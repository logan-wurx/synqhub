// ASUS Gear Link keyboard codec for the magnetic boards, unit-aware. Pure encode/decode, no transport.
//
// Two encoder classes exist in Gear Link's SDK (notes A0):
//   - legacy `Wn` (Falchion Ace HFX / HFX ZywOo): src/lib/keyboard-protocol.ts, captured on hardware.
//     Distances are 0.1 mm and rapid-trigger fields are u8. Those encoders are reused here unchanged.
//   - base `j` (Azoth 96 HE, Falcata, Falchion Ace 75 HE, TX75 Analog / Core, TUF K4 Magnetic):
//     0.01 mm, actuation u16, dead zones u8 (bottom first), rapid trigger
//     `51 54 MM 00 KK KK CC EE S1 S1 [S2 S2]` (u16 values after the flags), remap actuation u16.
// Everything takes millimetres plus the model's unit (manifest magKeyUnit) and quantises here.
//
// Source: ASUS Gear Link SDK chunk view/7184/chunk-1.00.36-7184-1784799807-12aa25-BJ-_oHSK.js
// (`j.setActuation`, `j.setDeadZone`, `j.setRapidTriggerPerKeySettings`, `j.setKeyTrigger`,
// `j.getActuation(V2)`, `j.getDeadZone(V2)`, `j.getRapidTriggerPerKeySettings(V2)`, `j.getKeyTrigger(V2)`),
// read as documentation 2026-10-13; see docs/devices/asus-gearlink.md.
import * as HFX from "../../keyboard-protocol.ts";
import { checkRange, mmToUnits, u16le, unitsToMm } from "../types.ts";
import type { AsusKbClass } from "./devices.ts";

export const frame = HFX.frame;
export { FW_KEY, FN_LAYER_OFFSET, KEY_DISABLED, fwKey, keyNameFromFw, type KeyName } from "../../keyboard-protocol.ts";

const le16 = (v: number): [number, number] => {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`u16 out of range: ${v}`);
  return [v & 0xff, v >> 8];
};

/** What the encoders need to know about a board. */
export interface KbUnitSpec {
  cls: AsusKbClass;
  /** Firmware distance unit in mm: 0.1 (HFX) or 0.01. */
  unitMm: number;
}

const isLegacy = (s: KbUnitSpec) => s.cls === "hfx";
const units = (s: KbUnitSpec, label: string, mm: number, lo: number, hi: number) => {
  checkRange(label, mm, lo, hi);
  return mmToUnits(mm, s.unitMm);
};
/** Physical ceilings (the manifests' ranges are applied by the backend; these only stop nonsense). */
const MAX_TRAVEL_MM = 4.0;
const MAX_RT_MM = 2.5;
const MAX_DZ_MM = 1.0;

/** Fn-layer keys are addressed as 0x9F00 + the base key code (Gear Link `Fn_*` names). */
export const fnKey = (code: number): number => {
  if (!Number.isInteger(code) || code < 1 || code > 0xff) throw new RangeError(`key code ${code}`);
  return HFX.FN_LAYER_OFFSET + code;
};

// ---------------------------------------------------------------------------------------------
// Analog: actuation, dead zones (same layout on both classes, unit differs)
// ---------------------------------------------------------------------------------------------

export function encodeGlobalActuation(s: KbUnitSpec, mm: number): Uint8Array {
  return HFX.encodeGlobalActuation(units(s, "actuation", mm, s.unitMm, MAX_TRAVEL_MM));
}
export function encodeKeyActuation(s: KbUnitSpec, key: number, mm: number): Uint8Array {
  return HFX.encodeKeyActuation(key, units(s, "actuation", mm, s.unitMm, MAX_TRAVEL_MM));
}
/** `51 58 00 00 <bottom u8> <top u8>`. 0.01 boards: 0.5 mm = 50, still one byte each. */
export function encodeGlobalDeadZones(s: KbUnitSpec, topMm: number, bottomMm: number): Uint8Array {
  return HFX.encodeGlobalDeadZone(units(s, "top dead zone", topMm, 0, MAX_DZ_MM), units(s, "bottom dead zone", bottomMm, 0, MAX_DZ_MM));
}
export function encodeKeyDeadZones(s: KbUnitSpec, key: number, topMm: number, bottomMm: number): Uint8Array {
  return HFX.encodeKeyDeadZone(key, units(s, "top dead zone", topMm, 0, MAX_DZ_MM), units(s, "bottom dead zone", bottomMm, 0, MAX_DZ_MM));
}

// ---------------------------------------------------------------------------------------------
// Rapid trigger per key
// ---------------------------------------------------------------------------------------------

export interface RapidTriggerMm {
  enabled: boolean;
  continuous: boolean;
  /** Separate press / release sensitivities, or one combined value. */
  independent: boolean;
  /** Combined sensitivity (independent = false). */
  sensitivityMm: number;
  pressMm: number;
  releaseMm: number;
}

/**
 * HFX: one u8 frame per value (MM 0 combined, 1 press, 2 release), as captured.
 * 0.01 boards: one frame per key, MM 0 = `KK KK CC EE S16`, MM 1 = `KK KK CC EE P16 R16`.
 */
export function encodeRapidTriggerKey(s: KbUnitSpec, key: number, rt: RapidTriggerMm): Uint8Array[] {
  const u = (label: string, mm: number) => Math.max(1, units(s, label, mm, 0, MAX_RT_MM));
  if (isLegacy(s)) {
    return HFX.encodeRapidTriggerForKey(
      key,
      { independent: rt.independent, sensitivity: u("RT sensitivity", rt.sensitivityMm), press: u("RT press", rt.pressMm), release: u("RT release", rt.releaseMm), continuous: rt.continuous },
      rt.enabled,
    );
  }
  const head = [...le16(key), rt.continuous ? 1 : 0, rt.enabled ? 1 : 0];
  return rt.independent
    ? [frame(0x51, 0x54, 1, [...head, ...le16(u("RT press", rt.pressMm)), ...le16(u("RT release", rt.releaseMm))])]
    : [frame(0x51, 0x54, 0, [...head, ...le16(u("RT sensitivity", rt.sensitivityMm))])];
}

/** `51 5C 00 00 EE`: rapid-trigger mode on/off (Azoth 96 HE only; other boards have a key for it). */
export const encodeRapidTriggerEnable = (on: boolean): Uint8Array => frame(0x51, 0x5c, 0, [on ? 1 : 0]);

// ---------------------------------------------------------------------------------------------
// Speed Tap, remap, polling, profiles, lighting
// ---------------------------------------------------------------------------------------------

export const encodeSpeedTapEnable = HFX.encodeSpeedTapEnable;
export const encodeSpeedTapPair = HFX.encodeSpeedTapPair;

/**
 * Normal key remap. Source (base or Fn layer 0x9Fxx) sits in bytes 2-3.
 * HFX: `51 21 SRC TGT16 ACT8` (captured). 0.01 boards: `51 21 SRC TGT16 ACT16` (Gear Link default act 100 = 1.0 mm).
 */
export function encodeRemap(s: KbUnitSpec, source: number, target: number, actuationMm: number): Uint8Array {
  const act = units(s, "remap actuation", actuationMm, s.unitMm, MAX_TRAVEL_MM);
  if (isLegacy(s)) return HFX.encodeKeyRemap(source, target, act);
  return frame(0x51, 0x21, source, [...le16(target), ...le16(act)]);
}

export const KB_POLLING_HZ = [1000, 2000, 4000, 8000] as const;
export const encodePollingRate = (hz: number): Uint8Array => {
  if (!(hz in HFX.POLLING_RATE_INDEX)) throw new RangeError(`polling ${hz} Hz not offered (1000/2000/4000/8000)`);
  return HFX.encodePollingRate(hz as HFX.PollingRateHz);
};
export const encodeSelectProfile = (index: number): Uint8Array => {
  if (!Number.isInteger(index) || index < 1 || index > 6) throw new RangeError(`profile ${index} (1..6)`);
  return HFX.encodeSelectProfile(index);
};
export const encodeSave = HFX.encodeSaveProfile;
export const encodeSimpleLighting = HFX.encodeSimpleLighting;

// ---------------------------------------------------------------------------------------------
// Reads (25 0x on he-v1, 25 Ax on he-v2; key in payload bytes 4-5, `0000` = global)
// ---------------------------------------------------------------------------------------------

export const encodeReadBasic = (): Uint8Array => HFX.encodeGetInfo(HFX.INFO.basic);
export const decodeBasic = HFX.decodeBasicInfo;
export const encodeReadPollingIndex = (): Uint8Array => frame(0x12, 0x15);
export const decodePollingIndex = (r: Uint8Array): number | null => KB_POLLING_HZ[r[4]] ?? null;
export const encodeReadRtMode = HFX.encodeGetRapidTriggerState;
/** `25 00` / `25 01` replies carry the on/off in byte 4. */
export const decodeStateByteSafe = (r: Uint8Array): boolean => r[4] === 1;
export const encodeReadSpeedTap = HFX.encodeGetSpeedTapState;
/** `25 08 PP 00`: Speed Tap pair table, page 0 (3 pairs) or 1 (2 pairs). */
export const encodeReadSpeedTapPairs = (page: 0 | 1): Uint8Array => frame(0x25, 0x08, page);
export function decodeSpeedTapPairs(r: Uint8Array, page: 0 | 1): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < (page === 0 ? 3 : 2); i++) {
    const a = u16le(r, 4 + 4 * i);
    const b = u16le(r, 6 + 4 * i);
    if (a && b && a !== 0xffff && b !== 0xffff) out.push([a, b]);
  }
  return out;
}

export type Getters = "v1" | "v2";
const keyed = (sub: number, key: number | null) => frame(0x25, sub, 0, le16(key ?? 0));

/** Actuation: v1 `25 05` global / `25 04 KK`, value u16 at [4]; v2 `25 A5` / `25 A4 KK`, value at [6]. */
export const encodeReadActuation = (g: Getters, key: number | null): Uint8Array =>
  keyed(g === "v1" ? (key === null ? 0x05 : 0x04) : key === null ? 0xa5 : 0xa4, key);
export const decodeActuation = (g: Getters, r: Uint8Array, unitMm: number): number => unitsToMm(u16le(r, g === "v1" ? 4 : 6), unitMm);

/** Dead zones: v1 `25 0A` / `25 09 KK` -> [4] bottom, [5] top; v2 `25 AA` / `25 A9 KK` -> [6] bottom, [7] top. */
export const encodeReadDeadZones = (g: Getters, key: number | null): Uint8Array =>
  keyed(g === "v1" ? (key === null ? 0x0a : 0x09) : key === null ? 0xaa : 0xa9, key);
export function decodeDeadZones(g: Getters, r: Uint8Array, unitMm: number): { topMm: number; bottomMm: number } {
  const at = g === "v1" ? 4 : 6;
  return { bottomMm: unitsToMm(r[at], unitMm), topMm: unitsToMm(r[at + 1], unitMm) };
}

/** Rapid trigger per key: v1 `25 06 KK`, v2 `25 A6 KK` (Gear Link sends a 16-byte zero payload after the key). */
export const encodeReadRapidTrigger = (g: Getters, key: number): Uint8Array => keyed(g === "v1" ? 0x06 : 0xa6, key);
export function decodeRapidTrigger(g: Getters, r: Uint8Array, unitMm: number): RapidTriggerMm & { continuousKnown: boolean } {
  const independent = u16le(r, 2) === 1;
  const v1 = g === "v1";
  const a = unitsToMm(u16le(r, v1 ? 4 : 6), unitMm);
  const b = unitsToMm(u16le(r, v1 ? 6 : 8), unitMm);
  return {
    independent,
    sensitivityMm: independent ? 0 : a,
    pressMm: independent ? a : 0,
    releaseMm: independent ? b : 0,
    enabled: r[v1 ? 9 : 11] === 1,
    // Gear Link's v1 reader ignores the continuous byte; v2 has it at [10].
    continuous: v1 ? r[8] === 1 : r[10] === 1,
    continuousKnown: !v1,
  };
}

/** Key trigger / binding: v1 `25 02 KK` -> type [2..3], target [4..5]; v2 `25 A2 KK` -> type [2..3], target [6..7]. */
export const encodeReadKeyTrigger = (g: Getters, key: number): Uint8Array => keyed(g === "v1" ? 0x02 : 0xa2, key);
export function decodeKeyTrigger(g: Getters, r: Uint8Array): { type: number; target: number } {
  return { type: u16le(r, 2), target: u16le(r, g === "v1" ? 4 : 6) };
}

/** Replies are matched on their first two bytes (Gear Link `matchBytes: 2`); writes echo verbatim. */
export const isAnswer = (sent: Uint8Array, r: Uint8Array): boolean => r[0] === sent[0] && r[1] === sent[1];
export const isRejected = (_sent: Uint8Array, r: Uint8Array): boolean => HFX.isRejected(r);
