// ASUS ROG / TUF / ProArt devices that SYNQ's Gear Link-family driver may talk to, and how they
// are told apart. Pure data: no device access.
//
// Identity: VID 0x0B05 + PID. Each PID has a Gear Link manifest (devices.generated.ts, generated from
// https://gearlink.asus.com/view/<pid>/manifest.json). The manifest's productNumber picks the SDK
// class (Gear Link SDK `initASUSDevices`: M605/M606 = legacy HFX class, M901/M703/M705/R701/R702/R704
// = base magnetic class with 0.01 mm units, the rest = mechanical boards and mice).
//
// Never touched: any ASUS PID not in this table (ASUS also makes motherboard Aura controllers such as
// 0x19AF), every bootloader / updater PID below, and headsets, gamepads and the dock (no protocol
// work here; they stay detect-only).
import { GEARLINK_DEVICES, GEARLINK_SNAPSHOT, type GearLinkDevice } from "./devices.generated.ts";
import type { HidChannel, KeyboardFeatures, MmRange, MouseFeatures, SupportTier } from "../types.ts";

export const ASUS_VID = 0x0b05;
export const ASUS_REPORT_ID = 0;
/**
 * Control report ids Gear Link uses on keyboards / mice: 0 over USB, 2 for a board's own 2.4 GHz
 * dongle (SDK `zs.initialize`). Report id 1 is the Omni receiver's own channel (63-byte frames), which
 * SYNQ does not drive.
 */
export const ASUS_CONTROL_REPORT_IDS: readonly number[] = [0, 2];

/** The control collection's output report id from the descriptor (WebHID shape), default 0. */
export function asusControlReportId(collections: readonly { usagePage?: number; usage?: number; outputReports?: readonly { reportId?: number }[] }[], page: number): number {
  const c = collections.find((x) => x.usagePage === page && x.usage === 1);
  const id = c?.outputReports?.[0]?.reportId ?? 0;
  return ASUS_CONTROL_REPORT_IDS.includes(id) ? id : -1;
}
export const ASUS_REPORT_LENGTH = 64;

/**
 * Gear Link devices.js object `z`: the collections it opens, by device class, always usage 1.
 * Mice, keyboards, headsets and receivers: control 0xFF00 / 0xFF01 / 0xFF02, events 0xFFC0..0xFFC2.
 * Gamepads 0xFF03 / 0xFFC3, dock 0xFF04 / 0xFFC4 (not driven by SYNQ).
 */
export const GEARLINK_CONTROL_PAGES = [0xff00, 0xff01, 0xff02] as const;
export const GEARLINK_EVENT_PAGES = [0xffc0, 0xffc1, 0xffc2] as const;
export const GEARLINK_USAGE = 0x0001;

/** The control channel (captured on the HFX ZywOo: FF00:0001, report 0, 64 bytes each way). */
export const asusControlChannel = (usagePage: number = 0xff00): HidChannel => ({
  role: "control",
  usagePage,
  usage: GEARLINK_USAGE,
  reportId: ASUS_REPORT_ID,
  length: ASUS_REPORT_LENGTH,
  direction: "output",
  note: "Requests and their echoes / replies. Gear Link sends one at a time and waits for the answer.",
});

/** Event channel (input report 3 on the HFX: key bitmaps, RT mode, touch panel). Input only. */
export const asusEventChannel = (usagePage: number = 0xffc0): HidChannel => ({
  role: "event",
  usagePage,
  usage: GEARLINK_USAGE,
  reportId: 3,
  length: ASUS_REPORT_LENGTH - 1,
  direction: "input",
  note: "Carries key-press bitmaps (0x71), i.e. what is typed. SYNQ does not need it; the bridge should not forward it.",
});

/**
 * Firmware-update identities. Sources: Gear Link ota/main.js `bootloader_pid` fields (mice-big2 notes)
 * and every manifest with hidPattern 3 (an updater/alternate PID with no settings UI of its own).
 * SYNQ never lists, opens or writes to these. src/lib/bootloader-ids.ts carries the OTA list too.
 */
export const ASUS_OTA_BOOTLOADER_PIDS: readonly number[] = [0x1948, 0x194a, 0x1aaf, 0x1acf, 0x1ad1, 0x1c11, 0x1c6a, 0x1c7e, 0x1cad, 0x1d4d, 0x1d69, 0x1d6d];
export const ASUS_BOOTLOADER_PIDS: ReadonlySet<number> = new Set([
  ...ASUS_OTA_BOOTLOADER_PIDS,
  ...GEARLINK_DEVICES.filter((d) => d.hidPattern === 3).map((d) => d.pid),
]);

export type AsusFamily =
  /** Falchion Ace HFX generation, Gear Link legacy class `Wn` (0.1 mm, u8 RT fields). */
  | "kb-hfx"
  /** Newer magnetic boards, Gear Link base class `j` (0.01 mm, u16 RT fields, 51 5A/5B/5C global RT). */
  | "kb-he"
  /** Mechanical Gear Link keyboards (Azoth, Strix Scope II, Morph 96, ProArt KD300). */
  | "kb-mech"
  | "mouse"
  | "receiver";

const HFX_PRODUCTS = new Set(["m605", "m606"]);
const HE_PRODUCTS = new Set(["m901", "m703", "m705", "r701", "r702", "r704"]);

/**
 * Gear Link SDK `LegacyModel` list (PIDs it runs in "Legacy Mode": no setting is read back, the UI
 * shows its own stored copy). Source: Gear Link SDK chunk, `z=[6975,6978,7038,7453,7204,7205,7493,7495,7586,7588]`.
 */
export const GEARLINK_LEGACY_MODE_PIDS: ReadonlySet<number> = new Set([6975, 6978, 7038, 7453, 7204, 7205, 7493, 7495, 7586, 7588]);

export interface AsusAnalogSpec {
  unitMm: number;
  actuation: MmRange;
  rapidTrigger: MmRange;
  deadZone: MmRange;
  defaults: { actuation: number; rtPress: number; rtRelease: number; dzTop: number; dzBottom: number };
}

export interface AsusModel {
  pid: number;
  name: string;
  productNumber: string;
  kind: "mouse" | "keyboard" | "receiver";
  family: AsusFamily;
  /** Gear Link reads nothing back from this model (legacy mode). */
  legacyMode: boolean;
  connection: "usb" | "rf" | null;
  analog: AsusAnalogSpec | null;
  /** SYNQ's tier for this model. Only the HFX ZywOo has been driven on hardware (by keyboard.ts). */
  tier: SupportTier;
  manifest: GearLinkDevice;
  sources: readonly string[];
}

/** The ZywOo manifest omits isMagneticAxis/magKeyUnit; it is the HFX with a different PID (same SDK class `Wn`). */
const HFX_FALLBACK = GEARLINK_DEVICES.find((d) => d.pid === 0x1b7e)?.analog ?? null;

function analogOf(d: GearLinkDevice, family: AsusFamily): AsusAnalogSpec | null {
  if (family !== "kb-hfx" && family !== "kb-he") return null;
  const a = d.analog ?? (family === "kb-hfx" ? HFX_FALLBACK : null);
  if (!a || !a.actuation || !a.rapidTrigger || !a.deadZone) return null;
  // Gear Link's dead-zone slider moves in 0.1 mm even on 0.01 mm boards (`Math.round(mm*10)/10*100`).
  const step = a.unitMm;
  return {
    unitMm: a.unitMm,
    actuation: { min: a.actuation[0], max: a.actuation[1], step },
    rapidTrigger: { min: a.rapidTrigger[0], max: a.rapidTrigger[1], step },
    deadZone: { min: a.deadZone[0], max: a.deadZone[1], step: 0.1 },
    defaults: {
      actuation: a.defaults.actuation ?? 1,
      rtPress: a.defaults.rtPress ?? 0.2,
      rtRelease: a.defaults.rtRelease ?? 0.2,
      dzTop: a.defaults.dzTop ?? 0.2,
      dzBottom: a.defaults.dzBottom ?? 0.2,
    },
  };
}

function familyOf(d: GearLinkDevice): AsusFamily | null {
  if (d.hidPattern === 3 || ASUS_BOOTLOADER_PIDS.has(d.pid)) return null;
  if (d.kind === "mouse") return "mouse";
  if (d.kind === "receiver") return "receiver";
  if (d.kind !== "keyboard") return null;
  if (HFX_PRODUCTS.has(d.productNumber)) return "kb-hfx";
  if (HE_PRODUCTS.has(d.productNumber)) return "kb-he";
  return "kb-mech";
}

const MANIFEST_URL = (pid: number) => `https://gearlink.asus.com/view/${pid}/manifest.json (snapshot ${GEARLINK_SNAPSHOT})`;

function build(): Map<number, AsusModel> {
  const out = new Map<number, AsusModel>();
  for (const d of GEARLINK_DEVICES) {
    const family = familyOf(d);
    if (!family) continue;
    out.set(d.pid, {
      pid: d.pid,
      name: d.name,
      productNumber: d.productNumber,
      kind: d.kind as AsusModel["kind"],
      family,
      legacyMode: GEARLINK_LEGACY_MODE_PIDS.has(d.pid),
      connection: d.connection,
      analog: analogOf(d, family),
      // keyboard.ts drives 0x1D1D on hardware; this driver is new code for every model.
      tier: family === "kb-mech" || family === "receiver" ? "readOnly" : "experimental",
      manifest: d,
      sources: [MANIFEST_URL(d.pid), "Gear Link SDK chunk (view/<pid>/chunk-*.js): makeCommand(cmd, sub, arg16, payload)"],
    });
  }
  return out;
}

export const ASUS_MODELS: ReadonlyMap<number, AsusModel> = build();

/** The model for a PID, or null (unknown ASUS device, bootloader, headset, gamepad, dock). */
export function asusModel(productId: number): AsusModel | null {
  return ASUS_MODELS.get(productId) ?? null;
}

export const isAsusBootloader = (vendorId: number, productId: number): boolean => vendorId === ASUS_VID && ASUS_BOOTLOADER_PIDS.has(productId);

/** PIDs per family, for the bridge allowance and the tests. */
export const asusPids = (family: AsusFamily): number[] => [...ASUS_MODELS.values()].filter((m) => m.family === family).map((m) => m.pid);

/**
 * Picks the control collection the way Gear Link does: usage 1 on a control page. Returns null when
 * the device shows none (then nothing is opened).
 */
export function pickControlPage(collections: readonly { usagePage?: number; usage?: number }[]): number | null {
  for (const page of GEARLINK_CONTROL_PAGES) if (collections.some((c) => c.usagePage === page && c.usage === GEARLINK_USAGE)) return page;
  return null;
}


/** Keyboards per family, by the control page Gear Link's device class uses (notes D). */
export const ASUS_CONTROL_PAGE: Readonly<Record<AsusFamily, number>> = {
  "kb-hfx": 0xff00,
  "kb-he": 0xff00,
  "kb-mech": 0xff00,
  mouse: 0xff01,
  receiver: 0xff02,
};

/**
 * Usage pages SYNQ must never open on ASUS devices: the Airoha RACE firmware channel (Feature 0x14
 * on 0xFF13) and its siblings 0xFF14 / 0xFF15 (Gladius IV Ace, Harpe II Ace Mini, Gladius IV Ace Max
 * flash in place there, with no bootloader PID), plus the generic keyboard / mouse collections.
 */
export const ASUS_FORBIDDEN_PAGES: readonly number[] = [0xff13, 0xff14, 0xff15, 0x0001, 0x0007];

// ---------------------------------------------------------------------------------------------
// Keyboard model classes (Gear Link SDK class per productNumber, notes A0-A8)
// ---------------------------------------------------------------------------------------------

/**
 * Guard family. The magnetic boards share the base `j` encoders but differ in what their pages send:
 *   hfx    M605/M606 legacy class: u8 RT fields, 0.1 mm, no read-back (Legacy Mode)
 *   he-v1  M901 Azoth 96 HE, M703 Falcata, M705 Falchion Ace 75 HE: 25 0x getters
 *   he-v2  R701 TX75 Analog, R702 TX75 Core, R704 K4 Magnetic: 25 Ax getters
 */
export type AsusKbClass = "hfx" | "he-v1" | "he-v2" | "mech";

export interface AsusKeyboardTraits {
  cls: AsusKbClass;
  /** Polling through `51 31` (index 0..3 = 1/2/4/8 kHz). Azoth 96 HE and Falcata use the 80 2x mode system instead (not driven). */
  polling51: boolean;
  /** RT mode on/off is `51 5C` (Azoth 96 HE); elsewhere it is a key on the board. */
  rtEnableCommand: boolean;
  /** Approximate form factor, used only to pick which key positions to show. */
  form: "65" | "75" | "75-split" | "96" | "full";
  /** Knob/lever index Gear Link uses for `71 01` (not driven). */
  leverIndex: number | null;
}

const KB_TRAITS: Readonly<Record<string, AsusKeyboardTraits>> = {
  m605: { cls: "hfx", polling51: true, rtEnableCommand: false, form: "65", leverIndex: 4 },
  m606: { cls: "hfx", polling51: true, rtEnableCommand: false, form: "65", leverIndex: 4 },
  m901: { cls: "he-v1", polling51: false, rtEnableCommand: true, form: "96", leverIndex: 9 },
  m703: { cls: "he-v1", polling51: false, rtEnableCommand: false, form: "75-split", leverIndex: 5 },
  m705: { cls: "he-v1", polling51: true, rtEnableCommand: false, form: "75", leverIndex: 3 },
  r701: { cls: "he-v2", polling51: true, rtEnableCommand: false, form: "75", leverIndex: 5 },
  r702: { cls: "he-v2", polling51: true, rtEnableCommand: false, form: "75", leverIndex: 5 },
  r704: { cls: "he-v2", polling51: true, rtEnableCommand: false, form: "full", leverIndex: 5 },
};

export function asusKeyboardTraits(m: AsusModel): AsusKeyboardTraits {
  return KB_TRAITS[m.productNumber] ?? { cls: "mech", polling51: false, rtEnableCommand: false, form: "full", leverIndex: null };
}

/** The guard family string for a model (what rules.ts matches on). */
export function asusGuardFamily(m: AsusModel): string {
  if (m.kind === "mouse") return "mouse";
  if (m.kind === "receiver") return "receiver";
  return asusKeyboardTraits(m).cls;
}

/** Polling rates by 51 31 index on keyboards (HFX capture; every Gear Link keyboard bundle). */
export const ASUS_KB_POLLING_HZ = [1000, 2000, 4000, 8000] as const;

export function asusKeyboardFeatures(m: AsusModel): KeyboardFeatures {
  const a = m.analog;
  const t = asusKeyboardTraits(m);
  const readBack = t.cls === "he-v1" || t.cls === "he-v2" ? "device" : "none";
  return {
    unitMm: a?.unitMm ?? null,
    actuation: a ? { range: a.actuation, perKey: true, readBack } : undefined,
    rapidTrigger: a ? { range: a.rapidTrigger, perKey: true, separatePressRelease: true, continuous: true, readBack } : undefined,
    deadZones: a ? { top: a.deadZone, bottom: a.deadZone, perKey: true, readBack } : undefined,
    socd: a ? { name: "Speed Tap", maxPairs: 5, modes: ["firmware default"], readBack: t.cls === "hfx" ? "none" : "device" } : undefined,
    remap: { layers: ["base", "fn"], readBack: t.cls === "hfx" ? "none" : "device" },
    lighting: { effects: ["static", "breathing", "colorCycle", "reactive", "starryNight", "current", "raindrop"], brightness: true, readBack: "none" },
    polling: t.polling51 ? { hz: ASUS_KB_POLLING_HZ, readBack: t.cls === "hfx" ? "none" : "device", reconnects: true } : undefined,
    profiles: { count: 6, save: "explicit", readBack: "device" },
  };
}

// ---------------------------------------------------------------------------------------------
// Mouse model groups (Gear Link mouse page capability table `nC`, notes B1)
// ---------------------------------------------------------------------------------------------

export interface AsusMouseTraits {
  group: 1 | 2 | 3 | 4 | 5 | 6 | 0;
  maxDpi: number;
  /** DPI wire value = floor(dpi / base) - 1. */
  dpiBase: 1 | 50;
  stages: number;
  splitXY: boolean;
  angleSnap: boolean;
  motionSync: boolean;
  /** Gear Link's "button response" (51 31 index 5). */
  debounce: boolean;
  pollingHz: readonly number[];
}

const MOUSE_GROUP: Readonly<Record<string, AsusMouseTraits["group"]>> = {
  p523: 1, p524: 1, md301: 2,
  p713: 3, p714: 3, p716: 3, p718: 3, p722: 3, p727: 3,
  p723: 4, p731: 4,
  p724: 5, p725: 5, p726: 5, p729: 5, p730: 5,
  p728: 6,
};
const BASE_1 = new Set(["p724", "p725", "p726", "p728", "p729", "p730"]);
const HZ_8K = [125, 250, 500, 1000, 2000, 4000, 8000] as const;
const HZ_1K = [125, 250, 500, 1000] as const;

export function asusMouseTraits(m: AsusModel): AsusMouseTraits {
  const group = MOUSE_GROUP[m.productNumber] ?? 0;
  const g = group;
  return {
    group,
    maxDpi: g === 1 ? 12000 : g === 2 ? 8000 : g === 3 || g === 4 ? 42000 : g === 5 || g === 6 ? 65000 : 26000,
    dpiBase: BASE_1.has(m.productNumber) ? 1 : 50,
    stages: g === 2 ? 3 : 4,
    splitXY: g >= 3,
    angleSnap: g !== 2,
    motionSync: g >= 4,
    debounce: g === 2 || g === 5,
    pollingHz: g === 1 || g === 2 || g === 6 ? HZ_1K : HZ_8K,
  };
}

export function asusMouseFeatures(m: AsusModel): MouseFeatures {
  const t = asusMouseTraits(m);
  return {
    dpi: { min: t.dpiBase === 1 ? 100 : 100, max: t.maxDpi, step: t.dpiBase, stages: t.stages, separateXY: t.splitXY, readBack: "device" },
    polling: { hz: t.pollingHz, readBack: "device" },
    liftOff: { values: [0, 1, 2], labels: { 0: "Low", 1: "Mid", 2: "High" }, asymmetric: false, readBack: "device" },
    motionSync: t.motionSync ? { readBack: "device" } : undefined,
    angleSnap: t.angleSnap ? { readBack: "device" } : undefined,
    debounceMs: t.debounce ? { values: [4, 8, 12, 16, 20, 24, 28, 32], readBack: "device" } : undefined,
    battery: m.manifest.flags.hasPowerInfo ? { readBack: "device" } : undefined,
    profiles: { count: 5, readBack: "device" },
  };
}
