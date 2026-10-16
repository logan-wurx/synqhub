// React side of the feature: the store as a hook, and the list of mice and keyboards that are plugged in.
import { useEffect, useSyncExternalStore } from "react";
import { feelStore } from "./persist.ts";
import type { FeelState } from "./store.ts";

/** The kept-state key that says a device page should show its "Match your setup" preview (the home's banner sets it). */
export const openKey = (id: string): string => `feel.open.${id}`;

export function useFeel(): FeelState {
  useEffect(() => {
    void feelStore.ready();
  }, []);
  return useSyncExternalStore(feelStore.subscribe, feelStore.getState);
}
