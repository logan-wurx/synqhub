// Checks the Logitech keyboard protocol encoders and the safety guard.
// Run (no device, no window): node --test scripts/logitech-kb-codec.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as P from "../src/lib/brands/logitech-kb/protocol.ts";
import { BLOCKED_FEATURES, EXAMPLE_FEATURE_MAP, LogitechKbGuard, SAFE_FEATURES, emptyGuard } from "../src/lib/brands/logitech-kb/guard.ts";

const guard = new LogitechKbGuard(EXAMPLE_FEATURE_MAP);
const idxOf = (id: number): number => {
  for (const [i, f] of EXAMPLE_FEATURE_MAP) if (f === id) return i;
  throw new Error(`no index for 0x${id.toString(16)}`);
};
const classify = (f: P.HidppFrame) => guard.classify({ type: "output", reportId: f.reportId, data: f.data });
const D = 0xff;

// ---------------------------------------------------------------------------------------------
// Frame building (golden)
// ---------------------------------------------------------------------------------------------

test("byte 2 is (function << 4) | software id", () => {
  // getFeature: fn 0, sw 0x0b -> 0x0b ; ping: fn 1 -> 0x1b ; rateExtSet fn 3 -> 0x3b
  assert.equal(P.getFeature(D, 0x1b08).data[2], 0x0b);
  assert.equal(P.ping(D).data[2], 0x1b);
  assert.equal(P.rateExtSet(D, 2, 3).data[2], 0x3b);
});

test("getFeature carries the feature id big-endian and uses the long report", () => {
  const f = P.getFeature(D, 0x1b08);
  assert.equal(f.report, "long");
  assert.equal(f.reportId, 0x11);
  assert.deepEqual([...f.data.subarray(0, 5)], [0xff, 0x00, 0x0b, 0x1b, 0x08]);
});

test("ping is a short report ending in the marker", () => {
  const f = P.ping(D, 0xa5);
  assert.equal(f.reportId, 0x10);
  assert.equal(f.data.length, 6);
  assert.equal(f.data[5], 0xa5);
});

test("brightnessSet is big-endian 16-bit at offset 3", () => {
  const f = P.brightnessSet(D, 7, 0x8000);
  assert.deepEqual([...f.data.subarray(3, 5)], [0x80, 0x00]);
});

test("every report length matches its report id", () => {
  for (const [name, spec] of Object.entries(P.REPORT)) {
    const f = P.frame(name as P.ReportName, D, 1, 0);
    assert.equal(f.data.length, spec.len, name);
    assert.equal(f.reportId, spec.id, name);
  }
});

// ---------------------------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------------------------

test("parseError recognises the 0xFF error report and isAnswer rejects it", () => {
  const req = P.rateGet(D, idxOf(P.FEATURE.reportRate));
  const err = new Uint8Array(6);
  err.set([D, 0xff, req.data[1], req.data[2], 0x05]);
  assert.deepEqual(P.parseError(err), { featureIndex: req.data[1], fn: (req.data[2] >> 4) & 0xf, code: 5 });
  assert.equal(P.isAnswer(req, err), false);
});

test("isAnswer matches device, feature and function nibble", () => {
  const req = P.analogGetRapidTrigger(D, idxOf(P.FEATURE.analogKeys));
  const ok = new Uint8Array(6);
  ok.set([req.data[0], req.data[1], req.data[2], 0x01]);
  assert.equal(P.isAnswer(req, ok), true);
  ok[1] ^= 0x01; // different feature index
  assert.equal(P.isAnswer(req, ok), false);
});

// ---------------------------------------------------------------------------------------------
// Guard: reads and writes allowed
// ---------------------------------------------------------------------------------------------

test("safe reads classify as read", () => {
  for (const f of [P.ping(D), P.getFeature(D, 0x1b08), P.fwGetInfo(D, idxOf(P.FEATURE.firmwareInfo)), P.rateExtGet(D, idxOf(P.FEATURE.reportRateExt)), P.brightnessGet(D, idxOf(P.FEATURE.brightness)), P.onboardGetMode(D, idxOf(P.FEATURE.onboardProfiles)), P.analogGetRapidTrigger(D, idxOf(P.FEATURE.analogKeys))]) {
    assert.equal(classify(f).verdict, "read", JSON.stringify([...f.data.subarray(0, 4)]));
  }
});

test("safe writes classify as write", () => {
  for (const f of [P.rateExtSet(D, idxOf(P.FEATURE.reportRateExt), 3), P.rateSet(D, idxOf(P.FEATURE.reportRate), 1), P.brightnessSet(D, idxOf(P.FEATURE.brightness), 0x4000), P.onboardSetMode(D, idxOf(P.FEATURE.onboardProfiles), 2), P.analogSetRapidTrigger(D, idxOf(P.FEATURE.analogKeys), true), P.analogSetKeyPriority(D, idxOf(P.FEATURE.analogKeys), true)]) {
    assert.equal(classify(f).verdict, "write", JSON.stringify([...f.data.subarray(0, 4)]));
  }
});

// ---------------------------------------------------------------------------------------------
// Guard: blocked
// ---------------------------------------------------------------------------------------------

test("every blocked feature is refused on every function, with a reason", () => {
  for (const [id, info] of BLOCKED_FEATURES) {
    // give the blocked feature some index the device "reported"
    const map = new Map(EXAMPLE_FEATURE_MAP);
    map.set(0x20, id);
    const g = new LogitechKbGuard(map);
    for (let fn = 0; fn <= 15; fn++) {
      const f = P.frame("short", D, 0x20, fn, [0xff, 0xff, 0xff]);
      const v = g.classify({ type: "output", reportId: f.reportId, data: f.data });
      assert.equal(v.verdict, "blocked", `0x${id.toString(16)} fn ${fn}`);
      if (v.verdict === "blocked") assert.equal(v.why, info.why);
    }
  }
});

test("unresolved feature index, bad device index, non-query root fn, unknown fn, bad report are all refused", () => {
  const cases: P.HidppFrame[] = [
    P.frame("short", D, 0x7e, 0), // index not in map
    P.frame("short", 0x00, idxOf(P.FEATURE.reportRate), 1), // device index 0
    P.frame("short", 0x07, idxOf(P.FEATURE.reportRate), 1), // receiver slot 7
    P.frame("short", D, P.IROOT_INDEX, 5), // root fn that isn't getFeature/ping
    P.frame("short", D, idxOf(P.FEATURE.reportRate), 7), // unknown fn on a safe feature
  ];
  for (const f of cases) assert.equal(classify(f).verdict, "blocked", JSON.stringify([...f.data.subarray(0, 3)]));
  // wrong length
  assert.equal(guard.classify({ type: "output", reportId: 0x10, data: new Uint8Array(19) }).verdict, "blocked");
  // feature report instead of output
  assert.equal(guard.classify({ type: "feature", reportId: 0x10, data: new Uint8Array(6) }).verdict, "blocked");
});

test("with no features resolved, only IRoot works", () => {
  const g = emptyGuard();
  assert.equal(g.classify({ type: "output", reportId: 0x10, data: P.ping(D).data }).verdict, "read");
  const f = P.rateSet(D, 4, 1);
  assert.equal(g.classify({ type: "output", reportId: f.reportId, data: f.data }).verdict, "blocked");
});

test("no safe feature shares an index with a blocked feature id", () => {
  for (const id of SAFE_FEATURES.keys()) assert.equal(BLOCKED_FEATURES.has(id), false, `0x${id.toString(16)}`);
});

// ---------------------------------------------------------------------------------------------
// Fixture matches the guard, line for line
// ---------------------------------------------------------------------------------------------

test("logitech-kb-frames.txt matches the guard for every line", () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/brands/logitech-kb/logitech-kb-frames.txt");
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  assert.ok(lines.length > 300, `expected a big fixture, got ${lines.length}`);
  const LEN: Record<number, number> = { 0x10: 6, 0x11: 19, 0x12: 63 };
  let checked = 0;
  for (const line of lines) {
    const [verdict, hexStr] = line.split(" ");
    const bytes = new Uint8Array(hexStr.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
    const reportId = bytes[0];
    const data = new Uint8Array(LEN[reportId] ?? bytes.length - 1);
    data.set(bytes.subarray(1, 1 + data.length));
    const got = guard.classify({ type: "output", reportId, data });
    assert.equal(got.verdict !== "blocked", verdict === "1", `line "${line}" -> ${got.verdict}`);
    checked++;
  }
  assert.ok(checked > 300);
});

// ---------------------------------------------------------------------------------------------
// No encoder, on any input, can emit a blocked frame
// ---------------------------------------------------------------------------------------------

test("no setting encoder can emit a blocked frame for any in-range input", () => {
  const safeIdx = {
    rate: idxOf(P.FEATURE.reportRate),
    rateExt: idxOf(P.FEATURE.reportRateExt),
    brightness: idxOf(P.FEATURE.brightness),
    onboard: idxOf(P.FEATURE.onboardProfiles),
    analog: idxOf(P.FEATURE.analogKeys),
  };
  for (let v = 1; v <= 8; v++) assert.notEqual(classify(P.rateSet(D, safeIdx.rate, v)).verdict, "blocked");
  for (let v = 0; v <= 6; v++) assert.notEqual(classify(P.rateExtSet(D, safeIdx.rateExt, v)).verdict, "blocked");
  for (let v = 0; v <= 0xffff; v += 257) assert.notEqual(classify(P.brightnessSet(D, safeIdx.brightness, v)).verdict, "blocked");
  for (const m of [1, 2]) assert.notEqual(classify(P.onboardSetMode(D, safeIdx.onboard, m)).verdict, "blocked");
  for (const on of [true, false]) {
    assert.notEqual(classify(P.analogSetRapidTrigger(D, safeIdx.analog, on)).verdict, "blocked");
    assert.notEqual(classify(P.analogSetKeyPriority(D, safeIdx.analog, on)).verdict, "blocked");
    assert.notEqual(classify(P.analogSetTravelEvents(D, safeIdx.analog, on)).verdict, "blocked");
  }
});

test("out-of-range setting values are rejected by the encoders", () => {
  assert.throws(() => P.rateSet(D, 4, 0));
  assert.throws(() => P.rateSet(D, 4, 9));
  assert.throws(() => P.rateExtSet(D, 5, 7));
  assert.throws(() => P.onboardSetMode(D, 9, 3));
  assert.throws(() => P.brightnessSet(D, 6, 0x10000));
});
