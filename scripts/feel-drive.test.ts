// "Keep your feel": running a plan's steps through each device's own session (src/lib/feel/drive.ts). The
// sessions are stand-ins that record what they are asked; the real ones do the backup, the tier checks and
// the read-back (their own tests cover that). Nothing here touches a device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyToFalchion, driveAtk, driveFalchion, driveGenericKeyboard, driveGenericMouse, driveLogitech, driveX68, x68SocdTable, x68Triggers } from "../src/lib/feel/drive.ts";
import type { Step } from "../src/lib/feel/types.ts";
import type { Change, WriteResult } from "../src/lib/openmouse/safe-mouse.ts";
import type { KbAnyChange, KbWriteResult } from "../src/lib/kb/types.ts";
import type { ProfileSettings } from "../src/lib/keyboard.ts";
import { atkView, genericKeyboardView, genericMouseView, logitechView, x68View } from "./feel-fixtures.ts";

const calls: string[] = [];
const fresh = () => (calls.length = 0);

// ---------------------------------------------------------------------------------------------
// Mice
// ---------------------------------------------------------------------------------------------

function logitech(fail?: string) {
  const op = (name: string) => async (...args: unknown[]) => {
    calls.push(`${name}(${args.join(",")})`);
    if (name === fail) throw new Error(`${name} failed`);
    return logitechView({ pollingHz: 4000 });
  };
  return { saveStages: op("saveStages"), setActiveDpi: op("setActiveDpi"), setPolling: op("setPolling"), setLod: op("setLod") };
}

const ALL_MOUSE_STEPS: Step[] = [
  { kind: "stages", values: [400, 800], active: 1 },
  { kind: "polling", hz: 2000 },
  { kind: "lod", level: "Medium" },
];

test("Logitech: stages, polling and lift-off go to the session's own calls, in order", async () => {
  fresh();
  const seen: number[] = [];
  const r = await driveLogitech(logitech(), ALL_MOUSE_STEPS, (v) => seen.push(v.pollingHz));
  assert.deepEqual(calls, ["saveStages(400,800,1)", "setPolling(2000)", "setLod(Medium)"]);
  assert.equal(r.ok, true);
  assert.equal(r.done, 3);
  assert.equal(r.total, 3);
  assert.equal(r.error, null);
  assert.equal(r.view!.pollingHz, 4000);
  assert.equal(seen.length, 3, "the panel hears about every new view");
  fresh();
  await driveLogitech(logitech(), [{ kind: "dpi", dpi: 1000 }]);
  assert.deepEqual(calls, ["setActiveDpi(1000)"]);
});

test("Logitech: it stops at the first change that fails and says how far it got", async () => {
  fresh();
  const r = await driveLogitech(logitech("setPolling"), ALL_MOUSE_STEPS);
  assert.deepEqual(calls, ["saveStages(400,800,1)", "setPolling(2000)"]);
  assert.equal(r.ok, false);
  assert.equal(r.done, 1);
  assert.equal(r.total, 3);
  assert.equal(r.error, "setPolling failed");
  assert.ok(r.view, "the view after the step that did go through");
});

test("Logitech: a step the mouse has no call for is refused, not guessed", async () => {
  fresh();
  const r = await driveLogitech(logitech(), [{ kind: "lod", mm: 1.2 }, { kind: "polling", hz: 500 }]);
  assert.equal(r.ok, false);
  assert.match(r.error!, /can't take a "lod" change/);
  assert.deepEqual(calls, []);
  const d = await driveLogitech(logitech(), [{ kind: "debounce", ms: 2 }]);
  assert.equal(d.ok, false);
});

test("ATK: every kind of step has its call", async () => {
  fresh();
  const op = (name: string) => async (...args: unknown[]) => {
    calls.push(`${name}(${args.join(",")})`);
    return atkView();
  };
  const s = {
    saveStages: op("saveStages"),
    setActiveDpi: op("setActiveDpi"),
    setPolling: op("setPolling"),
    setLiftOff: op("setLiftOff"),
    setAngleSnapping: op("setAngleSnapping"),
    setRippleControl: op("setRippleControl"),
    setMotionSync: op("setMotionSync"),
    setDebounce: op("setDebounce"),
  };
  const r = await driveAtk(s, [
    { kind: "stages", values: [800, 1600], active: 0 },
    { kind: "dpi", dpi: 900 },
    { kind: "polling", hz: 8000 },
    { kind: "lod", mm: 1.1 },
    { kind: "debounce", ms: 2 },
    { kind: "toggle", setting: "angleSnapping", on: true },
    { kind: "toggle", setting: "motionSync", on: false },
    { kind: "toggle", setting: "rippleControl", on: true },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [
    "saveStages(800,1600,0)",
    "setActiveDpi(900)",
    "setPolling(8000)",
    "setLiftOff(1.1)",
    "setDebounce(2)",
    "setAngleSnapping(true)",
    "setMotionSync(false)",
    "setRippleControl(true)",
  ]);
  const level = await driveAtk(s, [{ kind: "lod", level: "Low" }]);
  assert.equal(level.ok, false, "the X1 takes millimetres, not levels");
});

function safeMouse(verdict: (c: Change) => WriteResult["verdict"] = () => "confirmed") {
  return {
    async apply(c: Change): Promise<WriteResult> {
      calls.push(JSON.stringify(c));
      const v = verdict(c);
      return { view: genericMouseView(), verdict: v, persistence: "saved" as never, detail: v === "mismatch" ? "The mouse reports 500 instead of 1000" : "Read back from the mouse" };
    },
  };
}

test("generic mouse: each step is one SafeMouse change", async () => {
  fresh();
  const r = await driveGenericMouse(safeMouse(), [
    { kind: "stages", values: [400, 800], active: 1 },
    { kind: "polling", hz: 1000 },
    { kind: "lod", level: "High" },
    { kind: "debounce", ms: 3 },
    { kind: "toggle", setting: "motionSync", on: true },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => JSON.parse(c)), [
    { kind: "stages", values: [400, 800], active: 1 },
    { kind: "polling", hz: 1000 },
    { kind: "lod", value: "High" },
    { kind: "debounce", ms: 3 },
    { kind: "toggle", setting: "motionSync", on: true },
  ]);
});

test("generic mouse: a change the mouse didn't take stops the run and says what it reports", async () => {
  fresh();
  const r = await driveGenericMouse(safeMouse((c) => (c.kind === "polling" ? "mismatch" : "confirmed")), [
    { kind: "dpi", dpi: 800 },
    { kind: "polling", hz: 1000 },
    { kind: "debounce", ms: 2 },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.done, 1);
  assert.equal(r.error, "The mouse reports 500 instead of 1000");
  assert.equal(calls.length, 2, "nothing after it was sent");
});

test("generic mouse: an unconfirmed read-back is not a failure", async () => {
  fresh();
  const r = await driveGenericMouse(safeMouse(() => "unconfirmed"), [{ kind: "dpi", dpi: 800 }]);
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------------------------

function kbSession(verdict: (c: KbAnyChange) => KbWriteResult["verdict"] = () => "confirmed") {
  return {
    async apply(c: KbAnyChange): Promise<KbWriteResult> {
      calls.push(JSON.stringify(c));
      const v = verdict(c);
      return { view: genericKeyboardView(), verdict: v, persistence: "saved", detail: v === "mismatch" ? "The keyboard reports 2 instead of 1.2" : "Read back" };
    },
  };
}

test("generic keyboard: a global board gets global analog changes, one field per step", async () => {
  fresh();
  const r = await driveGenericKeyboard(
    kbSession(),
    genericKeyboardView(),
    [
      { kind: "actuation", mm: 1.2 },
      { kind: "rtSensitivity", pressMm: 0.3, releaseMm: 0.5 },
      { kind: "rapidTrigger", on: true },
    ],
  );
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => JSON.parse(c)), [
    { kind: "analog", target: "global", values: { actuationMm: 1.2 } },
    { kind: "analog", target: "global", values: { rtPressMm: 0.3, rtReleaseMm: 0.5 } },
    { kind: "analog", target: "global", values: { rapidTrigger: true } },
  ]);
});

test("generic keyboard: a per-key board gets every analog key; a board with one sensitivity gets only the press value", async () => {
  fresh();
  const v = genericKeyboardView();
  const perKey = { ...v, analog: { ...v.analog!, scope: "per-key" as const, keys: [3, 4, 5], writable: ["actuationMm", "rtPressMm", "rapidTrigger"] as never } };
  await driveGenericKeyboard(kbSession(), perKey, [{ kind: "actuation", mm: 2 }, { kind: "rtSensitivity", pressMm: 0.4, releaseMm: 0.4 }]);
  assert.deepEqual(calls.map((c) => JSON.parse(c)), [
    { kind: "analog", target: [3, 4, 5], values: { actuationMm: 2 } },
    { kind: "analog", target: [3, 4, 5], values: { rtPressMm: 0.4 } },
  ]);
  const none = await driveGenericKeyboard(kbSession(), { ...perKey, analog: { ...perKey.analog, keys: undefined }, keymap: undefined }, [{ kind: "actuation", mm: 2 }]);
  assert.equal(none.ok, false);
  assert.match(none.error!, /which keys are analog/);
});

test("generic keyboard: SOCD pairs are set by the indexes of their keys", async () => {
  fresh();
  const r = await driveGenericKeyboard(kbSession(), genericKeyboardView(), [{ kind: "socd", pairs: [{ a: "W", b: "S", mode: "neutral" }, { a: "A", b: "D", mode: "last" }] }]);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => JSON.parse(c)), [
    { kind: "socd", keys: [2, 3], mode: "neutral" },
    { kind: "socd", keys: [0, 1], mode: "last" },
  ]);
  fresh();
  const missing = await driveGenericKeyboard(kbSession(), genericKeyboardView(), [{ kind: "socd", pairs: [{ a: "A", b: "Q", mode: "last" }] }]);
  assert.equal(missing.ok, false);
  assert.match(missing.error!, /Q isn't a key/);
  assert.deepEqual(calls, []);
});

test("generic keyboard: a read-back mismatch stops the run", async () => {
  fresh();
  const r = await driveGenericKeyboard(kbSession((c) => (c.kind === "analog" && "actuationMm" in c.values ? "mismatch" : "confirmed")), genericKeyboardView(), [
    { kind: "actuation", mm: 1.2 },
    { kind: "rapidTrigger", on: true },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.done, 0);
  assert.match(r.error!, /reports 2 instead of 1\.2/);
  assert.equal(calls.length, 1);
});

test("generic keyboard: steps it has no call for are refused", async () => {
  const r = await driveGenericKeyboard(kbSession(), genericKeyboardView(), [{ kind: "polling", hz: 1000 }]);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------------------------
// Falchion
// ---------------------------------------------------------------------------------------------

function falchionSettings(): ProfileSettings {
  return {
    actuation: 15,
    top: 1,
    bottom: 1,
    keys: {},
    rapidTrigger: { enabled: false, keys: [1], independent: false, continuous: false, sensitivity: 4, press: 4, release: 4, custom: {} },
  } as unknown as ProfileSettings;
}

test("Falchion: the plan's millimetres become its 0.1 mm units", () => {
  const s = falchionSettings();
  applyToFalchion(s, [
    { kind: "actuation", mm: 1.2 },
    { kind: "rtSensitivity", pressMm: 0.3, releaseMm: 0.3 },
    { kind: "rapidTrigger", on: true },
  ]);
  assert.equal(s.actuation, 12);
  assert.deepEqual({ ...s.rapidTrigger, keys: undefined, custom: undefined }, { enabled: true, keys: undefined, independent: false, continuous: false, sensitivity: 3, press: 3, release: 3, custom: undefined });
  assert.deepEqual(s.rapidTrigger.keys, [1], "which keys have rapid trigger is the person's choice and stays");
});

test("Falchion: different press and release switch it to separate distances; values stay inside its limits", () => {
  const s = falchionSettings();
  applyToFalchion(s, [{ kind: "rtSensitivity", pressMm: 0.2, releaseMm: 0.5 }]);
  assert.equal(s.rapidTrigger.independent, true);
  assert.equal(s.rapidTrigger.press, 2);
  assert.equal(s.rapidTrigger.release, 5);
  applyToFalchion(s, [{ kind: "actuation", mm: 9 }, { kind: "rtSensitivity", pressMm: 0.01, releaseMm: 9 }]);
  assert.equal(s.actuation, 40);
  assert.equal(s.rapidTrigger.press, 1);
  assert.equal(s.rapidTrigger.release, 20);
});

test("Falchion: the whole plan is one edit, and an unsupported step queues nothing", async () => {
  fresh();
  const s = falchionSettings();
  const session = {
    async update(label: string, change: (p: ProfileSettings) => void) {
      calls.push(label);
      change(s);
      return {};
    },
  };
  const ok = await driveFalchion(session, [{ kind: "actuation", mm: 1.2 }, { kind: "rapidTrigger", on: true }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, ["Keep your feel"]);
  assert.equal(s.actuation, 12);
  fresh();
  const bad = await driveFalchion(session, [{ kind: "actuation", mm: 1 }, { kind: "polling", hz: 1000 }]);
  assert.equal(bad.ok, false);
  assert.deepEqual(calls, []);
  assert.equal(s.actuation, 12, "untouched");
  const boom = await driveFalchion({ update: async () => Promise.reject(new Error("The keyboard didn't answer.")) }, [{ kind: "actuation", mm: 1 }]);
  assert.equal(boom.error, "The keyboard didn't answer.");
});

// ---------------------------------------------------------------------------------------------
// X68 HE
// ---------------------------------------------------------------------------------------------

const state = (over: Parameters<typeof x68View>[0] = {}) => x68View(over).state;

test("X68 HE: actuation goes to every key the card writes, in travel units, and not to locked keys", () => {
  const out = x68Triggers(state(), [{ kind: "actuation", mm: 1.25 }]);
  // Keys 0, 1, 2 and 4 are editable (3 is Esc, locked). Key 3 has travel 200, key 2 has 120: both left alone or changed to 125.
  assert.deepEqual(out.map((k) => [k.index, k.travel]), [[0, 125], [1, 125], [2, 125], [4, 125]]);
  assert.ok(out.every((k) => k.mode === 12 && k.press === 30), "mode and rapid-trigger distances untouched");
});

test("X68 HE: a key that already has the value isn't written again", () => {
  assert.deepEqual(x68Triggers(state(), [{ kind: "actuation", mm: 1.5 }]).map((k) => k.index), [2], "only the 1.2 mm key differs");
});

test("X68 HE: rapid-trigger distances set both ways, and split mode appears only when they differ", () => {
  const same = x68Triggers(state(), [{ kind: "rtSensitivity", pressMm: 0.4, releaseMm: 0.4 }]);
  assert.ok(same.every((k) => k.press === 40 && k.release === 40 && k.mode === 12));
  const split = x68Triggers(state(), [{ kind: "rtSensitivity", pressMm: 0.2, releaseMm: 0.5 }]);
  assert.ok(split.every((k) => k.press === 20 && k.release === 50 && k.mode === 13));
  // Back to one distance on keys that were split: they go back to plain rapid trigger, with release = press.
  const back = x68Triggers(state({ keys: { 0: { index: 0, mode: 13, travel: 150, press: 20, release: 50 } } }), [{ kind: "rtSensitivity", pressMm: 0.3, releaseMm: 0.3 }]);
  assert.deepEqual(back.map((k) => [k.mode, k.press, k.release]), [[13, 30, 30]], "a key that was split stays split when both distances are equal");
});

test("X68 HE: rapid trigger on and off", () => {
  const off = state({ keys: { 0: { index: 0, mode: 12, travel: 150, press: 30, release: 30 }, 1: { index: 1, mode: 0, travel: 150, press: 30, release: 30 } } });
  assert.deepEqual(x68Triggers(off, [{ kind: "rapidTrigger", on: false }]).map((k) => [k.index, k.mode]), [[0, 0]]);
  assert.deepEqual(x68Triggers(off, [{ kind: "rapidTrigger", on: true }]).map((k) => [k.index, k.mode]), [[1, 12]]);
  // On with separate distances in the same plan: split.
  const both = x68Triggers(off, [{ kind: "rtSensitivity", pressMm: 0.2, releaseMm: 0.4 }, { kind: "rapidTrigger", on: true }]);
  assert.ok(both.every((k) => k.mode === 13 && k.press === 20 && k.release === 40));
});

test("X68 HE: distances stay inside the board's range, and a missing table is an error", () => {
  const out = x68Triggers(state(), [{ kind: "actuation", mm: 9 }, { kind: "rtSensitivity", pressMm: 0.001, releaseMm: 9 }]);
  assert.ok(out.every((k) => k.travel === 400 && k.press === 1 && k.release === 200));
  assert.throws(() => x68Triggers(state({ trigger: null }), [{ kind: "actuation", mm: 1 }]), /couldn't read this keyboard's trigger table/);
  assert.throws(() => x68Triggers(state(), [{ kind: "polling", hz: 1000 }]), /can't take/);
});

test("X68 HE: SOCD pairs are added after the ones the board has", () => {
  const table = x68SocdTable(state(), [{ a: "W", b: "S", mode: "priorityB" }, { a: "Left", b: "Right", mode: "neutral" }]);
  assert.deepEqual(table, [
    { index: 0, mode: 0, key1: 0x04, key2: 0x07, state: 1 },
    { index: 1, mode: 2, key1: 0x1a, key2: 0x16 },
    { index: 2, mode: 3, key1: 0x50, key2: 0x4f },
  ]);
  assert.throws(() => x68SocdTable(state(), [{ a: "A", b: "D", mode: "deeper" }]), /can't set "A \+ D"/);
  assert.throws(() => x68SocdTable(state(), [{ a: "A", b: "F13", mode: "last" }]), /can't set/);
});

test("X68 HE: triggers are written once, then SOCD; nothing is written when the plan can't be built", async () => {
  fresh();
  const s = {
    async setTriggers(label: string, changes: { index: number }[]) {
      calls.push(`setTriggers(${label}:${changes.length})`);
      return "ok";
    },
    async setSocd(label: string, entries: unknown[], on: boolean) {
      calls.push(`setSocd(${label}:${entries.length}:${on})`);
      return "ok";
    },
  };
  const r = await driveX68(s, state(), [{ kind: "actuation", mm: 1 }, { kind: "rapidTrigger", on: false }, { kind: "socd", pairs: [{ a: "W", b: "S", mode: "last" }] }]);
  assert.equal(r.ok, true);
  assert.equal(r.done, 3);
  assert.deepEqual(calls, ["setTriggers(Keep your feel:4)", "setSocd(Keep your feel: SOCD pairs:2:true)"]);

  fresh();
  const bad = await driveX68(s, state(), [{ kind: "actuation", mm: 1 }, { kind: "socd", pairs: [{ a: "A", b: "D", mode: "deeper" }] }]);
  assert.equal(bad.ok, false);
  assert.deepEqual(calls, [], "the SOCD problem is found before the trigger table is written");

  fresh();
  const same = await driveX68(s, state(), [{ kind: "actuation", mm: 1.5 }, { kind: "polling", hz: 1000 }]);
  assert.equal(same.ok, false);
  assert.deepEqual(calls, []);

  const failing = { ...s, setSocd: async () => Promise.reject(new Error("The board stopped answering.")) };
  const half = await driveX68(failing, state(), [{ kind: "actuation", mm: 1 }, { kind: "socd", pairs: [{ a: "W", b: "S", mode: "last" }] }]);
  assert.equal(half.ok, false);
  assert.equal(half.done, 1, "the triggers went through, the SOCD didn't");
  assert.equal(half.error, "The board stopped answering.");
});
