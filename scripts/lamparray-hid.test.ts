// The HID LampArray standard as the website speaks it (src/lib/lighting/lamparray-hid.ts), against the layout of
// Microsoft's sample LampArray descriptor (as WebHID describes it: extended usages, one item per main item), plus a
// device that numbers its reports differently and one missing a report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asusLamp, checkLampFrame, controlFrame, hasLampArray, layoutOf, multiFrame, rangeFrame, readAttributes, readLamp, requestFrame, slotsOf, type Collection, type ReportItem } from "../src/lib/lighting/lamparray-hid.ts";

const u = (usage: number) => 0x590000 + usage;
const item = (usages: number[], reportSize: number, reportCount: number, logicalMaximum?: number): ReportItem => ({ usages: usages.map(u), reportSize, reportCount, logicalMaximum });
const RGBI = [0x51, 0x52, 0x53, 0x54];

/** Microsoft's sample: report ids 1-6, eight lamps per list report. */
function sample(ids = [1, 2, 3, 4, 5, 6], withMulti = true): Collection {
  const [attr, req, resp, multi, range, ctrl] = ids;
  const children: Collection[] = [
    { usagePage: 0x59, usage: 0x02, featureReports: [{ reportId: attr, items: [item([0x03], 16, 1, 65535), item([0x04, 0x05, 0x06, 0x07, 0x08], 32, 5, 2147483647)] }] },
    { usagePage: 0x59, usage: 0x20, featureReports: [{ reportId: req, items: [item([0x21], 16, 1, 65535)] }] },
    {
      usagePage: 0x59,
      usage: 0x22,
      featureReports: [{ reportId: resp, items: [item([0x21], 16, 1, 65535), item([0x23, 0x24, 0x25, 0x27, 0x26], 32, 5, 2147483647), item([0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d], 8, 6, 255)] }],
    },
    { usagePage: 0x59, usage: 0x60, featureReports: [{ reportId: range, items: [item([0x55], 8, 1, 1), item([0x61, 0x62], 16, 2, 65535), item(RGBI, 8, 4, 255)] }] },
    { usagePage: 0x59, usage: 0x70, featureReports: [{ reportId: ctrl, items: [item([0x71], 8, 1, 1)] }] },
  ];
  if (withMulti)
    children.push({
      usagePage: 0x59,
      usage: 0x50,
      featureReports: [{ reportId: multi, items: [item([0x03, 0x55], 8, 2, 255), item(Array(8).fill(0x21), 16, 8, 65535), item(Array.from({ length: 8 }, () => RGBI).flat(), 8, 32, 255)] }],
    });
  return { usagePage: 0x59, usage: 0x01, children };
}

const le = (n: number, bytes: number) => Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 0xff);

test("the six reports are found by what they carry, whatever their ids", () => {
  for (const ids of [
    [1, 2, 3, 4, 5, 6],
    [0x10, 0x11, 0x12, 0x13, 0x14, 0x15],
  ]) {
    const l = layoutOf(sample(ids));
    assert.ok(l, "layout");
    assert.deepEqual([l.attributes.id, l.request.id, l.response.id, l.multi.id, l.range.id, l.control.id], ids);
    assert.deepEqual([l.attributes.bytes, l.request.bytes, l.response.bytes, l.multi.bytes, l.range.bytes, l.control.bytes], [22, 2, 28, 50, 9, 1]);
    assert.equal(slotsOf(l), 8);
  }
  assert.equal(layoutOf(sample(undefined, false)), null, "a LampArray without the list report is left alone");
  assert.ok(hasLampArray([{ usagePage: 0x0001, usage: 0x0006 }, { usagePage: 0x59, usage: 0x01 }]));
  assert.ok(!hasLampArray([{ usagePage: 0x59, usage: 0x02 }]));
});

test("the array's and a lamp's attributes read in metres", () => {
  const l = layoutOf(sample())!;
  const attrs = readAttributes(l, Uint8Array.from([...le(104, 2), ...le(320000, 4), ...le(120000, 4), ...le(30000, 4), ...le(1, 4), ...le(16000, 4)]));
  assert.deepEqual(attrs, { lampCount: 104, width: 0.32, height: 0.12, depth: 0.03, kind: 1, minIntervalUs: 16000 });
  const lamp = readLamp(l, Uint8Array.from([...le(7, 2), ...le(12000, 4), ...le(19000, 4), ...le(0, 4), ...le(4000, 4), ...le(1, 4), 255, 255, 255, 1, 1, 0]));
  assert.deepEqual(lamp, { id: 7, x: 0.012, y: 0.019, z: 0, purposes: 1, levels: [255, 255, 255, 1], programmable: true });
});

test("what SYNQ builds passes the guard; anything else is refused before it is sent", () => {
  const l = layoutOf(sample())!;
  const lamps = 104;
  const ok = (id: number, d: Uint8Array) => checkLampFrame(l, lamps, id, d);

  assert.deepEqual(ok(l.request.id, requestFrame(l, 0)), { ok: true, what: "request" });
  assert.equal(ok(l.request.id, requestFrame(l, 104)).ok, false, "no lamp 104 on a 104-lamp array");
  assert.deepEqual(ok(l.control.id, controlFrame(l, false)), { ok: true, what: "control" });
  assert.deepEqual(Array.from(controlFrame(l, true)), [1]);
  assert.equal(ok(l.control.id, Uint8Array.from([2])).ok, false, "no other mode");

  const frame = multiFrame(l, [{ id: 0, rgb: [255, 0, 0] }, { id: 103, rgb: [0, 0, 255] }], true);
  assert.deepEqual(ok(l.multi.id, frame), { ok: true, what: "multi" });
  assert.deepEqual(Array.from(frame.subarray(0, 6)), [2, 1, 0, 0, 103, 0], "count, complete, lamp ids");
  assert.deepEqual(Array.from(frame.subarray(18, 26)), [255, 0, 0, 255, 0, 0, 255, 255], "red then blue, full intensity");
  const tooMany = multiFrame(l, [{ id: 0, rgb: [1, 1, 1] }], false);
  tooMany[0] = 9;
  assert.equal(ok(l.multi.id, tooMany).ok, false, "more lamps than one report carries");
  const far = multiFrame(l, [{ id: 0, rgb: [1, 1, 1] }], false);
  far[2] = 200;
  assert.equal(ok(l.multi.id, far).ok, false, "a lamp the array doesn't have");

  assert.deepEqual(ok(l.range.id, rangeFrame(l, 0, 103, [10, 20, 30])), { ok: true, what: "range" });
  assert.equal(ok(l.range.id, rangeFrame(l, 0, 104, [10, 20, 30])).ok, false);
  assert.equal(ok(l.range.id, rangeFrame(l, 9, 3, [10, 20, 30])).ok, false, "start after end");

  assert.equal(ok(l.attributes.id, new Uint8Array(22)).ok, false, "the attributes are only read");
  assert.equal(ok(l.response.id, new Uint8Array(28)).ok, false);
  assert.equal(ok(0x7f, new Uint8Array(1)).ok, false, "a report the array doesn't have");
  assert.equal(ok(l.control.id, new Uint8Array(2)).ok, false, "wrong length");
});

test("colours are scaled to the levels a lamp takes", () => {
  const l = layoutOf(sample())!;
  const f = multiFrame(l, [{ id: 1, rgb: [255, 128, 0], levels: [16, 16, 16, 1] }], true);
  assert.deepEqual(Array.from(f.subarray(18, 22)), [15, 8, 0, 255]);
});

test("ASUS lights are never touched", () => {
  assert.ok(asusLamp(0x0b05, "Keyboard"));
  assert.ok(asusLamp(0x1234, "ROG Strix Scope"));
  assert.ok(asusLamp(0x1234, "AURA LED Controller"));
  assert.ok(!asusLamp(0x045e, "Microsoft Dynamic Lighting sample"));
});
