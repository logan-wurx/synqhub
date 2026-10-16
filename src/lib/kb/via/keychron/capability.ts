// The Keychron Hall-effect capability layer of the VIA backend: reads a Keychron / Lemokey HE keyboard's analog
// profile over the same raw-HID channel VIA uses, shows its actuation and rapid-trigger settings, and plans changes
// to them. It is not a driver of its own: ViaBackend (../backend.ts) owns the channel, the tier and the VIA blocks and
// asks this layer for an `analog` section and for the plan of an `analog` change.
//
// Protocol and byte layouts from Keychron's QMK firmware (GPL-2.0-or-later), see protocol.ts. What the firmware does:
//   - a profile (3 on shipped boards) holds a global configuration and one per matrix key; each is a mode (0 follow the
//     profile, 1 regular, 2 rapid trigger), an actuation point and rapid-trigger press / release sensitivities, in
//     0.1 mm units, where 0 means "follow the profile" for a key;
//   - 0xA9 0x14 sets those on the RAM copy (for the profile's own configuration, or for the keys in a row-mask), and
//     0xA9 0x1F writes the profile to EEPROM; SYNQ always sends the second right after the first;
//   - keys in an advanced mode (dynamic keystroke, game-controller axis, toggle) keep it: they are skipped here.
// Only the active profile is read and written. Nothing here was run against a keyboard.
import type { AnalogState, AnalogValues, KbChange, KbLayout, KbPlan, KeyIndex, NumberSpec } from "../../types.ts";
import type { KcModel } from "./catalog.generated.ts";
import type { KeychronContext } from "./guard.ts";
import * as P from "./protocol.ts";

/** Sends one 32-byte frame and resolves with the matching reply (the VIA transport does the guard and the pacing). */
export type KcSend = (frame: Uint8Array) => Promise<Uint8Array>;

export interface KcState {
  model: KcModel;
  /** The keyboard answered the Keychron version query. */
  present: boolean;
  firmware: string | null;
  analogFeature: boolean;
  analogVersion: number | null;
  info: P.ProfilesInfo | null;
  profileName: string | null;
  global: P.KeyConfig | null;
  /** Key configurations by key index (row * cols + col). */
  keys: Map<number, P.KeyConfig>;
  /** The profile reads like Keychron's analog profile for this board, so its values are shown (and, when true, written). */
  plausible: boolean;
  why: string;
  notes: string[];
}

/** The only analog protocol version SYNQ understands (KC_ANALOG_MATRIX_VERSION & 0xFF in both firmware branches). */
export const ANALOG_VERSION = 4;
const FIELDS = ["actuationMm", "rapidTrigger", "rtPressMm", "rtReleaseMm"] as const;
type Field = (typeof FIELDS)[number];
const SPEC: NumberSpec = { min: 0.1, max: 3.9, step: 0.1, unit: "mm", decimals: 1 };

interface Eff {
  rapid: boolean;
  act: number;
  sens: number;
  rls: number;
}

/** What a key actually does: its own values, else the profile's (analog_matrix.c `update_key_config`). */
export function effective(cfg: P.KeyConfig, g: P.KeyConfig): Eff {
  const mode = cfg.mode === 0 ? g.mode : cfg.mode;
  return {
    rapid: mode === P.AKM.rapid,
    act: cfg.act === 0 ? g.act : cfg.act,
    sens: cfg.sens === 0 ? g.sens : cfg.sens,
    rls: cfg.rls === 0 ? (g.rls === 0 ? g.sens : g.rls) : cfg.rls,
  };
}
const valuesOf = (e: Eff): AnalogValues => ({ actuationMm: P.mmOf(e.act), rapidTrigger: e.rapid, rtPressMm: P.mmOf(e.sens), rtReleaseMm: P.mmOf(e.rls) });

export interface AnalogPatch {
  actuationMm?: number;
  rapidTrigger?: boolean;
  rtPressMm?: number;
  rtReleaseMm?: number;
}

export class KeychronHe {
  readonly model: KcModel;
  state: KcState;
  readonly #send: KcSend;
  readonly #ctx: KeychronContext;
  readonly #allow: () => boolean | Promise<boolean>;

  /** `ctx` is the object the transport's guard reads on every frame: this layer fills in the profile and flips `writes` around a send. */
  constructor(model: KcModel, send: KcSend, ctx: KeychronContext, allowWrites: () => boolean | Promise<boolean> = () => true) {
    this.model = model;
    this.#send = send;
    this.#ctx = ctx;
    this.#allow = allowWrites;
    this.state = this.#blank();
  }

  #blank(): KcState {
    return { model: this.model, present: false, firmware: null, analogFeature: false, analogVersion: null, info: null, profileName: null, global: null, keys: new Map(), plausible: false, why: "Not read yet.", notes: [] };
  }

  get canWrite(): { ok: boolean; why: string } {
    const s = this.state;
    if (!s.present) return { ok: false, why: "This keyboard didn't answer Keychron's commands." };
    if (!s.plausible) return { ok: false, why: s.why };
    return { ok: true, why: "" };
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async #raw(profile: number, offset: number, size: number): Promise<Uint8Array> {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += P.RAW_CHUNK) {
      const n = Math.min(P.RAW_CHUNK, size - i);
      const req = P.profileRawFrame(profile, offset + i, n);
      const got = P.decodeProfileRaw(req, await this.#send(req));
      if (!got || got.length < n) throw new Error("The keyboard's profile bytes didn't come back in order.");
      out.set(got.subarray(0, n), i);
    }
    return out;
  }

  /** Re-reads the active profile's global and key configurations. */
  async readProfile(): Promise<void> {
    const s = this.state;
    const info = s.info!;
    const layout = P.profileLayout(info)!;
    const region = await this.#raw(info.current, 0, P.KEY_CONFIG_BYTES + P.KEY_CONFIG_BYTES * layout.keys);
    s.global = P.decodeKeyConfig(region, 0);
    s.keys = new Map();
    for (let r = 0; r < this.model.rows; r++)
      for (let c = 0; c < this.model.cols; c++) s.keys.set(r * this.model.cols + c, P.decodeKeyConfig(region, layout.keyAt(r, c, this.model.cols)));
  }

  /** The Keychron queries, then the active profile. Sends nothing that changes the keyboard. */
  async read(): Promise<KcState> {
    const s = (this.state = this.#blank());
    this.#ctx.profile = null;
    this.#ctx.writes = false;
    let r: Uint8Array;
    try {
      r = await this.#send(P.protocolVersionFrame());
    } catch {
      s.why = "This keyboard didn't answer Keychron's commands.";
      return s;
    }
    if (P.unhandled(r) || r[0] !== P.KC.protocolVersion) {
      s.why = "This firmware has no Keychron commands.";
      return s;
    }
    s.present = true;
    try {
      s.firmware = P.decodeFirmware(await this.#send(P.firmwareVersionFrame())) || null;
    } catch {
      /* the version text is a nicety */
    }
    const feat = await this.#send(P.supportFeatureFrame());
    s.analogFeature = !P.unhandled(feat) && P.decodeFeatures(feat).analogMatrix;
    if (!s.analogFeature) {
      s.why = "This keyboard doesn't report an analog matrix.";
      return s;
    }
    const ver = await this.#send(P.analogVersionFrame());
    s.analogVersion = P.unhandled(ver) ? null : ver[2];
    const info = P.decodeProfilesInfo(await this.#send(P.profilesInfoFrame()));
    s.info = info;
    if (s.analogVersion !== ANALOG_VERSION) {
      s.why = `Its analog protocol is version ${s.analogVersion ?? "unknown"}; SYNQ understands version ${ANALOG_VERSION}.`;
      s.notes.push(s.why);
      return s;
    }
    const keys = P.keysInProfile(info);
    if (info.current >= info.count || info.count < 1 || info.count > P.MAX_PROFILES || keys !== this.model.rows * this.model.cols) {
      s.why = `The keyboard's profile (${keys ?? "?"} keys, ${info.size} bytes) doesn't match the ${this.model.rows} x ${this.model.cols} matrix SYNQ knows for it.`;
      s.notes.push(s.why);
      return s;
    }
    this.#ctx.profile = info.current;
    await this.readProfile();
    const layout = P.profileLayout(info)!;
    try {
      s.profileName = P.decodeName(await this.#raw(info.current, layout.nameAt, layout.nameLength)) || null;
    } catch {
      /* the name is a nicety */
    }
    // Plausibility (the firmware itself repairs anything outside these on boot): a global mode of 1 or 2, an actuation point
    // and sensitivity in 1..39, and no key configuration outside 0..39.
    const g = s.global!;
    const bad = [...s.keys.values()].filter((k) => k.act > P.MAX_UNITS || k.sens > P.MAX_UNITS || k.rls > P.MAX_UNITS || k.mode > P.AKM.rapid).length;
    s.plausible = (g.mode === P.AKM.regular || g.mode === P.AKM.rapid) && g.act >= 1 && g.act <= P.MAX_UNITS && g.sens >= 1 && g.sens <= P.MAX_UNITS && g.rls <= P.MAX_UNITS && bad === 0;
    s.why = s.plausible ? "" : "The profile doesn't read like Keychron's analog profile (a value out of range), so changes are off.";
    if (!s.plausible) s.notes.push(s.why);
    return s;
  }

  // -------------------------------------------------------------------------------------------
  // The state the panel shows
  // -------------------------------------------------------------------------------------------

  /** The analog section for the panel, given the layout the backend draws (keys carry their matrix index). */
  analog(layout: KbLayout): AnalogState | null {
    const s = this.state;
    if (!s.plausible || !s.global) return null;
    const g = s.global;
    const perKey: Record<KeyIndex, AnalogValues> = {};
    const keys: KeyIndex[] = [];
    for (const k of layout.keys) {
      const cfg = s.keys.get(k.index);
      if (!cfg) continue;
      keys.push(k.index);
      perKey[k.index] = valuesOf(effective(cfg, g));
    }
    const w = this.canWrite.ok;
    return {
      scope: "both",
      keys,
      layout,
      travelMm: 4,
      fields: { actuationMm: SPEC, rapidTrigger: "toggle", rtPressMm: SPEC, rtReleaseMm: SPEC },
      writable: w ? [...FIELDS] : [],
      global: valuesOf(effective({ ...g, mode: g.mode, act: g.act, sens: g.sens, rls: g.rls }, g)),
      perKey,
      source: "device",
      unitSource: "manifest",
      note: `Profile ${(s.info?.current ?? 0) + 1} of ${s.info?.count ?? 1}${s.profileName ? ` (${s.profileName})` : ""}. The default applies to keys that haven't got their own value; keys in an advanced mode (dynamic keystroke, game-controller axis, toggle) are left alone. Changes are saved to the keyboard.`,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------------------------

  async #write(frame: Uint8Array, what: string): Promise<void> {
    if (!(await this.#allow())) throw new Error("Writes are switched off for this keyboard.");
    // The guard lets a write through only while this is on; it goes off again whatever happens.
    this.#ctx.writes = true;
    try {
      const reply = await this.#send(frame);
      if (!P.tookEffect(reply)) throw new Error(`The keyboard refused the change (${what}).`);
    } finally {
      this.#ctx.writes = false;
    }
  }

  #units(v: number, what: string): number {
    const u = P.unitsOf(v);
    if (!Number.isFinite(v) || u < 1 || u > P.MAX_UNITS) throw new Error(`${what} must be ${SPEC.min} to ${SPEC.max} mm.`);
    return u;
  }

  /** Validates a change's fields and turns them to 0.1 mm units. */
  #patch(change: Extract<KbChange, { kind: "analog" }>): { act?: number; rapid?: boolean; sens?: number; rls?: number } {
    const v = change.values;
    for (const k of Object.keys(v) as (keyof AnalogValues)[]) if (v[k] !== undefined && v[k] !== null && !FIELDS.includes(k as Field)) throw new Error("This keyboard has no such setting.");
    const p: { act?: number; rapid?: boolean; sens?: number; rls?: number } = {};
    if (typeof v.actuationMm === "number") p.act = this.#units(v.actuationMm, "Actuation");
    if (typeof v.rapidTrigger === "boolean") p.rapid = v.rapidTrigger;
    if (typeof v.rtPressMm === "number") p.sens = this.#units(v.rtPressMm, "Rapid-trigger press distance");
    if (typeof v.rtReleaseMm === "number") p.rls = this.#units(v.rtReleaseMm, "Rapid-trigger release distance");
    if (Object.keys(p).length === 0) throw new Error("Nothing to change.");
    return p;
  }

  /**
   * The configuration a key (or the profile itself, `global`) should hold after a patch, leaving a field alone when the
   * patch doesn't name it. A profile whose release distance is 0 follows its press distance, so a press-only change
   * pins the release at what it was; a key's release fallback is the profile's, so it needs no such care.
   */
  #next(cur: P.KeyConfig, p: { act?: number; rapid?: boolean; sens?: number; rls?: number }, global: boolean): P.KeyConfig {
    const mode: P.KeyMode = p.rapid === undefined ? cur.mode : p.rapid ? P.AKM.rapid : P.AKM.regular;
    let rls = p.rls ?? cur.rls;
    if (global && p.rls === undefined && p.sens !== undefined && cur.rls === 0) rls = cur.sens;
    return { ...cur, mode, act: p.act ?? cur.act, sens: p.sens ?? cur.sens, rls };
  }

  /** The whole keyboard's defaults (the profile's own configuration). */
  #planGlobal(p: { act?: number; rapid?: boolean; sens?: number; rls?: number }): KbPlan {
    const s = this.state;
    const profile = s.info!.current;
    const expectedFor = (cfg: P.KeyConfig): Partial<Record<Field, unknown>> => {
      const e = valuesOf(effective(cfg, cfg));
      const out: Partial<Record<Field, unknown>> = {};
      if (p.act !== undefined) out.actuationMm = e.actuationMm;
      if (p.rapid !== undefined) out.rapidTrigger = e.rapidTrigger;
      if (p.sens !== undefined) out.rtPressMm = e.rtPressMm;
      if (p.rls !== undefined) out.rtReleaseMm = e.rtReleaseMm;
      return out;
    };
    let expected = expectedFor(this.#next(s.global!, p, true));
    return {
      label: "Default actuation and rapid trigger",
      get expected() {
        return expected;
      },
      persistence: "saved",
      send: async () => {
        await this.readProfile();
        const g = this.state.global!;
        const next = this.#next(g, p, true);
        expected = expectedFor(next);
        if (next.mode === g.mode && next.act === g.act && next.sens === g.sens && next.rls === g.rls) return;
        await this.#write(P.travelFrame({ profile, mode: next.mode as P.KeyMode, act: next.act, sens: next.sens, rls: next.rls }, "entire"), "profile defaults");
        await this.#write(P.saveProfileFrame(profile), "save profile");
      },
      readBack: async () => {
        await this.readProfile();
        return expectedFor(this.state.global!);
      },
    };
  }

  /** Settings on these keys. A key in an advanced mode keeps it: it is skipped, and the plan is refused when that leaves nothing. */
  #planKeys(indices: readonly KeyIndex[], p: { act?: number; rapid?: boolean; sens?: number; rls?: number }): KbPlan {
    const s = this.state;
    const profile = s.info!.current;
    const m = this.model;
    const want = [...new Set(indices)];
    for (const i of want) if (!s.keys.has(i)) throw new Error(`Key ${i} isn't a key on this keyboard.`);
    const own = want.filter((i) => s.keys.get(i)!.adv === 0);
    if (!own.length) throw new Error("Those keys use an advanced mode (dynamic keystroke or similar) that SYNQ leaves alone.");
    const expectedFor = (cfgs: Map<number, P.KeyConfig>, g: P.KeyConfig, which: readonly number[]): Record<number, Partial<Record<Field, unknown>>> => {
      const out: Record<number, Partial<Record<Field, unknown>>> = {};
      for (const i of which) {
        const e = valuesOf(effective(cfgs.get(i)!, g));
        out[i] = { actuationMm: e.actuationMm, rapidTrigger: e.rapidTrigger, rtPressMm: e.rtPressMm, rtReleaseMm: e.rtReleaseMm };
      }
      return out;
    };
    const planned = (cfgs: Map<number, P.KeyConfig>) => new Map(own.filter((i) => cfgs.get(i)!.adv === 0).map((i) => [i, this.#next(cfgs.get(i)!, p, false)]));
    const expected = expectedFor(new Map(planned(s.keys)), s.global!, own);
    return {
      label: `Actuation and rapid trigger on ${own.length === 1 ? "1 key" : `${own.length} keys`}`,
      expected,
      persistence: "saved",
      send: async () => {
        await this.readProfile();
        const st = this.state;
        const next = planned(st.keys);
        const after = new Map(st.keys);
        for (const [i, c] of next) after.set(i, c);
        Object.assign(expected, expectedFor(after, st.global!, [...next.keys()]));
        // One message per distinct result: a message writes all four fields to every key in its row masks.
        const groups = new Map<string, { cfg: P.KeyConfig; keys: number[] }>();
        for (const [i, c] of next) {
          const cur = st.keys.get(i)!;
          if (c.mode === cur.mode && c.act === cur.act && c.sens === cur.sens && c.rls === cur.rls) continue;
          const k = `${c.mode}/${c.act}/${c.sens}/${c.rls}`;
          (groups.get(k) ?? groups.set(k, { cfg: c, keys: [] }).get(k)!).keys.push(i);
        }
        for (const { cfg, keys } of groups.values()) {
          const masks: number[] = new Array(m.rows).fill(0);
          for (const i of keys) masks[Math.floor(i / m.cols)] |= 1 << i % m.cols;
          await this.#write(P.travelFrame({ profile, mode: cfg.mode, act: cfg.act, sens: cfg.sens, rls: cfg.rls }, masks.map((x) => x >>> 0)), "key settings");
        }
        if (groups.size) await this.#write(P.saveProfileFrame(profile), "save profile");
      },
      readBack: async () => {
        await this.readProfile();
        return expectedFor(this.state.keys, this.state.global!, own);
      },
    };
  }

  plan(change: Extract<KbChange, { kind: "analog" }>): KbPlan {
    const w = this.canWrite;
    if (!w.ok) throw new Error(w.why);
    const p = this.#patch(change);
    return change.target === "global" ? this.#planGlobal(p) : this.#planKeys(change.target, p);
  }

  /** What the backup keeps: the decoded profile. */
  snapshot(): unknown {
    const s = this.state;
    const cfg = (c: P.KeyConfig | null) => c && { mode: c.mode, act: c.act, sens: c.sens, rls: c.rls, adv: c.adv, advData: c.advData };
    return { model: `${s.model.brand} ${s.model.name} ${s.model.variant}`.trim(), firmware: s.firmware, analogVersion: s.analogVersion, info: s.info, profileName: s.profileName, global: cfg(s.global), keys: Object.fromEntries([...s.keys].map(([i, c]) => [i, cfg(c)])) };
  }
}

