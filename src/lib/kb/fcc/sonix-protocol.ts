// Sonix Hall-effect keyboard settings protocol (Fighting68 HE family: VTER / driveall firmware on a
// Sonix MCU, about 150 boards), as documented and implemented by Fighting Control Center (FCC).
//
// Derived from Fighting Control Center, https://github.com/shybruh/FightingControlCenter-FCC
// (commit 5cad2404661de383f21dca654300e88764f6bc89), Copyright (C) the FCC authors, licensed under the
// GNU General Public License v3.0 or later. This file is part of SYNQ and is distributed under the
// GNU AGPL v3 (GPL-3-compatible); it keeps FCC's notice. It is a re-implementation from FCC's
// documentation and code, not a copy of FCC's files.
//
// Evidence labels used below (all paths are inside the FCC repo):
//   [doc:N]   docs/PROTOCOL.md, line N
//   [proto]   app/src/hid/protocol.ts       [device] app/src/hid/device.ts
//   [codec]   app/src/hid/codec.ts          [store]  app/src/store.ts
//   [backup]  backups/baseline-2026-10-09-fw1.25.json, a full read of FCC's own Fighting68 (fw 1.25)
//   [fcc-hw]  FCC says it verified this on its Fighting68 (fw 1.25); nobody here has seen it
//   [inferred] follows from the above, never confirmed anywhere
// FCC is brand new and reverse-engineered: only the Fighting68 (0c45:8030) is verified by FCC itself,
// the other ~135 boards are "untested" there too. Nothing here has run against a real keyboard.
//
// Pure encode/decode and the safety allowlist. No transport, erasable TypeScript, so node runs the tests
// directly; the one import is the Advanced gate's pure check (src/lib/advanced/core.ts). Every frame must
// pass checkFrame() before it reaches a device; the session (sonix-session.ts) does that, and the Rust
// bridge repeats it (fixtures: fcc-frames.txt for the default path, sonix-frames-advanced.txt with grants).
import { granted, type AdvancedScope, type Grants } from "../../advanced/core.ts";

// =============================================================================================
// Wire format
// =============================================================================================

export const SONIX = {
  /** Config collection. Only wired boards answer on it. [doc:9][proto CONFIG_USAGE_PAGE/CONFIG_USAGE] */
  usagePage: 0xff68,
  usage: 0x61,
  /** Output and input reports, report id 0 (no id byte on the wire). [doc:10][transport.ts sendReport(0, ...)] */
  reportId: 0,
  /** Every frame is 64 bytes. [doc:10][proto PACKET_LEN] */
  length: 64,
  /** [0]=0xAA, [1]=cmd, [2]=len, [3..4]=offset LE, [5..7]=0, [8..63]=payload. [doc:14-20] */
  headerLength: 8,
  chunk: 56,
  magic: 0xaa,
  /** Unsolicited stream reports (calibration mode) start with 0x55 instead. [doc:69] */
  streamMagic: 0x55,
} as const;

/** Commands SYNQ sends. Reads are 0x10..0x18, writes 0x21..0x28 (region read | 0x10). [doc:32-42][proto REGIONS] */
export const CMD = {
  /** "Apply" after RT / profile writes: bulk [0,0,0,0]. [doc:57][device commit] */
  commit: 0x00,
  readInfo: 0x10,
  readSettings: 0x11,
  readKeys: 0x12,
  readLed: 0x13,
  readColors: 0x14,
  readMacros: 0x15,
  readFn: 0x16,
  readRt: 0x17,
  readDks: 0x18,
  writeSettings: 0x21,
  writeKeys: 0x22,
  writeLed: 0x23,
  writeColors: 0x24,
  writeMacros: 0x25,
  writeRt: 0x27,
  writeDks: 0x28,
} as const;

/**
 * Commands SYNQ never sends. Listed so they can be blocked by name; nothing here builds them.
 * Anything not on the allowlist is blocked too, including every command byte not named anywhere.
 */
export const FORBIDDEN_COMMANDS: ReadonlyMap<number, string> = new Map([
  [0x0f, "reset: [0x0F, 0xFF] is factory reset of every setting, [0x0F, 0x05] resets key-check state [doc:58-59][store factoryReset]"],
  [0x26, "Fn-layer write: the firmware ignores it and the official driver never sends it [doc:46-51]"],
  [0x62, "status: listed by FCC, never sent by FCC; meaning unconfirmed [doc:60]"],
  [0x64, "start travel calibration: streams raw sensor packets and recalibrates every key pressed [doc:61][doc:66-82]"],
  [0x65, "end calibration: saves the new calibration [doc:62][doc:82]"],
  [0x66, "unknown toggle next to 'Selectable Axles' in the official driver [doc:63]"],
  [0x67, "unknown toggle next to 'Selectable Axles' in the official driver [doc:63]"],
  [0xfb, "device-to-host sensor stream (calibration mode) [doc:72]"],
  [0xfc, "device-to-host link notice [doc:64]"],
]);

export type RegionName = "info" | "settings" | "keys" | "led" | "colors" | "macros" | "fn" | "rt" | "dks";

export interface RegionDef {
  read: number;
  /** null: never written by SYNQ (info is read-only; the Fn region is ignored by the firmware). */
  write: number | null;
  size: number;
  /** Bytes SYNQ writes from offset 0 (settings: 16 of 32). */
  writeLength: number;
}

/** [doc:32-42][proto REGIONS][proto SETTINGS_WRITE_LEN] */
export const REGIONS: Readonly<Record<RegionName, RegionDef>> = {
  info: { read: CMD.readInfo, write: null, size: 24, writeLength: 0 },
  settings: { read: CMD.readSettings, write: CMD.writeSettings, size: 32, writeLength: 16 },
  keys: { read: CMD.readKeys, write: CMD.writeKeys, size: 512, writeLength: 512 },
  led: { read: CMD.readLed, write: CMD.writeLed, size: 16, writeLength: 16 },
  colors: { read: CMD.readColors, write: CMD.writeColors, size: 512, writeLength: 512 },
  macros: { read: CMD.readMacros, write: CMD.writeMacros, size: 4008, writeLength: 4008 },
  fn: { read: CMD.readFn, write: null, size: 512, writeLength: 0 },
  rt: { read: CMD.readRt, write: CMD.writeRt, size: 1024, writeLength: 1024 },
  dks: { read: CMD.readDks, write: CMD.writeDks, size: 1024, writeLength: 1024 },
};

/** Read order of a full read, as FCC does it. [proto READ_ORDER] */
export const READ_ORDER: readonly RegionName[] = ["info", "settings", "keys", "led", "colors", "macros", "fn", "rt", "dks"];
/** Regions a host-side profile owns, in the order the official driver writes them, then commit. [doc:171-174][proto PROFILE_REGIONS] */
export const PROFILE_REGIONS: readonly RegionName[] = ["keys", "led", "colors", "macros", "rt", "dks"];

const REGION_BY_READ = new Map(Object.entries(REGIONS).map(([n, d]) => [d.read, n as RegionName]));
const REGION_BY_WRITE = new Map(Object.entries(REGIONS).filter(([, d]) => d.write !== null).map(([n, d]) => [d.write as number, n as RegionName]));
export const regionForCommand = (cmd: number): RegionName | null => REGION_BY_READ.get(cmd) ?? REGION_BY_WRITE.get(cmd) ?? null;

export const KEY_SLOTS = 128; // 4-byte bindings, 8-byte RT entries [doc:36][doc:41]
export const COLOR_SLOTS = 126; // [doc:38][codec withColor: id >= 126 skipped]
export const DKS_SLOTS = 64; // [doc:42][codec DKS_SLOTS]
export const MACRO_MAX = 100; // [doc:134][codec MACRO_MAX]
export const MACRO_INDEX_BYTES = 400; // [doc:134]
/** Largest full travel in FCC's catalog (0.01 mm); RT and actuation values above it are refused. */
export const MAX_TRAVEL = 400;

export type Frame = Uint8Array;

/**
 * The only forbidden commands an Advanced action can unlock, and which one: the travel calibration start
 * and save (0x64 / 0x65, "calibrate") and the factory reset [0x0F, 0xFF] (0x0F, "reset"). Everything else
 * in FORBIDDEN_COMMANDS stays blocked whatever is granted, including the key-check reset [0x0F, 0x05].
 * [doc:58-62]
 */
export const ADVANCED_COMMANDS: ReadonlyMap<number, AdvancedScope> = new Map<number, AdvancedScope>([
  [0x64, "calibrate"],
  [0x65, "calibrate"],
  [0x0f, "reset"],
]);

export const hex = (b: ArrayLike<number>, trim = true): string => {
  let end = b.length;
  if (trim) while (end > 1 && b[end - 1] === 0) end--;
  return Array.from({ length: end }, (_, i) => (b[i] ?? 0).toString(16).padStart(2, "0")).join(" ");
};

const u16 = (b: ArrayLike<number>, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const setU16 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
function checkInt(name: string, v: number, min: number, max: number) {
  if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`${name} must be a whole number from ${min} to ${max} (got ${v}).`);
}

/** One bulk frame: [0xAA, cmd, len, offset lo, offset hi, 0, 0, 0, payload...]. [doc:14-20][proto buildPacket] */
export function bulkFrame(cmd: number, offset: number, payload: ArrayLike<number>): Frame {
  checkInt("command", cmd, 0, 0xff);
  checkInt("offset", offset, 0, 0xffff);
  if (payload.length > SONIX.chunk) throw new RangeError(`payload too large: ${payload.length}`);
  const f = new Uint8Array(SONIX.length);
  f[0] = SONIX.magic;
  f[1] = cmd;
  f[2] = payload.length;
  f[3] = offset & 0xff;
  f[4] = (offset >> 8) & 0xff;
  for (let i = 0; i < payload.length; i++) {
    checkInt(`payload byte ${i}`, payload[i], 0, 0xff);
    f[SONIX.headerLength + i] = payload[i];
  }
  return f;
}

// =============================================================================================
// Requests
// =============================================================================================

/**
 * A region read, one frame per 56-byte chunk: offset and len set, payload zero. The reply echoes the
 * command and carries the data at [8, 8 + len). [doc:23-25][device readRegion]
 */
export function encodeRegionRead(name: RegionName): Frame[] {
  const { read, size } = REGIONS[name];
  const out: Frame[] = [];
  for (let off = 0; off < size; off += SONIX.chunk) out.push(bulkFrame(read, off, new Uint8Array(Math.min(SONIX.chunk, size - off))));
  return out;
}

/** One chunk of a region read (the session stops macro reads early, like FCC). */
export const encodeRegionReadChunk = (name: RegionName, offset: number): Frame =>
  bulkFrame(REGIONS[name].read, offset, new Uint8Array(Math.min(SONIX.chunk, REGIONS[name].size - offset)));

/** A region write in 56-byte chunks from offset 0; each chunk waits for its echo. [doc:23-24][device writeRegion] */
export function encodeRegionWrite(name: RegionName, data: Uint8Array): Frame[] {
  const { write, writeLength } = REGIONS[name];
  if (write === null) throw new Error(`${name} is never written by SYNQ.`);
  if (data.length < writeLength) throw new RangeError(`${name}: expected ${writeLength} bytes, got ${data.length}`);
  const out: Frame[] = [];
  for (let off = 0; off < writeLength; off += SONIX.chunk) out.push(bulkFrame(write, off, data.subarray(off, Math.min(off + SONIX.chunk, writeLength))));
  return out;
}

/**
 * Advanced only (checkFrame refuses these without a live token): start travel calibration, which streams
 * 0xFB sensor packets until the end frame; save and leave calibration; factory reset of every setting.
 * Single-command packets are [0xAA, cmd, arg 0..3, 0...]. [doc:57-62]
 */
export const encodeCalibrationStart = (): Frame => singleFrame(0x64);
export const encodeCalibrationEnd = (): Frame => singleFrame(0x65);
export const encodeFactoryReset = (): Frame => singleFrame(0x0f, 0xff);
function singleFrame(cmd: number, arg = 0): Frame {
  const f = new Uint8Array(SONIX.length);
  f[0] = SONIX.magic;
  f[1] = cmd;
  f[2] = arg;
  return f;
}

/** The "apply" frame after RT and profile writes. [doc:57][device commit][store writeNow] */
export const encodeCommit = (): Frame => bulkFrame(CMD.commit, 0, [0, 0, 0, 0]);

/** Regions after whose write FCC sends the commit frame (RT always; any profile switch). [store writeNow/activateProfile] */
export const needsCommit = (name: RegionName): boolean => name === "rt";

// =============================================================================================
// Replies
// =============================================================================================

export type InputKind = "reply" | "sensor" | "link-down" | "other";

/** What an input report is. Sensor packets only exist in calibration mode, which SYNQ never enters. [device handleReport] */
export function classifyInput(r: Uint8Array): InputKind {
  if (r.length < SONIX.headerLength) return "other";
  if (r[1] === 0xfb) return "sensor";
  if (r[1] === 0xfc && r[2] === 4) return "link-down";
  return "reply";
}

/**
 * One calibration-mode sensor packet (a 0xFB report, ~3,600 a second round-robin over the keys): which key,
 * whether it has a calibration, its resting reading, the deepest reading seen so far ("calibrated bottom",
 * which only ever gets deeper), the live reading, live travel in 0.01 mm and full travel in 0.1 mm.
 * Little endian. [doc:66-82]
 */
export interface SensorPacket {
  key: number;
  hasCalibration: boolean;
  top: number;
  bottom: number;
  live: number;
  /** 0.01 mm */
  travel: number;
  /** 0.01 mm (the packet carries 0.1 mm) */
  fullTravel: number;
}

export function decodeSensor(r: Uint8Array): SensorPacket | null {
  if (r.length < SONIX.length || r[0] !== SONIX.streamMagic || r[1] !== 0xfb) return null;
  return { key: r[2], hasCalibration: r[3] === 1, top: u16(r, 4), bottom: u16(r, 6) & 0x7fff, live: u16(r, 8), travel: u16(r, 10), fullTravel: r[12] * 10 };
}

/** FCC matches a reply by its command byte alone (verified on fw 1.25). [device handleReport/exchange][fcc-hw] */
export const isReplyTo = (request: Uint8Array, reply: Uint8Array): boolean => classifyInput(reply) === "reply" && reply[1] === request[1];

/** Data bytes of a read reply: [8, 8 + min(len, 56)). [proto parseReply] */
export function replyPayload(reply: Uint8Array): Uint8Array {
  return reply.slice(SONIX.headerLength, SONIX.headerLength + Math.min(reply[2] ?? 0, SONIX.chunk));
}

/** Offset echoed in a reply, when the firmware echoes it (FCC never relies on it). [proto parseReply][inferred] */
export const replyOffset = (reply: Uint8Array): number => u16(reply, 3);

/**
 * Bytes a write sets that the board may not read back. Lighting bytes 4, 14 and 15 are constants the
 * official driver writes (255, 0xAA, 0x55) [codec encodeLed], yet FCC's own Fighting68 reads them back
 * as 0 [backup]. Whether the firmware ever stores them is unknown, so read-back checks skip them.
 */
export const READBACK_IGNORE: Readonly<Partial<Record<RegionName, readonly number[]>>> = { led: [4, 14, 15] };

/** First written byte that reads back differently (ignoring READBACK_IGNORE), or -1. */
export function readBackMismatch(name: RegionName, written: Uint8Array, readBack: Uint8Array): number {
  const skip = READBACK_IGNORE[name] ?? [];
  for (let i = 0; i < REGIONS[name].writeLength; i++) if (!skip.includes(i) && written[i] !== readBack[i]) return i;
  return -1;
}

// =============================================================================================
// Device info (read only, 24 bytes) [doc:34][codec decodeInfo]
// =============================================================================================

export interface SonixInfo {
  /** "1.25" from [8..9]: BCD low byte + 100 x [9]. [codec decodeInfo] */
  firmware: string;
  macroCapacity: number;
  /** [17]; meaningful on wireless boards only. */
  battery: number;
  vendorId: number;
  productId: number;
  /** [20..21] switch model id, raw. [doc:34] */
  switchModel: number;
}

export function decodeInfo(i: Uint8Array): SonixInfo {
  const v = (i[8] & 0x0f) + 10 * ((i[8] & 0xf0) >> 4) + 100 * i[9];
  return {
    firmware: (v / 100).toFixed(2),
    macroCapacity: i[2] + ((i[3] & 0x7f) << 8),
    battery: i[17],
    vendorId: u16(i, 4),
    productId: u16(i, 6),
    switchModel: u16(i, 20),
  };
}

// =============================================================================================
// Keyboard settings (read 32 bytes, write the first 16) [doc:35][codec decodeSettings/encodeSettings]
// =============================================================================================

/** Polling codes (settings byte 5). 0 = never set, the firmware default (FCC: "firmware default"). [codec POLLING_RATES] */
export const POLL_CODE_TO_HZ: Readonly<Record<number, number>> = { 3: 1000, 5: 4000, 6: 8000 };
export const POLL_HZ = [1000, 4000, 8000] as const;
export const pollCodeForHz = (hz: number): number | null => Number(Object.entries(POLL_CODE_TO_HZ).find(([, v]) => v === hz)?.[0] ?? NaN) || null;

/** Settings byte offsets. [doc:35] */
export const SET = { sleep: 3, polling: 5, topDeadZone: 8, bottomDeadZone: 9, stability: 11, adaptiveCalibration: 14, allKeyWake: 15 } as const;
/** Bytes of the written half whose meaning nobody knows. They were all 0 on FCC's Fighting68 [backup]; SYNQ only ever writes them back unchanged, and the allowlist refuses anything else. */
export const SETTINGS_UNKNOWN_BYTES: readonly number[] = [0, 1, 2, 4, 6, 7, 10, 12, 13];

export interface SonixSettings {
  /** 0..30 minutes; 0 = firmware default. */
  sleepMinutes: number;
  pollCode: number;
  pollHz: number | null;
  /** Global dead zones, raw byte. Units unknown and FCC never writes them; SYNQ keeps them read-only. [doc:35] */
  topDeadZoneRaw: number;
  bottomDeadZoneRaw: number;
  stability: boolean;
  /** Read only in SYNQ: it changes how the firmware recalibrates keys. [codec Settings.adaptiveCalibration] */
  adaptiveCalibration: boolean;
  allKeyWake: boolean;
}

export function decodeSettings(s: Uint8Array): SonixSettings {
  return {
    sleepMinutes: s[SET.sleep],
    pollCode: s[SET.polling],
    pollHz: POLL_CODE_TO_HZ[s[SET.polling]] ?? null,
    topDeadZoneRaw: s[SET.topDeadZone],
    bottomDeadZoneRaw: s[SET.bottomDeadZone],
    stability: s[SET.stability] === 1,
    adaptiveCalibration: s[SET.adaptiveCalibration] === 1,
    allKeyWake: s[SET.allKeyWake] === 1,
  };
}

export interface SettingsPatch {
  sleepMinutes?: number;
  pollHz?: number;
  stability?: boolean;
  allKeyWake?: boolean;
}

/** New settings bytes from the bytes read: only the four user settings change. [codec encodeSettings] */
export function encodeSettings(prev: Uint8Array, p: SettingsPatch): Uint8Array {
  const out = prev.slice();
  if (p.sleepMinutes !== undefined) {
    checkInt("sleep minutes", p.sleepMinutes, 0, 30);
    out[SET.sleep] = p.sleepMinutes;
  }
  if (p.pollHz !== undefined) {
    const code = pollCodeForHz(p.pollHz);
    if (code === null) throw new RangeError(`Polling rate must be one of ${POLL_HZ.join(", ")} Hz (got ${p.pollHz}).`);
    out[SET.polling] = code;
  }
  if (p.stability !== undefined) out[SET.stability] = p.stability ? 1 : 0;
  if (p.allKeyWake !== undefined) out[SET.allKeyWake] = p.allKeyWake ? 1 : 0;
  return out;
}

/** Bytes of the written half SYNQ may change (the stateful guard in the session checks this). */
export const SETTINGS_USER_BYTES: readonly number[] = [SET.sleep, SET.polling, SET.stability, SET.allKeyWake];

/** Null when `next` differs from `prev` only in user settings; else why not. */
export function settingsChangeProblem(prev: Uint8Array, next: Uint8Array): string | null {
  for (let i = 0; i < REGIONS.settings.writeLength; i++) {
    if (prev[i] !== next[i] && !SETTINGS_USER_BYTES.includes(i)) return `settings byte ${i} would change (${prev[i]} -> ${next[i]}); SYNQ only changes sleep, polling, stability and wake.`;
  }
  return null;
}

// =============================================================================================
// Key bindings (4 bytes per key index, 128 indices) [doc:85-98][codec decodeBinding/encodeBinding]
// =============================================================================================

export type Binding =
  | { type: "default" }
  | { type: "key"; mods: number; code: number }
  | { type: "media"; usage: number }
  | { type: "mouse"; button: number }
  | { type: "wheel"; dir: 1 | 255 }
  | { type: "macro"; index: number; mode: 0 | 1 | 2; repeat: number }
  | { type: "dks"; slot: number }
  | { type: "modtap"; hold: number; tap: number; ms: number }
  | { type: "toggle"; code: number }
  | { type: "socd"; mode: number; key1: number; key2: number }
  | { type: "rs"; key1: number; key2: number }
  | { type: "unknown"; bytes: [number, number, number, number] };

export const BINDING_TYPE = { default: 0, mouse: 1, key: 2, media: 3, macro: 6, dks: 8, modtap: 9, toggle: 10, socd: 11, rs: 12 } as const;
/** Mouse button masks. [doc:90] */
export const MOUSE_BUTTONS = [1, 2, 4, 8, 16] as const;
/** SOCD modes: 3 last input wins ("snap tap"), 1 key 1 priority, 2 key 2 priority, 4 neutral. [doc:155][advanced.ts SOCD_MODES] */
export const SOCD_MODE = { lastInput: 3, key1: 1, key2: 2, neutral: 4 } as const;
export const SOCD_MODES: readonly number[] = [3, 1, 2, 4];
/** Highest HID keyboard usage a binding may carry (0xE7 = right GUI). */
export const MAX_HID = 0xe7;

export function decodeBinding(keys: Uint8Array, index: number): Binding {
  const [t, a, b, c] = keys.subarray(index * 4, index * 4 + 4);
  switch (t) {
    case 0:
      return { type: "default" };
    case 1:
      return a === 3 ? { type: "wheel", dir: b === 255 ? 255 : 1 } : { type: "mouse", button: b };
    case 2:
      return { type: "key", mods: a, code: b };
    case 3:
      return { type: "media", usage: a | (b << 8) };
    case 6:
      return { type: "macro", index: a, mode: (b <= 2 ? b : 0) as 0 | 1 | 2, repeat: c };
    case 8:
      return { type: "dks", slot: a };
    case 9:
      return { type: "modtap", hold: a, tap: b, ms: c * 10 };
    case 10:
      return { type: "toggle", code: a };
    case 11:
      return { type: "socd", mode: a, key1: b, key2: c };
    case 12:
      return { type: "rs", key1: b, key2: c };
    default:
      return { type: "unknown", bytes: [t, a, b, c] };
  }
}

/** [codec encodeBinding]; throws on values the allowlist would refuse. */
export function encodeBinding(b: Binding): [number, number, number, number] {
  const hid = (name: string, v: number) => (checkInt(name, v, 0, MAX_HID), v);
  switch (b.type) {
    case "default":
      return [0, 0, 0, 0];
    case "key":
      checkInt("modifier mask", b.mods, 0, 0xff);
      return [2, b.mods, hid("key", b.code), 0];
    case "media":
      checkInt("consumer usage", b.usage, 1, 0x3ff);
      return [3, b.usage & 0xff, (b.usage >> 8) & 0xff, 0];
    case "mouse":
      if (!(MOUSE_BUTTONS as readonly number[]).includes(b.button)) throw new RangeError(`Mouse button mask must be one of ${MOUSE_BUTTONS.join(", ")}.`);
      return [1, 1, b.button, 0];
    case "wheel":
      return [1, 3, b.dir === 255 ? 255 : 1, 0];
    case "macro":
      checkInt("macro index", b.index, 0, MACRO_MAX - 1);
      return [6, b.index, b.mode, b.mode === 1 ? clamp(b.repeat, 1, 255) : 0];
    case "dks":
      checkInt("DKS slot", b.slot, 1, DKS_SLOTS - 1);
      return [8, b.slot, 0, 0];
    case "modtap":
      return [9, hid("hold key", b.hold), hid("tap key", b.tap), clamp(b.ms / 10, 1, 255)];
    case "toggle":
      return [10, hid("toggle key", b.code), 0, 0];
    case "socd":
      if (!SOCD_MODES.includes(b.mode)) throw new RangeError(`SOCD mode must be one of ${SOCD_MODES.join(", ")}.`);
      return [11, b.mode, hid("SOCD key 1", b.key1), hid("SOCD key 2", b.key2)];
    case "rs":
      return [12, 0, hid("RS key 1", b.key1), hid("RS key 2", b.key2)];
    case "unknown":
      return [...b.bytes] as [number, number, number, number];
  }
}

/** Null when four binding bytes are a shape SYNQ may write; else why not. Mirrors encodeBinding. */
export function bindingProblem(t: number, a: number, b: number, c: number): string | null {
  switch (t) {
    case 0:
      return a || b || c ? "default binding with non-zero bytes" : null;
    case 1:
      if (c) return "mouse binding byte 3 set";
      if (a === 1) return (MOUSE_BUTTONS as readonly number[]).includes(b) ? null : `mouse button mask ${b}`;
      if (a === 3) return b === 1 || b === 255 ? null : `wheel direction ${b}`;
      return `mouse kind ${a}`;
    case 2:
      return b > MAX_HID || c ? "key binding out of range" : null;
    case 3: {
      const usage = a | (b << 8);
      return usage < 1 || usage > 0x3ff || c ? "consumer usage out of range" : null;
    }
    case 6:
      if (a >= MACRO_MAX || b > 2) return "macro binding out of range";
      return (b === 1 ? c >= 1 : c === 0) ? null : "macro repeat count";
    case 8:
      return a >= 1 && a < DKS_SLOTS && !b && !c ? null : "DKS slot out of range";
    case 9:
      return a <= MAX_HID && b <= MAX_HID && c >= 1 ? null : "mod-tap out of range";
    case 10:
      return a <= MAX_HID && !b && !c ? null : "toggle out of range";
    case 11:
      return SOCD_MODES.includes(a) && b <= MAX_HID && c <= MAX_HID ? null : "SOCD out of range";
    case 12:
      return !a && b <= MAX_HID && c <= MAX_HID ? null : "rappy snappy out of range";
    default:
      return `binding type ${t} is not one SYNQ writes`;
  }
}

export function withBinding(keys: Uint8Array, indexes: readonly number[], b: Binding): Uint8Array {
  const out = keys.slice();
  const bytes = encodeBinding(b);
  for (const i of indexes) {
    checkInt("key index", i, 0, KEY_SLOTS - 1);
    out.set(bytes, i * 4);
  }
  return out;
}

// =============================================================================================
// Rapid trigger / actuation (8 bytes per key index) [doc:100-111][codec decodeRT/withRT]
// =============================================================================================

export const RT_FLAG = { continuous: 1, bottomOptimisation: 2, rampage: 4 } as const;

export interface KeyRT {
  /** Switch type id; 0 = board default. SYNQ never changes it (it selects the travel curve). */
  switchType: number;
  /** bit0 continuous (full-travel) RT, bit1 bottom optimisation, bit2 "rampage". */
  flags: number;
  /** Actuation point, 0.01 mm. */
  actuation: number;
  /** Press (down) RT sensitivity, 0.01 mm; 0 = RT off. */
  press: number;
  /** Release (up) RT sensitivity, 0.01 mm; 0 = RT off. */
  release: number;
}

export function decodeRT(rt: Uint8Array, index: number): KeyRT {
  const o = index * 8;
  return { switchType: rt[o], flags: rt[o + 1], actuation: u16(rt, o + 2), press: u16(rt, o + 4), release: u16(rt, o + 6) };
}

/** RT is on when both sensitivities are non-zero. [doc:111][codec rtEnabled] */
export const rtEnabled = (k: KeyRT): boolean => k.press > 0 && k.release > 0;

/** Switch limits of one board, 0.01 mm (from the catalog; actuation min 0.10 mm as in FCC registry). */
export interface RtLimits {
  travel: number;
  actuationMin: number;
  actuationMax: number;
  sensMin: number;
  sensMax: number;
}

export type RtPatch = Partial<Pick<KeyRT, "flags" | "actuation" | "press" | "release">>;

/** Applies `patch` to the keys in `indexes`, clamped to the board's limits; the switch type is kept. [codec withRT] */
export function withRT(rt: Uint8Array, indexes: readonly number[], patch: RtPatch, limits: RtLimits, actuationDefault: number): Uint8Array {
  const out = rt.slice();
  for (const i of indexes) {
    checkInt("key index", i, 0, KEY_SLOTS - 1);
    const o = i * 8;
    const k = { ...decodeRT(out, i), ...patch };
    if (patch.flags !== undefined) checkInt("RT flags", patch.flags, 0, 7);
    out[o + 1] = k.flags & 0x07;
    setU16(out, o + 2, clamp(k.actuation || actuationDefault, limits.actuationMin, Math.min(limits.actuationMax, MAX_TRAVEL)));
    setU16(out, o + 4, k.press === 0 ? 0 : clamp(k.press, limits.sensMin, Math.min(limits.sensMax, MAX_TRAVEL)));
    setU16(out, o + 6, k.release === 0 ? 0 : clamp(k.release, limits.sensMin, Math.min(limits.sensMax, MAX_TRAVEL)));
  }
  return out;
}

// =============================================================================================
// Lighting (16 bytes) [doc:113-129][codec decodeLed/encodeLed]
// =============================================================================================

/** Effect ids. 0 = off, 0x80 = per-key custom colours. [doc:116][doc:126-129][codec SONIX_EFFECTS] */
export const EFFECTS: readonly { id: number; name: string; color: boolean; speed: boolean; direction: boolean }[] = [
  { id: 0x00, name: "Off", color: false, speed: false, direction: false },
  { id: 0x01, name: "Static", color: true, speed: false, direction: false },
  { id: 0x02, name: "Reactive on", color: true, speed: true, direction: false },
  { id: 0x03, name: "Reactive off", color: true, speed: true, direction: false },
  { id: 0x04, name: "Starry sky", color: true, speed: true, direction: false },
  { id: 0x05, name: "Snowfall", color: true, speed: true, direction: false },
  { id: 0x06, name: "Bloom", color: false, speed: true, direction: false },
  { id: 0x07, name: "Breathing", color: true, speed: true, direction: false },
  { id: 0x08, name: "Spectrum cycle", color: false, speed: true, direction: false },
  { id: 0x09, name: "Fountain", color: true, speed: true, direction: false },
  { id: 0x0a, name: "Crosslines", color: true, speed: true, direction: true },
  { id: 0x0b, name: "Wave", color: true, speed: true, direction: true },
  { id: 0x0c, name: "Winding peaks", color: true, speed: true, direction: true },
  { id: 0x0d, name: "Reactive burst", color: true, speed: true, direction: false },
  { id: 0x0e, name: "Reactive cross", color: true, speed: true, direction: false },
  { id: 0x0f, name: "Ripple", color: true, speed: true, direction: false },
  { id: 0x10, name: "Endless flow", color: true, speed: true, direction: true },
  { id: 0x11, name: "Layered ridges", color: true, speed: true, direction: false },
  { id: 0x12, name: "Slanted rain", color: true, speed: true, direction: true },
  { id: 0x13, name: "Back & forth", color: true, speed: true, direction: false },
  { id: 0x80, name: "Custom per-key", color: false, speed: false, direction: false },
];
export const CUSTOM_EFFECT = 0x80;
const EFFECT_IDS = new Set(EFFECTS.map((e) => e.id));

export interface Led {
  effect: number;
  r: number;
  g: number;
  b: number;
  /** Colourful / rainbow (1) vs single colour (0). */
  rainbow: boolean;
  /** 1..5 */
  brightness: number;
  /** 1..5 */
  speed: number;
  direction: 0 | 1;
}

export function decodeLed(led: Uint8Array): Led {
  return { effect: led[0], r: led[1], g: led[2], b: led[3], rainbow: led[8] === 1, brightness: led[9], speed: led[10], direction: led[11] ? 1 : 0 };
}

/** [codec encodeLed]: bytes 4, 14, 15 are the constants the official driver writes (255, 0xAA, 0x55). */
export function encodeLed(prev: Uint8Array, l: Led): Uint8Array {
  if (!EFFECT_IDS.has(l.effect)) throw new RangeError(`Unknown lighting effect 0x${l.effect.toString(16)}.`);
  const out = prev.slice(0, 16);
  out[0] = l.effect;
  out[1] = clamp(l.r, 0, 255);
  out[2] = clamp(l.g, 0, 255);
  out[3] = clamp(l.b, 0, 255);
  out[4] = 255;
  out[8] = l.rainbow ? 1 : 0;
  out[9] = clamp(l.brightness, 1, 5);
  out[10] = clamp(l.speed, 1, 5);
  out[11] = l.direction ? 1 : 0;
  out[14] = 0xaa;
  out[15] = 0x55;
  return out;
}

// =============================================================================================
// Per-key colours (4 bytes per index: [index, R, G, B], 126 used) [doc:38][codec withColor]
// =============================================================================================

export const decodeColor = (colors: Uint8Array, index: number): [number, number, number] => [colors[index * 4 + 1], colors[index * 4 + 2], colors[index * 4 + 3]];

export function withColors(colors: Uint8Array, map: ReadonlyMap<number, readonly [number, number, number]>): Uint8Array {
  const out = colors.slice();
  for (const [i, rgb] of map) {
    checkInt("colour index", i, 0, COLOR_SLOTS - 1);
    out.set([i, clamp(rgb[0], 0, 255), clamp(rgb[1], 0, 255), clamp(rgb[2], 0, 255)], i * 4);
  }
  return out;
}

// =============================================================================================
// DKS (16 bytes per slot, 64 slots; slot 0 unused) [doc:141-151][codec decodeDks/withDks]
// =============================================================================================

export type DksAction = "none" | "tap" | "hold";

export interface DksSlot {
  /** Trigger points in 0.1 mm: press start, bottom, lift from bottom, full release. */
  points: [number, number, number, number];
  /** HID usage per bound key (0 = empty), modifiers as 0xE0..0xE7. */
  keys: [number, number, number, number];
  /** actions[key][stage]; "hold" keeps the key down from this stage until the next one. */
  actions: DksAction[][];
}

export const DKS_DEFAULT_POINTS: DksSlot["points"] = [16, 30, 30, 16];
/** Points are 0.1 mm; 40 = 4.0 mm, the largest travel in the catalog. */
export const DKS_POINT_MAX = MAX_TRAVEL / 10;

export function dksSlotUsed(dks: Uint8Array, slot: number): boolean {
  const o = slot * 16;
  return dks[o] !== 0 || dks[o + 1] !== 0 || dks[o + 2] !== 0 || dks[o + 3] !== 0;
}

export function decodeDks(dks: Uint8Array, slot: number): DksSlot {
  const o = slot * 16;
  const actions = [0, 1, 2, 3].map((m) =>
    [0, 1, 2, 3].map((j): DksAction => {
      const b = dks[o + 12 + j];
      return b & (1 << (m + 4)) ? "hold" : b & (1 << m) ? "tap" : "none";
    }),
  );
  return { points: [dks[o], dks[o + 1], dks[o + 2], dks[o + 3]], keys: [dks[o + 5], dks[o + 7], dks[o + 9], dks[o + 11]], actions };
}

/** Writes (or clears, with null) one slot. `travel` caps the points (0.1 mm). [codec withDks] */
export function withDks(dks: Uint8Array, slot: number, s: DksSlot | null, travelTenths = DKS_POINT_MAX): Uint8Array {
  checkInt("DKS slot", slot, 1, DKS_SLOTS - 1);
  const out = dks.slice();
  const o = slot * 16;
  out.fill(0, o, o + 16);
  if (!s) return out;
  s.points.forEach((p, i) => (out[o + i] = clamp(p, 1, Math.min(travelTenths, DKS_POINT_MAX))));
  s.keys.forEach((k, i) => {
    checkInt("DKS key", k, 0, MAX_HID);
    out[o + 5 + i * 2] = k;
  });
  s.actions.forEach((row, m) =>
    row.forEach((a, j) => {
      if (!s.keys[m]) return;
      if (a === "hold" && j < 3) out[o + 12 + j] |= 1 << (m + 4);
      else if (a !== "none") out[o + 12 + j] |= 1 << m;
    }),
  );
  return out;
}

export function freeDksSlot(dks: Uint8Array): number | null {
  for (let s = 1; s < DKS_SLOTS; s++) if (!dksSlotUsed(dks, s)) return s;
  return null;
}

// =============================================================================================
// Advanced keys across key map + DKS [advanced.ts listAdvanced/clearAdvanced]
// =============================================================================================

export type AdvancedType = "rs" | "socd" | "dks" | "modtap" | "toggle";
/** Official UI limit per profile. [doc:158][advanced.ts MAX_ADVANCED] */
export const MAX_ADVANCED = 40;

export interface AdvancedEntry {
  type: AdvancedType;
  /** Key indices carrying the binding (2 for RS / SOCD). */
  indexes: number[];
  binding: Binding;
  dks?: DksSlot;
}

const sameBinding = (keys: Uint8Array, a: number, b: number) => [0, 1, 2, 3].every((i) => keys[a * 4 + i] === keys[b * 4 + i]);
const isAdvanced = (b: Binding): b is Extract<Binding, { type: AdvancedType }> => ["rs", "socd", "dks", "modtap", "toggle"].includes(b.type);

/** Groups the key map into advanced entries; RS / SOCD pairs (same 4 bytes on two keys) become one entry. */
export function listAdvanced(keys: Uint8Array, dks: Uint8Array, layoutIndexes: readonly number[]): AdvancedEntry[] {
  const out: AdvancedEntry[] = [];
  const seen = new Set<number>();
  for (const i of layoutIndexes) {
    if (seen.has(i)) continue;
    const b = decodeBinding(keys, i);
    if (!isAdvanced(b)) continue;
    const indexes = [i];
    if (b.type === "rs" || b.type === "socd") {
      const partner = layoutIndexes.find((o) => o !== i && !seen.has(o) && sameBinding(keys, i, o));
      if (partner !== undefined) indexes.push(partner);
    }
    indexes.forEach((x) => seen.add(x));
    out.push({ type: b.type, indexes, binding: b, dks: b.type === "dks" ? decodeDks(dks, b.slot) : undefined });
  }
  return out;
}

/** Resets keys to default, with their pair partners and the DKS slots they own. [advanced.ts clearAdvanced] */
export function clearAdvanced(keys: Uint8Array, dks: Uint8Array, indexes: readonly number[], layoutIndexes: readonly number[]): { keys: Uint8Array; dks: Uint8Array } {
  let k = keys;
  let d = dks;
  for (const i of indexes) {
    const entry = listAdvanced(k, d, layoutIndexes).find((e) => e.indexes.includes(i));
    if (!entry) continue;
    if (entry.binding.type === "dks" && entry.binding.slot >= 1) d = withDks(d, entry.binding.slot, null);
    k = withBinding(k, entry.indexes, { type: "default" });
  }
  return { keys: withBinding(k, indexes, { type: "default" }), dks: d };
}

/** SOCD / snap tap on two physical keys: the same bytes go on both, with their native HID codes. [doc:97][doc:155-156] */
export const socdBinding = (mode: number, hid1: number, hid2: number): Binding => ({ type: "socd", mode, key1: hid1, key2: hid2 });
/** Rappy Snappy on two keys (deeper press wins). [doc:98] */
export const rsBinding = (hid1: number, hid2: number): Binding => ({ type: "rs", key1: hid1, key2: hid2 });

// =============================================================================================
// Macros (4008 bytes) [doc:131-139][codec decodeMacros/encodeMacros]
// =============================================================================================

export interface MacroEvent {
  /** HID usage for keys, button mask (1 L, 2 R, 4 M) for mouse. */
  code: number;
  down: boolean;
  mouse: boolean;
  /** Delay after this event, ms. */
  delay: number;
}

export function decodeMacros(buf: Uint8Array): MacroEvent[][] {
  const out: MacroEvent[][] = [];
  for (let i = 0; i < MACRO_MAX; i++) {
    const p = i * 4;
    const addr = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
    if (!addr || addr + 4 > buf.length) break;
    const count = u16(buf, addr) / 2;
    const events: MacroEvent[] = [];
    for (let r = 0; r < count; r++) {
      const o = addr + 4 + r * 4;
      if (o + 4 > buf.length) break;
      const flags = buf[o + 3];
      events.push({ delay: u16(buf, o), code: buf[o + 2], down: !!(flags & 0x80), mouse: !(flags & 0x20) });
    }
    out.push(events);
  }
  return out;
}

export const macroBytes = (macros: readonly MacroEvent[][]): number => MACRO_INDEX_BYTES + macros.reduce((n, m) => n + 4 + m.length * 4, 0);

/** Whole macro region; throws when it doesn't fit the board's macro memory. Flags: 0xB0/0x30 key down/up, 0x90/0x10 mouse. [doc:137-139] */
export function encodeMacros(macros: readonly MacroEvent[][], capacity = REGIONS.macros.size): Uint8Array {
  const limit = Math.min(capacity, REGIONS.macros.size);
  if (macros.length > MACRO_MAX) throw new RangeError(`At most ${MACRO_MAX} macros.`);
  if (macroBytes(macros) > limit) throw new RangeError("Not enough macro memory on the keyboard.");
  const out = new Uint8Array(REGIONS.macros.size);
  let addr = MACRO_INDEX_BYTES;
  macros.forEach((events, i) => {
    out.set([addr & 0xff, (addr >> 8) & 0xff, 0, 0], i * 4);
    setU16(out, addr, events.length * 2);
    events.forEach((e, r) => {
      const o = addr + 4 + r * 4;
      setU16(out, o, clamp(e.delay, 0, 65535));
      checkInt("macro key", e.code, 0, 0xff);
      out[o + 2] = e.code;
      out[o + 3] = (e.down ? 0x80 : 0) | (e.mouse ? 0x10 : 0x30);
    });
    addr += 4 + events.length * 4;
  });
  return out;
}

// =============================================================================================
// Safety: every outgoing frame is classified; only allowlisted shapes may be sent.
// =============================================================================================

export interface FrameCheck {
  ok: boolean;
  name: string;
  access: "read" | "write" | "blocked";
  reason?: string;
}

const ok = (name: string, access: "read" | "write"): FrameCheck => ({ ok: true, name, access });
const blocked = (name: string, reason: string): FrameCheck => ({ ok: false, name, access: "blocked", reason });
const notListed = (f: Uint8Array, why: string): FrameCheck => blocked("unknown", `${hex(f.subarray(0, 8))}... isn't on SYNQ's list of known-safe Sonix frames (${why}).`);
const zeroFrom = (f: Uint8Array, from: number) => f.subarray(from).every((b) => b === 0);

/** Validates the payload of a region write chunk, byte positions given relative to the region. */
function writePayloadProblem(name: RegionName, regionOffset: number, p: Uint8Array): string | null {
  switch (name) {
    case "settings": {
      if (p[SET.sleep] > 30) return "sleep over 30 minutes";
      if (p[SET.polling] !== 0 && !POLL_CODE_TO_HZ[p[SET.polling]]) return `polling code ${p[SET.polling]}`;
      for (const i of [SET.stability, SET.adaptiveCalibration, SET.allKeyWake]) if (p[i] > 1) return `settings byte ${i} is a flag`;
      for (const i of SETTINGS_UNKNOWN_BYTES) if (p[i] !== 0) return `unknown settings byte ${i} is ${p[i]} (only 0 has been seen on hardware)`;
      return null;
    }
    case "keys":
      for (let i = 0; i < p.length; i += 4) {
        const why = bindingProblem(p[i], p[i + 1], p[i + 2], p[i + 3]);
        if (why) return `key index ${(regionOffset + i) / 4}: ${why}`;
      }
      return null;
    case "led":
      if (!EFFECT_IDS.has(p[0])) return `lighting effect 0x${p[0].toString(16)}`;
      if (p[4] !== 255 || p[14] !== 0xaa || p[15] !== 0x55) return "lighting constants (bytes 4, 14, 15) differ from the official driver's";
      if (p[5] || p[6] || p[7] || p[12] || p[13]) return "unknown lighting bytes set";
      if (p[8] > 1 || p[11] > 1 || p[9] < 1 || p[9] > 5 || p[10] < 1 || p[10] > 5) return "lighting value out of range";
      return null;
    case "colors":
      for (let i = 0; i < p.length; i += 4) {
        const index = (regionOffset + i) / 4;
        if (index >= COLOR_SLOTS) {
          if (p[i] || p[i + 1] || p[i + 2] || p[i + 3]) return `colour slot ${index} doesn't exist`;
        } else if (p[i] !== index && p[i] !== 0) return `colour slot ${index} carries index ${p[i]}`;
      }
      return null;
    case "macros":
      // The 400-byte index: 100 u32 addresses, each 0 or inside the event area. Event bytes are free-form key data.
      for (let i = 0; i < p.length; i += 4) {
        const at = regionOffset + i;
        if (at >= MACRO_INDEX_BYTES) break;
        const addr = (p[i] | (p[i + 1] << 8) | (p[i + 2] << 16) | (p[i + 3] << 24)) >>> 0;
        if (addr !== 0 && (addr < MACRO_INDEX_BYTES || addr + 4 > REGIONS.macros.size || addr % 4 !== 0)) return `macro address ${addr} out of range`;
      }
      return null;
    case "rt":
      for (let i = 0; i < p.length; i += 8) {
        const index = (regionOffset + i) / 8;
        if (p[i + 1] > 7) return `key index ${index}: RT flags ${p[i + 1]}`;
        if (u16(p, i + 2) > MAX_TRAVEL || u16(p, i + 4) > MAX_TRAVEL || u16(p, i + 6) > MAX_TRAVEL) return `key index ${index}: travel value over ${MAX_TRAVEL / 100} mm`;
      }
      return null;
    case "dks":
      for (let i = 0; i < p.length; i++) {
        const field = (regionOffset + i) & 15;
        if (field < 4 && p[i] > DKS_POINT_MAX) return `DKS point over ${DKS_POINT_MAX / 10} mm`;
        if (field >= 4 && field < 12 && field % 2 === 0 && p[i] !== 0) return `DKS byte ${field} set`;
        if (field >= 5 && field < 12 && field % 2 === 1 && p[i] > MAX_HID) return `DKS key ${p[i]}`;
      }
      return null;
    default:
      return `${name} is never written`;
  }
}

/**
 * Hard blocklist + allowlist (stateless apart from the Advanced grants, so the Rust bridge can mirror it).
 * Blocked unless an Advanced action unlocks them (src/lib/advanced/core.ts): factory reset [0x0F, 0xFF]
 * ("reset") and travel calibration start / save 0x64 / 0x65 ("calibrate"). Blocked for good: the key-check
 * reset [0x0F, 0x05], the unknown 0x66 / 0x67
 * toggles, status (0x62, unused), Fn-layer writes (0x26), device event codes (0xFB / 0xFC) and every
 * command byte not listed. Allowed: chunk-aligned reads of the nine regions, chunk-aligned writes of
 * settings / keys / LED / colours / macros / RT / DKS whose contents pass the checks above, and the
 * commit frame. Firmware update and bootloader commands aren't documented by FCC at all; being
 * unlisted, they're blocked.
 */
export function checkFrame(f: Uint8Array, grants?: Grants): FrameCheck {
  if (f.length !== SONIX.length) return blocked("bad length", `Frames are ${SONIX.length} bytes (got ${f.length}).`);
  if (f[0] !== SONIX.magic) return notListed(f, "byte 0 must be 0xAA");
  const cmd = f[1];
  const forbidden = FORBIDDEN_COMMANDS.get(cmd);
  if (forbidden) {
    // Three of them can be unlocked, each only by its own Advanced action, each only in its exact shape.
    const scope = ADVANCED_COMMANDS.get(cmd);
    if (scope && granted(grants, scope)) {
      const single = f.subarray(3).every((b) => b === 0);
      if (cmd === 0x64 && f[2] === 0 && single) return ok("calibration start", "write");
      if (cmd === 0x65 && f[2] === 0 && single) return ok("calibration end", "write");
      if (cmd === 0x0f && f[2] === 0xff && single) return ok("factory reset", "write");
      return notListed(f, `${scope} frames are [AA ${cmd.toString(16)} ...] in their one shape`);
    }
    return blocked(forbidden.split(":")[0], `Command 0x${cmd.toString(16).padStart(2, "0")} is never sent by SYNQ: ${forbidden}.`);
  }
  const len = f[2];
  const offset = u16(f, 3);
  if (f[5] || f[6] || f[7]) return notListed(f, "header bytes 5..7 must be 0");
  if (cmd === CMD.commit) return len === 4 && offset === 0 && zeroFrom(f, 8) ? ok("commit", "write") : notListed(f, "commit is [AA 00 04 00 00 ...0]");
  const name = regionForCommand(cmd);
  if (!name) return notListed(f, `command 0x${cmd.toString(16)}`);
  const def = REGIONS[name];
  const isRead = cmd === def.read;
  const span = isRead ? def.size : def.writeLength;
  if (offset % SONIX.chunk !== 0 || offset >= span) return notListed(f, `offset ${offset} isn't a chunk of ${name}`);
  if (len !== Math.min(SONIX.chunk, span - offset)) return notListed(f, `length ${len} at offset ${offset} of ${name}`);
  if (!zeroFrom(f, SONIX.headerLength + len)) return notListed(f, "bytes after the payload must be 0");
  const payload = f.subarray(SONIX.headerLength, SONIX.headerLength + len);
  if (isRead) return payload.every((b) => b === 0) ? ok(name, "read") : notListed(f, "read payload must be 0");
  const why = writePayloadProblem(name, offset, payload);
  return why ? blocked(name, `Refused ${name} write: ${why}.`) : ok(name, "write");
}

/** Throws unless the frame is allowlisted. */
export function assertSendable(f: Uint8Array, grants?: Grants): FrameCheck {
  const r = checkFrame(f, grants);
  if (!r.ok) throw new Error(`Blocked: ${r.reason}`);
  return r;
}
