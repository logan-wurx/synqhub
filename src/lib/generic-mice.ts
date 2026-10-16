// Desktop glue for the generic (OpenMouse) mouse path: picks the host (the Rust bridge, or the
// preview's sample mice) and keeps a candidate from the device list only once an OpenMouse driver
// claims it. Everything here loads on demand, so a PC with no such mouse never downloads a driver.
//
// A driver that matches by vendor id alone (vendor ids like 0x093A or 0x373E are shared by several
// brands) can claim hardware that isn't its mouse, so such a claim counts only once the mouse has
// also answered a read-only identify (the driver's cheapest read). That answer is kept while the
// device stays plugged in; a mouse that didn't answer is asked again on a later list change, at most
// every RETRY_MS. Generic keyboards are confirmed the same way by src/lib/kb/confirm.ts.
import { inTauri, type Connected } from "./backend";

const WEB = typeof __ONBOARD_WEB__ !== "undefined" && __ONBOARD_WEB__ === true;

import type { GenericHost } from "./openmouse/host";

let host: Promise<GenericHost> | null = null;
export function genericHost(): Promise<GenericHost> {
  host ??= inTauri
    ? import("./openmouse/tauri-host").then((m) => m.tauriHost)
    : WEB
      ? import("./openmouse/web-host").then((m) => m.webMouseHost)
      : import("./openmouse/mock").then((m) => m.sampleHost);
  return host;
}

const identified: import("./openmouse/host").IdentifyCache = new Map();

/**
 * The list with generic candidates resolved: claimed mice named by their driver (vendor-wide claims
 * only once they answered), generic keyboards confirmed by their own path, the rest dropped. A mouse
 * candidate no mouse driver claims, but which has a QMK raw-HID collection, is offered to the
 * keyboard path as a VIA/Vial board. Devices in firmware-update mode pass through as they are.
 */
export async function confirmGeneric(list: Connected[]): Promise<Connected[]> {
  const mice = list.filter((d) => d.generic && d.kind === "mouse" && !d.bootloader);
  let resolved: Connected[] = list;
  if (mice.length) {
    try {
      const [h, { confirmMice, idKey }] = await Promise.all([genericHost(), import("./openmouse/host")]);
      const claimed = await confirmMice(h, mice.map((d) => idKey(d.vid, d.pid)), identified);
      const keep = new Map<string, Connected>();
      for (const d of mice) {
        const id = idKey(d.vid, d.pid);
        const c = claimed.get(id);
        if (c) keep.set(id, { ...d, name: c.name, brand: c.brand, driver: c.driver });
      }
      resolved = list.flatMap((d) => {
        if (!d.generic || d.kind !== "mouse" || d.bootloader) return [d];
        const k = keep.get(idKey(d.vid, d.pid));
        if (k) return [k];
        // Not a mouse any driver claims: a QMK raw-HID board can still be a VIA/Vial keyboard.
        return d.qmk ? [{ ...d, kind: "keyboard" as const, kb: "qmk" as const }] : [];
      });
    } catch (e) {
      console.warn("[onboard] couldn't check OpenMouse candidates", e);
      resolved = list.filter((d) => !(d.generic && d.kind === "mouse"));
    }
  }
  if (!resolved.some((d) => d.generic && d.kind === "keyboard")) return resolved;
  try {
    return await (await import("./kb/confirm")).confirmKeyboards(resolved);
  } catch (e) {
    console.warn("[onboard] couldn't check keyboard candidates", e);
    return resolved.filter((d) => !(d.generic && d.kind === "keyboard"));
  }
}
