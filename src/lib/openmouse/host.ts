// What the generic mouse panel needs from wherever it runs: a list of HID devices (the desktop
// bridge, WebHID in a browser, or sample devices in the preview), the driver lookup, and a store for
// backups and logs. The desktop host is tauri-host.ts; the preview host is mock.ts. No Tauri here.
import { SafeMouse } from "./safe-mouse.ts";
import { NOT_A_MOUSE } from "./policy.ts";
import { PINNED_IDS } from "./driver-index.generated.ts";
import { isBootloader } from "../bootloader-ids.ts";
import type { DriverMatch } from "./registry.ts";
import type { MouseStore } from "./store.ts";

export interface GenericHost {
  /** Real hardware (false in the preview). */
  live: boolean;
  store: MouseStore;
  /** HID devices this host may use. One per USB interface, as WebHID lists them. */
  devices(): Promise<HIDDevice[]>;
  /** The OpenMouse driver for a device, or null. */
  match(device: HIDDevice): Promise<DriverMatch | null>;
}

export interface Claimed {
  brand: string;
  driver: string;
  name: string;
  /**
   * The driver claims any product id of this vendor and this id has no entry of its own in OpenMouse's filters (vendor ids
   * such as 0x093A or 0x373E are shared by several brands), so the mouse is shown only once it has
   * answered a read-only identify (`pingGeneric`).
   */
  identify: boolean;
}

/** A device in firmware-update mode: never claimed, opened or asked anything. */
const updating = (d: HIDDevice) => isBootloader(d.vendorId, d.productId, d.productName);

const hex = (n: number) => n.toString(16).padStart(4, "0");
export const idKey = (vid: number | string, pid: number | string) => `${typeof vid === "number" ? hex(vid) : vid}:${typeof pid === "number" ? hex(pid) : pid}`;

/** A mouse name from the USB product string, with the brand in front when it isn't there yet. */
export function displayName(brand: string, productName: string): string {
  const p = productName.trim();
  if (!p) return `${brand} mouse`;
  return p.toLowerCase().includes(brand.toLowerCase()) ? p : `${brand} ${p}`;
}

/**
 * Which of the candidate ids (vid:pid, lower-case hex) one of OpenMouse's drivers claims as a mouse.
 * Loads only the drivers for the vendors present; reads nothing from the devices.
 */
export async function claimMice(host: GenericHost, ids: readonly string[]): Promise<Map<string, Claimed>> {
  const out = new Map<string, Claimed>();
  if (!ids.length) return out;
  const wanted = new Set(ids);
  for (const device of await host.devices()) {
    const key = idKey(device.vendorId, device.productId);
    if (!wanted.has(key) || out.has(key) || updating(device)) continue;
    const m = await host.match(device);
    if (!m || NOT_A_MOUSE.has(m.cls)) continue;
    out.set(key, { brand: m.brand, driver: m.cls, name: displayName(m.brand, device.productName), identify: m.anyPid === true && !PINNED_IDS.has(key) });
  }
  return out;
}

/** Opens the mouse with this id through its OpenMouse driver and reads it. Null when none claims it. */
export async function connectGeneric(host: GenericHost, id: string): Promise<SafeMouse | null> {
  for (const device of await host.devices()) {
    if (idKey(device.vendorId, device.productId) !== id || updating(device)) continue;
    const m = await host.match(device);
    if (!m || NOT_A_MOUSE.has(m.cls)) continue;
    return SafeMouse.connect(device, m, host.store);
  }
  return null;
}

/** Whether the mouse with this id answers a quick read-only check. False when no driver claims it. */
export async function pingGeneric(host: GenericHost, id: string): Promise<boolean> {
  for (const device of await host.devices()) {
    if (idKey(device.vendorId, device.productId) !== id || updating(device)) continue;
    const m = await host.match(device);
    if (!m || NOT_A_MOUSE.has(m.cls)) continue;
    return SafeMouse.ping(device, m);
  }
  return false;
}

/** How long a read-only identify may take. */
export const IDENTIFY_MS = 1000;
/** A mouse that didn't answer its identify is asked again no sooner than this. */
export const IDENTIFY_RETRY_MS = 30_000;

/** Identify answers per mouse id, kept while it stays plugged in. */
export type IdentifyCache = Map<string, { ok: boolean; at: number }>;

/**
 * Which of the candidate ids to show as mice: claimed by a driver, and, when that driver matches by
 * vendor id alone and the id has no entry of its own in OpenMouse's filters, also answering a read-only identify
 * (`pingGeneric`, the driver's cheapest read) within IDENTIFY_MS. A failed identify is retried no
 * sooner than IDENTIFY_RETRY_MS; ids no longer listed are forgotten.
 */
export async function confirmMice(host: GenericHost, ids: readonly string[], cache: IdentifyCache, now = Date.now): Promise<Map<string, Claimed>> {
  for (const k of [...cache.keys()]) if (!ids.includes(k)) cache.delete(k);
  const claimed = await claimMice(host, ids);
  const out = new Map<string, Claimed>();
  for (const [id, c] of claimed) {
    if (c.identify) {
      const known = cache.get(id);
      let ok: boolean;
      if (known && (known.ok || now() - known.at < IDENTIFY_RETRY_MS)) ok = known.ok;
      else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const limit = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), IDENTIFY_MS)));
        ok = await Promise.race([pingGeneric(host, id).catch(() => false), limit]).finally(() => clearTimeout(timer));
        cache.set(id, { ok, at: now() });
      }
      if (!ok) continue;
    }
    out.set(id, c);
  }
  return out;
}
