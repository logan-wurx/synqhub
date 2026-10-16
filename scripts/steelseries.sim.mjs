// In-memory SteelSeries Apex keyboards for the SteelSeries driver (src/lib/brands/steelseries/backend.ts).
// Run: node scripts/steelseries.sim.mjs
//
// Three simulated boards, one per command family SYNQ writes to:
//   1038:1614  Apex Pro TKL (2019)          legacy line: 31 47 actuation, 3A colour, 23/A3 brightness, 89 profiles
//   1038:1642  Apex Pro TKL (2024, Gen 3)   single line: 38 61/62/65 analog, 4B + 40 colour, F5/F2 queries
//   1038:1644  Apex Pro TKL Wireless (2024) receiver: 6F/76/77 analog with ACKs, 61/62 colour, BC/D2 status
// Each answers per the protocol in docs/devices/desktop-only/steelseries.md, records every frame it receives, and
// fails the run if a frame matching guard.ts BLOCKED (or any frame it doesn't understand) ever reaches it.
// Nothing here touches real hardware.
import assert from "node:assert/strict";
import { steelseriesKbDriver, SteelSeriesBackend } from "../src/lib/brands/steelseries/backend.ts";
import { BLOCKED, matchesPattern } from "../src/lib/brands/steelseries/guard.ts";
import * as P from "../src/lib/brands/steelseries/protocol.ts";
import { findModel } from "../src/lib/brands/steelseries/devices.ts";
import { KbSession, memoryKbStore } from "../src/lib/kb/session.ts";

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

class SimApex {
  constructor(productId) {
    const m = findModel(productId);
    this.vendorId = 0x1038;
    this.productId = productId;
    this.productName = `SteelSeries ${m.model}`;
    this.collections = [{ usagePage: 0xffc0, usage: 0x0001 }];
    this.model = m;
    this.family = m.family;
    this.opened = false;
    this.listeners = new Set();
    this.frames = []; // { type, data }
    this.violations = [];
    // device state
    this.firmware = this.family === "legacy" ? "4.16.8" : this.family === "single" ? "1.19.7" : "3.24.1";
    this.brightness = 8;
    this.profile = 1;
    this.thresholds = new Map(); // hid -> { l, h } as the keyboard stores them
    this.release = new Map(); // hid -> raw mode / enable byte
    this.sensitivity = new Map(); // hid -> raw
    this.colors = new Map(); // led -> [r,g,b]
    this.direct = false;
    this.initDone = false;
    const dflt = m.table ? P.mmToPair(m.table, 1.8) : null;
    for (const k of m.analogKeys ?? []) {
      this.thresholds.set(k, { ...dflt });
      this.release.set(k, 0);
      this.sensitivity.set(k, P.SENS_DEFAULT);
    }
  }
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  addEventListener(type, fn) {
    if (type === "inputreport") this.listeners.add(fn);
  }
  removeEventListener(type, fn) {
    if (type === "inputreport") this.listeners.delete(fn);
  }
  reply(bytes) {
    const data = new Uint8Array(64);
    data.set(bytes);
    setTimeout(() => {
      for (const fn of this.listeners) fn({ reportId: 0, data: new DataView(data.buffer) });
    }, 1);
  }
  async receiveFeatureReport() {
    return new DataView(new Uint8Array(P.featureLength(this.family)).buffer);
  }
  async sendReport(reportId, buf) {
    this.take("output", reportId, buf);
  }
  async sendFeatureReport(reportId, buf) {
    this.take("feature", reportId, buf);
  }
  take(type, reportId, buf) {
    if (!this.opened) throw new Error("device not open");
    const f = new Uint8Array(buf.buffer ? buf.buffer.slice(buf.byteOffset ?? 0, (buf.byteOffset ?? 0) + buf.byteLength) : buf);
    this.frames.push({ type, data: f });
    for (const b of BLOCKED) if (matchesPattern(b.bytes, f)) this.violations.push(`BLOCKED ${b.bytes} reached the device: ${P.hex(f.subarray(0, 8))}`);
    if (reportId !== 0) this.violations.push(`report id ${reportId}`);
    const want = type === "output" ? 64 : P.featureLength(this.family);
    if (f.length !== want) this.violations.push(`${type} of ${f.length} bytes (want ${want})`);
    const ok = this[this.family.replace("-", "_")](type, f);
    if (!ok) this.violations.push(`unexpected ${type} ${P.hex(f.subarray(0, 8))}`);
  }
  // --- legacy line (Apex Pro 2019)
  legacy(type, f) {
    if (type === "output") {
      switch (f[0]) {
        case 0x90:
          this.reply(ascii(this.firmware)); // bare ASCII, as GG saw on the 1614 [zunuza]
          return true;
        case 0xa3:
          this.reply([0xa3, 0x00, this.brightness]);
          return true;
        case 0x23:
          this.brightness = f[1];
          return true;
        case 0x89:
          this.profile = f[1];
          return true;
        case 0x3b:
          this.direct = false;
          return true;
      }
      return false;
    }
    if (f[0] === 0x31 && f[1] === 0x47) {
      for (let i = 0; i < 68; i++) this.thresholds.set(f[2 + i * 3], { h: f[3 + i * 3], l: f[4 + i * 3] });
      return true;
    }
    if (f[0] === 0x3a) {
      this.direct = true;
      for (let i = 0; i < f[1]; i++) this.colors.set(f[2 + i * 4], [f[3 + i * 4], f[4 + i * 4], f[5 + i * 4]]);
      return true;
    }
    return false;
  }
  // --- single line (Gen 3 wired)
  single(type, f) {
    if (type === "output") {
      switch (f[0]) {
        case 0x90:
          this.reply([0x90, 0x00, ...ascii(this.firmware)]);
          return true;
        case 0xf5:
          this.reply([0xf5, 0x00, 1]);
          return true;
        case 0xf2:
          this.reply([0xf2, 0x00, 0]);
          return true;
        case 0x4b:
          this.initDone = true;
          return true;
      }
      return false;
    }
    if (f[0] === 0x38 && f[1] === 0x61 && f[2] === 0x44 && f[3] === 0) {
      for (let i = 0; i < 68; i++) this.thresholds.set(f[4 + i * 3], { h: f[5 + i * 3], l: f[6 + i * 3] });
      return true;
    }
    if (f[0] === 0x38 && f[1] === 0x62 && f[2] === 0x44) {
      for (let i = 0; i < 68; i++) this.release.set(f[3 + i * 2], f[4 + i * 2]);
      return true;
    }
    if (f[0] === 0x38 && f[1] === 0x65 && f[2] === 0x44) {
      for (let i = 0; i < 68; i++) this.sensitivity.set(f[3 + i * 2], f[4 + i * 2]);
      return true;
    }
    if (f[0] === 0x40) {
      if (!this.initDone) this.violations.push("0x40 before 0x4B");
      this.direct = true;
      for (let i = 0; i < f[1]; i++) this.colors.set(f[2 + i * 4], [f[3 + i * 4], f[4 + i * 4], f[5 + i * 4]]);
      return true;
    }
    return false;
  }
  // --- wireless line through the receiver
  wireless_rx(type, f) {
    if (type === "output") {
      switch (f[0]) {
        case 0xbc:
          this.reply([0xbc, 0x01]);
          return true;
        case 0xd2:
          this.reply([0xd2, 0x0f]); // level 15 -> 70 %
          return true;
        case 0x62:
          this.direct = false;
          return true;
      }
      return false;
    }
    const ack = () => this.reply([f[0], 0x00]);
    if (f[0] === 0x6f && f[1] === 0 && f[2] === 0x44) {
      if (this.direct) return true; // [opengg]: no reply while temporary RGB is active (the session must release first)
      for (let i = 0; i < 68; i++) this.thresholds.set(f[3 + i * 3], { l: f[4 + i * 3], h: f[5 + i * 3] });
      ack();
      return true;
    }
    if (f[0] === 0x76 && f[1] === 0x44) {
      if (this.direct) return true;
      for (let i = 0; i < 68; i++) this.release.set(f[2 + i * 2], f[3 + i * 2]);
      ack();
      return true;
    }
    if (f[0] === 0x77 && f[1] === 0x44) {
      if (this.direct) return true;
      for (let i = 0; i < 68; i++) this.sensitivity.set(f[2 + i * 2], f[3 + i * 2]);
      ack();
      return true;
    }
    if (f[0] === 0x61) {
      this.direct = true;
      for (let i = 0; i < f[1]; i++) this.colors.set(f[2 + i * 4], [f[3 + i * 4], f[4 + i * 4], f[5 + i * 4]]);
      return true;
    }
    return false;
  }
  /** Distance the keyboard now uses for a key, via GG's table. */
  mmOf(hid) {
    return P.pairToMm(this.model.table, this.thresholds.get(hid));
  }
}

const results = [];
const step = (name) => results.push(name);

async function run(productId, scenario) {
  const dev = new SimApex(productId);
  assert.ok(steelseriesKbDriver.claims(dev), "driver claims the vendor collection");
  assert.ok(!steelseriesKbDriver.claims({ ...dev, collections: [{ usagePage: 1, usage: 6 }] }), "not the keyboard collection");
  assert.ok(await steelseriesKbDriver.ping(dev), "ping answers");
  const backend = await steelseriesKbDriver.open(dev, { store: memoryKbStore(), live: false, devices: async () => [dev] });
  assert.ok(backend instanceof SteelSeriesBackend);
  const store = memoryKbStore();
  const session = new KbSession(backend, store, dev);
  await scenario(dev, backend, session, store);
  // A blocked frame never reaches the device, even when pushed straight at the link.
  const before = dev.frames.length;
  for (const r of [
    { type: "output", reportId: 0, data: Uint8Array.of(0x02, 0x01, 0x80, ...new Uint8Array(61)) }, // flash erase
    { type: "output", reportId: 0, data: Uint8Array.of(0x75, 0x01, ...new Uint8Array(62)) }, // region write
    { type: "output", reportId: 0, data: Uint8Array.of(0x41, ...new Uint8Array(63)) }, // ambiguous reset
    { type: "output", reportId: 0, data: Uint8Array.of(0x88, 0x00, 0x01, 0x02, ...new Uint8Array(60)) }, // legacy profile write
    { type: "feature", reportId: 0, data: (() => { const u = new Uint8Array(P.featureLength(dev.family)); u.set([0x03, 0x01, 0x80]); return u; })() }, // flash chunk
    { type: "feature", reportId: 0, data: (() => { const u = new Uint8Array(P.featureLength(dev.family)); u.set([0x36, 0x00, 0x01, 0x04, 0x51, 0x04]); return u; })() }, // binding write
  ]) {
    await assert.rejects(() => backend.link.send(r), /refused|never sends|not a command/i);
  }
  assert.equal(dev.frames.length, before, "blocked frames never reached the device");
  assert.deepEqual(dev.violations, [], `violations on ${dev.model.model}`);
  await session.close();
  step(`${dev.model.model}: ${dev.frames.length} frames, 0 violations`);
}

// ------------------------------------------------------------------------------------------- legacy
await run(0x1614, async (dev, backend, session) => {
  const s = backend.state;
  assert.equal(s.info.firmware[0], "4.16.8");
  assert.equal(s.lighting.groups[0].settings.find((x) => x.id === "brightness").value, 8);
  assert.deepEqual(s.analog.writable, ["actuationMm"]);
  // locked until "Allow changes"
  await assert.rejects(() => session.apply({ kind: "analog", target: "global", values: { actuationMm: 1.2 } }), /Read-only/);
  session.setAllowChanges(true);
  // per-key before global: refused, nothing sent
  const n0 = dev.frames.length;
  await assert.rejects(() => session.apply({ kind: "analog", target: [0x16], values: { actuationMm: 0.5 } }), /all keys first/);
  assert.equal(dev.frames.length, n0);
  // global, then per key
  let r = await session.apply({ kind: "analog", target: "global", values: { actuationMm: 1.2 } });
  assert.equal(r.verdict, "unconfirmed");
  assert.equal(r.persistence, "volatile");
  for (const k of backend.model.analogKeys) assert.equal(dev.mmOf(k), 1.2);
  r = await session.apply({ kind: "analog", target: [0x16, 0x04], values: { actuationMm: 0.5 } });
  assert.equal(dev.mmOf(0x16), 0.5);
  assert.equal(dev.mmOf(0x04), 0.5);
  assert.equal(dev.mmOf(0x1a), 1.2);
  assert.equal(r.view.analog.perKey[0x16].actuationMm, 0.5);
  assert.equal(r.view.analog.source, "cache");
  // 3.2 mm refused before anything is sent
  const n1 = dev.frames.length;
  await assert.rejects(() => session.apply({ kind: "analog", target: "global", values: { actuationMm: 3.2 } }), /refused/);
  await assert.rejects(() => session.apply({ kind: "analog", target: "global", values: { rapidTrigger: true } }), /can't change rapid trigger/);
  assert.equal(dev.frames.length, n1);
  // brightness round-trips through the A3 read-back
  r = await session.apply({ kind: "lighting", id: "brightness", value: 3 });
  assert.equal(r.verdict, "confirmed");
  assert.equal(dev.brightness, 3);
  // colour, then hand back
  r = await session.apply({ kind: "lighting", id: "color", value: [0, 255] });
  assert.ok(dev.direct);
  assert.deepEqual(dev.colors.get(0x04), [255, 0, 0]);
  assert.equal(dev.colors.size, 112);
  r = await session.apply({ kind: "lighting", id: "mode", value: 0 });
  assert.ok(!dev.direct);
  // profile
  r = await session.apply({ kind: "profile", index: 2 });
  assert.equal(dev.profile, 3);
  assert.equal(r.view.profiles.active, 2);
  await assert.rejects(() => session.apply({ kind: "polling", hz: 1000 }), /Polling/);
  assert.ok(session.backupPath, "backup taken before the first write");
});

// ------------------------------------------------------------------------------------------- single
await run(0x1642, async (dev, backend, session) => {
  const s = backend.state;
  assert.equal(s.info.firmware[0], "1.19.7");
  assert.ok(s.info.extra.some(([k, v]) => k === "Region" && v === "US"));
  assert.deepEqual(s.analog.writable, ["actuationMm", "rapidTrigger", "rtPressMm"]);
  session.setAllowChanges(true);
  let r = await session.apply({ kind: "analog", target: "global", values: { actuationMm: 0.8, rapidTrigger: true, rtPressMm: 0.3 } });
  assert.equal(r.verdict, "unconfirmed");
  for (const k of backend.model.analogKeys) {
    assert.equal(dev.mmOf(k), 0.8);
    assert.equal(dev.release.get(k), P.RELEASE_MODE.rapidTrigger);
    assert.equal(dev.sensitivity.get(k), 3);
  }
  r = await session.apply({ kind: "analog", target: [0x1a, 0x04, 0x16, 0x07], values: { rapidTrigger: false, rtPressMm: 0.1 } });
  assert.equal(dev.release.get(0x1a), 0);
  assert.equal(dev.release.get(0x08), 2);
  assert.equal(dev.sensitivity.get(0x04), 1);
  assert.equal(dev.sensitivity.get(0x08), 3);
  assert.equal(r.view.analog.global.rapidTrigger, null, "mixed");
  await assert.rejects(() => session.apply({ kind: "analog", target: "global", values: { rtPressMm: 0.3, rtReleaseMm: 0.5 } }), /one rapid-trigger sensitivity/);
  await assert.rejects(() => session.apply({ kind: "analog", target: [0x29], values: { actuationMm: 1 } }), /no adjustable switch/);
  r = await session.apply({ kind: "lighting", id: "color", value: [85, 255] });
  assert.ok(dev.initDone && dev.direct);
  assert.equal(dev.colors.size, 86);
  await assert.rejects(() => session.apply({ kind: "lighting", id: "mode", value: 0 }), /hand-back|can't/);
  await assert.rejects(() => session.apply({ kind: "profile", index: 1 }), /can't switch/);
});

// ------------------------------------------------------------------------------------------- wireless receiver
await run(0x1644, async (dev, backend, session) => {
  const s = backend.state;
  assert.ok(s.info.extra.some(([k, v]) => k === "Keyboard" && v.startsWith("connected")));
  assert.ok(s.info.extra.some(([k, v]) => k === "Battery" && v.startsWith("70%")));
  session.setAllowChanges(true);
  // a colour first: the receiver then ignores advanced commands until lighting is released
  await session.apply({ kind: "lighting", id: "color", value: [170, 255] });
  assert.ok(dev.direct);
  const r = await session.apply({ kind: "analog", target: "global", values: { actuationMm: 1.5, rapidTrigger: true, rtPressMm: 0.5 } });
  assert.equal(r.verdict, "unconfirmed");
  assert.ok(!dev.direct, "62 sent before the analog frames");
  for (const k of backend.model.analogKeys) {
    assert.equal(dev.mmOf(k), 1.5);
    assert.deepEqual(dev.thresholds.get(k), { l: 28, h: 31 }); // [opengg] 1.5 mm = 1C 1F
    assert.equal(dev.release.get(k), 1);
    assert.equal(dev.sensitivity.get(k), 5);
  }
  await session.apply({ kind: "analog", target: [0x2c], values: { actuationMm: 0.1 } });
  assert.equal(dev.mmOf(0x2c), 0.1);
  assert.equal(dev.mmOf(0x04), 1.5);
});

for (const line of results) console.log(`ok  ${line}`);
console.log("steelseries sim: all scenarios passed");
