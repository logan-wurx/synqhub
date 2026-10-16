// The 0x19F5 firmware family (MCHOSE gen 1, DrunkDeer gen 2, NuPhy V3 / HE, Royal Kludge Gcome) as a
// generic Keyboard panel driver (src/lib/kb/types.ts), on top of Fw19f5Session. KbSession owns "Allow
// changes", the backup and the read-back verdict; Fw19f5Session keeps its guard, units and re-reads.
//
// What each family gets (see devices.ts for why):
//   MCHOSE      per-key actuation and rapid trigger (a "global" change sets every key), Win / Alt-Tab / Alt-F4
//               locks, bottom rapid trigger, debounce, sleep time, and lighting (effect, brightness, speed,
//               colour). Every board starts read-only behind "Allow changes": FCC lists them all as untested.
//   DrunkDeer   per-key actuation and rapid trigger on the A75 Pro OEM relabel (19F5:FB5C); the other ids are
//               shown read-only.
//   NuPhy, RK   the firmware version and nothing else.
//
// Protocol and MCHOSE's model table are from Fighting Control Center (FCC, https://github.com/shybruh/
// FightingControlCenter-FCC, GPL-3.0-or-later); DrunkDeer's gen-2 envelope is from svumo/DrunkDeer-Control
// (MIT). SYNQ is AGPL-3.0.
import type { AnalogValues, BlockedCommand, HidLike as KbHidLike, KbBackend, KbChange, KbDriver, KbKey, KbLayout, KbOption, KbPlan, KbState, KbSupport, KeyIndex, LightingSetting, NumberSpec } from "../../kb/types.ts";
import { hsToRgb, rgbToHs } from "../../kb/color.ts";
import { HID_NAMES } from "../../x68he-protocol.ts";
import type { HidLike } from "../local-kb.ts";
import { FW_CHANNEL, FW_VIDS, MC_EFFECT_NAMES, fwModel, isFwUpgrader, layoutOf } from "./devices.ts";
import { BLOCKED } from "./guard.ts";
import * as P from "./protocol.ts";
import { Fw19f5Session, tierAllowsWrites, type AnalogRead, type Fw19f5Plan } from "./session.ts";

const DRIVER_ID = "fw19f5";

/** A 0x19F5-family id the table names (not an upgrader) and its Generic Desktop collection 0001:0000. No I/O. */
export function claimsFw19f5(d: { vendorId: number; productId: number; collections?: readonly { usagePage?: number; usage?: number }[] }): boolean {
  if (isFwUpgrader(d.vendorId, d.productId) || !fwModel(d.vendorId, d.productId)) return false;
  return (d.collections ?? []).some((c) => c.usagePage === FW_CHANNEL.usagePage && (c.usage ?? 0) === FW_CHANNEL.usage);
}

const asLocal = (d: KbHidLike): HidLike => d as unknown as HidLike;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const hex4 = (n: number) => n.toString(16).padStart(4, "0");

export const fw19f5KbDriver: KbDriver = {
  id: DRIVER_ID,
  name: "MCHOSE / NuPhy / Royal Kludge / DrunkDeer (0x19F5 firmware)",
  priority: 60,
  vids: FW_VIDS,
  claims: (d) => claimsFw19f5(d),
  async open(device) {
    if (!device.opened) await device.open();
    return new Fw19f5KbBackend(device, await Fw19f5Session.connect(asLocal(device), { allowWrites: () => true }));
  },
  async ping(device) {
    const wasOpen = device.opened;
    try {
      if (!wasOpen) await device.open();
      const s = await Fw19f5Session.connect(asLocal(device));
      const ok = s.state.answered;
      s.close();
      return ok;
    } catch {
      return false;
    } finally {
      if (!wasOpen && device.opened) await device.close().catch(() => undefined);
    }
  },
};

/** The option ids this backend offers (MCHOSE's function block). */
const OPTION_LABELS = {
  winLock: ["Lock the Windows key", "Stops the Windows key opening the Start menu"],
  altTabLock: ["Lock Alt + Tab", undefined],
  altF4Lock: ["Lock Alt + F4", undefined],
  bottomRapidTrigger: ["Rapid trigger at the bottom", "MCHOSE's own name for the bottom-out rapid-trigger behaviour"],
  debounce: ["Debounce level", "0 = off; higher filters more chatter (MCHOSE's scale)"],
  sleep: ["Sleep after", "0 = never"],
} as const;

export class Fw19f5KbBackend implements KbBackend {
  readonly driver = DRIVER_ID;
  readonly blocked: readonly BlockedCommand[] = BLOCKED.map((b) => ({ what: b.what, why: b.why }));
  readonly #device: KbHidLike;
  readonly #s: Fw19f5Session;
  #state: KbState;

  constructor(device: KbHidLike, session: Fw19f5Session) {
    this.#device = device;
    this.#s = session;
    this.#state = this.#build();
  }

  get state(): KbState {
    return this.#state;
  }

  get support(): KbSupport {
    const m = this.#s.model;
    const writes = tierAllowsWrites(m.tier);
    const why =
      m.family === "mchose"
        ? writes
          ? "Built from Fighting Control Center's documentation of MCHOSE's protocol, which lists this board as untested; not yet tried on one with SYNQ."
          : m.notes ?? "Read-only."
        : m.family === "drunkdeer"
          ? writes
            ? "The 0x55 framing is confirmed for this relabel by a USB capture (svumo), but no one has written to it with SYNQ."
            : m.notes ?? "Read-only."
          : (m.notes ?? "Read-only.");
    return { tier: "read-only", why };
  }

  async load(): Promise<KbState> {
    await this.#s.readAll();
    this.#state = this.#build();
    return this.#state;
  }

  snapshot(): unknown {
    const st = this.#s.state;
    const h = (b: Uint8Array | null) => (b ? Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("") : null);
    return { model: this.#s.model.model, id: `${hex4(this.#s.model.vendorId)}:${hex4(this.#s.model.productId)}`, firmware: st.firmware?.text ?? null, base: st.base, func: h(st.func), triggers: h(st.triggers) };
  }

  async close(): Promise<void> {
    this.#s.close();
    if (this.#device.opened) await this.#device.close().catch(() => undefined);
  }

  // -------------------------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------------------------

  #specs() {
    const s = this.#s;
    const u = s.units;
    if (!u) return null;
    const m = s.model;
    const [aMin, aMax] = m.travel ? m.travel.actuation : [0.1, r4(u.maxTravel - 0.1)];
    const [rMin, rMax] = m.travel ? m.travel.rapidTrigger : [r4(2 * u.precision), u.maxTravel];
    const mm = (min: number, max: number, step: number): NumberSpec => ({ min, max, step, unit: "mm", decimals: 2 });
    return { actuation: mm(aMin, aMax, r4(1 / u.step)), rt: mm(rMin, rMax, u.precision) };
  }

  #layout(keys: readonly number[]): KbLayout {
    const board = this.#s.model.board;
    if (board) {
      const rows = layoutOf(board).filter((k) => keys.includes(k[0]));
      const kbKeys: KbKey[] = rows.map(([index, hid, x, y, w, h]) => ({ index, x, y, w, h, label: hid ? HID_NAMES[hid] : "Fn" }));
      return { source: "driver", width: Math.max(1, ...kbKeys.map((k) => k.x + k.w)), height: Math.max(1, ...kbKeys.map((k) => k.y + k.h)), keys: kbKeys, note: "Layout from MCHOSE's web driver, via Fighting Control Center" };
    }
    const cols = 16;
    return { source: "matrix", width: cols, height: Math.max(1, Math.ceil(P.MAX_KEYS / cols)), keys: keys.map((k) => ({ index: k, x: k % cols, y: Math.floor(k / cols), w: 1, h: 1 })), note: "By key slot (this keyboard sends no geometry)" };
  }

  #build(): KbState {
    const s = this.#s;
    const st = s.state;
    const m = s.model;
    const w = s.canWrite;
    const specs = this.#specs();
    const notes: string[] = [...st.notes];
    if (!st.answered) notes.push("Nothing else can be read or changed.");
    else if (m.family === "nuphy" || m.family === "rk-gcome") notes.push(m.notes ?? "Read-only.");
    else if (m.candidates.length) notes.push(m.notes ?? "");
    else if (!w.ok && tierAllowsWrites(m.tier)) notes.push(`Changes aren't sent to this keyboard: ${w.why}`);
    if (m.family === "drunkdeer" && st.answered && tierAllowsWrites(m.tier)) notes.push("DrunkDeer's OEM boards are untested with SYNQ; every change is read back and compared.");

    const extra: [string, string][] = [];
    if (st.base?.valid && st.base.profileCount) extra.push(["Profiles", `${st.base.profile + 1} of ${st.base.profileCount}`]);
    if (s.units) extra.push(["Travel unit", `${s.units.step} per mm${st.unitsOk || !st.answered ? "" : " (unconfirmed)"}`]);
    const info: KbState["info"] = {
      brand: m.brand,
      model: m.name,
      driver: DRIVER_ID,
      protocol: "0x19F5-family firmware",
      firmware: st.firmware ? [`Firmware ${st.firmware.text}`] : [],
      connection: "USB",
      extra,
    };
    if (!st.answered || !st.triggers || !s.units || !specs) return { info, notes };

    const keys = st.keys;
    const perKey: Record<KeyIndex, AnalogValues> = {};
    for (const k of keys) {
      const a = s.analogOf(k);
      if (a) perKey[k] = { actuationMm: a.actuationMm, rapidTrigger: a.rapidTrigger, rtPressMm: a.rtPressMm, rtReleaseMm: a.rtReleaseMm };
    }
    const analog: KbState["analog"] = keys.length
      ? {
          scope: "per-key",
          keys,
          layout: this.#layout(keys),
          travelMm: s.units.maxTravel,
          fields: { actuationMm: specs.actuation, rapidTrigger: "toggle", rtPressMm: specs.rt, rtReleaseMm: specs.rt },
          writable: w.ok ? ["actuationMm", "rapidTrigger", "rtPressMm", "rtReleaseMm"] : [],
          global: null,
          perKey,
          source: "device",
          unitSource: "manifest",
          note: st.unitsOk ? "Every key has its own settings; a global change sets all of them. Keys in an advanced mode (dynamic keystroke) keep it." : st.unitsWhy,
        }
      : undefined;
    if (!analog) notes.push("None of this keyboard's key records read as travel, so no key settings are shown.");

    const f = st.func ? P.decodeFunc(st.func) : null;
    let options: KbOption[] | undefined;
    let lighting: KbState["lighting"];
    if (f) {
      const toggle = (id: keyof typeof OPTION_LABELS, value: boolean): KbOption => ({ id, label: OPTION_LABELS[id][0], hint: OPTION_LABELS[id][1], kind: "toggle", value: value ? 1 : 0, writable: w.ok });
      options = [
        toggle("winLock", f.winLock),
        toggle("altTabLock", f.altTabLock),
        toggle("altF4Lock", f.altF4Lock),
        toggle("bottomRapidTrigger", f.bottomRapidTrigger),
        { id: "debounce", label: OPTION_LABELS.debounce[0], hint: OPTION_LABELS.debounce[1], kind: "range", spec: { min: 0, max: 7, step: 1, unit: "level" }, value: f.debounce, writable: w.ok },
        { id: "sleep", label: OPTION_LABELS.sleep[0], hint: OPTION_LABELS.sleep[1], kind: "range", spec: { min: 0, max: 7200, step: 30, unit: "s" }, value: f.sleepSteps * 30, writable: w.ok },
      ];
      const board = m.board;
      if (board && board.effects.length) {
        const settings: LightingSetting[] = [
          { id: "effect", label: "Effect", kind: "choice", choice: { options: board.effects.map((e) => ({ value: e, label: MC_EFFECT_NAMES[e] ?? `Effect ${e}` })) }, value: f.light.effect, writable: w.ok },
          { id: "brightness", label: "Brightness", kind: "range", spec: { min: 0, max: 100, step: 20, unit: "%" }, value: f.light.brightness, writable: w.ok },
          { id: "speed", label: "Speed", kind: "range", spec: { min: 0, max: 4, step: 1, unit: "level" }, value: f.light.speed, writable: w.ok },
          { id: "color", label: "Colour", kind: "color", value: rgbToHs(...f.light.rgb), writable: w.ok },
          { id: "rainbow", label: "Rainbow colours", kind: "toggle", value: f.light.rainbow ? 1 : 0, writable: w.ok },
        ];
        lighting = { groups: [{ id: "lighting", label: "Lighting", settings }], source: "device", note: "Per-key colours are supported by the board but not by this panel yet." };
      }
    }
    const profiles = st.base?.valid && st.base.profileCount ? { active: st.base.profile, count: st.base.profileCount, names: [], writable: false, note: "Switching profiles isn't offered for these boards yet." } : undefined;
    return { info, analog, options, lighting, profiles, notes };
  }

  #refresh = () => {
    this.#state = this.#build();
  };

  // -------------------------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------------------------

  #wrap<T>(p: Fw19f5Plan<T>): KbPlan {
    return {
      label: p.label,
      get expected() {
        return p.expected;
      },
      persistence: p.persistence,
      send: async () => {
        await p.send();
        this.#refresh();
      },
      readBack: async () => {
        const got = await p.readBack();
        this.#refresh();
        return got;
      },
    };
  }

  plan(change: KbChange): KbPlan {
    const s = this.#s;
    if (change.kind === "analog") {
      const v = change.values;
      for (const k of Object.keys(v) as (keyof AnalogValues)[]) if (v[k] !== undefined && v[k] !== null && !["actuationMm", "rapidTrigger", "rtPressMm", "rtReleaseMm"].includes(k)) throw new Error("This keyboard has no such setting.");
      const patch: P.TriggerPatch = {};
      if (typeof v.actuationMm === "number") patch.actuationMm = v.actuationMm;
      if (typeof v.rapidTrigger === "boolean") patch.rapidTrigger = v.rapidTrigger;
      if (typeof v.rtPressMm === "number") patch.rtPressMm = v.rtPressMm;
      if (typeof v.rtReleaseMm === "number") patch.rtReleaseMm = v.rtReleaseMm;
      const specs = this.#specs();
      if (specs) {
        if (patch.actuationMm !== undefined && (patch.actuationMm < specs.actuation.min - 1e-9 || patch.actuationMm > specs.actuation.max + 1e-9)) throw new Error(`Actuation must be ${specs.actuation.min} to ${specs.actuation.max} mm.`);
        for (const d of [patch.rtPressMm, patch.rtReleaseMm]) if (d !== undefined && (d < specs.rt.min - 1e-9 || d > specs.rt.max + 1e-9)) throw new Error(`Rapid trigger distances must be ${specs.rt.min} to ${specs.rt.max} mm.`);
      }
      try {
        const plan = s.planAnalog(change.target === "global" ? "all" : change.target, patch);
        return this.#wrap<Record<number, AnalogRead>>(plan);
      } catch (e) {
        throw e instanceof RangeError ? new Error(e.message) : e;
      }
    }
    if (change.kind === "option") {
      const n = change.value;
      switch (change.id) {
        case "winLock":
          return this.#wrap(s.planFunc({ winLock: n === 1 }, "Windows key lock"));
        case "altTabLock":
          return this.#wrap(s.planFunc({ altTabLock: n === 1 }, "Alt + Tab lock"));
        case "altF4Lock":
          return this.#wrap(s.planFunc({ altF4Lock: n === 1 }, "Alt + F4 lock"));
        case "bottomRapidTrigger":
          return this.#wrap(s.planFunc({ bottomRapidTrigger: n === 1 }, "Rapid trigger at the bottom"));
        case "debounce":
          return this.#wrap(s.planFunc({ debounce: n }, `Debounce level ${n}`));
        case "sleep":
          return this.#wrap(s.planFunc({ sleepSteps: Math.round(n / 30) }, `Sleep after ${n} s`));
        default:
          throw new Error("This keyboard has no such option.");
      }
    }
    if (change.kind === "lighting") {
      const v = change.value;
      const num = typeof v === "number" ? v : NaN;
      switch (change.id) {
        case "effect":
          if (!s.model.board?.effects.includes(num)) throw new Error("This keyboard doesn't offer that effect.");
          return this.#wrap(s.planFunc({ effect: num }, `Lighting effect: ${MC_EFFECT_NAMES[num] ?? num}`));
        case "brightness":
          return this.#wrap(s.planFunc({ brightness: num }, `Brightness ${num}%`));
        case "speed":
          return this.#wrap(s.planFunc({ speed: num }, `Lighting speed ${num}`));
        case "rainbow":
          return this.#wrap(s.planFunc({ rainbow: num === 1 }, "Rainbow colours"));
        case "color": {
          if (typeof v === "number") throw new Error("A colour is a hue and a saturation.");
          return this.#wrap(s.planFunc({ rgb: hsToRgb(v[0], v[1]) }, "Lighting colour"));
        }
        default:
          throw new Error("This keyboard has no such lighting setting.");
      }
    }
    throw new Error("This keyboard's driver can't change that here.");
  }
}
