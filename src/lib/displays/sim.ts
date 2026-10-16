// The browser preview's monitor and webcam: answers like the bridge's DDC/CI and UVC commands would, keeps what it is
// set to, and refuses what the guards refuse. Nothing here is real hardware.
import { vcpRefusal, type Caps, type Reading } from "./vcp.ts";
import { uvcRefusal, type CamControl } from "./uvc.ts";

const caps: Caps = {
  model: "VG248",
  mccs: "2.2",
  vcp: { "16": [], "18": [], "20": [5, 6, 8, 11], "22": [], "24": [], "26": [], "96": [3, 15, 17], "98": [], "141": [1, 2], "214": [1, 4, 5], "223": [] },
};
const values = new Map<number, Reading>([
  [0x10, { code: 0x10, value: 70, max: 100 }],
  [0x12, { code: 0x12, value: 80, max: 100 }],
  [0x14, { code: 0x14, value: 6, max: 11 }],
  [0x16, { code: 0x16, value: 100, max: 100 }],
  [0x18, { code: 0x18, value: 100, max: 100 }],
  [0x1a, { code: 0x1a, value: 100, max: 100 }],
  [0x60, { code: 0x60, value: 15, max: 17 }],
  [0x62, { code: 0x62, value: 40, max: 100 }],
  [0x8d, { code: 0x8d, value: 2, max: 2 }],
  [0xd6, { code: 0xd6, value: 1, max: 5 }],
  [0xdf, { code: 0xdf, value: 0x0202, max: 0 }],
]);

export const simMonitorCaps = (): Caps => structuredClone(caps);
export const simMonitorRead = (codes: number[]): Reading[] => codes.map((c) => values.get(c)).filter((r): r is Reading => !!r).map((r) => ({ ...r }));

export function simMonitorWrite(code: number, value: number, confirm: boolean): Reading {
  const now = values.get(code);
  if (!now) throw new Error("The monitor didn't report that setting.");
  const why = vcpRefusal(code, value, caps, now.max, confirm);
  if (why) throw new Error(why);
  const next = { ...now, value };
  values.set(code, next);
  return { ...next };
}

const controls = new Map<string, CamControl>([
  ["exposure", { id: "exposure", min: -11, max: -2, step: 1, default: -6, value: -6, auto: true, canAuto: true }],
  ["focus", { id: "focus", min: 0, max: 250, step: 5, default: 0, value: 30, auto: true, canAuto: true }],
  ["zoom", { id: "zoom", min: 100, max: 500, step: 1, default: 100, value: 100, auto: false, canAuto: false }],
  ["brightness", { id: "brightness", min: 0, max: 255, step: 1, default: 128, value: 128, auto: false, canAuto: false }],
  ["contrast", { id: "contrast", min: 0, max: 255, step: 1, default: 128, value: 128, auto: false, canAuto: false }],
  ["saturation", { id: "saturation", min: 0, max: 255, step: 1, default: 128, value: 128, auto: false, canAuto: false }],
  ["whiteBalance", { id: "whiteBalance", min: 2000, max: 7500, step: 10, default: 4000, value: 4000, auto: true, canAuto: true }],
  ["powerline", { id: "powerline", min: 0, max: 2, step: 1, default: 2, value: 2, auto: false, canAuto: false }],
]);

export const simWebcamControls = (): CamControl[] => [...controls.values()].map((c) => ({ ...c }));

export function simWebcamSet(id: string, value: number, auto: boolean): CamControl {
  const c = controls.get(id);
  if (!c) throw new Error("The camera doesn't report that control.");
  const why = uvcRefusal(id, c, value, auto);
  if (why) throw new Error(why);
  const next = { ...c, auto, value: auto ? c.value : value };
  controls.set(id, next);
  return { ...next };
}
