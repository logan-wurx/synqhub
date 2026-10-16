// The checkup's shapes: what is recorded during the guided steps, and what comes out of them. Pure data.
import type { FixIntent } from "./fix.ts";

/** One button going down or up. `button`: 0 left, 1 middle, 2 right, 3 back, 4 forward. */
export interface ButtonEvent {
  t: number;
  button: number;
  down: boolean;
}

/** One motion report (relative counts). */
export interface MotionReport {
  t: number;
  dx: number;
  dy: number;
}

/** One key going down or up, by `KeyboardEvent.code`. `repeat`: the OS's auto-repeat, not a new press. */
export interface KeyEvent {
  t: number;
  code: string;
  down: boolean;
  repeat: boolean;
}

/**
 * Where mouse timings came from. `raw`: Windows Raw Input in the app, one event per report with the time it
 * arrived, per mouse. `window`: the page's own pointer events, which the system may merge; rough.
 */
export type MouseSource = "raw" | "window";

/** What a mouse sent during the steps. */
export interface MouseCapture {
  source: MouseSource;
  buttons: ButtonEvent[];
  motion: MotionReport[];
}

export type Level = "good" | "warn" | "bad";

/** What a "Fix it" button changes: one of the settings the device's own panel can already write. */
export interface Fix {
  /** The device (navigation id: `mouse:atk`, `kb:x68`). */
  device: string;
  /** "Raise debounce to 8 ms or more"; exact once the device's page has resolved it. */
  label: string;
  intent: FixIntent;
  /** Why it can't be pressed (the device is read-only, or can't take that change). */
  blocked?: string;
}

export interface Finding {
  /** Stable within a report ("clicks.left", "polling.rate"). */
  id: string;
  level: Level;
  /** One short sentence: "The left button double-clicks on its own". */
  title: string;
  /** What was measured, in plain words with the numbers. */
  detail: string;
  fix?: Fix;
  /** When nothing in SYNQ can fix it, what can: said plainly ("The switch is wearing out..."). */
  advice?: string;
  /** A page that deals with it ("Open Sound"). */
  open?: { label: string; device: string };
}

/** Everything the checkup found on one device. */
export interface DeviceReport {
  device: string;
  name: string;
  kind: "mouse" | "keyboard" | "controller" | "sound";
  level: Level;
  findings: Finding[];
  /** What was looked at, for the all-clear line: "clicks, polling, sensor". */
  checked: string[];
  /** How the timings were taken ("Raw Input", "the window's events"), when that matters. */
  source?: string;
  /** It wasn't part of the steps, and why (the other mouse was used, the pad was asleep). */
  skipped?: string;
}
