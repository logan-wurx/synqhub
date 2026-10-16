// "Keep your feel": the shapes the feature passes around. Pure data, no React, no Tauri, no device access.
//
//   FeelProfile    what the person saved: a device-neutral mouse part, keyboard part and in-game sens.
//   MouseTarget /  what a device can take (its own steps, ranges and scales), read from the view its panel
//   KeyboardTarget already keeps (src/lib/feel/devices.ts). Nothing is read from the device for it.
//   Plan           what mapping a feel onto a target produces: the steps to run, the rows of the preview
//                  (old -> new) and the list of differences (src/lib/feel/mouse.ts, keyboard.ts).
//
// Units are the human ones: DPI, Hz, ms, mm. Each device's driver turns them into its own units.

// ---------------------------------------------------------------------------------------------
// What is saved
// ---------------------------------------------------------------------------------------------

export type LodLevel = "Low" | "Medium" | "High";

/**
 * Lift-off, as the source mouse reported it: millimetres (with the mouse's own range, so it can be placed
 * on another scale) or one of three levels. Both are placed on a 0..1 scale to cross between vendors.
 */
export type LodFeel = { kind: "mm"; mm: number; min?: number; max?: number } | { kind: "level"; level: LodLevel };

export interface MouseFeel {
  /** Effective DPI of every stage, in the order the mouse holds them. At least one. */
  stages: number[];
  /** Index into `stages` of the stage in use. */
  active: number;
  pollingHz: number | null;
  lod: LodFeel | null;
  debounceMs: number | null;
  angleSnapping: boolean | null;
  motionSync: boolean | null;
  ripple: boolean | null;
}

/** SOCD resolution for a pair of keys (the same names the keyboard panel uses). */
export type SocdMode = "last" | "neutral" | "priorityA" | "priorityB" | "first" | "deeper" | "deeperSingle";

/** A SOCD pair by key name ("A", "D", "Left"...), so it can be found on a keyboard with another layout. */
export interface SocdPairFeel {
  a: string;
  b: string;
  mode: SocdMode;
}

export interface KeyboardFeel {
  actuationMm: number | null;
  rapidTrigger: boolean | null;
  rtPressMm: number | null;
  rtReleaseMm: number | null;
  /** null: not captured (the keyboard has none, or can't be read). [] : captured, none set. */
  socd: SocdPairFeel[] | null;
}

/** The person's in-game sensitivity at the saved mouse's active DPI. */
export interface GameSens {
  cs2: number | null;
  valorant: number | null;
}

/** Where a part of the feel was taken from, for the summary ("from the X1 V2 Air+"). */
export interface FeelSource {
  /** The navigation id (`mouse:atk`, `kb:falchion`). */
  deviceId: string;
  name: string;
  brand?: string;
  savedAt: number;
}

export interface FeelProfile {
  version: 1;
  updatedAt: number;
  mouse: { feel: MouseFeel; from: FeelSource } | null;
  keyboard: { feel: KeyboardFeel; from: FeelSource } | null;
  sens: GameSens;
}

// ---------------------------------------------------------------------------------------------
// What a device can take
// ---------------------------------------------------------------------------------------------

export interface DpiCaps {
  min: number;
  max: number;
  step: number;
  /** A fixed list (some mice only offer these); empty or absent means "every step from min to max". */
  options?: readonly number[];
}

export interface MouseTarget {
  /** Whether a single DPI can be set at all. */
  dpi: DpiCaps | null;
  /** A list of stages: how many, and whether the count can change. null: the mouse has no stages. */
  stages: { max: number; fixedCount: number | null } | null;
  polling: { options: readonly number[] } | null;
  lod: { kind: "mm"; min: number; max: number; step: number } | { kind: "levels"; levels: readonly LodLevel[] } | null;
  debounce: { options: readonly number[] } | null;
  toggles: { angleSnapping: boolean; motionSync: boolean; ripple: boolean };
}

/**
 * What the device holds now. It is the same shape as a feel, so it is also what "Save as my feel" saves;
 * it is the "now" column of the preview, and a step that would write what the device already holds is left out.
 */
export type MouseNow = MouseFeel;

export interface MouseDevice {
  target: MouseTarget;
  now: MouseNow | null;
}

export interface Range {
  min: number;
  max: number;
  step: number;
}

export interface KeyboardTarget {
  actuation: Range | null;
  rapidTrigger: boolean;
  /** The rapid-trigger sensitivity, in mm; `independent`: press and release can differ. */
  rtSensitivity: (Range & { independent: boolean }) | null;
  socd: { modes: readonly SocdMode[]; maxPairs: number | null; keys: readonly string[]; existing: readonly SocdPairFeel[] } | null;
}

/** What the keyboard holds now (same shape as a feel; see MouseNow). */
export type KeyboardNow = KeyboardFeel;

export interface KeyboardDevice {
  target: KeyboardTarget;
  now: KeyboardNow | null;
}

// ---------------------------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------------------------

export type ToggleSetting = "angleSnapping" | "motionSync" | "rippleControl";

/** One change to make, in human units. The device's driver turns it into its own writes. */
export type Step =
  | { kind: "stages"; values: number[]; active: number }
  | { kind: "dpi"; dpi: number }
  | { kind: "polling"; hz: number }
  | { kind: "lod"; mm: number }
  | { kind: "lod"; level: LodLevel }
  | { kind: "debounce"; ms: number }
  | { kind: "toggle"; setting: ToggleSetting; on: boolean }
  | { kind: "actuation"; mm: number }
  | { kind: "rapidTrigger"; on: boolean }
  /** Rapid-trigger distances; `releaseMm` equals `pressMm` when the keyboard has one sensitivity. */
  | { kind: "rtSensitivity"; pressMm: number; releaseMm: number }
  /** SOCD pairs to add (existing pairs stay as they are). */
  | { kind: "socd"; pairs: SocdPairFeel[] };

export type SettingId =
  | "dpi"
  | "stages"
  | "polling"
  | "lod"
  | "debounce"
  | "angleSnapping"
  | "motionSync"
  | "ripple"
  | "actuation"
  | "rapidTrigger"
  | "rtSensitivity"
  | "socd";

/**
 * How a row of the preview came out:
 *   same         already what the feel says; nothing to write.
 *   exact        the feel's value, written as it is.
 *   adjusted     the nearest value this device has (its step, range or list is different).
 *   approximate  carried across two different scales (millimetres <-> Low/Medium/High).
 *   unavailable  this device can't do it.
 */
export type RowStatus = "same" | "exact" | "adjusted" | "approximate" | "unavailable";

export interface Row {
  id: SettingId;
  label: string;
  /** The feel's value ("1600 DPI"). */
  from: string;
  /** What this device will be set to; null when it can't. */
  to: string | null;
  /** What the device holds now, when that differs from `to`. */
  now?: string;
  status: RowStatus;
  note?: string;
}

export interface Difference {
  setting: SettingId;
  label: string;
  kind: "adjusted" | "approximate" | "unavailable" | "dropped";
  wanted: string;
  got: string | null;
  /** One plain sentence. */
  reason: string;
}

export interface SensLine {
  /** In-game sensitivity before and after. */
  old: number;
  next: number;
  /** DPI x sens before and after (the "next" one uses the rounded sens). */
  oldEdpi: number;
  newEdpi: number;
  /** The value was worked out from the other game's sens (Valorant = CS2 / 3.181818), not typed in. */
  derived: boolean;
}

export interface SensAdvice {
  oldDpi: number;
  newDpi: number;
  /** The new DPI is the old one, so the sens stays. */
  exact: boolean;
  /** old DPI / new DPI: what the in-game sens is multiplied by. */
  factor: number;
  cs2: SensLine | null;
  valorant: SensLine | null;
}

export interface Plan {
  steps: Step[];
  rows: Row[];
  differences: Difference[];
  /** Null for keyboards, and for a mouse that can't set DPI. */
  sens: SensAdvice | null;
  /** Nothing to write: every row is "same" or "unavailable". */
  nothingToDo: boolean;
}
