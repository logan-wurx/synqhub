// SYNQ Helper's status where the whole window can see it (the sidebar chip, Settings, the welcome flow).
// Read once when something first asks; the Settings card publishes every change. Nothing polls.
import { useSyncExternalStore } from "react";
import { helper, type HelperStatus } from "./helper";

let status: HelperStatus | null = null;
let started = false;
const listeners = new Set<() => void>();

export function publishHelper(next: HelperStatus) {
  status = next;
  for (const l of [...listeners]) l();
}

export function useHelperStatus(): HelperStatus | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      if (!started) {
        started = true;
        helper.status().then(publishHelper, () => undefined);
      }
      return () => listeners.delete(l);
    },
    () => status,
  );
}
