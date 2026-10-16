// SteelSeries Apex codec + guard tests. Run: node --test scripts/steelseries-codec.test.ts
//
// Golden frames carry their source in a comment. "S" paths are relative to the Wave 4 scratch folder
// wave4-src/steelseries/ (see docs/devices/desktop-only/steelseries.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../src/lib/brands/steelseries/protocol.ts";
import { BLOCKED, STEELSERIES_GUARD, guardFor, matchesPattern, patternOf } from "../src/lib/brands/steelseries/guard.ts";
import { ANALOG_KEYS_MINI, ANALOG_KEYS_TKL, BOOTLOADER_PIDS, FEATURE_LENGTH, LED_KEYS_LEGACY, LED_KEYS_TKL, MODELS, findModel, isDriven, type SsModel } from "../src/lib/brands/steelseries/devices.ts";
import { GG_TABLES } from "../src/lib/brands/steelseries/tables.ts";
import { claimsSteelSeries } from "../src/lib/brands/steelseries/backend.ts";
import type { OutgoingReport } from "../src/lib/brands/local-kb.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const unhex = (s: string): number[] => (s.replace(/\s+/g, "").match(/../g) ?? []).map((x) => parseInt(x, 16));
const pad = (bytes: number[], n: number): Uint8Array => {
  const u = new Uint8Array(n);
  u.set(bytes);
  return u;
};
const trim = (u: Uint8Array): string => {
  let e = u.length;
  while (e > 0 && u[e - 1] === 0) e--;
  return P.hex(u.subarray(0, e), "");
};

let seed = 4242;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};

const m1614 = findModel(0x1614)!;
const m1610 = findModel(0x1610)!;
const m1642 = findModel(0x1642)!;
const m1644 = findModel(0x1644)!;
const m1646 = findModel(0x1646)!;
const tgt = (m: SsModel): P.AnalogTarget => ({ family: m.family as P.CommandFamily, table: m.table!, keys: m.analogKeys! });

// ---------------------------------------------------------------------------------------------
// Device table
// ---------------------------------------------------------------------------------------------

test("device table: PIDs unique, bootloaders never driven, wire facts", () => {
  const pids = MODELS.map((m) => m.productId);
  assert.equal(new Set(pids).size, pids.length);
  for (const b of BOOTLOADER_PIDS) assert.ok(!pids.includes(b), `bootloader ${b.toString(16)} is also a model`);
  for (const m of MODELS) {
    assert.equal(m.vendorId, 0x1038);
    assert.ok(m.tier === "readOnly" || m.tier === "detectOnly");
    assert.ok(m.sources.length > 0, `${m.model} has no sources`);
    if (m.family !== "other") assert.equal(m.channel.length, FEATURE_LENGTH[m.family]);
  }
  // 68 analog keys, ascending, as GG's hall_thresholds lists them. [S keep/gg/.../3.15.0/20190607095158_squash.sql:1369, gg-20.0.0/...:239]
  assert.equal(ANALOG_KEYS_TKL.length, 68);
  assert.equal(ANALOG_KEYS_MINI.length, 68);
  assert.ok(!ANALOG_KEYS_TKL.includes(0x29) && ANALOG_KEYS_MINI.includes(0x29) && !ANALOG_KEYS_MINI.includes(0x35));
  assert.equal(LED_KEYS_LEGACY.length, 112); // [openrgb keys[]]
  assert.equal(LED_KEYS_TKL.length, 86); // [rikearon "86 LEDs"]
  // Every GG table: 40 entries, 0.1 .. 4.0 mm, l <= h, pairs unique.
  for (const t of Object.values(GG_TABLES)) {
    assert.equal(t.entries.length, 40, t.id);
    t.entries.forEach((e, i) => {
      assert.equal(Math.round(e[0] * 10), i + 1, t.id);
      assert.ok(e[1] <= e[2], `${t.id} ${e[0]}`);
    });
    assert.equal(new Set(t.entries.map((e) => `${e[1]},${e[2]}`)).size, 40, t.id);
  }
});

test("claims(): VID/PID + vendor collection only, never a bootloader, never an undriven board", () => {
  const col = [{ usagePage: 0xffc0, usage: 1 }];
  assert.ok(claimsSteelSeries({ vendorId: 0x1038, productId: 0x1614, collections: col }));
  assert.ok(claimsSteelSeries({ vendorId: 0x1038, productId: 0x1642, collections: col }));
  assert.ok(!claimsSteelSeries({ vendorId: 0x1038, productId: 0x1614, collections: [{ usagePage: 0x01, usage: 6 }] }));
  assert.ok(!claimsSteelSeries({ vendorId: 0x1038, productId: 0x1615, collections: col }), "bootloader");
  assert.ok(!claimsSteelSeries({ vendorId: 0x1038, productId: 0x161a, collections: col }), "Apex 3 is detect-only");
  assert.ok(!claimsSteelSeries({ vendorId: 0x1532, productId: 0x1614, collections: col }));
  for (const b of BOOTLOADER_PIDS) assert.ok(!claimsSteelSeries({ vendorId: 0x1038, productId: b, collections: col }));
});

// ---------------------------------------------------------------------------------------------
// Golden frames
// ---------------------------------------------------------------------------------------------

// GG 121 on an Apex Pro TKL 2019 (1038:1614, fw 4.16.8), live actuation after eight per-key edits.
// Source: [zunuza] S oss/zunuza/apex-control/docs/reference/tx-profile2-actuation-multikey.txt line 7 (MIT).
const GG_1614_FRAME =
  "314704857b05322e06322e07322e083b3709322e0a322e0b322e0c322e0d322e0e322e0f322e10322e11322e12322e13322e140b0a15322e16d9d417322e18322e19d9d41a17141b322e1c322e1d322e1e322e1f322e20322e21322e22322e23322e24322e25322e26322e27322e28322e2a322e2b322e2c06062d322e2e322e2f322e30322e31322e32322e33322e34322e35322e36322e37322e38322e39322e64322e87322e88322e89322e8a322e8b322ee0322ee12623e2322ee3403be4322ee5322ee6322ee7322ef0322e";

test("golden: legacy actuation = GG's captured 0x31 0x47 frame, decoded with GG's own map", () => {
  const data = pad(unhex(GG_1614_FRAME), 642);
  const mm = P.decodeActuation(tgt(m1614), data);
  // Values per GG's map [gg-ui S keep/asar/render/463.js @397836]: 1.8 = l46/h50 = wire 32 2e.
  const expect: Record<number, number> = { 0x04: 3.0, 0x08: 2.0, 0x14: 0.5, 0x16: 4.0, 0x19: 4.0, 0x1a: 1.0, 0x2c: 0.1, 0xe1: 1.5, 0xe3: 2.1 };
  for (const k of ANALOG_KEYS_TKL) assert.equal(mm.get(k), expect[k] ?? 1.8, `key 0x${k.toString(16)}`);
  const again = P.encodeActuation(tgt(m1614), (k) => mm.get(k)!);
  assert.equal(again.type, "feature");
  assert.equal(trim(again.data), GG_1614_FRAME);
  assert.deepEqual(STEELSERIES_GUARD.classify(again), { verdict: "write", name: "actuation" });
});

test("golden: every encoder (bytes from the cited source)", () => {
  const golden: [OutgoingReport, string, "output" | "feature", number][] = [
    // [zunuza] "O 90 00" / reply "34 2e 31 36 2e 38"; [rikearon] Queries "90 00"
    [P.encodeFirmwareRead(0), "90", "output", 64], // 90 00 (trailing zero trimmed)
    [P.encodeFirmwareRead(1), "9001", "output", 64],
    // [openrgb] APEX_PACKET_ID_GET/SET_BRIGHTNESS (0xA3 / 0x23), 0..10
    [P.encodeBrightnessRead(), "a3", "output", 64],
    [P.encodeBrightness(7), "2307", "output", 64],
    // [openrgb] APEX_GEN1_PACKET_ID_ONBOARD 0x3B; [opengg] 62 receiver / 22 cable
    [P.encodeLightingRelease("legacy"), "3b", "output", 64],
    [P.encodeLightingRelease("wireless-rx"), "62", "output", 64],
    [P.encodeLightingRelease("wireless-usb"), "22", "output", 64],
    // [zunuza] "89 <slot> selects the active profile"
    [P.encodeProfileSelect(3), "8903", "output", 64],
    // [rikearon] Queries F5 / F2; Lighting 4B
    [P.encodeRegionRead(), "f5", "output", 64],
    [P.encodeLayoutRead(), "f2", "output", 64],
    [P.encodeDirectInit(), "4b", "output", 64],
    // [opengg] BC / D2 receiver, 92 cable
    [P.encodeStatusRead("wireless-rx", "connection"), "bc", "output", 64],
    [P.encodeStatusRead("wireless-rx", "battery"), "d2", "output", 64],
    [P.encodeStatusRead("wireless-usb", "battery"), "92", "output", 64],
  ];
  for (const [r, hexs, type, len] of golden) {
    assert.equal(trim(r.data), hexs);
    assert.equal(r.type, type);
    assert.equal(r.data.length, len);
    assert.equal(r.reportId, 0);
  }
  // [rikearon] "38 61 44 00 [hid,h,l]x68"; GG 1642 map 1.5 mm = l27/h30 [gg-ui @411249]
  const a1642 = P.encodeActuation(tgt(m1642), () => 1.5);
  assert.equal(P.hex(a1642.data.subarray(0, 10), ""), "38614400041e1b051e1b");
  assert.equal(a1642.data.length, 644);
  // [rikearon] "38 62 44 [hid,mode]x68", 2 = rapid trigger; "38 65 44 [hid,sens]x68"
  assert.equal(P.hex(P.encodeRapidTrigger(tgt(m1642), (k) => k === 4).data.subarray(0, 7), ""), "38624404020500");
  assert.equal(P.hex(P.encodeSensitivity(tgt(m1642), () => 0.2).data.subarray(0, 7), ""), "38654404020502");
  // [opengg] "00 6F layer count [usage,A,B]", 1.5 mm = 1C 1F; "76 44 [usage,0|1]"; "77 44 [usage,sens]"
  assert.equal(P.hex(P.encodeActuation(tgt(m1644), () => 1.5).data.subarray(0, 9), ""), "6f0044041c1f051c1f");
  assert.equal(P.hex(P.encodeRapidTrigger(tgt(m1644), () => true).data.subarray(0, 6), ""), "764404010501");
  assert.equal(P.hex(P.encodeSensitivity(tgt(m1644), () => 0.5).data.subarray(0, 6), ""), "774404050505");
  // [opengg] cable: receiver opcode & ~0x40 -> 2F / 37
  assert.equal(P.hex(P.encodeActuation(tgt(m1646), () => 1.5).data.subarray(0, 6), ""), "2f0044041c1f");
  assert.equal(P.hex(P.encodeSensitivity(tgt(m1646), () => 0.5).data.subarray(0, 4), ""), "37440405");
  assert.equal(P.encodeActuation(tgt(m1646), () => 1.5).data.length, 641);
  // [openrgb] SetLEDsDirect: <id> <count> [key,R,G,B]...
  assert.equal(P.hex(P.encodeDirect("legacy", [4, 5], () => [1, 2, 3]).data.subarray(0, 10), ""), "3a02040102030501020300".slice(0, 20));
  assert.equal(P.hex(P.encodeDirect("single", [4], () => [255, 0, 0]).data.subarray(0, 6), ""), "400104ff0000");
  assert.equal(P.hex(P.encodeDirect("wireless-rx", [4], () => [0, 255, 0]).data.subarray(0, 6), ""), "61010400ff00");
  assert.equal(P.hex(P.encodeDirect("wireless-usb", [4], () => [0, 0, 255]).data.subarray(0, 6), ""), "2101040000ff");
});

// ---------------------------------------------------------------------------------------------
// Decoders and round trips
// ---------------------------------------------------------------------------------------------

test("decoders: replies", () => {
  // [zunuza] reply begins "34 2e 31 36 2e 38" (no echo) on 1614; [rikearon] "90 00 <ascii>" on 1642
  assert.equal(P.decodeFirmware(pad(unhex("342e31362e38"), 64)), "4.16.8");
  assert.equal(P.decodeFirmware(pad(unhex("9000312e31392e37"), 64)), "1.19.7");
  assert.equal(P.decodeFirmware(pad(unhex("90ff"), 64)), null);
  assert.equal(P.decodeFirmware(pad(unhex("a300"), 64)), null);
  // [openrgb] ReadBrightness: A3 00 <level>, FF status = unsupported
  assert.equal(P.decodeBrightness(pad(unhex("a30007"), 64)), 7);
  assert.equal(P.decodeBrightness(pad(unhex("a3ff"), 64)), null);
  assert.equal(P.decodeBrightness(pad(unhex("a3000b"), 64)), null);
  assert.equal(P.decodeQueryByte(P.OP.region, pad(unhex("f50001"), 64)), 1);
  assert.equal(P.decodeQueryByte(P.OP.region, pad(unhex("f50101"), 64)), null);
  assert.equal(P.decodeQueryByte(P.OP.layout, pad(unhex("f20002"), 64)), 2);
  assert.equal(P.decodeAck(0x6f, pad(unhex("6f00"), 64)), 0);
  assert.equal(P.decodeAck(0x6f, pad(unhex("7700"), 64)), null);
  // [opengg] "00 BC 01 says the keyboard is connected" (with the report id) -> data [BC, 01]
  assert.equal(P.decodeStatusByte(P.OP.rxConnection, pad(unhex("bc01"), 64)), 1);
  assert.equal(P.decodeStatusByte(P.OP.rxBattery, pad(unhex("bc01"), 64)), null);
  assert.deepEqual(P.batteryFromState(0x85), { percent: 20, charging: true });
  assert.equal(P.batteryFromState(0), null);
});

test("round trip: every analog frame decodes to what was encoded", () => {
  for (const m of [m1614, m1610, m1642, m1644, m1646]) {
    const t = tgt(m);
    for (let n = 0; n < 40; n++) {
      const vals = new Map(t.keys.map((k) => [k, P.tablePairs(t.table).length ? pickMm(t.table) : 1] as [number, number]));
      const a = P.encodeActuation(t, (k) => vals.get(k)!);
      const back = P.decodeActuation(t, a.data);
      for (const k of t.keys) assert.equal(back.get(k), vals.get(k));
      if (m.sensitivity) {
        const s = new Map(t.keys.map((k) => [k, (1 + rnd(40)) / 10] as [number, number]));
        const back2 = P.decodeSensitivity(t, P.encodeSensitivity(t, (k) => s.get(k)!).data);
        for (const k of t.keys) assert.equal(back2.get(k), s.get(k));
      }
      if (m.rapidTrigger) {
        const on = new Map(t.keys.map((k) => [k, !!rnd(2)] as [number, boolean]));
        const back3 = P.decodeRapidTrigger(t, P.encodeRapidTrigger(t, (k) => on.get(k)!).data);
        for (const k of t.keys) assert.equal(back3.get(k), on.get(k));
      }
    }
  }
  const d = P.decodeDirect("legacy", P.encodeDirect("legacy", [4, 0x2c, 0xf0], (k) => [k, 1, 2]).data);
  assert.deepEqual(d, [[4, 4, 1, 2], [0x2c, 0x2c, 1, 2], [0xf0, 0xf0, 1, 2]]);
});

function pickMm(table: keyof typeof GG_TABLES): number {
  for (;;) {
    const mm = (1 + rnd(40)) / 10;
    if (!(P.EXCLUDED_MM[table] ?? []).includes(mm)) return mm;
  }
}

test("mm conversions: on GG's table only, 3.2 mm refused on the 2019 line", () => {
  assert.deepEqual(P.mmToPair("apexPro2019", 1.8), { l: 46, h: 50 });
  assert.deepEqual(P.mmToPair("apexProTkl2024", 4.0), { l: 213, h: 219 });
  assert.deepEqual(P.mmToPair("apexProTklWireless2024", 1.5), { l: 28, h: 31 });
  assert.throws(() => P.mmToPair("apexPro2019", 3.2), /refused/);
  assert.throws(() => P.mmToPair("apexPro2019", 0));
  assert.throws(() => P.mmToPair("apexPro2019", 4.1));
  assert.throws(() => P.mmToPair("apexPro2019", 1.25), /grid/);
  assert.equal(P.pairToMm("apexPro2019", { l: 46, h: 50 }), 1.8);
  assert.equal(P.pairToMm("apexPro2019", { l: 46, h: 51 }), null);
  assert.equal(P.sensitivityToRaw(0.2), 2);
  assert.throws(() => P.sensitivityToRaw(0));
  assert.throws(() => P.sensitivityToRaw(4.1));
  assert.equal(P.rawToSensitivity(40), 4);
  assert.equal(P.rawToSensitivity(41), null);
});

test("encoders refuse bad input instead of building a frame", () => {
  assert.throws(() => P.encodeBrightness(11));
  assert.throws(() => P.encodeBrightness(-1));
  assert.throws(() => P.encodeProfileSelect(0));
  assert.throws(() => P.encodeProfileSelect(6));
  assert.throws(() => P.encodeActuation({ ...tgt(m1642), keys: ANALOG_KEYS_TKL.slice(1) }, () => 1));
  assert.throws(() => P.encodeActuation({ ...tgt(m1642), keys: [...ANALOG_KEYS_TKL].reverse() }, () => 1));
  assert.throws(() => P.encodeRapidTrigger(tgt(m1614), () => true), /not available/);
  assert.throws(() => P.encodeRapidTrigger(tgt(m1646), () => true), /not available/);
  assert.throws(() => P.encodeSensitivity(tgt(m1614), () => 0.2), /not available/);
  assert.throws(() => P.encodeDirect("legacy", [], () => [0, 0, 0]));
  assert.throws(() => P.encodeDirect("legacy", [5, 4], () => [0, 0, 0]));
  assert.throws(() => P.encodeDirect("legacy", [4], () => [256, 0, 0]));
  assert.throws(() => P.encodeLightingRelease("single"));
});

// ---------------------------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------------------------

const driven = MODELS.filter((m) => m.family !== "other" && isDriven(m));
const guards = [STEELSERIES_GUARD, ...driven.map((m) => guardFor(m))];

/** A concrete frame for a BLOCKED pattern: wildcards and the tail filled by `fill`. */
function instantiate(bytes: string, len: number, fill: () => number): Uint8Array {
  const p = patternOf(bytes);
  const u = new Uint8Array(len);
  for (let i = 0; i < len; i++) u[i] = i < p.length ? (p[i] ?? fill()) : i < 40 ? fill() : 0;
  return u;
}

test("every BLOCKED command is refused, as output and as feature, by every guard", () => {
  assert.ok(BLOCKED.length >= 20);
  for (const b of BLOCKED) {
    assert.ok(b.source.length > 10 && b.what.length > 5);
    for (let n = 0; n < 12; n++) {
      for (const [type, len] of [["output", 64], ["feature", 642], ["feature", 644], ["feature", 641]] as const) {
        const data = instantiate(b.bytes, len, () => (n % 3 === 0 ? 0 : rnd(256)));
        for (const g of guards) {
          const v = g.classify({ type, reportId: 0, data });
          assert.equal(v.verdict, "blocked", `${b.bytes} ${type} ${len}`);
          if (v.verdict === "blocked") assert.equal(v.why, b.why, `${b.bytes}: matched by its own rule`);
        }
      }
    }
  }
});

/** Every frame the encoders can build for a model, many inputs. */
function encoderFrames(m: SsModel, count = 30): OutgoingReport[] {
  const out: OutgoingReport[] = [];
  const fam = m.family as P.CommandFamily;
  if (m.firmwareQuery) out.push(P.encodeFirmwareRead(0), P.encodeFirmwareRead(1));
  if (m.brightness) for (let b = 0; b <= 10; b++) out.push(P.encodeBrightness(b), P.encodeBrightnessRead());
  if (m.profiles) for (let s = 1; s <= 5; s++) out.push(P.encodeProfileSelect(s));
  if (m.regionQuery) out.push(P.encodeRegionRead(), P.encodeLayoutRead());
  if (m.statusQuery) {
    if (fam === "wireless-rx") out.push(P.encodeStatusRead(fam, "connection"), P.encodeStatusRead(fam, "battery"));
    if (fam === "wireless-usb") out.push(P.encodeStatusRead(fam, "battery"));
  }
  const dl = m.directLighting;
  if (dl) {
    if (dl.initFirst) out.push(P.encodeDirectInit());
    if (dl.release) out.push(P.encodeLightingRelease(fam));
    for (let n = 0; n < count; n++) {
      const leds = dl.leds.filter(() => rnd(3) > 0);
      if (leds.length) out.push(P.encodeDirect(fam, leds, () => [rnd(256), rnd(256), rnd(256)]));
    }
    out.push(P.encodeDirect(fam, dl.leds, () => [255, 255, 255]));
  }
  if (m.table && m.analogKeys) {
    const t: P.AnalogTarget = { family: fam, table: m.table, keys: m.analogKeys };
    for (let n = 0; n < count; n++) {
      if (m.actuation) out.push(P.encodeActuation(t, () => pickMm(t.table)));
      if (m.rapidTrigger) out.push(P.encodeRapidTrigger(t, () => !!rnd(2)));
      if (m.sensitivity) out.push(P.encodeSensitivity(t, () => (1 + rnd(40)) / 10));
    }
  }
  return out;
}

test("every encoder output passes its model guard and the static guard, and matches no BLOCKED pattern", () => {
  for (const m of driven) {
    const g = guardFor(m);
    const frames = encoderFrames(m);
    assert.ok(frames.length > 0, m.model);
    for (const r of frames) {
      for (const b of BLOCKED) assert.ok(!matchesPattern(b.bytes, r.data), `${m.model} built a blocked frame ${P.hex(r.data.subarray(0, 4))}`);
      assert.notEqual(g.classify(r).verdict, "blocked", `${m.model}: ${P.hex(r.data.subarray(0, 6))} ${JSON.stringify(g.classify(r))}`);
      assert.notEqual(STEELSERIES_GUARD.classify(r).verdict, "blocked", `static: ${P.hex(r.data.subarray(0, 6))}`);
    }
  }
});

test("model guards only allow their own family, table and capabilities", () => {
  const g1614 = guardFor(m1614), g1642 = guardFor(m1642), g1644 = guardFor(m1644), g1646 = guardFor(m1646);
  const a1642 = P.encodeActuation(tgt(m1642), () => 1.5);
  assert.equal(g1614.classify(a1642).verdict, "blocked");
  assert.equal(g1642.classify(a1642).verdict, "write");
  // a 1614 frame with a pair from another table (1642's 1.5 mm = 27/30) is refused
  const t = tgt(m1614);
  const bad = P.encodeActuation(t, () => 1.8);
  bad.data[3] = 30, bad.data[4] = 27;
  assert.equal(STEELSERIES_GUARD.classify(bad).verdict, "blocked");
  assert.equal(g1614.classify(bad).verdict, "blocked");
  // 3.2 mm (GG's 144/156) refused on the 2019 line
  const k32 = P.encodeActuation(t, () => 1.8);
  k32.data[3] = 156, k32.data[4] = 144;
  assert.equal(g1614.classify(k32).verdict, "blocked");
  // brightness / profiles exist only on the legacy line
  assert.equal(g1642.classify(P.encodeBrightness(3)).verdict, "blocked");
  assert.equal(g1644.classify(P.encodeProfileSelect(1)).verdict, "blocked");
  assert.equal(g1614.classify(P.encodeRegionRead()).verdict, "blocked");
  // the cable never gets the receiver opcodes and vice versa
  assert.equal(g1646.classify(P.encodeActuation(tgt(m1644), () => 1.5)).verdict, "blocked");
  assert.equal(g1644.classify(P.encodeActuation(tgt(m1646), () => 1.5)).verdict, "blocked");
  assert.equal(g1646.classify(P.encodeLightingRelease("wireless-rx")).verdict, "blocked");
  // the 1628 has lighting but no actuation writes
  const g1628 = guardFor(findModel(0x1628)!);
  assert.equal(g1628.classify(a1642).verdict, "blocked");
  assert.equal(g1628.classify(P.encodeDirectInit()).verdict, "blocked", "the 1628 gets no 4B init");
});

test("unknown commands, wrong shapes, out-of-range values and dirty padding are refused", () => {
  const out = (bytes: number[]): OutgoingReport => ({ type: "output", reportId: 0, data: pad(bytes, 64) });
  const known = new Set([0x90, 0xa3, 0x23, 0x3b, 0x89, 0xf5, 0xf2, 0x4b, 0x62, 0x22, 0xbc, 0xd2, 0x92]);
  for (let op = 0; op < 256; op++) {
    if (known.has(op)) continue;
    for (const g of guards) assert.equal(g.classify(out([op])).verdict, "blocked", `output ${op.toString(16)}`);
  }
  for (let op = 0; op < 256; op++) {
    for (const len of [641, 642, 644]) {
      const v = STEELSERIES_GUARD.classify({ type: "feature", reportId: 0, data: pad([op, 1, 4, 1, 2, 3], len) });
      if (op === 0x3a && len === 642) assert.equal(v.verdict, "write");
      else if (op === 0x40 && len === 644) assert.equal(v.verdict, "write");
      else if ((op === 0x61 || op === 0x21) && len === 641) assert.equal(v.verdict, "write");
      else assert.equal(v.verdict, "blocked", `feature ${op.toString(16)} ${len}`);
    }
  }
  const g = STEELSERIES_GUARD;
  assert.equal(g.classify(out([0x23, 11])).verdict, "blocked", "brightness 11");
  assert.equal(g.classify(out([0x89, 0])).verdict, "blocked", "profile 0");
  assert.equal(g.classify(out([0x89, 6])).verdict, "blocked", "profile 6");
  assert.equal(g.classify(out([0x90, 2])).verdict, "blocked", "firmware selector 2");
  assert.equal(g.classify(out([0x90, 0, 0, 1])).verdict, "blocked", "dirty padding");
  assert.equal(g.classify(out([0x3b, 1])).verdict, "blocked", "dirty padding");
  assert.equal(g.classify({ type: "output", reportId: 1, data: pad([0x90], 64) }).verdict, "blocked", "report id 1");
  assert.equal(g.classify({ type: "output", reportId: 0, data: pad([0x90], 63) }).verdict, "blocked", "63 bytes");
  assert.equal(g.classify({ type: "feature", reportId: 0, data: pad([0x90], 642) }).verdict, "blocked", "query as feature");
  assert.equal(g.classify({ type: "output", reportId: 0, data: pad([0x31, 0x47], 64) }).verdict, "blocked", "actuation as output");
  const t = tgt(m1642);
  const sens = P.encodeSensitivity(t, () => 4.0);
  sens.data[4] = 41;
  assert.equal(g.classify(sens).verdict, "blocked", "sensitivity 41");
  const rt = P.encodeRapidTrigger(t, () => true);
  rt.data[4] = 3;
  assert.equal(g.classify(rt).verdict, "blocked", "release mode 3 (protection) is never written");
  const a = P.encodeActuation(t, () => 1.0);
  a.data[643] = 1;
  assert.equal(g.classify(a).verdict, "blocked", "dirty tail");
  const swapped = P.encodeActuation(t, () => 1.0);
  [swapped.data[4], swapped.data[7]] = [swapped.data[7], swapped.data[4]];
  assert.equal(g.classify(swapped).verdict, "blocked", "key order");
  const second = P.encodeActuation(t, () => 1.0);
  second.data[3] = 2;
  assert.equal(g.classify(second).verdict, "blocked", "second-actuation layer is never written");
  const dup = P.encodeDirect("legacy", [4, 5], () => [1, 1, 1]);
  dup.data[6] = 4;
  assert.equal(g.classify(dup).verdict, "blocked", "duplicate LED");
  const unknownLed = P.encodeDirect("single", [4], () => [1, 1, 1]);
  unknownLed.data[2] = 0x46; // Print Screen: not an LED on the Gen 3 TKL
  assert.equal(guardFor(m1642).classify(unknownLed).verdict, "blocked");
});

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

test("steelseries-frames.txt matches the static guard line for line", () => {
  const file = path.join(here, "../src/lib/brands/steelseries/steelseries-frames.txt");
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length);
  assert.ok(lines.length > 2000, `only ${lines.length} lines`);
  let allowed = 0;
  for (const line of lines) {
    const [flag, hexs = ""] = line.split(" ");
    const bytes = unhex(hexs);
    assert.equal(bytes[0] ?? 0, 0, "report id byte");
    const data = bytes.slice(1);
    const shape = P.naturalShape(pad(data.slice(0, 4), 4));
    const v = STEELSERIES_GUARD.classify({ type: shape.type, reportId: 0, data: pad(data, shape.length) });
    assert.equal(v.verdict === "blocked" ? "0" : "1", flag, line.slice(0, 60));
    if (flag === "1") allowed++;
  }
  assert.ok(allowed > 300 && allowed < lines.length - 500, `${allowed} allowed`);
});
