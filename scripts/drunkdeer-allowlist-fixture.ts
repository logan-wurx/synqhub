// Writes src/lib/brands/drunkdeer/drunkdeer-frames.txt: frames with the static DrunkDeer allowlist's verdict
// (DRUNKDEER_GUARD in src/lib/brands/drunkdeer/guard.ts), one per line as `<1|0> <hex, trailing zeros
// dropped>` (same format as src-tauri/src/x68-frames.txt), so a future Rust copy in hid.rs can be tested
// against it. Frames are the 63 data bytes of output report id 4.
// Run: node scripts/drunkdeer-allowlist-fixture.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureLine } from "../src/lib/brands/local-kb.ts";
import * as D from "../src/lib/brands/drunkdeer/index.ts";

let seed = 352;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const raw = (bytes: number[]) => {
  const f = new Uint8Array(63);
  f.set(bytes);
  return f;
};
const frames: Uint8Array[] = [];
const add = (f: Uint8Array) => frames.push(f);

// Every encoder, many inputs.
add(D.encodeIdentity());
add(D.encodeProfileCountQuery());
add(D.encodePullLw());
add(D.encodePullRdt());
for (const field of D.KEY_FIELDS) add(D.encodePullKeyPoints(field));
for (const m of D.AUTO_MATCH_VALUES) add(D.encodeAutoMatch(m));
for (const on of [true, false]) {
  add(D.encodeLwReplace(on));
  for (const d of ["legacy", "oldHighPrec", "newHighPrec"] as const) add(D.encodeTracking(on, d));
}
for (let m = 0; m < 4; m++) add(D.encodeClearPairs(m));
for (let n = 0; n < 32; n++) add(D.encodeCommon({ turbo: !!(n & 1), rapidTrigger: !!(n & 2), lastWin: !!(n & 4), rdt: !!(n & 8), rtMatch: !!(n & 16) }));
for (const d of ["legacy", "oldHighPrec", "newHighPrec"] as const)
  for (let n = 0; n < 6; n++)
    for (const field of D.KEY_FIELDS) {
      const [lo, hi] = D.WIRE_RANGE[d][field];
      const mm = Array.from({ length: 126 }, () => D.wireToMm(n === 0 ? lo : n === 1 ? hi : lo + rnd(hi - lo + 1), d));
      for (const f of D.encodeKeyPoints(field, mm, d)) add(f);
    }
for (let n = 0; n < 40; n++) {
  const k = n % 8;
  const slots = Array.from({ length: k }, () => {
    const a = rnd(126);
    return [a, (a + 1 + rnd(125)) % 126];
  });
  add(D.encodeLwPairs(slots.map(([main, trigger]) => ({ main, trigger }))));
  add(D.encodeRdtPairs(slots.slice(0, 7).map(([press, release]) => ({ press, release, activeMm: (10 + rnd(41)) / 200, resetMm: (300 + rnd(201)) / 200 }))));
}
for (const code of D.ALL_PRESET_CODES) add(D.encodeLighting({ code, speed: rnd(10), brightness: rnd(10), colour: rnd(8) }));

// Blocked commands (built by hand: the frame builder refuses them).
for (const f of [
  [0xf9, 0x00, 0x00, 0x00, 0x40, 0x01], [0xf9, 0x01, 56, 0, 0, 0, 0, 0xde, 0xad], [0xf9, 0x02], [0xaa], [0xaa, 0x00, 0x01],
  [0xa7, 0x01, 0x00, 0x2b, 0x01], [0xa8, 0x01, 0x01, 0x01, 0x01, 0x26, 0x01], [0xa0, 0x02, 0x04, 0x01, 0x0e, 0x01, 0x00, 0xfc, 0x00, 0x29],
  [0xab, 0x02], [0xa2, 0x03], [0xfb, 0x05, 0x01, 0x07], [0xc1, 0x03, 0x00, 0x01], [0xc2, 0x20, 0x01, 0x05], [0xae, 0x01, 0, 0, 0x13, 0x06, 0x09, 0xff, 0x80],
  [0xae, 0x01, 0, 0, 0x04, 0x05, 0x0a], [0xae, 0x01, 0, 0, 0x04, 0x0a, 0x09],
]) add(raw(f));

// Mutations of valid frames and plain random frames, including every first byte.
const valid = frames.length;
for (let n = 0; n < 3000; n++) {
  const base = n % 3 === 0 ? new Uint8Array(63) : new Uint8Array(frames[rnd(valid)]);
  if (n % 3 === 0) base[0] = n < 768 ? n % 256 : rnd(256);
  const flips = 1 + rnd(3);
  for (let k = 0; k < flips; k++) base[rnd(n % 2 ? 12 : 63)] = rnd(4) ? rnd(256) : 0;
  add(base);
}

const verdict = (f: Uint8Array) => D.DRUNKDEER_GUARD.classify({ type: "output", reportId: D.REPORT_ID, data: f }).verdict !== "blocked";
const lines = frames.map((f) => fixtureLine(verdict(f), f));
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/brands/drunkdeer/drunkdeer-frames.txt");
fs.writeFileSync(out, lines.join("\n") + "\n");
// Sanity: no line with a never-sent opcode is marked allowed.
const bad = lines.filter((l) => l.startsWith("1 ") && D.NEVER_OPCODES.has(parseInt(l.slice(2, 4), 16)));
if (bad.length) throw new Error(`blocked opcode marked allowed: ${bad[0]}`);
console.log(`${lines.length} frames (${lines.filter((l) => l.startsWith("1")).length} allowed) -> ${out}`);
