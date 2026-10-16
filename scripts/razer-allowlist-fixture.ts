// Writes src/lib/brands/razer/razer-frames.txt: Razer 90-byte control frames with the TypeScript
// allowlist's verdict (classifyRazerFrame in src/lib/brands/razer/guard.ts), so a Rust mirror in
// src-tauri/src/hid.rs can be tested against it (same idea and format as x68-frames.txt:
// `<1|0> <hex, trailing zeros dropped>`; pad back to 90 bytes before checking).
// Run: node scripts/razer-allowlist-fixture.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureLine } from "../src/lib/brands/local-kb.ts";
import * as P from "../src/lib/brands/razer/protocol.ts";
import { RAZER_BLOCKED, classifyRazerFrame } from "../src/lib/brands/razer/guard.ts";
import { RAZER_VALID_KEY_IDS } from "../src/lib/brands/razer/devices.ts";

let seed = 9090;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const KEYS = [...RAZER_VALID_KEY_IDS];
const pick = <T>(a: readonly T[]) => a[rnd(a.length)];
const frames: Uint8Array[] = [];
const add = (r: P.Request) => frames.push(P.frame(r, rnd(10) ? rnd(31) : 0xff));

// Every encoder, many inputs.
for (const r of [P.encFirmware(), P.encSerial(), P.encProfileCount(), P.encProfileList(), P.encActiveProfileGet(), P.encBattery(), P.encCharging(), P.encLiftGet(), P.encProximityOn()]) add(r);
for (let p = 0; p <= P.MAX_PROFILE_ID; p++) {
  for (const r of [P.encPollingGet(p), P.encBottomDeadZoneGet(p), P.encSnapTapGet(p), P.encSingleSnapTapGet(p), P.encDualPriorityGet(p), P.encBrightnessGet(p), P.encDpiStagesGet(p)]) add(r);
  for (const hz of [125, 250, 500, 1000, 2000, 4000, 8000]) add(P.encPollingSet(p, hz));
  if (p >= 1) add(P.encActiveProfileSet(p));
}
for (let lvl = 1; lvl <= 10; lvl++) add(P.encLiftSet(lvl));
for (let n = 0; n < 120; n++) {
  const p = rnd(P.MAX_PROFILE_ID + 1);
  const keys = [...new Set(Array.from({ length: 1 + rnd(15) }, () => pick(KEYS)))];
  const act = P.mmToRaw((1 + rnd(40)) / 10);
  add(P.encActuationGet(p, keys));
  add(P.encActuationSet(p, keys.map((keyId) => ({ keyId, actuationRaw: act, releaseRaw: P.releaseFor(act) }))));
  add(P.encActuationSet(p, [{ keyId: 255, actuationRaw: act, releaseRaw: P.releaseFor(act) }]));
  add(P.encRapidTriggerGet(p, keys.slice(0, 13)));
  add(P.encRapidTriggerSet(p, keys.slice(0, 13).map((keyId) => ({ keyId, enabled: !!rnd(2), pressRaw: P.mmToRaw((1 + rnd(20)) / 10), releaseRaw: P.mmToRaw((1 + rnd(20)) / 10) }))));
  add(P.encBottomDeadZoneSet(p, 1 + rnd(20)));
  const pairs = Array.from({ length: rnd(5) }, () => {
    const a = pick(KEYS);
    let b = pick(KEYS);
    while (b === a) b = pick(KEYS);
    return { a, b, mode: rnd(5) };
  });
  add(P.encSnapTapSet(p, { enabled: !!rnd(2), pairs }));
  add(P.encSingleSnapTapSet(p, { enabled: !!rnd(2), keys: Array.from({ length: rnd(5) }, () => ({ keyId: pick(KEYS), keyCode: rnd(256) })) }));
  add(P.encDualPrioritySet(p, { enabled: !!rnd(2), keys: [...new Set(Array.from({ length: rnd(5) }, () => pick(KEYS)))].slice(0, 4) }));
  add(P.encBrightnessSet(p, rnd(101)));
  const ns = 1 + rnd(5);
  add(P.encDpiStagesSet(p, { active: 1 + rnd(ns), stages: Array.from({ length: ns }, (_, i) => ({ id: i + 1, x: 100 + rnd(32900), y: 100 + rnd(32900) })) }));
}

// Every blocked command by name (class 0xFE: every id).
const raw = (cls: number, id: number, args: number[]) => {
  const f = new Uint8Array(90);
  f[1] = rnd(31);
  f[5] = Math.max(args.length, 2);
  f[6] = cls;
  f[7] = id;
  f.set(args, 8);
  f[88] = P.crc(f);
  return f;
};
for (const b of RAZER_BLOCKED) for (const id of b.id === "*" ? Array.from({ length: 256 }, (_, i) => i) : [b.id]) frames.push(raw(b.cls, id, [rnd(4), 0]));
for (const mode of [0, 1, 2, 3, 4, 8, 9]) frames.push(raw(0x00, 0x04, [mode, 0]));

// Mutations of valid frames and random frames over every class/id.
const valid = frames.length;
for (let n = 0; n < 4000; n++) {
  let f: Uint8Array;
  if (n % 3 === 0) {
    f = raw(rnd(256), rnd(256), Array.from({ length: rnd(12) }, () => (rnd(3) ? 0 : rnd(256))));
  } else {
    f = new Uint8Array(frames[rnd(valid)]);
    for (let k = 1 + rnd(3); k > 0; k--) f[rnd(n % 2 ? 16 : 90)] = rnd(4) ? rnd(256) : 0;
    if (rnd(3)) f[88] = P.crc(f);
  }
  frames.push(f);
}

const lines = frames.map((f) => fixtureLine(classifyRazerFrame(f).verdict !== "blocked", f));
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/brands/razer/razer-frames.txt");
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(`${lines.length} frames (${lines.filter((l) => l.startsWith("1")).length} allowed) -> ${out}`);
