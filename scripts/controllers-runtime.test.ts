// Controllers, wave C1: identification, the report parsers, the tester's figures, and the links driven against the
// simulated pads (src/lib/controllers/sim.ts), which refuse any report the guard refuses, exactly as the bridge does.
// Nothing here talks to a device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gamepadIds, identifyPad } from "../src/lib/controllers/identify.ts";
import { parseDs5, parseSwitch, redactSwitch, switchDeviceInfo, switchReply, switchStickCal } from "../src/lib/controllers/parse.ts";
import { changeTimes, circularity, deadzones, drift, pollingStats, resolution, sampleLimited, triggerStats } from "../src/lib/controllers/analysis.ts";
import { RUMBLE_MS, openHidLink, openXInputLink, type MeasureResult } from "../src/lib/controllers/link.ts";
import { simulateDualSense, simulateReadOnlyPad, simulateSwitchPro, simulatedXInput } from "../src/lib/controllers/sim.ts";
import { SWITCH_RUMBLE } from "../src/lib/controllers/frames.ts";
import { maskAddresses } from "../src/lib/controllers/diagnostics.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GAMEPAD = [{ usagePage: 0x0001, usage: 0x0005 }];

/**
 * Waits until `cond()` holds, up to `ms`. The simulated pads run on timers, and how many rounds a busy machine fits in
 * (Windows ticks at ~15 ms, the test files run in parallel) varies: the checks stay as strict, only the wait is generous.
 */
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  return cond();
}

/** The tester's measurement, taken again (up to `tries` windows) until one window holds `enough`: a loaded machine's
 * timers can leave a short window thin. Each window is still judged on its own. */
async function measureUntil(link: { measure(seconds: number): Promise<MeasureResult> }, seconds: number, enough: (m: MeasureResult) => boolean, tries = 10): Promise<MeasureResult> {
  let m = await link.measure(seconds);
  for (let i = 1; i < tries && !enough(m); i++) m = await link.measure(seconds);
  return m;
}

test("identify by what the pad says: model, personality, transport, guard", () => {
  const ds = identifyPad({ vid: 0x054c, pid: 0x0ce6, product: "DualSense Wireless Controller", via: "hid", collections: GAMEPAD })!;
  assert.equal(ds.model?.id, "sony-dualsense");
  assert.equal(ds.guard, "ds5");
  // The developer's G7 SE, through XInput (its ids from Windows' device list): tester only, nothing sent.
  const g7 = identifyPad({ vid: 0x3537, pid: 0x1010, via: "xinput" })!;
  assert.equal(g7.model?.id, "gamesir-g7-se");
  assert.equal(g7.transport, "gip");
  assert.equal(g7.guard, "input");
  assert.match(g7.model?.tool?.name ?? "", /GameSir Nexus/);
  // Windows' own XInput id when the pad couldn't be told: a generic Xbox-class pad.
  const shim = identifyPad({ vid: 0x045e, pid: 0x02ff, via: "xinput" })!;
  assert.equal(shim.model, null);
  assert.equal(shim.kind, "xboxone");
  // A pad's other interface (no gamepad collection) isn't the pad.
  assert.equal(identifyPad({ vid: 0x054c, pid: 0x0ce6, via: "hid", collections: [{ usagePage: 0x0001, usage: 0x0006 }] }), null);
  // Another maker's pad borrowing an id: shown as what it says, read only.
  const borrowed = identifyPad({ vid: 0x054c, pid: 0x0ce6, product: "8BitDo Pro 2", via: "hid", collections: GAMEPAD })!;
  assert.equal(borrowed.model, null);
  assert.equal(borrowed.guard, "input");
  assert.ok(borrowed.mismatch);
  // Not a controller.
  assert.equal(identifyPad({ vid: 0x046d, pid: 0xc0a0, via: "hid", collections: GAMEPAD }), null);
});

test("browser gamepad ids: Chromium's and Firefox's forms", () => {
  assert.deepEqual(gamepadIds("DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"), { vid: 0x054c, pid: 0x0ce6, name: "DualSense Wireless Controller" });
  assert.deepEqual(gamepadIds("54c-ce6-DualSense Wireless Controller"), { vid: 0x054c, pid: 0x0ce6, name: "DualSense Wireless Controller" });
  assert.equal(gamepadIds("Xbox 360 Controller (XInput STANDARD GAMEPAD)"), null);
});

test("Switch replies: the device info keeps firmware and type, the address is dropped and redacted", () => {
  const reply = new Uint8Array(48);
  reply[12] = 0x82;
  reply[13] = 0x02;
  reply.set([0x04, 0x33, 0x03, 0x02, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01], 14);
  const info = switchDeviceInfo(switchReply(reply)!.body)!;
  assert.deepEqual(info, { firmware: "4.51", type: "Pro Controller" });
  assert.ok(!JSON.stringify(info).includes("de"), "no address in the parsed info");
  const red = redactSwitch(0x21, reply);
  assert.deepEqual([...red.subarray(18, 24)], [0, 0, 0, 0, 0, 0]);
  const status = new Uint8Array(63);
  status.set([0x01, 0x00, 0x03, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff], 0);
  assert.deepEqual([...redactSwitch(0x81, status).subarray(3, 9)], [0, 0, 0, 0, 0, 0]);
  assert.equal(maskAddresses('{"mac":"aa:bb:cc:dd:ee:ff","x":"12-34-56-78-9a-bc"}'), '{"mac":"xx:xx:xx:xx:xx:xx","x":"xx:xx:xx:xx:xx:xx"}');
});

test("Switch stick calibration and the full report", () => {
  const cal = switchStickCal(Uint8Array.from([0x78, 0x85, 0x57, 0x00, 0x08, 0x80, 0x78, 0x85, 0x57, 0x00, 0x08, 0x80, 0x78, 0x85, 0x57, 0x78, 0x85, 0x57]));
  assert.deepEqual(cal[0], { max: [1400, 1400], center: [2048, 2048], min: [1400, 1400] });
  assert.deepEqual(cal[1], { center: [2048, 2048], min: [1400, 1400], max: [1400, 1400] });
  const d = new Uint8Array(48);
  const x = 2048 + 1400; // full right
  const y = 2048;
  d[5] = x & 0xff;
  d[6] = ((x >> 8) & 0x0f) | ((y & 0x0f) << 4);
  d[7] = y >> 4;
  d[2] = 0x08; // A
  const s = parseSwitch(0x30, d, 0, { cal })!;
  assert.ok(Math.abs(s.sticks[0].x - 1) < 1e-9 && Math.abs(s.sticks[0].y) < 1e-9);
  assert.equal(s.buttons.a, true);
});

test("the tester's figures: polling, drift, circularity, deadzones, resolution, triggers", () => {
  // 1 kHz with a little jitter, a 200 ms warm-up and one pause.
  const times: number[] = [];
  let t = 0;
  for (let i = 0; i < 3000; i++) {
    t += 1 + (i % 2 ? 0.05 : -0.05);
    if (i === 1500) t += 120;
    times.push(t);
  }
  const p = pollingStats(times)!;
  assert.ok(Math.abs(p.hz - 1000) < 60, `${p.hz}`);
  assert.ok(p.jitterMs < 0.1 && p.dropped >= 200);
  assert.equal(pollingStats([0, 1, 2]), null);
  assert.ok(sampleLimited(1000, 1500) && !sampleLimited(1000, 100000));
  // Drift: resting off centre.
  const rest = Array.from({ length: 100 }, (_, i) => ({ x: 0.03 + (i % 2 ? 0.001 : -0.001), y: -0.04 }));
  const d = drift(rest)!;
  assert.ok(Math.abs(d.magnitude - 0.05) < 0.002);
  // A perfect circle: no error, every direction reached.
  const ring = Array.from({ length: 720 }, (_, i) => ({ x: Math.cos((i / 720) * 2 * Math.PI), y: Math.sin((i / 720) * 2 * Math.PI) }));
  const c = circularity(ring);
  assert.equal(c.covered, 72);
  assert.ok(c.errorPct < 0.5, `${c.errorPct}`);
  // A slow push that starts at 10 % (an anti-deadzone) and stops growing at 95 %.
  const push = [{ x: 0, y: 0 }, ...Array.from({ length: 50 }, (_, i) => ({ x: Math.min(0.95, 0.1 + i * 0.02), y: 0 }))];
  const z = deadzones(push)!;
  assert.ok(z.jumps && Math.abs(z.inner - 0.1) < 1e-9 && Math.abs(z.outer - 0.95) < 1e-9);
  assert.deepEqual(resolution(Array.from({ length: 256 }, (_, i) => ({ x: i, y: i % 16 }))).distinct, [256, 16]);
  assert.equal(triggerStats([0, 255, 0, 255])!.hair, true);
  assert.equal(triggerStats([0, 12, 200, 255])!.hair, false);
  assert.deepEqual(changeTimes([{ t: 1, sticks: [], triggers: [], buttons: {}, form: "" }, { t: 2, sticks: [], triggers: [], buttons: {}, form: "" }, { t: 3, sticks: [], triggers: [], buttons: { a: true }, form: "" }]), [1, 3]);
});

test("a DualSense through the tester: firmware and calibration reads, parsed reports, rumble that stops by itself", async () => {
  const sim = simulateDualSense();
  const identity = identifyPad({ vid: 0x054c, pid: 0x0ce6, product: "DualSense Wireless Controller", via: "hid", collections: GAMEPAD })!;
  const link = await openHidLink(identity, sim.device);
  try {
    assert.deepEqual(sim.reads, [0x20, 0x05], "firmware, then calibration: nothing else is read");
    assert.equal(link.info.build, "Sep 21 2026 10:31:07");
    assert.equal(link.info.calibration, "read");
    assert.equal(link.info.reportModeChanged, false, "USB: no report-mode change");
    const states: unknown[] = [];
    const off = link.onState((s) => states.push(s));
    await until(() => states.length > 5);
    off();
    assert.ok(states.length > 5);
    const s = parseDs5(0x01, new Uint8Array(63), 0)!;
    assert.equal(s.form, "DualSense USB report");
    await link.tests!.rumble();
    assert.equal(sim.sent.length, 1);
    await until(() => sim.sent.length >= 2, RUMBLE_MS + 5000);
    assert.equal(sim.sent.length, 2, "the stop frame follows by itself");
    assert.deepEqual([...sim.sent[1][1].subarray(0, 4)], [0x03, 0x00, 0x00, 0x00], "motors back to 0");
    await link.tests!.lightbar!(139, 92, 246);
    await link.tests!.triggers!("resistance");
    await link.tests!.triggers!("off");
    assert.equal(sim.sent.length, 5);
  } finally {
    await link.close();
    sim.stop();
  }
});

test("a Switch Pro through the tester: allowlisted setup, its simple mode restored on close, two rumble frames", async () => {
  const sim = simulateSwitchPro();
  const identity = identifyPad({ vid: 0x057e, pid: 0x2009, product: "Pro Controller", via: "hid", collections: [{ usagePage: 0x0001, usage: 0x0004 }] })!;
  const link = await openHidLink(identity, sim.device);
  try {
    assert.equal(link.info.firmware, "4.51");
    assert.equal(link.info.deviceType, "Pro Controller");
    assert.equal(link.info.calibration, "read");
    const subs = sim.sent.filter(([id]) => id === 0x01).map(([, d]) => d[9]);
    assert.deepEqual(subs, [0x02, 0x03, 0x40, 0x10], "device info, input mode, IMU, SPI read (Bluetooth: no USB commands)");
    await sleep(80);
    await link.tests!.rumble();
    await until(() => sim.sent.filter(([id]) => id === 0x10).length >= 2, RUMBLE_MS + 5000);
    const rumbles = sim.sent.filter(([id]) => id === 0x10).map(([, d]) => [...d.subarray(1, 9)]);
    assert.deepEqual(rumbles, [[...SWITCH_RUMBLE.pulse], [...SWITCH_RUMBLE.stop]]);
    assert.ok(sim.sent.some(([id, d]) => id === 0x01 && d[9] === 0x48 && d[10] === 1), "vibration enabled first");
  } finally {
    await link.close();
    sim.stop();
  }
  const last = sim.sent[sim.sent.length - 1];
  assert.deepEqual([last[0], last[1][9], last[1][10]], [0x01, 0x03, 0x3f], "it was in the simple mode: restored");
});

test("a read-only pad is timed and sent nothing; an XInput pad's sampler gives the polling figure", async () => {
  const sim = simulateReadOnlyPad(0x2dc8, 0x6012, "8BitDo Ultimate 2 Wireless");
  const identity = identifyPad({ vid: 0x2dc8, pid: 0x6012, product: "8BitDo Ultimate 2 Wireless", via: "hid", collections: GAMEPAD })!;
  assert.equal(identity.guard, "input");
  const link = await openHidLink(identity, sim.device);
  const m = await measureUntil(link, 0.5, (r) => r.times.length > 20);
  await link.close();
  sim.stop();
  assert.ok(m.times.length > 20, `${m.times.length} reports`);
  assert.equal(sim.sent.length, 0);
  assert.equal(link.tests, null);

  const g7 = identifyPad({ vid: 0x3537, pid: 0x1010, via: "xinput" })!;
  const x = await openXInputLink(g7, 0, simulatedXInput(), ["wired", 3]);
  const r = await x.measure(0.6);
  await x.close();
  const stats = pollingStats(r.times)!;
  assert.ok(Math.abs(stats.hz - 1000) < 50, `${stats.hz}`);
  assert.equal(x.info.battery?.text, "Wired");
});

test("the DualSense Edge's profiles: read, a backup before the first change, write with read-back, delete, restore", async () => {
  const { simulateDualSenseEdge } = await import("../src/lib/controllers/sim.ts");
  const { EdgeSession, EdgeRefused } = await import("../src/lib/controllers/edge-session.ts");
  const sim = simulateDualSenseEdge();
  await sim.device.open();
  let allow = false;
  const saved: string[] = [];
  const session = new EdgeSession({ device: sim.device, link: "usb", save: async (prefix, json) => (saved.push(json), `${prefix}.json`), allowWrites: () => allow, gapMs: 0 });
  try {
    const slots = await session.read();
    assert.deepEqual(slots.map((p) => (p.empty ? "-" : p.label)), ["Default", "FPS", "-", "-"]);
    assert.deepEqual(slots[1].sticks.map((s) => [s.preset, s.step]), [[1, 4], [1, 4]]);
    const edit = { label: "Racing", sticks: [{ preset: 3, step: 2 }, { preset: 0, step: 0 }] as [{ preset: number; step: number }, { preset: number; step: number }], triggers: [{ min: 30, max: 220 }, { min: 0, max: 128 }] as [{ min: number; max: number }, { min: number; max: number }], buttons: Array.from({ length: 16 }, (_, i) => i) };
    await assert.rejects(session.write(2, edit), EdgeRefused, "Allow changes is off");
    assert.equal(sim.sent.length, 0);
    allow = true;
    await assert.rejects(session.write(0 as 1, edit), /never changed/);
    const written = await session.write(2, edit);
    assert.equal(written.label, "Racing");
    assert.equal(saved.length, 1, "one full backup before the first change");
    assert.equal(JSON.parse(saved[0]).reports.length, 12);
    assert.deepEqual(sim.sent.map(([id, d]) => [id, d[0]]), [[0x61, 0], [0x61, 1], [0x61, 2]], "three parts to Cross's slot");
    await session.write(3, { ...edit, label: "Two" });
    assert.equal(saved.length, 1, "still one backup");
    await session.remove(1);
    assert.equal(session.profiles[1].empty, true);
    // Back to how it was before the first change.
    await session.restore(JSON.parse(saved[0]));
    const again = await session.read();
    assert.deepEqual(again.map((p) => (p.empty ? "-" : p.label)), ["Default", "FPS", "-", "-"]);
    assert.ok(sim.sent.every(([id]) => id !== 0x63), "the default profile is never written");
    // Bluetooth: no profile I/O at all.
    const bt = new EdgeSession({ device: sim.device, link: "bt", save: async () => "x", allowWrites: () => true });
    await assert.rejects(bt.read(), /USB/);
  } finally {
    await sim.device.close();
    sim.stop();
  }
});

test("a GameSir pad through the tester: its keep-alive, firmware, the state report, rumble that stops by itself", async () => {
  const { simulateGamesir } = await import("../src/lib/controllers/sim.ts");
  const sim = simulateGamesir("g7pro8k", 0x10c7);
  const identity = identifyPad({ vid: 0x3537, pid: 0x10c7, product: "GameSir G7 Pro 8K", via: "hid", collections: [{ usagePage: 0xfff0, usage: 0x0001 }] })!;
  assert.equal(identity.guard, "gamesir-g7pro8k");
  const link = await openHidLink(identity, sim.device);
  try {
    assert.equal(link.info.firmware, "3.5.6 (receiver 1.2.0)");
    const states: { form: string; battery?: { percent: number | null } }[] = [];
    const off = link.onState((s) => states.push(s));
    await until(() => states.length > 10);
    off();
    assert.ok(states.length > 10, `${states.length} states`);
    assert.equal(states[0].form, "GameSir 0x12");
    assert.equal(states.at(-1)!.battery?.percent, 80);
    const m = await measureUntil(link, 0.2, (r) => r.times.length > 10);
    assert.ok(m.times.length > 10 && m.times.length === m.states.length, "only state reports are timed");
    await link.tests!.rumble();
    assert.deepEqual(sim.state.motors, [100, 100]);
    await until(() => sim.state.motors.every((v) => v === 0), RUMBLE_MS + 5000);
    assert.deepEqual(sim.state.motors, [0, 0], "the stop frame follows by itself");
    assert.equal(sim.state.dropped, 0, "commands are spaced");
  } finally {
    await link.close();
  }
  const sent = sim.sent.length;
  await sleep(500);
  assert.equal(sim.sent.length, sent, "no keep-alive after close");
  assert.ok(sim.sent.every(([, d]) => [0xf2, 0x09, 0x20].includes(d[0])), "the tester sends only its keep-alive, the firmware query and the rumble test");
  sim.stop();
  // The Tarantula's motors aren't mapped: no rumble test at all.
  const tar = simulateGamesir("tarantula", 0x103d);
  const tl = await openHidLink(identifyPad({ vid: 0x3537, pid: 0x103d, product: "GameSir Tarantula Pro 8K", via: "hid", collections: [{ usagePage: 0xfff0, usage: 0x0001 }] })!, tar.device);
  assert.equal(tl.tests, null);
  await tl.close();
  tar.stop();
});

test("GameSir settings: read, a backup before the first change, writes into the active profile read back, restore", async () => {
  const { GamesirSession, GamesirRefused } = await import("../src/lib/controllers/gamesir-session.ts");
  const { GAMESIR_CURVES, LIGHT_BANK, fieldBytes, remapBytes } = await import("../src/lib/controllers/gamesir.ts");
  const { checkPadOutput } = await import("../src/lib/controllers/guard.ts");
  const { simulateGamesir } = await import("../src/lib/controllers/sim.ts");
  const sim = simulateGamesir("cyclone2", 0x1053);
  await sim.device.open();
  const saved: string[] = [];
  let allow = false;
  const s = new GamesirSession({ device: sim.device, model: "cyclone2", save: async (prefix, json) => (saved.push(json), `${prefix}.json`), allowWrites: () => allow, gapMs: 10 });
  try {
    await s.read();
    assert.equal(s.firmware?.controller, "3.5.6");
    assert.equal(s.active, 1);
    const f = (name: string) => s.fields.find((x) => x.name === name)!;
    assert.deepEqual(fieldBytes(s.images.get(2)!, f("A remap")), [1, 0x0a], "profile 2 has A and B swapped");
    // Allow changes off: nothing but reads and the keep-alive.
    await assert.rejects(s.write(2, [{ field: f("A remap"), bytes: remapBytes(null) }]), GamesirRefused);
    assert.ok(sim.sent.every(([, d]) => [0xf2, 0x09, 0x0b, 0x04].includes(d[0])));
    allow = true;
    // A value the guard refuses (a keyboard key) never goes out.
    await assert.rejects(s.write(1, [{ field: f("A remap"), bytes: [1, 0x5c] }]), /isn't one SYNQ writes/);
    // Profile 2 isn't active: switched to (the pad answers busy once: sent again), written, read back, switched back.
    const r = await s.write(2, [
      { field: f("report rate"), bytes: [1] },
      { field: f("A remap"), bytes: remapBytes(null) },
      { field: f("left stick curve"), bytes: [...GAMESIR_CURVES[2].block] },
    ]);
    assert.deepEqual(r.verified, ["A remap", "left stick curve", "report rate"], "the report rate goes last");
    assert.equal(r.rateChanged, true);
    assert.equal(saved.length, 1, "one full backup before the first change");
    assert.equal(JSON.parse(saved[0]).banks.length, 5);
    assert.deepEqual(fieldBytes(sim.banks.get(2)!, f("A remap")), [0, 0]);
    assert.equal(sim.banks.get(2)![0x2e], 1);
    assert.deepEqual(fieldBytes(sim.banks.get(2)!, f("left stick curve")), [...GAMESIR_CURVES[2].block]);
    assert.equal(sim.state.active, 1, "back on the profile the pad was on");
    // The lighting bank is global: no profile switch.
    const switches = () => sim.sent.filter(([, d]) => d[0] === 0x07).length;
    const before = switches();
    await s.write(LIGHT_BANK, [{ field: f("lighting effect"), bytes: [2] }]);
    assert.equal(switches(), before);
    assert.equal(sim.banks.get(LIGHT_BANK)![0], 2);
    assert.equal(saved.length, 1, "still one backup");
    // Restore: everything SYNQ changed goes back; the paddle profile 3 has on a keyboard key is left as it is.
    const back = await s.restore(JSON.parse(saved[0]));
    assert.equal(back.restored.length, 4, back.restored.join(", "));
    assert.deepEqual(back.kept, []);
    assert.deepEqual(fieldBytes(sim.banks.get(2)!, f("A remap")), [1, 0x0a]);
    assert.equal(sim.banks.get(2)![0x2e], 2);
    assert.equal(sim.banks.get(LIGHT_BANK)![0], 0);
    assert.deepEqual(fieldBytes(sim.banks.get(3)!, f("L4 remap")), [1, 0x5c]);
    assert.equal(sim.state.dropped, 0, "commands are spaced");
    assert.ok(sim.sent.every(([id, d]) => checkPadOutput("gamesir-cyclone2", id, d).ok));
    assert.ok(!sim.sent.some(([, d]) => d[0] === 0x17), "never the firmware loader");
  } finally {
    s.channel.close();
    await sim.device.close();
    sim.stop();
  }
});

test("a SCUF Envision receiver: BRAGI reads only (firmware, the connected pad, its id and battery), answers kept out of the input", async () => {
  const { simulateScuf } = await import("../src/lib/controllers/sim.ts");
  const { checkPadOutput } = await import("../src/lib/controllers/guard.ts");
  const sim = simulateScuf(0x2e95, 0x434e, "SCUF ENVISION PRO WIRELESS RECEIVER", true);
  const identity = identifyPad({ vid: 0x2e95, pid: 0x434e, product: "SCUF ENVISION PRO WIRELESS RECEIVER", via: "hid", collections: [{ usagePage: 0x0001, usage: 0x0005 }, { usagePage: 0xff42, usage: 0x0001 }] })!;
  assert.equal(identity.guard, "scuf");
  const link = await openHidLink(identity, sim.device);
  try {
    const facts = Object.fromEntries(link.info.facts ?? []);
    assert.equal(facts["Receiver firmware"], "5.31.101");
    assert.equal(facts["Pad"], "Connected (BRAGI address 1)");
    assert.equal(facts["Pad firmware"], "2.4.17");
    assert.equal(facts["Pad USB id"], "2E95:434C");
    assert.equal(link.info.battery?.percent, 87);
    assert.equal(link.info.battery?.text, "87% · on battery");
    assert.equal(link.tests, null, "no tests: nothing is sent but reads");
    assert.ok(sim.sent.length === 7 && sim.sent.every(([id, d]) => id === 0 && d[1] === 0x02 && checkPadOutput("scuf", id, d).ok), "seven GETs");
    const m = await measureUntil(link, 0.2, (r) => r.times.length > 10);
    assert.ok(m.times.length > 10, "the pad's input is timed");
  } finally {
    await link.close();
    sim.stop();
  }
});

test("an 8BitDo Ultimate in config mode: vibration test, the config read, a backup first, a profile written whole and read back, restore", async () => {
  const { simulate8BitDo } = await import("../src/lib/controllers/sim.ts");
  const { EbdSession, EbdRefused } = await import("../src/lib/controllers/eightbitdo-session.ts");
  const { ebdSampleConfig, parseEbdConfig } = await import("../src/lib/controllers/eightbitdo.ts");
  const { checkPadOutput } = await import("../src/lib/controllers/guard.ts");
  const sim = simulate8BitDo(0x6007);
  const identity = identifyPad({ vid: 0x2dc8, pid: 0x6007, product: "8BitDo Ultimate Wireless Controller", via: "hid", collections: GAMEPAD })!;
  assert.equal(identity.guard, "8bitdo");
  const link = await openHidLink(identity, sim.device);
  const saved: string[] = [];
  let allow = false;
  const session = new EbdSession({ device: sim.device, save: async (prefix, json) => (saved.push(json), `${prefix}.json`), allowWrites: () => allow, gapMs: 1 });
  try {
    assert.equal(sim.sent.length, 0, "opening the tester sends nothing");
    await link.tests!.rumble();
    assert.deepEqual(sim.state.motors, [200, 200]);
    await until(() => sim.state.motors.every((v) => v === 0), RUMBLE_MS + 5000);
    assert.deepEqual(sim.state.motors, [0, 0], "stopped by itself");
    const c = await session.read();
    assert.equal(session.firmware, "1.09");
    assert.ok(c.crcOk, "the stored CRC checks out");
    assert.deepEqual(c.profiles.map((p) => p.name), ["Profile 1", "FPS", "Racing"]);
    const edit = { ...c.profiles[1], name: "Drift", rumble: [0.3, 0.6] as [number, number], keys: c.profiles[1].keys.map((k, i) => (i === 0 ? 0x2000 : i === 1 ? 0x1000 : k)) };
    await assert.rejects(session.write(edit), EbdRefused, "Allow changes is off");
    assert.ok(sim.sent.every(([, d]) => !(d[1] === 0x04 && (d[2] === 0x01 || d[2] === 0x06))), "no write or save yet");
    allow = true;
    await assert.rejects(session.write({ ...edit, keys: edit.keys.map((k, i) => (i === 0 ? 0x10000000 : k)) }), /Unknown button bits/);
    const after = await session.write(edit);
    assert.equal(saved.length, 1, "one full backup before the first change");
    assert.equal(after.profiles[1].name, "Drift");
    assert.equal(sim.state.saves, 1);
    const stored = parseEbdConfig(sim.state.config);
    assert.ok(stored.crcOk && stored.profiles[1].keys[0] === 0x2000 && Math.abs(stored.profiles[1].rumble[1] - 0.6) < 1e-6);
    assert.deepEqual(sim.state.config.subarray(0x1dc), ebdSampleConfig().subarray(0x1dc), "macros kept byte for byte");
    await session.restore(JSON.parse(saved[0]));
    assert.deepEqual([...sim.state.config], [...ebdSampleConfig()], "back as it was");
    assert.ok(sim.sent.every(([id, d]) => checkPadOutput("8bitdo", id, d).ok));
    assert.ok(!sim.sent.some(([, d]) => d[1] !== 0x04 && (d[2] === 0x36 || d[2] === 0x38)), "never calibration");
  } finally {
    session.close();
    await link.close();
    sim.stop();
  }
});

test("a Flydigi Apex 4 in D-input: who it is, its four slots, a backup first, a slot written and saved only on Save, read back, restore", async () => {
  const { simulateFlydigi } = await import("../src/lib/controllers/sim.ts");
  const { FlydigiSession, FdRefused } = await import("../src/lib/controllers/flydigi-session.ts");
  const { flydigiSampleConfig } = await import("../src/lib/controllers/flydigi.ts");
  const { checkPadOutput } = await import("../src/lib/controllers/guard.ts");
  const sim = simulateFlydigi();
  const identity = identifyPad({ vid: 0x04b4, pid: 0x2412, product: "Flydigi Apex 4", via: "hid", collections: [{ usagePage: 0x0001, usage: 0x0005 }, { usagePage: 0xffa0, usage: 0x0001 }] })!;
  assert.equal(identity.guard, "flydigi");
  const link = await openHidLink(identity, sim.device);
  const saved: string[] = [];
  let allow = false;
  const session = new FlydigiSession({ device: sim.device, save: async (prefix, json) => (saved.push(json), `${prefix}.json`), allowWrites: () => allow, gapMs: 0 });
  try {
    await link.tests!.rumble();
    assert.deepEqual(sim.state.motors, [200, 200]);
    await until(() => sim.state.motors.every((v) => v === 0), RUMBLE_MS + 5000);
    assert.deepEqual(sim.state.motors, [0, 0], "the stop frame follows by itself");
    await session.read();
    assert.equal(session.info?.deviceId, 84);
    assert.equal(session.info?.firmware, "6.8.3.0");
    assert.deepEqual(session.profiles.map((p) => p.title), ["General", "Shooter", "Fighting", "Racing"]);
    assert.equal(session.profiles[1].keys[4], 5, "slot 2 has A and B swapped");
    const edit = { ...session.profiles[2], title: "Drift", keys: session.profiles[2].keys.map((k, i) => (i === 7 ? 8 : k)), sticks: [{ curve: 1, deadZone: 30 }, session.profiles[2].sticks[1]] as typeof session.profiles[2]["sticks"] };
    await assert.rejects(session.write(edit), FdRefused, "Allow changes is off");
    assert.equal(sim.state.saves, 0);
    allow = true;
    await session.write(edit);
    assert.equal(saved.length, 1, "one full backup before the first change");
    assert.equal(sim.state.saves, 1, "saved to flash once, on Save");
    assert.equal(session.profiles[2].title, "Drift");
    assert.equal(session.profiles[2].keys[7], 8);
    assert.equal(sim.state.flash[2][0x20 * 0 + 13 + 18 * 3], 0x20, "the macro on M1 kept");
    await session.restore(JSON.parse(saved[0]));
    assert.deepEqual([...sim.state.slots[2]].filter((_, i) => i !== 225 && i !== 226), [...flydigiSampleConfig(2)].filter((_, i) => i !== 225 && i !== 226), "back as it was (but the save's own version bytes)");
    assert.ok(sim.sent.every(([id, d]) => checkPadOutput("flydigi", id, d).ok));
    assert.ok(!sim.sent.some(([, d]) => d[0] === 0xed || d[0] === 0x17), "never the mode switch or update mode");
    // Another Flydigi model on the same id: read only.
    const other = simulateFlydigi(86);
    const s2 = new FlydigiSession({ device: other.device, save: async () => "x", allowWrites: () => true, gapMs: 0 });
    await other.device.open();
    await s2.read();
    await assert.rejects(s2.write(s2.profiles[0]), /device id 84/);
    s2.close();
    other.stop();
  } finally {
    session.close();
    await link.close();
    sim.stop();
  }
});
