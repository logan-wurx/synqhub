// Which listed controllers are live: a receiver or dongle whose pad is off is shown greyed and last on the Devices home.
// Only receivers are asked (connect.ts `probeReceiver`: a short read-only look at its input reports, nothing sent, no
// mode change); every other pad counts as live while it's listed. Runs when the list of controllers changes, not on a
// timer.
import { useSyncExternalStore } from "react";
import type { Connected } from "../backend";
import { identifyConnected } from "./identify";

const answers = new Map<string, "live" | "quiet">();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, "live" | "quiet"> = new Map();
const changed = () => {
  snapshot = new Map(answers);
  for (const l of listeners) l();
};

export function usePadAnswers(): ReadonlyMap<string, "live" | "quiet"> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

let running: Promise<void> | null = null;

/** Asks each listed receiver once (keyed by vid:pid); the answers stay until the list changes. */
export function refreshPads(devices: readonly Connected[]): Promise<void> {
  const pads = devices.filter((d) => d.kind === "controller");
  const work = (running ?? Promise.resolve()).then(async () => {
    const keys = new Set(pads.map((d) => `${d.vid}:${d.pid}`));
    for (const k of [...answers.keys()]) if (!keys.has(k)) answers.delete(k);
    // The controller stack loads only when a controller is listed, after the home has painted (this runs from an effect).
    for (const d of pads) {
      const identity = identifyConnected(d);
      if (!identity) continue;
      const { probeReceiver } = await import("./connect");
      answers.set(`${d.vid}:${d.pid}`, await probeReceiver(d, identity).catch(() => "live" as const));
    }
    changed();
  });
  running = work.catch(() => undefined);
  return work;
}

/** A listed pad's answer ("live" until asked). */
export const padLive = (a: ReadonlyMap<string, "live" | "quiet">, d: Connected | undefined): boolean => !d || a.get(`${d.vid}:${d.pid}`) !== "quiet";
