// Pins the ROG Falchion Ace HFX ZywOo (0b05:1d1d) encoders to the bytes Gear Link sent in the
// 2026-10-11 hardware capture (docs/keyboard/captures.json), so making the distance unit a parameter
// (Wave 3a, for the 0.01 mm boards) cannot change what SYNQ sends to the HFX.
// Run (no device, no window): node --test scripts/falchion-codec.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../src/lib/keyboard-protocol.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capture = JSON.parse(fs.readFileSync(path.join(root, "docs/keyboard/captures.json"), "utf8"));
const captured = new Set<string>(
  capture.log.filter((e: { kind?: string; hex?: string }) => e.kind === "sendReport" && e.hex).map((e: { hex: string }) => e.hex),
);
/** Hex of a frame with trailing zeros stripped, the capture's format. */
const h = (f: Uint8Array) => {
  let end = f.length;
  while (end > 0 && f[end - 1] === 0) end--;
  return Array.from(f.subarray(0, end), (b) => b.toString(16).padStart(2, "0")).join(" ");
};
const seen = (f: Uint8Array) => {
  assert.equal(f.length, 64);
  assert.ok(captured.has(h(f)), `not in the capture: ${h(f)}`);
};

test("distance unit defaults to 0.1 mm and matches the old Math.round(mm * 10)", () => {
  assert.equal(P.HFX_UNIT_MM, 0.1);
  for (let i = 0; i <= 4000; i++) {
    const mm = i / 1000;
    assert.equal(P.mmToUnits(mm), Math.round(mm * 10), `mm ${mm}`);
    assert.equal(P.mmToUnits(mm, 0.1), Math.round(mm * 10), `mm ${mm}`);
  }
  assert.equal(P.unitsToMm(10), 1);
  assert.equal(P.unitsToMm(25), 2.5);
  // 0.01 mm boards: same helpers with their unit.
  assert.equal(P.mmToUnits(1, 0.01), 100);
  assert.equal(P.mmToUnits(1.15, 0.01), 115);
  assert.equal(P.mmToUnits(0.01, 0.01), 1);
  assert.equal(P.unitsToMm(250, 0.01), 2.5);
});

test("analog encoders reproduce the capture", () => {
  seen(P.encodeGlobalActuation(P.mmToUnits(1.0)));
  seen(P.encodeGlobalActuation(P.mmToUnits(1.1)));
  seen(P.encodeGlobalActuation(P.mmToUnits(2.0)));
  seen(P.encodeKeyActuation(P.fwKey("KeyP"), P.mmToUnits(0.5)));
  seen(P.encodeKeyActuation(P.fwKey("KeyO"), P.mmToUnits(0.7)));
  seen(P.encodeKeyActuation(P.fwKey("KeyO"), P.mmToUnits(0.6)));
  seen(P.encodeGlobalDeadZone(P.mmToUnits(0.4), P.mmToUnits(0.2)));
  seen(P.encodeGlobalDeadZone(P.mmToUnits(0.2), P.mmToUnits(0.4)));
  seen(P.encodeGlobalDeadZone(2, 2));
  seen(P.encodeKeyDeadZone(P.fwKey("KeyP"), 2, 2));
  seen(P.encodeKeyDeadZone(P.fwKey("KeyO"), 2, 2));
  assert.equal(h(P.encodeGlobalActuation(10)), "51 50 00 00 0a");
  assert.equal(h(P.encodeKeyActuation(0x1a, 5)), "51 4f 00 00 1a 00 05");
  assert.equal(h(P.encodeGlobalDeadZone(4, 2)), "51 58 00 00 02 04");
});

test("rapid trigger, Speed Tap, remap, polling, profiles reproduce the capture", () => {
  for (const key of ["KeyW", "KeyA", "KeyS", "KeyD"] as const) {
    const k = P.fwKey(key);
    for (const f of P.encodeRapidTriggerForKey(k, { independent: true, sensitivity: 2, press: 1, release: 1, continuous: false })) seen(f);
    for (const f of P.encodeRapidTriggerForKey(k, { independent: true, sensitivity: 2, press: 1, release: 1, continuous: true })) seen(f);
    for (const f of P.encodeRapidTriggerForKey(k, { independent: false, sensitivity: 2, press: 1, release: 1, continuous: false })) seen(f);
  }
  assert.equal(h(P.encodeRapidTriggerKey({ key: 0x12, mode: "press", sensitivity: 1, continuous: false, enabled: true })), "51 54 01 00 12 00 01 00 01");
  seen(P.encodeSpeedTapEnable(true));
  seen(P.encodeSpeedTapEnable(false));
  seen(P.encodeSpeedTapPair(P.fwKey("KeyA"), P.fwKey("KeyD"), true));
  seen(P.encodeSpeedTapPair(P.fwKey("KeyA"), P.fwKey("KeyD"), false));
  seen(P.encodeKeyRemap(P.fwKey("Insert"), P.fwKey("ScrollLock")));
  seen(P.encodeKeyRemap(P.fwKey("Insert"), P.fwKey("Insert")));
  seen(P.encodePollingRate(8000));
  for (let p = 1; p <= 6; p++) seen(P.encodeSelectProfile(p));
  seen(P.encodeSaveProfile());
  seen(P.encodeResetCurrentProfile());
  for (let fn = 0; fn < 5; fn++) seen(P.encodeTouchPanelFunctionEnable(fn, true));
  seen(P.encodeTouchPanelMode(4));
});

test("lighting and reads reproduce the capture", () => {
  seen(P.encodeSimpleLighting({ effect: "breathing", speed: 30, brightness: 100, singleColor: false, randomColor: false, colors: [{ r: 255, g: 255, b: 0 }, { r: 255, g: 0, b: 255 }] }));
  seen(P.encodeSimpleLighting({ effect: "breathing", speed: 30, brightness: 95, singleColor: false, randomColor: false, colors: [{ r: 255, g: 255, b: 0 }, { r: 255, g: 0, b: 255 }] }));
  seen(P.encodeSimpleLighting({ effect: "static", speed: 255, brightness: 100, singleColor: true, randomColor: false, colors: [{ r: 255, g: 0, b: 0 }] }));
  seen(P.encodeAnalogLighting("static", false));
  seen(P.encodeAnalogLighting("colorCycle", false));
  seen(P.encodeAnalogLighting("rainbow", false));
  for (const f of [P.encodeGetSerial(), P.encodeGetInfo(P.INFO.basic), P.encodeGetInfo(P.INFO.connectionType), P.encodeGetInfo(P.INFO.layout), P.encodeGetInfo(P.INFO.firmwareInfo), P.encodeGetInfo(P.INFO.wdlState), P.encodeGetRapidTriggerState(), P.encodeGetSpeedTapState(), P.encodeGetTouchPanelMode()])
    seen(f);
});
