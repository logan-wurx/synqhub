// Monitors (DDC/CI) and webcams (UVC), the pure parts (src/lib/displays): the shared allowlists, the TypeScript guards
// and their case file (the Rust guards in src-tauri/src/monitors.rs and webcams.rs are held to the same file), value
// names, and the preview's simulated monitor and webcam refusing what the guards refuse.
//   node --test scripts/displays.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INPUT_CODE, READ_ONLY, VCP, valueName, vcpRefusal, type Caps } from "../src/lib/displays/vcp.ts";
import { UVC, onStep, uvcLabel, uvcRefusal } from "../src/lib/displays/uvc.ts";
import { simMonitorRead, simMonitorWrite, simWebcamControls, simWebcamSet } from "../src/lib/displays/sim.ts";
import { caseLines } from "./display-allowlist-fixture.ts";

const CAPS: Caps = { model: "X", mccs: "2.2", vcp: { "16": [], "20": [5, 6], "96": [3, 15, 17], "4": [], "214": [1, 4, 5] } };

test("display-cases.txt is still what the guards say (regenerate with node scripts/display-allowlist-fixture.ts)", () => {
  const file = readFileSync(new URL("../src/lib/displays/display-cases.txt", import.meta.url), "utf8").trim().split(/\r?\n/);
  assert.deepEqual(file, caseLines());
});

test("the VCP allowlist: picture, colour, volume and input only; power and the MCCS version read only", () => {
  assert.deepEqual(VCP.map((s) => s.code), [0x10, 0x12, 0x14, 0x16, 0x18, 0x1a, 0x62, 0x8d, 0x60]);
  assert.deepEqual(READ_ONLY, [0xd6, 0xdf]);
  assert.equal(VCP.find((s) => s.code === INPUT_CODE)?.confirm, true);
  for (const never of [0x04, 0x05, 0x06, 0x08, 0x0a, 0x0c, 0xd6, 0xdf, 0xe0, 0xff]) assert.ok(!VCP.some((s) => s.code === never), `0x${never.toString(16)}`);
});

test("the VCP guard: in range, listed, confirmed", () => {
  assert.equal(vcpRefusal(0x10, 50, CAPS, 100, false), null);
  assert.match(vcpRefusal(0x10, 150, CAPS, 100, false)!, /maximum/);
  assert.equal(vcpRefusal(0x14, 6, CAPS, 11, false), null);
  assert.match(vcpRefusal(0x14, 7, CAPS, 11, false)!, /isn't a value/);
  assert.match(vcpRefusal(0x60, 17, CAPS, 17, false)!, /confirmation/);
  assert.equal(vcpRefusal(0x60, 17, CAPS, 17, true), null);
  assert.match(vcpRefusal(0x04, 1, CAPS, 1, true)!, /isn't one SYNQ changes/, "factory reset");
  assert.match(vcpRefusal(0x12, 10, CAPS, 100, false)!, /doesn't list/, "a code this monitor doesn't list");
});

test("value names", () => {
  assert.equal(valueName(0x60, 0x0f), "DisplayPort");
  assert.equal(valueName(0x60, 0x11), "HDMI");
  assert.equal(valueName(0x14, 0x05), "6500 K");
  assert.equal(valueName(0x60, 0x99), "0x99");
  assert.equal(valueName(0x10, 70), "70");
});

test("the UVC allowlist and guard keep to the camera's range, step and auto", () => {
  assert.deepEqual(UVC.map((s) => s.id), ["exposure", "focus", "zoom", "pan", "tilt", "brightness", "contrast", "saturation", "whiteBalance", "powerline"]);
  const wb = { min: 2800, max: 6500, step: 10, canAuto: false };
  assert.equal(uvcRefusal("whiteBalance", wb, 4000, false), null);
  assert.match(uvcRefusal("whiteBalance", wb, 4005, false)!, /step/);
  assert.match(uvcRefusal("whiteBalance", wb, 0, true)!, /no automatic/);
  assert.match(uvcRefusal("gain", wb, 4000, false)!, /isn't a webcam control/);
  assert.equal(onStep(wb, 4004), 4000);
  assert.equal(onStep(wb, 9000), 6500);
  assert.equal(uvcLabel(UVC.find((s) => s.id === "powerline")!, 2), "60 Hz");
  assert.equal(uvcLabel(UVC.find((s) => s.id === "whiteBalance")!, 4000), "4000 K");
});

test("the preview's monitor and webcam refuse what the guards refuse", () => {
  assert.throws(() => simMonitorWrite(0x60, 0x11, false), /confirmation/);
  assert.equal(simMonitorWrite(0x10, 55, false).value, 55);
  assert.equal(simMonitorRead([0x10])[0].value, 55);
  assert.throws(() => simMonitorWrite(0x04, 1, true), "a factory reset is never sent");
  assert.ok(simWebcamControls().some((c) => c.id === "exposure" && c.canAuto));
  assert.equal(simWebcamSet("focus", 35, false).value, 35);
  assert.throws(() => simWebcamSet("focus", 33, false), /step/);
});
