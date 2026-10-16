// Sonix HE boards (Fighting68 family, ~135 more) for SYNQ's generic Keyboard panel: the shared
// KbDriver / KbBackend contract (src/lib/kb/types.ts). The panel's KbSession adds tiers, "Allow
// changes", the backup and the read-back verdict; this file only reads, plans and checks frames.
//
// Derived from Fighting Control Center (FCC), https://github.com/shybruh/FightingControlCenter-FCC
// (commit 5cad2404661de383f21dca654300e88764f6bc89), GNU GPL v3.0 or later; part of SYNQ (AGPL-3.0).
//
// What the generic panel gets: per-key actuation / rapid trigger (a "global" change sets every key),
// plain remaps (keys, media, mouse; one layer), lighting, polling, sleep / stability / wake. Advanced
// keys (SOCD / snap tap, rappy snappy, DKS, mod-tap, toggle), per-key colours and macros are encoded
// and tested (sonix-protocol.ts, sonix-session.ts) but the shared KbChange has no kinds for them yet.
// Live key travel: none (calibration mode only, blocked).
import type { AnalogValues, BlockedCommand, HidLike, KbBackend, KbChange, KbContext, KbDriver, KbKey, KbOption, KbPlan, KbState, KbSupport, KeyIndex, LightingSetting, NumberSpec } from "../types.ts";
import { HID_NAMES } from "../../x68he-protocol.ts";
import { AdvancedGate, nativeOf } from "../../advanced/core.ts";
import type { AdvancedPanel } from "../../advanced/types.ts";
import { hsToRgb, rgbToHs } from "../color.ts";
import { fccAdvanced } from "./advanced.ts";
import * as P from "./sonix-protocol.ts";
import { SonixLink, hasConfigCollection, type SonixRegions } from "./sonix-link.ts";
import { SONIX_APPLE_ALIAS, SONIX_VENDOR_ID, detectSonix, isSonixId, type SonixDetection, type SonixModel } from "./sonix-devices.ts";

const MM = 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const hex4 = (n: number) => n.toString(16).padStart(4, "0");

/** What SYNQ never sends to these boards (shown in the panel's "never sends" list). */
export const FCC_BLOCKED: readonly BlockedCommand[] = [
  { what: "Factory reset (0x0F 0xFF) and key-check reset (0x0F 0x05)", why: "factory-reset" },
  { what: "Travel calibration start / save (0x64 / 0x65): FCC's live key travel runs inside it and recalibrates every key pressed", why: "calibration" },
  { what: "Unknown toggles 0x66 / 0x67 and the status command 0x62", why: "unverified" },
  { what: "Fn-layer writes (0x26): firmware 1.25 ignores them and the official driver never sends them", why: "unverified" },
  { what: "Firmware update / bootloader: no command is known for these boards, and every command not on SYNQ's list is refused", why: "firmware" },
  { what: "Changing the switch type of a key (RT byte 0): it selects the travel curve", why: "calibration" },
  { what: "Adaptive calibration, dead-zone bytes and settings bytes nobody understands: only written back unchanged", why: "unverified" },
];

// ---------------------------------------------------------------------------------------------
// Key codes in the generic panel: the 4 binding bytes as one number (keySpace "vendor")
// ---------------------------------------------------------------------------------------------

export const bindingCode = (b: readonly number[]): number => ((b[0] & 0xff) * 0x1000000 + ((b[1] & 0xff) << 16) + ((b[2] & 0xff) << 8) + (b[3] & 0xff));
export const codeBytes = (code: number): [number, number, number, number] => [Math.floor(code / 0x1000000) & 0xff, (code >> 16) & 0xff, (code >> 8) & 0xff, code & 0xff];
const keyCode = (hid: number, mods = 0) => bindingCode(P.encodeBinding({ type: "key", mods, code: hid }));

const MEDIA: readonly [number, string][] = [
  [0xcd, "Play / pause"],
  [0xb5, "Next track"],
  [0xb6, "Previous track"],
  [0xb7, "Stop"],
  [0xe2, "Mute"],
  [0xe9, "Volume up"],
  [0xea, "Volume down"],
  [0x6f, "Brightness up"],
  [0x70, "Brightness down"],
  [0x192, "Calculator"],
  [0x194, "File explorer"],
  [0x223, "Browser home"],
];

/** Codes the panel's picker offers: default, every named HID key, media, mouse buttons and wheel. */
export const FCC_ASSIGNABLE: readonly { code: number; label: string; group: string }[] = [
  { code: 0, label: "Default (the key's own function)", group: "Basic" },
  ...Object.entries(HID_NAMES)
    .map(([hid, label]) => ({ hid: Number(hid), label }))
    .filter(({ hid }) => hid >= 0x04 && hid <= P.MAX_HID)
    .map(({ hid, label }) => ({ code: keyCode(hid), label, group: hid >= 0xe0 ? "Modifiers" : hid >= 0x3a && hid <= 0x45 ? "Function" : "Keys" })),
  ...MEDIA.map(([usage, label]) => ({ code: bindingCode(P.encodeBinding({ type: "media", usage })), label, group: "Media" })),
  ...[
    [1, "Left click"],
    [2, "Right click"],
    [4, "Middle click"],
    [8, "Mouse back"],
    [16, "Mouse forward"],
  ].map(([button, label]) => ({ code: bindingCode(P.encodeBinding({ type: "mouse", button: button as number })), label: label as string, group: "Mouse" })),
  { code: bindingCode(P.encodeBinding({ type: "wheel", dir: 1 })), label: "Wheel up", group: "Mouse" },
  { code: bindingCode(P.encodeBinding({ type: "wheel", dir: 255 })), label: "Wheel down", group: "Mouse" },
];

// ---------------------------------------------------------------------------------------------
// Colour: the panel speaks [hue, saturation] 0..255; the board stores RGB (src/lib/kb/color.ts).
// ---------------------------------------------------------------------------------------------

export { hsToRgb, rgbToHs };

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

type AnalogProjection = Record<KeyIndex, Required<Pick<AnalogValues, "actuationMm" | "rapidTrigger" | "rtPressMm" | "rtReleaseMm">>>;

export class FccBackend implements KbBackend {
  readonly driver = "fcc";
  readonly dev: HidLike;
  readonly link: SonixLink;
  detection: SonixDetection;
  regions: SonixRegions | null = null;
  #state: KbState | null = null;
  readonly #gate: AdvancedGate;
  readonly #store?: KbContext["store"];
  #advanced?: AdvancedPanel;

  constructor(dev: HidLike, link: SonixLink, detection: SonixDetection, gate: AdvancedGate = new AdvancedGate("fcc"), store?: KbContext["store"]) {
    this.dev = dev;
    this.link = link;
    this.detection = detection;
    this.#gate = gate;
    this.#store = store;
  }

  /** The Advanced card's actions: a guided switch calibration and a factory reset (advanced.ts). */
  advanced(): AdvancedPanel {
    return (this.#advanced ??= fccAdvanced({
      link: this.link,
      gate: this.#gate,
      store: this.#store,
      deviceName: this.detection.model?.name ?? this.dev.productName ?? "Sonix keyboard",
      firmware: this.regions ? P.decodeInfo(this.regions.info).firmware : "",
      hardBlock: () => this.hardBlock,
      keys: () => (this.detection.model?.keys ?? []).map((k) => ({ index: k.index, label: k.hid ? HID_NAMES[k.hid] : "Fn" })),
      reload: async () => void (await this.load()),
    }));
  }

  get state(): KbState {
    if (!this.#state) throw new Error("The keyboard hasn't been read yet.");
    return this.#state;
  }

  get model(): SonixModel | null {
    return this.detection.model;
  }

  get blocked(): readonly BlockedCommand[] {
    return FCC_BLOCKED;
  }

  get support(): KbSupport {
    const m = this.detection.model;
    if (!m || !this.detection.certain) return { tier: "read-only", why: "Several Sonix boards share this USB id and the product name doesn't say which one this is, so SYNQ won't write to it." };
    if (this.detection.verified)
      return { tier: "driver-tested", why: `Fighting Control Center tested the ${m.name} end to end on firmware 1.25. SYNQ has only been checked against a simulator.` };
    return { tier: "read-only", why: `Fighting Control Center lists the ${m.name} as untested: same Sonix firmware family as the Fighting68, never confirmed on hardware.` };
  }

  /** Why nothing may be written at all, whatever the person allows. */
  get hardBlock(): string | null {
    if (!this.regions) return "The keyboard hasn't been read yet.";
    if (this.link.state !== "ok") return "The keyboard disconnected.";
    const m = this.detection.model;
    if (!m) return "SYNQ doesn't know this board's layout.";
    if (!this.detection.certain) return `Several boards share this USB id (${this.detection.candidates.map((c) => c.name).join(", ")}).`;
    const info = P.decodeInfo(this.regions.info);
    if (info.vendorId !== this.dev.vendorId || info.productId !== this.dev.productId)
      return `The keyboard reports ids ${hex4(info.vendorId)}:${hex4(info.productId)}, not its USB ids ${hex4(this.dev.vendorId)}:${hex4(this.dev.productId)}.`;
    return null;
  }

  async load(): Promise<KbState> {
    this.regions = await this.link.run(() => this.link.readAll());
    this.#state = this.#build();
    return this.#state;
  }

  snapshot(): unknown {
    return {
      format: "onboard-fcc-sonix",
      version: 1,
      model: this.detection.model?.id ?? null,
      regions: Object.fromEntries(Object.entries(this.regions ?? {}).map(([k, v]) => [k, Array.from(v as Uint8Array)])),
    };
  }

  async close(): Promise<void> {
    await this.#gate.revokeAll().catch(() => undefined);
    return this.link.close();
  }

  // -------------------------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------------------------

  #unknownBindings(): number[] {
    const keys = this.regions!.keys;
    const out: number[] = [];
    for (let i = 0; i < P.KEY_SLOTS; i++) if (P.bindingProblem(keys[i * 4], keys[i * 4 + 1], keys[i * 4 + 2], keys[i * 4 + 3])) out.push(i);
    return out;
  }

  #analog(rt: Uint8Array, indexes: readonly number[]): AnalogProjection {
    const out: AnalogProjection = {};
    for (const i of indexes) {
      const k = P.decodeRT(rt, i);
      out[i] = { actuationMm: r3(k.actuation / MM), rapidTrigger: P.rtEnabled(k), rtPressMm: r3(k.press / MM), rtReleaseMm: r3(k.release / MM) };
    }
    return out;
  }

  #lightValue(led: Uint8Array, id: string): number | readonly [number, number] {
    const l = P.decodeLed(led);
    switch (id) {
      case "effect":
        return l.effect;
      case "brightness":
        return l.brightness;
      case "speed":
        return l.speed;
      case "color":
        return rgbToHs(l.r, l.g, l.b);
      case "direction":
        return l.direction;
      case "rainbow":
        return l.rainbow ? 1 : 0;
      default:
        throw new Error(`No lighting setting "${id}" on this keyboard.`);
    }
  }

  #build(): KbState {
    const r = this.regions!;
    const info = P.decodeInfo(r.info);
    const settings = P.decodeSettings(r.settings);
    const m = this.detection.model;
    const keys = m?.keys ?? [];
    const indexes = keys.map((k) => k.index);
    const notes: string[] = [];
    if (!m) notes.push("Unknown layout: nothing can be changed.");
    else if (!this.detection.certain) notes.push(`This USB id is shared by ${this.detection.candidates.length} boards (${this.detection.candidates.map((c) => c.name).join(", ")}); SYNQ guessed the ${m.name} layout and stays read-only.`);
    const hard = this.hardBlock;
    if (hard && this.detection.certain) notes.push(hard);
    const unknown = this.#unknownBindings();
    if (unknown.length) notes.push(`Key indices ${unknown.join(", ")} hold bindings SYNQ doesn't know, so the key map stays read-only.`);
    const adv = m ? P.listAdvanced(r.keys, r.dks, indexes) : [];
    if (adv.length) notes.push(`${adv.length} advanced key${adv.length === 1 ? "" : "s"} on the board (${[...new Set(adv.map((a) => a.type.toUpperCase()))].join(", ")}); changing a key that has one clears it.`);
    notes.push("Live key travel isn't available: these boards only stream it in calibration mode, which also recalibrates keys.");

    const rt = m?.rt ?? { travel: 330, actuationMin: 10, actuationMax: 330, sensMin: 8, sensMax: 240 };
    const mmSpec = (min: number, max: number): NumberSpec => ({ min: min / MM, max: max / MM, step: 0.01, unit: "mm", decimals: 2 });
    const layoutKeys: KbKey[] = keys.map((k) => ({ index: k.index, x: k.x, y: k.y, w: k.w, h: k.h, label: k.hid ? HID_NAMES[k.hid] : "Fn" }));
    const width = Math.max(1, ...keys.map((k) => k.x + k.w));
    const height = Math.max(1, ...keys.map((k) => k.y + k.h));
    const codes: Record<KeyIndex, number> = {};
    for (const i of indexes) codes[i] = bindingCode(Array.from(r.keys.subarray(i * 4, i * 4 + 4)));

    const effect: LightingSetting = {
      id: "effect",
      label: "Effect",
      kind: "choice",
      choice: { options: P.EFFECTS.map((e) => ({ value: e.id, label: e.name })) },
      value: this.#lightValue(r.led, "effect"),
      writable: true,
    };
    const range = (id: string, label: string): LightingSetting => ({ id, label, kind: "range", spec: { min: 1, max: 5, step: 1, unit: "level" }, value: this.#lightValue(r.led, id), writable: true });
    const toggle = (id: string, label: string): LightingSetting => ({ id, label, kind: "toggle", value: this.#lightValue(r.led, id), writable: true });
    const options: KbOption[] = [
      { id: "sleep", label: "Sleep after", hint: "0 = the firmware's default", kind: "range", spec: { min: 0, max: 1800, step: 60, unit: "s" }, value: settings.sleepMinutes * 60, writable: true },
      { id: "stability", label: "Stability mode", hint: "Steadier key algorithm for extreme settings (FCC's wording)", kind: "toggle", value: settings.stability ? 1 : 0, writable: true },
      { id: "allKeyWake", label: "Wake on any key", hint: "Off = one key wakes it, which uses less power asleep", kind: "toggle", value: settings.allKeyWake ? 1 : 0, writable: true },
      { id: "adaptiveCalibration", label: "Adaptive calibration", hint: "Shown only: it changes how the firmware recalibrates keys", kind: "toggle", value: settings.adaptiveCalibration ? 1 : 0, writable: false },
      { id: "deadTopRaw", label: "Top dead zone (raw byte)", hint: "Unit unknown; FCC never writes it", kind: "range", spec: { min: 0, max: 255, step: 1, unit: "none" }, value: settings.topDeadZoneRaw, writable: false },
      { id: "deadBottomRaw", label: "Bottom dead zone (raw byte)", hint: "Unit unknown; FCC never writes it", kind: "range", spec: { min: 0, max: 255, step: 1, unit: "none" }, value: settings.bottomDeadZoneRaw, writable: false },
    ];
    const macros = P.decodeMacros(r.macros);
    return {
      info: {
        brand: "Sonix HE",
        model: m?.name ?? (this.dev.productName || "Sonix HE keyboard"),
        driver: "fcc",
        protocol: "Sonix HE (FCC protocol, 0xFF68)",
        firmware: [info.firmware],
        connection: "USB",
        extra: [
          ["USB id", `${hex4(this.dev.vendorId)}:${hex4(this.dev.productId)}`],
          ["FCC status", m ? m.status : "unknown"],
          ["Macro memory", `${info.macroCapacity} bytes`],
        ],
      },
      analog: m
        ? {
            scope: "per-key",
            keys: indexes,
            travelMm: rt.travel / MM,
            fields: { actuationMm: mmSpec(rt.actuationMin, rt.actuationMax), rapidTrigger: "toggle", rtPressMm: mmSpec(rt.sensMin, rt.sensMax), rtReleaseMm: mmSpec(rt.sensMin, rt.sensMax) },
            writable: ["actuationMm", "rapidTrigger", "rtPressMm", "rtReleaseMm"],
            global: null,
            perKey: this.#analog(r.rt, indexes),
            source: "device",
            note: "Every key has its own settings; a global change sets all of them. Continuous rapid trigger and the switch type are kept as they are.",
          }
        : undefined,
      keymap: m
        ? {
            layout: { source: "driver", width, height, keys: layoutKeys, note: "Layout from the official VTER driver, via Fighting Control Center" },
            layers: 1,
            codes: [codes],
            keySpace: "vendor",
            assignable: unknown.length ? [] : FCC_ASSIGNABLE,
            writable: unknown.length === 0,
            source: "device",
            note: "One layer: the Fn layer is fixed in firmware.",
          }
        : undefined,
      lighting: {
        groups: [{ id: "lighting", label: "Lighting", settings: [effect, range("brightness", "Brightness"), range("speed", "Speed"), { id: "color", label: "Colour", kind: "color", value: this.#lightValue(r.led, "color"), writable: true }, toggle("rainbow", "Rainbow"), toggle("direction", "Reverse direction")] }],
        source: "device",
        note: "Per-key colours are supported by the board but not by this panel yet.",
      },
      polling: { hz: settings.pollHz, options: P.POLL_HZ, writable: true, note: settings.pollHz === null ? "Never set: the firmware's default rate." : undefined },
      options,
      macros: { count: macros.length, bufferBytes: info.macroCapacity, summaries: macros.map((m, i) => `M${i + 1}: ${m.length} events`), note: "Macros are read only in this panel." },
      notes,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------------------------

  #plan(label: string, changes: [P.RegionName, Uint8Array][], expected: unknown, readBack: (r: SonixRegions) => unknown, caution?: string): KbPlan {
    const regions = this.regions!;
    for (const [name, data] of changes) {
      if (name === "settings") {
        const problem = P.settingsChangeProblem(regions.settings, data);
        if (problem) throw new Error(problem);
      }
      for (const f of P.encodeRegionWrite(name, data)) {
        const c = P.checkFrame(f);
        if (!c.ok) throw new Error(c.reason);
      }
    }
    const pending = changes.filter(([name, data]) => P.readBackMismatch(name, data, regions[name]) >= 0);
    return {
      label,
      expected,
      persistence: "saved",
      caution,
      send: () => this.link.run(() => this.link.writeRegions(pending, label)),
      readBack: () =>
        this.link.run(async () => {
          for (const [name] of pending) regions[name] = await this.link.readRegion(name);
          this.#state = this.#build();
          return readBack(regions);
        }),
    };
  }

  plan(change: KbChange): KbPlan {
    const block = this.hardBlock;
    if (block) throw new Error(block);
    const m = this.detection.model!;
    const r = this.regions!;
    const onBoard = new Set(m.keys.map((k) => k.index));
    switch (change.kind) {
      case "analog": {
        const v = change.values;
        if (v.deadTopMm != null || v.deadBottomMm != null) throw new Error("These boards' dead zones have an unknown unit, so SYNQ doesn't change them.");
        if (v.releaseMm != null) throw new Error("These boards have no separate release point.");
        const targets = change.target === "global" ? [...onBoard] : [...change.target];
        for (const i of targets) if (!onBoard.has(i)) throw new Error(`Key ${i} isn't on this board.`);
        if (!targets.length) throw new Error("No keys chosen.");
        let rt = r.rt;
        for (const i of targets) {
          const cur = P.decodeRT(rt, i);
          const patch: P.RtPatch = {};
          if (v.actuationMm != null) patch.actuation = Math.round(v.actuationMm * MM);
          if (v.rapidTrigger === false) {
            patch.press = 0;
            patch.release = 0;
          } else if (v.rapidTrigger === true || v.rtPressMm != null || v.rtReleaseMm != null) {
            patch.press = v.rtPressMm != null ? Math.round(v.rtPressMm * MM) : cur.press || m.limits.sensDefault;
            patch.release = v.rtReleaseMm != null ? Math.round(v.rtReleaseMm * MM) : cur.release || m.limits.sensDefault;
          }
          rt = P.withRT(rt, [i], patch, m.rt, m.limits.actuationDefault);
        }
        const what = [v.actuationMm != null ? `actuation ${v.actuationMm} mm` : "", v.rapidTrigger === false ? "rapid trigger off" : v.rapidTrigger || v.rtPressMm != null || v.rtReleaseMm != null ? "rapid trigger" : ""].filter(Boolean).join(", ");
        const label = `${what || "Key triggers"} on ${change.target === "global" ? "every key" : `${targets.length} key${targets.length === 1 ? "" : "s"}`}`;
        return this.#plan(label.charAt(0).toUpperCase() + label.slice(1), [["rt", rt]], this.#analog(rt, targets), (back) => this.#analog(back.rt, targets));
      }
      case "keycode": {
        if (change.layer !== 0) throw new Error("These boards have one layer.");
        if (!onBoard.has(change.key)) throw new Error(`Key ${change.key} isn't on this board.`);
        const bytes = codeBytes(change.code);
        if (![0, 1, 2, 3].includes(bytes[0])) throw new Error("Only keys, media, mouse buttons and the default can be assigned here.");
        const why = P.bindingProblem(...bytes);
        if (why) throw new Error(`That key code can't be written: ${why}.`);
        const cleared = P.clearAdvanced(r.keys, r.dks, [change.key], [...onBoard]);
        const keys = cleared.keys.slice();
        keys.set(bytes, change.key * 4);
        const label = FCC_ASSIGNABLE.find((a) => a.code === change.code)?.label ?? `code ${change.code}`;
        return this.#plan(
          `Key ${HID_NAMES[m.keys.find((k) => k.index === change.key)!.hid] ?? change.key} → ${label}`,
          [
            ["keys", keys],
            ["dks", cleared.dks],
          ],
          change.code,
          (back) => bindingCode(Array.from(back.keys.subarray(change.key * 4, change.key * 4 + 4))),
        );
      }
      case "lighting": {
        const l = P.decodeLed(r.led);
        const v = change.value;
        const num = (lo: number, hi: number) => {
          if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`Must be a whole number from ${lo} to ${hi}.`);
          return v;
        };
        let next: P.Led;
        switch (change.id) {
          case "effect":
            if (typeof v !== "number" || !P.EFFECTS.some((e) => e.id === v)) throw new Error("Unknown effect.");
            next = { ...l, effect: v };
            break;
          case "brightness":
            next = { ...l, brightness: num(1, 5) };
            break;
          case "speed":
            next = { ...l, speed: num(1, 5) };
            break;
          case "direction":
            next = { ...l, direction: num(0, 1) as 0 | 1 };
            break;
          case "rainbow":
            next = { ...l, rainbow: num(0, 1) === 1 };
            break;
          case "color": {
            if (!Array.isArray(v)) throw new Error("A colour is [hue, saturation].");
            const [red, green, blue] = hsToRgb(v[0], v[1]);
            next = { ...l, r: red, g: green, b: blue };
            break;
          }
          default:
            throw new Error(`No lighting setting "${change.id}" on this keyboard.`);
        }
        const led = P.encodeLed(r.led, next);
        return this.#plan(`Lighting: ${change.id}`, [["led", led]], this.#lightValue(led, change.id), (back) => this.#lightValue(back.led, change.id));
      }
      case "polling": {
        const settings = P.encodeSettings(r.settings, { pollHz: change.hz });
        return this.#plan(`Polling ${change.hz} Hz`, [["settings", settings]], change.hz, (back) => P.decodeSettings(back.settings).pollHz, "The keyboard may reconnect after a polling-rate change (not confirmed for these boards).");
      }
      case "option": {
        let settings: Uint8Array;
        let read: (s: P.SonixSettings) => number;
        switch (change.id) {
          case "sleep":
            settings = P.encodeSettings(r.settings, { sleepMinutes: Math.round(change.value / 60) });
            read = (s) => s.sleepMinutes * 60;
            break;
          case "stability":
            settings = P.encodeSettings(r.settings, { stability: change.value === 1 });
            read = (s) => (s.stability ? 1 : 0);
            break;
          case "allKeyWake":
            settings = P.encodeSettings(r.settings, { allKeyWake: change.value === 1 });
            read = (s) => (s.allKeyWake ? 1 : 0);
            break;
          default:
            throw new Error(`SYNQ doesn't change "${change.id}" on these boards.`);
        }
        return this.#plan(`Setting: ${change.id}`, [["settings", settings]], read(P.decodeSettings(settings)), (back) => read(P.decodeSettings(back.settings)));
      }
      case "profile":
        throw new Error("These boards have no onboard profiles (the official driver keeps profiles on the PC).");
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

export const fccDriver: KbDriver = {
  id: "fcc",
  name: "Sonix HE (Fighting Control Center protocol)",
  priority: 60,
  vids: [SONIX_VENDOR_ID, SONIX_APPLE_ALIAS.vendorId],
  claims: (d) => isSonixId(d.vendorId, d.productId) && hasConfigCollection(d),
  async open(device: HidLike, ctx: KbContext): Promise<KbBackend> {
    const detection = detectSonix(device.vendorId, device.productId, device.productName);
    if (!detection.candidates.length) throw new Error("Not a listed wired Sonix HE board.");
    const gate = new AdvancedGate(`fcc:${hex4(device.vendorId)}:${hex4(device.productId)}`, nativeOf(device));
    const link = await SonixLink.open(device, { closeDevice: true, grants: gate });
    const backend = new FccBackend(device, link, detection, gate, ctx.store);
    try {
      await backend.load();
    } catch (e) {
      await link.close().catch(() => undefined);
      throw e;
    }
    return backend;
  },
  /** One info-region read (24 bytes). Closes the device again if it wasn't open. */
  async ping(device: HidLike): Promise<boolean> {
    const wasOpen = device.opened;
    let link: SonixLink | null = null;
    try {
      link = await SonixLink.open(device, { replyMs: 600, attempts: 1, closeDevice: !wasOpen });
      const l = link;
      await l.run(() => l.exchange(P.encodeRegionRead("info")[0]));
      return true;
    } catch {
      return false;
    } finally {
      await link?.close().catch(() => undefined);
    }
  },
};
