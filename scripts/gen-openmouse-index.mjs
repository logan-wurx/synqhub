// Generates SYNQ's lazy index of @openmouse/protocol's mouse drivers, and the Rust allowlist
// the HID bridge uses for them. Re-run after updating @openmouse/protocol:
//
//   node scripts/gen-openmouse-index.mjs
//
// Writes:
//   src/lib/openmouse/driver-index.generated.ts  every DEVICE_DRIVERS entry, in registry order, with
//                                                the vendor ids it can claim and a dynamic import, so
//                                                a vendor's driver is only downloaded when a device
//                                                with that vendor id is plugged in.
//                                                Each entry says whether its driver claims any product id
//                                                of its vendor (`anyPid`); PINNED_IDS lists the ids
//                                                OpenMouse names one by one. A mouse claimed only by
//                                                vendor id must also answer a read-only identify first.
//   src/lib/kb/openmouse/driver-index.generated.ts the same for @openmouse/keyboard-protocol's keyboards.
//   src-tauri/src/openmouse_ids.rs               OpenMouse's SUPPORTED_HID_FILTERS as a Rust table, the
//                                                Logitech mouse ids, the Razer ids that get feature-only
//                                                access to their mouse collection (razer-feature-only.mjs),
//                                                and the keyboard config collections (KEYBOARD_FILTERS).
//
// Nothing here talks to a device.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVICE_DRIVERS, SUPPORTED_HID_FILTERS } from "@openmouse/protocol/drivers";
import { LOGITECH_DIRECT_PRODUCT_IDS } from "@openmouse/protocol/logitech";
import { DEVICE_DRIVERS as KB_DRIVERS, SUPPORTED_HID_FILTERS as KB_FILTERS } from "@openmouse/keyboard-protocol/drivers";
import { WOOTING_CONFIG_USAGE_PAGE_STANDARD } from "@openmouse/keyboard-protocol/wooting";
import { WUQUE_CONFIG_USAGE_PAGE_ALT } from "@openmouse/keyboard-protocol/wuque";
import { razerFeatureOnlyPids } from "./razer-feature-only.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "node_modules/@openmouse/protocol");
const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
const registrySrc = readFileSync(join(pkgDir, "dist/drivers/registry.js"), "utf8");

// ---- which module each registry entry's class comes from
const importOf = new Map();
for (const m of registrySrc.matchAll(/^import \{ ([^}]+) \} from "\.\/(.+?)\.js";/gm)) {
  for (const name of m[1].split(",").map((s) => s.trim()).filter(Boolean)) importOf.set(name, m[2]);
}
const body = registrySrc.slice(registrySrc.indexOf("export const DEVICE_DRIVERS"), registrySrc.indexOf("function driverFor"));
const parsed = [...body.matchAll(/\{ brand: "([^"]+)", supports: (?:\(device\) => (\w+)\.isSupported\(device\)|(eggWeIsSupported))/g)].map((m) => ({
  brand: m[1],
  cls: m[2] ?? "EggWeHidClient",
  special: m[3] ? "eggWe" : null,
}));
if (parsed.length !== DEVICE_DRIVERS.length) throw new Error(`Parsed ${parsed.length} registry entries, DEVICE_DRIVERS has ${DEVICE_DRIVERS.length}`);
parsed.forEach((p, i) => {
  if (p.brand !== DEVICE_DRIVERS[i].brand) throw new Error(`Entry ${i}: ${p.brand} vs ${DEVICE_DRIVERS[i].brand}`);
  if (!p.special && !DEVICE_DRIVERS[i].supports.toString().includes(`${p.cls}.isSupported`)) throw new Error(`Entry ${i} is not ${p.cls}`);
  p.module = p.special ? "endgame/egg-we-control" : importOf.get(p.cls);
  if (!p.module) throw new Error(`No import for ${p.cls}`);
});

// ---- vendor ids each entry can claim. Every driver checks the vendor id first, so a permissive
// stand-in for the collections shows which (vid, pid) pairs from OpenMouse's own filters it takes.
const pairs = new Map();
for (const f of SUPPORTED_HID_FILTERS) pairs.set(`${f.vendorId}:${f.productId ?? 0}`, [f.vendorId, f.productId ?? 0]);
const report = [...Array(256).keys()].map((reportId) => ({ reportId, items: [{ reportSize: 8, reportCount: 64 }] }));
const anyCollection = { usagePage: 0xff00, usage: 1, type: 1, children: [], inputReports: report, outputReports: report, featureReports: report };
const permissive = (item) =>
  new Proxy([item], {
    get(t, k) {
      if (k === "some" || k === "every" || k === "includes") return () => true;
      if (k === "find") return () => item;
      if (k === "findIndex") return () => 0;
      if (k === "filter" || k === "map" || k === "flatMap") return () => permissive(item);
      return Reflect.get(t, k);
    },
  });
const vids = DEVICE_DRIVERS.map(() => new Set());
for (const [vendorId, productId] of pairs.values()) {
  const device = { vendorId, productId, productName: "", opened: false, collections: permissive(anyCollection) };
  DEVICE_DRIVERS.forEach((d, i) => {
    try {
      if (d.supports(device)) vids[i].add(vendorId);
    } catch {
      /* a driver that needs a real collection shape */
    }
  });
}
// Drivers whose matcher needs a product id the filters leave out (vendor-wide filters) or a real
// report layout. Taken from each class's isSupported() (dist/drivers/<module>.js) and the vendor
// constants it compares against; re-check these when updating the package.
const MANUAL_VIDS = {
  EggOp1HidClient: [0x3367],
  EggWeHidClient: [0x3367],
  EggOtHidClient: [0x3367],
  PulsarXs1HidClient: [0x3710],
  PulsarProHidClient: [0x3710],
  PulsarAresonHidClient: [0x25a7],
  GravaStarHidClient: [0x3554],
  WLMouseBeastX4kHidClient: [0x36a7],
  NoirM1NexHidClient: [0x3554],
  LamzuAtlantisHidClient: [0x3554],
  OrbitalHidClient: [0x1915],
  RazerViperMiniHidClient: [0x1532],
  RazerViperHidClient: [0x1532],
  DeluxHidClient: [0x1d57],
  RazerViperV4ProHidClient: [0x1532],
  Keychron1kHidClient: [0x3434],
  Keychron4kHidClient: [0x3434],
  Keychron8kNordicHidClient: [0x3434],
  WootingHidClient: [0x31e3],
  WallhackMouseHidClient: [0x3879],
  WallhackKeyboardHidClient: [0x3879, 0x1caa],
  GloriousHidClient: [0x093a],
  MchoseV3HidClient: [0x3837],
  CoolerMasterHidClient: [0x2516],
};
// Vendor-wide OpenMouse filters narrowed to the product ids their driver really takes, because the
// vendor id also covers other hardware: Cooler Master's filter names no product, but its only driver is
// the MM711 mouse (0x0101), and a Cooler Master keyboard must never be listed or opened as a mouse.
// The Rust table gets the pinned rows instead of the vendor-wide one; the index entry gets `pids`.
const PINNED_PRODUCTS = { 0x2516: { cls: "CoolerMasterHidClient", pids: [0x0101] } };
parsed.forEach((p, i) => {
  for (const v of MANUAL_VIDS[p.cls] ?? []) vids[i].add(v);
  p.vids = [...vids[i]].sort((a, b) => a - b);
  if (!p.vids.length) throw new Error(`No vendor id known for ${p.cls}; add it to MANUAL_VIDS`);
});

// ---- which drivers claim any product id of their vendor. A made-up product id is offered with the
// collection shapes OpenMouse's own filters name for that vendor (and a permissive stand-in); a driver
// that takes it matches by vendor id alone, so the vendor id can't tell its mice from other hardware.
const shapes = new Map();
for (const f of SUPPORTED_HID_FILTERS) {
  const set = shapes.get(f.vendorId) ?? new Set(["65280:1"]);
  set.add(`${f.usagePage ?? 0xff00}:${f.usage ?? 1}`);
  shapes.set(f.vendorId, set);
}
const shaped = (usagePage, usage) => ({ usagePage, usage, type: 1, children: [], inputReports: report, outputReports: report, featureReports: report });
parsed.forEach((p, i) => {
  p.anyPid = p.vids.some((vendorId) =>
    [...(shapes.get(vendorId) ?? ["65280:1"])].some((pu) => {
      const [page, usage] = pu.split(":").map(Number);
      return [0xfffe, 0x7357].some((productId) =>
        [[shaped(page, usage)], permissive(shaped(page, usage))].some((collections) => {
          try {
            return DEVICE_DRIVERS[i].supports({ vendorId, productId, productName: "", opened: false, collections });
          } catch {
            return false;
          }
        }),
      );
    }),
  );
});
const pinned = [...new Set([...SUPPORTED_HID_FILTERS, ...Object.entries(PINNED_PRODUCTS).flatMap(([v, x]) => x.pids.map((productId) => ({ vendorId: Number(v), productId })))].filter((f) => f.productId !== undefined).map((f) => `${f.vendorId.toString(16).padStart(4, "0")}:${f.productId.toString(16).padStart(4, "0")}`))].sort();

const hex = (n, w = 4) => `0x${n.toString(16).padStart(w, "0")}`;
const ts = `// GENERATED by scripts/gen-openmouse-index.mjs from @openmouse/protocol ${version}. Do not edit.
//
// Every entry of OpenMouse's DEVICE_DRIVERS, in the same order (first match wins, as in
// createSupportedClient), with the vendor ids its matcher can accept and a dynamic import of its
// module. src/lib/openmouse/registry.ts only imports the entries for a vendor id that is present.
import type { DriverEntry } from "./registry.ts";

const cls = (C: unknown): DriverImpl => {
  const K = C as { isSupported(d: HIDDevice): boolean; new (d: HIDDevice): unknown };
  return { isSupported: (d) => K.isSupported(d), create: (d) => new K(d) };
};
type DriverImpl = Awaited<ReturnType<DriverEntry["load"]>>;

export const OPENMOUSE_VERSION = ${JSON.stringify(version)};

export const DRIVER_INDEX: readonly DriverEntry[] = [
${parsed
  .map((p) => {
    const load = p.special
      ? `() => import("@openmouse/protocol/drivers/endgame/egg-we-control").then((m) => ({ isSupported: m.eggWeIsSupported, create: m.eggWeCreate as (d: HIDDevice) => unknown }))`
      : `() => import("@openmouse/protocol/drivers/${p.module}").then((m) => cls(m.${p.cls}))`;
    const pin = Object.values(PINNED_PRODUCTS).find((x) => x.cls === p.cls);
    return `  { brand: ${JSON.stringify(p.brand)}, cls: ${JSON.stringify(p.cls)}, vids: [${p.vids.map((v) => hex(v)).join(", ")}],${pin ? ` pids: [${pin.pids.map((v) => hex(v)).join(", ")}],` : p.anyPid ? " anyPid: true," : ""} load: ${load} },`;
  })
  .join("\n")}
];

/** vid:pid (lower-case hex) of every mouse OpenMouse's filters name by product id. */
export const PINNED_IDS: ReadonlySet<string> = new Set(${JSON.stringify(pinned)});
`;
writeFileSync(join(root, "src/lib/openmouse/driver-index.generated.ts"), ts);

// LIGHTSPEED receivers from OpenMouse's LOGITECH_RECEIVER_PRODUCT_IDS (its "Lightspeed" comments).
const LIGHTSPEED = [0xc539, 0xc53a, 0xc53d, 0xc53f, 0xc541, 0xc543, 0xc545, 0xc547, 0xc54d, 0xc54f];
const logiMice = [...new Set([...LOGITECH_DIRECT_PRODUCT_IDS, ...LIGHTSPEED])].sort((a, b) => a - b);
const razerPids = razerFeatureOnlyPids();
const opt = (v) => (v === undefined ? "None" : `Some(${hex(v)})`);
const seen = new Set();
const rows = [];
for (const f of SUPPORTED_HID_FILTERS) {
  const pin = f.productId === undefined ? PINNED_PRODUCTS[f.vendorId] : undefined;
  for (const productId of pin ? pin.pids : [f.productId]) {
    const row = `    (${hex(f.vendorId)}, ${opt(productId)}, ${opt(f.usagePage)}, ${opt(f.usage)}),`;
    if (!seen.has(row)) seen.add(row), rows.push(row);
  }
}
const rs = `//! GENERATED by scripts/gen-openmouse-index.mjs from @openmouse/protocol ${version}. Do not edit.
//!
//! OpenMouse's SUPPORTED_HID_FILTERS: (vendor id, product id, usage page, usage), None = any.
//! hid.rs decides which of the matching collections may be opened (vendor-defined ones, and the Razer
//! mouse / consumer collections listed in RAZER_FEATURE_ONLY_PIDS, feature reports only).

pub const FILTERS: [(u16, Option<u16>, Option<u16>, Option<u16>); ${rows.length}] = [
${rows.join("\n")}
];

/// Logitech ids that are always a mouse: wired/direct mice (OpenMouse's LOGITECH_DIRECT_PRODUCT_IDS)
/// and LIGHTSPEED gaming receivers. Unifying, Nano and Bolt receivers also serve keyboards, so they
/// are not listed as a mouse from the id alone.
pub const LOGITECH_MOUSE_PIDS: [u16; ${logiMice.length}] = [${logiMice.map((v) => hex(v)).join(", ")}];

/// Razer product ids whose OpenMouse driver talks to the Generic Desktop mouse (0x01:0x02) or Consumer
/// Control (0x0C:0x01) collection and has no vendor-defined control interface (scripts/razer-feature-only.mjs).
/// hid.rs opens those two collections for exactly these ids, for feature-report get/set only.
pub const RAZER_FEATURE_ONLY_PIDS: [u16; ${razerPids.length}] = [${razerPids.map((v) => hex(v)).join(", ")}];
`;

// ---- @openmouse/keyboard-protocol: the same lazy index, and the config collections the bridge opens.
const kbDir = join(root, "node_modules/@openmouse/keyboard-protocol");
const kbVersion = JSON.parse(readFileSync(join(kbDir, "package.json"), "utf8")).version;
const kbRegistry = readFileSync(join(kbDir, "dist/drivers/registry.js"), "utf8");
const kbImport = new Map();
for (const m of kbRegistry.matchAll(/^import \{ ([^}]+) \} from "\.\/(.+?)\.js";/gm)) {
  for (const name of m[1].split(",").map((x) => x.trim()).filter(Boolean)) kbImport.set(name, m[2]);
}
const kbParsed = [...kbRegistry.matchAll(/\{ brand: "([^"]+)", supports: \(device\) => (\w+)\.isSupported\(device\)/g)].map((m) => ({ brand: m[1], cls: m[2], module: kbImport.get(m[2]), vids: [] }));
if (kbParsed.length !== KB_DRIVERS.length) throw new Error(`Parsed ${kbParsed.length} keyboard entries, DEVICE_DRIVERS has ${KB_DRIVERS.length}`);
kbParsed.forEach((p, i) => {
  if (p.brand !== KB_DRIVERS[i].brand) throw new Error(`Keyboard entry ${i}: ${p.brand} vs ${KB_DRIVERS[i].brand}`);
  if (!p.module) throw new Error(`No import for ${p.cls}`);
});
// Config collections: each filter, plus the alternative config pages the drivers accept (Wooting's
// standard-firmware 0x1337, Wuque's 0xFF80), kept only where the real driver claims a device whose
// only collection is that one. Never a typing, pointing or consumer page.
const KB_INPUT_PAGES = [0x0001, 0x0007, 0x000c, 0x000d];
const kbRows = new Map();
for (const f of KB_FILTERS) {
  for (const page of new Set([f.usagePage, WOOTING_CONFIG_USAGE_PAGE_STANDARD, WUQUE_CONFIG_USAGE_PAGE_ALT])) {
    if (KB_INPUT_PAGES.includes(page)) throw new Error(`Keyboard filter names input page ${hex(page)}`);
    const device = { vendorId: f.vendorId, productId: f.productId, productName: "", opened: false, collections: [shaped(page, f.usage)] };
    const i = KB_DRIVERS.findIndex((d) => {
      try {
        return d.supports(device);
      } catch {
        return false;
      }
    });
    if (i < 0) continue;
    kbParsed[i].vids = [...new Set([...kbParsed[i].vids, f.vendorId])].sort((a, b) => a - b);
    kbRows.set(`${f.vendorId}:${f.productId}:${page}:${f.usage}`, `    (${hex(f.vendorId)}, ${hex(f.productId)}, ${hex(page)}, ${hex(f.usage)}),`);
  }
}
kbParsed.forEach((p) => {
  if (!p.vids.length) throw new Error(`No keyboard filter claimed by ${p.cls}`);
});
const kbTs = `// GENERATED by scripts/gen-openmouse-index.mjs from @openmouse/keyboard-protocol ${kbVersion}. Do not edit.
//
// Every entry of the keyboard package's DEVICE_DRIVERS, in the same order (first match wins), with the
// vendor ids its filters name and a dynamic import of its module. src/lib/kb/openmouse/registry.ts only
// imports the entries for a vendor id that is present.
import type { KbDriverEntry } from "./registry.ts";

const cls = (C: unknown): KbDriverImpl => {
  const K = C as { isSupported(d: HIDDevice): boolean; new (d: HIDDevice): unknown };
  return { isSupported: (d) => K.isSupported(d), create: (d) => new K(d) };
};
type KbDriverImpl = Awaited<ReturnType<KbDriverEntry["load"]>>;

export const KEYBOARD_PROTOCOL_VERSION = ${JSON.stringify(kbVersion)};

export const KB_DRIVER_INDEX: readonly KbDriverEntry[] = [
${kbParsed
  .map((p) => `  { brand: ${JSON.stringify(p.brand)}, cls: ${JSON.stringify(p.cls)}, vids: [${p.vids.map((v) => hex(v)).join(", ")}], load: () => import("@openmouse/keyboard-protocol/drivers/${p.module}").then((m) => cls(m.${p.cls})) },`)
  .join("\n")}
];
`;
writeFileSync(join(root, "src/lib/kb/openmouse/driver-index.generated.ts"), kbTs);
const kbRs = `
/// @openmouse/keyboard-protocol ${kbVersion}: (vendor id, product id, usage page, usage) of each keyboard's
/// configuration collection, from its SUPPORTED_HID_FILTERS plus the alternative config pages its drivers
/// accept. hid.rs opens exactly these for those keyboards; never their typing, pointing or consumer ones.
pub const KEYBOARD_FILTERS: [(u16, u16, u16, u16); ${kbRows.size}] = [
${[...kbRows.values()].join("\n")}
];
`;
writeFileSync(join(root, "src-tauri/src/openmouse_ids.rs"), rs + kbRs);
console.log(`@openmouse/keyboard-protocol ${kbVersion}: ${kbParsed.length} drivers (${kbParsed.map((p) => p.brand).join(", ")}), ${kbRows.size} config collections`);

const brands = new Set(parsed.map((p) => p.brand));
const ids = new Set(SUPPORTED_HID_FILTERS.filter((f) => f.productId !== undefined).map((f) => `${f.vendorId}:${f.productId}`));
console.log(`@openmouse/protocol ${version}: ${parsed.length} drivers, ${brands.size} registry brands, ${ids.size} vid:pid identities, ${rows.length} filters`);
