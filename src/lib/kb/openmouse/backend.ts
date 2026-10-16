// An @openmouse/keyboard-protocol keyboard (Wooting, Wuque Studio, Kochi) as a KbBackend. It holds
// the driver client privately and only ever calls the allowlisted methods (policy.ts), checked again
// on every call. What it shows and can change, per driver:
//   - Wuque Studio: per-key actuation, release, rapid-trigger press/release and dead zones
//     (writePerformance, echoing everything it doesn't change), polling (writeReportRate), the
//     keymap read-only. Writes stay in the keyboard's RAM: the flash save is never sent.
//   - Wooting: identity, profiles (switching is RAM-only), the profile's actuation point, read-only.
//   - Kochi Hummingbird 68: the Windows / Mac switch.
// No Tauri, no React.
import type { KeyboardStatus } from "@openmouse/keyboard-protocol/drivers";
import type { AnalogValues, BlockedCommand, KbBackend, KbChange, KbLayout, KbOption, KbPlan, KbState, KbSupport, KeyIndex, NumberSpec } from "../types.ts";
import { isKbAllowed, isKbBlocked, OMKB_BLOCKED, omkbPersistence, omkbSupport, type KbAllowedMethod } from "./policy.ts";
import type { KbDriverMatch } from "./registry.ts";
import { keycodeLabel } from "../via/keycodes.ts";

type Device = { vendorId: number; productId: number; productName: string; opened?: boolean };

interface WuquePerf {
  mode: number;
  normalPressMm: number;
  normalReleaseMm: number;
  rtFirstTouchMm: number;
  rtPressMm: number;
  rtReleaseMm: number;
  pressDeadStrokeMm: number;
  releaseDeadStrokeMm: number;
  axis: number;
  calibrate: number;
  axisV2Id: number;
  axisRangeMax: number;
  axisCoefficient: number;
}

const WUQUE_RATES: Record<string, number> = { r8khz: 8000, r4khz: 4000, r2khz: 2000, r1khz: 1000, r500hz: 500, r250hz: 250, r125hz: 125 };
const WUQUE_COLS = 21;
/** Wuque layer codes are HID usages in the low byte (QMK's basic keycodes are the same table). */
const hidLabel = (code: number): string => (code === 0 ? "" : code <= 0xff ? keycodeLabel(code, "current") : `0x${code.toString(16)}`);

const ACTUATION: NumberSpec = { min: 0.1, max: 4, step: 0.01, unit: "mm", decimals: 2 };
const RT: NumberSpec = { min: 0.01, max: 2, step: 0.01, unit: "mm", decimals: 2 };
const DEAD: NumberSpec = { min: 0, max: 1, step: 0.01, unit: "mm", decimals: 2 };

const toJsonSafe = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? Array.from(x) : typeof x === "bigint" ? String(x) : x)));

export class OmkbBackend implements KbBackend {
  readonly #client: Record<string, unknown>;
  readonly #device: Device;
  readonly #match: Pick<KbDriverMatch, "brand" | "cls">;
  #status: KeyboardStatus | null = null;
  #perf = new Map<KeyIndex, WuquePerf>();
  #keymap: number[][] = [];
  #rate: string | null = null;
  #rates: string[] = [];
  #rtMin: number | null = null;
  #state: KbState;

  private constructor(client: unknown, device: Device, match: Pick<KbDriverMatch, "brand" | "cls">) {
    this.#client = client as Record<string, unknown>;
    this.#device = device;
    this.#match = match;
    this.#state = { info: { brand: match.brand, model: device.productName, driver: `omkb:${match.cls}`, firmware: [], connection: "USB" }, notes: [] };
  }

  static async open(device: Device, match: KbDriverMatch): Promise<OmkbBackend> {
    const b = new OmkbBackend(match.create(), device, match);
    try {
      await b.load();
    } catch (e) {
      await b.close().catch(() => undefined);
      throw e;
    }
    return b;
  }

  /** Whether it answers: its status read, then closed again if it was opened here. */
  static async ping(device: Device, match: KbDriverMatch): Promise<boolean> {
    const b = new OmkbBackend(match.create(), device, match);
    const wasOpen = Boolean(device.opened);
    try {
      await b.#call("open");
      return !!(await b.#call("readStatus"));
    } catch {
      return false;
    } finally {
      if (!wasOpen) await b.#call("close").catch(() => undefined);
    }
  }

  /** A driver method by name, only if allowed. The single place a client property is read. */
  async #call(method: KbAllowedMethod, ...args: unknown[]): Promise<unknown> {
    if (!isKbAllowed(method) || isKbBlocked(method)) throw new Error(`SYNQ never calls ${method}.`);
    const fn = this.#client[method];
    if (typeof fn !== "function") throw new Error(`This keyboard's driver has no ${method}.`);
    return (fn as (...a: unknown[]) => unknown).apply(this.#client, args);
  }

  #has(method: KbAllowedMethod): boolean {
    return isKbAllowed(method) && typeof this.#client[method] === "function";
  }

  get driver(): string {
    return `omkb:${this.#match.cls}`;
  }
  get state(): KbState {
    return this.#state;
  }
  get support(): KbSupport {
    const s = this.#status;
    const verified = this.#match.cls === "WuqueHidClient" && !!s?.wuque?.device?.protocol;
    return omkbSupport(this.#match.cls, this.#device.vendorId, this.#device.productId, verified);
  }
  get blocked(): readonly BlockedCommand[] {
    return OMKB_BLOCKED;
  }
  snapshot(): unknown {
    // The Wooting one-shot analog snapshot (key depths at connect) is never kept.
    const { analogSnapshot: _drop, ...status } = (this.#status ?? {}) as KeyboardStatus;
    return toJsonSafe({ status, keymap: this.#keymap, performance: Object.fromEntries(this.#perf), rate: this.#rate, rates: this.#rates });
  }
  close(): Promise<void> {
    return this.#has("close") ? (this.#call("close") as Promise<void>) : Promise.resolve();
  }

  async load(): Promise<KbState> {
    if (this.#has("open")) await this.#call("open");
    this.#status = (await this.#call("readStatus")) as KeyboardStatus;
    if (this.#match.cls === "WuqueHidClient") await this.#loadWuque();
    this.#state = this.#build();
    return this.#state;
  }

  async #loadWuque() {
    this.#keymap = [];
    for (let layer = 0; layer < 4; layer++) {
      const k = (await this.#call("readKeyLayout", layer).catch(() => null)) as { rows?: number[][] } | null;
      this.#keymap.push((k?.rows ?? []).flatMap((row) => Array.from({ length: WUQUE_COLS }, (_, c) => row[c] ?? 0)));
    }
    this.#perf.clear();
    for (const index of this.#analogKeys()) {
      const p = (await this.#call("readPerformance", Math.floor(index / WUQUE_COLS), index % WUQUE_COLS).catch(() => null)) as WuquePerf | null;
      if (p) this.#perf.set(index, p);
    }
    this.#rates = ((await this.#call("readReportRates").catch(() => [])) as (string | null)[]).filter((r): r is string => !!r && r in WUQUE_RATES);
    this.#rate = (await this.#call("readReportRate").catch(() => null)) as string | null;
    this.#rtMin = ((await this.#call("readRtPrecision").catch(() => null)) as { min?: number } | null)?.min ?? null;
  }

  /** Keys with something on layer 0: the matrix positions that exist. */
  #analogKeys(): KeyIndex[] {
    return (this.#keymap[0] ?? []).flatMap((code, i) => (code ? [i] : []));
  }

  #build(): KbState {
    const s = this.#status!;
    const state: KbState = {
      info: {
        brand: s.brand || this.#match.brand,
        model: s.name || this.#device.productName || "Keyboard",
        driver: this.driver,
        firmware: s.firmware ?? [],
        serial: s.serial,
        connection: s.connectionDetail || "USB",
        extra: [["Driver", `OpenMouse ${this.#match.cls.replace(/HidClient$/, "")}`], ...(s.layout ? ([["Layout", s.layout]] as [string, string][]) : [])],
      },
      notes: s.ui?.statusNote ? [s.ui.statusNote] : [],
    };
    if (this.#match.cls === "WootingHidClient") {
      if (s.profileCount !== null || s.activeProfile !== null)
        state.profiles = { active: s.activeProfile, count: s.profileCount, names: s.profileNames ?? [], writable: this.#has("switchProfile"), note: "Switching changes the active profile until the keyboard is unplugged." };
      const mm = s.analogProfile?.actuationMm ?? null;
      if (mm !== null) state.analog = { scope: "global", fields: { actuationMm: ACTUATION }, writable: [], global: { actuationMm: mm }, perKey: {}, source: "device", note: "Read from the active profile. SYNQ can't change it on this board yet." };
      state.notes = [...state.notes, "Key mappings, rapid trigger and lighting are read by the driver but not shown or changed yet."];
    }
    if (this.#match.cls === "WuqueHidClient") {
      const perKey: Record<KeyIndex, AnalogValues> = {};
      for (const [k, p] of this.#perf)
        perKey[k] = { actuationMm: p.normalPressMm, releaseMm: p.normalReleaseMm, rtPressMm: p.rtPressMm, rtReleaseMm: p.rtReleaseMm, deadTopMm: p.pressDeadStrokeMm, deadBottomMm: p.releaseDeadStrokeMm };
      if (this.#perf.size) {
        const rt = { ...RT, min: this.#rtMin && this.#rtMin > 0 && this.#rtMin < 1 ? this.#rtMin : RT.min };
        state.analog = {
          scope: "per-key",
          keys: [...this.#perf.keys()],
          travelMm: 4,
          fields: { actuationMm: ACTUATION, releaseMm: ACTUATION, rtPressMm: rt, rtReleaseMm: rt, deadTopMm: DEAD, deadBottomMm: DEAD },
          writable: this.#has("writePerformance") ? ["actuationMm", "releaseMm", "rtPressMm", "rtReleaseMm", "deadTopMm", "deadBottomMm"] : [],
          global: null,
          perKey,
          source: "device",
          note: "Changes stay in the keyboard's memory until it's unplugged: SYNQ never sends this board's flash save.",
        };
      }
      const layout = this.#matrixLayout();
      if (layout)
        state.keymap = {
          layout,
          layers: this.#keymap.length,
          codes: this.#keymap.map((layer) => Object.fromEntries(layout.keys.map((k) => [k.index, layer[k.index] ?? 0]))),
          keySpace: "vendor",
          label: hidLabel,
          assignable: [],
          writable: false,
          source: "device",
          note: "Drawn by matrix position (this board sends no key geometry). Key changes aren't sent to this board yet.",
        };
      const opts = this.#rates.map((r) => WUQUE_RATES[r]).sort((a, b) => a - b);
      if (this.#rate && opts.length) state.polling = { hz: WUQUE_RATES[this.#rate] ?? null, options: opts, writable: this.#has("writeReportRate"), note: "Lost when the keyboard is unplugged (the flash save is never sent)." };
      if (s.activeProfile !== null) state.profiles = { active: s.activeProfile, count: s.profileCount, names: [], writable: false };
    }
    if (this.#match.cls === "KochiHidClient") {
      const mode = s.kochi?.systemMode;
      const option: KbOption = {
        id: "systemMode",
        label: "Windows / Mac",
        hint: "Which modifier layout the keyboard uses.",
        kind: "choice",
        choice: { options: [{ value: 0, label: "Windows" }, { value: 1, label: "Mac" }] },
        value: mode === "win" ? 0 : mode === "mac" ? 1 : null,
        writable: this.#has("setSystemMode"),
      };
      state.options = [option];
    }
    return state;
  }

  #matrixLayout(): KbLayout | null {
    const keys = this.#analogKeys();
    if (!keys.length) return null;
    const rows = Math.max(...keys.map((k) => Math.floor(k / WUQUE_COLS))) + 1;
    const cols = Math.max(...keys.map((k) => k % WUQUE_COLS)) + 1;
    return {
      source: "matrix",
      width: cols,
      height: rows,
      keys: keys.map((index) => ({ index, row: Math.floor(index / WUQUE_COLS), col: index % WUQUE_COLS, x: index % WUQUE_COLS, y: Math.floor(index / WUQUE_COLS), w: 1, h: 1 })),
      note: "By matrix position",
    };
  }

  plan(change: KbChange): KbPlan {
    const cls = this.#match.cls;
    if (change.kind === "analog" && cls === "WuqueHidClient") return this.#planPerformance(change.target, change.values);
    if (change.kind === "polling" && cls === "WuqueHidClient") {
      const name = Object.entries(WUQUE_RATES).find(([k, hz]) => hz === change.hz && this.#rates.includes(k))?.[0];
      if (!name) throw new Error(`This keyboard doesn't offer ${change.hz} Hz.`);
      return {
        label: `Polling rate ${change.hz} Hz`,
        expected: change.hz,
        persistence: omkbPersistence("writeReportRate"),
        send: async () => {
          if (!(await this.#call("writeReportRate", name))) throw new Error("The keyboard didn't take the polling rate.");
        },
        readBack: async () => {
          this.#rate = (await this.#call("readReportRate")) as string | null;
          this.#state = this.#build();
          return this.#rate ? WUQUE_RATES[this.#rate] : undefined;
        },
      };
    }
    if (change.kind === "profile" && cls === "WootingHidClient") {
      const count = this.#status?.profileCount ?? 0;
      if (!Number.isInteger(change.index) || change.index < 0 || change.index >= Math.max(1, count)) throw new Error(`This keyboard has profiles 1 to ${Math.max(1, count)}.`);
      return {
        label: `Profile ${change.index + 1}`,
        expected: change.index,
        persistence: omkbPersistence("switchProfile"),
        send: async () => {
          await this.#call("switchProfile", change.index);
        },
        readBack: async () => {
          this.#status = (await this.#call("readStatus")) as KeyboardStatus;
          this.#state = this.#build();
          return this.#status.activeProfile ?? undefined;
        },
      };
    }
    if (change.kind === "option" && change.id === "systemMode" && cls === "KochiHidClient") {
      if (change.value !== 0 && change.value !== 1) throw new Error("Windows or Mac only.");
      const mode = change.value === 0 ? "win" : "mac";
      return {
        label: `${mode === "win" ? "Windows" : "Mac"} mode`,
        expected: change.value,
        persistence: omkbPersistence("setSystemMode"),
        send: async () => {
          await this.#call("setSystemMode", mode);
        },
        readBack: async () => {
          const got = (await this.#call("readSystemMode")) as string;
          this.#status = { ...this.#status!, kochi: { systemMode: got as "win" | "mac" } };
          this.#state = this.#build();
          return got === "win" ? 0 : got === "mac" ? 1 : undefined;
        },
      };
    }
    throw new Error("This keyboard's driver can't change that.");
  }

  #planPerformance(target: "global" | readonly KeyIndex[], values: AnalogValues): KbPlan {
    const analog = this.#state.analog;
    if (!analog?.writable.length) throw new Error("This keyboard's analog settings can't be changed.");
    const keys = target === "global" ? [...this.#perf.keys()] : [...target];
    if (!keys.length) throw new Error("Pick at least one key.");
    for (const k of keys) if (!this.#perf.has(k)) throw new Error("That key isn't an analog key on this keyboard.");
    const fields: [keyof AnalogValues, keyof WuquePerf][] = [
      ["actuationMm", "normalPressMm"],
      ["releaseMm", "normalReleaseMm"],
      ["rtPressMm", "rtPressMm"],
      ["rtReleaseMm", "rtReleaseMm"],
      ["deadTopMm", "pressDeadStrokeMm"],
      ["deadBottomMm", "releaseDeadStrokeMm"],
    ];
    const changes: [keyof WuquePerf, number][] = [];
    for (const [field, wire] of fields) {
      const v = values[field];
      if (v === undefined || v === null) continue;
      const spec = analog.fields[field];
      if (!spec || spec === "toggle" || typeof v !== "number" || !Number.isFinite(v) || v < spec.min - 1e-9 || v > spec.max + 1e-9) throw new Error(`${field} takes ${spec && spec !== "toggle" ? `${spec.min}–${spec.max} mm` : "no value"}.`);
      changes.push([wire, Math.round(v * 1000) / 1000]);
    }
    if (!changes.length) throw new Error("Nothing to change.");
    const pick = (p: WuquePerf) => Object.fromEntries(changes.map(([w]) => [w, p[w]]));
    const expected = keys.map(() => Object.fromEntries(changes));
    return {
      label: `${changes.length === 1 ? "Analog setting" : "Analog settings"} on ${keys.length === 1 ? "1 key" : `${keys.length} keys`}`,
      expected,
      persistence: omkbPersistence("writePerformance"),
      send: async () => {
        for (const k of keys) {
          const cur = this.#perf.get(k)!;
          // Everything not asked for is sent back exactly as read; calibration stays off.
          await this.#call("writePerformance", { ...cur, ...Object.fromEntries(changes), row: Math.floor(k / WUQUE_COLS), col: k % WUQUE_COLS, calibrate: 0 });
        }
      },
      readBack: async () => {
        const got: Record<string, number>[] = [];
        for (const k of keys) {
          const p = (await this.#call("readPerformance", Math.floor(k / WUQUE_COLS), k % WUQUE_COLS)) as WuquePerf | null;
          if (!p) return undefined;
          this.#perf.set(k, p);
          got.push(pick(p));
        }
        this.#state = this.#build();
        return got;
      },
    };
  }
}
