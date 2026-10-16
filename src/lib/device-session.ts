// Device sessions that outlive the panel showing them. A panel holds its slot while it's mounted;
// when it unmounts the session stays open, so coming straight back is instant and nothing in
// flight is cut off. Once no panel has held it for IDLE_MS, nothing is in flight and there are no
// unsaved edits, the slot's close() runs (the driver's own close, as the Reconnect button uses).
// Nothing here sends anything to a device.
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./backend";

const IDLE_MS = 30_000;

interface Slot {
  holders: number;
  inFlight: number;
  timer: number;
  /** Closes the session; set by the panel. */
  close: () => Promise<void>;
  /** False while there are unsaved edits that must not be dropped. */
  canClose: () => boolean;
}

const slots = new Map<string, Slot>();

function slot(key: string): Slot {
  let s = slots.get(key);
  if (!s) slots.set(key, (s = { holders: 0, inFlight: 0, timer: 0, close: async () => {}, canClose: () => true }));
  return s;
}

function arm(key: string, s: Slot) {
  window.clearTimeout(s.timer);
  s.timer = 0;
  if (s.holders > 0) return;
  s.timer = window.setTimeout(() => {
    s.timer = 0;
    if (s.holders > 0) return;
    // Busy or holding unsaved edits: look again later rather than cut anything off.
    if (s.inFlight > 0 || !s.canClose()) return arm(key, s);
    void s.close().catch(() => undefined);
  }, IDLE_MS);
}

/**
 * The device went away: closes its session now, as unmounting its panel used to. The caller
 * forgets the panel's kept state, so the next time it's plugged in the panel starts fresh.
 */
export function endSession(key: string): void {
  const s = slots.get(key);
  if (!s) return;
  window.clearTimeout(s.timer);
  s.timer = 0;
  void s.close().catch(() => undefined);
}

/**
 * Whether a panel is showing the session `key` or has work in flight on it. The mouse check
 * (src/lib/mouse-probe.ts) leaves such a device alone: it isn't opened or closed from under the panel.
 */
export function sessionHeld(key: string): boolean {
  const s = slots.get(key);
  return !!s && (s.holders > 0 || s.inFlight > 0);
}

/** Device work in flight across all sessions; the app doesn't suspend a minimized page meanwhile (src-tauri/src/sleep.rs). */
let busyCount = 0;
function busy(delta: 1 | -1) {
  const was = busyCount > 0;
  busyCount += delta;
  if (inTauri && was !== busyCount > 0) void invoke("page_busy", { busy: busyCount > 0 }).catch(() => undefined);
}

/** Runs `work` as part of the session `key`: the session isn't closed while it's in flight. */
export function track<T>(key: string, work: Promise<T>): Promise<T> {
  const s = slot(key);
  s.inFlight++;
  busy(1);
  const done = () => {
    s.inFlight--;
    busy(-1);
  };
  work.then(done, done);
  return work;
}

/**
 * Holds the session `key` while the calling panel is mounted. `close` and `canClose` are read
 * when the idle timer runs out, so they may use the panel's kept state.
 */
export function useSessionHold(key: string, close: () => Promise<void>, canClose: () => boolean = () => true): void {
  const latest = useRef({ close, canClose });
  latest.current = { close, canClose };
  useEffect(() => {
    const s = slot(key);
    s.close = () => latest.current.close();
    s.canClose = () => latest.current.canClose();
    s.holders++;
    arm(key, s);
    return () => {
      s.holders--;
      arm(key, s);
    };
  }, [key]);
}
