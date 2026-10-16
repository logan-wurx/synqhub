// Keychron's raw-HID extension of VIA, as far as SYNQ uses it: the 0xA0 family beside VIA's own commands on the
// QMK raw-HID collection (0xFF60:0x61, 32-byte reports, no report id), and the 0xA9 analog-matrix commands of the
// Hall-effect boards. Pure codec: no device access.
//
// Source: Keychron's published QMK firmware (github.com/Keychron/qmk_firmware, branch 2025q3, commit
// c5d998442710b38650903937249144a0cd728ebe, GPL-2.0-or-later): keyboards/keychron/common/keychron_raw_hid.c and .h
// (the 0xA0..0xAB command ids, the feature bits), analog_matrix/analog_matrix.c (`analog_matrix_rx`: the 0xA9
// sub-commands and their byte layouts), analog_matrix_type.h (the packed profile structs), profile.c and
// analog_matrix_eeconfig.h (what a command checks, how a profile is sized). SYNQ is AGPL-3.0; GPL-2.0-or-later code
// may be combined with it. Nothing here was run against a keyboard: the byte layouts are read from the firmware.
//
// What a request and its reply look like (32 bytes, data[0] is the command, data[1] the sub-command):
//   0xA0               protocol version: reply [A0, 02, 00, 02]
//   0xA1               firmware version: reply [A1, "v1.2.3 <build date>" as text]
//   0xA2               supported features: reply [A2, 00, bitmask low (0x08 = analog matrix), bitmask high]
//   0xA7 0x01          misc protocol version
//   0xA9 0x01          analog protocol version: reply [A9, 01, version low byte]
//   0xA9 0x10          profiles: reply [A9, 10, current, count, size lo, size hi, OKMC count, SOCD count]
//   0xA9 0x12 i lo hi n  raw profile bytes: reply [A9, 12, i, lo, hi, n, data...] (n <= 26)
//   0xA9 0x14 ...      set travel (see travelFrame): reply byte 2 = 0 when it took
//   0xA9 0x1F i        save profile i to EEPROM: reply byte 2 = 0 when it took
// Travel is in 0.1 mm units (full travel 40). A profile is the packed struct analog_matrix_profile_t: a global
// configuration, one 4-byte configuration per matrix key, the advanced-key tables, a 30-byte name and a CRC.

export const FRAME_LEN = 32;

/** Command ids beside VIA's (keychron_raw_hid.h). */
export const KC = {
  protocolVersion: 0xa0,
  firmwareVersion: 0xa1,
  supportFeature: 0xa2,
  defaultLayer: 0xa3,
  misc: 0xa7,
  rgb: 0xa8,
  analog: 0xa9,
  wirelessDfu: 0xaa,
  factoryTest: 0xab,
} as const;

/** Bits of the first byte of the feature mask (0xA2 reply byte 2). */
export const FEATURE = { defaultLayer: 0x01, bluetooth: 0x02, p24g: 0x04, analogMatrix: 0x08, stateNotify: 0x10, dynamicDebounce: 0x20, snapClick: 0x40, keychronRgb: 0x80 } as const;

/** 0xA7 sub-commands (the ones named; only MISC_GET_PROTOCOL_VER is ever sent). */
export const MISC = { getProtocolVer: 0x01, dfuInfoGet: 0x02, factoryReset: 0x11 } as const;

/** 0xA9 sub-commands (analog_matrix.c `AMC_*`). */
export const AMC = {
  getVersion: 0x01,
  getProfilesInfo: 0x10,
  selectProfile: 0x11,
  getProfileRaw: 0x12,
  setProfileName: 0x13,
  setTravel: 0x14,
  setAdvanceMode: 0x15,
  setSocd: 0x16,
  resetProfile: 0x1e,
  saveProfile: 0x1f,
  getCurve: 0x20,
  setCurve: 0x21,
  getGameControllerMode: 0x22,
  setGameControllerMode: 0x23,
  getRealtimeTravel: 0x30,
  calibrate: 0x40,
  getCalibrateState: 0x41,
  getCalibratedValue: 0x42,
} as const;

/** Analog key modes (analog_matrix_type.h AKM_*). A key's own mode is 0 (follow the profile's), 1 or 2. */
export const AKM = { global: 0, regular: 1, rapid: 2 } as const;
export type KeyMode = (typeof AKM)[keyof typeof AKM];

/** Units of travel per mm, and the most a configuration may hold (profile.c: act_pt > 39 is refused). */
export const UNITS_PER_MM = 10;
export const MAX_UNITS = 39;
/** The most raw bytes one 0x12 reply carries (32 - 6). */
export const RAW_CHUNK = 26;
/** Profiles the firmware may have (PROFILE_COUNT is 3 on the shipped boards). */
export const MAX_PROFILES = 8;
/** Sizes of the profile's parts (analog_matrix_eeconfig.h). */
export const KEY_CONFIG_BYTES = 4;
export const OKMC_BYTES = 19;
export const SOCD_BYTES = 3;
export const NAME_BYTES = 30;
export const CRC_BYTES = 2;

const frame = (...bytes: number[]): Uint8Array => {
  const f = new Uint8Array(FRAME_LEN);
  f.set(bytes);
  return f;
};

export const protocolVersionFrame = (): Uint8Array => frame(KC.protocolVersion);
export const firmwareVersionFrame = (): Uint8Array => frame(KC.firmwareVersion);
export const supportFeatureFrame = (): Uint8Array => frame(KC.supportFeature);
export const miscVersionFrame = (): Uint8Array => frame(KC.misc, MISC.getProtocolVer);
export const analogVersionFrame = (): Uint8Array => frame(KC.analog, AMC.getVersion);
export const profilesInfoFrame = (): Uint8Array => frame(KC.analog, AMC.getProfilesInfo);

/** Reads `size` (1..26) raw bytes of profile `profile` from `offset`. */
export function profileRawFrame(profile: number, offset: number, size: number): Uint8Array {
  if (!Number.isInteger(profile) || profile < 0 || profile >= MAX_PROFILES) throw new RangeError("profile out of range");
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffff) throw new RangeError("offset out of range");
  if (!Number.isInteger(size) || size < 1 || size > RAW_CHUNK) throw new RangeError(`a read moves 1..${RAW_CHUNK} bytes`);
  return frame(KC.analog, AMC.getProfileRaw, profile, offset & 0xff, offset >> 8, size);
}

/** Saves profile `profile` to the keyboard's EEPROM. */
export function saveProfileFrame(profile: number): Uint8Array {
  if (!Number.isInteger(profile) || profile < 0 || profile >= MAX_PROFILES) throw new RangeError("profile out of range");
  return frame(KC.analog, AMC.saveProfile, profile);
}

export interface TravelSet {
  profile: number;
  /** 0 follows the profile (per key only), 1 regular, 2 rapid trigger. */
  mode: KeyMode;
  /** Actuation point, 0.1 mm units (0 follows the profile for a key). */
  act: number;
  /** Rapid-trigger press sensitivity, 0.1 mm units (0 follows the profile for a key). */
  sens: number;
  /** Rapid-trigger release sensitivity, 0.1 mm units (0 follows the profile for a key). */
  rls: number;
}

/**
 * 0xA9 0x14: [A9, 14, profile, mode, act, sens, rls, entire, row masks (3 bytes per row, bit = column)...]. With
 * `entire` the profile's own (global) configuration is set; otherwise every key whose bit is set in `masks` gets
 * this mode, actuation and sensitivities (all four fields are written to each, so callers send what a key should keep).
 */
export function travelFrame(t: TravelSet, masks: readonly number[] | "entire"): Uint8Array {
  if (!Number.isInteger(t.profile) || t.profile < 0 || t.profile >= MAX_PROFILES) throw new RangeError("profile out of range");
  if (![0, 1, 2].includes(t.mode)) throw new RangeError("mode must be 0, 1 or 2");
  for (const v of [t.act, t.sens, t.rls]) if (!Number.isInteger(v) || v < 0 || v > MAX_UNITS) throw new RangeError(`travel units must be 0..${MAX_UNITS}`);
  const f = frame(KC.analog, AMC.setTravel, t.profile, t.mode, t.act, t.sens, t.rls, masks === "entire" ? 1 : 0);
  if (masks !== "entire") {
    if (masks.length > 8) throw new RangeError("at most 8 rows");
    masks.forEach((m, r) => {
      if (!Number.isInteger(m) || m < 0 || m > 0xffffff) throw new RangeError("a row mask is 24 bits");
      f[8 + r * 3] = m & 0xff;
      f[9 + r * 3] = (m >> 8) & 0xff;
      f[10 + r * 3] = (m >> 16) & 0xff;
    });
  }
  return f;
}

// ---------------------------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------------------------

/** Whether `reply` is the answer to `request`: the same command and sub-command (QMK echoes both; 0xFF = unhandled). */
export function answers(request: Uint8Array, reply: Uint8Array): boolean {
  if (reply[0] === 0xff) return true;
  if (reply[0] !== request[0]) return false;
  return request[0] === KC.analog || request[0] === KC.misc ? reply[1] === request[1] : true;
}

export const unhandled = (reply: Uint8Array): boolean => reply[0] === 0xff;

export interface KcInfo {
  protocolVersion: number;
  commandSet: number;
}
export const decodeProtocolVersion = (r: Uint8Array): KcInfo => ({ protocolVersion: r[1], commandSet: r[3] });

/** The firmware text, e.g. "v1.3.1 2025 Mar 10 11:07:56" (NUL ends it). */
export function decodeFirmware(r: Uint8Array): string {
  let end = 1;
  while (end < r.length && r[end] !== 0) end++;
  return new TextDecoder().decode(r.subarray(1, end)).trim();
}

export const decodeFeatures = (r: Uint8Array): { analogMatrix: boolean; mask: number } => ({ analogMatrix: (r[2] & FEATURE.analogMatrix) !== 0, mask: r[2] | (r[3] << 8) });

export interface ProfilesInfo {
  current: number;
  count: number;
  /** Bytes in one profile. */
  size: number;
  okmcCount: number;
  socdCount: number;
}
export const decodeProfilesInfo = (r: Uint8Array): ProfilesInfo => ({ current: r[2], count: r[3], size: r[4] | (r[5] << 8), okmcCount: r[6], socdCount: r[7] });

/** The matrix size a profile of `size` bytes implies, or null when the arithmetic doesn't close (rows * cols keys). */
export function keysInProfile(info: ProfilesInfo): number | null {
  const rest = info.size - CRC_BYTES - NAME_BYTES - OKMC_BYTES * info.okmcCount - SOCD_BYTES * info.socdCount - KEY_CONFIG_BYTES;
  return rest > 0 && rest % KEY_CONFIG_BYTES === 0 ? rest / KEY_CONFIG_BYTES : null;
}

export interface ProfileLayout {
  keys: number;
  /** Offset of key (row, col) configuration. */
  keyAt(row: number, col: number, cols: number): number;
  nameAt: number;
  nameLength: number;
}
export function profileLayout(info: ProfilesInfo): ProfileLayout | null {
  const keys = keysInProfile(info);
  if (keys === null) return null;
  const nameAt = KEY_CONFIG_BYTES + KEY_CONFIG_BYTES * keys + OKMC_BYTES * info.okmcCount + SOCD_BYTES * info.socdCount;
  return { keys, keyAt: (row, col, cols) => KEY_CONFIG_BYTES + KEY_CONFIG_BYTES * (row * cols + col), nameAt, nameLength: NAME_BYTES };
}

/** The reply to a raw profile read: the bytes, once its echo names the request. */
export function decodeProfileRaw(request: Uint8Array, reply: Uint8Array): Uint8Array | null {
  if (reply[0] !== KC.analog || reply[1] !== AMC.getProfileRaw) return null;
  for (let i = 2; i < 6; i++) if (reply[i] !== request[i]) return null;
  return reply.slice(6, 6 + request[5]);
}

/** Result byte of a set / save: the firmware writes 0 for success and 1 for failure into byte 2. */
export const tookEffect = (reply: Uint8Array): boolean => reply[0] === KC.analog && reply[2] === 0;

/** analog_key_config_t: mode:2, act_pt:6 | rpd_trig_sen:6, rpd_trig_sen_deact:6, adv_mode:4 | adv_mode_data. */
export interface KeyConfig {
  mode: KeyMode;
  act: number;
  sens: number;
  rls: number;
  /** Advanced-key mode (dynamic keystroke, game controller axis, toggle): 0 for none. */
  adv: number;
  advData: number;
}
export function decodeKeyConfig(b: ArrayLike<number>, at = 0): KeyConfig {
  const v = b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
  return { mode: (v & 3) as KeyMode, act: (v >> 2) & 63, sens: (v >> 8) & 63, rls: (v >> 14) & 63, adv: (v >> 20) & 15, advData: b[at + 3] };
}
export function encodeKeyConfig(c: KeyConfig): [number, number, number, number] {
  const v = (c.mode & 3) | ((c.act & 63) << 2) | ((c.sens & 63) << 8) | ((c.rls & 63) << 14) | ((c.adv & 15) << 20);
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, c.advData & 0xff];
}

/** The text of a profile name (NUL ends it). */
export function decodeName(b: Uint8Array): string {
  let end = 0;
  while (end < b.length && b[end] !== 0) end++;
  return new TextDecoder().decode(b.subarray(0, end)).trim();
}

export const mmOf = (units: number): number => Math.round(units * 100) / 1000;
export const unitsOf = (mm: number): number => Math.round(mm * UNITS_PER_MM + 1e-9);

/** A row's mask with one bit per listed column. */
export function maskFor(cols: readonly number[]): number {
  let m = 0;
  for (const c of cols) m |= 1 << c;
  return m >>> 0;
}
