// Headless check of src/lib/kb/analogsense/live.ts (and driver.ts) against simulated analog keyboards of
// every family. No hardware, no window. Checks the "cheap" rules: nothing runs before start(), nothing
// while hidden, no request ever goes to a stream keyboard, polling stays under maxHz, every frame
// passes checkAnalogFrame (tripwire in the fake firmware too).
// Run: node scripts/analogsense-live.sim.mjs
import assert from "node:assert/strict";
import { AnalogLive, liveDepthFor } from "../src/lib/kb/analogsense/live.ts";
import { analogsenseDriver } from "../src/lib/kb/analogsense/driver.ts";
import { findModel } from "../src/lib/kb/analogsense/devices.ts";
import * as A from "../src/lib/kb/analogsense/protocol.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Waits until `cond()` holds, up to `ms`. For results that depend on how many rounds a busy machine's timers fit in
 * (Windows ticks at ~15 ms and the sims run four at a time): the check stays strict, only the wait is generous.
 */
async function until(cond, ms) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  return cond();
}
const ALL = [];

class SimAnalog {
  constructor({ vendorId, productId, productName = "Sim", collections, respond = null }) {
    Object.assign(this, { vendorId, productId, productName, collections });
    this.respond = respond; // (reportId, bytes, dev) => void
    this.opened = false;
    this.opens = 0;
    this.listeners = new Set();
    this.sent = [];
    this.violations = [];
    this.family = null;
    ALL.push(this);
  }
  async open() {
    this.opened = true;
    this.opens++;
  }
  async close() {
    this.opened = false;
  }
  addEventListener(t, l) {
    if (t === "inputreport") this.listeners.add(l);
  }
  removeEventListener(t, l) {
    if (t === "inputreport") this.listeners.delete(l);
  }
  emit(reportId, bytes) {
    const b = Uint8Array.from(bytes);
    for (const l of [...this.listeners]) l({ reportId, data: new DataView(b.buffer) });
  }
  async sendReport(reportId, data) {
    const d = new Uint8Array(data);
    this.sent.push({ reportId, d, at: Date.now() });
    this.family ??= findModel(this).family;
    if (!A.checkAnalogFrame(this.family, reportId, d).ok) {
      this.violations.push(Array.from(d.slice(0, 8)));
      throw new Error("BLOCKED FRAME REACHED THE DEVICE");
    }
    if (!this.opened) throw new Error("sendReport on a closed device");
    setTimeout(() => this.respond?.(reportId, d, this), 1);
  }
  async sendFeatureReport() {
    this.violations.push("feature");
    throw new Error("feature reports are never sent");
  }
}

function fakeVisibility(hidden = false) {
  const cbs = new Set();
  return {
    hidden,
    subscribe(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    set(h) {
      this.hidden = h;
      for (const cb of cbs) cb();
    },
    get listeners() {
      return cbs.size;
    },
  };
}

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.stack ?? e}`);
  }
}

// ---------------------------------------------------------------------------------------------

await scenario("stream (Wooting v2): listens only, pauses while hidden, stop cleans up", async () => {
  const dev = new SimAnalog({ vendorId: 0x31e3, productId: 0x1310, collections: [{ usagePage: 0xff53, usage: 1 }] });
  const vis = fakeVisibility();
  const live = liveDepthFor(dev, { visibility: vis, maxHz: 50 });
  assert.equal(dev.opened, false, "nothing before start()");
  const frames = [];
  await live.start((f) => frames.push(f));
  assert.ok(dev.opened && dev.listeners.size === 1);
  const t0 = Date.now();
  let reports = 0;
  for (let i = 0; i < 40; i++) {
    for (let k = 0; k < 5; k++, reports++) dev.emit(0, [0, 0x1a, 0xc0, 0xff, 0, 0x04, 0, 0x80]); // W 1023 (full), A 512
    await sleep(2);
  }
  await sleep(40);
  const allowed = Math.ceil(((Date.now() - t0) / 1000) * 50) + 1;
  assert.ok(frames.length >= 1 && frames.length <= allowed && frames.length < reports / 4, `${reports} reports coalesced to <= 50 frames/s (got ${frames.length}, allowed ${allowed})`);
  assert.equal(frames.at(-1).depth.get(0x1a), 1);
  assert.ok(Math.abs(frames.at(-1).depth.get(0x04) - 0x200 / 1023) < 1e-9);
  vis.set(true);
  await sleep(5);
  assert.equal(live.status, "paused");
  assert.equal(dev.opened, false, "device closed while hidden");
  assert.equal(dev.listeners.size, 0);
  const n = frames.length;
  dev.emit(0, [0, 0x1a, 0, 0xff]);
  await sleep(40);
  assert.equal(frames.length, n, "no frames while hidden");
  vis.set(false);
  await sleep(5);
  assert.equal(live.status, "running");
  assert.equal(dev.opens, 2);
  await live.stop();
  assert.equal(dev.opened, false);
  assert.equal(dev.listeners.size, 0);
  assert.equal(vis.listeners, 0);
  assert.equal(dev.sent.length, 0, "nothing is ever sent to a stream keyboard");
});

await scenario("stream (Razer V3, NuPhy): report filtering and incremental keys", async () => {
  const razer = new SimAnalog({ vendorId: 0x1532, productId: 0x02a6, collections: [{ usagePage: 1, usage: 6 }, { usagePage: 0xff00, usage: 1, inputReports: [{ reportId: 11 }] }] });
  const frames = [];
  const live = liveDepthFor(razer, { visibility: null, maxHz: 200 });
  await live.start((f) => frames.push(f));
  razer.emit(1, [0x12, 255, 0]); // another report id: ignored
  razer.emit(11, [0x12, 255, 9, 0x20, 51, 9, 0]); // W full, S 0.2
  await sleep(20);
  assert.deepEqual([...frames.at(-1).depth], [[0x1a, 1], [0x16, 0.2]]);
  await live.stop();

  const nuphy = new SimAnalog({ vendorId: 0x19f5, productId: 0x3245, collections: [{ usagePage: 1, usage: 0 }] });
  const nf = [];
  const nl = liveDepthFor(nuphy, { visibility: null, maxHz: 200 });
  await nl.start((f) => nf.push(f));
  nuphy.emit(0, [0xa0, 0x10, 0, 0x1a, 0x03, 0x20, 0, 0]); // W 800/800
  await sleep(10);
  nuphy.emit(0, [0xa0, 0x10, 0, 0x04, 0x01, 0x90, 0, 0]); // A 400/800
  await sleep(10);
  assert.deepEqual([...nf.at(-1).depth], [[0x1a, 1], [0x04, 0.5]]);
  nuphy.emit(0, [0xa0, 0x10, 0, 0x1a, 0, 0, 0, 0]); // W released
  await sleep(10);
  assert.deepEqual([...nf.at(-1).depth], [[0x04, 0.5]]);
  await nl.stop();
  assert.equal(razer.sent.length + nuphy.sent.length, 0);
});

const drunkdeer = (extra = {}) =>
  new SimAnalog({
    vendorId: 0x352d,
    productId: 0x2383,
    collections: [{ usagePage: 0xff00, usage: 1 }],
    respond: (_id, _d, dev) => {
      for (let n = 0; n < 3; n++) {
        const r = new Uint8Array(63);
        r[3] = n;
        if (n === 0) r[4 + 44] = 20; // W 2.0 mm
        if (n === 1) r[4 + 5] = 40; // A 4.0 mm
        dev.emit(4, r);
      }
    },
    ...extra,
  });

await scenario("poll (DrunkDeer): one request at a time, <= maxHz, none while hidden", async () => {
  const dev = drunkdeer();
  const vis = fakeVisibility();
  const frames = [];
  const live = liveDepthFor(dev, { visibility: vis, maxHz: 20 });
  await live.start((f) => frames.push(f));
  await sleep(500);
  const ran = dev.sent.length;
  assert.ok(ran >= 6 && ran <= 12, `about 20/s for 0.5 s (got ${ran})`);
  assert.deepEqual([...frames.at(-1).depth], [[0x1a, 0.5], [0x04, 1]]);
  assert.deepEqual([...frames.at(-1).mm], [[0x1a, 2], [0x04, 4]]);
  vis.set(true);
  await sleep(30);
  const atHide = dev.sent.length;
  await sleep(300);
  assert.equal(dev.sent.length, atHide, "no requests while hidden");
  assert.equal(dev.opened, false);
  vis.set(false);
  await sleep(150);
  assert.ok(dev.sent.length > atHide, "polling resumes when visible");
  await live.stop();
  const atStop = dev.sent.length;
  await sleep(150);
  assert.equal(dev.sent.length, atStop, "nothing after stop()");
});

await scenario("poll: start while hidden opens nothing until visible", async () => {
  const dev = drunkdeer();
  const vis = fakeVisibility(true);
  const live = liveDepthFor(dev, { visibility: vis, maxHz: 30 });
  await live.start(() => {});
  await sleep(100);
  assert.equal(live.status, "paused");
  assert.equal(dev.opens, 0);
  assert.equal(dev.sent.length, 0);
  vis.set(false);
  await sleep(80);
  assert.ok(dev.sent.length > 0);
  await live.stop();
});

await scenario("poll (Keychron official firmware): version, then a few keys per round", async () => {
  let held = new Set([0x1a]);
  const q1 = A.LAYOUTS["keychron-q1-he"];
  const dev = new SimAnalog({
    vendorId: 0x3434,
    productId: 0x0b10,
    collections: [{ usagePage: 0xff60, usage: 0x61 }],
    respond: (_id, d, dev) => {
      const r = new Uint8Array(32);
      r[0] = 0xa9;
      r[1] = d[1];
      if (d[1] === 0x01) r[2] = 4; // version 4, official firmware (no 0x45)
      if (d[1] === 0x30) r[6] = held.has(q1.keys[d[2] * q1.cols + d[3]]) ? 235 : 0;
      dev.emit(0, r);
    },
  });
  const frames = [];
  const live = liveDepthFor(dev, { visibility: null, maxHz: 60, window: 6 });
  await live.start((f) => frames.push(f));
  // A full rotation over the board's 82 keys, six at a time, is ~14 rounds; on a loaded machine that can take a while.
  assert.ok(await until(() => frames.at(-1)?.depth.get(0x1a) === 1, 6000), "held W found by the rotating scan");
  assert.equal(dev.sent[0].d[1], 0x01, "version first");
  assert.ok(dev.sent.slice(1).every((s) => s.d[1] === 0x30));
  held = new Set();
  // A round is up to 7 one-key requests; the held key is in every one of them.
  assert.ok(await until(() => frames.at(-1)?.depth.has(0x1a) === false, 3000), "a held key is re-read every round");
  await live.stop();
});

await scenario("poll (Keychron custom firmware): all keys in four replies", async () => {
  const dev = new SimAnalog({
    vendorId: 0x362d,
    productId: 0x0610,
    collections: [{ usagePage: 0xff60, usage: 0x61 }],
    respond: (_id, d, dev) => {
      if (d[1] === 0x01) {
        const r = new Uint8Array(32);
        r.set([0xa9, 0x01, 4]);
        r[31] = 0x45;
        return dev.emit(0, r);
      }
      for (let p = 0; p < 4; p++) {
        const r = new Uint8Array(32);
        r.set([0xa9, 0x31]);
        if (p === 1) r[2 + (47 - 30)] = 117; // index 47 = S on the P1 ANSI
        dev.emit(0, r);
      }
    },
  });
  const frames = [];
  const live = liveDepthFor(dev, { visibility: null, maxHz: 30 });
  await live.start((f) => frames.push(f));
  await sleep(200);
  assert.ok(dev.sent.slice(1).every((s) => s.d[1] === 0x31));
  assert.equal(frames.at(-1).depth.get(0x16), 117 / 235);
  await live.stop();
});

await scenario("poll (Madlions, Redragon)", async () => {
  const l = A.LAYOUTS["madlions-mad68he"];
  const mad = new SimAnalog({
    vendorId: 0x373b,
    productId: 0x1058,
    collections: [{ usagePage: 0xff60, usage: 0x61 }],
    respond: (_id, d, dev) => {
      const r = new Uint8Array(32);
      r.set(d.slice(0, 8));
      for (let i = 0; i < 4; i++) if (l.keys[d[6] + i] === 0x1a) r.set([0x01, 0x5e], 10 + 5 * i); // W at 350
      dev.emit(0, r);
    },
  });
  const mf = [];
  const ml = liveDepthFor(mad, { visibility: null, maxHz: 60 });
  await ml.start((f) => mf.push(f));
  await sleep(400);
  assert.equal(mf.at(-1).depth.get(0x1a), 1);
  assert.equal(mf.at(-1).mm.get(0x1a), 3.5);
  await ml.stop();

  const red = new SimAnalog({
    vendorId: 0x372e,
    productId: 0x105b,
    collections: [{ usagePage: 0xff00, usage: 1 }],
    respond: (_id, _d, dev) => {
      const r = new Uint8Array(63);
      r.set([0x97, 0x01, 0, 0, 0, 4, 0, 30, 0x00, 0xb2]); // W at 178 / 355
      dev.emit(0, r);
    },
  });
  const rf = [];
  const rl = liveDepthFor(red, { visibility: null, maxHz: 30 });
  await rl.start((f) => rf.push(f));
  await sleep(150);
  assert.ok(Math.abs(rf.at(-1).depth.get(0x1a) - 178 / 355) < 1e-9);
  assert.ok(red.sent.every((s) => s.reportId === 9 && s.d.length === 63));
  await rl.stop();
});

await scenario("poll: a silent keyboard stops after maxMisses with an error", async () => {
  const dev = drunkdeer({ respond: null });
  let err = null;
  const live = liveDepthFor(dev, { visibility: null, maxHz: 100, replyMs: 20, maxMisses: 3, onError: (e) => (err = e) });
  await live.start(() => {});
  await sleep(250);
  assert.equal(live.status, "failed");
  assert.match(String(err), /didn't answer/);
  assert.equal(dev.sent.length, 3);
  assert.equal(dev.opened, false);
  await live.stop();
});

await scenario("driver: read-only backend with a live() hook", async () => {
  const dev = drunkdeer();
  assert.equal(analogsenseDriver.claims(dev), true);
  assert.equal(analogsenseDriver.claims(new SimAnalog({ vendorId: 0x352d, productId: 0x2383, collections: [{ usagePage: 1, usage: 6 }] })), false);
  const b = await analogsenseDriver.open(dev, { store: null, live: false, devices: async () => [] });
  assert.equal(dev.opens, 0, "open() reads nothing");
  assert.equal(b.support.tier, "read-only");
  assert.equal(b.state.info.brand, "DrunkDeer");
  assert.throws(() => b.plan({ kind: "polling", hz: 1000 }), /doesn't change/);
  assert.equal(await analogsenseDriver.ping(dev), true);
  const live = b.live({ visibility: null, maxHz: 30 });
  await live.start(() => {});
  await sleep(60);
  await b.close();
  assert.equal(live.status, "stopped");
  assert.equal(dev.opened, false);
  assert.ok(live instanceof AnalogLive);
});

const bad = ALL.flatMap((d) => d.violations);
results.push(bad.length ? `FAIL tripwire: ${JSON.stringify(bad)}` : `ok   tripwire: every frame to ${ALL.length} simulated keyboards was allowlisted; none to stream keyboards`);
const failed = results.filter((r) => r.startsWith("FAIL"));
console.log(results.join("\n"));
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
