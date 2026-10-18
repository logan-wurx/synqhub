// Razer device table for SYNQ's Razer protocol layer: Huntsman analog / Hall-effect keyboards and the
// Razer mice driven by SYNQ's own Razer code (the others use OpenMouse's driver library, @openmouse/protocol).
//
// Sources (read 2026-10-13, nothing executed, no device attached):
//   [SW]  Razer Synapse Web, https://synapse.razer.com : /AvailableDevices.json (product list, decimal ids)
//         and each /products/<pid>/static/js/main.<hash>.js bundle (per-product device config object
//         `{productId, vendorId:5426, claimInterface:3, OBMSpecs.supportedFeature, actuationInfo, ...}`).
//         Vendor JS: documentation only, no code copied.
//   [OR]  openrazer driver/razerkbd_driver.{c,h} (SPDX GPL-2.0-or-later): PIDs of the analog boards that
//         Synapse Web does not list, and their report interface (index 3) and transaction id (0xFF).
//   [OM]  @openmouse/protocol 0.41.0 razer/devices.js (AGPL-3.0-or-later): what OpenMouse already drives,
//         so this table only adds mice it lacks.
//
// Transaction ids. Synapse Web drives every product below with its rzDevice25 class, whose
// `_getTransactionId()` is a rolling counter 0..30 (it resets when it reaches 31) and whose reply check
// only requires the device to echo it ([SW] all bundles, class rzDevice25). So for these PIDs the
// transaction id is a sequence number, not a per-model constant: SYNQ follows Synapse Web ("rolling").
// openrazer's fixed ids are kept as the fallback for the boards Synapse Web doesn't list ([OR]: 0xFF for
// Huntsman V2 Analog / Mini Analog / V3 Pro family). The OpenMouse mice keep OpenMouse's own per-PID ids.

import type { Channel, DeviceEntry, Source, SupportTier } from "../local-kb.ts";

export const RAZER_VID = 0x1532;

/**
 * The control collection. Synapse Web's WebRzDevice filters `{vendorId, productId, usagePage}` with
 * usagePage defaulting to 12 (Consumer) when the product config names none (all keyboards here), then
 * picks the HIDDevice whose single top-level collection is on that page and has feature reports. The
 * mice name it explicitly: `filters:[{usagePage:12, usage:1}]` ([SW] 45061, Viper V4 HyperSpeed).
 * Transport: SET_FEATURE / GET_FEATURE report id 0, 90 data bytes (91 with the id). Never input or
 * output reports: the input reports Synapse reads come from a *different* collection (hardware events,
 * ADC notifications) that SYNQ doesn't open.
 */
export const RAZER_CONTROL: Channel = { usagePage: 0x000c, usage: 0x0001, transport: "feature", reportId: 0, length: 90 };

export type TxPolicy = { kind: "rolling"; wrapAt: 31 } | { kind: "fixed"; id: number };
export const ROLLING: TxPolicy = { kind: "rolling", wrapAt: 31 };

/** Raw actuation units: Synapse's slider unit is 1638 raw = 0.1 mm, so 16380 raw = 1 mm. [SW actuationInfo, convertUIRapidTriggerToFW = 16380 * mm] */
export const RAW_PER_MM = 16380;
export const RAW_STEP = 1638;

export interface RazerKeyboardFeatures {
  actuation: true;
  rapidTrigger: true;
  /** Global snap tap: up to 4 key pairs with a mode each (class 2 id 0x27). */
  snapTap: boolean;
  /** Single-key snap tap (class 2 id 0x2C). */
  singleKeySnapTap: boolean;
  /** Dual keypress priority (class 2 id 0x31). */
  dualKeypressPriority: boolean;
  /** 8 kHz-capable polling command (class 0 id 0x40/0xC0). */
  highSpeedPolling: boolean;
  bottomDeadZone: boolean;
  modTap: boolean;
  /** "Kill Switch (Old Snap Tap)" (class 2 id 0x21). Listed for completeness; SYNQ doesn't write it. */
  killSwitch: boolean;
}

export interface RazerKeyboardModel {
  pid: number;
  /** Synapse Web product id (decimal), or null when the board is desktop-Synapse only. */
  synapseId: number | null;
  model: string;
  form: "full" | "tkl" | "75" | "65" | "60";
  magnetic: boolean;
  tier: SupportTier;
  tx: TxPolicy;
  features: RazerKeyboardFeatures;
  /** Raw 16-bit actuation range: min 1638 (0.1 mm), max per model (65520 = 4.0 mm; low-profile 45864 = 2.8 mm). */
  actuation: { minRaw: number; maxRaw: number; defaultRaw: number };
  /** Bottom dead-zone levels [SW `bottomDeadZoneConfig`, default {responsive:3, medium:5, stable:8}]. */
  bottomDeadZone: { responsive: number; medium: number; stable: number } | null;
  /** Onboard profile slots [SW OBMSlots]. */
  profiles: number;
  polling: readonly number[];
  sources: readonly Source[];
  notes?: string;
}

const SW = (pid: number): Source => ({ kind: "configurator-js", ref: `https://synapse.razer.com/products/${pid}/ (device config)` });
const OR: Source = { kind: "open-source", ref: "https://github.com/openrazer/openrazer driver/razerkbd_driver.h", license: "GPL-2.0-or-later" };

const DZ_DEFAULT = { responsive: 3, medium: 5, stable: 8 } as const;
const HZ_8K = [125, 250, 500, 1000, 2000, 4000, 8000] as const;
const HZ_1K = [1000] as const;

const FULL_8K: RazerKeyboardFeatures = {
  actuation: true,
  rapidTrigger: true,
  snapTap: true,
  singleKeySnapTap: true,
  dualKeypressPriority: true,
  highSpeedPolling: true,
  bottomDeadZone: true,
  modTap: false,
  killSwitch: false,
};

function kb(m: Omit<RazerKeyboardModel, "tx" | "profiles"> & Partial<Pick<RazerKeyboardModel, "tx" | "profiles">>): RazerKeyboardModel {
  return { tx: ROLLING, profiles: 5, ...m };
}

/**
 * Keyboards. Feature flags are the union of the `OBMSpecs.supportedFeature` objects in each product's
 * own Synapse Web bundle (several config copies per bundle; a feature counts when any copy has it).
 */
export const RAZER_KEYBOARDS: readonly RazerKeyboardModel[] = [
  kb({
    pid: 0x02ea, synapseId: 746, model: "Huntsman V3 HE Magnetic TKL 8KHz", form: "tkl", magnetic: true, tier: "experimental",
    features: FULL_8K, actuation: { minRaw: 1638, maxRaw: 65520, defaultRaw: 19656 }, bottomDeadZone: DZ_DEFAULT, polling: HZ_8K, sources: [SW(746)],
  }),
  kb({
    pid: 0x02e4, synapseId: 740, model: "Huntsman V3 HE Magnetic Mini 65% 8KHz", form: "65", magnetic: true, tier: "experimental",
    features: { ...FULL_8K, modTap: true, killSwitch: true }, actuation: { minRaw: 1638, maxRaw: 65520, defaultRaw: 19656 }, bottomDeadZone: DZ_DEFAULT, polling: HZ_8K, sources: [SW(740)],
  }),
  kb({
    pid: 0x02cf, synapseId: 719, model: "Huntsman V3 Pro 8KHz", form: "full", magnetic: false, tier: "experimental",
    features: FULL_8K, actuation: { minRaw: 1638, maxRaw: 65520, defaultRaw: 19656 }, bottomDeadZone: DZ_DEFAULT, polling: HZ_8K, sources: [SW(719), OR],
    notes: "One config copy says max 65535 / default 39312; SYNQ caps at 65520 (4.0 mm) like the rest of the family.",
  }),
  kb({
    pid: 0x02d0, synapseId: 720, model: "Huntsman V3 Pro TKL 8KHz", form: "tkl", magnetic: false, tier: "experimental",
    features: FULL_8K, actuation: { minRaw: 1638, maxRaw: 65520, defaultRaw: 19656 }, bottomDeadZone: DZ_DEFAULT, polling: HZ_8K, sources: [SW(720)],
  }),
  kb({
    pid: 0x02d1, synapseId: 721, model: "Huntsman V3 Pro Mini 8KHz", form: "60", magnetic: false, tier: "experimental",
    features: { ...FULL_8K, modTap: true, killSwitch: true }, actuation: { minRaw: 1638, maxRaw: 65520, defaultRaw: 19656 }, bottomDeadZone: DZ_DEFAULT, polling: HZ_8K, sources: [SW(721)],
  }),
  kb({
    pid: 0x02d8, synapseId: 728, model: "Huntsman Signature Edition", form: "full", magnetic: false, tier: "experimental",
    features: { ...FULL_8K, killSwitch: true }, actuation: { minRaw: 1638, maxRaw: 65520, defaultRaw: 19656 }, bottomDeadZone: DZ_DEFAULT, polling: HZ_8K, sources: [SW(728)],
  }),
  kb({
    pid: 0x02e5, synapseId: 741, model: "Huntsman V3 TKL 8KHz", form: "tkl", magnetic: false, tier: "experimental",
    features: FULL_8K, actuation: { minRaw: 1638, maxRaw: 65520, defaultRaw: 19656 }, bottomDeadZone: DZ_DEFAULT, polling: HZ_8K, sources: [SW(741)],
    notes: "Earlier notes called this board non-analog; its Synapse Web config has analogKeyboardV3, snap tap and actuationInfo.",
  }),
  kb({
    pid: 0x02e6, synapseId: 742, model: "Huntsman V3 Pro Low-profile TKL 8KHz", form: "tkl", magnetic: false, tier: "experimental",
    features: FULL_8K, actuation: { minRaw: 1638, maxRaw: 45864, defaultRaw: 19656 }, bottomDeadZone: { responsive: 10, medium: 12, stable: 14 }, polling: HZ_8K, sources: [SW(742)],
    notes: "Low-profile switches: 2.8 mm travel (actuationInfo.max 45864).",
  }),
  kb({
    pid: 0x02b0, synapseId: 688, model: "Huntsman V3 Pro Mini", form: "60", magnetic: false, tier: "experimental",
    features: { ...FULL_8K, snapTap: false, singleKeySnapTap: false, dualKeypressPriority: false, highSpeedPolling: false, bottomDeadZone: false, modTap: true, killSwitch: true },
    actuation: { minRaw: 1638, maxRaw: 65520, defaultRaw: 19656 }, bottomDeadZone: null, polling: HZ_1K, sources: [SW(688), OR],
    notes: "No polling setting in Synapse Web (`pollingRate: false`).",
  }),
  // Desktop-Synapse only: same analogKeyboardV3 generation per openrazer (report index 3), but no web
  // bundle to confirm the command set or the collection. Reads only until an developer's diagnostics agree.
  kb({
    pid: 0x02a6, synapseId: null, model: "Huntsman V3 Pro", form: "full", magnetic: false, tier: "readOnly", tx: ROLLING,
    features: { ...FULL_8K, singleKeySnapTap: false, dualKeypressPriority: false, highSpeedPolling: false },
    actuation: { minRaw: 1638, maxRaw: 65520, defaultRaw: 19656 }, bottomDeadZone: null, polling: HZ_1K, sources: [OR],
    notes: "Not in Synapse Web. Collection and command support unconfirmed: identification and reads only.",
  }),
  kb({
    pid: 0x02a7, synapseId: null, model: "Huntsman V3 Pro TKL", form: "tkl", magnetic: false, tier: "readOnly", tx: ROLLING,
    features: { ...FULL_8K, singleKeySnapTap: false, dualKeypressPriority: false, highSpeedPolling: false },
    actuation: { minRaw: 1638, maxRaw: 65520, defaultRaw: 19656 }, bottomDeadZone: null, polling: HZ_1K, sources: [OR],
    notes: "Not in Synapse Web. Collection and command support unconfirmed: identification and reads only.",
  }),
];

/** Older analog generation (partial analog key set, different analog key ids): recognised, not driven. */
export const RAZER_DETECT_ONLY: readonly { pid: number; model: string; why: string }[] = [
  { pid: 0x0266, model: "Huntsman V2 Analog", why: "Older analog generation (desktop Synapse 3 only); command set not documented in any web bundle." },
  { pid: 0x0282, model: "Huntsman Mini Analog", why: "Older analog generation (desktop Synapse 3 only); command set not documented in any web bundle." },
  { pid: 0xb006, model: "Viper V4 HyperSpeed (Bluetooth)", why: "Bluetooth HID path; Razer's control reports are only documented over USB / the HyperSpeed dongle." },
  { pid: 0xb008, model: "DeathAdder V4 HyperSpeed (Bluetooth)", why: "Bluetooth HID path; Razer's control reports are only documented over USB / the HyperSpeed dongle." },
];

export interface RazerMouseModel {
  pid: number;
  synapseId: number;
  model: string;
  /** The dongle uses the same PID as the cable ([SW] `dongleId === productId`). */
  connection: "usb-or-dongle";
  tier: SupportTier;
  tx: TxPolicy;
  dpi: { min: number; max: number; step: number; stages: number };
  polling: readonly number[];
  /** Smart-tracking lift setting: symmetric "universal lift cut-off" levels; asymmetric not offered. */
  lod: { levels: readonly number[] } | null;
  battery: boolean;
  sources: readonly Source[];
  notes?: string;
}

/**
 * The newest Razer mice, driven by SYNQ's own Razer code: Synapse Web's AvailableDevices.json lists five mice; the
 * Viper V4 Pro (0x00E5/E6), DeathAdder V4 Pro (0x00BE/BF) and its Carbon Fiber edition (0x00EF/F0) use
 * OpenMouse's driver library. These two are a new PID range (0xB0xx) on VID 0x1532.
 */
export const RAZER_MICE: readonly RazerMouseModel[] = [
  {
    pid: 0xb005, synapseId: 45061, model: "Viper V4 HyperSpeed", connection: "usb-or-dongle", tier: "experimental", tx: ROLLING,
    dpi: { min: 100, max: 33000, step: 1, stages: 5 }, polling: [125, 500, 1000, 2000, 4000, 8000], lod: { levels: [1, 2, 3] }, battery: true,
    sources: [SW(45061)],
    notes: "maxDPI 33000 / dpiStep 1 [SW]. LOD levels 1..3 are an assumption (Synapse default trackingDistance 2); the slider bounds live in a UI bundle not read.",
  },
  {
    pid: 0xb007, synapseId: 45063, model: "DeathAdder V4 HyperSpeed", connection: "usb-or-dongle", tier: "experimental", tx: ROLLING,
    dpi: { min: 100, max: 33000, step: 1, stages: 5 }, polling: [125, 500, 1000, 2000, 4000, 8000], lod: { levels: [1, 2, 3] }, battery: true,
    sources: [SW(45063)],
    notes: "Bundle has two configs: maxDPI 33000/step 1 and 50000/step 50. SYNQ uses the lower ceiling until a read-back shows more.",
  },
];

export const findRazerKeyboard = (pid: number): RazerKeyboardModel | undefined => RAZER_KEYBOARDS.find((m) => m.pid === pid);
export const findRazerMouse = (pid: number): RazerMouseModel | undefined => RAZER_MICE.find((m) => m.pid === pid);

/** Every PID this layer opens, for the bridge's feature-only rule (keyboards + mice; not detect-only ones). */
export const RAZER_FEATURE_ONLY_PIDS: readonly number[] = [...RAZER_KEYBOARDS.map((m) => m.pid), ...RAZER_MICE.map((m) => m.pid)].sort((a, b) => a - b);

export const RAZER_DEVICES: readonly DeviceEntry[] = [
  ...RAZER_KEYBOARDS.map(
    (m): DeviceEntry => ({ vendor: "Razer", vendorId: RAZER_VID, productId: m.pid, model: m.model, kind: "keyboard", connection: "usb", channel: RAZER_CONTROL, tier: m.tier, sources: m.sources, notes: m.notes }),
  ),
  ...RAZER_MICE.map(
    (m): DeviceEntry => ({ vendor: "Razer", vendorId: RAZER_VID, productId: m.pid, model: m.model, kind: "mouse", connection: "receiver", channel: RAZER_CONTROL, tier: m.tier, sources: m.sources, notes: m.notes }),
  ),
];

/**
 * Firmware key ids ("fwID": Razer's key-position numbering) for the keys the analog commands address.
 * [SW] module `InputIDToMapping_Keyboard_Generic.NormalMode`. On these boards (`isFWAnalogMapping`) the
 * analog commands (actuation, rapid trigger, snap tap, dual keypress priority) use the same ids; 255 =
 * "every key" in the actuation / rapid-trigger writes.
 */
export const RAZER_KEY_IDS: Readonly<Record<string, number>> = {
  TILDE: 1, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11, MINUS: 12, EQUAL: 13, YEN: 14, BACKSPACE: 15,
  TAB: 16, Q: 17, W: 18, E: 19, R: 20, T: 21, Y: 22, U: 23, I: 24, O: 25, P: 26, LBRACKET: 27, RBRACKET: 28, BACKSLASH: 29,
  CAPS_LOCK: 30, A: 31, S: 32, D: 33, F: 34, G: 35, H: 36, J: 37, K: 38, L: 39, SEMICOLON: 40, APOSTROPHE: 41, NON_US_POUND: 42, ENTER: 43,
  LSHIFT: 44, NON_US_BACKSLASH: 45, Z: 46, X: 47, C: 48, V: 49, B: 50, N: 51, M: 52, COMMA: 53, PERIOD: 54, SLASH: 55, RO: 56, RSHIFT: 57,
  LCTRL: 58, RGUI: 59, LALT: 60, SPACE: 61, RALT: 62, RCTRL: 64,
  INSERT: 75, DELETE: 76, LEFT: 79, HOME: 80, END: 81, UP: 83, DOWN: 84, PAGE_UP: 85, PAGE_DOWN: 86, RIGHT: 89,
  NUM_LOCK: 90, KP_7: 91, KP_4: 92, KP_1: 93, KP_SLASH: 95, KP_8: 96, KP_5: 97, KP_2: 98, KP_0: 99, KP_ASTERISK: 100, KP_9: 101, KP_6: 102, KP_3: 103,
  KP_PERIOD: 104, KP_MINUS: 105, KP_PLUS: 106, KP_EQUAL: 107, KP_ENTER: 108,
  ESC: 110, F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
  PRINT_SCREEN: 124, SCROLL_LOCK: 125, PAUSE: 126, LGUI: 127, MENU: 129,
};
export const RAZER_ALL_KEYS = 255;
export const RAZER_VALID_KEY_IDS: ReadonlySet<number> = new Set(Object.values(RAZER_KEY_IDS));
