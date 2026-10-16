// Checks src/lib/brands/monsgeek (codec, units, paging, allowlist) without any device.
// Run: node --test scripts/monsgeek-codec.test.ts
//
// Evidence:
//  1. Golden bytes from sharkfin's Rust tests (GPL-3.0; protocol/tests.rs, hall.rs) and the MonsGeek web
//     driver's documented byte positions.
//  2. Mirror builders: line-by-line ports of FCC's frame() / sendKey / sendKeyLayer / sendMagnetism /
//     writeLed / writeSettings (app/src/hid/ry.ts, GPL-3.0), compared with SYNQ's encoders over many
//     random inputs.
//  3. The allowlist: everything the encoders build passes, every blocked opcode is refused, fuzzed and
//     mutated frames never get a blocked opcode through, and the frame builder can't produce one.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/lib/brands/monsgeek/protocol.ts";
import { MONSGEEK_BRIDGE, MONSGEEK_GUARD, classifyFrame, createGuard } from "../src/lib/brands/monsgeek/guard.ts";
import { L478, L487, MONSGEEK_DEVICES, MONSGEEK_MODELS, keyPositions, modelByDevId } from "../src/lib/brands/monsgeek/devices.ts";

let seed = 20261013;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const hex = (f: Uint8Array, n = 16) => P.hexBytes(f, n);
const frame64 = (bytes: number[]) => {
  const f = new Uint8Array(64);
  f.set(bytes);
  return f;
};
const withSum = (bytes: number[], at: 7 | 8 = 7) => {
  const f = frame64(bytes);
  f[at] = P.checksum(f, at);
  return f;
};

// ---------------------------------------------------------------------------------------------
// FCC mirrors (app/src/hid/ry.ts)
// ---------------------------------------------------------------------------------------------

/** FCC frame(bytes, sum): bytes from 0, checksum at 7 (bit7) or 8 (bit8). */
function fccFrame(bytes: ArrayLike<number>, sum: "bit7" | "bit8" = "bit7") {
  const out = new Uint8Array(64);
  out.set(Array.from(bytes).slice(0, 64));
  if (sum === "bit7") out[7] = 255 - (out.slice(0, 7).reduce((a, b) => a + b, 0) & 0xff);
  if (sum === "bit8") out[8] = 255 - (out.slice(0, 8).reduce((a, b) => a + b, 0) & 0xff);
  return out;
}
/** FCC sendKey: [SET_KEYMATRIX, profile, pos, 0, 0, 1, layer, 0, ...e]. */
const fccSendKey = (profile: number, layer: number, pos: number, e: readonly number[]) => fccFrame([0x0a, profile, pos, 0, 0, 1, layer, 0, ...e]);
/** FCC sendKeyLayer: 56-byte pages [0x0A, profile, 0xFF, page, len, last, layer, 0, ...data]. */
function fccSendKeyLayer(profile: number, layer: number, table: Uint8Array) {
  const pages = Math.ceil(table.length / 56);
  const out: Uint8Array[] = [];
  for (let page = 0; page < pages; page++) {
    const chunk = table.slice(page * 56, page * 56 + 56);
    const data = new Uint8Array(56);
    data.set(chunk);
    out.push(fccFrame([0x0a, profile, 0xff, page, chunk.length, page === pages - 1 ? 1 : 0, layer, 0, ...data]));
  }
  return out;
}
/** FCC sendMagnetism, single-key packets: [0x65, sub, 0, pos, commit, 0, 0, 0, ...bytes], commit on the last. */
function fccMagnetism(list: { sub: number; pos: number; bytes: number[] }[]) {
  const packets = list.map((x) => [x.sub, 0, x.pos, 0, 0, 0, 0, ...x.bytes]);
  return packets.map((pk, i) => {
    pk[3] = i === packets.length - 1 ? 1 : 0;
    return fccFrame([0x65, ...pk]);
  });
}
/** FCC writeLed: [SET_LEDPARAM, effect, speed, bright, option, r, g, b], bit8. */
const fccLed = (mode: number, speed: number, bright: number, option: number, r: number, g: number, b: number) => fccFrame([0x07, mode, speed, bright, option, r, g, b], "bit8");

// ---------------------------------------------------------------------------------------------
// Checksums and golden frames
// ---------------------------------------------------------------------------------------------

test("checksums match sharkfin's tests and the documented F7 example", () => {
  assert.equal(P.encodeIdentify()[7], 0xff - 0x8f); // sharkfin checksum_bit7
  assert.equal(P.checksum(frame64([0x07, 0x01]), 8), 0xff - 0x08); // sharkfin checksum_bit8
  assert.equal(P.checksum(frame64([0xf7]), 7), 0x08); // echtzeit docs, F7 example
  assert.equal(hex(P.encodeIdentify(), 9), "8f 00 00 00 00 00 00 70 00");
  assert.equal(hex(P.encodeFeatureList(), 8), "e6 00 00 00 00 00 00 19");
  assert.equal(hex(P.encodePollingWrite(1000), 8), "03 00 03 00 00 00 00 f9");
  assert.equal(hex(P.encodePollingWrite(8000), 8), "03 00 00 00 00 00 00 fc");
  assert.equal(hex(P.encodeProfileWrite(2), 8), "04 02 00 00 00 00 00 f9");
  assert.equal(hex(P.encodeDebounceWrite(5), 8), "06 05 00 00 00 00 00 f4");
  // Lighting: Bit8, checksum at byte 8 over 0..7: 7+1+2+4+8+255 = 277 -> 255 - 21 = 0xEA.
  const led = P.encodeLightingWrite({ mode: 1, speedWire: 2, brightness: 4, option: 0x08, r: 255, g: 0, b: 0 });
  assert.equal(hex(led, 10), "07 01 02 04 08 ff 00 00 ea 00");
  for (const f of [P.encodeIdentify(), P.encodePollingWrite(500), led, P.encodeKeyWrite(1, 42, 0, P.ENTRY.key(0x4a))]) assert.ok(P.checksumOk(f));
});

test("sharkfin golden: single-key table packet and DKS bindings", () => {
  // hall.rs single_slot_packet_matches_the_handler: [SET, TRAVEL, 0, 5, 1], value at 8..9.
  const p = P.encodeTableWrite(P.TABLE.actuation, 5, 200, true);
  assert.deepEqual(Array.from(p.subarray(0, 5)), [0x65, 0, 0, 5, 1]);
  assert.deepEqual([p[8], p[9]], [200, 0]);
  const m = P.encodeTableWrite(P.TABLE.mode, 3, 0x80, false);
  assert.deepEqual([m[4], m[8], m[9]], [0, 0x80, 0]);
  const d = P.encodeDksBindingsWrite(7, [1, 2, 3, 4], true);
  assert.deepEqual(Array.from(d.subarray(0, 5)), [0x65, 8, 0, 7, 1]);
  assert.deepEqual(Array.from(d.subarray(8, 12)), [1, 2, 3, 4]);
  assert.throws(() => P.encodeTableWrite(P.TABLE.actuation, 128, 1, true), /position/);
});

test("sharkfin golden: gen2 keymap packets", () => {
  // tests.rs gen2_keymap_packets_match_the_vendor_shapes
  const pkt = P.encodeKeyWrite(1, 42, 0, [0, 0, 74, 0]);
  assert.deepEqual(Array.from(pkt.subarray(0, 7)), [0x0a, 1, 42, 0, 0, 1, 0]);
  assert.deepEqual(Array.from(pkt.subarray(8, 12)), [0, 0, 74, 0]);
  const table = new Uint8Array(512);
  for (let p = 0; p < 128; p++) table.set([0, 0, 4 + (p % 50), 0], p * 4);
  const pages = P.encodeSublayerWrite(0, 0, table);
  assert.equal(pages.length, 10);
  assert.deepEqual(Array.from(pages[0].subarray(0, 6)), [0x0a, 0, 0xff, 0, 56, 0]);
  assert.deepEqual(Array.from(pages[9].subarray(0, 6)), [0x0a, 0, 0xff, 9, 8, 1]);
  assert.deepEqual(Array.from(pages[9].subarray(8, 16)), Array.from(table.subarray(504, 512)));
  assert.equal(pages[9][16], 0, "tail padded with zeros");
  // Rebuild the table from the pages.
  const back = new Uint8Array(512);
  for (const f of pages) back.set(f.subarray(8, 8 + f[4]), f[3] * 56);
  assert.deepEqual(back, table);
});

test("sharkfin golden: identify reply and LED white sentinel", () => {
  const reply = new Uint8Array(64);
  reply[0] = 0x8f;
  reply.set([0xaf, 0x07, 0, 0], 1); // 1967
  reply.set([0x09, 0x03], 7);
  assert.deepEqual(P.decodeIdentify(reply), { devId: 1967, firmware: 0x0309, boot: false });
  reply[9] = 1;
  assert.equal(P.decodeIdentify(reply)!.boot, true);
  reply.set([0xff, 0xff, 0xff, 0xff], 1);
  assert.equal(P.decodeIdentify(reply), null, "0xFFFFFFFF is 'no id'");
  // White goes out as FA FA FA and comes back as white; speed 3 survives. (tests.rs led_white_sentinel_round_trips)
  const w = P.lightingToWire({ mode: 1, speed: 3, brightness: 4, variant: 0, colour: "fixed", rgb: [255, 255, 255] }, L478);
  assert.deepEqual([w.r, w.g, w.b], [0xfa, 0xfa, 0xfa]);
  assert.equal(w.speedWire, 1);
  const back = P.lightingFromWire(w, L478);
  assert.deepEqual(back.rgb, [255, 255, 255]);
  assert.equal(back.speed, 3);
  assert.equal(back.colour, "fixed");
});

// ---------------------------------------------------------------------------------------------
// Encoders vs FCC mirrors
// ---------------------------------------------------------------------------------------------

test("key writes, sub-layer pages, table batches and lighting match FCC byte for byte", () => {
  for (let n = 0; n < 300; n++) {
    const profile = rnd(4), layer = rnd(4), pos = rnd(128);
    const e = P.ENTRY.key(4 + rnd(100), rnd(256));
    assert.deepEqual(P.encodeKeyWrite(profile, pos, layer, e), fccSendKey(profile, layer, pos, e));
  }
  for (let n = 0; n < 20; n++) {
    const t = new Uint8Array(512);
    for (let p = 0; p < 128; p++) t.set(rnd(3) ? P.ENTRY.key(4 + rnd(100)) : rnd(2) ? P.ENTRY.consumer(0xe9) : P.ENTRY.none(), p * 4);
    const profile = rnd(4), layer = rnd(4);
    assert.deepEqual(P.encodeSublayerWrite(profile, layer, t), fccSendKeyLayer(profile, layer, t));
  }
  for (let n = 0; n < 100; n++) {
    const list = Array.from({ length: 1 + rnd(10) }, () => {
      const sub = [0, 1, 2, 3, 4, 6, 5, 7, 9][rnd(9)];
      const pos = rnd(128);
      const v = sub === 7 ? P.KINDS[rnd(P.KINDS.length)] | (rnd(2) ? 0x80 : 0) : sub === 9 ? (pos + 1) % 128 : sub === 5 ? 1 + rnd(255) : sub === 6 ? rnd(300) : 1 + rnd(400);
      return { sub, pos, v };
    });
    const ours = P.encodeTableBatch(list.map((x) => ({ table: x.sub, pos: x.pos, value: x.v })));
    const fcc = fccMagnetism(list.map((x) => ({ sub: x.sub, pos: x.pos, bytes: P.U16_TABLES.includes(x.sub) ? [x.v & 0xff, x.v >> 8] : [x.v] })));
    assert.deepEqual(ours, fcc);
  }
  for (let n = 0; n < 200; n++) {
    const modes = Object.keys(P.LIGHT_MODES).map(Number);
    const mode = modes[rnd(modes.length)];
    const variant = rnd(P.variantsOf(mode));
    const nibble = mode === P.USER_PICTURE_MODE ? 0 : [7, 8][rnd(2)];
    const w = { mode, speedWire: rnd(5), brightness: rnd(5), option: (variant << 4) | nibble, r: rnd(256), g: rnd(256), b: rnd(256) };
    assert.deepEqual(P.encodeLightingWrite(w), fccLed(w.mode, w.speedWire, w.brightness, w.option, w.r, w.g, w.b));
  }
  // writeSettings: [SET_REPORT, 0, code], [SET_DEBOUNCE, ms], [SET_KBOPTION, 0, fn, anti, stab, wasd]
  for (let code = 0; code <= 6; code++) assert.deepEqual(P.encodePollingWrite(P.POLL_CODE_HZ[code]), fccFrame([0x03, 0, code]));
  for (let ms = 0; ms <= 10; ms++) assert.deepEqual(P.encodeDebounceWrite(ms), fccFrame([0x06, ms]));
  for (let n = 0; n < 50; n++) {
    const o = { fnIndex: rnd(2), antiMistouch: !!rnd(2), rtStabilityMs: 25 * rnd(6), wasdSwap: !!rnd(2) };
    assert.deepEqual(P.encodeOptionsWrite(o), fccFrame([0x09, 0, o.fnIndex, o.antiMistouch ? 1 : 0, o.rtStabilityMs / 25, o.wasdSwap ? 1 : 0]));
  }
  // Reads: magTable [0xE5, sub, 1, page], keyLayer [0x8A, profile, 0xFF, page, layer]
  for (const t of P.READ_TABLES) P.encodeTableReadAll(t).forEach((f, page) => assert.deepEqual(f, fccFrame([0xe5, t, 1, page])));
  for (let l = 0; l < 4; l++) P.encodeKeymapReadAll(2, l).forEach((f, page) => assert.deepEqual(f, fccFrame([0x8a, 2, 0xff, page, l])));
});

// ---------------------------------------------------------------------------------------------
// Units and paging
// ---------------------------------------------------------------------------------------------

test("travel units: feature list first, firmware fallback (FCC / web driver thresholds)", () => {
  const fl = (code: number) => frame64([0xe6, 0xaa, code]);
  assert.deepEqual(P.unitMm(fl(0), 0x0200), { unitMm: 0.01, source: "featureList" });
  assert.deepEqual(P.unitMm(fl(1), 0x0200), { unitMm: 0.005, source: "featureList" });
  assert.deepEqual(P.unitMm(fl(2), 0x0200), { unitMm: 0.001, source: "featureList" });
  assert.equal(P.unitMm(fl(9), 0x0200).unitMm, 0.01, "unknown code: the web driver's default");
  const echoed = frame64([0xe6]); // firmware without a feature list echoes the request [SF]
  assert.deepEqual(P.unitMm(echoed, 0x02ff), { unitMm: 0.1, source: "firmware" });
  assert.equal(P.unitMm(echoed, 768).unitMm, 0.01);
  assert.equal(P.unitMm(echoed, 0x0309).unitMm, 0.01);
  assert.equal(P.unitMm(null, 1279).unitMm, 0.01);
  assert.equal(P.unitMm(null, 1280).unitMm, 0.005);
  assert.equal(P.unitMm(null, 0x0507).unitMm, 0.005);
  assert.equal(P.unitMm(null, null).unitMm, 0.1);
  assert.equal(P.unitMm(null, 0x0507, 0x0200).unitMm, 0.1, "a non-zero rf version wins (web driver: rf || usb)");
  // sharkfin gen2_units: 2.0 mm = 200 counts at 0.01, 400 at 0.005; 810 counts at 0.005 = 4.05 mm.
  assert.equal(P.mmToWire(2.0, 0.01), 200);
  assert.equal(P.mmToWire(2.0, 0.005), 400);
  assert.equal(P.mmToWire(0.3, 0.001), 300);
  assert.equal(P.mmToWire(0.55, 0.1), 6, "rounds to the nearest count");
  assert.equal(P.wireToMm(810, 0.005), 4.05);
  assert.equal(P.wireToMm(50, 0.01), 0.5);
  for (let n = 0; n < 500; n++) {
    const unit = [0.1, 0.01, 0.005, 0.001][rnd(4)];
    const counts = rnd(3400);
    assert.equal(P.mmToWire(P.wireToMm(counts, unit), unit), counts);
  }
  // yc500 columns: tenths offset by one (sharkfin yc500_units_carry_the_one_tenth_offset)
  assert.equal(P.ycColumnMm(P.TABLE.actuation, 18), 1.9);
  assert.equal(P.ycColumnMm(P.TABLE.release, 28), 2.9);
  assert.equal(P.ycColumnMm(P.TABLE.rtPress, 2), 0.3);
  assert.equal(P.ycColumnMm(P.TABLE.deadzone, 33), 0.6);
  assert.equal(P.ycColumnMm(P.TABLE.dksPoint, 2), 0.4);
});

test("table and keymap paging", () => {
  assert.equal(P.encodeTableReadAll(P.TABLE.actuation).length, 4);
  assert.equal(P.encodeTableReadAll(P.TABLE.liveTravel).length, 4);
  assert.equal(P.encodeTableReadAll(P.TABLE.mode).length, 2);
  assert.equal(P.encodeTableReadAll(P.TABLE.snap).length, 2);
  assert.equal(P.encodeTableReadAll(P.TABLE.dksBindingsGet).length, 8);
  assert.equal(P.readPages(P.TABLE.actuation, "yc500"), 2);
  assert.throws(() => P.encodeTableRead(P.TABLE.actuation, 4), /page/);
  assert.throws(() => P.encodeTableRead(P.TABLE.dksBindingsSet, 0), /isn't one SYNQ reads/);
  assert.throws(() => P.encodeTableRead(252, 0), /isn't one SYNQ reads/);
  // u16 decode across page boundaries
  const values = Array.from({ length: 128 }, (_, p) => 100 + p * 7);
  const raw = new Uint8Array(256);
  values.forEach((v, p) => raw.set([v & 0xff, v >> 8], p * 2));
  const pages = [0, 1, 2, 3].map((i) => raw.slice(i * 64, i * 64 + 64));
  assert.deepEqual(Array.from(P.decodeU16Table(pages)), values);
  // DKS rows: four 128-byte blocks
  const dks = new Uint8Array(512).map((_, i) => i & 0xff);
  const rows = P.decodeDksBindings(Array.from({ length: 8 }, (_, i) => dks.slice(i * 64, i * 64 + 64)));
  assert.equal(rows[2][5], (256 + 5) & 0xff);
  assert.equal(P.decodeDksBindings(Array.from({ length: 8 }, (_, i) => dks.slice(i * 64, i * 64 + 64)), 126)[1].length, 126);
  assert.deepEqual(P.unpackDksRow(P.packDksRow([3, 2, 0, 1])), [3, 2, 0, 1]);
  assert.equal(P.packDksRow([3, 2, 0, 0]), 0b1011, "hold from A to C = 3, 2, 0, 0 (sharkfin)");
  // keymap reads: 8 pages
  assert.equal(P.encodeKeymapReadAll(0).length, 8);
  assert.throws(() => P.encodeKeymapRead(4, 0), /profile/);
  assert.throws(() => P.encodeKeymapRead(0, 8), /page/);
  // yc500 keymap slot = profile * 4 + sub-layer
  assert.deepEqual(Array.from(P.ycEncodeKeymapRead(2, 5, 1).subarray(0, 4)), [0x89, 9, 5, 0]);
});

test("decoders round-trip", () => {
  const opt = { fnIndex: 1, antiMistouch: true, rtStabilityMs: 75, wasdSwap: true };
  const w = P.encodeOptionsWrite(opt);
  const reply = frame64([0x89, 1, w[2], w[3], w[4], w[5]]);
  const d = P.decodeOptions(reply);
  assert.deepEqual({ fnIndex: d.fnIndex, antiMistouch: d.antiMistouch, rtStabilityMs: d.rtStabilityMs, wasdSwap: d.wasdSwap }, opt);
  assert.equal(d.os, "mac");
  assert.equal(P.decodeOptions(frame64([0x89, 0, 0, 0, 9])).rtStabilityMs, 0, "a level above 5 reads as 0");
  for (let n = 0; n < 200; n++) {
    const light = rnd(2) ? L478 : L487;
    const modes = Object.keys(P.LIGHT_MODES).map(Number);
    const mode = modes[rnd(modes.length)];
    const l: P.Lighting = { mode, speed: rnd(5), brightness: rnd(5), variant: rnd(P.variantsOf(mode)), colour: mode === 13 ? "none" : rnd(2) ? "rainbow" : "fixed", rgb: [rnd(255), rnd(255), rnd(255)] };
    const wire = P.lightingToWire(l, light);
    const rep = frame64([0x87, wire.mode, wire.speedWire, wire.brightness, wire.option, wire.r, wire.g, wire.b]);
    const back = P.lightingFromWire(P.decodeLightingWire(rep), light);
    assert.equal(back.mode, l.mode);
    assert.equal(back.speed, l.speed);
    assert.equal(back.brightness, l.brightness);
    assert.equal(back.variant, l.variant);
    if (mode !== 13) assert.equal(back.colour, l.colour);
    if (mode !== 13) assert.deepEqual(back.rgb, l.rgb);
  }
  assert.equal(P.lightingFromWire({ mode: 2, speedWire: 0, brightness: 4, option: 0x03, r: 9, g: 9, b: 9 }, L478).colour, "preset");
  assert.equal(P.decodePolling(frame64([0x83, 0, 3])), 1000);
  assert.equal(P.decodePolling(frame64([0x83, 0, 9])), null);
  assert.equal(P.ycDecodeDebounce(frame64([0x91, 0, 4])), 4);
  assert.deepEqual(P.ycDecodeOptions(frame64([0x86, 0, 1 | 8 | 128, 1, 0])).keyboardLock, true);
  assert.equal(P.decodeRfVersion(frame64([0x80])), null, "gen2 answers zeros over the cable");
  assert.equal(P.decodeRfVersion(frame64([0x80, 0x05, 0x04])), 0x0405);
  assert.equal(P.formatRevision(0x0200), "2.00");
  const fl = P.decodeFeatureList(frame64([0xe6, 0xaa, 1, 0, 1, 0, 1]));
  assert.deepEqual(fl, { supported: true, precisionCode: 1, altTab: true, altF4: false, winLock: true });
  assert.throws(() => P.decodeProfile(frame64([0x83, 1])), /Expected an answer/);
});

test("encoders refuse out-of-range values", () => {
  assert.throws(() => P.encodePollingWrite(3000));
  assert.throws(() => P.encodeDebounceWrite(11));
  assert.throws(() => P.encodeProfileWrite(4));
  assert.throws(() => P.encodeOptionsWrite({ fnIndex: 0, antiMistouch: false, rtStabilityMs: 30, wasdSwap: false }));
  assert.throws(() => P.encodeLightingWrite({ mode: 21, speedWire: 0, brightness: 0, option: 7, r: 0, g: 0, b: 0 }), /isn't one SYNQ writes/);
  assert.throws(() => P.encodeLightingWrite({ mode: 1, speedWire: 5, brightness: 0, option: 7, r: 0, g: 0, b: 0 }));
  assert.throws(() => P.encodeLightingWrite({ mode: 1, speedWire: 0, brightness: 0, option: 0x17, r: 0, g: 0, b: 0 }), /variant/);
  assert.throws(() => P.encodeLightingWrite({ mode: 4, speedWire: 0, brightness: 0, option: 0x03, r: 0, g: 0, b: 0 }), /nibble/);
  assert.throws(() => P.encodeTableWrite(P.TABLE.actuation, 0, 0, true));
  assert.throws(() => P.encodeTableWrite(P.TABLE.actuation, 0, 4001, true));
  assert.throws(() => P.encodeTableWrite(P.TABLE.mode, 0, 6, true));
  assert.throws(() => P.encodeTableWrite(P.TABLE.snap, 4, 4, true), /partner/);
  assert.throws(() => P.encodeTableWrite(P.TABLE.liveTravel, 0, 1, true));
  assert.throws(() => P.encodeTableWrite(11, 0, 1, true));
  assert.throws(() => P.encodeKeyWrite(0, 0, 0, [2, 0, 0, 0]));
  assert.throws(() => P.encodeKeyWrite(0, 0, 4, P.ENTRY.none()));
  const bad = new Uint8Array(512);
  bad.set([7, 1, 1, 1], 40);
  assert.throws(() => P.encodeSublayerWrite(0, 0, bad), /Position 10/);
  assert.throws(() => P.encodeSublayerWrite(0, 0, new Uint8Array(500)));
});

// ---------------------------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------------------------

/** Every frame the encoders can build, over many inputs. */
function allEncoderFrames(): { f: Uint8Array; scope: "identify" | "gen2" | "yc500" }[] {
  const out: { f: Uint8Array; scope: "identify" | "gen2" | "yc500" }[] = [];
  const add = (f: Uint8Array, scope: "identify" | "gen2" | "yc500" = "gen2") => out.push({ f, scope });
  for (const f of [P.encodeIdentify(), P.encodeRfVersion(), P.encodeFeatureList()]) add(f, "identify");
  for (const f of [P.encodeProfileRead(), P.encodePollingRead(), P.encodeDebounceRead(), P.encodeLightingRead(), P.encodeOptionsRead()]) add(f);
  for (let p = 0; p < 4; p++) add(P.encodeProfileWrite(p));
  for (const hz of P.POLL_CODE_HZ) add(P.encodePollingWrite(hz));
  for (let ms = 0; ms <= 10; ms++) add(P.encodeDebounceWrite(ms));
  for (let n = 0; n < 40; n++) add(P.encodeOptionsWrite({ fnIndex: rnd(4), antiMistouch: !!rnd(2), rtStabilityMs: 25 * rnd(6), wasdSwap: !!rnd(2) }));
  for (const mode of Object.keys(P.LIGHT_MODES).map(Number))
    for (let v = 0; v < P.variantsOf(mode); v++)
      for (const nib of mode === 13 ? [0] : P.COLOUR_NIBBLES) add(P.encodeLightingWrite({ mode, speedWire: rnd(5), brightness: rnd(5), option: (v << 4) | nib, r: rnd(256), g: rnd(256), b: rnd(256) }));
  for (let p = 0; p < 4; p++) for (let l = 0; l < 4; l++) P.encodeKeymapReadAll(p, l).forEach((f) => add(f));
  for (const t of P.READ_TABLES) P.encodeTableReadAll(t).forEach((f) => add(f));
  const entries = (): P.KeyEntry => {
    switch (rnd(8)) {
      case 0: return P.ENTRY.none();
      case 1: return P.ENTRY.consumer(rnd(0x400));
      case 2: return P.ENTRY.mouse(rnd(5));
      case 3: return P.ENTRY.wheel(!!rnd(2));
      case 4: return P.ENTRY.fn();
      case 5: return [13, rnd(32), rnd(16), 0];
      case 6: return [19, rnd(16), rnd(16), 0];
      default: return P.ENTRY.key(rnd(0xe8), rnd(256));
    }
  };
  for (let n = 0; n < 400; n++) add(P.encodeKeyWrite(rnd(4), rnd(128), rnd(4), entries()));
  for (let n = 0; n < 15; n++) {
    const t = new Uint8Array(512);
    for (let p = 0; p < 128; p++) t.set(entries(), p * 4);
    P.encodeSublayerWrite(rnd(4), rnd(4), t).forEach((f) => add(f));
  }
  for (let n = 0; n < 300; n++) {
    const table = P.WRITE_TABLES[rnd(P.WRITE_TABLES.length)];
    const pos = rnd(128);
    let value: number | number[];
    if (table === 7) value = P.KINDS[rnd(6)] | (rnd(2) ? 0x80 : 0);
    else if (table === 8) value = [rnd(256), rnd(256), rnd(256), rnd(256)];
    else if (table === 9) value = rnd(4) ? (pos + 1 + rnd(127)) % 128 : P.SNAP_NONE;
    else {
      const lim = P.TABLE_LIMITS[table];
      value = lim.min + rnd(lim.max - lim.min + 1);
    }
    P.encodeTableBatch([{ table, pos, value }, { table: 7, pos, value: 0 }]).forEach((f) => add(f));
  }
  for (const f of [P.ycEncodeRevision(), P.ycEncodeProfileRead(), P.ycEncodeOptionsRead(), P.ycEncodeDebounceRead()]) add(f, "yc500");
  for (let p = 0; p < 5; p++) for (let l = 0; l < 4; l++) for (let page = 0; page < 8; page++) if (p * 4 + l <= P.YC_MAX_SLOT) add(P.ycEncodeKeymapRead(p, page, l), "yc500");
  for (const t of P.YC_READ_TABLES) for (let page = 0; page < P.readPages(t, "yc500"); page++) add(P.ycEncodeTableRead(t, page), "yc500");
  return out;
}

test("allowlist: every frame the encoders build passes (union guard and its own scope)", () => {
  const frames = allEncoderFrames();
  assert.ok(frames.length > 1500);
  for (const { f, scope } of frames) {
    const any = classifyFrame(f, "any");
    assert.notEqual(any.verdict, "blocked", `${hex(f)} -> ${any.verdict === "blocked" ? any.reason : ""}`);
    const own = classifyFrame(f, scope);
    assert.notEqual(own.verdict, "blocked", `${scope}: ${hex(f)}`);
    const viaGuard = MONSGEEK_GUARD.classify({ type: "feature", reportId: 0, data: f });
    assert.notEqual(viaGuard.verdict, "blocked");
  }
});

test("allowlist: scopes", () => {
  const frames = allEncoderFrames();
  for (const { f } of frames) {
    const isWrite = classifyFrame(f, "any").verdict === "write";
    // Nothing a yc500 board could take as a write passes the yc500 scope.
    if (isWrite) assert.equal(classifyFrame(f, "yc500").verdict, "blocked", `yc500 scope let ${hex(f)} through`);
    // The identify scope takes 0x8F / 0x80 / 0xE6 only (yc500's revision read is the same bare 0x80 frame).
    if (![0x8f, 0x80, 0xe6].includes(f[0])) assert.equal(classifyFrame(f, "identify").verdict, "blocked", hex(f));
  }
  assert.equal(classifyFrame(P.encodeIdentify(), "yc500").verdict, "read");
  // Output reports, other report ids and wrong lengths are refused.
  const g = createGuard("gen2");
  assert.equal(g.classify({ type: "output", reportId: 0, data: P.encodeIdentify() }).verdict, "blocked");
  assert.equal(g.classify({ type: "feature", reportId: 1, data: P.encodeIdentify() }).verdict, "blocked");
  assert.equal(g.classify({ type: "feature", reportId: 0, data: P.encodeIdentify().subarray(0, 63) }).verdict, "blocked");
});

test("allowlist: every blocked opcode is refused with its reason, in every shape", () => {
  for (const b of P.BLOCKED) {
    const shapes = [
      withSum([b.opcode]),
      withSum([b.opcode, 0x55, 0xaa, 0x55, 0xaa]),
      withSum([b.opcode, 1, 0, 0, 0, 0, 0], 8),
      frame64([b.opcode]),
      withSum([b.opcode, rnd(256), rnd(256), rnd(256), rnd(256), rnd(256), rnd(256)]),
    ];
    for (const f of shapes)
      for (const scope of ["identify", "gen2", "yc500", "any"] as const) {
        const v = classifyFrame(f, scope);
        assert.equal(v.verdict, "blocked");
        if (v.verdict === "blocked") assert.equal(v.why, b.why, `0x${b.opcode.toString(16)} in ${scope}`);
      }
  }
  // The ones the brief names.
  for (const [op, why] of [[0x01, "factory-reset"], [0x7f, "bootloader"], [0xac, "firmware"], [0x50, "identity"], [0x1c, "calibration"], [0x1e, "calibration"], [0x25, "firmware"], [0x12, "firmware"]] as const) {
    const v = classifyFrame(withSum([op]), "any");
    assert.ok(v.verdict === "blocked" && v.why === why, `0x${op.toString(16)}`);
  }
  // Unknown opcodes are refused as "unknown" (default deny).
  for (const op of [0x05, 0x08, 0x0b, 0x0c, 0x10, 0x11, 0x17, 0x8b, 0x8c, 0x90, 0x97, 0xad, 0xae, 0xe7, 0xfb, 0xff]) {
    const v = classifyFrame(withSum([op]), "any");
    assert.ok(v.verdict === "blocked" && v.why === "unknown", `0x${op.toString(16)}`);
  }
});

test("allowlist: blocked opcodes are unreachable from the encoders", () => {
  const encodable = new Set<number>([...Object.values(P.CMD), ...Object.values(P.YC)]);
  for (const b of P.BLOCKED) assert.ok(!encodable.has(b.opcode), `0x${b.opcode.toString(16)} is encodable`);
  for (let op = 0; op < 256; op++) {
    if (encodable.has(op)) {
      assert.doesNotThrow(() => P.buildFrame(op), `0x${op.toString(16)}`);
      continue;
    }
    assert.throws(() => P.buildFrame(op), /Refusing/, `0x${op.toString(16)} built`);
    assert.throws(() => P.buildFrame(op, [0x55, 0xaa, 0x55, 0xaa]), /Refusing/);
  }
  // And nothing any encoder produced has a blocked or unknown opcode.
  for (const { f } of allEncoderFrames()) assert.ok(encodable.has(f[0]) && !P.blockedOpcode(f[0]));
});

test("allowlist: fuzzed and mutated frames never let a blocked opcode through", () => {
  const valid = allEncoderFrames().map((x) => x.f);
  const encodable = new Set<number>([...Object.values(P.CMD), ...Object.values(P.YC)]);
  let passed = 0;
  for (let n = 0; n < 60000; n++) {
    let f: Uint8Array;
    switch (n % 4) {
      case 0: // random frame with a valid checksum
        f = new Uint8Array(64).map(() => (rnd(3) ? 0 : rnd(256)));
        f[0] = rnd(256);
        f[P.checksumAt(f[0])] = P.checksum(f, P.checksumAt(f[0]));
        break;
      case 1: // mutate a valid frame, fix the checksum
        f = valid[rnd(valid.length)].slice();
        for (let k = 0, m = 1 + rnd(3); k < m; k++) f[rnd(rnd(2) ? 12 : 64)] = rnd(4) ? rnd(256) : 0;
        f[P.checksumAt(f[0])] = P.checksum(f, P.checksumAt(f[0]));
        break;
      case 2: // a valid frame with a blocked opcode swapped in
        f = valid[rnd(valid.length)].slice();
        f[0] = P.BLOCKED[rnd(P.BLOCKED.length)].opcode;
        f[P.checksumAt(f[0])] = P.checksum(f, P.checksumAt(f[0]));
        break;
      default: // mutate without fixing the checksum
        f = valid[rnd(valid.length)].slice();
        f[rnd(64)] ^= 1 + rnd(255);
    }
    for (const scope of ["identify", "gen2", "yc500", "any"] as const) {
      const v = classifyFrame(f, scope);
      if (v.verdict === "blocked") continue;
      passed++;
      assert.ok(!P.blockedOpcode(f[0]), `blocked opcode 0x${f[0].toString(16)} passed in ${scope}`);
      assert.ok(encodable.has(f[0]), `unknown opcode 0x${f[0].toString(16)} passed`);
      assert.ok(P.checksumOk(f), `bad checksum passed: ${hex(f)}`);
      if (scope === "yc500" || scope === "identify") assert.equal(v.verdict, "read");
      // Passing writes stay within the vendor's shapes: no payload past the defined length.
      if (f[0] === P.CMD.setTable) assert.equal(f[2], 0, "bulk table pages are never allowed");
      if (f[0] === P.CMD.setKeymap && f[2] === 0xff) assert.ok(f[3] <= 9 && f[4] === (f[3] === 9 ? 8 : 56));
      if (f[0] === P.CMD.setLighting) assert.ok(f.subarray(9).every((b) => b === 0));
    }
  }
  assert.ok(passed > 1000, `only ${passed} fuzzed frames passed; the fuzz isn't reaching the allowed shapes`);
});

// ---------------------------------------------------------------------------------------------
// Devices and bridge allowances
// ---------------------------------------------------------------------------------------------

test("device table and bridge allowances", () => {
  const ids = new Set<number>();
  for (const m of MONSGEEK_MODELS) {
    assert.ok(!ids.has(m.devId), `duplicate dev id ${m.devId}`);
    ids.add(m.devId);
    assert.ok(m.sources.length > 0);
    assert.ok(m.profiles >= 1 && m.profiles <= 5);
    if (m.family === "yc500") assert.equal(m.tier, "readOnly");
    if (m.tier === "experimental") {
      assert.equal(m.family, "gen2");
      assert.ok(m.light && m.keyMask, `${m.devId} writable without lighting constants / key mask`);
      assert.equal(keyPositions(m)!.length, m.keys);
    }
  }
  assert.equal(modelByDevId(2307)?.name, "FUN60 Ultra");
  assert.equal(modelByDevId(1674)?.family, "yc500");
  assert.equal(modelByDevId(123456), undefined);
  assert.ok(MONSGEEK_DEVICES.some((d) => d.vendorId === 0x3151 && d.productId === 0x5030 && d.model.includes("FUN60")));
  for (const a of MONSGEEK_BRIDGE) {
    assert.equal(a.access, "featureOnly");
    assert.deepEqual(a.reportIds, [0]);
    assert.equal(a.length, 64);
    assert.equal(a.usagePage, 0xffff);
    assert.equal(a.usage, 2);
  }
  const pids = MONSGEEK_BRIDGE.flatMap((a) => a.productIds.map((p) => `${a.vendorId.toString(16)}:${p.toString(16)}`));
  for (const m of MONSGEEK_MODELS) for (const [v, p] of m.usb) assert.ok(pids.includes(`${v.toString(16)}:${p.toString(16)}`), `${m.name} ${v.toString(16)}:${p.toString(16)} missing from the bridge`);
  assert.ok(!pids.includes("3151:5026") && !pids.includes("3151:503a"), "receivers are not opened");
});
