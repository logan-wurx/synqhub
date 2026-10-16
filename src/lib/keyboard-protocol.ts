// ROG Falchion Ace HFX ZywOo Edition (USB 0b05:1d1d, ASUS model M606) settings protocol.
// Captured from ASUS Gear Link 1.00.24 (gearlink.asus.com, WebHID) on 2026-10-11, firmware 1.00.03.
// Byte layouts are the ones Gear Link actually sent; see docs/keyboard/PROTOCOL.md and captures.json.
//
// Pure encode/decode only: every encoder returns one 64-byte Uint8Array to send as an OUTPUT report
// with report id 0 on the vendor interface (usage page 0xFF00, usage 0x01). The keyboard echoes every
// write verbatim on input report 0; wait for that echo before sending the next command. After a batch
// of writes send encodeSaveProfile() (50 55), as Gear Link does; that echo is slow (~100-270 ms).
// No transport code lives here.

export const REPORT_ID = 0;
export const REPORT_LENGTH = 64;

/**
 * Distances (actuation, dead zones, rapid trigger) travel in firmware units of `unitMm` mm. This
 * keyboard (and the Falchion Ace HFX, Gear Link manifest magKeyUnit 0.1) counts in 0.1 mm: 1.0 mm = 10.
 * Newer Gear Link HE boards (Azoth 96 HE, Falcata, Falchion Ace 75 HE, TX75, K4 Magnetic) use 0.01 mm;
 * their encoders live in src/lib/brands/asus/keyboard.ts and pass their unit here.
 */
export const HFX_UNIT_MM = 0.1;
/** The scale is rounded to an integer first, so the default is exactly Math.round(mm * 10) as before. */
export const mmToUnits = (mm: number, unitMm: number = HFX_UNIT_MM): number => Math.round(mm * Math.round(1 / unitMm));
export const unitsToMm = (units: number, unitMm: number = HFX_UNIT_MM): number => units / Math.round(1 / unitMm);

const byte = (v: number): number => {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError(`byte out of range: ${v}`);
  return v;
};
const u16 = (v: number): [number, number] => {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`u16 out of range: ${v}`);
  return [v & 0xff, (v >> 8) & 0xff];
};

/**
 * Generic frame: [cmd, sub, arg lo, arg hi, ...payload], zero padded to 64 bytes.
 * Matches Gear Link's makeCommand(cmd, sub, arg16, payload).
 */
export function frame(cmd: number, sub: number, arg = 0, payload: readonly number[] = []): Uint8Array {
  const out = new Uint8Array(REPORT_LENGTH);
  const bytes = [byte(cmd), byte(sub), ...u16(arg), ...payload.map(byte)];
  if (bytes.length > REPORT_LENGTH) throw new RangeError(`frame too long: ${bytes.length}`);
  out.set(bytes);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Command bytes
// ---------------------------------------------------------------------------------------------

export const CMD = {
  /** 12 xx: GetDeviceInfo (read). */
  getInfo: 0x12,
  /** 22 01: current touch-panel ("lever") mode (read). */
  getLever: 0x22,
  /** 25 xx: state reads. */
  getState: 0x25,
  /** 50 xx: profile maintenance (save / reset). */
  profile: 0x50,
  /** 51 xx: set parameter. */
  set: 0x51,
  /** 71 xx: touch-panel ("lever") configuration. */
  lever: 0x71,
} as const;

/** Second byte of 51 xx writes. */
export const SET = {
  profile: 0x00,
  keyRemap: 0x21,
  lighting: 0x2c,
  analogLighting: 0x2d,
  pollingRate: 0x31,
  keyActuation: 0x4f,
  globalActuation: 0x50,
  rapidTriggerKey: 0x54,
  speedTapPair: 0x55,
  speedTapEnable: 0x57,
  globalDeadZone: 0x58,
  keyDeadZone: 0x59,
} as const;

/** Second byte of 12 xx reads (Gear Link's DeviceInfo enum). */
export const INFO = {
  basic: 0x00,
  connectionType: 0x03,
  layout: 0x12,
  firmwareInfo: 0x14,
  wdlState: 0x16,
} as const;

// ---------------------------------------------------------------------------------------------
// Firmware key indices (IBM-style key position numbers), from Gear Link's NORMAL key table.
// Keys are KeyboardEvent.code names. Fn-layer bindings use FN_LAYER_OFFSET + index.
// ---------------------------------------------------------------------------------------------

export const FW_KEY = {
  Backquote: 1,
  Digit1: 2,
  Digit2: 3,
  Digit3: 4,
  Digit4: 5,
  Digit5: 6,
  Digit6: 7,
  Digit7: 8,
  Digit8: 9,
  Digit9: 10,
  Digit0: 11,
  Minus: 12,
  Equal: 13,
  IntlYen: 14,
  Backspace: 15,
  Tab: 16,
  KeyQ: 17,
  KeyW: 18,
  KeyE: 19,
  KeyR: 20,
  KeyT: 21,
  KeyY: 22,
  KeyU: 23,
  KeyI: 24,
  KeyO: 25,
  KeyP: 26,
  BracketLeft: 27,
  BracketRight: 28,
  Backslash: 29,
  CapsLock: 30,
  KeyA: 31,
  KeyS: 32,
  KeyD: 33,
  KeyF: 34,
  KeyG: 35,
  KeyH: 36,
  KeyJ: 37,
  KeyK: 38,
  KeyL: 39,
  Semicolon: 40,
  Quote: 41,
  UK_HashTilde: 42,
  Enter: 43,
  ShiftLeft: 44,
  IntlBackslash: 45,
  KeyZ: 46,
  KeyX: 47,
  KeyC: 48,
  KeyV: 49,
  KeyB: 50,
  KeyN: 51,
  KeyM: 52,
  Comma: 53,
  Period: 54,
  Slash: 55,
  Brazilian: 56,
  ShiftRight: 57,
  ControlLeft: 58,
  MetaLeft: 59,
  AltLeft: 60,
  Space: 61,
  AltRight: 62,
  ControlRight: 64,
  ContextMenu: 65,
  Insert: 75,
  Delete: 76,
  ArrowLeft: 79,
  Home: 80,
  End: 81,
  ArrowUp: 83,
  ArrowDown: 84,
  PageUp: 85,
  PageDown: 86,
  ArrowRight: 89,
  NumLock: 90,
  Numpad7: 91,
  Numpad4: 92,
  Numpad1: 93,
  NumpadDivide: 95,
  Numpad8: 96,
  Numpad5: 97,
  Numpad2: 98,
  Numpad0: 99,
  NumpadMultiply: 100,
  Numpad9: 101,
  Numpad6: 102,
  Numpad3: 103,
  NumpadDecimal: 104,
  NumpadSubtract: 105,
  NumpadAdd: 106,
  NumpadEnter: 108,
  Escape: 110,
  F1: 112,
  F2: 113,
  F3: 114,
  F4: 115,
  F5: 116,
  F6: 117,
  F7: 118,
  F8: 119,
  F9: 120,
  F10: 121,
  F11: 122,
  F12: 123,
  PrintScreen: 124,
  ScrollLock: 125,
  Pause: 126,
  NonConvert: 131,
  Convert: 132,
  KanaMode: 133,
  KP_Hanja: 150,
  KP_English: 151,
  FN: 159,
  ScreenLightingUp: 189,
  ScreenLightingDown: 190,
  ZoomIn: 199,
  ZoomOut: 200,
  WindowLock: 209,
  Brightness: 210,
  SpaceRight: 212,
} as const;

export type KeyName = keyof typeof FW_KEY;

/** Gear Link's Fn-layer key codes are 0x9F00 + the normal index (e.g. Fn_Digit1 = 0x9F02). */
export const FN_LAYER_OFFSET = 0x9f00;

/** Remap target that disables a key. */
export const KEY_DISABLED = 0;

export function fwKey(name: KeyName): number {
  return FW_KEY[name];
}

export function keyNameFromFw(index: number): KeyName | undefined {
  return (Object.keys(FW_KEY) as KeyName[]).find((k) => FW_KEY[k] === index);
}

// ---------------------------------------------------------------------------------------------
// Profiles and commit
// ---------------------------------------------------------------------------------------------

/** 50 55: save the current profile to flash. Gear Link sends it after every change. */
export const encodeSaveProfile = (): Uint8Array => frame(CMD.profile, 0x55);

/**
 * 50 40 00: reset the CURRENT profile to firmware defaults. Destructive. Gear Link's
 * "Sync Settings" sends it before rewriting each profile from its stored copy.
 */
export const encodeResetCurrentProfile = (): Uint8Array => frame(CMD.profile, 0x40, 0, [0]);

/** 51 00 00 00 nn: switch the active profile (Gear Link used 1..6; "Profile 1" = 1). */
export const encodeSelectProfile = (index: number): Uint8Array =>
  frame(CMD.set, SET.profile, 0, [index]);

// ---------------------------------------------------------------------------------------------
// Analog trigger: actuation and dead zones (0.1 mm units)
// ---------------------------------------------------------------------------------------------

/** 51 50 00 00 <u16 actuation>. Captured: 1.0 mm -> 51 50 00 00 0a, 2.0 mm -> 0x14. */
export const encodeGlobalActuation = (units: number): Uint8Array =>
  frame(CMD.set, SET.globalActuation, 0, u16(units));

/**
 * 51 4f 00 00 <u16 key> <u16 actuation>. Captured: P (0x1a) 0.5 mm -> 51 4f 00 00 1a 00 05.
 * To clear an override, send the global value for that key (Gear Link's "remove" does exactly
 * that, plus encodeKeyDeadZone with the global dead zones). Sending nothing leaves the old value.
 */
export const encodeKeyActuation = (key: number, units: number): Uint8Array =>
  frame(CMD.set, SET.keyActuation, 0, [...u16(key), ...u16(units)]);

/** 51 58 00 00 <bottom> <top>. Note the order: bottom first. Captured: top 0.4 -> 51 58 00 00 02 04. */
export const encodeGlobalDeadZone = (topUnits: number, bottomUnits: number): Uint8Array =>
  frame(CMD.set, SET.globalDeadZone, 0, [bottomUnits, topUnits]);

/** 51 59 00 00 <u16 key> <bottom> <top>. */
export const encodeKeyDeadZone = (key: number, topUnits: number, bottomUnits: number): Uint8Array =>
  frame(CMD.set, SET.keyDeadZone, 0, [...u16(key), bottomUnits, topUnits]);

// ---------------------------------------------------------------------------------------------
// Rapid trigger (per key; Gear Link's "global group" is the same command once per key)
// ---------------------------------------------------------------------------------------------

/** Byte 2 of 51 54: which sensitivity the value sets. */
export const RT_MODE = { combined: 0, press: 1, release: 2 } as const;
export type RapidTriggerMode = keyof typeof RT_MODE;

export interface RapidTriggerKey {
  key: number;
  mode: RapidTriggerMode;
  /** 0.1 mm units. */
  sensitivity: number;
  continuous: boolean;
  enabled: boolean;
}

/** 51 54 <mode> 00 <u16 key> <sensitivity> <continuous> <enabled>. */
export const encodeRapidTriggerKey = (rt: RapidTriggerKey): Uint8Array =>
  frame(CMD.set, SET.rapidTriggerKey, RT_MODE[rt.mode], [
    ...u16(rt.key),
    rt.sensitivity,
    rt.continuous ? 1 : 0,
    rt.enabled ? 1 : 0,
  ]);

export interface RapidTriggerSettings {
  /** Separate press/release values (two reports per key) or one combined value. */
  independent: boolean;
  /** Used when independent is false. 0.1 mm units. */
  sensitivity: number;
  press: number;
  release: number;
  continuous: boolean;
}

/**
 * The reports Gear Link sends for one key: [press, release] when independent, else [combined].
 * Pass enabled=false to switch rapid trigger off for a key; Gear Link never does this when a key is
 * dropped from the group (it just stops sending it), so that path is inferred, not captured.
 */
export function encodeRapidTriggerForKey(
  key: number,
  s: RapidTriggerSettings,
  enabled = true,
): Uint8Array[] {
  const base = { key, continuous: s.continuous, enabled };
  return s.independent
    ? [
        encodeRapidTriggerKey({ ...base, mode: "press", sensitivity: s.press }),
        encodeRapidTriggerKey({ ...base, mode: "release", sensitivity: s.release }),
      ]
    : [encodeRapidTriggerKey({ ...base, mode: "combined", sensitivity: s.sensitivity })];
}

// ---------------------------------------------------------------------------------------------
// Speed Tap (SOCD pair)
// ---------------------------------------------------------------------------------------------

/** 51 57 00 00 <0|1>. */
export const encodeSpeedTapEnable = (on: boolean): Uint8Array =>
  frame(CMD.set, SET.speedTapEnable, 0, [on ? 1 : 0]);

/** 51 55 00 00 <u16 key1> <u16 key2> <0|1>. Captured: A/D -> 51 55 00 00 1f 00 21 00 01. */
export const encodeSpeedTapPair = (key1: number, key2: number, enabled: boolean): Uint8Array =>
  frame(CMD.set, SET.speedTapPair, 0, [...u16(key1), ...u16(key2), enabled ? 1 : 0]);

// ---------------------------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------------------------

export const POLLING_RATE_INDEX = { 1000: 0, 2000: 1, 4000: 2, 8000: 3 } as const;
export type PollingRateHz = keyof typeof POLLING_RATE_INDEX;

/** 51 31 00 00 <index>. Captured: 8000 Hz -> 51 31 00 00 03. Gear Link's UI offers 1000 and 8000. */
export const encodePollingRate = (hz: PollingRateHz): Uint8Array =>
  frame(CMD.set, SET.pollingRate, 0, [POLLING_RATE_INDEX[hz]]);

// ---------------------------------------------------------------------------------------------
// Key assignment
// ---------------------------------------------------------------------------------------------

/**
 * 51 21 <u16 source> <u16 target> <actuation>. Bytes 2-3 hold the SOURCE key.
 * Captured: Insert -> ScrollLock = 51 21 4b 00 7d 00 0a; back to default = target = source.
 * actuationUnits is the key's actuation point (Gear Link sends the global value, 1.0 mm = 10).
 */
export const encodeKeyRemap = (source: number, target: number, actuationUnits = 10): Uint8Array =>
  frame(CMD.set, SET.keyRemap, source, [...u16(target), actuationUnits]);

// ---------------------------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------------------------

export const LIGHTING_EFFECT = {
  static: 0,
  breathing: 1,
  colorCycle: 2,
  reactive: 3,
  rainbow: 4,
  ripple: 5,
  starryNight: 6,
  quicksand: 7,
  current: 8,
  raindrop: 9,
} as const;
export type LightingEffect = keyof typeof LIGHTING_EFFECT;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface SimpleLighting {
  effect: Exclude<LightingEffect, "rainbow" | "ripple" | "quicksand">;
  /** Raw speed byte (Breathing "Normal" = 30; Static sends 255). */
  speed: number;
  /** 0-100 percent. */
  brightness: number;
  /** true = one colour, false = "Double" (two colours). */
  singleColor: boolean;
  randomColor: boolean;
  /** Up to two colours; missing ones are sent as black. */
  colors: Rgb[];
  /** Only some effects (Reactive, Starry Night...) use it; black otherwise. */
  background?: Rgb;
}

/**
 * 51 2c <u16 effect> <speed> <brightness> <flags> ff ff <rgb1> <rgb2> <rgb background>.
 * flags = (singleColor ? 0 : 1) << 4 | (random ? 1 : 0).
 * Captured: Breathing, double yellow/magenta, 100 %, Normal ->
 *   51 2c 01 00 1e 64 10 ff ff ff ff 00 ff 00 ff
 */
export function encodeSimpleLighting(l: SimpleLighting): Uint8Array {
  const flags = ((l.singleColor ? 0 : 1) << 4) | (l.randomColor ? 1 : 0);
  const colors = [...l.colors.slice(0, 2)];
  while (colors.length < 2) colors.push({ r: 0, g: 0, b: 0 });
  const bg = l.background ?? { r: 0, g: 0, b: 0 };
  return frame(CMD.set, SET.lighting, LIGHTING_EFFECT[l.effect], [
    l.speed,
    l.brightness,
    flags,
    0xff,
    0xff,
    ...colors.flatMap((c) => [c.r, c.g, c.b]),
    bg.r,
    bg.g,
    bg.b,
  ]);
}

export interface GradientStop extends Rgb {
  /** 0-100 position along the gradient. */
  location: number;
}

export interface GradientLighting {
  effect: "rainbow" | "ripple";
  speed: number;
  brightness: number;
  randomColor: boolean;
  /** Rainbow only (0 in the capture); Ripple sends 0. */
  direction: number;
  width: number;
  /** Gear Link always sends 7 stops. */
  stops: GradientStop[];
}

/**
 * Rainbow / Ripple are split over three 51 2c reports. Byte 3 counts down (2, 1, 0).
 * Report 2: speed, brightness, random, direction, width, stop count, first 2 stops;
 * report 1: next 4 stops; report 0: the rest. A stop is [location, r, g, b].
 * Reproduces the Sync capture byte for byte.
 */
export function encodeGradientLighting(l: GradientLighting): Uint8Array[] {
  const stops = l.stops.map((s) => [s.location, s.r, s.g, s.b]);
  const type = LIGHTING_EFFECT[l.effect];
  const first = [l.speed, l.brightness, l.randomColor ? 1 : 0, l.direction, l.width, stops.length];
  const chunks = [stops.slice(0, 2), stops.slice(2, 6), stops.slice(6)];
  return chunks.map((chunk, i) => {
    const payload = (i === 0 ? first : []).concat(chunk.flat());
    const remaining = chunks.length - 1 - i;
    return frame(CMD.set, SET.lighting, type | (remaining << 8), payload);
  });
}

/**
 * 51 2d 00 00 <effect> <0|1>: the "Analog Effect" toggle (lighting follows key travel).
 * Captured only with the toggle off: 51 2d 00 00 00 / 02 / 04 for Static, Color cycle, Rainbow.
 */
export const encodeAnalogLighting = (effect: LightingEffect, on: boolean): Uint8Array =>
  frame(CMD.set, SET.analogLighting, 0, [LIGHTING_EFFECT[effect], on ? 1 : 0]);

// ---------------------------------------------------------------------------------------------
// Touch panel ("lever"), as written by Sync Settings
// ---------------------------------------------------------------------------------------------

/** 71 00 00 00 <lever function 0-4> <0|1>. Sync enables all five. */
export const encodeTouchPanelFunctionEnable = (fn: number, on: boolean): Uint8Array =>
  frame(CMD.lever, 0x00, 0, [fn, on ? 1 : 0]);

/** 71 02 00 00 <mode>. Profile 1 uses mode 4. */
export const encodeTouchPanelMode = (mode: number): Uint8Array => frame(CMD.lever, 0x02, 0, [mode]);

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** 12 <type> <sub>: device info. 12 14 02 returns the serial number. */
export const encodeGetInfo = (type: number, sub = 0): Uint8Array => frame(CMD.getInfo, type, sub);
export const encodeGetSerial = (): Uint8Array => encodeGetInfo(INFO.firmwareInfo, 2);
/** 25 00: rapid trigger mode (toggled on the keyboard itself). */
export const encodeGetRapidTriggerState = (): Uint8Array => frame(CMD.getState, 0x00);
/** 25 01: Speed Tap on/off. */
export const encodeGetSpeedTapState = (): Uint8Array => frame(CMD.getState, 0x01);
/** 22 01: current touch-panel mode. */
export const encodeGetTouchPanelMode = (): Uint8Array => frame(CMD.getLever, 0x01);

export interface BasicInfo {
  firmware: string;
  profiles: number;
  currentLightingEffect: number;
  currentProfile: number;
  alive: boolean;
}

/** Reply to 12 00: 12 00 00 00 03 00 01 00 06 01 01 -> fw 1.00.03, 6 profiles, effect 1, profile 1. */
export function decodeBasicInfo(r: Uint8Array): BasicInfo {
  const v = r[4] | (r[5] << 8) | (r[6] << 16) | (r[7] << 24);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return {
    firmware: `${((v >> 16) & 0xff).toString(16)}.${hex((v >> 8) & 0xff)}.${hex(v & 0xff)}`,
    profiles: r[8],
    currentLightingEffect: r[9],
    currentProfile: r[10],
    alive: r[11] !== 0,
  };
}

/** Reply to 12 12: [4] layout type (1 here), [5] nation (1 = CA here). */
export const decodeLayout = (r: Uint8Array) => ({ layoutType: r[4], nation: r[5] });

/** Reply to 12 14 02: ASCII from byte 4 up to the first zero. */
export function decodeSerial(r: Uint8Array): string {
  let s = "";
  for (let i = 4; i < r.length && r[i] !== 0; i++) s += String.fromCharCode(r[i]);
  return s;
}

/** Replies to 25 00 / 25 01 / 22 01 carry the value in byte 4. */
export const decodeStateByte = (r: Uint8Array): number => r[4];

/** Does this input report echo the command we sent (same 64 bytes)? */
export function isEcho(sent: Uint8Array, received: Uint8Array): boolean {
  if (received.length < sent.length) return false;
  for (let i = 0; i < sent.length; i++) if (sent[i] !== received[i]) return false;
  return true;
}

/** Reply to a read: same first two bytes. */
export const isReplyTo = (sent: Uint8Array, received: Uint8Array): boolean =>
  received[0] === sent[0] && received[1] === sent[1];

/** The keyboard answers FF AA to commands it does not support (e.g. 7d 20 01). */
export const isRejected = (r: Uint8Array): boolean => r[0] === 0xff && r[1] === 0xaa;

export type KeyboardHidEvent =
  | { kind: "rapidTriggerMode"; enabled: boolean }
  | { kind: "touchPanelMode"; mode: number }
  | { kind: "keyBitmap" }
  | { kind: "unknown"; bytes: Uint8Array };

/** Input report 3 on the event interface (usage page 0xFFC0). */
export function decodeEventReport(r: Uint8Array): KeyboardHidEvent {
  switch (r[0]) {
    case 0x76:
      return { kind: "rapidTriggerMode", enabled: r[3] === 1 };
    case 0x91:
      return { kind: "touchPanelMode", mode: r[3] };
    case 0x71:
      return { kind: "keyBitmap" };
    default:
      return { kind: "unknown", bytes: r };
  }
}
