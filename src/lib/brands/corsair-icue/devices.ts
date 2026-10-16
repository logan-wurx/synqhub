// Corsair devices on the iCUE (BRAGI / Corsair V2) desktop path — identities only, no device access.
// Wave 3a owns the Web Hub path (src/lib/brands/corsair/); this table is the devices the Web Hub does
// NOT cover, above all the magnetic-switch boards (K70 MAX) that need actuation/rapid-trigger tuning.
//
// PID sources (read as data):
//   [icue]    official Corsair cuepkg `dev-k70-max` meta/auxiliary.json: K70 MAX usb-vid 0x1B1C,
//             usb-pid 0x1BC0, keyboard, HidProto "Bragi_kbd", onboard memory, actuation 0.4–3.6 mm
//             (0.1 mm units, default 2.0 mm), polling up to 8000 Hz.
//   [openrgb] CalcProgrammer1/OpenRGB CorsairPeripheralV2Devices.h (GPL, read for ids only): the
//             K-series RGB boards and Corsair mice PIDs, all on usage page 0xFF42.

import type { Channel, DeviceEntry, Source } from "../local-kb.ts";
import { BRAGI } from "./protocol.ts";

const VID = BRAGI.vendorId;

/** The Corsair control collection every BRAGI device exposes. */
export const BRAGI_CHANNEL: Channel = {
  usagePage: BRAGI.usagePage,
  usage: BRAGI.usage,
  transport: "output+input",
  reportId: BRAGI.reportId,
  length: BRAGI.length,
};

const icue = (ref: string): Source => ({ kind: "configurator-js", ref });
const openrgb = (ref: string): Source => ({ kind: "open-source", ref, license: "GPL-2.0-or-later" });

function dev(productId: number, model: string, kind: DeviceEntry["kind"], features: string[], sources: Source[], notes?: string): DeviceEntry {
  return { vendor: "Corsair", vendorId: VID, productId, model, kind, connection: "usb", channel: BRAGI_CHANNEL, tier: "readOnly", sources, notes: `${notes ? notes + " " : ""}Features: ${features.join(", ")}.` };
}

/** Magnetic-switch (analog) boards — the iCUE-only prize. Actuation + rapid trigger over BRAGI. */
export const CORSAIR_ANALOG_KEYBOARDS: readonly DeviceEntry[] = [
  dev(0x1bc0, "K70 MAX (MGX magnetic)", "keyboard", ["actuation 0.4–3.6 mm (0.1 mm steps, default 2.0)", "rapid trigger", "per-key RGB", "onboard profiles", "polling up to 8000 Hz"], [icue("cuepkg dev-k70-max auxiliary.json pid 0x1BC0; manifest KeyActuationCapabilities 0.4–3.6"), icue("DeviceCommands.dll Set/GetKeyActuationSetting, SetRapidTriggerSetting")], "Needs a device: exact BRAGI actuation property bytes are not published (abstracted in the iCUE DLL)."),
];

/** RGB (non-analog) K-series keyboards reached via BRAGI; PIDs from OpenRGB. */
export const CORSAIR_RGB_KEYBOARDS: readonly DeviceEntry[] = [
  dev(0x1bfd, "K70 Core RGB", "keyboard", ["per-key RGB", "onboard"], [openrgb("CorsairPeripheralV2Devices.h K70_CORE_RGB 0x1BFD")]),
  dev(0x2b01, "K70 Core RGB TKL", "keyboard", ["per-key RGB"], [openrgb("K70_CORE_RGB_TKL 0x2B01")]),
  dev(0x1bc4, "K70 RGB PRO", "keyboard", ["per-key RGB"], [openrgb("K70_RGB_PRO 0x1BC4")]),
  dev(0x1bb3, "K70 RGB PRO V2", "keyboard", ["per-key RGB"], [openrgb("K70_RGB_PRO_V2 0x1BB3")]),
  dev(0x1b7c, "K100 RGB Optical", "keyboard", ["per-key RGB", "polling"], [openrgb("K100_OPTICAL_V1 0x1B7C")]),
  dev(0x1bc5, "K100 RGB Optical (v2)", "keyboard", ["per-key RGB", "polling"], [openrgb("K100_OPTICAL_V2 0x1BC5")]),
  dev(0x1b7d, "K100 MX Red", "keyboard", ["per-key RGB"], [openrgb("K100_MXRED 0x1B7D")]),
  dev(0x1b89, "K95 RGB PLATINUM XT", "keyboard", ["per-key RGB"], [openrgb("K95_PLATINUM_XT 0x1B89")]),
  dev(0x1ba4, "K55 RGB PRO", "keyboard", ["zone RGB"], [openrgb("K55_RGB_PRO 0x1BA4")]),
];

/** Corsair mice reached via BRAGI; PIDs from OpenRGB. */
export const CORSAIR_MICE: readonly DeviceEntry[] = [
  dev(0x1bf0, "M75 Gaming Mouse", "mouse", ["RGB", "DPI"], [openrgb("M75_GAMING 0x1BF0")]),
  dev(0x1bf1, "M75 Wireless", "mouse", ["RGB", "DPI"], [openrgb("M75_WIRELESS 0x1BF1")]),
  dev(0x1b9e, "M65 RGB Ultra (wired)", "mouse", ["RGB", "DPI"], [openrgb("M65_RGB_ULTRA_WIRED 0x1B9E")]),
  dev(0x1be3, "Scimitar Elite RGB V2", "mouse", ["RGB", "DPI"], [openrgb("SCIMITAR_ELITE_RGB_V2 0x1BE3")]),
  dev(0x1bba, "Katar Pro V2", "mouse", ["RGB", "DPI"], [openrgb("KATAR_PRO_V2 0x1BBA")]),
  dev(0x1b70, "M55 RGB PRO", "mouse", ["RGB", "DPI"], [openrgb("M55_RGB_PRO 0x1B70")]),
];

export const CORSAIR_ICUE_DEVICES: readonly DeviceEntry[] = [...CORSAIR_ANALOG_KEYBOARDS, ...CORSAIR_RGB_KEYBOARDS, ...CORSAIR_MICE];

export const isCorsairIcueDevice = (vendorId: number, productId: number): boolean => vendorId === VID && CORSAIR_ICUE_DEVICES.some((d) => d.productId === productId);
export const corsairIcueDevice = (vendorId: number, productId: number): DeviceEntry | undefined => (vendorId === VID ? CORSAIR_ICUE_DEVICES.find((d) => d.productId === productId) : undefined);
