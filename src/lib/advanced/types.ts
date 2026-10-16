// What every panel's Advanced card needs from a device's driver, in one shape. A driver fills in only the
// actions its protocol is KNOWN for (from the sources it names); an action that is missing is hidden, with a
// one-line reason for the "Not available" list. Pure types: no React, no Tauri.
import type { AdvancedConfirmation, AdvancedGate, AdvancedScope } from "./core.ts";

/** Whether one Advanced action exists on this device, where its commands come from, and why not when they don't. */
export interface FeatureStatus {
  available: boolean;
  /** Where the commands are documented, e.g. "ATK HUB 3.2.27 + OpenMouse ATK driver". Always set when available. */
  source: string;
  /** Plain words, when not available. */
  why?: string;
}

/** The five actions the Advanced card can offer. Firmware has no entry: it is information only. */
export type FeatureTable = Readonly<Record<AdvancedScope, FeatureStatus>>;

/** Firmware, and a way to the maker's own updater. SYNQ never updates firmware itself. */
export interface FirmwareInfo {
  versions: readonly { part: string; version: string }[];
  /** The newest version an official source this driver already reads says exists. null: no way to tell. */
  latest: string | null;
  /** The maker's updater (its name and the page to get it). null when no official page is known. */
  updater: { name: string; url: string } | null;
  note?: string;
}

// ---------------------------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------------------------

export type PairPhase = "starting" | "waiting" | "paired" | "timeout" | "failed" | "cancelled";

export interface PairProgress {
  phase: PairPhase;
  secondsLeft: number | null;
  /** One sentence for the person. */
  message: string;
}

export interface PairApi {
  /** The guide, in order: "Turn the mouse off", "Turn it on again now"... */
  readonly steps: readonly string[];
  readonly timeoutSeconds: number;
  /** Starts pairing and follows it until it is paired, times out, fails or `signal` aborts. Never throws for those. */
  run(confirmation: AdvancedConfirmation, onProgress: (p: PairProgress) => void, signal: AbortSignal): Promise<PairProgress>;
}

// ---------------------------------------------------------------------------------------------
// Mouse buttons
// ---------------------------------------------------------------------------------------------

export interface ButtonChoice {
  id: string;
  label: string;
}

export interface ButtonSlot {
  id: string;
  label: string;
  /** The id of its current action, or null when it holds something SYNQ doesn't write (a macro, a shortcut). */
  action: string | null;
  actionLabel: string;
  /** Left click and anything unreadable can't be changed. */
  locked: boolean;
  lockedWhy?: string;
  /** What the choices are for this button. */
  choices: readonly ButtonChoice[];
  /** Differs from the backup taken when the session began. */
  changed: boolean;
}

export interface ButtonsState {
  slots: readonly ButtonSlot[];
  backupPath: string | null;
}

export interface ButtonsApi {
  /** Reads the buttons, saves a backup of them, then (and only then) takes the grant. */
  begin(confirmation: AdvancedConfirmation): Promise<ButtonsState>;
  set(slotId: string, actionId: string): Promise<ButtonsState>;
  /** Puts every button back to what the backup holds. */
  undoAll(): Promise<ButtonsState>;
  /** Gives the grant back. */
  end(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Keyboard keys and macros
// ---------------------------------------------------------------------------------------------

export interface KeyChoice {
  code: number;
  label: string;
  group: string;
}

export interface KeymapAdvancedState {
  layers: number;
  /** codes[layer][key index]. */
  codes: readonly (Readonly<Record<number, number>>)[];
  /** Per layer: the key indexes that differ from the backup. */
  changed: readonly (readonly number[])[];
  backupPath: string | null;
  /** The key codes the picker offers, grouped. */
  choices: readonly KeyChoice[];
}

export interface KeymapApi {
  begin(confirmation: AdvancedConfirmation): Promise<KeymapAdvancedState>;
  set(layer: number, key: number, code: number): Promise<KeymapAdvancedState>;
  undoAll(): Promise<KeymapAdvancedState>;
  end(): Promise<void>;
  label(code: number): string;
  /** Why this change would be refused, or null (the same rules `set` applies). */
  problem(layer: number, key: number, code: number): string | null;
}

export interface MacroSlot {
  index: number;
  /** The macro in SYNQ's small text form: plain text types itself, {Enter} taps a key, {wait 100} waits. */
  text: string;
  bytes: number;
  /** False when the macro holds actions SYNQ can't show; it is then left alone, byte for byte. */
  editable: boolean;
}

export interface MacrosState {
  slots: readonly MacroSlot[];
  capacity: number;
  used: number;
  backupPath: string | null;
}

export interface MacrosApi {
  begin(confirmation: AdvancedConfirmation): Promise<MacrosState>;
  /** Saves one macro; the others are written back exactly as they were. */
  save(index: number, text: string): Promise<MacrosState>;
  undoAll(): Promise<MacrosState>;
  end(): Promise<void>;
  /** How many bytes `text` takes, or why it isn't a macro. */
  check(text: string): { bytes: number; error: string | null };
}

// ---------------------------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------------------------

export type CalibratePhase = "starting" | "pressing" | "saving" | "done" | "aborted" | "failed" | "timeout";

export interface CalibrateTarget {
  id: string;
  label: string;
  /** waiting: not touched yet. partial: pressed but not all the way. done: pressed fully. */
  state: "waiting" | "partial" | "done";
}

export interface CalibrateProgress {
  phase: CalibratePhase;
  targets: readonly CalibrateTarget[];
  /** Live depth of the key or button being pressed, 0..1, when the device reports it. */
  depth: number | null;
  message: string;
  backupPath: string | null;
}

export interface CalibrateApi {
  /** The guide: "Press each key fully, then release". */
  readonly steps: readonly string[];
  readonly timeoutSeconds: number;
  /** Whether the old calibration can be written back (most devices can't be asked for it). */
  readonly canRestore: boolean;
  readonly restoreNote: string;
  run(confirmation: AdvancedConfirmation, onProgress: (p: CalibrateProgress) => void, signal: AbortSignal): Promise<CalibrateProgress>;
}

// ---------------------------------------------------------------------------------------------
// Factory reset
// ---------------------------------------------------------------------------------------------

export interface ResetApi {
  /** What a reset wipes, in plain words. */
  readonly wipes: readonly string[];
  /** Saves the full settings backup and returns where it went. Runs before the reset, always. */
  backup(): Promise<string>;
  /** Backs up (if not just done), then resets. `confirmation.typed` must be RESET. */
  reset(confirmation: AdvancedConfirmation): Promise<{ backupPath: string }>;
  /** Puts the saved settings back right after a reset. */
  canRestore(): boolean;
  restore(confirmation: AdvancedConfirmation): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------

/** Everything the Advanced card renders for one device. */
export interface AdvancedPanel {
  readonly deviceName: string;
  readonly kind: "mouse" | "keyboard";
  readonly gate: AdvancedGate;
  readonly features: FeatureTable;
  readonly firmware: FirmwareInfo;
  readonly pair?: PairApi;
  readonly buttons?: ButtonsApi;
  readonly keymap?: KeymapApi;
  readonly macros?: MacrosApi;
  readonly calibrate?: CalibrateApi;
  readonly reset?: ResetApi;
  /** Called after any Advanced action changed the device, so the panel can read it again. */
  refreshed?: () => void;
}

/** Features table helper: every action hidden, with the same reason, until a driver turns some on. */
export function noFeatures(why: string): FeatureTable {
  const off: FeatureStatus = { available: false, source: "", why };
  return { pair: off, remap: off, macros: off, calibrate: off, reset: off };
}

export function withFeatures(base: FeatureTable, on: Partial<Record<AdvancedScope, FeatureStatus>>): FeatureTable {
  return { ...base, ...on };
}
