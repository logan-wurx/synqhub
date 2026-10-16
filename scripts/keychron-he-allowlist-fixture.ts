// Writes src/lib/kb/via/keychron/keychron-he-frames.txt: 32-byte raw-HID frames with the static verdict of the Keychron
// Hall-effect tier (src/lib/kb/via/keychron/guard.ts checkKeychronFrame), one per line as `<1|0> <hex, trailing zeros
// dropped>`. src-tauri/src/hid.rs `keychron_he_matches_its_frames` and scripts/web-guard.test.ts run the same lines
// through their copies. (VIA's own guard is a separate fixture, src-tauri/src/via-frames.txt.)
// Run: node scripts/keychron-he-allowlist-fixture.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkKeychronFrame } from "../src/lib/kb/via/keychron/guard.ts";
import * as P from "../src/lib/kb/via/keychron/protocol.ts";

let seed = 0xa9a9;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed >>> 8) % n;
};
const frames: Uint8Array[] = [];
const add = (f: Uint8Array) => frames.push(f);
const raw = (...b: number[]) => {
  const f = new Uint8Array(32);
  f.set(b);
  return f;
};

// The commands SYNQ builds.
add(P.protocolVersionFrame());
add(P.firmwareVersionFrame());
add(P.supportFeatureFrame());
add(P.miscVersionFrame());
add(P.analogVersionFrame());
add(P.profilesInfoFrame());
for (let p = 0; p < 10; p++) for (const [off, n] of [[0, 26], [26, 26], [364, 4], [0, 1], [4000, 26], [4070, 26], [4096, 1], [0, 27], [0, 0]]) add(raw(P.KC.analog, P.AMC.getProfileRaw, p, off & 0xff, off >> 8, n));
for (let p = 0; p < 10; p++) add(raw(P.KC.analog, P.AMC.saveProfile, p));
for (let n = 0; n < 600; n++) {
  const entire = rnd(6) === 0 ? 1 : 0;
  const t: P.TravelSet = { profile: rnd(10), mode: (rnd(5) === 0 ? 3 : rnd(3)) as P.KeyMode, act: rnd(7) === 0 ? rnd(64) : rnd(40), sens: rnd(7) === 0 ? rnd(64) : rnd(40), rls: rnd(7) === 0 ? rnd(64) : rnd(40) };
  const f = raw(P.KC.analog, P.AMC.setTravel, t.profile, t.mode, t.act, t.sens, t.rls, rnd(8) === 0 ? 2 : entire);
  if (!entire || rnd(5) === 0) for (let r = 0; r < 8; r++) if (rnd(3) === 0) { const m = rnd(1 << 24); f[8 + r * 3] = m & 0xff; f[9 + r * 3] = (m >> 8) & 0xff; f[10 + r * 3] = m >> 16; }
  add(f);
}
// Every first byte with every second byte up to 0x50, zero tail (the VIA commands, Keychron's own, everything else).
for (let a = 0; a < 256; a++) for (let b = 0; b < 0x50; b++) if (a >= 0xa0 && a <= 0xac ? true : rnd(12) === 0) add(raw(a, b));
// Named never-commands in several shapes.
for (const [a, b] of [[P.KC.wirelessDfu, 0], [P.KC.wirelessDfu, 1], [P.KC.factoryTest, 0], [P.KC.factoryTest, 5], [P.KC.misc, P.MISC.factoryReset], [P.KC.analog, P.AMC.resetProfile], [P.KC.analog, P.AMC.calibrate], [P.KC.analog, P.AMC.getCalibrateState], [P.KC.analog, P.AMC.setAdvanceMode], [P.KC.analog, P.AMC.setSocd], [P.KC.analog, P.AMC.selectProfile], [P.KC.analog, P.AMC.setProfileName], [0x0b, 0], [0x0a, 0]]) {
  add(raw(a, b));
  add(raw(a, b, 1, 2, 3, 4, 5, 6, 7, 8));
}
// Mutations of what exists: a few random byte flips.
const valid = frames.length;
for (let n = 0; n < 3000; n++) {
  const f = new Uint8Array(frames[rnd(valid)]);
  const flips = 1 + rnd(3);
  for (let k = 0; k < flips; k++) f[rnd(n % 2 ? 10 : 32)] = rnd(4) ? rnd(256) : 0;
  add(f);
}
// Wrong lengths are the transport's business (the VIA guard checks 32 / 64); the fixture is 32 bytes.

const lines = frames.map((f) => {
  let end = f.length;
  while (end > 0 && f[end - 1] === 0) end--;
  return `${checkKeychronFrame(f).ok ? 1 : 0} ${Array.from(f.subarray(0, end), (x) => x.toString(16).padStart(2, "0")).join("")}`;
});
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/kb/via/keychron/keychron-he-frames.txt");
fs.writeFileSync(out, lines.join("\n") + "\n");
// Sanity: nothing outside 0xA0..0xA9 is allowed; no 0xAA / 0xAB / factory reset / profile reset / calibration.
const ok = lines.filter((l) => l[0] === "1");
const first = (l: string) => parseInt(l.slice(2, 4), 16);
const second = (l: string) => parseInt(l.slice(4, 6).padEnd(2, "0"), 16);
if (ok.some((l) => first(l) < 0xa0 || first(l) > 0xa9)) throw new Error("a frame outside 0xA0..0xA9 is allowed");
if (ok.some((l) => first(l) === 0xa9 && [0x1e, 0x40, 0x41, 0x42, 0x15, 0x16, 0x13, 0x11].includes(second(l)))) throw new Error("a forbidden analog command is allowed");
if (ok.some((l) => first(l) === 0xa7 && second(l) !== 1)) throw new Error("a misc command other than the version read is allowed");
console.log(`${lines.length} frames (${ok.length} allowed) -> ${out}`);
