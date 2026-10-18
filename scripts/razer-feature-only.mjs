// Which Razer mice need SYNQ's bridge to reach their Generic Desktop mouse (0x01:0x02) or Consumer
// Control (0x0C:0x01) collection, derived from OpenMouse's own Razer drivers. Nothing here talks to a
// device; it asks each real driver's isSupported() about made-up device shapes.
//
// A Razer PID is in the set when
//   1. one of OpenMouse's Razer drivers claims a device whose only collection is the mouse one or the
//      consumer one (that is the control channel those drivers talk to), and
//   2. the PID's entry in OpenMouse's product table names no vendor-defined control interface
//      (`vendorControlInterface`): those mice are reachable through the vendor collection the bridge
//      already opens, so they stay exactly as they were.
// The Viper Mini, Viper, Cobra and Viper V4 Pro have their own drivers and are not in that table, so
// condition 2 never excludes them.
//
// gen-openmouse-index.mjs writes the result into src-tauri/src/openmouse_ids.rs; the safety test
// derives it again and compares.
import { DEVICE_DRIVERS, SUPPORTED_HID_FILTERS } from "@openmouse/protocol/drivers";
import { RAZER_PRODUCTS } from "@openmouse/protocol/razer-devices";
import { RAZER_V4_REPORT_ID } from "@openmouse/protocol/razer-v4";

export const RAZER_VENDOR = 0x1532;
/** The only collections a feature-only Razer is ever opened on: (usage page, usage). */
export const FEATURE_ONLY_COLLECTIONS = [
  [0x0001, 0x0002],
  [0x000c, 0x0001],
];

const feature = [0, RAZER_V4_REPORT_ID].map((reportId) => ({ reportId, items: [{ reportSize: 8, reportCount: 90 }] }));
const collection = (usagePage, usage) => ({ usagePage, usage, type: 1, children: [], inputReports: [], outputReports: [], featureReports: feature });

/** Whether any OpenMouse Razer driver claims a Razer device of this id whose only collection is this one. */
export function razerClaims(productId, usagePage, usage) {
  const device = { vendorId: RAZER_VENDOR, productId, productName: "", opened: false, collections: [collection(usagePage, usage)] };
  return DEVICE_DRIVERS.some((d) => {
    if (d.brand !== "Razer") return false;
    try {
      return d.supports(device);
    } catch {
      return false;
    }
  });
}

/** Razer product ids OpenMouse's table lists, ascending. */
export function razerListedPids() {
  return [...new Set(SUPPORTED_HID_FILTERS.filter((f) => f.vendorId === RAZER_VENDOR && f.productId !== undefined).map((f) => f.productId))].sort((a, b) => a - b);
}

export function razerFeatureOnlyPids() {
  return razerListedPids().filter(
    (pid) => FEATURE_ONLY_COLLECTIONS.some(([page, usage]) => razerClaims(pid, page, usage)) && RAZER_PRODUCTS.get(pid)?.vendorControlInterface !== true,
  );
}
