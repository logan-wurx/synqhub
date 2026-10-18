// Everything the generic (OpenMouse) mouse path decides by rule, in one place: which driver methods
// may ever be called, which are refused outright, support tiers, and what SYNQ knows about
// whether each driver's writes survive a power cycle. No device access, no Tauri, no React.
import { granted, type AdvancedScope, type Grants } from "../advanced/core.ts";

/** Driver methods the generic panel may call to read. Nothing else is ever looked up on a client. */
export const READ_METHODS = [
  "open",
  "close",
  "readStatus",
  "getDpiOptions",
  "getSupportedPollingRates",
  "getSleepOptions",
  "getDebounceOptions",
  "getDebounceMaxMs",
  "deviceBrand",
] as const;

/** Driver methods the generic panel may call to change a setting. */
export const SETTING_METHODS = [
  "setDpi",
  "setDpiStageValue",
  "setActiveDpiStage",
  "setDpiStageCount",
  "setPollingRate",
  "setLiftOffDistance",
  "setMotionSync",
  "setAngleSnapping",
  "setRippleControl",
  "setDebounceTime",
  "setSleepTimeout",
  "setLighting",
  "setMagneticTriggerPoint",
  "setMagneticRapidTrigger",
  "setMagneticReleasePoint",
] as const;

export type ReadMethod = (typeof READ_METHODS)[number];
export type SettingMethod = (typeof SETTING_METHODS)[number];
export type AllowedMethod = ReadMethod | SettingMethod;

/**
 * Never called and never exposed, whatever a driver offers: firmware / DFU / bootloader / update,
 * pairing and unpairing, factory reset, magnetic calibration, profile wipes, anything that changes
 * the USB identity (USB speed, gamepad/host switching, receiver reboots), raw report access, and
 * button/macro/profile rewrites. Checked again on every call as a second line behind the allowlist.
 */
export const BLOCKED_PATTERNS: readonly RegExp[] = [
  /firmware|dfu|bootloader|upgrade|update|flash(?!Led)|erase/i,
  /pair/i,
  /factory|restore|reset/i,
  /calibrat/i,
  /wipe|clear|initialize|blank/i,
  /usbSpeed|productId|identity|reboot|hostSwitch|requestHost|onboardMode|gameMode|layerOrientation/i,
  /^send|^receive|^request|^command$|writeBlock|rawWrite|probe/i,
  /macro|keycode|setKeys|buttonMapping|buttonsMapping|profileData|profileName|friendlyName|uploadMacro/i,
];

export function isBlocked(method: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(method));
}

// ---- Advanced

/**
 * The only blocked methods an Advanced action can call, by scope, and only while the mouse's AdvancedGate
 * holds a live token for that scope (src/lib/advanced/core.ts). Everything else in BLOCKED_PATTERNS stays
 * blocked whatever is granted: firmware, un-pairing, profile wipes, USB identity, raw reports, macro and
 * profile rewrites. `isAllowed` and `isBlocked` above are unchanged; the default path never sees these.
 * Sources: @openmouse/protocol 0.41 drivers (asus/hid.js setOmniPairingMode, the shared `setButtonMapping`
 * remapper, lamzu + gwolves calibrateMagneticButtons, endgame/wallhack/zaunkoenig factoryReset).
 */
export const ADVANCED_METHODS: Readonly<Partial<Record<AdvancedScope, readonly string[]>>> = {
  pair: ["setOmniPairingMode"],
  remap: ["setButtonMapping"],
  calibrate: ["calibrateMagneticButtons"],
  reset: ["factoryReset"],
};

/** Never callable, not even from Advanced: checked before the lists above are consulted. */
export const NEVER_PATTERNS: readonly RegExp[] = [
  /firmware|dfu|bootloader|upgrade|update|flash(?!Led)|erase/i,
  /unpair|clearPair|rebootOmni|reboot/i,
  /wipe|clear|initialize|blank|resetAll|resetButton|resetProfile/i,
  /usbSpeed|productId|identity|hostSwitch|requestHost|onboardMode|gameMode|layerOrientation/i,
  /^send|^receive|^request|^command$|writeBlock|rawWrite|probe/i,
  /profileData|profileName|friendlyName|uploadMacro|setMacro|setKeys|buttonsMapping/i,
];

/** Whether an Advanced action of `scope` may call `method` right now: named for that scope, never a NEVER method, and the gate holds a live token. */
export function isAdvancedAllowed(method: string, scope: AdvancedScope, grants?: Grants): boolean {
  if (NEVER_PATTERNS.some((p) => p.test(method))) return false;
  return !!ADVANCED_METHODS[scope]?.includes(method) && granted(grants, scope);
}

export function isAllowed(method: string): method is AllowedMethod {
  return ((READ_METHODS as readonly string[]).includes(method) || (SETTING_METHODS as readonly string[]).includes(method)) && !isBlocked(method);
}

// ---- the quick "is it on" check

/**
 * The cheapest call that proves a mouse answers, per driver class. Any class not listed is asked for
 * its status (`readStatus`), which every driver offers and which only reads. Razer's RazerHidClient
 * is listed because its readStatus, once per connection, also writes the mouse's lift-off setting back
 * to learn whether it has the asymmetric kind (`probeAsymmetric`); a check that runs each time the
 * Mouse page opens must not do that. `probeReachable` only reads the firmware version.
 * These names are outside the allowlist above (the blocked patterns catch "probe"): only
 * `SafeMouse.ping` may call them, and only for the class that names them.
 */
export const CHEAPEST_READ: Readonly<Record<string, string>> = { RazerHidClient: "probeReachable" };

// ---- which mice the generic panel is for

/** Mice SYNQ drives with its own code; the generic panel never writes to these. */
export function hasHandBuiltPanel(vid: number, pid: number): boolean {
  return vid === 0x046d || (vid === 0x373b && (pid === 0x1278 || pid === 0x12a2));
}

/** Tested by hand on real hardware: the PRO X 2 DEX (cable and LIGHTSPEED receiver) and the X1 V2 Air+. */
const VERIFIED: readonly [number, number][] = [
  [0x046d, 0xc0a0],
  [0x046d, 0xc54d],
  [0x373b, 0x1278],
  [0x373b, 0x12a2],
];

/** OpenMouse drivers in the mouse registry that are not mice (keyboards, a charging dock). */
export const NOT_A_MOUSE = new Set(["WootingHidClient", "WallhackKeyboardHidClient", "AjazzAk820HidClient", "MchoseDockHidClient"]);

export type Tier = "verified" | "driver-tested" | "read-only";

export const TIER_LABEL: Record<Tier, { label: string; hint: string }> = {
  verified: { label: "Verified", hint: "Tested with SYNQ on this exact mouse." },
  "driver-tested": { label: "Driver-tested", hint: "OpenMouse marks this mouse's settings as tested. SYNQ hasn't been tried on one." },
  "read-only": { label: "Read-only", hint: "Not tested with SYNQ yet, so changes are off until you allow them." },
};

export function supportTier(vid: number, pid: number, ui: { settingsReady?: boolean; valuesVerified?: boolean } | undefined): Tier {
  if (VERIFIED.some(([v, p]) => v === vid && p === pid)) return "verified";
  // Explicit flags only: SYNQ uses settingsReady only when the driver sets it.
  if (ui?.valuesVerified === true || ui?.settingsReady === true) return "driver-tested";
  return "read-only";
}

// ---- persistence

export type Persistence = "saved" | "volatile" | "unknown";

export const PERSISTENCE_LABEL: Record<Persistence, string> = {
  saved: "Saved on the mouse",
  volatile: "Lost when the mouse turns off",
  unknown: "Not verified",
};

/**
 * From each driver's own code (@openmouse/protocol 0.36): an EEPROM/flash write or an explicit save
 * command after the setter means "saved"; a driver that says its writes are live-only means
 * "volatile". Anything else stays "unknown". Drivers marked "(likely)" in the survey are left out.
 */
const SAVED = new Set([
  "AsusHidClient", // save() after each setter (asus/hid.js:193)
  "AtkHidClient", // WRITE_EEPROM (atk/hid.js:990)
  "EggWeHidClient", // writeEeprom (egg-we-hid.js:276)
  "GravaStarHidClient", // Pulsar flash map
  "GWolvesHidClient", // flash read/write (gwolves/hid.js:322)
  "HyperXHidClient", // SAVE packet (hyperx/hid.js:23)
  "Keychron4kHidClient", // "Writes are followed by a save"
  "Keychron8kNordicHidClient", // save() (mouse-8k-nordic-hid.js:410)
  "KsnakeHidClient", // commit to flash
  "LamzuAtlantisHidClient", // flash byte fields
  "NoirM1NexHidClient", // LamzuAtlantis subclass
  "OrbitalHidClient", // save command after writes (host-protocol.js:78)
  "PulsarHidClient", // writeFlash (pulsar-hid.js:329)
  "PulsarAresonHidClient", // PulsarHidClient subclass
  "PulsarProHidClient", // saveAllow after each setValue
  "RazerHidClient", // VARSTORE storage byte
  "RazerCobraHidClient",
  "RazerViperHidClient",
  "RazerViperMiniHidClient",
  "RedragonHidClient", // commit block after writes
  "SteelSeriesRival3HidClient", // save command after every setter
  "SteelSeriesAerox3HidClient",
  "SteelSeriesAerox3WirelessHidClient",
  "SteelSeriesRival3WirelessHidClient",
  "SteelSeriesAerox5HidClient",
  "SteelSeriesAerox5WirelessHidClient",
  "SteelSeriesRival650HidClient",
  "SteelSeriesAerox9WirelessHidClient",
  "SteelSeriesRival310HidClient",
  "SteelSeriesPrimePlusHidClient",
  "SteelSeriesPrimeMiniWirelessHidClient",
  "SteelSeriesSenseiTenHidClient",
  "TeevolutionHidClient", // writeFlash
  "VgnF2HidClient", // flash read/write
  "AjazzHidClient", // commit to flash
]);
/** "Live profile ... forgets on a power cycle" (corsair/hid.js:14). */
const VOLATILE = new Set(["CorsairHidClient"]);
/** Per-setting exceptions to the driver's rule. */
const EXCEPTIONS: Record<string, Partial<Record<SettingMethod, Persistence>>> = {
  AsusHidClient: { setDpi: "unknown" },
  EggOp1HidClient: { setActiveDpiStage: "volatile" },
  HyperXHidClient: { setPollingRate: "unknown" },
  // Host mode (ensureHostControl): live DPI, lift-off and lighting are dropped at power-off.
  LogitechHidppClient: { setDpi: "volatile", setLiftOffDistance: "volatile", setLighting: "volatile" },
  SteelSeriesAerox3WirelessHidClient: { setLighting: "volatile" },
};
/** Razer's DeathAdder V2 generation writes with the no-store byte. */
const RAZER_NOSTORE_PIDS = new Set([0x0084]);

export function persistenceFor(cls: string, method: SettingMethod, pid: number, deviceMode?: string): Persistence {
  if (deviceMode === "Host") return "volatile";
  const exception = EXCEPTIONS[cls]?.[method];
  if (exception) return exception;
  if (cls === "RazerHidClient" && RAZER_NOSTORE_PIDS.has(pid)) return "volatile";
  if (VOLATILE.has(cls)) return "volatile";
  if (SAVED.has(cls)) return "saved";
  return "unknown";
}

// ---- units

/**
 * Seconds per unit of the value setSleepTimeout takes (and status.sleepTimeout reports). Most
 * drivers take seconds; these take a code in 10 s steps or minutes.
 */
const SLEEP_SCALE: Record<string, number> = {
  PulsarHidClient: 10,
  PulsarAresonHidClient: 10,
  PulsarProHidClient: 10,
  TeevolutionHidClient: 10,
  VgnF2HidClient: 10,
  WallhackMouseHidClient: 60,
};
export const sleepSecondsPerUnit = (cls: string) => SLEEP_SCALE[cls] ?? 1;
