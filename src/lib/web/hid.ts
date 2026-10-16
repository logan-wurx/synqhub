// The website's `navigator.hid`: the browser's own WebHID with the guard in front of every device. After
// `installWebHid()`, every driver that asks `navigator.hid.getDevices()` gets guarded proxies
// (src/lib/web/proxy.ts) of the devices the person granted, only the usable ones, and `requestDevice()`
// never opens a chooser for a driver (it returns the granted matches, as the desktop shim does). The one
// real chooser is `pickDevices()`, behind the "Add device" button: filters built from the driver
// registries (src/lib/web/policy.ts `chooserFilters`), one chooser per click, because Chromium 153+
// consumes the user gesture in requestDevice().
import { GuardedHidDevice, type RawHidDevice } from "./proxy.ts";
import { chooserFilters, classifyDevice } from "./policy.ts";
import { availability, supportsExclusionFilters, type Availability } from "./availability.ts";
import { currentPlatform } from "./platform.ts";
import { asusLamp, hasLampArray } from "../lighting/lamparray-hid.ts";

let real: HID | undefined;
let installed: Promise<void> | null = null;
const wrapped = new WeakMap<HIDDevice, Promise<GuardedHidDevice>>();
const changeListeners = new Set<() => void>();

/** Whether this browser has WebHID at all (checked before anything is installed). */
export function webHidSupported(): boolean {
  return typeof navigator !== "undefined" && "hid" in navigator && !!(navigator as Navigator & { hid?: HID }).hid;
}

function realHid(): HID {
  if (!real) throw new Error("WebHID isn't available in this browser.");
  return real;
}

/** The devices the person granted, exactly as the browser lists them. */
export const rawGranted = (): Promise<HIDDevice[]> => realHid().getDevices();

function guardedOf(raw: HIDDevice): Promise<GuardedHidDevice> {
  let p = wrapped.get(raw);
  if (!p) wrapped.set(raw, (p = GuardedHidDevice.wrap(raw as unknown as RawHidDevice)));
  return p;
}

/** Guarded proxies of every granted device a driver may use (not in update mode, at least one usable collection). */
export async function guardedDevices(): Promise<GuardedHidDevice[]> {
  const all = await Promise.all((await rawGranted()).map(guardedOf));
  return all.filter((d) => d.guard.usable);
}

const matches = (d: GuardedHidDevice, f: HIDDeviceFilter): boolean => {
  if (f.vendorId !== undefined && f.vendorId !== d.vendorId) return false;
  if (f.productId !== undefined && f.productId !== d.productId) return false;
  if (f.usagePage === undefined && f.usage === undefined) return true;
  return d.collections.some((c) => (f.usagePage === undefined || c.usagePage === f.usagePage) && (f.usage === undefined || c.usage === f.usage));
};

/** What drivers see as `navigator.hid`. */
class WebHid {
  onconnect = null;
  ondisconnect = null;
  getDevices = (): Promise<HIDDevice[]> => guardedDevices() as unknown as Promise<HIDDevice[]>;
  /** Never a chooser: the granted devices that match, like the desktop shim. */
  async requestDevice(options: HIDDeviceRequestOptions): Promise<HIDDevice[]> {
    const all = await guardedDevices();
    const filters = options.filters ?? [];
    return (filters.length ? all.filter((d) => filters.some((f) => matches(d, f))) : all) as unknown as HIDDevice[];
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}

/** Puts the guarded WebHID in place of `navigator.hid`. Safe to call more than once. */
export function installWebHid(): Promise<void> {
  installed ??= (async () => {
    const hid = (navigator as Navigator & { hid?: HID }).hid;
    if (!hid) throw new Error("WebHID isn't available in this browser.");
    real = hid;
    const changed = () => {
      for (const l of [...changeListeners]) l();
    };
    hid.addEventListener("connect", changed);
    hid.addEventListener("disconnect", changed);
    Object.defineProperty(navigator, "hid", { value: new WebHid(), configurable: true });
  })();
  return installed;
}

/** Hears a device being plugged in or removed (the browser's connect / disconnect events). */
export function onHidChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

// ---------------------------------------------------------------------------------------------
// The "Add device" chooser
// ---------------------------------------------------------------------------------------------

export interface PickedDevice {
  name: string;
  vendorId: number;
  productId: number;
  /** SYNQ has a driver for it (it will show on the Devices home). */
  known: boolean;
  availability: Availability;
}

export type PickResult =
  | { status: "picked"; devices: PickedDevice[] }
  | { status: "cancelled" }
  | { status: "blocked"; message: string };

const hex4 = (n: number) => n.toString(16).padStart(4, "0");

/**
 * Opens the browser's device chooser with filters built from the registries and reports what was picked,
 * with the availability verdict for this OS and browser. Call it straight from a click: it must be the
 * first thing the click does (the gesture is used up by the chooser).
 */
export async function pickDevices(): Promise<PickResult> {
  const hid = realHid();
  const platform = currentPlatform();
  const { filters, exclusionFilters } = chooserFilters();
  let picked: HIDDevice[];
  try {
    // `exclusionFilters` is in Chromium's WebHID since 91 but not in the bundled type definitions.
    const options = (supportsExclusionFilters(platform) ? { filters, exclusionFilters } : { filters }) as unknown as HIDDeviceRequestOptions;
    picked = await hid.requestDevice(options);
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "NotFoundError") return { status: "cancelled" };
    if (name === "SecurityError" || name === "NotAllowedError")
      return { status: "blocked", message: "This browser or its administrator doesn't let this page ask for HID devices. Check the site's permissions, or use the desktop app." };
    return { status: "blocked", message: `The browser couldn't show its device chooser: ${String((e as Error)?.message ?? e)}` };
  }
  if (!picked.length) return { status: "cancelled" };
  changeListeners.forEach((l) => l());
  const devices = picked.map((raw): PickedDevice => {
    const cols = raw.collections.map((c) => ({ usagePage: c.usagePage ?? 0, usage: c.usage ?? 0 }));
    const c = classifyDevice(raw.vendorId, raw.productId, cols, raw.productName || null);
    // A Dynamic Lighting device SYNQ may light shows up on the Lights page (src/lib/web/lamparrays.ts).
    const lamps = hasLampArray(cols) && !asusLamp(raw.vendorId, raw.productName ?? "");
    return {
      name: c?.name ?? (raw.productName || `${hex4(raw.vendorId)}:${hex4(raw.productId)}`),
      vendorId: raw.vendorId,
      productId: raw.productId,
      known: c !== null || lamps,
      availability: availability({ vendorId: raw.vendorId, productId: raw.productId }, platform),
    };
  });
  return { status: "picked", devices };
}

/** Removes the devices with this vendor / product id (the browser forgets the permission). */
export async function forgetDevice(vendorId: number, productId: number): Promise<void> {
  for (const r of await rawGranted()) {
    if (r.vendorId !== vendorId || r.productId !== productId) continue;
    try {
      const g = await guardedOf(r);
      if (g.raw.opened) await g.close();
    } catch {
      /* closing is best effort */
    }
    await r.forget();
  }
  changeListeners.forEach((l) => l());
}

/** Removes every device this page was granted (the browser forgets the permission). */
export async function forgetAllDevices(): Promise<number> {
  const raws = await rawGranted();
  await Promise.all(
    raws.map(async (r) => {
      try {
        const g = await guardedOf(r);
        if (g.raw.opened) await g.close();
      } catch {
        /* closing is best effort */
      }
      await r.forget();
    }),
  );
  changeListeners.forEach((l) => l());
  return raws.length;
}
