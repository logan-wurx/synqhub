// Writes src/lib/brands/rk-beiying/rk-beiying-frames.txt: 64-byte data blocks (the data of feature report 0x0A)
// with the static allowlist's verdict (RK_BEIYING_GUARD in src/lib/brands/rk-beiying/guard.ts), one per line as
// `<1|0> <hex, trailing zeros dropped>` (the format of the other brand fixtures). The Rust copy in
// src-tauri/src/brands.rs `rk_beiying` and scripts/web-guard.test.ts run the same lines.
// Run: node scripts/rk-beiying-allowlist-fixture.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureLine } from "../src/lib/brands/local-kb.ts";
import * as R from "../src/lib/brands/rk-beiying/index.ts";

let seed = 0x258a;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const frames: Uint8Array[] = [];
const add = (f: Uint8Array) => frames.push(f);
const raw = (bytes: number[]) => {
  const f = new Uint8Array(64);
  f.set(bytes);
  return f;
};

// Lighting: every mode, every speed and brightness, random on / off, sleep codes, many colours.
for (let mode = 1; mode <= 21; mode++) {
  for (let n = 0; n < 12; n++) {
    const random = n % 3 === 0;
    add(R.encodeLighting({ mode, speed: 1 + rnd(5), brightness: rnd(6), rgb: [rnd(256), rnd(256), rnd(256)], random, sleep: 1 + rnd(5) }, n % 5 === 0));
  }
}
add(R.encodeLighting({ mode: 1, speed: 1, brightness: 0, rgb: [0, 0, 0], random: false, sleep: 1 }));
add(R.encodeLighting({ mode: 21, speed: 5, brightness: 5, rgb: [255, 255, 255], random: false, sleep: 5 }));

// Key maps: the default-looking map and random ones with every kind of code.
const codes = (): number => {
  switch (rnd(8)) {
    case 0:
      return R.keyCode(0x04 + rnd(0xd0));
    case 1:
      return R.keyCode(0x04 + rnd(0xd0), 1 << rnd(8));
    case 2:
      return R.modifierCode(0xe0 + rnd(8));
    case 3:
      return R.consumerCode(rnd(0x300));
    case 4:
      return R.FN;
    case 5:
      return 0;
    default:
      return R.keyCode(0x04 + rnd(0x60), rnd(4) ? 0 : rnd(256));
  }
};
for (let n = 0; n < 90; n++) {
  const map = new Map<number, number>();
  const count = n === 0 ? 0 : 1 + rnd(139);
  for (let i = 0; i < count; i++) map.set(rnd(139), codes());
  for (const f of R.encodeKeymap(map)) add(f);
}
// A full map: every slot a key.
{
  const map = new Map<number, number>();
  for (let s = 0; s < 139; s++) map.set(s, R.keyCode(0x04 + (s % 0x60)));
  for (const f of R.encodeKeymap(map)) add(f);
}

// Shapes that must be refused, built by hand.
for (const f of [
  [7, 1, 3, 0x7e, 1, 255, 0, 0], // a per-key colour report
  [7, 2, 255, 255],
  [1, 1, 2, 0x29, 0, 0, 3, 5, 255, 255, 255, 0, 5], // mode 0
  [1, 1, 2, 0x29, 22, 0, 3, 5, 255, 255, 255, 0, 5], // mode 22
  [1, 1, 2, 0x29, 3, 0, 0, 5, 255, 255, 255, 0, 5], // speed 0
  [1, 1, 2, 0x29, 3, 0, 6, 5, 255, 255, 255, 0, 5], // speed 6
  [1, 1, 2, 0x29, 3, 0, 3, 6, 255, 255, 255, 0, 5], // brightness 6
  [1, 1, 2, 0x29, 3, 0, 3, 5, 255, 255, 255, 2, 5], // random 2
  [1, 1, 2, 0x29, 3, 0, 3, 5, 255, 255, 255, 1, 5], // random with colours
  [1, 1, 2, 0x29, 3, 0, 3, 5, 255, 255, 255, 0, 0], // sleep 0
  [1, 1, 2, 0x29, 3, 0, 3, 5, 255, 255, 255, 0, 6], // sleep 6
  [1, 1, 2, 0x28, 3, 0, 3, 5, 255, 255, 255, 0, 5], // wrong sub-command
  [1, 2, 2, 0x29, 3, 0, 3, 5, 255, 255, 255, 0, 5], // wrong index
  [9, 0, 1, 0xf8],
  [9, 10, 1, 0xf8],
  [9, 1, 0, 0xf8],
  [9, 1, 1, 0xf7],
  [0x55, 0x03, 0, 0x38, 0x38], // another family's frame
  [0x0f, 0xff], // a SinoWealth-looking reset
]) add(raw(f));

// Mutations of valid frames and plain random frames, including every first byte.
const valid = frames.length;
for (let n = 0; n < 3000; n++) {
  const base = n % 4 === 0 ? new Uint8Array(64) : new Uint8Array(frames[rnd(valid)]);
  if (n % 4 === 0) {
    base[0] = n < 1024 ? n % 256 : rnd(2) ? [1, 9, 7][rnd(3)] : rnd(256);
    base[1] = rnd(2) ? 1 + rnd(9) : rnd(256);
  }
  const flips = 1 + rnd(3);
  for (let k = 0; k < flips; k++) base[rnd(n % 2 ? 16 : 64)] = rnd(4) ? rnd(256) : rnd(2);
  add(base);
}

const lines = frames.map((f) => fixtureLine(R.RK_BEIYING_GUARD.classify({ type: "feature", reportId: R.REPORT_ID, data: f }).verdict !== "blocked", f));
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/brands/rk-beiying/rk-beiying-frames.txt");
fs.writeFileSync(out, lines.join("\n") + "\n");
// Sanity: nothing that is not a lighting or key-map shape is allowed.
const bad = lines.filter((l) => l.startsWith("1 ") && !/^1 (0101|0901|0902|0903|0904|0905|0906|0907|0908|0909)/.test(l));
if (bad.length) throw new Error(`an unknown shape is marked allowed: ${bad[0]}`);
console.log(`${lines.length} frames (${lines.filter((l) => l.startsWith("1")).length} allowed) -> ${out}`);
