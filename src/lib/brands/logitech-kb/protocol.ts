// Logitech G keyboards over HID++ 2.0 — transport-agnostic encode/decode, no device access.
//
// HID++ 2.0 is a request/answer protocol on the vendor collection (usage page 0xFF00). A request is
//   [deviceIndex, featureIndex, (function << 4) | softwareId, ...params]
// and the device answers on the same report id, echoing byte0..byte2. Feature IDs (0x0003, 0x8060,
// 0x1B08…) are NOT fixed indices: the host first asks IRoot (always feature index 0x00) for the
// index of a feature ID, then addresses that index. So the only safe thing a static table can key on
// is the *resolved* feature index, which the session learns during load() and hands to the guard
// (see guard.ts); this module just builds and reads frames.
//
// Sources (nothing was sent to a keyboard; files read as data):
//   [agent]   G HUB lghub_agent.exe (build 2026.6.981214) RTTI + log strings:
//             devio::Feature1B08AnalogKeys::_getRapidTriggerState / _setRapidTriggerState /
//             _setKeyTravelEventsState / _get|_setKeyPriorityState; Feature0005DeviceName,
//             Feature0003FirmwareInfo, Feature8060/8061, Feature8040Brightness, Feature8102 profiles.
//   [solaar]  pwr-Solaar/Solaar (GPL-2.0-or-later, read for cross-check, not copied) settings_templates.py:
//             REPORT_RATE 0x00/0x10/0x20, EXTENDED_ADJUSTABLE_REPORT_RATE 0x10/0x20/0x30,
//             BRIGHTNESS_CONTROL 0x10/0x20, ONBOARD_PROFILES get mode 0x20 / set 0x10.
//   [ui]      G HUB app.asar app.min.js: capability model analogSupport.supportedAnalogFeatures
//             ("ACTUATION_POINT","RAPID_TRIGGER","MULTI_ACTION"), keyTravelConfig.actuationPoint
//             {minimum,maximum,step,decimalLength}.
//   [openmouse] @openmouse/protocol drivers/logitech/hidpp.js: FEATURE.analogButtons = 0x1b0c, the
//             HID++ short/long report framing (reused here for the keyboard features).
//
// Confidence per field is marked [confirmed] (Solaar/OpenMouse code or agent symbol), [inferred]
// (follows from the model but no byte capture), or [needs-device]. Erasable TS, node runs it directly.

export const HIDPP = {
  vendorId: 0x046d,
  /** HID++ vendor collection. The short/long/very-long reports all live under it. [openmouse][agent] */
  usagePage: 0xff00,
  /** usage 0x0001 = short-report collection, 0x0002 = long-report collection. [openmouse] */
  usageShort: 0x0001,
  usageLong: 0x0002,
} as const;

/** HID++ report ids and their data length (bytes after the report id). [openmouse hidpp.js] */
export const REPORT = {
  short: { id: 0x10, len: 6 },
  long: { id: 0x11, len: 19 },
  /** HID++ 2.0 "very long", used by lighting/profile bulk transfers. [agent Feature8081/8101] */
  veryLong: { id: 0x12, len: 63 },
} as const;

export type ReportName = keyof typeof REPORT;

/** Our software id (low nibble of byte 2). 0x0b keeps our replies apart from G HUB's own (0x05). */
export const SOFTWARE_ID = 0x0b;

/** The always-present features at fixed indices / well-known IDs. */
export const FEATURE = {
  root: 0x0000,
  featureSet: 0x0001,
  firmwareInfo: 0x0003,
  deviceName: 0x0005,
  // The settings SYNQ reads and writes.
  reportRate: 0x8060, // [solaar]
  reportRateExt: 0x8061, // [solaar]
  brightness: 0x8040, // [solaar]
  colorLedEffects: 0x8070, // [solaar]
  rgbEffects: 0x8071, // [solaar]
  perKeyLighting: 0x8080, // [agent]
  perKeyLightingV2: 0x8081, // [agent]
  onboardProfiles: 0x8100, // [solaar]
  profileManagement: 0x8101, // [agent Feature8102ProfileManagement wraps 0x8101]
  analogKeys: 0x1b08, // [agent Feature1B08AnalogKeys] — the RAPID boards' actuation/rapid-trigger
  analogButtons: 0x1b0c, // [openmouse] mouse analog buttons; keyboards don't use it
  fullKeyCustomization: 0x1b05, // [agent]
} as const;

/** IRoot (index 0x00) function 0x00 = GetFeature(featureId), function 0x01 = GetProtocolVersion (ping). */
export const ROOT_FN = { getFeature: 0x00, ping: 0x01 } as const;

export const IROOT_INDEX = 0x00;

// ---------------------------------------------------------------------------------------------
// Frame building
// ---------------------------------------------------------------------------------------------

export type HidppFrame = {
  report: ReportName;
  /** The report id byte (0x10/0x11/0x12). */
  reportId: number;
  /** Payload WITHOUT the report id, zero-padded to the report length. */
  data: Uint8Array;
};

const byte2 = (fn: number) => ((fn & 0x0f) << 4) | (SOFTWARE_ID & 0x0f);

/** Build one HID++ request. params fills bytes from offset 3; rest is zero-padded. */
export function frame(report: ReportName, deviceIndex: number, featureIndex: number, fn: number, params: ArrayLike<number> = []): HidppFrame {
  const spec = REPORT[report];
  if (deviceIndex < 0 || deviceIndex > 0xff) throw new RangeError(`device index ${deviceIndex}`);
  if (featureIndex < 0 || featureIndex > 0xff) throw new RangeError(`feature index ${featureIndex}`);
  if (fn < 0 || fn > 0x0f) throw new RangeError(`function ${fn}`);
  const data = new Uint8Array(spec.len);
  data[0] = deviceIndex;
  data[1] = featureIndex;
  data[2] = byte2(fn);
  if (params.length > spec.len - 3) throw new RangeError(`${params.length} params exceed ${report} report`);
  for (let i = 0; i < params.length; i++) data[3 + i] = params[i] & 0xff;
  return { report, reportId: spec.id, data };
}

/** IRoot.GetFeature(featureId): resolve a feature ID to its device feature index. A pure read. [solaar] */
export const getFeature = (deviceIndex: number, featureId: number): HidppFrame =>
  frame("long", deviceIndex, IROOT_INDEX, ROOT_FN.getFeature, [(featureId >> 8) & 0xff, featureId & 0xff]);

/** IRoot ping (GetProtocolVersion), changes nothing. byte2 becomes 0x1b. [logitech-ping.ts] */
export const ping = (deviceIndex: number, marker = 0xa5): HidppFrame => frame("short", deviceIndex, IROOT_INDEX, ROOT_FN.ping, [0, 0, marker]);

// Function *indices* (0..15). Byte 2 of the frame = (index << 4) | softwareId, so Solaar's "fnid 0x10"
// is index 1 here, "0x20" is index 2, and so on.
export const FN = {
  f0: 0x0,
  f1: 0x1,
  f2: 0x2,
  f3: 0x3,
  f4: 0x4,
  f5: 0x5,
  f6: 0x6,
} as const;

// ---- reads (safe) ---------------------------------------------------------------------------

/** 0x0003 GetDeviceInfo (fn 0); the device answers on a long report. [agent Feature0003FirmwareInfo] */
export const fwGetInfo = (d: number, idx: number): HidppFrame => frame("long", d, idx, FN.f0);
/** 0x0003 GetFwInfo(entity) (fn 1); long reply carries name + version bytes. [agent] */
export const fwGetEntry = (d: number, idx: number, entity: number): HidppFrame => frame("long", d, idx, FN.f1, [entity]);
/** 0x0005 GetCount (fn 0). [agent Feature0005DeviceName] */
export const nameGetCount = (d: number, idx: number): HidppFrame => frame("short", d, idx, FN.f0);
/** 0x0005 GetDeviceName(offset) (fn 1). [agent] */
export const nameGetChunk = (d: number, idx: number, offset: number): HidppFrame => frame("short", d, idx, FN.f1, [offset & 0xff]);
/** 0x8060 GetReportRateList (fn 0) / GetReportRate (fn 1). [solaar read_fnid 0x00/0x10] */
export const rateGetList = (d: number, idx: number): HidppFrame => frame("short", d, idx, FN.f0);
export const rateGet = (d: number, idx: number): HidppFrame => frame("short", d, idx, FN.f1);
/** 0x8061 GetReportRateList (fn 1) / GetReportRate (fn 2). [solaar read_fnid 0x10/0x20] */
export const rateExtGetList = (d: number, idx: number): HidppFrame => frame("short", d, idx, FN.f1);
export const rateExtGet = (d: number, idx: number): HidppFrame => frame("short", d, idx, FN.f2);
/** 0x8040 GetBrightnessInfo (fn 0) / GetBrightness (fn 1). [solaar read_fnid 0x10 + getInfo] */
export const brightnessGetInfo = (d: number, idx: number): HidppFrame => frame("short", d, idx, FN.f0);
export const brightnessGet = (d: number, idx: number): HidppFrame => frame("short", d, idx, FN.f1);
/** 0x8100 GetOnboardProfilesInfo (fn 0) / GetOnboardMode (fn 2) / GetCurrentProfile (fn 4). [solaar] */
export const onboardGetInfo = (d: number, idx: number): HidppFrame => frame("short", d, idx, FN.f0);
export const onboardGetMode = (d: number, idx: number): HidppFrame => frame("short", d, idx, FN.f2);
export const onboardGetProfile = (d: number, idx: number): HidppFrame => frame("short", d, idx, FN.f4);
/** 0x1B08 GetRapidTriggerState (fn 3) / GetKeyPriorityState (fn 5). Function ids [inferred] from the
 *  agent's getter/setter pairing; the reply byte layout is [needs-device]. */
export const analogGetRapidTrigger = (d: number, idx: number): HidppFrame => frame("short", d, idx, FN.f3);
export const analogGetKeyPriority = (d: number, idx: number): HidppFrame => frame("short", d, idx, FN.f5);

// ---- writes (gated; "write" verdict) --------------------------------------------------------

/** 0x8060 SetReportRate(code) (fn 2). code is a 1..8 ms index. [solaar write_fnid 0x20] */
export const rateSet = (d: number, idx: number, code: number): HidppFrame => frame("short", d, idx, FN.f2, [checkByte("report rate", code, 1, 8)]);
/** 0x8061 SetReportRate(code) (fn 3). code 0..6 (8ms..125us). [solaar write_fnid 0x30] */
export const rateExtSet = (d: number, idx: number, code: number): HidppFrame => frame("short", d, idx, FN.f3, [checkByte("report rate", code, 0, 6)]);
/** 0x8040 SetBrightness(value16) (fn 2), big-endian. [solaar write_fnid 0x20] */
export const brightnessSet = (d: number, idx: number, value: number): HidppFrame => {
  const v = checkRange("brightness", value, 0, 0xffff);
  return frame("short", d, idx, FN.f2, [(v >> 8) & 0xff, v & 0xff]);
};
/** 0x8100 SetOnboardMode(mode) (fn 1); 0x01 = onboard memory, 0x02 = host/SW. [solaar write 0x10] */
export const onboardSetMode = (d: number, idx: number, mode: number): HidppFrame => frame("short", d, idx, FN.f1, [checkByte("onboard mode", mode, 1, 2)]);
/** 0x1B08 SetRapidTriggerState(enabled) (fn 4). Function id [inferred]; param [inferred] 0/1. */
export const analogSetRapidTrigger = (d: number, idx: number, on: boolean): HidppFrame => frame("short", d, idx, FN.f4, [on ? 1 : 0]);
/** 0x1B08 SetKeyTravelEventsState(enabled) (fn 2) — arms travel-change notifications. [agent fn-pair inferred] */
export const analogSetTravelEvents = (d: number, idx: number, on: boolean): HidppFrame => frame("short", d, idx, FN.f2, [on ? 1 : 0]);
/** 0x1B08 SetKeyPriorityState(enabled) (fn 6). [agent fn-pair inferred] */
export const analogSetKeyPriority = (d: number, idx: number, on: boolean): HidppFrame => frame("short", d, idx, FN.f6, [on ? 1 : 0]);

// ---------------------------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------------------------

/** HID++ 2.0 error report: [index, 0xFF, feature, fn|sw, errorCode]. */
export function parseError(data: Uint8Array): { featureIndex: number; fn: number; code: number } | null {
  if (data[1] !== 0xff) return null;
  return { featureIndex: data[2], fn: (data[3] >> 4) & 0x0f, code: data[4] };
}

/** True when `reply` answers `req` (same device, feature, function; not an error). */
export function isAnswer(req: HidppFrame, reply: Uint8Array): boolean {
  if (parseError(reply)) return false;
  return reply[0] === req.data[0] && reply[1] === req.data[1] && (reply[2] & 0xf0) === (req.data[2] & 0xf0);
}

/** IRoot.GetFeature reply -> { index, type } (type bit5 = hidden, bit7 = obsolete). [solaar] */
export function parseGetFeature(reply: Uint8Array): { index: number; type: number } {
  return { index: reply[3], type: reply[4] };
}

export const u16be = (f: ArrayLike<number>, at: number): number => ((f[at] << 8) | f[at + 1]) >>> 0;

export function checkByte(label: string, v: number, lo: number, hi: number): number {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${label} ${v} outside ${lo}..${hi}`);
  return v;
}
export function checkRange(label: string, v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v) || v < lo || v > hi) throw new RangeError(`${label} ${v} outside ${lo}..${hi}`);
  return Math.round(v);
}

export const hex = (b: ArrayLike<number>, sep = " "): string => Array.from(b, (x) => (x & 0xff).toString(16).padStart(2, "0")).join(sep);
