// SteelSeries Apex keyboards (VID 0x1038): USB identities, firmware lines, per-model capabilities and where each
// fact came from. Nothing here talks to a device. Erasable TypeScript only (node runs scripts/ directly).
//
// Sources (paths are relative to the Wave 4 scratch folder wave4-src/steelseries/, see
// docs/devices/desktop-only/steelseries.md for the full list and the evidence per command):
//   [gg-sql]   SteelSeries GG 121.0.0 installer, apps/engine/db/migrations/**.sql (plain text): the engine's
//              `devices` rows (product_id = VID << 16 | PID, GG name, default settings JSON) and `physical_devices`
//              rows (USB identity -> bootloader product id). Read as data.
//   [gg-fw]    apps/engine/firmware/<VID<<16|PID>/version.json: firmware line per model.
//   [gg-ui]    resources/app.asar -> render/463.js: the device pages (actuation maps, release-mode meaning,
//              rapid-trigger sensitivity map). Read as data; tables are in tables.ts.
//   [zunuza]   github.com/zunuza/apex-control (MIT) docs/PROTOCOL_NOTES.md: USB captures of GG on an Apex Pro TKL
//              (2019, 1038:1614, fw 4.16.8), hardware-tested.
//   [rikearon] github.com/Rikearon/apex-control (MIT; docs/PROTOCOL.md CC BY 4.0): Apex Pro TKL Gen 3 wired
//              (1038:1642, fw 1.19.7), hardware-tested where it says so.
//   [opengg]   github.com/GUHPY/OpenGG docs/protocol.md (non-commercial licence: facts only, no code): Apex Pro TKL
//              Wireless Gen 3 receiver 1038:1644 and USB 1038:1646, fw 3.24.1, hardware-tested.
//   [openrgb]  OpenRGB Controllers/SteelSeriesController (GPL-2.0-or-later: learned from, not copied).
//
// The device's own HID-command builders live in GG's per-device descriptor files (deviceSpecifications/*.edevice),
// which ship OpenPGP-encrypted. They were NOT decrypted; every byte layout here comes from the open-source projects
// above, cross-checked against GG's plain-text data where GG has any.

import type { BridgeAllowance, Channel, DeviceEntry, KeyboardCaps, Source } from "../local-kb.ts";
import type { GgTableId } from "./tables.ts";

export const STEELSERIES_VID = 0x1038;

/** The configuration collection on every Apex that GG configures. [zunuza mi_01][rikearon][opengg][openrgb IPU 0xFFC0] */
export const SS_USAGE_PAGE = 0xffc0;
export const SS_USAGE = 0x0001;
/** No report ids on this collection: WebHID report id 0. [zunuza wValue 0x0300/0x0200][rikearon][opengg] */
export const SS_REPORT_ID = 0;
/** Output and input reports carry 64 data bytes. [zunuza][rikearon][opengg 65 with id] */
export const SS_OUTPUT_LENGTH = 64;

/**
 * Firmware lines, from GG's firmware folder (version.json) [gg-fw]:
 *   legacy   "4.16.8/4.16.8" (keyboard-app + lighting-app MCUs): Apex Pro / TKL 2019, Apex Pro 2024 full size, Apex 7.
 *            Apex 5 (2.x) shares the lighting command set per [openrgb].
 *   single   "1.19.x" / "1.20.00": Apex Pro TKL 2023 + 2024, Cyber, Steel, Apex Pro Mini + Mini 2024.
 *   wireless "3.24.1" (nordic + stm + dongle): the wireless TKL 2023 / 2024 and Mini Wireless. Two transports:
 *            through the receiver ("rx") and over the USB cable ("usb") use different opcodes. [opengg]
 *   other    zone-lit or OptiPoint boards: detect only.
 */
export type SsFamily = "legacy" | "single" | "wireless-rx" | "wireless-usb" | "other";

/** Feature-report data length per family (without the report id byte). */
export const FEATURE_LENGTH: Readonly<Record<Exclude<SsFamily, "other">, number>> = {
  /** wLength 642 SET_REPORT [zunuza]; 643 with id [openrgb APEX_PACKET_LENGTH] */
  legacy: 642,
  /** 644 payload [rikearon]; 645 FeatureReportByteLength incl. id (steelclock-go PR #50) */
  single: 644,
  /** 642 incl. report id on Windows [opengg] */
  "wireless-rx": 641,
  "wireless-usb": 641,
};

export function channelFor(family: SsFamily): Channel {
  const length = family === "other" ? SS_OUTPUT_LENGTH : FEATURE_LENGTH[family];
  return { usagePage: SS_USAGE_PAGE, usage: SS_USAGE, transport: "output+input", reportId: SS_REPORT_ID, length };
}

/** The 68 OmniPoint keys of the TKL / full-size boards, ascending HID usage (= wire order everywhere). [gg-sql hall_thresholds][zunuza][rikearon][opengg] */
export const ANALOG_KEYS_TKL: readonly number[] = [
  ...range(0x04, 0x28), ...range(0x2a, 0x39), 0x64, ...range(0x87, 0x8b), ...range(0xe0, 0xe7), 0xf0,
];
/** The 68 analog keys of the Mini boards (Esc in, grave out). [gg-sql apex_pro_mini hall_thresholds, gg-20.0.0/20220616103339_squash.sql:239] */
export const ANALOG_KEYS_MINI: readonly number[] = [
  ...range(0x04, 0x34), ...range(0x36, 0x39), 0x64, ...range(0x87, 0x8b), ...range(0xe0, 0xe7), 0xf0,
];

/** LED ids the legacy direct frame addresses: HID usages 0x04-0x64, ISO 0x87-0x8B, modifiers, 0xF0, 0xFB. [openrgb keys[]] */
export const LED_KEYS_LEGACY: readonly number[] = [...range(0x04, 0x64), ...range(0x87, 0x8b), ...range(0xe0, 0xe7), 0xf0, 0xfb];
/** The 86 LEDs of the Gen 3 TKL: 0x04-0x45, 0x49-0x52, 0xE0-0xE7, 0xF0, 0xFB. [rikearon "86 LEDs"] Used for the wireless TKL too. */
export const LED_KEYS_TKL: readonly number[] = [...range(0x04, 0x45), ...range(0x49, 0x52), ...range(0xe0, 0xe7), 0xf0, 0xfb];

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

const SQL = "keep/gg/apps/engine/db/migrations/";
const src = {
  sql: (file: string, line: number): Source => ({ kind: "configurator-js", ref: `[gg-sql] ${SQL}${file}:${line}` }),
  fw: (id: number): Source => ({ kind: "configurator-js", ref: `[gg-fw] keep/gg/apps/engine/firmware/${0x10380000 + id}/version.json` }),
  ui: (offset: number, what: string): Source => ({ kind: "configurator-js", ref: `[gg-ui] keep/asar/render/463.js @${offset} (${what})` }),
  zunuza: { kind: "capture", ref: "[zunuza] github.com/zunuza/apex-control@5d07f1d docs/PROTOCOL_NOTES.md (GG USB captures, 1038:1614)", license: "MIT" } as Source,
  rikearon: { kind: "open-source", ref: "[rikearon] github.com/Rikearon/apex-control@f7db8c5 docs/PROTOCOL.md (1038:1642)", license: "MIT / CC-BY-4.0 (doc)" } as Source,
  opengg: { kind: "community-doc", ref: "[opengg] github.com/GUHPY/OpenGG@1853cfb docs/protocol.md (1038:1644/1646; facts only)", license: "OpenGG Non-Commercial (not copied)" } as Source,
  openrgb: { kind: "open-source", ref: "[openrgb] CalcProgrammer1/OpenRGB@9515475 Controllers/SteelSeriesController (learned from, not copied)", license: "GPL-2.0-or-later" } as Source,
};

/** How sure a capability is. Writes are only planned for "captured" / "source-hw" / "inferred-strong" (see backend). */
export type Evidence =
  /** GG's own traffic captured on this exact PID, replayed on hardware by the capturing project. */
  | "captured"
  /** An open-source tool for this exact PID that its author ran on hardware. */
  | "source-hw"
  /** Same firmware line, same GG page module and default data as a captured model. */
  | "inferred-strong"
  /** Only an open-source project without hardware notes for this PID, or a sibling with a different table. */
  | "inferred";

export interface SsCapability {
  evidence: Evidence;
  /** One line for the panel and the doc: why we believe it. */
  why: string;
  sources: readonly Source[];
}

export interface SsModel extends DeviceEntry {
  /** GG's own name for the model (devices.name). */
  ggName: string;
  family: SsFamily;
  /** As GG ships it for this PID ([gg-fw]); null when GG has no firmware folder. */
  firmwareLine: string | null;
  /** physical_devices.bootloader_product_id; null when GG 121 lists none. Never claimed by SYNQ. */
  bootloaderPid: number | null;
  /** For a receiver (dongle): the keyboard PID GG maps it to (devices_to_physical_devices). */
  mainPid?: number;
  outputLength: number;
  /** GG's mm -> (l, h) actuation table for this model (tables.ts), when the model has OmniPoint keys. */
  table?: GgTableId;
  analogKeys?: readonly number[];
  /** Live actuation (global + per key). */
  actuation?: SsCapability;
  /** Per-key rapid trigger on/off (release mode). */
  rapidTrigger?: SsCapability;
  /** Rapid-trigger sensitivity, 0.1 .. 4.0 mm in 0.1 mm (raw = mm x 10). */
  sensitivity?: SsCapability;
  /** Per-key direct colour frame (volatile, host-driven). */
  directLighting?: SsCapability & { leds: readonly number[]; initFirst: boolean; release: boolean };
  /** Illumination brightness 0..10 with read-back. */
  brightness?: SsCapability;
  /** Select on-board profile 1..5 (the keyboard can't report which is active). */
  profiles?: SsCapability;
  /** Region / layout queries (0xF5 / 0xF2). */
  regionQuery?: SsCapability;
  /** Firmware version query (0x90). */
  firmwareQuery?: SsCapability;
  /** Connection / battery queries on the wireless line. */
  statusQuery?: SsCapability;
  features: KeyboardCaps;
}

const RT_RANGE = { min: 0.1, max: 4.0, step: 0.1 } as const;
const ACT_RANGE = { min: 0.1, max: 4.0, step: 0.1 } as const;

const cap = (evidence: Evidence, why: string, ...sources: Source[]): SsCapability => ({ evidence, why, sources });

function model(m: Omit<SsModel, "vendor" | "vendorId" | "kind" | "channel" | "outputLength" | "tier"> & { tier?: SsModel["tier"] }): SsModel {
  return {
    vendor: "SteelSeries",
    vendorId: STEELSERIES_VID,
    kind: m.connection === "receiver" ? "receiver" : "keyboard",
    channel: channelFor(m.family),
    outputLength: SS_OUTPUT_LENGTH,
    tier: m.tier ?? (m.family === "other" ? "detectOnly" : "readOnly"),
    ...m,
  };
}

const FW_LEGACY = cap("source-hw", "0x90 00 answers the ASCII firmware version (\"4.16.8\").", src.zunuza, src.openrgb);
const FW_SINGLE = cap("source-hw", "0x90 00 answers 90 00 + ASCII version (\"1.19.7\").", src.rikearon, src.openrgb);

const LEGACY_LIGHT = (evidence: Evidence, why: string) => ({ ...cap(evidence, why, src.openrgb, src.zunuza), leds: LED_KEYS_LEGACY, initFirst: false, release: true });
const LEGACY_BRIGHTNESS = cap("inferred", "0x23 <0..10> sets, 0xA3 reads A3 00 <level>; offered only when the keyboard answers the read.", src.openrgb);

export const MODELS: readonly SsModel[] = [
  // ---------------------------------------------------------------- legacy line (fw 4.16.8)
  model({
    productId: 0x1614, ggName: "apex_pro_tkl", model: "Apex Pro TKL (2019)", connection: "usb", family: "legacy", firmwareLine: "4.16.8/4.16.8",
    bootloaderPid: 0x1615, table: "apexPro2019", analogKeys: ANALOG_KEYS_TKL,
    actuation: cap("captured", "GG's live 0x31 0x47 frame captured on this PID; global and per-key replayed on hardware. Values from GG's own 40-level map.", src.zunuza, src.ui(397836, "map Wp")),
    directLighting: LEGACY_LIGHT("inferred", "0x3A direct frame [openrgb]; GG's 3a 57 04 ... RGB refresh seen in [zunuza] captures."),
    brightness: LEGACY_BRIGHTNESS,
    profiles: cap("captured", "89 <slot> selects Config 1..5 (GG traffic, hardware-tested); the active slot can't be read back.", src.zunuza),
    firmwareQuery: FW_LEGACY,
    sources: [src.sql("3.15.0/20190607095158_squash.sql", 1778), src.sql("3.15.0/20190607095158_squash.sql", 2371), src.fw(0x1614), src.zunuza, src.openrgb],
    features: { analog: { perKey: true, actuation: ACT_RANGE }, lighting: { effects: false, perKey: true, brightness: { min: 0, max: 10, step: 1 } }, profiles: 5 },
    notes: "GG default actuation 1.8 mm (l 46 / h 50 on the wire); 3.2 mm is refused (key-repeat reported on hardware by [zunuza]).",
  }),
  model({
    productId: 0x1610, ggName: "apex_pro", model: "Apex Pro (2019)", connection: "usb", family: "legacy", firmwareLine: "4.16.8/4.16.8",
    bootloaderPid: 0x1611, table: "apexPro2019", analogKeys: ANALOG_KEYS_TKL,
    actuation: cap("inferred-strong", "Same firmware (4.16.8), same GG page map (26977 Wp) and same 68-key default table as the captured TKL.", src.zunuza, src.ui(397836, "map Wp"), src.sql("3.15.0/20190607095158_squash.sql", 1369)),
    directLighting: LEGACY_LIGHT("inferred", "Same controller as the TKL in [openrgb]."),
    brightness: LEGACY_BRIGHTNESS,
    profiles: cap("inferred-strong", "Same firmware as the captured TKL.", src.zunuza),
    firmwareQuery: FW_LEGACY,
    sources: [src.sql("3.15.0/20190607095158_squash.sql", 1120), src.sql("3.15.0/20190607095158_squash.sql", 1773), src.fw(0x1610), src.openrgb],
    features: { analog: { perKey: true, actuation: ACT_RANGE }, lighting: { effects: false, perKey: true, brightness: { min: 0, max: 10, step: 1 } }, profiles: 5 },
    notes: "Full-size 2019 board. The numpad keys are not OmniPoint (not in GG's hall_thresholds list).",
  }),
  model({
    productId: 0x1640, ggName: "apex_pro_2024", model: "Apex Pro (2024, Gen 3 full size)", connection: "usb", family: "legacy", firmwareLine: "4.16.8/4.16.8",
    bootloaderPid: 0x1641, table: "apexPro2024", analogKeys: ANALOG_KEYS_TKL,
    directLighting: LEGACY_LIGHT("inferred", "[openrgb] drives 0x1640 with the legacy controller (no protocol quirk)."),
    brightness: LEGACY_BRIGHTNESS,
    firmwareQuery: FW_LEGACY,
    sources: [src.sql("gg-71.0.0/20240916111722_squash.sql", 4), src.sql("gg-71.0.0/20240916111722_squash.sql", 23), src.fw(0x1640), src.openrgb],
    features: { lighting: { effects: false, perKey: true, brightness: { min: 0, max: 10, step: 1 } } },
    notes: "Actuation not offered: GG uses a different, non-monotonic map for it (60531) and nobody has captured its frames.",
  }),
  model({
    productId: 0x1612, ggName: "apex_7", model: "Apex 7", connection: "usb", family: "legacy", firmwareLine: "4.16.8/4.16.8", bootloaderPid: 0x1613,
    directLighting: LEGACY_LIGHT("inferred", "Same controller in [openrgb]."), brightness: LEGACY_BRIGHTNESS, firmwareQuery: FW_LEGACY,
    sources: [src.sql("3.15.0/20190607095158_squash.sql", 4), src.sql("3.15.0/20190607095158_squash.sql", 587), src.fw(0x1612), src.openrgb],
    features: { lighting: { effects: false, perKey: true, brightness: { min: 0, max: 10, step: 1 } } },
  }),
  model({
    productId: 0x1618, ggName: "apex_7_tkl", model: "Apex 7 TKL", connection: "usb", family: "legacy", firmwareLine: "4.16.8/4.16.8", bootloaderPid: 0x1619,
    directLighting: LEGACY_LIGHT("inferred", "Same controller in [openrgb]."), brightness: LEGACY_BRIGHTNESS, firmwareQuery: FW_LEGACY,
    sources: [src.sql("3.15.0/20190607095158_squash.sql", 592), src.sql("3.15.0/20190607095158_squash.sql", 1115), src.fw(0x1618), src.openrgb],
    features: { lighting: { effects: false, perKey: true, brightness: { min: 0, max: 10, step: 1 } } },
  }),
  model({
    productId: 0x161c, ggName: "apex_5", model: "Apex 5", connection: "usb", family: "legacy", firmwareLine: "2.1.1/2.1.1", bootloaderPid: 0x161d,
    directLighting: LEGACY_LIGHT("inferred", "Same controller in [openrgb]."), brightness: LEGACY_BRIGHTNESS, firmwareQuery: FW_LEGACY,
    sources: [src.sql("3.17.2/20200117160341_squash.sql", 4), src.sql("3.17.2/20200117160341_squash.sql", 557), src.fw(0x161c), src.openrgb],
    features: { lighting: { effects: false, perKey: true, brightness: { min: 0, max: 10, step: 1 } } },
  }),
  model({
    productId: 0x1652, ggName: "apex_7_2024", model: "Apex 7 (2024)", connection: "usb", family: "legacy", firmwareLine: "4.16.8/4.16.8", bootloaderPid: 0x1653,
    firmwareQuery: FW_LEGACY,
    sources: [src.sql("gg-73.0.0/20241014153235_squash.sql", 12), src.sql("gg-73.0.0/20241014153235_squash.sql", 16), src.fw(0x1652)],
    features: {},
    notes: "Firmware line matches the Apex 7, but no open-source tool drives this PID: firmware version only.",
  }),
  model({
    productId: 0x1650, ggName: "apex_5_2024", model: "Apex 5 (2024)", connection: "usb", family: "legacy", firmwareLine: "2.2.3/2.2.3", bootloaderPid: 0x1651,
    firmwareQuery: FW_LEGACY,
    sources: [src.sql("gg-73.0.0/20241014153235_squash.sql", 3), src.sql("gg-73.0.0/20241014153235_squash.sql", 7), src.fw(0x1650)],
    features: {},
    notes: "No open-source tool drives this PID: firmware version only.",
  }),

  // ---------------------------------------------------------------- single-MCU line (fw 1.19.x / 1.20)
  model({
    productId: 0x1642, ggName: "apex_pro_tkl_2024", model: "Apex Pro TKL (2024, Gen 3)", connection: "usb", family: "single", firmwareLine: "1.19.7",
    bootloaderPid: 0x1643, table: "apexProTkl2024", analogKeys: ANALOG_KEYS_TKL,
    actuation: cap("source-hw", "38 61 44 00 [hid,h,l]x68; written and stored on hardware by [rikearon]; the same (l,h) pairs as GG's map for this PID.", src.rikearon, src.ui(411249, "map p")),
    rapidTrigger: cap("source-hw", "38 62 44 [hid,mode]x68, mode 0 off / 2 rapid trigger (verified); GG's page: 3 = protection, 4 = both.", src.rikearon, src.ui(412446, "release_mode 2|4")),
    sensitivity: cap("source-hw", "38 65 44 [hid,sens]x68, sens = mm x 10 (default 2).", src.rikearon, src.ui(817292, "sensitivity map")),
    directLighting: { ...cap("source-hw", "40 <n> [hid,R,G,B]xn (feature); 4B before it.", src.rikearon, src.openrgb), leds: LED_KEYS_TKL, initFirst: true, release: false },
    regionQuery: cap("source-hw", "F5 -> F5 err region, F2 -> F2 err layout.", src.rikearon),
    firmwareQuery: FW_SINGLE,
    sources: [src.sql("gg-71.0.0/20240916111722_squash.sql", 29), src.sql("gg-71.0.0/20240916111722_squash.sql", 48), src.fw(0x1642), src.rikearon, src.openrgb],
    features: { analog: { perKey: true, actuation: ACT_RANGE, rapidTrigger: { press: RT_RANGE, perKey: true } }, lighting: { effects: false, perKey: true, brightness: { min: 0, max: 0, step: 1 } } },
    notes: "Live writes go to RAM only ([rikearon]); GG's own Save rewrites the flash profile, which SYNQ never does.",
  }),
  model({
    productId: 0x1628, ggName: "apex_pro_tkl_2022", model: "Apex Pro TKL (2023)", connection: "usb", family: "single", firmwareLine: "1.19.7",
    bootloaderPid: 0x1629, table: "apexProTkl2022", analogKeys: ANALOG_KEYS_TKL,
    directLighting: { ...cap("inferred", "[openrgb] drives it with 0x40 without the 0x4B init (its 'Gen 2').", src.openrgb), leds: LED_KEYS_TKL, initFirst: false, release: false },
    firmwareQuery: FW_SINGLE,
    sources: [src.sql("gg-25.0.0/20220926100614_squash.sql", 449), src.sql("gg-25.0.0/20220926100614_squash.sql", 887), src.fw(0x1628), src.openrgb],
    features: { lighting: { effects: false, perKey: true, brightness: { min: 0, max: 0, step: 1 } } },
    notes: "Same firmware line as the 1642 but GG gives it another map (62347) and nobody has published its actuation frames: actuation is shown, not written.",
  }),
  model({
    productId: 0x1660, ggName: "apex_pro_tkl_2024_cyber", model: "Apex Pro TKL Cyber", connection: "usb", family: "single", firmwareLine: "1.20.00",
    bootloaderPid: 0x1661, table: "apexProTkl2024Cyber", analogKeys: ANALOG_KEYS_TKL, firmwareQuery: FW_SINGLE,
    sources: [src.sql("gg-117.0.0/20260811100835_squash.sql", 997), src.sql("gg-117.0.0/20260811100835_squash.sql", 5461), src.fw(0x1660)],
    features: {},
    notes: "Firmware 1.20.00 and its own GG map (44233); no capture: firmware version only.",
  }),
  model({
    productId: 0x1662, ggName: "apex_pro_tkl_2024_steel", model: "Apex Pro TKL Steel", connection: "usb", family: "single", firmwareLine: "1.20.00",
    bootloaderPid: 0x1663, table: "apexProTkl2024Steel", analogKeys: ANALOG_KEYS_TKL, firmwareQuery: FW_SINGLE,
    sources: [src.sql("gg-117.0.0/20260811100835_squash.sql", 5463), src.sql("gg-117.0.0/20260811100835_squash.sql", 9927), src.fw(0x1662)],
    features: {},
    notes: "Firmware 1.20.00 and its own GG map (22919); no capture: firmware version only.",
  }),
  model({
    productId: 0x161e, ggName: "apex_pro_mini", model: "Apex Pro Mini", connection: "usb", family: "single", firmwareLine: "1.19.7",
    bootloaderPid: null, table: "apexProMini", analogKeys: ANALOG_KEYS_MINI, firmwareQuery: FW_SINGLE,
    sources: [src.sql("gg-20.0.0/20220616103339_squash.sql", 4), src.fw(0x161e)],
    features: {},
    notes: "Different analog key set (Esc in, grave out) and GG map (96184); no capture: firmware version only.",
  }),
  model({
    productId: 0x1648, ggName: "apex_pro_mini_2024", model: "Apex Pro Mini (2024)", connection: "usb", family: "single", firmwareLine: "1.19.6",
    bootloaderPid: null, table: "apexProMini2024", analogKeys: ANALOG_KEYS_MINI, firmwareQuery: FW_SINGLE,
    sources: [src.sql("gg-76.0.0/20241202181419_squash.sql", 3), src.fw(0x1648)],
    features: {},
    notes: "No capture: firmware version only.",
  }),

  // ---------------------------------------------------------------- wireless line (fw 3.24.1)
  model({
    productId: 0x1644, ggName: "apex_pro_tkl_wireless_2024_dongle", model: "Apex Pro TKL Wireless (2024) receiver", connection: "receiver", family: "wireless-rx",
    firmwareLine: "3.24.1/3.24.1/3.24.1", bootloaderPid: 0x1645, mainPid: 0x1646, table: "apexProTklWireless2024", analogKeys: ANALOG_KEYS_TKL,
    actuation: cap("source-hw", "6F 00 44 [usage,l,h]x68 + ACK; GG's map for 1646 (1.5 mm = 28/31) as [opengg] measured.", src.opengg, src.ui(1372345, "map g")),
    rapidTrigger: cap("source-hw", "76 44 [usage,0|1]x68 + ACK (GG's page: release_mode 1 = rapid trigger on this line).", src.opengg, src.ui(1373456, "98480 release_mode 1")),
    sensitivity: cap("source-hw", "77 44 [usage,sens]x68 + ACK, sens = mm x 10.", src.opengg),
    directLighting: { ...cap("source-hw", "61 <n> [usage,R,G,B]xn (feature, no ACK); 62 releases it.", src.opengg, src.openrgb), leds: LED_KEYS_TKL, initFirst: false, release: true },
    statusQuery: cap("source-hw", "BC -> connection (byte 2 = 1 connected), D2 -> battery state.", src.opengg),
    sources: [src.sql("gg-71.0.0/20240916111722_squash.sql", 76), src.sql("gg-71.0.0/20240916111722_squash.sql", 79), src.fw(0x1644), src.opengg, src.openrgb],
    features: { analog: { perKey: true, actuation: ACT_RANGE, rapidTrigger: { press: RT_RANGE, perKey: true } }, lighting: { effects: false, perKey: true, brightness: { min: 0, max: 0, step: 1 } } },
    notes: "Before an advanced command OpenGG releases temporary RGB (62); SYNQ does the same when it set a colour.",
  }),
  model({
    productId: 0x1646, ggName: "apex_pro_tkl_wireless_2024", model: "Apex Pro TKL Wireless (2024, USB cable)", connection: "usb", family: "wireless-usb",
    firmwareLine: "3.24.1/3.24.1", bootloaderPid: 0x1647, table: "apexProTklWireless2024", analogKeys: ANALOG_KEYS_TKL,
    actuation: cap("source-hw", "2F 00 44 [usage,l,h]x68 + ACK (the receiver opcode with bit 0x40 cleared).", src.opengg, src.ui(1372345, "map g")),
    sensitivity: cap("source-hw", "37 44 [usage,sens]x68 + ACK.", src.opengg),
    directLighting: { ...cap("source-hw", "21 <n> [usage,R,G,B]xn (feature); 22 releases it.", src.opengg), leds: LED_KEYS_TKL, initFirst: false, release: true },
    statusQuery: cap("source-hw", "92 -> battery state.", src.opengg),
    sources: [src.sql("gg-71.0.0/20240916111722_squash.sql", 54), src.sql("gg-71.0.0/20240916111722_squash.sql", 75), src.fw(0x1646), src.opengg],
    features: { analog: { perKey: true, actuation: ACT_RANGE }, lighting: { effects: false, perKey: true, brightness: { min: 0, max: 0, step: 1 } } },
    notes: "Rapid-trigger on/off is not offered over the cable: its opcode 0x36 is the key-binding write on the wired Gen 3, so the guard refuses 0x36 everywhere.",
  }),
  model({
    productId: 0x1630, ggName: "apex_pro_tkl_wireless_dongle", model: "Apex Pro TKL Wireless (2023) receiver", connection: "receiver", family: "wireless-rx",
    firmwareLine: "3.24.1/3.24.1/3.24.1", bootloaderPid: 0x1631, mainPid: 0x1632, table: "apexProTkl2022", analogKeys: ANALOG_KEYS_TKL,
    directLighting: { ...cap("inferred", "[openrgb] uses 0x61 on this receiver; same firmware line as the 1644.", src.openrgb), leds: LED_KEYS_TKL, initFirst: false, release: true },
    statusQuery: cap("inferred", "Same firmware line as the 1644.", src.opengg),
    sources: [src.sql("gg-25.0.0/20220926100614_squash.sql", 440), src.sql("gg-25.0.0/20220926100614_squash.sql", 443), src.fw(0x1630), src.openrgb],
    features: { lighting: { effects: false, perKey: true, brightness: { min: 0, max: 0, step: 1 } } },
    notes: "Actuation shown only: same firmware line as the 2024 wireless, different GG map (62347), no capture.",
  }),
  model({
    productId: 0x1632, ggName: "apex_pro_tkl_wireless", model: "Apex Pro TKL Wireless (2023, USB cable)", connection: "usb", family: "wireless-usb",
    firmwareLine: "3.24.1/3.24.1", bootloaderPid: 0x1633, table: "apexProTkl2022", analogKeys: ANALOG_KEYS_TKL,
    sources: [src.sql("gg-25.0.0/20220926100614_squash.sql", 4), src.sql("gg-25.0.0/20220926100614_squash.sql", 441), src.fw(0x1632)],
    features: {},
    notes: "[openrgb] sends receiver opcodes (0x61) here; [opengg] reports that receiver bytes on the cable failed on the 2024 model. Nothing is written.",
  }),
  model({
    productId: 0x1624, ggName: "apex_pro_mini_wireless_dongle", model: "Apex Pro Mini Wireless receiver", connection: "receiver", family: "wireless-rx",
    firmwareLine: "3.24.1/3.24.1/3.24.1", bootloaderPid: 0x1625, mainPid: 0x1626, table: "apexProMiniWireless", analogKeys: ANALOG_KEYS_MINI,
    sources: [src.sql("gg-20.0.0/20220616103339_squash.sql", 784), src.sql("gg-20.0.0/20220616103339_squash.sql", 787), src.fw(0x1624)],
    features: {},
    notes: "No capture: detected only.",
  }),
  model({
    productId: 0x1626, ggName: "apex_pro_mini_wireless", model: "Apex Pro Mini Wireless (USB cable)", connection: "usb", family: "wireless-usb",
    firmwareLine: "3.24.1/3.24.1", bootloaderPid: 0x1627, table: "apexProMiniWireless", analogKeys: ANALOG_KEYS_MINI,
    sources: [src.sql("gg-20.0.0/20220616103339_squash.sql", 405), src.sql("gg-20.0.0/20220616103339_squash.sql", 785), src.fw(0x1626)],
    features: {},
    notes: "No capture: detected only.",
  }),

  // ---------------------------------------------------------------- other boards: detect only
  model({ productId: 0x1620, ggName: "apex_9_mini", model: "Apex 9 Mini", connection: "usb", family: "other", firmwareLine: "1.19.9", bootloaderPid: null, sources: [src.sql("gg-23.0.0/20220817165906_squash.sql", 75), src.fw(0x1620), src.openrgb], features: {}, notes: "OptiPoint (not analog). [openrgb] lights it with a 512-byte frame; not implemented." }),
  model({ productId: 0x1634, ggName: "apex_9_tkl", model: "Apex 9 TKL", connection: "usb", family: "other", firmwareLine: "1.19.9", bootloaderPid: null, sources: [src.sql("gg-23.0.0/20220817165906_squash.sql", 335), src.fw(0x1634), src.openrgb], features: {}, notes: "OptiPoint (not analog). [openrgb] lights it with a 512-byte frame; not implemented." }),
  model({ productId: 0x161a, ggName: "apex_3", model: "Apex 3", connection: "usb", family: "other", firmwareLine: "0.40.0.0", bootloaderPid: 0x161b, sources: [src.sql("3.17.0/20191223104517_squash.sql", 4), src.sql("3.17.0/20191223104517_squash.sql", 173), src.fw(0x161a), src.openrgb], features: {}, notes: "10-zone lighting on another protocol ([openrgb] TZone); not implemented." }),
  model({ productId: 0x1622, ggName: "apex_3_tkl", model: "Apex 3 TKL", connection: "usb", family: "other", firmwareLine: "3.0.4", bootloaderPid: 0x1623, sources: [src.sql("gg-9.0.0/20211006104421_squash.sql", 5), src.sql("gg-9.0.0/20211006104421_squash.sql", 116), src.fw(0x1622), src.openrgb], features: {}, notes: "8-zone lighting on another protocol ([openrgb] 8Zone); not implemented." }),
  model({ productId: 0x1616, ggName: "apex_150", model: "Apex 150", connection: "usb", family: "other", firmwareLine: "0.25.0.0", bootloaderPid: 0x1617, sources: [src.sql("3.11.3/20170911105341_squash.sql", 4), src.sql("3.11.3/20170911105341_squash.sql", 327), src.fw(0x1616)], features: {} }),
];

export const findModel = (productId: number): SsModel | undefined => MODELS.find((m) => m.productId === productId);

/** Every bootloader PID GG 121 lists for these keyboards (physical_devices.bootloader_product_id). Never claimed. */
export const BOOTLOADER_PIDS: readonly number[] = MODELS.flatMap((m) => (m.bootloaderPid === null ? [] : [m.bootloaderPid]));

export const isBootloader = (vendorId: number, productId: number): boolean => vendorId === STEELSERIES_VID && BOOTLOADER_PIDS.includes(productId);

/** Models the driver opens: a known command family and at least one query or setting with evidence. */
export const isDriven = (m: SsModel): boolean => m.family !== "other" && !!(m.firmwareQuery || m.statusQuery || m.actuation || m.directLighting);

/** What the Rust bridge (hid.rs) must allow for SteelSeries, and nothing more. */
export const STEELSERIES_BRIDGE: BridgeAllowance = {
  vendorId: STEELSERIES_VID,
  productIds: MODELS.filter(isDriven).map((m) => m.productId),
  usagePage: SS_USAGE_PAGE,
  usage: SS_USAGE,
  access: "full",
  reportIds: [SS_REPORT_ID],
  length: Math.max(...Object.values(FEATURE_LENGTH)),
  note: "Vendor page 0xFFC0 only: 64-byte output/input, 641/642/644-byte feature reports by family (see FEATURE_LENGTH). Every frame must pass steelseries-frames.txt.",
};
