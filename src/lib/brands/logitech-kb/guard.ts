// The safety allowlist for Logitech G keyboards (HID++ 2.0). Every outgoing report passes classify();
// anything not explicitly recognised as a safe read or a safe setting write is refused, and the whole
// family of firmware / bootloader / reset / pairing / host-switch / device-mode / profile-memory
// features is refused outright even when the device reports an index for it.
//
// HID++ addresses a feature by its per-device *index*, which the host learns from IRoot. So the guard
// is built with that resolved feature map (index -> feature id); the session fills it during load()
// and the desktop bridge must build the same map from the same IRoot answers before it trusts a frame
// (logitech-kb-frames.txt is generated against EXAMPLE_FEATURE_MAP so the two can be checked line for
// line). With an empty map only IRoot itself (index 0x00: GetFeature, ping) is reachable.
//
// why-codes are from ../local-kb.ts BlockReason. Nothing here touches a device.

import { blockVerdict, okVerdict, type BlockReason, type CommandGuard, type OutgoingReport, type Verdict } from "../local-kb.ts";
import { FEATURE, IROOT_INDEX, REPORT, ROOT_FN } from "./protocol.ts";

const LEN_BY_ID: Readonly<Record<number, number>> = { [REPORT.short.id]: REPORT.short.len, [REPORT.long.id]: REPORT.long.len, [REPORT.veryLong.id]: REPORT.veryLong.len };

/** Device indices SYNQ will address: a cabled keyboard (0xFF) or receiver slots 1..6. */
const okDeviceIndex = (i: number): boolean => i === 0xff || (i >= 0x01 && i <= 0x06);

/** Feature ids that must never be addressed, with why and a human label (the "never sends" panel). */
export const BLOCKED_FEATURES: ReadonlyMap<number, { what: string; why: BlockReason }> = new Map([
  [0x00c0, { what: "DFU control (legacy)", why: "bootloader" }],
  [0x00c1, { what: "DFU control (unsigned)", why: "bootloader" }],
  [0x00c2, { what: "DFU control (signed)", why: "bootloader" }],
  [0x00c3, { what: "DFU control", why: "bootloader" }],
  [0x00d0, { what: "DFU (firmware transfer)", why: "firmware" }],
  [0x00d1, { what: "Resumable DFU", why: "firmware" }],
  [0x010a, { what: "Generic DFU", why: "firmware" }],
  [0x1800, { what: "Manufacturing / generic test", why: "calibration" }],
  [0x1802, { what: "Device reset", why: "factory-reset" }],
  [0x1805, { what: "Out-of-box (OOB) state", why: "factory-reset" }],
  [0x1806, { what: "Configurable device properties", why: "identity" }],
  [0x1500, { what: "Force pairing", why: "pairing" }],
  [0x1814, { what: "Change host", why: "device-mode" }],
  [0x1815, { what: "Hosts info / host switch", why: "device-mode" }],
  [0x1816, { what: "BLE Pro pre-pairing", why: "pairing" }],
  [0x1894, { what: "LIGHTSPEED device pairing", why: "pairing" }],
  [0x1895, { what: "Receiver notifications / pairing", why: "pairing" }],
  [0x1df0, { what: "Remaining pairing", why: "pairing" }],
  [0x1e00, { what: "Enable hidden (manufacturing) features", why: "device-mode" }],
  [0x1b30, { what: "Device mode (gaming/multimedia)", why: "device-mode" }],
  [0x1b05, { what: "Full key customization (remap/keystrokes)", why: "identity" }],
  [0x1b20, { what: "Switch swapability", why: "device-mode" }],
  [0x8101, { what: "Profile management (onboard memory + macros)", why: "profile-wipe" }],
  [0x8102, { what: "Modular profile management (macros/assignments)", why: "profile-wipe" }],
  [0x4521, { what: "Disable keyboard keys", why: "identity" }],
  [0x4522, { what: "Disable keys by usage", why: "identity" }],
]);

interface SafeFeature {
  name: string;
  read: ReadonlySet<number>;
  write: ReadonlySet<number>;
}
const s = (name: string, read: number[], write: number[] = []): SafeFeature => ({ name, read: new Set(read), write: new Set(write) });

// Function *indices* (0..15), not Solaar's pre-shifted fnid bytes. See protocol.ts FN.
/** feature id -> the only functions SYNQ may call on it, split read vs write. */
export const SAFE_FEATURES: ReadonlyMap<number, SafeFeature> = new Map([
  [FEATURE.featureSet, s("feature set", [0, 1])],
  [FEATURE.firmwareInfo, s("firmware info", [0, 1])],
  [FEATURE.deviceName, s("device name", [0, 1, 2])],
  [FEATURE.reportRate, s("report rate", [0, 1], [2])],
  [FEATURE.reportRateExt, s("report rate (extended)", [1, 2], [3])],
  [FEATURE.brightness, s("brightness", [0, 1], [2, 4])],
  [FEATURE.colorLedEffects, s("LED effects", [0], [1, 2, 3])],
  [FEATURE.rgbEffects, s("RGB effects", [0, 1, 3], [1, 2, 5])],
  [FEATURE.perKeyLighting, s("per-key lighting", [0], [1, 2, 4, 5])],
  [FEATURE.perKeyLightingV2, s("per-key lighting v2", [0], [1, 2, 4, 5])],
  // Onboard profiles: read info(0)/mode(2)/current(4), set mode(1) only. The flash read/write fns
  // (5 bulk read, 6/7/8 write/commit) are NOT listed, so they fall through to "blocked" (profile memory).
  [FEATURE.onboardProfiles, s("onboard profiles", [0, 2, 4], [1])],
  // Analog keys (RAPID boards). Function indices are inferred from the agent's getter/setter pairs; all
  // are reversible settings, so SYNQ treats the setters as writes gated behind "Allow changes".
  [FEATURE.analogKeys, s("analog keys (actuation / rapid trigger)", [0, 3, 5], [2, 4, 6])],
]);

function classifyFrame(featureMap: ReadonlyMap<number, number>, report: OutgoingReport): Verdict {
  if (report.type !== "output") return blockVerdict("non-output report", "unknown", "HID++ requests are output reports.");
  const expected = LEN_BY_ID[report.reportId];
  if (expected === undefined) return blockVerdict("unknown report id", "unknown", `report id 0x${report.reportId.toString(16)} is not a HID++ report`);
  if (report.data.length !== expected) return blockVerdict("bad length", "unknown", `report 0x${report.reportId.toString(16)} is ${expected} bytes (got ${report.data.length})`);
  const deviceIndex = report.data[0];
  const featureIndex = report.data[1];
  const fn = (report.data[2] >> 4) & 0x0f;
  if (!okDeviceIndex(deviceIndex)) return blockVerdict("bad device index", "unknown", `device index 0x${deviceIndex.toString(16)} is not a cabled device or a receiver slot`);

  if (featureIndex === IROOT_INDEX) {
    if (fn === ROOT_FN.getFeature || fn === ROOT_FN.ping) return okVerdict("root query", "read");
    return blockVerdict("root function", "unknown", `IRoot function 0x${fn.toString(16)} is not a query`);
  }

  const featureId = featureMap.get(featureIndex);
  if (featureId === undefined) return blockVerdict("unresolved feature", "unknown", `feature index ${featureIndex} was not resolved through IRoot; SYNQ only talks to features it looked up`);
  const blocked = BLOCKED_FEATURES.get(featureId);
  if (blocked) return blockVerdict(blocked.what, blocked.why, `feature 0x${featureId.toString(16)} (${blocked.what}) is never sent`);
  const safe = SAFE_FEATURES.get(featureId);
  if (!safe) return blockVerdict("unlisted feature", "unknown", `feature 0x${featureId.toString(16)} is not on SYNQ's list of known-safe keyboard features`);
  if (safe.read.has(fn)) return okVerdict(`${safe.name} read`, "read");
  if (safe.write.has(fn)) return okVerdict(`${safe.name} write`, "write");
  return blockVerdict(`${safe.name} function 0x${fn.toString(16)}`, "unknown", `function 0x${fn.toString(16)} on feature 0x${featureId.toString(16)} is not one SYNQ uses`);
}

/** A guard bound to one device's resolved feature map. */
export class LogitechKbGuard implements CommandGuard {
  readonly #map: ReadonlyMap<number, number>;
  readonly blocked: readonly { what: string; why: BlockReason }[];
  constructor(featureMap: ReadonlyMap<number, number>) {
    this.#map = featureMap;
    this.blocked = [...BLOCKED_FEATURES.values()];
  }
  classify(report: OutgoingReport): Verdict {
    return classifyFrame(this.#map, report);
  }
}

/** A guard with no features resolved yet (only IRoot works). Used before load(). */
export const emptyGuard = (): LogitechKbGuard => new LogitechKbGuard(new Map());

/**
 * The feature map used to generate logitech-kb-frames.txt and the codec tests: a plausible PRO X TKL
 * RAPID layout where IRoot (0) is implicit and each safe/blocked feature gets a fixed index. The
 * desktop bridge builds the real map the same way (index = IRoot.GetFeature(id)) before trusting a
 * frame. Indices here are arbitrary but distinct.
 */
export const EXAMPLE_FEATURE_MAP: ReadonlyMap<number, number> = new Map([
  [0x01, FEATURE.featureSet],
  [0x02, FEATURE.firmwareInfo],
  [0x03, FEATURE.deviceName],
  [0x04, FEATURE.reportRate],
  [0x05, FEATURE.reportRateExt],
  [0x06, FEATURE.brightness],
  [0x07, FEATURE.rgbEffects],
  [0x08, FEATURE.perKeyLightingV2],
  [0x09, FEATURE.onboardProfiles],
  [0x0a, FEATURE.analogKeys],
  // dangerous features the device also exposes an index for — must stay blocked:
  [0x0b, 0x00d0], // DFU
  [0x0c, 0x1802], // device reset
  [0x0d, 0x1e00], // enable hidden features
  [0x0e, 0x1b30], // device mode
  [0x0f, 0x8101], // profile management
  [0x10, 0x1500], // force pairing
  [0x11, FEATURE.fullKeyCustomization], // remap
]);
