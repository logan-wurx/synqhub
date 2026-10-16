// MonsGeek / Akko magnetic keyboards on RongYuan firmware: the wire codec (pure functions, no I/O).
//
// Two command sets share the vendor collection (usage page 0xFFFF, usage 2, feature report id 0,
// 64 bytes each way) and collide on opcodes:
//   "gen2"  RY5088 boards (Artery AT32F405 + PAN1080): FUN60 / FUN68 / M1 V5 HE, Akko 5075B / MOD007 V5 ...
//           SYNQ reads and writes these.
//   "yc500" YiChip YC3121 magnetic boards (M1W HE, MG75S HE, Akko MOD007B HE PC). SYNQ only READS
//           them: yc500 0x09 is the gen2 option register's opcode but means "keymap", 0x06 means
//           "options", 0x11 "debounce" ..., so a gen2 write sent to a yc500 board lands on a live register.
// The command set comes from the board's model id (command 0x8F), never from the USB product id.
//
// Sources and licences (what came from where):
//   - FightingControlCenter (FCC), shybruh/FightingControlCenter-FCC, GPL-3.0: frame layout and both
//     checksums, every gen2 command shape SYNQ sends (app/src/hid/ry.ts), the per-key table ids and
//     paging, the precision rule (feature list 0xE6, firmware fallback), the "travel units must make
//     sense before any travel write" rule, key entry formats (docs/PROTOCOL-RY.md). Ported to this file.
//   - sharkfin, dniminenn/sharkfin, GPL-3.0-or-later: the two command families and their opcode
//     collisions, yc500 reads (profile x4 + sub-layer, debounce at byte 2, one-byte columns in tenths
//     offset by one, revision 0x80 >= 2.00 for columns), the destructive opcode list (0x7F 55AA55AA,
//     0xAC, 0x2C, 0x30, 0x1C/0x1E calibration, 0x1A), bulk table writes possibly spilling into the next
//     column (docs/PROTOCOL.md, src-tauri/src/protocol/{hall,gen2,cmd}.rs). Ported / re-derived here.
//   - MonsGeek web driver (https://app.monsgeek.com, read 2026-10-13) and echtzeit-solutions/
//     monsgeek-akko-linux docs (no licence): DOCUMENTATION ONLY, no code copied. Used to cross-check
//     byte positions (0x09 options layout, 0xE6 precision codes, polling codes, keymap write bytes 5/6,
//     LED option nibble, white = FA FA FA, pacing 10 ms / 100 ms) and the firmware's missing bounds
//     checks on chunked writes.
// SYNQ is AGPL-3.0; GPL-3.0 code may be combined with it.
//
// Nothing here has been sent to a real keyboard. Labels: [FCC] [SF] (sharkfin) [WEB] (vendor JS, docs)
// [EZ] (echtzeit docs). Erasable TypeScript only, so `node --test` runs the tests directly.

import type { BlockReason } from "../local-kb.ts";

// =============================================================================================
// Transport constants
// =============================================================================================

export const REPORT_ID = 0;
/** Data bytes per feature report (the report id is not counted). [FCC][SF][WEB] */
export const FRAME_LEN = 64;
/** Payload offset of every Bit7 frame. [FCC] */
export const DATA_AT = 8;
export const DATA_MAX = FRAME_LEN - DATA_AT; // 56
/** Matrix positions per sub-layer / per-key table on gen2. [FCC][SF] */
export const POSITIONS = 128;
/** yc500 columns are 126 slots (21 rows of 6). [SF] */
export const YC_POSITIONS = 126;
export const SUBLAYERS = 4;
export const KEYMAP_BYTES = POSITIONS * 4; // 512
export const KEYMAP_READ_PAGES = 8; // 8 x 64 bytes [FCC][SF][WEB]
export const KEYMAP_WRITE_PAGES = Math.ceil(KEYMAP_BYTES / DATA_MAX); // 10, last page 8 bytes [FCC][WEB]
/** The wire profile byte of gen2 (profiles 0..3). [EZ "SET_PROFILE 0-3"][FCC] */
export const MAX_PROFILES = 4;

export type Family = "gen2" | "yc500";

/** gen2 (RY5088) opcodes SYNQ uses. GETs echo the opcode in byte 0, paged reads don't. [FCC][WEB] */
export const CMD = {
  identify: 0x8f,
  rfVersion: 0x80,
  featureList: 0xe6,
  getPolling: 0x83,
  setPolling: 0x03,
  getProfile: 0x84,
  setProfile: 0x04,
  getDebounce: 0x86,
  setDebounce: 0x06,
  getLighting: 0x87,
  setLighting: 0x07,
  getOptions: 0x89,
  setOptions: 0x09,
  getKeymap: 0x8a,
  setKeymap: 0x0a,
  getTable: 0xe5,
  setTable: 0x65,
} as const;

/** yc500 (YC3121) GET opcodes SYNQ uses. Reads only. [SF cmd.rs][WEB 02a575fe/e14d483e] */
export const YC = {
  identify: 0x8f,
  revision: 0x80,
  getProfile: 0x85,
  getOptions: 0x86,
  getLighting: 0x87,
  getKeymap: 0x89,
  getDebounce: 0x91,
  getTable: 0xe5,
} as const;

/** Per-key tables of SET 0x65 / GET 0xE5. [FCC][SF][EZ] */
export const TABLE = {
  actuation: 0,
  release: 1,
  rtPress: 2,
  rtRelease: 3,
  dksPoint: 4,
  modTap: 5,
  deadzone: 6,
  mode: 7,
  dksBindingsSet: 8,
  snap: 9,
  dksBindingsGet: 10,
  liveTravel: 254,
} as const;

/** u16 little-endian per position, 4 read pages. [FCC][SF] */
export const U16_TABLES: readonly number[] = [0, 1, 2, 3, 4, 6, 254];
/** one byte per position, 2 read pages. [FCC][SF] */
export const U8_TABLES: readonly number[] = [5, 7, 9];
/** Tables SYNQ may read (gen2). 8 is write-only, 251/252 aren't used. */
export const READ_TABLES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 254];
/** Tables SYNQ may write (gen2, single-key form only). 254 is read-only. */
export const WRITE_TABLES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
/** Tables a yc500 board answers (columns are one byte each). [SF hall.rs] */
export const YC_READ_TABLES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10];

/** Key mode byte (table 7): low 7 bits the kind, 0x80 rapid trigger. [FCC][SF][WEB _decodeMagnetismKeyModes] */
export const KIND = { normal: 0, dks: 2, modTap: 3, toggleHold: 4, toggleTap: 5, snap: 7 } as const;
export type KindName = keyof typeof KIND;
export const KINDS: readonly number[] = [0, 2, 3, 4, 5, 7];
export const RT_FLAG = 0x80;
export const SNAP_NONE = 0xff;

/** Polling code -> Hz (0 = 8000 ... 6 = 125). [FCC][WEB getReportRate] */
export const POLL_CODE_HZ: readonly number[] = [8000, 4000, 2000, 1000, 500, 250, 125];

export function readPages(table: number, family: Family = "gen2"): number {
  if (table === TABLE.dksBindingsGet) return 8;
  if (family === "yc500") return 2;
  return U16_TABLES.includes(table) ? 4 : 2;
}

// =============================================================================================
// Destructive / never-sent opcodes. The frame builder refuses them, so no encoder can produce one;
// guard.ts refuses them again on the way out (and the Rust bridge mirrors guard.ts).
// =============================================================================================

export interface BlockedOpcode {
  opcode: number;
  what: string;
  why: BlockReason;
  reason: string;
}

export const BLOCKED: readonly BlockedOpcode[] = [
  { opcode: 0x01, what: "Factory reset (gen2)", why: "factory-reset", reason: "Resets every profile, keymap and switch setting. [FCC][SF][WEB SET_RESERT]" },
  { opcode: 0x02, what: "Factory reset (yc500)", why: "factory-reset", reason: "yc500 reset, about 4 s. [SF]" },
  { opcode: 0x7f, what: "USB bootloader entry", why: "bootloader", reason: "With 55 AA 55 AA it erases the keymap and switch blocks and enters the bootloader. [SF][EZ]" },
  { opcode: 0xac, what: "Flash-chip erase", why: "firmware", reason: "Erases the external flash (about 55 s). [SF][WEB SET_FLASHCHIPERASSE]" },
  { opcode: 0x2c, what: "Display erase (yc500)", why: "firmware", reason: "Same flag as 0xAC on the images read. [SF]" },
  { opcode: 0x30, what: "Display-chip bootloader", why: "bootloader", reason: "Screen chip boot entry. [SF][EZ SET_OLEDBOOTLOADER]" },
  { opcode: 0x31, what: "Display firmware transfer", why: "firmware", reason: "Screen chip firmware start. [EZ SET_OLEDBOOTSTART]" },
  { opcode: 0x43, what: "Radio bootloader", why: "bootloader", reason: "Nordic/RF boot. [WEB SET_NORDIC_BOOT]" },
  { opcode: 0x44, what: "Radio firmware transfer", why: "firmware", reason: "Nordic/RF boot start. [WEB SET_NORDIC_BOOTSTART]" },
  { opcode: 0xc3, what: "Radio boot state", why: "bootloader", reason: "Boot-mode query of the radio updater; not needed. [WEB GET_NORDIC_BOOT]" },
  { opcode: 0xc4, what: "Radio boot start state", why: "bootloader", reason: "Boot-mode query of the radio updater; not needed. [WEB GET_NORDIC_BOOTSTART]" },
  { opcode: 0x50, what: "Write SKU", why: "identity", reason: "Rewrites the factory SKU. [FCC][WEB SET_SKU]" },
  { opcode: 0xd0, what: "Read SKU", why: "identity", reason: "Factory SKU; SYNQ has no use for it. [WEB GET_SKU][EZ]" },
  { opcode: 0x1c, what: "Switch calibration (rest)", why: "calibration", reason: "On it zeroes the travel tables in RAM; off saves them, so on-then-off without pressing every key commits zeroed tables. [SF][WEB SET_MAGNETISM_CAL]" },
  { opcode: 0x1e, what: "Switch calibration (bottom)", why: "calibration", reason: "Maximum-travel calibration. [SF][WEB SET_MAGNETISM_MAXIMUM_CALIBRATION]" },
  { opcode: 0x9c, what: "Calibration read (yc500)", why: "calibration", reason: "Calibration state; not needed. [WEB GET_MAGNETISM_CAL]" },
  { opcode: 0x9e, what: "Calibration read (yc500)", why: "calibration", reason: "Calibration state; not needed. [WEB GET_MAGNETISM_CALMAX]" },
  { opcode: 0xfe, what: "Raw calibration values", why: "calibration", reason: "GET_CALIBRATION on the keyboard, a response-size override on the receiver. [EZ]" },
  { opcode: 0x1a, what: "Global switch record (yc500)", why: "profile-wipe", reason: "Rewrites every key's switch settings and saves. [SF]" },
  { opcode: 0x1d, what: "Switch preset (yc500)", why: "profile-wipe", reason: "Replaces the per-key columns with a built-in preset. [SF][EZ]" },
  { opcode: 0x1b, what: "Key travel stream", why: "device-mode", reason: "Streams input reports; SYNQ's channel is feature-only and reads live travel with 0xE5 254 instead. [SF][WEB SET_MAGNETISM_REPOR]" },
  { opcode: 0x12, what: "Per-key animation upload", why: "firmware", reason: "GIF frames go to flash; repeated uploads stall the endpoint. [WEB SET_USERGIF][SF]" },
  { opcode: 0x18, what: "Animation upload (yc500)", why: "firmware", reason: "GIF start (yc500). [WEB SET_USERGIFSTART]" },
  { opcode: 0x19, what: "Animation upload (yc500)", why: "firmware", reason: "GIF frames (yc500). [WEB SET_USERGIF]" },
  { opcode: 0x25, what: "Screen image data", why: "firmware", reason: "TFT/OLED frames, written to flash. [SF][WEB SETTFTLCDDATA]" },
  { opcode: 0x29, what: "Screen image data (24-bit)", why: "firmware", reason: "Screen frames. [SF][WEB SET_SCREEN_24BITDATA]" },
  { opcode: 0xa5, what: "Screen frame announce", why: "firmware", reason: "Starts a screen upload. [SF]" },
  { opcode: 0xa9, what: "Screen frame announce (24-bit)", why: "firmware", reason: "Starts a screen upload. [SF]" },
  { opcode: 0x22, what: "Screen options", why: "device-mode", reason: "Display settings; not supported. [WEB SET_OLEDOPTION]" },
  { opcode: 0x27, what: "Screen language", why: "device-mode", reason: "Display settings; not supported. [WEB SET_OLEDLUANGAGE]" },
  { opcode: 0x28, what: "Screen clock", why: "device-mode", reason: "Display settings; not supported. [WEB SET_OLEDCLOCK]" },
  { opcode: 0xf6, what: "Receiver relay target", why: "pairing", reason: "2.4 GHz receiver relay control; SYNQ talks to the cable only. [SF][EZ]" },
  { opcode: 0xf8, what: "Receiver pairing", why: "pairing", reason: "Enters RF pairing (55 AA 55 AA). [EZ]" },
  { opcode: 0x7a, what: "Receiver pairing command", why: "pairing", reason: "RF pairing control. [EZ]" },
];

const BLOCKED_BY_OPCODE = new Map<number, BlockedOpcode>(BLOCKED.map((b) => [b.opcode, b]));
export const blockedOpcode = (opcode: number): BlockedOpcode | undefined => BLOCKED_BY_OPCODE.get(opcode);

// =============================================================================================
// Frame builder (the one place frames are made)
// =============================================================================================

export type ChecksumAt = 7 | 8;

/** 255 - (sum of bytes 0..at-1 & 0xFF). Bit7: at = 7; Bit8 (lighting): at = 8. [FCC][SF][EZ] */
export function checksum(f: ArrayLike<number>, at: ChecksumAt): number {
  let s = 0;
  for (let i = 0; i < at; i++) s += f[i];
  return 255 - (s & 0xff);
}

export const checksumAt = (cmd: number): ChecksumAt => (cmd === CMD.setLighting ? 8 : 7);
export const checksumOk = (f: Uint8Array): boolean => f.length === FRAME_LEN && f[checksumAt(f[0])] === checksum(f, checksumAt(f[0]));

/** Every opcode an encoder below may use. Anything else (and every BLOCKED opcode) throws. */
const ENCODABLE: ReadonlySet<number> = new Set<number>([...Object.values(CMD), ...Object.values(YC)]);

function checkByte(name: string, v: number, min = 0, max = 255) {
  if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`${name} must be a whole number from ${min} to ${max} (got ${v}).`);
}

/**
 * Builds one 64-byte frame: `cmd` at 0, `params` from byte 1, checksum at 7 (or 8 for lighting),
 * `data` from byte 8. Throws for blocked or unknown opcodes, so no encoder can ever produce one.
 */
export function buildFrame(cmd: number, params: readonly number[] = [], data?: ArrayLike<number>): Uint8Array {
  checkByte("command", cmd);
  const blocked = blockedOpcode(cmd);
  if (blocked) throw new Error(`Refusing to build 0x${cmd.toString(16).padStart(2, "0")} (${blocked.what}): ${blocked.reason}`);
  if (!ENCODABLE.has(cmd)) throw new Error(`Refusing to build 0x${cmd.toString(16).padStart(2, "0")}: SYNQ has no encoder for it.`);
  const at = checksumAt(cmd);
  if (params.length > at - 1) throw new RangeError(`Too many parameters for 0x${cmd.toString(16)} (${params.length}).`);
  const f = new Uint8Array(FRAME_LEN);
  f[0] = cmd;
  params.forEach((v, i) => {
    checkByte(`byte ${i + 1}`, v);
    f[1 + i] = v;
  });
  if (data) {
    if (at !== 7) throw new Error("Lighting frames carry no payload.");
    if (data.length > DATA_MAX) throw new RangeError(`Payload is ${data.length} bytes (max ${DATA_MAX}).`);
    for (let i = 0; i < data.length; i++) {
      checkByte(`data ${i}`, data[i]);
      f[DATA_AT + i] = data[i];
    }
  }
  f[at] = checksum(f, at);
  return f;
}

// =============================================================================================
// Units
// =============================================================================================

export type UnitSource = "featureList" | "firmware";

/**
 * Size of one travel count. The feature list (0xE6) answers [E6, AA, code]: 0 = 0.01 mm, 1 = 0.005,
 * 2 = 0.001. Without it the firmware version decides (rf version if non-zero, else the 0x8F
 * version): below 768 = 0.1 mm, below 1280 = 0.01 mm, else 0.005 mm. [FCC precision()][WEB
 * get磁轴行程步进倍数 / getLegacy...][SF gen2_unit_mm, same thresholds 0x300 / 0x500]
 */
export function unitMm(featureReply: Uint8Array | null, firmware: number | null, rfVersion?: number | null): { unitMm: number; source: UnitSource } {
  if (featureReply && featureReply[0] === CMD.featureList && featureReply[1] === 0xaa) {
    const byCode: Record<number, number> = { 0: 0.01, 1: 0.005, 2: 0.001 };
    return { unitMm: byCode[featureReply[2]] ?? 0.01, source: "featureList" };
  }
  const v = rfVersion || firmware;
  if (v === null || v === undefined || v === 0) return { unitMm: 0.1, source: "firmware" };
  return { unitMm: v >= 1280 ? 0.005 : v >= 768 ? 0.01 : 0.1, source: "firmware" };
}

/** mm -> wire counts (rounded to the nearest count). */
export function mmToWire(mm: number, unit: number): number {
  if (!Number.isFinite(mm) || mm < 0) throw new RangeError(`Travel must be a positive number of mm (got ${mm}).`);
  return Math.round(mm / unit + 1e-9);
}
export const wireToMm = (v: number, unit: number): number => Math.round(v * unit * 100000) / 100000;

/**
 * yc500 one-byte columns are tenths of a millimetre offset by one: actuation, release and rapid
 * trigger show (b + 1) / 10 mm, the DKS first point (b + 2) / 10, the bottom dead zone
 * (40 - (b + 1)) / 10 mm from the bottom. [SF hall.rs Columns::to_mm, 1618 evaluator]
 */
export function ycColumnMm(table: number, b: number): number {
  const tenths = table === TABLE.deadzone ? 40 - (b + 1) : table === TABLE.dksPoint ? b + 2 : b + 1;
  return Math.max(0, tenths) / 10;
}

// =============================================================================================
// Key entries (4 bytes per matrix position). [FCC PROTOCOL-RY "Key matrix"][SF "Slot values"]
// =============================================================================================

export type KeyEntry = readonly [number, number, number, number];

export const ENTRY = {
  /** Nothing. On sub-layer 0 this silences the key (no factory fallback). [FCC][EZ] */
  none: (): KeyEntry => [0, 0, 0, 0],
  /** HID keyboard usage with modifier bits (1 LCtrl, 2 LShift, 4 LAlt, 8 LGui, 16.. right side). */
  key: (usage: number, mods = 0): KeyEntry => {
    checkByte("HID usage", usage, 0, 0xe7);
    checkByte("modifiers", mods);
    return [0, mods, usage, 0];
  },
  /** Consumer (media) usage, e.g. 0xE9 volume up. */
  consumer: (usage: number): KeyEntry => {
    checkByte("consumer usage", usage, 0, 0x3ff);
    return [3, 0, usage & 0xff, usage >> 8];
  },
  /** Mouse button 0 left, 1 right, 2 middle, 3 back, 4 forward (RY codes 240..244). */
  mouse: (button: number): KeyEntry => {
    checkByte("mouse button", button, 0, 4);
    return [1, 0, 240 + button, 0];
  },
  wheel: (up: boolean): KeyEntry => [1, 0, 245, up ? 1 : 255],
  fn: (): KeyEntry => [10, 1, 0, 0],
} as const;

/** Entry types seen in the vendor's factory matrices (FCC ry-catalog.json) plus macros (9). */
export const KNOWN_ENTRY_TYPES: readonly number[] = [0, 1, 3, 8, 9, 10, 13, 19];

/**
 * True for an entry SYNQ is willing to put on the wire: its own encoders' output, or a factory
 * entry being written back (lighting keys 13, knob 19, specials 10, macro binding 9).
 */
export function entryOk(e: ArrayLike<number>): boolean {
  const [t, a, b, c] = [e[0], e[1], e[2], e[3]];
  switch (t) {
    case 0:
      return b <= 0xe7 && c <= 0xe7;
    case 1:
      return a === 0 && ((b >= 240 && b <= 244 && c === 0) || (b === 245 && (c === 1 || c === 255)));
    case 3:
      return a === 0 && c <= 0x03;
    case 8:
      return a <= 0x0f && c === 0;
    case 9:
      return a <= 2 && b < 50 && c === 0;
    case 10:
      return a <= 0x3f && b === 0 && c === 0;
    case 13:
      return a <= 0x1f && b <= 0x0f && c === 0;
    case 19:
      return a <= 0x0f && b <= 0x0f && c === 0;
    default:
      return false;
  }
}

export const entryAt = (table: Uint8Array, pos: number): KeyEntry => [table[pos * 4], table[pos * 4 + 1], table[pos * 4 + 2], table[pos * 4 + 3]];
export const sameEntry = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

// =============================================================================================
// gen2 encoders
// =============================================================================================

function checkProfile(p: number) {
  checkByte("profile", p, 0, MAX_PROFILES - 1);
}
function checkPos(pos: number) {
  checkByte("matrix position", pos, 0, POSITIONS - 1);
}
function checkSublayer(s: number) {
  checkByte("sub-layer", s, 0, SUBLAYERS - 1);
}

export const encodeIdentify = () => buildFrame(CMD.identify);
export const encodeRfVersion = () => buildFrame(CMD.rfVersion);
export const encodeFeatureList = () => buildFrame(CMD.featureList);
export const encodeProfileRead = () => buildFrame(CMD.getProfile);
export const encodePollingRead = () => buildFrame(CMD.getPolling);
export const encodeDebounceRead = () => buildFrame(CMD.getDebounce);
export const encodeLightingRead = () => buildFrame(CMD.getLighting);
export const encodeOptionsRead = () => buildFrame(CMD.getOptions);

/** [0x04, profile]. [WEB setCurrentProfile][EZ] */
export function encodeProfileWrite(profile: number): Uint8Array {
  checkProfile(profile);
  return buildFrame(CMD.setProfile, [profile]);
}

/** [0x03, 0, code]. [FCC][WEB setReportRate] */
export function encodePollingWrite(hz: number): Uint8Array {
  const code = POLL_CODE_HZ.indexOf(hz);
  if (code < 0) throw new RangeError(`Polling rate must be one of ${POLL_CODE_HZ.join(", ")} Hz (got ${hz}).`);
  return buildFrame(CMD.setPolling, [0, code]);
}

/** Debounce in ms at byte 1 (gen2). The vendor's own range is 0..10 (`other.deBounce: 10`). [FCC][SF][WEB] */
export const DEBOUNCE_MAX = 10;
export function encodeDebounceWrite(ms: number): Uint8Array {
  checkByte("debounce (ms)", ms, 0, DEBOUNCE_MAX);
  return buildFrame(CMD.setDebounce, [ms]);
}

export interface OptionsWrite {
  /** Byte 2 as read back (the vendor calls it fnIndex). */
  fnIndex: number;
  antiMistouch: boolean;
  /** 0..125 ms in 25 ms steps (wire 0..5). */
  rtStabilityMs: number;
  wasdSwap: boolean;
}

/**
 * [0x09, 0, fnIndex, antiMistouch, rtStability / 25, wasdSwap]. Byte 1 is 0 exactly as MonsGeek's
 * web driver sends it (the firmware re-derives the OS from the connection [EZ]); qmk.top's driver
 * sends the current OS there instead and adds win-lock / Alt+Tab / Alt+F4 at 6, 8, 9 [docs].
 * [FCC writeSettings][WEB setKBOption]
 */
export function encodeOptionsWrite(o: OptionsWrite): Uint8Array {
  checkByte("Fn index", o.fnIndex, 0, 3);
  if (!Number.isInteger(o.rtStabilityMs) || o.rtStabilityMs < 0 || o.rtStabilityMs > 125 || o.rtStabilityMs % 25 !== 0)
    throw new RangeError(`RT stability must be 0..125 ms in 25 ms steps (got ${o.rtStabilityMs}).`);
  return buildFrame(CMD.setOptions, [0, o.fnIndex, o.antiMistouch ? 1 : 0, o.rtStabilityMs / 25, o.wasdSwap ? 1 : 0]);
}

/** Wire bytes of 0x07 / 0x87: [mode, speed (inverted), brightness, option, r, g, b]. */
export interface LightingWire {
  mode: number;
  speedWire: number;
  brightness: number;
  /** variant << 4 | colour nibble */
  option: number;
  r: number;
  g: number;
  b: number;
}

/**
 * Lighting modes SYNQ writes (vendor list index -> name). 20, 21, 22 (music / screen sync) and 25
 * (streamed colours) need the host to feed them and are left out. [FCC RY_LIGHT_LIST][WEB LightList]
 */
export const LIGHT_MODES: Readonly<Record<number, string>> = {
  0: "Off",
  1: "Static",
  2: "Breathing",
  3: "Neon",
  4: "Wave",
  5: "Ripple",
  6: "Raindrop",
  7: "Snake",
  8: "Reactive",
  9: "Converge",
  10: "Sine wave",
  11: "Kaleidoscope",
  12: "Line wave",
  13: "Custom per-key",
  14: "Laser",
  15: "Circle wave",
  16: "Rainbow",
  17: "Rain down",
  18: "Meteor",
  19: "Reactive off",
  23: "Train",
  24: "Fireworks",
};
export const USER_PICTURE_MODE = 13;
/** Option variants (direction / picture slot) per mode; 1 when absent. [FCC ry-catalog lights[].types[].options] */
export const LIGHT_VARIANTS: Readonly<Record<number, number>> = { 4: 4, 7: 2, 11: 2, 13: 5, 15: 2, 24: 2 };
export const variantsOf = (mode: number): number => LIGHT_VARIANTS[mode] ?? 1;
/** Colour nibbles SYNQ writes: the model's rainbow/fixed pair (7/8, 8/7, or 7/1 on one class). */
export const COLOUR_NIBBLES: readonly number[] = [1, 7, 8];

/** [0x07, mode, speed, brightness, option, r, g, b], checksum at byte 8 (Bit8). [FCC writeLed][WEB setLightSetting] */
export function encodeLightingWrite(w: LightingWire): Uint8Array {
  if (!(w.mode in LIGHT_MODES)) throw new RangeError(`Lighting mode ${w.mode} isn't one SYNQ writes.`);
  checkByte("speed", w.speedWire, 0, 4);
  checkByte("brightness", w.brightness, 0, 4);
  checkByte("option", w.option);
  const variant = w.option >> 4;
  const nibble = w.option & 0x0f;
  if (variant >= variantsOf(w.mode)) throw new RangeError(`Mode ${w.mode} has ${variantsOf(w.mode)} variant(s) (got ${variant}).`);
  if (w.mode === USER_PICTURE_MODE ? nibble !== 0 : !COLOUR_NIBBLES.includes(nibble)) throw new RangeError(`Colour nibble ${nibble} isn't valid for mode ${w.mode}.`);
  return buildFrame(CMD.setLighting, [w.mode, w.speedWire, w.brightness, w.option, w.r, w.g, w.b]);
}

/** One page of one sub-layer: [0x8A, profile, 0xFF, page 0..7, sub-layer]. [FCC keyLayer][SF gen2.rs][WEB _getKeyMatrix] */
export function encodeKeymapRead(profile: number, page: number, sublayer = 0): Uint8Array {
  checkProfile(profile);
  checkByte("keymap page", page, 0, KEYMAP_READ_PAGES - 1);
  checkSublayer(sublayer);
  return buildFrame(CMD.getKeymap, [profile, 0xff, page, sublayer]);
}
export const encodeKeymapReadAll = (profile: number, sublayer = 0): Uint8Array[] =>
  Array.from({ length: KEYMAP_READ_PAGES }, (_, page) => encodeKeymapRead(profile, page, sublayer));

/** One key: [0x0A, profile, position, 0, 0, apply=1, sub-layer, ck, entry]. [FCC sendKey][SF set_layer_key_packet][WEB setKeyConfigSimple] */
export function encodeKeyWrite(profile: number, pos: number, sublayer: number, entry: KeyEntry): Uint8Array {
  checkProfile(profile);
  checkPos(pos);
  checkSublayer(sublayer);
  if (!entryOk(entry)) throw new RangeError(`Key entry [${entry.join(", ")}] isn't one SYNQ writes.`);
  return buildFrame(CMD.setKeymap, [profile, pos, 0, 0, 1, sublayer], entry);
}

/**
 * A whole sub-layer: 10 pages [0x0A, profile, 0xFF, page, length, last, sub-layer, ck, 56 bytes];
 * 9 pages of 56 and a last page of 8, "last" set on page 9 only, zero padding. Mirrors the vendor
 * exactly: the firmware doesn't bounds-check the chunk index or length [EZ firmware limits].
 * [FCC sendKeyLayer][WEB _setKeyConfig][SF bulk_keymatrix_packets]
 */
export function encodeSublayerWrite(profile: number, sublayer: number, table: Uint8Array): Uint8Array[] {
  checkProfile(profile);
  checkSublayer(sublayer);
  if (table.length !== KEYMAP_BYTES) throw new RangeError(`A sub-layer is ${KEYMAP_BYTES} bytes (got ${table.length}).`);
  for (let p = 0; p < POSITIONS; p++) if (!entryOk(table.subarray(p * 4, p * 4 + 4))) throw new RangeError(`Position ${p} holds an entry SYNQ won't write ([${Array.from(table.subarray(p * 4, p * 4 + 4)).join(", ")}]).`);
  const out: Uint8Array[] = [];
  for (let page = 0; page < KEYMAP_WRITE_PAGES; page++) {
    const chunk = table.subarray(page * DATA_MAX, page * DATA_MAX + DATA_MAX);
    out.push(buildFrame(CMD.setKeymap, [profile, 0xff, page, chunk.length, page === KEYMAP_WRITE_PAGES - 1 ? 1 : 0, sublayer], chunk));
  }
  return out;
}

/** One page of a per-key table: [0xE5, table, 1, page]. [FCC magTable][SF get_payload][WEB _getMulitMagnetismCMD] */
export function encodeTableRead(table: number, page: number): Uint8Array {
  if (!READ_TABLES.includes(table)) throw new RangeError(`Table ${table} isn't one SYNQ reads.`);
  checkByte("table page", page, 0, readPages(table) - 1);
  return buildFrame(CMD.getTable, [table, 1, page]);
}
export const encodeTableReadAll = (table: number): Uint8Array[] => Array.from({ length: readPages(table) }, (_, page) => encodeTableRead(table, page));

/** Value bounds per writable table (wire units). Travel counts allow 4.0 mm at the finest unit (0.001). */
export const TABLE_LIMITS: Readonly<Record<number, { min: number; max: number }>> = {
  0: { min: 1, max: 4000 },
  1: { min: 1, max: 4000 },
  2: { min: 1, max: 2500 },
  3: { min: 1, max: 2500 },
  4: { min: 1, max: 4000 },
  5: { min: 1, max: 255 },
  6: { min: 0, max: 1000 },
};

/**
 * One key of one table: [0x65, table, 0, position, commit, 0, 0, ck, value]. u16 tables put the value
 * little-endian at 8..9, byte tables at 8. `commit` (byte 4) makes the keyboard apply and save; send
 * it on the last frame of a batch only, then give it ~300 ms. [FCC sendMagnetism][SF set_one][WEB
 * _sendMagnetismInfoSimpleCMD]. The bulk form (byte 2 = 1) is never built: SYNQ writes keys one
 * by one, so no page can spill into the next column [SF "bounds are the host's job"].
 */
export function encodeTableWrite(table: number, pos: number, value: number, commit: boolean): Uint8Array {
  checkPos(pos);
  if (table === TABLE.mode) {
    checkByte("key mode", value);
    if (!KINDS.includes(value & 0x7f)) throw new RangeError(`Key kind ${value & 0x7f} isn't known.`);
    return buildFrame(CMD.setTable, [table, 0, pos, commit ? 1 : 0, 0, 0], [value]);
  }
  if (table === TABLE.snap) {
    if (!(Number.isInteger(value) && ((value >= 0 && value < POSITIONS && value !== pos) || value === SNAP_NONE))) throw new RangeError(`Snap tap partner must be another position or none (got ${value}).`);
    return buildFrame(CMD.setTable, [table, 0, pos, commit ? 1 : 0, 0, 0], [value]);
  }
  const lim = TABLE_LIMITS[table];
  if (!lim) throw new RangeError(`Table ${table} isn't one SYNQ writes this way.`);
  checkByte(`table ${table} value`, value, lim.min, lim.max);
  const bytes = U16_TABLES.includes(table) ? [value & 0xff, value >> 8] : [value];
  return buildFrame(CMD.setTable, [table, 0, pos, commit ? 1 : 0, 0, 0], bytes);
}

/** DKS bindings of one key: [0x65, 8, 0, position, commit, 0, 0, ck, b0, b1, b2, b3] (single-key only). [FCC][SF set_dks_actions] */
export function encodeDksBindingsWrite(pos: number, rows: readonly number[], commit: boolean): Uint8Array {
  checkPos(pos);
  if (rows.length !== 4) throw new RangeError("DKS has four binding rows.");
  rows.forEach((v, i) => checkByte(`DKS row ${i}`, v));
  return buildFrame(CMD.setTable, [TABLE.dksBindingsSet, 0, pos, commit ? 1 : 0, 0, 0], rows);
}

export interface TableWrite {
  table: number;
  pos: number;
  /** One value, or four DKS binding rows for table 8. */
  value: number | readonly number[];
}

/** A batch of single-key table writes, commit flag on the last frame only. Order kept. */
export function encodeTableBatch(writes: readonly TableWrite[]): Uint8Array[] {
  return writes.map((w, i) => {
    const last = i === writes.length - 1;
    if (w.table === TABLE.dksBindingsSet) {
      if (!Array.isArray(w.value)) throw new RangeError("Table 8 takes four binding rows.");
      return encodeDksBindingsWrite(w.pos, w.value as readonly number[], last);
    }
    if (typeof w.value !== "number") throw new RangeError(`Table ${w.table} takes one value.`);
    return encodeTableWrite(w.table, w.pos, w.value, last);
  });
}

// =============================================================================================
// yc500 read encoders (YC3121 boards; reads only)
// =============================================================================================

export const ycEncodeRevision = () => buildFrame(YC.revision);
export const ycEncodeProfileRead = () => buildFrame(YC.getProfile);
export const ycEncodeOptionsRead = () => buildFrame(YC.getOptions);
export const ycEncodeDebounceRead = () => buildFrame(YC.getDebounce);
/** Magnetic yc500 boards address keymaps as profile * 4 + sub-layer. [SF yc500_profile_slot][WEB _getKeyMatrix] */
export const YC_MAX_SLOT = 31;
export function ycEncodeKeymapRead(profile: number, page: number, sublayer = 0): Uint8Array {
  const slot = profile * 4 + sublayer;
  checkByte("yc500 keymap slot", slot, 0, YC_MAX_SLOT);
  checkSublayer(sublayer);
  checkByte("keymap page", page, 0, KEYMAP_READ_PAGES - 1);
  return buildFrame(YC.getKeymap, [slot, page]);
}
export function ycEncodeTableRead(table: number, page: number): Uint8Array {
  if (!YC_READ_TABLES.includes(table)) throw new RangeError(`yc500 table ${table} isn't one SYNQ reads.`);
  checkByte("table page", page, 0, readPages(table, "yc500") - 1);
  return buildFrame(YC.getTable, [table, 1, page]);
}

// =============================================================================================
// Decoders
// =============================================================================================

const u16 = (b: ArrayLike<number>, o: number) => b[o] | (b[o + 1] << 8);

export interface Identity {
  /** Model id the vendor's device list is keyed by. [FCC probe][WEB ___getNormalID] */
  devId: number;
  /** u16 at bytes 7..8 ("usb version"). [FCC][WEB getUSBVersion][SF] */
  firmware: number;
  /** byte 9 == 1: the board is in its bootloader. [WEB getDeviceIsBoot] */
  boot: boolean;
}

export function decodeIdentify(r: Uint8Array): Identity | null {
  if (r.length < 10 || r[0] !== CMD.identify) return null;
  const devId = (r[1] | (r[2] << 8) | (r[3] << 16) | (r[4] << 24)) >>> 0;
  if (devId === 0 || devId === 0xffffffff) return null; // [WEB: 0xFFFFFFFF = no id]
  return { devId, firmware: u16(r, 7), boot: r[9] === 1 };
}

/** [0x80, lo, hi]; 0 or no echo = none (gen2 answers zeros over the cable [SF]). [WEB getRFVersion] */
export function decodeRfVersion(r: Uint8Array): number | null {
  if (r[0] !== CMD.rfVersion) return null;
  const v = (r[2] << 8) | r[1];
  return v === 0 ? null : v;
}

/** yc500 firmware revision: (reply[2] << 8) | reply[1], BCD-ish (02 00 = 2.00). [SF] */
export const ycDecodeRevision = (r: Uint8Array): number | null => (r[0] === YC.revision ? (r[2] << 8) | r[1] : null);
export const formatRevision = (v: number) => `${(v >> 8).toString(16)}.${(v & 0xff).toString(16).padStart(2, "0")}`;

export interface FeatureList {
  supported: boolean;
  precisionCode: number | null;
  /** bytes 4..6: the board offers Alt+Tab / Alt+F4 / Win lock switches. [WEB getFunctionList] */
  altTab: boolean;
  altF4: boolean;
  winLock: boolean;
}
export function decodeFeatureList(r: Uint8Array | null): FeatureList {
  const ok = !!r && r[0] === CMD.featureList && r[1] === 0xaa;
  return { supported: ok, precisionCode: ok ? r![2] : null, altTab: ok && r![4] === 1, altF4: ok && r![5] === 1, winLock: ok && r![6] === 1 };
}

const echo = (r: Uint8Array, cmd: number) => {
  if (r[0] !== cmd) throw new Error(`Expected an answer to 0x${cmd.toString(16)}, got 0x${r[0].toString(16)}.`);
};

export function decodeProfile(r: Uint8Array): number {
  echo(r, CMD.getProfile);
  return r[1];
}
/** Polling rate in Hz, null for an unknown code. [FCC][WEB] */
export function decodePolling(r: Uint8Array): number | null {
  echo(r, CMD.getPolling);
  return POLL_CODE_HZ[r[2]] ?? null;
}
export function decodeDebounce(r: Uint8Array): number {
  echo(r, CMD.getDebounce);
  return r[1];
}

export type HostOs = "win" | "mac" | "ios" | "android";
export interface Options {
  /** Byte 1; MonsGeek's driver reads 0 win, 1 mac, 2 ios, 3 android (sharkfin's Fn table uses 2 android, 3 ios). Read-only. */
  os: HostOs;
  osByte: number;
  fnIndex: number;
  antiMistouch: boolean;
  /** 0..125 ms; a level above 5 reads as 0. [WEB getKBOption][EZ] */
  rtStabilityMs: number;
  wasdSwap: boolean;
}
export function decodeOptions(r: Uint8Array): Options {
  echo(r, CMD.getOptions);
  const osNames: HostOs[] = ["win", "mac", "ios", "android"];
  return {
    os: osNames[r[1]] ?? "win",
    osByte: r[1],
    fnIndex: r[2],
    antiMistouch: r[3] === 1,
    rtStabilityMs: r[4] > 5 ? 0 : r[4] * 25,
    wasdSwap: r[5] === 1,
  };
}

/** Lighting constants of a model class: top speed and the rainbow / fixed-colour nibbles. */
export interface LightClass {
  maxSpeed: number;
  rainbow: number;
  fixed: number;
}

/** Preset colours a GET nibble 0..6 stands for (vendor COMMONCOLOR): red, orange, yellow, green, cyan, blue, magenta. [WEB][SF] */
export const PRESET_COLOURS: readonly (readonly [number, number, number])[] = [
  [255, 0, 0],
  [255, 128, 0],
  [255, 255, 0],
  [0, 255, 0],
  [0, 255, 255],
  [0, 0, 255],
  [255, 0, 255],
];

export interface Lighting {
  mode: number;
  /** 0 (slowest) .. light.maxSpeed (fastest). */
  speed: number;
  brightness: number;
  /** Direction / picture slot (option high nibble). */
  variant: number;
  colour: "rainbow" | "fixed" | "preset" | "none";
  presetIndex?: number;
  rgb: readonly [number, number, number];
}

export function decodeLightingWire(r: Uint8Array): LightingWire {
  echo(r, CMD.getLighting);
  return { mode: r[1], speedWire: r[2], brightness: r[3], option: r[4], r: r[5], g: r[6], b: r[7] };
}

/** Wire -> host. White comes back as FA FA FA. [FCC ledToFcc][WEB getLightSetting] */
export function lightingFromWire(w: LightingWire, light: LightClass): Lighting {
  const nibble = w.option & 0x0f;
  let rgb: readonly [number, number, number] = w.r === 0xfa && w.g === 0xfa && w.b === 0xfa ? [255, 255, 255] : [w.r, w.g, w.b];
  let colour: Lighting["colour"] = "none";
  let presetIndex: number | undefined;
  if (nibble === light.rainbow) colour = "rainbow";
  else if (nibble === light.fixed) colour = "fixed";
  else if (nibble <= 6 && w.mode !== USER_PICTURE_MODE && nibble !== 0) {
    colour = "preset";
    presetIndex = nibble;
    rgb = PRESET_COLOURS[nibble];
  } else if (nibble === 0 && w.mode !== USER_PICTURE_MODE) {
    colour = "preset";
    presetIndex = 0;
    rgb = PRESET_COLOURS[0];
  }
  return {
    mode: w.mode,
    speed: Math.max(0, Math.min(light.maxSpeed, light.maxSpeed - w.speedWire)),
    brightness: w.brightness,
    variant: w.option >> 4,
    colour,
    presetIndex,
    rgb,
  };
}

/**
 * Host -> wire. option = variant << 4 | (rainbow ? rainbow nibble : fixed nibble); the custom
 * per-key mode carries only its picture slot. White is sent as FA FA FA. [FCC writeLed][WEB setLightSetting]
 */
export function lightingToWire(l: Lighting, light: LightClass): LightingWire {
  if (!Number.isInteger(l.speed) || l.speed < 0 || l.speed > light.maxSpeed) throw new RangeError(`Speed must be 0..${light.maxSpeed} (got ${l.speed}).`);
  const custom = l.mode === USER_PICTURE_MODE;
  const nibble = custom ? 0 : l.colour === "rainbow" ? light.rainbow : light.fixed;
  let [r, g, b] = l.rgb;
  if (r === 255 && g === 255 && b === 255) [r, g, b] = [0xfa, 0xfa, 0xfa];
  return { mode: l.mode, speedWire: light.maxSpeed - l.speed, brightness: l.brightness, option: (l.variant << 4) | nibble, r, g, b };
}

/** Concatenated raw pages of a paged read (no echo; every page is 64 data bytes). */
export function joinPages(pages: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pages.length * FRAME_LEN);
  pages.forEach((p, i) => {
    if (p.length !== FRAME_LEN) throw new Error(`Page ${i} is ${p.length} bytes (expected ${FRAME_LEN}).`);
    out.set(p, i * FRAME_LEN);
  });
  return out;
}

export function decodeKeymapPages(pages: readonly Uint8Array[]): Uint8Array {
  if (pages.length !== KEYMAP_READ_PAGES) throw new Error(`A keymap read is ${KEYMAP_READ_PAGES} pages (got ${pages.length}).`);
  return joinPages(pages).slice(0, KEYMAP_BYTES);
}

export function decodeU16Table(pages: readonly Uint8Array[], count = POSITIONS): Uint16Array {
  const raw = joinPages(pages);
  const out = new Uint16Array(count);
  for (let p = 0; p < count; p++) out[p] = u16(raw, p * 2);
  return out;
}

export function decodeU8Table(pages: readonly Uint8Array[], count = POSITIONS): Uint8Array {
  return joinPages(pages).slice(0, count);
}

/**
 * Table 10: four 128-byte blocks (one per binding row, two pages each), 8 pages. Each byte holds four
 * 2-bit stage cells. yc500 uses the first 126 bytes of each block. [FCC][SF "two pages a block"]
 */
export function decodeDksBindings(pages: readonly Uint8Array[], count = POSITIONS): Uint8Array[] {
  const raw = joinPages(pages);
  return [0, 1, 2, 3].map((row) => raw.slice(row * 128, row * 128 + count));
}

export const kindOf = (mode: number): number => mode & 0x7f;
export const rtOn = (mode: number): boolean => (mode & RT_FLAG) !== 0;
export const kindName = (mode: number): KindName | "unknown" => (Object.keys(KIND) as KindName[]).find((k) => KIND[k] === kindOf(mode)) ?? "unknown";

/** DKS stage cells: 0 none, 1 tap, 2 hold to the next stage, 3 hold across. Four per row byte. [FCC][SF] */
export type DksCell = 0 | 1 | 2 | 3;
export const packDksRow = (cells: readonly DksCell[]): number => cells.reduce<number>((acc, c, j) => acc | ((c & 3) << (j * 2)), 0);
export const unpackDksRow = (b: number): DksCell[] => [0, 1, 2, 3].map((j) => ((b >> (j * 2)) & 3) as DksCell);

// yc500 decoders --------------------------------------------------------------------------------

export function ycDecodeProfile(r: Uint8Array): number {
  echo(r, YC.getProfile);
  return r[1];
}
/** Debounce at byte 2 on yc500. [SF][WEB getDeBounce] */
export function ycDecodeDebounce(r: Uint8Array): number {
  echo(r, YC.getDebounce);
  return r[2];
}
export interface YcOptions {
  winLock: boolean;
  mac: boolean;
  wasdSwap: boolean;
  backlightOff: boolean;
  sideLightOff: boolean;
  /** byte 2 bit 128; never written by SYNQ. */
  keyboardLock: boolean;
  fnMatrix: number;
  powerSave: number;
}
/** Byte 2 bitfield: 1 win lock, 2 mac, 8 WASD swap, 16 backlight off, 32 side light off, 128 lock. [SF][WEB ___getKbOption] */
export function ycDecodeOptions(r: Uint8Array): YcOptions {
  echo(r, YC.getOptions);
  const o = r[2];
  return { winLock: !!(o & 1), mac: !!(o & 2), wasdSwap: !!(o & 8), backlightOff: !!(o & 16), sideLightOff: !!(o & 32), keyboardLock: !!(o & 128), fnMatrix: r[3], powerSave: r[4] };
}

// Small helpers -------------------------------------------------------------------------------

export const hexBytes = (b: ArrayLike<number>, n = b.length) => Array.from({ length: Math.min(n, b.length) }, (_, i) => b[i].toString(16).padStart(2, "0")).join(" ");
