// How the checkup listens while a step runs. Two sources for the mouse:
//   raw     the desktop app on Windows: Raw Input in the Rust side (src-tauri/src/rawmouse.rs), one event per report with
//           its arrival time, per mouse (by USB id). Listen only.
//   window  everywhere else: this page's own pointer events, which the system may merge (rough timings).
// Keys always come from this page's own events, and only while the key steps run. Nothing is stored or sent.
import { invoke } from "@tauri-apps/api/core";
import { isTauri, platform } from "../runtime.ts";
import type { RawMouseRun } from "./raw.ts";
import type { ButtonEvent, KeyEvent, MotionReport } from "./types.ts";

/** Raw Input is there: the desktop app on Windows. */
export const rawAvailable = (): boolean => isTauri && platform === "windows";

/** Listens to every mouse for up to `seconds` (motion too with `motion`); null when Raw Input isn't available or refused. */
export async function sampleRaw(seconds: number, motion: boolean): Promise<RawMouseRun | null> {
  if (!rawAvailable()) return null;
  return invoke<RawMouseRun>("mouse_sample", { seconds, motion }).catch(() => null);
}

/** Ends the raw run early (the click step reached its count). */
export function stopRaw(): void {
  if (rawAvailable()) void invoke("mouse_sample_stop").catch(() => undefined);
}

export interface DomCapture {
  buttons: ButtonEvent[];
  motion: MotionReport[];
  keys: KeyEvent[];
}

/**
 * This page's own events for one step. `keys`: the codes whose default action (Space scrolling) is held back
 * while the step listens; every other key behaves as usual. The right-click menu is held back while clicks count.
 */
export function listenDom(opts: { keys?: readonly string[]; clicks?: boolean; onButton?: (e: ButtonEvent) => void; onMotion?: (n: number) => void; onKey?: (e: KeyEvent) => void }): { stop: () => DomCapture } {
  const cap: DomCapture = { buttons: [], motion: [], keys: [] };
  const held = new Set(opts.keys ?? []);
  const down = (e: MouseEvent) => {
    const ev = { t: e.timeStamp, button: e.button, down: true };
    cap.buttons.push(ev);
    opts.onButton?.(ev);
  };
  const up = (e: MouseEvent) => {
    const ev = { t: e.timeStamp, button: e.button, down: false };
    cap.buttons.push(ev);
    opts.onButton?.(ev);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerType && e.pointerType !== "mouse") return;
    const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const all = list.length ? list : [e];
    for (const c of all) if (c.movementX || c.movementY) cap.motion.push({ t: c.timeStamp, dx: c.movementX, dy: c.movementY });
    opts.onMotion?.(all.length);
  };
  const key = (down: boolean) => (e: KeyboardEvent) => {
    if (held.has(e.code)) e.preventDefault();
    const ev = { t: e.timeStamp, code: e.code, down, repeat: e.repeat };
    cap.keys.push(ev);
    opts.onKey?.(ev);
  };
  const keyDown = key(true);
  const keyUp = key(false);
  const menu = (e: Event) => opts.clicks && e.preventDefault();
  // `pointerrawupdate` carries every report the browser got (secure pages only); `pointermove` otherwise.
  const moveEvent = "onpointerrawupdate" in window ? "pointerrawupdate" : "pointermove";
  window.addEventListener("mousedown", down, true);
  window.addEventListener("mouseup", up, true);
  window.addEventListener(moveEvent, move as EventListener, true);
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("keyup", keyUp, true);
  window.addEventListener("contextmenu", menu, true);
  return {
    stop: () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener(moveEvent, move as EventListener, true);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("keyup", keyUp, true);
      window.removeEventListener("contextmenu", menu, true);
      return cap;
    },
  };
}
