// ASUS Gear Link magnetic keyboards as a generic-panel driver (src/lib/kb/types.ts KbDriver/KbBackend):
// Azoth 96 HE, Falcata, Falchion Ace 75 HE, TX75 Analog / Core, TUF K4 Magnetic (0.01 mm boards), and
// the plain Falchion Ace HFX 0x1B7E (0.1 mm, Legacy Mode). The HFX ZywOo 0x1D1D is NOT claimed: it keeps
// its own verified panel (src/lib/keyboard.ts).
//
// Every frame goes through FrameSession -> classifyAsusFrame (guard.ts) before it reaches the device.
// Writes are followed by `50 55` (save), as Gear Link does. Read-back: the 0.01 mm boards answer the
// 25 0x (he-v1) or 25 Ax (he-v2) getters; the HFX cannot report its settings (Legacy Mode), so its
// changes come back "unconfirmed".
import type {
  AnalogField,
  AnalogValues,
  BlockedCommand as KbBlocked,
  KbBackend,
  KbChange,
  KbContext,
  KbDriver,
  KbOption,
  KbPlan,
  KbState,
  KbSupport,
  KeyIndex,
  LightingSetting,
  NumberSpec,
} from "../../kb/types.ts";
import { codesForForm, layoutFromGrid } from "../ansi-layout.ts";
import { FrameSession } from "../frame-session.ts";
import type { HidLike } from "../types.ts";
import { ASUS_REPORT_LENGTH, ASUS_VID, asusControlReportId, asusKeyboardTraits, asusModel, pickControlPage, type AsusKeyboardTraits, type AsusModel } from "./devices.ts";
import { ASUS_BLOCKED, classifyAsusFrame } from "./guard.ts";
import * as C from "./keyboard-codec.ts";

/** Owned by src/lib/keyboard.ts (verified panel); never claimed here. */
export const FALCHION_ZYWOO_PID = 0x1d1d;

const asHid = (d: unknown) => d as HidLike;

export function claimsAsusKeyboard(vendorId: number, productId: number, collections: readonly { usagePage?: number; usage?: number }[] = []): AsusModel | null {
  if (vendorId !== ASUS_VID || productId === FALCHION_ZYWOO_PID) return null;
  const m = asusModel(productId);
  if (!m || m.kind !== "keyboard" || !m.analog) return null;
  if (collections.length && pickControlPage(collections) !== 0xff00) return null;
  return m;
}

/** The keyboard's control channel: FF00:0001, output report 0 over USB or 2 through its own dongle. */
export function asusLink(device: HidLike, productId: number, log?: (dir: "out" | "in", b: Uint8Array, note?: string) => void): FrameSession {
  const reportId = asusControlReportId((device.collections ?? []) as Parameters<typeof asusControlReportId>[0], 0xff00);
  if (reportId < 0) throw new Error("The keyboard's control collection uses an unexpected report id; SYNQ won't guess.");
  return new FrameSession({
    device,
    reportId,
    length: ASUS_REPORT_LENGTH,
    guard: (f) => classifyAsusFrame(productId, f),
    isAnswer: C.isAnswer,
    isRejected: C.isRejected,
    // A flash save echoes in ~100-270 ms on the HFX; profile switches ~100 ms.
    timeoutFor: (f) => (f[0] === 0x50 || (f[0] === 0x51 && f[1] === 0x00) ? 1500 : 600),
    log,
  });
}

interface KeyAnalog {
  actuationMm: number | null;
  deadTopMm: number | null;
  deadBottomMm: number | null;
  rt: C.RapidTriggerMm | null;
}

interface Lighting {
  effect: "static" | "breathing" | "colorCycle" | "reactive" | "starryNight" | "current" | "raindrop";
  brightness: number;
  hue: number;
  sat: number;
}

const EFFECTS: readonly Lighting["effect"][] = ["static", "breathing", "colorCycle", "reactive", "starryNight", "current", "raindrop"];
const EFFECT_LABEL: Record<Lighting["effect"], string> = { static: "Static", breathing: "Breathing", colorCycle: "Color cycle", reactive: "Reactive", starryNight: "Starry night", current: "Current", raindrop: "Raindrop" };

function hsvToRgb(h: number, s: number): { r: number; g: number; b: number } {
  const H = (h / 255) * 6;
  const S = s / 255;
  const i = Math.floor(H) % 6;
  const f = H - Math.floor(H);
  const p = Math.round(255 * (1 - S));
  const q = Math.round(255 * (1 - S * f));
  const t = Math.round(255 * (1 - S * (1 - f)));
  const v = 255;
  return [
    { r: v, g: t, b: p },
    { r: q, g: v, b: p },
    { r: p, g: v, b: t },
    { r: p, g: q, b: v },
    { r: t, g: p, b: v },
    { r: v, g: p, b: q },
  ][i];
}

const toKbBlocked = (): KbBlocked[] =>
  ASUS_BLOCKED.map((b) => ({
    what: b.what,
    why: b.why === "profile-wipe" ? "factory-reset" : b.why === "demo" || b.why === "unknown" ? "unverified" : (b.why as KbBlocked["why"]),
  }));

export class AsusKbBackend implements KbBackend {
  readonly driver = "asus-gearlink";
  readonly model: AsusModel;
  readonly traits: AsusKeyboardTraits;
  readonly blocked: readonly KbBlocked[] = toKbBlocked();
  readonly support: KbSupport;
  readonly link: FrameSession;
  /** FW key indices treated as analog keys (form-factor based; see keys()). */
  readonly keys: readonly number[];
  #state: KbState;
  #global: KeyAnalog = { actuationMm: null, deadTopMm: null, deadBottomMm: null, rt: null };
  #perKey = new Map<number, KeyAnalog>();
  #codes = new Map<number, number>();
  #rtMode: boolean | null = null;
  #speedTap: boolean | null = null;
  #pairs: [number, number][] = [];
  #pollingHz: number | null = null;
  #profile: number | null = null;
  #profiles = 6;
  #firmware = "";
  #lighting: Lighting | null = null;

  constructor(device: HidLike, model: AsusModel, log?: (dir: "out" | "in", b: Uint8Array, note?: string) => void) {
    this.model = model;
    this.traits = asusKeyboardTraits(model);
    this.link = asusLink(device, model.pid, log);
    const names = codesForForm(this.traits.form);
    this.keys = (Object.keys(C.FW_KEY) as C.KeyName[]).filter((n) => names.has(n) && n !== "FN").map((n) => C.FW_KEY[n]);
    this.support = {
      tier: "read-only",
      why:
        this.traits.cls === "hfx"
          ? "Built from the captured Falchion Ace HFX ZywOo protocol (same Gear Link class); not tried on this PID with SYNQ."
          : "Built from ASUS Gear Link's web-app code (2026-10-13); not tried on this model with SYNQ yet.",
    };
    this.#state = this.#build();
  }

  get state(): KbState {
    return this.#state;
  }

  get #spec(): C.KbUnitSpec {
    return { cls: this.traits.cls, unitMm: this.model.analog!.unitMm };
  }
  get #getters(): C.Getters | null {
    return this.traits.cls === "he-v1" ? "v1" : this.traits.cls === "he-v2" ? "v2" : null;
  }

  async #ask(f: Uint8Array): Promise<Uint8Array> {
    return this.link.request(f);
  }

  async load(): Promise<KbState> {
    const basic = C.decodeBasic(await this.#ask(C.encodeReadBasic()));
    this.#firmware = basic.firmware;
    this.#profiles = basic.profiles || 6;
    this.#profile = basic.currentProfile;
    this.#rtMode = C.decodeStateByteSafe(await this.#ask(C.encodeReadRtMode()));
    this.#speedTap = C.decodeStateByteSafe(await this.#ask(C.encodeReadSpeedTap()));
    const g = this.#getters;
    if (g) {
      const unit = this.model.analog!.unitMm;
      this.#global.actuationMm = C.decodeActuation(g, await this.#ask(C.encodeReadActuation(g, null)), unit);
      const dz = C.decodeDeadZones(g, await this.#ask(C.encodeReadDeadZones(g, null)), unit);
      this.#global.deadTopMm = dz.topMm;
      this.#global.deadBottomMm = dz.bottomMm;
      for (const k of this.keys) await this.#readKey(k);
      this.#pairs = [
        ...C.decodeSpeedTapPairs(await this.#ask(C.encodeReadSpeedTapPairs(0)), 0),
        ...C.decodeSpeedTapPairs(await this.#ask(C.encodeReadSpeedTapPairs(1)), 1),
      ];
      if (this.traits.polling51) this.#pollingHz = C.decodePollingIndex(await this.#ask(C.encodeReadPollingIndex()));
    }
    this.#state = this.#build();
    return this.#state;
  }

  async #readKey(k: number): Promise<KeyAnalog> {
    const g = this.#getters!;
    const unit = this.model.analog!.unitMm;
    const dz = C.decodeDeadZones(g, await this.#ask(C.encodeReadDeadZones(g, k)), unit);
    const rt = C.decodeRapidTrigger(g, await this.#ask(C.encodeReadRapidTrigger(g, k)), unit);
    const a: KeyAnalog = {
      actuationMm: C.decodeActuation(g, await this.#ask(C.encodeReadActuation(g, k)), unit),
      deadTopMm: dz.topMm,
      deadBottomMm: dz.bottomMm,
      rt,
    };
    this.#perKey.set(k, a);
    const trig = C.decodeKeyTrigger(g, await this.#ask(C.encodeReadKeyTrigger(g, k)));
    if (trig.type === 0) this.#codes.set(k, trig.target);
    return a;
  }

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------

  #values(a: KeyAnalog): AnalogValues {
    const rt = a.rt;
    return {
      actuationMm: a.actuationMm,
      deadTopMm: a.deadTopMm,
      deadBottomMm: a.deadBottomMm,
      rapidTrigger: rt ? rt.enabled : null,
      rtPressMm: rt ? (rt.independent ? rt.pressMm : rt.sensitivityMm) : null,
      rtReleaseMm: rt ? (rt.independent ? rt.releaseMm : rt.sensitivityMm) : null,
    };
  }

  #globalValues(): AnalogValues {
    const first = this.#perKey.get(this.keys[0]);
    const v = this.#values(this.#global);
    if (first?.rt) {
      const f = this.#values(first);
      v.rtPressMm = f.rtPressMm;
      v.rtReleaseMm = f.rtReleaseMm;
    }
    v.rapidTrigger = this.#rtMode;
    return v;
  }

  #build(): KbState {
    const a = this.model.analog!;
    const spec = (r: { min: number; max: number; step: number }): NumberSpec => ({ min: r.min, max: r.max, step: r.step, unit: "mm", decimals: r.step < 0.1 ? 2 : 1 });
    const readable = this.#getters !== null;
    const writable: AnalogField[] = ["actuationMm", "deadTopMm", "deadBottomMm", "rapidTrigger", "rtPressMm", "rtReleaseMm"];
    const perKey: Record<KeyIndex, AnalogValues> = {};
    for (const [k, v] of this.#perKey) perKey[k] = this.#values(v);
    const layout = layoutFromGrid(
      (Object.keys(C.FW_KEY) as C.KeyName[]).filter((n) => this.keys.includes(C.FW_KEY[n]) || n === "FN").map((n) => ({ index: C.FW_KEY[n], code: n })),
      "Standard ANSI positions filtered to this board's form factor (approximate; Gear Link key indices).",
    );
    const options: KbOption[] = [
      { id: "speedTap", label: "Speed Tap", hint: this.#pairs.length ? `Pairs: ${this.#pairs.map(([x, y]) => `${C.keyNameFromFw(x) ?? x}/${C.keyNameFromFw(y) ?? y}`).join(", ")}` : "Last-pressed key wins between paired keys.", kind: "toggle", value: this.#speedTap === null ? null : this.#speedTap ? 1 : 0, writable: true },
    ];
    if (this.traits.rtEnableCommand) options.push({ id: "rapidTriggerMode", label: "Rapid trigger mode", kind: "toggle", value: this.#rtMode === null ? null : this.#rtMode ? 1 : 0, writable: true });
    const l = this.#lighting;
    const lightingSettings: LightingSetting[] = [
      { id: "effect", label: "Effect", kind: "choice", choice: { options: EFFECTS.map((e, i) => ({ value: i, label: EFFECT_LABEL[e] })) }, value: l ? EFFECTS.indexOf(l.effect) : null, writable: true },
      { id: "brightness", label: "Brightness", kind: "range", spec: { min: 0, max: 100, step: 1, unit: "%" }, value: l?.brightness ?? null, writable: true },
      { id: "color", label: "Colour", kind: "color", value: l ? ([l.hue, l.sat] as const) : null, writable: true },
    ];
    return {
      info: {
        brand: "ASUS",
        model: this.model.name,
        driver: this.driver,
        protocol: `Gear Link ${this.traits.cls} (${a.unitMm} mm units)`,
        firmware: this.#firmware ? [this.#firmware] : [],
        connection: "USB",
        extra: [["Product", this.model.productNumber.toUpperCase()], ["PID", `0x${this.model.pid.toString(16).padStart(4, "0")}`]],
      },
      analog: {
        scope: "both",
        keys: this.keys,
        travelMm: a.actuation.max,
        fields: {
          actuationMm: spec(a.actuation),
          deadTopMm: spec(a.deadZone),
          deadBottomMm: spec(a.deadZone),
          rapidTrigger: "toggle",
          rtPressMm: spec(a.rapidTrigger),
          rtReleaseMm: spec(a.rapidTrigger),
        },
        writable,
        global: readable ? this.#globalValues() : null,
        perKey,
        source: readable ? "device" : "unknown",
        note: readable ? undefined : "This keyboard cannot report its analog settings (Gear Link Legacy Mode). Values appear after SYNQ writes them.",
      },
      keymap: {
        layout,
        layers: 2,
        codes: [readable ? Object.fromEntries(this.#codes) : null, null],
        keySpace: "vendor",
        assignable: [{ code: C.KEY_DISABLED, label: "Disabled", group: "Special" }, ...(Object.keys(C.FW_KEY) as C.KeyName[]).filter((n) => n !== "FN").map((n) => ({ code: C.FW_KEY[n], label: n, group: "Keys" }))],
        writable: true,
        source: readable ? "device" : "unknown",
        note: "Layer 2 is the Fn layer (Gear Link addresses it as 0x9F00 + key).",
      },
      lighting: { groups: [{ id: "main", label: "Lighting", settings: lightingSettings }], source: l ? "cache" : "unknown", note: "The keyboard does not report its lighting; SYNQ shows what it last wrote." },
      polling: this.traits.polling51
        ? { hz: this.#pollingHz, options: [...C.KB_POLLING_HZ], writable: true, note: "Changing it may make the keyboard reconnect." }
        : { hz: null, options: [], writable: false, note: "This board sets polling through Gear Link's Normal / Zone / Power-saving modes, which SYNQ does not drive yet." },
      profiles: { active: this.#profile, count: this.#profiles, names: Array.from({ length: this.#profiles }, (_, i) => (i + 1 === this.#profiles ? "Default" : `Profile ${i + 1}`)), writable: true },
      options,
      notes: [],
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------------------------

  #range(label: string, v: number, r: { min: number; max: number }): number {
    if (!Number.isFinite(v) || v < r.min - 1e-9 || v > r.max + 1e-9) throw new Error(`${label} must be between ${r.min} and ${r.max} mm on the ${this.model.name}.`);
    return v;
  }

  #mergedRt(base: C.RapidTriggerMm | null, v: AnalogValues): C.RapidTriggerMm {
    const d = this.model.analog!.defaults;
    const press = v.rtPressMm ?? (base ? (base.independent ? base.pressMm : base.sensitivityMm) : d.rtPress);
    const release = v.rtReleaseMm ?? (base ? (base.independent ? base.releaseMm : base.sensitivityMm) : d.rtRelease);
    return {
      enabled: v.rapidTrigger ?? base?.enabled ?? true,
      continuous: base?.continuous ?? false,
      independent: press !== release,
      sensitivityMm: press,
      pressMm: press,
      releaseMm: release,
    };
  }

  #analogFrames(target: "global" | readonly KeyIndex[], v: AnalogValues): Uint8Array[] {
    const a = this.model.analog!;
    const s = this.#spec;
    if (v.actuationMm != null) this.#range("Actuation", v.actuationMm, a.actuation);
    for (const [k, label] of [["deadTopMm", "Top dead zone"], ["deadBottomMm", "Bottom dead zone"]] as const) if (v[k] != null) this.#range(label, v[k]!, a.deadZone);
    for (const [k, label] of [["rtPressMm", "Rapid trigger press"], ["rtReleaseMm", "Rapid trigger release"]] as const) if (v[k] != null) this.#range(label, v[k]!, a.rapidTrigger);
    const rtTouched = v.rapidTrigger != null || v.rtPressMm != null || v.rtReleaseMm != null;
    const dzTouched = v.deadTopMm != null || v.deadBottomMm != null;
    const out: Uint8Array[] = [];
    if (target === "global") {
      if (v.actuationMm != null) out.push(C.encodeGlobalActuation(s, v.actuationMm));
      if (dzTouched) out.push(C.encodeGlobalDeadZones(s, v.deadTopMm ?? this.#global.deadTopMm ?? a.defaults.dzTop, v.deadBottomMm ?? this.#global.deadBottomMm ?? a.defaults.dzBottom));
      if (rtTouched) {
        // Gear Link's TX75 / K4 pages write rapid trigger per key only; SYNQ does that on every board.
        for (const k of this.keys) out.push(...C.encodeRapidTriggerKey(s, k, this.#mergedRt(this.#perKey.get(k)?.rt ?? null, v)));
        if (v.rapidTrigger != null && this.traits.rtEnableCommand) out.push(C.encodeRapidTriggerEnable(v.rapidTrigger));
      }
    } else {
      if (!target.length) throw new Error("Pick at least one key.");
      for (const k of target) {
        if (!this.keys.includes(k)) throw new Error(`Key ${C.keyNameFromFw(k) ?? k} is not an analog key on this board.`);
        const cur = this.#perKey.get(k);
        if (v.actuationMm != null) out.push(C.encodeKeyActuation(s, k, v.actuationMm));
        if (dzTouched) out.push(C.encodeKeyDeadZones(s, k, v.deadTopMm ?? cur?.deadTopMm ?? a.defaults.dzTop, v.deadBottomMm ?? cur?.deadBottomMm ?? a.defaults.dzBottom));
        if (rtTouched) out.push(...C.encodeRapidTriggerKey(s, k, this.#mergedRt(cur?.rt ?? null, v)));
      }
    }
    if (!out.length) throw new Error("Nothing to change.");
    return out;
  }

  #send(frames: readonly Uint8Array[], save = true): () => Promise<void> {
    for (const f of [...frames, ...(save ? [C.encodeSave()] : [])]) {
      const v = classifyAsusFrame(this.model.pid, f);
      if (v.verdict === "blocked") throw new Error(`SYNQ won't send that (${v.what}: ${v.reason ?? v.why}).`);
    }
    return async () => {
      await this.link.requestAll(frames);
      if (save) await this.link.request(C.encodeSave());
    };
  }

  plan(change: KbChange): KbPlan {
    const g = this.#getters;
    switch (change.kind) {
      case "analog": {
        const frames = this.#analogFrames(change.target, change.values);
        const fields = Object.keys(change.values).filter((k) => change.values[k as AnalogField] != null) as AnalogField[];
        const expected = Object.fromEntries(fields.map((f) => [f, change.values[f]]));
        const n = change.target === "global" ? "all keys" : `${change.target.length} key${change.target.length > 1 ? "s" : ""}`;
        return {
          label: `Analog settings on ${n}`,
          expected,
          persistence: "saved",
          send: this.#send(frames),
          readBack: async () => {
            if (!g) {
              this.#remember(change.target, change.values);
              this.#state = this.#build();
              return undefined;
            }
            if (change.target === "global") {
              const unit = this.model.analog!.unitMm;
              this.#global.actuationMm = C.decodeActuation(g, await this.#ask(C.encodeReadActuation(g, null)), unit);
              const dz = C.decodeDeadZones(g, await this.#ask(C.encodeReadDeadZones(g, null)), unit);
              this.#global.deadTopMm = dz.topMm;
              this.#global.deadBottomMm = dz.bottomMm;
              if (fields.some((f) => f.startsWith("rt") || f === "rapidTrigger")) for (const k of this.keys) await this.#readKey(k);
              if (this.traits.rtEnableCommand) this.#rtMode = C.decodeStateByteSafe(await this.#ask(C.encodeReadRtMode()));
              this.#state = this.#build();
              // Global actuation / dead zones from the global getters; rapid trigger was written per key,
              // so it is checked on the first analog key (and the RT-mode switch where there is one).
              const got = this.#globalValues();
              if (!(this.traits.rtEnableCommand && fields.includes("rapidTrigger"))) got.rapidTrigger = this.#rtOf(this.keys[0]).rapidTrigger ?? null;
              return Object.fromEntries(fields.map((f) => [f, got[f]]));
            }
            for (const k of change.target) await this.#readKey(k);
            this.#state = this.#build();
            const got = this.#values(this.#perKey.get(change.target[0])!);
            return Object.fromEntries(fields.map((f) => [f, got[f]]));
          },
        };
      }
      case "keycode": {
        if (change.layer !== 0 && change.layer !== 1) throw new Error("ASUS boards have a base layer and an Fn layer.");
        if (!this.keys.includes(change.key)) throw new Error("That key can't be remapped here.");
        const source = change.layer === 0 ? change.key : C.fnKey(change.key);
        const act = this.#perKey.get(change.key)?.actuationMm ?? this.#global.actuationMm ?? this.model.analog!.defaults.actuation;
        const frames = [C.encodeRemap(this.#spec, source, change.code, act)];
        return {
          label: `Remap ${C.keyNameFromFw(change.key) ?? change.key}${change.layer ? " (Fn layer)" : ""}`,
          expected: change.code,
          persistence: "saved",
          send: this.#send(frames),
          readBack: async () => {
            if (!g) return undefined;
            const t = C.decodeKeyTrigger(g, await this.#ask(C.encodeReadKeyTrigger(g, source)));
            if (change.layer === 0) this.#codes.set(change.key, t.target);
            this.#state = this.#build();
            return t.target;
          },
        };
      }
      case "polling": {
        if (!this.traits.polling51) throw new Error("This board's polling modes aren't supported yet.");
        const frames = [C.encodePollingRate(change.hz)];
        return {
          label: `Polling rate ${change.hz / 1000} kHz`,
          expected: change.hz,
          persistence: "saved",
          caution: "The keyboard may reconnect after a polling-rate change.",
          send: this.#send(frames),
          readBack: async () => {
            if (!g) return undefined;
            this.#pollingHz = C.decodePollingIndex(await this.#ask(C.encodeReadPollingIndex()));
            this.#state = this.#build();
            return this.#pollingHz;
          },
        };
      }
      case "profile": {
        const frames = [C.encodeSelectProfile(change.index)];
        if (change.index > this.#profiles) throw new Error(`This keyboard has ${this.#profiles} profiles.`);
        return {
          label: `Switch to profile ${change.index}`,
          expected: change.index,
          persistence: "saved",
          send: this.#send(frames, false),
          readBack: async () => {
            const b = C.decodeBasic(await this.#ask(C.encodeReadBasic()));
            this.#profile = b.currentProfile;
            await this.load();
            return b.currentProfile;
          },
        };
      }
      case "option": {
        const on = change.value !== 0;
        if (change.id === "speedTap") {
          return {
            label: `Speed Tap ${on ? "on" : "off"}`,
            expected: on ? 1 : 0,
            persistence: "saved",
            send: this.#send([C.encodeSpeedTapEnable(on)]),
            readBack: async () => {
              if (!g) return undefined;
              this.#speedTap = C.decodeStateByteSafe(await this.#ask(C.encodeReadSpeedTap()));
              this.#state = this.#build();
              return this.#speedTap ? 1 : 0;
            },
          };
        }
        if (change.id === "rapidTriggerMode" && this.traits.rtEnableCommand) {
          return {
            label: `Rapid trigger mode ${on ? "on" : "off"}`,
            expected: on ? 1 : 0,
            persistence: "saved",
            send: this.#send([C.encodeRapidTriggerEnable(on)]),
            readBack: async () => {
              this.#rtMode = C.decodeStateByteSafe(await this.#ask(C.encodeReadRtMode()));
              this.#state = this.#build();
              return this.#rtMode ? 1 : 0;
            },
          };
        }
        throw new Error(`Unknown option ${change.id}.`);
      }
      case "lighting": {
        const l: Lighting = { ...(this.#lighting ?? { effect: "static", brightness: 100, hue: 0, sat: 255 }) };
        if (change.id === "effect") l.effect = EFFECTS[Number(change.value)] ?? l.effect;
        else if (change.id === "brightness") l.brightness = Math.max(0, Math.min(100, Math.round(Number(change.value))));
        else if (change.id === "color" && Array.isArray(change.value)) [l.hue, l.sat] = change.value as [number, number];
        else throw new Error(`Unknown lighting setting ${change.id}.`);
        const color = hsvToRgb(l.hue, l.sat);
        const frames = [C.encodeSimpleLighting({ effect: l.effect, speed: l.effect === "static" ? 255 : 30, brightness: l.brightness, singleColor: true, randomColor: false, colors: [color] })];
        return {
          label: `Lighting ${EFFECT_LABEL[l.effect]} ${l.brightness}%`,
          expected: change.value,
          persistence: "saved",
          send: async () => {
            await this.#send(frames)();
            this.#lighting = l;
            this.#state = this.#build();
          },
          readBack: async () => undefined,
        };
      }
    }
  }

  #rtOf(k: number): AnalogValues {
    const a = this.#perKey.get(k);
    return a ? this.#values(a) : {};
  }

  #remember(target: "global" | readonly KeyIndex[], v: AnalogValues): void {
    const apply = (a: KeyAnalog) => {
      if (v.actuationMm != null) a.actuationMm = v.actuationMm;
      if (v.deadTopMm != null) a.deadTopMm = v.deadTopMm;
      if (v.deadBottomMm != null) a.deadBottomMm = v.deadBottomMm;
      if (v.rapidTrigger != null || v.rtPressMm != null || v.rtReleaseMm != null) a.rt = this.#mergedRt(a.rt, v);
    };
    if (target === "global") apply(this.#global);
    else for (const k of target) apply(this.#perKey.get(k) ?? (this.#perKey.set(k, { actuationMm: null, deadTopMm: null, deadBottomMm: null, rt: null }), this.#perKey.get(k)!));
  }

  snapshot(): unknown {
    return {
      model: { pid: this.model.pid, name: this.model.name, productNumber: this.model.productNumber, cls: this.traits.cls },
      firmware: this.#firmware,
      profile: this.#profile,
      global: this.#global,
      perKey: Object.fromEntries(this.#perKey),
      codes: Object.fromEntries(this.#codes),
      rtMode: this.#rtMode,
      speedTap: { on: this.#speedTap, pairs: this.#pairs },
      pollingHz: this.#pollingHz,
    };
  }

  close(): Promise<void> {
    return this.link.close();
  }
}

export const ASUS_KB_DRIVER: KbDriver = {
  id: "asus-gearlink",
  name: "ASUS Gear Link magnetic keyboards",
  priority: 60,
  vids: [ASUS_VID],
  claims: (device) => claimsAsusKeyboard(device.vendorId, device.productId, (device.collections ?? []) as readonly { usagePage?: number; usage?: number }[]) !== null,
  async open(device, _ctx: KbContext) {
    const m = claimsAsusKeyboard(device.vendorId, device.productId);
    if (!m) throw new Error("Not an ASUS magnetic keyboard SYNQ knows.");
    const b = new AsusKbBackend(asHid(device), m);
    await b.load();
    return b;
  },
  async ping(device) {
    const m = claimsAsusKeyboard(device.vendorId, device.productId);
    if (!m) return false;
    const link = asusLink(asHid(device), m.pid);
    try {
      await link.request(C.encodeReadBasic());
      return true;
    } catch {
      return false;
    } finally {
      await link.close().catch(() => undefined);
    }
  },
};
