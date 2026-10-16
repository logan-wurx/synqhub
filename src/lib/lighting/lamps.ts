// The lamps SYNQ can reach, as the Lights page and the lamp pages list them. The Bluetooth scan behind the list
// (src-tauri/src/lighting/govee/ble.rs) runs only while a page that shows lamps is on screen, the window is in use and
// someone has touched the mouse or keyboard in the last minute; the bridge stops it a minute after the last ask. A
// page left idle goes quiet, and the next touch scans again. Nothing here connects to a lamp.
import { useEffect, useSyncExternalStore } from "react";
import { isActive, onActivityChange } from "../activity";
import { listLamps } from "./link.ts";
import { weak, type LampInfo } from "./models.ts";
import { settle } from "./signal.ts";

const SCAN_MS = 4000;
/** No mouse or key input for this long: the scan rests until the next one. */
const QUIET_MS = 60_000;

let lamps: readonly LampInfo[] = [];
let shape = "";
const subs = new Set<() => void>();
let scanners = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let offActivity: (() => void) | null = null;
let lastInput = performance.now();
let resting = false;
const INPUT = ["pointerdown", "pointermove", "keydown", "wheel"] as const;

/** Input while lamps are shown (passive listeners, only then): note the time, and wake a resting scan. */
function onInput() {
  lastInput = performance.now();
  if (!resting) return;
  resting = false;
  void poll();
  schedule();
}

/** Stops the scan until the next input. */
function rest() {
  resting = true;
  if (timer) clearInterval(timer);
  timer = null;
}

/** The cards change when a lamp comes, goes, crosses the weak-signal line or starts or stops syncing; the dBm wobbling
 * alone redraws nothing. */
const shapeOf = (list: readonly LampInfo[]) => list.map((l) => `${l.id}|${l.name}|${weak(l)}|${l.sync?.edge ?? ""}`).join();

async function poll() {
  let next: LampInfo[];
  try {
    next = (await listLamps()).map((l) => settle(l));
  } catch {
    return;
  }
  const s = shapeOf(next);
  if (s === shape) return;
  shape = s;
  lamps = next;
  subs.forEach((cb) => cb());
}

/** Scans while someone shows lamps and the window is in use; a background window scans nothing. */
function schedule() {
  if (timer) clearInterval(timer);
  timer = null;
  if (scanners > 0 && isActive() && !resting)
    timer = setInterval(() => {
      if (performance.now() - lastInput > QUIET_MS) rest();
      else void poll();
    }, SCAN_MS);
}

function onActivity() {
  if (isActive()) {
    // Coming back to the window counts as input.
    const woke = resting;
    onInput();
    if (!woke) void poll();
  }
  schedule();
}

function subscribe(cb: () => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}
const snapshot = () => lamps;

/** Reads the list now, not at the next scan: the website's Add a light just added one. */
export const refreshLamps = (): Promise<void> => poll();

/** The lamps heard last (no scan of its own). */
export const useLamps = (): readonly LampInfo[] => useSyncExternalStore(subscribe, snapshot);

/** The lamps in range, kept fresh while the calling page is on screen (and `on`). */
export function useLampScan(on = true): readonly LampInfo[] {
  useEffect(() => {
    if (!on) return;
    scanners++;
    lastInput = performance.now();
    if (scanners === 1) for (const e of INPUT) window.addEventListener(e, onInput, { passive: true });
    offActivity ??= onActivityChange(onActivity);
    void poll();
    schedule();
    return () => {
      scanners--;
      if (scanners === 0) {
        offActivity?.();
        offActivity = null;
        resting = false;
        for (const e of INPUT) window.removeEventListener(e, onInput);
      }
      schedule();
    };
  }, [on]);
  return useLamps();
}
