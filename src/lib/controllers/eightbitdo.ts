// 8BitDo Ultimate (wave C3): its three onboard profiles in HID config mode. The configuration is one 1652-byte struct
// read and written in 45-byte chunks over output report 0x81 (answers on input report 0x02), committed by a save
// command; the struct carries a CRC-16/KERMIT at 0x0C. Source (MIT): s8n/ultimatecontroller-rs docs/protocol.md and
// src/protocol (from the official Windows / Android apps, checked with USB captures), configurable on the Ultimate
// 2.4G adapter (3012), the Ultimate PC (3011) and the config mode (6007) only; any other 8BitDo id is read only.
//
// Safety: SYNQ sends the report-state, version, chunk read, chunk write, save and vibration-test commands only.
// Never calibration (direct 0x36 / 0x38), the vibration-parameter writes that disconnect the pad (0x0B / 0x0C), reset
// (0x0D), boot or firmware commands, nor anything to a boot or recovery id. Each chunk written is checked field by field
// where a field lies inside it (modes, slot, names, rumble 0-1, ranges in order, known feature and button bits, macro
// counts); guard.ts and src-tauri/src/pads.rs judge every frame the same way. The XInput (3106) -> config-mode switch
// is not built: it goes through xusb22 on Windows and needs the developer (CONTROLLERS.md §5.7).
// Pure data and functions: no DOM, no React, no device access.

export const EBD_OUT = 0x81;
/** Answers come back as input report 0x02 (ultimatecontroller-rs reads it as a leading "status 0x02"). */
export const EBD_IN = 0x02;
/** Bytes after the report id. */
export const EBD_LEN = 63;
export const EBD_CONFIG_SIZE = 1652;
export const EBD_CHUNK = 45;
export const EBD_CMD = { write: 1, read: 2, readResponse: 4, save: 6, reportState: 7, vibrate: 8 } as const;
export const EBD_SAVE_SUB = 0x15;
/** The vibration test's longest duration (ms): it stops by itself. */
export const EBD_VIBRATE_MAX_MS = 1000;
const TYPE = 0x04;

/** CRC-16/KERMIT as 8BitDo uses it: poly 0x8408 reflected, init 0xFFFF, no final xor. */
export function crc16Kermit(bytes: ArrayLike<number>, from = 0, to = bytes.length): number {
  let crc = 0xffff;
  for (let i = from; i < to; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return crc;
}

// ---- the struct

export const EBD_AT = {
  crc: 0x00c,
  mode: 0x010,
  slot: 0x012,
  names: 0x014,
  rumble: 0x074,
  sticks: 0x098,
  triggers: 0x0b0,
  special: 0x0c8,
  keys: 0x0e0,
  macros: 0x1dc,
} as const;
export const EBD_NAME_LEN = 32;
const KEYS_RECORD = 84;
const MACRO_RECORD = 392;

/** Button bits a mapping may hold (MAP_KEY bitmasks: buttons, d-pad, menu, home, BT, screenshot, turbo, paddles). */
export const EBD_KEY_BITS = 0x07c7ffff;
/** Special-feature bits: invert LX/LY/RX/RY, swap sticks, swap triggers, dead zone on, 4-way d-pad. */
export const EBD_FEATURE_BITS = 0x309f;
export const EBD_FEATURES = [
  { bit: 0x0001, name: "Invert left stick X" },
  { bit: 0x0002, name: "Invert left stick Y" },
  { bit: 0x0004, name: "Invert right stick X" },
  { bit: 0x0008, name: "Invert right stick Y" },
  { bit: 0x0010, name: "Swap the sticks" },
  { bit: 0x0080, name: "Swap the triggers" },
  { bit: 0x1000, name: "Dead zone on" },
  { bit: 0x2000, name: "4-way d-pad" },
] as const;

/** The 20 mappable inputs (MAP_KEY_E), and the button each one sends by default. */
export const EBD_INPUTS = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "LS", "RS", "Select", "Start", "Star", "Home", "Up", "Down", "Left", "Right", "P1", "P2"] as const;
/** Targets SYNQ offers (single buttons; P1 / P2 are never targets: the firmware can't send them). */
export const EBD_TARGETS: readonly { name: string; bits: number }[] = [
  { name: "A", bits: 0x2000 },
  { name: "B", bits: 0x1000 },
  { name: "X", bits: 0x0010 },
  { name: "Y", bits: 0x0020 },
  { name: "LB", bits: 0x0400 },
  { name: "RB", bits: 0x0800 },
  { name: "LT", bits: 0x4000 },
  { name: "RT", bits: 0x8000 },
  { name: "LS", bits: 0x0002 },
  { name: "RS", bits: 0x0004 },
  { name: "Select", bits: 0x0008 },
  { name: "Start", bits: 0x0001 },
  { name: "Up", bits: 0x0200 },
  { name: "Down", bits: 0x0100 },
  { name: "Left", bits: 0x0080 },
  { name: "Right", bits: 0x0040 },
  { name: "Home", bits: 0x20000 },
  { name: "None", bits: 0 },
];

/** Why the bytes of a chunk at `offset` aren't a config SYNQ writes, or null (checks each field inside the chunk). */
export function ebdChunkProblem(offset: number, chunk: Uint8Array): string | null {
  const end = offset + chunk.length;
  const has = (at: number, n: number) => at >= offset && at + n <= end;
  const b = (at: number) => chunk[at - offset];
  const u16 = (at: number) => b(at) | (b(at + 1) << 8);
  const u32 = (at: number) => (b(at) | (b(at + 1) << 8) | (b(at + 2) << 16) | (b(at + 3) << 24)) >>> 0;
  const f32 = (at: number) => new DataView(Uint8Array.from([b(at), b(at + 1), b(at + 2), b(at + 3)]).buffer).getFloat32(0, true);
  if (has(EBD_AT.mode, 2) && u16(EBD_AT.mode) > 5) return "gamepad mode";
  if (has(EBD_AT.slot, 2) && u16(EBD_AT.slot) > 2) return "active profile";
  for (let at = Math.max(offset, EBD_AT.names); at < Math.min(end, EBD_AT.names + 3 * EBD_NAME_LEN); at++) if (b(at) !== 0 && b(at) < 0x20) return "a control character in a profile name";
  for (let i = 0; i < 3; i++) {
    for (const at of [EBD_AT.rumble + i * 12 + 4, EBD_AT.rumble + i * 12 + 8]) {
      if (!has(at, 4)) continue;
      const v = f32(at);
      if (!(v >= 0 && v <= 1)) return "rumble 0 to 1";
    }
    for (const base of [EBD_AT.sticks + i * 8, EBD_AT.triggers + i * 8]) {
      for (const at of [base + 4, base + 6]) if (has(at, 2) && b(at) > b(at + 1)) return "a range that ends before it starts";
    }
    if (has(EBD_AT.special + i * 8 + 4, 4) && (u32(EBD_AT.special + i * 8 + 4) & ~EBD_FEATURE_BITS) !== 0) return "an unknown special-feature bit";
    for (let k = 0; k < 20; k++) {
      const at = EBD_AT.keys + i * KEYS_RECORD + 4 + k * 4;
      if (has(at, 4) && (u32(at) & ~EBD_KEY_BITS) !== 0) return "an unknown button bit";
    }
    const macro = EBD_AT.macros + i * MACRO_RECORD;
    if (has(macro + 4, 1) && b(macro + 4) > 4) return "more than 4 macros";
    for (let m = 0; m < 4; m++) if (has(macro + 8 + m * 96 + 94, 1) && b(macro + 8 + m * 96 + 94) > 18) return "a macro longer than 18 steps";
  }
  return null;
}

export type EbdVerdict = { ok: true; what: string } | { ok: false; why: string };

/** The guard for one output report to an 8BitDo Ultimate in config mode (`data` excludes the report id). */
export function checkEbdOutput(reportId: number, data: Uint8Array): EbdVerdict {
  const no = (why: string): EbdVerdict => ({ ok: false, why: `8BitDo: ${why}.` });
  if (reportId !== EBD_OUT) return no(`output report 0x${reportId.toString(16)} isn't the config channel's`);
  if (data.length !== EBD_LEN) return no("config reports are 64 bytes");
  const rest = (from: number) => data.subarray(from).every((x) => x === 0);
  const u16 = (at: number) => data[at] | (data[at + 1] << 8);
  const u32 = (at: number) => (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
  if (data[1] !== TYPE) {
    // Direct commands: the firmware version read only (never calibration 0x36 / 0x38 or anything else).
    if (data[0] === 0x05 && data[1] === 0x00 && data[2] === 0x21 && data[3] === 0x01 && data[4] === 0x00 && rest(5)) return { ok: true, what: "firmware version" };
    return no(`direct command 0x${data[1].toString(16)}${data[2].toString(16).padStart(2, "0")} is never sent${data[2] === 0x36 || data[2] === 0x38 ? " (stick calibration)" : ""}`);
  }
  const cmd = u16(2);
  const sub = u16(4);
  switch (cmd) {
    case EBD_CMD.reportState:
      return data[0] === 0x11 && sub === 0 && rest(6) ? { ok: true, what: "config mode" } : no("the report-state command");
    case EBD_CMD.save:
      return data[0] === 0x11 && sub === EBD_SAVE_SUB && rest(6) ? { ok: true, what: "save" } : no("the save command");
    case EBD_CMD.vibrate:
      return data[0] === 0x11 && sub >= 1 && sub <= EBD_VIBRATE_MAX_MS && rest(8) ? { ok: true, what: "vibration test" } : no("the vibration test (at most 1 s)");
    case EBD_CMD.read:
    case EBD_CMD.write: {
      const chunk = u16(6);
      const total = u32(10);
      const offset = u32(14);
      if (sub !== 0 || total !== EBD_CONFIG_SIZE || offset % EBD_CHUNK !== 0 || offset >= EBD_CONFIG_SIZE || chunk !== Math.min(EBD_CHUNK, EBD_CONFIG_SIZE - offset)) return no("a chunk of the 1652-byte config");
      if (cmd === EBD_CMD.read) return data[0] === 0x11 && u16(8) === 0 && rest(18) ? { ok: true, what: `read ${offset}` } : no("a read carries no data");
      const payload = data.subarray(18, 18 + chunk);
      if (data[0] !== 17 + chunk || u16(8) !== crc16Kermit(payload) || !rest(18 + chunk)) return no("a write chunk with its CRC");
      const why = ebdChunkProblem(offset, payload);
      return why ? no(why) : { ok: true, what: `write ${offset}` };
    }
    default:
      return no(`command ${cmd} is never sent${cmd === 0x0b || cmd === 0x0c ? " (vibration parameters: it can disconnect the pad)" : cmd === 0x0d ? " (reset)" : ""}`);
  }
}

// ---- frames

const frame = (bytes: number[]) => {
  const d = new Uint8Array(EBD_LEN);
  d.set(bytes);
  return { reportId: EBD_OUT, data: d };
};
const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

export const ebdReportState = () => frame([0x11, TYPE, ...le16(EBD_CMD.reportState), 0, 0]);
export const ebdSave = () => frame([0x11, TYPE, ...le16(EBD_CMD.save), ...le16(EBD_SAVE_SUB)]);
export const ebdVersion = () => frame([0x05, 0x00, 0x21, 0x01, 0x00]);
/** The vibration test: both motors (0-255) for `ms` (at most 1000), then it stops by itself. */
export const ebdVibrate = (left: number, right: number, ms = 600) => frame([0x11, TYPE, ...le16(EBD_CMD.vibrate), ...le16(Math.max(1, Math.min(EBD_VIBRATE_MAX_MS, ms))), left & 0xff, right & 0xff]);

/** Every read chunk of the config, in order. */
export function ebdReads(): { reportId: number; data: Uint8Array; offset: number }[] {
  const out = [];
  for (let off = 0; off < EBD_CONFIG_SIZE; off += EBD_CHUNK) {
    const n = Math.min(EBD_CHUNK, EBD_CONFIG_SIZE - off);
    out.push({ ...frame([0x11, TYPE, ...le16(EBD_CMD.read), 0, 0, ...le16(n), 0, 0, ...le32(EBD_CONFIG_SIZE), ...le32(off)]), offset: off });
  }
  return out;
}

/** Every write chunk of a whole config, in order. */
export function ebdWrites(config: Uint8Array): { reportId: number; data: Uint8Array; offset: number }[] {
  if (config.length !== EBD_CONFIG_SIZE) throw new RangeError("an 8BitDo config is 1652 bytes");
  const out = [];
  for (let off = 0; off < EBD_CONFIG_SIZE; off += EBD_CHUNK) {
    const n = Math.min(EBD_CHUNK, EBD_CONFIG_SIZE - off);
    const payload = config.subarray(off, off + n);
    out.push({ ...frame([17 + n, TYPE, ...le16(EBD_CMD.write), 0, 0, ...le16(n), ...le16(crc16Kermit(payload)), ...le32(EBD_CONFIG_SIZE), ...le32(off), ...payload]), offset: off });
  }
  return out;
}

// ---- answers (input report 0x02, data without the id)

export interface EbdAnswer {
  cmd: number;
  sub: number;
  offset?: number;
  data?: Uint8Array;
  version?: string;
}

export function parseEbdAnswer(data: Uint8Array): EbdAnswer | null {
  if (data.length < 4) return null;
  if (data[0] === 0x22) return { cmd: 0x22, sub: 0, version: (() => {
    const v = data[1] | (data[2] << 8);
    return `${Math.floor(v / 100)}.${String(v % 100).padStart(2, "0")}`;
  })() };
  if (data[0] !== TYPE) return null;
  const u16 = (at: number) => data[at] | (data[at + 1] << 8);
  const cmd = u16(1);
  const sub = u16(3);
  if (data.length < 17) return { cmd, sub };
  const n = u16(5);
  const offset = (data[13] | (data[14] << 8) | (data[15] << 16) | (data[16] << 24)) >>> 0;
  return { cmd, sub, offset, data: data.slice(17, 17 + n) };
}

// ---- the config as the page shows it

export interface EbdProfile {
  slot: number;
  name: string;
  /** 0-1 each. */
  rumble: [number, number];
  sticks: [{ start: number; end: number }, { start: number; end: number }];
  triggers: [{ start: number; end: number }, { start: number; end: number }];
  features: number;
  /** One per input (EBD_INPUTS): the button bits it sends. */
  keys: number[];
}

export interface EbdConfig {
  bytes: Uint8Array;
  /** The stored CRC matches the bytes: the layout is the one SYNQ knows (writes need it). */
  crcOk: boolean;
  mode: number;
  active: number;
  profiles: EbdProfile[];
}

export const ebdCrcOf = (bytes: Uint8Array): number => {
  const c = bytes.slice();
  c.fill(0, EBD_AT.crc, EBD_AT.crc + 4);
  return crc16Kermit(c);
};

export function parseEbdConfig(bytes: Uint8Array): EbdConfig {
  if (bytes.length !== EBD_CONFIG_SIZE) throw new RangeError("an 8BitDo config is 1652 bytes");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const profiles: EbdProfile[] = [0, 1, 2].map((i) => {
    const nameBytes = bytes.subarray(EBD_AT.names + i * EBD_NAME_LEN, EBD_AT.names + (i + 1) * EBD_NAME_LEN);
    const end = nameBytes.indexOf(0);
    const range = (at: number) => ({ start: bytes[at], end: bytes[at + 1] });
    return {
      slot: i,
      name: new TextDecoder().decode(nameBytes.subarray(0, end < 0 ? EBD_NAME_LEN : end)),
      rumble: [v.getFloat32(EBD_AT.rumble + i * 12 + 4, true), v.getFloat32(EBD_AT.rumble + i * 12 + 8, true)],
      sticks: [range(EBD_AT.sticks + i * 8 + 4), range(EBD_AT.sticks + i * 8 + 6)],
      triggers: [range(EBD_AT.triggers + i * 8 + 4), range(EBD_AT.triggers + i * 8 + 6)],
      features: v.getUint32(EBD_AT.special + i * 8 + 4, true),
      keys: Array.from({ length: 20 }, (_, k) => v.getUint32(EBD_AT.keys + i * KEYS_RECORD + 4 + k * 4, true)),
    };
  });
  return { bytes: bytes.slice(), crcOk: v.getUint32(EBD_AT.crc, true) === ebdCrcOf(bytes), mode: v.getUint16(EBD_AT.mode, true), active: v.getUint16(EBD_AT.slot, true), profiles };
}

/** Why an edit can't be written, or null. */
export function checkEbdEdit(p: EbdProfile): string | null {
  if (new TextEncoder().encode(p.name).length > EBD_NAME_LEN) return "Names are at most 32 bytes.";
  if ([...p.name].some((c) => c.charCodeAt(0) < 0x20)) return "Names can't hold control characters.";
  if (p.rumble.some((x) => !(x >= 0 && x <= 1))) return "Rumble is 0 to 100%.";
  if ([...p.sticks, ...p.triggers].some((r) => r.start > r.end || r.start < 0 || r.end > 255)) return "Each range starts before it ends (0-255).";
  if ((p.features & ~EBD_FEATURE_BITS) !== 0) return "Unknown feature bits.";
  if (p.keys.length !== 20 || p.keys.some((k) => (k & ~EBD_KEY_BITS) !== 0)) return "Unknown button bits.";
  return null;
}

/** The whole config with one profile replaced (every other byte kept) and its CRC recomputed. */
export function ebdApply(bytes: Uint8Array, p: EbdProfile): Uint8Array {
  const out = bytes.slice();
  const v = new DataView(out.buffer);
  const i = p.slot;
  const name = new TextEncoder().encode(p.name).subarray(0, EBD_NAME_LEN);
  out.fill(0, EBD_AT.names + i * EBD_NAME_LEN, EBD_AT.names + (i + 1) * EBD_NAME_LEN);
  out.set(name, EBD_AT.names + i * EBD_NAME_LEN);
  v.setFloat32(EBD_AT.rumble + i * 12 + 4, p.rumble[0], true);
  v.setFloat32(EBD_AT.rumble + i * 12 + 8, p.rumble[1], true);
  out.set([p.sticks[0].start, p.sticks[0].end, p.sticks[1].start, p.sticks[1].end], EBD_AT.sticks + i * 8 + 4);
  out.set([p.triggers[0].start, p.triggers[0].end, p.triggers[1].start, p.triggers[1].end], EBD_AT.triggers + i * 8 + 4);
  v.setUint32(EBD_AT.special + i * 8 + 4, p.features >>> 0, true);
  p.keys.forEach((k, j) => v.setUint32(EBD_AT.keys + i * KEYS_RECORD + 4 + j * 4, k >>> 0, true));
  v.setUint32(EBD_AT.crc, ebdCrcOf(out), true);
  return out;
}

/** The bits each input sends by default (its own button; P1 / P2 their paddle bits). */
export const EBD_DEFAULT_KEYS: readonly number[] = [0x2000, 0x1000, 0x0010, 0x0020, 0x0400, 0x0800, 0x4000, 0x8000, 0x0002, 0x0004, 0x0008, 0x0001, 0x400000, 0x20000, 0x0200, 0x0100, 0x0080, 0x0040, 0x2000000, 0x4000000];

/** A config like a fresh pad's, for the sims and fixtures: three profiles (the second with A and B swapped). */
export function ebdSampleConfig(): Uint8Array {
  const b = new Uint8Array(EBD_CONFIG_SIZE);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x01, true);
  v.setUint16(EBD_AT.mode, 3, true);
  v.setUint16(EBD_AT.slot, 0, true);
  ["Profile 1", "FPS", "Racing"].forEach((name, i) => {
    b.set(new TextEncoder().encode(name), EBD_AT.names + i * EBD_NAME_LEN);
    v.setFloat32(EBD_AT.rumble + i * 12 + 4, 1, true);
    v.setFloat32(EBD_AT.rumble + i * 12 + 8, i === 2 ? 0.5 : 1, true);
    b.set([10, 245, 10, 245], EBD_AT.sticks + i * 8 + 4);
    b.set([0, 255, 0, 255], EBD_AT.triggers + i * 8 + 4);
    v.setUint32(EBD_AT.special + i * 8 + 4, 0x1000, true);
    EBD_DEFAULT_KEYS.forEach((k, j) => v.setUint32(EBD_AT.keys + i * KEYS_RECORD + 4 + j * 4, i === 1 && j < 2 ? EBD_DEFAULT_KEYS[1 - j] : k, true));
  });
  v.setUint32(EBD_AT.crc, ebdCrcOf(b), true);
  return b;
}
