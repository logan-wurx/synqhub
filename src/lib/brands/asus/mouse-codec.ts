// ASUS Gear Link mouse codec (ROG Harpe / Keris / Gladius / Spatha generation). Pure encode/decode.
//
// Frames are `[cmd, sub, arg lo, arg hi, payload...]` on the 0xFF01 usage 1 collection, report id 0,
// zero padded to the output report length the descriptor gives (64; 63 on some, so the session passes
// the real length). Writes are echoed; reads answer with the same leading bytes.
//
//   51 31 <index> 00 <payload>   performance block: 0-3 DPI stage, 4 polling, 5 button response
//                                (debounce), 6 angle snap, 9 active stage, 10 stage count,
//                                12-15 split X/Y, 18 motion sync
//   50 02 <profile-1> 00         select profile          50 03   save (Gear Link: 1.5 s after the last change)
//   12 00 / 12 04 00 / 12 04 04 / 12 06 01 / 12 07 00   reads (info, performance, motion sync, LOD, battery)
//
// Source: Gear Link mouse controller (view/7600 chunk-C9DkXjFJ.js `ns.makeCommand`, setDPI,
// setPollingRate, setButtonResponse, setAngleSnapping, setMotionSync, getPerformanceInfo) and the mouse
// page table `nC`, read as documentation 2026-10-13. The 12 04 00 layout matches OpenMouse's
// asus/index.js (AGPL; from libratbag, MIT). Lift-off (51 35) is deliberately NOT encoded: the same
// `51 35 01` arg is LOD on some models and manual sensor calibration on others (Gear Link
// setCalibration vs setCalibrationLOD), so SYNQ only reads it.
import { u16le } from "../types.ts";
import type { AsusMouseTraits } from "./devices.ts";

export const MOUSE_POLLING_HZ = [125, 250, 500, 1000, 2000, 4000, 8000] as const;
export const IDX = { stage0: 0, polling: 4, debounce: 5, angleSnap: 6, activeStage: 9, stageCount: 10, split0: 12, motionSync: 18 } as const;

const u8 = (v: number): number => {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError(`byte out of range: ${v}`);
  return v;
};
const le16 = (v: number): [number, number] => {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`u16 out of range: ${v}`);
  return [v & 0xff, v >> 8];
};

export function mouseFrame(cmd: number, sub: number, arg: number, payload: readonly number[] = [], length = 64): Uint8Array {
  const out = new Uint8Array(length);
  const bytes = [u8(cmd), u8(sub), ...le16(arg), ...payload.map(u8)];
  if (bytes.length > length) throw new RangeError("frame too long");
  out.set(bytes);
  return out;
}

/** DPI wire value: floor(dpi / base) - 1 (base 50, or 1 on p724-p726 and p728-p730). */
export function dpiRaw(t: Pick<AsusMouseTraits, "dpiBase" | "maxDpi">, dpi: number): number {
  if (!Number.isInteger(dpi) || dpi < 100 || dpi > t.maxDpi) throw new RangeError(`DPI ${dpi} outside 100..${t.maxDpi}`);
  if (dpi % t.dpiBase) throw new RangeError(`DPI ${dpi} is not a multiple of ${t.dpiBase}`);
  return dpi / t.dpiBase - 1;
}
export const dpiFromRaw = (t: Pick<AsusMouseTraits, "dpiBase">, raw: number): number => (raw + 1) * t.dpiBase;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `51 31 <stage 0-3> 00 RAW16 [R G B]`. */
export function encodeDpiStage(t: AsusMouseTraits, stage: number, dpi: number, color?: Rgb, length?: number): Uint8Array {
  if (!Number.isInteger(stage) || stage < 0 || stage >= t.stages) throw new RangeError(`stage ${stage} (0..${t.stages - 1})`);
  return mouseFrame(0x51, 0x31, IDX.stage0 + stage, [...le16(dpiRaw(t, dpi)), ...(color ? [color.r, color.g, color.b] : [])], length);
}
/** `51 31 <12+stage> 00 X16 Y16`. */
export function encodeDpiStageXY(t: AsusMouseTraits, stage: number, x: number, y: number, length?: number): Uint8Array {
  if (!t.splitXY) throw new Error("this mouse has no separate X/Y DPI");
  if (!Number.isInteger(stage) || stage < 0 || stage >= t.stages) throw new RangeError(`stage ${stage}`);
  return mouseFrame(0x51, 0x31, IDX.split0 + stage, [...le16(dpiRaw(t, x)), ...le16(dpiRaw(t, y))], length);
}
/** `51 31 09 00 <1..4> 00`. */
export function encodeActiveStage(t: AsusMouseTraits, stage: number, length?: number): Uint8Array {
  if (!Number.isInteger(stage) || stage < 0 || stage >= t.stages) throw new RangeError(`stage ${stage}`);
  return mouseFrame(0x51, 0x31, IDX.activeStage, [stage + 1, 0], length);
}
/** `51 31 04 00 <index> 00`, 0 = 125 ... 6 = 8000 Hz. */
export function encodePolling(t: AsusMouseTraits, hz: number, length?: number): Uint8Array {
  if (!t.pollingHz.includes(hz)) throw new RangeError(`polling ${hz} Hz not offered (${t.pollingHz.join("/")})`);
  return mouseFrame(0x51, 0x31, IDX.polling, [MOUSE_POLLING_HZ.indexOf(hz as (typeof MOUSE_POLLING_HZ)[number]), 0], length);
}
/** `51 31 05 00 <ms/4 - 1> 00`: button response 4..32 ms in 4 ms steps. */
export function encodeDebounce(t: AsusMouseTraits, ms: number, length?: number): Uint8Array {
  if (!t.debounce) throw new Error("this mouse has no button-response setting in Gear Link");
  if (!Number.isInteger(ms) || ms < 4 || ms > 32 || ms % 4) throw new RangeError(`debounce ${ms} ms (4..32, step 4)`);
  return mouseFrame(0x51, 0x31, IDX.debounce, [ms / 4 - 1, 0], length);
}
export function encodeAngleSnap(t: AsusMouseTraits, on: boolean, length?: number): Uint8Array {
  if (!t.angleSnap) throw new Error("this mouse has no angle snapping");
  return mouseFrame(0x51, 0x31, IDX.angleSnap, [on ? 1 : 0], length);
}
export function encodeMotionSync(t: AsusMouseTraits, on: boolean, length?: number): Uint8Array {
  if (!t.motionSync) throw new Error("this mouse has no motion sync");
  return mouseFrame(0x51, 0x31, IDX.motionSync, [on ? 1 : 0], length);
}
/** `50 02 <profile-1> 00`. */
export function encodeSelectProfile(profile: number, count = 5, length?: number): Uint8Array {
  if (!Number.isInteger(profile) || profile < 1 || profile > count) throw new RangeError(`profile ${profile} (1..${count})`);
  return mouseFrame(0x50, 0x02, profile - 1, [], length);
}
/** `50 03`: save the current profile to flash. Mice never use 50 55. */
export const encodeSave = (length?: number): Uint8Array => mouseFrame(0x50, 0x03, 0, [], length);

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export const encodeReadInfo = (length?: number): Uint8Array => mouseFrame(0x12, 0x00, 0, [], length);
export const encodeReadPerformance = (length?: number): Uint8Array => mouseFrame(0x12, 0x04, 0, [], length);
export const encodeReadSplitDpi = (length?: number): Uint8Array => mouseFrame(0x12, 0x04, 2, [], length);
export const encodeReadMotionSync = (length?: number): Uint8Array => mouseFrame(0x12, 0x04, 4, [], length);
export const encodeReadLod = (length?: number): Uint8Array => mouseFrame(0x12, 0x06, 1, [], length);
export const encodeReadBattery = (length?: number): Uint8Array => mouseFrame(0x12, 0x07, 0, [], length);

export interface MouseInfo {
  firmware: string;
  profiles: number;
  profile: number;
  activeStage: number;
}
/** `12 00` reply: [4..7] u32 version, [8] profile count, [10] current profile (0-based), [11] DPI index. */
export function decodeInfo(r: Uint8Array): MouseInfo {
  const v = (r[4] | (r[5] << 8) | (r[6] << 16) | (r[7] << 24)) >>> 0;
  const hx = (n: number) => n.toString(16).padStart(2, "0");
  return { firmware: `${((v >> 16) & 0xff).toString(16)}.${hx((v >> 8) & 0xff)}.${hx(v & 0xff)}`, profiles: r[8], profile: r[10] + 1, activeStage: r[11] };
}

export interface Performance {
  dpi: number[];
  pollingHz: number | null;
  debounceMs: number | null;
  angleSnap: boolean;
}
/** `12 04 00` reply (4-stage mice): DPI raw u16 x4 at [4], polling word [12..13] (bits 0-3), debounce [14], snapping [16]. */
export function decodePerformance(t: AsusMouseTraits, r: Uint8Array): Performance {
  const base = 4 + t.stages * 2;
  const word = u16le(r, base);
  const debounceRaw = r[base + 2];
  return {
    dpi: Array.from({ length: t.stages }, (_, i) => dpiFromRaw(t, u16le(r, 4 + 2 * i))),
    pollingHz: MOUSE_POLLING_HZ[word & 0x0f] ?? null,
    debounceMs: debounceRaw <= 7 ? (debounceRaw + 1) * 4 : null,
    angleSnap: r[base + 4] === 1,
  };
}
export const decodeMotionSync = (r: Uint8Array): boolean => r[4] === 1;
/** `12 06 01` reply: [4] mode (0 normal, 1 asymmetric, 2 manual calibration), [5] normal LOD 0 low / 1 mid / 2 high. */
export const decodeLod = (r: Uint8Array): { mode: number; level: number } => ({ mode: r[4], level: r[5] });
/** `12 07 00` reply: [4] percent, [9] charging. */
export const decodeBattery = (r: Uint8Array): { percent: number; charging: boolean } => ({ percent: r[4], charging: r[9] > 0 });

/** Answers share the first two bytes; `12 xx` reads also echo their page byte. */
export const isAnswer = (sent: Uint8Array, r: Uint8Array): boolean =>
  r[0] === sent[0] && r[1] === sent[1] && (sent[0] !== 0x12 || r[2] === sent[2]);
export const isRejected = (_sent: Uint8Array, r: Uint8Array): boolean => r[0] === 0xff && r[1] === 0xaa;
