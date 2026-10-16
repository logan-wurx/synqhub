// Checks src/lib/brands/fw19f5 (framing, trigger and function-block codecs, the model table, the allowlist
// and its frame fixture). No device, no window.
// Run: node --test scripts/fw19f5-codec.test.ts
//
// Evidence used:
//  1. Golden frames from the sources' documented bytes: FCC (GPL-3.0-or-later) docs/PROTOCOL-MC.md and
//     app/src/hid/mc.ts (packet shape, checksum, areas, trigger record layout), and svumo/DrunkDeer-Control
//     (MIT) docs/gen2-wire-format-confirmed.md, whose USB capture of a DrunkDeer A75 Pro OEM relabel
//     (19F5:FB5C) gives a real write frame with its checksum and a decoded record.
//  2. A mirror of FCC's `mcPacket` over many random inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as F from "../src/lib/brands/fw19f5/index.ts";
import { OEM_19F5_PIDS } from "../src/lib/brands/drunkdeer/devices.ts";
import { BOOTLOADER_RANGES, isBootloader } from "../src/lib/bootloader-ids.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hx = (f: Uint8Array, n = f.length) => Array.from(f.subarray(0, n), (b) => b.toString(16).padStart(2, "0")).join(" ");
const out = (data: Uint8Array) => ({ type: "output" as const, reportId: 0, data });
let seed = 0x55aa;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};

// ---------------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------------

test("a read request is [55, cmd, 0, checksum, len, offset, 0, ...] with the checksum over bytes 4 onward", () => {
  const f = F.readFrame(F.AREA.info, 0, 56);
  assert.equal(hx(f, 8), "55 03 00 38 38 00 00 00");
  assert.equal(f.length, 64);
  // FCC's mock device recomputes it as sum(len, offset lo, offset hi, 0, data...) & 0xFF.
  const k = F.readFrame(160, 0x0408, 56);
  assert.equal(hx(k, 8), `55 a0 00 ${((56 + 0x08 + 0x04) & 0xff).toString(16).padStart(2, "0")} 38 08 04 00`);
});

test("svumo's USB capture: seven key records written at offset 0 carry checksum 0xF5 and parse back", () => {
  const rec = [0xa0, 0x01, 0x3b, 0x00, 0x0e, 0x00, 0x31, 0x00];
  const data = Array.from({ length: 7 }, () => rec).flat();
  const f = F.writeFrame(F.AREA.triggerSet, 0, data);
  assert.equal(hx(f, 16), "55 a1 00 f5 38 00 00 00 a0 01 3b 00 0e 00 31 00");
  const r = F.parseRequest(f)!;
  assert.deepEqual([r.cmd, r.len, r.offset, r.flag], [0xa1, 56, 0, 0]);
  assert.equal(r.data.length, 56);
  // The last chunk of a stream is flagged 1 and the flag counts in the checksum.
  const last = F.writeFrame(F.AREA.triggerSet, 0x3f0, rec.concat(rec), true);
  assert.equal(last[7], 1);
  assert.equal(last[3], (16 + 0xf0 + 0x03 + 1 + 283 * 2) & 0xff);
  assert.equal(F.parseRequest(last)?.flag, 1);
});

test("frame builders agree with a mirror of FCC's mcPacket for many inputs", () => {
  const mirror = (cmd: number, offset: number, data: number[] | { size: number }) => {
    const payload = "size" in data ? [] : data;
    const len = "size" in data ? data.size : payload.length;
    const h = [len, offset & 0xff, offset >> 8, 0, ...payload];
    const o = new Uint8Array(64);
    o.set([0x55, cmd, 0, h.reduce((a, b) => a + b, 0) & 0xff, ...h]);
    return o;
  };
  for (let n = 0; n < 400; n++) {
    const cmd = rnd(256);
    const off = rnd(0x10000);
    if (n % 2) {
      const size = 1 + rnd(56);
      assert.deepEqual(F.readFrame(cmd, off, size), mirror(cmd, off, { size }));
    } else {
      const data = Array.from({ length: 1 + rnd(56) }, () => rnd(256));
      assert.deepEqual(F.writeFrame(cmd, off, data), mirror(cmd, off, data));
    }
  }
  assert.throws(() => F.readFrame(3, 0, 57), RangeError);
  assert.throws(() => F.readFrame(3, 0, 0), RangeError);
  assert.throws(() => F.readFrame(3, 0x10000, 8), RangeError);
  assert.throws(() => F.writeFrame(6, 0, []), RangeError);
});

test("a reply answers its request by command, offset and length (shorter is fine)", () => {
  const q = F.readFrame(160, 56, 56);
  const reply = (cmd: number, len: number, off: number) => {
    const r = new Uint8Array(64);
    r.set([0xaa, cmd, 0, 0, len, off & 0xff, off >> 8, 0]);
    return r;
  };
  assert.ok(F.answers(q, reply(160, 56, 56)));
  assert.ok(F.answers(q, reply(160, 8, 56)));
  assert.ok(!F.answers(q, reply(160, 57, 56)));
  assert.ok(!F.answers(q, reply(161, 56, 56)));
  assert.ok(!F.answers(q, reply(160, 56, 0)));
  const bad = reply(160, 56, 56);
  bad[0] = 0x55;
  assert.ok(!F.answers(q, bad));
  const p = F.parseReply(reply(3, 2, 0))!;
  assert.deepEqual([p.cmd, p.len, p.offset], [3, 2, 0]);
  assert.equal(F.parseReply(new Uint8Array(64)), null);
});

test("firmware and base areas decode as FCC reads them", () => {
  assert.deepEqual(F.decodeFirmware(Uint8Array.of(0x20, 0x01)), { raw: 0x0120, text: "1.20" });
  assert.equal(F.decodeFirmware(Uint8Array.of(0x07, 0x02)).text, "2.07");
  // FCC's mock: [order index 0, profile count 4, order 0 1 2 3]
  assert.deepEqual(F.decodeBase(Uint8Array.of(0, 4, 0, 1, 2, 3)), { index: 0, profileCount: 4, order: [0, 1, 2, 3], valid: true, ordered: true, profile: 0 });
  // The active profile is order[index] when the order is a permutation; svumo's tester B had profile 1 active.
  assert.equal(F.decodeBase(Uint8Array.of(1, 4, 0, 1, 2, 3)).profile, 1);
  assert.equal(F.decodeBase(Uint8Array.of(2, 4, 3, 2, 1, 0)).profile, 1);
  // Not a permutation: the index itself; out of range: profile 0.
  assert.equal(F.decodeBase(Uint8Array.of(2, 4, 0, 0, 0, 0)).profile, 2);
  assert.equal(F.decodeBase(Uint8Array.of(9, 4, 0, 1, 2, 3)).valid, false);
  assert.equal(F.decodeBase(Uint8Array.of(9, 4, 0, 1, 2, 3)).profile, 0);
});

// ---------------------------------------------------------------------------------------------
// Key triggers
// ---------------------------------------------------------------------------------------------

const UNITS_100: F.TravelUnits = { step: 100, precision: 0.01, maxTravel: 3.4 };
const UNITS_50: F.TravelUnits = { step: 50, precision: 0.02, maxTravel: 3.4 };

test("svumo's decoded record: actuation 0.60 mm, rapid trigger 0.15 / 0.50 mm; patching to 1.38 mm gives the captured bytes", () => {
  const rec = Uint8Array.of(0xa0, 0x00, 0x3b, 0x00, 0x0e, 0x00, 0x31, 0x00);
  const t = F.decodeTrigger(rec, UNITS_100);
  assert.deepEqual([t.actuationMm, t.rtPressMm, t.rtReleaseMm, t.rapidTrigger, t.live, t.mode], [0.6, 0.15, 0.5, false, true, 0]);
  assert.equal(hx(F.patchTrigger(rec, { actuationMm: 1.38 }, UNITS_100)), "a0 00 89 00 0e 00 31 00");
  const rt = F.patchTrigger(rec, { rapidTrigger: true, rtPressMm: 0.3, rtReleaseMm: 0.2 }, UNITS_100);
  assert.equal(hx(rt), "a0 01 3b 00 1d 00 13 00");
  const t2 = F.decodeTrigger(rt, UNITS_100);
  assert.deepEqual([t2.rapidTrigger, t2.rtPressMm, t2.rtReleaseMm, t2.actuationMm], [true, 0.3, 0.2, 0.6]);
});

test("the 9th bits, precision codes and dead zones are kept; only the named fields change", () => {
  // Actuation 3.30 mm = raw 330: byte 2 low, bit 0 of byte 3 high. Press precision 1 (0.005 mm), release precision 2 (0.001 mm), dead zones 5 / 9.
  const rec = Uint8Array.of(0xa3, 0x21, 0x00, 0x01 | (2 << 1) | (1 << 3) | 0x80, 0x0a, 0x00 | (5 << 1), 0x0a, 0x00 | (9 << 1));
  const t = F.decodeTrigger(rec, UNITS_100);
  assert.equal(t.actuationMm, 2.57); // (0 | 1<<8) + 1 = 257 raw
  assert.equal(t.raw.pressPrecision, 1);
  assert.equal(t.raw.releasePrecision, 2);
  assert.equal(t.rtPressMm, 0.055); // 11 raw at 200 per mm
  assert.equal(t.rtReleaseMm, 0.011); // 11 raw at 1000 per mm
  const p = F.patchTrigger(rec, { actuationMm: 3.3 }, UNITS_100);
  assert.equal(p[0], 0xa3, "switch type kept");
  assert.equal(p[1], 0x21, "priority and mode kept");
  assert.equal(p[3] & 0xfe, rec[3] & 0xfe, "precision codes and the unknown top bit kept");
  assert.equal(p[5], rec[5], "press dead zone kept");
  assert.equal(p[7], rec[7], "release dead zone kept");
  assert.equal(F.decodeTrigger(p, UNITS_100).actuationMm, 3.3);
  // At precision 1 (200 per mm) the 9-bit field tops out at 2.56 mm: a longer distance is refused with a sentence.
  assert.throws(() => F.patchTrigger(rec, { rtPressMm: 3 }, UNITS_100), /can't hold|isn't a value/);
  const q = F.patchTrigger(rec, { rtPressMm: 2.5 }, UNITS_100);
  assert.equal(F.decodeTrigger(q, UNITS_100).rtPressMm, 2.5);
  assert.equal(q[5] & 0xfe, rec[5] & 0xfe);
});

test("rapid trigger is only switched between normal and rapid; an advanced mode refuses", () => {
  const dks = Uint8Array.of(0xa0, 0x03, 0x5a, 0, 0x0a, 0, 0x0a, 0);
  assert.throws(() => F.patchTrigger(dks, { rapidTrigger: true }, UNITS_100), /advanced mode/);
  assert.equal(hx(F.patchTrigger(dks, { actuationMm: 1 }, UNITS_100)), "a0 03 63 00 0a 00 0a 00", "other fields can still change; the mode stays");
  const on = F.patchTrigger(Uint8Array.of(0xa0, 0x10, 0x5a, 0, 0x0a, 0, 0x0a, 0), { rapidTrigger: true }, UNITS_100);
  assert.equal(on[1], 0x11, "priority nibble kept");
});

test("units: the Ace 60's 50 per mm with 0.02 mm rapid-trigger steps; values outside the 9 bits are refused", () => {
  const rec = Uint8Array.of(0xa0, 0, 0x4a, 0, 0x0d, 0, 0x0d, 0);
  assert.equal(F.decodeTrigger(rec, UNITS_50).actuationMm, 1.5); // raw 75 / 50
  assert.equal(F.decodeTrigger(rec, UNITS_50).rtPressMm, 0.28); // raw 14 / 50
  assert.equal(F.patchTrigger(rec, { actuationMm: 2 }, UNITS_50)[2], 99);
  assert.throws(() => F.patchTrigger(rec, { actuationMm: 0 }, UNITS_100), /Actuation/);
  assert.throws(() => F.patchTrigger(rec, { actuationMm: 6 }, UNITS_100), /Actuation/);
  assert.throws(() => F.patchTrigger(rec, { rtPressMm: 0.005 }, UNITS_100), /Rapid trigger/);
  assert.equal(F.rtPerMm(0, 0.02), 50);
  assert.equal(F.rtPerMm(1, 0.02), 200);
  assert.equal(F.rtPerMm(2, 0.01), 1000);
});

test("changedRuns writes runs of consecutive changed records, at most 56 bytes, and never an unchanged record", () => {
  const a = new Uint8Array(1024);
  const b = new Uint8Array(a);
  assert.deepEqual(F.changedRuns(a, b), []);
  b[8 * 3 + 2] = 1;
  assert.deepEqual(F.changedRuns(a, b), [[24, 32]]);
  b[8 * 4] = 1;
  assert.deepEqual(F.changedRuns(a, b), [[24, 40]]);
  b[8 * 6] = 1; // record 5 is unchanged: it is not written
  assert.deepEqual(F.changedRuns(a, b), [[24, 40], [48, 56]]);
  b[8 * 127 + 7] = 1; // the last record
  assert.deepEqual(F.changedRuns(a, b).at(-1), [1016, 1024]);
  for (let i = 0; i < 128; i++) b[i * 8 + 1] = 1;
  const runs = F.changedRuns(a, b);
  assert.ok(runs.every(([x, y]) => y - x <= 56 && (y - x) % 8 === 0 && x % 8 === 0));
  assert.equal(runs.length, 19, "128 records at 7 per write");
  assert.equal(runs[0][0], 0);
  assert.equal(runs.at(-1)![1], 1024);
  assert.equal(runs.reduce((n, [x, y]) => n + (y - x), 0), 1024, "every record once");
});

// ---------------------------------------------------------------------------------------------
// Function block
// ---------------------------------------------------------------------------------------------

test("the function block decodes as FCC's table says and patches only the named bits", () => {
  const b = new Uint8Array(64);
  b[1] = 0x02; // OS mode, untouched
  b[4] = 0x35; // polling / tick, untouched
  b[6] = 0x05; // Win lock + Alt-F4 lock
  b[7] = 0x40 | 0x04; // debounce 2, travel check
  b[8] = 3;
  b[9] = 80;
  b[10] = 2; // 4 - speed 2
  b[14] = 255;
  b[16] = 128;
  b[35] = 4;
  const f = F.decodeFunc(b);
  assert.deepEqual([f.winLock, f.altTabLock, f.altF4Lock, f.bottomRapidTrigger, f.debounce, f.sleepSteps], [true, false, true, false, 2, 4]);
  assert.deepEqual(f.light, { effect: 3, brightness: 80, speed: 2, direction: 0, rainbow: false, rgb: [255, 0, 128] });
  const p = F.patchFunc(b, { altTabLock: true, bottomRapidTrigger: true, debounce: 6, sleepSteps: 10, speed: 4, rgb: [1, 2, 3], effect: 9, brightness: 20, rainbow: true });
  assert.equal(p[1], 0x02);
  assert.equal(p[4], 0x35);
  assert.equal(p[6], 0x07);
  assert.equal(p[7], 0xc0 | 0x04 | 0x02, "debounce 6, travel check kept, bottom RT on");
  assert.deepEqual([p[8], p[9], p[10], p[12], p[14], p[15], p[16], p[35]], [9, 20, 0, 1, 1, 2, 3, 10]);
  assert.deepEqual(F.decodeFunc(p).light.speed, 4);
  assert.throws(() => F.patchFunc(b, { debounce: 8 }), RangeError);
  assert.throws(() => F.patchFunc(b, { brightness: 101 }), RangeError);
  assert.throws(() => F.patchFunc(b, { speed: 5 }), RangeError);
  // Untouched: nothing else moved.
  const diff = Array.from(p).flatMap((v, i) => (v !== b[i] ? [i] : []));
  assert.deepEqual(diff, [6, 7, 8, 9, 10, 12, 14, 15, 16, 35]);
});

test("the 64-byte block goes out as bytes 0-55 and bytes 8-63, as FCC writes it", () => {
  const b = Uint8Array.from({ length: 64 }, (_, i) => i);
  const w = F.funcWrites(2, b);
  assert.deepEqual(w.map((x) => [x.offset, x.data.length]), [[128, 56], [136, 56]]);
  assert.equal(w[1].data[0], 8);
  assert.equal(w[1].data[55], 63);
});

// ---------------------------------------------------------------------------------------------
// The model table
// ---------------------------------------------------------------------------------------------

test("the model table: 85 ids, one family each, none shared with an upgrader", () => {
  const count = (fam: F.FwFamily) => F.FW_MODELS.filter((m) => m.family === fam).length;
  assert.deepEqual([count("mchose"), count("drunkdeer"), count("nuphy"), count("rk-gcome")], [31, 7, 38, 9]);
  assert.equal(F.FW_MODELS.length, 85);
  const ids = F.FW_IDS.map(([v, p]) => `${v.toString(16)}:${p.toString(16)}`);
  assert.equal(new Set(ids).size, ids.length, "no duplicate id");
  for (const m of F.FW_MODELS) {
    assert.ok(F.FW_VIDS.includes(m.vendorId));
    assert.equal(F.isFwUpgrader(m.vendorId, m.productId), false, `${m.model} is not an upgrader`);
    assert.deepEqual([m.channel.usagePage, m.channel.usage, m.channel.reportId, m.channel.length], [1, 0, 0, 64]);
    assert.equal(m.kind, "keyboard");
  }
  for (const u of F.FW_UPGRADERS) assert.equal(F.fwModel(u.vendorId, u.productId), null, `${u.what} is nobody's keyboard`);
  // Only MCHOSE and the NuPhy and RK families use 41E4 / 3837 or the A0xx..FExx ranges as listed.
  assert.ok(F.FW_MODELS.filter((m) => m.vendorId !== 0x19f5).every((m) => m.family === "mchose"));
});

test("MCHOSE: FCC's 28 boards on 31 ids; the shared id 3837:3033 is read-only with four candidates and no layout", () => {
  const boards = new Set(F.FW_MODELS.flatMap((m) => (m.board ? [m.board.id] : m.candidates.map((c) => c.id))));
  assert.equal(boards.size, 28);
  const shared = F.fwModel(0x3837, 0x3033)!;
  assert.equal(shared.tier, "readOnly");
  assert.deepEqual(shared.candidates.map((c) => c.name).sort(), ["G75 V2(8K)", "G87 V2(8K)", "K87S", "K99 V3"]);
  assert.equal(shared.board, null);
  for (const m of F.FW_MODELS.filter((x) => x.family === "mchose" && x.board)) {
    assert.equal(m.tier, "experimental", `${m.model} starts behind Allow changes`);
    const rows = F.layoutOf(m.board!);
    assert.ok(rows.length >= 60 && rows.length <= 90, `${m.model}: ${rows.length} keys`);
    assert.ok(rows.every((k) => k[0] < m.board!.maxKeyCount && k[0] < 128), "every slot is inside the trigger table");
    assert.equal(new Set(rows.map((k) => k[0])).size, rows.length, "no slot twice");
    assert.ok([50, 100].includes(m.board!.step));
    assert.ok(m.board!.maxTravel >= 3 && m.board!.maxTravel <= 4);
  }
  // The Ace 60 / 60 Pro names and both of their ids, from FCC's DEVICES.md.
  assert.equal(F.fwModel(0x41e4, 0x2101)?.board?.name, "Ace 60");
  assert.equal(F.fwModel(0x19f5, 0xfc30)?.board?.id, "mc-ace60-2101");
  assert.equal(F.fwModel(0x41e4, 0x2103)?.board?.name, "Ace 60 Pro");
  assert.equal(F.fwModel(0x19f5, 0xfc31)?.board?.id, "mc-ace60pro-2103");
  assert.equal(F.fwModel(0x3837, 0x3028)?.board?.name, "Ace 68 Turbo(8K)");
  assert.equal(F.fwModel(0x3837, 0x301d)?.board?.name, "Ace 75(16K)");
  assert.equal(F.fwModel(0x41e4, 0x2118)?.board?.name, "Jet 75");
  assert.equal(F.fwModel(0x41e4, 0x211c)?.board?.name, "ZERO 75X");
  assert.equal(F.fwModel(0x41e4, 0x2122)?.board?.name, "Mix 87");
});

test("DrunkDeer's seven 0x19F5 ids are DrunkDeer's own table; only the captured A75 Pro relabel may be written", () => {
  assert.deepEqual(F.fwIdsOf("drunkdeer").map(([, p]) => p).sort(), [...OEM_19F5_PIDS].sort());
  for (const m of F.FW_MODELS.filter((x) => x.family === "drunkdeer")) assert.equal(m.tier, m.productId === 0xfb5c ? "experimental" : "readOnly", m.model);
  assert.equal(F.fwModel(0x19f5, 0xfb5c)?.travel?.step, 100);
});

test("NuPhy and Royal Kludge boards are read-only forever; their upgraders are refused by id", () => {
  for (const m of F.FW_MODELS.filter((x) => x.family === "nuphy" || x.family === "rk-gcome")) assert.equal(m.tier, "readOnly", m.model);
  // NuPhyIO's 38 app ids; the ones named in the research.
  assert.equal(F.fwModel(0x19f5, 0x6120)?.name, "Air75 HE");
  assert.equal(F.fwModel(0x19f5, 0xfee0)?.name, "Air60 HE");
  assert.equal(F.fwModel(0x19f5, 0xfe70)?.name, "Field75 HE");
  assert.equal(F.fwModel(0x19f5, 0x6112)?.name, "Halo65 HE");
  assert.equal(F.fwModel(0x19f5, 0x1028)?.name, "Air75 V3");
  assert.equal(F.fwModel(0x19f5, 0x1030)?.name, "Node75");
  // RK's USB Gcome entries, not its 2.4 GHz dongles (8F0B, 8F1F, 8F21, 8F22).
  assert.equal(F.fwModel(0x19f5, 0xa01c)?.name, "K99");
  for (const dongle of [0x8f0b, 0x8f1f, 0x8f21, 0x8f22]) assert.equal(F.fwModel(0x19f5, dongle), null);
  // 37 NuPhy upgraders + 9 RK + the receiver's; the AFxx one rides the range.
  assert.equal(F.FW_UPGRADERS.length, 47);
  assert.equal(F.FW_UPGRADER_ROWS.length, 46);
  assert.ok(F.isFwUpgrader(0x19f5, 0x6f10) && F.isFwUpgrader(0x19f5, 0xaf0f) && F.isFwUpgrader(0x19f5, 0xaf99) && F.isFwUpgrader(0x19f5, 0x8a11) && F.isFwUpgrader(0x19f5, 0xfe00));
  assert.ok(!F.isFwUpgrader(0x19f5, 0x6120));
});

test("every upgrader id is in the shared bootloader tables (explicit rows, or the 19F5:AFxx range)", () => {
  for (const u of F.FW_UPGRADERS) assert.ok(isBootloader(u.vendorId, u.productId), `${u.what} ${u.productId.toString(16)}`);
  assert.ok(BOOTLOADER_RANGES.some((r) => r.vid === 0x19f5 && r.from === 0xaf00 && r.to === 0xafff));
  // And no board this driver claims is a bootloader.
  for (const [v, p] of F.FW_IDS) assert.equal(isBootloader(v, p), false, `${v.toString(16)}:${p.toString(16)}`);
});

// ---------------------------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------------------------

const allowed = (f: Uint8Array, fam: F.GuardFamily, ctx?: F.GuardContext) => (ctx ? F.classifyFrame(f, fam, ctx) : F.FW_GUARDS[fam].classify(out(f))).verdict !== "blocked";
const rec = [0xa0, 0, 0x3b, 0, 0x0e, 0, 0x31, 0];

test("NuPhy and Royal Kludge boards get the info and base reads and nothing else", () => {
  assert.ok(allowed(F.readFrame(3, 0, 56), "readonly"));
  assert.ok(allowed(F.readFrame(4, 0, 56), "readonly"));
  for (const f of [
    F.readFrame(5, 0, 56),
    F.readFrame(160, 0, 56),
    F.readFrame(8, 0, 56),
    F.writeFrame(161, 0, rec),
    F.writeFrame(6, 0, new Array(56).fill(0)),
    F.writeFrame(238, 0, [255]),
  ])
    assert.equal(allowed(f, "readonly"), false, hx(f, 8));
});

test("MCHOSE and DrunkDeer: the listed areas, in-block offsets, valid records; flag 1 only for DrunkDeer", () => {
  for (const fam of ["mchose", "drunkdeer"] as const) {
    assert.ok(allowed(F.readFrame(5, 64 * 3 + 8, 56 - 8), fam));
    assert.ok(allowed(F.readFrame(160, 1024 * 3 + 1000, 24), fam));
    assert.equal(allowed(F.readFrame(160, 1024 * 4, 8), fam), false, "profile 5 doesn't exist");
    assert.equal(allowed(F.readFrame(160, 1020, 56), fam), false, "a read must stay in its profile's block");
    assert.equal(allowed(F.readFrame(7, 0, 56), fam), false, "the factory key map is never read");
    assert.equal(allowed(F.readFrame(8, 0, 56), fam), false, "the key map is not read yet");
    assert.ok(allowed(F.writeFrame(161, 2048 + 16, rec.concat(rec)), fam));
    assert.equal(allowed(F.writeFrame(161, 4, rec), fam), false, "records start on 8-byte boundaries");
    assert.equal(allowed(F.writeFrame(161, 0, rec.slice(0, 7)), fam), false, "whole records");
    assert.equal(allowed(F.writeFrame(161, 1024 - 8, rec.concat(rec)), fam), false, "inside the block");
    assert.equal(allowed(F.writeFrame(161, 0, [0x10, ...rec.slice(1)]), fam), false, "byte 0's high nibble must be 0xA");
    assert.equal(allowed(F.writeFrame(161, 0, [0xa0, 0, 0, 0b0001_1000, 0, 0, 0, 0]), fam), false, "precision code 3");
    for (const cmd of [9, 11, 13, 165, 167, 238]) assert.equal(allowed(F.writeFrame(cmd, 0, [255]), fam), false, `area ${cmd}`);
  }
  assert.ok(allowed(F.writeFrame(161, 0, rec, true), "drunkdeer"));
  assert.equal(allowed(F.writeFrame(161, 0, rec, true), "mchose"), false, "MCHOSE never flags a chunk");
  assert.equal(allowed(F.writeFrame(161, 0, rec).fill(1, 40), "drunkdeer"), false, "padding must be zero");
  // Function-config writes: MCHOSE only; two shapes; byte ranges that have one.
  const block = new Uint8Array(64);
  block[F.FUNC.effect] = 9;
  block[F.FUNC.brightness] = 100;
  const [w0, w1] = F.funcWrites(1, block);
  assert.ok(allowed(F.writeFrame(6, w0.offset, w0.data), "mchose"));
  assert.ok(allowed(F.writeFrame(6, w1.offset, w1.data), "mchose"));
  assert.equal(allowed(F.writeFrame(6, w0.offset, w0.data), "drunkdeer"), false);
  assert.equal(allowed(F.writeFrame(6, 64 + 4, w0.data), "mchose"), false, "only offsets 0 and 8 in a block");
  assert.equal(allowed(F.writeFrame(6, 64, w0.data.slice(0, 40)), "mchose"), false, "only 56-byte writes");
  const hot = Uint8Array.from(block);
  hot[F.FUNC.brightness] = 101;
  assert.equal(allowed(F.writeFrame(6, 0, F.funcWrites(0, hot)[0].data), "mchose"), false, "brightness above 100");
  hot[F.FUNC.brightness] = 0;
  hot[F.FUNC.effect] = 77;
  assert.equal(allowed(F.writeFrame(6, 0, F.funcWrites(0, hot)[0].data), "mchose"), false, "unknown effect");
});

test("shape: a wrong length, magic, checksum or report type never passes", () => {
  const good = F.readFrame(3, 0, 56);
  assert.ok(allowed(good, "mchose"));
  assert.equal(F.FW_GUARDS.mchose.classify(out(good.slice(0, 63))).verdict, "blocked");
  const bad = new Uint8Array(good);
  bad[3] ^= 1;
  assert.equal(allowed(bad, "mchose"), false, "checksum");
  const magic = new Uint8Array(good);
  magic[0] = 0xaa;
  assert.equal(allowed(magic, "mchose"), false, "reply magic is not a request");
  assert.equal(F.FW_GUARDS.mchose.classify({ type: "feature", reportId: 0, data: good }).verdict, "blocked");
  assert.equal(F.FW_GUARDS.mchose.classify({ type: "output", reportId: 4, data: good }).verdict, "blocked");
  assert.equal(allowed(F.writeFrame(161, 0, rec).fill(0x55, 63), "mchose"), false);
  for (const fam of ["mchose", "drunkdeer", "readonly"] as const) assert.equal(F.FW_GUARDS[fam].blocked.length, F.BLOCKED.length);
});

test("a session's guard: only info and base before the profile is known; reads only without writes; the active profile only", () => {
  const ctx = (profile: number | null, writes: boolean): F.GuardContext => ({ profile, writes });
  assert.ok(allowed(F.readFrame(3, 0, 56), "mchose", ctx(null, false)));
  assert.ok(allowed(F.readFrame(4, 0, 56), "mchose", ctx(null, false)));
  assert.equal(allowed(F.readFrame(160, 0, 56), "mchose", ctx(null, false)), false);
  assert.ok(allowed(F.readFrame(160, 0, 56), "mchose", ctx(0, false)));
  assert.equal(allowed(F.readFrame(160, 1024, 56), "mchose", ctx(0, false)), false, "another profile");
  assert.ok(allowed(F.readFrame(160, 1024, 56), "mchose", ctx(1, false)));
  assert.equal(allowed(F.writeFrame(161, 0, rec), "mchose", ctx(0, false)), false, "read-only tier");
  assert.ok(allowed(F.writeFrame(161, 0, rec), "mchose", ctx(0, true)));
  assert.equal(allowed(F.writeFrame(161, 2048, rec), "mchose", ctx(0, true)), false, "writes go to the active profile only");
  assert.equal(allowed(F.writeFrame(6, 64, F.funcWrites(1, new Uint8Array(64))[0].data), "mchose", ctx(0, true)), false);
  assert.ok(allowed(F.writeFrame(6, 64, F.funcWrites(1, new Uint8Array(64))[0].data), "mchose", ctx(1, true)));
});

test("the frame fixture is what the guards say today (rust and the website read the same lines)", () => {
  const text = readFileSync(join(root, "src/lib/brands/fw19f5/fw19f5-frames.txt"), "utf8");
  const lines = text.split("\n").filter(Boolean);
  assert.ok(lines.length >= 4000, `${lines.length} frames`);
  const tally = { m: 0, d: 0, r: 0 };
  for (const line of lines) {
    const [v, hex = ""] = line.split(" ");
    const f = new Uint8Array(64);
    f.set((hex.match(/../g) ?? []).map((x) => parseInt(x, 16)));
    assert.equal(v[0] === "1", allowed(f, "mchose"), `mchose ${hex}`);
    assert.equal(v[1] === "1", allowed(f, "drunkdeer"), `drunkdeer ${hex}`);
    assert.equal(v[2] === "1", allowed(f, "readonly"), `readonly ${hex}`);
    if (v[0] === "1") tally.m++;
    if (v[1] === "1") tally.d++;
    if (v[2] === "1") tally.r++;
  }
  assert.ok(tally.m > 300 && tally.d > 100 && tally.r > 5 && tally.r < 50, JSON.stringify(tally));
});
