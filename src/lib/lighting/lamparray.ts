// Windows Dynamic Lighting (wave L4): the LampArray devices Windows lists (keyboards, mice, strips and cases that speak
// the HID LampArray standard), what each reports about its lamps, and the colours a simple effect gives each lamp at a
// moment. Windows lets only the app in front set these lights; a background ("ambient") controller has to be a packaged
// app that declares the com.microsoft.windows.lighting extension, which SYNQ (unpackaged) can't. Pure.
import type { Rgb } from "./govee/frames";

export interface LampArrayDevice {
  /** Windows' device interface id. */
  id: string;
  name: string;
  /** Windows' LampArrayKind once read (-1 until then; missing in the preview's list). */
  kind?: number;
  /** USB ids, when its interface id or the device gives them ("" when unknown). */
  vid?: string;
  pid?: string;
}

export interface Lamp {
  /** Metres from the device's top-left-front corner. */
  x: number;
  y: number;
  z: number;
  /** LampPurposes flags: 1 control, 2 accent, 4 branding, 8 status, 16 illumination, 32 presentation. */
  purposes: number;
}

export interface LampArrayInfo {
  id: string;
  name: string;
  /** Windows' LampArrayKind. */
  kind: number;
  /** Bounding box, metres. */
  width: number;
  height: number;
  depth: number;
  vid: string;
  pid: string;
  /** Windows lets this app set it now (SYNQ is in front and nothing else holds it). */
  available: boolean;
  /** Dynamic Lighting is on for this device in Settings. */
  enabled: boolean;
  lamps: Lamp[];
}

/** LampArrayKind, as Windows numbers it. */
export const KIND_NAMES: Record<number, string> = {
  0: "Light",
  1: "Keyboard",
  2: "Mouse",
  3: "Game controller",
  4: "Peripheral",
  5: "Scene light",
  6: "Notification light",
  7: "PC case",
  8: "Wearable",
  9: "Furniture",
  10: "Art",
  11: "Headset",
  12: "Microphone",
  13: "Speaker",
};
export const kindName = (k: number) => KIND_NAMES[k] ?? "Light";

export type Effect = "solid" | "breathe" | "rainbow" | "wave";
export const EFFECTS: readonly { id: Effect; label: string }[] = [
  { id: "solid", label: "Solid" },
  { id: "breathe", label: "Breathe" },
  { id: "rainbow", label: "Rainbow" },
  { id: "wave", label: "Wave" },
];

const hsv = (h: number, s: number, v: number): Rgb => {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
};
const scale = (c: Rgb, k: number): Rgb => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];

/** Where a lamp sits across the device, 0 (left) to 1 (right). */
const across = (info: LampArrayInfo, l: Lamp) => (info.width > 0 ? Math.max(0, Math.min(1, l.x / info.width)) : 0);

/**
 * Each lamp's colour at `t` seconds: one colour; that colour breathing (a 3 s cycle at speed 2); a rainbow sweeping
 * across; or the colour travelling across as a wave. `speed` 1-3 (slow, normal, fast).
 */
export function colorsAt(info: LampArrayInfo, effect: Effect, base: Rgb, t: number, speed = 2): Rgb[] {
  const rate = [0, 0.5, 1, 2][Math.max(1, Math.min(3, speed))];
  if (effect === "solid") return info.lamps.map(() => base);
  if (effect === "breathe") {
    const k = 0.15 + 0.85 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t * rate) / 3));
    return info.lamps.map(() => scale(base, k));
  }
  if (effect === "rainbow") return info.lamps.map((l) => hsv((((across(info, l) - t * rate * 0.25) % 1) + 1) % 1, 1, 1));
  return info.lamps.map((l) => {
    const phase = (((across(info, l) - t * rate * 0.4) % 1) + 1) % 1;
    return scale(base, 0.12 + 0.88 * Math.max(0, Math.cos(phase * 2 * Math.PI)) ** 2);
  });
}

/** Whether a lamp array is a device SYNQ already lists (same USB ids), so the two can point at each other. */
export const sameDevice = (info: Pick<LampArrayInfo, "vid" | "pid">, d: { vid: string; pid: string }) => info.vid !== "0000" && info.vid === d.vid.toLowerCase() && info.pid === d.pid.toLowerCase();

/** The preview's lamp array: a 75% keyboard, 6 rows of lamps, 0.32 m wide. */
export function simLampArray(): LampArrayInfo {
  const lamps: Lamp[] = [];
  for (let row = 0; row < 6; row++) for (let col = 0; col < 16; col++) lamps.push({ x: 0.012 + col * 0.0195, y: 0.012 + row * 0.019, z: 0, purposes: 1 });
  return { id: "sim-lamparray", name: "Keyboard (Dynamic Lighting)", kind: 1, width: 0.32, height: 0.12, depth: 0.03, vid: "0000", pid: "0000", available: true, enabled: true, lamps };
}
