// Corsair peripherals as iCUE 5 drives them ("BRAGI" / Corsair V2 protocol) — transport-agnostic
// encode/decode, no device access. Covers the K-series keyboards and Corsair mice that Corsair's Web
// Hub does NOT reach, including the magnetic-switch boards (K70 MAX / K65 MAX, MGX switches). Wave 3a
// owns the Web Hub path in src/lib/brands/corsair/; this is the separate desktop (iCUE) path.
//
// Sources (read as data; nothing was run, no Corsair service was touched):
//   [icue]   C:\Program Files\Corsair\Corsair iCUE5 Software DeviceCommands.dll / DeviceControllers.dll
//            MSVC RTTI symbols under cue::dev::cmd — the command surface (SetKeyActuationSetting,
//            SetRapidTriggerSetting, GetAnalogSwitchSettings, CommitKeyActuationSettings, and the
//            dangerous ones: SetFirmwareUpdatingState, Reset, PowerReset, ResetHardwareStorage,
//            ClearHardwareProfile, StartPairing/SetPairingId, StartCalibration/ApplyCalibration).
//            iCUE confirms magnetic support (strings "MagneticSwitch", "CorsairMagneticHyperdrive").
//   [openrgb] CalcProgrammer1/OpenRGB CorsairPeripheralV2Controller (GPL-2.0-or-later, read for the
//            wire layer, not copied) — the exact BRAGI packet bytes below: write ids, command set,
//            read addresses, the lighting transaction, and the usage page / VID / PIDs.
//
// Confidence: [C] confirmed in OpenRGB code; [I] inferred from the iCUE symbol surface; [D] needs a
// device. The *magnetic actuation write* bytes are iCUE-internal (abstracted in the DLL, device package
// encrypted), so SYNQ does NOT emit them — it reads lighting/identity and leaves analog read-only.
// Erasable TS, node runs it directly.

export const BRAGI = {
  vendorId: 0x1b1c,
  /** Corsair control collection. [openrgb REGISTER_HID_DETECTOR_IP … 0xFF42] */
  usagePage: 0xff42,
  usage: 0x01,
  /** Everything is report id 0; a 64-byte data payload (65-byte write incl. the id). [openrgb] */
  reportId: 0x00,
  length: 64,
} as const;

/** Byte 0 of the data (OpenRGB buffer[1]): wired vs wireless write id. [openrgb] */
export const WRITE_ID = { wired: 0x08, wireless: 0x09 } as const;

/** Byte 1 (OpenRGB buffer[2]): the BRAGI command. [openrgb CORSAIR_V2_CMD_*] */
export const CMD = {
  set: 0x01,
  get: 0x02,
  stopTx: 0x05,
  blockW1: 0x06,
  blockWn: 0x07,
  startTx: 0x0d,
} as const;

/** Byte 2 (OpenRGB buffer[3]) when reading: the property address. [openrgb] */
export const ADDR = {
  firmwareVid: 0x11, // GetAddress(0x11): firmware + vid
  pid: 0x12, // GetAddress(0x12): product id
  keyboardLayout: 0x41, // GetKeyboardLayout
  renderMode: 0x03, // SET render mode (software/hardware)
  lightCtrl1: 0x01, // lighting control endpoint 1 (mice/mousepads)
  lightCtrl2: 0x22, // lighting control endpoint 2 (keyboards; K100 pinned here)
} as const;

/** Device render modes (byte 3 low byte of a SET renderMode). [openrgb corsair_v2_device_mode] */
export const MODE = { direct: 0x12, hwStatic: 0x7e } as const;

export type Transport = "wired" | "wireless";

export interface BragiFrame {
  reportId: number;
  /** 64 data bytes, no report id (WebHID convention). */
  data: Uint8Array;
}

function blank(transport: Transport): Uint8Array {
  const d = new Uint8Array(BRAGI.length);
  d[0] = WRITE_ID[transport];
  return d;
}

// ---- reads (safe) ---------------------------------------------------------------------------

/** GET firmware/vid (address 0x11). [openrgb GetAddress] */
export const getFirmware = (t: Transport = "wired"): BragiFrame => read(t, ADDR.firmwareVid);
/** GET product id (address 0x12). [openrgb] */
export const getPid = (t: Transport = "wired"): BragiFrame => read(t, ADDR.pid);
/** GET keyboard layout (address 0x41). [openrgb GetKeyboardLayout] */
export const getLayout = (t: Transport = "wired"): BragiFrame => read(t, ADDR.keyboardLayout);
/** LightingControl probe: GET on a lighting-control endpoint (0x01 or 0x22). [openrgb LightingControl] */
export const lightingProbe = (endpoint: number, t: Transport = "wired"): BragiFrame => read(t, endpoint);

function read(t: Transport, address: number): BragiFrame {
  const d = blank(t);
  d[1] = CMD.get;
  d[2] = address & 0xff;
  return { reportId: BRAGI.reportId, data: d };
}

// ---- lighting (gated writes) ----------------------------------------------------------------

/** SET render mode (software direct vs hardware). [openrgb SetRenderMode] */
export function setRenderMode(mode: number, t: Transport = "wired"): BragiFrame {
  const d = blank(t);
  d[1] = CMD.set;
  d[2] = ADDR.renderMode;
  d[4] = mode & 0xff; // OpenRGB buffer[5]
  return { reportId: BRAGI.reportId, data: d };
}

/** Open a lighting transaction: START_TX, opt1 = 0, byte = light-control endpoint. [openrgb StartTransaction(0)] */
export function startLightingTx(lightCtrl: number, t: Transport = "wired"): BragiFrame {
  const d = blank(t);
  d[1] = CMD.startTx;
  d[2] = 0x00; // opt1 = 0 for lighting
  d[3] = lightCtrl & 0xff; // OpenRGB buffer[4] = light_ctrl
  return { reportId: BRAGI.reportId, data: d };
}

/** Close a lighting transaction: STOP_TX, buffer[3]=0x01, byte=endpoint. [openrgb StopTransaction] */
export function stopLightingTx(lightCtrl: number, t: Transport = "wired"): BragiFrame {
  const d = blank(t);
  d[1] = CMD.stopTx;
  d[2] = 0x01;
  d[3] = lightCtrl & 0xff;
  return { reportId: BRAGI.reportId, data: d };
}

/** First LED block: BLK_W1, size at bytes 3..4 (LE), payload from offset 7 (OpenRGB offset 8). [openrgb SetLEDs] */
export function ledBlockFirst(totalSize: number, chunk: ArrayLike<number>, t: Transport = "wired"): BragiFrame {
  if (totalSize < 0 || totalSize > 0xffff) throw new RangeError(`led data size ${totalSize}`);
  const d = blank(t);
  d[1] = CMD.blockW1;
  d[3] = totalSize & 0xff; // OpenRGB buffer[4]
  d[4] = (totalSize >> 8) & 0xff; // buffer[5]
  if (chunk.length > BRAGI.length - 7) throw new RangeError(`first LED chunk too big (${chunk.length})`);
  for (let i = 0; i < chunk.length; i++) d[7 + i] = chunk[i] & 0xff;
  return { reportId: BRAGI.reportId, data: d };
}

/** Continuation LED block: BLK_WN, payload from offset 3 (OpenRGB offset 4). [openrgb SetLEDs] */
export function ledBlockNext(chunk: ArrayLike<number>, t: Transport = "wired"): BragiFrame {
  const d = blank(t);
  d[1] = CMD.blockWn;
  if (chunk.length > BRAGI.length - 3) throw new RangeError(`LED chunk too big (${chunk.length})`);
  for (let i = 0; i < chunk.length; i++) d[3 + i] = chunk[i] & 0xff;
  return { reportId: BRAGI.reportId, data: d };
}

// ---- reply parsing --------------------------------------------------------------------------

/** OpenRGB reads firmware from the GET 0x11 reply; layout varies per device, so expose the raw bytes. */
export const replyBytes = (reply: Uint8Array): Uint8Array => reply.slice();
export const u16le = (f: ArrayLike<number>, at: number): number => (f[at] | (f[at + 1] << 8)) >>> 0;
export const hex = (b: ArrayLike<number>, sep = " "): string => Array.from(b, (x) => (x & 0xff).toString(16).padStart(2, "0")).join(sep);
