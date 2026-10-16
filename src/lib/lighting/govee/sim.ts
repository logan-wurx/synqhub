// Simulated Govee lights for the browser preview, the end-to-end build and the tests: the developer's two H6076 floor
// lamps (one in reach, one usually out of range) and two other models for the L2 pages. They answer the frames the real
// lights answer (queries, acks, the power event), keep their state in the colour dialect their model takes, and refuse
// anything the guard refuses, exactly as the bridge would.
import { CMD, HEAD, MODE, checkLightFrame, checkLightUpload, frame, gradualFrame, kelvinRgb, segmentPageFrame, type Rgb, type UploadKind } from "./frames.ts";
import { scenesFor } from "./scenes.generated.ts";
import { DIALECT, specOf, type GoveeSpec } from "./spec.ts";
import type { SimLampSpec, SyncEdge } from "../models.ts";

const hex = (s: string): Rgb => [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
const skuOf = (name: string) => name.split("_").find((p) => /^H[0-9A-F]{4}$/i.test(p)) ?? "";

export class SimGoveeLamp {
  readonly spec: SimLampSpec;
  readonly model: GoveeSpec;
  power = true;
  brightness = 35;
  mode: number;
  segments: Rgb[];
  segmentBrightness: number[];
  gradual = true;
  scene: number | null = null;
  /** Every frame the lamp accepted, in order. */
  readonly accepted: Uint8Array[] = [];
  readonly uploads: { kind: UploadKind; body: Uint8Array }[] = [];
  #listeners = new Set<(f: Uint8Array) => void>();

  constructor(spec: SimLampSpec) {
    this.spec = spec;
    this.model = specOf(skuOf(spec.name))!;
    // A model of unknown segments has some all the same (the count it reports in `aa 40`).
    const n = this.model.segments || spec.segments || 1;
    this.mode = spec.dialect ?? this.model.dialect;
    this.segments = Array.from({ length: n }, (_, i) => [255, Math.round(120 + i * 6), 40] as const);
    this.segmentBrightness = Array.from({ length: n }, () => 100);
  }

  onReport(cb: (f: Uint8Array) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #report(bytes: number[]) {
    const f = frame(bytes);
    setTimeout(() => this.#listeners.forEach((cb) => cb(f)), 4);
  }

  #paint(mask: number, rgb: Rgb) {
    this.segments = this.segments.map((c, i) => (mask & (1 << i) ? rgb : c));
  }

  /** A frame from SYNQ: refused like the bridge refuses it, else applied and answered. */
  send(f: Uint8Array): void {
    const v = checkLightFrame(this.model, f);
    if (!v.ok) throw new Error(`Refused: ${v.why}`);
    this.accepted.push(f);
    const [head, cmd] = [f[0], f[1]];
    if (head === HEAD.query) {
      if (cmd === CMD.power) this.#report([HEAD.query, CMD.power, this.power ? 1 : 0]);
      else if (cmd === CMD.brightness) this.#report([HEAD.query, CMD.brightness, this.brightness]);
      else if (cmd === CMD.mode) this.#report([HEAD.query, CMD.mode, this.mode, 0x00]);
      else if (cmd === CMD.version) this.#report([HEAD.query, CMD.version, ...Array.from("1.04.05", (c) => c.charCodeAt(0))]);
      else if (cmd === CMD.icCount) this.#report([HEAD.query, CMD.icCount, 0, this.segments.length * 6, this.segments.length]);
      else if (cmd === CMD.segments) {
        const p = f[2] - 1;
        const cells = [0, 1, 2, 3].flatMap((i) => {
          const s = p * 4 + i;
          return s < this.segments.length ? [this.segmentBrightness[s], ...this.segments[s]] : [0, 0, 0, 0];
        });
        this.#report([HEAD.query, CMD.segments, f[2], ...cells]);
      }
      return;
    }
    this.#report([HEAD.set, cmd]);
    if (cmd === CMD.power) {
      this.power = f[2] === 1;
      this.#report([HEAD.event, 0x30, 0x01, f[2], ...(this.power ? [1] : [])]);
    } else if (cmd === CMD.brightness) this.brightness = f[2];
    else if (cmd === CMD.gradual) this.gradual = f[2] === 1;
    else if (cmd === CMD.mode) this.#mode(f);
  }

  #mode(f: Uint8Array) {
    const sub = f[2];
    this.mode = sub;
    const all = (1 << this.segments.length) - 1;
    if (sub === DIALECT.typed && f[3] === 0x01) {
      const k = (f[7] << 8) | f[8];
      this.#paint(f[12] | (f[13] << 8), k ? kelvinRgb(k) : [f[4], f[5], f[6]]);
    } else if (sub === DIALECT.typed && f[3] === 0x02) {
      const mask = f[5] | (f[6] << 8);
      this.segmentBrightness = this.segmentBrightness.map((b, i) => (mask & (1 << i) ? f[4] : b));
    } else if (sub === DIALECT.typed && f[3] === 0x04) {
      const p = f[4] - 1;
      for (let i = 0; i < 4 && p * 4 + i < this.segments.length; i++) this.segments[p * 4 + i] = [f[5 + i * 3], f[6 + i * 3], f[7 + i * 3]];
    } else if (sub === DIALECT.ic) this.#paint(f[6] | (f[7] << 8), [f[3], f[4], f[5]]);
    else if (sub === DIALECT.cct) {
      const k = (f[6] << 8) | f[7];
      this.#paint(all, k ? kelvinRgb(k) : [f[3], f[4], f[5]]);
    } else if (sub === DIALECT.rgb) this.#paint(all, [f[3], f[4], f[5]]);
    else if (sub === MODE.scene) {
      this.scene = f[3] | (f[4] << 8);
      const s = scenesFor(this.model.sku).find((x) => x.code === this.scene);
      if (s) this.segments = this.segments.map((_, i) => hex(s.colours[i % s.colours.length]));
    }
  }

  /** An upload: refused unless the guard allows it; acknowledged like the lamp does (a3 <type> 00). */
  upload(kind: UploadKind, body: Uint8Array, code?: number): boolean {
    const v = checkLightUpload(this.model, kind, body, code);
    if (!v.ok) throw new Error(`Refused: ${v.why}`);
    this.uploads.push({ kind, body });
    this.#report([HEAD.upload, kind === "scene" ? 0x02 : 0x04, 0x00]);
    return true;
  }
}

const sims = new Map<string, SimGoveeLamp>();
export const simLamp = (spec: SimLampSpec) => {
  let s = sims.get(spec.id);
  if (!s) sims.set(spec.id, (s = new SimGoveeLamp(spec)));
  return s;
};

/** A segment colour that moved less than this on every channel isn't resent (the bridge's `stream::THRESHOLD`). */
const SYNC_THRESHOLD = 8;
const SYNC_MS = 166;

/** The pages (1-based) holding a segment that moved enough since it was last sent (every page at first). */
export function changedPages(sent: readonly Rgb[], next: readonly Rgb[]): number[] {
  const pages: number[] = [];
  for (let p = 0; p * 4 < next.length; p++)
    if (next.slice(p * 4, p * 4 + 4).some((c, i) => !sent[p * 4 + i] || c.some((v, k) => Math.abs(v - sent[p * 4 + i][k]) > SYNC_THRESHOLD))) pages.push(p + 1);
  return pages;
}

const hsv = (h: number, s: number): Rgb => {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
};

const running = new Map<string, () => void>();

/**
 * The preview's screen sync: a pretend screen (colours drifting up the lamp, a little different per edge) sent as
 * changed segment pages at the bridge's pace, until stopped. Like the bridge's, it outlives the lamp's page.
 */
export function simSyncStart(spec: SimLampSpec, edge: SyncEdge, onColours: (c: Rgb[], blind: boolean) => void): void {
  simSyncStop(spec.id);
  const sim = simLamp(spec);
  const shift = { left: 0, right: 120, both: 60, full: 200 }[edge];
  let sent: Rgb[] = [];
  sim.send(gradualFrame(false));
  const t0 = Date.now();
  const timer = setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    const colours = Array.from({ length: sim.segments.length }, (_, i) => hsv((t * 24 + i * 9 + shift) % 360, 0.85));
    const pages = changedPages(sent, colours);
    for (const p of pages) sim.send(segmentPageFrame(p, colours.slice((p - 1) * 4, p * 4)));
    if (pages.length) {
      sent = colours;
      onColours(colours, false);
    }
  }, SYNC_MS);
  running.set(spec.id, () => clearInterval(timer));
}

export function simSyncStop(id: string): boolean {
  const stop = running.get(id);
  stop?.();
  running.delete(id);
  return !!stop;
}
