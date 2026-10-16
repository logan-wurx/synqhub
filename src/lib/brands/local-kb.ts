// Local stand-in for the shared keyboard/driver interface (src/lib/kb/types.ts, Wave 1). That file did
// not exist when the Wave 3b brand protocols (razer/, monsgeek/, drunkdeer/) were written (2026-10-13),
// so they build on this one. Names follow docs/devices/CAPABILITIES.md §3 (OutgoingReport,
// CommandGuard.classify, SupportTier, HidMatch, Reading) so moving over is a rename: when
// src/lib/kb/types.ts lands, re-export its types from here (or point the imports at it) and keep the
// helpers below (GuardedChannel, the frame fixture format).
//
// Pure TypeScript, erasable syntax only (no enums, no parameter properties), so node runs the tests in
// scripts/ directly. Nothing in here talks to a device on its own: GuardedChannel only forwards to the
// HidLike it is given, after the brand's guard has said yes.

export type SupportTier = "verified" | "community" | "experimental" | "readOnly" | "detectOnly";
export type DeviceKind = "mouse" | "keyboard" | "receiver";

export interface HidMatch {
  vendorId: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

/** One report on its way to a device. `data` excludes the report id (WebHID convention). */
export interface OutgoingReport {
  type: "output" | "feature";
  reportId: number;
  data: Uint8Array;
}

export type BlockReason =
  | "firmware"
  | "bootloader"
  | "device-mode"
  | "factory-reset"
  | "calibration"
  | "pairing"
  | "profile-wipe"
  | "identity"
  | "shape"
  | "unknown";

/** What a guard says about one outgoing report. Anything not explicitly listed is "blocked"/"unknown". */
export type Verdict =
  | { verdict: "read" | "write"; name: string }
  | { verdict: "blocked"; name: string; why: BlockReason; reason: string };

export interface CommandGuard {
  /** Every outgoing report passes here; the desktop bridge repeats the same table in Rust. */
  classify(report: OutgoingReport): Verdict;
  /** Documented blocks, for a "What SYNQ never sends" panel. */
  readonly blocked: readonly { what: string; why: BlockReason }[];
}

/** Collection a driver talks on, and how the bridge must treat it. */
export interface Channel {
  usagePage: number;
  usage: number;
  /** "feature": SET/GET_FEATURE only, never input or output reports (Razer). "output+input": vendor page. */
  transport: "feature" | "output+input";
  reportId: number;
  /** Data bytes per report, without the report id. */
  length: number;
}

/** What the Rust bridge (src-tauri/src/hid.rs) must allow for a brand, and nothing more. */
export interface BridgeAllowance {
  vendorId: number;
  productIds: readonly number[];
  usagePage: number;
  usage: number;
  /** featureOnly = hid.rs `Access::FeatureOnly`; full = `Access::Full` (vendor-defined pages only). */
  access: "featureOnly" | "full";
  reportIds: readonly number[];
  length: number;
  note: string;
}

export interface NumRange {
  min: number;
  max: number;
  step: number;
}

export type SocdMode = "last" | "neutral" | "priorityA" | "priorityB" | "first" | "deeper";

/** Analog (Hall-effect / analog-optical) key features, in mm. Absent = the device doesn't have it. */
export interface AnalogCaps {
  perKey: boolean;
  actuation: NumRange;
  /** Separate release point (not RT). */
  release?: NumRange;
  rapidTrigger?: { press: NumRange; release?: NumRange; continuous?: boolean; perKey: boolean };
  deadzones?: { top?: NumRange; bottom?: NumRange };
  socd?: { modes: readonly SocdMode[]; maxPairs: number; global?: boolean };
  dks?: { slots: number };
  modTap?: { holdMs: NumRange };
  toggleKey?: boolean;
  liveDepth?: boolean;
}

export interface KeyboardCaps {
  analog?: AnalogCaps;
  keymap?: { layers: number; remap: boolean; macros?: number };
  lighting?: { effects: boolean; perKey: boolean; brightness: NumRange };
  polling?: readonly number[];
  profiles?: number;
  debounceMs?: NumRange;
}

export interface MouseCaps {
  dpi: { min: number; max: number; step: number; stages: number; separateXY: boolean };
  polling: readonly number[];
  pollingWireless?: readonly number[];
  liftOff?: { kind: "levels" | "mm"; min: number; max: number; asymmetric: boolean };
  battery: boolean;
}

export interface Source {
  kind: "configurator-js" | "open-source" | "community-doc" | "vendor-doc" | "capture" | "inferred";
  ref: string;
  license?: string;
}

/** One USB identity a brand table knows. Several models may share a PID (MonsGeek); then `model` is a family name. */
export interface DeviceEntry {
  vendor: string;
  vendorId: number;
  productId: number;
  model: string;
  kind: DeviceKind;
  connection: "usb" | "receiver" | "bluetooth";
  channel: Channel;
  tier: SupportTier;
  sources: readonly Source[];
  notes?: string;
}

/** A value read from a device, or SYNQ's own last write when the device can't report it. */
export interface Reading<T> {
  value: T | null;
  source: "device" | "cache" | "default" | "unknown";
  at?: string;
}

/** Outcome of a write: confirmed by read-back, sent but not readable ("unconfirmed"), or read back different. */
export type WriteOutcome<T = unknown> =
  | { status: "confirmed"; value: T }
  | { status: "unconfirmed"; value: T; why: string }
  | { status: "mismatch"; wrote: T; read: T };

export interface InputReportEventLike {
  reportId: number;
  data: DataView;
}
export type InputListener = (event: InputReportEventLike) => void;

/** The subset of WebHID's HIDDevice the drivers use; src/lib/tauri-hid.ts gives the desktop app the same shape. */
export interface HidLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly collections?: readonly { usagePage?: number; usage?: number }[];
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  sendFeatureReport(reportId: number, data: Uint8Array): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  addEventListener(type: "inputreport", listener: InputListener): void;
  removeEventListener(type: "inputreport", listener: InputListener): void;
}

export type FrameLog = (dir: "out" | "in" | "blocked", reportId: number, data: Uint8Array, note: string) => void;

export class BlockedFrameError extends Error {
  readonly verdict: Verdict;
  constructor(verdict: Verdict, data: Uint8Array) {
    super(`${verdict.verdict === "blocked" ? verdict.reason : "refused"} [${hex(data.subarray(0, 12))}]`);
    this.name = "BlockedFrameError";
    this.verdict = verdict;
  }
}

/**
 * Every outgoing report of a brand session goes through one of these. It asks the guard first and only
 * then touches the device; a blocked report throws and never reaches `hid`. For a "feature" channel it
 * refuses output reports and never subscribes to input reports, so a Consumer/Generic Desktop collection
 * is only ever used for SET/GET_FEATURE (the bridge's feature-only rule).
 */
export class GuardedChannel {
  readonly hid: HidLike;
  readonly guard: CommandGuard;
  readonly channel: Channel;
  readonly log: FrameLog;

  constructor(hid: HidLike, guard: CommandGuard, channel: Channel, log?: FrameLog) {
    this.hid = hid;
    this.guard = guard;
    this.channel = channel;
    this.log = log ?? (() => {});
  }

  check(report: OutgoingReport): Verdict {
    const v = this.guard.classify(report);
    if (v.verdict === "blocked") {
      this.log("blocked", report.reportId, report.data, v.reason);
      throw new BlockedFrameError(v, report.data);
    }
    return v;
  }

  async feature(data: Uint8Array): Promise<Verdict> {
    if (data.length !== this.channel.length) throw new Error(`Frames on this channel are ${this.channel.length} bytes (got ${data.length}).`);
    const v = this.check({ type: "feature", reportId: this.channel.reportId, data });
    this.log("out", this.channel.reportId, data, v.name);
    await this.hid.sendFeatureReport(this.channel.reportId, data);
    return v;
  }

  async getFeature(): Promise<Uint8Array> {
    const view = await this.hid.receiveFeatureReport(this.channel.reportId);
    let bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
    // Chrome includes the report id as byte 0 of a feature GET on some platforms; drop it when it is
    // there so callers always see the data bytes only.
    if (bytes.length === this.channel.length + 1 && bytes[0] === this.channel.reportId) bytes = bytes.subarray(1).slice();
    this.log("in", this.channel.reportId, bytes, "feature");
    return bytes;
  }

  async output(data: Uint8Array): Promise<Verdict> {
    if (this.channel.transport === "feature") throw new Error("This channel takes feature reports only.");
    if (data.length !== this.channel.length) throw new Error(`Frames on this channel are ${this.channel.length} bytes (got ${data.length}).`);
    const v = this.check({ type: "output", reportId: this.channel.reportId, data });
    this.log("out", this.channel.reportId, data, v.name);
    await this.hid.sendReport(this.channel.reportId, data);
    return v;
  }

  /** Input reports with this channel's report id. Refused on feature-only channels. */
  onInput(listener: (data: Uint8Array) => void): () => void {
    if (this.channel.transport === "feature") throw new Error("Feature-only channels never read input reports.");
    const wrapped: InputListener = (e) => {
      if (e.reportId !== this.channel.reportId) return;
      const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength).slice();
      this.log("in", e.reportId, bytes, "input");
      listener(bytes);
    };
    this.hid.addEventListener("inputreport", wrapped);
    return () => this.hid.removeEventListener("inputreport", wrapped);
  }
}

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Quantise mm to device units, clamped to a range (both in mm). */
export function mmToUnits(mm: number, unitMm: number, range?: NumRange): number {
  const v = range ? Math.min(range.max, Math.max(range.min, mm)) : mm;
  return Math.round(v / unitMm + 1e-9);
}

export function unitsToMm(units: number, unitMm: number): number {
  return Math.round(units * unitMm * 10000) / 10000;
}

/** One line of a bridge fixture file: `<1|0> <hex without spaces, trailing zeros dropped>`. */
export function fixtureLine(allowed: boolean, data: Uint8Array): string {
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  return `${allowed ? 1 : 0} ${Array.from(data.subarray(0, end), (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function okVerdict(name: string, kind: "read" | "write"): Verdict {
  return { verdict: kind, name };
}

export function blockVerdict(name: string, why: BlockReason, reason: string): Verdict {
  return { verdict: "blocked", name, why, reason };
}
