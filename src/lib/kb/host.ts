// What the generic Keyboard panel needs from wherever it runs: the HID devices (the desktop bridge,
// WebHID in a browser, or sample boards in the preview), the drivers, a store for backups and logs,
// and where VIA layouts come from. The desktop host is tauri-host.ts; the preview's is mock.ts.
// No Tauri here.
import { isBootloader } from "../bootloader-ids.ts";
import { driversFor, type KbDriverLoader } from "./registry.ts";
import { KbSession } from "./session.ts";
import type { DefinitionSource, KbDriver, KbStore } from "./types.ts";

export interface KbHost {
  /** Real hardware (false in the preview). */
  live: boolean;
  store: KbStore;
  devices(): Promise<HIDDevice[]>;
  drivers: readonly KbDriverLoader[];
  definitions?: DefinitionSource;
}

const hex = (n: number) => n.toString(16).padStart(4, "0");
export const kbId = (vid: number | string, pid: number | string) => `${typeof vid === "number" ? hex(vid) : vid}:${typeof pid === "number" ? hex(pid) : pid}`;

export interface KbClaim {
  device: HIDDevice;
  driver: KbDriver;
  brand: string;
  name: string;
}

/** The device with this id that a driver claims, and the best driver for it. Never one in update mode. */
export async function claimKeyboard(host: KbHost, id: string): Promise<KbClaim | null> {
  for (const device of await host.devices()) {
    if (kbId(device.vendorId, device.productId) !== id || isBootloader(device.vendorId, device.productId, device.productName)) continue;
    const [driver] = await driversFor(device, host.drivers);
    if (!driver) continue;
    const brand = driver.id === "via" ? "VIA / Vial" : driver.name;
    return { device, driver, brand, name: device.productName.trim() || "Keyboard" };
  }
  return null;
}

/** Which of these ids a keyboard driver claims. Loads only the drivers that could; reads nothing. */
export async function claimKeyboards(host: KbHost, ids: readonly string[]): Promise<Map<string, Omit<KbClaim, "device">>> {
  const out = new Map<string, Omit<KbClaim, "device">>();
  for (const id of new Set(ids)) {
    const c = await claimKeyboard(host, id);
    if (c) out.set(id, { driver: c.driver, brand: c.brand, name: c.name });
  }
  return out;
}

/** Opens the keyboard with this id and reads it. Null when no driver claims it. */
export async function connectKeyboard(host: KbHost, id: string): Promise<KbSession | null> {
  const c = await claimKeyboard(host, id);
  if (!c) return null;
  const backend = await c.driver.open(c.device, { store: host.store, live: host.live, devices: () => host.devices(), definitions: host.definitions });
  return new KbSession(backend, host.store, c.device);
}

/** Whether the keyboard with this id answers a quick read-only check. */
export async function pingKeyboard(host: KbHost, id: string): Promise<boolean> {
  const c = await claimKeyboard(host, id);
  return c ? c.driver.ping(c.device) : false;
}
