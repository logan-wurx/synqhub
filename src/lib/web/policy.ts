// Which devices and which collections SYNQ may touch, ported 1:1 from the desktop bridge
// (src-tauri/src/hid.rs `allowed`, `collection_access`, `usable`, ...; src-tauri/src/brands.rs
// `CHANNELS`; src-tauri/src/devices.rs `classify`). The website has no Rust bridge, so this is the
// rule that decides what its chooser asks for, what the device list shows and which collections a
// driver is handed. scripts/web-guard.test.ts compares the channel table with brands.rs and the tables
// with the Rust ones, so a change on one side without the other fails a test.
//
// Pure data and functions: no DOM, no React, no device access.
import { BOOTLOADER_IDS, bootloaderEntry, isBootloader } from "../bootloader-ids.ts";
import * as ids from "./ids.generated.ts";
import { ILLUMIPC_USB_IDS, isIllumipcId } from "../illumipc/ids.ts";
import { BRAGI_REQUEST, FLYDIGI_PAGE, GAMEPAD_COLLECTIONS, GAMESIR_PAGE, VALVE_INPUT, hidPad, isPad, padAccess, padCollection, padGuardOf, padRow } from "../controllers/pads.ts";
import { PAD_BOOT, PAD_ROWS } from "../controllers/ids.generated.ts";
import { findHeadset, type Family as HeadsetFamily } from "../headsets/protocol.ts";
import { FAMILIES as HUB_FAMILIES, MODELS as HUB_MODELS, findHub, type HubModel } from "../lighting/hidrgb/protocol.ts";
import { LAMP_ARRAY, LIGHTING_PAGE } from "../lighting/lamparray-hid.ts";

export const LOGITECH = 0x046d;
export const ASUS = 0x0b05;
export const ATK = 0x373b;
export const RAZER = 0x1532;
export const FALCHION_ZYWOO = 0x1d1d;
export const ATK_PRODUCTS: readonly number[] = [0x1278, 0x12a2];
export const ASUS_PRODUCTS: readonly number[] = [FALCHION_ZYWOO];
/** Typing, pointing, consumer and digitizer pages: never opened for an OpenMouse device. */
export const INPUT_PAGES: readonly number[] = [0x0001, 0x0007, 0x000c, 0x000d];
export const ATK_CONFIG_COLLECTION = [0xff02, 0x0002] as const;
export const X68_CONFIG_COLLECTION = [0xff1b, 0x0091] as const;
export const X68_REPORT_ID = 1;
export const X68_FRAME_LEN = 63;
export const QMK_RAW_COLLECTION = [0xff60, 0x0061] as const;
export const RAZER_FEATURE_COLLECTIONS: readonly (readonly [number, number])[] = [
  [0x0001, 0x0002],
  [0x000c, 0x0001],
];
const WOOTING_ANALOG_PAGES: readonly number[] = [0xff53, 0xff54];

const key = (v: number, p: number) => v * 0x10000 + p;
const pairSet = (rows: readonly (readonly [number, number])[]) => new Set(rows.map(([v, p]) => key(v, p)));
const pidSet = (vendor: number, pids: readonly number[]) => new Set(pids.map((p) => key(vendor, p)));

const sets = {
  sonix: pairSet(ids.SONIX),
  monsgeek: pairSet(ids.MONSGEEK),
  drunkdeer: pairSet(ids.DRUNKDEER),
  x60: pairSet(ids.DRUNKDEER_X60),
  bytech: pairSet(ids.BYTECH),
  fwMchose: pairSet(ids.FW19F5_MCHOSE),
  fwDrunkdeer: pairSet(ids.FW19F5_DRUNKDEER),
  fwNuphy: pairSet(ids.FW19F5_NUPHY),
  fwRkGcome: pairSet(ids.FW19F5_RK_GCOME),
  rkBeiying: pairSet(ids.RK_BEIYING),
  sparklink: pairSet(ids.SPARKLINK),
  keychronHe: pairSet(ids.KEYCHRON_HE),
  razerKb: pidSet(RAZER, ids.RAZER_KEYBOARDS),
  razerMouse: pidSet(RAZER, ids.RAZER_BRAND_MICE),
  asusBoot: new Set(ids.ASUS_BOOTLOADER),
  bragiKb: pidSet(0x1b1c, ids.CORSAIR_BRAGI_KEYBOARDS),
  bragiMouse: pidSet(0x1b1c, ids.CORSAIR_BRAGI_MICE),
  sabre: pidSet(0x1b1c, ids.CORSAIR_SABRE),
  icueKb: pidSet(0x1b1c, ids.ICUE_KEYBOARDS),
  icueMouse: pidSet(0x1b1c, ids.ICUE_MICE),
  logitechKb: pidSet(LOGITECH, ids.LOGITECH_KEYBOARDS),
  steelseries: pidSet(0x1038, ids.STEELSERIES),
  ssBoot: new Set(ids.STEELSERIES_BOOTLOADER),
  listed: pairSet(ids.LISTED_KEYBOARDS),
  logitechMice: new Set(ids.LOGITECH_MOUSE_PIDS),
  razerFeatureOnly: new Set(ids.RAZER_FEATURE_ONLY_PIDS),
};

// ---------------------------------------------------------------------------------------------
// Brand channels (brands.rs CHANNELS)
// ---------------------------------------------------------------------------------------------

export type Takes = "output" | "feature" | "both";
export type GuardKind = "sonix" | "monsgeek" | "drunkdeer" | "bytech" | "razer" | "asus" | "bragi" | "sabre" | "icue" | "logitech-kb" | "steelseries" | "fw19f5-mchose" | "fw19f5-drunkdeer" | "fw19f5-readonly" | "rk-beiying" | "sparklink" | "headset";

export interface Channel {
  brand: string;
  /** "keyboard" and "headset" are listed in the device list; "mouse" is opened for a driver but not listed. */
  kind: "keyboard" | "mouse" | "headset";
  ids(vendorId: number, productId: number): boolean;
  /** The collections this brand talks on: [usage page, usage or null for any usage on that page]. */
  collections: readonly (readonly [number, number | null])[];
  takes: Takes;
  reportIds: readonly number[];
  featureSize: number;
  guard: GuardKind;
  /** A further identity check on the product string, for ids on a borrowed vendor id. */
  nameOk?: (name: string) => boolean;
}

const asusFamily = (p: number): string | undefined => ids.ASUS_FAMILY[p];
const headsetIn = (v: number, p: number, ...families: HeadsetFamily[]): boolean => {
  const m = findHeadset(v, p);
  return !!m && families.includes(m.family);
};
const k = key;

/** The X60's vendor id isn't DrunkDeer's: its product string must say so. */
export const x60Name = (name: string): boolean => {
  const n = name.toLowerCase();
  return n.includes("x60") || n.replace(/[ \-_]/g, "").includes("drunkdeer");
};

export const CHANNELS: readonly Channel[] = [
  { brand: "Sonix", kind: "keyboard", ids: (v, p) => sets.sonix.has(k(v, p)), collections: [[0xff68, 0x0061]], takes: "output", reportIds: [0], featureSize: 65, guard: "sonix" },
  { brand: "MonsGeek", kind: "keyboard", ids: (v, p) => sets.monsgeek.has(k(v, p)), collections: [[0xffff, 0x0002]], takes: "feature", reportIds: [0], featureSize: 65, guard: "monsgeek" },
  { brand: "DrunkDeer", kind: "keyboard", ids: (v, p) => sets.drunkdeer.has(k(v, p)), collections: [[0xff00, null]], takes: "output", reportIds: [4], featureSize: 65, guard: "drunkdeer" },
  { brand: "DrunkDeer", kind: "keyboard", ids: (v, p) => sets.x60.has(k(v, p)), collections: [[0xff00, null]], takes: "output", reportIds: [4], featureSize: 65, guard: "drunkdeer", nameOk: x60Name },
  { brand: "Bytech", kind: "keyboard", ids: (v, p) => sets.bytech.has(k(v, p)), collections: [[0xff00, null]], takes: "output", reportIds: [9], featureSize: 65, guard: "bytech" },
  { brand: "Razer", kind: "keyboard", ids: (v, p) => sets.razerKb.has(k(v, p)), collections: [[0x000c, 0x0001]], takes: "feature", reportIds: [0], featureSize: 256, guard: "razer" },
  { brand: "Razer", kind: "mouse", ids: (v, p) => sets.razerMouse.has(k(v, p)), collections: [[0x000c, 0x0001]], takes: "feature", reportIds: [0], featureSize: 256, guard: "razer" },
  {
    brand: "ASUS",
    kind: "keyboard",
    ids: (v, p) => v === ASUS && p !== FALCHION_ZYWOO && !sets.asusBoot.has(p) && ["mech", "hfx", "he-v1", "he-v2"].includes(asusFamily(p) ?? ""),
    collections: [[0xff00, 0x0001]],
    takes: "output",
    reportIds: [0, 2],
    featureSize: 65,
    guard: "asus",
  },
  { brand: "ASUS", kind: "mouse", ids: (v, p) => v === ASUS && !sets.asusBoot.has(p) && asusFamily(p) === "mouse", collections: [[0xff01, 0x0001]], takes: "output", reportIds: [0, 2], featureSize: 65, guard: "asus" },
  { brand: "Corsair", kind: "keyboard", ids: (v, p) => sets.bragiKb.has(k(v, p)), collections: [[0xff42, 0x0001]], takes: "output", reportIds: [0], featureSize: 65, guard: "bragi" },
  { brand: "Corsair", kind: "mouse", ids: (v, p) => sets.bragiMouse.has(k(v, p)), collections: [[0xff42, 0x0001]], takes: "output", reportIds: [0], featureSize: 65, guard: "bragi" },
  { brand: "Corsair", kind: "mouse", ids: (v, p) => sets.sabre.has(k(v, p)), collections: [[0xff02, 0x0002]], takes: "output", reportIds: [8], featureSize: 65, guard: "sabre" },
  { brand: "Corsair iCUE", kind: "keyboard", ids: (v, p) => sets.icueKb.has(k(v, p)), collections: [[0xff42, 0x0001]], takes: "output", reportIds: [0], featureSize: 65, guard: "icue" },
  { brand: "Corsair iCUE", kind: "mouse", ids: (v, p) => sets.icueMouse.has(k(v, p)), collections: [[0xff42, 0x0001]], takes: "output", reportIds: [0], featureSize: 65, guard: "icue" },
  {
    brand: "Logitech",
    kind: "keyboard",
    ids: (v, p) => sets.logitechKb.has(k(v, p)),
    collections: [
      [0xff00, null],
      [0xff43, null],
    ],
    takes: "output",
    reportIds: [0x10, 0x11, 0x12],
    featureSize: 65,
    guard: "logitech-kb",
  },
  { brand: "SteelSeries", kind: "keyboard", ids: (v, p) => v === 0x1038 && sets.steelseries.has(k(v, p)) && !sets.ssBoot.has(p), collections: [[0xffc0, 0x0001]], takes: "both", reportIds: [0], featureSize: 1024, guard: "steelseries" },
  // Wave 4a. The 0x19F5 firmware family: Generic Desktop 0001:0000 (usage 0) only, never the keyboard, mouse or system-control collections.
  { brand: "MCHOSE", kind: "keyboard", ids: (v, p) => sets.fwMchose.has(k(v, p)), collections: [[0x0001, 0x0000]], takes: "output", reportIds: [0], featureSize: 65, guard: "fw19f5-mchose" },
  { brand: "DrunkDeer", kind: "keyboard", ids: (v, p) => sets.fwDrunkdeer.has(k(v, p)), collections: [[0x0001, 0x0000]], takes: "output", reportIds: [0], featureSize: 65, guard: "fw19f5-drunkdeer" },
  { brand: "NuPhy", kind: "keyboard", ids: (v, p) => sets.fwNuphy.has(k(v, p)), collections: [[0x0001, 0x0000]], takes: "output", reportIds: [0], featureSize: 65, guard: "fw19f5-readonly" },
  { brand: "Royal Kludge", kind: "keyboard", ids: (v, p) => sets.fwRkGcome.has(k(v, p)), collections: [[0x0001, 0x0000]], takes: "output", reportIds: [0], featureSize: 65, guard: "fw19f5-readonly" },
  // Wave 4e. Royal Kludge BeiYing: System Control 0001:0080, feature report 0x0A only. Browsers hide that collection (availability.ts).
  { brand: "Royal Kludge", kind: "keyboard", ids: (v, p) => sets.rkBeiying.has(k(v, p)), collections: [[0x0001, 0x0080]], takes: "feature", reportIds: [0x0a], featureSize: 65, guard: "rk-beiying" },
  // Wave 4c. SparkLink (Royal Kludge C / M75 HE, AULA HE, Kochi): vendor collection 0xFFA0:0x0001, output report 0.
  { brand: "SparkLink", kind: "keyboard", ids: (v, p) => sets.sparklink.has(k(v, p)), collections: [[0xffa0, 0x0001]], takes: "output", reportIds: [0], featureSize: 65, guard: "sparklink" },
  // Gaming headsets (src/lib/headsets, brands.rs): each family's one collection.
  { brand: "SteelSeries", kind: "headset", ids: (v, p) => headsetIn(v, p, "ss-nova7"), collections: [[0xffc0, 0x0001]], takes: "output", reportIds: [0], featureSize: 65, guard: "headset" },
  { brand: "Logitech", kind: "headset", ids: (v, p) => headsetIn(v, p, "logi-g535"), collections: [[0x000c, 0x0001]], takes: "output", reportIds: [0x11], featureSize: 65, guard: "headset" },
  { brand: "Logitech", kind: "headset", ids: (v, p) => headsetIn(v, p, "logi-gpro", "logi-g633"), collections: [[0xff43, 0x0202]], takes: "output", reportIds: [0x11], featureSize: 65, guard: "headset" },
  { brand: "HyperX", kind: "headset", ids: (v, p) => headsetIn(v, p, "hyperx-cloud2w"), collections: [[0xff90, 0x0303]], takes: "output", reportIds: [6], featureSize: 65, guard: "headset" },
];

/** Keychron / Lemokey Hall-effect keyboards: VIA's raw-HID channel takes Keychron's analog commands too (hid.rs `keychron_he_frame_allowed`). */
export const keychronHe = (v: number, p: number): boolean => sets.keychronHe.has(k(v, p));

/** An id OpenMouse's own table names one by one: its driver keeps it (a brand channel never takes it over). */
const openmousePinned = (v: number, p: number) => ids.OPENMOUSE_FILTERS.some(([fv, fp]) => fv === v && fp === p);

/** Whether this vendor/product id belongs to a brand channel (then only that channel is ever opened). */
export function brandDevice(v: number, p: number): Channel | null {
  if (openmousePinned(v, p)) return null;
  return CHANNELS.find((c) => c.ids(v, p)) ?? null;
}

/** The brand channel this collection is, if it is one. */
export function brandChannel(v: number, p: number, page: number, usage: number): Channel | null {
  const c = brandDevice(v, p);
  return c && c.collections.some(([cp, cu]) => cp === page && (cu === null || cu === usage)) ? c : null;
}

/** Whether the device list shows this brand keyboard (a registered keyboard driver claims it). */
export const brandListed = (v: number, p: number): boolean => ![0x0b05, 0x1b1c, 0x046d, 0x1038].includes(v) || sets.listed.has(k(v, p));

export const channelNameOk = (c: Channel, product: string | null | undefined): boolean => !c.nameOk || (!!product && c.nameOk(product));

// ---------------------------------------------------------------------------------------------
// Which collections of which devices may be opened (hid.rs)
// ---------------------------------------------------------------------------------------------

export type Access = "full" | "feature" | "input";

export const bootloaderId = (v: number, p: number): boolean => isBootloader(v, p, null);
export const inBootloader = (v: number, p: number, product?: string | null): boolean => isBootloader(v, p, product);

export const openmouseDevice = (v: number, p: number): boolean => ids.OPENMOUSE_FILTERS.some(([fv, fp]) => fv === v && (fp === null || fp === p));
export const keyboardDevice = (v: number, p: number): boolean => ids.KEYBOARD_FILTERS.some(([fv, fp]) => fv === v && fp === p);
export const keyboardCollection = (v: number, p: number, page: number, usage: number): boolean =>
  !INPUT_PAGES.includes(page) && ids.KEYBOARD_FILTERS.some(([fv, fp, fpage, fu]) => fv === v && fp === p && fpage === page && fu === usage);

export function openmouseCollection(v: number, p: number, page: number, usage: number): boolean {
  if (INPUT_PAGES.includes(page)) return false;
  return ids.OPENMOUSE_FILTERS.some(([fv, fp, fpage, fu]) => fv === v && (fp === null || fp === p) && (fpage !== null ? fpage === page && (fu === null || fu === usage) : page >= 0xff00));
}

export function razerFeatureOnly(v: number, p: number, page: number, usage: number): boolean {
  return (
    v === RAZER &&
    sets.razerFeatureOnly.has(p) &&
    RAZER_FEATURE_COLLECTIONS.some(([cp, cu]) => cp === page && cu === usage) &&
    ids.OPENMOUSE_FILTERS.some(([fv, fp, fpage, fu]) => fv === v && fp === p && (fpage === null || fpage === page) && (fu === null || fu === usage))
  );
}

export const openmouseCollectionOrRazer = (v: number, p: number, page: number, usage: number): boolean => openmouseCollection(v, p, page, usage) || razerFeatureOnly(v, p, page, usage);

export const qmkRawHid = (v: number, p: number, page: number, usage: number): boolean =>
  page === QMK_RAW_COLLECTION[0] && usage === QMK_RAW_COLLECTION[1] && v !== ASUS && !isIllumipcId(v, p) && !bootloaderId(v, p);

/** Every QMK raw-HID collection except one an OpenMouse filter names by product id for its own protocol on that page. */
export const viaGuarded = (v: number, p: number, page: number, usage: number): boolean =>
  page === QMK_RAW_COLLECTION[0] && usage === QMK_RAW_COLLECTION[1] && !ids.OPENMOUSE_FILTERS.some(([fv, fp, fpage]) => fv === v && fp === p && fpage === page);

export const analogInputOnly = (v: number, p: number, page: number): boolean =>
  WOOTING_ANALOG_PAGES.includes(page) && (v === 0x31e3 || (v === 0x03eb && (p === 0xff01 || p === 0xff02))) && !bootloaderId(v, p);

export const atkDevice = (v: number, p: number): boolean => v === ATK && ATK_PRODUCTS.includes(p);

/** Whether this vendor/product id may be listed at all (hid.rs `allowed`). */
export function allowed(v: number, p: number): boolean {
  if (bootloaderId(v, p)) return false;
  // A game controller (src/lib/controllers/pads.ts): allowed when it's a HID pad; nothing else is made of its id.
  if (isPad(v, p)) return hidPad(v, p);
  if (brandDevice(v, p)) return true;
  // The keyboards illumipc.com's configurator drives (2E3C:C365..C368, 0416:7372).
  if (isIllumipcId(v, p)) return true;
  switch (v) {
    case LOGITECH:
      return true;
    case ASUS:
      return ASUS_PRODUCTS.includes(p) || openmouseDevice(v, p);
    case ATK:
      return ATK_PRODUCTS.includes(p) || openmouseDevice(v, p);
    default:
      return openmouseDevice(v, p) || keyboardDevice(v, p);
  }
}

function fullAccess(v: number, p: number, page: number, usage: number): boolean {
  if (isIllumipcId(v, p)) return page === X68_CONFIG_COLLECTION[0] && usage === X68_CONFIG_COLLECTION[1];
  switch (v) {
    case LOGITECH:
      return true;
    case ASUS:
      if (ASUS_PRODUCTS.includes(p)) return true;
      break;
    case ATK:
      if (ATK_PRODUCTS.includes(p)) return page === ATK_CONFIG_COLLECTION[0] && usage === ATK_CONFIG_COLLECTION[1];
      break;
  }
  return openmouseCollection(v, p, page, usage) || keyboardCollection(v, p, page, usage);
}

/** How a collection of a device may be used, or null when it must stay closed. */
export function collectionAccess(v: number, p: number, page: number, usage: number): Access | null {
  if (bootloaderId(v, p)) return null;
  // A game controller: its own read-only rule only (pads.rs `access`).
  if (isPad(v, p)) return padAccess(v, p, page, usage);
  const brand = brandDevice(v, p);
  if (brand) {
    const c = brandChannel(v, p, page, usage);
    return c ? (c.takes === "feature" ? "feature" : "full") : null;
  }
  if (razerFeatureOnly(v, p, page, usage)) return "feature";
  if (analogInputOnly(v, p, page)) return "input";
  return fullAccess(v, p, page, usage) || qmkRawHid(v, p, page, usage) ? "full" : null;
}

export const collectionAllowed = (v: number, p: number, page: number, usage: number): boolean => collectionAccess(v, p, page, usage) !== null;

/** Whether a collection may be listed: not in update mode (by id or product string), and allowed. */
export function usable(v: number, p: number, product: string | null | undefined, page: number, usage: number): boolean {
  const c = brandChannel(v, p, page, usage);
  if (c) return !inBootloader(v, p, product) && channelNameOk(c, product);
  return !inBootloader(v, p, product) && (allowed(v, p) || qmkRawHid(v, p, page, usage) || analogInputOnly(v, p, page)) && collectionAllowed(v, p, page, usage);
}

// ---------------------------------------------------------------------------------------------
// The device list (devices.rs `classify`)
// ---------------------------------------------------------------------------------------------

export interface CollectionInfo {
  usagePage: number;
  usage: number;
}

export interface Classified {
  kind: "mouse" | "keyboard" | "audio" | "controller" | "rgbhub";
  name: string;
  connection: string;
  generic: boolean;
  kb?: "omkb" | "qmk" | "brand";
  qmk: boolean;
  bootloader: boolean;
  vid: string;
  pid: string;
  reported: string | null;
  /** A game controller: how it is reached (devices.rs `PadInfo`). */
  pad?: { via: "hid"; kind: string };
}

interface Known {
  vid: number;
  pid: number;
  kind: "mouse" | "keyboard" | "audio";
  name: string;
  connection: string;
}

const KNOWN: readonly Known[] = [
  { vid: 0x046d, pid: 0xc0a0, kind: "mouse", name: "PRO X 2 DEX", connection: "USB cable" },
  { vid: 0x046d, pid: 0xc09b, kind: "mouse", name: "PRO X SUPERLIGHT 2", connection: "USB cable" },
  { vid: 0x046d, pid: 0xc54d, kind: "mouse", name: "Logitech mouse", connection: "LIGHTSPEED receiver" },
  { vid: 0x373b, pid: 0x1278, kind: "mouse", name: "ATK X1 V2 Air+", connection: "8K receiver" },
  { vid: 0x373b, pid: 0x12a2, kind: "mouse", name: "ATK X1 V2 Air+", connection: "USB cable" },
  { vid: 0x0b05, pid: 0x1d1d, kind: "keyboard", name: "ROG Falchion Ace HFX ZywOo", connection: "USB" },
  ...ILLUMIPC_USB_IDS.map(([vid, pid]): Known => ({ vid, pid, kind: "keyboard", name: `HE keyboard (${vid.toString(16).toUpperCase().padStart(4, "0")}:${pid.toString(16).toUpperCase().padStart(4, "0")})`, connection: "USB" })),
  { vid: 0x3142, pid: 0xa010, kind: "audio", name: "USB audio (EQ output)", connection: "USB" },
];

function refine(known: Known, reported: string | null): string {
  if (known.vid === 0x2e3c && known.pid === 0xc365 && reported && reported.toUpperCase().replace(/[ \-]/g, "").includes("X68")) return "MAGIC-REFINER X68 HE";
  return known.name;
}

const candidateName = (reported: string | null, fallback: string) => reported ?? fallback;
const candidateConnection = (reported: string | null) => (["receiver", "dongle", "wireless", "2.4g"].some((w) => (reported ?? "").toLowerCase().includes(w)) ? "Receiver" : "USB");

const hex4 = (n: number) => n.toString(16).padStart(4, "0");

function bootloaderKind(v: number, p: number, cols: readonly CollectionInfo[]): "mouse" | "keyboard" | "controller" | null {
  const KEYBOARDS: readonly (readonly [number, number])[] = [
    [0x361d, 0x0201],
    [0x16c0, 0x0478],
    [0x16c0, 0x05df],
    [0x03eb, 0x2067],
  ];
  if (KEYBOARDS.some(([kv, kp]) => kv === v && kp === p) || v === 0x19f5 || (v === 0x03eb && p >= 0x2ff0 && p <= 0x2ff9) || (v === 0x1038 && sets.ssBoot.has(p))) return "keyboard";
  if (bootloaderEntry(v, p)?.kind === "controller") return "controller";
  if (bootloaderId(v, p)) return "mouse";
  if (ids.KEYBOARD_FILTERS.some(([fv]) => fv === v) || cols.some((c) => c.usagePage === QMK_RAW_COLLECTION[0] && c.usage === QMK_RAW_COLLECTION[1])) return "keyboard";
  return v === 0x046d || v === 0x373b || ids.OPENMOUSE_FILTERS.some(([fv]) => fv === v) ? "mouse" : null;
}

/** A hub's vendor collection (hidrgb.rs `open`): the family's own (Lian Li), else any vendor-defined page. */
export function hubCollection(m: HubModel, cols: readonly CollectionInfo[]): boolean {
  const want = HUB_FAMILIES[m.family].collection;
  return cols.some((c) => (want ? c.usagePage === want[0] && c.usage === want[1] : c.usagePage >= 0xff00));
}

/** What one vendor/product id is to SYNQ, or null when it is nothing SYNQ shows. */
export function classifyDevice(v: number, p: number, cols: readonly CollectionInfo[], reported: string | null): Classified | null {
  const entry = (kind: Classified["kind"], name: string, connection: string): Classified => ({ kind, name, connection, generic: false, qmk: false, bootloader: false, vid: hex4(v), pid: hex4(p), reported });
  const qmk = cols.some((c) => c.usagePage === QMK_RAW_COLLECTION[0] && c.usage === QMK_RAW_COLLECTION[1]) && qmkRawHid(v, p, QMK_RAW_COLLECTION[0], QMK_RAW_COLLECTION[1]);
  if (inBootloader(v, p, reported)) {
    const kind = bootloaderKind(v, p, cols);
    if (!kind) return null;
    return { ...entry(kind, reported ?? "Device", "USB"), bootloader: true };
  }
  const known = KNOWN.find((x) => x.vid === v && x.pid === p);
  if (known) return entry(known.kind, refine(known, reported), known.connection);
  // A USB RGB hub (src/lib/lighting/hidrgb/hubs.json): listed when its vendor collection is there, as hidrgb.rs lists it.
  const hub = findHub(v, p);
  if (hub) return hubCollection(hub, cols) ? entry("rgbhub", hub.name, "USB") : null;
  // A game controller: listed when its gamepad collection is there (devices.rs; the browser has no XInput, so an
  // Xbox pad over Bluetooth is listed here as the HID pad it is).
  if (isPad(v, p)) {
    const row = padRow(v, p)!;
    if (!cols.some((c) => padCollection(v, p, c.usagePage, c.usage))) return null;
    return { ...entry("controller", reported ?? "Game controller", "USB"), pad: { via: "hid", kind: row[2] } };
  }
  const ch = brandDevice(v, p);
  if (ch) {
    const present = cols.some((c) => brandChannel(v, p, c.usagePage, c.usage));
    if (!present || !channelNameOk(ch, reported) || ch.kind !== "keyboard" || !brandListed(v, p)) return null;
    return { ...entry("keyboard", candidateName(reported, "Keyboard"), "USB"), generic: true, kb: "brand" };
  }
  if (v === LOGITECH) return sets.logitechMice.has(p) ? entry("mouse", "Logitech mouse", p >= 0xc500 ? "LIGHTSPEED receiver" : "USB cable") : null;
  const ok = allowed(v, p);
  const any = (f: (v: number, p: number, page: number, usage: number) => boolean) => cols.some((c) => f(v, p, c.usagePage, c.usage));
  if (ok && keyboardDevice(v, p) && any(keyboardCollection)) return { ...entry("keyboard", candidateName(reported, "Keyboard"), "USB"), generic: true, kb: "omkb", qmk };
  if (ok && openmouseDevice(v, p) && any(openmouseCollectionOrRazer)) return { ...entry("mouse", candidateName(reported, "Mouse"), candidateConnection(reported)), generic: true, qmk };
  if (qmk) return { ...entry("keyboard", candidateName(reported, "Keyboard"), "USB"), generic: true, kb: "qmk", qmk };
  return null;
}

// ---------------------------------------------------------------------------------------------
// The chooser (navigator.hid.requestDevice)
// ---------------------------------------------------------------------------------------------

const same = (a: HIDDeviceFilter, b: HIDDeviceFilter) => a.vendorId === b.vendorId && a.productId === b.productId && a.usagePage === b.usagePage && a.usage === b.usage;

/**
 * The filters the "Add device" chooser asks for, built from the same registries the rest of the app
 * uses: OpenMouse's mouse table, the keyboard package's config collections, every brand driver's
 * channel, VIA / Vial's raw-HID usage page, and the hand-built devices. Firmware-update (bootloader)
 * identities are excluded, so they can't be picked at all.
 */
export function chooserFilters(): { filters: HIDDeviceFilter[]; exclusionFilters: HIDDeviceFilter[] } {
  const filters: HIDDeviceFilter[] = [];
  const add = (f: HIDDeviceFilter) => {
    if (!filters.some((x) => same(x, f))) filters.push(f);
  };
  const optional = (vendorId: number, productId: number | null, usagePage: number | null, usage: number | null): HIDDeviceFilter => ({
    vendorId,
    ...(productId !== null ? { productId } : {}),
    ...(usagePage !== null ? { usagePage } : {}),
    ...(usage !== null ? { usage } : {}),
  });
  for (const [v, p, page, u] of ids.OPENMOUSE_FILTERS) add(optional(v, p, page, u));
  for (const [v, p, page, u] of ids.KEYBOARD_FILTERS) add(optional(v, p, page, u));
  // Brand channels: every id the table names, on that brand's collection. (ASUS ids come from the rule table's families.)
  const brandPairs: [Channel, number, number][] = [];
  const pairLists: [number, readonly (readonly [number, number])[]][] = [
    [0, ids.SONIX],
    [1, ids.MONSGEEK],
    [2, ids.DRUNKDEER],
    [3, ids.DRUNKDEER_X60],
    [4, ids.BYTECH],
    [16, ids.FW19F5_MCHOSE],
    [17, ids.FW19F5_DRUNKDEER],
    [18, ids.FW19F5_NUPHY],
    [19, ids.FW19F5_RK_GCOME],
    [21, ids.SPARKLINK],
  ];
  for (const [i, rows] of pairLists) for (const [v, p] of rows) brandPairs.push([CHANNELS[i], v, p]);
  const byGuard = (guard: GuardKind, kind: "keyboard" | "mouse" | "headset") => CHANNELS.find((c) => c.guard === guard && c.kind === kind)!;
  for (const p of ids.RAZER_KEYBOARDS) brandPairs.push([byGuard("razer", "keyboard"), RAZER, p]);
  for (const p of ids.RAZER_BRAND_MICE) brandPairs.push([byGuard("razer", "mouse"), RAZER, p]);
  for (const p of Object.keys(ids.ASUS_FAMILY).map(Number)) {
    const c = CHANNELS.find((x) => x.guard === "asus" && x.ids(ASUS, p));
    if (c) brandPairs.push([c, ASUS, p]);
  }
  for (const p of ids.CORSAIR_BRAGI_KEYBOARDS) brandPairs.push([byGuard("bragi", "keyboard"), 0x1b1c, p]);
  for (const p of ids.CORSAIR_BRAGI_MICE) brandPairs.push([byGuard("bragi", "mouse"), 0x1b1c, p]);
  for (const p of ids.CORSAIR_SABRE) brandPairs.push([byGuard("sabre", "mouse"), 0x1b1c, p]);
  for (const p of ids.ICUE_KEYBOARDS) brandPairs.push([byGuard("icue", "keyboard"), 0x1b1c, p]);
  for (const p of ids.ICUE_MICE) brandPairs.push([byGuard("icue", "mouse"), 0x1b1c, p]);
  for (const p of ids.LOGITECH_KEYBOARDS) brandPairs.push([byGuard("logitech-kb", "keyboard"), LOGITECH, p]);
  for (const p of ids.STEELSERIES) brandPairs.push([byGuard("steelseries", "keyboard"), 0x1038, p]);
  for (const [c, v, p] of brandPairs) {
    if (!c.ids(v, p)) continue;
    for (const [page, usage] of c.collections) add(optional(v, p, page, usage));
  }
  // Hand-built devices.
  add(optional(LOGITECH, null, 0xff00, null));
  add(optional(LOGITECH, null, 0xff43, null));
  for (const p of ATK_PRODUCTS) add(optional(ATK, p, ATK_CONFIG_COLLECTION[0], ATK_CONFIG_COLLECTION[1]));
  for (const [v, p] of ILLUMIPC_USB_IDS) add(optional(v, p, X68_CONFIG_COLLECTION[0], X68_CONFIG_COLLECTION[1]));
  add(optional(ASUS, FALCHION_ZYWOO, 0xff00, 0x0001));
  // VIA / Vial and QMK: any vendor, the raw-HID usage.
  add({ usagePage: QMK_RAW_COLLECTION[0], usage: QMK_RAW_COLLECTION[1] });
  // Game controllers: the gamepad and joystick collections of every vendor with a HID pad in the controller table,
  // and Valve's vendor input collection.
  for (const v of new Set(PAD_ROWS.filter(([pv, pp]) => hidPad(pv, pp)).map(([pv]) => pv))) {
    for (const [page, usage] of GAMEPAD_COLLECTIONS) add({ vendorId: v, usagePage: page, usage });
  }
  add({ vendorId: 0x28de, usagePage: VALVE_INPUT[0], usage: VALVE_INPUT[1] });
  // GameSir's configurable pads (per id): their vendor collection, the settings channel and its state report.
  for (const [v, p] of PAD_ROWS) if (padGuardOf(v, p)?.startsWith("gamesir-")) add({ vendorId: v, productId: p, usagePage: GAMESIR_PAGE });
  // The SCUF Envision's BRAGI channel (identity, firmware, battery reads only), per id.
  for (const [v, p] of PAD_ROWS) if (padGuardOf(v, p) === "scuf") add({ vendorId: v, productId: p, usagePage: BRAGI_REQUEST[0], usage: BRAGI_REQUEST[1] });
  // Flydigi's config channel (D-input mode), per id.
  for (const [v, p] of PAD_ROWS) if (padGuardOf(v, p) === "flydigi") add({ vendorId: v, productId: p, usagePage: FLYDIGI_PAGE });
  // USB RGB hubs, per id: the family's collection where it has one (Lian Li), else the device (its vendor page varies).
  for (const m of HUB_MODELS) {
    const c = HUB_FAMILIES[m.family].collection;
    add(optional(parseInt(m.vid, 16), parseInt(m.pid, 16), c?.[0] ?? null, c?.[1] ?? null));
  }
  // Dynamic Lighting: any device's LampArray collection (the HID standard; ASUS is refused when it is listed).
  add({ usagePage: LIGHTING_PAGE, usage: LAMP_ARRAY });
  // Firmware-update identities can't be picked.
  const exclusionFilters: HIDDeviceFilter[] = [];
  const seen = new Set<number>();
  const exclude = (v: number, p: number) => {
    if (seen.has(key(v, p))) return;
    seen.add(key(v, p));
    exclusionFilters.push({ vendorId: v, productId: p });
  };
  for (const [v, p] of bootloaderPairs()) exclude(v, p);
  return { filters, exclusionFilters };
}

/** Plain bootloader id pairs; ranges (NuPhy 19F5:AFxx, Atmel DFU) can't be a filter and are refused by `usable` instead. */
function bootloaderPairs(): [number, number][] {
  return [
    ...BOOTLOADER_IDS.map((b): [number, number] => [b.vid, b.pid]),
    ...PAD_BOOT.map(([v, p]): [number, number] => [v, p]),
    ...ids.ASUS_BOOTLOADER.map((p): [number, number] => [ASUS, p]),
    ...ids.STEELSERIES_BOOTLOADER.map((p): [number, number] => [0x1038, p]),
  ];
}
