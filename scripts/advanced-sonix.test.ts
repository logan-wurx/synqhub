// Sonix HE boards' Advanced actions (guided switch calibration, factory reset + restore) against a simulated
// keyboard on the real link and guard:
//   node --test scripts/advanced-sonix.test.ts
//
//  (a) calibration start / end and the factory reset are refused without the confirmation token;
//  (b) the key-check reset, the unknown toggles and every other command stay refused with every token;
//  (c) a backup is saved before the first calibration / reset frame, and the end frame always follows a start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvancedGate, type AdvancedScope } from "../src/lib/advanced/core.ts";
import { fccAdvanced } from "../src/lib/kb/fcc/advanced.ts";
import { SonixLink } from "../src/lib/kb/fcc/sonix-link.ts";
import * as P from "../src/lib/kb/fcc/sonix-protocol.ts";
import { memoryKbStore } from "../src/lib/kb/session.ts";

const ok = { acknowledged: true };
const RESET = { acknowledged: true, typed: "RESET" };

function board() {
  const sent: Uint8Array[] = [];
  const listeners = new Set<(e: HIDInputReportEvent) => void>();
  let streaming = false;
  const dev = {
    vendorId: 0x0c45,
    productId: 0x8030,
    productName: "Fighting68",
    opened: false,
    collections: [{ usagePage: 0xff68, usage: 0x61, type: 1, children: [], inputReports: [], outputReports: [], featureReports: [] }],
    async open() {
      dev.opened = true;
    },
    async close() {
      dev.opened = false;
    },
    addEventListener(_t: string, l: (e: HIDInputReportEvent) => void) {
      listeners.add(l);
    },
    removeEventListener(_t: string, l: (e: HIDInputReportEvent) => void) {
      listeners.delete(l);
    },
    async sendReport(_id: number, data: BufferSource) {
      const f = new Uint8Array(data as ArrayBuffer);
      sent.push(f);
      if (f[1] === 0x64) streaming = true;
      if (f[1] === 0x65) streaming = false;
      if (f[1] === 0x64 || f[1] === 0x65 || f[1] === 0x0f) return; // answered by the stream / nothing
      const reply = f.slice();
      if (f[1] === 0x13) [reply[8 + 9], reply[8 + 10]] = [3, 3]; // a lighting row with in-range speed and brightness
      emit(reply); // every other frame is echoed, payload zero
    },
  };
  const emit = (f: Uint8Array) => {
    const e = { data: new DataView(f.slice().buffer) } as unknown as HIDInputReportEvent;
    setTimeout(() => [...listeners].forEach((l) => l(e)), 0);
  };
  /** One sensor packet: key, travel in 0.01 mm, bottom reading. Full travel 3.4 mm. */
  const sensor = (key: number, travel: number, bottom = 3000, full = 34) => {
    const f = new Uint8Array(64);
    f.set([0x55, 0xfb, key, 1, 0x10, 0x27, bottom & 0xff, (bottom >> 8) | 0x80, 0, 0, travel & 0xff, travel >> 8, full]);
    emit(f);
  };
  return { dev: dev as unknown as HIDDevice, sent, sensor, get streaming() { return streaming; } };
}

async function rig(opts: { block?: string | null } = {}) {
  const b = board();
  const gate = new AdvancedGate("t");
  const link = await SonixLink.open(b.dev, { grants: gate, replyMs: 200, attempts: 1 });
  const store = memoryKbStore();
  const events: string[] = [];
  const save = store.saveBackup.bind(store);
  store.saveBackup = async (p, j) => (events.push(`backup:${p}`), save(p, j));
  const orig = b.dev.sendReport.bind(b.dev);
  (b.dev as unknown as { sendReport: unknown }).sendReport = async (id: number, d: BufferSource) => {
    const f = new Uint8Array(d as ArrayBuffer);
    if (f[1] === 0x64) events.push("frame:cal-start");
    if (f[1] === 0x65) events.push("frame:cal-end");
    if (f[1] === 0x0f) events.push("frame:reset");
    return orig(id, d);
  };
  let waits = 0;
  let script: (n: number) => void = () => {};
  const panel = fccAdvanced({
    link,
    gate,
    store,
    deviceName: "Fighting68",
    firmware: "1.25",
    hardBlock: () => opts.block ?? null,
    keys: () => [0, 1, 2].map((index) => ({ index, label: ["Q", "W", "E"][index] })),
    reload: async () => undefined,
    wait: async () => {
      script(++waits);
      await new Promise((r) => setTimeout(r, 2));
    },
  });
  return { ...b, gate, link, store, events, panel, onWait: (f: (n: number) => void) => (script = f) };
}

test("(a) calibration and reset frames are refused without their token, on the real link", async () => {
  const { link, gate, sent } = await rig();
  for (const f of [P.encodeCalibrationStart(), P.encodeCalibrationEnd(), P.encodeFactoryReset()]) {
    await assert.rejects(link.run(() => link.sendOnly(f)), /Blocked/);
    await assert.rejects(link.run(() => link.exchange(f)), /Blocked/);
  }
  await gate.grant("calibrate", ok);
  await assert.rejects(link.run(() => link.sendOnly(P.encodeFactoryReset())), /Blocked/, "a calibrate token doesn't open the reset");
  await link.run(() => link.sendOnly(P.encodeCalibrationStart()));
  assert.equal(sent.length, 1);
});

test("(b) the key-check reset and everything else stay refused with every token", async () => {
  const { link, gate, sent } = await rig();
  for (const s of ["pair", "remap", "macros", "calibrate", "reset"] as AdvancedScope[]) await gate.grant(s, RESET);
  const frame = (...b: number[]) => {
    const f = new Uint8Array(64);
    f[0] = 0xaa;
    f.set(b, 1);
    return f;
  };
  for (const f of [frame(0x0f, 0x05), frame(0x66), frame(0x67), frame(0x62), frame(0x26, 56), frame(0xfc, 4), frame(0x64, 1), frame(0x7f), frame(0xfd)]) {
    await assert.rejects(link.run(() => link.sendOnly(f)), /Blocked|isn't on SYNQ's list/);
  }
  assert.equal(sent.length, 0);
});

test("the card lists calibration and reset for a Sonix board, and hides the rest with a reason", async () => {
  const { panel } = await rig();
  assert.ok(panel.features.calibrate.available && panel.features.reset.available);
  assert.match(panel.features.calibrate.source, /Fighting Control Center/);
  for (const s of ["pair", "remap", "macros"] as const) assert.ok(!panel.features[s].available && panel.features[s].why, s);
  assert.deepEqual(panel.firmware.versions, [{ part: "Firmware", version: "1.25" }]);
  const blocked = await rig({ block: "The keyboard hasn't been read yet." });
  assert.ok(!blocked.panel.features.calibrate.available);
  assert.equal(blocked.panel.calibrate, undefined);
});

test("(c) calibration: backups first, every key followed, the end frame sent once, token returned", async () => {
  const r = await rig();
  const seen: string[] = [];
  r.onWait((n) => {
    if (n === 1) [0, 1, 2].forEach((k) => r.sensor(k, 0)); // the old calibration, before anyone touches a key
    else if (n === 2) r.sensor(0, 200); // partial
    else if (n === 3) [0, 1, 2].forEach((k) => r.sensor(k, 330)); // all pressed to the bottom
    else [0, 1, 2].forEach((k) => r.sensor(k, 0)); // let go
  });
  const done = await r.panel.calibrate!.run(ok, (p) => seen.push(`${p.phase}:${p.targets.map((t) => t.state[0]).join("")}`), new AbortController().signal);
  assert.equal(done.phase, "done", done.message);
  assert.ok(seen.includes("pressing:www"), seen.join());
  assert.ok(seen.some((s) => s === "pressing:pww" || s === "pressing:ppp" || s.startsWith("pressing:p")), "a half press shows as partial");
  assert.equal(r.events.filter((e) => e === "frame:cal-end").length, 1);
  const i = (e: string) => r.events.findIndex((x) => x.startsWith(e));
  assert.ok(i("backup:kb-sonix-fighting68-before-calibration") < i("frame:cal-start"), r.events.join());
  assert.ok(i("frame:cal-start") < i("backup:kb-sonix-fighting68-old-calibration"));
  assert.ok(i("frame:cal-end") > i("backup:kb-sonix-fighting68-old-calibration"));
  assert.ok(!r.events.includes("frame:reset"));
  assert.deepEqual(r.gate.live, []);
  assert.equal(r.streaming, false);
  const old = JSON.parse(r.store.backups.at(-1)!.json);
  assert.equal(old.keys.length, 3);
  assert.equal(old.keys[0].bottom, 3000);
  assert.equal(r.panel.calibrate!.canRestore, false);
});

test("calibration needs confirmation, and is stopped safely on abort, timeout-like silence and anomalies", async () => {
  {
    const r = await rig();
    await assert.rejects(r.panel.calibrate!.run({ acknowledged: false }, () => {}, new AbortController().signal), /confirmation/);
    assert.equal(r.sent.length, 0, "nothing was sent, not even reads");
    assert.deepEqual(r.events, []);
  }
  {
    // abort part-way
    const r = await rig();
    const ctl = new AbortController();
    r.onWait((n) => {
      if (n === 1) [0, 1, 2].forEach((k) => r.sensor(k, 0));
      if (n === 3) ctl.abort();
    });
    const out = await r.panel.calibrate!.run(ok, () => {}, ctl.signal);
    assert.equal(out.phase, "aborted");
    assert.equal(r.events.filter((e) => e === "frame:cal-end").length, 1, "calibration mode is always left");
    assert.deepEqual(r.gate.live, []);
  }
  {
    // no stream at all
    const r = await rig();
    const out = await r.panel.calibrate!.run(ok, () => {}, new AbortController().signal);
    assert.equal(out.phase, "failed");
    assert.match(out.message, /didn't send any sensor data/);
    assert.equal(r.events.filter((e) => e === "frame:cal-end").length, 1);
  }
  {
    // a key reports more travel than it has
    const r = await rig();
    r.onWait((n) => {
      if (n === 1) [0, 1, 2].forEach((k) => r.sensor(k, 0));
      if (n === 2) r.sensor(1, 900);
    });
    const out = await r.panel.calibrate!.run(ok, () => {}, new AbortController().signal);
    assert.equal(out.phase, "failed");
    assert.match(out.message, /more travel than it has/);
    assert.equal(r.events.filter((e) => e === "frame:cal-end").length, 1);
  }
  {
    // a key that comes out shallower than before
    const r = await rig();
    r.onWait((n) => {
      if (n === 1) [0, 1, 2].forEach((k) => r.sensor(k, 0, 3000));
      else if (n === 2) [0, 1, 2].forEach((k) => r.sensor(k, 330, k === 2 ? 3500 : 2800));
    });
    const out = await r.panel.calibrate!.run(ok, () => {}, new AbortController().signal);
    assert.equal(out.phase, "failed");
    assert.match(out.message, /shallower/);
  }
});

test("(c) factory reset: RESET typed, full backup first, [AA 0F FF] once, then Restore my settings", async () => {
  const r = await rig();
  const reset = r.panel.reset!;
  await assert.rejects(reset.reset({ acknowledged: true }), /RESET/);
  await assert.rejects(reset.reset({ acknowledged: true, typed: "Reset" }), /RESET/);
  assert.equal(r.sent.length, 0);
  assert.deepEqual(r.events, []);
  const { backupPath } = await reset.reset(RESET);
  assert.match(backupPath, /before-reset/);
  const resetFrames = r.sent.filter((f) => f[1] === 0x0f);
  assert.equal(resetFrames.length, 1);
  assert.deepEqual(Array.from(resetFrames[0].subarray(0, 4)), [0xaa, 0x0f, 0xff, 0]);
  assert.ok(r.events.indexOf("backup:kb-sonix-fighting68-before-reset") < r.events.indexOf("frame:reset"));
  assert.deepEqual(r.gate.live, []);
  assert.ok(reset.canRestore());
  const before = r.sent.length;
  await assert.rejects(reset.restore({ acknowledged: false }), /confirmation/);
  await reset.restore(ok);
  const writes = r.sent.slice(before).filter((f) => [0x21, 0x22, 0x23, 0x24, 0x25, 0x27, 0x28].includes(f[1]));
  assert.ok(writes.length > 0 && writes.every((f) => f[1] !== 0x0f));
  assert.ok(!r.sent.slice(before).some((f) => f[1] === 0x0f || f[1] === 0x64 || f[1] === 0x65));
});

test("(c) a reset never runs if its backup couldn't be saved", async () => {
  const r = await rig();
  r.store.saveBackup = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(r.panel.reset!.reset(RESET), /disk full/);
  assert.ok(!r.sent.some((f) => f[1] === 0x0f));
  await assert.rejects(r.panel.calibrate!.run(ok, () => {}, new AbortController().signal), /disk full/);
  assert.ok(!r.sent.some((f) => f[1] === 0x64));
  assert.deepEqual(r.gate.live, []);
});
