// The SparkLink ("PlayJoy") keyboard framing and the commands SYNQ uses. Pure codec: no device access.
//
// Sources, all read as documentation of a wire format and re-implemented here (nothing is copied or run):
//   - @sparklinkplayjoy/sdk-keyboard 1.0.24 and @sparklinkplayjoy/protocol-keyboard 1.0.7 on npm (package.json says
//     "license": "MIT"; neither package ships a LICENSE file or per-file headers, and the docs repo
//     sparklinkplayjoy/keyboard-docs has no licence file at all), for the framing, the order and layout numbers
//     and the reply layouts;
//   - AureTrix-Solutions/AureTrix_driver (MIT), a web configurator built on that SDK, for how its calls are used
//     (key mode, actuation, rapid trigger and dead zones are written per key by the key's default key value);
//   - @openmouse/keyboard-protocol 1.1.0 (AGPL-3.0-or-later; the Kochi codec), which exercised the same framing on
//     a Kochi Hummingbird 68 (1CA2:0901): the checksum rule, the name and Windows / Mac orders.
// SYNQ is AGPL-3.0. This is the SparkLink "v1" family on usage page 0xFFA0 (RK, AULA, Kochi). The newer "v2" SDK
// (sdk-keyboard-v2) speaks to usage page 0xFFB0 with another framing and is not used here.
//
// Every message is one 64-byte output report with no report id, and the reply is one input report:
//
//   request  [0x5C, len, cmd, checksum, data...]        data is `len` bytes (1..60), the rest zero
//   reply    [0x5C, len, cmd | 0x80, checksum, data...]  (cmd 0xFF = the keyboard refused)
//   checksum = (0x35 + 0x5C + len + cmd + data[len - 1]) & 0xFF
//
// `cmd` is a command class: 0 an "order" (data = [order type, args..., 0xFF, 0xFF]), 1 sync (board info), 35 key
// layouts (data = [flag 0 read / 1 write, then 4-byte groups key, layout, value lo, value hi]), 41 global travel,
// 43 default key table. A key is addressed by its default key value (the HID usage the factory layout has on it,
// 1 = Fn). Travel values travel in micrometres. Replies to our requests are matched by command class and the echoed
// order type / key / layout; anything else the board sends (it can stream) is skipped.

export const HEADER = 0x5c;
export const FRAME_LEN = 64;
export const HEADER_LEN = 4;
/** The most data bytes one message carries. */
export const MAX_DATA = 60;
export const REPLY_FLAG = 0x80;
export const FAIL = 0xff;

/** Command classes SYNQ sends. The others the SDK has (higher keys, macros, lighting, firmware) are listed in guard.ts as blocked. */
export const CMD = { order: 0, sync: 1, key: 35, db: 41, defKey: 43 } as const;

/**
 * Command classes that are never sent, by the SDK's names. 8 to 14 are the bootloader (sign, erase, reboot,
 * to-app, write, read, crc); 48 and 49 write a picture to a screen.
 */
export const NEVER_CMD: Readonly<Record<number, { name: string; why: "firmware" | "macro" | "unknown" }>> = {
  8: { name: "bootloader sign", why: "firmware" },
  9: { name: "bootloader erase", why: "firmware" },
  10: { name: "bootloader reboot", why: "firmware" },
  11: { name: "bootloader to app", why: "firmware" },
  12: { name: "bootloader write", why: "firmware" },
  13: { name: "bootloader read", why: "firmware" },
  14: { name: "bootloader crc", why: "firmware" },
  18: { name: "raw travel matrix (calibration reads)", why: "unknown" },
  32: { name: "macro data", why: "macro" },
  33: { name: "macro mode", why: "macro" },
  36: { name: "mod-tap", why: "unknown" },
  37: { name: "toggle key", why: "unknown" },
  38: { name: "dynamic keystroke", why: "unknown" },
  39: { name: "multi-point trigger", why: "unknown" },
  40: { name: "end key", why: "unknown" },
  44: { name: "SOCD", why: "unknown" },
  45: { name: "rapid-switch key", why: "unknown" },
  48: { name: "screen picture", why: "firmware" },
  49: { name: "screen picture write", why: "firmware" },
};

/** Order types (data[0] of a class-0 message), by the SDK's names. Only the ones in READ_ORDERS / MODE_ORDERS are ever sent. */
export const ORDER = {
  protocolVersion: 0x01,
  savingParameter: 0x02,
  reloadParameters: 0x03,
  clearCalibration: 0x04,
  openDks: 0x05,
  closeDks: 0x06,
  reverse: 0x07,
  remappingOn: 0x08,
  remappingOff: 0x09,
  relativeTriggerOn: 0x0a,
  relativeTriggerOff: 0x0b,
  calibrationStart: 0x0c,
  calibrationClose: 0x0d,
  demoStart: 0x0e,
  demoClose: 0x0f,
  eraseMacroStorage: 0x10,
  factoryReset: 0x11,
  lockWinKey: 0x20,
  queryWin: 0x21,
  queryMac: 0x22,
  queryStandard: 0x23,
  queryAdjustable: 0x24,
  precisionStroke: 0x25,
  keyboardName: 0x26,
  setWin: 0x30,
  setMac: 0x31,
  setStandard: 0x32,
  setAdjustable: 0x33,
  topDeadSwitch: 0x34,
  rgb1: 0x40,
  rgb2: 0x41,
  rgb3: 0x42,
  rgb4: 0x43,
  lightFixRgb: 0x44,
  rgbNack: 0x47,
  rateOfReturn: 0x50,
  web: 0x60,
  socd: 0x61,
  config: 0x70,
  currentAxis: 0x75,
  axisList: 0x76,
} as const;

/**
 * Orders SYNQ reads with, in the shape [type, 0xFF, 0xFF]: the arguments are the "no argument" filler, which these
 * orders answer with their current value (the SDK's own readiness probe and AureTrix send ORDER_TYPE_ROES that way).
 */
export const READ_ORDERS: readonly number[] = [
  ORDER.protocolVersion,
  ORDER.lockWinKey,
  ORDER.queryWin,
  ORDER.queryMac,
  ORDER.precisionStroke,
  ORDER.keyboardName,
  ORDER.rateOfReturn,
  ORDER.config,
  ORDER.currentAxis,
  ORDER.axisList,
];
/** Orders that switch Windows / Mac mode, in the exact shape OpenMouse exercised on a Kochi Hummingbird 68. */
export const MODE_ORDERS: readonly number[] = [ORDER.setWin, ORDER.setMac];

/** Key layouts (data of a class-35 message), by the SDK's names. */
export const LAYOUT = {
  fn0: 0,
  fn1: 1,
  fn2: 2,
  fn3: 3,
  /** The key's own actuation travel (single and rapid-trigger keys). */
  db0: 4,
  db1: 5,
  db2: 6,
  db3: 7,
  /** Touch mode in the high nibble, advanced-key mode in the low nibble. */
  mode: 8,
  dks1: 9,
  dks2: 10,
  dks3: 11,
  dks4: 12,
  trps1: 13,
  trps2: 14,
  trps3: 15,
  trps4: 16,
  macroAddr: 17,
  macroSize: 18,
  mtDelay: 19,
  /** Rapid trigger: press (re-trigger) distance. */
  rtp: 20,
  /** Rapid trigger: release (reset) distance. */
  rtr: 21,
  /** Top (press) dead zone. */
  dp: 22,
  /** Bottom (release) dead zone. */
  dr: 23,
  kr: 24,
  /** The key's switch type: part of the sensor calibration, never written. */
  axis: 25,
  rs: 32,
} as const;

/** The layouts SYNQ reads, and the ones it writes (a subset). */
export const READ_LAYOUTS: readonly number[] = [LAYOUT.db0, LAYOUT.mode, LAYOUT.rtp, LAYOUT.rtr, LAYOUT.dp, LAYOUT.dr];
export const WRITE_LAYOUTS: readonly number[] = [LAYOUT.db0, LAYOUT.mode, LAYOUT.rtp, LAYOUT.rtr, LAYOUT.dp, LAYOUT.dr];
/** Layouts whose value is a travel in micrometres. */
export const TRAVEL_LAYOUTS: readonly number[] = [LAYOUT.db0, LAYOUT.rtp, LAYOUT.rtr, LAYOUT.dp, LAYOUT.dr];
/** The most travel a value may name, micrometres (the SDK documents 0 to 4000). */
export const MAX_TRAVEL_UM = 4000;
/** Touch modes, the high nibble of the mode layout. */
export const TOUCH = { global: 0, single: 1, rt: 2 } as const;
export type Touch = keyof typeof TOUCH;
/** Key groups the default-key table covers: 6 rows of 21 columns. */
export const MATRIX_ROWS = 6;
export const MATRIX_COLS = 21;
/** Entries one key read or write message may carry (4 bytes each after the flag). */
export const MAX_GROUPS = 14;

// ---------------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------------

/** Checksum of a frame: 0x35 + the header byte + len + cmd + the last data byte, low byte. Needs a valid `len`. */
export function checksum(f: ArrayLike<number>): number {
  const len = f[1];
  return (0x35 + f[0] + len + f[2] + f[HEADER_LEN + len - 1]) & 0xff;
}

/** One request frame: the data is 1..60 bytes. */
export function frame(cmd: number, data: ArrayLike<number>): Uint8Array {
  if (!Number.isInteger(cmd) || cmd < 0 || cmd > 255) throw new RangeError("command out of range");
  if (data.length < 1 || data.length > MAX_DATA) throw new RangeError(`a message carries 1..${MAX_DATA} data bytes`);
  const f = new Uint8Array(FRAME_LEN);
  f[0] = HEADER;
  f[1] = data.length;
  f[2] = cmd;
  for (let i = 0; i < data.length; i++) f[HEADER_LEN + i] = data[i] & 0xff;
  f[3] = checksum(f);
  return f;
}

/** An order with no argument: [type, 0xFF, 0xFF]. */
export const orderFrame = (type: number): Uint8Array => frame(CMD.order, [type, 0xff, 0xff]);

/** The board-info message. */
export const syncFrame = (): Uint8Array => frame(CMD.sync, [1, 2, 3, 4, 0xff, 0xff]);

/** Reads the default key table rows `a` and `b` (0..5). */
export function defKeyFrame(a: number, b: number): Uint8Array {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= MATRIX_ROWS || b >= MATRIX_ROWS) throw new RangeError("row out of range");
  return frame(CMD.defKey, [0, a, b]);
}

/** Reads the given layouts of one key (at most 14 groups). */
export function keyReadFrame(key: number, layouts: readonly number[]): Uint8Array {
  if (!Number.isInteger(key) || key < 1 || key > 255) throw new RangeError("key value out of range");
  if (!layouts.length || layouts.length > MAX_GROUPS) throw new RangeError(`a read names 1..${MAX_GROUPS} layouts`);
  const data = [0];
  for (const l of layouts) data.push(key, l, 0, 0);
  return frame(CMD.key, data);
}

/** Writes one layout of one key (value 0..65535). */
export function keyWriteFrame(key: number, layout: number, value: number): Uint8Array {
  if (!Number.isInteger(key) || key < 1 || key > 255) throw new RangeError("key value out of range");
  if (!Number.isInteger(layout) || layout < 0 || layout > 255) throw new RangeError("layout out of range");
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError("value out of range");
  return frame(CMD.key, [1, key, layout, value & 0xff, value >> 8]);
}

export interface GlobalTravel {
  /** Actuation travel of the keys in global mode, micrometres. */
  travel: number;
  /** Top (press) dead zone, micrometres. */
  pressDead: number;
  /** Bottom (release) dead zone, micrometres. */
  releaseDead: number;
}

const u16 = (v: number): [number, number] => [v & 0xff, (v >> 8) & 0xff];

/** Reads the global travel settings. */
export const dbReadFrame = (): Uint8Array => frame(CMD.db, [0, ...new Array(14).fill(0)]);

/** Writes the global travel settings: [1, 0, 0, travel, pressDead, releaseDead, 6 zero bytes]. */
export function dbWriteFrame(g: GlobalTravel): Uint8Array {
  for (const v of [g.travel, g.pressDead, g.releaseDead]) if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError("travel out of range");
  return frame(CMD.db, [1, 0, 0, ...u16(g.travel), ...u16(g.pressDead), ...u16(g.releaseDead), 0, 0, 0, 0, 0, 0]);
}

// ---------------------------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------------------------

export interface Message {
  cmd: number;
  len: number;
  data: Uint8Array;
}

/** A request frame taken apart; null when it is not one (wrong header, length, checksum or padding). */
export function parseRequest(f: Uint8Array): Message | null {
  if (f.length !== FRAME_LEN || f[0] !== HEADER || f[1] < 1 || f[1] > MAX_DATA || f[3] !== checksum(f)) return null;
  for (let i = HEADER_LEN + f[1]; i < FRAME_LEN; i++) if (f[i] !== 0) return null;
  return { cmd: f[2], len: f[1], data: f.slice(HEADER_LEN, HEADER_LEN + f[1]) };
}

/** A reply taken apart (`cmd` is the request's command class, with the reply bit removed); null when it is not one. */
export function parseReply(f: Uint8Array): (Message & { failed: boolean }) | null {
  if (f.length !== FRAME_LEN || f[0] !== HEADER || f[1] < 1 || f[1] > MAX_DATA || f[3] !== checksum(f)) return null;
  const failed = f[2] === FAIL;
  if (!failed && (f[2] & REPLY_FLAG) === 0) return null;
  return { cmd: f[2] & ~REPLY_FLAG & 0xff, len: f[1], data: f.slice(HEADER_LEN, HEADER_LEN + f[1]), failed };
}

/** Whether `reply` answers `request`: same command class and the echoed order type / key and layout / row. */
export function answers(request: Uint8Array, reply: Uint8Array): boolean {
  const q = parseRequest(request);
  const r = parseReply(reply);
  if (!q || !r) return false;
  if (r.failed) return true;
  if (r.cmd !== q.cmd) return false;
  switch (q.cmd) {
    case CMD.order:
      return r.data[1] === q.data[0];
    case CMD.key:
      // A key the board has no such layout for echoes layout 0xFF.
      return r.data[1] === q.data[1] && (r.data[2] === q.data[2] || r.data[2] === 0xff);
    case CMD.defKey:
      return r.data[1] === q.data[1];
    default:
      return true;
  }
}

const text = (b: Uint8Array): string => new TextDecoder("utf-8").decode(b.filter((x) => x !== 0)).trim();

export interface SyncInfo {
  boardId: number;
  keyType: number;
  keyboardLayout: number;
  runMode: number;
  serial: string;
  /** "V1.2.3" when the version word is below 1000, else "". */
  versionString: string;
  appVersion: string;
  buildDate: string;
  /** The application text starts with "Boot": the board is in its bootloader. */
  bootloader: boolean;
}

/** The sync reply (data bytes), as the SDK's getCmdSync reads it. */
export function decodeSync(d: Uint8Array): SyncInfo {
  const boardId = (d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24)) >>> 0;
  const word = d[5] | (d[6] << 8);
  const versionString = word < 1000 ? `V${Math.floor(word / 100)}.${Math.floor((word % 100) / 10)}.${word % 10}` : "";
  const boot = text(d.slice(26, 30)).startsWith("Boot");
  return {
    boardId,
    keyType: d[3],
    keyboardLayout: d[4],
    runMode: d[7],
    serial: text(d.slice(9, 25)),
    versionString,
    appVersion: text(d.slice(26, boot ? 37 : 36)),
    buildDate: text(d.slice(43, 54)),
    bootloader: boot,
  };
}

/** The order-reply value bytes (data[2...]). */
export function decodeProtocolVersion(d: Uint8Array): string {
  return `${d[3] & 15}.${(d[2] >> 4) & 15}.${d[2] & 15}`;
}
export const decodeName = (d: Uint8Array): string => text(d.slice(2, 34));

export interface Precision {
  /** One step of travel, mm. */
  stepMm: number;
  minMm: number;
  maxMm: number;
}
export function decodePrecision(d: Uint8Array): Precision {
  return { stepMm: d[2] / 1000, minMm: (d[3] | (d[4] << 8)) / 1000, maxMm: (d[5] | (d[6] << 8)) / 1000 };
}

/** Windows / Mac query reply: 1 yes, 0 no, null when the board has no such mode (255). */
export function decodeModeQuery(d: Uint8Array): boolean | null {
  return d[2] === 1 ? true : d[2] === 0 ? false : null;
}

/** The set-mode reply of a mode order SYNQ sent: acknowledged when the value byte is 1. */
export const decodeModeAck = (d: Uint8Array): boolean => d[2] === 1;

export const RATE_HZ: readonly number[] = [8000, 4000, 2000, 1000, 500, 250, 125];
/** The reply of a rate-of-return query: an index into RATE_HZ, or null when it names none. */
export function decodeRate(d: Uint8Array): number | null {
  return RATE_HZ[d[2]] ?? null;
}

export const decodeConfig = (d: Uint8Array): number => d[2];

export interface KeyEntry {
  key: number;
  layout: number;
  value: number;
}
/** The 4-byte groups of a key reply (the first data byte is the echoed flag). Groups with layout 255 or value 0xFFFF are "not available". */
export function decodeKeyEntries(d: Uint8Array): KeyEntry[] {
  const out: KeyEntry[] = [];
  for (let at = 1; at + 3 < d.length; at += 4) {
    const key = d[at];
    const layout = d[at + 1];
    const value = d[at + 2] | (d[at + 3] << 8);
    if (key === 0 || layout === 0xff || value === 0xffff) continue;
    out.push({ key, layout, value });
  }
  return out;
}

export const modeValue = (touch: Touch | number, adv = 0): number => ((typeof touch === "number" ? touch : TOUCH[touch]) << 4) | (adv & 15);
export interface ModeValue {
  touch: Touch;
  /** Advanced-key mode, 0 for none. */
  adv: number;
}
export function decodeMode(value: number): ModeValue {
  const n = value & 0xff;
  const t = (n >> 4) & 15;
  return { touch: t === 1 ? "single" : t === 2 ? "rt" : "global", adv: n & 15 };
}

/** The global travel reply: travel at bytes 3-4, press dead zone 5-6, release dead zone 7-8. */
export function decodeDb(d: Uint8Array): GlobalTravel {
  return { travel: d[3] | (d[4] << 8), pressDead: d[5] | (d[6] << 8), releaseDead: d[7] | (d[8] << 8) };
}

export interface DefKey {
  row: number;
  col: number;
  /** The default key value (a HID usage; 1 = Fn). */
  value: number;
}
/** One default-key reply: two rows of 21 values (rows at bytes 1 and 23). */
export function decodeDefKeys(d: Uint8Array): DefKey[] {
  const out: DefKey[] = [];
  const rows: [number, number][] = [
    [d[1], 2],
    [d[23], 24],
  ];
  for (const [row, from] of rows) for (let c = 0; c < MATRIX_COLS; c++) if (d[from + c]) out.push({ row, col: c, value: d[from + c] });
  return out;
}

export const um = (mm: number): number => Math.round(mm * 1000);
export const mm = (micrometres: number): number => Math.round(micrometres) / 1000;
