// Analog key depth: the few requests some keyboards need, the decoders for every family, and the
// allowlist for outgoing frames. Pure: no device access, no imports, erasable TypeScript.
//
// From AnalogSense (MIT, Copyright (c) 2024 Calamity, Inc.); labels as in devices.ts:
//   [js:N]   AnalogSense JavaScript-SDK AnalogSense.js line N (commit 6ba3f4a2)
//   [soup:N] calamity-inc/Soup soup/AnalogueKeyboard.cpp line N (branch senpai, 2026-10-13)
// Key tables below were parsed out of those files as data (scratch script, nothing executed).
//
// Scancodes are HID keyboard usages (page 0x07), with AnalogSense's extensions: 0x3xx consumer keys,
// 0x403..0x405 OEM keys (profile buttons), 0x409 Fn. Depth is 0..1 (1 = bottomed out).

export type Family = "wooting-v1" | "wooting-v2" | "razer-v2" | "razer-v3" | "nuphy" | "drunkdeer" | "keychron" | "madlions" | "bytech";

export const KEY_FN = 0x409;

/** Key names for the scancodes above. [js:1-108] */
export const KEY_NAMES: Readonly<Record<number, string>> = Object.fromEntries([
  [41, "Escape"], [58, "F1"], [59, "F2"], [60, "F3"], [61, "F4"], [62, "F5"], [63, "F6"], [64, "F7"], [65, "F8"], [66, "F9"], [67, "F10"], [68, "F11"], [69, "F12"],
  [53, "`"], [30, "1"], [31, "2"], [32, "3"], [33, "4"], [34, "5"], [35, "6"], [36, "7"], [37, "8"], [38, "9"], [39, "0"], [45, "-"], [46, "="], [42, "Backspace"],
  [43, "Tab"], [20, "Q"], [26, "W"], [8, "E"], [21, "R"], [23, "T"], [28, "Y"], [24, "U"], [12, "I"], [18, "O"], [19, "P"], [47, "["], [48, "]"], [40, "Enter"],
  [57, "Caps Lock"], [4, "A"], [22, "S"], [7, "D"], [9, "F"], [10, "G"], [11, "H"], [13, "J"], [14, "K"], [15, "L"], [51, ";"], [52, "'"], [49, "Backslash"],
  [225, "Left Shift"], [100, "Intl Backslash"], [29, "Z"], [27, "X"], [6, "C"], [25, "V"], [5, "B"], [17, "N"], [16, "M"], [54, ","], [55, "."], [56, "/"], [229, "Right Shift"],
  [224, "Left Ctrl"], [227, "Left Meta"], [226, "Left Alt"], [44, "Space"], [230, "Right Alt"], [231, "Right Meta"], [0x409, "Fn"], [101, "Context Menu"], [228, "Right Ctrl"],
  [70, "Print Screen"], [72, "Pause"], [71, "Scroll Lock"], [73, "Insert"], [74, "Home"], [75, "Page Up"], [76, "Delete"], [77, "End"], [78, "Page Down"],
  [82, "Up Arrow"], [80, "Left Arrow"], [81, "Down Arrow"], [79, "Right Arrow"], [83, "Num Lock"], [84, "Numpad /"], [85, "Numpad *"], [86, "Numpad -"],
  [95, "Numpad 7"], [96, "Numpad 8"], [97, "Numpad 9"], [87, "Numpad +"], [92, "Numpad 4"], [93, "Numpad 5"], [94, "Numpad 6"], [89, "Numpad 1"], [90, "Numpad 2"],
  [91, "Numpad 3"], [88, "Numpad Enter"], [98, "Numpad 0"], [99, "Numpad ."],
  [0x3b5, "Next Track"], [0x3b6, "Previous Track"], [0x3b7, "Stop Media"], [0x3cd, "Play/Pause"], [0x394, "File Explorer"], [0x323, "Browser Home"],
  [0x401, "Brightness Up"], [0x402, "Brightness Down"], [0x403, "Profile 1"], [0x404, "Profile 2"], [0x405, "Profile 3"], [0x408, "Profile Switch"],
] as [number, string][]);

const pairs = (flat: readonly number[]) => {
  const m = new Map<number, number>();
  for (let i = 0; i < flat.length; i += 2) m.set(flat[i], flat[i + 1]);
  return m;
};

/** Razer scancode -> HID. [js:1-108 "razer" column][soup:440-553] */
export const RAZER_TO_HID: ReadonlyMap<number, number> = pairs([
  110, 41, 112, 58, 113, 59, 114, 60, 115, 61, 116, 62, 117, 63, 118, 64, 119, 65, 120, 66, 121, 67, 122, 68, 123, 69, 1, 53, 2, 30, 3, 31, 4, 32, 5, 33, 6, 34, 7, 35,
  8, 36, 9, 37, 10, 38, 11, 39, 12, 45, 13, 46, 15, 42, 16, 43, 17, 20, 18, 26, 19, 8, 20, 21, 21, 23, 22, 28, 23, 24, 24, 12, 25, 18, 26, 19, 27, 47, 28, 48, 43, 40,
  30, 57, 31, 4, 32, 22, 33, 7, 34, 9, 35, 10, 36, 11, 37, 13, 38, 14, 39, 15, 40, 51, 41, 52, 42, 49, 44, 225, 45, 100, 46, 29, 47, 27, 48, 6, 49, 25, 50, 5, 51, 17,
  52, 16, 53, 54, 54, 55, 55, 56, 57, 229, 58, 224, 127, 227, 60, 226, 61, 44, 62, 230, 59, 0x409, 129, 101, 64, 228, 124, 70, 125, 72, 126, 71, 75, 73, 80, 74, 85, 75,
  76, 76, 81, 77, 86, 78, 83, 82, 79, 80, 84, 81, 89, 79, 90, 83, 95, 84, 100, 85, 105, 86, 91, 95, 96, 96, 101, 97, 106, 87, 92, 92, 97, 93, 102, 94, 93, 89, 98, 90,
  103, 91, 108, 88, 99, 98, 104, 99,
]);

/** NuPhy reports modifiers as bit masks and Fn as 0xFF05; every other key as its HID usage. [js:69-77 "nuphy" column][soup:1097-1105] */
export const NUPHY_SPECIAL: ReadonlyMap<number, number> = pairs([0x100, 224, 0x200, 225, 0x400, 226, 0x800, 227, 0x1000, 228, 0x2000, 229, 0x4000, 230, 0x8000, 231, 0xff05, 0x409]);

/** Bytech key position -> HID. [js:1-108 "bytech" column] */
export const BYTECH_TO_HID: ReadonlyMap<number, number> = pairs([
  1, 41, 2, 58, 3, 59, 4, 60, 5, 61, 6, 62, 7, 63, 8, 64, 9, 65, 10, 66, 11, 67, 12, 68, 13, 69, 14, 53, 15, 30, 16, 31, 17, 32, 18, 33, 19, 34, 20, 35, 21, 36, 22, 37,
  23, 38, 24, 39, 25, 45, 26, 46, 27, 42, 28, 43, 29, 20, 30, 26, 31, 8, 32, 21, 33, 23, 34, 28, 35, 24, 36, 12, 37, 18, 38, 19, 39, 47, 40, 48, 54, 40, 42, 57, 43, 4,
  44, 22, 45, 7, 46, 9, 47, 10, 48, 11, 49, 13, 50, 14, 51, 15, 52, 51, 53, 52, 41, 49, 55, 225, 56, 29, 57, 27, 58, 6, 59, 25, 60, 5, 61, 17, 62, 16, 63, 54, 64, 55,
  65, 56, 66, 229, 67, 224, 68, 227, 69, 226, 70, 44, 71, 230, 72, 0x409, 73, 228, 100, 74, 102, 75, 99, 76, 103, 78, 74, 82, 76, 80, 75, 81, 77, 79,
]);

/** DrunkDeer matrix index (row * 21 + column) -> HID. [js:1067-1161 drunkdeerIndexToHidScancode][soup:814-900] */
export const DRUNKDEER_TO_HID: ReadonlyMap<number, number> = pairs([
  0, 41, 2, 58, 3, 59, 4, 60, 5, 61, 6, 62, 7, 63, 8, 64, 9, 65, 10, 66, 11, 67, 12, 68, 13, 69, 14, 76, 21, 53, 22, 30, 23, 31, 24, 32, 25, 33, 26, 34, 27, 35, 28, 36,
  29, 37, 30, 38, 31, 39, 32, 45, 33, 46, 34, 42, 36, 74, 42, 43, 43, 20, 44, 26, 45, 8, 46, 21, 47, 23, 48, 28, 49, 24, 50, 12, 51, 18, 52, 19, 53, 47, 54, 48, 55, 49,
  57, 75, 63, 57, 64, 4, 65, 22, 66, 7, 67, 9, 68, 10, 69, 11, 70, 13, 71, 14, 72, 15, 73, 51, 74, 52, 76, 40, 78, 78, 84, 225, 86, 29, 87, 27, 88, 6, 89, 25, 90, 5,
  91, 17, 92, 16, 93, 54, 94, 55, 95, 56, 97, 229, 98, 82, 99, 77, 105, 224, 106, 227, 107, 226, 111, 44, 115, 230, 116, 0x409, 117, 101, 119, 80, 120, 81, 121, 79,
]);

export interface MatrixLayout {
  rows: number;
  cols: number;
  /** HID scancode per matrix index (row * cols + col); 0 = no key. */
  keys: readonly number[];
}

/** Keychron / Lemokey matrices [soup:221-279] and Madlions [soup:289-303] (5 rows assumed [soup:1161]). */
export const LAYOUTS: Readonly<Record<string, MatrixLayout>> = {
  "keychron-q1-he": { rows: 6, cols: 15, keys: [41,58,59,60,61,62,63,64,65,66,67,68,69,76,0,53,30,31,32,33,34,35,36,37,38,39,45,46,42,75,43,20,26,8,21,23,28,24,12,18,19,47,48,49,78,57,4,22,7,9,10,11,13,14,15,51,52,40,74,0,225,0,29,27,6,25,5,17,16,54,55,0,56,229,82,224,227,226,0,0,0,44,0,0,231,1033,228,80,81,79] },
  "keychron-q3-he": { rows: 6, cols: 16, keys: [41,58,59,60,61,62,63,64,65,66,67,68,69,70,1027,1028,53,30,31,32,33,34,35,36,37,38,39,45,46,42,73,74,43,20,26,8,21,23,28,24,12,18,19,47,48,49,76,77,57,4,22,7,9,10,11,13,14,15,51,52,0,40,75,78,225,0,29,27,6,25,5,17,16,54,55,0,56,229,0,82,224,227,226,0,0,0,44,0,0,230,231,1033,228,80,81,79] },
  "keychron-q5-he": { rows: 6, cols: 19, keys: [41,0,58,59,60,61,62,63,64,65,66,67,68,69,76,1027,1028,1029,0,53,30,31,32,33,34,35,36,37,38,39,45,46,42,75,83,84,85,86,43,20,26,8,21,23,28,24,12,18,19,47,48,49,78,95,96,97,87,57,4,22,7,9,10,11,13,14,15,51,52,40,74,0,92,93,94,0,225,0,29,27,6,25,5,17,16,54,55,0,56,229,82,89,90,91,88,224,227,226,0,0,0,44,0,0,231,1033,228,80,81,79,0,98,99,0] },
  "keychron-k2-he": { rows: 6, cols: 16, keys: [41,58,59,60,61,62,63,64,65,66,67,68,69,70,76,1028,53,30,31,32,33,34,35,36,37,38,39,45,46,42,75,0,43,20,26,8,21,23,28,24,12,18,19,47,48,49,78,0,57,4,22,7,9,10,11,13,14,15,51,52,40,74,0,0,225,0,29,27,6,25,5,17,16,54,55,56,229,82,77,0,224,227,226,0,0,0,44,0,0,230,1033,228,80,81,79,0] },
  "lemokey-p1-he-ansi": { rows: 6, cols: 15, keys: [41,58,59,60,61,62,63,64,65,66,67,68,69,76,0,53,30,31,32,33,34,35,36,37,38,39,45,46,42,74,43,20,26,8,21,23,28,24,12,18,19,47,48,49,75,57,4,22,7,9,10,11,13,14,15,51,52,40,78,0,225,0,29,27,6,25,5,17,16,54,55,0,56,229,82,224,227,226,0,0,0,44,0,0,231,1033,228,80,81,79] },
  "lemokey-p1-he-iso": { rows: 6, cols: 15, keys: [41,58,59,60,61,62,63,64,65,66,67,68,69,76,0,53,30,31,32,33,34,35,36,37,38,39,45,46,42,74,43,20,26,8,21,23,28,24,12,18,19,47,48,40,75,57,4,22,7,9,10,11,13,14,15,51,52,49,78,0,225,100,29,27,6,25,5,17,16,54,55,0,56,229,82,224,227,226,0,0,0,44,0,0,231,1033,228,80,81,79] },
  "madlions-mad60he": { rows: 5, cols: 14, keys: [41,30,31,32,33,34,35,36,37,38,39,45,46,42,43,20,26,8,21,23,28,24,12,18,19,47,48,49,57,4,22,7,9,10,11,13,14,15,51,52,0,40,225,0,29,27,6,25,5,17,16,54,55,56,0,229,224,227,226,0,0,0,44,0,0,231,230,101,228,1033] },
  "madlions-mad68he": { rows: 5, cols: 15, keys: [41,30,31,32,33,34,35,36,37,38,39,45,46,42,73,43,20,26,8,21,23,28,24,12,18,19,47,48,49,76,57,4,22,7,9,10,11,13,14,15,51,52,0,40,75,225,0,29,27,6,25,5,17,16,54,55,56,229,82,78,224,227,226,0,0,0,44,0,0,230,1033,228,80,81,79] },
};

export interface DepthUpdate {
  /** Keys whose depth this report gives (others unchanged). */
  set: Map<number, number>;
  /** True when the report describes every key: keys missing from `set` are up. */
  complete: boolean;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// =============================================================================================
// Stream families (nothing is ever sent to them)
// =============================================================================================

/** Wooting v1: [scancode hi, scancode lo, value] x up to 16, ended by scancode 0. Full list of pressed keys. [js:356-368][soup:606-650] */
export function decodeWootingV1(d: Uint8Array): DepthUpdate {
  const set = new Map<number, number>();
  for (let i = 0; i + 3 <= d.length; i += 3) {
    const sc = (d[i] << 8) | d[i + 1];
    if (sc === 0) break;
    set.set(sc, d[i + 2] / 255); // the last value wins when a key repeats [soup:625-633]
  }
  return { set, complete: true };
}

/** Wooting v2: 4-byte entries [matrix pos, scancode lo, packed, value hi]; value = hi << 2 | packed >> 6, 0..1023. [js:386-412][soup:652-695] */
export function decodeWootingV2(d: Uint8Array): DepthUpdate {
  const set = new Map<number, number>();
  for (let i = 0; i + 4 <= d.length; i += 4) {
    const lo = d[i + 1];
    const packed = d[i + 2];
    if (lo === 0) break;
    const sc = (((packed >> 2) & 0xf) << 8) | lo;
    const value = (d[i + 3] << 2) | ((packed >> 6) & 0x3);
    if (value) set.set(sc, value / 1023);
  }
  return { set, complete: true };
}

/** Razer report 7 (V2: [scancode, value] x up to 11) or 11 (V3: [scancode, value, ?] x up to 15); data without the report id. [js:430-451][js:470-492][soup:715-766] */
export function decodeRazer(d: Uint8Array, v3: boolean): DepthUpdate {
  const set = new Map<number, number>();
  const step = v3 ? 3 : 2;
  for (let i = 0; i + 2 <= d.length; i += step) {
    if (d[i] === 0) break;
    const hid = RAZER_TO_HID.get(d[i]);
    if (hid) set.set(hid, d[i + 1] / 255);
  }
  return { set, complete: true };
}

/**
 * NuPhy 0xA0 report: [0xA0, ?, scancode hi, scancode lo, value hi, value lo, ...], one key per report;
 * depth = value / scale (800, or 1600 on the Air75 / Air60 HE). [soup:1083-1131]
 * (The WebHID SDK reads byte 7 / 200 instead [js:516-523]; SYNQ follows the newer C++ code.)
 */
export function decodeNuphy(d: Uint8Array, scale = 800): DepthUpdate | null {
  if (d.length < 6 || d[0] !== 0xa0) return null;
  const raw = (d[2] << 8) | d[3];
  const hid = raw >> 8 ? NUPHY_SPECIAL.get(raw) ?? 0 : raw;
  if (!hid) return null;
  const value = (d[4] << 8) | d[5];
  return { set: new Map([[hid, clamp01(value / scale)]]), complete: false };
}

// =============================================================================================
// Poll families: requests and replies
// =============================================================================================

/** DrunkDeer: report 4, 63 bytes [0xB6, 0x03, 0x01, 0...]. [js:551-562][soup:781-789] */
export const DRUNKDEER_REQUEST: readonly number[] = [0xb6, 0x03, 0x01, ...new Array(60).fill(0)];
export const DRUNKDEER_CHUNK = 59; // bytes of depth per reply (63 - 4 header) [js:577]
/** 0.1 mm per unit; 40 = 4.0 mm = bottomed out. [js:582][soup:808] */
export const DRUNKDEER_FULL = 40;

/** One of the three replies: [?, ?, ?, n, depth x 59]; returns null for other reports. [js:564-590] */
export function decodeDrunkdeerChunk(d: Uint8Array): { part: number; depth: Map<number, number>; mm: Map<number, number> } | null {
  const part = d[3];
  if (d.length < 5 || part > 2) return null;
  const depth = new Map<number, number>();
  const mm = new Map<number, number>();
  for (let i = 4; i < d.length; i++) {
    const v = d[i];
    if (!v) continue;
    const hid = DRUNKDEER_TO_HID.get(part * DRUNKDEER_CHUNK + (i - 4));
    if (!hid) continue;
    depth.set(hid, clamp01(v / DRUNKDEER_FULL));
    mm.set(hid, v / 10);
  }
  return { part, depth, mm };
}

/** Keychron / Lemokey (QMK "KC_HE" 0xA9). Report 0, 32 bytes. [soup:919-1026] */
export const KC = { cmd: 0xa9, getVersion: 0x01, travel: 0x30, travelAll: 0x31 } as const;
const kc32 = (sub: number, row = 0, col = 0) => {
  const f = new Array(32).fill(0);
  f[0] = KC.cmd;
  f[1] = sub;
  f[2] = row;
  f[3] = col;
  return f;
};
/** AMC_GET_VERSION: reply [0xA9, 0x01, version, ...]; byte 31 = 0x45 on AnalogSense's custom firmware. [soup:921-940][js:653-654] */
export const keychronVersionRequest = (): number[] => kc32(KC.getVersion);
/** AMC_GET_REALTIME_TRAVEL for one matrix position. [soup:983-1001][js:715-731] */
export const keychronTravelRequest = (row: number, col: number): number[] => kc32(KC.travel, row, col);
/** AMC_GET_REALTIME_TRAVEL_ALL (custom firmware only): four replies of 30 positions. [soup:944-978][js:733-743] */
export const keychronTravelAllRequest = (): number[] => kc32(KC.travelAll);
export const KEYCHRON_FULL = 235; // [soup:973][js:670]
export const KEYCHRON_MIN = 5; // below this the key is up [soup:968]

export const isKeychronReply = (d: Uint8Array, sub: number): boolean => d[0] === KC.cmd && d[1] === sub;
export const decodeKeychronVersion = (d: Uint8Array) => ({ version: d[2], fullReport: d[31] === 0x45 });
/** Travel byte of a one-key reply: [6] from version 4, [3] before. [soup:1003][js:698] */
export const decodeKeychronTravel = (d: Uint8Array, version: number): number => {
  const t = d[version >= 4 ? 6 : 3];
  return t >= KEYCHRON_MIN ? clamp01(t / KEYCHRON_FULL) : 0;
};
/** One page of the all-keys reply: 30 travel bytes from [2]; page p covers matrix indices 30p..30p+29. [soup:962-978] */
export function decodeKeychronAllPage(d: Uint8Array, page: number, layout: MatrixLayout): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < 30; i++) {
    const at = page * 30 + i;
    if (at >= layout.keys.length) break;
    const hid = layout.keys[at];
    if (!hid) continue;
    const t = d[2 + i];
    out.set(hid, t >= KEYCHRON_MIN ? clamp01(t / KEYCHRON_FULL) : 0);
  }
  return out;
}

/** Madlions: report 0, 32 bytes [0x02, 0x96, 0x1C, 0, 0, 0, offset, 4]: four keys from matrix offset. [soup:1163-1212][js:803-841] */
export const madlionsRequest = (offset: number): number[] => {
  const f = new Array(32).fill(0);
  f[0] = 0x02;
  f[1] = 0x96;
  f[2] = 0x1c;
  f[6] = offset;
  f[7] = 4;
  return f;
};
export const MADLIONS_FULL = 350; // [soup:1221][js:829]
/** Reply: per key i < 4, travel = u16 big-endian at 10 + 5i (0.01 mm, inferred from 350 = 3.5 mm). [soup:1214-1221][js:817-832] */
export function decodeMadlions(d: Uint8Array, offset: number, layout: MatrixLayout): { depth: Map<number, number>; mm: Map<number, number> } {
  const depth = new Map<number, number>();
  const mm = new Map<number, number>();
  for (let i = 0; i < 4; i++) {
    const at = offset + i;
    if (at >= layout.keys.length) break;
    const hid = layout.keys[at];
    if (!hid) continue;
    const t = (d[10 + 5 * i] << 8) | d[11 + 5 * i];
    depth.set(hid, clamp01(t / MADLIONS_FULL));
    mm.set(hid, t / 100);
  }
  return { depth, mm };
}

/** Bytech: report 9, 63 bytes [0x97, 0x00, 0..., checksum], checksum = 255 - ((9 + sum of bytes 0..61) mod 256). [js:861-869][js:876] */
export function bytechRequest(): number[] {
  const f = new Array(63).fill(0);
  f[0] = 0x97;
  f[1] = 0x00;
  let sum = 9;
  for (let i = 0; i < 62; i++) sum += f[i];
  f[62] = 255 - (sum % 256);
  return f;
}
export const BYTECH_FULL = 355; // [js:899]
/** Reply [0x97, 0x01, ?, ?, ?, count, (pos u16 BE, distance u16 BE) ...]; distance <= 10 = up. [js:881-905] */
export function decodeBytech(d: Uint8Array): DepthUpdate | null {
  if (d[0] !== 0x97 || d[1] !== 0x01) return null;
  const set = new Map<number, number>();
  const count = d[5];
  for (let i = 0; i < count && 9 + i < d.length; i += 4) {
    const pos = (d[6 + i] << 8) | d[7 + i];
    const distance = (d[8 + i] << 8) | d[9 + i];
    const hid = BYTECH_TO_HID.get(pos);
    if (hid && distance > 10) set.set(hid, clamp01(distance / BYTECH_FULL));
  }
  return { set, complete: true };
}

// =============================================================================================
// Safety: the only frames SYNQ may send for live depth. Everything else is refused, notably:
//   - VIA bootloader jump 0x0B, EEPROM reset 0x0A, keymap reset 0x06, set value 0x03, every write
//     (Keychron / Lemokey / Madlions sit on VIA's FF60 / 0x61 collection);
//   - every Keychron 0xA9 sub-command except version / travel reads (profiles, calibration, save);
//   - every other DrunkDeer and Bytech command (their configurators' writes, resets, firmware);
//   - anything at all to Wooting, Razer and NuPhy (stream only); in particular Razer's "device mode 3"
//     feature report that switches on analog reports [soup:315-341, disabled there too], a device-mode change;
//   - feature reports for every family.
// =============================================================================================

export interface FrameCheck {
  ok: boolean;
  name: string;
  reason?: string;
}

const hexOf = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
const sameAs = (d: ArrayLike<number>, want: readonly number[]) => d.length === want.length && want.every((v, i) => d[i] === v);
const zeroFrom = (d: ArrayLike<number>, from: number) => Array.from(d).slice(from).every((b) => b === 0);

export const KEYCHRON_MAX_COLS = 19; // widest listed matrix (Q5 HE)
export const MADLIONS_MAX_KEYS = 75; // MAD68HE matrix (5 x 15)

/** Stateless: may `data` go out as output report `reportId` to a keyboard of `family`? */
export function checkAnalogFrame(family: Family, reportId: number, data: ArrayLike<number>, kind: "output" | "feature" = "output"): FrameCheck {
  const no = (reason: string): FrameCheck => ({ ok: false, name: "blocked", reason: `${family}: ${reason} (${hexOf(Array.from(data).slice(0, 8))}...)` });
  if (kind !== "output") return no("feature reports are never sent for live depth");
  switch (family) {
    case "drunkdeer":
      return reportId === 4 && sameAs(data, DRUNKDEER_REQUEST) ? { ok: true, name: "drunkdeer depth request" } : no("only the 0xB6 03 01 depth request (report 4, 63 bytes) is allowed");
    case "bytech":
      return reportId === 9 && sameAs(data, bytechRequest()) ? { ok: true, name: "bytech depth request" } : no("only the 0x97 00 depth request (report 9, 63 bytes) is allowed");
    case "keychron": {
      if (reportId !== 0 || data.length !== 32 || data[0] !== KC.cmd) return no("only 0xA9 depth reads (report 0, 32 bytes) are allowed");
      if ((data[1] === KC.getVersion || data[1] === KC.travelAll) && zeroFrom(data, 2)) return { ok: true, name: data[1] === KC.getVersion ? "keychron analog version" : "keychron depth (all keys)" };
      if (data[1] === KC.travel && data[2] < 6 && data[3] < KEYCHRON_MAX_COLS && zeroFrom(data, 4)) return { ok: true, name: "keychron depth (one key)" };
      return no(`0xA9 sub-command 0x${(data[1] ?? 0).toString(16)} isn't a depth read`);
    }
    case "madlions":
      if (reportId === 0 && data.length === 32 && sameAs(Array.from(data).slice(0, 6), [0x02, 0x96, 0x1c, 0, 0, 0]) && data[6] % 4 === 0 && data[6] < MADLIONS_MAX_KEYS && data[7] === 4 && zeroFrom(data, 8))
        return { ok: true, name: "madlions depth (4 keys)" };
      return no("only the 02 96 1C depth read (report 0, 32 bytes, offset multiple of 4) is allowed");
    default:
      return no("nothing is ever sent to this keyboard; its depth arrives on its own");
  }
}

export function assertAnalogSendable(family: Family, reportId: number, data: ArrayLike<number>): FrameCheck {
  const c = checkAnalogFrame(family, reportId, data);
  if (!c.ok) throw new Error(`Blocked: ${c.reason}`);
  return c;
}
