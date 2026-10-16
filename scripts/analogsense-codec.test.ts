// Checks src/lib/kb/analogsense/{protocol,devices}.ts against AnalogSense (MIT).
// Run (no device, no window): node --test scripts/analogsense-codec.test.ts
//
// Reports are built byte by byte the way AnalogSense.js / Soup read them, then decoded; "mirror"
// functions transcribe AnalogSense.js's own decode loops for comparison over random reports.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as A from "../src/lib/kb/analogsense/protocol.ts";
import { ANALOGSENSE_BRIDGE, FAMILIES, MODELS, analogCoverage, depthCollection, findModel } from "../src/lib/kb/analogsense/devices.ts";

let seed = 777;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const bytes = (n: number, fill: (i: number) => number = () => 0) => Uint8Array.from({ length: n }, (_, i) => fill(i));

// ---------------------------------------------------------------------------------------------
// Mirrors of AnalogSense.js decode loops (DataView access replaced by array access)
// ---------------------------------------------------------------------------------------------

/** AsProviderWootingV1.startListening [js:356-368] */
function mirrorWootingV1(d: Uint8Array) {
  const out: [number, number][] = [];
  for (let i = 0; i < d.length; ) {
    const scancode = (d[i++] << 8) | d[i++];
    if (scancode == 0) break;
    const value = d[i++];
    out.push([scancode, value / 255]);
  }
  return out;
}
/** AsProviderWootingV2 [js:390-410] */
function mirrorWootingV2(d: Uint8Array) {
  const out: [number, number][] = [];
  for (let i = 0; i + 4 <= d.length; i += 4) {
    const keycode = d[i + 1], packed = d[i + 2], value_hi = d[i + 3];
    const scancode = (((packed >> 2) & 0xf) << 8) | keycode;
    const value = (value_hi << 2) | ((packed >> 6) & 0x3);
    if (scancode === 0) break;
    if (value === 0) continue;
    out.push([scancode, value / 1023]);
  }
  return out;
}
/** AsProviderMadlions reply loop [js:817-832] */
function mirrorMadlions(d: Uint8Array, offset: number, layout: readonly number[]) {
  const out: [number, number][] = [];
  for (let i = 0; i != 4; ++i) {
    if (offset + i < layout.length) {
      const travel = (d[7 + i * 5 + 3] << 8) | d[7 + i * 5 + 4];
      out.push([layout[offset + i], travel / 350]);
    }
  }
  return out;
}

test("Wooting v1 / v2 decode like AnalogSense.js", () => {
  for (let n = 0; n < 500; n++) {
    const v1 = bytes(48);
    const keys = 1 + rnd(15);
    for (let k = 0; k < keys; k++) {
      const sc = 4 + rnd(100);
      v1[k * 3] = sc >> 8;
      v1[k * 3 + 1] = sc & 0xff;
      v1[k * 3 + 2] = 1 + rnd(255);
    }
    assert.deepEqual([...A.decodeWootingV1(v1).set], [...new Map(mirrorWootingV1(v1))]);
    const v2 = bytes(64);
    for (let k = 0; k < 1 + rnd(15); k++) {
      v2[k * 4] = rnd(256);
      v2[k * 4 + 1] = 4 + rnd(200);
      v2[k * 4 + 2] = rnd(256);
      v2[k * 4 + 3] = rnd(256);
    }
    assert.deepEqual([...A.decodeWootingV2(v2).set], [...new Map(mirrorWootingV2(v2))]);
  }
  // Media key in v2: namespace 3 -> 0x3xx (Play/Pause 0xCD -> 0x3CD), full depth.
  const media = bytes(8);
  media.set([0, 0xcd, (3 << 2) | (3 << 6), 0xff]);
  assert.deepEqual([...A.decodeWootingV2(media).set], [[0x3cd, 1]]);
});

test("Razer V2 / V3 map Razer scancodes to HID", () => {
  // V2: [scancode, value] pairs: W (0x12) half, A (0x1F) full, then 0.
  assert.deepEqual([...A.decodeRazer(Uint8Array.from([0x12, 128, 0x1f, 255, 0, 0]), false).set], [[0x1a, 128 / 255], [0x04, 1]]);
  // V3: [scancode, value, ?] triples; Fn (0x3B) maps to 0x409.
  assert.deepEqual([...A.decodeRazer(Uint8Array.from([0x3b, 51, 9, 0x2c, 255, 9, 0]), true).set], [[0x409, 0.2], [0xe1, 1]]);
  // Every Razer code in the table maps to a named key.
  for (const hid of A.RAZER_TO_HID.values()) assert.ok(A.KEY_NAMES[hid], `hid ${hid}`);
});

test("NuPhy: one key per 0xA0 report, scaled as the C++ plugin does", () => {
  const r = (sc: number, value: number) => Uint8Array.from([0xa0, 0x10, sc >> 8, sc & 0xff, value >> 8, value & 0xff, 0, 0]);
  assert.deepEqual([...A.decodeNuphy(r(0x1a, 400))!.set], [[0x1a, 0.5]]);
  assert.deepEqual([...A.decodeNuphy(r(0x1a, 400), 1600)!.set], [[0x1a, 0.25]]);
  assert.deepEqual([...A.decodeNuphy(r(0x200, 800))!.set], [[0xe1, 1]]); // Left Shift as a bit mask
  assert.deepEqual([...A.decodeNuphy(r(0xff05, 0))!.set], [[0x409, 0]]); // Fn released
  assert.equal(A.decodeNuphy(Uint8Array.from([0x01, 0, 0, 4, 0, 1])), null); // not an analog report
  assert.equal(A.decodeNuphy(r(0x0300, 100)), null); // unknown special code
});

test("DrunkDeer: three replies of 59 positions in 0.1 mm", () => {
  const parts = [0, 1, 2].map((n) => {
    const d = bytes(63);
    d[3] = n;
    return d;
  });
  parts[0][4 + 0] = 40; // Escape bottomed (4.0 mm)
  parts[0][4 + 44] = 20; // index 44 = W, 2.0 mm
  parts[1][4 + (64 - 59)] = 10; // index 64 = A, 1.0 mm
  parts[2][4 + (121 - 118)] = 4; // index 121 = Right Arrow
  const got = parts.map((p) => A.decodeDrunkdeerChunk(p)!);
  assert.deepEqual([...got[0].depth], [[41, 1], [0x1a, 0.5]]);
  assert.deepEqual([...got[0].mm], [[41, 4], [0x1a, 2]]);
  assert.deepEqual([...got[1].depth], [[4, 0.25]]);
  assert.deepEqual([...got[2].depth], [[0x4f, 0.1]]);
  const notChunk = bytes(63);
  notChunk[3] = 7;
  assert.equal(A.decodeDrunkdeerChunk(notChunk), null);
  assert.equal(A.DRUNKDEER_REQUEST.length, 63);
  assert.deepEqual(A.DRUNKDEER_REQUEST.slice(0, 4), [0xb6, 0x03, 0x01, 0]);
});

test("Keychron / Lemokey requests and replies", () => {
  assert.deepEqual(A.keychronVersionRequest().slice(0, 4), [0xa9, 0x01, 0, 0]);
  assert.deepEqual(A.keychronTravelRequest(2, 7).slice(0, 5), [0xa9, 0x30, 2, 7, 0]);
  assert.deepEqual(A.keychronTravelAllRequest().slice(0, 3), [0xa9, 0x31, 0]);
  assert.equal(A.keychronVersionRequest().length, 32);
  const ver = bytes(32);
  ver.set([0xa9, 0x01, 4]);
  ver[31] = 0x45;
  assert.deepEqual(A.decodeKeychronVersion(ver), { version: 4, fullReport: true });
  const one = bytes(32);
  one.set([0xa9, 0x30, 2, 7, 0, 0, 235]);
  assert.equal(A.decodeKeychronTravel(one, 4), 1);
  assert.equal(A.decodeKeychronTravel(one, 3), 7 / 235); // before version 4 the travel is byte 3 (here the column, 7)
  one[3] = 4;
  assert.equal(A.decodeKeychronTravel(one, 3), 0, "below 5 = up");
  const page = bytes(32);
  page.set([0xa9, 0x31]);
  page[2 + 15 + 2] = 120; // matrix index 17 on the Q1 = "2"... (row 1, col 2)
  const q1 = A.LAYOUTS["keychron-q1-he"];
  assert.equal(q1.keys[17], 31);
  assert.equal(A.decodeKeychronAllPage(page, 0, q1).get(31), 120 / 235);
  // Every layout is rows x cols long and every key has a name.
  for (const [name, l] of Object.entries(A.LAYOUTS)) {
    assert.equal(l.keys.length, l.rows * l.cols, name);
    for (const k of l.keys) if (k) assert.ok(A.KEY_NAMES[k], `${name}: ${k}`);
  }
});

test("Madlions decode like AnalogSense.js", () => {
  const l = A.LAYOUTS["madlions-mad68he"];
  for (let n = 0; n < 200; n++) {
    const offset = rnd(19) * 4;
    const d = bytes(32, () => rnd(256));
    const mine = A.decodeMadlions(d, offset, l).depth;
    const theirs = mirrorMadlions(d, offset, l.keys).filter(([k]) => k);
    assert.deepEqual([...mine], theirs.map(([k, v]) => [k, Math.max(0, Math.min(1, v))]));
  }
  assert.deepEqual(A.madlionsRequest(8).slice(0, 9), [0x02, 0x96, 0x1c, 0, 0, 0, 8, 4, 0]);
});

test("Bytech request checksum and reply", () => {
  const req = A.bytechRequest();
  assert.equal(req.length, 63);
  assert.equal(req[62], 255 - ((9 + 0x97) % 256)); // 0x5F
  assert.equal(req[62], 0x5f);
  const rep = bytes(63);
  rep.set([0x97, 0x01, 0, 0, 0, 8, 0, 30, 0x01, 0x63, 0, 43, 0, 5]); // W at 355 (full), A at 5 (<= 10: up)
  assert.deepEqual([...A.decodeBytech(rep)!.set], [[0x1a, 1]]);
  assert.equal(A.decodeBytech(bytes(63)), null);
});

// ---------------------------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------------------------

test("every request SYNQ builds is allowed", () => {
  assert.ok(A.checkAnalogFrame("drunkdeer", 4, A.DRUNKDEER_REQUEST).ok);
  assert.ok(A.checkAnalogFrame("bytech", 9, A.bytechRequest()).ok);
  assert.ok(A.checkAnalogFrame("keychron", 0, A.keychronVersionRequest()).ok);
  assert.ok(A.checkAnalogFrame("keychron", 0, A.keychronTravelAllRequest()).ok);
  for (const [name, l] of Object.entries(A.LAYOUTS)) {
    if (name.startsWith("madlions")) for (let o = 0; o < l.keys.length; o += 4) assert.ok(A.checkAnalogFrame("madlions", 0, A.madlionsRequest(o)).ok, `${name} ${o}`);
    else for (let r = 0; r < l.rows; r++) for (let c = 0; c < l.cols; c++) assert.ok(A.checkAnalogFrame("keychron", 0, A.keychronTravelRequest(r, c)).ok);
  }
});

test("blocked: VIA resets / bootloader / writes, other vendor commands, anything to stream boards", () => {
  const via32 = (...head: number[]) => [...head, ...new Array(32 - head.length).fill(0)];
  for (const fam of ["keychron", "madlions"] as const) {
    for (const cmd of [0x0b, 0x0a, 0x06, 0x03, 0x05, 0x07, 0x09, 0x0f, 0x10, 0x13, 0x15, 0xfe, 0x01, 0x02, 0x04, 0x08, 0x12]) assert.equal(A.checkAnalogFrame(fam, 0, via32(cmd)).ok, false, `${fam} 0x${cmd.toString(16)}`);
    assert.equal(A.checkAnalogFrame(fam, 0, via32(0x02, 0x03)).ok, false, "switch-matrix read");
  }
  for (let sub = 0; sub < 256; sub++) if (![0x01, 0x30, 0x31].includes(sub)) assert.equal(A.checkAnalogFrame("keychron", 0, via32(0xa9, sub)).ok, false, `0xA9 0x${sub.toString(16)}`);
  assert.equal(A.checkAnalogFrame("keychron", 0, via32(0xa9, 0x30, 6, 0)).ok, false, "row out of range");
  assert.equal(A.checkAnalogFrame("keychron", 0, via32(0xa9, 0x01, 0, 0, 1)).ok, false, "trailing bytes");
  assert.equal(A.checkAnalogFrame("keychron", 0, A.keychronVersionRequest().slice(0, 31)).ok, false, "length");
  assert.equal(A.checkAnalogFrame("keychron", 1, A.keychronVersionRequest()).ok, false, "report id");
  const m = A.madlionsRequest(8);
  for (const [i, v] of [[1, 0x97], [2, 0x1d], [6, 9], [6, 76], [7, 5], [20, 1]] as const) {
    const x = [...m];
    x[i] = v;
    assert.equal(A.checkAnalogFrame("madlions", 0, x).ok, false, `madlions byte ${i}`);
  }
  for (let n = 0; n < 2000; n++) {
    const f = Array.from({ length: 63 }, () => (rnd(4) ? 0 : rnd(256)));
    f[0] = rnd(256);
    const isReq = f.every((b, i) => b === A.DRUNKDEER_REQUEST[i]);
    assert.equal(A.checkAnalogFrame("drunkdeer", 4, f).ok, isReq);
    assert.equal(A.checkAnalogFrame("bytech", 9, f).ok, f.every((b, i) => b === A.bytechRequest()[i]));
  }
  const badSum = A.bytechRequest();
  badSum[62] ^= 1;
  assert.equal(A.checkAnalogFrame("bytech", 9, badSum).ok, false);
  assert.equal(A.checkAnalogFrame("drunkdeer", 3, A.DRUNKDEER_REQUEST).ok, false);
  for (const fam of ["wooting-v1", "wooting-v2", "razer-v2", "razer-v3", "nuphy"] as const) {
    for (const f of [[], [0], A.keychronVersionRequest(), A.DRUNKDEER_REQUEST]) for (const id of [0, 1, 4, 7, 11]) assert.equal(A.checkAnalogFrame(fam, id, f).ok, false, fam);
  }
  // Razer's analog-mode switch (device mode 3, a 90-byte feature report) [soup:329-338] and any feature report.
  const razerMode = new Array(90).fill(0);
  razerMode.splice(0, 9, 0x00, 0x1f, 0, 0, 0, 0x02, 0x00, 0x04, 0x03);
  assert.equal(A.checkAnalogFrame("razer-v2", 0, razerMode, "feature").ok, false);
  assert.equal(A.checkAnalogFrame("drunkdeer", 4, A.DRUNKDEER_REQUEST, "feature").ok, false);
  assert.throws(() => A.assertAnalogSendable("nuphy", 0, [0]));
});

// ---------------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------------

test("device table: models, collections, never a keyboard collection", () => {
  const kb = { usagePage: 1, usage: 6, inputReports: [{ reportId: 7 }] };
  // Wooting: v2 collection preferred when present, v1 otherwise.
  assert.equal(findModel({ vendorId: 0x31e3, productId: 0x1310, collections: [{ usagePage: 0xff53, usage: 1 }] })?.family, "wooting-v2");
  assert.equal(findModel({ vendorId: 0x31e3, productId: 0x1310, collections: [{ usagePage: 0xff54, usage: 1 }] })?.family, "wooting-v1");
  assert.equal(findModel({ vendorId: 0x31e3, productId: 0x1310, collections: [kb] }), null);
  assert.equal(findModel({ vendorId: 0x03eb, productId: 0xff01, collections: [{ usagePage: 0xff54, usage: 1 }] })?.name, "Wooting One (old firmware)");
  assert.equal(findModel({ vendorId: 0x03eb, productId: 0x2ff4, collections: [{ usagePage: 0xff54, usage: 1 }] }), null, "other Atmel devices");
  // Razer: only a non-keyboard collection declaring report 7.
  assert.equal(findModel({ vendorId: 0x1532, productId: 0x0266, collections: [kb] }), null);
  assert.equal(findModel({ vendorId: 0x1532, productId: 0x0266, collections: [kb, { usagePage: 0xff00, usage: 1, inputReports: [{ reportId: 7 }] }] })?.name, "Razer Huntsman V2 Analog");
  assert.equal(findModel({ vendorId: 0x1532, productId: 0x02a6, collections: [{ usagePage: 0xff00, usage: 1, inputReports: [{ reportId: 7 }] }] }), null, "V3 uses report 11");
  // NuPhy: Generic Desktop usage 0 only; Air75 HE gets its own scale.
  assert.equal(findModel({ vendorId: 0x19f5, productId: 0x6120, collections: [{ usagePage: 1, usage: 0 }] })?.scale, 1600);
  assert.equal(findModel({ vendorId: 0x19f5, productId: 0x3245, collections: [{ usagePage: 1, usage: 0 }] })?.scale, 800);
  assert.equal(findModel({ vendorId: 0x19f5, productId: 0x3245, collections: [kb] }), null);
  // Madlions shares ATK's vendor id: ATK mice never match.
  assert.equal(findModel({ vendorId: 0x373b, productId: 0x1278, collections: [{ usagePage: 0xff60, usage: 0x61 }] }), null);
  assert.equal(findModel({ vendorId: 0x373b, productId: 0x105d, collections: [{ usagePage: 0xff60, usage: 0x61 }] })?.layout, "madlions-mad60he");
  // Keychron needs VIA's raw collection exactly.
  assert.equal(findModel({ vendorId: 0x3434, productId: 0x0b10, collections: [{ usagePage: 0xff60, usage: 0x62 }] }), null);
  for (const m of MODELS) {
    const f = FAMILIES[m.family];
    if (m.layout) assert.ok(A.LAYOUTS[m.layout], m.name);
    const c = f.inputReportId !== null ? { usagePage: 0xff00, usage: 1, inputReports: [{ reportId: f.inputReportId }] } : { usagePage: f.usagePage ?? 0, usage: f.usage ?? 1 };
    assert.ok(depthCollection(m, [kb, c]) === c, m.name);
  }
  // The bridge table never lists a typing collection.
  for (const b of ANALOGSENSE_BRIDGE) assert.ok(!(b.usagePage === 1 && b.usage === 6) && b.usagePage !== 7 && !(b.usagePage === 0x0c && b.usage === 1));
  const c = analogCoverage();
  assert.deepEqual(c.brands.sort(), ["DrunkDeer", "Keychron", "Lemokey", "Madlions", "NuPhy", "Razer", "Redragon", "Wooting"]);
  assert.equal(c.families, 9);
});
