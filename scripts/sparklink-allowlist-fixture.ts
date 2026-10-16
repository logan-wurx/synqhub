// Writes src/lib/brands/sparklink/sparklink-frames.txt: frames with the static allowlist's verdict
// (src/lib/brands/sparklink/guard.ts), one per line as `<1|0> <hex, trailing zeros dropped>`. The Rust copy
// (src-tauri/src/brands.rs `sparklink_matches_its_frames`) and scripts/web-guard.test.ts run the same lines through
// their guards. Frames are the 64 bytes of output report 0.
// Run: node scripts/sparklink-allowlist-fixture.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "../src/lib/brands/sparklink/index.ts";

let seed = 0x5c5c;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const frames: Uint8Array[] = [];
const add = (f: Uint8Array) => frames.push(f);
const reseal = (f: Uint8Array): Uint8Array => {
  const g = new Uint8Array(f);
  if (g[1] >= 1 && g[1] <= 60) g[3] = S.checksum(g);
  return g;
};

// Every order type, bare and with arguments.
for (let t = 0; t < 256; t++) {
  add(S.orderFrame(t));
  add(S.frame(S.CMD.order, [t, 0, 0xff, 0xff]));
  add(S.frame(S.CMD.order, [t, 1, 0xff, 0xff]));
  add(S.frame(S.CMD.order, [t, 0xff]));
  add(S.frame(S.CMD.order, [t]));
}
add(S.syncFrame());
add(S.frame(S.CMD.sync, [1, 2, 3, 4]));
add(S.frame(S.CMD.sync, [1, 2, 3, 5, 0xff, 0xff]));
// The key table: every pair of rows 0..7.
for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) add(S.frame(S.CMD.defKey, [0, a, b]));
add(S.frame(S.CMD.defKey, [1, 0, 1]));
add(S.frame(S.CMD.defKey, [0, 0]));
// Key reads: single layouts and groups; every layout number once.
for (let layout = 0; layout < 64; layout++) for (const key of [1, 4, 0x29, 0xe7]) add(S.keyReadFrame(key, [layout]));
for (let n = 0; n < 200; n++) {
  const count = 1 + rnd(S.MAX_GROUPS);
  const layouts = Array.from({ length: count }, () => (rnd(3) === 0 ? rnd(40) : S.READ_LAYOUTS[rnd(S.READ_LAYOUTS.length)]));
  {
    const key = rnd(4) === 0 ? 0 : 1 + rnd(255);
    add(key === 0 ? S.frame(S.CMD.key, [0, ...layouts.flatMap((l) => [0, l, 0, 0])]) : S.keyReadFrame(key, layouts));
  }
}
add(S.keyReadFrame(0x04, S.READ_LAYOUTS));
// Key writes: every layout with in-range and out-of-range values; flags other than 0 / 1.
for (let layout = 0; layout < 40; layout++) {
  for (const value of [0, 1, 10, 1500, 3999, 4000, 4001, 0x10, 0x11, 0x20, 0x21, 0x30, 0x03, 0x100, 0xffff]) add(S.keyWriteFrame(0x04, layout, value));
}
for (let n = 0; n < 400; n++) {
  const layout = n % 3 === 0 ? S.WRITE_LAYOUTS[rnd(S.WRITE_LAYOUTS.length)] : rnd(40);
  const value = layout === S.LAYOUT.mode ? (rnd(3) << 4) | (rnd(5) === 0 ? rnd(16) : 0) | (rnd(9) === 0 ? rnd(4) << 8 : 0) : rnd(4) === 0 ? rnd(65536) : rnd(4300);
  {
    const key = rnd(5) === 0 ? 0 : 1 + rnd(255);
    add(key === 0 ? S.frame(S.CMD.key, [1, 0, layout, value & 0xff, (value >> 8) & 0xff]) : S.keyWriteFrame(key, layout, value));
  }
}
add(S.frame(S.CMD.key, [2, 4, 4, 1, 0]));
add(S.frame(S.CMD.key, [1, 4, 4, 1, 0, 4, 20, 1, 0]));
// Global travel: reads, writes, odd shapes.
add(S.dbReadFrame());
for (let n = 0; n < 120; n++) add(S.dbWriteFrame({ travel: rnd(4400), pressDead: rnd(4400), releaseDead: rnd(4400) }));
add(S.frame(S.CMD.db, [0, 1, ...new Array(13).fill(0)]));
add(S.frame(S.CMD.db, [1, 0, 0, 0xd0, 0x07, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]));
add(S.frame(S.CMD.db, [1, 0, 0, 0xd0, 0x07, 0, 0, 0, 0]));
// Every command class with plausible data of several lengths.
for (let cmd = 0; cmd < 256; cmd++) {
  for (const len of [1, 3, 5, 6, 15, 60]) {
    const data = Array.from({ length: len }, () => rnd(256));
    add(S.frame(cmd, data));
    add(S.frame(cmd, new Array(len).fill(0)));
  }
}
// Mutations: raw flips (the checksum usually breaks), and the same with the checksum fixed so the structural checks decide.
const valid = frames.length;
for (let n = 0; n < 3000; n++) {
  const base = new Uint8Array(frames[rnd(valid)]);
  const flips = 1 + rnd(3);
  for (let k = 0; k < flips; k++) base[rnd(n % 2 ? 12 : 64)] = rnd(4) ? rnd(256) : 0;
  add(n % 3 === 0 ? base : reseal(base));
}

const allowed = (f: Uint8Array) => S.SPARKLINK_GUARD.classify({ type: "output", reportId: 0, data: f }).verdict !== "blocked";
const line = (f: Uint8Array) => {
  let end = f.length;
  while (end > 0 && f[end - 1] === 0) end--;
  return `${allowed(f) ? 1 : 0} ${Array.from(f.subarray(0, end), (x) => x.toString(16).padStart(2, "0")).join("")}`;
};
const lines = frames.map(line);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/brands/sparklink/sparklink-frames.txt");
fs.writeFileSync(out, lines.join("\n") + "\n");

// Sanity: nothing outside the listed classes is allowed, no bootloader class, no factory reset, no calibration order.
const okLines = lines.filter((l) => l[0] === "1");
const bytesOfEarly = (l: string) => Uint8Array.from((l.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16)));
const bad = okLines.filter((l) => ![S.CMD.order, S.CMD.sync, S.CMD.key, S.CMD.db, S.CMD.defKey].includes(bytesOfEarly(l)[2] as never));
if (bad.length) throw new Error(`a frame outside the listed classes is allowed: ${bad[0]}`);
const forbiddenOrders: number[] = [S.ORDER.factoryReset, S.ORDER.clearCalibration, S.ORDER.calibrationStart, S.ORDER.calibrationClose, S.ORDER.eraseMacroStorage, S.ORDER.savingParameter];
const badOrder = okLines.filter((l) => bytesOfEarly(l)[2] === S.CMD.order && forbiddenOrders.includes(bytesOfEarly(l)[4]));
if (badOrder.length) throw new Error(`a forbidden order is allowed: ${badOrder[0]}`);
const bytesOf = (l: string) => Uint8Array.from((l.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16)));
const axis = okLines.filter((l) => {
  const b = bytesOf(l);
  return b[2] === S.CMD.key && b[4] === 1 && b[6] === S.LAYOUT.axis;
});
if (axis.length) throw new Error(`a switch-type write is allowed: ${axis[0]}`);
console.log(`${lines.length} frames (${okLines.length} allowed) -> ${out}`);
