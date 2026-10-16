// CORSAIR "Bragi" protocol codec (Web Hub generation: 0x2Bxx keyboards, mice and SLIPSTREAM v2
// receivers), pure functions only.
//
// Learned from CORSAIR Web Hub (https://www.corsair.com/web-hub/, bundle assets/BDiHBs-c.js) and the
// CORSAIR Web FW Updater (firmware-updater/index.html, which names the enums), read as documentation
// on 2026-10-13; SYNQ's own code. Cross-checked with OpenMouse's Bragi codec (@openmouse/protocol
// corsair/bragi.js, AGPL) and ckb-next's bragi_proto.h names (docs only). See
// docs/devices/corsair-bragi.md for the evidence per field.
//
// Transport: output report id 0 on the vendor collection 0xFF42 usage 1, zero padded to the report
// length the descriptor gives (64 on every device seen). Answers come back as the next input report on
// the same collection. Notifications use a separate collection, 0xFF42 usage 2 (input only).
//
// Two header layouts:
//   v1.0  [0x08 | addr, cmd, payload...]          reply [?, cmd, status, data...]
//   v1.5  [addr, 0x01, sessionId, cmd, payload...] reply [?, code, ?, cmd, status, data...]
// A v1.5 device wants a host session first: cmd 0x1B `AA 01 00 1B 01 n0 n1 n2 n3 00`, the answer's
// byte 9 is the session id, which then goes in byte 2 of every frame.

export const CORSAIR_VID = 0x1b1c;
export const BRAGI_USAGE_PAGE = 0xff42;
export const BRAGI_USAGE_REQUEST = 1;
export const BRAGI_USAGE_NOTIFY = 2;
export const BRAGI_REPORT_ID = 0;
export const BRAGI_DEFAULT_LENGTH = 64;

export type Framing = "v1" | "v15";

/** Header byte count before the payload. */
export const headerSize = (f: Framing): number => (f === "v1" ? 2 : 4);
/** Index of the command byte. */
export const cmdIndex = (f: Framing): number => (f === "v1" ? 1 : 3);
/** Reply: index of the status byte and of the first data byte. */
export const replyStatusIndex = (f: Framing): number => (f === "v1" ? 2 : 4);
export const replyDataIndex = (f: Framing): number => (f === "v1" ? 3 : 5);

/** Commands (Web Hub `Di` methods; FW Updater `Ct` names). */
export const CMD = {
  set: 0x01,
  get: 0x02,
  getMultiple: 0x03,
  unbindBuffer: 0x05,
  writeBegin: 0x06,
  write: 0x07,
  readBuffer: 0x08,
  describeBuffer: 0x09,
  /** BLOCKED: calibration control (Start/Abort/Reset/Apply x sensor, gyro, sticks, magnetic switches). */
  calibration: 0x0a,
  /** BLOCKED: create / delete a file. */
  createFile: 0x0b,
  deleteFile: 0x0c,
  openFile: 0x0d,
  /** BLOCKED: factory reset (scope 0 everything, 1 properties, 2 files). */
  factoryReset: 0x0f,
  /** BLOCKED: apply firmware. */
  applyFirmware: 0x10,
  /** BLOCKED: pairing control (FW Updater). */
  pairing: 0x11,
  /** Ping with no payload. With a payload it is Web Hub's pairing command: BLOCKED. */
  ping: 0x12,
  /** BLOCKED: apply firmware (extended, CRC32). */
  applyFirmwareExtended: 0x16,
  /** Host software session control: 01 start, 02 stop. */
  session: 0x1b,
} as const;

/** Properties SYNQ uses (Web Hub constant block; FW Updater `Ke` names where it has them). */
export const PROP = {
  pollingRate: 0x01,
  brightness: 0x02,
  /** 1 self-operated (hardware), 2 host-controlled. 3 BOOTLOADER, 5 MCU BOOTLOADER: never written. */
  operatingMode: 0x03,
  liftHeight: 0x06,
  angleSnap: 0x07,
  angleSnapDegrees: 0x08,
  debounce: 0x0a,
  batteryLevel: 0x0f,
  batteryStatus: 0x10,
  usbVid: 0x11,
  usbPid: 0x12,
  firmware: 0x13,
  bootloaderVersion: 0x14,
  dpiStage1: 0x18,
  dpiStage5: 0x1c,
  dpiSniper: 0x1d,
  activeDpiStage: 0x1e,
  dpiStageMask: 0x1f,
  subdevices: 0x36,
  debounce2: 0x38,
  connectionMode: 0x3a,
  layout: 0x41,
  winLock: 0x45,
  activeProfile: 0x6e,
  maxPollingRate: 0x96,
  wirelessPollingRate: 0xdf,
  bragiVersion: 0x105,
  motionSync: 0x113,
  ripple: 0x114,
  /** FlashTap lives in the profile properties file under these ids (not set live). */
  flashTapEnable: 251,
  flashTapMode: 252,
  flashTapColor: 253,
  flashTapKey1: 254,
  flashTapKey2: 255,
} as const;

/** Operating modes (property 0x03). Only 1 and 2 are ever written. */
export const MODE = { selfOperated: 1, hostControlled: 2, bootloader: 3, sleep: 4, mcuBootloader: 5, limitedHost: 6, esports: 7 } as const;

/** Fixed file ids. Firmware and pairing files are listed so the guard can name them. */
export const FILE = {
  keyMappingsNonProfile: 2,
  firmware: 3,
  pairingId: 5,
  encryptionKey: 6,
  profilesList: 0x0f,
  secondaryFirmware: 18,
  bluetoothAddress: 20,
  pairedSubdevices: 36,
  serial: 38,
  pairingIdV2: 53,
  connectedSubdevices: 54,
  screenFirmware: 59,
  dialFirmware: 60,
  gameModeActuation: 72,
  switchSettings: 75,
} as const;

/** Host-allocated files (profiles and their sub-files) live in this range. */
export const HOST_FILE_MIN = 28000;
export const HOST_FILE_MAX = 32767;
/** Web Hub's identity / listing files inside that range: never written by SYNQ. */
export const IDENTITY_FILES: ReadonlySet<number> = new Set([31000, 30999, 30998, 30997, 30996, 28399, 28398, 28397, 28396]);

/** Reply status byte (Web Hub `me.Status`). */
export const STATUS = {
  ok: 0,
  invalidArgument: 1,
  insufficientBuffer: 2,
  invalidState: 3,
  notSupported: 4,
  propertyNotSupported: 5,
  invalidAddress: 6,
  hardwareError: 7,
  invalidOperation: 9,
  invalidFirmwareFile: 10,
  unknown: 11,
} as const;

/** v1.5 reply byte 1. */
export const PROTOCOL_CODE = { success: 0, busy: 1, malformed: 15 } as const;

export const POLLING_HZ = [125, 250, 500, 1000, 2000, 4000, 8000] as const;
export const pollingCode = (hz: number): number => {
  const i = POLLING_HZ.indexOf(hz as (typeof POLLING_HZ)[number]);
  if (i < 0) throw new RangeError(`unsupported polling rate ${hz} Hz`);
  return i + 1;
};
export const pollingHz = (code: number): number | null => POLLING_HZ[code - 1] ?? null;

// ---------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------

export interface FrameOpts {
  framing: Framing;
  /** 0 = the USB device; 1.. = a device paired to a receiver. */
  addr?: number;
  /** v1.5 session id (0 before a session exists). */
  session?: number;
  /** Report payload length (descriptor), default 64. */
  length?: number;
}

const u8 = (v: number): number => {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError(`byte out of range: ${v}`);
  return v;
};
const le16 = (v: number): number[] => {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`u16 out of range: ${v}`);
  return [v & 0xff, v >> 8];
};
const le32 = (v: number): number[] => {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`u32 out of range: ${v}`);
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
};

export function frame(o: FrameOpts, cmd: number, payload: readonly number[] = []): Uint8Array {
  const length = o.length ?? BRAGI_DEFAULT_LENGTH;
  const addr = u8(o.addr ?? 0);
  if (addr > 7) throw new RangeError(`device address ${addr} > 7`);
  const head = o.framing === "v1" ? [0x08 | addr, u8(cmd)] : [addr, 0x01, u8(o.session ?? 0), u8(cmd)];
  const bytes = [...head, ...payload.map(u8)];
  if (bytes.length > length) throw new RangeError(`frame too long: ${bytes.length} > ${length}`);
  const out = new Uint8Array(length);
  out.set(bytes);
  return out;
}

/** SET property = value (u32 LE, or 4 raw bytes such as a [B,G,R,0] colour). */
export function encodeSet(o: FrameOpts, prop: number, value: number | readonly number[]): Uint8Array {
  const v = typeof value === "number" ? le32(value) : [...value, 0, 0, 0, 0].slice(0, 4);
  return frame(o, CMD.set, [...le16(prop), ...v]);
}
export const encodeGet = (o: FrameOpts, prop: number): Uint8Array => frame(o, CMD.get, le16(prop));
export const encodePing = (o: FrameOpts): Uint8Array => frame(o, CMD.ping);
export const encodeOpenFile = (o: FrameOpts, fileId: number, buffer = 0): Uint8Array => frame(o, CMD.openFile, [buffer, ...le16(fileId)]);
export const encodeDescribeBuffer = (o: FrameOpts, buffer = 0): Uint8Array => frame(o, CMD.describeBuffer, [buffer]);
export const encodeReadBuffer = (o: FrameOpts, buffer = 0): Uint8Array => frame(o, CMD.readBuffer, [buffer]);
/** Web Hub closes with `05 01 <buffer>` (count 1). */
export const encodeUnbindBuffer = (o: FrameOpts, buffer = 0): Uint8Array => frame(o, CMD.unbindBuffer, [1, buffer]);

/** Payload bytes that fit in the first (writeBegin) and following (write) frames. */
export const firstChunkSize = (o: FrameOpts): number => (o.length ?? BRAGI_DEFAULT_LENGTH) - headerSize(o.framing) - 5;
export const nextChunkSize = (o: FrameOpts): number => (o.length ?? BRAGI_DEFAULT_LENGTH) - headerSize(o.framing) - 1;

/** A whole-file write: `06 <buf> <len u32> <data...>`, then `07 <buf> <data...>` until done. */
export function encodeWriteFile(o: FrameOpts, data: Uint8Array, buffer = 0): Uint8Array[] {
  const first = firstChunkSize(o);
  const next = nextChunkSize(o);
  const out = [frame(o, CMD.writeBegin, [buffer, ...le32(data.length), ...data.subarray(0, first)])];
  for (let at = first; at < data.length; at += next) out.push(frame(o, CMD.write, [buffer, ...data.subarray(at, at + next)]));
  return out;
}

/** Session start for a v1.5 device: `addr 01 00 1B 01 n0 n1 n2 n3 00`. */
export function encodeSessionStart(nonce: readonly number[], addr = 0, length = BRAGI_DEFAULT_LENGTH): Uint8Array {
  if (nonce.length !== 4) throw new RangeError("session nonce is 4 bytes");
  const out = new Uint8Array(length);
  out.set([u8(addr), 0x01, 0x00, CMD.session, 0x01, ...nonce.map(u8), 0x00]);
  return out;
}
/** Session stop: `addr 01 SS 1B 02 00 00 00 00 SS`. Only for the session SYNQ started. */
export function encodeSessionStop(session: number, addr = 0, length = BRAGI_DEFAULT_LENGTH): Uint8Array {
  const out = new Uint8Array(length);
  out.set([u8(addr), 0x01, u8(session), CMD.session, 0x02, 0, 0, 0, 0, u8(session)]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------------------------

export interface Reply {
  cmd: number;
  status: number;
  /** v1.5 only: 0 success, 1 busy, 15 malformed / session expired. */
  code: number | null;
  data: Uint8Array;
}

export function decodeReply(f: Framing, r: Uint8Array): Reply {
  return {
    cmd: r[cmdIndex(f)],
    status: r[replyStatusIndex(f)],
    code: f === "v15" ? r[1] : null,
    data: r.subarray(replyDataIndex(f)),
  };
}

/** Is `r` the answer to `sent`? Same command byte (session replies are matched on 0x1B). */
export function isReplyTo(f: Framing, sent: Uint8Array, r: Uint8Array): boolean {
  if (sent[3] === CMD.session && sent[1] === 0x01 && (f === "v15" || sent[0] < 8)) return r[3] === CMD.session;
  return r[cmdIndex(f)] === sent[cmdIndex(f)];
}

/** v1.5: the device wants a (new) session before it will answer. */
export const needsSession = (f: Framing, r: Uint8Array): boolean =>
  f === "v15" && (r[1] === PROTOCOL_CODE.malformed || r[replyStatusIndex(f)] === STATUS.invalidState);

/** Session reply: checks the nonce echo (bytes 5..8) and returns the id (byte 9). */
export function decodeSessionReply(r: Uint8Array, nonce: readonly number[]): number {
  if (r[3] !== CMD.session) throw new Error("not a session reply");
  if (r[4] !== STATUS.ok) throw new Error(`session refused (status ${r[4]})`);
  for (let i = 0; i < 4; i++) if (r[5 + i] !== nonce[i]) throw new Error("session reply does not echo our nonce (another host?)");
  return r[9];
}

export const u32le = (d: Uint8Array, at = 0): number => (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;
export const u16at = (d: Uint8Array, at: number): number => d[at] | (d[at + 1] << 8);

export const statusText = (s: number): string =>
  (Object.entries(STATUS).find(([, v]) => v === s)?.[0] ?? `status ${s}`).replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`);

/** Firmware reply data: major, minor, build u16. */
export const decodeFirmware = (d: Uint8Array): string => `${d[0]}.${d[1]}.${d[2] | (d[3] << 8)}`;

// ---------------------------------------------------------------------------------------------
// File formats (Web Hub KeyActualService `fI`, FlashTapService `Sp`, ProfileService `bp`)
// ---------------------------------------------------------------------------------------------

/** Profiles list (file 0x0F): hdr u16 (0x0013), count u16, file id u16 x count. */
export function decodeProfilesList(d: Uint8Array): number[] {
  if (d.length < 4) throw new Error("profiles list too short");
  const n = u16at(d, 2);
  if (d.length < 4 + 2 * n) throw new Error("profiles list truncated");
  return Array.from({ length: n }, (_, i) => u16at(d, 4 + 2 * i));
}

export interface ProfileFile {
  magic: number;
  cookie: number;
  assignments: number;
  properties: number;
  lightings: number;
  keyMappings: number;
  primaryActuation: number;
  secondaryActuation: number;
  name: string;
  primaryReset: number;
  secondaryReset: number;
  rapidTrigger: number;
}

export const PROFILE_MAGIC = 0xf11e;
export const PROPERTIES_MAGIC = 0xd43d;

/** Profile file: magic u16, cookie u32, 12 file ids u16, nameLength u16, name + NUL, 4 more ids. */
export function decodeProfileFile(d: Uint8Array): ProfileFile {
  if (d.length < 32) throw new Error("profile file too short");
  const magic = u16at(d, 0);
  if (magic !== PROFILE_MAGIC) throw new Error(`profile file magic 0x${magic.toString(16)} (expected f11e)`);
  const nameLength = u16at(d, 30);
  const after = 33 + nameLength;
  if (d.length < after + 6) throw new Error("profile file truncated");
  return {
    magic,
    cookie: u32le(d, 2),
    assignments: u16at(d, 6),
    properties: u16at(d, 8),
    lightings: u16at(d, 12),
    keyMappings: u16at(d, 14),
    primaryActuation: u16at(d, 24),
    secondaryActuation: u16at(d, 26),
    name: new TextDecoder().decode(d.subarray(32, 32 + nameLength)),
    primaryReset: u16at(d, after),
    secondaryReset: u16at(d, after + 2),
    rapidTrigger: u16at(d, after + 4),
  };
}

export interface DistanceEntry {
  key: number;
  /** 1 = enabled (primary), 0/1 disabled/enabled (secondary). */
  flags: number;
  /** 0.1 mm units. */
  distance: number;
}
export interface DistanceFile {
  header: number;
  entries: DistanceEntry[];
}

/** Actuation / reset distance file: hdr u16, count u8, {key, flags, distance} x count. */
export function decodeDistanceFile(d: Uint8Array): DistanceFile {
  if (d.length < 3) throw new Error("actuation file too short");
  const n = d[2];
  if (d.length < 3 + 3 * n) throw new Error("actuation file truncated");
  return { header: u16at(d, 0), entries: Array.from({ length: n }, (_, i) => ({ key: d[3 + 3 * i], flags: d[4 + 3 * i], distance: d[5 + 3 * i] })) };
}
export function encodeDistanceFile(f: DistanceFile): Uint8Array {
  const out = new Uint8Array(3 + 3 * f.entries.length);
  out.set(le16(f.header));
  out[2] = u8(f.entries.length);
  f.entries.forEach((e, i) => out.set([u8(e.key), u8(e.flags), u8(e.distance)], 3 + 3 * i));
  return out;
}

export const RT_FLAGS = { off: 0, on: 1, continuous: 3 } as const;
export interface RapidTriggerEntry {
  key: number;
  /** 0 off, 1 on, 3 on + continuous (bit 1). */
  flags: number;
  /** Where rapid trigger starts (Web Hub passes the key's actuation point), 0.1 mm. */
  deadzone: number;
  press: number;
  release: number;
}
export interface RapidTriggerFile {
  header: number;
  entries: RapidTriggerEntry[];
}
export function decodeRapidTriggerFile(d: Uint8Array): RapidTriggerFile {
  if (d.length < 3) throw new Error("rapid trigger file too short");
  const n = d[2];
  if (d.length < 3 + 5 * n) throw new Error("rapid trigger file truncated");
  return {
    header: u16at(d, 0),
    entries: Array.from({ length: n }, (_, i) => {
      const at = 3 + 5 * i;
      return { key: d[at], flags: d[at + 1], deadzone: d[at + 2], press: d[at + 3], release: d[at + 4] };
    }),
  };
}
export function encodeRapidTriggerFile(f: RapidTriggerFile): Uint8Array {
  const out = new Uint8Array(3 + 5 * f.entries.length);
  out.set(le16(f.header));
  out[2] = u8(f.entries.length);
  f.entries.forEach((e, i) => out.set([u8(e.key), u8(e.flags), u8(e.deadzone), u8(e.press), u8(e.release)], 3 + 5 * i));
  return out;
}

/** Properties file: magic u16 0xD43D, count u16, {id u16, value[4]} x count. */
export interface PropertiesFile {
  magic: number;
  values: Map<number, Uint8Array>;
}
export function decodePropertiesFile(d: Uint8Array): PropertiesFile {
  if (d.length < 4) throw new Error("properties file too short");
  const magic = u16at(d, 0);
  if (magic !== PROPERTIES_MAGIC) throw new Error(`properties file magic 0x${magic.toString(16)} (expected d43d)`);
  const n = u16at(d, 2);
  if (d.length < 4 + 6 * n) throw new Error("properties file truncated");
  const values = new Map<number, Uint8Array>();
  for (let i = 0; i < n; i++) values.set(u16at(d, 4 + 6 * i), d.slice(6 + 6 * i, 10 + 6 * i));
  return { magic, values };
}
export function encodePropertiesFile(p: PropertiesFile): Uint8Array {
  const out = new Uint8Array(4 + 6 * p.values.size);
  out.set([...le16(p.magic), ...le16(p.values.size)]);
  let i = 0;
  for (const [id, v] of p.values) {
    out.set([...le16(id), ...v.subarray(0, 4)], 4 + 6 * i);
    i++;
  }
  return out;
}
export const propU32 = (p: PropertiesFile, id: number): number | null => {
  const v = p.values.get(id);
  return v ? u32le(v) : null;
};
export const withPropU32 = (p: PropertiesFile, id: number, value: number): PropertiesFile => {
  const values = new Map(p.values);
  values.set(id, new Uint8Array(le32(value)));
  return { magic: p.magic, values };
};

/** FlashTap (Corsair SOCD) modes, property 252. */
export const FLASHTAP_MODE = { neutral: 0, last: 1, first: 2 } as const;

/** mm <-> Corsair's 0.1 mm bytes (Web Hub `$o = mm * 10`). */
export const CORSAIR_UNIT_MM = 0.1;
