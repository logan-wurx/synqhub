// @openmouse/keyboard-protocol's driver registry, loaded per vendor: the same list and order as the
// package's createSupportedClient (first match wins), but only the modules whose vendor ids are
// present are downloaded. No Tauri, no React.
import { KB_DRIVER_INDEX } from "./driver-index.generated.ts";

export interface KbDriverImpl {
  isSupported(device: HIDDevice): boolean;
  create(device: HIDDevice): unknown;
}

export interface KbDriverEntry {
  brand: string;
  /** The driver class's name in @openmouse/keyboard-protocol, e.g. "WuqueHidClient". */
  cls: string;
  vids: readonly number[];
  load(): Promise<KbDriverImpl>;
}

export interface KbDriverMatch {
  brand: string;
  cls: string;
  create(): unknown;
}

const loaded = new Map<string, Promise<KbDriverImpl>>();
const load = (e: KbDriverEntry) => {
  let p = loaded.get(e.cls);
  if (!p) loaded.set(e.cls, (p = e.load()));
  return p;
};

/** Every vendor id an OpenMouse keyboard driver can claim. */
export const OMKB_VIDS: readonly number[] = [...new Set(KB_DRIVER_INDEX.flatMap((e) => e.vids))];

/** The keyboard driver OpenMouse would pick for `device`, loading only that vendor's module. */
export async function findKbDriver(device: HIDDevice, index: readonly KbDriverEntry[] = KB_DRIVER_INDEX): Promise<KbDriverMatch | null> {
  for (const entry of index) {
    if (!entry.vids.includes(device.vendorId)) continue;
    const impl = await load(entry);
    let ok = false;
    try {
      ok = impl.isSupported(device);
    } catch {
      ok = false;
    }
    if (ok) return { brand: entry.brand, cls: entry.cls, create: () => impl.create(device) };
  }
  return null;
}
