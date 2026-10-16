// "Keep your feel" against the real shapes of each panel's kept view: what a device can take, what it holds
// now (which is what "Save as my feel" saves), that a device always matches its own feel, and the plans
// between brands. Also the constants the feature copies from the protocol modules, kept equal here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIFT_OFF } from "../src/lib/atk-protocol.ts";
import { TRIGGER_MODE } from "../src/lib/x68he-protocol.ts";
import {
  ATK_LIFT_OFF,
  FALCHION_LIMITS,
  HID_KEY_NAMES,
  X68_MODE,
  atkMouse,
  describeKeyboard,
  describeMouse,
  falchionKeyboard,
  genericKeyIndex,
  genericKeyboard,
  genericMouse,
  hidUsageOf,
  keyNameOf,
  logitechMouse,
  mostCommon,
  x68Keyboard,
} from "../src/lib/feel/devices.ts";
import { mapKeyboard } from "../src/lib/feel/keyboard.ts";
import { mapMouse } from "../src/lib/feel/mouse.ts";
import { keyboardSummary, mouseSummary } from "../src/lib/feel/profile.ts";
import type { GenericView } from "../src/lib/openmouse/safe-mouse.ts";
import type { KbView } from "../src/lib/kb/types.ts";
import { atkView, falchionView, genericKeyboardView, genericMouseView, logitechView, x68View } from "./feel-fixtures.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NO_SENS = { cs2: null, valorant: null };

// ---------------------------------------------------------------------------------------------
// Constants copied from the protocol modules
// ---------------------------------------------------------------------------------------------

test("the ATK lift-off scale is the protocol's", () => {
  assert.equal(ATK_LIFT_OFF.min, LIFT_OFF.minMm);
  assert.equal(ATK_LIFT_OFF.max, LIFT_OFF.maxMm);
  assert.equal(ATK_LIFT_OFF.step, LIFT_OFF.stepMm);
});

test("the X68 trigger modes are the protocol's", () => {
  assert.deepEqual({ ...X68_MODE }, { ...TRIGGER_MODE });
});

test("the Falchion's limits are the ones in src/lib/keyboard.ts", () => {
  const src = readFileSync(join(root, "src/lib/keyboard.ts"), "utf8");
  const block = src.slice(src.indexOf("export const LIMITS"), src.indexOf("} as const;", src.indexOf("export const LIMITS")));
  const pair = (name: string) => {
    const m = block.match(new RegExp(`${name}: \\{ min: (\\d+), max: (\\d+) \\}`));
    return { min: Number(m?.[1]), max: Number(m?.[2]) };
  };
  assert.deepEqual({ ...FALCHION_LIMITS.actuation }, pair("actuation"));
  assert.deepEqual({ ...FALCHION_LIMITS.rapidTrigger }, pair("rapidTrigger"));
});

// ---------------------------------------------------------------------------------------------
// Key names
// ---------------------------------------------------------------------------------------------

test("pair names: letters, digits, arrows and a few modifiers, from legends of any style", () => {
  assert.equal(keyNameOf("a"), "A");
  assert.equal(keyNameOf(" D "), "D");
  assert.equal(keyNameOf("5"), "5");
  assert.equal(keyNameOf("←"), "Left");
  assert.equal(keyNameOf("Left Arrow"), "Left");
  assert.equal(keyNameOf("SPACE"), "Space");
  assert.equal(keyNameOf("L Shift"), "Shift");
  assert.equal(keyNameOf("Fn"), null);
  assert.equal(keyNameOf("F5"), null);
  assert.equal(keyNameOf(""), null);
  assert.equal(keyNameOf(undefined), null);
});

test("HID usages and names agree", () => {
  assert.equal(HID_KEY_NAMES[0x04], "A");
  assert.equal(HID_KEY_NAMES[0x07], "D");
  assert.equal(HID_KEY_NAMES[0x1d], "Z");
  assert.equal(HID_KEY_NAMES[0x1e], "1");
  assert.equal(HID_KEY_NAMES[0x27], "0");
  assert.equal(HID_KEY_NAMES[0x50], "Left");
  assert.equal(hidUsageOf("a"), 0x04);
  assert.equal(hidUsageOf("Right"), 0x4f);
  assert.equal(hidUsageOf("Nope"), null);
  for (const [usage, name] of Object.entries(HID_KEY_NAMES)) assert.equal(hidUsageOf(name), Number(usage), name);
});

test("mostCommon", () => {
  assert.equal(mostCommon([1, 2, 2, 3], 9), 2);
  assert.equal(mostCommon([], 9), 9);
});

// ---------------------------------------------------------------------------------------------
// Mice
// ---------------------------------------------------------------------------------------------

test("Logitech: its own steps, polling list and three lift-off levels", () => {
  const d = logitechMouse(logitechView());
  assert.deepEqual(d.target.dpi, { min: 100, max: 44000, step: 50 });
  assert.deepEqual(d.target.stages, { max: 5, fixedCount: null });
  assert.deepEqual(d.target.polling!.options, [125, 250, 500, 1000, 2000, 4000, 8000]);
  assert.deepEqual(d.target.lod, { kind: "levels", levels: ["Low", "Medium", "High"] });
  assert.equal(d.target.debounce, null);
  assert.deepEqual(d.target.toggles, { angleSnapping: false, motionSync: false, ripple: false });
  assert.deepEqual(d.now, { stages: [400, 800, 1600], active: 1, pollingHz: 1000, lod: { kind: "level", level: "Low" }, debounceMs: null, angleSnapping: null, motionSync: null, ripple: null });
});

test("Logitech: a mouse whose steps weren't read has no 'now' and can't be saved", () => {
  assert.equal(logitechMouse(logitechView({ stages: [] })).now, null);
  assert.equal(logitechMouse(logitechView({ lods: [], lod: null })).target.lod, null);
});

test("ATK: millimetres of lift-off, debounce and the three toggles", () => {
  const d = atkMouse(atkView());
  assert.deepEqual(d.target.dpi, { min: 100, max: 26000, step: 50 });
  assert.deepEqual(d.target.stages, { max: 6, fixedCount: null });
  assert.deepEqual(d.target.lod, { kind: "mm", min: 0.7, max: 1.7, step: 0.1 });
  assert.deepEqual(d.target.debounce, { options: [0, 1, 2, 4, 8] });
  assert.deepEqual(d.target.toggles, { angleSnapping: true, motionSync: true, ripple: true });
  assert.deepEqual(d.now, { stages: [400, 800, 1600, 3200], active: 2, pollingHz: 4000, lod: { kind: "mm", mm: 0.9, min: 0.7, max: 1.7 }, debounceMs: 2, angleSnapping: false, motionSync: true, ripple: true });
  assert.equal(atkMouse(atkView({ liftOffMm: null })).now!.lod, null);
});

test("generic mouse: only what the driver can set is offered", () => {
  const d = genericMouse(
    genericMouseView({
      dpi: { value: 800, options: [400, 800, 1600], min: 400, max: 1600, step: 400, canSet: true },
      stages: null,
      polling: { hz: 1000, options: [500, 1000], canSet: false, note: null },
      lod: null,
      toggles: [{ setting: "motionSync", value: true, canSet: true }, { setting: "angleSnapping", value: false, canSet: false }],
      debounce: { ms: 3, options: [1, 2, 3], canSet: true },
    } as Partial<GenericView>),
  );
  assert.deepEqual(d.target.dpi, { min: 400, max: 1600, step: 400, options: [400, 800, 1600] });
  assert.equal(d.target.stages, null);
  assert.equal(d.target.polling, null, "a rate the driver can read but not set is not available");
  assert.equal(d.target.lod, null);
  assert.deepEqual(d.target.debounce, { options: [1, 2, 3] });
  assert.deepEqual(d.target.toggles, { angleSnapping: false, motionSync: true, ripple: false });
  assert.deepEqual(d.now, { stages: [800], active: 0, pollingHz: 1000, lod: null, debounceMs: 3, angleSnapping: false, motionSync: true, ripple: null });
});

test("generic mouse: a fixed number of steps", () => {
  const v = genericMouseView();
  const d = genericMouse({ ...v, stages: { ...v.stages!, countEditable: false } });
  assert.deepEqual(d.target.stages, { max: 5, fixedCount: 4 });
  assert.deepEqual(d.target.dpi, { min: 100, max: 35000, step: 50, options: undefined });
});

test("describeMouse picks the reader by family, and says nothing before the panel read the mouse", () => {
  assert.ok(describeMouse("logitech", logitechView()));
  assert.ok(describeMouse("atk", atkView()));
  assert.ok(describeMouse("om:1532:00c1", genericMouseView()));
  assert.equal(describeMouse("atk", null), null);
  assert.equal(describeMouse("mystery", {}), null);
});

// ---------------------------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------------------------

test("Falchion: 0.1 mm units, rapid trigger with press and release", () => {
  const d = falchionKeyboard(falchionView());
  assert.deepEqual(d.target.actuation, { min: 0.1, max: 4, step: 0.1 });
  assert.deepEqual(d.target.rtSensitivity, { min: 0.1, max: 2, step: 0.1, independent: true });
  assert.equal(d.target.rapidTrigger, true);
  assert.equal(d.target.socd, null);
  assert.deepEqual(d.now, { actuationMm: 1.2, rapidTrigger: true, rtPressMm: 0.3, rtReleaseMm: 0.3, socd: null });
  const split = falchionKeyboard(falchionView({ rapidTrigger: { enabled: false, keys: [], independent: true, continuous: false, sensitivity: 3, press: 2, release: 5, custom: {} } }));
  assert.deepEqual(split.now, { actuationMm: 1.2, rapidTrigger: false, rtPressMm: 0.2, rtReleaseMm: 0.5, socd: null });
});

test("X68 HE: 0.01 mm units from the board's own trigger table", () => {
  const d = x68Keyboard(x68View());
  assert.deepEqual(d.target.actuation, { min: 0.1, max: 4, step: 0.01 });
  assert.deepEqual(d.target.rtSensitivity, { min: 0.01, max: 2, step: 0.01, independent: true });
  // The Esc key is locked; the most common travel among the others is 1.5 mm.
  assert.deepEqual(d.now, { actuationMm: 1.5, rapidTrigger: true, rtPressMm: 0.3, rtReleaseMm: 0.3, socd: [{ a: "A", b: "D", mode: "last" }] });
  assert.equal(d.target.socd!.maxPairs, 20);
  assert.deepEqual(d.target.socd!.modes, ["last", "priorityA", "priorityB", "neutral"]);
  assert.ok(d.target.socd!.keys.includes("A") && d.target.socd!.keys.includes("Left"));
  assert.deepEqual(d.target.socd!.existing, [{ a: "A", b: "D", mode: "last" }]);
});

test("X68 HE: rapid trigger is on when any key has it; SOCD only when the board has the table", () => {
  const off = x68Keyboard(x68View({ keys: { 0: { index: 0, mode: 0, travel: 150, press: 30, release: 30 }, 1: { index: 1, mode: 0, travel: 150, press: 30, release: 30 } }, socd: null }));
  assert.equal(off.now!.rapidTrigger, false);
  assert.equal(off.target.socd, null);
  assert.equal(off.now!.socd, null);
  const none = x68Keyboard(x68View({ trigger: null }));
  assert.equal(none.now, null);
  assert.equal(none.target.actuation, null);
  assert.equal(none.target.rtSensitivity, null);
});

test("generic keyboard: ranges and toggles from the driver, only for fields it can write", () => {
  const d = genericKeyboard(genericKeyboardView());
  assert.deepEqual(d.target.actuation, { min: 0.1, max: 4, step: 0.1 });
  assert.deepEqual(d.target.rtSensitivity, { min: 0.1, max: 2, step: 0.1, independent: true });
  assert.equal(d.target.rapidTrigger, true);
  assert.deepEqual(d.now, { actuationMm: 1.5, rapidTrigger: true, rtPressMm: 0.3, rtReleaseMm: 0.4, socd: [{ a: "A", b: "D", mode: "last" }] });

  const v = genericKeyboardView();
  const readOnly = genericKeyboard({ ...v, analog: { ...v.analog!, writable: ["actuationMm"] } });
  assert.notEqual(readOnly.target.actuation, null);
  assert.equal(readOnly.target.rapidTrigger, false, "a field the driver can't change is not available");
  assert.equal(readOnly.target.rtSensitivity, null);

  const oneSens = genericKeyboard({ ...v, analog: { ...v.analog!, writable: ["actuationMm", "rtPressMm"] } });
  assert.equal(oneSens.target.rtSensitivity!.independent, false);
});

test("generic keyboard: per-key boards report the most common value", () => {
  const v = genericKeyboardView();
  const d = genericKeyboard({ ...v, analog: { ...v.analog!, scope: "per-key", global: null, perKey: { 0: { actuationMm: 1.2, rapidTrigger: true }, 1: { actuationMm: 1.2, rapidTrigger: false }, 2: { actuationMm: 2 } } } });
  assert.equal(d.now!.actuationMm, 1.2);
  assert.equal(d.now!.rapidTrigger, true);
});

test("generic keyboard: SOCD needs a driver that writes it and a keymap with legends", () => {
  const v = genericKeyboardView();
  assert.deepEqual([...genericKeyIndex(v)].sort(), [["A", 0], ["D", 1], ["Left", 5], ["S", 3], ["W", 2]]);
  assert.deepEqual(genericKeyboard(v).target.socd!.keys.sort(), ["A", "D", "Left", "S", "W"]);
  assert.equal(genericKeyboard({ ...v, advanced: { ...v.advanced!, writable: [] } }).target.socd, null);
  assert.equal(genericKeyboard({ ...v, keymap: undefined }).target.socd, null);
  assert.equal(genericKeyboard({ ...v, analog: undefined }).now, null);
});

test("describeKeyboard picks the reader by family", () => {
  assert.ok(describeKeyboard("falchion", falchionView()));
  assert.ok(describeKeyboard("x68", x68View()));
  assert.ok(describeKeyboard("kb:31e3:1322", genericKeyboardView()));
  assert.equal(describeKeyboard("x68", null), null);
  assert.equal(describeKeyboard("falchion", {}), null);
});

// ---------------------------------------------------------------------------------------------
// A device always matches its own feel; and the way between brands
// ---------------------------------------------------------------------------------------------

test("every mouse panel's view matches the feel it would save", () => {
  for (const [name, d] of [
    ["logitech", logitechMouse(logitechView())],
    ["atk", atkMouse(atkView())],
    ["generic", genericMouse(genericMouseView())],
  ] as const) {
    const p = mapMouse(d.now!, d, NO_SENS);
    assert.equal(p.nothingToDo, true, name);
    assert.deepEqual(p.differences, [], name);
    assert.ok(p.rows.every((r) => r.status === "same"), name);
  }
});

test("every keyboard panel's view matches the feel it would save", () => {
  for (const [name, d] of [
    ["falchion", falchionKeyboard(falchionView())],
    ["x68", x68Keyboard(x68View())],
    ["generic", genericKeyboard(genericKeyboardView())],
  ] as const) {
    const p = mapKeyboard(d.now!, d);
    assert.equal(p.nothingToDo, true, name);
    assert.deepEqual(p.differences, [], name);
  }
});

test("Logitech -> ATK: levels become millimetres, the list of rates is kept, ATK-only settings are untouched", () => {
  const feel = logitechMouse(logitechView()).now!;
  const p = mapMouse(feel, atkMouse(atkView()), NO_SENS);
  assert.deepEqual(p.steps.find((s) => s.kind === "stages"), { kind: "stages", values: [400, 800, 1600], active: 1 });
  assert.deepEqual(p.steps.find((s) => s.kind === "polling"), { kind: "polling", hz: 1000 });
  assert.deepEqual(p.steps.find((s) => s.kind === "lod"), { kind: "lod", mm: 0.7 });
  assert.ok(!p.steps.some((s) => s.kind === "debounce" || s.kind === "toggle"), "nothing in the feel for them");
  assert.equal(p.sens!.exact, true);
});

test("ATK -> Logitech: millimetres become a level, debounce and toggles are not available", () => {
  const feel = atkMouse(atkView()).now!;
  const p = mapMouse(feel, logitechMouse(logitechView({ lod: "High", pollingHz: 500 })), { cs2: 0.5, valorant: null });
  assert.deepEqual(p.steps.find((s) => s.kind === "lod"), { kind: "lod", level: "Low" }, "0.9 mm sits at 0.2 of 0.7-1.7");
  assert.deepEqual(p.steps.find((s) => s.kind === "polling"), { kind: "polling", hz: 4000 });
  assert.deepEqual(p.differences.filter((d) => d.kind === "unavailable").map((d) => d.setting).sort(), ["angleSnapping", "debounce", "motionSync", "ripple"]);
  assert.equal(p.sens!.exact, true);
});

test("ATK -> a mouse with a short list of DPIs and rates: the changes are named and the sens is converted", () => {
  const feel = atkMouse(atkView({ stages: [400, 800, 1250], activeStage: 2 })).now!;
  const slow = genericMouse(
    genericMouseView({
      dpi: { value: 800, options: [400, 800, 1600, 3200], min: 400, max: 3200, step: 400, canSet: true },
      stages: { values: [400, 800, 1600], active: 1, maxStages: 3, countEditable: false, min: 400, max: 3200, step: 400, canSet: true },
      polling: { hz: 500, options: [500, 1000], canSet: true, note: null },
    } as Partial<GenericView>),
  );
  const p = mapMouse(feel, slow, { cs2: 0.55, valorant: 0.173 });
  assert.deepEqual(p.steps.find((s) => s.kind === "stages"), { kind: "stages", values: [400, 800, 1600], active: 2 });
  assert.deepEqual(p.steps.find((s) => s.kind === "polling"), { kind: "polling", hz: 1000 }, "4000 Hz is above the list: clamped to its top");
  assert.equal(p.sens!.oldDpi, 1250);
  assert.equal(p.sens!.newDpi, 1600);
  assert.equal(p.sens!.cs2!.next, 0.43);
  assert.equal(p.sens!.valorant!.next, 0.135);
});

test("Falchion -> X68 HE: finer units keep 0.1 mm values exactly; separate press and release survive", () => {
  const feel = falchionKeyboard(falchionView({ rapidTrigger: { enabled: true, keys: [1], independent: true, continuous: false, sensitivity: 3, press: 2, release: 5, custom: {} } })).now!;
  const p = mapKeyboard(feel, x68Keyboard(x68View()));
  assert.deepEqual(p.steps, [
    { kind: "actuation", mm: 1.2 },
    { kind: "rtSensitivity", pressMm: 0.2, releaseMm: 0.5 },
  ]);
  assert.deepEqual(p.differences, []);
});

test("X68 HE -> Falchion: 0.01 mm values land on 0.1 mm; the SOCD pair is not available", () => {
  const view = x68View({ keys: { 0: { index: 0, mode: 12, travel: 125, press: 25, release: 35 }, 1: { index: 1, mode: 12, travel: 125, press: 25, release: 35 } } });
  const feel = x68Keyboard(view).now!;
  assert.equal(feel.actuationMm, 1.25);
  const p = mapKeyboard(feel, falchionKeyboard(falchionView()));
  assert.deepEqual(p.steps.find((s) => s.kind === "actuation"), { kind: "actuation", mm: 1.3 });
  assert.deepEqual(p.steps.find((s) => s.kind === "rtSensitivity"), { kind: "rtSensitivity", pressMm: 0.3, releaseMm: 0.4 });
  assert.ok(p.differences.some((d) => d.setting === "socd" && d.kind === "unavailable"));
  assert.ok(!p.steps.some((s) => s.kind === "socd"));
});

test("X68 HE -> a generic keyboard: the SOCD pair is found by key name", () => {
  const feel = x68Keyboard(x68View({ socd: { on: true, entries: [{ index: 0, mode: 2, key1: 0x1a, key2: 0x16, state: 1 }, { index: 1, mode: 0, key1: 0x50, key2: 0x4f, state: 1 }] } })).now!;
  assert.deepEqual(feel.socd, [{ a: "W", b: "S", mode: "priorityB" }, { a: "Left", b: "Right", mode: "last" }]);
  const target = genericKeyboard(genericKeyboardView({ advanced: { socd: { modes: ["last", "neutral", "priorityA", "priorityB"], pairs: [], maxPairs: 4 }, writable: ["socd"] } } as Partial<KbView>));
  const p = mapKeyboard(feel, target);
  // The sample keymap has W, S and a Left arrow but no Right arrow.
  assert.deepEqual(p.steps.find((s) => s.kind === "socd"), { kind: "socd", pairs: [{ a: "W", b: "S", mode: "priorityB" }] });
  assert.equal(p.differences.filter((d) => d.setting === "socd").length, 1);
});

test("summaries read like a sentence", () => {
  assert.equal(mouseSummary(atkMouse(atkView()).now!), "1600 DPI · 4 kHz · 0.9 mm lift-off");
  assert.equal(mouseSummary(logitechMouse(logitechView()).now!), "800 DPI · 1 kHz · Low lift-off");
  assert.equal(keyboardSummary(falchionKeyboard(falchionView()).now!), "1.2 mm · rapid trigger 0.3 mm");
  assert.equal(keyboardSummary({ actuationMm: 1, rapidTrigger: false, rtPressMm: 0.2, rtReleaseMm: 0.2, socd: [{ a: "A", b: "D", mode: "last" }] }), "1.0 mm · rapid trigger off · 1 SOCD pair");
});
