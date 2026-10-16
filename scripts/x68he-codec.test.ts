// Checks src/lib/x68he-protocol.ts against frames built the way illumipc.com builds them.
// Run (no device, no window): node --test scripts/x68he-codec.test.ts
//
// Two kinds of evidence:
//  1. Golden frames written out by hand from the illumipc v2 bundle (app.js, SDK 1.1.9 build 20261008),
//     each with the function it comes from.
//  2. "Mirror" builders: line-by-line transcriptions of illumipc's byte assignments (renamed
//     variables, same index arithmetic), compared with SYNQ's encoders over many random inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/lib/x68he-protocol.ts";
import { X68_LAYOUTS, layoutForProduct } from "../src/lib/x68he-layout.ts";

const h = (f: Uint8Array) => P.hex(f);
const fromHex = (s: string) => {
  const f = new Uint8Array(63);
  s.trim().split(/\s+/).forEach((b, i) => (f[i] = parseInt(b, 16)));
  return f;
};
let seed = 12345;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};

// ---------------------------------------------------------------------------------------------
// Mirrors of illumipc's builders (v2 app.js)
// ---------------------------------------------------------------------------------------------

/** XA.setTrigger: s = Uint8Array(31) ... d[0]=33, d[4]=24, d.set(s, 5). */
function mirrorSetTrigger(r: { mode: number; travel: number; interval1: number; interval2: number; indexes: number[] }) {
  const s = new Uint8Array(31);
  s[0] = r.mode;
  for (const u of r.indexes) {
    const row = Math.floor(u / 22);
    s[(u % 22) + 1] |= 1 << row;
  }
  const l = r.travel, a = r.interval1, c = r.interval2;
  s[23] = 255 & l; s[24] = 255 & l; s[25] = 255 & a; s[26] = 255 & c;
  s[27] = (l >> 8) & 255; s[28] = (l >> 8) & 255; s[29] = (a >> 8) & 255; s[30] = (c >> 8) & 255;
  const d = new Uint8Array(63);
  d[0] = 33; d[4] = 24; d.set(s, 5);
  return d;
}

/** Nl._sendKeyData: 56-byte chunks, a[0]=24, a[1]=layer(0|2), a[2..3]=page, a[4]=len. */
function mirrorSendKeyData(e: Uint8Array, i: number) {
  const out: Uint8Array[] = [];
  const o = e.byteLength, r = o % 56, s = Math.floor(o / 56) + (r > 0 ? 1 : 0);
  for (let l = 0; l < s; l++) {
    const a = new Uint8Array(63);
    a[0] = 24; a[1] = i; a[2] = (l >> 8) & 255; a[3] = 255 & l;
    const c = 56 * l, d = l === s - 1 && r > 0 ? c + r : c + 56, u = d - c;
    a[4] = u; a.set(e.subarray(c, d), 5);
    out.push(a);
  }
  return out;
}

/** LA.sendSocdData (n = layout type). */
function mirrorSendSocd(i: { state?: number; model: number; keyCode1: number; keyCode2: number }[], n: string) {
  const out: Uint8Array[] = [];
  for (let r = 0; r < 2; r++) {
    const s = new Uint8Array(63);
    s[0] = 36; s[1] = 0; s[2] = (r >> 8) & 255; s[3] = 255 & r; s[4] = 40;
    for (let l = 0; l < 10; l++) {
      const a = 10 * r + l;
      if (a < i.length) {
        const c = i[a];
        s[4 * l + 5] = c.state !== undefined ? c.state : 1; s[4 * l + 6] = c.model; s[4 * l + 7] = c.keyCode1;
        n != "us" && c.keyCode2 == 49 ? (s[4 * l + 8] = 50) : (s[4 * l + 8] = c.keyCode2);
      }
    }
    out.push(s);
  }
  return out;
}

/** IA.setConfig. */
function mirrorSetLight(e: P.LightConfig, side: boolean) {
  const c = new Uint8Array(63);
  c[0] = side ? 8 : 7; c[1] = 0; c[2] = 0; c[3] = 0; c[4] = 14; c[5] = e.mode; c[6] = e.brightness; c[7] = e.speed;
  c[8] = e.color.r; c[9] = e.color.g; c[10] = e.color.b; c[11] = e.background.r; c[12] = e.background.g; c[13] = e.background.b;
  c[14] = e.direction; c[15] = e.fullColor; c[16] = e.power; c[17] = e.timer;
  return c;
}

/** XA.setDeadBand (o = 264-byte table). */
function mirrorSetDeadband(o: Uint8Array) {
  const out: Uint8Array[] = [];
  const r = 58, s = Math.ceil(o.length / r), l = o.length % r;
  for (let a = 0; a < s; a++) {
    const c = new Uint8Array(63);
    c[0] = 38; c[1] = 1; c[2] = (a >> 8) & 255; c[3] = 255 & a;
    l > 0 && a === s - 1 ? ((c[4] = l), c.set(o.subarray(a * r, a * r + l), 5)) : ((c[4] = r), c.set(o.subarray(a * r, (a + 1) * r), 5));
    out.push(c);
  }
  return out;
}

type K = { code1: number; hidCode: number; code3: number; code4: number; index?: number };
/** YA.sendAdvancedKeys, one slot (Ie = entry). */
function mirrorAdvanced(ht: number, Ie: { type: string; travelPoints?: number[]; keys: K[]; steps?: number[]; duration?: number; mode?: number } | null) {
  const Ye = new Uint8Array(63);
  Ye[0] = 34; Ye[1] = ht; Ye[4] = 50;
  if (Ie) {
    let ft = 0;
    if (Ie.type === "DKS") ft = 1;
    if (Ie.type === "MT") ft = 2;
    if (Ie.type === "TGL") ft = 3;
    if (Ie.type === "RS") ft = 4;
    if (Ie.type === "RKRT") ft = 5;
    if (Ie.type === "MDS") ft = 6;
    Ye[5] = ft;
    const k = Ie.keys;
    if (ft === 1) {
      Ye[6] = Ie.travelPoints?.[0] || 0; Ye[7] = Ie.travelPoints?.[1] || 0; Ye[8] = Ie.travelPoints?.[2] || 0; Ye[9] = Ie.travelPoints?.[3] || 0;
      for (let le = 0; le < 4; le++) {
        // illumipc stores code1 18 (mouse) as [18, code3, hidCode, code4]; SYNQ keeps raw bytes, so the
        // mirror is fed raw bytes in code1/hidCode/code3/code4 order and takes the plain branch.
        Ye[8 * le + 10] = k[le]?.code1 || 0; Ye[8 * le + 11] = k[le]?.hidCode || 0; Ye[8 * le + 12] = k[le]?.code3 || 0; Ye[8 * le + 13] = k[le]?.code4 || 0;
        Ye[8 * le + 14] = Ie.steps?.[4 * le] || 0; Ye[8 * le + 15] = Ie.steps?.[4 * le + 1] || 0; Ye[8 * le + 16] = Ie.steps?.[4 * le + 2] || 0; Ye[8 * le + 17] = Ie.steps?.[4 * le + 3] || 0;
      }
    }
    if (ft === 2) {
      Ye[6] = k[1]?.code1 || 0; Ye[7] = k[1]?.hidCode || 0; Ye[8] = k[1]?.code3 || 0; Ye[9] = k[1]?.code4 || 0;
      Ye[10] = k[0]?.code1 || 0; Ye[11] = k[0]?.hidCode || 0; Ye[12] = k[0]?.code3 || 0; Ye[13] = k[0]?.code4 || 0; Ye[14] = Ie.duration!;
    }
    if (ft === 3) { Ye[6] = k[0]?.code1 || 0; Ye[7] = k[0]?.hidCode || 0; Ye[8] = k[0]?.code3 || 0; Ye[9] = k[0]?.code4 || 0; }
    if (ft === 4) {
      Ye[6] = k[0]?.code1 || 0; Ye[7] = k[0]?.hidCode || 0; Ye[8] = k[0]?.code3 || 0; Ye[9] = k[0]?.code4 || 0;
      Ye[10] = Math.floor((k[0]?.index || 0) / 22); Ye[11] = (k[0]?.index || 0) % 22;
      Ye[12] = k[1]?.code1 || 0; Ye[13] = k[1]?.hidCode || 0; Ye[14] = k[1]?.code3 || 0; Ye[15] = k[1]?.code4 || 0;
      Ye[16] = Math.floor((k[1]?.index || 0) / 22); Ye[17] = (k[1]?.index || 0) % 22;
    }
    if (ft === 5) {
      Ye[6] = k[0]?.code1 || 0; Ye[7] = k[0]?.hidCode || 0; Ye[8] = k[0]?.code3 || 0; Ye[9] = k[0]?.code4 || 0;
      Ye[12] = k[1]?.code1 || 0; Ye[13] = k[1]?.hidCode || 0; Ye[14] = k[1]?.code3 || 0; Ye[15] = k[1]?.code4 || 0;
    }
    if (ft === 6) {
      const le = k.filter((be) => be && be.hidCode), Ee = Math.min(le.length, 6), Ue = Ie.duration || 0;
      Ye[6] = (Ue >> 8) & 255; Ye[7] = 255 & Ue; Ye[8] = Ie.mode || 0; Ye[9] = Ee;
      for (let be = 0; be < Ee; be++) Ye[10 + be] = le[be].hidCode || 0;
    }
  }
  return Ye;
}

/** WA._writeDeviceSettings. */
function mirrorDeviceSettings(e: { lockWin: boolean; lockShiftTab: boolean; lockAltF4: boolean; lockAltTab: boolean; superPerformance: boolean; is6Key: boolean }) {
  const n = new Uint8Array(63);
  n[0] = 20; n[4] = 1;
  n[12] = e.lockWin ? 1 : 0; n[13] = e.lockShiftTab ? 1 : 0; n[14] = e.lockAltF4 ? 1 : 0; n[15] = e.lockAltTab ? 1 : 0; n[17] = e.superPerformance ? 1 : 0; n[18] = e.is6Key ? 1 : 0;
  return n;
}

const raw = (k: K): P.RawAction => [k.code1, k.hidCode, k.code3, k.code4];
const randKey = (): K => ({ code1: rnd(4) === 0 ? 0x13 : 0, hidCode: 4 + rnd(100), code3: rnd(3) ? 0 : 4 + rnd(30), code4: 0 });

// ---------------------------------------------------------------------------------------------
// Golden frames (hand-derived from the bundle)
// ---------------------------------------------------------------------------------------------

test("golden read frames", () => {
  assert.equal(h(P.encodeStatus()), "01"); // WA.initSupport: e[0] = tC (1)
  assert.equal(h(P.encodeProduct()), "0d"); // WA.initProduct: i[0] = rC (13)
  assert.equal(h(P.encodeSerial()), "15"); // SA._readSerialNumber: e[0] = 21
  assert.equal(h(P.encodeFnEditable()), "0e"); // Nl.getFnKey: i[0] = 14
  assert.equal(h(P.encodeLightModes()), "0a"); // IA.getLightingList(false): nC (10), [1] = 0
  assert.equal(h(P.encodeLightModes(true)), "02"); // iC (2)
  assert.equal(h(P.encodeLightRead()), "07 01"); // IA.getConfig: TA (7), [1] = 1
  assert.equal(h(P.encodeKeymapRead("default")), "18 80"); // Nl.getLayoutKey: 24, 128
  assert.equal(h(P.encodeKeymapRead("fn")), "18 82"); // 130
  assert.equal(h(P.encodeMacroRead(3)), "19 83"); // KA.initMacroValue: Hl (25), 128 + slot
  assert.equal(h(P.encodeAdvancedRead()), "22 80"); // YA.initAdvancedKeys: MA (34), 128
  assert.equal(h(P.encodeSocdListRead()), "24 01"); // LA.initSocdData: cr (36), 1
  assert.equal(h(P.encodeSocdPowerRead()), "24 02"); // LA.initSocdPower
  assert.equal(h(P.encodeTriggerConfigRead()), "21 00 00 00 18 04"); // XA.getTriggerConfig: [0]=33, [4]=24, [5]=4
  assert.equal(h(P.encodeKeyTriggerRead(70)), "21 00 00 00 18 05 03 04"); // D key: row 3 col 4
  assert.equal(h(P.encodePollRateRead()), "21 00 00 00 01 09"); // NA.readPollRate
  assert.equal(h(P.encodeProfileQuery()), "21 00 00 00 00 11"); // WA.initPresetProfileIndex: GA, [5] = lC (17)
  assert.equal(h(P.encodeSwitchListRead()), "25"); // PA.getAxisList: Oc (37), [1] = 0
  assert.equal(h(P.encodeKeySwitchRead()), "25 02"); // PA.initKeyAxis
  assert.equal(h(P.encodeDeadbandRead()), "26"); // XA.readDeadBand: 38, 0
});

test("golden write frames", () => {
  // TriggerPanel: rapid trigger with separate press/release = mode 13; A (68) and D (70) at 1.20 mm with 0.01 mm units.
  assert.equal(
    h(P.encodeTriggerWrite({ mode: 13, travel: 120, press: 15, release: 20 }, [68, 70])),
    "21 00 00 00 18 0d 00 00 08 00 08 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 78 78 0f 14",
  );
  // 4.00 mm (400 units) shows the high bytes.
  assert.equal(h(P.encodeTriggerWrite({ mode: 0, travel: 400, press: 0, release: 0 }, [22])), "21 00 00 00 18 00 02 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 90 90 00 00 01 01");
  assert.equal(h(P.encodePollRateWrite(8000)), "21 00 00 00 00 09 01 08"); // NA.setPollRate
  assert.equal(h(P.encodePollRateWrite(1000)), "21 00 00 00 00 09 01 01");
  assert.equal(h(P.encodeProfileSet(2)), "21 00 00 00 00 12 02"); // WA.setProfileIndex: [5] = aC (18)
  assert.equal(h(P.encodeSocdPowerWrite(true)), "24 03 00 00 01 01"); // LA.setSocdPower
  // The friend's setup: SOCD on A (0x04) and D (0x07), last input wins (mode 0).
  const [p0, p1] = P.encodeSocdWrite([{ index: 0, mode: 0, key1: 0x04, key2: 0x07 }]);
  assert.equal(h(p0), "24 00 00 00 28 01 00 04 07");
  assert.equal(h(p1), "24 00 00 01 28");
  assert.equal(
    h(P.encodeLightWrite({ mode: 2, brightness: 4, speed: 3, color: { r: 255, g: 0, b: 0 }, background: { r: 0, g: 0, b: 0 }, direction: 1, fullColor: 1, power: 0, timer: 0 })),
    "07 00 00 00 0e 02 04 03 ff 00 00 00 00 00 01 01",
  );
  assert.equal(h(P.encodeDeviceSettings({ lockWin: true, lockShiftTab: false, lockAltF4: false, lockAltTab: false, superPerformance: false, sixKey: false })), "14 00 00 00 01 00 00 00 00 00 00 00 01");
  // MT: tap = A, hold = Left Ctrl, 150 ms -> 15 (saveMT order: bytes 6..9 = keys[1], 10..13 = keys[0]).
  assert.equal(h(P.encodeAdvancedWrite(0, { slot: 0, type: "MT", actions: [[0, 0x04, 0, 0], [0, 0xe0, 0, 0]], duration: 15 })), "22 00 00 00 32 02 00 e0 00 00 00 04 00 00 0f");
  assert.equal(h(P.encodeAdvancedWrite(5, null)), "22 05 00 00 32");
});

// ---------------------------------------------------------------------------------------------
// Mirror comparisons
// ---------------------------------------------------------------------------------------------

test("trigger writes match illumipc for random inputs", () => {
  for (let n = 0; n < 500; n++) {
    const mode = P.WRITABLE_TRIGGER_MODES[rnd(3)];
    const travel = 1 + rnd(450), press = rnd(300), release = rnd(300);
    const indexes = [...new Set(Array.from({ length: 1 + rnd(20) }, () => rnd(132)))];
    const ours = P.encodeTriggerWrite({ mode, travel, press, release }, indexes);
    const theirs = mirrorSetTrigger({ mode, travel, interval1: press, interval2: release, indexes });
    assert.equal(h(ours), h(theirs));
    assert.ok(P.checkFrame(ours).ok, h(ours));
  }
});

test("keymap writes match illumipc", () => {
  for (const layer of ["default", "fn"] as const) {
    const table = new Uint8Array(528).map(() => rnd(256));
    const ours = P.encodeKeymapWrite(layer, table);
    const theirs = mirrorSendKeyData(table, layer === "default" ? 0 : 2);
    assert.equal(ours.length, 10);
    assert.deepEqual(ours.map(h), theirs.map(h));
    for (const f of ours) assert.ok(P.checkFrame(f).ok);
  }
});

test("SOCD, lighting, dead zones and device settings match illumipc", () => {
  for (let n = 0; n < 200; n++) {
    const entries = Array.from({ length: rnd(21) }, (_, i) => ({ index: i, mode: rnd(4), key1: 1 + rnd(200), key2: rnd(5) === 0 ? 0x31 : 1 + rnd(200) }));
    for (const nonUs of [false, true]) {
      const ours = P.encodeSocdWrite(entries, nonUs);
      const theirs = mirrorSendSocd(entries.map((e) => ({ model: e.mode, keyCode1: e.key1, keyCode2: e.key2 })), nonUs ? "uk" : "us");
      assert.deepEqual(ours.map(h), theirs.map(h));
      for (const f of ours) assert.ok(P.checkFrame(f).ok);
    }
    const light: P.LightConfig = { mode: rnd(17), brightness: rnd(5), speed: rnd(5), color: { r: rnd(256), g: rnd(256), b: rnd(256) }, background: { r: rnd(256), g: rnd(256), b: rnd(256) }, direction: rnd(6), fullColor: rnd(2), power: rnd(2), timer: rnd(3) };
    for (const side of [false, true]) {
      assert.equal(h(P.encodeLightWrite(light, side)), h(mirrorSetLight(light, side)));
      assert.ok(P.checkFrame(P.encodeLightWrite(light, side)).ok);
    }
    const db = new Uint8Array(264).map(() => rnd(30));
    assert.deepEqual(P.encodeDeadbandWrite(db).map(h), mirrorSetDeadband(db).map(h));
    const flags = [rnd(2), rnd(2), rnd(2), rnd(2), rnd(2), rnd(2)].map(Boolean);
    const ds = P.encodeDeviceSettings({ lockWin: flags[0], lockShiftTab: flags[1], lockAltF4: flags[2], lockAltTab: flags[3], superPerformance: flags[4], sixKey: flags[5] });
    assert.equal(h(ds), h(mirrorDeviceSettings({ lockWin: flags[0], lockShiftTab: flags[1], lockAltF4: flags[2], lockAltTab: flags[3], superPerformance: flags[4], is6Key: flags[5] })));
    assert.ok(P.checkFrame(ds).ok);
  }
});

test("advanced keys match illumipc and round-trip through the reader", () => {
  for (let n = 0; n < 300; n++) {
    const slot = rnd(40);
    const type = (["DKS", "MT", "TGL", "RS", "RKRT", "MDS"] as const)[rnd(6)];
    const keys = Array.from({ length: 6 }, randKey);
    keys[0].index = 22 + rnd(100);
    keys[1].index = 22 + rnd(100);
    const steps = Array.from({ length: 16 }, () => rnd(4));
    const travelPoints = [10 + rnd(20), 30 + rnd(10), 30 + rnd(10), 10 + rnd(20)];
    const duration = type === "MDS" ? rnd(3000) : 1 + rnd(100);
    const mode = rnd(2);
    const entry: P.AdvancedEntry =
      type === "DKS"
        ? { slot, type, actions: keys.slice(0, 4).map(raw), steps, travelPoints }
        : type === "MDS"
          ? { slot, type, actions: [], hidKeys: keys.map((k) => k.hidCode), duration, mdsMode: mode }
          : type === "RS"
            ? { slot, type, actions: keys.slice(0, 2).map(raw), keyIndexes: [keys[0].index!, keys[1].index!] }
            : { slot, type, actions: keys.slice(0, type === "TGL" ? 1 : 2).map(raw), duration: type === "MT" ? duration : undefined };
    const ours = P.encodeAdvancedWrite(slot, entry);
    const theirs = mirrorAdvanced(slot, { type, keys: type === "TGL" ? keys.slice(0, 1) : keys, steps, travelPoints, duration, mode });
    assert.equal(h(ours), h(theirs), type);
    assert.ok(P.checkFrame(ours).ok);
    // Reader: a read page is the same bytes with byte 1 = 0x80 and the slot as the page number.
    const page = new Uint8Array(ours);
    page[1] = 0x80;
    page[3] = slot;
    const [back] = P.decodeAdvancedPages([page]).entries;
    assert.equal(back.type, type);
    assert.equal(h(P.encodeAdvancedWrite(slot, back)), h(ours));
  }
});

test("keymap pages decode back to the table", () => {
  const table = new Uint8Array(528).map(() => rnd(256));
  // Reply pages: 14 entries (56 bytes) per page, page 9 holds the last 6 entries.
  const pages = Array.from({ length: 10 }, (_, page) => {
    const r = new Uint8Array(63);
    const n = Math.min(14, 132 - page * 14);
    r[0] = 0x18; r[1] = 0x80; r[3] = page; r[4] = n * 4;
    r.set(table.subarray(page * 56, page * 56 + n * 4), 5);
    return r;
  });
  const { table: back, seen } = P.decodeKeymapPages(pages);
  assert.equal(seen, 132);
  assert.deepEqual(Array.from(back), Array.from(table));
  const rule = P.replyRule(P.encodeKeymapRead("default"))!;
  assert.ok(rule.match(pages[0]) && !rule.last!(pages[0]) && rule.last!(pages[9]));
});

// ---------------------------------------------------------------------------------------------
// Decoders built from illumipc's parsers
// ---------------------------------------------------------------------------------------------

test("trigger config follows getTriggerConfig", () => {
  // High precision, unit raw 1 -> 0.001? No: 10 / 1000 = 0.01 mm; max 400 units = 4.00 mm; min byte 10 = 10 units.
  const r = fromHex("21 00 00 00 18 04 90 0a 0a 01 0a");
  const c = P.decodeTriggerConfig(r, true);
  assert.equal(c.unitMm, 0.01);
  assert.equal(c.maxUnits, 400);
  assert.equal(c.maxMm, 4);
  assert.equal(c.minUnits, 10);
  assert.equal(c.minMm, 0.1);
  assert.equal(c.rtMaxMm, 2);
  // Low precision, unit byte 0 -> 10/100 = 0.1 mm, min 0 -> 1 unit.
  const d = P.decodeTriggerConfig(fromHex("21 00 00 00 18 04 28 00 00 00 00"), false);
  assert.equal(d.unitMm, 0.1);
  assert.equal(d.maxUnits, 40);
  assert.equal(d.minUnits, 1);
});

test("per-key trigger, poll rate, profile, SOCD and status replies", () => {
  const t = P.decodeKeyTrigger(fromHex("21 00 00 00 18 05 0d 78 78 0f 14 01 01 00 00 03 04"), 70);
  assert.deepEqual(t, { index: 70, mode: 13, travel: 0x178, press: 15, release: 20 });
  assert.ok(P.replyRule(P.encodeKeyTriggerRead(70))!.match(fromHex("21 00 00 00 18 05 0d 78 78 0f 14 01 01 00 00 03 04")));
  assert.ok(!P.replyRule(P.encodeKeyTriggerRead(68))!.match(fromHex("21 00 00 00 18 05 0d 78 78 0f 14 01 01 00 00 03 04")));
  assert.deepEqual(P.decodePollRate(fromHex("21 00 00 00 01 09 08")), { code: 8, hz: 8000 });
  assert.deepEqual(P.decodeProfileIndex(fromHex("21 00 00 00 00 11 02 01")), { index: 2, fromQuery: true });
  const socd = fromHex("24 01 00 00 28 01 00 04 07 07 ff ff ff 00 00 00 00 01 02 1a 16");
  assert.deepEqual(P.decodeSocdPages([socd]), [
    { index: 0, state: 1, mode: 0, key1: 4, key2: 7 },
    { index: 3, state: 1, mode: 2, key1: 0x1a, key2: 0x16 },
  ]);
  assert.deepEqual(P.decodeSocdPower(fromHex("24 02 00 00 06 01 00 00 00 04 07")), { on: true, key1: 4, key2: 7 });
  // supportData bytes 5..22: socd (n[9]), poll rate + dead band (n[12] 0x18), high precision + RS (n[13] 0x09), win lock (n[15] 1), storing (n[17] 2).
  const s = P.decodeStatus(fromHex("01 00 00 00 00 01 00 00 00 00 00 00 00 00 01 00 00 18 09 01 01 00 02"));
  assert.ok(s.flags.socd && s.flags.pollRate && s.flags.deadBand && s.flags.highPrecision && s.flags.rs && s.flags.calibrated && s.flags.storing);
  assert.ok(s.winLock.lockWin && !s.winLock.lockAltTab);
  assert.ok(P.isStoring(fromHex("01 00 00 00 00 01 00 00 00 00 00 00 00 00 01 00 00 18 09 01 01 00 02")));
  const prod = new Uint8Array(63);
  const text = "1,2,3,4,AK1680UKX68ZAXHEARGB,V1_0_3";
  prod[0] = 0x0d; prod[4] = text.length;
  prod.set(Array.from(text, (ch) => ch.charCodeAt(0)), 5);
  assert.deepEqual(
    { product: P.decodeProduct([prod]).product, firmware: P.decodeProduct([prod]).firmware },
    { product: "AK1680UKX68ZAXHEARGB", firmware: "1.0.3" },
  );
  const modes = fromHex("0a 00 00 00 0d 00 01 02 03 04 07 08 09 0a 00 00 03 04");
  assert.deepEqual(P.decodeLightModes(modes), { modes: [0, 1, 2, 3, 4, 7, 8, 9, 10], maxBrightness: 4, maxSpeed: 3 });
});

// ---------------------------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------------------------

test("destructive commands are blocked", () => {
  const cases: [string, string][] = [
    ["0b", "bootloader"], // WA.enterBootloader: oC (11)
    ["14 00 00 00 01 01", "keyboard reset"], // WA.resetKeyboard (Factory Reset)
    ["14 02", "factory reset"], // WA.factoryReset / getSleepTimer
    ["14 03 00 00 01 01", "gamepad mode"], // Nl.setGamePadMode
    ["21 00 00 00 18 06", "reset triggers"], // XA.resetTrigger
    ["21 00 00 00 18 07 03 04", "calibration"], // XA.reviseKey
    ["21 00 00 00 18 08", "calibration"], // XA.startAllKey
    ["21 00 00 00 18 08 01", "calibration"], // XA.stopAllKey
    ["21 00 00 00 18 0f", "calibration"], // XA.startAnyKey
    ["21 00 00 00 18 10", "calibration"], // XA.stopAnyKey
    ["23 00 00 00 00 01", "adc"], // XA.openADC
    ["25 01 00 00 3a 01 01", "switch type"], // PA.setKeyAxis
  ];
  for (const [frame, name] of cases) {
    const r = P.checkFrame(fromHex(frame));
    assert.equal(r.ok, false, frame);
    assert.equal(r.name, name, frame);
    assert.throws(() => P.assertSendable(fromHex(frame)));
  }
  // Not destructive, but not on the allowlist either.
  for (const frame of ["21 00 00 00 18 02", "21 00 00 00 18 03", "17 00 00 00 02 01 01", "19 00 00 00 3a 01", "19 03 00 00 01", "09 00 00 00 36 ff", "14 01 00 00 00 00 00 00 00 3c", "99", "18 01", "22 28 00 00 32 01"])
    assert.equal(P.checkFrame(fromHex(frame)).ok, false, frame);
  // A trigger write with a bitmap byte above row 5, or travel 0, is refused.
  const bad = P.encodeTriggerWrite({ mode: 0, travel: 10, press: 0, release: 0 }, [22]);
  bad[6] = 0x40;
  assert.equal(P.checkFrame(bad).ok, false);
  assert.throws(() => P.encodeTriggerWrite({ mode: 6, travel: 10, press: 0, release: 0 }, [22]));
  assert.throws(() => P.encodeTriggerWrite({ mode: 0, travel: 0, press: 0, release: 0 }, [22]));
  assert.throws(() => P.encodePollRateWrite(500));
  // Random junk never passes as a write unless it is exactly a known shape.
  for (let n = 0; n < 20000; n++) {
    const f = new Uint8Array(63);
    f[0] = [0x0b, 0x14, 0x21, 0x23, 0x25][rnd(5)];
    for (let i = 1; i < 8; i++) f[i] = rnd(4) ? 0 : rnd(256);
    const r = P.checkFrame(f);
    if (f[0] === 0x0b || f[0] === 0x23) assert.equal(r.ok, false);
    if (f[0] === 0x14 && f[5] !== 0) assert.equal(r.ok, false);
    if (f[0] === 0x21 && [6, 7, 8, 15, 16].includes(f[5])) assert.equal(r.ok, false);
    if (f[0] === 0x25 && f[1] === 1) assert.equal(r.ok, false);
  }
});

test("every read request is allowlisted and has a reply rule", () => {
  const reads = [
    P.encodeStatus(), P.encodeProduct(), P.encodeSerial(), P.encodeFnEditable(), P.encodeLightModes(), P.encodeLightModes(true), P.encodeLightRead(), P.encodeLightRead(true),
    P.encodeKeymapRead("default"), P.encodeKeymapRead("fn"), P.encodeMacroRead(0), P.encodeMacroRead(9), P.encodeAdvancedRead(), P.encodeSocdListRead(), P.encodeSocdPowerRead(),
    P.encodeTriggerConfigRead(), P.encodeKeyTriggerRead(22), P.encodeKeyTriggerRead(126), P.encodePollRateRead(), P.encodeProfileQuery(), P.encodeSwitchListRead(), P.encodeKeySwitchRead(), P.encodeDeadbandRead(),
  ];
  for (const f of reads) {
    const c = P.checkFrame(f);
    assert.ok(c.ok && c.access === "read", h(f));
    assert.ok(P.replyRule(f), h(f));
  }
});

// ---------------------------------------------------------------------------------------------
// Layouts (matrix indexes from illumipc's config/keys/<product>.json files)
// ---------------------------------------------------------------------------------------------

const ANSI_INDEXES = [22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 36, 38, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 58, 60, 66, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 80, 82, 88, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 101, 103, 104, 110, 111, 112, 116, 119, 121, 122, 124, 125, 126];
const ISO_INDEXES = [...ANSI_INDEXES.filter((i) => i !== 58), 79, 89].sort((a, b) => a - b);

test("layouts match illumipc's key indexes", () => {
  assert.deepEqual(X68_LAYOUTS.ansi.keys.map((k) => k.index).sort((a, b) => a - b), ANSI_INDEXES);
  for (const id of ["iso", "iso-uk", "iso-br"] as const) assert.deepEqual(X68_LAYOUTS[id].keys.map((k) => k.index).sort((a, b) => a - b), ISO_INDEXES, id);
  assert.equal(X68_LAYOUTS.ansi.keys.length, 68);
  assert.equal(X68_LAYOUTS["iso-uk"].keys.length, 69);
  // Factory entries: A = 04, Fn = 01 fa, UK '#' key sends 0x32, BR Ro sends 0x87.
  const at = (id: keyof typeof X68_LAYOUTS, i: number) => X68_LAYOUTS[id].keys.find((k) => k.index === i)!.factory;
  assert.deepEqual(at("ansi", 68), [0, 0x04, 0, 0]);
  assert.deepEqual(at("ansi", 121), [1, 0xfa, 0, 0]);
  assert.deepEqual(at("iso-uk", 79), [0, 0x32, 0, 0]);
  assert.deepEqual(at("iso-br", 99), [0, 0x87, 0, 0]);
  assert.deepEqual(at("iso-uk", 38), [0, 0x4a, 0, 0]);
  // Rows never overlap and stay inside 16 x 5 units.
  for (const l of Object.values(X68_LAYOUTS)) {
    for (const a of l.keys) {
      assert.ok(a.x >= 0 && a.x + a.w <= 16 && a.y >= 0 && a.y + a.h <= 5, `${l.id} ${a.index}`);
      for (const b of l.keys) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${l.id} ${a.index}/${b.index} overlap`);
    }
  }
  assert.equal(layoutForProduct("AK1680UKX68ZAXHEARGB")?.layout.id, "iso-uk");
  assert.equal(layoutForProduct("AK1680BRX68ZAXHEARGB")?.layout.id, "iso-br");
  assert.equal(layoutForProduct("AK1680GUSHEARGB")?.layout.id, "ansi");
  assert.equal(layoutForProduct("AK1680GUSHEARGB")?.known, false);
  assert.equal(layoutForProduct("SI2828HEARGB"), null);
});
