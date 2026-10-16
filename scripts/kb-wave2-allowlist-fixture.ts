// Writes the frame lists the Rust bridge can test its own allowlist against (like
// scripts/x68he-allowlist-fixture.ts -> src-tauri/src/x68-frames.txt):
//   src/lib/kb/fcc/fcc-frames.txt                 "<1|0> <hex>"      64-byte output report 0 frames,
//                                                 trailing zeros dropped (pad back to 64)
//   src/lib/kb/analogsense/analogsense-frames.txt "<1|0> <family> <report id> <length> <hex>"
//                                                 output reports, trailing zeros dropped (pad to length)
// 1 = the frontend allowlist (checkFrame / checkAnalogFrame) lets it through, 0 = refused.
// Run: node scripts/kb-wave2-allowlist-fixture.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../src/lib/kb/fcc/sonix-protocol.ts";
import { SONIX_WIRED, modelOf } from "../src/lib/kb/fcc/sonix-devices.ts";
import * as A from "../src/lib/kb/analogsense/protocol.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let seed = 2026;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const hex = (b: ArrayLike<number>) => {
  let end = b.length;
  while (end > 1 && b[end - 1] === 0) end--;
  return Array.from({ length: end }, (_, i) => (b[i] ?? 0).toString(16).padStart(2, "0")).join("");
};

// ---------------------------------------------------------------------------------------------
// FCC Sonix
// ---------------------------------------------------------------------------------------------
const fcc: Uint8Array[] = [P.encodeCommit()];
for (const name of P.READ_ORDER) fcc.push(...P.encodeRegionRead(name));
const zeros = (n: number) => new Uint8Array(n);
const hidKey = () => 4 + rnd(0x60);
for (let n = 0; n < 25; n++) {
  const m = modelOf(SONIX_WIRED[rnd(SONIX_WIRED.length)]);
  const idx = () => m.keys[rnd(m.keys.length)].index;
  let keys = zeros(512);
  const bindings: P.Binding[] = [
    { type: "key", mods: rnd(256), code: hidKey() },
    { type: "media", usage: 0xe9 },
    { type: "mouse", button: 4 },
    { type: "macro", index: rnd(100), mode: 1, repeat: 1 + rnd(9) },
    { type: "dks", slot: 1 + rnd(63) },
    { type: "modtap", hold: 0xe0 + rnd(8), tap: hidKey(), ms: 300 },
    { type: "toggle", code: hidKey() },
    { type: "socd", mode: P.SOCD_MODES[rnd(4)], key1: hidKey(), key2: hidKey() },
    { type: "rs", key1: hidKey(), key2: hidKey() },
  ];
  for (const b of bindings) keys = P.withBinding(keys, [idx()], b);
  fcc.push(...P.encodeRegionWrite("keys", keys));
  fcc.push(...P.encodeRegionWrite("rt", P.withRT(zeros(1024), [idx(), idx(), idx()], { actuation: rnd(500), press: rnd(500), release: rnd(500), flags: rnd(8) }, m.rt, m.limits.actuationDefault)));
  fcc.push(...P.encodeRegionWrite("dks", P.withDks(zeros(1024), 1 + rnd(63), { points: [16, 30, 30, 16], keys: [hidKey(), 0, 0, 0], actions: [["tap", "hold", "none", "tap"], [], [], []] })));
  fcc.push(...P.encodeRegionWrite("macros", P.encodeMacros([[{ code: hidKey(), down: true, mouse: false, delay: rnd(500) }, { code: hidKey(), down: false, mouse: false, delay: 0 }]])));
  fcc.push(...P.encodeRegionWrite("led", P.encodeLed(zeros(16), { effect: P.EFFECTS[rnd(P.EFFECTS.length)].id, r: rnd(256), g: rnd(256), b: rnd(256), rainbow: !!rnd(2), brightness: 1 + rnd(5), speed: 1 + rnd(5), direction: rnd(2) as 0 | 1 })));
  fcc.push(...P.encodeRegionWrite("colors", P.withColors(zeros(512), new Map([[rnd(126), [rnd(256), rnd(256), rnd(256)] as const]]))));
  fcc.push(...P.encodeRegionWrite("settings", P.encodeSettings(zeros(32), { sleepMinutes: rnd(31), pollHz: P.POLL_HZ[rnd(3)], stability: !!rnd(2), allKeyWake: !!rnd(2) })));
}
// Every blocked command in its likely forms (FCC's own factory reset / calibration bytes included).
for (const cmd of P.FORBIDDEN_COMMANDS.keys()) {
  for (const args of [[], [0xff], [0x05], [0, 0, 0, 0]]) {
    const f = new Uint8Array(64);
    f[0] = 0xaa;
    f[1] = cmd;
    f.set(args, 2);
    fcc.push(f);
  }
  fcc.push(P.bulkFrame(cmd, 0, new Uint8Array(56)));
}
// Mutations of valid frames, and every command byte with a plausible header.
const valid = fcc.length;
for (let cmd = 0; cmd < 256; cmd++) fcc.push(P.bulkFrame(cmd, 0, new Uint8Array(rnd(2) ? 16 : 56)));
for (let n = 0; n < 3000; n++) {
  const f = new Uint8Array(fcc[rnd(valid)]);
  const flips = 1 + rnd(3);
  for (let k = 0; k < flips; k++) f[rnd(n % 2 ? 12 : 64)] = rnd(4) ? rnd(256) : 0;
  fcc.push(f);
}
const fccLines = fcc.map((f) => `${P.checkFrame(f).ok ? 1 : 0} ${hex(f)}`);
const fccOut = path.join(root, "src/lib/kb/fcc/fcc-frames.txt");
fs.writeFileSync(fccOut, fccLines.join("\n") + "\n");
console.log(`${fccLines.length} Sonix frames (${fccLines.filter((l) => l.startsWith("1")).length} allowed) -> ${fccOut}`);

// ---------------------------------------------------------------------------------------------
// AnalogSense
// ---------------------------------------------------------------------------------------------
type Row = [A.Family, number, number[]];
const as: Row[] = [
  ["drunkdeer", 4, [...A.DRUNKDEER_REQUEST]],
  ["bytech", 9, A.bytechRequest()],
  ["keychron", 0, A.keychronVersionRequest()],
  ["keychron", 0, A.keychronTravelAllRequest()],
];
for (let r = 0; r < 6; r++) for (let c = 0; c < A.KEYCHRON_MAX_COLS; c++) as.push(["keychron", 0, A.keychronTravelRequest(r, c)]);
for (let o = 0; o < A.MADLIONS_MAX_KEYS; o += 4) as.push(["madlions", 0, A.madlionsRequest(o)]);
const okRows = as.length;
const pad = (head: number[], n: number) => [...head, ...new Array(Math.max(0, n - head.length)).fill(0)];
// VIA commands that must never reach Keychron / Lemokey / Madlions (bootloader, EEPROM reset, writes...).
for (const fam of ["keychron", "madlions"] as const) for (let cmd = 0; cmd < 0x16; cmd++) as.push([fam, 0, pad([cmd], 32)]);
for (let sub = 0; sub < 256; sub++) as.push(["keychron", 0, pad([0xa9, sub], 32)]);
as.push(["keychron", 0, pad([0xa9, 0x30, 6, 0], 32)], ["keychron", 0, pad([0xa9, 0x30, 0, 19], 32)], ["madlions", 0, pad([0x02, 0x96, 0x1c, 0, 0, 0, 2, 4], 32)], ["madlions", 0, pad([0x02, 0x96, 0x1c, 0, 0, 0, 76, 4], 32)]);
for (const fam of ["wooting-v1", "wooting-v2", "razer-v2", "razer-v3", "nuphy"] as const) for (const [id, f] of [[0, pad([], 32)], [7, pad([1], 64)], [11, A.keychronVersionRequest()]] as const) as.push([fam, id, [...f]]);
for (let n = 0; n < 1500; n++) {
  const [fam, id, f] = as[rnd(okRows)];
  const g = [...f];
  for (let k = 0, flips = 1 + rnd(2); k < flips; k++) g[rnd(n % 2 ? 8 : g.length)] = rnd(256);
  as.push([fam, rnd(5) ? id : rnd(16), g]);
}
const asLines = as.map(([fam, id, f]) => `${A.checkAnalogFrame(fam, id, f).ok ? 1 : 0} ${fam} ${id} ${f.length} ${hex(f)}`);
const asOut = path.join(root, "src/lib/kb/analogsense/analogsense-frames.txt");
fs.writeFileSync(asOut, asLines.join("\n") + "\n");
console.log(`${asLines.length} AnalogSense frames (${asLines.filter((l) => l.startsWith("1")).length} allowed) -> ${asOut}`);
