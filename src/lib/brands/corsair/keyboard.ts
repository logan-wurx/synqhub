// CORSAIR Hall-effect keyboards (Vanguard Pro 96 / GUMA, Clipper Pro Mini 60, Vanguard Pro 60
// Wireless, MAKR Pro 75) as a generic-panel driver (src/lib/kb/types.ts).
//
// Analog settings live in files of the active profile, not in properties (Web Hub KeyActualService):
//   primary actuation file   hdr u16, count u8, {key, flags, distance 0.1 mm} x count
//   primary reset file       same layout, distance = release point
//   rapid trigger file       hdr u16, count u8, {key, flags (1 on, 3 continuous), start, press, release}
//   properties file          FlashTap = ids 251 enable, 252 mode, 254/255 keys
// Every change rewrites the whole file (open 0D, write 06/07, close 05) inside operating mode 2, and
// always returns the board to mode 1 (a board left in mode 2 stops applying its own settings).
// There is no separate save: writes land in the device's storage. Polling, brightness and the active
// profile are plain SETs. Key ids are HID usage codes (modifiers 105-111, Fn 122).
import type { AnalogField, AnalogValues, BlockedCommand as KbBlocked, KbBackend, KbChange, KbContext, KbDriver, KbOption, KbPlan, KbState, KbSupport, KeyIndex, NumberSpec } from "../../kb/types.ts";
import { layoutFromGrid } from "../ansi-layout.ts";
import type { HidLike } from "../types.ts";
import * as B from "./bragi.ts";
import { corsairModel, type CorsairModel } from "./devices.ts";
import { CORSAIR_BLOCKED } from "./guard.ts";
import { BragiLink, type BragiLinkOptions } from "./link.ts";

/** Corsair key index (HID usage based) -> KeyboardEvent.code, for drawing and labels. */
export const CORSAIR_KEY_CODES: Readonly<Record<number, string>> = (() => {
  const m: Record<number, string> = {};
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach((c, i) => (m[4 + i] = `Key${c}`));
  "123456789".split("").forEach((d, i) => (m[30 + i] = `Digit${d}`));
  m[39] = "Digit0";
  const rest: [number, string][] = [
    [40, "Enter"], [41, "Escape"], [42, "Backspace"], [43, "Tab"], [44, "Space"], [45, "Minus"], [46, "Equal"], [47, "BracketLeft"], [48, "BracketRight"],
    [49, "Backslash"], [51, "Semicolon"], [52, "Quote"], [53, "Backquote"], [54, "Comma"], [55, "Period"], [56, "Slash"], [57, "CapsLock"],
    [70, "PrintScreen"], [71, "ScrollLock"], [72, "Pause"], [73, "Insert"], [74, "Home"], [75, "PageUp"], [76, "Delete"], [77, "End"], [78, "PageDown"],
    [79, "ArrowRight"], [80, "ArrowLeft"], [81, "ArrowDown"], [82, "ArrowUp"], [83, "NumLock"], [84, "NumpadDivide"], [85, "NumpadMultiply"], [86, "NumpadSubtract"],
    [87, "NumpadAdd"], [88, "NumpadEnter"], [98, "Numpad0"], [99, "NumpadDecimal"], [100, "IntlBackslash"], [101, "ContextMenu"],
    [105, "ControlLeft"], [106, "ShiftLeft"], [107, "AltLeft"], [108, "MetaLeft"], [109, "ControlRight"], [110, "ShiftRight"], [111, "AltRight"], [122, "FN"],
  ];
  for (let i = 0; i < 12; i++) m[58 + i] = `F${i + 1}`;
  for (let i = 0; i < 9; i++) m[89 + i] = `Numpad${i + 1}`;
  for (const [k, v] of rest) m[k] = v;
  return m;
})();

const tenth = (mm: number) => Math.round(mm * 10);
const mm = (units: number) => units / 10;

interface KeyRow {
  press: B.DistanceEntry | null;
  reset: B.DistanceEntry | null;
  rt: B.RapidTriggerEntry | null;
}

interface Files {
  profileId: number;
  profile: B.ProfileFile;
  press: B.DistanceFile;
  reset: B.DistanceFile;
  rt: B.RapidTriggerFile;
  props: B.PropertiesFile;
}

const toKbBlocked = (): KbBlocked[] => CORSAIR_BLOCKED.map((b) => ({ what: b.what, why: b.why === "profile-wipe" ? "factory-reset" : b.why === "unknown" || b.why === "demo" ? "unverified" : (b.why as KbBlocked["why"]) }));

const FLASHTAP_CHOICES = [
  { value: 0, label: "Off" },
  { value: 1, label: "Neutral (both cancel)" },
  { value: 2, label: "Last input wins" },
  { value: 3, label: "First input wins" },
];

export function claimsCorsairKeyboard(vendorId: number, productId: number): CorsairModel | null {
  if (vendorId !== B.CORSAIR_VID) return null;
  const m = corsairModel(productId);
  return m && m.family === "kb-he" ? m : null;
}

export class CorsairKbBackend implements KbBackend {
  readonly driver = "corsair-bragi";
  readonly model: CorsairModel;
  readonly link: BragiLink;
  readonly blocked: readonly KbBlocked[] = toKbBlocked();
  readonly support: KbSupport = { tier: "read-only", why: "Built from CORSAIR Web Hub's code (2026-10-13); not tried on this model with SYNQ yet." };
  #files: Files | null = null;
  #firmware = "";
  #pollingHz: number | null = null;
  #brightness: number | null = null;
  #profileIndex: number | null = null;
  #profileCount = 0;
  #state: KbState;

  constructor(device: HidLike, model: CorsairModel, o: BragiLinkOptions = {}) {
    this.model = model;
    this.link = new BragiLink(device, model, o);
    this.#state = this.#build();
  }

  get state(): KbState {
    return this.#state;
  }

  async #readFiles(): Promise<Files> {
    return this.link.withHostControl(async () => {
      const list = B.decodeProfilesList(await this.link.readFile(B.FILE.profilesList));
      const idx = this.#profileIndex ?? 0;
      const profileId = list[idx];
      if (profileId === undefined) throw new Error("The keyboard has no profile for the active index.");
      this.#profileCount = list.length;
      const profile = B.decodeProfileFile(await this.link.readFile(profileId));
      return {
        profileId,
        profile,
        press: B.decodeDistanceFile(await this.link.readFile(profile.primaryActuation)),
        reset: B.decodeDistanceFile(await this.link.readFile(profile.primaryReset)),
        rt: B.decodeRapidTriggerFile(await this.link.readFile(profile.rapidTrigger)),
        props: B.decodePropertiesFile(await this.link.readFile(profile.properties)),
      };
    });
  }

  async load(): Promise<KbState> {
    this.#firmware = B.decodeFirmware(await this.link.get(B.PROP.firmware, 0));
    this.#pollingHz = B.pollingHz(await this.link.getU32(B.PROP.pollingRate, 0));
    const br = await this.link.tryU32(B.PROP.brightness);
    this.#brightness = br === null ? null : Math.round(br / 10);
    this.#profileIndex = await this.link.getU32(B.PROP.activeProfile);
    this.#files = await this.#readFiles();
    this.#state = this.#build();
    return this.#state;
  }

  #rows(): Map<number, KeyRow> {
    const out = new Map<number, KeyRow>();
    const f = this.#files;
    if (!f) return out;
    const row = (k: number) => out.get(k) ?? (out.set(k, { press: null, reset: null, rt: null }), out.get(k)!);
    for (const e of f.press.entries) row(e.key).press = e;
    for (const e of f.reset.entries) row(e.key).reset = e;
    for (const e of f.rt.entries) row(e.key).rt = e;
    return out;
  }

  #values(r: KeyRow): AnalogValues {
    return {
      actuationMm: r.press ? mm(r.press.distance) : null,
      releaseMm: r.reset ? mm(r.reset.distance) : null,
      rapidTrigger: r.rt ? (r.rt.flags & 1) === 1 : null,
      rtPressMm: r.rt ? mm(r.rt.press) : null,
      rtReleaseMm: r.rt ? mm(r.rt.release) : null,
    };
  }

  #keys(): number[] {
    return this.#files ? this.#files.press.entries.filter((e) => !this.model.table.keysNotAllowForActuation.includes(e.key)).map((e) => e.key) : [];
  }

  #mostCommon(values: AnalogValues[]): AnalogValues {
    const out: AnalogValues = {};
    for (const f of ["actuationMm", "releaseMm", "rapidTrigger", "rtPressMm", "rtReleaseMm"] as const) {
      const count = new Map<string, number>();
      for (const v of values) if (v[f] != null) count.set(JSON.stringify(v[f]), (count.get(JSON.stringify(v[f])) ?? 0) + 1);
      const best = [...count].sort((a, b) => b[1] - a[1])[0];
      (out as Record<string, unknown>)[f] = best ? JSON.parse(best[0]) : null;
    }
    return out;
  }

  #flashTap(): { choice: number; keys: [number, number] } | null {
    const p = this.#files?.props;
    if (!p) return null;
    const on = B.propU32(p, B.PROP.flashTapEnable);
    const mode = B.propU32(p, B.PROP.flashTapMode);
    const k1 = B.propU32(p, B.PROP.flashTapKey1) ?? 4;
    const k2 = B.propU32(p, B.PROP.flashTapKey2) ?? 7;
    if (on === null) return null;
    return { choice: on ? (mode ?? 1) + 1 : 0, keys: [k1, k2] };
  }

  #build(): KbState {
    const a = this.model.actuationMm ?? [0.1, 4];
    const spec = (min: number, max: number): NumberSpec => ({ min, max, step: 0.1, unit: "mm", decimals: 1 });
    const rows = this.#rows();
    const perKey: Record<KeyIndex, AnalogValues> = {};
    for (const [k, r] of rows) perKey[k] = this.#values(r);
    const keys = this.#keys();
    const ft = this.#flashTap();
    const label = (k: number) => CORSAIR_KEY_CODES[k] ?? `#${k}`;
    const options: KbOption[] = ft
      ? [{ id: "flashTap", label: "FlashTap (SOCD)", hint: `Keys ${label(ft.keys[0])} / ${label(ft.keys[1])}`, kind: "choice", choice: { options: FLASHTAP_CHOICES }, value: ft.choice, writable: true }]
      : [];
    return {
      info: {
        brand: "CORSAIR",
        model: this.model.name,
        driver: this.driver,
        protocol: `Bragi ${this.model.framing === "v15" ? "1.5" : "1.0"}`,
        firmware: this.#firmware ? [this.#firmware] : [],
        connection: "USB",
        extra: [["PID", `0x${this.model.pid.toString(16)}`], ...(this.#files ? ([["Profile", this.#files.profile.name || `#${this.#files.profileId}`]] as [string, string][]) : [])],
      },
      analog: {
        scope: "per-key",
        keys,
        travelMm: a[1],
        fields: { actuationMm: spec(a[0], a[1]), releaseMm: spec(0.1, a[1]), rapidTrigger: "toggle", rtPressMm: spec(0.1, 2.0), rtReleaseMm: spec(0.1, 2.0) },
        writable: ["actuationMm", "releaseMm", "rapidTrigger", "rtPressMm", "rtReleaseMm"],
        global: rows.size ? this.#mostCommon([...rows.values()].map((r) => this.#values(r))) : null,
        perKey,
        source: this.#files ? "device" : "unknown",
        note: "CORSAIR stores these per key; \"all keys\" writes every key. Rapid trigger starts at each key's actuation point.",
      },
      keymap: {
        layout: layoutFromGrid(
          [...rows.keys()].filter((k) => CORSAIR_KEY_CODES[k]).map((k) => ({ index: k, code: CORSAIR_KEY_CODES[k] })),
          "Standard ANSI positions for the keys this board reports (approximate).",
        ),
        layers: 1,
        codes: [null],
        keySpace: "hid",
        assignable: [],
        writable: false,
        source: "unknown",
        note: "Key remaps aren't supported for CORSAIR boards yet (their assignment files are only partly understood).",
      },
      lighting: {
        groups: [{ id: "main", label: "Lighting", settings: [{ id: "brightness", label: "Brightness", kind: "range", spec: { min: 0, max: 100, step: 1, unit: "%" }, value: this.#brightness, writable: true }] }],
        source: this.#brightness === null ? "unknown" : "device",
      },
      polling: { hz: this.#pollingHz, options: [...this.model.table.pollingWiredHz], writable: true },
      profiles: { active: this.#profileIndex === null ? null : this.#profileIndex + 1, count: this.#profileCount || (this.model.table.profileMax ?? null), names: [], writable: true },
      options,
      notes: this.model.table.resetDebugMode ? ["Web Hub also clears a debug flag after actuation edits on this board; SYNQ leaves it alone."] : [],
    };
  }

  // ---------------------------------------------------------------------------------------------

  #check(label: string, v: number, lo: number, hi: number): number {
    if (!Number.isFinite(v) || v < lo - 1e-9 || v > hi + 1e-9) throw new Error(`${label} must be between ${lo} and ${hi} mm on the ${this.model.name}.`);
    return v;
  }

  /** New press / reset / RT files for a change; only the files that change are returned. */
  newFiles(target: "global" | readonly KeyIndex[], v: AnalogValues): { press?: B.DistanceFile; reset?: B.DistanceFile; rt?: B.RapidTriggerFile } {
    const f = this.#files;
    if (!f) throw new Error("Read the keyboard first.");
    const a = this.model.actuationMm ?? [0.1, 4];
    const keys = target === "global" ? this.#keys() : [...target];
    if (!keys.length) throw new Error("Pick at least one key.");
    const all = new Set(this.#keys());
    for (const k of keys) if (!all.has(k)) throw new Error(`Key ${CORSAIR_KEY_CODES[k] ?? k} has no adjustable actuation.`);
    if (v.actuationMm != null) this.#check("Actuation", v.actuationMm, a[0], a[1]);
    if (v.releaseMm != null) this.#check("Release point", v.releaseMm, 0.1, a[1]);
    for (const [k, l] of [["rtPressMm", "Rapid trigger press"], ["rtReleaseMm", "Rapid trigger release"]] as const) if (v[k] != null) this.#check(l, v[k]!, 0.1, 2.0);
    const sel = new Set(keys);
    const out: { press?: B.DistanceFile; reset?: B.DistanceFile; rt?: B.RapidTriggerFile } = {};
    const pressOf = new Map(f.press.entries.map((e) => [e.key, e.distance]));
    if (v.actuationMm != null) {
      const d = tenth(v.actuationMm);
      out.press = { header: f.press.header, entries: f.press.entries.map((e) => (sel.has(e.key) ? { key: e.key, flags: 1, distance: d } : e)) };
      for (const k of keys) pressOf.set(k, d);
    }
    if (v.actuationMm != null || v.releaseMm != null) {
      out.reset = {
        header: f.reset.header,
        entries: f.reset.entries.map((e) => {
          if (!sel.has(e.key)) return e;
          const press = pressOf.get(e.key) ?? e.distance + 1;
          // Web Hub: reset = max(press - 0.1 mm, 0.1 mm) unless set; flag 1 when press > 0.1 mm.
          const want = v.releaseMm != null ? tenth(v.releaseMm) : Math.max(press - 1, 1);
          if (want >= press) throw new Error(`The release point must be above the actuation point (${mm(press)} mm).`);
          return { key: e.key, flags: press > 1 ? 1 : 0, distance: want };
        }),
      };
    }
    if (v.rapidTrigger != null || v.rtPressMm != null || v.rtReleaseMm != null) {
      const seen = new Set(f.rt.entries.map((e) => e.key));
      const entries = f.rt.entries.map((e) => {
        if (!sel.has(e.key)) return e;
        const on = v.rapidTrigger ?? (e.flags & 1) === 1;
        return { key: e.key, flags: on ? (e.flags & 2 ? B.RT_FLAGS.continuous : B.RT_FLAGS.on) : B.RT_FLAGS.off, deadzone: pressOf.get(e.key) ?? e.deadzone, press: v.rtPressMm != null ? tenth(v.rtPressMm) : e.press, release: v.rtReleaseMm != null ? tenth(v.rtReleaseMm) : e.release };
      });
      for (const k of keys)
        if (!seen.has(k))
          entries.push({ key: k, flags: v.rapidTrigger === false ? 0 : 1, deadzone: pressOf.get(k) ?? 10, press: tenth(v.rtPressMm ?? 0.1), release: tenth(v.rtReleaseMm ?? v.rtPressMm ?? 0.1) });
      out.rt = { header: f.rt.header, entries };
    }
    if (!out.press && !out.reset && !out.rt) throw new Error("Nothing to change.");
    return out;
  }

  plan(change: KbChange): KbPlan {
    switch (change.kind) {
      case "analog": {
        const files = this.newFiles(change.target, change.values);
        const fields = (Object.keys(change.values) as AnalogField[]).filter((k) => change.values[k] != null);
        const first = change.target === "global" ? this.#keys()[0] : change.target[0];
        const p = this.#files!.profile;
        return {
          label: `Analog settings on ${change.target === "global" ? "all keys" : `${change.target.length} key(s)`}`,
          expected: Object.fromEntries(fields.map((f) => [f, change.values[f]])),
          persistence: "saved",
          send: () =>
            this.link.withHostControl(async () => {
              if (files.press) await this.link.writeFile(p.primaryActuation, B.encodeDistanceFile(files.press));
              if (files.reset) await this.link.writeFile(p.primaryReset, B.encodeDistanceFile(files.reset));
              if (files.rt) await this.link.writeFile(p.rapidTrigger, B.encodeRapidTriggerFile(files.rt));
            }),
          readBack: async () => {
            this.#files = await this.#readFiles();
            this.#state = this.#build();
            const row = this.#rows().get(first);
            if (!row) return undefined;
            const got = this.#values(row);
            return Object.fromEntries(fields.map((f) => [f, got[f]]));
          },
        };
      }
      case "polling": {
        const code = B.pollingCode(change.hz);
        if (!this.model.table.pollingWiredHz.includes(change.hz)) throw new Error(`${change.hz} Hz isn't offered on the ${this.model.name}.`);
        return {
          label: `Polling rate ${change.hz} Hz`,
          expected: change.hz,
          persistence: "saved",
          send: () => this.link.withHostControl(() => this.link.set(B.PROP.pollingRate, code, 0), 0),
          readBack: async () => {
            this.#pollingHz = B.pollingHz(await this.link.getU32(B.PROP.pollingRate, 0));
            this.#state = this.#build();
            return this.#pollingHz;
          },
        };
      }
      case "profile": {
        const count = this.#profileCount || (this.model.table.profileMax ?? 1);
        if (!Number.isInteger(change.index) || change.index < 1 || change.index > count) throw new Error(`Profiles are 1..${count}.`);
        return {
          label: `Switch to profile ${change.index}`,
          expected: change.index,
          persistence: "saved",
          send: () => this.link.set(B.PROP.activeProfile, change.index - 1),
          readBack: async () => {
            await this.load();
            return this.#profileIndex === null ? undefined : this.#profileIndex + 1;
          },
        };
      }
      case "lighting": {
        if (change.id !== "brightness") throw new Error("Only brightness is supported for CORSAIR lighting.");
        const pct = Math.max(0, Math.min(100, Math.round(Number(change.value))));
        return {
          label: `Brightness ${pct}%`,
          expected: pct,
          persistence: "saved",
          send: () => this.link.set(B.PROP.brightness, pct * 10),
          readBack: async () => {
            const v = await this.link.tryU32(B.PROP.brightness);
            this.#brightness = v === null ? null : Math.round(v / 10);
            this.#state = this.#build();
            return v === null ? undefined : this.#brightness;
          },
        };
      }
      case "option": {
        if (change.id !== "flashTap") throw new Error(`Unknown option ${change.id}.`);
        const f = this.#files;
        if (!f) throw new Error("Read the keyboard first.");
        const choice = Number(change.value);
        if (!FLASHTAP_CHOICES.some((c) => c.value === choice)) throw new Error("Unknown FlashTap mode.");
        let props = B.withPropU32(f.props, B.PROP.flashTapEnable, choice ? 1 : 0);
        if (choice) props = B.withPropU32(props, B.PROP.flashTapMode, choice - 1);
        return {
          label: `FlashTap ${FLASHTAP_CHOICES.find((c) => c.value === choice)!.label}`,
          expected: choice,
          persistence: "saved",
          send: () => this.link.withHostControl(() => this.link.writeFile(f.profile.properties, B.encodePropertiesFile(props))),
          readBack: async () => {
            this.#files = await this.#readFiles();
            this.#state = this.#build();
            return this.#flashTap()?.choice;
          },
        };
      }
      case "keycode":
        throw new Error("Key remaps aren't supported for CORSAIR boards yet.");
    }
  }

  snapshot(): unknown {
    return { model: { pid: this.model.pid, name: this.model.name }, firmware: this.#firmware, pollingHz: this.#pollingHz, brightness: this.#brightness, profileIndex: this.#profileIndex, files: this.#files };
  }

  close(): Promise<void> {
    return this.link.close();
  }
}

export const CORSAIR_KB_DRIVER: KbDriver = {
  id: "corsair-bragi",
  name: "CORSAIR Web Hub Hall-effect keyboards",
  priority: 60,
  vids: [B.CORSAIR_VID],
  claims: (device) =>
    claimsCorsairKeyboard(device.vendorId, device.productId) !== null &&
    (device.collections ?? []).some((c) => c.usagePage === B.BRAGI_USAGE_PAGE && c.usage === B.BRAGI_USAGE_REQUEST),
  async open(device, _ctx: KbContext) {
    const m = claimsCorsairKeyboard(device.vendorId, device.productId);
    if (!m) throw new Error("Not a CORSAIR Hall-effect keyboard SYNQ knows.");
    const b = new CorsairKbBackend(device as unknown as HidLike, m);
    await b.load();
    return b;
  },
  async ping(device) {
    const m = claimsCorsairKeyboard(device.vendorId, device.productId);
    if (!m) return false;
    const link = new BragiLink(device as unknown as HidLike, m);
    try {
      await link.command((o) => B.encodePing(o), "ping", 0);
      return true;
    } catch {
      return false;
    } finally {
      await link.close().catch(() => undefined);
    }
  },
};
