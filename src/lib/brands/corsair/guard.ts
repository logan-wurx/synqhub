// CORSAIR Bragi allowlist. Every frame SYNQ sends a Web Hub device passes classifyBragiFrame first;
// anything not listed is refused, and the blocked list names what Web Hub / the FW Updater can do that
// SYNQ never will.
//
// File writes are the one stateful part: `06`/`07` write into whatever file buffer 0 has open. The
// guard therefore tracks the file opened by the last allowed `0D` (and forgets it on `05`), and only
// lets data through to host-allocated profile sub-files (28000-32767, minus Web Hub's identity files).
// Firmware (3, 18, 59, 60) and pairing files (5, 6, 20, 53) cannot even be opened. The Rust bridge must
// keep the same one-number state per device handle (see corsair-frames.txt: column 3 is that state).
//
// Sources: CORSAIR Web Hub bundle (`Di` command builders, `xg` DeviceHandler, `En` HID constants) and
// the Web FW Updater's named enums (`Ct` commands, `Ke` properties, `Ft` files, `Tt` modes), read as
// documentation 2026-10-13; docs/devices/corsair-bragi.md.
import type { BlockedCommand, FrameVerdict } from "../types.ts";
import { CMD, FILE, HOST_FILE_MAX, HOST_FILE_MIN, IDENTITY_FILES, MODE, PROP, cmdIndex, headerSize, type Framing } from "./bragi.ts";
import type { CorsairFamily } from "./devices.ts";

const ok = (verdict: "read" | "write", what: string): FrameVerdict => ({ verdict, what });
const no = (what: string, why: FrameVerdict["why"], reason: string): FrameVerdict => ({ verdict: "blocked", what, why, reason });
const zeroFrom = (f: Uint8Array, i: number) => {
  for (let j = i; j < f.length; j++) if (f[j]) return false;
  return true;
};
const u16 = (f: Uint8Array, i: number) => f[i] | (f[i + 1] << 8);
const u32 = (f: Uint8Array, i: number) => (f[i] | (f[i + 1] << 8) | (f[i + 2] << 16) | (f[i + 3] << 24)) >>> 0;

const KEYBOARDS: readonly CorsairFamily[] = ["kb-he", "kb"];
const MICE: readonly CorsairFamily[] = ["mouse-bragi"];
const ALL_BRAGI: readonly CorsairFamily[] = ["kb-he", "kb", "mouse-bragi", "receiver"];

/** SET properties SYNQ may write, with the values it may write, per family. */
export const SET_ALLOWED: ReadonlyMap<number, { what: string; min: number; max: number; families: readonly CorsairFamily[] }> = new Map([
  [PROP.pollingRate, { what: "polling rate (1..7 = 125..8000 Hz)", min: 1, max: 7, families: ALL_BRAGI }],
  [PROP.brightness, { what: "brightness (0..1000)", min: 0, max: 1000, families: KEYBOARDS }],
  [PROP.operatingMode, { what: "operating mode (1 self-operated / 2 host-controlled)", min: MODE.selfOperated, max: MODE.hostControlled, families: ALL_BRAGI }],
  [PROP.activeProfile, { what: "active hardware profile (0..4)", min: 0, max: 4, families: ["kb-he", "kb", "mouse-bragi"] }],
  [PROP.liftHeight, { what: "lift height (1..7)", min: 1, max: 7, families: MICE }],
  [PROP.angleSnap, { what: "angle snapping (0/1)", min: 0, max: 1, families: MICE }],
  [PROP.debounce, { what: "debounce (5..14)", min: 5, max: 14, families: MICE }],
  [PROP.debounce2, { what: "debounce, second property (5..14)", min: 5, max: 14, families: MICE }],
  [PROP.dpiStage1, { what: "DPI stage 1", min: 100, max: 65535, families: MICE }],
  [PROP.dpiStage1 + 1, { what: "DPI stage 2", min: 100, max: 65535, families: MICE }],
  [PROP.dpiStage1 + 2, { what: "DPI stage 3", min: 100, max: 65535, families: MICE }],
  [PROP.dpiStage1 + 3, { what: "DPI stage 4", min: 100, max: 65535, families: MICE }],
  [PROP.dpiStage5, { what: "DPI stage 5", min: 100, max: 65535, families: MICE }],
  [PROP.activeDpiStage, { what: "active DPI stage (0..4)", min: 0, max: 4, families: MICE }],
  [PROP.motionSync, { what: "motion sync (0/1)", min: 0, max: 1, families: MICE }],
]);

/** GET properties SYNQ reads (all harmless; listed so unknown ids still fail closed). */
export const GET_ALLOWED: ReadonlySet<number> = new Set([
  PROP.pollingRate, PROP.brightness, PROP.operatingMode, PROP.liftHeight, PROP.angleSnap, PROP.angleSnapDegrees, PROP.debounce,
  PROP.batteryLevel, PROP.batteryStatus, PROP.usbVid, PROP.usbPid, PROP.firmware, PROP.bootloaderVersion,
  0x18, 0x19, 0x1a, 0x1b, 0x1c, PROP.dpiSniper, PROP.activeDpiStage, PROP.dpiStageMask, PROP.subdevices, PROP.debounce2,
  PROP.connectionMode, PROP.layout, PROP.activeProfile, PROP.maxPollingRate, PROP.wirelessPollingRate, PROP.bragiVersion, PROP.motionSync,
]);

/** Files SYNQ may open for reading. Writes additionally need a host-allocated, non-identity file. */
export function fileReadable(id: number): boolean {
  return id === FILE.profilesList || id === FILE.serial || (id >= HOST_FILE_MIN && id <= HOST_FILE_MAX && !IDENTITY_FILES.has(id));
}
export function fileWritable(id: number | null): boolean {
  return id !== null && id >= HOST_FILE_MIN && id <= HOST_FILE_MAX && !IDENTITY_FILES.has(id);
}

const FILE_NAMES: ReadonlyMap<number, string> = new Map([
  [FILE.firmware, "firmware image"],
  [FILE.secondaryFirmware, "secondary-chip firmware"],
  [FILE.screenFirmware, "screen-module firmware"],
  [FILE.dialFirmware, "dial-module firmware"],
  [FILE.pairingId, "pairing id"],
  [FILE.encryptionKey, "wireless encryption key"],
  [FILE.bluetoothAddress, "Bluetooth address"],
  [FILE.pairingIdV2, "pairing id v2"],
  [FILE.switchSettings, "switch settings / calibration"],
]);

export interface BragiGuardContext {
  framing: Framing;
  family: CorsairFamily;
  /** File open in buffer 0 (from the last allowed 0x0D, cleared by 0x05), or null. */
  openFile: number | null;
  /** The session SYNQ started (v1.5), so a stop can only end our own. */
  session?: number | null;
  /** Report length (descriptor); frames must match it exactly. */
  length?: number;
}

/** The verdict for one outgoing frame. Pure: the caller tracks `openFile` (BragiGuardState does). */
export function classifyBragiFrame(ctx: BragiGuardContext, f: Uint8Array): FrameVerdict {
  const len = ctx.length ?? 64;
  if (f.length !== len) return no("bad length", "unknown", `frames are ${len} bytes (got ${f.length})`);
  if (ctx.family === "mouse-sabre") return no("Bragi frame to a Sabre v2", "unknown", "Sabre v2 Pro mice speak the EEPROM protocol (sabre.ts)");

  // Session control is always the 4-byte header form: [addr, 01, sid, 1B, op, ...].
  if (f[3] === CMD.session && f[1] === 0x01 && f[0] <= 7) {
    if (ctx.framing !== "v15") return no("session control", "unknown", "only Bragi 1.5 devices take sessions");
    if (f[4] === 0x01 && f[2] === 0 && f[9] === 0 && zeroFrom(f, 10)) return ok("read", "start host session");
    if (f[4] === 0x02 && f[2] === f[9] && zeroFrom(f, 10) && f.subarray(5, 9).every((x) => x === 0)) {
      if (ctx.session === undefined || ctx.session === f[2]) return ok("read", "stop SYNQ's host session");
      return no("stop session", "identity", "that session belongs to another host (iCUE / Web Hub)");
    }
    return no("session control", "unknown", "unknown session operation");
  }

  // Header.
  if (ctx.framing === "v1") {
    if ((f[0] & 0xf8) !== 0x08) return no("bad header", "unknown", "Bragi 1.0 frames start 08..0F");
  } else if (f[0] > 7 || f[1] !== 0x01) return no("bad header", "unknown", "Bragi 1.5 frames start [addr 0..7, 01, session]");
  const cmd = f[cmdIndex(ctx.framing)];
  const p = headerSize(ctx.framing);

  switch (cmd) {
    case CMD.calibration:
      return no("calibration control 0x0A", "calibration", "Start/Abort/Reset/Apply calibration of sensors, sticks or magnetic switches");
    case CMD.createFile:
    case CMD.deleteFile:
      return no(cmd === CMD.createFile ? "create file 0x0B" : "delete file 0x0C", "profile-wipe", "SYNQ never creates or deletes device files");
    case CMD.factoryReset:
      return no("factory reset 0x0F", "factory-reset", "RESET_TO_DEFAULTS");
    case CMD.applyFirmware:
    case CMD.applyFirmwareExtended:
      return no("apply firmware", "firmware", "APPLY_FIRMWARE / APPLY_FIRMWARE_EXTENDED");
    case CMD.pairing:
      return no("pairing control 0x11", "pairing", "PAIRING_CONTROL");
    case CMD.ping:
      return zeroFrom(f, p) ? ok("read", "ping") : no("pairing 0x12 with payload", "pairing", "Web Hub's pairing command (0x12 + action) un-pairs receivers");
    case CMD.getMultiple:
      return no("get multiple 0x03", "unknown", "never used");
    case CMD.get: {
      const prop = u16(f, p);
      if (!GET_ALLOWED.has(prop)) return no(`GET 0x${prop.toString(16)}`, "unknown", "property not on SYNQ's read list");
      return zeroFrom(f, p + 2) ? ok("read", `GET 0x${prop.toString(16)}`) : no("GET with extra bytes", "unknown", "trailing bytes after the property id");
    }
    case CMD.set: {
      const prop = u16(f, p);
      const value = u32(f, p + 2);
      if (prop === PROP.operatingMode && (value === MODE.bootloader || value === MODE.mcuBootloader)) return no("operating mode = bootloader", "bootloader", "SET 0x03 = 3/5 re-enumerates the device as its bootloader");
      if (prop === PROP.operatingMode && value > MODE.hostControlled) return no(`operating mode = ${value}`, "identity", "sleep / limited host / esports modes are never set");
      const rule = SET_ALLOWED.get(prop);
      if (!rule || !rule.families.includes(ctx.family)) return no(`SET 0x${prop.toString(16)}`, "unknown", "property not on SYNQ's write list for this device");
      if (value < rule.min || value > rule.max) return no(`SET ${rule.what} = ${value}`, "unknown", `outside ${rule.min}..${rule.max}`);
      return zeroFrom(f, p + 6) ? ok("write", `SET ${rule.what}`) : no("SET with extra bytes", "unknown", "trailing bytes after the value");
    }
    case CMD.openFile: {
      const file = u16(f, p + 1);
      if (f[p] !== 0) return no("open file", "unknown", "SYNQ only uses buffer 0");
      if (!fileReadable(file)) {
        const name = FILE_NAMES.get(file);
        return no(`open file ${file}${name ? ` (${name})` : ""}`, name?.includes("firmware") ? "firmware" : name?.includes("pair") || name?.includes("key") || name?.includes("Bluetooth") ? "pairing" : name ? "calibration" : "unknown", "not a file SYNQ reads");
      }
      return zeroFrom(f, p + 3) ? ok("read", `open file ${file}`) : no("open with extra bytes", "unknown", "trailing bytes");
    }
    case CMD.describeBuffer:
    case CMD.readBuffer:
      return f[p] === 0 && zeroFrom(f, p + 1) ? ok("read", cmd === CMD.readBuffer ? "read buffer" : "describe buffer") : no("buffer op", "unknown", "buffer 0 only, no payload");
    case CMD.unbindBuffer:
      return f[p] === 1 && f[p + 1] === 0 && zeroFrom(f, p + 2) ? ok("read", "close buffer 0") : no("unbind", "unknown", "SYNQ closes buffer 0 only");
    case CMD.writeBegin:
    case CMD.write: {
      if (f[p] !== 0) return no("write buffer", "unknown", "buffer 0 only");
      if (!fileWritable(ctx.openFile)) {
        const name = ctx.openFile === null ? "no open file" : `file ${ctx.openFile}`;
        return no(`write into ${name}`, "firmware", "data may only go to an open, host-allocated profile file");
      }
      if (cmd === CMD.writeBegin && u32(f, p + 1) > 4096) return no("write too large", "unknown", "profile sub-files are a few hundred bytes");
      return ok("write", `${cmd === CMD.writeBegin ? "begin" : "continue"} writing file ${ctx.openFile}`);
    }
    default:
      return no(`command 0x${cmd.toString(16)}`, "unknown", "not on SYNQ's list of known-safe Bragi commands");
  }
}

/** Tracks the open file across frames, as the bridge must. */
export class BragiGuardState {
  openFile: number | null = null;
  session: number | null = null;
  readonly framing: Framing;
  readonly family: CorsairFamily;
  readonly length: number;
  constructor(framing: Framing, family: CorsairFamily, length = 64) {
    this.framing = framing;
    this.family = family;
    this.length = length;
  }
  classify(f: Uint8Array): FrameVerdict {
    return classifyBragiFrame({ framing: this.framing, family: this.family, openFile: this.openFile, session: this.session, length: this.length }, f);
  }
  /** Call after an allowed frame was sent. */
  observe(f: Uint8Array): void {
    if (f[3] === CMD.session && f[1] === 0x01) return;
    const cmd = f[cmdIndex(this.framing)];
    const p = headerSize(this.framing);
    if (cmd === CMD.openFile) this.openFile = u16(f, p + 1);
    else if (cmd === CMD.unbindBuffer) this.openFile = null;
  }
}

export const CORSAIR_BLOCKED: readonly BlockedCommand[] = [
  { what: "SET operating mode 3 / 5 (bootloader, MCU bootloader)", why: "bootloader", bytes: "SET 03 00 03|05", source: "FW Updater `Tt`, requestReconnectBootloader" },
  { what: "Firmware upload: open / write files 3, 18, 59, 60", why: "firmware", bytes: "0D 00 03 00 ...", source: "FW Updater `Ft`" },
  { what: "Apply firmware (0x10) and apply firmware extended (0x16)", why: "firmware", bytes: "10 .. / 16 ..", source: "FW Updater `Ct`" },
  { what: "Factory reset (0x0F, any scope)", why: "factory-reset", bytes: "0F ..", source: "Web Hub `resetToFactorySetting`" },
  { what: "Pairing control (0x11) and Web Hub pairing (0x12 with payload)", why: "pairing", bytes: "11 .. / 12 01 00 00", source: "FW Updater `Ct`, Web Hub `pairingCommand`" },
  { what: "Pairing secrets: files 5, 6, 20, 53", why: "pairing", bytes: "0D 00 05 00 ...", source: "FW Updater `Ft`, ckb RES_PAIRINGID/RES_ENCRYPTIONKEY" },
  { what: "Calibration control (0x0A), incl. magnetic-switch calibration; switch-settings file 75", why: "calibration", bytes: "0A .. / 0D 00 4B 00", source: "Web Hub CalibrationService" },
  { what: "Create / delete files (0x0B / 0x0C)", why: "profile-wipe", bytes: "0B .. / 0C ..", source: "Web Hub `createFileCommand` / `deleteFileCommand`" },
  { what: "Web Hub identity files 31000 / 28399 and listings", why: "identity", bytes: "0D 00 18 79 ...", source: "Web Hub `setDeviceId`" },
  { what: "Stopping another host's session (0x1B 02)", why: "identity", bytes: "1B 02 ..", source: "FW Updater `stopSession`" },
  { what: "Operating modes 4 / 6 / 7 (sleep, limited host, esports)", why: "identity", bytes: "SET 03 00 04|06|07", source: "Web Hub `Ee`" },
];
