# SYNQ capability model (proposal)

Status: design proposal, 2026-10-13. No code exists yet.

It is written to meet two requirements:
- every device family in [BRANDS.md](BRANDS.md) fits it, and so does the order of work in [ROADMAP.md](ROADMAP.md);
- the drivers SYNQ already has (Logitech HID++ via OpenMouse, ATK/Compx, ROG Falchion Ace HFX, X68 HE/illumipc) and the Equalizer APO engine can be re-expressed in it without losing anything they do today.

Related formats it lines up with (all reviewed in BRANDS.md):
- AutoEq's per-slot `PEQ_CONFIGS` / `peq.yaml` schema (MIT);
- HeadsetControl's `EqualizerInfo` / `ParametricEqualizerInfo` (GPL-3.0+);
- devicePEQ's `peqConstraintsConfig.json` (0BSD);
- Keychron's analog-matrix structs (GPL-2.0+);
- the Wooting / Razer / Corsair / ASUS HE settings vocabularies.

## 1. Goals

1. **The UI builds itself.** A driver says *what* the device can do (groups, settings, ranges, steps,
   scope, how values are known). Pages render cards from that. No brand-specific branching in the UI:
   drivers only describe what exists.
2. **One driver core for web and desktop.** Drivers talk to a `HidLike` (WebHID's `HIDDevice` shape). In
   Chrome/Edge it is the real `navigator.hid`; in the desktop app it is the Rust bridge
   (`src/lib/tauri-hid.ts` already does this). Audio EQ has a second transport (Equalizer APO engine,
   desktop only).
3. **Honest values.** Many devices cannot report what they hold (Falchion actuation, Razer lighting,
   X68 profiles on old firmware). Every value carries where it came from.
4. **Safety by construction.** Every outgoing report passes a per-driver allowlist, in TypeScript and
   again in the Rust bridge (as the X68 and ATK drivers already do). Firmware, bootloader, pairing,
   factory reset and calibration are never reachable from generated UI.
5. **Support tiers are data,** per model, firmware and setting, with evidence, so "verified",
   "community-tested", "experimental" and "read-only" are shown and enforced the same way everywhere.

## 2. Layers

```
 UI (cards generated from Capabilities)          <- knows nothing about brands
   │ Change[] / Values / events
 DeviceSession  (one per connected device)       <- plan → apply → verify, cache, backups, diagnostics
   │ reports
 Driver (codec + model tables + guard)           <- pure TS, shared by web + desktop
   │ HidLike (sendReport / sendFeatureReport / receiveFeatureReport / inputreport)
 Transport: WebHID (browser) | Rust bridge (desktop) | EAPO engine (desktop audio) | none (detect-only)
           └ bridge re-checks every frame against the same guard (compiled to Rust tables)
```

## 3. TypeScript sketch

The sketch is the contract; names are proposals. Units are always the human unit (mm, Hz, dB, ms,
counts per inch). Drivers convert to device units (0.1 mm, codes, BCD) internally.

### 3.1 Primitives

```ts
export type Unit = "cpi" | "hz" | "ms" | "s" | "min" | "mm" | "deg" | "%" | "db" | "q" | "level" | "none";

/** A number the device accepts. `values` wins over min/max/step when the device only takes a set. */
export interface NumberSpec {
  kind: "number";
  unit: Unit;
  min: number;
  max: number;
  step: number;
  values?: readonly number[];          // e.g. polling [125, 250, 500, 1000, 2000, 4000, 8000]
  labels?: Readonly<Record<number, string>>; // e.g. LOD {1: "Low", 2: "Medium", 3: "High"}
  decimals?: number;
  /** Finer step that applies when a condition holds (X68 "high precision" 0.01 mm mode). */
  fine?: { when: Condition; step: number };
  /** Logarithmic slider (EQ frequency, Q). */
  log?: boolean;
}

export interface ChoiceSpec<V extends string | number = string> {
  kind: "choice";
  options: readonly { value: V; label: string; hint?: string; tier?: SupportTier }[];
}

export interface ToggleSpec { kind: "toggle" }
export interface ColorSpec { kind: "color"; model: "rgb" | "rgbw" | "palette"; palette?: readonly string[] }
export interface TextSpec { kind: "text"; maxBytes: number; charset: "ascii" | "utf16" }

/** An ordered list, e.g. DPI stages or SOCD pairs. */
export interface ListSpec<S extends Spec = Spec> {
  kind: "list";
  item: S;
  minItems: number;
  maxItems: number;
  /** Count is fixed by the device (some mice always have 4 stages). */
  fixedCount?: boolean;
}

/** A record of named fields, e.g. one DPI stage {x, y, color} or one EQ band. */
export interface RecordSpec { kind: "record"; fields: Readonly<Record<string, Spec>> }

/** A per-key / per-button / per-zone / per-band map over a target set. */
export interface MapSpec<S extends Spec = Spec> {
  kind: "map";
  over: TargetSet;                      // which keys, buttons, zones or bands
  value: S;
  /** The device has a global default and per-target overrides (Falchion, Wooting). */
  inheritsFrom?: SettingId;
}

export type Spec = NumberSpec | ChoiceSpec | ToggleSpec | ColorSpec | TextSpec | ListSpec | RecordSpec | MapSpec | ActionSpec;

export type TargetSet =
  | { kind: "keys"; layout: LayoutRef; only?: readonly KeyIndex[] }   // analog keys may be a subset
  | { kind: "buttons"; ids: readonly ButtonId[] }
  | { kind: "zones"; ids: readonly string[] }
  | { kind: "bands"; count: number };

export type Condition =
  | { setting: SettingId; equals: unknown }
  | { setting: SettingId; notEquals: unknown }
  | { connection: "wired" | "receiver" | "bluetooth" }
  | { receiverMaxHz: number }                       // 8K needs an 8K dongle (ATK, Razer HyperPolling)
  | { all: readonly Condition[] }
  | { any: readonly Condition[] };
```

### 3.2 Settings, values and provenance

```ts
export type SettingId = `${GroupId}.${string}`;     // "pointer.dpiStages", "analog.actuation", "eq.bands"
export type GroupId = "info" | "power" | "pointer" | "buttons" | "lighting" | "analog" | "keymap"
                    | "profiles" | "eq" | "headset" | "wireless";

export interface Setting<S extends Spec = Spec> {
  id: SettingId;
  label: string;
  help?: string;
  spec: S;
  /**
   * rw: read and written.  ro: shown only (battery, firmware).
   * wo: the device accepts writes but cannot report the value back (Razer lighting effects, Falchion
   *     actuation). The UI shows SYNQ's cached copy and says so.
   */
  access: "rw" | "ro" | "wo";
  /** Where the value lives. */
  scope: "device" | "profile" | "stage" | "key" | "button" | "zone" | "band" | "connection";
  /**
   * onboard: stored in the device's flash, survives power cycles and other PCs.
   * volatile: lost on power-off/sleep (some "live" modes).
   * host: only works while software runs (Logitech host mode, Synapse-only features). SYNQ runs
   *       nothing in the background, so `host` settings are hidden unless a driver opts in with a warning.
   */
  persistence: "onboard" | "volatile" | "host";
  /** immediate: takes effect on write. commit: needs a save command (Falchion `50 55`).
   *  reconnect: the device re-enumerates (polling changes on several keyboards). */
  apply: "immediate" | "commit" | "reconnect";
  when?: Condition;                 // shown/enabled only when this holds
  tier?: SupportTier;               // overrides the device tier for this one setting
  /** Physical risk beyond "wrong value" (e.g. gamepad mode changes the USB PID). Shown before writing. */
  caution?: string;
}

export interface Reading<T = unknown> {
  value: T | null;
  /** device: read now. cache: SYNQ's last confirmed write (wo settings, unreadable firmware).
   *  default: vendor default assumed. unknown: never read, never written. */
  source: "device" | "cache" | "default" | "unknown";
  at?: string;                      // ISO time of the read or write
}

export type Values = Readonly<Record<SettingId, Reading>>;
export interface Change { id: SettingId; target?: string | number; value: unknown }
```

### 3.3 Capability groups (the superset)

Each group is optional. A driver fills only what the device has. Typical ranges below are the
superset seen across [BRANDS.md](BRANDS.md); the driver supplies the real numbers.

```ts
export interface Capabilities {
  info: InfoGroup;
  power?: PowerGroup;
  pointer?: PointerGroup;
  buttons?: ButtonsGroup;
  lighting?: LightingGroup;
  analog?: AnalogGroup;
  keymap?: KeymapGroup;
  profiles?: ProfilesGroup;
  eq?: EqGroup;
  headset?: HeadsetGroup;
  wireless?: WirelessGroup;
}

// ---- device info (always present, read-only) ----
export interface InfoGroup {
  vendor: string;                   // "ATK", "Razer"
  model: string;                    // from the device where possible (HID++ name, CID/MID, product code)
  modelKey: string;                 // stable key into SupportRecord tables: "atk:cid1-mid61"
  kind: "mouse" | "keyboard" | "headset" | "dac" | "receiver" | "dock" | "light";
  /**
   * How the model was resolved. PID alone is often NOT enough: RY5088 (0x8F model id), Sonix (USB product
   * string), illumipc (0x0D product code), Compx (CID/MID), DrunkDeer (0xA0 type code), audio dongles
   * (product string + scheme), receivers (paired-device query: WLMouse 0x8B, VAXEE 0x0A, G-Wolves handshake).
   */
  identifiedBy: "pid" | "product-string" | "name-query" | "cid-mid" | "product-code" | "firmware-query"
              | "receiver-query" | "descriptor";
  firmware: readonly { part: string; version: string }[];   // mouse, receiver, sensor, MCU
  serial?: string;
  connection: { kind: "usb" | "receiver" | "bluetooth"; via?: string };  // via: receiver name
  driver: string;                   // DriverManifest.id
  image?: string;                   // render key, only for models we have art for
}

// ---- power / battery ----
export interface PowerGroup {
  battery?: Setting<NumberSpec>;              // ro, %, may be coarse (levels)
  charging?: Setting<ToggleSpec>;             // ro
  sleepTimeout?: Setting<NumberSpec>;         // s; typical 10 s .. 30 min, often a value set
  deepSleep?: Setting<NumberSpec>;
  lowBatteryWarning?: Setting<NumberSpec>;    // %
  powerMode?: Setting<ChoiceSpec>;            // e.g. "performance" | "endurance"
}

// ---- pointer (mice; also HE mouse buttons live under buttons) ----
export interface PointerGroup {
  dpiStages?: Setting<ListSpec<RecordSpec>>;  // item fields: x (cpi), y? (cpi), color?, lod? (Logitech per-stage)
                                              // typical: 1..8 stages (Logitech 5, Razer 5, ATK 8), 50..30000+ cpi,
                                              // step 1/10/50; scope "profile"
  activeStage?: Setting<NumberSpec>;          // index; "the starred step"
  separateXY?: Setting<ToggleSpec>;
  pollingWired?: Setting<NumberSpec>;         // values ⊆ [125,250,500,1000,2000,4000,8000]
  pollingWireless?: Setting<NumberSpec>;      // 4K/8K `when: { receiverMaxHz }`
  liftOff?: Setting<NumberSpec>;              // mm (ATK 0.7..1.7 step 0.1) or levels with labels (Logitech Low/Med/High)
  liftOffAsymmetric?: Setting<RecordSpec>;    // Razer: separate lift and landing distances
  surfaceCalibration?: ActionDescriptor;      // guarded action, not a setting
  motionSync?: Setting<ToggleSpec>;
  angleSnapping?: Setting<ToggleSpec | NumberSpec>;  // toggle on most; degrees where supported
  rippleControl?: Setting<ToggleSpec>;
  sensorMode?: Setting<ChoiceSpec>;           // ATK Basic/Competitive/MAX, "high performance", glass mode
  debounce?: Setting<NumberSpec>;             // ms, often a value set (ATK [0,1,2,4,8,15,20])
  sensorRotation?: Setting<NumberSpec>;       // deg, -30..30 where firmware has it
  scroll?: Setting<RecordSpec>;               // anti-mistouch ms, ratchet/free-spin, direction
}

// ---- buttons, macros, shift layer ----
export interface ButtonsGroup {
  buttons: readonly { id: ButtonId; label: string; where: "left" | "right" | "middle" | "side" | "top" | "bottom" | "wheel" }[];
  mapping?: Setting<MapSpec<ActionSpec>>;     // scope "profile"
  shiftLayer?: Setting<MapSpec<ActionSpec>>;  // HyperShift / Easy-Shift / G-Shift
  macros?: MacroCaps;
  magnetic?: AnalogButtonCaps;                // Hall-effect main buttons (Logitech 0x1B0C, some Chinese 8K mice)
}

export type ActionKind = "mouse" | "key" | "consumer" | "dpi" | "profile" | "macro" | "layer"
                       | "scroll" | "sniper" | "disabled" | "lighting" | "qmk" | "vendor";
export interface ActionSpec {
  kind: "action";
  allowed: readonly ActionKind[];             // what this device can bind
  /** Key action encoding: HID usage page 7 + modifiers, or QMK 16-bit keycodes (VIA/Vial). */
  keySpace: "hid" | "qmk";
}
export interface MacroCaps {
  slots: number;
  maxEventsPerMacro: number;
  maxBytesTotal?: number;
  delays: NumberSpec | null;                  // ms, null = fixed timing
  repeatModes: readonly ("once" | "whileHeld" | "toggle" | "count")[];
}

// ---- lighting (device RGB, and the Lighting tab's room lights) ----
export interface LightingGroup {
  /**
   * vendor: the device's own lighting commands (most drivers).
   * lampArray: HID LampArray (usage page 0x59), the standard behind Windows Dynamic Lighting; one driver for all.
   * network: room lights in the Lighting tab (Govee LAN/cloud/BLE, Hue bridge, Nanoleaf); kind "light".
   */
  source: "vendor" | "lampArray" | "network";
  transport?: "hid" | "lan" | "cloud" | "ble";
  /** SYNQ cannot read the current effect back (Razer, RK, SteelSeries): values are SYNQ's copy. */
  writeOnly?: boolean;
  /** Effects stored in flash: rate-limit writes (sharkfin's rule for RY5088 per-key paint). */
  flashBacked?: boolean;
  zones: readonly { id: string; label: string; leds: number; perLed: boolean }[];
  effect?: Setting<ChoiceSpec>;               // scope "zone" or "device"
  effectParams?: Readonly<Record<string, readonly EffectParam[]>>; // per effect: colors (0..n), speed, direction, width
  brightness?: Setting<NumberSpec>;           // %
  perKeyColor?: Setting<MapSpec<ColorSpec>>;  // keyboards with per-key RGB (static custom)
  idleOff?: Setting<NumberSpec>;              // s
  dpiIndicator?: Setting<ChoiceSpec>;
}
export type EffectParam =
  | { name: "colors"; count: number }
  | { name: "speed" | "direction" | "width"; spec: NumberSpec | ChoiceSpec };

// ---- analog keys (HE / magnetic / inductive / analog-optical keyboards) ----
export interface AnalogGroup {
  targets: TargetSet;                         // which keys are analog (all, or a subset)
  travel: { minMm: number; maxMm: number };   // total travel; may vary per switch type
  switchType?: Setting<MapSpec<ChoiceSpec>>;  // per-key switch model selects travel + curve (X68, Wooting)
  actuation: Setting<MapSpec<NumberSpec>>;    // mm, typical 0.1..4.0, step 0.1 / 0.05 / 0.01; inheritsFrom global
  release?: Setting<MapSpec<NumberSpec>>;     // separate release point (some firmwares)
  rapidTrigger?: {
    enabled: Setting<MapSpec<ToggleSpec>>;
    press: Setting<MapSpec<NumberSpec>>;      // mm, typical 0.01..2.0
    release?: Setting<MapSpec<NumberSpec>>;   // absent = symmetric
    continuous?: Setting<MapSpec<ToggleSpec>>;// RT stays active until fully released
  };
  deadzones?: { top: Setting<MapSpec<NumberSpec>>; bottom: Setting<MapSpec<NumberSpec>> };
  socd?: {
    pairs: Setting<ListSpec<RecordSpec>>;     // {a: KeyIndex, b: KeyIndex, mode}; max pairs from the device
    modes: ChoiceSpec;                        // superset seen: "last" | "neutral" | "priorityA" | "priorityB" | "first"
                                              // | "deeper" (Wooting Rappy Snappy, Keychron "deeper travel")
                                              // | "deeperSingle" (Keychron). Vendor names: Snap Tap, FlashTap,
                                              // Speed Tap, Rapid Tap, Last Win, Keyboard Priority, Dual Keypress Priority
    enabled?: Setting<ToggleSpec>;            // global switch (X68 `24 03`)
  };
  dks?: {                                     // dynamic keystroke: up to 4 actions × 4 travel points
    slots: number;
    points: 4;                                // press, bottom-out, release-from-bottom, full release
    pointSpec: NumberSpec;                    // mm for the configurable points
    stepKinds: readonly ("none" | "tap" | "hold" | "release")[];
  };
  modTap?: { slots: number; holdMs: NumberSpec };   // X68: hold time in 10 ms units, default 150 ms
  toggleKey?: { slots: number };
  gamepad?: Setting<ChoiceSpec>;              // analog-as-gamepad; may change the USB PID → caution
  liveDepth?: { stream: true; hz: number };   // input-report stream for the key-depth visualiser
  calibration?: ActionDescriptor;             // ALWAYS guarded, usually blocked
  highPrecision?: Setting<ToggleSpec>;        // switches step 0.1 → 0.01 mm where firmware has it
  /**
   * Where the travel unit came from. Writes are refused until it is known: a wrong unit writes values 10×
   * off (documented on DrunkDeer). Sources: RY5088 0xE6 (0.1/0.01/0.005/0.001 mm), ASUS manifest
   * `magKeyUnit` (0.1 vs 0.01), DrunkDeer firmware dialect, Keychron FULL_TRAVEL_UNIT.
   */
  unitSource: "device-query" | "manifest" | "firmware-dialect" | "fixed";
}
export interface AnalogButtonCaps {           // the same idea for HE mouse buttons
  actuation: Setting<MapSpec<NumberSpec>>;
  rapidTrigger?: Setting<MapSpec<NumberSpec>>;
  switchMode?: Setting<MapSpec<ChoiceSpec>>;  // "magnetic" | "optical"
}

// ---- keymap / layers ----
export interface KeymapGroup {
  layout: KeyboardLayout;
  layers: readonly { id: number; label: string; editable: boolean }[];   // Base, Fn, Fn2...
  keymap: Setting<MapSpec<ActionSpec>>;       // scope "key", per layer
  encoders?: Setting<MapSpec<ActionSpec>>;    // rotary knobs (cw, ccw, press) per layer
  combos?: { slots: number };                 // Vial
  tapDance?: { slots: number };               // Vial
  keyOverrides?: { slots: number };           // Vial
  qmkSettings?: readonly Setting[];           // Vial QMK settings (tapping term, etc.) as plain settings
  winLock?: Setting<ToggleSpec>;
}
export interface KeyboardLayout {
  source: "driver" | "via-definition" | "vial-firmware" | "vendor-json";
  /** KLE-style geometry; matrix index is what the protocol uses. */
  keys: readonly { index: KeyIndex; row: number; col: number; x: number; y: number; w: number; h: number;
                   r?: number; label: string; hidUsage?: number }[];
  /** Layout options (ISO enter, split backspace) when the definition has them. */
  options?: readonly { id: string; label: string; choices: readonly string[] }[];
}

// ---- onboard profiles ----
export interface ProfilesGroup {
  count: number;
  active: Setting<NumberSpec>;                // rw when the device can switch on command
  names?: Setting<MapSpec<TextSpec>>;
  /** What changes with the profile (settings whose scope is "profile"). Computed from settings. */
  switchingIsSafe: boolean;                   // false when switching clears state (illumipc v1 profiles)
}

// ---- audio EQ (software engine, device PEQ, headset EQ) ----
// Shape follows AutoEq's per-slot PEQ_CONFIGS (MIT); HeadsetControl's ParametricEqualizerInfo and devicePEQ's
// constraint profiles are subsets of it. Real devices need PER-SLOT limits (JDS: 2 LS + 8 PK + 2 HS; Qudelix:
// 2 shelves + 8 PK), gain ceilings (+3 / +6 dB), wire quantisation and a realisation model.
export interface EqGroup {
  engine: "eapo" | "device";
  topology: "flat" | "typed" | "graphic" | "presetOnly";
  /**
   * flat: `slotCount` identical slots, each may use any of `defaultSlot.kinds` (EAPO, FiiO, WalkPlay, Nova 5).
   * typed: `slots[i]` fixes the kind (and maybe freq/Q) per position (JDS Element IV, AutoEq 8_PEAKING_WITH_SHELVES).
   * graphic: fixed freqs (and Q), gain only (Arctis Nova 7/Pro: 10 bands ±10 step 0.5; Nova 3: 6 bands ±6).
   * presetOnly: the device can only switch presets (Audeze Maxwell via HeadsetControl).
   */
  slotCount: { min: number; max: number };    // EAPO 1..UI max; WalkPlay 5..10; FiiO K17/K19 31
  defaultSlot: EqSlotSpec;
  slots?: readonly EqSlotSpec[];              // typed/graphic topologies
  preamp:
    | { mode: "host"; spec: NumberSpec }      // a global-gain register SYNQ writes (WalkPlay, FiiO, Qudelix, JDS)
    | { mode: "device" }                      // device attenuates on its own (KT Micro, FreeDSP Pro, Moonriver 3)
    | { mode: "none" };                       // headsets: fit must keep net boost ≤ 0 dB by shifting the curve
  /** Wire encodings, so fitting can quantise BEFORE scoring the error. */
  quantization: {
    gainStepDb: number;                       // 0.1 FiiO/Nova 3P, 0.5 Nova 5/7, 1 A50, 1/256 WalkPlay
    qEncoding: "x100" | "x256" | "x1000" | "x1024" | "bandwidth4096" | "float";
    freq: "intHz" | "float" | "table";
  };
  disabledSlot?: { encoding: "gain0" | "freq" | "type"; value?: number };   // Nova: freq 20001
  presets?: { builtIn: readonly { id: number; name: string }[]; userSlots: readonly number[]; bypassId?: number };
                                              // FiiO USER1..10 = 160..169, bypass 240; WalkPlay "Custom" 101
  readback: boolean;                          // false: Conexant FreeDSP, EarFun (show SYNQ's copy)
  commit: "auto" | "explicit";                // explicit: separate flash-commit command; only on Save (wear)
  persistence: "onboard" | "volatile" | "host";  // EAPO: "host" (a system APO, always on)
  transport: "eapo" | "hid" | "serial" | "spp" | "ble" | "http";
  sampleRateHz?: number;                      // design rate used for host-computed biquads (WalkPlay)
  /** Measured deviation from the RBJ ideal (devicePEQ compensation.js): freq scale, Q law, shelf Q↔slope. */
  realization?: { freqScale?: number; qLaw?: "cosine" | "gainDependent"; shelfModel?: "q" | "slope" };
  discoverable: boolean;                      // true: device reports its own limits (JDS Describe, G PRO X 2)
}
export interface EqSlotSpec {
  kinds: readonly FilterKind[];               // PK, LSC, HSC, LPQ, HPQ, NO (src/lib/eq.ts names)
  freq: NumberSpec | { fixed: number };       // Hz, log; WalkPlay 20..20000 int; A50 80..15000
  q: NumberSpec | { fixed: number };          // AutoEq graphic 10-band: fixed sqrt(2)
  gain: NumberSpec & { ceilingDb?: number };  // ±10/±12/±15/−24..+12; ceiling +3 (Moondrop Old Fashioned)
}

// ---- headset extras ----
export interface HeadsetGroup {
  sidetone?: Setting<NumberSpec>;
  micGain?: Setting<NumberSpec>;
  noiseGate?: Setting<ToggleSpec | NumberSpec>;
  anc?: Setting<ChoiceSpec>;                  // off / ANC / transparency
  chatMix?: Setting<NumberSpec>;
  autoOff?: Setting<NumberSpec>;              // min
  voicePrompts?: Setting<ToggleSpec>;
}

// ---- wireless ----
export interface WirelessGroup {
  receiverFirmware?: string;
  linkQuality?: Setting<NumberSpec>;          // ro
  pairing?: ActionDescriptor;                 // guarded; default blocked (an unpaired mouse needs the vendor tool)
}

export interface ActionDescriptor {
  id: string;
  label: string;
  risk: "low" | "high" | "blocked";           // blocked = listed so the UI can explain, never runnable
  confirm: string;                            // the sentence the user must confirm
}
```

### 3.4 Drivers and sessions

```ts
export interface HidMatch { vendorId: number; productId?: number; usagePage?: number; usage?: number }

export interface DriverManifest {
  id: string;                                 // "atk-compx", "razer-v4", "via", "illumipc", "eapo"
  name: string;
  brands: readonly string[];
  kinds: readonly InfoGroup["kind"][];
  /** Devices this driver may claim. Several drivers can share a VID (0x258a, 0x373e, 0x3554, 0x2e3c):
   *  `probe` decides, using only read commands. */
  match: readonly HidMatch[];
  /** Filters passed to navigator.hid.requestDevice(); may differ from `match` (Razer needs page 0x01 and 0x0c).
   *  Never VID-only: VIDs are shared (093A Pixart, 1915 Nordic, 258A SinoWealth, 3554/373E Compx, 0C45 Sonix). */
  requestFilters: readonly HIDDeviceFilter[];
  /** The configuration channel(s); web availability is DERIVED from these plus the platform (§3.6). */
  channels: readonly ChannelShape[];
  /** Hand-recorded exceptions, first match wins (e.g. Razer on Windows Chromium >= 153). */
  webRules?: readonly WebRule[];
  /** Identities this driver must refuse to open: bootloader / upgrader / DFU PIDs (BRANDS §7). */
  neverOpen: readonly HidMatch[];
  /** Vendor suites that hold or race the device; warn (never kill) when running. */
  conflictingApps?: readonly string[];        // process-name substrings: "razerappengine", "lghub", "icue"…
  provenance: readonly { kind: "configurator-js" | "capture" | "open-source" | "vendor-doc"; ref: string; license?: string }[];
  guard: CommandGuard;
  support: readonly SupportRecord[];
  probe(devices: readonly HidLike[]): Promise<ProbeResult | null>;
  open(devices: readonly HidLike[], probe: ProbeResult, ctx: DriverContext): Promise<DeviceSession>;
}

export interface ProbeResult { modelKey: string; model: string; firmware?: string; collections: readonly HidLike[] }

export interface DriverContext {
  cache: SettingsCache;                       // per serial/modelKey, SYNQ's confirmed-write copy
  backups: BackupStore;
  log: HidLog;                                // every frame in/out, for "Save diagnostics"
  allowWrites: () => boolean;                 // the user's "Allow changes" switch for experimental tiers
}

export interface DeviceSession {
  readonly capabilities: Capabilities;        // may be refined after the first read (e.g. 8K only wired)
  readonly support: EffectiveSupport;
  read(groups?: readonly GroupId[]): Promise<Values>;
  /** Pure: turns UI changes into labelled steps, flags reconnects and cautions. Nothing is sent. */
  plan(changes: readonly Change[]): Promise<WritePlan>;
  /** Sends the plan, reads back what the device can report, updates the cache only on confirmation. */
  apply(plan: WritePlan, opts?: { verify?: boolean }): Promise<ApplyResult>;
  run(action: string, args?: unknown): Promise<string>;   // guarded actions (surface calibration)
  subscribe(listener: (e: SessionEvent) => void): () => void;  // battery, active stage, live depth, link
  backup(): Promise<Snapshot>;
  restore(snapshot: Snapshot): Promise<ApplyResult>;
  diagnostics(): Promise<DiagnosticsBundle>;  // descriptor dump + HID log + reads, no writes
  close(): Promise<void>;
}

export interface WritePlan {
  steps: readonly { label: string; reports: readonly OutgoingReport[] }[];
  reconnects: boolean;
  cautions: readonly string[];
  tier: SupportTier;                          // lowest tier among the touched settings
}

export interface CommandGuard {
  /** Every outgoing report passes here; the desktop bridge applies the same table in Rust. */
  classify(report: OutgoingReport): { verdict: "read" | "write" | "blocked"; reason?: string };
  /** Documented blocks, shown in the device's "What SYNQ never sends" panel. */
  blocked: readonly { what: string; why: "firmware" | "bootloader" | "factory-reset" | "calibration" | "pairing" | "profile-wipe" | "unknown" }[];
}
export interface OutgoingReport { type: "output" | "feature"; reportId: number; data: Uint8Array }
```

### 3.5 Support tiers

```ts
export type SupportTier =
  | "verified"      // written AND read back on real hardware by a maintainer; model + firmware recorded
  | "community"     // ≥1 owner ran it and sent a SYNQ diagnostics bundle (same model, firmware in range)
  | "experimental"  // built from configurator JS, captures or open source; never confirmed on hardware
  | "readOnly"      // identification and reads only; write controls render disabled with the reason
  | "detectOnly";   // recognised by VID/PID only: name, vendor tool link, on-device button guide (Zowie)

export interface SupportRecord {
  modelKey: string;                           // "logitech:pro-x-2-dex", "atk:cid1-mid61"
  firmware?: string;                          // exact version or range ("5.20", ">=5.0 <6")
  connection?: "usb" | "receiver" | "bluetooth";
  tier: SupportTier;
  settings?: Readonly<Partial<Record<SettingId, SupportTier>>>;   // per-setting overrides
  evidence: readonly {
    kind: "hardware" | "community-report" | "capture" | "configurator-js" | "open-source";
    ref: string;                              // file in docs/, issue URL, diagnostics bundle id
    date: string;
    who?: string;
  }[];
}

export interface EffectiveSupport {
  tier: SupportTier;                          // for the device as connected (model + firmware + connection)
  perSetting: Readonly<Record<SettingId, SupportTier>>;
  why: string;                                // "ATK X1 V2 Air+ fw 5.20 verified 2026-10-12; 8K experimental"
}
```

Rules (enforced in `DeviceSession`, not in the UI):

| Tier | Reads | Writes | UI |
|---|---|---|---|
| verified | yes | yes | normal controls |
| community | yes | yes | normal controls, small "community-tested" badge with the report link |
| experimental | yes | only while the per-device "Allow changes" switch is on; backup taken first; read-back required where the device can report | amber badge, switch off by default (as the X68 panel does now) |
| readOnly | yes | never (plan() throws) | values shown, controls disabled, reason shown |
| detectOnly | no protocol | never | device card, vendor-tool link, button-combo guide |

- The effective tier of a setting is the lowest of: the model's tier, the setting override, and the
  firmware match (an unknown firmware drops `verified`/`community` to `experimental`).
- A new firmware version never inherits `verified` automatically.
- Settings with `access: "wo"` can still be `verified` (the write was confirmed by behaviour), but the
  UI always labels their value as "SYNQ's saved copy".
- Promotion path: experimental → community (diagnostics bundle from an owner + a read-back match) →
  verified (maintainer hardware). Evidence entries are the audit trail.

### 3.6 Platform availability (derived, not declared)

Research finding (BRANDS.md §6): web availability is **not a static per-driver fact**. It depends on:
- the OS;
- the Chromium version (Windows Chrome 153 changed it);
- the shape of the collection on that device and firmware.

So the driver describes its channel, and the core derives a verdict.

```ts
export interface ChannelShape {
  transport: "hid" | "serial" | "ble" | "http" | "lan" | "eapo";
  tlc?: { usagePage: number; usage: number };  // top-level collection carrying the protocol
  reportType?: "input" | "output" | "feature";
  reportId?: number;
  declared?: boolean;                          // report declared in that TLC (Razer's 90-byte report 0 is not)
  windowsSubCollection?: boolean;              // lives on a &colNN path Chrome doesn't surface (Attack Shark 1D57)
}
export type WebVerdict = "ok" | "needsBridge" | "no";
export interface WebRule {
  os?: "windows" | "macos" | "linux" | "chromeos" | "android";
  chromium?: string;                           // semver range on the Chromium major, e.g. ">=153"
  verdict: WebVerdict;
  reason: string;                              // shown to the user
  evidence: string;                            // issue URL / notes / diagnostics bundle
}
```

**Derivation** (Chromium `IsAlwaysProtected`, unchanged from 152 to main):

| Channel | Web verdict | Desktop bridge |
|---|---|---|
| Vendor `FF00–FFFF`, Consumer `0x0C`, Generic Desktop usage 0, LampArray `0x59` | ok | ok |
| Generic Desktop Mouse/Keyboard/Pointer/Keypad + **declared feature** report | ok (macOS: the browser needs Input Monitoring) | ok (zero-access handle on Windows) |
| Same, feature report **undeclared**, the only TLC on the interface (Razer) | **needsBridge on Windows Chromium ≥ 153** | ok |
| Generic Desktop Mouse/Keyboard + input or output report | needsBridge | Windows: **no** (the OS owns it) |
| Keyboard page `0x07`, System Control `0x80–0x8F` (legacy RK), System Dock, FIDO | **no** | feature ok; input/output no on Windows |
| `windowsSubCollection` | needsBridge on Windows | ok (open the `&colNN` path) |
| Chromium blocklist hit (Jabra `0B0E` `FF00` output report 5; Finch can add rules) | no | ok |
| `serial` | ok via Web Serial (JDS Labs) | serial crate |
| `eapo` | no | ok |

**Runtime behaviour:**
- `webRules` override the derivation; first match wins.
- After the user picks a device, **probe**. If the expected collection is missing, or the first read fails, switch the card to "use the SYNQ desktop app" and record it in diagnostics. A firmware or descriptor change can flip a device either way.
- The website pre-filters its chooser so `needsBridge`/`no` devices are never offered. It calls `requestDevice` **once per click** (Chrome 153 consumes the activation).
- It detects missing `navigator.hid` (Firefox, Safari) and `DefaultWebHidGuardSetting = 2`.
- Optional later: the desktop app exposes a loopback HID bridge (origin allowlist, the same Rust guard), so the website can reach bridge-only devices.

### 3.7 Feel profile ("Keep your feel", ROADMAP Wave 5)

```ts
/** A brand-neutral description of how a mouse feels, read from one mouse and applied to another. */
export interface FeelProfile {
  cpi: { x: number; y?: number };              // effective counts per inch of the active stage
  measuredCpiFactor?: number;                  // user calibration: real/nominal (sensors deviate from nominal)
  pollingHz: number;
  liftOffMm?: number;                          // levels converted to mm where the driver knows the map
  angleSnapping?: boolean;
  motionSync?: boolean;
  rippleControl?: boolean;
  debounceMs?: number;
  windows?: { pointerSpeed: number; enhancePointerPrecision: boolean };   // desktop only; warn if EPP on
  games?: Readonly<Record<string, { sens: number; cmPer360: number }>>;   // per-game, via a yaw-constant table
}
/** Planning a transfer is a pure function over Capabilities; the result is reviewed before any write. */
export interface FeelTransferPlan {
  changes: readonly Change[];
  unmatched: readonly { setting: SettingId; wanted: unknown; nearest?: unknown; why: string }[];
}
```

**Rules:**
- Pick the nearest legal value. Never silently drop a setting: list it in `unmatched`.
- Convert sensitivity as `cm/360 = 360 / (sens × yaw × cpi) × 2.54`.
- The per-game yaw constants are data with sources (still to be collected; ROADMAP Wave 5).

## 4. UI generation rules

| Spec | Control |
|---|---|
| NumberSpec with `values` ≤ 7 | segmented buttons (polling, debounce) |
| NumberSpec range | slider + number field (existing `fader` / `number-field`), log slider when `log` |
| ChoiceSpec ≤ 5 | segmented; more → select |
| ToggleSpec | switch |
| ListSpec of RecordSpec (DPI stages) | stage editor with add/remove up to `maxItems`, star for `activeStage` |
| MapSpec over keys | keyboard layout with multi-select, value panel for the selection, "inherits global" shown dimmed |
| MapSpec over bands | EQ graph + band strips (existing EqPage) driven by `EqGroup` limits |
| ActionSpec | action picker filtered by `allowed`, key picker by `keySpace` |
| ActionDescriptor risk high | button behind a typed confirmation; risk blocked → listed in "What SYNQ never sends" |

Groups render as pages/cards in a fixed order: info, power, pointer, buttons, lighting, analog, keymap,
profiles, eq, headset, wireless. A group with no settings is not rendered.

## 5. How today's drivers map

| Today | Capability groups | Notes |
|---|---|---|
| Logitech HID++ (`mouse.ts`) | info, power, pointer (dpiStages with per-stage LOD, activeStage, pollingWired/Wireless, liftOff levels), profiles | DPI stages persistence `onboard` (format 7 profile); live `setDpi` would be `host` and stays hidden |
| ATK (`atk-mouse.ts`) | info (identifiedBy cid-mid), power, pointer (stages ≤8, polling with receiverMaxHz, liftOff 0.7–1.7 mm, motionSync, angleSnapping, ripple, debounce set, sensorMode) | 8K, ripple, debounce: setting-level `experimental`; rest `verified` (2026-10-12) |
| Falchion Ace HFX (`keyboard.ts`) | analog (actuation/RT/deadzones, `access: "wo"`), keymap remaps, lighting, pollingWired as `apply: "reconnect"` | values come from cache: the keyboard reports only profile, effect, RT and Speed Tap switches |
| X68 HE (`x68he.ts`) | analog (switchType, actuation, RT, deadzones, SOCD with global switch, DKS, mod-tap, highPrecision), keymap (base + Fn), lighting, profiles (`switchingIsSafe: false` on v1) | whole device `experimental` until the friend's diagnostics arrive |
| Equalizer APO (`eq.ts`) | eq (engine "eapo", topology "flat", slotCount 1..max, kinds PK/LSC/HSC/LPQ/HPQ/NO, preamp host, quantization float, transport "eapo") | the net-peak ≤ 0 dB gate stays an engine rule, not a capability |

### 5.0 Controllers (waves C0 / C1, 2026-10-15)

The controller groups of CONTROLLERS.md §7 as they ship today. Settings groups (curves, deadzones, remaps written to
a pad) start with wave C2 (the DualSense Edge's profiles, GameSir's HID pads; experimental, behind Allow changes, a
backup first, every write read back); C1 is the tester and the volatile tests.

| Piece | Where | What it is |
|---|---|---|
| Ids and models | `src/lib/controllers/models.ts`, `ids.generated.ts`, `src-tauri/src/controller_ids.rs` (scripts/gen-controller-ids.ts from SDL `usb_ids.h` + `controller_list.h`, xpad facts, models.ts) | 760 ids: kind (SDL controller type), transport `hid` / `xusb` / `gip` / `usb`, name; models add personalities, configurator, on-device guide, caps; boot and recovery ids (8BitDo boot/RR, RP2040/RP2350) refused everywhere |
| Identification | `identify.ts` | the PID gives the candidates; the product string, the collections and the path (HID, XInput slot, Gamepad API) confirm; a product string naming another maker drops the model (read only). XInput slots that report Windows' own id (045E:02FF) are matched to the one present USB pad of their class (cfgmgr32 device list) |
| Bridge rule | `src-tauri/src/pads.rs` (+ hid.rs, hid_plan.rs, web policy.ts / guard.ts, the helper) | separate from mice/keyboards: Gamepad 0x05 / Joystick 0x04 (and Valve's 0xFF00:0x0001) of table ids only, input only; Sony and Nintendo `Full` with every report checked; never Mouse 0x02, Keyboard 0x06, page 0x07; XInput pads never opened as HID; Linux routes per report id |
| Guard families | `guard.ts` / `pads.rs`, fixtures `pad-frames.txt` | `ds5`, `ds4`: one volatile effect per output report (USB / Bluetooth with CRC32), feature GET calibration + firmware only; `switch`: subcommands 0x02, 0x03 (0x30/0x3F), 0x10 (calibration SPI ranges), 0x30, 0x38, 0x40, 0x48, the two 0x10 rumble frames, USB 0x80 0x01–0x05; `edge`: the DualSense's plus profile reads 0x70–0x7B and custom-slot writes 0x60–0x62 / deletes 0x68 (C2); `gamesir-cyclone2` / `-g7pro8k` / `-tarantula`: the config channel (0x0F) on page 0xFFF0, register writes only into the fields of the model's map with allowed values (C2); `scuf`: BRAGI 1.0 GETs of identity, firmware, battery and the connected-pad bitmap on 0xFF42:0x0001 (C2, read only); `input`: nothing |
| Groups shown | Devices home caps | `sticks`, `triggers`, `haptics` (volatile rumble test), `motion`, `link`, `live` (the tester) |
| `live` (tester) | `link.ts`, `analysis.ts` | sources `hid` (per-report times from the bridge), `xinput` (per-change, sampler), `gamepad` (Gamepad API, ≈250 Hz); drift, circularity (72 bins), deadzones, resolution, trigger range / bits, chatter, gyro bias, polling (Gamepadla's method) |
| Tiers | `TierBadge` | `experimental` for Sony / Nintendo (their tests are sent on a click only and don't stay on the pad), `read-only` for tester-only pads, `read-only` + "named only" for detect-only (Switch 2) |
| Diagnostics | `diagnostics.ts` | descriptor (collections), 3 s of input reports, the allowlisted reads, firmware; Bluetooth addresses dropped in the parsers, Switch replies redacted, MAC-shaped text masked |
| Conflicts | `src-tauri/src/conflicts.rs` | Xbox Accessories, iCUE, Synapse, GameSir Nexus, DSX, DS4Windows, Steam: a warning on the controller's page; process names read only |

### 5.0b Lamps (wave L1, 2026-10-16)

LIGHTING.md has the protocol and what still needs the developer. A lamp is a device kind of its own (`light`): it is found
by a Bluetooth scan, not the USB list, and connected only while its page is open.

| Piece | Where | What it is |
|---|---|---|
| Models | `scripts/lighting/govee/models.json` → `models.generated.ts` / `catalogue.rs` (`src/lib/lighting/govee/spec.ts`) | the SKUs SYNQ lists and opens (81 Govee models in L2): name, kind, colour dialects, segments, white range, brightness scale, music modes, DIY, what is proven |
| Bridge rule | `src-tauri/src/lighting/govee/guard.rs` (+ `frames.ts` mirror, fixture `frames.txt`) | power, brightness, colour / white / segment colours and brightness, gradual change, catalogue scenes, the lamp's music modes, DIY slots, a few queries; uploads = a catalogue scene's own data or a DIY effect's shape; everything else refused |
| Groups shown | Devices home caps | `colour` (colour and white), `segments`, `scenes`, `music` |
| Live state | `lamp.ts` `LampController` | optimistic view, writes coalesced per kind (about 14 a second, last value wins), checked by queries 0.9 s after a burst |
| Group | `lamp.ts` `LampGroup` ("All lamps") | every change to each lamp that answered; the view is the first lamp's |
| Kept | `saved.ts` (`lighting.json`) | saved and recent colours, saved gradients, DIY effects |
| Screen sync | `src-tauri/src/lighting/screen.rs`, `govee/stream.rs` | the bridge reads thin screen strips and sends the segment pages that moved; holds the lamp open without its page until stopped (the only exception to the focus backstop) |
| Tier | `TierBadge` | `experimental` until the developer session confirms the UNVERIFIED frames |

### 5.1 How research families map (examples)

| Family (BRANDS §2) | Notable capability use |
|---|---|
| RY5088 keyboards | `identifiedBy: "firmware-query"` (0x8F); `analog.unitSource: "device-query"` (0xE6); lighting `flashBacked` |
| Sonix VTER keyboards | `identifiedBy: "product-string"` (PIDs shared); calibration guarded (0x64/0x65) |
| RK BeiYing | keymap and lighting `access: "wo"` (write-only); two channels: `FF00` (web ok) and System Control (web **no**) |
| ASUS HE keyboards | analog step from manifest `magKeyUnit` (`unitSource: "manifest"`); `neverOpen` = bootloader PIDs / `hidPattern 3` |
| Wooting | `match` by `pid & ~3` (gamepad alt PIDs); gamepad mode carries a `caution` (changes the PID) |
| Razer mice | channel = Generic Desktop Mouse TLC, feature report 0, `declared: false` → needsBridge on Windows Chromium ≥ 153 |
| Glorious / SteelSeries mice | most settings `access: "wo"`; SteelSeries `apply: "commit"` (save command), 50 ms pacing in the driver |
| Lamzu / G-Wolves / Finalmouse | `buttons.magnetic` (HE/TMR main buttons) with guarded calibration |
| WalkPlay dongles | eq topology "flat", 8–10 slots, scheme 11 kinds exclude HSC; `realization.freqScale` ≈ 0.976 |
| Arctis Nova 7 | eq topology "graphic", 10 fixed bands, gain ±10 step 0.5, presets 4, preamp none |
| JDS Element IV | eq topology "typed" (2 LS + 8 PK + 2 HS), transport "serial", `discoverable: true` |

### 5.2 checkup, pro loadouts, headsets, AutoEq, monitors, webcams, PC lighting (2026-10-16)

| Piece | Where | Tier and writes |
|---|---|---|
| Gear checkup (Gear Doctor) | `src/lib/checkup` (thresholds in `thresholds.ts`), `src/components/checkup`, mouse timings `src-tauri/src/rawmouse.rs` | Reads only (Raw Input mice, the window's key events, the pad tester, the EQ config). Fix it = an existing setting (debounce, polling, rapid trigger) resolved on the device's page and run through its own session; disabled when the tier is read-only; Undo |
| Pro loadouts | `src/lib/pros` (41 pros, source + date each), `src/components/feel/ProPicker.tsx` | Through the mouse's own session (Keep your feel math); Undo; no game files |
| Gaming headsets | `src/lib/headsets` (HeadsetControl, GPL-3.0), `src-tauri/src/headsets.rs`, brand channels in `brands.rs` | Experimental: reads free; settings behind Allow changes, backup first, read back where the headset can (HyperX auto-off). Allowlist = every frame SYNQ builds, mirrored in Rust, `headset-frames.txt` |
| AutoEq presets | `src/lib/audio/autoeq.ts`, `src/components/eq/AutoEqFinder.tsx` | Fetched on request only; saved through the existing preset format; "Use it now" = the EQ page's own load (backup first) |
| Monitors (DDC/CI) | `src-tauri/src/monitors.rs`, `src/lib/displays/vcp.*` | Experimental: allowlist in `vcp.json` (shared), read back; input with confirmation and a 15 s switch-back; never 0x04-family, 0xD6, 0xE0-0xFF |
| Webcams (UVC) | `src-tauri/src/webcams.rs`, `src/lib/displays/uvc.*` | Experimental: allowlist in `uvc.json` (shared), range and step checked, read back; preview only on request, on its page |
| Dynamic Lighting (LampArray, wave L4) | `src-tauri/src/lighting/lamparray.rs`, `src/lib/lighting/lamparray.ts`, `src/components/lighting/LampArrayPage.tsx` | Experimental: one colour or an effect, only while SYNQ is in front (Windows' rule; a background controller must be a packaged app). No allowlist needed beyond colours: nothing else is sent |
| USB RGB hubs (wave L4) | `src/lib/lighting/hidrgb` (OpenRGB's notes, GPL-2.0), `src-tauri/src/lighting/hidrgb.rs` | Experimental: NZXT HUE 2 family, Corsair Lighting Node family, Lian Li Uni Hub SL; one static colour per channel behind Allow changes, a backup of what the hub reports first; Put back = the colour sent before the last (the hubs can't report their effect). Allowlist mirrored in Rust, `rgb-frames.txt`. The Corsair Nautilus LCD Cap (`1B1C:0C57`) is named, read-only |
