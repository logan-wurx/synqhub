// Desktop glue for generic keyboards: picks the host (the Rust bridge, or the preview's sample
// boards) and keeps a keyboard candidate from the device list only once a keyboard driver claims it
// (no I/O: ids and collections). Loaded only when the list has such a candidate.
import { inTauri, type Connected } from "../backend.ts";

const WEB = typeof __ONBOARD_WEB__ !== "undefined" && __ONBOARD_WEB__ === true;

import type { KbHost } from "./host.ts";

let host: Promise<KbHost> | null = null;
export function kbHost(): Promise<KbHost> {
  host ??= inTauri
    ? import("./tauri-host.ts").then((m) => m.tauriKbHost)
    : WEB
      ? import("./web-host.ts").then((m) => m.webKbHost)
      : import("./mock.ts").then((m) => m.sampleKbHost);
  return host;
}

/** The list with keyboard candidates resolved: claimed ones named, the rest dropped. */
export async function confirmKeyboards(list: Connected[]): Promise<Connected[]> {
  const candidates = list.filter((d) => d.generic && d.kind === "keyboard" && !d.bootloader);
  if (!candidates.length) return list;
  const [h, { claimKeyboards, kbId }] = await Promise.all([kbHost(), import("./host.ts")]);
  const claimed = await claimKeyboards(h, candidates.map((d) => kbId(d.vid, d.pid)));
  return list.flatMap((d) => {
    if (!d.generic || d.kind !== "keyboard" || d.bootloader) return [d];
    const c = claimed.get(kbId(d.vid, d.pid));
    if (!c) return [];
    return [{ ...d, name: d.reported?.trim() || c.name, brand: c.brand, driver: c.driver.id }];
  });
}
