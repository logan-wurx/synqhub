// The Royal Kludge "BeiYing" legacy protocol: three kinds of HID feature report with report id 0x0A and 64 data
// bytes. Nothing ever answers, so SYNQ keeps the board's state itself (session.ts). Pure codec: no device access.
//
// Sources, all GPL-3.0(-or-later), cross-checked against each other byte for byte:
//   Fighting Control Center (FCC) docs/PROTOCOL-RK.md and app/src/hid/rk.ts;
//   rnayabed/rangoli src/keyboardconfiguratorcontroller.cpp (getStandardLightBuffer, setBufferKey, the 9 key-map
//   and 7 per-key-colour buffers), src/keycode.h (the firmware codes);
//   vinc3m1/kludgeknight docs/lighting-protocol.md, src/models/BufferCodec.ts.
// SYNQ is AGPL-3.0, which is compatible with all three; the attribution stays in these headers.
//
// In the reports below, bytes are numbered WITHOUT the report id (the id goes in front on the wire):
//
//   lighting (1 report)   [0x01, 0x01, 0x02, 0x29, mode, 0x00, speed, brightness, r, g, b, random, sleep, 0...]
//                           mode = the board's lighting mode number (RK's KB.ini LedOpt number); speed 1..5;
//                           brightness 0..5 (0 = off); r, g, b are 0 when random = 1; sleep 1 = 5 min, 2 = 10,
//                           3 = 20, 4 = 30, 5 = never
//   key map (9 reports)   [0x09, n, (n = 1: 0x01, 0xF8), data...]   n = 1..9; the data of all nine, in order, is
//                           139 slots of 4 bytes, big-endian: (modifier mask << 16) | (HID usage << 8) for a key,
//                           modifier mask << 16 alone for a modifier, 0xB000 for Fn, 0x01000000 | usage for a
//                           consumer key, 0 for nothing. Report 1 carries 60 data bytes (from byte 4), the others 62.
//   per-key colours       [0x07, n, (n = 1: 0x03, 0x7E, 0x01), data...]   7 reports of r, g, b per slot. SYNQ does
//                           not send these (the panel has no per-key colours) and its guard refuses them.
//
// A key-map write rewrites the base layer in full: the keyboard can't report its map, so SYNQ sends its own copy
// (the board's default map with the remaps made from this PC).

export const REPORT_ID = 0x0a;
export const DATA_LEN = 64;
export const KEY_SLOTS = 139;
export const KEYMAP_REPORTS = 9;
export const KEYMAP_FIRST_DATA = 4;
export const KEYMAP_NEXT_DATA = 2;
/** Bytes of key data in report n (1-based): 60 in the first, 62 in the rest. */
export const keymapChunk = (n: number): number => (n === 1 ? DATA_LEN - KEYMAP_FIRST_DATA : DATA_LEN - KEYMAP_NEXT_DATA);
/** The global byte offset in the 556-byte key data where report n's data starts. */
export const keymapOffset = (n: number): number => (n === 1 ? 0 : keymapChunk(1) + (n - 2) * keymapChunk(2));
export const KEYMAP_BYTES = keymapOffset(KEYMAP_REPORTS) + keymapChunk(KEYMAP_REPORTS);

export const MODE_MAX = 21;
export const SPEED = { min: 1, max: 5 } as const;
export const BRIGHTNESS = { min: 0, max: 5 } as const;
/** Sleep codes and what they mean. */
export const SLEEP_CODES: readonly { code: number; label: string }[] = [
  { code: 1, label: "5 minutes" },
  { code: 2, label: "10 minutes" },
  { code: 3, label: "20 minutes" },
  { code: 4, label: "30 minutes" },
  { code: 5, label: "Never" },
];

export interface Lighting {
  mode: number;
  speed: number;
  brightness: number;
  rgb: readonly [number, number, number];
  random: boolean;
  sleep: number;
}

const int = (v: number, lo: number, hi: number, what: string): number => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${what} must be a whole number from ${lo} to ${hi}.`);
  return v;
};

/** The 64 data bytes of the lighting report. `swapRedGreen`: Rangoli's issue 12 (board 0065 shows red and green swapped). */
export function encodeLighting(l: Lighting, swapRedGreen = false): Uint8Array {
  const d = new Uint8Array(DATA_LEN);
  d.set([0x01, 0x01, 0x02, 0x29]);
  d[4] = int(l.mode, 1, MODE_MAX, "Lighting mode");
  d[6] = int(l.speed, SPEED.min, SPEED.max, "Speed");
  d[7] = int(l.brightness, BRIGHTNESS.min, BRIGHTNESS.max, "Brightness");
  if (!l.random) {
    const [r, g, b] = l.rgb.map((v, i) => int(v, 0, 255, ["Red", "Green", "Blue"][i]));
    d[8] = swapRedGreen ? g : r;
    d[9] = swapRedGreen ? r : g;
    d[10] = b;
  }
  d[11] = l.random ? 1 : 0;
  d[12] = int(l.sleep, 1, 5, "Sleep");
  return d;
}

export function decodeLighting(d: Uint8Array): Lighting | null {
  if (d.length !== DATA_LEN || d[0] !== 1 || d[1] !== 1 || d[2] !== 2 || d[3] !== 0x29) return null;
  return { mode: d[4], speed: d[6], brightness: d[7], rgb: [d[8], d[9], d[10]], random: d[11] === 1, sleep: d[12] };
}

// ---------------------------------------------------------------------------------------------
// Firmware key codes (Rangoli keycode.h)
// ---------------------------------------------------------------------------------------------

export const FN = 0xb000;
export const CONSUMER = 0x01000000;

/** A plain key, optionally with modifier bits (1 L-Ctrl, 2 L-Shift, 4 L-Alt, 8 L-Win, 0x10 R-Ctrl, 0x20 R-Shift, 0x40 R-Alt, 0x80 R-Win). */
export const keyCode = (hid: number, mods = 0): number => ((mods << 16) | (hid << 8)) >>> 0;
/** A modifier key on its own: its bit in byte 1 (HID 0xE0..0xE7). */
export const modifierCode = (hid: number): number => ((1 << (hid - 0xe0)) << 16) >>> 0;
export const consumerCode = (usage: number): number => (CONSUMER | usage) >>> 0;

export type CodeKind = "none" | "key" | "modifier" | "consumer" | "fn" | "unknown";

export function classifyCode(code: number): { kind: CodeKind; hid?: number; mods?: number; usage?: number } {
  if (code === 0) return { kind: "none" };
  if (code === FN) return { kind: "fn" };
  if (code >= CONSUMER) return code >>> 24 === 1 && (code & 0xff0000) === 0 ? { kind: "consumer", usage: code & 0xffff } : { kind: "unknown" };
  if (code > 0xffffff) return { kind: "unknown" };
  const mods = (code >> 16) & 0xff;
  const hid = (code >> 8) & 0xff;
  if ((code & 0xff) !== 0) return { kind: "unknown" };
  if (hid === 0) return mods !== 0 && (mods & (mods - 1)) === 0 ? { kind: "modifier", hid: 0xe0 + Math.log2(mods), mods } : { kind: "unknown" };
  return hid >= 0x04 && hid <= 0xe7 ? { kind: "key", hid, mods } : { kind: "unknown" };
}

// ---------------------------------------------------------------------------------------------
// The key map
// ---------------------------------------------------------------------------------------------

/** The 9 reports' data (64 bytes each) for a map from slot to code; slots not in the map are 0. */
export function encodeKeymap(codes: ReadonlyMap<number, number>): Uint8Array[] {
  const payload = new Uint8Array(KEYMAP_BYTES);
  for (const [slot, code] of codes) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= KEY_SLOTS) throw new RangeError(`Key slot ${slot} is outside 0..${KEY_SLOTS - 1}.`);
    if (classifyCode(code).kind === "unknown") throw new RangeError(`0x${code.toString(16)} isn't a key code this keyboard knows.`);
    payload.set([(code >>> 24) & 0xff, (code >>> 16) & 0xff, (code >>> 8) & 0xff, code & 0xff], slot * 4);
  }
  const out: Uint8Array[] = [];
  let pos = 0;
  for (let n = 1; n <= KEYMAP_REPORTS; n++) {
    const d = new Uint8Array(DATA_LEN);
    d[0] = KEYMAP_REPORTS;
    d[1] = n;
    let at = KEYMAP_NEXT_DATA;
    if (n === 1) {
      d[2] = 0x01;
      d[3] = 0xf8;
      at = KEYMAP_FIRST_DATA;
    }
    const len = keymapChunk(n);
    d.set(payload.subarray(pos, pos + len), at);
    pos += len;
    out.push(d);
  }
  return out;
}

/** The slot -> code map inside nine key-map reports (for tests and the guard's own checks). */
export function decodeKeymap(frames: readonly Uint8Array[]): Map<number, number> | null {
  if (frames.length !== KEYMAP_REPORTS) return null;
  const payload = new Uint8Array(KEYMAP_BYTES);
  let pos = 0;
  for (let n = 1; n <= KEYMAP_REPORTS; n++) {
    const d = frames[n - 1];
    if (d.length !== DATA_LEN || d[0] !== KEYMAP_REPORTS || d[1] !== n) return null;
    const at = n === 1 ? KEYMAP_FIRST_DATA : KEYMAP_NEXT_DATA;
    payload.set(d.subarray(at, at + keymapChunk(n)), pos);
    pos += keymapChunk(n);
  }
  const out = new Map<number, number>();
  for (let slot = 0; slot < KEY_SLOTS; slot++) {
    const code = ((payload[slot * 4] << 24) | (payload[slot * 4 + 1] << 16) | (payload[slot * 4 + 2] << 8) | payload[slot * 4 + 3]) >>> 0;
    if (code !== 0) out.set(slot, code);
  }
  return out;
}
