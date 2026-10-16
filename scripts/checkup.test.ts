// Gear Doctor, the pure core (src/lib/checkup): click bounce, polling / dropouts / sensor jumps, key chatter and
// rapid-trigger flicker, stick drift, the sound config, the fixes a finding offers and how they resolve against a
// device. No device I/O, no React.
//   node --test scripts/checkup.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { clickStats, motionStats, nominalHz, restStats } from "../src/lib/checkup/mouse.ts";
import { holdStats, keyLabel, keyStats, phantomKeys } from "../src/lib/checkup/keyboard.ts";
import { channelLevels } from "../src/lib/checkup/audio.ts";
import { ceilToGrid, intentLabel, isResolved, resolveKeyboardFix, resolveMouseFix } from "../src/lib/checkup/fix.ts";
import { controllerReport, keyboardReport, mouseReport, soundReport, worst, type KeyboardSubject, type MouseSubject } from "../src/lib/checkup/report.ts";
import { estimateSeconds, planSteps } from "../src/lib/checkup/steps.ts";
import { CLICKS, HOLD, KEYS, MOTION } from "../src/lib/checkup/thresholds.ts";
import type { ButtonEvent, KeyEvent, MotionReport } from "../src/lib/checkup/types.ts";
import type { KeyboardDevice, MouseDevice } from "../src/lib/feel/types.ts";
import type { PadState } from "../src/lib/controllers/parse.ts";
import type { EngineStatus, EqSnapshot } from "../src/lib/backend.ts";

/** `n` clean clicks of `button`, one every `pace` ms, each held 70 ms. */
function clicks(n: number, pace = 250, button = 0, start = 0): ButtonEvent[] {
  const out: ButtonEvent[] = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * pace;
    out.push({ t, button, down: true }, { t: t + 70, button, down: false });
  }
  return out;
}

/** A bounce: the button comes back `gap` ms after the release at `upAt`, for 4 ms. */
const bounce = (upAt: number, gap: number, button = 0): ButtonEvent[] => [
  { t: upAt + gap, button, down: true },
  { t: upAt + gap + 4, button, down: false },
];

/** Steady circles: one report every 1000/hz ms with `counts` of motion, for `seconds`. */
function circles(hz: number, seconds: number, counts = 6, start = 0): MotionReport[] {
  const out: MotionReport[] = [];
  const n = Math.round(hz * seconds);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 8;
    out.push({ t: start + (i * 1000) / hz, dx: Math.round(Math.cos(a) * counts) || 1, dy: Math.round(Math.sin(a) * counts) || 1 });
  }
  return out;
}

const keys = (code: string, downAt: number, upAt: number): KeyEvent[] => [
  { t: downAt, code, down: true, repeat: false },
  { t: upAt, code, down: false, repeat: false },
];

function mouseDevice(over: Partial<MouseDevice["target"]> = {}, now: Partial<NonNullable<MouseDevice["now"]>> = {}): MouseDevice {
  return {
    target: {
      dpi: { min: 50, max: 26000, step: 50 },
      stages: { max: 8, fixedCount: null },
      polling: { options: [125, 250, 500, 1000, 2000, 4000, 8000] },
      lod: { kind: "mm", min: 0.7, max: 1.7, step: 0.1 },
      debounce: { options: [0, 1, 2, 4, 8, 12, 15, 20] },
      toggles: { angleSnapping: true, motionSync: true, ripple: true },
      ...over,
    },
    now: { stages: [800], active: 0, pollingHz: 1000, lod: null, debounceMs: 2, angleSnapping: false, motionSync: false, ripple: false, ...now },
  };
}

function keyboardDevice(now: Partial<NonNullable<KeyboardDevice["now"]>> = {}, rt: KeyboardDevice["target"]["rtSensitivity"] = { min: 0.01, max: 2, step: 0.01, independent: true }): KeyboardDevice {
  return {
    target: { actuation: { min: 0.1, max: 4, step: 0.01 }, rapidTrigger: true, rtSensitivity: rt, socd: null },
    now: { actuationMm: 1.2, rapidTrigger: true, rtPressMm: 0.02, rtReleaseMm: 0.02, socd: null, ...now },
  };
}

test("clean clicks have no bounce; the pace is the median press-to-press time", () => {
  const s = clickStats(clicks(30, 240), 0);
  assert.equal(s.presses, 30);
  assert.equal(s.bounces, 0);
  assert.equal(s.paceMs, 240);
});

test("a press within the bounce window after a release counts as a bounce, and only for that button", () => {
  const ev = [...clicks(30, 240), ...bounce(70, 6), ...bounce(240 * 4 + 70, 11), ...clicks(5, 300, 2, 20)];
  const s = clickStats(ev, 0);
  assert.equal(s.bounces, 2);
  assert.deepEqual(s.gaps, [6, 11]);
  assert.equal(clickStats(ev, 2).bounces, 0);
  // A press 25 ms after letting go is a fast person, not a bounce.
  assert.equal(clickStats([...clicks(20, 240), ...bounce(70, CLICKS.chatterGapMs + 5)], 0).bounces, 0);
});

test("a down repeated without an up is one press", () => {
  const s = clickStats([{ t: 0, button: 0, down: true }, { t: 1, button: 0, down: true }, { t: 50, button: 0, down: false }], 0);
  assert.equal(s.presses, 1);
});

test("nominalHz snaps to the rates mice are sold with", () => {
  assert.equal(nominalHz(997), 1000);
  assert.equal(nominalHz(7600), 8000);
  assert.equal(nominalHz(470), 500);
  assert.equal(nominalHz(130), 125);
});

test("steady 1 kHz circles: about 1000 Hz, no dropouts, no jumps, even", () => {
  const s = motionStats(circles(1000, 4))!;
  assert.ok(Math.abs(s.hz! - 1000) < 30, `hz ${s.hz}`);
  assert.equal(s.nominalHz, 1000);
  assert.equal(s.dropouts, 0);
  assert.equal(s.jumps, 0);
  assert.ok(s.unevenCv !== null && s.unevenCv < 0.1, `cv ${s.unevenCv}`);
});

test("8 kHz circles read as 8 kHz", () => {
  const s = motionStats(circles(8000, 2, 4))!;
  assert.equal(s.nominalHz, 8000);
});

test("slow motion (one count per report) doesn't read as a low rate", () => {
  const slow = circles(1000, 3, 1).map((r) => ({ ...r, dx: 1, dy: 0 }));
  assert.equal(motionStats(slow)!.hz, null);
});

test("silences in fast motion are dropouts; the catch-up report after one isn't a sensor jump", () => {
  const base = circles(1000, 4);
  // Cut 3 dropouts of 20 ms; the report after each carries the motion gathered meanwhile.
  const cut = base.filter((r) => !((r.t >= 1000 && r.t < 1020) || (r.t >= 2000 && r.t < 2020) || (r.t >= 3000 && r.t < 3020)));
  for (const at of [1020, 2020, 3020]) {
    const i = cut.findIndex((r) => r.t === at);
    cut[i] = { ...cut[i], dx: 120, dy: 40 };
  }
  const s = motionStats(cut)!;
  assert.equal(s.dropouts, 3);
  assert.equal(s.longestDropMs, 21);
  assert.equal(s.jumps, 0);
  assert.ok(s.dropPct > 1 && s.dropPct < 2, `drop ${s.dropPct}`);
});

test("a pause at a slow turn-around isn't a dropout", () => {
  const a = circles(1000, 1.5).map((r) => ({ ...r, dx: 6, dy: 0 }));
  const slowEnd = Array.from({ length: 10 }, (_, i) => ({ t: 1500 + i, dx: 1, dy: 0 }));
  const b = circles(1000, 1.5, 6, 1530).map((r) => ({ ...r, dx: -1, dy: 0 }));
  assert.equal(motionStats([...a, ...slowEnd, ...b])!.dropouts, 0);
});

test("one report many times its neighbours is a sensor jump", () => {
  const r = circles(1000, 3);
  r[1500] = { ...r[1500], dx: 400, dy: 0 };
  assert.equal(motionStats(r)!.jumps, 1);
});

test("too few reports: no verdict", () => {
  assert.equal(motionStats(circles(1000, 0.1)), null);
});

test("rest: a few counts of jitter is fine, real motion isn't", () => {
  assert.equal(restStats([{ t: 0, dx: 1, dy: 0 }, { t: 5, dx: 0, dy: 1 }]).moved, false);
  assert.equal(restStats(circles(1000, 0.05, 3)).moved, true);
});

test("keys: chatter, auto-repeat ignored, stuck keys", () => {
  const ev: KeyEvent[] = [
    ...keys("KeyW", 0, 90),
    ...keys("KeyW", 98, 150),
    { t: 400, code: "KeyA", down: true, repeat: false },
    { t: 700, code: "KeyA", down: true, repeat: true },
    { t: 750, code: "KeyA", down: false, repeat: false },
    { t: 900, code: "KeyS", down: true, repeat: false },
  ];
  const s = keyStats(ev, 2000);
  assert.equal(s.get("KeyW")!.presses, 2);
  assert.equal(s.get("KeyW")!.bounces, 1);
  assert.deepEqual(s.get("KeyW")!.gaps, [8]);
  assert.equal(s.get("KeyA")!.presses, 1);
  assert.equal(s.get("KeyS")!.stuck, true);
  assert.equal(keyStats(ev, 900 + KEYS.stuckAfterMs - 1).get("KeyS")!.stuck, false);
});

test("hold: releases in the middle of a hold are flicker; letting go at the end isn't", () => {
  const steady = holdStats(keys("KeyW", 0, 2000));
  assert.deepEqual(steady, { pressed: true, toggles: 0, longestMs: 2000, spanMs: 2000, released: true });
  const flicker = holdStats([...keys("KeyW", 0, 600), ...keys("KeyW", 612, 1300), ...keys("KeyW", 1309, 2000)]);
  assert.equal(flicker.toggles, 2);
  assert.equal(flicker.spanMs, 2000);
  // Letting go and pressing again a second later is the person.
  assert.equal(holdStats([...keys("KeyW", 0, 900), ...keys("KeyW", 1900, 2400)]).toggles, 0);
});

test("phantom keys and key labels", () => {
  assert.deepEqual(phantomKeys([...keys("KeyQ", 10, 20), ...keys("KeyQ", 30, 40)]), ["KeyQ"]);
  assert.equal(keyLabel("KeyW"), "W");
  assert.equal(keyLabel("Space"), "Space");
  assert.equal(keyLabel("ShiftLeft"), "Left Shift");
  assert.equal(keyLabel("ControlRight"), "Right Ctrl");
  assert.equal(keyLabel("ArrowUp"), "Up");
});

test("channel levels: per-channel preamps against the common one", () => {
  const cfg = "Preamp: -3 dB\nChannel: L\nPreamp: -1.5 dB\nChannel: R\nPreamp: 0 dB\nChannel: all\nFilter: ON PK Fc 100 Hz Gain 2 dB Q 1";
  const c = channelLevels(cfg);
  assert.equal(c.balanceDb, -1.5);
  assert.deepEqual(c.byChannel, { L: -4.5, R: -3 });
  assert.equal(channelLevels("Preamp: -6 dB").balanceDb, null);
  assert.equal(channelLevels(null).balanceDb, null);
  assert.equal(channelLevels("Channel: 1\nPreamp: 2 dB # louder left").balanceDb, 2);
});

test("ceilToGrid lands on the device's grid at or above the wish", () => {
  assert.equal(ceilToGrid(0.15, 0.01, 2, 0.01), 0.15);
  assert.equal(ceilToGrid(0.151, 0.1, 4, 0.1), 0.2);
  assert.equal(ceilToGrid(0.05, 0.1, 4, 0.1), 0.1);
  assert.equal(ceilToGrid(5, 0.1, 4, 0.1), null);
});

test("a debounce fix picks the smallest option above the bounces and above what's set", () => {
  const r = resolveMouseFix({ kind: "debounce", atLeastMs: 7 }, mouseDevice());
  assert.ok(isResolved(r));
  assert.deepEqual(r.steps, [{ kind: "debounce", ms: 8 }]);
  assert.equal(r.label, "Debounce 2 ms → 8 ms");
  // Already at 8: the next one up.
  const r2 = resolveMouseFix({ kind: "debounce", atLeastMs: 3 }, mouseDevice({}, { debounceMs: 8 }));
  assert.ok(isResolved(r2));
  assert.deepEqual(r2.steps, [{ kind: "debounce", ms: 12 }]);
  // Nothing long enough: said plainly.
  const r3 = resolveMouseFix({ kind: "debounce", atLeastMs: 30 }, mouseDevice());
  assert.ok(!isResolved(r3) && /longest debounce, 20 ms/.test(r3.reason));
  const r4 = resolveMouseFix({ kind: "debounce", atLeastMs: 4 }, mouseDevice({ debounce: null }));
  assert.ok(!isResolved(r4) && /no debounce setting/.test(r4.reason));
});

test("a polling fix lowers to the fastest option at or under the limit", () => {
  const r = resolveMouseFix({ kind: "polling", atMostHz: 2000 }, mouseDevice({}, { pollingHz: 8000 }));
  assert.ok(isResolved(r));
  assert.deepEqual(r.steps, [{ kind: "polling", hz: 2000 }]);
  assert.equal(r.label, "Polling 8 kHz → 2 kHz");
  const same = resolveMouseFix({ kind: "polling", atMostHz: 2000 }, mouseDevice({}, { pollingHz: 1000 }));
  assert.ok(!isResolved(same) && /already 1 kHz/.test(same.reason));
});

test("a rapid-trigger fix raises press and release onto the keyboard's grid", () => {
  const r = resolveKeyboardFix({ kind: "rtSensitivity", atLeastMm: 0.15 }, keyboardDevice());
  assert.ok(isResolved(r));
  assert.deepEqual(r.steps, [{ kind: "rtSensitivity", pressMm: 0.15, releaseMm: 0.15 }]);
  assert.equal(r.label, "Rapid trigger 0.02 mm → 0.15 mm");
  // One sensitivity for both directions: release follows press.
  const one = resolveKeyboardFix({ kind: "rtSensitivity", atLeastMm: 0.15 }, keyboardDevice({ rtReleaseMm: 0.5 }, { min: 0.1, max: 2, step: 0.1, independent: false }));
  assert.ok(isResolved(one));
  assert.deepEqual(one.steps, [{ kind: "rtSensitivity", pressMm: 0.2, releaseMm: 0.2 }]);
  const none = resolveKeyboardFix({ kind: "rtSensitivity", atLeastMm: 0.15 }, { ...keyboardDevice(), target: { ...keyboardDevice().target, rtSensitivity: null } });
  assert.ok(!isResolved(none));
  assert.equal(intentLabel({ kind: "rtSensitivity", atLeastMm: 0.15 }), "Raise rapid-trigger sensitivity to 0.15 mm");
});

const mouse = (over: Partial<MouseSubject> = {}): MouseSubject => ({ id: "mouse:atk", name: "X1 V2 Air+", blocked: null, wireless: true, device: mouseDevice(), ...over });

test("mouse report: bouncing clicks get a debounce fix; red from the third bounce", () => {
  const ev = [...clicks(30, 240), ...bounce(70, 6), ...bounce(240 * 3 + 70, 9), ...bounce(240 * 9 + 70, 5)];
  const r = mouseReport(mouse(), { source: "raw", clicks: ev, motion: circles(1000, 4), rest: [] });
  const f = r.findings.find((x) => x.id === "clicks.bounce")!;
  assert.equal(f.level, "bad");
  assert.equal(r.level, "bad");
  assert.deepEqual(f.fix?.intent, { kind: "debounce", atLeastMs: 11 });
  assert.match(f.detail, /3 of 33 presses came back 5-9 ms after you let go/);
  assert.equal(f.fix?.blocked, undefined);
});

test("mouse report: before its panel has read it, a driver without debounce gets advice, not a fix", () => {
  const ev = [...clicks(30, 240), ...bounce(70, 6)];
  const logi = mouseReport(mouse({ device: null, known: { debounce: false, polling: true } }), { source: "raw", clicks: ev, motion: [], rest: [] });
  assert.equal(logi.findings[0].fix, undefined);
  const unknown = mouseReport(mouse({ device: null }), { source: "raw", clicks: ev, motion: [], rest: [] });
  assert.deepEqual(unknown.findings[0].fix?.intent, { kind: "debounce", atLeastMs: 8 });
});

test("keyboard report: a flicker with the same cause as a double press is said once", () => {
  const ev = [...allKeys(), ...keys("KeyE", 2000 + 80 + 9, 2000 + 140)];
  const r = keyboardReport(kb(), { keys: ev, keysEnd: 4500, asked: KEYS.codes, hold: [...keys("KeyW", 0, 600), ...keys("KeyW", 610, 2000)], holdEnd: 2500, rest: [] });
  const hold = r.findings.find((x) => x.id === "hold.flicker")!;
  assert.equal(hold.fix, undefined);
  assert.equal(hold.advice, undefined);
  assert.match(hold.detail, /1 release in 2.0 s of holding\. Same cause as above\./);
  assert.ok(r.findings.find((x) => x.id === "keys.bounce")!.fix);
});

test("mouse report: a read-only mouse shows the fix but blocked; one without debounce gets advice only", () => {
  const ev = [...clicks(30, 240), ...bounce(70, 6)];
  const ro = mouseReport(mouse({ blocked: "Read-only" }), { source: "raw", clicks: ev, motion: [], rest: [] });
  assert.equal(ro.findings[0].fix?.blocked, "Read-only");
  assert.equal(ro.findings[0].level, "warn");
  const noDb = mouseReport(mouse({ device: mouseDevice({ debounce: null }) }), { source: "raw", clicks: ev, motion: [], rest: [] });
  assert.equal(noDb.findings[0].fix, undefined);
  assert.match(noDb.findings[0].advice!, /no debounce setting/);
});

test("mouse report: a wireless mouse at 8 kHz that drops reports is offered 2 kHz", () => {
  const base = circles(8000, 3, 4);
  const cut = base.filter((r) => Math.floor(r.t / 250) % 2 === 0 || r.t % 250 > 30);
  const r = mouseReport(mouse({ device: mouseDevice({}, { pollingHz: 8000 }) }), { source: "raw", clicks: [], motion: cut, rest: [] });
  const f = r.findings.find((x) => x.id === "polling.dropouts")!;
  assert.ok(f, JSON.stringify(r.findings));
  assert.deepEqual(f.fix?.intent, { kind: "polling", atMostHz: MOTION.wirelessSafeHz });
  assert.match(f.advice!, /receiver/);
});

test("mouse report: running slower than set is said with numbers; a clean run says so", () => {
  const slow = mouseReport(mouse({ device: mouseDevice({}, { pollingHz: 4000 }) }), { source: "raw", clicks: [], motion: circles(1000, 4), rest: [] });
  const f = slow.findings.find((x) => x.id === "polling.slow")!;
  assert.equal(f.title, "Runs at about 1 kHz, not the 4 kHz it's set to");
  assert.deepEqual(f.fix?.intent, { kind: "polling", atMostHz: 1000 });
  const clean = mouseReport(mouse(), { source: "raw", clicks: clicks(30), motion: circles(1000, 4), rest: [] });
  assert.equal(clean.level, "good");
  assert.deepEqual(clean.findings.map((x) => x.id).sort(), ["clicks.ok", "polling.ok"]);
  assert.deepEqual(clean.checked, ["clicks", "polling", "sensor"]);
});

test("mouse report: reports Windows held back judge no polling and give no rate", () => {
  // A 4 kHz mouse heard through a listener Windows treats as background: merged to about 125 a second.
  const r = mouseReport(mouse({ device: mouseDevice({}, { pollingHz: 4000 }) }), { source: "raw", throttled: true, clicks: [], motion: circles(125, 4), rest: [] });
  assert.ok(!r.findings.some((f) => f.id.startsWith("polling")), JSON.stringify(r.findings));
  assert.ok(!r.findings.some((f) => f.fix), "nothing may be offered from held-back reports");
});

test("mouse report: the window's own events judge no polling problems", () => {
  const base = circles(1000, 4).filter((r) => r.t % 500 > 30);
  const r = mouseReport(mouse(), { source: "window", clicks: [], motion: base, rest: [] });
  assert.ok(!r.findings.some((f) => f.level !== "good"));
  assert.match(r.findings[0].title, /measured in the window, rough/);
});

const kb = (over: Partial<KeyboardSubject> = {}): KeyboardSubject => ({ id: "kb:x68", name: "X68 HE", blocked: null, device: keyboardDevice(), ...over });
const allKeys = (): KeyEvent[] => KEYS.codes.flatMap((c, i) => keys(c, i * 400, i * 400 + 80));

test("keyboard report: rapid trigger flicker on a magnetic board gets a coarser-RT fix", () => {
  const hold = [...keys("KeyW", 0, 600), ...keys("KeyW", 610, 2000)];
  const r = keyboardReport(kb(), { keys: allKeys(), keysEnd: 4000, asked: KEYS.codes, hold, holdEnd: 2500, rest: [] });
  const f = r.findings.find((x) => x.id === "hold.flicker")!;
  assert.equal(f.level, "warn");
  assert.deepEqual(f.fix?.intent, { kind: "rtSensitivity", atLeastMm: HOLD.rtSafeMm });
  assert.match(f.advice!, /finer than a finger can hold still/);
});

test("keyboard report: chatter on a mechanical board is advice, not a fix; missing and stuck keys are named", () => {
  const ev = [...allKeys().filter((e) => e.code !== "KeyQ"), ...keys("KeyE", 2000 + 80 + 9, 2000 + 140)];
  ev.push({ t: 3500, code: "KeyR", down: true, repeat: false });
  const r = keyboardReport(kb({ device: null }), { keys: ev.filter((e) => !(e.code === "KeyR" && !e.down)), keysEnd: 4500, asked: KEYS.codes, hold: keys("KeyW", 0, 2000), holdEnd: 2500, rest: [] });
  const bounce = r.findings.find((x) => x.id === "keys.bounce")!;
  assert.equal(bounce.fix, undefined);
  assert.match(bounce.advice!, /chattering/);
  assert.equal(r.findings.find((x) => x.id === "keys.missing")!.title, "Q never registered");
  assert.equal(r.findings.find((x) => x.id === "keys.stuck")!.title, "R stayed down after you let go");
  assert.equal(r.level, "bad");
});

test("keyboard report: all clean", () => {
  const r = keyboardReport(kb(), { keys: allKeys(), keysEnd: 4000, asked: KEYS.codes, hold: keys("KeyW", 0, 2000), holdEnd: 2500, rest: [] });
  assert.equal(r.level, "good");
  assert.equal(r.findings[0].id, "keys.ok");
});

const pad = (t: number, lx: number, ly: number, rx = 0, ry = 0): PadState => ({ t, sticks: [{ x: lx, y: ly }, { x: rx, y: ry }], triggers: [0, 0], buttons: {}, form: "test" });
const spin = (n: number, r = 1): PadState[] => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 6;
  return pad(i * 4, Math.cos(a) * r, Math.sin(a) * r, Math.cos(a) * r, Math.sin(a) * r);
});

test("controller report: drift on one stick, round circles", () => {
  const rest = Array.from({ length: 100 }, (_, i) => pad(i * 4, 0.08, 0.02));
  const r = controllerReport({ id: "pad:x", name: "Pad", blocked: null }, { rest, spin: spin(600) });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].title, "The left stick drifts");
  assert.equal(r.findings[0].level, "warn");
  assert.match(r.findings[0].advice!, /at least 12%/);
  assert.deepEqual(r.checked, ["drift", "circularity"]);
});

test("controller report: an out-of-round stick; no measurement, no findings", () => {
  const rest = Array.from({ length: 100 }, (_, i) => pad(i * 4, 0, 0));
  const r = controllerReport({ id: "pad:x", name: "Pad", blocked: null }, { rest, spin: spin(600, 0.75) });
  assert.ok(r.findings.some((f) => f.id === "round.Left stick" && f.level === "bad"));
  assert.deepEqual(controllerReport({ id: "pad:x", name: "Pad", blocked: null }, null).findings, []);
});

function engine(over: Partial<EngineStatus> = {}): EngineStatus {
  return {
    state: "active",
    summary: "on · USB DAC output",
    installed: true,
    version: "1.4.2",
    installPath: null,
    registered: true,
    defaultOutput: { id: "o", name: "Speakers (USB DAC)", title: "USB DAC", short: "USB DAC", state: "active", engine: true, slots: [], enhancementsDisabled: false, isDefault: true, canAdd: false, issues: [] },
    outputs: [],
    inputsWithEngine: [],
    problems: [],
    canUndo: false,
    installerReady: true,
    ...over,
  };
}
const eq = (over: Partial<EqSnapshot> = {}): EqSnapshot =>
  ({ configPath: "", state: { preamp: -3, filters: [] }, advanced: null, bypassed: false, peakDb: -0.2, editorOpen: false, modified: 0, limits: {} as EqSnapshot["limits"], ...over }) as EqSnapshot;

test("sound report: running and level is good; clipping and imbalance are said, never changed", () => {
  const ok = soundReport({ id: "sound", name: "Sound", blocked: null }, engine(), eq());
  assert.equal(ok.level, "good");
  assert.equal(ok.findings[0].title, "The EQ is running on USB DAC");
  const bad = soundReport({ id: "sound", name: "Sound", blocked: null }, engine({ state: "notOnOutput" }), eq({ peakDb: 2.4, advanced: "Channel: R\nPreamp: -4 dB" }));
  const ids = bad.findings.map((f) => f.id);
  assert.deepEqual(ids, ["engine.notOnOutput", "eq.clip", "eq.balance"]);
  assert.equal(bad.findings[2].title, "Left is 4 dB louder than right");
  assert.equal(bad.findings[2].level, "bad");
  assert.ok(bad.findings.every((f) => !f.fix));
});

test("the steps follow the gear, and the worst finding colours a report", () => {
  assert.deepEqual(planSteps({ mice: 1, keyboards: 0, controllers: 0 }).map((s) => s.id), ["rest", "clicks", "circles"]);
  assert.deepEqual(planSteps({ mice: 1, keyboards: 1, controllers: 1 }).map((s) => s.id), ["rest", "clicks", "circles", "keys", "hold", "sticks"]);
  assert.deepEqual(planSteps({ mice: 0, keyboards: 0, controllers: 0 }), []);
  assert.match(planSteps({ mice: 0, keyboards: 1, controllers: 0 })[0].hint, /Let go of the keyboard\./);
  const all = planSteps({ mice: 1, keyboards: 1, controllers: 1 });
  const secs = estimateSeconds(all);
  assert.ok(secs >= 45 && secs <= 75, `${secs} s`);
  assert.equal(worst(["good", "warn", "good"]), "warn");
  assert.equal(worst([]), "good");
});
