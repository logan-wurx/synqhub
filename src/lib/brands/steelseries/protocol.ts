// SteelSeries Apex settings protocol (vendor collection 0xFFC0, report id 0), as far as it can be pinned down without
// GG's encrypted device descriptors. Pure encode/decode only: no transport, no device access. Every frame must pass
// guard.ts before it reaches a device; the session (backend.ts) does that, and the Rust bridge repeats the same table
// (steelseries-frames.txt).
//
// Labels in the doc comments (docs/devices/desktop-only/steelseries.md has the full evidence):
//   [gg-ui] / [gg-sql]  plain-text data from the GG 121.0.0 installer (tables, value meanings, key lists)
//   [zunuza]            GG traffic captured on an Apex Pro TKL 2019 (1038:1614), replayed on hardware (MIT)
//   [rikearon]          Apex Pro TKL Gen 3 wired (1038:1642) tool, hardware-tested where its doc says so (MIT / CC BY 4.0)
//   [opengg]            Apex Pro TKL Wireless Gen 3 (1038:1644 receiver, 1038:1646 cable), hardware-tested (facts only)
//   [openrgb]           OpenRGB SteelSeries Apex controller (GPL-2.0-or-later; learned from, not copied)
//   [inferred]          follows from the above, nothing confirms it on hardware
//
// Encoders return the report data WITHOUT the report id byte (WebHID convention), with its report type and id.
// Erasable TypeScript only (node runs the tests in scripts/ directly).

import type { OutgoingReport } from "../local-kb.ts";
import { FEATURE_LENGTH, SS_OUTPUT_LENGTH, SS_REPORT_ID, type SsFamily } from "./devices.ts";
import { GG_TABLES, type GgTableId } from "./tables.ts";

export type CommandFamily = Exclude<SsFamily, "other">;

/** First data byte of every command SYNQ builds (and the sub-bytes where a command has them). */
export const OP = {
  /** Output `90 00` (keyboard MCU) / `90 01` (LED MCU) -> ASCII version. [zunuza][rikearon][openrgb APEX_PACKET_ID_FIRMWARE] */
  firmware: 0x90,
  /** Output `23 <0..10>`: illumination brightness. [openrgb APEX_PACKET_ID_SET_BRIGHTNESS] */
  brightnessSet: 0x23,
  /** Output `A3` -> input `A3 00 <level>`; FF in byte 1 when unsupported. [openrgb APEX_PACKET_ID_GET_BRIGHTNESS] */
  brightnessGet: 0xa3,
  /** Output `3B`: hand lighting back to the on-board profile (legacy line). [openrgb APEX_GEN1_PACKET_ID_ONBOARD] */
  legacyRelease: 0x3b,
  /** Output `89 <1..5>`: select on-board profile Config N. [zunuza "89 <slot> selects the active profile"] */
  profile: 0x89,
  /** Feature `31 47 [hid,h,l]x68` (642 bytes): live actuation, legacy line. [zunuza] */
  legacyActuation: 0x31,
  legacyActuationSub: 0x47,
  /** Feature `3A <n> [hid,R,G,B]xn` (642 bytes): direct per-key colour, legacy line. [openrgb APEX_GEN1_PACKET_ID_DIRECT][zunuza "3a 57 04"] */
  legacyDirect: 0x3a,
  /** Feature `38 <cmd> ...` (644 bytes): the Gen 3 wired device-command namespace. [rikearon] */
  single: 0x38,
  singleThresholds: 0x61,
  singleReleaseMode: 0x62,
  singleSensitivity: 0x65,
  /** Feature `40 <n> [hid,R,G,B]xn` (644 bytes). [rikearon][openrgb APEX_2023_PACKET_ID_DIRECT] */
  singleDirect: 0x40,
  /** Output `4B`: direct-mode init before `40`. [rikearon][openrgb APEX_2023_PACKET_ID_INIT] */
  singleInit: 0x4b,
  /** Output `F5` -> `F5 <err> <region>`; `F2` -> `F2 <err> <layout>`. [rikearon] */
  region: 0xf5,
  layout: 0xf2,
  /** Wireless line through the receiver (feature, 641 bytes, ACK `<op> 00`). [opengg] */
  rxActuation: 0x6f,
  rxRapidTrigger: 0x76,
  rxSensitivity: 0x77,
  rxDirect: 0x61,
  rxRelease: 0x62,
  rxConnection: 0xbc,
  rxBattery: 0xd2,
  /** Wireless line over the USB cable: the receiver opcode with bit 0x40 cleared where [opengg] tested it. */
  usbActuation: 0x2f,
  usbSensitivity: 0x37,
  usbDirect: 0x21,
  usbRelease: 0x22,
  usbBattery: 0x92,
} as const;

/** 68 analog keys: the count byte the threshold / mode / sensitivity frames carry. [rikearon `44`][opengg `44`] */
export const ANALOG_COUNT = 0x44;

/** Rapid-trigger sensitivity: raw = mm x 10, 1..40 (0.1 .. 4.0 mm); GG's default is 2 (0.2 mm). [gg-ui sensitivity map, default A=2][rikearon][opengg] */
export const SENS_MIN = 1;
export const SENS_MAX = 40;
export const SENS_DEFAULT = 2;

/** Release-mode bytes. Single line: 0 off, 2 rapid trigger, 3 protection, 4 both [gg-ui 29359]; SYNQ writes only 0 / 2.
 *  Wireless line: per-key enable 0 / 1 [opengg 0x76][gg-ui 98480 release_mode 1]. */
export const RELEASE_MODE = { off: 0, rapidTrigger: 2, protection: 3, rapidTriggerProtection: 4 } as const;

/** Brightness 0..10, the steps the keyboard's own brightness keys walk through. [openrgb APEX_BRIGHTNESS_MAX] */
export const BRIGHTNESS_MAX = 10;
export const PROFILE_SLOTS = 5;

/**
 * Actuation values GG sends but that misbehaved on hardware: 3.2 mm (h 156 / l 144) caused key-repeat on the 1614
 * [zunuza "Observed-but-bad value: 0x909c"]. SYNQ refuses them; the guard does too.
 */
export const EXCLUDED_MM: Readonly<Partial<Record<GgTableId, readonly number[]>>> = { apexPro2019: [3.2] };

export interface Pair {
  /** Release threshold (raw Hall units). */
  l: number;
  /** Actuation threshold, h >= l. */
  h: number;
}

/** Threshold-pair byte order on the wire. Legacy and single: `hid, h, l` [zunuza 2.0 mm = 3b 37][rikearon "h first"];
 *  wireless: `usage, l, h` [opengg 1.5 mm = 1C 1F, GG map 28:31]. */
export const PAIR_ORDER: Readonly<Record<CommandFamily, "hl" | "lh">> = { legacy: "hl", single: "hl", "wireless-rx": "lh", "wireless-usb": "lh" };

export const featureLength = (family: CommandFamily): number => FEATURE_LENGTH[family];

// ---------------------------------------------------------------------------------------------
// mm <-> device units
// ---------------------------------------------------------------------------------------------

const tenth = (mm: number): number => {
  if (!Number.isFinite(mm)) throw new RangeError(`bad distance ${mm} mm`);
  const t = Math.round(mm * 10);
  if (Math.abs(mm * 10 - t) > 1e-6) throw new RangeError(`${mm} mm is not on the 0.1 mm grid`);
  return t;
};

/** GG's (l, h) for a distance on a model's table; throws for values off the table or excluded. */
export function mmToPair(table: GgTableId, mm: number): Pair {
  const t = tenth(mm);
  if (t < 1 || t > 40) throw new RangeError(`actuation ${mm} mm outside 0.1..4.0 mm`);
  if ((EXCLUDED_MM[table] ?? []).some((x) => Math.round(x * 10) === t)) throw new RangeError(`actuation ${mm} mm is refused on this model (misbehaved on hardware)`);
  const e = GG_TABLES[table].entries[t - 1];
  if (Math.round(e[0] * 10) !== t) throw new Error(`table ${table} is out of order at ${mm} mm`);
  return { l: e[1], h: e[2] };
}

/** The distance GG shows for an exact (l, h) pair, or null when the pair is not on the table. */
export function pairToMm(table: GgTableId, p: Pair): number | null {
  const e = GG_TABLES[table].entries.find((x) => x[1] === p.l && x[2] === p.h);
  return e ? e[0] : null;
}

/** Every (l, h) pair a table holds, minus excluded distances: what the guard lets through. */
export function tablePairs(table: GgTableId): Pair[] {
  const ex = (EXCLUDED_MM[table] ?? []).map((x) => Math.round(x * 10));
  return GG_TABLES[table].entries.filter((e) => !ex.includes(Math.round(e[0] * 10))).map((e) => ({ l: e[1], h: e[2] }));
}

export function sensitivityToRaw(mm: number): number {
  const t = tenth(mm);
  if (t < SENS_MIN || t > SENS_MAX) throw new RangeError(`rapid-trigger sensitivity ${mm} mm outside 0.1..4.0 mm`);
  return t;
}

export const rawToSensitivity = (raw: number): number | null => (raw >= SENS_MIN && raw <= SENS_MAX ? raw / 10 : null);

// ---------------------------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------------------------

const output = (bytes: readonly number[]): OutgoingReport => {
  const data = new Uint8Array(SS_OUTPUT_LENGTH);
  data.set(bytes);
  return { type: "output", reportId: SS_REPORT_ID, data };
};

const feature = (family: CommandFamily, bytes: readonly number[]): OutgoingReport => {
  const n = featureLength(family);
  if (bytes.length > n) throw new RangeError(`frame of ${bytes.length} bytes exceeds the ${n}-byte feature report`);
  const data = new Uint8Array(n);
  data.set(bytes);
  return { type: "feature", reportId: SS_REPORT_ID, data };
};

const byte = (label: string, v: number, lo = 0, hi = 255): number => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${label} ${v} outside ${lo}..${hi}`);
  return v;
};

function checkKeys(keys: readonly number[]): void {
  if (keys.length !== ANALOG_COUNT) throw new RangeError(`the analog frames carry ${ANALOG_COUNT} keys (got ${keys.length})`);
  for (let i = 0; i < keys.length; i++) {
    byte("key", keys[i], 1, 255);
    if (i && keys[i] <= keys[i - 1]) throw new RangeError("analog keys must be unique and ascending (GG's wire order)");
  }
}

/** Who an analog frame is for: the command family, GG's table for the model and its 68 analog keys. */
export interface AnalogTarget {
  family: CommandFamily;
  table: GgTableId;
  keys: readonly number[];
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

/** `90 00` keyboard firmware, `90 01` LED-controller firmware (legacy line). [zunuza][rikearon][openrgb] */
export const encodeFirmwareRead = (which: 0 | 1 = 0): OutgoingReport => output([OP.firmware, byte("firmware selector", which, 0, 1)]);

/**
 * Firmware reply: plain ASCII on the legacy line ("4.16.8" [zunuza]), `90 00` + ASCII on the single line [rikearon]
 * ([openrgb] drops the 0x90 when present). Returns "x.y.z" or null.
 */
export function decodeFirmware(reply: Uint8Array): string | null {
  let i = 0;
  if (reply[0] === OP.firmware) i = reply[1] === 0 ? 2 : 1;
  let s = "";
  for (; i < reply.length; i++) {
    const c = reply[i];
    if (c === 0) break;
    if ((c >= 0x30 && c <= 0x39) || c === 0x2e) s += String.fromCharCode(c);
    else return null;
  }
  return /^\d+\.\d+(\.\d+)*$/.test(s) ? s : null;
}

/** Is `reply` the answer to the firmware request? Legacy answers with bare ASCII digits, single with `90`. */
export const isFirmwareReply = (reply: Uint8Array): boolean => reply[0] === OP.firmware || (reply[0] >= 0x30 && reply[0] <= 0x39);

export const encodeBrightnessRead = (): OutgoingReport => output([OP.brightnessGet]);
export const encodeBrightness = (level: number): OutgoingReport => output([OP.brightnessSet, byte("brightness", level, 0, BRIGHTNESS_MAX)]);

/** `A3 00 <level>`; anything else (FF status = unsupported, level > 10) is null. [openrgb ReadBrightness] */
export function decodeBrightness(reply: Uint8Array): number | null {
  if (reply[0] !== OP.brightnessGet || reply[1] !== 0 || reply[2] > BRIGHTNESS_MAX) return null;
  return reply[2];
}

export const encodeRegionRead = (): OutgoingReport => output([OP.region]);
export const encodeLayoutRead = (): OutgoingReport => output([OP.layout]);

/** `F5 <err> <region>` / `F2 <err> <layout>`: the value when err is 0. [rikearon Queries] */
export function decodeQueryByte(op: number, reply: Uint8Array): number | null {
  if (reply[0] !== op || reply[1] !== 0) return null;
  return reply[2];
}

/** Region ids [rikearon] (1 US, 3 UK, 4 Germany, 6 France, 10 Nordic, 13 Japan, 20 Turkish) and layouts (0 US, 1 EU, 2 JP). */
export const REGION_NAMES: Readonly<Record<number, string>> = { 1: "US", 3: "UK", 4: "Germany", 6: "France", 10: "Nordic", 13: "Japan", 20: "Turkish" };
export const LAYOUT_NAMES: Readonly<Record<number, string>> = { 0: "ANSI (US)", 1: "ISO (EU)", 2: "JIS" };

/** Wireless status: receiver `BC` connection, `D2` battery; cable `92` battery. [opengg]: "byte 2 is data, not a success
 *  status" counting the report id (`00 BC 01` = connected), i.e. data byte 1 here. */
export function encodeStatusRead(family: "wireless-rx" | "wireless-usb", what: "connection" | "battery"): OutgoingReport {
  if (family === "wireless-usb") {
    if (what === "connection") throw new RangeError("the cable has no connection query");
    return output([OP.usbBattery]);
  }
  return output([what === "connection" ? OP.rxConnection : OP.rxBattery]);
}

export function decodeStatusByte(op: number, reply: Uint8Array): number | null {
  return reply[0] === op ? reply[1] : null;
}

/** Battery state byte: low 7 bits level (percent = (level - 1) x 5), bit 7 charging; 0 = nothing to report.
 *  [opengg; its own note: the percentage scale is inherited, not calibrated] */
export function batteryFromState(state: number): { percent: number; charging: boolean } | null {
  const level = state & 0x7f;
  if (level === 0) return null;
  return { percent: Math.min(100, Math.max(0, (level - 1) * 5)), charging: (state & 0x80) !== 0 };
}

/** Wireless ACK: `<op> <status>`, status 0 = accepted ([opengg] `[00, opcode, status]` with the report id). */
export const decodeAck = (op: number, reply: Uint8Array): number | null => (reply[0] === op ? reply[1] : null);

// ---------------------------------------------------------------------------------------------
// Profiles (legacy line)
// ---------------------------------------------------------------------------------------------

/** `89 <1..5>`: Config N becomes active. The keyboard has no "which is active" query. [zunuza] */
export const encodeProfileSelect = (slot: number): OutgoingReport => output([OP.profile, byte("profile slot", slot, 1, PROFILE_SLOTS)]);

// ---------------------------------------------------------------------------------------------
// Analog: actuation, rapid trigger, sensitivity
// ---------------------------------------------------------------------------------------------

function actuationHeader(family: CommandFamily): number[] {
  switch (family) {
    case "legacy":
      return [OP.legacyActuation, OP.legacyActuationSub];
    case "single":
      return [OP.single, OP.singleThresholds, ANALOG_COUNT, 0x00];
    case "wireless-rx":
      return [OP.rxActuation, 0x00, ANALOG_COUNT];
    case "wireless-usb":
      return [OP.usbActuation, 0x00, ANALOG_COUNT];
  }
}

/**
 * Live actuation for every analog key (GG always sends the full table [zunuza]): one (l, h) per key from the
 * model's GG table. Layer 0 (primary actuation) only; the second-actuation layer is never built.
 */
export function encodeActuation(t: AnalogTarget, mmFor: (hid: number) => number): OutgoingReport {
  checkKeys(t.keys);
  const out = actuationHeader(t.family);
  const order = PAIR_ORDER[t.family];
  for (const hid of t.keys) {
    const p = mmToPair(t.table, mmFor(hid));
    out.push(hid, order === "hl" ? p.h : p.l, order === "hl" ? p.l : p.h);
  }
  return feature(t.family, out);
}

/** Per-key mm out of an actuation frame (the encoder's inverse); null for a pair not on the table. */
export function decodeActuation(t: AnalogTarget, data: Uint8Array): Map<number, number | null> {
  const head = actuationHeader(t.family);
  for (let i = 0; i < head.length; i++) if (data[i] !== head[i]) throw new Error("not an actuation frame for this family");
  const order = PAIR_ORDER[t.family];
  const out = new Map<number, number | null>();
  for (let k = 0; k < ANALOG_COUNT; k++) {
    const at = head.length + k * 3;
    const a = data[at + 1], b = data[at + 2];
    out.set(data[at], pairToMm(t.table, order === "hl" ? { h: a, l: b } : { l: a, h: b }));
  }
  return out;
}

/** Per-key rapid trigger. Single: `38 62 44 [hid, 0|2]x68`; receiver: `76 44 [usage, 0|1]x68`. The cable's `36` is refused. */
export function encodeRapidTrigger(t: AnalogTarget, on: (hid: number) => boolean): OutgoingReport {
  checkKeys(t.keys);
  let out: number[];
  let onByte: number;
  if (t.family === "single") {
    out = [OP.single, OP.singleReleaseMode, ANALOG_COUNT];
    onByte = RELEASE_MODE.rapidTrigger;
  } else if (t.family === "wireless-rx") {
    out = [OP.rxRapidTrigger, ANALOG_COUNT];
    onByte = 1;
  } else {
    throw new RangeError(`rapid trigger on/off is not available on the ${t.family} line`);
  }
  for (const hid of t.keys) out.push(hid, on(hid) ? onByte : 0);
  return feature(t.family, out);
}

export function decodeRapidTrigger(t: AnalogTarget, data: Uint8Array): Map<number, boolean | null> {
  const head = t.family === "single" ? [OP.single, OP.singleReleaseMode, ANALOG_COUNT] : [OP.rxRapidTrigger, ANALOG_COUNT];
  const onByte = t.family === "single" ? RELEASE_MODE.rapidTrigger : 1;
  for (let i = 0; i < head.length; i++) if (data[i] !== head[i]) throw new Error("not a rapid-trigger frame for this family");
  const out = new Map<number, boolean | null>();
  for (let k = 0; k < ANALOG_COUNT; k++) {
    const v = data[head.length + k * 2 + 1];
    out.set(data[head.length + k * 2], v === onByte ? true : v === 0 ? false : null);
  }
  return out;
}

function sensitivityHeader(family: CommandFamily): number[] {
  switch (family) {
    case "single":
      return [OP.single, OP.singleSensitivity, ANALOG_COUNT];
    case "wireless-rx":
      return [OP.rxSensitivity, ANALOG_COUNT];
    case "wireless-usb":
      return [OP.usbSensitivity, ANALOG_COUNT];
    default:
      throw new RangeError(`rapid-trigger sensitivity is not available on the ${family} line`);
  }
}

/** Per-key rapid-trigger sensitivity (one value for press and release), raw = mm x 10. */
export function encodeSensitivity(t: AnalogTarget, mmFor: (hid: number) => number): OutgoingReport {
  checkKeys(t.keys);
  const out = sensitivityHeader(t.family);
  for (const hid of t.keys) out.push(hid, sensitivityToRaw(mmFor(hid)));
  return feature(t.family, out);
}

export function decodeSensitivity(t: AnalogTarget, data: Uint8Array): Map<number, number | null> {
  const head = sensitivityHeader(t.family);
  for (let i = 0; i < head.length; i++) if (data[i] !== head[i]) throw new Error("not a sensitivity frame for this family");
  const out = new Map<number, number | null>();
  for (let k = 0; k < ANALOG_COUNT; k++) out.set(data[head.length + k * 2], rawToSensitivity(data[head.length + k * 2 + 1]));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------------------------

export const DIRECT_OP: Readonly<Record<CommandFamily, number>> = { legacy: OP.legacyDirect, single: OP.singleDirect, "wireless-rx": OP.rxDirect, "wireless-usb": OP.usbDirect };

/** Most LEDs one direct frame holds: (feature length - 2) / 4. */
export const directCapacity = (family: CommandFamily): number => Math.floor((featureLength(family) - 2) / 4);

export type Rgb = readonly [number, number, number];

/**
 * Direct per-key colour: `<op> <n> [led, R, G, B]xn`, LEDs ascending. Volatile: the keyboard shows it until it is
 * released, re-initialised or unplugged. [openrgb SetLEDsDirect][rikearon 0x40][opengg 0x61 / 0x21]
 */
export function encodeDirect(family: CommandFamily, leds: readonly number[], colorFor: (led: number) => Rgb): OutgoingReport {
  if (!leds.length || leds.length > directCapacity(family)) throw new RangeError(`1..${directCapacity(family)} LEDs per frame (got ${leds.length})`);
  const out = [DIRECT_OP[family], leds.length];
  for (let i = 0; i < leds.length; i++) {
    if (i && leds[i] <= leds[i - 1]) throw new RangeError("LED ids must be unique and ascending");
    const c = colorFor(leds[i]);
    out.push(byte("LED id", leds[i], 1, 255), byte("red", c[0]), byte("green", c[1]), byte("blue", c[2]));
  }
  return feature(family, out);
}

export function decodeDirect(family: CommandFamily, data: Uint8Array): [number, number, number, number][] {
  if (data[0] !== DIRECT_OP[family]) throw new Error("not a direct-colour frame for this family");
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < data[1]; i++) out.push([data[2 + i * 4], data[3 + i * 4], data[4 + i * 4], data[5 + i * 4]]);
  return out;
}

/** `4B` before a single-line direct frame. [rikearon "harmless to repeat"][openrgb SendInitialization] */
export const encodeDirectInit = (): OutgoingReport => output([OP.singleInit]);

/** Hand lighting back to the keyboard: legacy `3B` [openrgb], receiver `62`, cable `22` [opengg]. The single line has
 *  no safe release (its `41` is a "reset" on the wireless line per [opengg]; refused everywhere). */
export function encodeLightingRelease(family: CommandFamily): OutgoingReport {
  switch (family) {
    case "legacy":
      return output([OP.legacyRelease]);
    case "wireless-rx":
      return output([OP.rxRelease]);
    case "wireless-usb":
      return output([OP.usbRelease]);
    default:
      throw new RangeError("this keyboard line has no lighting release SYNQ can send");
  }
}

// ---------------------------------------------------------------------------------------------
// Fixture shape (shared with the Rust bridge)
// ---------------------------------------------------------------------------------------------

const FEATURE_642 = new Set([0x31, 0x3a, 0x03, 0x83]);
const FEATURE_644 = new Set([0x38, 0x40, 0x36, 0xb6]);
const FEATURE_641 = new Set([0x6f, 0x76, 0x77, 0x61, 0x2f, 0x37, 0x21, 0x54, 0x43, 0x4a, 0x4c, 0x0a]);

/**
 * The report type and data length a frame travels as, decided by its first bytes (no command SYNQ knows uses one
 * opcode as both types). steelseries-frames.txt lines carry no type: a reader pads each line to this length and
 * classifies it as this type. `38 66` / `38 67` (rapid tap) are output reports; every other `38` is a feature.
 */
export function naturalShape(data: Uint8Array): { type: "output" | "feature"; length: number } {
  const op = data[0];
  if (op === OP.single && (data[1] === 0x66 || data[1] === 0x67)) return { type: "output", length: SS_OUTPUT_LENGTH };
  if (FEATURE_642.has(op)) return { type: "feature", length: FEATURE_LENGTH.legacy };
  if (FEATURE_644.has(op)) return { type: "feature", length: FEATURE_LENGTH.single };
  if (FEATURE_641.has(op)) return { type: "feature", length: FEATURE_LENGTH["wireless-rx"] };
  return { type: "output", length: SS_OUTPUT_LENGTH };
}

export const hex = (b: ArrayLike<number>, sep = " "): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(sep);

// ---------------------------------------------------------------------------------------------
// Colour helpers: the panel speaks [hue, saturation] 0..255, the keyboard RGB.
// ---------------------------------------------------------------------------------------------

export function hsToRgb(h: number, s: number): [number, number, number] {
  const hh = ((h / 255) * 360) % 360;
  const c = 255 * (s / 255);
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = 255 - c;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round(r + m), Math.round(g + m), Math.round(b + m)];
}
