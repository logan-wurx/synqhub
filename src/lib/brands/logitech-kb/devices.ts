// Logitech G keyboard device table for SYNQ. Identities only — no device access. Every board here
// speaks HID++ 2.0 on the vendor collection (usage page 0xFF00); the three report ids are handled in
// protocol.ts, so the Channel below names the short-report collection as the primary one.
//
// PID sources (read as data, nothing sent to a keyboard):
//   [solaar]  pwr-Solaar/Solaar lib/logitech_receiver/descriptors.py usbid=… (GPL, read for ids only).
//   [dfu]     G HUB details.json depot dfu.json "interfaceInfos" (application PID is the non-force,
//             updatable DEVIO interface; the "force" one is the bootloader — see bootloader-ids.ts).
//   [agent]   lghub_agent.exe model ids "KEYBOARD.<model>".
// The analog RAPID boards (PRO X TKL RAPID, G515 RAPID) ship their definition inside an *encrypted*
// G HUB capsule depot, so their runtime application PID could not be read here; they are listed in
// LOGITECH_ANALOG_KEYBOARDS with the facts that are known and a needs-device note.

import type { Channel, DeviceEntry, Source } from "../local-kb.ts";
import { HIDPP, REPORT } from "./protocol.ts";

const VID = HIDPP.vendorId;

/** HID++ short-report collection. protocol.ts also uses long (0x11) and very-long (0x12) on this device. */
export const HIDPP_CHANNEL: Channel = {
  usagePage: HIDPP.usagePage,
  usage: HIDPP.usageShort,
  transport: "output+input",
  reportId: REPORT.short.id,
  length: REPORT.short.len,
};

const src = (ref: string): Source => ({ kind: ref.startsWith("Solaar") ? "open-source" : "configurator-js", ref, license: ref.startsWith("Solaar") ? "GPL-2.0-or-later" : undefined });

function kb(productId: number, model: string, connection: DeviceEntry["connection"], features: string[], sources: Source[], notes?: string): DeviceEntry {
  return { vendor: "Logitech G", vendorId: VID, productId, model, kind: "keyboard", connection, channel: HIDPP_CHANNEL, tier: "readOnly", sources, notes: notes ? `${notes} Features: ${features.join(", ")}.` : `Features: ${features.join(", ")}.` };
}

const LIGHTING = "per-key RGB (0x8071/0x8081)";
const RATE = "report rate (0x8060/0x8061)";
const BRIGHT = "brightness (0x8040)";
const PROFILES = "onboard profiles (0x8100)";

/** Keyboards whose application USB product id is known from source. All read-only in SYNQ. */
export const LOGITECH_KEYBOARDS: readonly DeviceEntry[] = [
  kb(0xc336, "G213 Prodigy", "usb", [LIGHTING, BRIGHT], [src("Solaar descriptors.py usbid=0xC336")], "RGB zones, no analog."),
  kb(0xc339, "PRO (mechanical)", "usb", [LIGHTING, RATE], [src("Solaar descriptors.py usbid=0xC339")]),
  kb(0xc33c, "G512 RGB", "usb", [LIGHTING], [src("Solaar descriptors.py usbid=0xC33C")]),
  kb(0xc33f, "G815 LIGHTSYNC", "usb", [LIGHTING, BRIGHT, PROFILES], [src("Solaar descriptors.py usbid=0xC33F")]),
  kb(0xc341, "K845 Mechanical", "usb", [LIGHTING], [src("Solaar descriptors.py usbid=0xC341")]),
  kb(0xc343, "G915 TKL LIGHTSPEED", "receiver", [LIGHTING, BRIGHT, RATE, PROFILES], [src("Solaar descriptors.py usbid=0xC343"), src("G HUB g915_tkl_dfu.json 046d_c343")], "Wireless; also pairs via LIGHTSPEED receiver. DFU/bootloader PID 046d_aafb (blocked)."),
  kb(0xc33e, "G915 LIGHTSPEED", "receiver", [LIGHTING, BRIGHT, RATE, PROFILES], [src("G HUB g915_dfu.json 046d_c33e")], "DFU/bootloader PID 046d_aae3 (blocked)."),
  kb(0xc347, "G715 (AURORA)", "receiver", [LIGHTING, BRIGHT, RATE, PROFILES], [src("G HUB g715_dfu.json 046d_c347")], "DFU/bootloader PID 046d_ab15 (blocked)."),
  kb(0xc348, "G713 (AURORA)", "usb", [LIGHTING, BRIGHT, PROFILES], [src("G HUB g713_dfu.json 046d_c348")], "DFU/bootloader PID 046d_ab16 (blocked)."),
  kb(0xc351, "PRO X 60", "usb", [LIGHTING, RATE, PROFILES], [src("G HUB pro_x_60_keyboard_dfu.json 046d_c351")], "FKC (0x1B05) remap. DFU/bootloader PID 046d_ab29 (blocked)."),
];

export interface AnalogKeyboard {
  model: string;
  /** G HUB model id ("KEYBOARD.<id>"). */
  modelId: string;
  /** Known application/runtime USB product id, or null when it lives in an encrypted G HUB package. */
  productId: number | null;
  /** DFU/bootloader interface ids from dfu.json, if the depot was readable (RAPID depots are encrypted). */
  dfu: readonly string[];
  features: readonly string[];
  note: string;
}

/**
 * The magnetic-analog "RAPID" boards: feature 0x1B08 AnalogKeys (actuation point, rapid trigger, key
 * priority) plus the same lighting/profile features as the mechanical boards. Their definitions are in
 * encrypted G HUB capsule depots, so the runtime PID still needs a real device to confirm.
 */
export const LOGITECH_ANALOG_KEYBOARDS: readonly AnalogKeyboard[] = [
  { model: "PRO X TKL RAPID", modelId: "pro_x_tkl_rapid", productId: null, dfu: [], features: ["actuation 0.1–4.0 mm", "rapid trigger", "key priority / SOCD", "per-key RGB", "onboard profiles"], note: "0.1 mm steps; actuation range from G HUB UI keyTravelConfig (needs-device to confirm exact min/max)." },
  { model: "G515 RAPID TKL", modelId: "g515_tkl_rapid", productId: null, dfu: [], features: ["actuation 0.1–2.5 mm", "rapid trigger", "per-key RGB", "onboard profiles"], note: "Low-profile; Logitech lists 0.1–2.5 mm actuation. Runtime PID needs-device (g515_tkl_keyboard_dfu depot is encrypted)." },
  { model: "G515 LIGHTSPEED TKL (analog variant)", modelId: "g515_ls_tkl", productId: null, dfu: [], features: ["actuation", "rapid trigger", "per-key RGB"], note: "Wireless low-profile; g515_ls_tkl_keyboard_dfu depot encrypted. Needs-device." },
];

export const isLogitechKeyboard = (vendorId: number, productId: number): boolean => vendorId === VID && LOGITECH_KEYBOARDS.some((d) => d.productId === productId);

export const logitechKeyboard = (vendorId: number, productId: number): DeviceEntry | undefined => (vendorId === VID ? LOGITECH_KEYBOARDS.find((d) => d.productId === productId) : undefined);
