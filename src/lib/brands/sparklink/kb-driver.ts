// The SparkLink family (Royal Kludge C / M75 HE / X87, AULA HE boards, Kochi Hummingbird 68) as a generic Keyboard
// panel driver (src/lib/kb/types.ts), on top of SparkLinkSession. KbSession owns "Allow changes", the backup and the
// read-back verdict; SparkLinkSession keeps its guard, units and re-reads.
//
// What every board gets: its name, firmware, serial and configuration number. What a board that reports a travel range
// gets on top: a default actuation and dead zones, and per key an own actuation, rapid trigger (press / release
// distance) and dead zones. A board that has the Windows / Mac switch gets it. Everything starts read-only behind "Allow
// changes": nobody has driven these boards with SYNQ, and the SDK doesn't say whether a change survives a power cycle.
//
// Protocol: @sparklinkplayjoy/sdk-keyboard and protocol-keyboard (MIT), see protocol.ts. SYNQ is AGPL-3.0.
import type { AnalogValues, BlockedCommand, HidLike as KbHidLike, KbBackend, KbChange, KbDriver, KbKey, KbLayout, KbOption, KbPlan, KbState, KbSupport, KeyIndex, NumberSpec } from "../../kb/types.ts";
import { HID_NAMES } from "../../x68he-protocol.ts";
import type { HidLike } from "../local-kb.ts";
import { SPARKLINK_CHANNEL, SPARKLINK_VIDS, isKochi, sparklinkModel } from "./devices.ts";
import { BLOCKED } from "./guard.ts";
import * as P from "./protocol.ts";
import { SparkLinkSession, tierAllowsWrites, type KeyRead, type SparkLinkPlan } from "./session.ts";

const DRIVER_ID = "sparklink";

/** A SparkLink-family id the table names and its vendor collection 0xFFA0:0x0001. No I/O. */
export function claimsSparkLink(d: { vendorId: number; productId: number; collections?: readonly { usagePage?: number; usage?: number }[] }): boolean {
  if (!sparklinkModel(d.vendorId, d.productId)) return false;
  return (d.collections ?? []).some((c) => c.usagePage === SPARKLINK_CHANNEL.usagePage && (c.usage ?? 0) === SPARKLINK_CHANNEL.usage);
}

const asLocal = (d: KbHidLike): HidLike => d as unknown as HidLike;
const hex4 = (n: number) => n.toString(16).padStart(4, "0");
const keyLabel = (value: number): string => (value === 1 ? "Fn" : (HID_NAMES[value] ?? `0x${value.toString(16)}`));

export const sparklinkKbDriver: KbDriver = {
  id: DRIVER_ID,
  name: "SparkLink (Royal Kludge, AULA, Kochi)",
  // Above OpenMouse's keyboard driver, which also knows the Kochi Hummingbird 68 (Windows / Mac switch only).
  priority: 60,
  vids: SPARKLINK_VIDS,
  claims: (d) => claimsSparkLink(d),
  async open(device) {
    if (!device.opened) await device.open();
    return new SparkLinkKbBackend(device, await SparkLinkSession.connect(asLocal(device), { allowWrites: () => true }));
  },
  async ping(device) {
    const wasOpen = device.opened;
    try {
      if (!wasOpen) await device.open();
      const s = await SparkLinkSession.connect(asLocal(device));
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

const ANALOG_FIELDS: readonly (keyof AnalogValues)[] = ["actuationMm", "rapidTrigger", "rtPressMm", "rtReleaseMm", "deadTopMm", "deadBottomMm"];

export class SparkLinkKbBackend implements KbBackend {
  readonly driver = DRIVER_ID;
  readonly blocked: readonly BlockedCommand[] = BLOCKED.map((b) => ({ what: b.what, why: b.why }));
  readonly #device: KbHidLike;
  readonly #s: SparkLinkSession;
  #state: KbState;

  constructor(device: KbHidLike, session: SparkLinkSession) {
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
    const why = writes
      ? "Built from the SparkLink SDK's documentation and the AureTrix driver (both MIT). No one has changed settings on this keyboard with SYNQ; every change is read back and compared."
      : (m.notes ?? "Read-only.");
    return { tier: "read-only", why, ...(this.#s.modeSwitchTested ? { groups: { options: "driver-tested" as const } } : {}) };
  }

  async load(): Promise<KbState> {
    await this.#s.readAll();
    this.#state = this.#build();
    return this.#state;
  }

  snapshot(): unknown {
    const st = this.#s.state;
    return {
      model: this.#s.model.model,
      id: `${hex4(this.#s.model.vendorId)}:${hex4(this.#s.model.productId)}`,
      sync: st.sync,
      protocol: st.protocol,
      name: st.name,
      precision: st.precision,
      global: st.global,
      keys: st.keys,
      perKey: Object.fromEntries(st.perKey),
      winMode: st.winMode,
      rateHz: st.rateHz,
      configId: st.configId,
    };
  }

  async close(): Promise<void> {
    this.#s.close();
    if (this.#device.opened) await this.#device.close().catch(() => undefined);
  }

  // -------------------------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------------------------

  #layout(): KbLayout {
    const keys: KbKey[] = this.#s.state.keys.map((k) => ({ index: k.index, row: k.row, col: k.col, x: k.col, y: k.row, w: 1, h: 1, label: keyLabel(k.key) }));
    return {
      source: "matrix",
      width: Math.max(1, ...keys.map((k) => k.x + k.w)),
      height: Math.max(1, ...keys.map((k) => k.y + k.h)),
      keys,
      note: "Keys are drawn at their matrix positions (this keyboard sends no geometry), labelled with the factory key.",
    };
  }

  #valuesOf(r: KeyRead): AnalogValues {
    const g = this.#s.state.global;
    const dead = this.#s.globalDead();
    return {
      actuationMm: r.touch === "global" ? (g?.travelMm ?? r.travelMm) : r.travelMm,
      rapidTrigger: r.touch === "rt",
      rtPressMm: r.touch === "rt" ? r.rtPressMm : null,
      rtReleaseMm: r.touch === "rt" ? r.rtReleaseMm : null,
      deadTopMm: r.deadTopMm ?? dead.top,
      deadBottomMm: r.deadBottomMm ?? dead.bottom,
    };
  }

  #build(): KbState {
    const s = this.#s;
    const st = s.state;
    const m = s.model;
    const notes: string[] = [...st.notes];
    if (!st.answered) notes.push("Nothing else can be read or changed.");
    const w = s.canWriteKeys;
    if (st.answered && st.analog && !w.ok && tierAllowsWrites(m.tier)) notes.push(`Key changes aren't sent to this keyboard: ${w.why}`);
    if (st.ambiguous.length) notes.push(`${st.ambiguous.length} key${st.ambiguous.length === 1 ? " shares its factory key" : "s share a factory key"} with another, so they can't be addressed one at a time and are left out.`);

    const name = isKochi(m.vendorId, m.productId) ? m.name : st.name && st.name.length >= 3 && !/^[?\s]+$/.test(st.name) ? st.name : m.name;
    const firmware: string[] = [];
    if (st.sync) {
      const parts = [st.sync.appVersion, st.sync.versionString].filter(Boolean);
      if (parts.length) firmware.push(`Firmware ${parts.join(" ")}`);
      if (st.sync.buildDate) firmware.push(`Built ${st.sync.buildDate}`);
    }
    const extra: [string, string][] = [];
    if (st.sync) extra.push(["Board id", `0x${st.sync.boardId.toString(16).padStart(8, "0")}`]);
    if (st.precision) extra.push(["Travel", `${st.precision.minMm} to ${st.precision.maxMm} mm in ${st.precision.stepMm} mm steps`]);
    if (st.configId !== null) extra.push(["Configuration", String(st.configId + 1)]);
    const info: KbState["info"] = {
      brand: m.brand,
      model: name,
      driver: DRIVER_ID,
      protocol: st.protocol ? `SparkLink protocol ${st.protocol}` : "SparkLink protocol",
      firmware,
      serial: st.sync?.serial || null,
      connection: "USB",
      extra,
    };
    if (!st.answered) return { info, notes };

    const out: KbState = { info, notes };
    const ranges = s.ranges();
    if (st.analog && st.unitsOk && ranges && st.keys.length) {
      const mm = (min: number, max: number): NumberSpec => ({ min, max, step: ranges.step, unit: "mm", decimals: 2 });
      const perKey: Record<KeyIndex, AnalogValues> = {};
      for (const k of st.keys) {
        const r = st.perKey.get(k.key);
        if (r) perKey[k.index] = this.#valuesOf(r);
      }
      const analogKeys = st.keys.filter((k) => st.perKey.has(k.key)).map((k) => k.index);
      const dead = s.globalDead();
      const own = [...st.perKey.values()].filter((r) => r.adv === 0);
      const rt = own.length && own.every((r) => r.touch === "rt") ? true : own.some((r) => r.touch === "rt") ? null : false;
      out.analog = {
        scope: "both",
        keys: analogKeys,
        layout: this.#layout(),
        travelMm: ranges.actuation[1],
        fields: {
          actuationMm: mm(...ranges.actuation),
          rapidTrigger: "toggle",
          rtPressMm: mm(...ranges.rt),
          rtReleaseMm: mm(...ranges.rt),
          deadTopMm: mm(...ranges.dead),
          deadBottomMm: mm(...ranges.dead),
        },
        writable: w.ok ? [...ANALOG_FIELDS] : [],
        global: { actuationMm: st.global?.travelMm ?? null, rapidTrigger: rt, deadTopMm: dead.top, deadBottomMm: dead.bottom },
        perKey,
        source: "device",
        unitSource: "device-query",
        note: "The default applies to keys that haven't got their own setting. A key given its own actuation or rapid trigger switches to its own mode; keys in an advanced mode (dynamic keystroke and the like) are left alone. Whether a change survives a power cycle isn't documented by the maker.",
      };
    } else if (st.keys.length) {
      notes.push(st.unitsWhy || "This keyboard didn't report key travel settings.");
    }

    const options: KbOption[] = [];
    if (st.winMode !== null) {
      options.push({
        id: "systemMode",
        label: "Operating-system mode",
        hint: "Windows or Mac key behaviour",
        kind: "choice",
        choice: { options: [{ value: 0, label: "Windows" }, { value: 1, label: "Mac" }] },
        value: st.winMode ? 0 : 1,
        writable: s.canWrite.ok,
      });
    }
    if (options.length) out.options = options;
    if (st.rateHz !== null) out.polling = { hz: st.rateHz, options: [...P.RATE_HZ], writable: false, note: "Changing the report rate restarts the keyboard, so SYNQ only shows it for now." };
    if (st.configId !== null) out.profiles = { active: st.configId, count: 4, names: [], writable: false, note: "Switching configurations isn't offered for these boards yet." };
    return out;
  }

  #refresh = () => {
    this.#state = this.#build();
  };

  // -------------------------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------------------------

  #wrap<T>(p: SparkLinkPlan<T>): KbPlan {
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

  #keyOfIndex(index: KeyIndex): number {
    const k = this.#s.state.keys.find((x) => x.index === index);
    if (!k) throw new Error(`Key ${index} isn't a key on this keyboard.`);
    return k.key;
  }

  plan(change: KbChange): KbPlan {
    const s = this.#s;
    if (change.kind === "analog") {
      const v = change.values;
      for (const k of Object.keys(v) as (keyof AnalogValues)[]) if (v[k] !== undefined && v[k] !== null && !ANALOG_FIELDS.includes(k)) throw new Error("This keyboard has no such setting.");
      const patch: { actuationMm?: number; rapidTrigger?: boolean; rtPressMm?: number; rtReleaseMm?: number; deadTopMm?: number; deadBottomMm?: number } = {};
      if (typeof v.actuationMm === "number") patch.actuationMm = v.actuationMm;
      if (typeof v.rapidTrigger === "boolean") patch.rapidTrigger = v.rapidTrigger;
      if (typeof v.rtPressMm === "number") patch.rtPressMm = v.rtPressMm;
      if (typeof v.rtReleaseMm === "number") patch.rtReleaseMm = v.rtReleaseMm;
      if (typeof v.deadTopMm === "number") patch.deadTopMm = v.deadTopMm;
      if (typeof v.deadBottomMm === "number") patch.deadBottomMm = v.deadBottomMm;
      try {
        if (change.target === "global") {
          const rtFields = patch.rapidTrigger !== undefined || patch.rtPressMm !== undefined || patch.rtReleaseMm !== undefined;
          const base = patch.actuationMm !== undefined || patch.deadTopMm !== undefined || patch.deadBottomMm !== undefined;
          if (rtFields && base) throw new Error("Change the default travel and the rapid trigger separately.");
          // Rapid trigger is per key: "the whole keyboard" applies it to every key.
          if (rtFields) return this.#wrap(s.planKeys("all", patch));
          return this.#wrap(s.planGlobal(patch));
        }
        return this.#wrap(s.planKeys(change.target.map((i) => this.#keyOfIndex(i)), patch));
      } catch (e) {
        throw e instanceof RangeError ? new Error(e.message) : e;
      }
    }
    if (change.kind === "option" && change.id === "systemMode") {
      if (change.value !== 0 && change.value !== 1) throw new Error("The mode is Windows (0) or Mac (1).");
      return this.#wrap(s.planSystemMode(change.value === 0 ? "win" : "mac"));
    }
    throw new Error("This keyboard's driver can't change that here.");
  }
}
