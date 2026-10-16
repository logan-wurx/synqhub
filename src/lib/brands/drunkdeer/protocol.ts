// DrunkDeer gen-1 (VID 0x352D, and the X60 on 0x1A81) settings protocol: pure frame encoders and
// decoders. No transport, no state, no device access.
//
// Wire: output report id 4 with 63 data bytes on the vendor collection 0xFF00/0x00; the keyboard answers
// with input reports (id 4, 63 bytes) on the same collection, usually an echo of the request. Byte 0 is
// the command, byte 1 usually a sub-command. Indexes below are data indexes (report id excluded).
//
// Sources (see devices.ts for the full list):
//   [antler] / [kbcn]  official configurator bundles. DOCS ONLY: byte layouts were read from them and
//                      re-implemented here; nothing was copied.
//   [svumo]  svumo/DrunkDeer-Control, MIT (Driver/Packets.cs, KeyboardSpecs.cs, HidStreamListener.cs). The
//            encoder structure (common switch, per-key batches per dialect, LW/RDT pair packets, LED mode
//            packet) is ported from svumo's C# builders, with SYNQ's own range checks.
//            Copyright (c) 2026 svumo, MIT licence (permission notice in that repository's LICENSE).
//   [halljoy] PashOK7/HallJoy, AGPL-3.0: 0xB7 tracking stream framing (chunk in data byte 3).
//   [mojobojo] identity offsets and LED mode/colour tables (docs only).
// Every frame built here goes through buildFrame(), which refuses the opcodes SYNQ never sends, and
// then through the guard (guard.ts) before it reaches a device.

import { hex } from "../local-kb.ts";
import { ALL_PRESET_CODES, GRID, LIGHT_COLOURS, LIGHT_LEVEL_MAX, type Dialect } from "./devices.ts";

export { hex };

export const REPORT_ID = 4;
export const FRAME_LEN = 63;
export const SLOTS = GRID.slots;

/** Command bytes. The second group is never built by SYNQ (buildFrame throws). */
export const CMD = {
  identity: 0xa0,
  profileCount: 0xa2,
  led: 0xae,
  common: 0xb5,
  keyPoints: 0xb6,
  depthLow: 0xb7,
  pairs: 0xfc,
  high: 0xfd,
  // never sent
  rtpAuthority: 0xa7,
  rtpAuthorityDownload: 0xa8,
  reset: 0xaa,
  deleteProfile: 0xab,
  knob: 0xc1,
  ledStrip: 0xc2,
  firmware: 0xf9,
  changeProfile: 0xfb,
} as const;

/** Opcodes SYNQ never builds, with the reason. [antler send* builders][svumo] */
export const NEVER_OPCODES: ReadonlyMap<number, string> = new Map([
  [0xf9, "firmware upgrade (sendUpgradeFirmwareDataStart/Data/End, subs 0/1/2)"],
  [0xaa, "reset keyboard (0xAA 00) / clear RTP upper (0xAA 00 01)"],
  [0xa7, "RTP authority (writes the RT+ authority table; part of the 0xAA batch)"],
  [0xa8, "RTP authority download (writes the RT+ authority table; part of the 0xAA batch)"],
  [0xab, "delete a firmware-side profile slot"],
  [0xfb, "change the active firmware profile (carries host profile ids)"],
  [0xc1, "knob action remap"],
  [0xc2, "X60 LED strip"],
]);

/** Sub-command for per-key fields in 0xB6 (old dialects) and 0xFD (newHighPrec). [antler][svumo KeyPointType] */
export const FIELD_SUB = { actuation: 0x01, downstroke: 0x04, upstroke: 0x05 } as const;
export type KeyField = keyof typeof FIELD_SUB;
export const KEY_FIELDS: readonly KeyField[] = ["actuation", "downstroke", "upstroke"];

/** 0xFD 07 x pulls and their reply sub-commands (0xFD 08 / 0A / 0B). [antler sendPull*, case 253] */
export const PULL_REQ = { actuation: 0x01, downstroke: 0x03, upstroke: 0x04 } as const;
export const PULL_REPLY = { actuation: 0x08, downstroke: 0x0a, upstroke: 0x0b } as const;

export const FD = { tracking: 0x03, depth: 0x06, pull: 0x07, autoMatch: 0x0c } as const;
export const FC = { lwPairs: 0x01, rdtPairs: 0x03, pullLw: 0x05, lwReply: 0x06, pullRdt: 0x07, rdtReply: 0x08, clearPairs: 0x0a, lwReplace: 0x0b } as const;

/** RT auto-match modes ("autoMatch*Mode" ids) and 255 = off. [antler] */
export const AUTO_MATCH = { standard: 0, competitive: 1, hardcore: 2, off: 255 } as const;
export type AutoMatchMode = (typeof AUTO_MATCH)[keyof typeof AUTO_MATCH];
export const AUTO_MATCH_VALUES: readonly number[] = [0, 1, 2, 255];

// ---------------------------------------------------------------------------------------------
// Frame builder
// ---------------------------------------------------------------------------------------------

/**
 * Builds one 63-byte frame from its leading bytes (rest zero). Throws for every opcode SYNQ never sends,
 * for the keymap write (0xA0 02 04), the profile-count write (0xA2 n), and the per-key custom light stream,
 * so no encoder can produce them. Bytes must be integers 0..255 (no silent wrap like a JS Uint8Array).
 */
export function buildFrame(bytes: readonly number[]): Uint8Array {
  if (bytes.length === 0 || bytes.length > FRAME_LEN) throw new RangeError(`A frame has 1..${FRAME_LEN} bytes (got ${bytes.length}).`);
  bytes.forEach((b, i) => {
    if (!Number.isInteger(b) || b < 0 || b > 255) throw new RangeError(`Byte ${i} = ${b} is not 0..255.`);
  });
  const c = bytes[0];
  const why = NEVER_OPCODES.get(c);
  if (why) throw new Error(`SYNQ never sends 0x${c.toString(16)}: ${why}.`);
  if (c === CMD.identity && !(bytes[1] === 0x02 && (bytes[2] ?? 0) === 0x00)) throw new Error("Only the identity read (0xA0 02 00) is built; 0xA0 02 04 is the keymap write.");
  if (c === CMD.profileCount && (bytes[1] ?? 0) !== 0) throw new Error("Only the profile-count query (0xA2 00) is built; 0xA2 n changes the firmware profile count.");
  if (c === CMD.led && bytes[5] === 0x06 && bytes[7] === 0xff) throw new Error("The per-key custom light stream is not built.");
  const f = new Uint8Array(FRAME_LEN);
  f.set(bytes);
  return f;
}

// ---------------------------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------------------------

/** mm per wire unit. [antler: x10 / x100 / x200] */
export const UNIT_MM: Readonly<Record<Dialect, number>> = { legacy: 0.1, oldHighPrec: 0.01, newHighPrec: 0.005 };

/**
 * Wire value ranges the encoders and the guard accept, in wire units. AP min is the official 0.2 mm;
 * maxima are the official slider caps (legacy 3.3/3.1, oldHighPrec 2.0) and, for newHighPrec DS/US, the
 * official builder clamp Yg = 3.1 mm (the slider stops at 2.0) so values another app stored still round-trip.
 */
export const WIRE_RANGE: Readonly<Record<Dialect, Readonly<Record<KeyField, readonly [number, number]>>>> = {
  legacy: { actuation: [2, 33], downstroke: [0, 31], upstroke: [0, 31] },
  oldHighPrec: { actuation: [20, 200], downstroke: [0, 200], upstroke: [0, 200] },
  newHighPrec: { actuation: [40, 660], downstroke: [0, 620], upstroke: [0, 620] },
};

/** mm -> wire units (rounded to the nearest unit; the official JS truncates, which can lose a unit to float error). */
export function mmToWire(mm: number, dialect: Dialect): number {
  return Math.round(mm / UNIT_MM[dialect] + 1e-9);
}

export function wireToMm(units: number, dialect: Dialect): number {
  return Math.round(units * UNIT_MM[dialect] * 10000) / 10000;
}

const u16 = (v: number): [number, number] => [v & 0xff, (v >> 8) & 0xff];

// ---------------------------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------------------------

/** Identity / spec request. Reply: 0xA0 02 00 + identity bytes (decodeIdentity). [antler sendIdentityData][svumo IDENTITY_PACKET] */
export function encodeIdentity(): Uint8Array {
  return buildFrame([CMD.identity, 0x02, 0x00, 0x00]);
}

export interface CommonSettings {
  turbo: boolean;
  rapidTrigger: boolean;
  lastWin: boolean;
  /** Release Dual-Trigger / Rapid Double Tap. */
  rdt: boolean;
  rtMatch: boolean;
}

/** Last-Win + RDT combined enum used by 0xB5 byte 10 and 0xFC 0A: 0 none, 1 LW, 2 RDT, 3 both. */
export const lwRdtMode = (lastWin: boolean, rdt: boolean): number => (lastWin && rdt ? 3 : lastWin ? 1 : rdt ? 2 : 0);

/** Common switch: B5 00 1E 01 00 00 01 turbo rt 00 lw|rdt rtMatch. Echoed back. [antler sendCommonData][svumo BuildCommonSwitchPacket] */
export function encodeCommon(s: CommonSettings): Uint8Array {
  return buildFrame([CMD.common, 0x00, 0x1e, 0x01, 0x00, 0x00, 0x01, +s.turbo, +s.rapidTrigger, 0x00, lwRdtMode(s.lastWin, s.rdt), +s.rtMatch]);
}

/**
 * One full per-key batch for a field (126 slots, values in mm).
 *   legacy / oldHighPrec: B6 sub 00 p, p = 0..2, 59 + 59 + 8 one-byte values from byte 4.
 *   newHighPrec:          FD sub p,    p = 0..4, 30 x 4 + 6 little-endian u16 values from byte 3.
 * Throws when a value is outside WIRE_RANGE for the dialect (the official builder clamps silently).
 * [antler sendActionPointData/sendDownStokeData/sendUpStrokeData][svumo BuildPacketKeyPoint*, BuildKeyPointBatch]
 */
export function encodeKeyPoints(field: KeyField, mm: readonly number[], dialect: Dialect): Uint8Array[] {
  if (mm.length !== SLOTS) throw new RangeError(`Per-key batches carry all ${SLOTS} slots (got ${mm.length}).`);
  const [lo, hi] = WIRE_RANGE[dialect][field];
  const wire = mm.map((v, slot) => {
    if (!Number.isFinite(v)) throw new RangeError(`Slot ${slot}: ${v} is not a number.`);
    const w = mmToWire(v, dialect);
    if (w < lo || w > hi) throw new RangeError(`Slot ${slot}: ${v} mm is outside ${wireToMm(lo, dialect)}..${wireToMm(hi, dialect)} mm for ${field} (${dialect}).`);
    return w;
  });
  const sub = FIELD_SUB[field];
  const frames: Uint8Array[] = [];
  if (dialect === "newHighPrec") {
    for (let p = 0; p < 5; p++) {
      const n = p < 4 ? 30 : 6;
      frames.push(buildFrame([CMD.high, sub, p, ...wire.slice(p * 30, p * 30 + n).flatMap(u16)]));
    }
  } else {
    for (let p = 0; p < 3; p++) {
      const n = p < 2 ? 59 : 8;
      frames.push(buildFrame([CMD.keyPoints, sub, 0x00, p, ...wire.slice(p * 59, p * 59 + n)]));
    }
  }
  return frames;
}

/** Keystroke tracking (live depth) on/off: B6 03 v (old dialects) or FD 03 v (newHighPrec). One stream round per "on". [antler sendTrackingStart/StopData] */
export function encodeTracking(on: boolean, dialect: Dialect): Uint8Array {
  return buildFrame([dialect === "newHighPrec" ? CMD.high : CMD.keyPoints, FD.tracking, +on]);
}

/** Per-key read-back request (newHighPrec with firmware sync): FD 07 01/03/04. Reply: 5 x FD 08/0A/0B. [antler sendPull*Data] */
export function encodePullKeyPoints(field: KeyField): Uint8Array {
  return buildFrame([CMD.high, FD.pull, PULL_REQ[field]]);
}

/** Last-Win pair table read-back: FC 05 -> FC 06. [antler sendPullLw] */
export function encodePullLw(): Uint8Array {
  return buildFrame([CMD.pairs, FC.pullLw]);
}

/** RDT pair table read-back: FC 07 -> FC 08. [antler sendPullRdt] */
export function encodePullRdt(): Uint8Array {
  return buildFrame([CMD.pairs, FC.pullRdt]);
}

/** Firmware profile count query: A2 00 -> A2 n (1..5). [antler event_send_profile_len(true)] */
export function encodeProfileCountQuery(): Uint8Array {
  return buildFrame([CMD.profileCount, 0x00]);
}

/** RT auto-match mode: FD 0C v (0 standard, 1 competitive, 2 hardcore, 255 off). [antler sendRtModeDate][svumo BuildAutoMatchModePacket] */
export function encodeAutoMatch(mode: number): Uint8Array {
  if (!AUTO_MATCH_VALUES.includes(mode)) throw new RangeError(`Auto-match mode must be 0, 1, 2 or 255 (got ${mode}).`);
  return buildFrame([CMD.high, FD.autoMatch, mode]);
}

/** Last-Win Replace: FC 0B v. [antler sendLwReplaceData][svumo BuildLastWinReplacePacket] */
export function encodeLwReplace(on: boolean): Uint8Array {
  return buildFrame([CMD.pairs, FC.lwReplace, +on]);
}

/** Clears the pair table and states the LW/RDT mode (0..3): FC 0A m. Sent before FC 01 / FC 03. [antler sendClearRtpData][svumo BuildClearRtpPacket] */
export function encodeClearPairs(mode: number): Uint8Array {
  if (!Number.isInteger(mode) || mode < 0 || mode > 3) throw new RangeError(`Pair mode is 0..3 (got ${mode}).`);
  return buildFrame([CMD.pairs, FC.clearPairs, mode]);
}

export interface LwPair {
  /** Firmware slot (0..125) of the first key. */
  main: number;
  /** Firmware slot of the key that takes over. */
  trigger: number;
}

/** Wire capacity of FC 01 (4 bytes per pair after a 4-byte header). */
export const LW_FRAME_CAPACITY = 14;
/** Wire capacity of FC 03 (8 bytes per pair after a 3-byte header). */
export const RDT_FRAME_CAPACITY = 7;

const checkSlot = (s: number, what: string) => {
  if (!Number.isInteger(s) || s < 0 || s >= SLOTS) throw new RangeError(`${what} slot ${s} is not 0..${SLOTS - 1}.`);
};

/** Last-Win pair table: FC 01 00 n, then [main, trigger, 0, 0] per pair. [antler sendCreateLwData][svumo BuildCreateLwPairsPacket] */
export function encodeLwPairs(pairs: readonly LwPair[]): Uint8Array {
  if (pairs.length > LW_FRAME_CAPACITY) throw new RangeError(`At most ${LW_FRAME_CAPACITY} Last-Win pairs fit in one frame.`);
  const body: number[] = [];
  for (const p of pairs) {
    checkSlot(p.main, "Main");
    checkSlot(p.trigger, "Trigger");
    if (p.main === p.trigger) throw new RangeError("A Last-Win pair needs two different keys.");
    body.push(p.main, p.trigger, 0, 0);
  }
  return buildFrame([CMD.pairs, FC.lwPairs, 0x00, pairs.length, ...body]);
}

export interface RdtPair {
  /** Slot whose press fires its own key. */
  press: number;
  /** Slot whose key is sent when the press key is released. */
  release: number;
  /** Activation distance relative to the press key's upstroke, 0.05..0.25 mm (wire x200, 10..50). */
  activeMm: number;
  /** Reset distance relative to the press key's upstroke, 1.5..2.5 mm (wire x200, 300..500). */
  resetMm: number;
}

export const RDT_ACTIVE_RAW: readonly [number, number] = [10, 50];
export const RDT_RESET_RAW: readonly [number, number] = [300, 500];

/** RDT pair table: FC 03 n, then [press, release, active u16, reset u16, 0, 0] per pair. [antler sendCreateRdtData][svumo BuildCreateRdtPairsPacket] */
export function encodeRdtPairs(pairs: readonly RdtPair[]): Uint8Array {
  if (pairs.length > RDT_FRAME_CAPACITY) throw new RangeError(`At most ${RDT_FRAME_CAPACITY} RDT pairs fit in one frame.`);
  const body: number[] = [];
  for (const p of pairs) {
    checkSlot(p.press, "Press");
    checkSlot(p.release, "Release");
    if (p.press === p.release) throw new RangeError("An RDT pair needs two different keys.");
    const a = Math.round(p.activeMm * 200 + 1e-9);
    const r = Math.round(p.resetMm * 200 + 1e-9);
    if (a < RDT_ACTIVE_RAW[0] || a > RDT_ACTIVE_RAW[1]) throw new RangeError(`RDT activation ${p.activeMm} mm is outside 0.05..0.25 mm.`);
    if (r < RDT_RESET_RAW[0] || r > RDT_RESET_RAW[1]) throw new RangeError(`RDT reset ${p.resetMm} mm is outside 1.5..2.5 mm.`);
    body.push(p.press, p.release, ...u16(a), ...u16(r), 0, 0);
  }
  return buildFrame([CMD.pairs, FC.rdtPairs, pairs.length, ...body]);
}

export interface LightingFrame {
  /** Wire mode code from the model's preset table (devices.ts colourPresets). */
  code: number;
  /** 0..9. */
  speed: number;
  /** 0..9 (10+ is reported to soft-brick the A75 Pro). */
  brightness: number;
  /** 0 = colourful, 1..7 = preset colours. */
  colour: number;
}

/** LED mode select: AE 01 00 00 mode speed brightness colour. Echoed (AE 01). [antler sendLedModeData + apiSaveColourSolution arg order][svumo BuildLedModePacket][cli BuildLEDModeSelect] */
export function encodeLighting(l: LightingFrame): Uint8Array {
  if (!ALL_PRESET_CODES.includes(l.code)) throw new RangeError(`Lighting mode code ${l.code} is not a preset any DrunkDeer model uses.`);
  for (const [k, v] of [["speed", l.speed], ["brightness", l.brightness]] as const)
    if (!Number.isInteger(v) || v < 0 || v > LIGHT_LEVEL_MAX) throw new RangeError(`Lighting ${k} must be 0..${LIGHT_LEVEL_MAX} (got ${v}).`);
  if (!Number.isInteger(l.colour) || l.colour < 0 || l.colour >= LIGHT_COLOURS.length) throw new RangeError(`Lighting colour must be 0..${LIGHT_COLOURS.length - 1} (got ${l.colour}).`);
  return buildFrame([CMD.led, 0x01, 0x00, 0x00, l.code, l.speed, l.brightness, l.colour]);
}

// ---------------------------------------------------------------------------------------------
// Decoders (input reports, data bytes without the report id)
// ---------------------------------------------------------------------------------------------

export const isIdentityReply = (d: Uint8Array): boolean => d[0] === CMD.identity && d[1] === 0x02 && d[2] === 0x00;

export interface IdentityInfo {
  typeBytes: readonly [number, number, number];
  /** Bytes 7 (low) and 8 (high) of the firmware version. */
  fwLow: number;
  fwHigh: number;
  /** The official app's firmware number: Number(String(byte8) + String(byte7)) (decimal concatenation). */
  firmware: number;
  /** "0." + byte8 + byte7, plus "-k.p.n" (hex of bytes 34..36) when byte 34 != 0. */
  firmwareText: string;
  turbo: boolean;
  rapidTrigger: boolean;
  rdt: boolean;
  lastWin: boolean;
  /** Bytes 20..32: meaningful on newHighPrec boards only (the official app ignores them elsewhere). */
  profileIndex: number;
  colour: { code: number; speed: number; brightness: number };
  rtMatch: boolean;
  autoMatch: number;
  lwReplace: boolean;
  /** Byte 25 (old_l): on oldHighPrec boards, the official slider steps 0.01 mm when set, else 0.1 mm. */
  fineStep: boolean;
  raw: Uint8Array;
}

/**
 * 0xA0 02 00 reply. Offsets [antler case 160 handler][svumo KeyboardSpecs]: type 4..6, firmware 7 (low) and 8
 * (high), turbo 15, rt 16, rdt 18, lw 19, profile 20, colour 22..24, old_l 25, rtMatch 30, autoMatch 31,
 * lwReplace 32, firmware suffix 34..36.
 */
export function decodeIdentity(d: Uint8Array): IdentityInfo {
  if (!isIdentityReply(d)) throw new Error(`Not an identity reply: ${hex(d.subarray(0, 4))}`);
  const b = (i: number) => d[i] ?? 0;
  const suffix = b(34) !== 0 ? `-${b(34).toString(16)}.${b(35).toString(16)}.${b(36).toString(16)}` : "";
  return {
    typeBytes: [b(4), b(5), b(6)],
    fwLow: b(7),
    fwHigh: b(8),
    firmware: Number(`${b(8)}${b(7)}`),
    firmwareText: `0.${b(8)}${b(7)}${suffix}`,
    turbo: b(15) !== 0,
    rapidTrigger: b(16) !== 0,
    rdt: b(18) !== 0,
    lastWin: b(19) !== 0,
    profileIndex: b(20),
    colour: { code: b(22), speed: b(23), brightness: b(24) },
    rtMatch: b(30) !== 0,
    autoMatch: b(30) !== 0 ? b(31) : AUTO_MATCH.off,
    lwReplace: b(32) !== 0,
    fineStep: b(25) !== 0,
    raw: d.slice(),
  };
}

/** 0xB5 echo: turbo 7, rt 8, LW/RDT enum 10. [antler case 181] */
export function decodeCommonEcho(d: Uint8Array): { turbo: boolean; rapidTrigger: boolean; lastWin: boolean; rdt: boolean } | null {
  if (d[0] !== CMD.common) return null;
  const m = d[10];
  return { turbo: d[7] !== 0, rapidTrigger: d[8] !== 0, lastWin: m === 1 || m === 3, rdt: m === 2 || m === 3 };
}

export interface DepthChunk {
  /** First slot this chunk covers. */
  first: number;
  /** Depth per slot in mm (values under the noise floor read 0). */
  mm: number[];
  /** True for the chunk that ends a round (B7 chunk 2 / FD 06 chunk 4). */
  last: boolean;
}

/**
 * Live depth streams [antler case 183 / xC][svumo HidStreamListener][halljoy]:
 *   0xB7 (old dialects): byte 3 = chunk 0..2, one byte per slot from byte 4 (59/59/8); < 2 reads 0;
 *        legacy units 0.1 mm, oldHighPrec 0.01 mm.
 *   0xFD 06 (newHighPrec): byte 2 = chunk 0..4, u16 LE per slot from byte 3 (30 x 4 + 6), 0.005 mm; < 40 reads 0.
 */
export function decodeDepth(d: Uint8Array, dialect: Dialect): DepthChunk | null {
  if (dialect === "newHighPrec") {
    if (d[0] !== CMD.high || d[1] !== FD.depth) return null;
    const chunk = d[2];
    if (chunk > 4) return null;
    const n = chunk < 4 ? 30 : 6;
    const mm: number[] = [];
    for (let i = 0; i < n; i++) {
      const raw = d[3 + i * 2] | (d[4 + i * 2] << 8);
      mm.push(raw < 40 ? 0 : raw / 200);
    }
    return { first: chunk * 30, mm, last: chunk === 4 };
  }
  if (d[0] !== CMD.depthLow) return null;
  const chunk = d[3];
  if (chunk > 2) return null;
  const n = chunk < 2 ? 59 : 8;
  const unit = UNIT_MM[dialect];
  const mm: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = d[4 + i];
    mm.push(w < 2 ? 0 : Math.round(w * unit * 1000) / 1000);
  }
  return { first: chunk * 59, mm, last: chunk === 2 };
}

/** FD 08 / 0A / 0B reply chunk: 30 u16 LE values (mm x 200) from byte 3; byte 2 = chunk. [antler watch_ap_rt] */
export function decodePullReply(d: Uint8Array): { field: KeyField; chunk: number; mm: number[] } | null {
  if (d[0] !== CMD.high) return null;
  const field = (Object.keys(PULL_REPLY) as KeyField[]).find((k) => PULL_REPLY[k] === d[1]);
  if (!field) return null;
  const mm: number[] = [];
  for (let i = 3; i + 1 < FRAME_LEN; i += 2) mm.push((d[i] | (d[i + 1] << 8)) / 200);
  return { field, chunk: d[2], mm };
}

/** FC 06 reply: count at byte 2, then 4-byte entries from byte 4 with the pair at +1/+2. [antler watch_lw_rdt "lw"] */
export function decodeLwPull(d: Uint8Array): LwPair[] | null {
  if (d[0] !== CMD.pairs || d[1] !== FC.lwReply) return null;
  const n = Math.min(d[2], Math.floor((FRAME_LEN - 4) / 4));
  const out: LwPair[] = [];
  for (let i = 0; i < n; i++) out.push({ main: d[4 + i * 4 + 1], trigger: d[4 + i * 4 + 2] });
  return out;
}

/** FC 08 reply: count at byte 3, then 8-byte entries from byte 4: +1 press, +2 release, +3/4 active, +5/6 reset (u16 / 200). [antler watch_lw_rdt "rdt"] */
export function decodeRdtPull(d: Uint8Array): RdtPair[] | null {
  if (d[0] !== CMD.pairs || d[1] !== FC.rdtReply) return null;
  const n = Math.min(d[3], Math.floor((FRAME_LEN - 4) / 8));
  const out: RdtPair[] = [];
  for (let i = 0; i < n; i++) {
    const e = 4 + i * 8;
    out.push({ press: d[e + 1], release: d[e + 2], activeMm: (d[e + 3] | (d[e + 4] << 8)) / 200, resetMm: (d[e + 5] | (d[e + 6] << 8)) / 200 });
  }
  return out;
}

/** A2 reply: firmware profile count at byte 1 (the official app clamps it to 1..5). [antler case 162 / YC] */
export function decodeProfileCount(d: Uint8Array): number | null {
  return d[0] === CMD.profileCount ? Math.max(1, Math.min(5, d[1] || 0)) : null;
}
