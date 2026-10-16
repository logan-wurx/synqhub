// The only way the generic mouse panel touches an OpenMouse driver. It holds the driver client
// privately and offers a fixed set of changes; each one maps to one allowlisted driver method
// (src/lib/openmouse/policy.ts). Before the first change it saves a backup of everything it read;
// after every change it reads the mouse again and compares. No Tauri, no React: the website version
// can use it as it is, with its own MouseStore.
import type { MagneticButtonsStatus, MouseLighting, MouseStatus } from "@openmouse/protocol/drivers";
import { AdvancedGate, type AdvancedScope } from "../advanced/core.ts";
import { lockedPanel } from "../advanced/panel.ts";
import type { AdvancedPanel } from "../advanced/types.ts";
import { mouseAdvanced } from "./advanced.ts";
import {
  CHEAPEST_READ,
  NOT_A_MOUSE,
  PERSISTENCE_LABEL,
  hasHandBuiltPanel,
  isAdvancedAllowed,
  isAllowed,
  isBlocked,
  persistenceFor,
  sleepSecondsPerUnit,
  supportTier,
  type AllowedMethod,
  type Persistence,
  type SettingMethod,
  type Tier,
} from "./policy.ts";
import { slug, type MouseStore } from "./store.ts";
import type { DriverMatch } from "./registry.ts";

export type Lod = NonNullable<MouseStatus["liftOffDistance"]>;
export type ToggleSetting = "motionSync" | "angleSnapping" | "rippleControl";

/** Every change the generic panel can ask for. There is no other way to reach the driver. */
export type Change =
  | { kind: "dpi"; dpi: number }
  | { kind: "stages"; values: number[]; active: number }
  | { kind: "polling"; hz: number }
  | { kind: "lod"; value: Lod }
  | { kind: "toggle"; setting: ToggleSetting; on: boolean }
  | { kind: "debounce"; ms: number }
  | { kind: "sleep"; value: number }
  | { kind: "lighting"; lighting: MouseLighting }
  | { kind: "magneticTrigger"; button: 0 | 1; point: number }
  | { kind: "magneticRapid"; button: 0 | 1; enabled: boolean; level: number }
  | { kind: "magneticRelease"; button: 0 | 1; point: number | null };

/** confirmed: read back and equal. mismatch: read back and different. unconfirmed: the mouse can't report it. */
export type Verdict = "confirmed" | "mismatch" | "unconfirmed";

export interface WriteResult {
  view: GenericView;
  verdict: Verdict;
  persistence: Persistence;
  /** One line for a notice: what was checked and where the setting lives. */
  detail: string;
}

const TOGGLE_METHOD: Record<ToggleSetting, SettingMethod> = { motionSync: "setMotionSync", angleSnapping: "setAngleSnapping", rippleControl: "setRippleControl" };
const TOGGLE_HIDDEN: Record<ToggleSetting, "hideMotionSync" | "hideAngleSnapping" | "hideRippleControl"> = {
  motionSync: "hideMotionSync",
  angleSnapping: "hideAngleSnapping",
  rippleControl: "hideRippleControl",
};

export interface GenericView {
  name: string;
  brand: string;
  driver: string;
  vid: number;
  pid: number;
  productName: string;
  tier: Tier;
  /** Changes can be sent right now. */
  writable: boolean;
  /** Why not, when they can't. */
  lockedReason: string | null;
  /** Read-only tier: the person can turn changes on. */
  canAllow: boolean;
  allowChanges: boolean;
  connection: string | null;
  batteryPercent: number | null;
  batteryState: MouseStatus["batteryState"];
  showBattery: boolean;
  firmware: string[];
  mode: MouseStatus["deviceMode"] | null;
  notes: string[];
  dpi: { value: number; options: number[]; min: number; max: number; step: number; canSet: boolean };
  stages: { values: number[]; active: number; maxStages: number; countEditable: boolean; min: number; max: number; step: number; canSet: boolean } | null;
  polling: { hz: number; options: number[]; canSet: boolean; note: string | null } | null;
  lod: { value: Lod | null; options: Lod[]; canSet: boolean } | null;
  toggles: { setting: ToggleSetting; value: boolean | null; canSet: boolean }[];
  debounce: { ms: number | null; options: number[]; canSet: boolean } | null;
  sleep: { value: number | null; options: number[]; secondsPerUnit: number; canSet: boolean } | null;
  lighting: { zones: MouseLighting[]; canSet: boolean } | null;
  magnetic: { status: MagneticButtonsStatus; canTrigger: boolean; canRapid: boolean; canRelease: boolean } | null;
  /** Where each kind of change lives, for the labels next to the controls. */
  persistence: Record<SettingMethod, Persistence>;
}

export interface Snapshot {
  status: MouseStatus;
  dpiOptions: number[];
  pollingOptions: number[];
  sleepOptions: number[];
  debounceOptions: number[];
  debounceMaxMs: number | null;
}

type Device = { vendorId: number; productId: number; productName: string; opened?: boolean };

const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const norm = (v: unknown): unknown => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : Array.isArray(v) ? v.map(norm) : v);
const show = (v: unknown) => (v === null || v === undefined ? "nothing" : typeof v === "string" ? v : JSON.stringify(v));
const toJson = (v: unknown) =>
  JSON.stringify(
    v,
    (_k, x) => (x instanceof Uint8Array ? Array.from(x) : x instanceof Map ? Object.fromEntries(x) : typeof x === "bigint" ? String(x) : x),
    1,
  );

export class SafeMouse {
  readonly #client: Record<string, unknown>;
  readonly #device: Device;
  readonly #match: Pick<DriverMatch, "brand" | "cls">;
  readonly #store: MouseStore;
  #snap: Snapshot;
  #allow = false;
  /** The mouse's Advanced tokens. Generic mice have no bridge-side guard to ask, so this gate is TypeScript only. */
  readonly #gate: AdvancedGate;
  #wait?: (ms: number) => Promise<void>;
  #advanced?: AdvancedPanel;
  #backup: string | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(client: unknown, device: Device, match: Pick<DriverMatch, "brand" | "cls">, store: MouseStore, snap: Snapshot) {
    this.#client = client as Record<string, unknown>;
    this.#device = device;
    this.#match = match;
    this.#store = store;
    this.#snap = snap;
    this.#gate = new AdvancedGate(`om:${hex(device.vendorId)}:${hex(device.productId)}`);
  }

  /** Opens the mouse and reads everything the panel shows. Sends nothing that changes it. */
  static async connect(device: Device, match: Pick<DriverMatch, "brand" | "cls"> & { create(): unknown }, store: MouseStore, opts: { wait?: (ms: number) => Promise<void> } = {}): Promise<SafeMouse> {
    const client = match.create();
    const probe = new SafeMouse(client, device, match, store, null as unknown as Snapshot);
    probe.#wait = opts.wait;
    try {
      probe.#snap = await probe.#readAll();
    } catch (e) {
      await probe.close().catch(() => undefined);
      throw e;
    }
    return probe;
  }

  /**
   * Whether the mouse answers right now: opens it if it isn't open, makes the one cheapest read the
   * driver has (CHEAPEST_READ, else readStatus), and closes it again if it opened it. Changes
   * nothing on the mouse, and nothing in SYNQ's state: no snapshot, no backup, no log.
   */
  static async ping(device: Device, match: Pick<DriverMatch, "cls"> & { create(): unknown }): Promise<boolean> {
    const client = match.create() as Record<string, unknown>;
    const run = (method: string) => (client[method] as () => Promise<unknown>).call(client);
    const read = CHEAPEST_READ[match.cls] ?? "readStatus";
    // Only these three are ever called here, and the read only if it is allowlisted or this class's own.
    if (typeof client[read] !== "function" || !(read === CHEAPEST_READ[match.cls] || isAllowed(read))) return false;
    const wasOpen = Boolean(device.opened);
    try {
      if (typeof client.open === "function" && isAllowed("open")) await run("open");
      // probeReachable answers true or false; readStatus resolves with the status or throws.
      return (await run(read)) !== false;
    } catch {
      return false;
    } finally {
      // A device somebody else already holds open (a panel's session) is left open.
      if (!wasOpen && typeof client.close === "function" && isAllowed("close")) await run("close").catch(() => undefined);
    }
  }

  /**
   * The Advanced card's actions for this mouse: button changes, magnetic-button calibration, a factory reset and
   * receiver pairing, each only where its driver has the method (advanced.ts). Every action is refused while the
   * mouse is still read-only; each then asks for its own confirmation and takes a short-lived token.
   */
  get advanced(): AdvancedPanel {
    return (this.#advanced ??= lockedPanel(
      mouseAdvanced({
        gate: this.#gate,
        name: this.view.name,
        brand: this.#brand(),
        driver: this.#match.cls,
        status: () => this.#snap.status,
        reread: async () => {
          await this.refresh();
          return this.#snap.status;
        },
        wait: this.#wait,
        has: (method) => typeof this.#client[method] === "function",
        call: (scope, method, ...args) => this.#callAdvanced(scope, method, ...args),
        save: (name, body) => this.#store.saveBackup(`${this.#prefix()}-${name}`, toJson({ savedAt: new Date().toISOString(), device: { vendorId: hex(this.#device.vendorId), productId: hex(this.#device.productId), productName: this.#device.productName }, driver: this.#match.cls, ...(body as object) })),
        restoreSettings: (saved) => this.#restoreSettings(saved),
      }),
      () => this.#lockedReason(),
    ));
  }

  /** An Advanced driver call: by name, from policy.ts's list for that scope, while the gate holds its token. */
  async #callAdvanced(scope: AdvancedScope, method: string, ...args: unknown[]): Promise<unknown> {
    if (!isAdvancedAllowed(method, scope, this.#gate)) throw new Error(`SYNQ doesn't call ${method} without your confirmation.`);
    const fn = this.#client[method];
    if (typeof fn !== "function") throw new Error(`This mouse's driver has no ${method}.`);
    const ret = await (fn as (...a: unknown[]) => unknown).apply(this.#client, args);
    await this.#store.log(this.#prefix(), [`${new Date().toISOString()} advanced ${scope}: ${method}(${args.filter((a) => typeof a !== "function" && !(a instanceof AbortSignal)).map(show).join(", ")}) -> ${show(ret)}`]).catch(() => undefined);
    return ret;
  }

  /** Puts the settings SYNQ writes back to what `saved` held, one default-path change at a time (each backed up and read back). */
  async #restoreSettings(saved: MouseStatus): Promise<{ restored: number; skipped: string[] }> {
    await this.refresh();
    const view = this.view;
    const changes: Change[] = [];
    if (view.stages?.canSet && saved.dpiStages?.length) changes.push({ kind: "stages", values: saved.dpiStages, active: saved.activeDpiStage ?? 0 });
    else if (view.dpi.canSet && saved.dpi) changes.push({ kind: "dpi", dpi: saved.dpi });
    if (view.polling?.canSet && saved.pollingRateHz) changes.push({ kind: "polling", hz: saved.pollingRateHz });
    if (view.lod?.canSet && saved.liftOffDistance) changes.push({ kind: "lod", value: saved.liftOffDistance });
    for (const t of view.toggles) if (t.canSet && typeof saved[t.setting] === "boolean") changes.push({ kind: "toggle", setting: t.setting, on: saved[t.setting] as boolean });
    if (view.debounce?.canSet && typeof saved.debounceMs === "number") changes.push({ kind: "debounce", ms: saved.debounceMs });
    if (view.sleep?.canSet && typeof saved.sleepTimeout === "number") changes.push({ kind: "sleep", value: saved.sleepTimeout });
    if (view.lighting?.canSet) for (const z of saved.lightingZones?.length ? saved.lightingZones : saved.lighting ? [saved.lighting] : []) changes.push({ kind: "lighting", lighting: z });
    const mags = saved.magneticButtons?.buttons ?? [];
    if (view.magnetic) {
      mags.slice(0, 2).forEach((b, i) => {
        const button = i as 0 | 1;
        if (view.magnetic!.canTrigger && b.triggerPoint !== null) changes.push({ kind: "magneticTrigger", button, point: b.triggerPoint });
        if (view.magnetic!.canRapid && b.rapidTrigger !== null && b.rapidTriggerEnabled !== null) changes.push({ kind: "magneticRapid", button, enabled: b.rapidTriggerEnabled, level: b.rapidTrigger });
        if (view.magnetic!.canRelease && b.releasePoint !== undefined) changes.push({ kind: "magneticRelease", button, point: b.releasePoint });
      });
    }
    let restored = 0;
    const skipped: string[] = [];
    for (const c of changes) {
      try {
        await this.apply(c);
        restored++;
      } catch (e) {
        if (!/Nothing changed/.test(String(e))) skipped.push(`${c.kind}: ${String(e).replace(/^Error: /, "")}`);
      }
    }
    return { restored, skipped };
  }

  /** A driver method by name, only if allowed. The single place a client property is read. */
  async #call(method: AllowedMethod, ...args: unknown[]): Promise<unknown> {
    if (!isAllowed(method) || isBlocked(method)) throw new Error(`SYNQ never calls ${method}.`);
    const fn = this.#client[method];
    if (typeof fn !== "function") throw new Error(`This mouse's driver has no ${method}.`);
    return (fn as (...a: unknown[]) => unknown).apply(this.#client, args);
  }

  #has(method: AllowedMethod): boolean {
    return isAllowed(method) && typeof this.#client[method] === "function";
  }

  async #optional<T>(method: AllowedMethod, fallback: T): Promise<T> {
    if (!this.#has(method)) return fallback;
    try {
      return ((await this.#call(method)) as T) ?? fallback;
    } catch {
      return fallback;
    }
  }

  async #readAll(): Promise<Snapshot> {
    if (this.#has("open")) await this.#call("open");
    const status = (await this.#call("readStatus")) as MouseStatus;
    const nums = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
    return {
      status,
      dpiOptions: nums(await this.#optional("getDpiOptions", [])),
      pollingOptions: nums(await this.#optional("getSupportedPollingRates", [])),
      sleepOptions: nums(await this.#optional("getSleepOptions", [])),
      debounceOptions: nums(await this.#optional("getDebounceOptions", [])),
      debounceMaxMs: await this.#optional<number | null>("getDebounceMaxMs", null),
    };
  }

  get snapshot(): Snapshot {
    return this.#snap;
  }

  get view(): GenericView {
    return this.#describe();
  }

  /** The read-only tier's switch. Has no effect on mice that can't be written at all. */
  setAllowChanges(on: boolean): GenericView {
    this.#allow = on;
    return this.view;
  }

  /** Reads the mouse again. */
  refresh(): Promise<GenericView> {
    return this.#serial(async () => {
      this.#snap = await this.#readAll();
      return this.view;
    });
  }

  async close(): Promise<void> {
    await this.#gate.revokeAll().catch(() => undefined);
    return this.#has("close") ? (this.#call("close") as Promise<void>) : Promise.resolve();
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #lockedReason(): string | null {
    const { vendorId: vid, productId: pid } = this.#device;
    const ui = this.#snap.status.ui;
    if (hasHandBuiltPanel(vid, pid)) return "SYNQ's own panel handles this mouse; here it's only read.";
    if (NOT_A_MOUSE.has(this.#match.cls)) return "This isn't a mouse; SYNQ only shows what it is.";
    if (ui?.settingsReady === false) return "OpenMouse can identify this mouse but hasn't mapped its settings yet, so they're shown without changing them.";
    if (this.#tier() === "read-only" && !this.#allow) return "Read-only until you allow changes.";
    return null;
  }

  #tier(): Tier {
    return supportTier(this.#device.vendorId, this.#device.productId, this.#snap.status.ui);
  }

  #describe(): GenericView {
    const { status: s, dpiOptions, pollingOptions, sleepOptions, debounceOptions, debounceMaxMs } = this.#snap;
    const ui = s.ui ?? {};
    const has = (m: AllowedMethod) => this.#has(m);
    const locked = this.#lockedReason();
    const tier = this.#tier();
    const canAllow = tier === "read-only" && !hasHandBuiltPanel(this.#device.vendorId, this.#device.productId) && !NOT_A_MOUSE.has(this.#match.cls) && ui.settingsReady !== false;
    const editor = ui.dpiStageEditor;
    const dpiMin = editor?.minDpi ?? (dpiOptions.length ? Math.min(...dpiOptions) : 100);
    const dpiMax = editor?.maxDpi ?? (dpiOptions.length ? Math.max(...dpiOptions) : 26000);
    const dpiStep = editor?.stepDpi ?? (dpiOptions.length > 1 ? Math.max(1, Math.min(...dpiOptions.slice(1).map((v, i) => v - dpiOptions[i]).filter((d) => d > 0))) : 50);
    const showValues = ui.settingsReady !== false || ui.valuesVerified === true;
    const processing = !ui.hideProcessingCard;
    const lods: Lod[] = (s.supportedLiftOffDistances?.length ? s.supportedLiftOffDistances : (["Low", "Medium", "High"] as Lod[])).filter((l) => !(ui.hideLodLow && l === "Low"));
    const polling = ui.hideUnsupportedPollingRates && s.supportedPollingRates?.length ? s.supportedPollingRates : pollingOptions.length ? pollingOptions : (s.supportedPollingRates ?? []);
    const zones = s.lightingZones?.length ? s.lightingZones : s.lighting ? [s.lighting] : [];
    const magnetic = s.magneticButtons;
    const persistence = {} as Record<SettingMethod, Persistence>;
    for (const m of [
      "setDpi",
      "setDpiStageValue",
      "setActiveDpiStage",
      "setDpiStageCount",
      "setPollingRate",
      "setLiftOffDistance",
      "setMotionSync",
      "setAngleSnapping",
      "setRippleControl",
      "setDebounceTime",
      "setSleepTimeout",
      "setLighting",
      "setMagneticTriggerPoint",
      "setMagneticRapidTrigger",
      "setMagneticReleasePoint",
    ] as SettingMethod[])
      persistence[m] = persistenceFor(this.#match.cls, m, this.#device.productId, s.deviceMode);
    const notes = [ui.statusNote].filter((n): n is string => !!n);

    return {
      name: s.name || ui.defaultDisplayName || this.#device.productName || "Mouse",
      brand: this.#brand(),
      driver: this.#match.cls,
      vid: this.#device.vendorId,
      pid: this.#device.productId,
      productName: this.#device.productName,
      tier,
      writable: locked === null,
      lockedReason: locked,
      canAllow,
      allowChanges: this.#allow,
      connection: s.connectionType ? `${s.connectionType === "Wired" ? "Cable" : "Wireless"}${s.connectionDetail ? ` · ${s.connectionDetail}` : ""}` : null,
      batteryPercent: s.batteryPercent,
      batteryState: s.batteryState,
      showBattery: s.batteryPercent !== null || ui.forceShowBattery === true || s.connectionType === "Wireless",
      firmware: s.firmware ?? [],
      mode: s.deviceMode ?? null,
      notes,
      dpi: { value: s.dpi, options: dpiOptions, min: dpiMin, max: dpiMax, step: dpiStep, canSet: showValues && has("setDpi") },
      stages:
        showValues && s.dpiStages?.length
          ? {
              values: s.dpiStages,
              active: Math.max(0, Math.min(s.activeDpiStage ?? 0, s.dpiStages.length - 1)),
              maxStages: editor?.maxStages ?? s.dpiStages.length,
              countEditable: !!editor && editor.countEditable !== false && has("setDpiStageCount"),
              min: dpiMin,
              max: dpiMax,
              step: dpiStep,
              canSet: !!editor && has("setDpiStageValue"),
            }
          : null,
      polling: showValues && s.pollingRateHz ? { hz: s.pollingRateHz, options: polling.length ? polling : [s.pollingRateHz], canSet: !ui.pollingReadOnly && has("setPollingRate"), note: ui.pollingNote ?? null } : null,
      lod: showValues && s.liftOffDistance !== undefined ? { value: s.liftOffDistance, options: lods, canSet: has("setLiftOffDistance") } : null,
      toggles: showValues && processing
        ? (["motionSync", "angleSnapping", "rippleControl"] as ToggleSetting[])
            .filter((t) => s[t] !== undefined && !ui[TOGGLE_HIDDEN[t]])
            .map((t) => ({ setting: t, value: s[t] ?? null, canSet: has(TOGGLE_METHOD[t]) }))
        : [],
      debounce:
        showValues && s.debounceMs !== undefined
          ? { ms: s.debounceMs ?? null, options: debounceOptions.length ? debounceOptions : debounceMaxMs ? range(0, debounceMaxMs) : [], canSet: has("setDebounceTime") }
          : null,
      sleep:
        showValues && s.sleepTimeout !== undefined && !ui.hideSleepCard
          ? { value: s.sleepTimeout ?? null, options: sleepOptions, secondsPerUnit: sleepSecondsPerUnit(this.#match.cls), canSet: has("setSleepTimeout") && sleepOptions.length > 0 }
          : null,
      lighting: zones.length ? { zones, canSet: has("setLighting") } : null,
      magnetic: magnetic
        ? { status: magnetic, canTrigger: has("setMagneticTriggerPoint"), canRapid: has("setMagneticRapidTrigger") && magnetic.rapidTriggerRange !== null, canRelease: has("setMagneticReleasePoint") && !!magnetic.releasePointRange }
        : null,
      persistence,
    };
  }

  #brand(): string {
    if (this.#match.cls === "EggWeHidClient" || this.#match.cls === "EggOp1HidClient") return "Endgame Gear";
    const fn = this.#client.deviceBrand;
    if (typeof fn === "function") {
      try {
        const b = (fn as () => unknown).call(this.#client);
        if (typeof b === "string" && b) return b;
      } catch {
        /* the registry's brand */
      }
    }
    return this.#snap.status.brand || this.#match.brand;
  }

  /** Changes one setting: backup first (once), write, read back, compare, log. */
  apply(change: Change): Promise<WriteResult> {
    return this.#serial(() => this.#apply(change));
  }

  async #apply(change: Change): Promise<WriteResult> {
    const locked = this.#lockedReason();
    if (locked) throw new Error(locked);
    const view = this.view;
    const plan = this.#plan(change, view);
    await this.#backupOnce();
    const log: string[] = [];
    let expected: unknown = plan.expected;
    for (const [method, args] of plan.calls) {
      const ret = await this.#call(method, ...args);
      log.push(`${new Date().toISOString()} ${method}(${args.map(show).join(", ")}) -> ${show(ret)}`);
      // A setter that returns what it applied (clamped or snapped) is what to compare against.
      if (plan.calls.length === 1 && plan.useReturn && ret !== undefined && typeof ret === typeof expected) expected = ret;
    }
    this.#snap = await this.#readAll();
    const got = plan.readBack(this.#snap.status);
    const verdict: Verdict = plan.unconfirmable || got === undefined || got === null ? "unconfirmed" : same(got, expected) ? "confirmed" : "mismatch";
    const persistence = persistenceFor(this.#match.cls, plan.calls[0]?.[0] ?? "setDpi", this.#device.productId, this.#snap.status.deviceMode);
    const checked =
      verdict === "confirmed"
        ? "Read back from the mouse"
        : verdict === "unconfirmed"
          ? "Unconfirmed: the mouse can't report this back"
          : `The mouse reports ${show(got)} instead of ${show(expected)}`;
    log.push(`  read back: ${show(got)} expected ${show(expected)} -> ${verdict} (${persistence})`);
    await this.#store.log(this.#prefix(), [`# ${this.#brand()} ${this.view.name} ${hex(this.#device.vendorId)}:${hex(this.#device.productId)} ${this.#match.cls}`, ...log]).catch(() => undefined);
    return { view: this.view, verdict, persistence, detail: `${checked} · ${PERSISTENCE_LABEL[persistence]}` };
  }

  #prefix(): string {
    return `generic-${slug(this.#brand())}-${slug(this.view.name)}`;
  }

  async #backupOnce(): Promise<void> {
    if (this.#backup) return;
    const json = toJson({
      savedAt: new Date().toISOString(),
      note: "Everything SYNQ read from this mouse before its first change (generic OpenMouse panel).",
      device: { vendorId: hex(this.#device.vendorId), productId: hex(this.#device.productId), productName: this.#device.productName },
      driver: this.#match.cls,
      brand: this.#brand(),
      ...this.#snap,
    });
    this.#backup = await this.#store.saveBackup(this.#prefix(), json);
  }

  /** Where the first backup went, once there is one. */
  get backupPath(): string | null {
    return this.#backup;
  }

  #plan(change: Change, view: GenericView): Plan {
    const one = (method: SettingMethod, args: unknown[], expected: unknown, readBack: (s: MouseStatus) => unknown, extra: Partial<Plan> = {}): Plan => ({
      calls: [[method, args]],
      expected,
      readBack,
      useReturn: true,
      unconfirmable: false,
      ...extra,
    });
    const need = (ok: boolean | undefined, what: string) => {
      if (!ok) throw new Error(`${what} can't be changed on this mouse.`);
    };
    switch (change.kind) {
      case "dpi": {
        need(view.dpi.canSet, "DPI");
        const dpi = clamp(change.dpi, view.dpi.min, view.dpi.max, view.dpi.step);
        return one("setDpi", [dpi], dpi, (s) => s.dpi);
      }
      case "stages": {
        const st = view.stages;
        need(st?.canSet, "DPI steps");
        const values = change.values.map((v) => clamp(v, st!.min, st!.max, st!.step));
        if (!values.length || values.length > st!.maxStages) throw new Error(`This mouse takes 1 to ${st!.maxStages} DPI steps.`);
        if (values.length !== st!.values.length && !st!.countEditable) throw new Error("This mouse has a fixed number of DPI steps.");
        const active = Math.max(0, Math.min(change.active, values.length - 1));
        const calls: [SettingMethod, unknown[]][] = [];
        if (values.length !== st!.values.length) calls.push(["setDpiStageCount", [values.length]]);
        values.forEach((v, i) => v !== st!.values[i] && calls.push(["setDpiStageValue", [i, v]]));
        if (active !== st!.active) calls.push(["setActiveDpiStage", [active]]);
        if (!calls.length) throw new Error("Nothing changed.");
        return {
          calls,
          expected: { values, active },
          readBack: (s) => (s.dpiStages ? { values: s.dpiStages.slice(0, values.length), active: s.activeDpiStage } : undefined),
          useReturn: false,
          unconfirmable: false,
        };
      }
      case "polling":
        need(view.polling?.canSet && view.polling.options.includes(change.hz), "That polling rate");
        return one("setPollingRate", [change.hz], change.hz, (s) => s.pollingRateHz);
      case "lod":
        need(view.lod?.canSet && view.lod.options.includes(change.value), "Lift-off distance");
        return one("setLiftOffDistance", [change.value], change.value, (s) => s.liftOffDistance);
      case "toggle": {
        const t = view.toggles.find((x) => x.setting === change.setting);
        need(t?.canSet, "That setting");
        return one(TOGGLE_METHOD[change.setting], [change.on], change.on, (s) => s[change.setting]);
      }
      case "debounce":
        need(view.debounce?.canSet && (!view.debounce.options.length || view.debounce.options.includes(change.ms)), "That debounce time");
        return one("setDebounceTime", [change.ms], change.ms, (s) => s.debounceMs);
      case "sleep":
        need(view.sleep?.canSet && view.sleep.options.includes(change.value), "That sleep time");
        return one("setSleepTimeout", [change.value], change.value, (s) => s.sleepTimeout);
      case "lighting": {
        need(view.lighting?.canSet, "Lighting");
        const zone = view.lighting!.zones.find((z) => z.zone === change.lighting.zone);
        if (!zone) throw new Error(`No lighting zone ${change.lighting.zone}.`);
        if (change.lighting.mode && !zone.modes.includes(change.lighting.mode)) throw new Error(`${change.lighting.mode} isn't an effect this zone has.`);
        const pick = (l: MouseLighting | undefined) => (l ? { mode: l.mode, color: l.colorModes.includes(l.mode as never) ? l.color : null } : undefined);
        return {
          calls: [["setLighting", [change.lighting]]],
          expected: pick(change.lighting),
          readBack: (s) => pick((s.lightingZones?.length ? s.lightingZones : s.lighting ? [s.lighting] : []).find((z) => z.zone === change.lighting.zone)),
          useReturn: false,
          // Razer and others: the effect can be written but not read back.
          unconfirmable: zone.writeOnly === true,
        };
      }
      case "magneticTrigger": {
        const m = view.magnetic;
        need(m?.canTrigger, "The trigger point");
        const point = Math.max(m!.status.triggerPointRange.min, Math.min(m!.status.triggerPointRange.max, change.point));
        return one("setMagneticTriggerPoint", [change.button, point], point, (s) => s.magneticButtons?.buttons[change.button]?.triggerPoint);
      }
      case "magneticRapid": {
        const m = view.magnetic;
        need(m?.canRapid, "Rapid trigger");
        const r = m!.status.rapidTriggerRange!;
        const level = Math.max(r.min, Math.min(r.max, change.level));
        return one(
          "setMagneticRapidTrigger",
          [change.button, change.enabled, level],
          { enabled: change.enabled, level },
          (s) => {
            const b = s.magneticButtons?.buttons[change.button];
            return b && b.rapidTriggerEnabled !== null && b.rapidTrigger !== null ? { enabled: b.rapidTriggerEnabled, level: b.rapidTrigger } : undefined;
          },
          { useReturn: false },
        );
      }
      case "magneticRelease": {
        const m = view.magnetic;
        need(m?.canRelease, "The release point");
        return one("setMagneticReleasePoint", [change.button, change.point], change.point, (s) => s.magneticButtons?.buttons[change.button]?.releasePoint, {
          // Null means "follows the trigger point": nothing separate to read back.
          unconfirmable: change.point === null,
        });
      }
    }
    // Anything else (a caller that got around the types) is refused.
    throw new Error(`SYNQ has no change called ${String((change as { kind?: unknown }).kind)}.`);
  }
}

interface Plan {
  calls: [SettingMethod, unknown[]][];
  expected: unknown;
  readBack: (s: MouseStatus) => unknown;
  useReturn: boolean;
  unconfirmable: boolean;
}

const hex = (n: number) => n.toString(16).padStart(4, "0");
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
function clamp(v: number, min: number, max: number, step: number) {
  const snapped = Math.round(v / step) * step;
  return Math.max(min, Math.min(max, snapped));
}
