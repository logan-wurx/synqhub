// Which Sonix HE board is connected, its key layout and switch limits, and exactly what the HID
// bridge must allow for these boards.
//
// Derived from Fighting Control Center (FCC), https://github.com/shybruh/FightingControlCenter-FCC
// (commit 5cad2404661de383f21dca654300e88764f6bc89), GNU GPL v3.0 or later; part of SYNQ (AGPL-3.0).
// Detection follows FCC app/src/devices/registry.ts `detect` (end of file) and `WIRED_IDS`; the bridge
// filter follows FCC app/src-tauri/src/hid.rs `find_config_interface` (VENDOR_IDS 0x0c45 + 0x05ac,
// usage page 0xFF68, usage 0x61) and app/src/hid/transport.ts `FILTERS` / `isConfigInterface`.
import { SONIX_CATALOG, SONIX_LAYOUTS, type SonixCatalogEntry, type SonixLayoutKey } from "./sonix-catalog.generated.ts";
import { SONIX, type RtLimits } from "./sonix-protocol.ts";

export { SONIX_CATALOG, SONIX_LAYOUTS };
export type { SonixCatalogEntry, SonixLayoutKey };

/** Sonix Technology's USB vendor id (also used by Sonix webcams and other gear: always filter by PID + collection). */
export const SONIX_VENDOR_ID = 0x0c45;
/**
 * Two boards in the official driver's list (LEOBOG "AMG65 Dongle" and "ES75-MAG") report Apple's vendor
 * id 0x05AC with PID 0x024F, the id of an Apple keyboard. FCC opens them on the same 0xFF68 collection.
 */
export const SONIX_APPLE_ALIAS = { vendorId: 0x05ac, productId: 0x024f } as const;

/** Boards that speak the protocol: wired, not "unsupported". [registry WIRED_IDS: transport === "wired"] */
export const SONIX_WIRED: readonly SonixCatalogEntry[] = SONIX_CATALOG.filter((d) => d.transport === "wired" && d.status !== "unsupported");

const idKey = (v: number, p: number) => `${v.toString(16).padStart(4, "0")}:${p.toString(16).padStart(4, "0")}`;

/** Every distinct USB id the bridge must list for these boards (each only on 0xFF68 / 0x61). */
export const SONIX_USB_IDS: readonly { vendorId: number; productId: number }[] = [...new Map(SONIX_WIRED.map((d) => [idKey(d.vendorId, d.productId), { vendorId: d.vendorId, productId: d.productId }])).values()].sort(
  (a, b) => a.vendorId - b.vendorId || a.productId - b.productId,
);

export const isSonixId = (vendorId: number, productId: number): boolean => SONIX_USB_IDS.some((d) => d.vendorId === vendorId && d.productId === productId);

/**
 * What the bridge must allow, and nothing more: the vendor config collection 0xFF68 / 0x61 of the listed
 * ids, output report 0 (64 bytes) out, input report 0 (64 bytes) in. No feature reports. Never the
 * keyboard (page 0x07 / Generic Desktop keyboard), consumer or system-control collections, and no
 * other Sonix (0x0C45) product: the same vendor id covers webcams and other devices.
 */
export const SONIX_BRIDGE = {
  usagePage: SONIX.usagePage,
  usage: SONIX.usage,
  outputReportId: SONIX.reportId,
  inputReportId: SONIX.reportId,
  reportLength: SONIX.length,
  featureReports: false,
  ids: SONIX_USB_IDS,
} as const;

/** WebHID-style filters for the config collection of every listed board. [transport.ts FILTERS] */
export const SONIX_FILTERS: readonly HIDDeviceFilterLike[] = SONIX_USB_IDS.map((d) => ({ ...d, usagePage: SONIX.usagePage, usage: SONIX.usage }));

export interface HIDDeviceFilterLike {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

export interface SonixKey {
  /** Firmware key index: addresses the key map, RT and colour regions. */
  index: number;
  /** HID usage of the key's native function (0 = Fn or none). */
  hid: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SonixModel extends SonixCatalogEntry {
  keys: SonixKey[];
  /** Limits in 0.01 mm; actuation from 0.10 mm to full travel, as FCC registry builds them. */
  rt: RtLimits;
}

export function layoutKeys(layout: string): SonixKey[] {
  return (SONIX_LAYOUTS[layout] ?? []).map(([index, hid, x, y, w, h]) => ({ index, hid, x, y, w, h }));
}

export function modelOf(entry: SonixCatalogEntry): SonixModel {
  const l = entry.limits;
  return { ...entry, keys: layoutKeys(entry.layout), rt: { travel: l.travel, actuationMin: 10, actuationMax: l.travel, sensMin: l.sensMin, sensMax: l.sensMax } };
}

export interface SonixDetection {
  /** Best guess; null when the id isn't a listed wired board. */
  model: SonixModel | null;
  /** Every listed board sharing the USB id (22 ids are shared, up to 9 boards on 0c45:8800). */
  candidates: SonixModel[];
  /** True when the guess is certain: an exact product-name match, or every candidate has the same layout. */
  certain: boolean;
  /** FCC has confirmed this exact model on hardware (only the Fighting68). */
  verified: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Model from the USB ids and product string. Same rules as FCC registry `detect`: wired candidates by
 * VID:PID; an exact (normalised) name match is certain, preferring the verified entry; otherwise the
 * first candidate, certain only when all candidates share one layout. `firmwareIds` (info region bytes
 * 4..7, the ids the firmware reports) must agree with the USB ids when given.
 */
export function detectSonix(vendorId: number, productId: number, productName: string, firmwareIds?: { vendorId: number; productId: number }): SonixDetection {
  const candidates = SONIX_WIRED.filter((d) => d.vendorId === vendorId && d.productId === productId).map(modelOf);
  if (!candidates.length) return { model: null, candidates: [], certain: false, verified: false };
  if (firmwareIds && (firmwareIds.vendorId !== vendorId || firmwareIds.productId !== productId)) return { model: null, candidates, certain: false, verified: false };
  const byName = candidates.filter((d) => norm(d.name) === norm(productName));
  if (byName.length) {
    const pick = byName.find((d) => d.status === "verified") ?? byName[0];
    return { model: pick, candidates, certain: true, verified: pick.status === "verified" };
  }
  const certain = new Set(candidates.map((d) => d.layout)).size === 1;
  return { model: candidates[0], candidates, certain, verified: false };
}

/** Coverage counts (for the report and the UI's "supported boards" line). */
export function sonixCoverage() {
  const wired = SONIX_WIRED;
  return {
    catalogEntries: SONIX_CATALOG.length,
    wiredBoards: wired.length,
    verified: wired.filter((d) => d.status === "verified").length,
    untested: wired.filter((d) => d.status === "untested").length,
    unsupported: SONIX_CATALOG.filter((d) => d.status === "unsupported" || d.transport !== "wired").length,
    usbIds: SONIX_USB_IDS.length,
    sharedUsbIds: [...new Set(wired.map((d) => idKey(d.vendorId, d.productId)))].filter((k) => wired.filter((d) => idKey(d.vendorId, d.productId) === k).length > 1).length,
    layouts: new Set(wired.map((d) => d.layout)).size,
  };
}
