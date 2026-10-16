// Razer 90-byte control-report codec for the Huntsman analog / HE keyboards and the Razer mice OpenMouse
// lacks. Pure encode/decode: no transport, no device access. Every frame this file builds passes the
// allowlist in guard.ts before it can leave (GuardedChannel), and the Rust bridge repeats that check.
//
// Wire format (identical in openrazer driver_razercommon.h `struct razer_report`, GPL-2.0-or-later, and
// Synapse Web rzDevice25 `_createDataSend`):
//   byte 0      status (0 on requests; replies: 1 busy, 2 ok, 3 failed, 4 timeout, 5 not supported)
//   byte 1      transaction id (rolling 0..30 in Synapse Web; echoed by the device)
//   bytes 2..3  remaining packets (0), byte 4 protocol type (0)
//   byte 5      data size (bytes of arguments that matter)
//   byte 6/7    command class / command id (GET = SET | 0x80)
//   bytes 8..87 arguments (80)
//   byte 88     XOR of bytes 2..87, byte 89 reserved (0)
// Synapse Web copies only `data size` argument bytes into the report, so everything after them is zero.
//
// Command layouts were read from Synapse Web's per-product bundles (https://synapse.razer.com/products/
// <pid>/static/js/main.*.js, read 2026-10-13; docs only, no code copied): the class-2 command table
// module (`[size, class, id]` triples with "Get/Set ..." names) and the rzDevice25 helpers that fill the
// arguments. Each encoder names the helper it follows. Multi-byte values are big-endian (Synapse `E4` =
// value >> 8, `l7` = value & 0xff, `Jz(hi, lo)`).

import { RAW_PER_MM, RAW_STEP, RAZER_ALL_KEYS, RAZER_VALID_KEY_IDS } from "./devices.ts";

export const REPORT_LEN = 90;
export const ARGS_MAX = 80;
export const CRC_INDEX = 88;

export const STATUS = { new: 0x00, busy: 0x01, ok: 0x02, failed: 0x03, timeout: 0x04, unsupported: 0x05 } as const;

export interface RazerCommand {
  cls: number;
  id: number;
  /** Synapse Web's default data size for the command (first byte of its `[size, class, id]` triple). */
  size: number;
  kind: "read" | "write";
  what: string;
}

/**
 * Every command SYNQ can build. Nothing outside this table can be framed (`frame()` refuses), and
 * guard.ts accepts nothing outside it either. Names and sizes as in Synapse Web's tables.
 */
export const CMD = {
  // class 0x00: device
  firmware: { cls: 0x00, id: 0x81, size: 2, kind: "read", what: "Get Firmware Version" },
  serial: { cls: 0x00, id: 0x82, size: 22, kind: "read", what: "Get Serial Number" },
  pollingGet: { cls: 0x00, id: 0xc0, size: 2, kind: "read", what: "Get USB High Speed Polling Period" },
  pollingSet: { cls: 0x00, id: 0x40, size: 2, kind: "write", what: "Set USB High Speed Polling Period" },
  // class 0x05: onboard profiles (read the list, switch the active one; never create/delete/reset)
  profileCount: { cls: 0x05, id: 0x80, size: 1, kind: "read", what: "Get Number of Profiles" },
  profileList: { cls: 0x05, id: 0x81, size: 80, kind: "read", what: "Get Profiles ID List" },
  profileActiveGet: { cls: 0x05, id: 0x84, size: 1, kind: "read", what: "Get Active Profile ID" },
  profileActiveSet: { cls: 0x05, id: 0x04, size: 1, kind: "write", what: "Set Active Profile ID" },
  // class 0x02: analog keys (keyboards)
  actuationGet: { cls: 0x02, id: 0x99, size: 80, kind: "read", what: "Get Multi Analog Key Actuation Point" },
  actuationSet: { cls: 0x02, id: 0x19, size: 80, kind: "write", what: "Set Multi Analog Key Actuation Point" },
  rapidTriggerGet: { cls: 0x02, id: 0x9a, size: 80, kind: "read", what: "Get Multi Analog Key Rapid Trigger" },
  rapidTriggerSet: { cls: 0x02, id: 0x1a, size: 80, kind: "write", what: "Set Multi Analog Key Rapid Trigger" },
  bottomDeadZoneGet: { cls: 0x02, id: 0xa8, size: 2, kind: "read", what: "Get Analog Key Bottom Dead-Zone Value" },
  bottomDeadZoneSet: { cls: 0x02, id: 0x28, size: 2, kind: "write", what: "Set Analog Key Bottom Dead-Zone Value" },
  snapTapGet: { cls: 0x02, id: 0xa7, size: 15, kind: "read", what: "Get Snap Tap Ctrl" },
  snapTapSet: { cls: 0x02, id: 0x27, size: 15, kind: "write", what: "Set Snap Tap Ctrl" },
  singleSnapTapGet: { cls: 0x02, id: 0xac, size: 11, kind: "read", what: "Get Single-key Snap Tap Ctrl" },
  singleSnapTapSet: { cls: 0x02, id: 0x2c, size: 11, kind: "write", what: "Set Single-key Snap Tap Ctrl" },
  dualPriorityGet: { cls: 0x02, id: 0xb1, size: 7, kind: "read", what: "Get Dual Keypress Priority" },
  dualPrioritySet: { cls: 0x02, id: 0x31, size: 7, kind: "write", what: "Set Dual Keypress Priority" },
  // class 0x0F: Chroma brightness (rzDevice25 "Get/Set Chroma Brightness", [3, 0x0F, 0x84/0x04])
  brightnessGet: { cls: 0x0f, id: 0x84, size: 3, kind: "read", what: "Get Chroma Brightness" },
  brightnessSet: { cls: 0x0f, id: 0x04, size: 3, kind: "write", what: "Set Chroma Brightness" },
  // class 0x04: DPI stages (mice)
  dpiStagesGet: { cls: 0x04, id: 0x86, size: 80, kind: "read", what: "Get Profile DPI Class Data" },
  dpiStagesSet: { cls: 0x04, id: 0x06, size: 80, kind: "write", what: "Set Profile DPI Class Data" },
  // class 0x07: battery (mice)
  batteryGet: { cls: 0x07, id: 0x80, size: 2, kind: "read", what: "Get Battery Level" },
  chargingGet: { cls: 0x07, id: 0x84, size: 2, kind: "read", what: "Get Device Charging Status" },
  // class 0x0B: proximity sensor lift setting (mice; Synapse's orca5Plus "smart tracking" engine)
  liftGet: { cls: 0x0b, id: 0x8b, size: 4, kind: "read", what: "Get Proximity Sensor Lift Setting" },
  liftSet: { cls: 0x0b, id: 0x0b, size: 4, kind: "write", what: "Set Proximity Sensor Lift Setting" },
  proximityStateSet: { cls: 0x0b, id: 0x03, size: 3, kind: "write", what: "Set Proximity Sensor State" },
} as const satisfies Record<string, RazerCommand>;

export type CmdName = keyof typeof CMD;

/** One request before framing: which command, its argument bytes and the data size to declare. */
export interface Request {
  cmd: CmdName;
  args: Uint8Array;
  dataSize: number;
}

export interface Reply {
  status: number;
  tx: number;
  dataSize: number;
  cls: number;
  id: number;
  /** The `dataSize` argument bytes. */
  data: Uint8Array;
  crcOk: boolean;
}

/** Profile / class ids SYNQ sends. Razer onboard profiles are small ids (Synapse slots 1..6). */
export const MAX_PROFILE_ID = 8;
/** Per-packet entry limits [SW class-2 module: pe = 15, Te = 13, Ae = 19]. */
export const ACTUATION_PER_PACKET = 15;
export const RT_PER_PACKET = 13;
export const SNAP_TAP_MAX_PAIRS = 4;
export const SINGLE_SNAP_MAX_KEYS = 4;
export const DUAL_PRIORITY_MAX_KEYS = 4;
export const DPI_MAX_STAGES = 5;
/** Release threshold floor [SW `thresholdH: Math.max(actuation - 1638, 256)`]. */
export const RELEASE_MIN_RAW = 256;
export const ACTUATION_MIN_RAW = 1638;
export const ACTUATION_MAX_RAW = 65520;

/** Snap tap pair modes [SW: LAST_INPUT 0, PRIO_LEFT 1, PRIO_RIGHT 2, NEUTRAL 3, COMPARE_LEVEL 4]. */
export const SNAP_TAP_MODE = { last: 0, priorityA: 1, priorityB: 2, neutral: 3, deeper: 4 } as const;
export type SnapTapMode = keyof typeof SNAP_TAP_MODE;

/** High-speed polling codes [SW enum Mt: RATE_8000Hz 1 ... RATE_125Hz 64]. */
export const POLL_CODE: Readonly<Record<number, number>> = { 8000: 0x01, 4000: 0x02, 2000: 0x04, 1000: 0x08, 500: 0x10, 250: 0x20, 125: 0x40 };
export const POLL_HZ: Readonly<Record<number, number>> = Object.fromEntries(Object.entries(POLL_CODE).map(([hz, code]) => [code, Number(hz)]));

/** Lift modes [SW CALIBRATION_LIFT_MODE_ENUM]; SYNQ only ever writes Universal_Lift_Cut_off (1). */
export const LIFT_MODE = { universalCutOff: 1, universalHysteresis: 2, presetCutOff: 3, presetHysteresis: 4, manualCutOff: 5, manualHysteresis: 6 } as const;
/** Smart-tracking engine ids [SW SURFACE_CALIBRATION_CLASS_ID 0, CALIBRATION_SENSOR_ID.Avago_Proximity_sensor 4]. */
export const PROXIMITY_CLASS = 0;
export const PROXIMITY_SENSOR = 4;

export class RazerCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RazerCodecError";
  }
}

const fail = (msg: string): never => {
  throw new RazerCodecError(msg);
};

const u16 = (hi: number, lo: number) => ((hi & 0xff) << 8) | (lo & 0xff);
const isByte = (v: number) => Number.isInteger(v) && v >= 0 && v <= 0xff;
const isProfile = (v: number) => Number.isInteger(v) && v >= 0 && v <= MAX_PROFILE_ID;
const checkProfile = (p: number) => (isProfile(p) ? p : fail(`Profile id ${p} is outside 0..${MAX_PROFILE_ID}.`));
const checkKey = (k: number) => (RAZER_VALID_KEY_IDS.has(k) ? k : fail(`Key id ${k} is not a Razer key id SYNQ knows.`));

// ---------------------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------------------

export function crc(report: Uint8Array): number {
  let c = 0;
  for (let i = 2; i < CRC_INDEX; i++) c ^= report[i] ?? 0;
  return c;
}

const req = (cmd: CmdName, args: ArrayLike<number> = [], dataSize: number = CMD[cmd].size): Request => {
  if (!Number.isInteger(dataSize) || dataSize < 0 || dataSize > ARGS_MAX) fail(`Data size ${dataSize} is outside 0..${ARGS_MAX}.`);
  if (args.length > dataSize) fail(`${CMD[cmd].what}: ${args.length} argument bytes for a data size of ${dataSize}.`);
  const a = new Uint8Array(dataSize);
  for (let i = 0; i < args.length; i++) {
    const v = args[i];
    if (!isByte(v)) fail(`${CMD[cmd].what}: argument ${i} (${v}) is not a byte.`);
    a[i] = v;
  }
  return { cmd, args: a, dataSize };
};

/**
 * Builds the 90 data bytes of one feature report (report id 0 is separate). Only commands in CMD can be
 * framed: there is no way to frame an arbitrary class/id from this module.
 */
export function frame(r: Request, tx: number): Uint8Array {
  const c: RazerCommand | undefined = (CMD as Record<string, RazerCommand>)[r.cmd];
  if (!c) fail(`Unknown command ${String(r.cmd)}.`);
  if (!isByte(tx)) fail(`Transaction id ${tx} is not a byte.`);
  if (r.args.length !== r.dataSize) fail("Argument length must equal the data size.");
  const f = new Uint8Array(REPORT_LEN);
  f[1] = tx;
  f[5] = r.dataSize;
  f[6] = c!.cls;
  f[7] = c!.id;
  f.set(r.args, 8);
  f[CRC_INDEX] = crc(f);
  return f;
}

/** Parses a GET_FEATURE reply (90 bytes, or 91 with a leading report id 0). */
export function parseReply(bytes: Uint8Array): Reply {
  let b = bytes;
  if (b.length === REPORT_LEN + 1 && b[0] === 0) b = b.subarray(1);
  if (b.length !== REPORT_LEN) fail(`Razer replies are ${REPORT_LEN} bytes (got ${bytes.length}).`);
  const dataSize = Math.min(b[5], ARGS_MAX);
  return { status: b[0], tx: b[1], dataSize, cls: b[6], id: b[7], data: b.slice(8, 8 + dataSize), crcOk: b[CRC_INDEX] === crc(b) };
}

// ---------------------------------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------------------------------

/** mm → raw, on Synapse's 0.1 mm grid (multiples of 1638). */
export function mmToRaw(mm: number): number {
  if (!Number.isFinite(mm)) fail("Distance must be a number.");
  return Math.round(mm * 10 + 1e-9) * RAW_STEP;
}

/** raw → mm, rounded to 0.01 mm (raw values written by other software need not sit on the 0.1 grid). */
export function rawToMm(raw: number): number {
  return Math.round((raw / RAW_PER_MM) * 100) / 100;
}

/** Synapse's release point for an actuation point: 0.1 mm above it, never below 256 raw. */
export function releaseFor(actuationRaw: number): number {
  return Math.max(actuationRaw - RAW_STEP, RELEASE_MIN_RAW);
}

// ---------------------------------------------------------------------------------------------------
// Device / profiles
// ---------------------------------------------------------------------------------------------------

export const encFirmware = (): Request => req("firmware");
export const decFirmware = (d: Uint8Array): string => `${d[0] ?? 0}.${d[1] ?? 0}`;

export const encSerial = (): Request => req("serial");
export function decSerial(d: Uint8Array): string {
  let s = "";
  for (const c of d) if (c >= 32 && c < 127) s += String.fromCharCode(c);
  return s.trim();
}

export const encProfileCount = (): Request => req("profileCount");
export const decProfileCount = (d: Uint8Array): number => d[0] ?? 0;
export const encProfileList = (): Request => req("profileList");
/** [SW getProfileIDList: total at 0, ids from 1]. */
export const decProfileList = (d: Uint8Array): number[] => Array.from(d.subarray(1, 1 + Math.min(d[0] ?? 0, d.length - 1)));
export const encActiveProfileGet = (): Request => req("profileActiveGet");
export const decActiveProfile = (d: Uint8Array): number => d[0] ?? 0;
export function encActiveProfileSet(id: number): Request {
  if (!Number.isInteger(id) || id < 1 || id > MAX_PROFILE_ID) fail(`Profile id ${id} is outside 1..${MAX_PROFILE_ID}.`);
  return req("profileActiveSet", [id]);
}

// ---------------------------------------------------------------------------------------------------
// Polling (class 0x00 0xC0 / 0x40): [profile, code]  [SW Ci/cH, decoder W reads data[1]]
// ---------------------------------------------------------------------------------------------------

export const encPollingGet = (profile: number): Request => req("pollingGet", [checkProfile(profile)]);
export function encPollingSet(profile: number, hz: number): Request {
  const code = POLL_CODE[hz] ?? fail(`${hz} Hz is not a Razer polling rate.`);
  return req("pollingSet", [checkProfile(profile), code]);
}
export function decPolling(d: Uint8Array): number | null {
  return POLL_HZ[d[1] ?? 0] ?? null;
}

// ---------------------------------------------------------------------------------------------------
// Actuation (class 0x02 0x99 / 0x19)  [SW setMultiAnalogKeyActuationPoint(0, profile, list)]
//   args: [dataType 0, profile, then per key: keyId, thresholdH (release) u16 BE, thresholdL (actuation) u16 BE]
//   data size 2 + 5n, n <= 15. thresholdL is the press point; thresholdH the release point above it.
// ---------------------------------------------------------------------------------------------------

export interface KeyActuation {
  keyId: number;
  actuationRaw: number;
  releaseRaw: number;
}

export function encActuationGet(profile: number, keyIds: readonly number[]): Request {
  if (keyIds.length < 1 || keyIds.length > ACTUATION_PER_PACKET) fail(`1..${ACTUATION_PER_PACKET} keys per actuation read.`);
  const a = [0, checkProfile(profile)];
  keyIds.forEach((k, i) => (a[2 + 5 * i] = checkKey(k)));
  const n = 2 + 5 * keyIds.length;
  return req("actuationGet", Array.from({ length: n }, (_, i) => a[i] ?? 0), n);
}

export function encActuationSet(profile: number, entries: readonly KeyActuation[], maxRaw: number = ACTUATION_MAX_RAW): Request {
  if (entries.length < 1 || entries.length > ACTUATION_PER_PACKET) fail(`1..${ACTUATION_PER_PACKET} keys per actuation write.`);
  const all = entries.some((e) => e.keyId === RAZER_ALL_KEYS);
  if (all && entries.length !== 1) fail("Key id 255 (every key) must be written alone.");
  const a: number[] = [0, checkProfile(profile)];
  for (const e of entries) {
    if (e.keyId !== RAZER_ALL_KEYS) checkKey(e.keyId);
    if (!Number.isInteger(e.actuationRaw) || e.actuationRaw < ACTUATION_MIN_RAW || e.actuationRaw > Math.min(maxRaw, ACTUATION_MAX_RAW))
      fail(`Actuation ${rawToMm(e.actuationRaw)} mm is outside ${rawToMm(ACTUATION_MIN_RAW)}..${rawToMm(Math.min(maxRaw, ACTUATION_MAX_RAW))} mm.`);
    if (!Number.isInteger(e.releaseRaw) || e.releaseRaw < RELEASE_MIN_RAW || e.releaseRaw > e.actuationRaw) fail("The release point must sit between 256 raw and the actuation point.");
    a.push(e.keyId, e.releaseRaw >> 8, e.releaseRaw & 0xff, e.actuationRaw >> 8, e.actuationRaw & 0xff);
  }
  return req("actuationSet", a, a.length);
}

export function decActuation(r: Reply): KeyActuation[] {
  const out: KeyActuation[] = [];
  for (let i = 2; i + 4 < r.data.length; i += 5) {
    out.push({ keyId: r.data[i], releaseRaw: u16(r.data[i + 1], r.data[i + 2]), actuationRaw: u16(r.data[i + 3], r.data[i + 4]) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Rapid trigger (class 0x02 0x9A / 0x1A)  [SW setMultiAnalogKeyRapidTrigger(0, profile, list)]
//   per key: keyId, enabled, upSensitivity u16 BE (release), downSensitivity u16 BE (press); n <= 13.
//   Units: FW = 16380 * mm [SW convertUIRapidTriggerToFW].
// ---------------------------------------------------------------------------------------------------

export interface KeyRapidTrigger {
  keyId: number;
  enabled: boolean;
  pressRaw: number;
  releaseRaw: number;
}

export const RT_MIN_RAW = RAW_STEP; // 0.1 mm
export const RT_MAX_RAW = 2 * RAW_PER_MM; // 2.0 mm: SYNQ's ceiling (Synapse's slider bounds weren't in the bundles read)

export function encRapidTriggerGet(profile: number, keyIds: readonly number[]): Request {
  if (keyIds.length < 1 || keyIds.length > RT_PER_PACKET) fail(`1..${RT_PER_PACKET} keys per rapid-trigger read.`);
  const a = [0, checkProfile(profile)];
  keyIds.forEach((k, i) => (a[2 + 6 * i] = checkKey(k)));
  const n = 2 + 6 * keyIds.length;
  return req("rapidTriggerGet", Array.from({ length: n }, (_, i) => a[i] ?? 0), n);
}

export function encRapidTriggerSet(profile: number, entries: readonly KeyRapidTrigger[]): Request {
  if (entries.length < 1 || entries.length > RT_PER_PACKET) fail(`1..${RT_PER_PACKET} keys per rapid-trigger write.`);
  if (entries.some((e) => e.keyId === RAZER_ALL_KEYS) && entries.length !== 1) fail("Key id 255 (every key) must be written alone.");
  const a: number[] = [0, checkProfile(profile)];
  for (const e of entries) {
    if (e.keyId !== RAZER_ALL_KEYS) checkKey(e.keyId);
    for (const v of [e.pressRaw, e.releaseRaw])
      if (!Number.isInteger(v) || v < RT_MIN_RAW || v > RT_MAX_RAW) fail(`Rapid-trigger sensitivity ${rawToMm(v)} mm is outside ${rawToMm(RT_MIN_RAW)}..${rawToMm(RT_MAX_RAW)} mm.`);
    a.push(e.keyId, e.enabled ? 1 : 0, e.releaseRaw >> 8, e.releaseRaw & 0xff, e.pressRaw >> 8, e.pressRaw & 0xff);
  }
  return req("rapidTriggerSet", a, a.length);
}

export function decRapidTrigger(r: Reply): KeyRapidTrigger[] {
  const out: KeyRapidTrigger[] = [];
  for (let i = 2; i + 5 < r.data.length; i += 6) {
    out.push({ keyId: r.data[i], enabled: r.data[i + 1] === 1, releaseRaw: u16(r.data[i + 2], r.data[i + 3]), pressRaw: u16(r.data[i + 4], r.data[i + 5]) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Bottom dead zone (class 0x02 0xA8 / 0x28): [profile, level]  [SW getAnalogKeyBottomDeadZoneValue]
// ---------------------------------------------------------------------------------------------------

export const BOTTOM_DZ_MAX_LEVEL = 20;
export const encBottomDeadZoneGet = (profile: number): Request => req("bottomDeadZoneGet", [checkProfile(profile)]);
export function encBottomDeadZoneSet(profile: number, level: number): Request {
  if (!Number.isInteger(level) || level < 1 || level > BOTTOM_DZ_MAX_LEVEL) fail(`Bottom dead-zone level ${level} is outside 1..${BOTTOM_DZ_MAX_LEVEL}.`);
  return req("bottomDeadZoneSet", [checkProfile(profile), level]);
}
export const decBottomDeadZone = (d: Uint8Array): number => d[1] ?? 0;

// ---------------------------------------------------------------------------------------------------
// Snap tap (class 0x02 0xA7 / 0x27): [profile, pairs, enabled, (key1, key2, mode) x pairs], size 15
// [SW setSnapTapCtrl(profile, numPairs, enabled, payload); payload built from analogKeyID, which equals
// the fwID on isFWAnalogMapping boards]
// ---------------------------------------------------------------------------------------------------

export interface SnapTapPair {
  a: number;
  b: number;
  mode: number;
}
export interface SnapTapState {
  enabled: boolean;
  pairs: SnapTapPair[];
}

export const encSnapTapGet = (profile: number): Request => req("snapTapGet", [checkProfile(profile)]);
export function encSnapTapSet(profile: number, s: SnapTapState): Request {
  if (s.pairs.length > SNAP_TAP_MAX_PAIRS) fail(`At most ${SNAP_TAP_MAX_PAIRS} snap-tap pairs.`);
  const a: number[] = [checkProfile(profile), s.pairs.length, s.enabled ? 1 : 0];
  for (const p of s.pairs) {
    checkKey(p.a);
    checkKey(p.b);
    if (p.a === p.b) fail("A snap-tap pair needs two different keys.");
    if (!Number.isInteger(p.mode) || p.mode < 0 || p.mode > SNAP_TAP_MODE.deeper) fail(`Snap-tap mode ${p.mode} is outside 0..4.`);
    a.push(p.a, p.b, p.mode);
  }
  return req("snapTapSet", a);
}
export function decSnapTap(d: Uint8Array): SnapTapState {
  const n = Math.min(d[1] ?? 0, SNAP_TAP_MAX_PAIRS);
  const pairs: SnapTapPair[] = [];
  for (let i = 0; i < n; i++) pairs.push({ a: d[3 + 3 * i] ?? 0, b: d[4 + 3 * i] ?? 0, mode: d[5 + 3 * i] ?? 0 });
  return { enabled: d[2] === 1, pairs };
}

// ---------------------------------------------------------------------------------------------------
// Single-key snap tap (class 0x02 0xAC / 0x2C): [profile, keys, enabled, (keyId, keyCode) x keys], size 11
// keyCode's meaning isn't documented in the bundles read: SYNQ only re-sends pairs it read back.
// ---------------------------------------------------------------------------------------------------

export interface SingleSnapTapState {
  enabled: boolean;
  keys: { keyId: number; keyCode: number }[];
}
export const encSingleSnapTapGet = (profile: number): Request => req("singleSnapTapGet", [checkProfile(profile)]);
export function encSingleSnapTapSet(profile: number, s: SingleSnapTapState): Request {
  if (s.keys.length > SINGLE_SNAP_MAX_KEYS) fail(`At most ${SINGLE_SNAP_MAX_KEYS} single-key snap-tap keys.`);
  const a: number[] = [checkProfile(profile), s.keys.length, s.enabled ? 1 : 0];
  for (const k of s.keys) {
    checkKey(k.keyId);
    if (!isByte(k.keyCode)) fail("Key code must be a byte.");
    a.push(k.keyId, k.keyCode);
  }
  return req("singleSnapTapSet", a);
}
export function decSingleSnapTap(d: Uint8Array): SingleSnapTapState {
  const n = Math.min(d[1] ?? 0, SINGLE_SNAP_MAX_KEYS);
  const keys: { keyId: number; keyCode: number }[] = [];
  for (let i = 0; i < n; i++) keys.push({ keyId: d[3 + 2 * i] ?? 0, keyCode: d[4 + 2 * i] ?? 0 });
  return { enabled: d[2] === 1, keys };
}

// ---------------------------------------------------------------------------------------------------
// Dual keypress priority (class 0x02 0xB1 / 0x31): [profile, count, enabled, key x 4 (zero-padded)], size 7
// ---------------------------------------------------------------------------------------------------

export interface DualPriorityState {
  enabled: boolean;
  keys: number[];
}
export const encDualPriorityGet = (profile: number): Request => req("dualPriorityGet", [checkProfile(profile)]);
export function encDualPrioritySet(profile: number, s: DualPriorityState): Request {
  if (s.keys.length > DUAL_PRIORITY_MAX_KEYS) fail(`At most ${DUAL_PRIORITY_MAX_KEYS} dual-priority keys.`);
  if (new Set(s.keys).size !== s.keys.length) fail("Dual-priority keys must be different.");
  const a = [checkProfile(profile), s.keys.length, s.enabled ? 1 : 0, 0, 0, 0, 0];
  s.keys.forEach((k, i) => (a[3 + i] = checkKey(k)));
  return req("dualPrioritySet", a);
}
export function decDualPriority(d: Uint8Array): DualPriorityState {
  const n = Math.min(d[1] ?? 0, DUAL_PRIORITY_MAX_KEYS);
  return { enabled: d[2] === 1, keys: Array.from(d.subarray(3, 3 + n)) };
}

// ---------------------------------------------------------------------------------------------------
// Brightness (class 0x0F 0x84 / 0x04): [profile, region (0 = all), value 0..255]
// [SW rzDevice25 setBrightness: r[0]=profileId, r[1]=regionId, r[2]=floor(percent/100*255)]
// ---------------------------------------------------------------------------------------------------

export const REGION_ALL = 0;
export const encBrightnessGet = (profile: number): Request => req("brightnessGet", [checkProfile(profile), REGION_ALL]);
export function encBrightnessSet(profile: number, percent: number): Request {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) fail("Brightness is 0..100 %.");
  return req("brightnessSet", [checkProfile(profile), REGION_ALL, Math.floor((percent / 100) * 255)]);
}
export const decBrightness = (d: Uint8Array): number => Math.round(((d[2] ?? 0) * 100) / 255);

// ---------------------------------------------------------------------------------------------------
// DPI stages (class 0x04 0x86 / 0x06)  [SW rzDevice25 getDPIStages / setProfileDPIClassData]
//   set args: [profile, activeStage (1-based), count, then per stage: id, x u16 BE, y u16 BE, z u16 BE (0)]
//   data size 3 + 7n. The reply of the read has the same layout.
// ---------------------------------------------------------------------------------------------------

export interface DpiStage {
  id: number;
  x: number;
  y: number;
}
export interface DpiStages {
  active: number;
  stages: DpiStage[];
}
export const DPI_GUARD_MIN = 50;
export const DPI_GUARD_MAX = 50000;

export const encDpiStagesGet = (profile: number): Request => req("dpiStagesGet", [checkProfile(profile)]);
export function encDpiStagesSet(profile: number, s: DpiStages, range: { min: number; max: number } = { min: DPI_GUARD_MIN, max: DPI_GUARD_MAX }): Request {
  const n = s.stages.length;
  if (n < 1 || n > DPI_MAX_STAGES) fail(`1..${DPI_MAX_STAGES} DPI stages.`);
  if (!Number.isInteger(s.active) || s.active < 1 || s.active > n) fail(`Active stage ${s.active} is outside 1..${n}.`);
  const a: number[] = [checkProfile(profile), s.active, n];
  for (const st of s.stages) {
    if (!Number.isInteger(st.id) || st.id < 0 || st.id > 8) fail(`Stage id ${st.id} is outside 0..8.`);
    for (const v of [st.x, st.y]) if (!Number.isInteger(v) || v < range.min || v > range.max) fail(`DPI ${v} is outside ${range.min}..${range.max}.`);
    a.push(st.id, st.x >> 8, st.x & 0xff, st.y >> 8, st.y & 0xff, 0, 0);
  }
  return req("dpiStagesSet", a, a.length);
}
export function decDpiStages(r: Reply): DpiStages {
  const d = r.data;
  const n = Math.min(d[2] ?? 0, DPI_MAX_STAGES);
  const stages: DpiStage[] = [];
  for (let i = 0; i < n; i++) {
    const o = 3 + 7 * i;
    if (o + 4 >= d.length) break;
    stages.push({ id: d[o], x: u16(d[o + 1], d[o + 2]), y: u16(d[o + 3], d[o + 4]) });
  }
  return { active: d[1] ?? 0, stages };
}

// ---------------------------------------------------------------------------------------------------
// Battery (class 0x07 0x80 / 0x84): data[1] = level 0..255 / charging flag  [SW batteryLevel = data[1]/255]
// ---------------------------------------------------------------------------------------------------

export const encBattery = (): Request => req("batteryGet");
export const decBattery = (d: Uint8Array): number => Math.round(((d[1] ?? 0) * 100) / 255);
export const encCharging = (): Request => req("chargingGet");
export const decCharging = (d: Uint8Array): boolean => (d[1] ?? 0) === 1;

// ---------------------------------------------------------------------------------------------------
// Lift-off (class 0x0B)  [SW orca5PlusCalibrationEngine.smartTracking: setProximitySensorState(0, 4, true)
// then setProximitySensorLiftSetting(0, 4, Universal_Lift_Cut_off, trackingDistance - 1)]
//   get args [class 0, sensor 4] -> reply [class, sensor, liftMode, liftHeight]; level = height + 1.
// The asymmetric ("preset hysteresis") path writes calibration-engine data and is not offered.
// ---------------------------------------------------------------------------------------------------

export const LIFT_MAX_HEIGHT = 9;
export const encLiftGet = (): Request => req("liftGet", [PROXIMITY_CLASS, PROXIMITY_SENSOR]);
export function encLiftSet(level: number): Request {
  const h = level - 1;
  if (!Number.isInteger(h) || h < 0 || h > LIFT_MAX_HEIGHT) fail(`Lift level ${level} is outside 1..${LIFT_MAX_HEIGHT + 1}.`);
  return req("liftSet", [PROXIMITY_CLASS, PROXIMITY_SENSOR, LIFT_MODE.universalCutOff, h]);
}
export const encProximityOn = (): Request => req("proximityStateSet", [PROXIMITY_CLASS, PROXIMITY_SENSOR, 1]);
export function decLift(d: Uint8Array): { mode: number; level: number; asymmetric: boolean } {
  return { mode: d[2] ?? 0, level: (d[3] ?? 0) + 1, asymmetric: d[2] === LIFT_MODE.presetHysteresis };
}
