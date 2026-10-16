// DualSense Edge onboard profiles (wave C2), after steffalon's DualSense Edge profile web app (MIT, (c) 2023 steffalon;
// docs/devices/CONTROLLERS.md §5.3). USB only.
//
// - Read: feature reports 0x70-0x7B, three per slot: Triangle (the default) 0x70, Square 0x73, Cross 0x76, Circle 0x79.
// - Write: 0x60 (Square), 0x61 (Cross), 0x62 (Circle), three 64-byte parts each (part index in byte 1), every part
//   ending in a CRC32 seeded with 0xA3, and part 3 carrying the profile's own CRC at [56]. 0x63 (Triangle, the default
//   profile) is never written.
// - Delete: feature 0x68 with the slot number (2-4; 1, the default, is never deleted).
//
// SYNQ builds a write from the slot's own bytes as read (unknown bytes are kept, so settings SYNQ doesn't know,
// like vibration intensity, survive), changes only the fields below, and recomputes both CRCs. guard.ts / pads.rs check
// every part again: its id, part index, the fields' ranges and its CRC. Pure functions: no DOM, no React, no device I/O.
import { crc32 } from "./frames.ts";

export const EDGE_VID = 0x054c;
export const EDGE_PID = 0x0df2;
/** A part: 64 bytes with its report id first. */
export const EDGE_PART = 64;
export const EDGE_DELETE = 0x68;
/** The seed byte of a part's CRC (feature SET header). */
export const EDGE_CRC_SEED = 0xa3;

export interface EdgeSlot {
  slot: 0 | 1 | 2 | 3;
  /** The face button that picks it with Fn. */
  button: "Triangle" | "Square" | "Cross" | "Circle";
  /** First of its three read reports. */
  read: number;
  /** Its write report (never sent for the default). */
  write: number;
  protected: boolean;
}

export const EDGE_SLOTS: readonly EdgeSlot[] = [
  { slot: 0, button: "Triangle", read: 0x70, write: 0x63, protected: true },
  { slot: 1, button: "Square", read: 0x73, write: 0x60, protected: false },
  { slot: 2, button: "Cross", read: 0x76, write: 0x61, protected: false },
  { slot: 3, button: "Circle", read: 0x79, write: 0x62, protected: false },
];

/** Every read report: 0x70..0x7B. */
export const EDGE_READS: readonly number[] = Array.from({ length: 12 }, (_, i) => 0x70 + i);
/** The write reports SYNQ may send (not 0x63). */
export const EDGE_WRITES: readonly number[] = [0x60, 0x61, 0x62];

// ---- stick curves: six presets, each six points with an 11-step adjustment (the reference app's table)

type Step = number | readonly number[];
interface CurvePreset {
  id: number;
  name: string;
  /** The byte stored beside the curve ("modifier" in the reference: 0x03 or 0x04 by preset). */
  modifier: number;
  points: readonly (readonly [initial: number, step?: Step])[];
}

export const EDGE_CURVES: readonly CurvePreset[] = [
  { id: 0, name: "Default", modifier: 0x03, points: [[128], [128], [196], [196], [225], [225]] },
  { id: 1, name: "Quick", modifier: 0x03, points: [[38], [38], [122, -3], [139, [6, 5]], [255], [255]] },
  { id: 2, name: "Precise", modifier: 0x04, points: [[70, 3], [57, [-3, -4]], [134, 3], [115, [-6, -7]], [196, 2], [177, [-7, -8]]] },
  { id: 3, name: "Steady", modifier: 0x04, points: [[62, -1], [62, -1], [120, -4], [129, [0, -1]], [197, [3, 2]], [179, [-5, -6]]] },
  { id: 4, name: "Digital", modifier: 0x03, points: [[38], [38], [38], [75, 18], [255], [255]] },
  { id: 5, name: "Dynamic", modifier: 0x03, points: [[69, [3, 2]], [57, [-3, -4]], [183, [-4, -5]], [198, 3], [255], [255]] },
];
/** Adjustment steps (the console's 11-position slider). */
export const EDGE_ADJUST_MAX = 10;

/** The six curve bytes of a preset at an adjustment step (0..10). */
export function edgeCurve(preset: number, step: number): number[] {
  const p = EDGE_CURVES[preset];
  if (!p) throw new Error(`No stick curve preset ${preset}.`);
  const s = Math.max(0, Math.min(EDGE_ADJUST_MAX, Math.round(step)));
  return p.points.map(([initial, mod]) => {
    if (mod === undefined) return initial;
    let v = initial;
    for (let i = 0; i < s; i++) v += Array.isArray(mod) ? (mod as readonly number[])[i % (mod as readonly number[]).length] : (mod as number);
    return Math.max(0, Math.min(255, v));
  });
}

/** The adjustment step that gives these curve bytes for this preset, or null when they're none of its 11. */
export function edgeCurveStep(preset: number, curve: readonly number[]): number | null {
  for (let s = 0; s <= EDGE_ADJUST_MAX; s++) if (edgeCurve(preset, s).every((v, i) => v === curve[i])) return s;
  return null;
}

// ---- buttons

/** What a button can be mapped to (the reference's Button enum). */
export const EDGE_BUTTONS: readonly { value: number; name: string }[] = [
  { value: 0x00, name: "Up" },
  { value: 0x01, name: "Left" },
  { value: 0x02, name: "Down" },
  { value: 0x03, name: "Right" },
  { value: 0x04, name: "Circle" },
  { value: 0x05, name: "Cross" },
  { value: 0x06, name: "Square" },
  { value: 0x07, name: "Triangle" },
  { value: 0x08, name: "R1" },
  { value: 0x09, name: "R2" },
  { value: 0x0a, name: "R3" },
  { value: 0x0b, name: "L1" },
  { value: 0x0c, name: "L2" },
  { value: 0x0d, name: "L3" },
  // A paddle on itself (the reference's new profile maps every input to its own index, the paddles to 14 and 15).
  { value: 0x0e, name: "Left paddle" },
  { value: 0x0f, name: "Right paddle" },
  { value: 0x10, name: "Options" },
  { value: 0x11, name: "Touchpad" },
];
export const EDGE_BUTTON_VALUES: ReadonlySet<number> = new Set(EDGE_BUTTONS.map((b) => b.value));
/** The 16 physical inputs in the map's order (the reference's ButtonIndex). */
export const EDGE_INPUTS: readonly string[] = ["Up", "Left", "Down", "Right", "Circle", "Cross", "Square", "Triangle", "R1", "R2", "R3", "L1", "L2", "L3", "Left paddle", "Right paddle"];
/** Each input on itself: the map a new profile starts from. */
export const EDGE_IDENTITY_MAP: readonly number[] = Array.from({ length: 16 }, (_, i) => i);

// ---- layout (byte offsets in each 64-byte part, report id at 0)

const AT = {
  part: 1,
  /** Part 0: 1 when the slot holds a profile (the reference writes it); a read with 16 at [1] is an empty slot. */
  used: 2,
  label0: [6, 60] as const,
  label1: [2, 27] as const,
  id: [28, 44] as const,
  leftModifier: 44,
  leftCurve: [47, 53] as const,
  rightModifier: 53,
  rightCurveA: [56, 60] as const,
  rightCurveB: [2, 4] as const,
  triggers: 4,
  buttons: [10, 26] as const,
  leftPreset: 30,
  rightPreset: 32,
  stamp: [34, 40] as const,
  profileCrc: 56,
  crc: 60,
} as const;
/** The bytes the reference writes in a new profile's stamp area ("DateTime area?"). */
const STAMP = [0x1c, 0x55, 0xbb, 0x05, 0x87, 0x01];
const LABEL_MAX = (AT.label0[1] - AT.label0[0]) / 2 + Math.ceil((AT.label1[1] - AT.label1[0]) / 2);

export interface EdgeStick {
  preset: number;
  /** The adjustment step its curve matches (null: a curve not from the table, kept as it is). */
  step: number | null;
  curve: number[];
  modifier: number;
}

export interface EdgeProfile {
  slot: EdgeSlot;
  empty: boolean;
  label: string;
  sticks: [EdgeStick, EdgeStick];
  /** L2 then R2: the travel range (0-255) that counts. */
  triggers: [{ min: number; max: number }, { min: number; max: number }];
  /** 16 entries, EDGE_INPUTS order. */
  buttons: number[];
  /** The three parts as read (report id first). */
  raw: [Uint8Array, Uint8Array, Uint8Array];
}

export const EDGE_LABEL_MAX = LABEL_MAX;

/** Reads the label from the even bytes of part 0 (from 6) and part 1 (from 2): UTF-16LE, ASCII only. */
function readLabel(p0: Uint8Array, p1: Uint8Array): string {
  let s = "";
  for (const [part, [from, to]] of [
    [p0, AT.label0],
    [p1, AT.label1],
  ] as const) {
    for (let i = from; i < to; i += 2) if (part[i] >= 0x20 && part[i] < 0x7f) s += String.fromCharCode(part[i]);
  }
  return s.trim();
}

/** A slot from its three read reports (each 64 bytes, report id first). */
export function parseEdgeProfile(slot: EdgeSlot, parts: readonly Uint8Array[]): EdgeProfile {
  if (parts.length !== 3 || parts.some((p) => p.length < EDGE_PART)) throw new Error("An Edge profile is three 64-byte reports.");
  const [p0, p1, p2] = parts.map((p) => p.slice(0, EDGE_PART)) as [Uint8Array, Uint8Array, Uint8Array];
  const empty = p0[1] === 16;
  const leftCurve = empty ? edgeCurve(0, 0) : [...p1.subarray(...AT.leftCurve)];
  const rightCurve = empty ? edgeCurve(0, 0) : [...p1.subarray(...AT.rightCurveA), ...p2.subarray(...AT.rightCurveB)];
  const leftPreset = EDGE_CURVES[p2[AT.leftPreset]] ? p2[AT.leftPreset] : 0;
  const rightPreset = EDGE_CURVES[p2[AT.rightPreset]] ? p2[AT.rightPreset] : 0;
  return {
    slot,
    empty,
    label: empty ? "" : readLabel(p0, p1),
    sticks: [
      { preset: leftPreset, step: edgeCurveStep(leftPreset, leftCurve), curve: leftCurve, modifier: p1[AT.leftModifier] || EDGE_CURVES[leftPreset].modifier },
      { preset: rightPreset, step: edgeCurveStep(rightPreset, rightCurve), curve: rightCurve, modifier: p1[AT.rightModifier] || EDGE_CURVES[rightPreset].modifier },
    ],
    triggers: empty
      ? [
          { min: 0, max: 255 },
          { min: 0, max: 255 },
        ]
      : [
          { min: p2[AT.triggers], max: p2[AT.triggers + 1] },
          { min: p2[AT.triggers + 2], max: p2[AT.triggers + 3] },
        ],
    buttons: empty ? [...EDGE_IDENTITY_MAP] : [...p2.subarray(...AT.buttons)],
    raw: [p0, p1, p2],
  };
}

/** The profile CRC (part 3, [56]): CRC32 of parts 1-2's bytes 2..59 and part 3's bytes 2..55, in order. */
export function edgeProfileCrc(parts: readonly Uint8Array[]): number {
  const buf = new Uint8Array(170);
  buf.set(parts[0].subarray(2, 60), 0);
  buf.set(parts[1].subarray(2, 60), 58);
  buf.set(parts[2].subarray(2, 56), 116);
  return crc32(buf);
}

/** A part's own CRC ([60]): CRC32 of the seed 0xA3 and the whole 64-byte part with its CRC bytes at zero. */
export function edgePartCrc(part: Uint8Array): number {
  const copy = part.slice(0, EDGE_PART);
  copy.fill(0, AT.crc);
  return crc32(copy, crc32([EDGE_CRC_SEED]));
}

const le32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true);
const setLe32 = (b: Uint8Array, at: number, v: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(at, v, true);

/** The changes the panel makes to a slot. */
export interface EdgeEdit {
  label: string;
  sticks: [{ preset: number; step: number }, { preset: number; step: number }];
  triggers: [{ min: number; max: number }, { min: number; max: number }];
  buttons: number[];
}

/** Checks an edit before anything is built from it. */
export function checkEdgeEdit(e: EdgeEdit): string | null {
  if (!/^[\x20-\x7e]*$/.test(e.label)) return "Profile names are plain letters, digits and punctuation.";
  if (e.label.trim().length === 0) return "Give the profile a name.";
  if (e.label.length > LABEL_MAX) return `Profile names are at most ${LABEL_MAX} characters.`;
  for (const s of e.sticks) {
    if (!EDGE_CURVES[s.preset]) return "Unknown stick curve.";
    if (!Number.isInteger(s.step) || s.step < 0 || s.step > EDGE_ADJUST_MAX) return `The curve adjustment is 0 to ${EDGE_ADJUST_MAX}.`;
  }
  for (const t of e.triggers) {
    if (![t.min, t.max].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return "Trigger ranges are 0 to 255.";
    if (t.min >= t.max) return "A trigger's start has to be below its end.";
  }
  if (e.buttons.length !== 16 || e.buttons.some((b) => !EDGE_BUTTON_VALUES.has(b))) return "Every input needs one of the Edge's buttons.";
  return null;
}

/** 16 random bytes: a new profile's id (the reference generates one per profile). */
export function newProfileId(random: () => number = Math.random): number[] {
  return Array.from({ length: 16 }, () => Math.floor(random() * 256) & 0xff);
}

/**
 * The three write reports for a slot: built from its own bytes as read (an empty slot starts from zeros, like the
 * reference's new profile), with only the edited fields changed and both CRCs recomputed. `data` excludes the id.
 */
export function edgeWriteFrames(p: EdgeProfile, e: EdgeEdit, id: number[] = newProfileId()): { reportId: number; data: Uint8Array }[] {
  if (p.slot.protected) throw new Error("The default profile (Triangle) is never written.");
  const why = checkEdgeEdit(e);
  if (why) throw new Error(why);
  const parts = p.empty ? [new Uint8Array(EDGE_PART), new Uint8Array(EDGE_PART), new Uint8Array(EDGE_PART)] : p.raw.map((r) => r.slice(0, EDGE_PART));
  const [a, b, c] = parts;
  for (const [i, part] of parts.entries()) {
    part[0] = p.slot.write;
    part[AT.part] = i;
    part.fill(0, AT.crc);
  }
  a[AT.used] = 1;
  // Label: UTF-16LE in the even bytes, across parts 1 and 2.
  a.fill(0, AT.label0[0], AT.label0[1]);
  b.fill(0, AT.label1[0], AT.label1[1]);
  const chars = [...e.label];
  for (const [part, [from, to]] of [
    [a, AT.label0],
    [b, AT.label1],
  ] as const) {
    for (let i = from; i < to && chars.length; i += 2) part[i] = chars.shift()!.charCodeAt(0);
  }
  if (p.empty) {
    b.set(id, AT.id[0]);
    c.set(STAMP, AT.stamp[0]);
  }
  const [l, r] = e.sticks;
  const left = edgeCurve(l.preset, l.step);
  const right = edgeCurve(r.preset, r.step);
  b[AT.leftModifier] = EDGE_CURVES[l.preset].modifier;
  b[AT.rightModifier] = EDGE_CURVES[r.preset].modifier;
  b.set(left, AT.leftCurve[0]);
  b.set(right.slice(0, 4), AT.rightCurveA[0]);
  c.set(right.slice(4), AT.rightCurveB[0]);
  c[AT.leftPreset] = l.preset;
  c[AT.rightPreset] = r.preset;
  c.set([e.triggers[0].min, e.triggers[0].max, e.triggers[1].min, e.triggers[1].max], AT.triggers);
  c.set(e.buttons, AT.buttons[0]);
  setLe32(c, AT.profileCrc, edgeProfileCrc(parts));
  for (const part of parts) setLe32(part, AT.crc, edgePartCrc(part));
  return parts.map((part) => ({ reportId: part[0], data: part.slice(1) }));
}

/** The delete report for a slot (1-3; the default can't be deleted): byte 1 is the slot number counted from 1. */
export function edgeDeleteFrame(slot: 1 | 2 | 3): { reportId: number; data: Uint8Array } {
  const data = new Uint8Array(EDGE_PART - 1);
  data[0] = slot + 1;
  return { reportId: EDGE_DELETE, data };
}

/** Why a feature SET to the Edge is refused, or null when it's an allowed profile part or delete (guard.ts, pads.rs). */
export function edgeFeatureSetProblem(reportId: number, data: Uint8Array): string | null {
  if (reportId === 0x63) return "the default profile (Triangle) is never written";
  if (reportId === EDGE_DELETE) {
    if (data.length !== EDGE_PART - 1) return "a delete is one 64-byte report";
    if (data[0] < 2 || data[0] > 4) return data[0] === 1 ? "the default profile can't be deleted" : "a delete names slot 2, 3 or 4";
    return data.subarray(1).every((v) => v === 0) ? null : "a delete carries nothing but the slot";
  }
  if (!EDGE_WRITES.includes(reportId)) return `feature 0x${reportId.toString(16)} isn't an Edge profile write`;
  if (data.length !== EDGE_PART - 1) return "a profile part is 64 bytes";
  const part = new Uint8Array(EDGE_PART);
  part[0] = reportId;
  part.set(data, 1);
  const index = part[AT.part];
  if (index > 2) return "a profile has three parts";
  if (le32(part, AT.crc) !== edgePartCrc(part)) return "the part's CRC doesn't match";
  const odd = (from: number, to: number) => {
    for (let i = from + 1; i < to; i += 2) if (part[i] !== 0) return true;
    return false;
  };
  const text = (from: number, to: number) => {
    for (let i = from; i < to; i += 2) if (part[i] !== 0 && (part[i] < 0x20 || part[i] > 0x7e)) return true;
    return false;
  };
  if (index === 0) {
    if (part[AT.used] !== 1) return "part 1 marks the slot as used";
    if (odd(...AT.label0) || text(...AT.label0)) return "the name is plain text";
  }
  if (index === 1) {
    if (odd(...AT.label1) || text(...AT.label1)) return "the name is plain text";
    if (![0x03, 0x04].includes(part[AT.leftModifier]) || ![0x03, 0x04].includes(part[AT.rightModifier])) return "stick curve modifier";
  }
  if (index === 2) {
    if (!EDGE_CURVES[part[AT.leftPreset]] || !EDGE_CURVES[part[AT.rightPreset]]) return "stick curve preset";
    const t = part.subarray(AT.triggers, AT.triggers + 4);
    if (t[0] >= t[1] || t[2] >= t[3]) return "a trigger range has to start below its end";
    for (const v of part.subarray(...AT.buttons)) if (!EDGE_BUTTON_VALUES.has(v)) return "a button map entry isn't an Edge button";
  }
  return null;
}
