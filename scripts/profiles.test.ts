// Game profiles encoded offline (src/lib/profiles/encode.ts): the settings the Games page edits become the
// drivers' own frames, every one of them passes the driver's guard (the same verdicts as the Rust guards:
// see the ATK / X68 frame fixtures run by both test suites), only changed rows are written, the restore
// set is exactly the last-known rows, and nothing but settings writes can come out. No device I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as A from "../src/lib/atk-protocol.ts";
import * as X from "../src/lib/x68he-protocol.ts";
import { encode, familyOf, settingsFrom, type KnownDevice, type Step } from "../src/lib/profiles/encode.ts";

const pairs = (...v: number[]) => v.flatMap((x) => A.pair(x));

function atkKnown(): KnownDevice & { family: "atk" } {
  return {
    family: "atk",
    key: "373b:1278:2:",
    name: "ATK X1 V2 Air+",
    vendorId: 0x373b,
    productId: 0x1278,
    updated: 1,
    atk: {
      rows: {
        // 1000 Hz, 4 steps, step 2 active, then two bytes ATK HUB keeps (bhop, button mode) as read.
        system: [...pairs(0x01, 4, 1), 0x33, 0x22, ...A.pair(0)],
        liftOff: A.pair(A.liftOffCode(1.0)),
        function: pairs(2, 1, 6, 0, 0),
        performance: pairs(0, 0, 1),
        stages: [400, 800, 1600, 3200].map((d) => A.packPaw3955Stage(d)),
      },
      pollingOptions: A.RATES_8K,
      debounceOptions: [...A.DEBOUNCE_MS],
      dpi: { ...A.PAW3955_DPI, maxStages: A.PAW3955_MAX_STAGES },
    },
  };
}

const atkFrame = (s: Step) => Uint8Array.from(s.data);
const atkAddress = (s: Step) => (s.data[2] << 8) | s.data[3];
const atkRow = (s: Step) => s.data.slice(A.DATA_OFFSET, A.DATA_OFFSET + s.data[4]);

test("ATK: last-known state reads back as settings and encodes to nothing", () => {
  const k = atkKnown();
  const s = settingsFrom(k);
  assert.deepEqual(s, { family: "atk", atk: { stages: [400, 800, 1600, 3200], activeStage: 1, pollingHz: 1000, liftOffMm: 1, motionSync: true, angleSnapping: false, debounceMs: 2 } });
  assert.deepEqual(encode(k, s), { steps: [], restore: [] });
});

test("ATK: only changed rows are written, every frame passes the guard, restore is the rows as read", () => {
  const k = atkKnown();
  const s = settingsFrom(k);
  if (s.family !== "atk") throw new Error();
  const e = encode(k, { family: "atk", atk: { ...s.atk, stages: [400, 800, 1600, 3200, 6400], activeStage: 4, pollingHz: 4000, motionSync: false } });
  // New stage 5, the system row (rate, count, active), the function row. Stages 1-4 and lift-off unchanged.
  assert.deepEqual(e.steps.map(atkAddress), [A.ADDR.paw3955Dpi + 4 * A.PAW3955_STAGE_LENGTH, A.ADDR.system, A.ADDR.function]);
  for (const step of [...e.steps, ...e.restore]) {
    assert.equal(step.kind, "output");
    assert.equal((step as { reportId: number }).reportId, A.REPORT_ID);
    assert.equal(step.data[0], A.CMD.setEeprom, "settings writes only");
    assert.equal(A.checkFrame(atkFrame(step)), null, "the ATK guard (no grant) lets it through");
  }
  const sys = atkRow(e.steps[1]);
  assert.deepEqual(A.decodeSystem(sys), { pollingHz: 4000, stageCount: 5, activeStage: 4 });
  assert.deepEqual(sys.slice(6), k.atk.rows.system.slice(6), "bytes SYNQ doesn't edit stay exactly as read");
  assert.equal(A.decodeFunction(atkRow(e.steps[2])).motionSync, false);
  // Restore: the rows as read, the system row last; the new 5th stage has nothing to restore (the count hides it).
  assert.deepEqual(e.restore.map(atkAddress), [A.ADDR.function, A.ADDR.system]);
  assert.deepEqual(atkRow(e.restore[1]), k.atk.rows.system);
  assert.deepEqual(atkRow(e.restore[0]), k.atk.rows.function);
});

test("ATK: settings the mouse can't take are refused, nothing encoded", () => {
  const k = atkKnown();
  const s = settingsFrom(k);
  if (s.family !== "atk") throw new Error();
  const bad = [
    { ...s.atk, stages: [10] },
    { ...s.atk, stages: [] },
    { ...s.atk, stages: Array(9).fill(800) },
    { ...s.atk, activeStage: 7 },
    { ...s.atk, pollingHz: 333 },
    { ...s.atk, debounceMs: 3 },
    { ...s.atk, liftOffMm: 3 },
  ];
  for (const atk of bad) assert.throws(() => encode(k, { family: "atk", atk }), JSON.stringify(atk));
  const x = settingsFrom(x68Known());
  assert.throws(() => encode(k, x), /another kind of device/);
});

function x68Known(): KnownDevice & { family: "x68" } {
  return {
    family: "x68",
    key: "2e3c:c365:1:",
    name: "X68 HE",
    vendorId: 0x2e3c,
    productId: 0xc365,
    updated: 1,
    x68: {
      trigger: { unitMm: 0.01, minUnits: 10, maxUnits: 400, minMm: 0.1, maxMm: 4, rtMinMm: 0.01, rtMaxMm: 2 },
      keys: Array.from({ length: 68 }, (_, i) => ({ index: i, mode: X.TRIGGER_MODE.normal, travel: i < 4 ? 120 : 150, press: 15, release: 15 })),
    },
  };
}

test("X68 HE: actuation and rapid trigger for every key, guarded frames, restore per key as read", () => {
  const k = x68Known();
  const s = settingsFrom(k);
  assert.deepEqual(s, { family: "x68", x68: { actuationMm: 1.5, rapidTrigger: false, pressMm: 0.15, releaseMm: 0.15 } });
  const e = encode(k, { family: "x68", x68: { actuationMm: 0.4, rapidTrigger: true, pressMm: 0.1, releaseMm: 0.2 } });
  assert.equal(e.steps.length, 1, "one frame: every key gets the same values");
  assert.equal(e.restore.length, 2, "two frames: the 4 keys at 1.2 mm and the rest at 1.5 mm");
  for (const step of [...e.steps, ...e.restore]) {
    assert.equal(step.kind, "outputTo");
    const st = step as { usagePage: number; usage: number; reportId: number };
    assert.deepEqual([st.usagePage, st.usage, st.reportId], [X.X68.usagePage, X.X68.usage, X.X68.reportId]);
    const c = X.checkFrame(Uint8Array.from(step.data));
    assert.ok(c.ok && c.access === "write", c.reason);
  }
  const uniform = x68Known();
  uniform.x68.keys.forEach((key) => (key.travel = 150));
  assert.deepEqual(encode(uniform, settingsFrom(uniform)), { steps: [], restore: [] }, "unchanged: nothing");
  assert.throws(() => encode(k, { family: "x68", x68: { actuationMm: 9, rapidTrigger: false, pressMm: 0.1, releaseMm: 0.1 } }), /Actuation/);
  assert.throws(() => encode(k, { family: "x68", x68: { actuationMm: 1, rapidTrigger: true, pressMm: 3, releaseMm: 0.1 } }), /sensitivity/);
  const legacy = x68Known();
  legacy.x68.keys[0].mode = X.TRIGGER_MODE.rapidLegacy;
  assert.throws(() => encode(legacy, { family: "x68", x68: { actuationMm: 0.4, rapidTrigger: false, pressMm: 0.1, releaseMm: 0.1 } }), /can't put back/);
});

test("only drivers that can encode offline are offered", () => {
  assert.equal(familyOf(0x373b, 0x1278), "atk", "the X1 on its 8K receiver");
  assert.equal(familyOf(0x373b, 0x12a2), A.ATK_LINKS[0x12a2]?.verified ? "atk" : null, "on a cable only when that link is verified");
  assert.equal(familyOf(0x2e3c, 0xc365), "x68");
  assert.equal(familyOf(0x046d, 0xc54d), null, "Logitech: onboard-profile flash writes need a live exchange");
  assert.equal(familyOf(0x1532, 0x00b7), null);
  assert.equal(familyOf(0x0b05, 0x1d1d), null);
});
