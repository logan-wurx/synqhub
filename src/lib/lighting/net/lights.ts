// The Wi-Fi lights as the Devices home and their pages list them: what the last "Find lights" found this session.
// Discovery (mDNS, SSDP and each brand's own broadcast; about 1.5 s) runs only when the person presses Find lights
// (so with SYNQ in front): never in the background, never on a timer. Nothing here changes a light.
import { useSyncExternalStore } from "react";
import type { NetDevice } from "./brands.ts";
import { findNetLights, openUp } from "./link.ts";

let lights: readonly NetDevice[] = [];
let finding = false;
let looked = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((cb) => cb());

/** Asks the network now (the person pressed Find lights); how many lights are listed after. One find at a time. */
export async function findLights(): Promise<number> {
  if (finding) return lights.length;
  finding = true;
  emit();
  try {
    lights = await findNetLights();
  } catch {
    // Nothing found this time; the list stays as it was.
  } finally {
    looked = true;
    finding = false;
    emit();
  }
  return lights.length;
}

const same = (a: Pick<NetDevice, "brand" | "id">, b: Pick<NetDevice, "brand" | "id">) => a.brand === b.brand && a.id === b.id;

/** A light was just paired: it (a Hue bridge: its lights, asked of the bridge) takes its place in the list. */
export async function paired(d: NetDevice): Promise<void> {
  const now = await openUp({ ...d, paired: true });
  lights = [...lights.filter((x) => !same(x, d)), ...now];
  emit();
}

/** A light's pairing was forgotten: it is listed unpaired again (a Hue bridge: the bridge, not its lights). */
export function forgotten(d: NetDevice): void {
  const bridge: NetDevice = { ...d, paired: false, sub: undefined, name: d.brand === "hue" ? "Hue Bridge" : d.name };
  lights = [...lights.filter((x) => !same(x, d)), bridge];
  emit();
}

const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => subs.delete(cb);
};

/** The Wi-Fi lights found this session (no network: Find lights asks). */
export const useNetLights = (): readonly NetDevice[] => useSyncExternalStore(subscribe, () => lights);
/** Whether a Find lights is running. */
export const useNetFinding = () => useSyncExternalStore(subscribe, () => finding);
/** Whether Find lights has run this session (before that, a light's page offers it). */
export const useNetLooked = () => useSyncExternalStore(subscribe, () => looked);
