// One open lamp as the page sees it: what it is showing (updated at once when the person changes something, then
// confirmed by the lamp's own reports), and a write queue that coalesces fast changes (a dragged slider, a painted
// stroke) so Bluetooth gets about 14 writes a second, always the latest value. Every frame is built for the lamp's
// model (src/lib/lighting/govee/spec.ts): its colour dialect (the table's first guess, then whatever colour mode the
// lamp says it is in), its segments (the table's, or the count it reports) and its brightness scale. `LampGroup`
// ("All lamps") mirrors every change to each open lamp.
import {
  CMD,
  HEAD,
  MODE,
  allSegments,
  brightnessFrame,
  colourFrame,
  diyFrame,
  gradient,
  kelvinRgb,
  musicFrame,
  parseReport,
  powerFrame,
  queryFrame,
  sceneFrame,
  segmentBrightnessFrame,
  segmentFrames,
  whiteFrame,
  type Rgb,
} from "./govee/frames.ts";
import { DIY_APPLY_CODE } from "./govee/diy.ts";
import { sceneBlob, scenesFor, type LightScene } from "./govee/scenes.generated.ts";
import { COLOUR_DIALECTS, limitOf, paintable, type GoveeSpec } from "./govee/spec.ts";
import type { LampLink } from "./link.ts";
import type { SyncEdge, SyncInfo } from "./models.ts";

export type LampMode = "colour" | "white" | "segments" | "scene" | "music" | "diy" | "other";

export interface MusicSettings {
  mode: number;
  sensitivity: number;
  /** 0 or 1 (the lamp's two styles: dynamic and calm, UNVERIFIED which is which). */
  style: number;
  /** A fixed colour, or null for the lamp's own colours. */
  colour: Rgb | null;
}

export interface LampView {
  power: boolean | null;
  brightness: number | null;
  mode: LampMode | null;
  segments: readonly Rgb[];
  /** Each segment's own brightness, 0-100 (on top of the lamp's). */
  segmentBrightness: readonly number[];
  kelvin: number | null;
  scene: number | null;
  firmware: string | null;
  music: MusicSettings | null;
  /** Screen sync, while it runs (`blind`: the screen can't be seen, so the lamp holds its last colours). */
  sync: (SyncInfo & { blind: boolean }) | null;
}

/** A DIY effect: a style (family + variant) or a combo of up to four, a speed and up to eight colours. */
export interface DiyEffect {
  id: string;
  name: string;
  family: number;
  variant: number;
  speed: number;
  colours: Rgb[];
  combo?: { family: number; variant: number }[];
}

export function diyBody(d: DiyEffect): Uint8Array {
  const colours = d.colours.slice(0, 8).flatMap((c) => [...c]);
  const speed = Math.max(0, Math.min(100, Math.round(d.speed)));
  if (d.combo?.length) return Uint8Array.from([0xff, 0, speed, colours.length, ...colours, d.combo.length * 2, ...d.combo.slice(0, 4).flatMap((p) => [p.family, p.variant])]);
  return Uint8Array.from([d.family, d.variant, speed, colours.length, ...colours]);
}

/** Room between two queued writes (about 14 a second; each can be several frames, which the bridge spaces). */
export const PACE_MS = 70;
/** After a burst of changes, the lamp is asked what it now shows, so the page shows the lamp's answer. */
export const CONFIRM_MS = 900;

const initial = (segments: number): LampView => ({
  power: null,
  brightness: null,
  mode: null,
  segments: Array.from({ length: segments }, () => [255, 255, 255] as const),
  segmentBrightness: Array.from({ length: segments }, () => 100),
  kelvin: null,
  scene: null,
  firmware: null,
  music: null,
  sync: null,
});

export class LampController {
  readonly link: LampLink;
  readonly spec: GoveeSpec;
  view: LampView;
  /** The colour sub-mode this lamp takes (the table's guess until the lamp names one). */
  dialect: number;
  /** Segments, as the table has them or as the lamp reports them (1: one colour for the whole light). */
  #count: number;
  /** The brightness scale: 100, or 254 once the lamp reports a value above 100 (the app's other scale). */
  #scale = 100;
  /** A write that didn't go through (the page shows it). */
  onError: (why: string) => void = () => {};
  /** Screen sync ended by itself (the screen locked, the lamp dropped...): why. */
  onSyncStopped: (why: string) => void = () => {};
  #subs = new Set<() => void>();
  #queue = new Map<string, readonly Uint8Array[]>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #busy = false;
  #off: () => void;
  /** What to ask the lamp once the changes stop (query commands), and when it was last changed and last asked. */
  #confirm = new Set<number>();
  #confirmTimer: ReturnType<typeof setTimeout> | null = null;
  #wrote = 0;
  #asked = 0;

  constructor(link: LampLink, spec: GoveeSpec) {
    this.link = link;
    this.spec = spec;
    this.dialect = spec.dialect;
    this.#count = spec.segments || 1;
    this.view = initial(this.#count);
    if (link.sync) this.view = { ...this.view, sync: { ...link.sync, blind: false } };
    const offs = [
      link.onReport((f) => this.#report(f)),
      link.onSync((colours, blind) => this.view.sync && this.#set({ mode: "segments", segments: colours, sync: { ...this.view.sync, blind } })),
      link.onSyncStopped((why) => {
        if (!this.view.sync) return;
        this.#set({ sync: null });
        this.onSyncStopped(why);
      }),
    ];
    this.#off = () => offs.forEach((off) => off());
  }

  subscribe = (cb: () => void): (() => void) => {
    this.#subs.add(cb);
    return () => this.#subs.delete(cb);
  };
  getView = () => this.view;

  #set(patch: Partial<LampView>) {
    this.view = { ...this.view, ...patch };
    this.#subs.forEach((cb) => cb());
  }

  /** Queues a write (the same key replaces a write still waiting); `confirm` names the queries that check it. */
  #enqueue(key: string, frames: readonly Uint8Array[], confirm: readonly number[] = []) {
    this.#queue.delete(key);
    this.#queue.set(key, frames);
    if (confirm.length) {
      this.#wrote = Date.now();
      confirm.forEach((c) => this.#confirm.add(c));
    }
    if (this.#timer === null && !this.#busy) this.#timer = setTimeout(() => void this.#pump(), 0);
  }

  /** The segment pages to ask for (0x15 lights only). */
  #pages() {
    return paintable(this.spec, this.dialect) && this.dialect === 0x15 ? Array.from({ length: Math.ceil(this.#count / 4) }, (_, i) => i + 1) : [];
  }

  /** Once nothing has been changed for a moment: ask the lamp what it shows now. */
  #scheduleConfirm() {
    if (this.#confirmTimer) clearTimeout(this.#confirmTimer);
    if (!this.#confirm.size) return;
    this.#confirmTimer = setTimeout(() => {
      this.#confirmTimer = null;
      const frames = [...this.#confirm].flatMap((c) => (c === CMD.segments ? this.#pages().map((p) => queryFrame(c, p)) : [queryFrame(c)]));
      this.#confirm.clear();
      this.#asked = Date.now();
      this.#enqueue("query", frames);
    }, CONFIRM_MS);
  }

  async #pump() {
    this.#timer = null;
    const next = this.#queue.entries().next();
    if (next.done) return;
    const [key, frames] = next.value;
    this.#queue.delete(key);
    this.#busy = true;
    try {
      await this.link.send(frames);
    } catch (e) {
      this.onError(String(e).replace(/^Error: /, ""));
    } finally {
      this.#busy = false;
      if (this.#queue.size) this.#timer = setTimeout(() => void this.#pump(), PACE_MS);
      else this.#scheduleConfirm();
    }
  }

  /** Sends everything still queued now (before an upload, so the order holds). A question about what the lamp shows,
   * still waiting from those earlier writes, is dropped: the new look answers it, and a late answer would undo it. */
  async flush() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#confirmTimer) clearTimeout(this.#confirmTimer);
    this.#confirmTimer = null;
    this.#confirm.clear();
    this.#queue.delete("query");
    while (this.#busy) await new Promise((r) => setTimeout(r, 10));
    const all = [...this.#queue.values()].flat();
    this.#queue.clear();
    if (all.length) await this.link.send(all);
  }

  /** Screen sync needs known segments and the 0x15 pages (the bridge's rule too). */
  get syncable() {
    return this.spec.segments > 0 && this.spec.dialects.includes(0x15) && this.dialect === 0x15;
  }

  /** How many segments the page can paint (1: the light takes one colour). */
  get segments() {
    return paintable(this.spec, this.dialect) ? this.#count : 1;
  }

  /** The mask of every segment: the reported count's, or every one the model may have when it isn't known. */
  #mask() {
    return this.spec.segments || this.#count > 1 ? (1 << this.#count) - 1 : allSegments(this.spec);
  }

  /** A new segment count (the table's or the lamp's): the drawing gets that many segments. */
  #resize(n: number) {
    this.#count = n;
    const fill = <T>(xs: readonly T[], v: T) => Array.from({ length: this.segments }, (_, i) => xs[i] ?? v);
    this.#set({ segments: fill(this.view.segments, this.view.segments[0] ?? ([255, 255, 255] as const)), segmentBrightness: fill(this.view.segmentBrightness, 100) });
  }

  #report(f: Uint8Array) {
    const r = parseReport(f);
    if (!r) return;
    // A state answer to a question asked before the latest change is out of date: the next check corrects the page.
    if (f[0] === HEAD.query && this.#wrote > this.#asked && (r.kind === "power" || r.kind === "brightness" || r.kind === "mode" || r.kind === "segments")) return;
    if (r.kind === "power") this.#set({ power: r.on });
    else if (r.kind === "brightness") {
      if (r.value > 100 && this.spec.brightnessMax > 100) this.#scale = this.spec.brightnessMax;
      this.#set({ brightness: Math.max(1, Math.round((r.value / this.#scale) * 100)) });
    } else if (r.kind === "version") this.#set({ firmware: r.text });
    else if (r.kind === "ics") {
      // The segment count a model of unknown segments reports (`aa 40`, the third byte).
      if (!this.spec.segments && r.segments >= 1 && r.segments <= this.spec.maxSegments) this.#resize(Math.min(r.segments, limitOf(this.spec, this.dialect) || r.segments));
    } else if (r.kind === "mode") {
      if (r.mode === MODE.scene) this.#set({ mode: "scene", scene: r.data[0] | (r.data[1] << 8) });
      else if (r.mode === MODE.music) this.#set({ mode: "music" });
      else if (r.mode === MODE.diy) this.#set({ mode: "diy" });
      else if (COLOUR_DIALECTS.includes(r.mode) && this.spec.dialects.includes(r.mode)) {
        // The lamp names the colour dialect it takes: use it from now on.
        if (r.mode !== this.dialect) {
          this.dialect = r.mode;
          this.#resize(this.#count);
        }
        if (this.view.mode === null) this.#set({ mode: "colour" });
      } else this.#set({ mode: "other" });
    } else if (r.kind === "segments" && r.page >= 1) {
      const segs = [...this.view.segments];
      const bright = [...this.view.segmentBrightness];
      r.segments.forEach((s, i) => {
        const at = (r.page - 1) * 4 + i;
        if (at >= segs.length) return;
        segs[at] = s.rgb;
        bright[at] = s.brightness;
      });
      this.#set({ segments: segs, segmentBrightness: bright });
    }
  }

  /** Asks the lamp what it is showing (power, brightness, mode, firmware, each segment's colour, how many it has). */
  refresh() {
    this.#asked = Date.now();
    const asks = [CMD.power, CMD.brightness, CMD.mode, CMD.version, ...(this.spec.segments ? [] : [CMD.icCount])];
    this.#enqueue("query", [...asks.map((c) => queryFrame(c)), ...this.#pages().map((p) => queryFrame(CMD.segments, p))]);
  }

  /** A colour, white or painted change is checked by asking for the mode and every segment's colour. */
  #colourCheck() {
    return this.#pages().length ? [CMD.mode, CMD.segments] : [CMD.mode];
  }

  setPower(on: boolean) {
    if (!on) this.#endSync();
    this.#set({ power: on });
    this.#enqueue("power", [powerFrame(on)], [CMD.power]);
  }

  /** An effect's colours laid along the segments, for the drawing (the lamp moves them itself). */
  #spread(colours: readonly Rgb[]): Rgb[] {
    return this.view.segments.map((_, i) => colours[i % Math.max(colours.length, 1)] ?? [255, 255, 255]);
  }

  /** A change that shows light turns a lamp that is off on first (UNVERIFIED whether the H6076 would by itself). */
  #wake() {
    if (this.view.power === false) this.setPower(true);
  }

  setBrightness(percent: number) {
    this.#wake();
    this.#set({ brightness: percent });
    this.#enqueue("brightness", [brightnessFrame(Math.round((percent / 100) * this.#scale), this.#scale)], [CMD.brightness]);
  }

  setColour(rgb: Rgb) {
    this.#endSync();
    this.#wake();
    this.#set({ mode: "colour", segments: this.view.segments.map(() => rgb), scene: null });
    this.#enqueue("colour", [colourFrame(this.spec, this.dialect, rgb, this.#mask())], this.#colourCheck());
  }

  setWhite(kelvin: number) {
    this.#endSync();
    this.#wake();
    const rgb = kelvinRgb(kelvin);
    this.#set({ mode: "white", kelvin, segments: this.view.segments.map(() => rgb), scene: null });
    this.#enqueue("colour", [whiteFrame(this.spec, this.dialect, kelvin)], this.#colourCheck());
  }

  /** Every segment's colour at once (painting, a gradient); a light of one colour takes the first. */
  paint(colours: readonly Rgb[]) {
    if (this.segments === 1) return this.setColour(colours[0] ?? [255, 255, 255]);
    this.#endSync();
    this.#wake();
    this.#set({ mode: "segments", segments: colours, scene: null });
    this.#enqueue("colour", segmentFrames(this.spec, this.dialect, colours), this.#colourCheck());
  }

  setGradient(stops: readonly Rgb[]) {
    this.paint(gradient(stops, this.segments));
  }

  /** One brightness for the segments in `mask` (bit 0 is segment 1). */
  setSegmentBrightness(percent: number, mask: number) {
    if (this.dialect !== 0x15 || this.segments === 1) return;
    this.#wake();
    this.#set({ segmentBrightness: this.view.segmentBrightness.map((b, i) => (mask & (1 << i) ? percent : b)) });
    this.#enqueue(`segbright:${mask}`, [segmentBrightnessFrame(percent, mask)], [CMD.segments]);
  }

  async applyScene(scene: LightScene) {
    // "All lamps" of different models: a scene goes only to the lamps whose catalogue has it.
    if (!scenesFor(this.spec.sku).some((x) => x.code === scene.code)) return;
    this.#endSync();
    this.#wake();
    await this.flush();
    const blob = sceneBlob(scene);
    if (blob) await this.link.upload("scene", blob, scene.code);
    await this.link.send([sceneFrame(scene.code)]);
    this.#set({ mode: "scene", scene: scene.code, segments: this.#spread(scene.colours.map(fromHex)) });
  }

  setMusic(m: MusicSettings) {
    if (!this.spec.music.some((x) => x.id === m.mode)) return;
    this.#endSync();
    this.#wake();
    this.#set({ mode: "music", music: m });
    this.#enqueue("music", [musicFrame(m.mode, m.sensitivity, m.style, m.colour)], [CMD.mode]);
  }

  async applyDiy(d: DiyEffect) {
    if (!this.spec.diy) return;
    this.#endSync();
    this.#wake();
    await this.flush();
    await this.link.upload("diy", diyBody(d));
    await this.link.send([diyFrame(DIY_APPLY_CODE)]);
    this.#set({ mode: "diy", scene: null, segments: this.#spread(d.colours) });
  }

  /**
   * Screen sync: the bridge samples the screen and sends the segment colours itself, and keeps the lamp connected
   * until it is stopped (here, on the Devices home card, or by a colour, scene, effect or music change).
   */
  async startSync(edge: SyncEdge, vivid: boolean, monitor: string | null = null) {
    if (!this.syncable) return;
    this.#wake();
    await this.flush();
    const info = await this.link.startSync(edge, vivid, monitor);
    this.#set({ sync: { ...info, blind: false }, scene: null });
  }

  async stopSync() {
    if (!this.view.sync) return;
    this.#set({ sync: null });
    await this.link.stopSync();
  }

  /** Changing the lamp's look by hand ends screen sync first (it would paint over the change). */
  #endSync() {
    if (this.view.sync) void this.stopSync().catch((e) => this.onError(String(e).replace(/^Error: /, "")));
  }

  async close() {
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#confirmTimer) clearTimeout(this.#confirmTimer);
    this.#queue.clear();
    this.#off();
    await this.link.close();
  }
}

const fromHex = (h: string): Rgb => {
  const n = parseInt(h.replace("#", ""), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** What a lamp page drives: one lamp, or every open lamp at once. */
export type LampControl = Pick<
  LampController,
  | "subscribe"
  | "getView"
  | "refresh"
  | "setPower"
  | "setBrightness"
  | "setColour"
  | "setWhite"
  | "paint"
  | "setGradient"
  | "setSegmentBrightness"
  | "applyScene"
  | "setMusic"
  | "applyDiy"
  | "startSync"
  | "stopSync"
  | "close"
  | "segments"
  | "spec"
  | "dialect"
  | "syncable"
> & { onError: (why: string) => void; onSyncStopped: (why: string) => void };

/**
 * "All lamps": every change goes to each lamp, and the page shows the first one (the others are sent the same, so
 * they show the same). Uploads go to the lamps one after another: each waits for its own lamp's acknowledgement.
 */
export class LampGroup implements LampControl {
  readonly members: readonly LampController[];

  constructor(members: readonly LampController[]) {
    if (!members.length) throw new Error("No lamps to group.");
    this.members = members;
  }

  set onError(fn: (why: string) => void) {
    this.members.forEach((m) => (m.onError = fn));
  }
  get onError() {
    return this.members[0].onError;
  }
  set onSyncStopped(fn: (why: string) => void) {
    this.members.forEach((m) => (m.onSyncStopped = fn));
  }
  get onSyncStopped() {
    return this.members[0].onSyncStopped;
  }

  subscribe = (cb: () => void) => {
    const offs = this.members.map((m) => m.subscribe(cb));
    return () => offs.forEach((off) => off());
  };
  getView = () => this.members[0].view;
  /** The first lamp leads the page (its model's scenes, music and segments); the others follow where they can. */
  get spec() {
    return this.members[0].spec;
  }
  get segments() {
    return this.members[0].segments;
  }
  get dialect() {
    return this.members[0].dialect;
  }
  get syncable() {
    return this.members.some((m) => m.syncable);
  }

  refresh = () => this.members.forEach((m) => m.refresh());
  setPower = (on: boolean) => this.members.forEach((m) => m.setPower(on));
  setBrightness = (percent: number) => this.members.forEach((m) => m.setBrightness(percent));
  setColour = (rgb: Rgb) => this.members.forEach((m) => m.setColour(rgb));
  setWhite = (kelvin: number) => this.members.forEach((m) => m.setWhite(kelvin));
  paint = (colours: readonly Rgb[]) => this.members.forEach((m) => m.paint(colours));
  setGradient = (stops: readonly Rgb[]) => this.members.forEach((m) => m.setGradient(stops));
  setSegmentBrightness = (percent: number, mask: number) => this.members.forEach((m) => m.setSegmentBrightness(percent, mask));
  setMusic = (music: MusicSettings) => this.members.forEach((m) => m.setMusic(music));

  async applyScene(scene: LightScene) {
    for (const m of this.members) await m.applyScene(scene);
  }
  async applyDiy(d: DiyEffect) {
    for (const m of this.members) await m.applyDiy(d);
  }
  async startSync(edge: SyncEdge, vivid: boolean, monitor: string | null = null) {
    await Promise.all(this.members.map((m) => m.startSync(edge, vivid, monitor)));
  }
  async stopSync() {
    await Promise.all(this.members.map((m) => m.stopSync()));
  }
  async close() {
    await Promise.all(this.members.map((m) => m.close()));
  }
}

/** The scene a code names, if it is in the model's catalogue. */
export const sceneOf = (sku: string, code: number | null) => (code === null ? null : (scenesFor(sku).find((s) => s.code === code) ?? null));
