// I/O for Sonix HE boards (FCC protocol): one request at a time on the 0xFF68 / 0x61 collection, the
// reply matched by its command byte, retries like FCC, every frame through checkFrame(). Used by the
// generic-panel driver (driver.ts) and the full-feature session (sonix-session.ts).
//
// Derived from Fighting Control Center (FCC), https://github.com/shybruh/FightingControlCenter-FCC
// (commit 5cad2404661de383f21dca654300e88764f6bc89, app/src/hid/device.ts `exchange`, `readRegion`,
// `writeRegion`, `commit`), GNU GPL v3.0 or later; part of SYNQ (AGPL-3.0).
import * as P from "./sonix-protocol.ts";
import type { HidLike } from "../types.ts";
import type { Grants } from "../../advanced/core.ts";

export type SonixRegions = Record<P.RegionName, Uint8Array>;

export interface SonixLogEntry {
  dir: "out" | "in";
  bytes: Uint8Array;
  note?: string;
}

export interface SonixLinkOptions {
  /** Reply timeout per frame (FCC: 1500 ms). */
  replyMs?: number;
  /** Tries per frame (FCC: 3). */
  attempts?: number;
  /** Every report sent and received. */
  log?: (e: SonixLogEntry) => void;
  /** Skip open() (the caller already opened the device). */
  alreadyOpen?: boolean;
  /** Close the HID device in close(). Default: only when this link opened it. */
  closeDevice?: boolean;
  /** The keyboard's AdvancedGate: which Advanced actions are unlocked right now. Default: none. */
  grants?: Grants;
}

/** True when the device exposes the Sonix configuration collection (no I/O). */
export const hasConfigCollection = (dev: Pick<HidLike, "collections">): boolean =>
  !!dev.collections?.some((c) => c.usagePage === P.SONIX.usagePage && c.usage === P.SONIX.usage);

export class SonixLink {
  readonly dev: HidLike;
  readonly opts: SonixLinkOptions;
  state: "ok" | "lost" | "closed" = "ok";
  #queue: Promise<unknown> = Promise.resolve();
  #waiter: { cmd: number; resolve: (r: Uint8Array) => void; reject: (e: Error) => void } | null = null;
  #listener = (e: HIDInputReportEvent) => this.#onInput(e);
  #openedHere = false;
  readonly #sensors = new Set<(p: P.SensorPacket) => void>();

  private constructor(dev: HidLike, opts: SonixLinkOptions) {
    this.dev = dev;
    this.opts = opts;
  }

  /** Opens the device (unless it's open already) and listens for replies. Sends nothing. */
  static async open(dev: HidLike, opts: SonixLinkOptions = {}): Promise<SonixLink> {
    if (dev.collections?.length && !hasConfigCollection(dev)) throw new Error("This HID device isn't the keyboard's 0xFF68 / 0x61 configuration collection.");
    const link = new SonixLink(dev, opts);
    if (!opts.alreadyOpen && !dev.opened) {
      await dev.open();
      link.#openedHere = true;
    }
    dev.addEventListener("inputreport", link.#listener);
    return link;
  }

  #onInput(e: HIDInputReportEvent) {
    const r = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength).slice();
    this.opts.log?.({ dir: "in", bytes: r });
    const kind = P.classifyInput(r);
    if (kind === "link-down") {
      this.state = "lost";
      const w = this.#waiter;
      this.#waiter = null;
      w?.reject(new Error("The keyboard reported that it disconnected."));
      return;
    }
    if (kind === "sensor") {
      // Only calibration mode streams these (an Advanced action); nothing listens otherwise.
      const packet = this.#sensors.size ? P.decodeSensor(r) : null;
      if (packet) for (const l of [...this.#sensors]) l(packet);
      return;
    }
    if (kind !== "reply") return;
    if (this.#waiter && r[1] === this.#waiter.cmd) {
      const w = this.#waiter;
      this.#waiter = null;
      w.resolve(r);
    }
  }

  /** Listens for calibration-mode sensor packets; returns the unsubscribe. */
  onSensor(listener: (p: P.SensorPacket) => void): () => void {
    this.#sensors.add(listener);
    return () => this.#sensors.delete(listener);
  }

  /**
   * Sends one allowlisted frame and does not wait for a reply: the calibration start and end frames are
   * answered by (or followed by) the sensor stream rather than an echo. Call inside run().
   */
  async sendOnly(frame: Uint8Array): Promise<void> {
    if (this.state === "closed") throw new Error("The keyboard connection is closed.");
    const check = P.assertSendable(frame, this.opts.grants);
    this.opts.log?.({ dir: "out", bytes: frame, note: `${check.access} ${check.name}` });
    await this.dev.sendReport(P.SONIX.reportId, new Uint8Array(frame));
  }

  /** Runs `op` after everything queued before it. */
  run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(op, op);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Sends one allowlisted frame and waits for the reply with the same command byte. Call inside run(). */
  async exchange(frame: Uint8Array): Promise<Uint8Array> {
    if (this.state === "closed") throw new Error("The keyboard connection is closed.");
    const check = P.assertSendable(frame, this.opts.grants);
    const replyMs = this.opts.replyMs ?? 1500;
    const attempts = this.opts.attempts ?? 3;
    let last: unknown;
    for (let a = 0; a < attempts; a++) {
      const reply = new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.#waiter?.resolve === done) this.#waiter = null;
          reject(new Error(`No reply to Sonix command 0x${frame[1].toString(16).padStart(2, "0")} (${check.name}).`));
        }, replyMs);
        const done = (r: Uint8Array) => {
          clearTimeout(timer);
          resolve(r);
        };
        this.#waiter = {
          cmd: frame[1],
          resolve: done,
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        };
      });
      this.opts.log?.({ dir: "out", bytes: frame, note: `${check.access} ${check.name}` });
      try {
        await this.dev.sendReport(P.SONIX.reportId, new Uint8Array(frame));
        return await reply;
      } catch (e) {
        last = e;
        if (this.state !== "ok") break;
      }
    }
    throw last;
  }

  /** One region, chunk by chunk. Call inside run(). */
  async readRegion(name: P.RegionName): Promise<Uint8Array> {
    const def = P.REGIONS[name];
    const buf = new Uint8Array(def.size);
    for (let off = 0; off < def.size; off += P.SONIX.chunk) {
      const frame = P.encodeRegionReadChunk(name, off);
      const len = frame[2];
      const data = P.replyPayload(await this.exchange(frame)).subarray(0, len);
      buf.set(data, off);
      // FCC / the official driver stop reading macros at the first empty chunk past the 400-byte index.
      if (name === "macros" && off + len > P.MACRO_INDEX_BYTES && data.every((b) => b === 0)) break;
    }
    return buf;
  }

  /** Every region, in FCC's order. Call inside run(). */
  async readAll(): Promise<SonixRegions> {
    const out = {} as SonixRegions;
    for (const name of P.READ_ORDER) out[name] = await this.readRegion(name);
    return out;
  }

  /**
   * Writes whole regions in the order given and then the commit frame when one of them needs it.
   * Every frame of every region is checked before the first one goes out. Call inside run().
   */
  async writeRegions(changes: readonly (readonly [P.RegionName, Uint8Array])[], label = "Change"): Promise<void> {
    const plan = changes.map(([name, data]) => {
      const frames = P.encodeRegionWrite(name, data);
      for (const f of frames) {
        const c = P.checkFrame(f);
        if (!c.ok) throw new Error(`${label}: ${c.reason}`);
      }
      return { name, frames };
    });
    for (const { frames } of plan) for (const f of frames) await this.exchange(f);
    if (plan.some(({ name }) => P.needsCommit(name))) await this.exchange(P.encodeCommit());
  }

  /** Stops listening and closes the device if this link opened it. */
  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    this.dev.removeEventListener("inputreport", this.#listener);
    const w = this.#waiter;
    this.#waiter = null;
    w?.reject(new Error("The keyboard connection closed."));
    if (this.opts.closeDevice ?? this.#openedHere) await this.dev.close();
  }
}
