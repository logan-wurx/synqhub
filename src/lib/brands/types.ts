// Shared, transport-free types for the brand protocol layers in src/lib/brands/<brand>/.
//
// LOCAL INTERFACE. Wave 1's shared driver interface (src/lib/kb/types.ts) did not exist when this was
// written, so these types follow the names in docs/devices/CAPABILITIES.md §3.4–3.5 (HidMatch,
// OutgoingReport, CommandGuard, SupportTier, provenance) to make adapting a rename or a re-export:
//   - CommandGuard.classify(report) → { verdict: "read" | "write" | "blocked" } is the same contract.
//   - HidLike is the subset of WebHID's HIDDevice the sessions use; src/lib/tauri-hid.ts devices and
//     real HIDDevice objects both satisfy it.
//   - KeyboardFeatures / MouseFeatures are flat capability descriptors a Capabilities builder can map
//     onto AnalogGroup / PointerGroup without knowing the brand.
// Nothing in src/lib/brands talks to a device by itself; sessions only send through a HidLike they are
// handed, and every frame passes the brand guard first.

export type SupportTier = "verified" | "community" | "experimental" | "readOnly" | "detectOnly";

export type DeviceKind = "mouse" | "keyboard" | "headset" | "gamepad" | "receiver" | "dock";

/** How a fact was established. "unconfirmed" = written from vendor code or open source, never on hardware. */
export type Confidence = "captured" | "source" | "inferred" | "unconfirmed";

export interface Provenance {
  kind: "configurator-js" | "capture" | "open-source" | "manifest" | "vendor-doc";
  ref: string;
  license?: string;
}

export interface HidMatch {
  vendorId: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

/** One HID top-level collection a driver uses. */
export interface HidChannel {
  role: "control" | "event" | "notify";
  usagePage: number;
  usage: number;
  /** Report id the frames travel on (0 = no report id). */
  reportId: number;
  /** Report payload length in bytes, without the report id. */
  length: number;
  /** "output" = host writes requests here; "input" = device-to-host only. */
  direction: "output" | "input";
  note?: string;
}

export interface OutgoingReport {
  type: "output" | "feature";
  reportId: number;
  data: Uint8Array;
}

export type BlockReason =
  | "firmware"
  | "bootloader"
  | "factory-reset"
  | "calibration"
  | "pairing"
  | "profile-wipe"
  | "identity"
  | "demo"
  | "unknown";

export interface FrameVerdict {
  verdict: "read" | "write" | "blocked";
  /** Short label of the matched command ("global actuation", "save profile"). */
  what: string;
  why?: BlockReason;
  reason?: string;
}

/** A documented block, shown in the device's "What SYNQ never sends" list and tested. */
export interface BlockedCommand {
  what: string;
  why: BlockReason;
  /** Hex pattern, `..` = any byte. */
  bytes: string;
  source: string;
}

export interface CommandGuard {
  /** Every outgoing report passes here; the Rust bridge repeats the same table (see the *-frames.txt fixtures). */
  classify(report: OutgoingReport): FrameVerdict;
  blocked: readonly BlockedCommand[];
}

export class BlockedFrameError extends Error {
  readonly verdict: FrameVerdict;
  readonly bytes: Uint8Array;
  constructor(verdict: FrameVerdict, bytes: Uint8Array) {
    super(`SYNQ refused to send ${verdict.what}: ${verdict.reason ?? verdict.why ?? "not on the allowlist"}`);
    this.name = "BlockedFrameError";
    this.verdict = verdict;
    this.bytes = bytes;
  }
}

// ---------------------------------------------------------------------------------------------
// Transport surface
// ---------------------------------------------------------------------------------------------

export interface HidInputEvent {
  reportId: number;
  data: DataView;
}

/** The part of WebHID's HIDDevice the sessions use. */
export interface HidLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly opened: boolean;
  readonly collections?: readonly { usagePage?: number; usage?: number; outputReports?: readonly { reportId?: number }[] }[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener(type: "inputreport", listener: (event: HidInputEvent) => void): void;
  removeEventListener(type: "inputreport", listener: (event: HidInputEvent) => void): void;
}

// ---------------------------------------------------------------------------------------------
// Capability descriptors (human units: mm, Hz, ms, cpi)
// ---------------------------------------------------------------------------------------------

export interface MmRange {
  min: number;
  max: number;
  /** UI step in mm (= the firmware unit unless the vendor UI is coarser). */
  step: number;
}

/** Whether a value can be read back from the device, or only written. */
export type ReadBack = "device" | "unconfirmed" | "none";

export interface KeyboardFeatures {
  /** Firmware distance unit in mm (0.1, 0.01). Encoders quantise to this. */
  unitMm: number | null;
  actuation?: { range: MmRange; perKey: boolean; readBack: ReadBack };
  rapidTrigger?: {
    range: MmRange;
    perKey: boolean;
    separatePressRelease: boolean;
    continuous: boolean;
    /** Corsair "actuationDeadzone" style extra field. */
    deadzone?: MmRange;
    readBack: ReadBack;
  };
  deadZones?: { top: MmRange; bottom: MmRange; perKey: boolean; readBack: ReadBack };
  socd?: { name: string; maxPairs: number; modes: readonly string[]; readBack: ReadBack };
  remap?: { layers: readonly string[]; readBack: ReadBack };
  lighting?: { effects: readonly string[]; brightness: boolean; readBack: ReadBack };
  polling?: { hz: readonly number[]; readBack: ReadBack; reconnects?: boolean };
  debounceMs?: { values: readonly number[]; readBack: ReadBack };
  profiles?: { count: number; save: "explicit" | "automatic"; readBack: ReadBack };
}

export interface MouseFeatures {
  dpi?: { min: number; max: number; step: number; stages: number; separateXY: boolean; readBack: ReadBack };
  polling?: { hz: readonly number[]; wirelessHz?: readonly number[]; readBack: ReadBack };
  liftOff?: { values: readonly number[]; labels?: Readonly<Record<number, string>>; asymmetric: boolean; readBack: ReadBack };
  motionSync?: { readBack: ReadBack };
  angleSnap?: { readBack: ReadBack };
  debounceMs?: { values: readonly number[]; readBack: ReadBack };
  battery?: { readBack: ReadBack };
  profiles?: { count: number; readBack: ReadBack };
}

// ---------------------------------------------------------------------------------------------
// Small helpers shared by the brand codecs
// ---------------------------------------------------------------------------------------------

export const hex = (bytes: ArrayLike<number>, sep = " "): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(sep);

/** Hex string (spaces optional) to a zero-padded buffer of `length` bytes. */
export function fromHex(s: string, length: number): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  if (clean.length % 2) throw new Error(`odd hex: ${s}`);
  const out = new Uint8Array(length);
  for (let i = 0; i < clean.length / 2; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** True when bytes[from..] are all zero. */
export const restZero = (f: Uint8Array, from: number): boolean => {
  for (let i = from; i < f.length; i++) if (f[i] !== 0) return false;
  return true;
};

export const u16le = (f: Uint8Array, at: number): number => f[at] | (f[at + 1] << 8);

/**
 * mm → firmware units for a unit of `unitMm` (0.1 → ×10, 0.01 → ×100). The scale is rounded to an
 * integer first so 0.1 mm boards get exactly Math.round(mm * 10), as the captured HFX encoder does.
 */
export function mmToUnits(mm: number, unitMm: number): number {
  if (!(unitMm > 0)) throw new RangeError(`bad unit ${unitMm}`);
  if (!Number.isFinite(mm) || mm < 0) throw new RangeError(`bad distance ${mm} mm`);
  return Math.round(mm * Math.round(1 / unitMm));
}

export function unitsToMm(units: number, unitMm: number): number {
  const scale = Math.round(1 / unitMm);
  return units / scale;
}

/** Throws unless lo <= v <= hi (with a little float slack for mm values). */
export function checkRange(label: string, v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v) || v < lo - 1e-9 || v > hi + 1e-9) throw new RangeError(`${label} ${v} outside ${lo}..${hi}`);
  return v;
}

// ---------------------------------------------------------------------------------------------
// Mice (no shared mouse driver interface exists outside OpenMouse's; this is the local one the brand
// mouse sessions implement. Human units: cpi, Hz, ms.)
// ---------------------------------------------------------------------------------------------

export interface MouseSettings {
  firmware: string | null;
  /** One value per stage (X when the mouse has separate axes). */
  dpi: number[] | null;
  /** 0-based. */
  activeStage: number | null;
  pollingHz: number | null;
  debounceMs: number | null;
  angleSnap: boolean | null;
  motionSync: boolean | null;
  /** Lift-off: raw level/enum as the device reports it; label in liftOffLabel. */
  liftOff: number | null;
  liftOffLabel: string | null;
  battery: { percent: number; charging: boolean | null } | null;
  /** 1-based. */
  profile: number | null;
}

export type MouseChange =
  | { kind: "dpi"; stage: number; dpi: number }
  | { kind: "activeStage"; stage: number }
  | { kind: "polling"; hz: number }
  | { kind: "debounce"; ms: number }
  | { kind: "angleSnap"; on: boolean }
  | { kind: "motionSync"; on: boolean }
  | { kind: "liftOff"; value: number }
  | { kind: "profile"; index: number };

export interface MouseWriteResult {
  verdict: "confirmed" | "mismatch" | "unconfirmed";
  expected: unknown;
  got: unknown;
  persistence: "saved" | "volatile" | "unknown";
}

export interface BrandMouseSession {
  readonly features: MouseFeatures;
  readonly blocked: readonly BlockedCommand[];
  read(): Promise<MouseSettings>;
  /** Sends one change (guarded), saves where the device needs it, reads it back and compares. */
  apply(change: MouseChange): Promise<MouseWriteResult>;
  close(): Promise<void>;
}

export const emptyMouseSettings = (): MouseSettings => ({
  firmware: null,
  dpi: null,
  activeStage: null,
  pollingHz: null,
  debounceMs: null,
  angleSnap: null,
  motionSync: null,
  liftOff: null,
  liftOffLabel: null,
  battery: null,
  profile: null,
});

/** Read-back comparison shared by the mouse sessions. */
export function verdictOf(expected: unknown, got: unknown): MouseWriteResult["verdict"] {
  if (got === undefined) return "unconfirmed";
  return JSON.stringify(expected) === JSON.stringify(got) ? "confirmed" : "mismatch";
}
