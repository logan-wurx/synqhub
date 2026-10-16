// Writes src/lib/brands/steelseries/steelseries-frames.txt: frames with the static SteelSeries allowlist's verdict
// (STEELSERIES_GUARD in src/lib/brands/steelseries/guard.ts), so a Rust copy in the bridge can be tested against it.
// Run: node scripts/steelseries-allowlist-fixture.ts
//
// Line format: `<1|0> <hex>`, hex = report id byte (always 00) + data bytes, trailing zeros dropped. Lines carry no
// report type: a reader pads the data to naturalShape(data).length and classifies it as naturalShape(data).type
// (protocol.ts). Deterministic: fixed seed, so the file only changes when the guard or the encoders do.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../src/lib/brands/steelseries/protocol.ts";
import { BLOCKED, STEELSERIES_GUARD, patternOf } from "../src/lib/brands/steelseries/guard.ts";
import { MODELS, isDriven } from "../src/lib/brands/steelseries/devices.ts";
import { fixtureLine } from "../src/lib/brands/local-kb.ts";

let seed = 1038;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const frames: Uint8Array[] = [];
const add = (data: Uint8Array) => frames.push(data);

const pickMm = (table: P.AnalogTarget["table"]): number => {
  for (;;) {
    const mm = (1 + rnd(40)) / 10;
    if (!(P.EXCLUDED_MM[table] ?? []).includes(mm)) return mm;
  }
};

// 1. Every encoder, many inputs, for every driven model.
for (const m of MODELS.filter((x) => x.family !== "other" && isDriven(x))) {
  const fam = m.family as P.CommandFamily;
  if (m.firmwareQuery) add(P.encodeFirmwareRead(0).data), add(P.encodeFirmwareRead(1).data);
  if (m.brightness) for (let b = 0; b <= P.BRIGHTNESS_MAX; b++) add(P.encodeBrightness(b).data);
  if (m.brightness) add(P.encodeBrightnessRead().data);
  if (m.profiles) for (let s = 1; s <= P.PROFILE_SLOTS; s++) add(P.encodeProfileSelect(s).data);
  if (m.regionQuery) add(P.encodeRegionRead().data), add(P.encodeLayoutRead().data);
  if (m.statusQuery && fam === "wireless-rx") add(P.encodeStatusRead(fam, "connection").data), add(P.encodeStatusRead(fam, "battery").data);
  if (m.statusQuery && fam === "wireless-usb") add(P.encodeStatusRead(fam, "battery").data);
  const dl = m.directLighting;
  if (dl) {
    if (dl.initFirst) add(P.encodeDirectInit().data);
    if (dl.release) add(P.encodeLightingRelease(fam).data);
    add(P.encodeDirect(fam, dl.leds, () => [255, 255, 255]).data);
    for (let n = 0; n < 12; n++) {
      const leds = dl.leds.filter(() => rnd(4) > 0);
      if (leds.length) add(P.encodeDirect(fam, leds, () => [rnd(256), rnd(256), rnd(256)]).data);
    }
  }
  if (m.table && m.analogKeys) {
    const t: P.AnalogTarget = { family: fam, table: m.table, keys: m.analogKeys };
    for (let n = 0; n < 25; n++) {
      if (m.actuation) add(P.encodeActuation(t, n % 5 ? () => pickMm(t.table) : () => (1 + (n % 40)) / 10 === 3.2 ? 1 : (1 + (n % 40)) / 10).data);
      if (m.rapidTrigger) add(P.encodeRapidTrigger(t, () => !!rnd(2)).data);
      if (m.sensitivity) add(P.encodeSensitivity(t, () => (1 + rnd(40)) / 10).data);
    }
  }
}
const valid = frames.length;

// 2. Every BLOCKED pattern, with zero and random fill.
for (const b of BLOCKED) {
  const p = patternOf(b.bytes);
  for (let n = 0; n < 6; n++) {
    const u = new Uint8Array(64);
    for (let i = 0; i < 24; i++) u[i] = i < p.length && p[i] !== null ? p[i]! : n % 2 ? rnd(256) : i === p.length ? 1 + n : 0;
    add(u);
  }
}

// 3. Mutations of valid frames (opcode, sub-bytes, values, padding) and plain random frames.
for (let n = 0; n < 4000; n++) {
  const base = n % 4 === 0 ? new Uint8Array(64) : new Uint8Array(frames[rnd(valid)]);
  if (n % 4 === 0) {
    base[0] = rnd(256);
    for (let k = 0; k < 1 + rnd(4); k++) base[1 + rnd(6)] = rnd(256);
  } else {
    const flips = 1 + rnd(3);
    for (let k = 0; k < flips; k++) {
      const where = rnd(10) < 7 ? rnd(Math.min(base.length, 16)) : rnd(base.length);
      base[where] = rnd(3) ? rnd(256) : 0;
    }
  }
  add(base);
}

// 4. Every first byte alone (as its natural shape).
for (let op = 0; op < 256; op++) add(Uint8Array.of(op));

const lines = frames.map((f) => {
  const shape = P.naturalShape(f);
  const data = new Uint8Array(shape.length);
  data.set(f.subarray(0, shape.length));
  const v = STEELSERIES_GUARD.classify({ type: shape.type, reportId: 0, data });
  const withId = new Uint8Array(data.length + 1);
  withId.set(data, 1);
  return fixtureLine(v.verdict !== "blocked", withId);
});
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/brands/steelseries/steelseries-frames.txt");
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(`${lines.length} frames (${lines.filter((l) => l.startsWith("1")).length} allowed, ${valid} from encoders) -> ${out}`);
