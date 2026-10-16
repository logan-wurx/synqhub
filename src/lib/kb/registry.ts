// The keyboard drivers the generic panel can use, each loaded only when a device it might claim is
// present (by vendor id, or any vendor for collection-based drivers like VIA). When several claim one
// device, the highest priority wins: a specific driver over generic VIA.
//
// Adding a driver: put `entry.ts` in its folder (src/lib/kb/<name>/entry.ts) exporting
// `entry: KbDriverLoader`; src/lib/kb/plugins.ts picks it up in the app (Wave 2's FCC and
// AnalogSense drivers plug in that way), or pass it to `driversFor` directly in tests.
import type { KbDriver } from "./types.ts";
import { OMKB_VIDS } from "./openmouse/registry.ts";

export interface KbDriverLoader {
  id: string;
  /** Vendor ids it can claim; null = any (it claims by collection). */
  vids: readonly number[] | null;
  priority: number;
  load(): Promise<KbDriver>;
}

/**
 * Every keyboard driver, with the vendor ids it can claim (so its module loads only when such a device
 * is present; scripts/kb-safety.test.ts checks each list against the driver's own `vids`).
 */
export const CORE_DRIVERS: readonly KbDriverLoader[] = [
  // Wave 2: Sonix HE boards (FCC protocol).
  { id: "fcc", vids: [0x0c45, 0x05ac], priority: 60, load: () => import("./fcc/driver.ts").then((m) => m.fccDriver) },
  // Wave 3b: Razer analog keyboards, MonsGeek / Akko, DrunkDeer.
  { id: "razer-he", vids: [0x1532], priority: 60, load: () => import("../brands/razer/kb-driver.ts").then((m) => m.razerKbDriver) },
  { id: "monsgeek", vids: [0x3151, 0x38ee, 0x39ab], priority: 60, load: () => import("../brands/monsgeek/kb-driver.ts").then((m) => m.monsgeekKbDriver) },
  { id: "drunkdeer", vids: [0x352d, 0x1a81], priority: 60, load: () => import("../brands/drunkdeer/kb-driver.ts").then((m) => m.drunkdeerKbDriver) },
  // Wave 4a: the 0x19F5 firmware family (MCHOSE gen 1, DrunkDeer gen 2, NuPhy V3 / HE, Royal Kludge Gcome).
  // It also owns the ids AnalogSense used to claim on 0x19F5 for live depth.
  { id: "fw19f5", vids: [0x19f5, 0x41e4, 0x3837], priority: 60, load: () => import("../brands/fw19f5/kb-driver.ts").then((m) => m.fw19f5KbDriver) },
  // Wave 4e: Royal Kludge BeiYing boards (SinoWealth 258A) over RK's legacy software channel: write-only, desktop bridge only.
  { id: "rk-beiying", vids: [0x258a], priority: 60, load: () => import("../brands/rk-beiying/kb-driver.ts").then((m) => m.rkBeiyingKbDriver) },
  // Wave 4c: SparkLink boards (Royal Kludge C / M75 HE, AULA HE, Kochi) on the vendor collection 0xFFA0:0x0001. It also owns
  // the Kochi Hummingbird 68, which OpenMouse's keyboard driver used to claim for its Windows / Mac switch.
  { id: "sparklink", vids: [0x1ca2, 0x1ca3, 0x1ca5, 0x1c4f], priority: 60, load: () => import("../brands/sparklink/kb-driver.ts").then((m) => m.sparklinkKbDriver) },
  // Wave 3a: ASUS Gear Link magnetic keyboards (never 0B05:1D1D, the Falchion ZywOo keeps its own panel)
  // and CORSAIR Hall-effect keyboards (Bragi).
  { id: "asus-gearlink", vids: [0x0b05], priority: 60, load: () => import("../brands/asus/keyboard.ts").then((m) => m.ASUS_KB_DRIVER) },
  { id: "corsair-bragi", vids: [0x1b1c], priority: 60, load: () => import("../brands/corsair/keyboard.ts").then((m) => m.CORSAIR_KB_DRIVER) },
  // Wave 4: SteelSeries Apex (every model read-only until verified) and Logitech G keyboards (HID++ 2.0).
  { id: "steelseries", vids: [0x1038], priority: 50, load: () => import("../brands/steelseries/backend.ts").then((m) => m.steelseriesKbDriver) },
  { id: "logitech-kb", vids: [0x046d], priority: 40, load: () => import("../brands/logitech-kb/backend.ts").then((m) => m.logitechKbDriver) },
  // Wave 1: @openmouse/keyboard-protocol (Wooting, Wuque Studio, Kochi), then VIA / Vial on any vendor.
  { id: "omkb", vids: OMKB_VIDS, priority: 20, load: () => import("./openmouse/driver.ts").then((m) => m.omkbDriver) },
  { id: "via", vids: null, priority: 10, load: () => import("./via/driver.ts").then((m) => m.viaDriver) },
  // Wave 2: AnalogSense live key depth (read-only; boards another driver claims use its liveDepthFor()).
  { id: "analogsense", vids: [0x31e3, 0x03eb, 0x1532, 0x19f5, 0x352d, 0x3434, 0x362d, 0x373b, 0x372e], priority: 5, load: () => import("./analogsense/driver.ts").then((m) => m.analogsenseDriver) },
];

const loaded = new Map<string, Promise<KbDriver>>();

/** The drivers that claim `device`, best first. Loads only the drivers that could. No I/O. */
export async function driversFor(device: HIDDevice, loaders: readonly KbDriverLoader[]): Promise<KbDriver[]> {
  const out: KbDriver[] = [];
  for (const l of loaders) {
    if (l.vids && !l.vids.includes(device.vendorId)) continue;
    let p = loaded.get(l.id);
    if (!p) loaded.set(l.id, (p = l.load()));
    const driver = await p;
    let ok = false;
    try {
      ok = await driver.claims(device);
    } catch {
      ok = false;
    }
    if (ok) out.push(driver);
  }
  return out.sort((a, b) => b.priority - a.priority);
}
