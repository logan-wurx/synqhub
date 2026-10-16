// The contract between keyboard drivers and SYNQ's generic Keyboard panel
// (src/components/keyboard/GenericKeyboard.tsx). It follows docs/devices/CAPABILITIES.md, cut down
// to what keyboards need now. Keep it stable: several drivers plug in here.
//
//   driver (KbDriver)      claims a HID device with no I/O, opens a backend, pings cheaply
//   backend (KbBackend)    reads everything into a KbState, plans each KbChange as send + read-back
//   session (KbSession)    src/lib/kb/session.ts: tiers and "Allow changes", a backup before the first
//                          write, the read-back verdict after every write, the log. Drivers never
//                          implement any of that themselves.
//   panel                  renders a KbView (state + tier + locks), sends KbChange, nothing else.
//
// Drivers so far: @openmouse/keyboard-protocol (src/lib/kb/openmouse), VIA / Vial (src/lib/kb/via).
// Wave 2 adds FCC Sonix HE boards (src/lib/kb/fcc) and AnalogSense analog read (src/lib/kb/analogsense):
// a read-only driver simply plans nothing (plan() throws) and leaves `writable` lists empty.
//
// Units are the human ones (mm, Hz); drivers convert to device units inside. Pure types and a few
// tiny helpers: no device access, no Tauri, no React.
import type { AdvancedPanel } from "../advanced/types.ts";

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/** WebHID's HIDDevice (the desktop bridge's navigator.hid shim and Chrome both provide it). */
export type HidLike = HIDDevice;

/**
 * The panel's three tiers. docs/devices/CAPABILITIES.md's five map onto them: verified = verified,
 * community = driver-tested, experimental and readOnly = read-only (experimental can be unlocked with
 * "Allow changes"; a readOnly driver simply plans nothing), detectOnly = no KbBackend at all.
 *
 * verified: written and read back on this exact model with SYNQ (only the Falchion, which keeps
 *   its own panel, so generic drivers never claim it).
 * driver-tested: the driver's authors tested these settings on hardware; SYNQ hasn't.
 * read-only: shown, not written, until the person turns on "Allow changes".
 */
export type KbTier = "verified" | "driver-tested" | "read-only" | "experimental";

/** Where a written value lives afterwards. */
export type KbPersistence = "saved" | "volatile" | "unknown";

/** Where a shown value came from. */
export type Provenance = "device" | "cache" | "default" | "unknown";

/** confirmed: read back and equal. mismatch: read back and different. unconfirmed: the device can't report it. */
export type Verdict = "confirmed" | "mismatch" | "unconfirmed";

export interface NumberSpec {
  min: number;
  max: number;
  step: number;
  unit: "mm" | "hz" | "%" | "ms" | "s" | "level" | "none";
  decimals?: number;
}

export interface ChoiceSpec {
  options: readonly { value: number; label: string }[];
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

/**
 * A key's id in this driver's protocol: VIA uses `row * cols + col`, OpenMouse keyboards their own
 * key index. The panel treats it as opaque.
 */
export type KeyIndex = number;

/** One key in key units (1 = a standard key), KLE-style. */
export interface KbKey {
  index: KeyIndex;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rotation in degrees about (rx, ry), as in KLE. */
  r?: number;
  rx?: number;
  ry?: number;
  /** Matrix position, when the protocol has one. */
  row?: number;
  col?: number;
  /** Printed legend when the driver knows it; otherwise the panel labels from the keymap. */
  label?: string;
  /** A decorative key with no switch (KLE "d"). */
  decal?: boolean;
}

export interface KbLayout {
  /**
   * driver: the protocol carries geometry. via-definition: the-via/keyboards definition.
   * vial-firmware: the definition the keyboard holds. matrix: no geometry known, keys drawn by
   * matrix row and column.
   */
  source: "driver" | "via-definition" | "vial-firmware" | "matrix";
  width: number;
  height: number;
  keys: readonly KbKey[];
  /** One line for the panel ("Layout from usevia.app, cached on this PC"). */
  note?: string;
}

// ---------------------------------------------------------------------------------------------
// Capability groups. Each is optional: a driver fills only what the keyboard has.
// ---------------------------------------------------------------------------------------------

export interface InfoState {
  brand: string;
  model: string;
  /** Driver id, e.g. "via", "vial", "omkb:wooting". */
  driver: string;
  /** Human-readable protocol line: "VIA protocol 12", "Vial 6 · VIA 9". */
  protocol?: string;
  firmware: readonly string[];
  serial?: string | null;
  connection: string;
  /** Extra rows for the device card. */
  extra?: readonly (readonly [string, string])[];
}

/** Analog (Hall-effect, magnetic, optical-analog) key settings, in mm. */
export interface AnalogValues {
  actuationMm?: number | null;
  releaseMm?: number | null;
  rapidTrigger?: boolean | null;
  rtPressMm?: number | null;
  rtReleaseMm?: number | null;
  deadTopMm?: number | null;
  deadBottomMm?: number | null;
}
export type AnalogField = keyof AnalogValues;

export interface AnalogState {
  /** global: one value for the whole board. per-key: every key its own. both: a global default with per-key overrides. */
  scope: "global" | "per-key" | "both";
  /** Keys that are analog (all keys when absent). */
  keys?: readonly KeyIndex[];
  /** Where the analog keys are, for a board with no keymap to draw them from. */
  layout?: KbLayout;
  travelMm?: number;
  /** What exists and its range; "toggle" for on/off fields. */
  fields: Readonly<Partial<Record<AnalogField, NumberSpec | "toggle">>>;
  /** Fields the driver can change. */
  writable: readonly AnalogField[];
  global: AnalogValues | null;
  perKey: Readonly<Record<KeyIndex, AnalogValues>>;
  source: Provenance;
  /**
   * Where the travel unit came from (docs/devices/CAPABILITIES.md AnalogGroup.unitSource). A driver
   * leaves `writable` empty until it is known: a wrong unit writes values 10x off.
   */
  unitSource?: "device-query" | "manifest" | "firmware-dialect" | "fixed";
  /** The board can stream key depth (AnalogSense's live view); started only while that view is visible. */
  liveDepth?: { hz?: number };
  note?: string;
}

export interface KeymapState {
  layout: KbLayout;
  layers: number;
  /** codes[layer][key], or null for a layer not read. */
  codes: readonly (Readonly<Record<KeyIndex, number>> | null)[];
  keySpace: "qmk" | "hid" | "vendor";
  /** A short keycap label for a code ("A", "MO1", "Vol +"). Optional: the panel shows the code in hex without it. */
  label?: (code: number) => string;
  /** Codes the picker offers; empty when keys can't be changed. */
  assignable: readonly { code: number; label: string; group: string }[];
  writable: boolean;
  source: Provenance;
  note?: string;
}

export type LightingValue = number | readonly [number, number];

export interface LightingSetting {
  id: string;
  label: string;
  kind: "range" | "choice" | "color" | "toggle";
  spec?: NumberSpec;
  choice?: ChoiceSpec;
  /** range/choice/toggle: a number (toggle 0/1). color: [hue, saturation], 0..255 each. */
  value: LightingValue | null;
  writable: boolean;
}

export interface LightingState {
  groups: readonly { id: string; label: string; settings: readonly LightingSetting[] }[];
  source: Provenance;
  note?: string;
}

export interface PollingState {
  hz: number | null;
  options: readonly number[];
  writable: boolean;
  note?: string;
}

export interface ProfilesState {
  active: number | null;
  count: number | null;
  names: readonly (string | null)[];
  writable: boolean;
  note?: string;
}

/** Anything else the keyboard has: Win/Mac mode, sleep time, debounce... */
export interface KbOption {
  id: string;
  label: string;
  hint?: string;
  kind: "range" | "choice" | "toggle";
  spec?: NumberSpec;
  choice?: ChoiceSpec;
  value: number | null;
  writable: boolean;
}

/** SOCD resolution for a pair of keys. "last" (last input wins) is snap tap; "deeper" is Wooting's analog "deeper wins". */
export type SocdMode = "last" | "neutral" | "priorityA" | "priorityB" | "first" | "deeper" | "deeperSingle";

/** What a DKS action does at each of the four points: press, bottom-out, release from bottom, full release. */
export type DksStep = "none" | "tap" | "hold" | "release";
export interface DksBinding {
  /** A code in the keymap's key space. */
  code: number;
  steps: readonly [DksStep, DksStep, DksStep, DksStep];
}

/** Advanced keys: SOCD / snap tap pairs, dynamic keystroke, mod-tap. */
export interface AdvancedState {
  socd?: { modes: readonly SocdMode[]; pairs: readonly { keys: readonly [KeyIndex, KeyIndex]; mode: SocdMode }[]; maxPairs?: number };
  dks?: { slots: number; keys: readonly KeyIndex[]; bindingsPerKey: number; points?: NumberSpec };
  modTap?: { keys: readonly KeyIndex[]; holdMs: NumberSpec };
  /** Which of them the driver can change. */
  writable: readonly ("socd" | "dks" | "modTap")[];
  note?: string;
}

export interface MacrosState {
  count: number;
  bufferBytes: number | null;
  /** Short text of each macro as read; macros are never written yet. */
  summaries: readonly string[];
  note?: string;
}

export interface KbState {
  info: InfoState;
  analog?: AnalogState;
  keymap?: KeymapState;
  lighting?: LightingState;
  polling?: PollingState;
  profiles?: ProfilesState;
  options?: readonly KbOption[];
  advanced?: AdvancedState;
  macros?: MacrosState;
  /** Sentences the panel shows at the top (why something is missing, firmware quirks). */
  notes: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Changes and plans
// ---------------------------------------------------------------------------------------------

export type KbChange =
  | { kind: "analog"; target: "global" | readonly KeyIndex[]; values: AnalogValues }
  | { kind: "keycode"; layer: number; key: KeyIndex; code: number }
  | { kind: "lighting"; id: string; value: LightingValue }
  | { kind: "polling"; hz: number }
  | { kind: "profile"; index: number }
  | { kind: "option"; id: string; value: number };

/**
 * Advanced-key changes, kept apart from KbChange so drivers written against it stay exhaustive. A
 * backend that supports them implements `planAdvanced`; KbSession.apply takes either kind.
 */
export type KbAdvancedChange =
  /** A SOCD pair; mode "last" is snap tap. */
  | { kind: "socd"; keys: readonly [KeyIndex, KeyIndex]; mode: SocdMode }
  /** Dynamic keystroke on one key; the travel points in mm when the board lets them be set. */
  | { kind: "dks"; key: KeyIndex; bindings: readonly DksBinding[]; pressMm?: number; releaseMm?: number }
  /** Mod-tap: `hold` while held longer than `holdMs`, else `tap` (codes in the keymap's key space). */
  | { kind: "modTap"; key: KeyIndex; hold: number; tap: number; holdMs: number }
  /** Back to plain keys: removes SOCD, DKS and mod-tap from these keys (and their pair partners). */
  | { kind: "advancedClear"; keys: readonly KeyIndex[] };

export type ChangeGroup = "analog" | "keymap" | "lighting" | "polling" | "profiles" | "options" | "advanced";

export type KbAnyChange = KbChange | KbAdvancedChange;

export const isAdvancedChange = (c: KbAnyChange): c is KbAdvancedChange => c.kind === "socd" || c.kind === "dks" || c.kind === "modTap" || c.kind === "advancedClear";

export const groupOf = (c: KbAnyChange): ChangeGroup =>
  c.kind === "keycode"
    ? "keymap"
    : c.kind === "profile"
      ? "profiles"
      : c.kind === "option"
        ? "options"
        : c.kind === "socd" || c.kind === "dks" || c.kind === "modTap" || c.kind === "advancedClear"
          ? "advanced"
          : c.kind;

/** One change, ready to send. Nothing is sent until `send()`. */
export interface KbPlan {
  /** For the notice: "Actuation 1.2 mm on 3 keys". */
  label: string;
  /** What the read-back should show. */
  expected: unknown;
  /** Sends the change; nothing else. */
  send(): Promise<void>;
  /**
   * Reads back what the keyboard holds now for this change, and refreshes the backend's state.
   * Resolves undefined when the keyboard can't report it (the session then says "Unconfirmed").
   */
  readBack(): Promise<unknown>;
  persistence: KbPersistence;
  /** Said before sending when the change has a side effect (re-enumeration, a flash write). */
  caution?: string;
}

/** A command SYNQ refuses for this driver, for the panel's "never sends" list. */
export interface BlockedCommand {
  what: string;
  why:
    | "firmware"
    | "bootloader"
    | "device-mode"
    | "factory-reset"
    | "calibration"
    | "pairing"
    | "profile-wipe"
    | "identity"
    | "keystrokes"
    | "macro"
    | "shape"
    | "unverified"
    | "unknown";
}

export interface KbSupport {
  /** The keyboard's tier. */
  tier: KbTier;
  /** One line: who tested what. */
  why: string;
  /** Per-group overrides (a group can be tested while the rest is not). */
  groups?: Readonly<Partial<Record<ChangeGroup, KbTier>>>;
}

// ---------------------------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------------------------

/** Where backups and the write log go (app data on the desktop, memory in the preview). */
export interface KbStore {
  saveBackup(prefix: string, json: string): Promise<string>;
  log(prefix: string, lines: string[]): Promise<void>;
}

/** What a backend may ask its host for. */
export interface KbContext {
  store: KbStore;
  /** Real hardware (false in the browser preview). */
  live: boolean;
  /** Every HID device this host lists (a driver may need a sibling collection of the same board). */
  devices(): Promise<HidLike[]>;
  /** Where VIA keyboard definitions come from (src/lib/kb/via/definitions.ts). */
  definitions?: DefinitionSource;
}

/** VIA keyboard definitions by vendor/product id, cached by the host. */
export interface DefinitionSource {
  /** The compiled definition JSON (usevia.app format) or null when there is none. */
  get(version: "v2" | "v3", vendorId: number, productId: number): Promise<{ json: unknown; origin: "cache" | "network" } | null>;
  /** Where fetched definitions are kept, for the panel's sentence: "this PC" (default) or "this browser". */
  kept?: string;
  /** Why the last fetch failed (offline, blocked by the network), when it did; shown instead of a guess. */
  problem?(): string | null;
}

export interface KbBackend {
  /** Driver id, as in InfoState.driver. */
  readonly driver: string;
  /** The last full read. */
  readonly state: KbState;
  readonly support: KbSupport;
  readonly blocked: readonly BlockedCommand[];
  /** Reads everything the panel shows again. Sends nothing that changes the keyboard. */
  load(): Promise<KbState>;
  /** Turns a change into a plan; throws (with a sentence for the person) when it isn't possible. */
  plan(change: KbChange): KbPlan;
  /** The same for advanced keys (SOCD / snap tap, DKS, mod-tap), when the driver has them. */
  planAdvanced?(change: KbAdvancedChange): KbPlan;
  /** JSON-able copy of everything read, for the backup file. */
  snapshot(): unknown;
  /**
   * The Advanced card's actions for this keyboard (pairing, key and macro changes, calibration, a reset),
   * limited to what the driver's protocol is known for. Absent: the card shows firmware information only.
   */
  advanced?(): AdvancedPanel;
  close(): Promise<void>;
}

export interface KbDriver {
  /** "via", "omkb", "fcc", "analogsense". */
  id: string;
  name: string;
  /** Higher wins when several claim one device (a specific driver over generic VIA). */
  priority: number;
  /** Vendor ids it can claim, for lazy loading; null = any vendor (claimed by collection). */
  vids: readonly number[] | null;
  /** May this driver drive this device? No I/O: ids and collections only. */
  claims(device: HidLike): boolean | Promise<boolean>;
  /** Opens it and reads everything (KbBackend.load()). */
  open(device: HidLike, ctx: KbContext): Promise<KbBackend>;
  /** Whether it answers right now: one cheap read, nothing kept, closes what it opened. */
  ping(device: HidLike): Promise<boolean>;
}

/** What the generic panel shows: the state plus the session's rules. */
export interface KbView extends KbState {
  id: string;
  name: string;
  brand: string;
  driver: string;
  tier: KbTier;
  tierWhy: string;
  /** Tier per group, after the person's "Allow changes". */
  groupTier: Readonly<Record<ChangeGroup, KbTier>>;
  /** Per group: changes can be sent now. */
  writable: Readonly<Record<ChangeGroup, boolean>>;
  /** Why the read-only groups are locked. */
  lockedReason: string | null;
  /** Something is read-only and the person can allow changes. */
  canAllow: boolean;
  allowChanges: boolean;
  blocked: readonly BlockedCommand[];
  backupPath: string | null;
}

export interface KbWriteResult {
  view: KbView;
  verdict: Verdict;
  persistence: KbPersistence;
  /** One line for a notice: what was checked and where the setting lives. */
  detail: string;
}

export const TIER_LABEL: Readonly<Record<KbTier, { label: string; hint: string }>> = {
  verified: { label: "Verified", hint: "Tested with SYNQ on this exact keyboard." },
  "driver-tested": { label: "Driver-tested", hint: "The driver's authors tested these settings on this keyboard. SYNQ hasn't been tried on one." },
  "read-only": { label: "Read-only", hint: "Not tested with SYNQ, so changes are off until you allow them." },
  experimental: {
    label: "Experimental",
    hint: "Built from open drivers and protocol notes; SYNQ hasn't been tried on one yet. Only the tests you click are sent, and they don't stay on the device.",
  },
};

export const PERSISTENCE_LABEL: Readonly<Record<KbPersistence, string>> = {
  saved: "Saved on the keyboard",
  volatile: "Lost when the keyboard is unplugged",
  unknown: "Not verified",
};
