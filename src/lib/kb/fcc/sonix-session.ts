// Sonix HE keyboard session (FCC protocol): the full-feature API (per-key RT, SOCD / snap tap, rappy
// snappy, DKS, mod-tap, toggle, remaps, lighting, colours, macros, settings) over SonixLink. The generic
// Keyboard panel uses driver.ts instead (shared KbDriver / KbBackend contract, src/lib/kb/types.ts);
// this class is for a panel that edits advanced keys, and for the simulator.
//
// Derived from Fighting Control Center (FCC), https://github.com/shybruh/FightingControlCenter-FCC
// (commit 5cad2404661de383f21dca654300e88764f6bc89), GNU GPL v3.0 or later; part of SYNQ (AGPL-3.0).
//
// Rules, stricter than FCC because nobody here has one of these boards:
//   - only the config collection 0xFF68 / 0x61, output and input report 0, 64 bytes (SonixLink);
//   - everything is read first; nothing is written until that read is complete and the model is known;
//   - writes stay off until setWritesEnabled(true) (FCC does the same for its "untested" boards);
//   - every frame passes checkFrame() (sonix-protocol.ts) before it's sent, and a whole write is checked
//     before its first frame goes out; the Rust bridge should repeat the check (fcc-frames.txt);
//   - settings writes may change only sleep, polling, stability and wake (stateful guard on top);
//   - before the first write, onBeforeFirstWrite() gets the full read so the app can save a backup;
//   - after every write the region is read back and compared;
//   - live key travel is not offered: on these boards it only exists inside calibration mode (0x64),
//     which also recalibrates every key pressed and is blocked.
import * as P from "./sonix-protocol.ts";
import { detectSonix, modelOf, type SonixDetection, type SonixKey, type SonixModel } from "./sonix-devices.ts";
import { SonixLink, type SonixLinkOptions, type SonixRegions } from "./sonix-link.ts";
import type { HidLike } from "../types.ts";

export type { SonixRegions };

export interface SonixSessionOptions extends SonixLinkOptions {
  /** Called once, before the first write of the session, with the full read. Throwing cancels the write. */
  onBeforeFirstWrite?: (snapshot: SonixSnapshot) => Promise<void> | void;
  /** Start with writes allowed (default false). */
  writesEnabled?: boolean;
}

export interface SonixSnapshot {
  format: "onboard-fcc-sonix";
  version: 1;
  vendorId: number;
  productId: number;
  productName: string;
  model: string | null;
  firmware: string | null;
  readAt: string;
  regions: Record<P.RegionName, number[]>;
}

export type SonixFeature =
  | "actuation"
  | "rapidTrigger"
  | "deadZones"
  | "socd"
  | "snapTap"
  | "dks"
  | "modTap"
  | "toggle"
  | "rappySnappy"
  | "remap"
  | "layers"
  | "macros"
  | "lighting"
  | "perKeyRgb"
  | "polling"
  | "sleep"
  | "liveTravel";

export interface SonixFeatureState {
  supported: boolean;
  writable: boolean;
  note?: string;
}

export interface SonixIdentity {
  vendorId: number;
  productId: number;
  productName: string;
  model: string | null;
  firmware: string | null;
  /** FCC confirmed this model on hardware (only the Fighting68). */
  verified: boolean;
  /** The model guess is certain (USB ids can be shared by several boards). */
  certain: boolean;
}

/** Per-key trigger settings in mm. */
export interface SonixKeyTrigger {
  index: number;
  actuationMm: number;
  rapidTrigger: boolean;
  pressMm: number;
  releaseMm: number;
  continuous: boolean;
}

export interface SonixTriggerChange {
  index: number;
  actuationMm?: number;
  /** false turns rapid trigger off; true needs pressMm / releaseMm (or keeps the current ones). */
  rapidTrigger?: boolean;
  pressMm?: number;
  releaseMm?: number;
  continuous?: boolean;
}

export interface SonixTravelLimits {
  travelMm: number;
  actuationMinMm: number;
  actuationMaxMm: number;
  sensitivityMinMm: number;
  sensitivityMaxMm: number;
  stepMm: number;
}

const MM = 100; // protocol units per mm (RT, actuation)

const feature = (supported: boolean, writable: boolean, note?: string): SonixFeatureState => ({ supported, writable: supported && writable, note });

export class SonixSession {
  readonly dev: HidLike;
  readonly opts: SonixSessionOptions;
  detection: SonixDetection;
  regions: SonixRegions | null = null;
  info: P.SonixInfo | null = null;
  readAt: string | null = null;
  readonly #link: SonixLink;
  #userWrites: boolean;
  #backedUp = false;

  private constructor(dev: HidLike, link: SonixLink, detection: SonixDetection, opts: SonixSessionOptions) {
    this.dev = dev;
    this.#link = link;
    this.detection = detection;
    this.opts = opts;
    this.#userWrites = !!opts.writesEnabled;
  }

  /** Opens the config collection, reads everything and works out the model. */
  static async open(dev: HidLike, opts: SonixSessionOptions = {}): Promise<SonixSession> {
    const detection = detectSonix(dev.vendorId, dev.productId, dev.productName);
    if (dev.collections?.length && !dev.collections.some((c) => c.usagePage === P.SONIX.usagePage && c.usage === P.SONIX.usage))
      throw new Error("This HID device isn't the keyboard's 0xFF68 / 0x61 configuration collection.");
    if (!detection.candidates.length) throw new Error(`${dev.productName || "This keyboard"} (${dev.vendorId.toString(16)}:${dev.productId.toString(16)}) isn't a listed wired Sonix HE board.`);
    const link = await SonixLink.open(dev, opts);
    const s = new SonixSession(dev, link, detection, opts);
    try {
      await s.refresh();
    } catch (e) {
      await s.close().catch(() => undefined);
      throw e;
    }
    return s;
  }

  /** "ok" until the keyboard reports a disconnect or the session closes. */
  get link(): "ok" | "lost" | "closed" {
    return this.#link.state;
  }

  // -------------------------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------------------------

  get model(): SonixModel | null {
    return this.detection.model;
  }

  /** Picks the model when several boards share the USB id (detection.certain is false). */
  chooseModel(id: string): void {
    const m = this.detection.candidates.find((c) => c.id === id);
    if (!m) throw new Error(`${id} isn't one of the boards with this USB id.`);
    this.detection = { ...this.detection, model: modelOf(m), certain: true, verified: m.status === "verified" };
  }

  get readOnlyReason(): string | null {
    if (!this.regions || !this.info) return "The keyboard hasn't been read yet.";
    if (this.link !== "ok") return "The keyboard disconnected.";
    if (!this.detection.model) return "SYNQ doesn't know this board's layout.";
    if (!this.detection.certain) return `Several boards share this USB id (${this.detection.candidates.map((c) => c.name).join(", ")}); choose the model first.`;
    if (this.info.vendorId !== this.dev.vendorId || this.info.productId !== this.dev.productId)
      return `The keyboard reports ids ${this.info.vendorId.toString(16)}:${this.info.productId.toString(16)}, not its USB ids; left read-only.`;
    return null;
  }

  get writesEnabled(): boolean {
    return this.#userWrites && this.readOnlyReason === null;
  }

  setWritesEnabled(on: boolean): void {
    this.#userWrites = on;
  }

  /** Key indices whose stored binding is a type SYNQ can't write back (the key map is then read-only). */
  unknownBindings(): number[] {
    if (!this.regions) return [];
    const keys = this.regions.keys;
    const out: number[] = [];
    for (let i = 0; i < P.KEY_SLOTS; i++) if (P.bindingProblem(keys[i * 4], keys[i * 4 + 1], keys[i * 4 + 2], keys[i * 4 + 3])) out.push(i);
    return out;
  }

  get settings(): P.SonixSettings | null {
    return this.regions ? P.decodeSettings(this.regions.settings) : null;
  }

  get led(): P.Led | null {
    return this.regions ? P.decodeLed(this.regions.led) : null;
  }

  get identity(): SonixIdentity {
    const m = this.detection.model;
    return {
      vendorId: this.dev.vendorId,
      productId: this.dev.productId,
      productName: this.dev.productName,
      model: m?.name ?? null,
      firmware: this.info?.firmware ?? null,
      verified: this.detection.verified,
      certain: this.detection.certain,
    };
  }

  get capabilities(): Readonly<Record<SonixFeature, SonixFeatureState>> {
    const keymapOk = this.unknownBindings().length === 0;
    const keymapNote = keymapOk ? undefined : `Key indices ${this.unknownBindings().join(", ")} hold bindings SYNQ doesn't know, so the key map stays read-only.`;
    return {
      actuation: feature(true, true),
      rapidTrigger: feature(true, true),
      deadZones: feature(true, false, "Two global dead-zone bytes exist (settings bytes 8 and 9) but their unit is unknown and FCC never writes them; there are no per-key dead zones."),
      socd: feature(true, keymapOk, keymapNote),
      snapTap: feature(true, keymapOk, keymapNote ?? "Snap tap is SOCD mode 3 (last input wins)."),
      dks: feature(true, keymapOk, keymapNote),
      modTap: feature(true, keymapOk, keymapNote),
      toggle: feature(true, keymapOk, keymapNote),
      rappySnappy: feature(true, keymapOk, keymapNote),
      remap: feature(true, keymapOk, keymapNote),
      layers: feature(false, false, "Only the base layer: the Fn region reads back but firmware 1.25 ignores it (FCC docs/PROTOCOL.md)."),
      macros: feature(true, true),
      lighting: feature(true, true),
      perKeyRgb: feature(true, true),
      polling: feature(true, true),
      sleep: feature(true, true),
      liveTravel: feature(false, false, "These boards only stream key travel in calibration mode, which also recalibrates keys; SYNQ blocks it."),
    };
  }

  get keys(): readonly SonixKey[] {
    return this.detection.model?.keys ?? [];
  }

  get layoutIndexes(): number[] {
    return this.keys.map((k) => k.index);
  }

  get limits(): SonixTravelLimits {
    const rt = this.detection.model?.rt ?? { travel: 330, actuationMin: 10, actuationMax: 330, sensMin: 8, sensMax: 240 };
    return { travelMm: rt.travel / MM, actuationMinMm: rt.actuationMin / MM, actuationMaxMm: rt.actuationMax / MM, sensitivityMinMm: rt.sensMin / MM, sensitivityMaxMm: rt.sensMax / MM, stepMm: 0.01 };
  }

  snapshot(): SonixSnapshot {
    if (!this.regions) throw new Error("Nothing has been read yet.");
    return {
      format: "onboard-fcc-sonix",
      version: 1,
      vendorId: this.dev.vendorId,
      productId: this.dev.productId,
      productName: this.dev.productName,
      model: this.detection.model?.id ?? null,
      firmware: this.info?.firmware ?? null,
      readAt: this.readAt ?? new Date().toISOString(),
      regions: Object.fromEntries(Object.entries(this.regions).map(([k, v]) => [k, Array.from(v)])) as Record<P.RegionName, number[]>,
    };
  }

  refresh(): Promise<void> {
    return this.#link.run(async () => {
      const out = await this.#link.readAll();
      this.regions = out;
      this.info = P.decodeInfo(out.info);
      this.readAt = new Date().toISOString();
    });
  }

  // -------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------

  /**
   * One change, run in the serial queue: `build` computes the new region bytes from the current ones
   * (so back-to-back calls never build on stale data). Regions are written in the order returned, then
   * the commit frame if any needs it, then each is read back and compared.
   */
  #apply(label: string, build: (r: SonixRegions, m: SonixModel) => [P.RegionName, Uint8Array][]): Promise<string> {
    return this.#link.run(async () => {
      if (!this.#userWrites) throw new Error("Changes are off for this keyboard. Allow changes first.");
      const why = this.readOnlyReason;
      if (why) throw new Error(why);
      const regions = this.regions!;
      const changes = build(regions, this.detection.model!);
      const pending = changes.filter(([name, data]) => P.readBackMismatch(name, data, regions[name]) >= 0);
      if (!pending.length) return `${label}: nothing to change.`;
      // Check every frame of the whole change before the first one goes out.
      const plan = pending.map(([name, data]) => {
        if (name === "settings") {
          const problem = P.settingsChangeProblem(regions.settings, data);
          if (problem) throw new Error(problem);
        }
        for (const f of P.encodeRegionWrite(name, data)) {
          const c = P.checkFrame(f);
          if (!c.ok) throw new Error(`${label}: ${c.reason}`);
        }
        return { name, data };
      });
      if (!this.#backedUp) {
        await this.opts.onBeforeFirstWrite?.(this.snapshot());
        this.#backedUp = true;
      }
      await this.#link.writeRegions(
        plan.map(({ name, data }) => [name, data] as const),
        label,
      );
      for (const { name, data } of plan) {
        const back = await this.#link.readRegion(name);
        regions[name] = back;
        const at = P.readBackMismatch(name, data, back);
        if (at >= 0) throw new Error(`${label}: the keyboard reads back different ${name} data (byte ${at}: wrote ${data[at]}, read ${back[at]}).`);
      }
      return `${label}: saved.`;
    });
  }

  /** Raw per-key RT patches (0.01 mm), computed from the current RT bytes. The switch type byte is never changed. */
  #rt(label: string, make: (rt: Uint8Array) => { index: number; patch: P.RtPatch }[]): Promise<string> {
    return this.#apply(label, (r, m) => {
      let rt = r.rt;
      for (const c of make(r.rt)) {
        this.#requireKey(c.index);
        rt = P.withRT(rt, [c.index], c.patch, m.rt, m.limits.actuationDefault);
      }
      return [["rt", rt]];
    });
  }

  async setRt(label: string, changes: { index: number; patch: P.RtPatch }[]): Promise<string> {
    return this.#rt(label, () => changes);
  }

  /** Plain remaps (key, combo, media, mouse, wheel, macro, default). Advanced bindings on those keys are cleared with their partners. */
  async setBindings(label: string, changes: { index: number; binding: P.Binding }[]): Promise<string> {
    return this.#apply(label, (r) => {
      for (const c of changes) {
        this.#requireKey(c.index);
        if (["socd", "rs", "dks", "modtap", "toggle", "unknown"].includes(c.binding.type)) throw new Error("Use the advanced-key methods for SOCD, rappy snappy, DKS, mod-tap and toggle.");
      }
      const cleared = P.clearAdvanced(r.keys, r.dks, changes.map((c) => c.index), this.layoutIndexes);
      let keys = cleared.keys;
      for (const c of changes) keys = P.withBinding(keys, [c.index], c.binding);
      return [
        ["keys", keys],
        ["dks", cleared.dks],
      ];
    });
  }

  /** SOCD on two keys (mode 3 = last input wins = snap tap). Clears whatever advanced binding they had. */
  async setSocd(index1: number, index2: number, mode: number = P.SOCD_MODE.lastInput): Promise<string> {
    return this.#pair("SOCD", index1, index2, (h1, h2) => P.socdBinding(mode, h1, h2));
  }

  async setRappySnappy(index1: number, index2: number): Promise<string> {
    return this.#pair("Rappy snappy", index1, index2, (h1, h2) => P.rsBinding(h1, h2));
  }

  async setModTap(index: number, holdHid: number, tapHid: number, ms = 400): Promise<string> {
    return this.#single("Mod-tap", index, { type: "modtap", hold: holdHid, tap: tapHid, ms });
  }

  async setToggle(index: number, hid: number): Promise<string> {
    return this.#single("Toggle", index, { type: "toggle", code: hid });
  }

  /** Dynamic keystroke on one key: fills a free DKS slot (or the key's own), then points the key at it. */
  async setDks(index: number, slot: P.DksSlot): Promise<string> {
    return this.#apply("Dynamic keystroke", (r, m) => {
      this.#requireKey(index);
      const current = P.decodeBinding(r.keys, index);
      const cleared = P.clearAdvanced(r.keys, r.dks, [index], this.layoutIndexes);
      const slotNo = current.type === "dks" && current.slot >= 1 ? current.slot : P.freeDksSlot(cleared.dks);
      if (slotNo === null) throw new Error("Every DKS slot is in use.");
      this.#requireAdvancedRoom(cleared.keys, cleared.dks, 1);
      const dks = P.withDks(cleared.dks, slotNo, slot, Math.floor(m.rt.travel / 10));
      const keys = P.withBinding(cleared.keys, [index], { type: "dks", slot: slotNo });
      // The slot is written before the key points at it.
      return [
        ["dks", dks],
        ["keys", keys],
      ];
    });
  }

  /** Back to the key's native function, with pair partners and owned DKS slots. */
  async clearAdvanced(indexes: number[]): Promise<string> {
    return this.#apply("Advanced keys cleared", (r) => {
      indexes.forEach((i) => this.#requireKey(i));
      const { keys, dks } = P.clearAdvanced(r.keys, r.dks, indexes, this.layoutIndexes);
      // The key stops pointing at its slot before the slot is cleared.
      return [
        ["keys", keys],
        ["dks", dks],
      ];
    });
  }

  async setLighting(patch: Partial<P.Led>): Promise<string> {
    return this.#apply("Lighting", (r) => [["led", P.encodeLed(r.led, { ...P.decodeLed(r.led), ...patch })]]);
  }

  async setKeyColors(colors: ReadonlyMap<number, readonly [number, number, number]>): Promise<string> {
    return this.#apply("Key colours", (r) => {
      for (const i of colors.keys()) this.#requireKey(i);
      return [["colors", P.withColors(r.colors, colors)]];
    });
  }

  async setSettings(patch: P.SettingsPatch): Promise<string> {
    return this.#apply("Keyboard settings", (r) => [["settings", P.encodeSettings(r.settings, patch)]]);
  }

  async setMacros(macros: P.MacroEvent[][]): Promise<string> {
    return this.#apply("Macros", () => [["macros", P.encodeMacros(macros, this.info?.macroCapacity || undefined)]]);
  }

  macros(): P.MacroEvent[][] {
    return this.regions ? P.decodeMacros(this.regions.macros) : [];
  }

  advanced(): P.AdvancedEntry[] {
    return this.regions ? P.listAdvanced(this.regions.keys, this.regions.dks, this.layoutIndexes) : [];
  }

  // -------------------------------------------------------------------------------------------
  // Millimetre helpers
  // -------------------------------------------------------------------------------------------

  keyTriggers(): SonixKeyTrigger[] {
    if (!this.regions) return [];
    return this.keys.map((k) => {
      const rt = P.decodeRT(this.regions!.rt, k.index);
      return { index: k.index, actuationMm: rt.actuation / MM, rapidTrigger: P.rtEnabled(rt), pressMm: rt.press / MM, releaseMm: rt.release / MM, continuous: !!(rt.flags & P.RT_FLAG.continuous) };
    });
  }

  #patchFor(c: Omit<SonixTriggerChange, "index">, current: P.KeyRT): P.RtPatch {
    const m = this.#requireModel();
    const p: P.RtPatch = {};
    if (c.actuationMm !== undefined) p.actuation = Math.round(c.actuationMm * MM);
    if (c.rapidTrigger === false) {
      p.press = 0;
      p.release = 0;
    } else if (c.rapidTrigger === true || c.pressMm !== undefined || c.releaseMm !== undefined) {
      p.press = c.pressMm !== undefined ? Math.round(c.pressMm * MM) : current.press || m.limits.sensDefault;
      p.release = c.releaseMm !== undefined ? Math.round(c.releaseMm * MM) : current.release || m.limits.sensDefault;
    }
    if (c.continuous !== undefined) p.flags = (current.flags & ~P.RT_FLAG.continuous) | (c.continuous ? P.RT_FLAG.continuous : 0);
    return p;
  }

  async setKeyTriggers(changes: SonixTriggerChange[]): Promise<string> {
    return this.#rt("Key triggers", (rt) => changes.map((c) => ({ index: c.index, patch: this.#patchFor(c, P.decodeRT(rt, c.index)) })));
  }

  async setGlobalTrigger(change: Omit<SonixTriggerChange, "index">): Promise<string> {
    return this.#rt("All keys", (rt) => this.keys.map((k) => ({ index: k.index, patch: this.#patchFor(change, P.decodeRT(rt, k.index)) })));
  }

  pollingRates(): readonly number[] {
    return P.POLL_HZ;
  }

  pollingRate(): number | null {
    return this.settings?.pollHz ?? null;
  }

  async setPollingRate(hz: number): Promise<string> {
    return this.setSettings({ pollHz: hz });
  }

  /** Always null: these boards only stream key travel in calibration mode, which SYNQ blocks. */
  startLiveTravel(): null {
    return null;
  }

  async close(): Promise<void> {
    await this.#link.close();
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  #requireModel(): SonixModel {
    if (!this.regions) throw new Error("The keyboard hasn't been read yet.");
    const m = this.detection.model;
    if (!m) throw new Error("SYNQ doesn't know this board's layout.");
    return m;
  }

  #requireKey(index: number): SonixKey {
    const k = this.#requireModel().keys.find((x) => x.index === index);
    if (!k) throw new Error(`Key index ${index} isn't on this board.`);
    return k;
  }

  #requireAdvancedRoom(keys: Uint8Array, dks: Uint8Array, adding: number) {
    const used = P.listAdvanced(keys, dks, this.layoutIndexes).length;
    if (used + adding > P.MAX_ADVANCED) throw new Error(`At most ${P.MAX_ADVANCED} advanced keys.`);
  }

  #pair(label: string, index1: number, index2: number, make: (hid1: number, hid2: number) => P.Binding): Promise<string> {
    return this.#apply(label, (r) => {
      if (index1 === index2) throw new Error(`${label} needs two different keys.`);
      const k1 = this.#requireKey(index1);
      const k2 = this.#requireKey(index2);
      if (!k1.hid || !k2.hid) throw new Error(`${label} needs keys with a normal key function (not Fn).`);
      const cleared = P.clearAdvanced(r.keys, r.dks, [index1, index2], this.layoutIndexes);
      this.#requireAdvancedRoom(cleared.keys, cleared.dks, 1);
      return [
        ["keys", P.withBinding(cleared.keys, [index1, index2], make(k1.hid, k2.hid))],
        ["dks", cleared.dks],
      ];
    });
  }

  #single(label: string, index: number, b: P.Binding): Promise<string> {
    return this.#apply(label, (r) => {
      this.#requireKey(index);
      const cleared = P.clearAdvanced(r.keys, r.dks, [index], this.layoutIndexes);
      this.#requireAdvancedRoom(cleared.keys, cleared.dks, 1);
      return [
        ["keys", P.withBinding(cleared.keys, [index], b)],
        ["dks", cleared.dks],
      ];
    });
  }
}
