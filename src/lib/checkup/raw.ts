// A raw run from the desktop app's Raw Input listener (src-tauri/src/rawmouse.rs), split per mouse. Pure.
import type { ButtonEvent, MotionReport } from "./types.ts";

/** What the Rust side returns: one column per field (src-tauri/src/rawmouse.rs `RawMouseRun`). */
export interface RawMouseRun {
  devices: { vid: string; pid: string }[];
  t: number[];
  dev: number[];
  dx: number[];
  dy: number[];
  buttons: number[];
  ended: string;
  /** Reports Windows delivered as to a listener in the background: merged, about 125 a second, so not the mouse's timing. */
  background: number;
}

/** One mouse's part of a raw run. */
export interface RawCapture {
  vid: string;
  pid: string;
  buttons: ButtonEvent[];
  motion: MotionReport[];
}

/** `usButtonFlags` bits -> [DOM button, down]: left, right, middle, back, forward (down then up for each). */
const FLAG_BUTTONS: readonly [number, number, boolean][] = [
  [0x0001, 0, true],
  [0x0002, 0, false],
  [0x0004, 2, true],
  [0x0008, 2, false],
  [0x0010, 1, true],
  [0x0020, 1, false],
  [0x0040, 3, true],
  [0x0080, 3, false],
  [0x0100, 4, true],
  [0x0200, 4, false],
];

/** Splits a raw run per mouse, turning each report's button flags into downs and ups. */
export function expandRun(run: RawMouseRun): RawCapture[] {
  const out: RawCapture[] = run.devices.map((d) => ({ vid: d.vid, pid: d.pid, buttons: [], motion: [] }));
  for (let i = 0; i < run.t.length; i++) {
    const c = out[run.dev[i]];
    if (!c) continue;
    const t = run.t[i];
    const flags = run.buttons[i];
    if (flags) for (const [bit, button, down] of FLAG_BUTTONS) if (flags & bit) c.buttons.push({ t, button, down });
    if (run.dx[i] || run.dy[i]) c.motion.push({ t, dx: run.dx[i], dy: run.dy[i] });
  }
  return out;
}

/** The mouse with the most going on in a set of captures (clicks count more than motion). */
export function busiest(caps: readonly RawCapture[]): RawCapture | null {
  let best: RawCapture | null = null;
  let score = 0;
  for (const c of caps) {
    const s = c.buttons.length * 50 + c.motion.length;
    if (s > score) {
      best = c;
      score = s;
    }
  }
  return best;
}
