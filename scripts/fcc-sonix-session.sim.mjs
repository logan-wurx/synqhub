// Headless end-to-end check of src/lib/kb/fcc/sonix-session.ts and src/lib/kb/fcc/driver.ts (through the
// generic panel's real KbSession, src/lib/kb/session.ts) against a simulated Sonix HE board that answers
// the way FCC's docs and driver expect (echo of every command, data at [8..8+len)). No hardware, no
// window, no Tauri: everything runs over a fake WebHID-like device.
// Run: node scripts/fcc-sonix-session.sim.mjs
//
// The simulated firmware has its own tripwire: any blocked or unknown command that reaches it is
// recorded and fails the run, independently of the session's allowlist.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { SonixSession } from "../src/lib/kb/fcc/sonix-session.ts";
import * as P from "../src/lib/kb/fcc/sonix-protocol.ts";
import { fccDriver, bindingCode } from "../src/lib/kb/fcc/driver.ts";
import { SONIX_WIRED } from "../src/lib/kb/fcc/sonix-devices.ts";
import { KbSession, memoryKbStore } from "../src/lib/kb/session.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fcc-fighting68-fw125.fixture.json"), "utf8"));
const baseline = () =>
  Object.fromEntries(
    Object.entries(fixture.regions).map(([k, [n, nz]]) => {
      const b = new Uint8Array(n);
      for (const [i, v] of nz) b[i] = v;
      return [k, b];
    }),
  );

const READS = new Map(Object.entries(P.REGIONS).map(([n, d]) => [d.read, n]));
const WRITES = new Map(Object.entries(P.REGIONS).filter(([, d]) => d.write !== null).map(([n, d]) => [d.write, n]));
const FIRMWARE_BLOCKED = new Set([0x0f, 0x26, 0x62, 0x64, 0x65, 0x66, 0x67]);
const ALL_DEVICES = [];

class SimSonix {
  constructor({ vendorId = 0x0c45, productId = 0x8030, productName = "Fighting68", regions = baseline(), collections = [{ usagePage: 0xff68, usage: 0x61 }] } = {}) {
    Object.assign(this, { vendorId, productId, productName, collections });
    this.mem = regions;
    this.opened = false;
    this.closed = 0;
    this.listeners = new Set();
    this.sent = [];
    this.violations = [];
    this.commits = 0;
    this.dropReplies = 0;
    this.silent = false;
    this.corruptNextWrite = false;
    ALL_DEVICES.push(this);
  }
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
    this.closed++;
  }
  addEventListener(type, l) {
    if (type === "inputreport") this.listeners.add(l);
  }
  removeEventListener(type, l) {
    if (type === "inputreport") this.listeners.delete(l);
  }
  emit(bytes) {
    const copy = new Uint8Array(64);
    copy.set(bytes.slice(0, 64));
    const ev = { reportId: 0, data: new DataView(copy.buffer) };
    for (const l of [...this.listeners]) l(ev);
  }
  async sendReport(reportId, data) {
    const f = new Uint8Array(data);
    assert.equal(reportId, 0, "Sonix frames go out as report 0");
    assert.equal(f.length, 64, "Sonix frames are 64 bytes");
    this.sent.push(f);
    const cmd = f[1];
    if (f[0] !== 0xaa || FIRMWARE_BLOCKED.has(cmd) || (cmd !== 0 && !READS.has(cmd) && !WRITES.has(cmd))) {
      this.violations.push(P.hex(f));
      throw new Error(`BLOCKED FRAME REACHED THE DEVICE: ${P.hex(f)}`);
    }
    if (this.silent) return;
    if (this.dropReplies > 0) {
      this.dropReplies--;
      return;
    }
    const len = f[2];
    const off = f[3] | (f[4] << 8);
    const reply = new Uint8Array(64);
    reply.set(f.subarray(0, 8));
    if (cmd === 0) this.commits++;
    else if (READS.has(cmd)) reply.set(this.mem[READS.get(cmd)].subarray(off, off + len), 8);
    else {
      const name = WRITES.get(cmd);
      this.mem[name].set(f.subarray(8, 8 + len), off);
      // FCC's real board reads lighting bytes 4, 14, 15 back as 0: assume the firmware doesn't keep them.
      if (name === "led") for (const i of [4, 14, 15]) this.mem.led[i] = 0;
      if (this.corruptNextWrite) {
        this.mem[name][off] ^= 1;
        this.corruptNextWrite = false;
      }
    }
    setTimeout(() => this.emit(reply), 1);
  }
}

const fastOpts = (extra = {}) => ({ replyMs: 60, attempts: 2, ...extra });
const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.stack ?? e}`);
  }
}
const allSentPass = (dev) => dev.violations.length === 0 && dev.sent.every((f) => P.checkFrame(f).ok);

await scenario("open reads every region and identifies the Fighting68", async () => {
  const dev = new SimSonix();
  const s = await SonixSession.open(dev, fastOpts());
  assert.ok(dev.opened);
  // info 1 + settings 1 + keys 10 + led 1 + colors 10 + macros 8 (stops after the first empty chunk past 400) + fn 10 + rt 19 + dks 19
  assert.equal(dev.sent.length, 1 + 1 + 10 + 1 + 10 + 8 + 10 + 19 + 19);
  assert.equal(s.identity.model, "Fighting68");
  assert.ok(s.identity.verified && s.identity.certain);
  assert.equal(s.identity.firmware, "1.25");
  assert.equal(s.readOnlyReason, null);
  assert.equal(s.writesEnabled, false, "writes start off");
  assert.equal(s.keys.length, 68);
  assert.equal(s.pollingRate(), null);
  assert.equal(s.capabilities.liveTravel.supported, false);
  assert.equal(s.startLiveTravel(() => {}), null);
  assert.equal(s.keyTriggers().find((k) => k.index === 49).actuationMm, 0.8);
  assert.ok(allSentPass(dev));
  await s.close();
  assert.equal(dev.listeners.size, 0);
  assert.equal(dev.closed, 1);
});

await scenario("nothing is written while changes are off", async () => {
  const dev = new SimSonix();
  const s = await SonixSession.open(dev, fastOpts());
  const before = dev.sent.length;
  await assert.rejects(s.setKeyTriggers([{ index: 34, actuationMm: 0.5 }]), /Changes are off/);
  assert.equal(dev.sent.length, before);
});

await scenario("per-key and global triggers write RT, commit, read back", async () => {
  const dev = new SimSonix();
  let backups = 0;
  const s = await SonixSession.open(dev, fastOpts({ onBeforeFirstWrite: (snap) => (backups++, assert.equal(snap.regions.rt.length, 1024)) }));
  s.setWritesEnabled(true);
  const before = dev.sent.length;
  assert.match(await s.setKeyTriggers([{ index: 34, actuationMm: 0.5, rapidTrigger: true, pressMm: 0.1, releaseMm: 0.2, continuous: true }]), /saved/);
  assert.equal(dev.sent.length - before, 19 + 1 + 19, "19 RT chunks, commit, 19 read-back chunks");
  assert.equal(dev.commits, 1);
  assert.deepEqual(P.decodeRT(dev.mem.rt, 34), { switchType: 0, flags: 1, actuation: 50, press: 10, release: 20 });
  await s.setGlobalTrigger({ actuationMm: 1.5 });
  assert.ok(s.keys.every((k) => P.decodeRT(dev.mem.rt, k.index).actuation === 150));
  assert.equal(P.decodeRT(dev.mem.rt, 34).press, 10, "global actuation keeps RT");
  await s.setGlobalTrigger({ rapidTrigger: false });
  assert.ok(s.keys.every((k) => !P.rtEnabled(P.decodeRT(dev.mem.rt, k.index))));
  // Clamped to the Fighting68's limits (0.08..2.40 mm sensitivity, 0.10..3.30 mm actuation).
  await s.setKeyTriggers([{ index: 33, actuationMm: 9, rapidTrigger: true, pressMm: 0.01, releaseMm: 5 }]);
  assert.deepEqual(P.decodeRT(dev.mem.rt, 33), { switchType: 0, flags: 0, actuation: 330, press: 8, release: 240 });
  assert.equal(backups, 1, "one backup before the first write");
  assert.ok(allSentPass(dev));
});

await scenario("SOCD / snap tap, rappy snappy, DKS, mod-tap, toggle, clear", async () => {
  const dev = new SimSonix();
  const s = await SonixSession.open(dev, fastOpts({ writesEnabled: true }));
  await s.setSocd(49, 51); // A + D, last input wins
  assert.deepEqual([...dev.mem.keys.subarray(49 * 4, 49 * 4 + 4)], [11, 3, 0x04, 0x07]);
  assert.deepEqual([...dev.mem.keys.subarray(51 * 4, 51 * 4 + 4)], [11, 3, 0x04, 0x07]);
  assert.deepEqual(s.advanced().map((e) => [e.type, e.indexes]), [["socd", [49, 51]]]);
  await s.setRappySnappy(49, 51); // replaces the SOCD pair
  assert.deepEqual([...dev.mem.keys.subarray(49 * 4, 49 * 4 + 4)], [12, 0, 0x04, 0x07]);
  await s.setDks(0, { points: [16, 30, 30, 16], keys: [0x04, 0, 0, 0], actions: [["tap", "none", "none", "tap"], [], [], []] });
  assert.deepEqual([...dev.mem.keys.subarray(0, 4)], [8, 1, 0, 0]);
  assert.deepEqual(P.decodeDks(dev.mem.dks, 1).points, [16, 30, 30, 16]);
  await s.setModTap(48, 0xe0, 0x29, 200); // Caps: hold Ctrl, tap Esc
  assert.deepEqual([...dev.mem.keys.subarray(48 * 4, 48 * 4 + 4)], [9, 0xe0, 0x29, 20]);
  await s.setToggle(64, 0xe1);
  await s.clearAdvanced([49, 0]);
  assert.deepEqual([...dev.mem.keys.subarray(49 * 4, 49 * 4 + 4)], [0, 0, 0, 0]);
  assert.deepEqual([...dev.mem.keys.subarray(51 * 4, 51 * 4 + 4)], [0, 0, 0, 0], "pair partner cleared too");
  assert.equal(P.dksSlotUsed(dev.mem.dks, 1), false, "owned DKS slot cleared");
  await assert.rejects(s.setSocd(49, 85), /normal key function/); // Fn has no HID code
  await assert.rejects(s.setBindings("x", [{ index: 49, binding: { type: "socd", mode: 3, key1: 4, key2: 7 } }]), /advanced-key methods/);
  await s.setBindings("Remap", [{ index: 48, binding: { type: "key", mods: 0, code: 0x29 } }, { index: 0, binding: { type: "media", usage: 0xe9 } }]);
  assert.deepEqual([...dev.mem.keys.subarray(0, 4)], [3, 0xe9, 0, 0]);
  assert.ok(allSentPass(dev));
});

await scenario("lighting, colours, settings, macros", async () => {
  const dev = new SimSonix();
  const s = await SonixSession.open(dev, fastOpts({ writesEnabled: true }));
  await s.setLighting({ effect: 0x0b, r: 1, g: 2, b: 3, direction: 1 }); // read-back skips bytes 4/14/15
  assert.equal(dev.mem.led[0], 0x0b);
  assert.match(await s.setLighting({}), /nothing to change/, "constant-only differences aren't rewritten");
  await s.setKeyColors(new Map([[34, [255, 0, 0]]]));
  assert.deepEqual([...dev.mem.colors.subarray(34 * 4, 34 * 4 + 4)], [34, 255, 0, 0]);
  await s.setPollingRate(8000);
  assert.equal(dev.mem.settings[5], 6);
  await s.setSettings({ sleepMinutes: 10, allKeyWake: true });
  assert.equal(s.settings.sleepMinutes, 10);
  await assert.rejects(s.setPollingRate(2000), /Polling rate/);
  await s.setMacros([[{ code: 0x04, down: true, mouse: false, delay: 30 }, { code: 0x04, down: false, mouse: false, delay: 0 }]]);
  assert.deepEqual(s.macros()[0].map((e) => e.code), [4, 4]);
  await s.setBindings("Macro key", [{ index: 66, binding: { type: "macro", index: 0, mode: 0, repeat: 0 } }]);
  assert.ok(allSentPass(dev));
});

await scenario("unknown settings bytes / adaptive calibration are never written", async () => {
  const regions = baseline();
  regions.settings[2] = 7; // a byte nobody understands
  regions.settings[14] = 1; // adaptive calibration on
  const dev = new SimSonix({ regions });
  const s = await SonixSession.open(dev, fastOpts({ writesEnabled: true }));
  const before = dev.sent.length;
  await assert.rejects(s.setPollingRate(1000), /unknown settings byte 2/);
  assert.equal(dev.sent.length, before, "refused before any frame went out");
  assert.equal(s.settings.adaptiveCalibration, true);
});

await scenario("unknown binding types keep the key map read-only", async () => {
  const regions = baseline();
  regions.keys.set([5, 1, 0, 0], 85 * 4); // type 5 on Fn: not a type SYNQ knows
  const dev = new SimSonix({ regions });
  const s = await SonixSession.open(dev, fastOpts({ writesEnabled: true }));
  assert.deepEqual(s.unknownBindings(), [85]);
  assert.equal(s.capabilities.remap.writable, false);
  const before = dev.sent.length;
  await assert.rejects(s.setBindings("Remap", [{ index: 48, binding: { type: "key", mods: 0, code: 0x29 } }]), /binding type 5/);
  assert.equal(dev.sent.length, before);
  await s.setKeyTriggers([{ index: 48, actuationMm: 1 }]); // RT is unaffected
});

await scenario("shared USB id: read-only until the model is chosen", async () => {
  const dev = new SimSonix({ productName: "Mystery HE Board" });
  const s = await SonixSession.open(dev, fastOpts({ writesEnabled: true }));
  assert.equal(s.identity.certain, false);
  assert.equal(s.detection.candidates.length, 8);
  assert.match(s.readOnlyReason, /choose the model/);
  assert.equal(s.writesEnabled, false);
  await assert.rejects(s.setPollingRate(1000), /choose the model/);
  s.chooseModel("fighting68");
  assert.equal(s.readOnlyReason, null);
  assert.ok(s.writesEnabled);
  // A board whose firmware reports other ids stays read-only.
  const odd = new SimSonix();
  odd.mem.info[6] = 0x31;
  const s2 = await SonixSession.open(odd, fastOpts({ writesEnabled: true }));
  assert.match(s2.readOnlyReason, /reports ids/);
});

await scenario("not the config collection / not a listed board", async () => {
  await assert.rejects(SonixSession.open(new SimSonix({ collections: [{ usagePage: 1, usage: 6 }] }), fastOpts()), /0xFF68/);
  await assert.rejects(SonixSession.open(new SimSonix({ productId: 0x6366, productName: "USB Camera" }), fastOpts()), /isn't a listed/);
});

await scenario("retries a lost reply, gives up on silence, stops on link-down", async () => {
  const dev = new SimSonix();
  const s = await SonixSession.open(dev, fastOpts({ writesEnabled: true }));
  dev.dropReplies = 1;
  await s.refresh();
  dev.silent = true;
  await assert.rejects(s.refresh(), /No reply to Sonix command 0x10/);
  dev.silent = false;
  const p = s.refresh();
  setTimeout(() => dev.emit([0xaa, 0xfc, 4]), 0);
  await assert.rejects(p, /disconnected/);
  assert.equal(s.link, "lost");
  assert.match(s.readOnlyReason, /disconnected/);
});

await scenario("read-back mismatch is reported", async () => {
  const dev = new SimSonix();
  const s = await SonixSession.open(dev, fastOpts({ writesEnabled: true }));
  dev.corruptNextWrite = true;
  await assert.rejects(s.setKeyTriggers([{ index: 34, actuationMm: 0.7 }]), /reads back different rt/);
});

await scenario("fuzzed session calls never put a blocked frame on the wire", async () => {
  const dev = new SimSonix();
  const s = await SonixSession.open(dev, fastOpts({ writesEnabled: true }));
  let seed = 99;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  const idx = () => s.keys[rnd(s.keys.length)].index;
  const ops = [
    () => s.setKeyTriggers([{ index: idx(), actuationMm: rnd(500) / 100, rapidTrigger: !!rnd(2), pressMm: rnd(300) / 100, releaseMm: rnd(300) / 100 }]),
    () => s.setSocd(idx(), idx(), [1, 2, 3, 4, 9][rnd(5)]),
    () => s.setRappySnappy(idx(), idx()),
    () => s.setModTap(idx(), 0xe0 + rnd(10), rnd(300), rnd(3000)),
    () => s.setToggle(idx(), rnd(300)),
    () => s.setLighting({ effect: rnd(0x90), brightness: rnd(9), speed: rnd(9) }),
    () => s.setSettings({ sleepMinutes: rnd(40), pollHz: [1000, 2000, 4000, 8000][rnd(4)] }),
    () => s.setBindings("x", [{ index: idx(), binding: { type: "key", mods: rnd(256), code: rnd(300) } }]),
    () => s.clearAdvanced([idx()]),
    () => s.setDks(idx(), { points: [rnd(60), rnd(60), rnd(60), rnd(60)], keys: [rnd(300), 0, 0, 0], actions: [["tap", "hold", "none", "tap"], [], [], []] }),
  ];
  let refused = 0;
  for (let n = 0; n < 120; n++) {
    try {
      await ops[rnd(ops.length)]();
    } catch {
      refused++;
    }
  }
  assert.ok(refused > 0 && refused < 120);
  assert.ok(allSentPass(dev));
  assert.ok(!dev.sent.some((f) => P.FORBIDDEN_COMMANDS.has(f[1])));
});

// ---------------------------------------------------------------------------------------------
// Generic panel: fccDriver through KbSession
// ---------------------------------------------------------------------------------------------

const ctx = (store) => ({ store, live: false, devices: async () => [] });

await scenario("generic panel: claims, open, state", async () => {
  const dev = new SimSonix();
  assert.equal(fccDriver.claims(dev), true);
  assert.equal(fccDriver.claims(new SimSonix({ collections: [{ usagePage: 1, usage: 6 }] })), false, "never the keyboard collection");
  assert.equal(fccDriver.claims(new SimSonix({ productId: 0x6366 })), false, "never other Sonix gear");
  const b = await fccDriver.open(dev, ctx(memoryKbStore()));
  const s = b.state;
  assert.equal(s.info.model, "Fighting68");
  assert.deepEqual(s.info.firmware, ["1.25"]);
  assert.equal(s.analog.perKey[49].actuationMm, 0.8);
  assert.equal(s.analog.perKey[33].rapidTrigger, true);
  assert.equal(s.keymap.codes[0][49], bindingCode([2, 0, 4, 0]));
  assert.equal(s.keymap.layout.keys.length, 68);
  assert.equal(s.polling.hz, null);
  assert.equal(b.support.tier, "driver-tested");
  assert.ok(b.blocked.some((x) => x.why === "calibration") && b.blocked.some((x) => x.why === "factory-reset"));
  await b.close();
  assert.equal(dev.listeners.size, 0);
});

await scenario("generic panel: changes are confirmed by read-back", async () => {
  const dev = new SimSonix();
  const store = memoryKbStore();
  const b = await fccDriver.open(dev, ctx(store));
  const session = new KbSession(b, store, dev);
  assert.equal(session.view.writable.analog, true, "Fighting68 is driver-tested");
  let r = await session.apply({ kind: "analog", target: [34, 50], values: { actuationMm: 0.5, rapidTrigger: true, rtPressMm: 0.1, rtReleaseMm: 0.15 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.deepEqual(P.decodeRT(dev.mem.rt, 50), { switchType: 0, flags: 0, actuation: 50, press: 10, release: 15 });
  assert.equal(store.backups.length, 1, "backup before the first change");
  r = await session.apply({ kind: "analog", target: "global", values: { actuationMm: 2 } });
  assert.equal(r.verdict, "confirmed");
  assert.equal(P.decodeRT(dev.mem.rt, 50).press, 10, "global actuation keeps RT");
  r = await session.apply({ kind: "keycode", layer: 0, key: 48, code: bindingCode([2, 0, 0x29, 0]) });
  assert.equal(r.verdict, "confirmed");
  assert.deepEqual([...dev.mem.keys.subarray(48 * 4, 48 * 4 + 4)], [2, 0, 0x29, 0]);
  r = await session.apply({ kind: "lighting", id: "color", value: [85, 255] });
  assert.equal(r.verdict, "confirmed", r.detail);
  r = await session.apply({ kind: "lighting", id: "effect", value: 0x0b });
  assert.equal(r.verdict, "confirmed");
  r = await session.apply({ kind: "polling", hz: 8000 });
  assert.equal(r.verdict, "confirmed");
  assert.equal(dev.mem.settings[5], 6);
  r = await session.apply({ kind: "option", id: "sleep", value: 600 });
  assert.equal(r.verdict, "confirmed");
  assert.equal(dev.mem.settings[3], 10);
  for (const bad of [
    { kind: "analog", target: [34], values: { deadTopMm: 0.2 } },
    { kind: "profile", index: 1 },
    { kind: "option", id: "adaptiveCalibration", value: 1 },
    { kind: "polling", hz: 2000 },
    { kind: "keycode", layer: 1, key: 48, code: 0 },
    { kind: "keycode", layer: 0, key: 48, code: bindingCode([8, 1, 0, 0]) },
    { kind: "lighting", id: "effect", value: 0x40 },
  ]) {
    const before = dev.sent.length;
    await assert.rejects(session.apply(bad), undefined, JSON.stringify(bad));
    assert.equal(dev.sent.length, before, `nothing sent for ${JSON.stringify(bad)}`);
  }
  assert.ok(allSentPass(dev));
});

await scenario("generic panel: untested boards are read-only until allowed; uncertain ones stay read-only", async () => {
  const entry = SONIX_WIRED.find((d) => d.status === "untested" && SONIX_WIRED.filter((x) => x.productId === d.productId && x.vendorId === d.vendorId).length === 1);
  const regions = baseline();
  regions.info.set([entry.vendorId & 0xff, entry.vendorId >> 8, entry.productId & 0xff, entry.productId >> 8], 4);
  const dev = new SimSonix({ vendorId: entry.vendorId, productId: entry.productId, productName: entry.name, regions });
  const store = memoryKbStore();
  const b = await fccDriver.open(dev, ctx(store));
  const session = new KbSession(b, store, dev);
  assert.equal(session.view.tier, "read-only");
  const key = b.state.analog.keys[0];
  await assert.rejects(session.apply({ kind: "analog", target: [key], values: { actuationMm: 1 } }), /allow changes/);
  session.setAllowChanges(true);
  assert.equal((await session.apply({ kind: "analog", target: [key], values: { actuationMm: 1 } })).verdict, "confirmed");

  const mystery = new SimSonix({ productName: "Mystery HE Board" });
  const s2 = new KbSession(await fccDriver.open(mystery, ctx(store)), store, mystery);
  s2.setAllowChanges(true);
  const before = mystery.sent.length;
  await assert.rejects(s2.apply({ kind: "polling", hz: 1000 }), /share this USB id/);
  assert.equal(mystery.sent.length, before);
});

await scenario("generic panel: ping is one read and closes what it opened", async () => {
  const dev = new SimSonix();
  assert.equal(await fccDriver.ping(dev), true);
  assert.equal(dev.sent.length, 1);
  assert.equal(dev.opened, false);
  assert.equal(dev.listeners.size, 0);
  const quiet = new SimSonix();
  quiet.silent = true;
  assert.equal(await fccDriver.ping(quiet), false);
  assert.equal(quiet.opened, false);
});

const tripped = ALL_DEVICES.flatMap((d) => d.violations);
results.push(tripped.length ? `FAIL firmware tripwire: ${tripped.join(" | ")}` : `ok   firmware tripwire: no blocked frame reached any of ${ALL_DEVICES.length} simulated boards`);
const sims = results.length;
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(results.join("\n"));
console.log(`\n${sims - failed.length}/${sims} scenarios passed`);
process.exit(failed.length ? 1 : 0);
