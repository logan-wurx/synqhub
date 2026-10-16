// Writes src/lib/brands/monsgeek/monsgeek-frames.txt: frames with the union allowlist's verdict
// (classifyFrame(f, "any") in src/lib/brands/monsgeek/guard.ts), one per line as `<1|0> <hex>` with
// trailing zeros dropped (pad back to 64 bytes), so a future Rust mirror in src-tauri can be tested
// against the TypeScript table. Deterministic (fixed seed).
// Run: node scripts/monsgeek-allowlist-fixture.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureLine } from "../src/lib/brands/local-kb.ts";
import * as P from "../src/lib/brands/monsgeek/protocol.ts";
import { classifyFrame } from "../src/lib/brands/monsgeek/guard.ts";

let seed = 5088;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const frames: Uint8Array[] = [];
const add = (f: Uint8Array) => frames.push(f);
const fix = (f: Uint8Array) => {
  f[P.checksumAt(f[0])] = P.checksum(f, P.checksumAt(f[0]));
  return f;
};

// Every encoder, many inputs.
for (const f of [P.encodeIdentify(), P.encodeRfVersion(), P.encodeFeatureList(), P.encodeProfileRead(), P.encodePollingRead(), P.encodeDebounceRead(), P.encodeLightingRead(), P.encodeOptionsRead()]) add(f);
for (const f of [P.ycEncodeRevision(), P.ycEncodeProfileRead(), P.ycEncodeOptionsRead(), P.ycEncodeDebounceRead()]) add(f);
for (let p = 0; p < 4; p++) add(P.encodeProfileWrite(p));
for (const hz of P.POLL_CODE_HZ) add(P.encodePollingWrite(hz));
for (let ms = 0; ms <= 10; ms++) add(P.encodeDebounceWrite(ms));
for (let n = 0; n < 12; n++) add(P.encodeOptionsWrite({ fnIndex: rnd(4), antiMistouch: !!rnd(2), rtStabilityMs: 25 * rnd(6), wasdSwap: !!rnd(2) }));
for (const mode of Object.keys(P.LIGHT_MODES).map(Number))
  for (let v = 0; v < P.variantsOf(mode); v++) add(P.encodeLightingWrite({ mode, speedWire: rnd(5), brightness: rnd(5), option: (v << 4) | (mode === 13 ? 0 : P.COLOUR_NIBBLES[rnd(3)]), r: rnd(256), g: rnd(256), b: rnd(256) }));
for (let p = 0; p < 4; p++) for (let l = 0; l < 4; l++) P.encodeKeymapReadAll(p, l).forEach(add);
for (const t of P.READ_TABLES) P.encodeTableReadAll(t).forEach(add);
for (let p = 0; p < 2; p++) for (let page = 0; page < 8; page++) add(P.ycEncodeKeymapRead(p, page, rnd(4)));
for (const t of P.YC_READ_TABLES) for (let page = 0; page < P.readPages(t, "yc500"); page++) add(P.ycEncodeTableRead(t, page));
const entry = (): P.KeyEntry => {
  switch (rnd(6)) {
    case 0: return P.ENTRY.none();
    case 1: return P.ENTRY.consumer(0xe9);
    case 2: return P.ENTRY.mouse(rnd(5));
    case 3: return P.ENTRY.fn();
    default: return P.ENTRY.key(4 + rnd(100), rnd(4) ? 0 : 2);
  }
};
for (let n = 0; n < 60; n++) add(P.encodeKeyWrite(rnd(4), rnd(128), rnd(4), entry()));
for (let n = 0; n < 2; n++) {
  const t = new Uint8Array(512);
  for (let p = 0; p < 128; p++) t.set(entry(), p * 4);
  P.encodeSublayerWrite(rnd(4), rnd(4), t).forEach(add);
}
for (let n = 0; n < 60; n++) {
  const table = P.WRITE_TABLES[rnd(P.WRITE_TABLES.length)];
  const pos = rnd(128);
  const value =
    table === 7 ? P.KINDS[rnd(6)] | (rnd(2) ? 0x80 : 0) : table === 8 ? [rnd(256), rnd(256), rnd(256), rnd(256)] : table === 9 ? (pos + 1) % 128 : P.TABLE_LIMITS[table].min + rnd(P.TABLE_LIMITS[table].max - P.TABLE_LIMITS[table].min + 1);
  P.encodeTableBatch([{ table, pos, value }]).forEach(add);
}

// Every blocked opcode, bare and with the 55 AA 55 AA trailer, plus every other opcode bare.
for (const b of P.BLOCKED) {
  add(fix(Uint8Array.from({ length: 64 }, (_, i) => (i === 0 ? b.opcode : 0))));
  const t = new Uint8Array(64);
  t.set([b.opcode, 0x55, 0xaa, 0x55, 0xaa]);
  add(fix(t));
}
for (let op = 0; op < 256; op++) {
  const f = new Uint8Array(64);
  f[0] = op;
  add(fix(f));
}

// Near misses: valid frames with one byte changed (checksum fixed or not), and random frames.
const valid = frames.length;
for (let n = 0; n < 2500; n++) {
  const f = frames[rnd(valid)].slice();
  f[rnd(n % 2 ? 12 : 64)] = rnd(4) ? rnd(256) : 0;
  add(n % 5 === 0 ? f : fix(f));
}
for (let n = 0; n < 500; n++) {
  const f = new Uint8Array(64);
  f[0] = rnd(256);
  for (let i = 1; i < 12; i++) f[i] = rnd(3) ? 0 : rnd(256);
  add(fix(f));
}

const lines = frames.map((f) => fixtureLine(classifyFrame(f, "any").verdict !== "blocked", f));
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/brands/monsgeek/monsgeek-frames.txt");
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(`${lines.length} frames (${lines.filter((l) => l.startsWith("1")).length} allowed) -> ${out}`);
