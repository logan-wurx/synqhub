// The exact reports SYNQ sends to a controller in wave C1, and nothing else: Sony's volatile outputs (lightbar,
// player LEDs, mic LED, rumble, the adaptive-trigger test), Nintendo's allowlisted subcommands and two rumble frames.
// guard.ts checks every one of them again (and src-tauri/src/pads.rs in the bridge), against the same fixtures
// (src-tauri/src/pad-frames.txt, written by scripts/pad-fixtures.ts).
//
// Layouts: Linux hid-playstation and hid-nintendo (GPL-2.0+), SDL's PS4 / PS5 / Switch HIDAPI drivers and its
// testcontroller (zlib). `data` never includes the report id (WebHID's sendReport takes the id apart).
//
// Pure functions: no DOM, no React, no device access.

// ---- CRC-32 (IEEE, reflected): DualSense and DualShock 4 Bluetooth reports end in one, seeded with the HID header.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 over `bytes`, continuing from `crc` (start with 0). */
export function crc32(bytes: ArrayLike<number>, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** HID header byte that is part of a Sony Bluetooth output report's CRC ("a2": DATA | OUTPUT). */
export const BT_OUTPUT_SEED = 0xa2;

/** The CRC a Sony Bluetooth output report carries in its last 4 bytes: over the header byte, the id and the data. */
export function sonyBtCrc(reportId: number, dataWithoutCrc: ArrayLike<number>): number {
  return crc32(dataWithoutCrc, crc32([BT_OUTPUT_SEED, reportId]));
}

/** Writes the CRC into the last four bytes of `data` (little-endian). */
function sealBt(reportId: number, data: Uint8Array): Uint8Array {
  const crc = sonyBtCrc(reportId, data.subarray(0, data.length - 4));
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(data.length - 4, crc, true);
  return data;
}

export type Link = "usb" | "bt";

// ---- DualSense / DualSense Edge

export const DS5 = {
  USB_OUTPUT: 0x02,
  BT_OUTPUT: 0x31,
  /** Bytes after the id: the 47-byte effects block (USB); tag, effects, padding and CRC (Bluetooth). */
  USB_LEN: 47,
  BT_LEN: 77,
  BT_TAG: 0x10,
  COMMON: 47,
  FEATURE_CALIBRATION: 0x05,
  FEATURE_FIRMWARE: 0x20,
  /** Never read: pairing info (the pad's and the host's Bluetooth addresses). */
  FEATURE_PAIRING: 0x09,
} as const;

/** Effects block offsets (SDL DS5EffectsState_t; hid-playstation dualsense_output_report_common). */
export const DS5_AT = {
  enable1: 0,
  enable2: 1,
  rumbleRight: 2,
  rumbleLeft: 3,
  micLed: 8,
  rightTrigger: 10,
  leftTrigger: 21,
  playerLeds: 43,
  red: 44,
  green: 45,
  blue: 46,
} as const;

/** enable1: compatible vibration + haptics select (rumble), right / left trigger effect. enable2: mic LED, lightbar, release LEDs, player LEDs. */
export const DS5_BIT = { vibration: 0x01, hapticsSelect: 0x02, rightTrigger: 0x04, leftTrigger: 0x08, micLed: 0x01, lightbar: 0x04, releaseLeds: 0x08, playerLeds: 0x10 } as const;

/** The adaptive-trigger test: SDL testcontroller's three effects (off, constant resistance, resistance with vibration). */
export const DS5_TRIGGER_EFFECTS = {
  off: [0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  resistance: [0x01, 0, 110, 0, 0, 0, 0, 0, 0, 0, 0],
  vibration: [0x06, 15, 63, 128, 0, 0, 0, 0, 0, 0, 0],
} as const;
export type Ds5Trigger = keyof typeof DS5_TRIGGER_EFFECTS;

/** One of the volatile things SYNQ may ask a DualSense for, on the person's click only. */
export type Ds5Effect =
  | { kind: "rumble"; left: number; right: number }
  | { kind: "lightbar"; r: number; g: number; b: number }
  | { kind: "playerLeds"; pattern: number }
  | { kind: "micLed"; mode: 0 | 1 | 2 }
  | { kind: "triggers"; effect: Ds5Trigger }
  | { kind: "releaseLeds" };

const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n))) & 0xff;

function ds5Common(e: Ds5Effect): Uint8Array {
  const c = new Uint8Array(DS5.COMMON);
  switch (e.kind) {
    case "rumble":
      c[DS5_AT.enable1] = DS5_BIT.vibration | DS5_BIT.hapticsSelect;
      c[DS5_AT.rumbleRight] = byte(e.right);
      c[DS5_AT.rumbleLeft] = byte(e.left);
      break;
    case "lightbar":
      c[DS5_AT.enable2] = DS5_BIT.lightbar;
      c[DS5_AT.red] = byte(e.r);
      c[DS5_AT.green] = byte(e.g);
      c[DS5_AT.blue] = byte(e.b);
      break;
    case "playerLeds":
      c[DS5_AT.enable2] = DS5_BIT.playerLeds;
      c[DS5_AT.playerLeds] = e.pattern & 0x3f;
      break;
    case "micLed":
      c[DS5_AT.enable2] = DS5_BIT.micLed;
      c[DS5_AT.micLed] = e.mode;
      break;
    case "triggers":
      c[DS5_AT.enable1] = DS5_BIT.rightTrigger | DS5_BIT.leftTrigger;
      c.set(DS5_TRIGGER_EFFECTS[e.effect], DS5_AT.rightTrigger);
      c.set(DS5_TRIGGER_EFFECTS[e.effect], DS5_AT.leftTrigger);
      break;
    case "releaseLeds":
      c[DS5_AT.enable2] = DS5_BIT.releaseLeds;
      break;
  }
  return c;
}

/** The DualSense output report for `e`: [report id, data]. Bluetooth: sequence 0 (as SDL), tag 0x10, CRC sealed. */
export function ds5Output(link: Link, e: Ds5Effect): { reportId: number; data: Uint8Array } {
  const common = ds5Common(e);
  if (link === "usb") return { reportId: DS5.USB_OUTPUT, data: common };
  const data = new Uint8Array(DS5.BT_LEN);
  data[0] = 0x00; // sequence (high nibble) and tag 0
  data[1] = DS5.BT_TAG;
  data.set(common, 2);
  return { reportId: DS5.BT_OUTPUT, data: sealBt(DS5.BT_OUTPUT, data) };
}

// ---- DualShock 4

export const DS4 = {
  USB_OUTPUT: 0x05,
  BT_OUTPUT: 0x11,
  USB_LEN: 31,
  BT_LEN: 77,
  /** Bluetooth hardware control: HID + CRC, the poll interval left as it is (hid-playstation). */
  BT_HW_CONTROL: 0xc0,
  FEATURE_CALIBRATION_USB: 0x02,
  FEATURE_CALIBRATION_BT: 0x05,
  FEATURE_FIRMWARE: 0xa3,
  /** Never read: the pad's Bluetooth address and the paired host's. */
  FEATURE_SERIAL: 0x12,
} as const;
export const DS4_BIT = { motor: 0x01, led: 0x02 } as const;

export type Ds4Effect = { kind: "rumble"; left: number; right: number } | { kind: "lightbar"; r: number; g: number; b: number };

/** Offsets inside the common block (valid_flag0, valid_flag1, reserved, motor_right, motor_left, r, g, b, blink on/off). */
function ds4Common(e: Ds4Effect): Uint8Array {
  const c = new Uint8Array(10);
  if (e.kind === "rumble") {
    c[0] = DS4_BIT.motor;
    c[3] = byte(e.right);
    c[4] = byte(e.left);
  } else {
    c[0] = DS4_BIT.led;
    c[5] = byte(e.r);
    c[6] = byte(e.g);
    c[7] = byte(e.b);
  }
  return c;
}

export function ds4Output(link: Link, e: Ds4Effect): { reportId: number; data: Uint8Array } {
  const common = ds4Common(e);
  if (link === "usb") {
    const data = new Uint8Array(DS4.USB_LEN);
    data.set(common, 0);
    return { reportId: DS4.USB_OUTPUT, data };
  }
  const data = new Uint8Array(DS4.BT_LEN);
  data[0] = DS4.BT_HW_CONTROL;
  data[1] = 0x00; // audio control
  data.set(common, 2);
  return { reportId: DS4.BT_OUTPUT, data: sealBt(DS4.BT_OUTPUT, data) };
}

// ---- Nintendo Switch Pro Controller / Joy-Con

export const SWITCH = {
  SUBCOMMAND: 0x01,
  RUMBLE: 0x10,
  USB_COMMAND: 0x80,
  /** Bytes after the id: 48 over Bluetooth, 63 over USB (SDL k_unSwitchBluetoothPacketLength / USB packet length). */
  BT_LEN: 48,
  USB_LEN: 63,
} as const;

/** Rumble data for both sides: neutral (stop), and the one test pulse (SDL's frequencies, half amplitude). */
export const SWITCH_RUMBLE = {
  stop: [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40],
  pulse: [0x74, 0x88, 0x3d, 0x62, 0x74, 0x88, 0x3d, 0x62],
} as const;

/** The subcommands SYNQ may send (everything else is refused by guard.ts and pads.rs). */
export const SWITCH_SUB = {
  deviceInfo: 0x02,
  inputMode: 0x03,
  spiRead: 0x10,
  playerLights: 0x30,
  homeLight: 0x38,
  imu: 0x40,
  vibration: 0x48,
} as const;

/** USB-only commands (report 0x80): status, handshake, high speed, USB only (no timeout), allow the timeout again. */
export const SWITCH_USB = { status: 0x01, handshake: 0x02, highSpeed: 0x03, forceUsb: 0x04, clearUsb: 0x05 } as const;

/** SPI ranges that may be read: stick and IMU calibration, factory and user (SDL's offsets). [first, last] inclusive. */
export const SWITCH_SPI_READABLE: readonly (readonly [number, number])[] = [
  [0x6020, 0x6037], // factory IMU calibration
  [0x603d, 0x604e], // factory stick calibration
  [0x8010, 0x8025], // user stick calibration
  [0x8026, 0x8039], // user IMU calibration
];
/** Largest SPI read the pad answers in one reply. */
export const SWITCH_SPI_MAX = 0x1d;

export type SwitchCommand =
  | { kind: "usb"; command: (typeof SWITCH_USB)[keyof typeof SWITCH_USB] }
  | { kind: "rumble"; pulse: boolean }
  | { kind: "deviceInfo" }
  | { kind: "inputMode"; mode: 0x30 | 0x3f }
  | { kind: "spiRead"; address: number; length: number }
  | { kind: "playerLights"; pattern: number }
  | { kind: "homeLight"; intensity: number }
  | { kind: "imu"; on: boolean }
  | { kind: "vibration"; on: boolean };

/** One Switch output report. `packet` is the 4-bit packet counter the pad expects to change. */
export function switchOutput(link: Link, cmd: SwitchCommand, packet: number): { reportId: number; data: Uint8Array } {
  const data = new Uint8Array(link === "usb" ? SWITCH.USB_LEN : SWITCH.BT_LEN);
  if (cmd.kind === "usb") {
    data[0] = cmd.command;
    return { reportId: SWITCH.USB_COMMAND, data };
  }
  data[0] = packet & 0x0f;
  if (cmd.kind === "rumble") {
    data.set(cmd.pulse ? SWITCH_RUMBLE.pulse : SWITCH_RUMBLE.stop, 1);
    return { reportId: SWITCH.RUMBLE, data };
  }
  // A subcommand always carries the neutral rumble: rumble comes only from the rumble test.
  data.set(SWITCH_RUMBLE.stop, 1);
  const args = data.subarray(10);
  switch (cmd.kind) {
    case "deviceInfo":
      data[9] = SWITCH_SUB.deviceInfo;
      break;
    case "inputMode":
      data[9] = SWITCH_SUB.inputMode;
      args[0] = cmd.mode;
      break;
    case "spiRead":
      data[9] = SWITCH_SUB.spiRead;
      new DataView(args.buffer, args.byteOffset, 4).setUint32(0, cmd.address, true);
      args[4] = cmd.length;
      break;
    case "playerLights":
      data[9] = SWITCH_SUB.playerLights;
      args[0] = cmd.pattern & 0xff;
      break;
    case "homeLight": {
      const i = Math.max(0, Math.min(15, Math.round(cmd.intensity)));
      data[9] = SWITCH_SUB.homeLight;
      args.set([0x01, i << 4, i << 4, 0x00]);
      break;
    }
    case "imu":
      data[9] = SWITCH_SUB.imu;
      args[0] = cmd.on ? 1 : 0;
      break;
    case "vibration":
      data[9] = SWITCH_SUB.vibration;
      args[0] = cmd.on ? 1 : 0;
      break;
  }
  return { reportId: SWITCH.SUBCOMMAND, data };
}
