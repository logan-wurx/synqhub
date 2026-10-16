// OpenMouse's driver registry, loaded per vendor. `createSupportedClient` from @openmouse/protocol
// imports every driver up front; this walks the same list in the same order (first match wins), but
// only downloads the modules whose matcher can accept the device's vendor id. No Tauri, no React.
import { DRIVER_INDEX } from "./driver-index.generated.ts";

export interface DriverImpl {
  isSupported(device: HIDDevice): boolean;
  create(device: HIDDevice): unknown;
}

export interface DriverEntry {
  brand: string;
  /** The driver class's name in @openmouse/protocol, e.g. "RazerHidClient". */
  cls: string;
  vids: readonly number[];
  /** The driver claims any product id of its vendor (generated), so a claim alone doesn't identify a mouse. */
  anyPid?: boolean;
  /** The only product ids this entry may claim, where its vendor id also covers other hardware (generated pins). */
  pids?: readonly number[];
  load(): Promise<DriverImpl>;
}

export interface DriverMatch {
  brand: string;
  cls: string;
  /** See DriverEntry.anyPid. */
  anyPid?: boolean;
  create(): unknown;
}

const loaded = new Map<string, Promise<DriverImpl>>();
const load = (e: DriverEntry) => {
  let p = loaded.get(e.cls);
  if (!p) loaded.set(e.cls, (p = e.load()));
  return p;
};

/** Every vendor id some OpenMouse driver can claim. */
export const OPENMOUSE_VIDS: ReadonlySet<number> = new Set(DRIVER_INDEX.flatMap((e) => e.vids));

/** The driver OpenMouse would pick for `device`, loading only that vendor's modules. */
export async function findDriver(device: HIDDevice, index: readonly DriverEntry[] = DRIVER_INDEX): Promise<DriverMatch | null> {
  for (const entry of index) {
    if (!entry.vids.includes(device.vendorId) || (entry.pids && !entry.pids.includes(device.productId))) continue;
    const impl = await load(entry);
    let ok = false;
    try {
      ok = impl.isSupported(device);
    } catch {
      ok = false;
    }
    if (ok) return { brand: entry.brand, cls: entry.cls, anyPid: entry.anyPid === true, create: () => impl.create(device) };
  }
  return null;
}
