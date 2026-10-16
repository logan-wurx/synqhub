// Writes the fixtures that keep the TypeScript Advanced guards and the Rust bridge's guards in step:
//
//   src-tauri/src/atk-frames.txt           ATK X1 frames, each judged with and without Advanced scopes
//   src-tauri/src/via-frames-advanced.txt  QMK raw-HID (VIA / Vial) frames, ditto
//   src-tauri/src/sonix-frames-advanced.txt  Sonix HE (FCC protocol) frames, ditto
//
// Every line is `<grants> <1|0> <hex>`: the grants that were live (`-` for none, else scopes joined by
// `+`, a remap scope carrying its keycode scheme as `remap:current` / `remap:legacy`), whether the
// frontend guard let the frame through, and the frame (VIA's with trailing zero bytes dropped). The Rust
// tests (hid.rs `atk_guard_matches_the_frontend`, `via_advanced_guard_matches_the_frontend`) must agree
// on every line. The default path's own fixture, src-tauri/src/via-frames.txt, is not touched: it must
// stay byte for byte what it was before the Advanced section existed. Run after changing either side:
//
//   node scripts/advanced-fixtures.ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { weBuildCmdPayload, weReportChecksum } from "@openmouse/protocol/endgame-gear-we";
import { AdvancedGate, type AdvancedScope, type KeycodeScheme } from "../src/lib/advanced/core.ts";
import * as ATK from "../src/lib/atk-protocol.ts";
import { checkViaFrame } from "../src/lib/kb/via/guard.ts";
import { ADVANCED_KEYCODES, NEVER_KEYCODES } from "../src/lib/kb/via/keycode-safety.ts";
import * as SONIX from "../src/lib/kb/fcc/sonix-protocol.ts";

export interface GrantSpec {
  scopes: readonly AdvancedScope[];
  scheme?: KeycodeScheme;
}

export const specText = (g: GrantSpec): string => (g.scopes.length ? g.scopes.map((s) => (s === "remap" && g.scheme ? `remap:${g.scheme}` : s)).join("+") : "-");

/** A live gate holding exactly these scopes (an unconfirmed one for none). */
export async function gateFor(g: GrantSpec): Promise<AdvancedGate> {
  const gate = new AdvancedGate("fixture");
  for (const s of g.scopes) await gate.grant(s, { acknowledged: true, typed: "RESET" }, { scheme: g.scheme });
  return gate;
}

const hex = (b: ArrayLike<number>, trim = false) => {
  let end = b.length;
  if (trim) while (end > 1 && b[end - 1] === 0) end--;
  return Array.from({ length: end }, (_, i) => b[i].toString(16).padStart(2, "0")).join("");
};

// ---------------------------------------------------------------------------------------------
// ATK
// ---------------------------------------------------------------------------------------------

export function atkFixtureFrames(): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const raw = (cmd: number, body: readonly number[], sum = true) => {
    // body[0] is byte 1.
    const f = new Uint8Array(16);
    f[0] = cmd;
    body.forEach((b, i) => (f[1 + i] = b));
    f[15] = sum ? weReportChecksum(0x08, Array.from(f.subarray(0, 15))) : 0x99;
    frames.push(f);
  };
  // every command id, bare
  for (let c = 0; c < 256; c++) raw(c, []);
  for (let c = 0; c < 256; c += 17) raw(c, [], false);
  // a bare command with something after it
  for (const c of [0x03, 0x04, 0x06, 0x09, 0x10, 0x12, 0x1d]) {
    raw(c, [1]);
    raw(c, [0, 0, 0, 0, 5]);
    raw(c, new Array(14).fill(0).map((_, i) => (i === 13 ? 1 : 0)));
  }
  // EEPROM reads: every address the service reads plus key rows and strangers, lengths 0..12
  const addresses = [0x0000, 0x000a, 0x00a9, 0x00b5, 0x00bd, 0x0060, 0x0064, 0x0074, 0x0078, 0x1b00, 0x1b06, 0x1b2a, 0x0100, 0x0300, 0xffff];
  for (const a of addresses) for (let len = 0; len <= 12; len++) raw(0x08, [0, a >> 8, a & 0xff, len]);
  raw(0x08, [1, 0, 0x60, 4]);
  raw(0x08, [0, 0, 0x60, 4, 9]);
  // writes to each default row: well formed, bad pair, wrong length, trailing byte
  const pair = (v: number) => [v, (0x55 - v) & 0xff];
  const rows: [number, number[], boolean][] = [
    [0x0000, [...pair(0x01), ...pair(4), ...pair(2), ...pair(0), ...pair(0)], false],
    [0x000a, [...pair(5)], false],
    [0x00a9, [...pair(1), ...pair(1), ...pair(6), ...pair(0), ...pair(0)], false],
    [0x00b5, [...pair(0), ...pair(1), ...pair(2)], false],
    [0x1b00, ATK.packPaw3955Stage(800), true],
    [0x1b06, ATK.packPaw3955Stage(1600), true],
    [0x1b2a, ATK.packPaw3955Stage(3200), true],
  ];
  for (const [a, data] of rows) {
    const w = (addr: number, d: number[], len = d.length) => raw(0x07, [0, addr >> 8, addr & 0xff, len, ...d]);
    w(a, data);
    w(a, data.map((b, i) => (i === 1 ? (b + 1) & 0xff : b)));
    w(a, data.slice(0, -2), data.length - 2);
    w(a, [...data, 0], data.length);
    w(a, data, data.length + 1);
    raw(0x07, [1, a >> 8, a & 0xff, data.length, ...data]);
    raw(0x07, [0, a >> 8, a & 0xff, data.length, ...data, ...new Array(Math.max(0, 10 - data.length)).fill(0), 1].slice(0, 14));
  }
  // writes to addresses nobody owns
  for (const a of [0x0001, 0x0100, 0x0300, 0x00bd, 0x1b01, 0x1b30, 0x1bff, 0x0060 - 4, 0x0060 + 24, 0x0062, 0x0000 + 0xa8, 0x7fff]) raw(0x07, [0, a >> 8, a & 0xff, 4, ...ATK.packButton({ kind: "dpi", value: 1 })]);
  // button rows: every class / value / second value, at each key
  for (const key of [0, 1, 5, 6]) {
    const a = ATK.KEY_ROW.base + key * 4;
    for (const cls of [0, 1, 2, 3, 0xff]) {
      for (const v1 of [0, 1, 2, 3, 4, 8, 16, 17]) {
        for (const v2 of [0, 1]) {
          const body = [cls, v1, v2];
          raw(0x07, [0, a >> 8, a & 0xff, 4, ...body, (0x55 - body.reduce((s, b) => s + b, 0)) & 0xff]);
        }
      }
    }
    raw(0x07, [0, a >> 8, a & 0xff, 4, 1, 1, 0, 0x54]); // bad check
    raw(0x07, [0, a >> 8, a & 0xff, 3, 1, 1, 0]);
    raw(0x07, [0, a >> 8, a & 0xff, 5, 1, 1, 0, 0x53, 0]);
    raw(0x07, [0, a >> 8, a & 0xff, 4, ...ATK.LEFT_CLICK_ROW, 1]);
    raw(0x07, [1, a >> 8, a & 0xff, 4, ...ATK.LEFT_CLICK_ROW]);
  }
  // pair requests: checked mouse, other mice, malformed
  for (const [cid, mid] of [[1, 61], [1, 8], [0, 0], [255, 255], [1, 60], [2, 61]]) frames.push(ATK.buildPairRequest(cid, mid));
  raw(0x05, [0, 0, 0, 2, 1, 61, 1]);
  raw(0x05, [0, 0, 0, 3, 1, 61]);
  raw(0x05, [1, 0, 0, 2, 1, 61]);
  raw(0x05, [0, 1, 0, 2, 1, 61]);
  raw(0x05, [0, 0, 0, 2, 1, 61, 0, 0, 0, 0, 0, 0, 0, 1]);
  frames.push(ATK.buildPairResult(), ATK.buildRestoreFactory());
  // length: not 16 bytes (the guard rejects before looking)
  frames.push(new Uint8Array(15), new Uint8Array(17), weBuildCmdPayload(0x03).slice(0, 8));
  return frames;
}

const ATK_SPECS: GrantSpec[] = [
  { scopes: [] },
  { scopes: ["pair"] },
  { scopes: ["remap"] },
  { scopes: ["reset"] },
  { scopes: ["macros"] },
  { scopes: ["calibrate"] },
  { scopes: ["pair", "remap", "reset"] },
  { scopes: ["pair", "remap", "macros", "calibrate", "reset"] },
];

export async function atkFixtureText(): Promise<string> {
  const frames = atkFixtureFrames();
  const lines: string[] = [];
  for (const spec of ATK_SPECS) {
    const gate = await gateFor(spec);
    for (const f of frames) lines.push(`${specText(spec)} ${ATK.checkFrame(f, gate) === null ? 1 : 0} ${hex(f)}`);
  }
  return lines.join("\n").concat("\n");
}

// ---------------------------------------------------------------------------------------------
// VIA
// ---------------------------------------------------------------------------------------------

export function viaAdvancedFrames(): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const frame = (...bytes: number[]) => {
    const f = new Uint8Array(32);
    f.set(bytes);
    frames.push(f);
  };
  for (let c = 0; c < 256; c++) frame(c);
  for (const c of [0x02, 0x07, 0x09, 0xfe]) for (let b = 1; b < 256; b += 7) frame(c, b);
  // keycode writes: every multiple of 0x20, the edge of every range, and the dangerous ones by name
  const codes = new Set<number>();
  for (let c = 0; c <= 0xffff; c += 0x100) codes.add(c);
  for (let c = 0x4f00; c <= 0x7f00; c += 0x20) codes.add(c);
  for (const [a, b] of [...NEVER_KEYCODES, ...ADVANCED_KEYCODES.current, ...ADVANCED_KEYCODES.legacy]) for (const c of [a - 1, a, a + 1, b - 1, b, b + 1]) if (c >= 0 && c <= 0xffff) codes.add(c);
  for (const c of [0x7c00, 0x7c01, 0x7c02, 0x7c03, 0x7c04, 0x7c10, 0x7c73, 0x5c00, 0x5c01, 0x5c02, 0x5c03, 0x5c10, 0x5f12, 0x5f21, 0x5f22, 0x5f80, 0x7700, 0x777f, 0x7780, 0x7e00, 0x7e40, 0x7fff, 0x8000, 0xffff, 0x00ff, 0x0100]) codes.add(c);
  for (const c of [...codes].sort((a, b) => a - b)) frame(0x05, 1, 2, 3, c >> 8, c & 0xff);
  // macro writes: sizes, offsets, padding
  for (const [off, size] of [[0, 1], [0, 28], [0, 29], [0, 0], [4068, 28], [4069, 28], [4096, 1], [0xffff, 1], [100, 27], [100, 255]]) {
    const f = new Uint8Array(32);
    f.set([0x0f, off >> 8, off & 0xff, size]);
    for (let i = 0; i < Math.min(size, 28); i++) f[4 + i] = 0x41 + (i % 26);
    frames.push(f);
  }
  frame(0x0f, 0, 0, 3, 0x41, 0x42, 0x43, 0x44); // data past the declared size
  frame(0x0f, 0, 0, 0);
  // the 64-byte flavour of a few
  for (const base of [[0x05, 1, 2, 3, 0x7c, 0x00], [0x05, 1, 2, 3, 0x52, 0x21], [0x0f, 0, 0, 2, 0x41, 0x42], [0x06], [0x10], [0x0a], [0x0b], [0x13, 0, 0, 4, 1, 2, 3, 4]]) {
    const f = new Uint8Array(64);
    f.set(base);
    frames.push(f);
  }
  return frames;
}

const VIA_SPECS: GrantSpec[] = [
  { scopes: [] },
  { scopes: ["remap"], scheme: "current" },
  { scopes: ["remap"], scheme: "legacy" },
  { scopes: ["remap"] }, // a remap grant with no scheme: nothing above basic
  { scopes: ["macros"] },
  { scopes: ["reset"] },
  { scopes: ["pair"] },
  { scopes: ["calibrate"] },
  { scopes: ["remap", "macros", "reset"], scheme: "current" },
  { scopes: ["remap", "macros", "reset"], scheme: "legacy" },
  { scopes: ["pair", "remap", "macros", "calibrate", "reset"], scheme: "current" },
];

export async function viaAdvancedText(): Promise<string> {
  const frames = viaAdvancedFrames();
  const lines: string[] = [];
  for (const spec of VIA_SPECS) {
    const gate = await gateFor(spec);
    for (const f of frames) lines.push(`${specText(spec)} ${checkViaFrame(f, gate).ok ? 1 : 0} ${hex(f, true)}`);
  }
  return lines.join("\n").concat("\n");
}

// ---------------------------------------------------------------------------------------------
// Sonix
// ---------------------------------------------------------------------------------------------

export function sonixAdvancedFrames(): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const frame = (...bytes: number[]) => {
    const f = new Uint8Array(64);
    f[0] = 0xaa;
    f.set(bytes, 1);
    frames.push(f);
  };
  for (let c = 0; c < 256; c++) frame(c);
  for (const c of [0x0f, 0x64, 0x65, 0x62, 0x66, 0x67, 0x26, 0xfb, 0xfc, 0x00]) for (let a = 0; a < 256; a += 5) frame(c, a);
  frame(0x0f, 0xff, 0, 1);
  frame(0x0f, 0xff, 1);
  frame(0x64, 0, 0, 0, 0, 0, 1);
  frame(0x65, 0, 1);
  frame(0x0f, 0x05);
  frames.push(SONIX.encodeCalibrationStart(), SONIX.encodeCalibrationEnd(), SONIX.encodeFactoryReset());
  // the ordinary frames, to show an Advanced grant changes nothing about them
  for (const name of SONIX.READ_ORDER) frames.push(...SONIX.encodeRegionRead(name));
  frames.push(SONIX.encodeCommit());
  frames.push(SONIX.bulkFrame(SONIX.CMD.writeSettings, 0, new Uint8Array(16)), SONIX.bulkFrame(SONIX.CMD.writeKeys, 0, new Uint8Array(56)), SONIX.bulkFrame(SONIX.CMD.writeKeys, 56, new Uint8Array(56).fill(1)));
  return frames;
}

const SONIX_SPECS: GrantSpec[] = [
  { scopes: [] },
  { scopes: ["calibrate"] },
  { scopes: ["reset"] },
  { scopes: ["pair"] },
  { scopes: ["remap"] },
  { scopes: ["macros"] },
  { scopes: ["calibrate", "reset"] },
  { scopes: ["pair", "remap", "macros", "calibrate", "reset"] },
];

export async function sonixAdvancedText(): Promise<string> {
  const frames = sonixAdvancedFrames();
  const lines: string[] = [];
  for (const spec of SONIX_SPECS) {
    const gate = await gateFor(spec);
    for (const f of frames) lines.push(`${specText(spec)} ${SONIX.checkFrame(f, gate).ok ? 1 : 0} ${hex(f, true)}`);
  }
  return lines.join("\n").concat("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/src");
  writeFileSync(join(dir, "atk-frames.txt"), await atkFixtureText());
  writeFileSync(join(dir, "via-frames-advanced.txt"), await viaAdvancedText());
  writeFileSync(join(dir, "sonix-frames-advanced.txt"), await sonixAdvancedText());
  console.log(`wrote atk-frames.txt, via-frames-advanced.txt and sonix-frames-advanced.txt in ${dir}`);
}
