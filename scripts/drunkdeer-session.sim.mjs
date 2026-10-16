// Headless end-to-end check of src/lib/brands/drunkdeer/session.ts against simulated DrunkDeer keyboards
// that answer the way the sources describe (official configurator handlers [antler], svumo/DrunkDeer-Control
// docs, HallJoy): echo every settings frame, answer 0xA0 with the identity, stream one depth round per
// "tracking on", answer pulls with 5 chunks, no answer to the old-dialect tracking stop. No hardware, no
// window: the fake implements the HidLike interface from src/lib/brands/local-kb.ts.
// Run: node scripts/drunkdeer-session.sim.mjs
import assert from "node:assert/strict";
import { DrunkDeerSession } from "../src/lib/brands/drunkdeer/session.ts";
import { DRUNKDEER_GUARD } from "../src/lib/brands/drunkdeer/guard.ts";
import { BlockedFrameError } from "../src/lib/brands/local-kb.ts";

const NEVER = new Set([0xf9, 0xaa, 0xa7, 0xa8, 0xab, 0xfb, 0xc1, 0xc2]);
const hex = (f) => Array.from(f, (b) => b.toString(16).padStart(2, "0")).join(" ");

class FakeKeyboard {
  constructor({ vendorId = 0x352d, productId = 0x2383, productName = "DrunkDeer Keyboard", typeBytes, fw, dialect, silent = false, quirks = {} }) {
    Object.assign(this, { vendorId, productId, productName, typeBytes, fw, dialect, silent, quirks });
    this.collections = [{ usagePage: 1, usage: 6 }, { usagePage: 0xff00, usage: 0 }];
    this.sent = [];
    this.violations = [];
    this.listeners = new Set();
    this.common = { turbo: 0, rt: 0, mode: 0, rtMatch: 0 };
    this.autoMatch = 255;
    this.lwReplace = 0;
    this.colour = { code: dialect === "newHighPrec" ? 3 : 2, speed: 5, brightness: 9, colour: 0 };
    const scale = { legacy: 10, oldHighPrec: 100, newHighPrec: 200 }[dialect];
    this.scale = scale;
    this.keys = { 1: new Array(126).fill(2 * scale), 4: new Array(126).fill(0), 5: new Array(126).fill(0) };
    this.lw = [[64, 66]];
    this.rdt = [];
    this.profiles = 3;
    this.depth = new Array(126).fill(0);
    this.depth[64] = 1.5; // A held halfway
  }
  emit(bytes) {
    const f = new Uint8Array(63);
    f.set(bytes.slice(0, 63));
    for (const l of this.listeners) setTimeout(() => l({ reportId: 4, data: new DataView(f.buffer) }), 1);
  }
  identity() {
    const f = new Array(63).fill(0);
    f[0] = 0xa0; f[1] = 2; f[2] = 0;
    [f[4], f[5], f[6]] = this.typeBytes;
    [f[7], f[8]] = this.fw;
    f[15] = this.common.turbo; f[16] = this.common.rt; f[18] = this.common.mode >> 1; f[19] = this.common.mode & 1;
    if (this.dialect === "newHighPrec") {
      f[20] = 1; f[22] = this.colour.code; f[23] = this.colour.speed; f[24] = this.colour.brightness;
      f[30] = this.autoMatch === 255 ? 0 : 1; f[31] = this.autoMatch === 255 ? 0 : this.autoMatch; f[32] = this.lwReplace;
    } else {
      for (let i = 20; i <= 33; i++) f[i] = 0x5a; // old firmwares: bytes SYNQ must not trust
      f[25] = 1;
    }
    return f;
  }
  // --- HidLike ---
  async sendReport(reportId, data) {
    assert.equal(reportId, 4, "report id");
    assert.equal(data.length, 63, "length");
    const f = Uint8Array.from(data);
    this.sent.push(f);
    if (NEVER.has(f[0]) || (f[0] === 0xa0 && f[2] === 4)) {
      this.violations.push(hex(f.subarray(0, 8)));
      throw new Error(`BLOCKED FRAME REACHED THE DEVICE: ${hex(f.subarray(0, 8))}`);
    }
    if (DRUNKDEER_GUARD.classify({ type: "output", reportId, data: f }).verdict === "blocked") this.violations.push(`unlisted ${hex(f.subarray(0, 8))}`);
    if (!this.silent) this.handle(f);
  }
  async sendFeatureReport() {
    throw new Error("feature reports are never used");
  }
  async receiveFeatureReport() {
    throw new Error("feature reports are never used");
  }
  addEventListener(type, l) {
    assert.equal(type, "inputreport");
    this.listeners.add(l);
  }
  removeEventListener(type, l) {
    this.listeners.delete(l);
  }
  // --- firmware ---
  handle(f) {
    const [c, s] = f;
    const echo = () => this.emit(Array.from(f));
    const hi = this.dialect === "newHighPrec";
    switch (c) {
      case 0xa0:
        return this.emit(this.identity());
      case 0xb5:
        this.common = { turbo: f[7], rt: f[8], mode: f[10], rtMatch: f[11] };
        if (this.quirks.turboStuck) this.common.turbo = 0;
        return echo();
      case 0xb6:
        if (hi) return; // the newHighPrec firmware silently ignores 0xB6 (svumo)
        if (s === 3) {
          if (!f[2]) return; // tracking stop: no answer (official LC special case)
          echo();
          for (let p = 0; p < 3; p++) {
            const n = p < 2 ? 59 : 8;
            this.emit([0xb7, 0, 0, p, ...this.depth.slice(p * 59, p * 59 + n).map((mm) => Math.round(mm * this.scale))]);
          }
          return;
        }
        for (let i = 0; i < (f[3] < 2 ? 59 : 8); i++) this.keys[s][f[3] * 59 + i] = f[4 + i];
        return echo();
      case 0xfd:
        if (!hi) return; // old firmwares don't know 0xFD (svumo: tracking via FD is ignored on A75 Pro 0.09)
        if (s === 3) {
          echo();
          if (f[2]) for (let p = 0; p < 5; p++) {
            const n = p < 4 ? 30 : 6;
            this.emit([0xfd, 0x06, p, ...this.depth.slice(p * 30, p * 30 + n).flatMap((mm) => [Math.round(mm * 200) & 255, Math.round(mm * 200) >> 8])]);
          }
          return;
        }
        if (s === 7) {
          const field = { 1: 1, 3: 4, 4: 5 }[f[2]], reply = { 1: 0x08, 3: 0x0a, 4: 0x0b }[f[2]];
          for (let p = 0; p < 5; p++) this.emit([0xfd, reply, p, ...this.keys[field].slice(p * 30, p * 30 + 30).flatMap((w) => [w & 255, w >> 8])]);
          return;
        }
        if (s === 0x0c) {
          this.autoMatch = f[2];
          return echo();
        }
        for (let i = 0; i < (f[2] < 4 ? 30 : 6); i++) {
          let w = f[3 + i * 2] | (f[4 + i * 2] << 8);
          if (this.quirks.apFloor && s === 1) w = Math.max(w, this.quirks.apFloor);
          this.keys[s][f[2] * 30 + i] = w;
        }
        return echo();
      case 0xfc:
        if (!hi) return;
        if (s === 0x0a) {
          this.lw = [];
          this.rdt = [];
          return echo();
        }
        if (s === 0x01) {
          this.lw = Array.from({ length: f[3] }, (_, i) => [f[4 + i * 4], f[5 + i * 4]]);
          return echo();
        }
        if (s === 0x03) {
          this.rdt = Array.from({ length: f[2] }, (_, i) => Array.from(f.subarray(3 + i * 8, 9 + i * 8)));
          return echo();
        }
        if (s === 0x05) return this.emit([0xfc, 0x06, this.lw.length, 0, ...this.lw.flatMap(([m, t]) => [0, m, t, 0])]);
        if (s === 0x07) return this.emit([0xfc, 0x08, 0, this.rdt.length, ...this.rdt.flatMap((e) => [0, ...e, 0])]);
        if (s === 0x0b) {
          this.lwReplace = f[2];
          return echo();
        }
        return;
      case 0xa2:
        return this.emit([0xa2, this.profiles]);
      case 0xae:
        this.colour = { code: f[4], speed: f[5], brightness: f[6], colour: f[7] };
        return echo();
      default:
        return;
    }
  }
}

const allow = { on: false };
const opts = (extra = {}) => ({ allowWrites: () => allow.on, ...extra });
const log = [];
const logger = (dir, id, data, note) => log.push(`${dir} ${hex(data.subarray(0, 6))} ${note}`);

// ---------------------------------------------------------------------------------------------
// 1. A75 Pro, firmware 0.023 (oldHighPrec, svumo's verified combination)
// ---------------------------------------------------------------------------------------------
{
  allow.on = false;
  const kb = new FakeKeyboard({ productId: 0x2383, typeBytes: [11, 4, 3], fw: [23, 0], dialect: "oldHighPrec" });
  const s = await DrunkDeerSession.connect(kb, opts({ log: logger }));
  assert.equal(s.model.name, "A75 Pro");
  assert.equal(s.features.dialect, "oldHighPrec");
  assert.equal(s.tier, "community");
  assert.equal(s.state.identity.firmwareText, "0.023");
  assert.equal(kb.sent.length, 1, "connect on an old dialect = identity only (nothing else is readable)");
  assert.equal(s.state.keyPoints.actuation.source, "unknown");
  assert.equal(s.state.lighting.source, "unknown", "garbage bytes 20..33 are not trusted");
  assert.equal(s.caps.analog.actuation.max, 2.0);
  assert.equal(s.caps.analog.actuation.step, 0.01, "identity byte 25 set: fine step");

  await assert.rejects(s.setCommon({ turbo: true }), /switched off/);
  assert.equal(kb.sent.length, 1, "nothing sent while changes are off");
  allow.on = true;

  let r = await s.setCommon({ turbo: true });
  assert.deepEqual([r.status, kb.common.turbo], ["confirmed", 1]);
  r = await s.setCommon({ lastWin: true });
  assert.equal(r.status, "unconfirmed", "LW flag isn't reported on this dialect");
  assert.deepEqual(kb.common, { turbo: 0, rt: 1, mode: 1, rtMatch: 0 }, "LW forces RT on and Turbo off");
  await assert.rejects(s.setCommon({ turbo: true }), /Turbo can't be on together/);

  await assert.rejects(s.setKeyPoints("actuation", { 44: 0.5 }), /baseline "factory"/);
  r = await s.setKeyPoints("actuation", { 44: 0.5, 64: 0.5 }, { baseline: "factory" });
  assert.equal(r.status, "unconfirmed");
  assert.deepEqual([kb.keys[1][44], kb.keys[1][64], kb.keys[1][65], kb.keys[1][125]], [50, 50, 200, 200], "x100 scale on the wire");
  assert.equal(s.state.keyPoints.actuation.source, "cache");
  r = await s.setKeyPoints("actuation", { 65: 0.25 }); // partial now works from SYNQ's own last write
  assert.deepEqual([kb.keys[1][44], kb.keys[1][65]], [50, 25]);
  await assert.rejects(s.setKeyPoints("actuation", { 44: 2.5 }), /0.2\.\.2 mm/);
  await assert.rejects(s.setKeyPoints("downstroke", { 44: 1.8 }, { baseline: "factory" }), /exceed 2 mm/);
  r = await s.setKeyPoints("downstroke", { 44: 1.2 }, { baseline: "factory" });
  assert.deepEqual([r.status, kb.keys[4][44]], ["unconfirmed", 120]);

  await assert.rejects(s.setLastWinPairs([{ main: 64, trigger: 66 }]), /0xAA/);
  await assert.rejects(s.setAutoMatch(1), /isn't offered/);
  await assert.rejects(s.setLastWinReplace(true), /isn't offered/);
  r = await s.setLighting({ mode: "Breath", speed: 5, brightness: 9, colour: 0 });
  assert.deepEqual([r.status, kb.colour.code], ["unconfirmed", 4], "A75 Pro Breath = wire code 4 (svumo hardware-verified)");
  const before = kb.sent.length;
  await assert.rejects(s.setLighting({ mode: "Breath", speed: 5, brightness: 10, colour: 0 }), /0\.\.9/);
  await assert.rejects(s.setLighting({ mode: "color26", speed: 5, brightness: 5, colour: 0 }), /isn't a lighting preset/);
  assert.equal(kb.sent.length, before, "rejected lighting never reaches the keyboard");

  // Live depth: one B7 round per "tracking on", re-armed.
  const rounds = [];
  s.startDepth((mm) => rounds.push(mm));
  while (rounds.length < 3) await new Promise((res) => setTimeout(res, 5));
  await s.stopDepth();
  assert.equal(rounds[0][64], 1.5);
  assert.equal(rounds[0][0], 0);
  assert.equal(hex(kb.sent.at(-1).subarray(0, 3)), "b6 03 00", "tracking off sent last");
  assert.ok(kb.sent.filter((f) => f[0] === 0xb6 && f[1] === 3 && f[2] === 1).length >= 3, "re-armed each round");

  // Blocked frames never reach the device, even through the raw channel.
  const n = kb.sent.length;
  const fw = new Uint8Array(63); fw[0] = 0xf9;
  const reset = new Uint8Array(63); reset[0] = 0xaa; reset[2] = 1;
  const keymap = new Uint8Array(63); keymap.set([0xa0, 0x02, 0x04, 1, 14, 1]);
  const fdOnOld = new Uint8Array(63); fdOnOld.set([0xfd, 0x07, 0x01]);
  for (const f of [fw, reset, keymap, fdOnOld]) await assert.rejects(s.channel.output(f), BlockedFrameError);
  assert.equal(kb.sent.length, n);
  assert.ok(log.some((l) => l.startsWith("blocked f9")), "blocked frames are logged");
  await s.close();
  assert.deepEqual(kb.violations, []);
  console.log(`A75 Pro 0.023: ok (${kb.sent.length} frames)`);
}

// ---------------------------------------------------------------------------------------------
// 2. A75 Ultra, firmware 0.085 (newHighPrec: read-back pulls, pairs, auto-match, LW replace)
// ---------------------------------------------------------------------------------------------
{
  allow.on = true;
  const kb = new FakeKeyboard({ productId: 0x2383, typeBytes: [11, 4, 4], fw: [85, 0], dialect: "newHighPrec", quirks: { apFloor: 100 } });
  const s = await DrunkDeerSession.connect(kb, opts());
  assert.equal(s.model.name, "A75 Ultra");
  assert.equal(s.features.dialect, "newHighPrec");
  assert.equal(kb.sent.length, 7, "identity + 3 per-key pulls + LW pull + RDT pull + profile count");
  assert.equal(s.state.keyPoints.actuation.source, "device");
  assert.equal(s.state.keyPoints.actuation.value[10], 2.0);
  assert.deepEqual(s.state.lwPairs.value, [{ main: 64, trigger: 66 }]);
  assert.equal(s.state.profileCount.value, 3);
  assert.equal(s.state.profileIndex.value, 1);
  assert.deepEqual(s.state.lighting.value.mode, "color5", "Ultra code 3 = Breath");
  assert.equal(s.state.autoMatch.value, 255);

  let r = await s.setKeyPoints("actuation", { 44: 0.6 });
  assert.equal(r.status, "confirmed");
  assert.equal(kb.keys[1][44], 120, "x200 u16 on the wire");
  assert.equal(kb.sent.filter((f) => f[0] === 0xfd && f[1] === 1).length, 5, "5 FD batches");
  r = await s.setKeyPoints("actuation", { 65: 0.3 }); // the fake firmware floors AP at 0.5 mm
  assert.equal(r.status, "mismatch");
  assert.equal(r.read[65], 0.5);
  assert.equal(s.state.keyPoints.actuation.value[65], 0.5, "state follows the device after a mismatch");
  r = await s.setKeyPoints("actuation", new Array(126).fill(3.3));
  assert.equal(r.status, "confirmed", "3.3 mm allowed on newHighPrec");

  r = await s.setCommon({ rapidTrigger: true, lastWin: true });
  assert.equal(r.status, "confirmed");
  r = await s.setLastWinPairs([{ main: 64, trigger: 66 }, { main: 66, trigger: 64 }]);
  assert.equal(r.status, "confirmed");
  const fc = kb.sent.filter((f) => f[0] === 0xfc && (f[1] === 0x0a || f[1] === 0x01)).map((f) => hex(f.subarray(0, 4)));
  assert.deepEqual(fc.slice(-2), ["fc 0a 01 00", "fc 01 00 02"], "clear (mode LW) then the table");
  r = await s.setCommon({ rdt: true });
  r = await s.setRdtPairs([{ press: 44, release: 65, activeMm: 0.1, resetMm: 2.0 }]);
  assert.equal(r.status, "confirmed");
  await assert.rejects(s.setRdtPairs(Array.from({ length: 6 }, (_, i) => ({ press: i, release: i + 20, activeMm: 0.1, resetMm: 2 }))), /At most 5/);
  r = await s.setAutoMatch(1);
  assert.deepEqual([r.status, kb.autoMatch], ["confirmed", 1]);
  r = await s.setLastWinReplace(true);
  assert.equal(r.status, "confirmed");
  r = await s.setLighting({ mode: "color9", speed: 3, brightness: 7, colour: 2 });
  assert.deepEqual([r.status, kb.colour.code], ["confirmed", 1], "Ultra Always-on = code 1");

  // Turbo stuck in firmware -> mismatch.
  kb.quirks.turboStuck = true;
  r = await s.setCommon({ lastWin: false, rdt: false, turbo: true });
  assert.equal(r.status, "mismatch");
  assert.equal(r.read.turbo, false);

  const rounds = [];
  s.startDepth((mm) => rounds.push(mm));
  while (rounds.length < 2) await new Promise((res) => setTimeout(res, 5));
  await s.stopDepth();
  assert.equal(rounds[1][64], 1.5);
  assert.equal(hex(kb.sent.at(-1).subarray(0, 3)), "fd 03 00");
  await s.close();
  assert.deepEqual(kb.violations, []);
  console.log(`A75 Ultra 0.085: ok (${kb.sent.length} frames)`);
}

// ---------------------------------------------------------------------------------------------
// 3. Legacy firmware: A75 Pro 0.09 -> x10 scale, AP up to 3.3 mm
// ---------------------------------------------------------------------------------------------
{
  allow.on = true;
  const kb = new FakeKeyboard({ typeBytes: [11, 4, 3], fw: [9, 0], dialect: "legacy" });
  const s = await DrunkDeerSession.connect(kb, opts());
  assert.equal(s.features.dialect, "legacy");
  assert.equal(s.tier, "experimental");
  const r = await s.setKeyPoints("actuation", { 44: 3.0 }, { baseline: "factory" });
  assert.equal(r.status, "unconfirmed");
  assert.deepEqual([kb.keys[1][44], kb.keys[1][0]], [30, 20], "x10 scale");
  await s.close();
  assert.deepEqual(kb.violations, []);
  console.log("A75 Pro 0.09 (legacy): ok");
}

// ---------------------------------------------------------------------------------------------
// 4. Unknown type code -> read-only, dialect unknown, no writes
// ---------------------------------------------------------------------------------------------
{
  allow.on = true;
  const kb = new FakeKeyboard({ productId: 0x2387, typeBytes: [11, 9, 9], fw: [30, 0], dialect: "oldHighPrec" });
  const s = await DrunkDeerSession.connect(kb, opts());
  assert.equal(s.model, null);
  assert.equal(s.tier, "readOnly");
  assert.equal(s.features, null);
  await assert.rejects(s.setKeyPoints("actuation", new Array(126).fill(2)), /dialect is unknown/);
  await assert.rejects(s.setCommon({ turbo: true }), /dialect is unknown/);
  assert.throws(() => s.startDepth(() => {}), /dialect is unknown/);
  const t = new Uint8Array(63); t.set([0xb6, 0x03, 0x01]);
  await assert.rejects(s.channel.output(t), BlockedFrameError, "only the identity read before the model is known");
  assert.equal(kb.sent.length, 1);
  assert.ok(s.state.notes.some((n) => n.includes("Unknown type bytes")));
  await s.close();
  console.log("unknown type code: ok (read-only)");
}

// ---------------------------------------------------------------------------------------------
// 5. Ids that are never opened, and a keyboard that never answers
// ---------------------------------------------------------------------------------------------
{
  const never = [
    new FakeKeyboard({ vendorId: 0x05ac, productId: 0x024f, typeBytes: [11, 4, 3], fw: [23, 0], dialect: "oldHighPrec" }),
    new FakeKeyboard({ vendorId: 0x19f5, productId: 0xaf12, typeBytes: [11, 4, 3], fw: [23, 0], dialect: "oldHighPrec" }),
    new FakeKeyboard({ vendorId: 0x19f5, productId: 0xfb5c, typeBytes: [11, 4, 3], fw: [23, 0], dialect: "oldHighPrec" }),
    new FakeKeyboard({ vendorId: 0x1a81, productId: 0x2094, productName: "USB Gaming Mouse", typeBytes: [11, 6, 5], fw: [20, 0], dialect: "newHighPrec" }),
    new FakeKeyboard({ vendorId: 0x352d, productId: 0x2a08, typeBytes: [11, 4, 3], fw: [23, 0], dialect: "oldHighPrec" }),
  ];
  for (const kb of never) {
    await assert.rejects(DrunkDeerSession.connect(kb, opts()));
    assert.equal(kb.sent.length, 0, `${kb.vendorId.toString(16)}:${kb.productId.toString(16)} got no frame`);
  }
  const wrongCollection = new FakeKeyboard({ typeBytes: [11, 4, 3], fw: [23, 0], dialect: "oldHighPrec" });
  wrongCollection.collections = [{ usagePage: 1, usage: 6 }];
  await assert.rejects(DrunkDeerSession.connect(wrongCollection, opts()), /0xFF00/);
  assert.equal(wrongCollection.sent.length, 0);

  const x60 = new FakeKeyboard({ vendorId: 0x1a81, productId: 0x2094, productName: "DrunkDeer X60", typeBytes: [11, 6, 5], fw: [20, 0], dialect: "newHighPrec" });
  const s = await DrunkDeerSession.connect(x60, opts());
  assert.equal(s.model.name, "X60");
  assert.equal(s.state.profileCount.value, 3);
  await s.close();

  const silent = new FakeKeyboard({ typeBytes: [11, 4, 3], fw: [23, 0], dialect: "oldHighPrec", silent: true });
  const t0 = Date.now();
  await assert.rejects(DrunkDeerSession.connect(silent, opts({ timeoutMs: 150 })), /No answer/);
  assert.ok(Date.now() - t0 >= 140);
  assert.equal(silent.listeners.size, 0, "listener removed after a failed connect");
  console.log("never-opened ids, X60, timeout: ok");
}

console.log("drunkdeer session sim: all ok");
process.exit(0);
