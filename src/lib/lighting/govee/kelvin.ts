// White as Govee's colour frames carry it: a colour temperature and the RGB the app renders it to (Tanner Helland's
// fit, as the reference integration has it). The guards hold every white frame to this rendering. Pure.
import type { Rgb } from "./frames.ts";

/** White is set in steps of 100 K. */
export const KELVIN_STEP = 100;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

export function kelvinRgb(kelvin: number): Rgb {
  const t = Math.max(1000, Math.min(10000, kelvin)) / 100;
  const red = t <= 66 ? 255 : clamp(Math.trunc(329.698727446 * (t - 60) ** -0.1332047592), 0, 255);
  const green = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const blue = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [Math.trunc(red), clamp(Math.trunc(green), 0, 255), clamp(Math.trunc(blue), 0, 255)];
}
