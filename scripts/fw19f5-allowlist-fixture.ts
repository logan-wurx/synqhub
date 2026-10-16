// Writes src/lib/brands/fw19f5/fw19f5-frames.txt: frames with the static allowlist's verdict for each of the
// three guard families (src/lib/brands/fw19f5/guard.ts), one per line as `<m><d><r> <hex, trailing zeros
// dropped>`, where m / d / r are 1 (allowed) or 0 (refused) for the MCHOSE, DrunkDeer and read-only
// (NuPhy, Royal Kludge) guards. src-tauri/src/brands.rs `fw19f5_matches_its_frames` and
// scripts/web-guard.test.ts run the same lines through their copies. Frames are the 64 bytes of output
// report 0.
// Run: node scripts/fw19f5-allowlist-fixture.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as F from "../src/lib/brands/fw19f5/index.ts";

let seed = 0x19f5;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const frames: Uint8Array[] = [];
const add = (f: Uint8Array) => frames.push(f);
const reseal = (f: Uint8Array): Uint8Array => {
  const g = new Uint8Array(f);
  g[3] = F.checksum(g);
  return g;
};
const record = (act: number, press: number, release: number, mode = 0, pp = 0, rp = 0): number[] => [
  0xa0,
  mode,
  (act - 1) & 0xff,
  (((act - 1) >> 8) & 1) | (rp << 1) | (pp << 3),
  (press - 1) & 0xff,
  ((press - 1) >> 8) & 1,
  (release - 1) & 0xff,
  ((release - 1) >> 8) & 1,
];

// Reads: every area, a few offsets and lengths.
for (const cmd of [3, 4, 5, 7, 8, 10, 12, 160, 164, 166]) {
  for (const len of [1, 8, 56]) {
    for (const off of [0, 8, 56, 64, 128, 192, 512, 1024, 2048, 3072, 3080, 4096]) {
      add(F.readFrame(cmd, off, len));
    }
  }
}
// The reads the session really makes.
for (let p = 0; p < 4; p++) {
  add(F.readFrame(F.AREA.funcGet, F.funcOffset(p), 56));
  add(F.readFrame(F.AREA.funcGet, F.funcOffset(p) + 56, 8));
  for (let i = 0; i < 1024; i += 56) add(F.readFrame(F.AREA.triggerGet, F.triggerOffset(p) + i, Math.min(56, 1024 - i)));
}

// Function-config writes: the two chunks of a block, several contents.
for (let n = 0; n < 60; n++) {
  const block = new Uint8Array(64);
  for (let i = 0; i < 64; i++) block[i] = rnd(256);
  block[F.FUNC.effect] = n % 5 === 0 ? 255 : rnd(23);
  block[F.FUNC.brightness] = rnd(101);
  block[F.FUNC.speed] = rnd(5);
  for (let p = 0; p < 4; p++) for (const w of F.funcWrites(p, block)) add(F.writeFrame(F.AREA.funcSet, w.offset, w.data));
}
// Trigger writes: runs of 1..7 records at every record offset of every profile, both flags.
for (let n = 0; n < 220; n++) {
  const count = 1 + rnd(7);
  const slot = rnd(128 - count + 1);
  const data: number[] = [];
  for (let i = 0; i < count; i++) data.push(...record(1 + rnd(400), 2 + rnd(300), 2 + rnd(300), rnd(3) === 0 ? rnd(4) : rnd(2), rnd(3), rnd(3)));
  const p = rnd(4);
  add(F.writeFrame(F.AREA.triggerSet, F.triggerOffset(p) + slot * 8, data, n % 4 === 0));
}

// Blocked areas, built by hand: the key map, colours, macros, mod-tap, toggle writes, the factory reset.
for (const cmd of [9, 11, 13, 165, 167, 238, 1, 2, 6, 14, 255]) {
  for (const data of [[255], [0, 0, 0, 0], new Array(56).fill(0x11)]) {
    for (const off of [0, 64, 512, 1024]) add(F.writeFrame(cmd, off, data));
  }
}

// Mutations: raw flips (the checksum usually breaks), and the same with the checksum fixed so the structural
// checks decide, plus every first byte and every command with a valid checksum.
const valid = frames.length;
for (let n = 0; n < 3200; n++) {
  const base = n % 4 === 0 ? new Uint8Array(64) : new Uint8Array(frames[rnd(valid)]);
  if (n % 4 === 0) {
    base[0] = n < 1024 ? n % 256 : rnd(2) ? 0x55 : rnd(256);
    base[1] = rnd(256);
    base[4] = 1 + rnd(56);
  }
  const flips = 1 + rnd(3);
  for (let k = 0; k < flips; k++) base[rnd(n % 2 ? 16 : 64)] = rnd(4) ? rnd(256) : 0;
  add(n % 3 === 0 ? base : reseal(base));
}
for (let cmd = 0; cmd < 256; cmd++) {
  const f = new Uint8Array(64);
  f[0] = 0x55;
  f[1] = cmd;
  f[4] = 8;
  add(reseal(f));
  const g = new Uint8Array(f);
  g[4] = 56;
  g[5] = 0x40;
  add(reseal(g));
}

const verdict = (f: Uint8Array, family: F.GuardFamily) => F.FW_GUARDS[family].classify({ type: "output", reportId: 0, data: f }).verdict !== "blocked";
const line = (f: Uint8Array) => {
  let end = f.length;
  while (end > 0 && f[end - 1] === 0) end--;
  const v = `${verdict(f, "mchose") ? 1 : 0}${verdict(f, "drunkdeer") ? 1 : 0}${verdict(f, "readonly") ? 1 : 0}`;
  return `${v} ${Array.from(f.subarray(0, end), (x) => x.toString(16).padStart(2, "0")).join("")}`;
};
const lines = frames.map(line);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/brands/fw19f5/fw19f5-frames.txt");
fs.writeFileSync(out, lines.join("\n") + "\n");
// Sanity: nothing outside the allowed areas is marked allowed, the factory reset never is, and NuPhy / RK get the reads only.
const allowedAreas = new Set([3, 4, 5, 160, 6, 161]);
const bad = lines.filter((l) => l.slice(0, 3) !== "000" && !allowedAreas.has(parseInt(l.slice(6, 8), 16)));
if (bad.length) throw new Error(`a frame outside the allowed areas is allowed: ${bad[0]}`);
const reset = lines.filter((l) => l.slice(0, 3) !== "000" && l.slice(6, 8) === "ee");
if (reset.length) throw new Error(`the factory reset is allowed: ${reset[0]}`);
const roReadonly = lines.filter((l) => l[2] === "1" && ![3, 4].includes(parseInt(l.slice(6, 8), 16)));
if (roReadonly.length) throw new Error(`the read-only guard allows more than info and base: ${roReadonly[0]}`);
const count = (i: number) => lines.filter((l) => l[i] === "1").length;
console.log(`${lines.length} frames (mchose ${count(0)}, drunkdeer ${count(1)}, read-only ${count(2)} allowed) -> ${out}`);
