// Live key depth for a visible "live view". Cheap by construction:
//   - nothing runs until start(); stop() undoes everything (listener, timers, the device if it opened it);
//   - while the page is hidden it pauses: no requests, no timers, no listener, device closed again;
//   - stream keyboards (Wooting, Razer, NuPhy) are only listened to, never sent anything;
//   - poll keyboards (DrunkDeer, Keychron, Madlions, Redragon) get one request at a time, at most
//     `maxHz` rounds a second, every frame through checkAnalogFrame();
//   - frames reach the view at most `maxHz` times a second, coalesced.
// Read-only. From AnalogSense (MIT, Copyright (c) 2024 Calamity, Inc.); see protocol.ts for sources.
import type { HidLike } from "../types.ts";
import { FAMILIES, findModel, type AnalogFamilyInfo, type AnalogModel } from "./devices.ts";
import * as A from "./protocol.ts";

export interface LiveFrame {
  /** Depth 0..1 by scancode (HID usage; 0x409 = Fn). Keys that are up are absent. */
  depth: ReadonlyMap<number, number>;
  /** Millimetres where the keyboard reports an absolute unit (DrunkDeer, Madlions; inferred), else null. */
  mm: ReadonlyMap<number, number> | null;
  at: number;
}

export interface VisibilitySource {
  readonly hidden: boolean;
  subscribe(onChange: () => void): () => void;
}

/** The page's visibility (document.visibilityState), or null outside a browser. */
export function documentVisibility(): VisibilitySource | null {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return null;
  return {
    get hidden() {
      return doc.visibilityState === "hidden";
    },
    subscribe(cb) {
      doc.addEventListener("visibilitychange", cb);
      return () => doc.removeEventListener("visibilitychange", cb);
    },
  };
}

export interface LiveOptions {
  /** Poll rounds and frames per second, at most (default 60). */
  maxHz?: number;
  /** Reply timeout per request (default 250 ms). */
  replyMs?: number;
  /** Consecutive missed replies before polling stops with an error (default 5). */
  maxMisses?: number;
  /** Keys refreshed per round on one-key-per-request keyboards, besides the keys held (default 6). */
  window?: number;
  /** Default: the page's visibility. null = always visible (tests, a pop-out window). */
  visibility?: VisibilitySource | null;
  onError?: (e: Error) => void;
  log?: (dir: "out" | "in", reportId: number, bytes: Uint8Array) => void;
}

type Accept = (reportId: number, d: Uint8Array) => boolean;

export class AnalogLive {
  readonly dev: HidLike;
  readonly model: AnalogModel;
  readonly info: AnalogFamilyInfo;
  readonly layout: A.MatrixLayout | null;
  readonly stats = { requests: 0, reports: 0, frames: 0, misses: 0 };
  #opts: Required<Omit<LiveOptions, "visibility" | "onError" | "log">> & Pick<LiveOptions, "onError" | "log">;
  #visibility: VisibilitySource | null;
  #status: "stopped" | "running" | "paused" | "failed" = "stopped";
  #onFrame: ((f: LiveFrame) => void) | null = null;
  #unsubscribe: (() => void) | null = null;
  #listener = (e: HIDInputReportEvent) => this.#onInput(e.reportId, new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
  #openedHere = false;
  #generation = 0;
  #depth = new Map<number, number>();
  #mm: Map<number, number> | null = null;
  #dirty = false;
  #lastEmit = 0;
  #emitTimer: ReturnType<typeof setTimeout> | null = null;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #pending: { accept: Accept; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  // Poll-family state
  #kcVersion: number | null = null;
  #kcFull = false;
  #cursor = 0;

  constructor(dev: HidLike, model: AnalogModel, opts: LiveOptions = {}) {
    this.dev = dev;
    this.model = model;
    this.info = FAMILIES[model.family];
    this.layout = model.layout ? (A.LAYOUTS[model.layout] ?? null) : null;
    this.#opts = { maxHz: opts.maxHz ?? 60, replyMs: opts.replyMs ?? 250, maxMisses: opts.maxMisses ?? 5, window: opts.window ?? 6, onError: opts.onError, log: opts.log };
    this.#visibility = opts.visibility === undefined ? documentVisibility() : opts.visibility;
    if ((model.family === "keychron" || model.family === "madlions") && !this.layout) throw new Error(`No matrix layout for ${model.name}.`);
  }

  get status(): "stopped" | "running" | "paused" | "failed" {
    return this.#status;
  }

  /** Starts the live view (paused right away while the page is hidden). */
  async start(onFrame: (f: LiveFrame) => void): Promise<void> {
    if (this.#status !== "stopped") throw new Error("The live view is already started.");
    this.#onFrame = onFrame;
    this.#unsubscribe = this.#visibility?.subscribe(() => void this.#visibilityChanged()) ?? null;
    if (this.#visibility?.hidden) this.#status = "paused";
    else await this.#activate();
  }

  /** Stops everything; safe to call more than once. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#onFrame = null;
    await this.#deactivate();
    this.#status = "stopped";
  }

  async #visibilityChanged() {
    if (this.#status === "running" && this.#visibility?.hidden) {
      await this.#deactivate();
      this.#status = "paused";
    } else if (this.#status === "paused" && !this.#visibility?.hidden) {
      try {
        await this.#activate();
      } catch (e) {
        this.#status = "failed";
        await this.#deactivate();
        this.#opts.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  async #activate() {
    const gen = ++this.#generation;
    this.#status = "running";
    this.#depth = new Map();
    this.#mm = null;
    this.stats.misses = 0;
    if (!this.dev.opened) {
      await this.dev.open();
      this.#openedHere = true;
    }
    if (gen !== this.#generation) return;
    this.dev.addEventListener("inputreport", this.#listener);
    if (this.info.mode === "poll") this.#schedulePoll(gen, 0);
  }

  async #deactivate() {
    this.#generation++;
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    if (this.#emitTimer) clearTimeout(this.#emitTimer);
    this.#pollTimer = this.#emitTimer = null;
    const p = this.#pending;
    this.#pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(new Error("stopped"));
    }
    this.dev.removeEventListener("inputreport", this.#listener);
    if (this.#openedHere) {
      this.#openedHere = false;
      await this.dev.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Input and frames
  // -------------------------------------------------------------------------------------------

  #onInput(reportId: number, data: Uint8Array) {
    if (this.#status !== "running") return;
    const d = data.slice();
    this.stats.reports++;
    this.#opts.log?.("in", reportId, d);
    if (this.#pending) {
      if (this.#pending.accept(reportId, d)) {
        const p = this.#pending;
        this.#pending = null;
        clearTimeout(p.timer);
        p.resolve();
      }
      return;
    }
    let u: A.DepthUpdate | null = null;
    switch (this.model.family) {
      case "wooting-v1":
        u = A.decodeWootingV1(d);
        break;
      case "wooting-v2":
        u = A.decodeWootingV2(d);
        break;
      case "razer-v2":
      case "razer-v3":
        if (reportId === this.info.inputReportId) u = A.decodeRazer(d, this.model.family === "razer-v3");
        break;
      case "nuphy":
        u = A.decodeNuphy(d, this.model.scale);
        break;
      default:
        return; // poll families: replies only count while a request is pending
    }
    if (u) this.#apply(u.set, u.complete);
  }

  #apply(set: ReadonlyMap<number, number>, complete: boolean, mm?: ReadonlyMap<number, number>) {
    if (complete) {
      this.#depth = new Map();
      this.#mm = mm ? new Map() : null;
    }
    for (const [k, v] of set) {
      if (v > 0) this.#depth.set(k, v);
      else this.#depth.delete(k);
      if (mm) {
        this.#mm ??= new Map();
        const x = mm.get(k);
        if (x && v > 0) this.#mm.set(k, x);
        else this.#mm.delete(k);
      }
    }
    this.#dirty = true;
    this.#scheduleEmit();
  }

  #scheduleEmit() {
    if (this.#emitTimer || !this.#dirty) return;
    const wait = Math.max(0, this.#lastEmit + 1000 / this.#opts.maxHz - Date.now());
    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = null;
      if (!this.#dirty || this.#status !== "running") return;
      this.#dirty = false;
      this.#lastEmit = Date.now();
      this.stats.frames++;
      this.#onFrame?.({ depth: new Map(this.#depth), mm: this.#mm ? new Map(this.#mm) : null, at: this.#lastEmit });
    }, wait);
  }

  // -------------------------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------------------------

  #schedulePoll(gen: number, delay: number) {
    this.#pollTimer = setTimeout(async () => {
      this.#pollTimer = null;
      if (gen !== this.#generation) return;
      const started = Date.now();
      try {
        await this.#round();
        this.stats.misses = 0;
      } catch (e) {
        if (gen !== this.#generation) return;
        this.stats.misses++;
        if (this.stats.misses >= this.#opts.maxMisses) {
          this.#status = "failed";
          await this.#deactivate();
          this.#opts.onError?.(e instanceof Error ? e : new Error(String(e)));
          return;
        }
      }
      if (gen !== this.#generation) return;
      this.#schedulePoll(gen, Math.max(0, started + 1000 / this.#opts.maxHz - Date.now()));
    }, delay);
  }

  /** Sends one allowlisted request and waits until `accept` takes a reply. */
  async #request(reportId: number, frame: readonly number[], accept: Accept): Promise<void> {
    A.assertAnalogSendable(this.model.family, reportId, frame);
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending?.timer === timer) this.#pending = null;
        reject(new Error(`${this.model.name} didn't answer the depth request.`));
      }, this.#opts.replyMs);
      this.#pending = { accept, resolve, reject, timer };
    });
    const bytes = Uint8Array.from(frame);
    this.stats.requests++;
    this.#opts.log?.("out", reportId, bytes);
    await this.dev.sendReport(reportId, bytes);
    await done;
  }

  async #round(): Promise<void> {
    switch (this.model.family) {
      case "drunkdeer": {
        const depth = new Map<number, number>();
        const mm = new Map<number, number>();
        let next = 0;
        await this.#request(4, A.DRUNKDEER_REQUEST, (_id, d) => {
          const c = A.decodeDrunkdeerChunk(d);
          if (!c || c.part !== next) return false;
          c.depth.forEach((v, k) => depth.set(k, v));
          c.mm.forEach((v, k) => mm.set(k, v));
          next++;
          return c.part === 2;
        });
        this.#apply(depth, true, mm);
        return;
      }
      case "bytech": {
        const box: { u: A.DepthUpdate | null } = { u: null };
        await this.#request(9, A.bytechRequest(), (_id, d) => !!(box.u = A.decodeBytech(d)));
        if (box.u) this.#apply(box.u.set, true);
        return;
      }
      case "keychron":
        return this.#keychronRound();
      case "madlions":
        return this.#madlionsRound();
      default:
        return;
    }
  }

  /** Matrix indices to refresh this round: keys held now plus the next `window` keys in turn. */
  #plan(indexes: readonly number[], window: number): number[] {
    const layout = this.layout!;
    const held = indexes.filter((i) => this.#depth.has(layout.keys[i]));
    const turn: number[] = [];
    for (let n = 0; n < indexes.length && turn.length < window; n++) {
      const i = indexes[(this.#cursor + n) % indexes.length];
      if (!held.includes(i)) turn.push(i);
    }
    this.#cursor = (this.#cursor + window) % Math.max(1, indexes.length);
    return [...held, ...turn];
  }

  async #keychronRound(): Promise<void> {
    const layout = this.layout!;
    if (this.#kcVersion === null) {
      const box = { version: 0, fullReport: false };
      await this.#request(0, A.keychronVersionRequest(), (_id, d) => A.isKeychronReply(d, A.KC.getVersion) && (Object.assign(box, A.decodeKeychronVersion(d)), true));
      this.#kcVersion = box.version;
      this.#kcFull = box.fullReport;
      return;
    }
    if (this.#kcFull) {
      // Always four replies of 30 positions, whatever the matrix size. [soup:950-960]
      const all = new Map<number, number>();
      let page = 0;
      await this.#request(0, A.keychronTravelAllRequest(), (_id, d) => {
        if (!A.isKeychronReply(d, A.KC.travelAll)) return false;
        A.decodeKeychronAllPage(d, page++, layout).forEach((v, k) => all.set(k, v));
        return page >= 4;
      });
      this.#apply(all, true);
      return;
    }
    const keyed = layout.keys.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
    const update = new Map<number, number>();
    for (const i of this.#plan(keyed, this.#opts.window)) {
      const row = Math.floor(i / layout.cols);
      const col = i % layout.cols;
      let value = 0;
      await this.#request(0, A.keychronTravelRequest(row, col), (_id, d) => A.isKeychronReply(d, A.KC.travel) && ((value = A.decodeKeychronTravel(d, this.#kcVersion!)), true));
      update.set(layout.keys[i], value);
    }
    this.#apply(update, false);
  }

  async #madlionsRound(): Promise<void> {
    const layout = this.layout!;
    const chunks = Array.from({ length: Math.ceil(layout.keys.length / 4) }, (_, c) => c * 4);
    const held = chunks.filter((o) => layout.keys.slice(o, o + 4).some((k) => k && this.#depth.has(k)));
    const turn: number[] = [];
    for (let n = 0; n < chunks.length && turn.length < Math.max(1, Math.round(this.#opts.window / 4)) + 3; n++) {
      const o = chunks[(this.#cursor + n) % chunks.length];
      if (!held.includes(o)) turn.push(o);
    }
    this.#cursor = (this.#cursor + turn.length) % chunks.length;
    const depth = new Map<number, number>();
    const mm = new Map<number, number>();
    for (const offset of [...held, ...turn]) {
      // The sources take whatever report comes next [soup:1212-1214]; 0xFF first is VIA's "unhandled".
      let unhandled = false;
      await this.#request(0, A.madlionsRequest(offset), (_id, d) => {
        if (d[0] === 0xff) unhandled = true;
        else {
          const r = A.decodeMadlions(d, offset, layout);
          r.depth.forEach((v, k) => depth.set(k, v));
          r.mm.forEach((v, k) => mm.set(k, v));
        }
        return true;
      });
      if (unhandled) throw new Error(`${this.model.name} doesn't answer the depth request (VIA "unhandled").`);
    }
    this.#apply(depth, false, mm);
  }
}

/** A live depth source for this HID device, or null when it isn't a listed analog keyboard. No I/O. */
export function liveDepthFor(dev: HidLike, opts?: LiveOptions): AnalogLive | null {
  const model = findModel(dev as unknown as Parameters<typeof findModel>[0]);
  return model ? new AnalogLive(dev, model, opts) : null;
}
