// Webcams over UVC: the controls SYNQ may set (src/lib/displays/uvc.json, the same file the Rust side reads) and the
// TypeScript copy of the guard (src-tauri/src/webcams.rs `guard`), both held to display-cases.txt. Pure.
import table from "./uvc.json" with { type: "json" };

export interface UvcSpec {
  id: string;
  label: string;
  iface: "camera" | "proc";
  prop: number;
  unit?: string;
  labels?: Record<string, string>;
}

export const UVC: readonly UvcSpec[] = table.allowed as UvcSpec[];

/** One control as the camera reports it (src-tauri/src/webcams.rs `Control`). */
export interface CamControl {
  id: string;
  min: number;
  max: number;
  step: number;
  default: number;
  value: number;
  auto: boolean;
  canAuto: boolean;
}

/** Null when SYNQ may set the control to `value` (or to auto), else why not. */
export function uvcRefusal(id: string, c: Pick<CamControl, "min" | "max" | "step" | "canAuto">, value: number, auto: boolean): string | null {
  if (!UVC.some((s) => s.id === id)) return `Refused: "${id}" isn't a webcam control SYNQ changes.`;
  if (auto) return c.canAuto ? null : "This camera has no automatic mode for that.";
  if (value < c.min || value > c.max) return `Refused: ${value} is outside the camera's range (${c.min} to ${c.max}).`;
  if (c.step > 0 && (value - c.min) % c.step !== 0) return `Refused: ${value} isn't on the camera's step of ${c.step}.`;
  return null;
}

/** The nearest value on the camera's grid (sliders move freely; the camera takes steps). */
export function onStep(c: Pick<CamControl, "min" | "max" | "step">, v: number): number {
  const s = c.step > 0 ? c.step : 1;
  return Math.min(c.max, Math.max(c.min, c.min + Math.round((v - c.min) / s) * s));
}

export const uvcLabel = (spec: UvcSpec, v: number): string => spec.labels?.[String(v)] ?? `${v}${spec.unit ? ` ${spec.unit}` : ""}`;
