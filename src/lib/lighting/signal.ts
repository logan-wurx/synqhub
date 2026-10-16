// A lamp's weak-signal state, settled from its recent readings: at the edge of reach one Bluetooth reading is often a
// few dB off, and judging each reading alone made a lamp near the line flip between "in range" and "weak" (and its card
// grey out and back) on every scan. Pure; the scan store (./lamps.ts) keeps the history.
import { WEAK_RSSI, type LampInfo } from "./models.ts";

/** Readings kept per lamp for the median. */
const READINGS = 5;
/** A lamp in range turns weak below this (median), and a weak one comes back above the other: a lamp sitting near the
 * line keeps its state instead of flipping with every reading. */
const WEAK_BELOW = WEAK_RSSI - 2;
const BACK_ABOVE = WEAK_RSSI + 3;
const readings = new Map<string, number[]>();
const settled = new Map<string, boolean>();

/** The lamp with its weak-signal state settled from its recent readings. */
export function settle(l: LampInfo, history = readings, states = settled): LampInfo {
  const r = [...(history.get(l.id) ?? []), l.rssi].slice(-READINGS);
  history.set(l.id, r);
  const m = [...r].sort((a, b) => a - b)[r.length >> 1];
  const was = states.get(l.id);
  const now = was === undefined ? m < WEAK_RSSI : was ? m < BACK_ABOVE : m < WEAK_BELOW;
  states.set(l.id, now);
  return { ...l, weak: now };
}
