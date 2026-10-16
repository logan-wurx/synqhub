// The 0x19F5-family framing and the memory areas SYNQ touches. Pure codec: no device access.
//
// Sources: Fighting Control Center (FCC, GPL-3.0-or-later) docs/PROTOCOL-MC.md and app/src/hid/mc.ts for
// MCHOSE's first generation; svumo/DrunkDeer-Control (MIT) docs/gen2-wire-format-confirmed.md, whose USB
// capture of a DrunkDeer A75 Pro OEM relabel (19F5:FB5C) shows the same envelope and the key-trigger table.
// SYNQ is AGPL-3.0, which is compatible with FCC's licence; the attribution stays in these headers.
//
// Every message is one 64-byte report with no report id:
//
//   request  [0x55, cmd, 0, checksum, len, offset lo, offset hi, flag, data...]
//   reply    [0xAA, cmd, 0, checksum, len, offset lo, offset hi, flag, data from byte 8...]
//   checksum = (len + offset lo + offset hi + flag + sum(data)) & 0xFF   (bytes 4 onward)
//
// A read carries a length and no data. A write carries `len` data bytes (at most 56). `flag` is 0 except on
// DrunkDeer's gen-2 boards, where the last chunk of a stream is flagged 1 (svumo). Every command works on a
// memory area at an offset. Replies to our requests are matched by command, offset and length; the board
// also sends unsolicited reports (profile changes, battery), which are skipped.

export const REQUEST = 0x55;
export const REPLY = 0xaa;
export const FRAME_LEN = 64;
export const HEADER_LEN = 8;
/** The most data bytes one message moves. */
export const CHUNK = 56;
export const MAX_KEYS = 128;

/** Areas (the `cmd` byte), named as FCC's PROTOCOL-MC.md does. Only the ones in READ_AREAS / WRITE_AREAS are ever sent. */
export const AREA = {
  info: 3,
  base: 4,
  funcGet: 5,
  funcSet: 6,
  keysDefault: 7,
  keysGet: 8,
  keysSet: 9,
  colorsGet: 10,
  colorsSet: 11,
  macrosGet: 12,
  macrosSet: 13,
  triggerGet: 160,
  triggerSet: 161,
  modTapGet: 164,
  modTapSet: 165,
  toggleGet: 166,
  toggleSet: 167,
  factoryReset: 238,
} as const;

/** Areas SYNQ reads (info, base, function config, key map, key triggers). */
export const READ_AREAS: readonly number[] = [AREA.info, AREA.base, AREA.funcGet, AREA.keysGet, AREA.triggerGet];
/** Areas SYNQ writes: function config and key triggers. Never the key map, colours, macros, mod-tap, toggle or the factory reset. */
export const WRITE_AREAS: readonly number[] = [AREA.funcSet, AREA.triggerSet];

/** Profiles the base area can name. */
export const PROFILES = 4;
/** Bytes per profile in each area. */
export const BLOCK = { func: 64, keysPerLayer: 512, layers: 4, trigger: 1024 } as const;
export const KEY_BYTES = 3;
export const TRIGGER_BYTES = 8;

// ---------------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------------

/** Checksum of a frame: the sum of bytes 4..63, low byte. */
export function checksum(f: ArrayLike<number>): number {
  let s = 0;
  for (let i = 4; i < f.length; i++) s += f[i];
  return s & 0xff;
}

function frame(cmd: number, offset: number, len: number, flag: number, data: ArrayLike<number> = []): Uint8Array {
  if (!Number.isInteger(cmd) || cmd < 0 || cmd > 255) throw new RangeError("command out of range");
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff) throw new RangeError("offset out of range");
  if (!Number.isInteger(len) || len < 1 || len > CHUNK) throw new RangeError(`length must be 1..${CHUNK}`);
  const f = new Uint8Array(FRAME_LEN);
  f[0] = REQUEST;
  f[1] = cmd;
  f[4] = len;
  f[5] = offset & 0xff;
  f[6] = offset >> 8;
  f[7] = flag;
  for (let i = 0; i < data.length; i++) f[HEADER_LEN + i] = data[i] & 0xff;
  f[3] = checksum(f);
  return f;
}

/** A read of `size` bytes (1..56) of an area at `offset`. */
export const readFrame = (cmd: number, offset: number, size: number): Uint8Array => frame(cmd, offset, size, 0);

/** A write of 1..56 data bytes. `last` sets the flag byte (DrunkDeer's gen-2 boards commit on it). */
export function writeFrame(cmd: number, offset: number, data: ArrayLike<number>, last = false): Uint8Array {
  if (data.length < 1 || data.length > CHUNK) throw new RangeError(`a write moves 1..${CHUNK} bytes`);
  return frame(cmd, offset, data.length, last ? 1 : 0, data);
}

export interface Request {
  cmd: number;
  len: number;
  offset: number;
  flag: number;
  data: Uint8Array;
}

/** A request frame taken apart; null when it is not one (wrong magic, wrong checksum, wrong length). */
export function parseRequest(f: Uint8Array): Request | null {
  if (f.length !== FRAME_LEN || f[0] !== REQUEST || f[2] !== 0 || f[3] !== checksum(f) || f[4] < 1 || f[4] > CHUNK) return null;
  return { cmd: f[1], len: f[4], offset: f[5] | (f[6] << 8), flag: f[7], data: f.slice(HEADER_LEN, HEADER_LEN + f[4]) };
}

export interface Reply {
  cmd: number;
  len: number;
  offset: number;
  flag: number;
  /** Bytes 8..8+len. */
  data: Uint8Array;
}

/** A reply taken apart; null when it does not start with 0xAA or is not 64 bytes. */
export function parseReply(f: Uint8Array): Reply | null {
  if (f.length !== FRAME_LEN || f[0] !== REPLY) return null;
  const len = Math.min(f[4], CHUNK);
  return { cmd: f[1], len, offset: f[5] | (f[6] << 8), flag: f[7], data: f.slice(HEADER_LEN, HEADER_LEN + len) };
}

/** Whether `reply` answers `request`: same command, same offset, no more data than asked for (FCC `mcMatches`). */
export function answers(request: Uint8Array, reply: Uint8Array): boolean {
  return reply.length === FRAME_LEN && reply[0] === REPLY && reply[1] === request[1] && reply[4] <= request[4] && reply[5] === request[5] && reply[6] === request[6];
}

// ---------------------------------------------------------------------------------------------
// Info and base
// ---------------------------------------------------------------------------------------------

/** Area 3, bytes 0-1: the firmware version as a little-endian number whose hex digits read as the version (0x0120 = 1.20). */
export function decodeFirmware(info: Uint8Array): { raw: number; text: string } {
  const raw = info[0] | (info[1] << 8);
  return { raw, text: `${raw >> 8}.${(raw & 0xff).toString(16).padStart(2, "0")}` };
}

export interface BaseInfo {
  /** Byte 0: index into `order` (or the profile itself when `order` is not a permutation). */
  index: number;
  /** Byte 1. */
  profileCount: number;
  order: readonly number[];
  /** Index and count are in range. */
  valid: boolean;
  /** `order` is a permutation of 0..3. */
  ordered: boolean;
  /** The active profile (FCC `readAll`): order[index] when ordered, else the index, else 0. */
  profile: number;
}

/** Area 4: [order index, profile count, order x4...]. */
export function decodeBase(b: Uint8Array): BaseInfo {
  const order = [b[2], b[3], b[4], b[5]];
  const ordered = [...order].sort((x, y) => x - y).join() === "0,1,2,3";
  const valid = b[0] < PROFILES && b[1] <= PROFILES;
  const profile = valid && ordered ? order[b[0]] : valid ? b[0] : 0;
  return { index: b[0], profileCount: b[1], order, valid, ordered, profile };
}

// ---------------------------------------------------------------------------------------------
// Key triggers: 8 bytes per key (FCC PROTOCOL-MC.md "Key triggers"; svumo `KeyTriggerEntry`)
// ---------------------------------------------------------------------------------------------

/** What a board's travel units are. Come from the catalogue, never from the board. */
export interface TravelUnits {
  /** Raw actuation units per mm. */
  step: number;
  /** The smallest rapid-trigger step in mm (the unit of precision code 0). */
  precision: number;
  /** Plausibility ceiling, mm. */
  maxTravel: number;
}

export interface Trigger {
  /** Byte 0 low nibble. Never written. */
  switchType: number;
  /** Byte 1 low nibble: 0 normal, 1 rapid trigger; other values are advanced modes SYNQ leaves alone. */
  mode: number;
  priority: number;
  actuationMm: number;
  rtPressMm: number;
  rtReleaseMm: number;
  rapidTrigger: boolean;
  /** Byte 0's high nibble is 0xA in a live record. */
  live: boolean;
  /** The raw 9-bit values + 1, and the precision codes, for exact round trips. */
  raw: { actuation: number; press: number; release: number; pressPrecision: number; releasePrecision: number };
}

const recordAt = (table: Uint8Array, slot: number): Uint8Array => table.subarray(slot * TRIGGER_BYTES, slot * TRIGGER_BYTES + TRIGGER_BYTES);

/** mm per raw unit of a rapid-trigger distance: code 0 is the board's own step, 1 is 0.005 mm, 2 is 0.001 mm. */
export const rtPerMm = (code: number, precision: number): number => (code === 1 ? 200 : code === 2 ? 1000 : Math.round(1 / precision));

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

export function decodeTrigger(rec: ArrayLike<number>, units: TravelUnits): Trigger {
  const act = (rec[2] | ((rec[3] & 1) << 8)) + 1;
  const press = (rec[4] | ((rec[5] & 1) << 8)) + 1;
  const release = (rec[6] | ((rec[7] & 1) << 8)) + 1;
  const pp = (rec[3] >> 3) & 3;
  const rp = (rec[3] >> 1) & 3;
  const mode = rec[1] & 15;
  return {
    switchType: rec[0] & 15,
    mode,
    priority: rec[1] >> 4,
    actuationMm: round4(act / units.step),
    rtPressMm: round4(press / rtPerMm(pp, units.precision)),
    rtReleaseMm: round4(release / rtPerMm(rp, units.precision)),
    rapidTrigger: mode === 1,
    live: (rec[0] & 0xf0) === 0xa0,
    raw: { actuation: act, press, release, pressPrecision: pp, releasePrecision: rp },
  };
}

/** Decodes slot `slot` of a trigger table. */
export const triggerAt = (table: Uint8Array, slot: number, units: TravelUnits): Trigger => decodeTrigger(recordAt(table, slot), units);

/** Whether the record reads like a real key at these units: a live record with a travel-sized actuation. */
export function plausible(t: Trigger, units: TravelUnits): boolean {
  return t.live && t.actuationMm > 0 && t.actuationMm <= units.maxTravel + 0.3;
}

export interface TriggerPatch {
  actuationMm?: number;
  rapidTrigger?: boolean;
  rtPressMm?: number;
  rtReleaseMm?: number;
}

/** The 9-bit stored value for `mm` at `perMm` units per mm: stored = raw - 1, raw within [min, 512]. */
function stored(mm: number, perMm: number, min: number, what: string): number {
  const raw = Math.round(mm * perMm + 1e-9);
  if (raw < min || raw > 512) throw new RangeError(`${what} ${mm} mm isn't a value this key can hold (${round4(min / perMm)} to ${round4(512 / perMm)} mm at its current step).`);
  return raw - 1;
}

/**
 * A copy of a record with the patch applied. Only actuation (byte 2 and bit 0 of byte 3), the key mode
 * (low nibble of byte 1, and only between normal and rapid trigger), and the two rapid-trigger distances
 * (bytes 4 and 6 with bit 0 of 5 and 7) change; the switch type, priority, precision bits and dead zones are
 * kept as they were. Throws a RangeError with a sentence when a value doesn't fit.
 */
export function patchTrigger(rec: ArrayLike<number>, patch: TriggerPatch, units: TravelUnits): Uint8Array {
  const out = Uint8Array.from({ length: TRIGGER_BYTES }, (_, i) => rec[i] & 0xff);
  if (patch.actuationMm !== undefined) {
    const a = stored(patch.actuationMm, units.step, 1, "Actuation");
    out[2] = a & 0xff;
    out[3] = (out[3] & ~1) | ((a >> 8) & 1);
  }
  if (patch.rapidTrigger !== undefined) {
    const mode = out[1] & 15;
    if (mode !== 0 && mode !== 1) throw new RangeError("This key uses an advanced mode (dynamic keystroke or similar) that SYNQ leaves alone.");
    out[1] = (out[1] & 0xf0) | (patch.rapidTrigger ? 1 : 0);
  }
  if (patch.rtPressMm !== undefined) {
    const p = stored(patch.rtPressMm, rtPerMm((out[3] >> 3) & 3, units.precision), 2, "Rapid trigger press distance");
    out[4] = p & 0xff;
    out[5] = (out[5] & ~1) | ((p >> 8) & 1);
  }
  if (patch.rtReleaseMm !== undefined) {
    const r = stored(patch.rtReleaseMm, rtPerMm((out[3] >> 1) & 3, units.precision), 2, "Rapid trigger release distance");
    out[6] = r & 0xff;
    out[7] = (out[7] & ~1) | ((r >> 8) & 1);
  }
  return out;
}

/**
 * Runs of consecutive changed 8-byte records, as [first byte, last byte + 1) with at most 56 bytes each. A
 * record that didn't change is never written, even between two that did (FCC merges across such gaps; SYNQ
 * doesn't, so a slot that isn't a key is never touched and the guard can insist every record it passes is live).
 */
export function changedRuns(before: Uint8Array, after: Uint8Array): [number, number][] {
  const per = Math.floor(CHUNK / TRIGGER_BYTES) * TRIGGER_BYTES;
  const runs: [number, number][] = [];
  let start = -1;
  const close = (end: number) => {
    if (start >= 0) runs.push([start, end]);
    start = -1;
  };
  for (let o = 0; o + TRIGGER_BYTES <= after.length; o += TRIGGER_BYTES) {
    let changed = false;
    for (let i = 0; i < TRIGGER_BYTES; i++) if (before[o + i] !== after[o + i]) changed = true;
    if (!changed) close(o);
    else if (start < 0) start = o;
    else if (o + TRIGGER_BYTES - start > per) {
      close(o);
      start = o;
    }
  }
  close(after.length - (after.length % TRIGGER_BYTES));
  return runs;
}

// ---------------------------------------------------------------------------------------------
// Function config: 64 bytes per profile (FCC PROTOCOL-MC.md "Function config")
// ---------------------------------------------------------------------------------------------

export interface FuncSettings {
  winLock: boolean;
  altTabLock: boolean;
  altF4Lock: boolean;
  /** Bit 1 of byte 7: rapid trigger at the bottom of the travel. */
  bottomRapidTrigger: boolean;
  /** Bits 5-7 of byte 7. */
  debounce: number;
  /** Byte 35 in 30-second steps. */
  sleepSteps: number;
  light: {
    effect: number;
    /** 0..100 */
    brightness: number;
    /** 0 (slow) .. 4 (fast); stored as 4 - speed. */
    speed: number;
    direction: number;
    rainbow: boolean;
    rgb: readonly [number, number, number];
  };
}

export const FUNC = { winLock: 6, flags: 7, effect: 8, brightness: 9, speed: 10, direction: 11, rainbow: 12, red: 14, green: 15, blue: 16, sleep: 35 } as const;

export function decodeFunc(b: ArrayLike<number>): FuncSettings {
  return {
    winLock: (b[FUNC.winLock] & 1) === 1,
    altTabLock: (b[FUNC.winLock] & 2) === 2,
    altF4Lock: (b[FUNC.winLock] & 4) === 4,
    bottomRapidTrigger: (b[FUNC.flags] & 2) === 2,
    debounce: (b[FUNC.flags] >> 5) & 7,
    sleepSteps: b[FUNC.sleep],
    light: {
      effect: b[FUNC.effect],
      brightness: b[FUNC.brightness],
      speed: Math.min(4, Math.max(0, 4 - b[FUNC.speed])),
      direction: b[FUNC.direction],
      rainbow: b[FUNC.rainbow] === 1,
      rgb: [b[FUNC.red], b[FUNC.green], b[FUNC.blue]],
    },
  };
}

export interface FuncPatch {
  winLock?: boolean;
  altTabLock?: boolean;
  altF4Lock?: boolean;
  bottomRapidTrigger?: boolean;
  debounce?: number;
  sleepSteps?: number;
  effect?: number;
  brightness?: number;
  speed?: number;
  rainbow?: boolean;
  rgb?: readonly [number, number, number];
}

const bit = (byte: number, mask: number, on: boolean): number => (on ? byte | mask : byte & ~mask);
const int = (v: number, lo: number, hi: number, what: string): number => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${what} must be a whole number from ${lo} to ${hi}.`);
  return v;
};

/** A copy of a 64-byte function block with the patch applied and every other byte as it was. */
export function patchFunc(block: ArrayLike<number>, p: FuncPatch): Uint8Array {
  const out = Uint8Array.from({ length: BLOCK.func }, (_, i) => block[i] & 0xff);
  if (p.winLock !== undefined) out[FUNC.winLock] = bit(out[FUNC.winLock], 1, p.winLock);
  if (p.altTabLock !== undefined) out[FUNC.winLock] = bit(out[FUNC.winLock], 2, p.altTabLock);
  if (p.altF4Lock !== undefined) out[FUNC.winLock] = bit(out[FUNC.winLock], 4, p.altF4Lock);
  if (p.bottomRapidTrigger !== undefined) out[FUNC.flags] = bit(out[FUNC.flags], 2, p.bottomRapidTrigger);
  if (p.debounce !== undefined) out[FUNC.flags] = (out[FUNC.flags] & 0x1f) | (int(p.debounce, 0, 7, "Debounce") << 5);
  if (p.sleepSteps !== undefined) out[FUNC.sleep] = int(p.sleepSteps, 0, 255, "Sleep time");
  if (p.effect !== undefined) out[FUNC.effect] = int(p.effect, 0, 255, "Lighting effect");
  if (p.brightness !== undefined) out[FUNC.brightness] = int(p.brightness, 0, 100, "Brightness");
  if (p.speed !== undefined) out[FUNC.speed] = 4 - int(p.speed, 0, 4, "Speed");
  if (p.rainbow !== undefined) out[FUNC.rainbow] = p.rainbow ? 1 : 0;
  if (p.rgb !== undefined) {
    out[FUNC.red] = int(p.rgb[0], 0, 255, "Red");
    out[FUNC.green] = int(p.rgb[1], 0, 255, "Green");
    out[FUNC.blue] = int(p.rgb[2], 0, 255, "Blue");
  }
  return out;
}

/** The two writes that carry a 64-byte block: bytes 0-55, then bytes 8-63 (a short tail is moved back to stay 56 bytes, as FCC does). */
export function funcWrites(profile: number, block: Uint8Array): { offset: number; data: Uint8Array }[] {
  const base = BLOCK.func * profile;
  return [
    { offset: base, data: block.slice(0, CHUNK) },
    { offset: base + (BLOCK.func - CHUNK), data: block.slice(BLOCK.func - CHUNK, BLOCK.func) },
  ];
}

/** Function-block offsets for a profile. */
export const funcOffset = (profile: number): number => BLOCK.func * profile;
export const triggerOffset = (profile: number): number => BLOCK.trigger * profile;
export const keysOffset = (profile: number, layer: number): number => BLOCK.keysPerLayer * (BLOCK.layers * profile + layer);
