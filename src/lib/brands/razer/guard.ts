// Razer allowlist: every report SYNQ's Razer sessions send passes `classifyRazer` first (via
// GuardedChannel), and the desktop bridge must repeat the same check (fixture: razer-frames.txt next to
// this file, written by scripts/razer-allowlist-fixture.ts). Default deny: a frame is allowed only when
// it is a feature report, report id 0, exactly 90 bytes, well-formed (status/reserved bytes zero, valid
// XOR, zero padding after the declared data size) AND its class/id is one of the commands in
// protocol.ts CMD AND its arguments pass that command's own check. Anything else is refused, and the
// commands below are refused by name with a reason.
//
// Sources for the blocked list: Synapse Web bundles (command tables of classes 0x00, 0x02, 0x05, 0x06,
// 0x0B, 0x0F, 0xFE, and the device-mode enum Normal 0 / Bootloader 1 / Testing 2 / Driver 3 / Download 4 /
// RF test 8 / Retail 9), openrazer (set_device_mode refuses the factory test mode), SYNQ hid.rs
// (`razer_frame_allowed` already refuses class 0x00 id 0x04/0x84).

import { blockVerdict, okVerdict, type BlockReason, type BridgeAllowance, type CommandGuard, type OutgoingReport, type Verdict } from "../local-kb.ts";
import { RAZER_ALL_KEYS, RAZER_DETECT_ONLY, RAZER_FEATURE_ONLY_PIDS, RAZER_KEYBOARDS, RAZER_MICE, RAZER_VALID_KEY_IDS, RAZER_VID } from "./devices.ts";
import {
  ACTUATION_MAX_RAW,
  ACTUATION_MIN_RAW,
  ACTUATION_PER_PACKET,
  ARGS_MAX,
  BOTTOM_DZ_MAX_LEVEL,
  CMD,
  CRC_INDEX,
  DPI_GUARD_MAX,
  DPI_GUARD_MIN,
  DPI_MAX_STAGES,
  DUAL_PRIORITY_MAX_KEYS,
  LIFT_MAX_HEIGHT,
  LIFT_MODE,
  MAX_PROFILE_ID,
  POLL_HZ,
  PROXIMITY_CLASS,
  PROXIMITY_SENSOR,
  RELEASE_MIN_RAW,
  REPORT_LEN,
  RT_MAX_RAW,
  RT_MIN_RAW,
  RT_PER_PACKET,
  SINGLE_SNAP_MAX_KEYS,
  SNAP_TAP_MAX_PAIRS,
  SNAP_TAP_MODE,
  crc,
  type CmdName,
} from "./protocol.ts";

/** A command (or a whole class, id "*") SYNQ refuses by name. */
export interface RazerBlocked {
  cls: number;
  id: number | "*";
  what: string;
  why: BlockReason;
}

export const RAZER_BLOCKED: readonly RazerBlocked[] = [
  { cls: 0x00, id: 0x04, what: "Set Device Mode (modes include Bootloader 1, Testing 2, Download 4, RF test 8, Retail 9)", why: "device-mode" },
  { cls: 0x00, id: 0x84, what: "Get Device Mode (refused by the bridge together with its set)", why: "device-mode" },
  { cls: 0x00, id: 0x0b, what: "Set Device Reset", why: "factory-reset" },
  { cls: 0x00, id: 0x02, what: "Set Serial Number", why: "identity" },
  { cls: 0x00, id: 0x36, what: "Set Device HW Info Force Check", why: "identity" },
  { cls: 0x00, id: 0x41, what: "Set Device Pairing Mode", why: "pairing" },
  { cls: 0x00, id: 0x42, what: "Set Device Unpair", why: "pairing" },
  { cls: 0x00, id: 0x46, what: "Set Device Scan", why: "pairing" },
  { cls: 0x00, id: 0x47, what: "Set Active Wireless Connection State", why: "pairing" },
  { cls: 0x00, id: 0x53, what: "Set USB Device Enumerate", why: "device-mode" },
  { cls: 0x00, id: 0x55, what: "Set Device Auto Pairing Status", why: "pairing" },
  { cls: 0x00, id: 0x5c, what: "Set Tournament Signature", why: "identity" },
  { cls: 0xfe, id: "*", what: "Class 0xFE: analog calibration mode, ADC / calibration data by key, user calibration data", why: "calibration" },
  { cls: 0x02, id: 0x9c, what: "Get Multi Analog Key ADC Data (raw sensor stream used by calibration)", why: "calibration" },
  { cls: 0x02, id: 0x21, what: "Set Keyboard Kill Switch Ctrl (old snap tap; not modelled)", why: "unknown" },
  { cls: 0x05, id: 0x02, what: "Create New Profile", why: "profile-wipe" },
  { cls: 0x05, id: 0x03, what: "Set Delete Profile", why: "profile-wipe" },
  { cls: 0x05, id: 0x0b, what: "Set Profile Reset (same id as Set Device Power Plan on other products)", why: "profile-wipe" },
  { cls: 0x06, id: 0x0a, what: "Set Macro Memory Management (storage format / allocation)", why: "profile-wipe" },
  { cls: 0x06, id: 0x09, what: "Set Macro Memory Data", why: "profile-wipe" },
  { cls: 0x0b, id: 0x01, what: "Start Proximity Sensor Calibration", why: "calibration" },
  { cls: 0x0b, id: 0x0c, what: "Set Proximity Sensor Lift To Track Calibration Data", why: "calibration" },
  { cls: 0x0b, id: 0x0d, what: "Set Proximity Sensor Track To Lift Calibration Data", why: "calibration" },
  { cls: 0x0b, id: 0x05, what: "Set Proximity Sensor Configuration (asymmetric lift data)", why: "calibration" },
  { cls: 0x0b, id: 0x08, what: "Proximity Sensor Calibration Data ([50, 0x0B, 0x08] in Synapse's table)", why: "calibration" },
];

export const RAZER_BLOCKED_SUMMARY: readonly { what: string; why: BlockReason }[] = [
  ...RAZER_BLOCKED.map((b) => ({ what: `${hex2(b.cls)}/${b.id === "*" ? "**" : hex2(b.id)} ${b.what}`, why: b.why })),
  { what: "Firmware update: Razer flashes through its desktop CFU updater; Synapse Web has no in-browser flashing. No firmware opcode is reachable (default deny).", why: "firmware" },
  { what: "Any class / id not in SYNQ's command table", why: "unknown" },
];

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function blockedEntry(cls: number, id: number): RazerBlocked | undefined {
  return RAZER_BLOCKED.find((b) => b.cls === cls && (b.id === "*" || b.id === id));
}

/** Whether a class/id is explicitly blocked (used by tests to prove the codec can't reach them). */
export const isRazerBlocked = (cls: number, id: number): boolean => blockedEntry(cls, id) !== undefined;

const CMD_BY_CODE = new Map<number, CmdName>((Object.keys(CMD) as CmdName[]).map((n) => [(CMD[n].cls << 8) | CMD[n].id, n]));
export const razerCommandFor = (cls: number, id: number): CmdName | undefined => CMD_BY_CODE.get((cls << 8) | id);

const u16 = (a: Uint8Array, i: number) => (a[i] << 8) | a[i + 1];
const zeroFrom = (a: Uint8Array, i: number) => a.subarray(i).every((x) => x === 0);
const profileOk = (p: number) => p <= MAX_PROFILE_ID;
const keyOk = (k: number) => RAZER_VALID_KEY_IDS.has(k);
const bool = (b: number) => b === 0 || b === 1;

/** Per-command argument checks. `a` = the declared-size argument bytes; `size` = byte 5. Returns a reason or null. */
const CHECKS: Record<CmdName, (a: Uint8Array, size: number) => string | null> = {
  firmware: (a, n) => (n === 2 && zeroFrom(a, 0) ? null : "firmware read takes size 2, no arguments"),
  serial: (a, n) => (n === 22 && zeroFrom(a, 0) ? null : "serial read takes size 22, no arguments"),
  pollingGet: (a, n) => (n === 2 && profileOk(a[0]) && a[1] === 0 ? null : "polling read is [profile, 0]"),
  pollingSet: (a, n) => (n === 2 && profileOk(a[0]) && POLL_HZ[a[1]] !== undefined ? null : "polling write is [profile, rate code]"),
  profileCount: (a, n) => (n === 1 && a[0] === 0 ? null : "profile count read takes no arguments"),
  profileList: (a, n) => (n === 80 && zeroFrom(a, 0) ? null : "profile list read takes no arguments"),
  profileActiveGet: (a, n) => (n === 1 && a[0] === 0 ? null : "active profile read takes no arguments"),
  profileActiveSet: (a, n) => (n === 1 && a[0] >= 1 && profileOk(a[0]) ? null : "active profile write is [profile id 1..8]"),
  actuationGet: (a, n) => keyListRead(a, n, 5, ACTUATION_PER_PACKET),
  actuationSet: (a, n) => {
    const k = (n - 2) / 5;
    if (!Number.isInteger(k) || k < 1 || k > ACTUATION_PER_PACKET) return "actuation write size must be 2 + 5n, n 1..15";
    if (a[0] !== 0 || !profileOk(a[1])) return "actuation write starts [0, profile]";
    for (let i = 0; i < k; i++) {
      const o = 2 + 5 * i;
      const key = a[o];
      if (!(keyOk(key) || (key === RAZER_ALL_KEYS && k === 1))) return `key id ${key} not allowed`;
      const rel = u16(a, o + 1);
      const act = u16(a, o + 3);
      if (act < ACTUATION_MIN_RAW || act > ACTUATION_MAX_RAW) return "actuation outside 0.1..4.0 mm";
      if (rel < RELEASE_MIN_RAW || rel > act) return "release point outside 256 raw..actuation";
    }
    return null;
  },
  rapidTriggerGet: (a, n) => keyListRead(a, n, 6, RT_PER_PACKET),
  rapidTriggerSet: (a, n) => {
    const k = (n - 2) / 6;
    if (!Number.isInteger(k) || k < 1 || k > RT_PER_PACKET) return "rapid-trigger write size must be 2 + 6n, n 1..13";
    if (a[0] !== 0 || !profileOk(a[1])) return "rapid-trigger write starts [0, profile]";
    for (let i = 0; i < k; i++) {
      const o = 2 + 6 * i;
      const key = a[o];
      if (!(keyOk(key) || (key === RAZER_ALL_KEYS && k === 1))) return `key id ${key} not allowed`;
      if (!bool(a[o + 1])) return "rapid-trigger enable must be 0/1";
      for (const v of [u16(a, o + 2), u16(a, o + 4)]) if (v < RT_MIN_RAW || v > RT_MAX_RAW) return "rapid-trigger sensitivity outside 0.1..2.0 mm";
    }
    return null;
  },
  bottomDeadZoneGet: (a, n) => (n === 2 && profileOk(a[0]) && a[1] === 0 ? null : "bottom dead-zone read is [profile, 0]"),
  bottomDeadZoneSet: (a, n) => (n === 2 && profileOk(a[0]) && a[1] >= 1 && a[1] <= BOTTOM_DZ_MAX_LEVEL ? null : "bottom dead-zone write is [profile, level 1..20]"),
  snapTapGet: (a, n) => (n === 15 && profileOk(a[0]) && zeroFrom(a, 1) ? null : "snap-tap read is [profile]"),
  snapTapSet: (a, n) => {
    if (n !== 15 || !profileOk(a[0]) || a[1] > SNAP_TAP_MAX_PAIRS || !bool(a[2])) return "snap-tap write is [profile, pairs 0..4, enabled, ...]";
    for (let i = 0; i < a[1]; i++) {
      const o = 3 + 3 * i;
      if (!keyOk(a[o]) || !keyOk(a[o + 1]) || a[o] === a[o + 1] || a[o + 2] > SNAP_TAP_MODE.deeper) return "bad snap-tap pair";
    }
    return zeroFrom(a, 3 + 3 * a[1]) ? null : "snap-tap padding must be zero";
  },
  singleSnapTapGet: (a, n) => (n === 11 && profileOk(a[0]) && zeroFrom(a, 1) ? null : "single-key snap-tap read is [profile]"),
  singleSnapTapSet: (a, n) => {
    if (n !== 11 || !profileOk(a[0]) || a[1] > SINGLE_SNAP_MAX_KEYS || !bool(a[2])) return "single-key snap-tap write is [profile, keys 0..4, enabled, ...]";
    for (let i = 0; i < a[1]; i++) if (!keyOk(a[3 + 2 * i])) return "bad single-key snap-tap key";
    return zeroFrom(a, 3 + 2 * a[1]) ? null : "single-key snap-tap padding must be zero";
  },
  dualPriorityGet: (a, n) => (n === 7 && profileOk(a[0]) && zeroFrom(a, 1) ? null : "dual-priority read is [profile]"),
  dualPrioritySet: (a, n) => {
    if (n !== 7 || !profileOk(a[0]) || a[1] > DUAL_PRIORITY_MAX_KEYS || !bool(a[2])) return "dual-priority write is [profile, count 0..4, enabled, keys]";
    const keys = Array.from(a.subarray(3, 3 + a[1]));
    if (!keys.every(keyOk) || new Set(keys).size !== keys.length) return "bad dual-priority key";
    return zeroFrom(a, 3 + a[1]) ? null : "dual-priority padding must be zero";
  },
  brightnessGet: (a, n) => (n === 3 && profileOk(a[0]) && a[1] === 0 && a[2] === 0 ? null : "brightness read is [profile, region 0]"),
  brightnessSet: (a, n) => (n === 3 && profileOk(a[0]) && a[1] === 0 ? null : "brightness write is [profile, region 0, value]"),
  dpiStagesGet: (a, n) => (n === 80 && profileOk(a[0]) && zeroFrom(a, 1) ? null : "DPI read is [profile]"),
  dpiStagesSet: (a, n) => {
    const k = a[2];
    if (k < 1 || k > DPI_MAX_STAGES || n !== 3 + 7 * k) return "DPI write size must be 3 + 7n, n 1..5";
    if (!profileOk(a[0]) || a[1] < 1 || a[1] > k) return "DPI write is [profile, active 1..n, n, ...]";
    for (let i = 0; i < k; i++) {
      const o = 3 + 7 * i;
      if (a[o] > 8) return "DPI stage id outside 0..8";
      for (const v of [u16(a, o + 1), u16(a, o + 3)]) if (v < DPI_GUARD_MIN || v > DPI_GUARD_MAX) return "DPI outside 50..50000";
      if (a[o + 5] !== 0 || a[o + 6] !== 0) return "DPI z must be 0";
    }
    return null;
  },
  batteryGet: (a, n) => (n === 2 && zeroFrom(a, 0) ? null : "battery read takes no arguments"),
  chargingGet: (a, n) => (n === 2 && zeroFrom(a, 0) ? null : "charging read takes no arguments"),
  liftGet: (a, n) => (n === 4 && a[0] === PROXIMITY_CLASS && a[1] === PROXIMITY_SENSOR && a[2] === 0 && a[3] === 0 ? null : "lift read is [0, 4]"),
  liftSet: (a, n) =>
    n === 4 && a[0] === PROXIMITY_CLASS && a[1] === PROXIMITY_SENSOR && a[2] === LIFT_MODE.universalCutOff && a[3] <= LIFT_MAX_HEIGHT ? null : "lift write is [0, 4, 1 (universal cut-off), height 0..9]",
  proximityStateSet: (a, n) => (n === 3 && a[0] === PROXIMITY_CLASS && a[1] === PROXIMITY_SENSOR && a[2] === 1 ? null : "proximity state write is [0, 4, 1]"),
};

function keyListRead(a: Uint8Array, n: number, stride: number, max: number): string | null {
  const k = (n - 2) / stride;
  if (!Number.isInteger(k) || k < 1 || k > max) return `read size must be 2 + ${stride}n, n 1..${max}`;
  if (a[0] !== 0 || !profileOk(a[1])) return "read starts [0, profile]";
  for (let i = 0; i < k; i++) {
    const o = 2 + stride * i;
    if (!keyOk(a[o])) return `key id ${a[o]} not allowed`;
    for (let j = 1; j < stride; j++) if (a[o + j] !== 0) return "read slots must be zero after the key id";
  }
  return null;
}

/** Transaction ids SYNQ sends: Synapse's rolling 0..30 (plus 31) and openrazer's fixed 0xFF fallback. */
export const txAllowed = (tx: number): boolean => tx <= 0x1f || tx === 0xff;

/** The 90 data bytes of a Razer feature report (report id excluded). */
export function classifyRazerFrame(f: Uint8Array): Verdict {
  if (f.length !== REPORT_LEN) return blockVerdict("shape", "shape", `Razer control reports are ${REPORT_LEN} bytes (got ${f.length}).`);
  const [status, tx, rp0, rp1, proto, size, cls, id] = f;
  const named = blockedEntry(cls, id);
  if (named) return blockVerdict(named.what, named.why, `Blocked: ${named.what}.`);
  const cmd = razerCommandFor(cls, id);
  if (!cmd) return blockVerdict(`class ${hex2(cls)} id ${hex2(id)}`, "unknown", "Not on SYNQ's list of known-safe Razer commands.");
  const c = CMD[cmd];
  const bad = (why: string) => blockVerdict(c.what, "shape", `${c.what}: ${why}.`);
  if (status !== 0 || rp0 !== 0 || rp1 !== 0 || proto !== 0 || f[89] !== 0) return bad("status / reserved bytes must be zero");
  if (!txAllowed(tx)) return bad(`transaction id ${hex2(tx)} is not one SYNQ uses`);
  if (size > ARGS_MAX) return bad("data size over 80");
  if (f[CRC_INDEX] !== crc(f)) return bad("checksum mismatch");
  if (!f.subarray(8 + size, CRC_INDEX).every((x) => x === 0)) return bad("bytes after the data size must be zero");
  const why = CHECKS[cmd](f.subarray(8, 8 + size), size);
  if (why) return bad(why);
  return okVerdict(c.what, c.kind);
}

export const razerGuard: CommandGuard = {
  classify(report: OutgoingReport): Verdict {
    if (report.type !== "feature") return blockVerdict("output report", "shape", "Razer control collections take feature reports only.");
    if (report.reportId !== 0) return blockVerdict("report id", "shape", "Razer control reports use report id 0.");
    return classifyRazerFrame(report.data);
  },
  blocked: RAZER_BLOCKED_SUMMARY,
};

/**
 * What src-tauri/src/hid.rs must allow for this layer (nothing more). Same shape as the existing
 * Razer mouse rule: `Access::FeatureOnly` on the Consumer Control collection, report id 0, 90 bytes,
 * SET/GET_FEATURE only, never input reports, never output reports, plus the frame check above
 * (razer-frames.txt) in place of the generic `razer_frame_allowed`. These PIDs are not in
 * OpenMouse's table, so `razer_feature_only()` (which requires an OpenMouse filter) does not cover them:
 * they need their own PID list.
 */
export const RAZER_BRIDGE: readonly BridgeAllowance[] = [
  {
    vendorId: RAZER_VID,
    productIds: RAZER_KEYBOARDS.filter((m) => m.tier !== "readOnly").map((m) => m.pid),
    usagePage: 0x000c,
    usage: 0x0001,
    access: "featureOnly",
    reportIds: [0],
    length: REPORT_LEN,
    note: "Huntsman analog/HE keyboards (Synapse Web). Usage 0x0001 assumed: Synapse only filters on usage page 0x0C (+ feature reports); confirm with hid_list on a real board.",
  },
  {
    vendorId: RAZER_VID,
    productIds: RAZER_KEYBOARDS.filter((m) => m.tier === "readOnly").map((m) => m.pid),
    usagePage: 0x000c,
    usage: 0x0001,
    access: "featureOnly",
    reportIds: [0],
    length: REPORT_LEN,
    note: "Huntsman V3 Pro / TKL (desktop-Synapse only): reads only in SYNQ; collection unconfirmed.",
  },
  {
    vendorId: RAZER_VID,
    productIds: RAZER_MICE.map((m) => m.pid),
    usagePage: 0x000c,
    usage: 0x0001,
    access: "featureOnly",
    reportIds: [0],
    length: REPORT_LEN,
    note: "Viper V4 HyperSpeed / DeathAdder V4 HyperSpeed (cable and dongle share the PID). Synapse filter {usagePage:12, usage:1}.",
  },
];

/** PIDs recognised but never opened (Bluetooth paths, older analog generation). */
export const RAZER_NEVER_OPEN: readonly number[] = RAZER_DETECT_ONLY.map((d) => d.pid);

/** Sanity: the feature-only list equals the bridge allowances. */
export const RAZER_BRIDGE_PIDS: readonly number[] = RAZER_FEATURE_ONLY_PIDS;
