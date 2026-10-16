// Everything the OpenMouse keyboard path decides by rule: which driver methods may ever be called,
// which are refused outright, tiers per board, and where each write lives. No device access.
import type { BlockedCommand, KbPersistence, KbSupport } from "../types.ts";

/** Driver methods that only read. Nothing else is ever looked up on a client. */
export const KB_READ_METHODS = ["open", "close", "readStatus", "readSystemMode", "readReportRate", "readReportRates", "readRtPrecision", "readKeyLayout", "readPerformance"] as const;

/** Driver methods that change one setting. */
export const KB_SETTING_METHODS = ["writePerformance", "writeReportRate", "setSystemMode", "switchProfile"] as const;

export type KbReadMethod = (typeof KB_READ_METHODS)[number];
export type KbSettingMethod = (typeof KB_SETTING_METHODS)[number];
export type KbAllowedMethod = KbReadMethod | KbSettingMethod;

/**
 * Never called, whatever a driver offers: firmware / DFU / bootloader, factory reset and any
 * flash-wide save or restore (Wooting saveProfile, Wuque saveScope, which also reaches its
 * calibration and axis scopes), calibration and the raw axis reads (which also report held keys),
 * anything that changes the USB identity or mode (USB / high-polling mode, gamepad, system type),
 * key and macro writes, lighting writes, the live analog stream, and raw report access.
 */
export const KB_BLOCKED_PATTERNS: readonly RegExp[] = [
  /firmware|dfu|bootloader|upgrade|update|flash|erase/i,
  /reset|restore|factory|wipe|clear/i,
  /save/i,
  /calibrat|axis/i,
  /usbMode|gamepad|xinput|systemSetting|configSwitch|identity|reboot/i,
  /keyCode|keycode|higherKey|macro|mapping|remap/i,
  /lighting|rgb|color|colour|blackout|directDrive|caps/i,
  /startAnalog|analogSnapshot|rawScanning|keysOff/i,
  /^send|^receive|^probe|^command|^request|raw/i,
];

export function isKbBlocked(method: string): boolean {
  return KB_BLOCKED_PATTERNS.some((p) => p.test(method));
}

export function isKbAllowed(method: string): method is KbAllowedMethod {
  return ((KB_READ_METHODS as readonly string[]).includes(method) || (KB_SETTING_METHODS as readonly string[]).includes(method)) && !isKbBlocked(method);
}

export const OMKB_BLOCKED: readonly BlockedCommand[] = [
  { what: "Firmware update, bootloader and DFU commands", why: "firmware" },
  { what: "Factory reset, settings reset and flash-wide save or restore (Wooting save, Wuque saveScope)", why: "factory-reset" },
  { what: "Switch calibration and raw sensor reads", why: "calibration" },
  { what: "USB / high-polling mode, gamepad mode and system-type switches", why: "identity" },
  { what: "Key, advanced-key and macro writes", why: "macro" },
  { what: "Lighting writes", why: "unverified" },
  { what: "The live analog stream (which keys are pressed)", why: "keystrokes" },
];

/** Tiers per driver class and board, from the package's own evidence (README / product tables). */
export function omkbSupport(cls: string, vendorId: number, productId: number, verifiedByDriver: boolean): KbSupport {
  if (cls === "WuqueHidClient" && vendorId === 0x1ca6 && productId === 0x1b10 && verifiedByDriver)
    return {
      tier: "read-only",
      why: "OpenMouse tested actuation, rapid trigger, dead zones and polling on a BABAO60 HE (protocol 1.2.1.0). SYNQ hasn't been tried on one.",
      groups: { analog: "driver-tested", polling: "driver-tested" },
    };
  if (cls === "KochiHidClient")
    return { tier: "read-only", why: "OpenMouse exercised the Windows / Mac switch on a Hummingbird 68 and read it back. SYNQ hasn't been tried on one.", groups: { options: "driver-tested" } };
  if (cls === "WootingHidClient") return { tier: "read-only", why: "OpenMouse reads this Wooting's settings; only profile switching can be sent, and no one has tested it with SYNQ." };
  return { tier: "read-only", why: "Not tested with SYNQ or marked tested by OpenMouse." };
}

/** Where each kind of write lives, from each driver's own code. */
export function omkbPersistence(method: KbSettingMethod): KbPersistence {
  // Wuque writes go to RAM; only a scoped save (never sent) moves them to flash. Wooting's profile
  // switch is RAM-only by design. The Kochi mode switch's persistence isn't documented.
  if (method === "writePerformance" || method === "writeReportRate" || method === "switchProfile") return "volatile";
  return "unknown";
}
