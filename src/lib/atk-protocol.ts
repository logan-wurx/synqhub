// ATK (Compx) mouse protocol, as spoken by the X1 V2 Air+ through its "Wireless mouse 8k
// dongle-L" receiver (373b:1278). Pure functions only: no HID here, so it can be checked offline.
//
// Transport: vendor collection FF02:0002, output/input report 0x08, 16-byte frames
//   [cmd][status][addr hi][addr lo][len][data x10][checksum], report id + all 16 bytes sum to 0x55.
// Settings live in the mouse's EEPROM as value/checksum pairs (value + check = 0x55).
//
// Sources, and how sure each piece is:
//   [hw]   read and written on the user's mouse, 2026-10-12 (CID/MID 1,61, firmware 5.20, receiver 5.01)
//   [hub]  ATK HUB 3.2.27 web bundle (hub.atk.pro, static/index-F-MYsmWR.js): enum `en` (commands),
//          `At.Address` (EEPROM map), classes j2/Wu/Tf/Yu/qu/Qu (row layouts), sO (PAW3955 DPI encoder)
//   [om]   @openmouse/protocol 0.36 (AGPL): WE framing, PAW3955 decoder, lift-off scale, model catalog
import { WE_REPORT_ID, weBuildCmdPayload, weReportChecksum } from "@openmouse/protocol/endgame-gear-we";
import { ATK_LIFT_OFF_MAX_CODE, ATK_LIFT_OFF_MIN_CODE, atkBuildReceiverPairRequest, atkDecodeLiftOff, atkUnpackDpiStageForSensor, type AtkSensor } from "@openmouse/protocol/atk";
import { granted, type AdvancedScope, type Grants } from "./advanced/core.ts";

export const REPORT_ID = WE_REPORT_ID; // 0x08 [hw]
export const FRAME_LENGTH = 16;
export const DATA_OFFSET = 5;
export const MAX_DATA = 10;
/** The config channel; the bridge opens nothing else on ATK devices. [hw] */
export const CONFIG_COLLECTION = { usagePage: 0xff02, usage: 0x0002 } as const;
export const ATK_VENDOR_ID = 0x373b;

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/** Everything SYNQ sends. All reads except setEeprom, which is limited to WRITABLE_ROWS. [hub][hw] */
export const CMD = {
  getMouseOnline: 0x03, // receiver answers itself: [online, rf id x3]
  getBattery: 0x04, // [percent, charging]
  setEeprom: 0x07,
  getEeprom: 0x08,
  getCidMid: 0x10, // [cid, mid, ?]
  getVersion: 0x12, // BCD [major, minor]
  getDongleVersion: 0x1d, // BCD [major, minor]
} as const;

/**
 * Commands SYNQ never sends by default: firmware, bootloader, pairing and reset. Listed so they can
 * be blocked. Three of them can be unlocked, each only for the Advanced action that needs it and only
 * while the panel's AdvancedGate holds a live token (ADVANCED_COMMANDS): 0x05 and 0x06 (pairing) and
 * 0x09 (factory reset). The rest never get through, whatever is granted: firmware transfer (0x01, 0x02,
 * 0x5A, 0x5B), the bootloader (0x0D), the profile bank switch (0x0F), un-pairing (0x13) and the
 * unknown ones. [hub] enum `en`
 */
export const FORBIDDEN_COMMANDS: ReadonlyMap<number, string> = new Map([
  [0x01, "DownLoadData: firmware transfer"],
  [0x02, "DownLoadDriverStatus: firmware transfer status"],
  [0x05, "SetWirelessDonglePair: starts receiver pairing"],
  [0x06, "GetWirelessDonglePairResult: pairing flow"],
  [0x09, "RestoreFactory: factory reset of every setting"],
  [0x0a, "ReportMouseStatus: device-to-host only"],
  [0x0b, "Reserved1: meaning unknown"],
  [0x0c, "Reserved2: meaning unknown"],
  [0x0d, "EnterUSBUpgradeMode: jumps to the bootloader"],
  [0x0f, "SetCurrentConfig: switches the onboard profile bank"],
  [0x11, "Reserved3: meaning unknown"],
  [0x13, "DongleExitPair: unpairs the receiver"],
  [0x5a, "ReportMouseUpgradeErrorStatus: firmware update"],
  [0x5b, "ReportMouseUpgradeStatus: firmware update"],
]);

export const ALLOWED_COMMANDS: ReadonlySet<number> = new Set(Object.values(CMD));

/**
 * The only forbidden commands an Advanced action can unlock, and which one. [hub] `en`, `yTe` (pair
 * request), `vTe` (pair result), `_D` (RestoreFactory); [om] ATK_COMPX_COMMAND, atkBuildReceiverPairRequest.
 */
export const ADVANCED_COMMANDS: ReadonlyMap<number, AdvancedScope> = new Map<number, AdvancedScope>([
  [0x05, "pair"], // SetWirelessDonglePair [cid, mid]
  [0x06, "pair"], // GetWirelessDonglePairResult -> [status, seconds left]
  [0x09, "reset"], // RestoreFactory
]);

/** ATK HUB's pair result: status 3 means paired (its own flow polls for it once a second for 30 s). [hub] */
export const PAIR_STATUS_PAIRED = 3;
export const PAIR_WINDOW_SECONDS = 30;

// ---------------------------------------------------------------------------------------------
// EEPROM map [hub] At.Address, [hw] values on the user's mouse
// ---------------------------------------------------------------------------------------------

export const ADDR = {
  /** 10 bytes: rate, stage count, active stage, bhop, button-operation mode (bit 7 = DPI toggle). */
  system: 0x0000,
  /** 2 bytes: lift-off code, 1..11 = 0.7..1.7 mm ("silentHeight"). */
  liftOff: 0x000a,
  /** 6 bytes per stage, 8 stages ("paw3955Dpi1..8"). The 4-byte rows at 0x000c are legacy; ATK HUB leaves them alone for this sensor. */
  paw3955Dpi: 0x1b00,
  /** 10 bytes: debounce ms, motion sync, sleep (x10 s), angle snapping ("linearCorrection"), ripple control. */
  function: 0x00a9,
  /** 6 bytes: sensor sleep enabled, sensor sleep (x10 s), sensor mode. */
  performance: 0x00b5,
  /** 4 bytes: sensor rotation degrees, rotation enabled. Read only here. */
  angle: 0x00bd,
} as const;

/**
 * The button rows: 4 bytes each, [class, value 1, value 2, check] with the four summing to 0x55, one per
 * button from 0x0060 in steps of 4 (key0..key5). [hub] At.Address.key0..key5 and the model's
 * `buttonKeys` / `buttonKeysValue`; [om] ATK_R1_BUTTONS, atkDecodeButtonAssignment. SYNQ writes
 * these (class 0 off, 1 mouse button, 2 DPI control) only inside the Advanced "remap" action.
 */
export const KEY_ROW = { base: 0x0060, length: 4, count: 6 } as const;
export const KEY_CLASS = { off: 0x00, mouse: 0x01, dpi: 0x02 } as const;
/** Mouse-button values of class 1. [hub] ButtonKeyValue1Mouse; [om] MOUSE_ACTION_LABELS */
export const MOUSE_BUTTON_VALUES: Readonly<Record<number, string>> = { 1: "Left click", 2: "Right click", 4: "Middle click", 8: "Back", 16: "Forward" };
/** DPI-control values of class 2. [hub] ButtonKeyValue1Dpi; [om] DPI_ACTION_LABELS */
export const DPI_CONTROL_VALUES: Readonly<Record<number, string>> = { 1: "DPI cycle", 2: "DPI up", 3: "DPI down" };

/** The six buttons in row order, with their factory actions. [hub] buttonKeys, buttonKeysValue */
export const BUTTONS = [
  { id: "left", label: "Left button", factory: { kind: "mouse", value: 1 } },
  { id: "right", label: "Right button", factory: { kind: "mouse", value: 2 } },
  { id: "middle", label: "Wheel click", factory: { kind: "mouse", value: 4 } },
  { id: "back", label: "Back side button", factory: { kind: "mouse", value: 8 } },
  { id: "forward", label: "Forward side button", factory: { kind: "mouse", value: 16 } },
  { id: "bottom", label: "DPI button", factory: { kind: "dpi", value: 1 } },
] as const;
export type ButtonId = (typeof BUTTONS)[number]["id"];
export const keyRowAddress = (index: number) => KEY_ROW.base + index * KEY_ROW.length;

/** One button's action. */
export type ButtonAction = { kind: "off" } | { kind: "mouse"; value: number } | { kind: "dpi"; value: number };

/** The row for an action, check byte included. */
export function packButton(a: ButtonAction): number[] {
  const body = a.kind === "off" ? [KEY_CLASS.off, 0, 0] : a.kind === "mouse" ? [KEY_CLASS.mouse, a.value, 0] : [KEY_CLASS.dpi, a.value, 0];
  return [...body, (0x55 - body.reduce((s, b) => s + b, 0)) & 0xff];
}

/** The action in a row, or null when the row is something SYNQ doesn't write (a macro, a shortcut...) or fails its check. */
export function unpackButton(row: readonly number[]): ButtonAction | null {
  if (row.length !== KEY_ROW.length || (row.reduce((s, b) => s + b, 0) & 0xff) !== 0x55) return null;
  const [cls, v1, v2] = row;
  if (v2 !== 0) return null;
  if (cls === KEY_CLASS.off && v1 === 0) return { kind: "off" };
  if (cls === KEY_CLASS.mouse && v1 in MOUSE_BUTTON_VALUES) return { kind: "mouse", value: v1 };
  if (cls === KEY_CLASS.dpi && v1 in DPI_CONTROL_VALUES) return { kind: "dpi", value: v1 };
  return null;
}

/** The left button's row: it is always left click, whatever is granted. */
export const LEFT_CLICK_ROW: readonly number[] = packButton({ kind: "mouse", value: 1 });

export const PAW3955_STAGE_LENGTH = 6;
export const PAW3955_MAX_STAGES = 8;
export const SYSTEM_LENGTH = 10;
export const FUNCTION_LENGTH = 10;
export const PERFORMANCE_LENGTH = 6;

interface WritableRow {
  length: number;
  name: string;
  /** "pairs": every value/checksum pair sums to 0x55. "paw3955": the whole 6-byte row does. */
  layout: "pairs" | "paw3955";
}

/** The only EEPROM rows SYNQ writes, each whole, at exactly this length. */
export const WRITABLE_ROWS: ReadonlyMap<number, WritableRow> = new Map<number, WritableRow>([
  [ADDR.system, { length: SYSTEM_LENGTH, name: "system row", layout: "pairs" }],
  [ADDR.liftOff, { length: 2, name: "lift-off", layout: "pairs" }],
  [ADDR.function, { length: FUNCTION_LENGTH, name: "function row", layout: "pairs" }],
  [ADDR.performance, { length: PERFORMANCE_LENGTH, name: "performance row", layout: "pairs" }],
  ...Array.from({ length: PAW3955_MAX_STAGES }, (_, i): [number, WritableRow] => [
    ADDR.paw3955Dpi + i * PAW3955_STAGE_LENGTH,
    { length: PAW3955_STAGE_LENGTH, name: `DPI stage ${i + 1}`, layout: "paw3955" },
  ]),
]);

// ---------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------

const hi = (a: number) => (a >> 8) & 0xff;
const lo = (a: number) => a & 0xff;

export const buildCommand = (cmd: number): Uint8Array => weBuildCmdPayload(cmd);
export const buildRead = (address: number, length: number): Uint8Array => weBuildCmdPayload(CMD.getEeprom, [0, hi(address), lo(address), length]);
export const buildWrite = (address: number, data: readonly number[]): Uint8Array =>
  weBuildCmdPayload(CMD.setEeprom, [0, hi(address), lo(address), data.length, ...data]);

export const frameChecksumOk = (f: Uint8Array | readonly number[]): boolean =>
  f.length === FRAME_LENGTH && f[15] === weReportChecksum(REPORT_ID, Array.from(f).slice(0, 15));

const pairsOk = (data: readonly number[]) => data.length % 2 === 0 && data.every((v, i) => i % 2 === 1 || ((v + data[i + 1]) & 0xff) === 0x55);
const rowSumOk = (data: readonly number[]) => (data.reduce((s, b) => s + b, 0) & 0xff) === 0x55;

/**
 * Gatekeeper for the transport: null when the frame may be sent, else why not. Rejects forbidden
 * and unknown commands, bad checksums, EEPROM writes outside WRITABLE_ROWS or at the wrong length,
 * and rows whose own value/checksum pairs would not hold.
 */
export function checkFrame(f: Uint8Array, grants?: Grants): string | null {
  if (f.length !== FRAME_LENGTH) return `frame must be ${FRAME_LENGTH} bytes, got ${f.length}`;
  const cmd = f[0];
  const forbidden = FORBIDDEN_COMMANDS.get(cmd);
  const unlock = ADVANCED_COMMANDS.get(cmd);
  if (forbidden && !(unlock && granted(grants, unlock))) return `forbidden command 0x${cmd.toString(16)}: ${forbidden}`;
  if (!forbidden && !ALLOWED_COMMANDS.has(cmd)) return `command 0x${cmd.toString(16)} is not on the ATK allow-list`;
  if (!frameChecksumOk(f)) return "bad frame checksum";
  if (cmd === CMD.getEeprom) {
    if (f[4] < 1 || f[4] > MAX_DATA) return `read length ${f[4]} out of range`;
    if (f[1] !== 0 || !f.subarray(5, 15).every((b) => b === 0)) return "a read is [8, 0, address hi, address lo, length] and nothing else";
  }
  // A command with no arguments carries nothing after its id (every builder here makes it that way).
  if (BARE_COMMANDS.has(cmd) && !f.subarray(1, 15).every((b) => b === 0)) return `command 0x${cmd.toString(16)} takes no arguments`;
  if (cmd === ADV_PAIR) return pairShape(f);
  if (cmd !== CMD.setEeprom) return null;
  const address = (f[2] << 8) | f[3];
  const row = WRITABLE_ROWS.get(address);
  if (!row) {
    const key = keyRowIndex(address);
    if (key === null) return `EEPROM address 0x${address.toString(16).padStart(4, "0")} is not writable from SYNQ`;
    if (!granted(grants, "remap")) return `${BUTTONS[key].label}: button rows are only written from Advanced`;
    return keyRowProblem(key, f);
  }
  if (f[4] !== row.length) return `${row.name} must be written whole (${row.length} bytes), got ${f[4]}`;
  const data = Array.from(f.subarray(DATA_OFFSET, DATA_OFFSET + row.length));
  if (row.layout === "pairs" ? !pairsOk(data) : !rowSumOk(data)) return `${row.name} has a bad value/checksum pair`;
  if (f[1] !== 0 || !f.subarray(DATA_OFFSET + row.length, 15).every((b) => b === 0)) return `${row.name}: nothing follows the row`;
  return null;
}

const ADV_PAIR = 0x05;
/** Commands whose frame is the id and nothing else. */
const BARE_COMMANDS: ReadonlySet<number> = new Set([CMD.getMouseOnline, CMD.getBattery, CMD.getCidMid, CMD.getVersion, CMD.getDongleVersion, 0x06, 0x09]);

/** Mice the pair request may name: the ones SYNQ has checked (CID/MID). */
export function pairableModel(cid: number, mid: number): boolean {
  return ATK_MODELS[`${cid},${mid}`]?.verified === true;
}

function pairShape(f: Uint8Array): string | null {
  if (f[1] !== 0 || f[2] !== 0 || f[3] !== 0 || f[4] !== 2) return "a pair request is [5, 0, 0, 0, 2, CID, MID]";
  if (!f.subarray(7, 15).every((b) => b === 0)) return "a pair request carries nothing after CID and MID";
  if (!pairableModel(f[5], f[6])) return `pairing is only offered for a mouse SYNQ has checked (CID/MID ${f[5]},${f[6]} isn't one)`;
  return null;
}

/** Which button a key-row address belongs to, or null. */
export function keyRowIndex(address: number): number | null {
  const i = (address - KEY_ROW.base) / KEY_ROW.length;
  return Number.isInteger(i) && i >= 0 && i < KEY_ROW.count ? i : null;
}

function keyRowProblem(index: number, f: Uint8Array): string | null {
  const label = BUTTONS[index].label;
  if (f[4] !== KEY_ROW.length) return `${label} must be written whole (${KEY_ROW.length} bytes), got ${f[4]}`;
  const row = Array.from(f.subarray(DATA_OFFSET, DATA_OFFSET + KEY_ROW.length));
  if (f[1] !== 0 || !f.subarray(DATA_OFFSET + KEY_ROW.length, 15).every((b) => b === 0)) return `${label}: nothing follows the row`;
  if (!unpackButton(row)) return `${label} has an action SYNQ doesn't write`;
  // Left click is never remapped away: the first button's row is left click, always.
  if (index === 0 && row.join() !== LEFT_CLICK_ROW.join()) return "The left button always stays left click";
  return null;
}

/** The frame that writes one button row (check byte included). */
export const buildButtonWrite = (index: number, action: ButtonAction): Uint8Array => buildWrite(keyRowAddress(index), packButton(action));
/** The pair request for one mouse, as OpenMouse builds it. [om] */
export const buildPairRequest = (cid: number, mid: number): Uint8Array => atkBuildReceiverPairRequest(cid, mid);
/** GetWirelessDonglePairResult. */
export const buildPairResult = (): Uint8Array => buildCommand(0x06);
/** RestoreFactory: a bare 0x09. [hub] `_D` */
export const buildRestoreFactory = (): Uint8Array => buildCommand(0x09);

/** The pair result in a reply: its status and the seconds left in the window. [om] atkDecodePairingStatus */
export function decodePairResult(reply: Uint8Array): { status: number; secondsLeft: number } | null {
  if (reply[0] !== 0x06 || reply[1] !== 0 || reply[4] < 2 || !frameChecksumOk(reply)) return null;
  return { status: reply[DATA_OFFSET], secondsLeft: reply[DATA_OFFSET + 1] };
}

/** Does `reply` answer an EEPROM read of `length` bytes at `address`? (Some firmware echoes 0x07.) */
export const isReadReply = (r: Uint8Array, address: number, length: number) =>
  (r[0] === CMD.getEeprom || r[0] === CMD.setEeprom) && r[1] === 0 && r[2] === hi(address) && r[3] === lo(address) && r[4] >= length && frameChecksumOk(r);

/** Does `reply` echo a write of `data` at `address`? [hw] the receiver echoes every write. */
export const isWriteEcho = (r: Uint8Array, address: number, data: readonly number[]) =>
  r[0] === CMD.setEeprom && r[1] === 0 && r[2] === hi(address) && r[3] === lo(address) && r[4] === data.length && data.every((b, i) => r[DATA_OFFSET + i] === b);

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

export const pair = (value: number): [number, number] => [value & 0xff, (0x55 - value) & 0xff];
export const unpair = (value: number, check: number): number | null => (((value + check) & 0xff) === 0x55 ? value : null);

/** Replaces the pair at `offset` in a copy of `row`. */
export function withPair(row: readonly number[], offset: number, value: number): number[] {
  const next = [...row];
  next.splice(offset, 2, ...pair(value));
  return next;
}

function pairAt(row: readonly number[], offset: number, what: string): number {
  const v = unpair(row[offset], row[offset + 1]);
  if (v === null) throw new Error(`The mouse reported a ${what} that failed its checksum.`);
  return v;
}

/** Report-rate codes. [hub] At.ReportRate */
const RATE_CODES: [number, number][] = [
  [0x08, 125],
  [0x04, 250],
  [0x02, 500],
  [0x01, 1000],
  [0x10, 2000],
  [0x20, 4000],
  [0x40, 8000],
];
export const rateForCode = (code: number) => RATE_CODES.find(([c]) => c === code)?.[1] ?? null;
export const codeForRate = (hz: number) => RATE_CODES.find(([, r]) => r === hz)?.[0] ?? null;
/** Rates through the 8K receiver: 125 to 8000 Hz. [hub] mdt + ydt for dongle8K */
export const RATES_8K = RATE_CODES.map(([, hz]) => hz);

export interface SystemRow {
  pollingHz: number;
  stageCount: number;
  activeStage: number;
}

export function decodeSystem(row: readonly number[]): SystemRow {
  const code = pairAt(row, 0, "polling rate");
  const pollingHz = rateForCode(code);
  if (pollingHz === null) throw new Error(`The mouse reported an unknown polling-rate code 0x${code.toString(16)}.`);
  const stageCount = pairAt(row, 2, "DPI stage count");
  const activeStage = pairAt(row, 4, "active DPI stage");
  if (stageCount < 1 || stageCount > PAW3955_MAX_STAGES) throw new Error(`The mouse reported ${stageCount} DPI stages.`);
  return { pollingHz, stageCount, activeStage: Math.min(activeStage, stageCount - 1) };
}

/** PAW3955 Master: 50..40000 (SYNQ's range; ATK HUB allows 1..50000 with doubling above 40000). */
export const PAW3955_DPI = { min: 50, max: 40000, step: 1 } as const;

/**
 * One 6-byte PAW3955 stage row, exactly as ATK HUB builds it (`sO` + `Tf.create`): below 40000 the
 * value is dpi-1 little-endian; from 40000 it is halved with the axis "double" flag set. [hub][hw]
 */
export function packPaw3955Stage(x: number, y: number = x): number[] {
  const axis = (dpi: number) => {
    const t = Math.max(1, Math.floor(dpi));
    if (t < 40000) return { base: t - 1, mult: false };
    const half = (t % 2 === 0 ? t : t - 1) / 2;
    return { base: Math.min(half - 1, 0xffff), mult: true };
  };
  const ax = axis(x);
  const ay = axis(y);
  const flags = (ax.mult ? 0x01 : 0) | (ay.mult ? 0x10 : 0);
  const row = [ax.base & 0xff, (ax.base >> 8) & 0xff, ay.base & 0xff, (ay.base >> 8) & 0xff, flags];
  return [...row, (0x55 - (row.reduce((s, b) => s + b, 0) & 0xff)) & 0xff];
}

export function unpackPaw3955Stage(row: readonly number[]): { x: number; y: number } {
  const stage = atkUnpackDpiStageForSensor("PAW3955Master", row);
  if (!stage) throw new Error("The mouse reported a DPI stage that failed its checksum.");
  return stage;
}

export const LIFT_OFF = { minMm: 0.7, maxMm: 1.7, stepMm: 0.1, minCode: ATK_LIFT_OFF_MIN_CODE, maxCode: ATK_LIFT_OFF_MAX_CODE } as const;
/** Code 1..11 = 0.7..1.7 mm. [hub] SilenceHeightUltimate, for PAW3950Ultra / PAW3955MASTER */
export const liftOffMm = (code: number): number | null => (code >= LIFT_OFF.minCode && code <= LIFT_OFF.maxCode ? atkDecodeLiftOff(code) : null);
export const liftOffCode = (mm: number): number => Math.round(mm * 10) - 6;

export interface FunctionRow {
  debounceMs: number;
  motionSync: boolean;
  sleepSeconds: number;
  angleSnapping: boolean;
  rippleControl: boolean;
}

/** Offsets inside the function row. [hub] class Yu */
export const FN = { debounce: 0, motionSync: 2, sleep: 4, angleSnapping: 6, rippleControl: 8 } as const;

export function decodeFunction(row: readonly number[]): FunctionRow {
  return {
    debounceMs: pairAt(row, FN.debounce, "debounce time"),
    motionSync: pairAt(row, FN.motionSync, "motion sync flag") === 1,
    sleepSeconds: pairAt(row, FN.sleep, "sleep time") * 10,
    angleSnapping: pairAt(row, FN.angleSnapping, "angle snapping flag") === 1,
    rippleControl: pairAt(row, FN.rippleControl, "ripple control flag") === 1,
  };
}

/** Debounce choices ATK HUB offers (models flagged noZeroKeyDebounce start at 1). [hub] NZ / c3t */
export const DEBOUNCE_MS = [0, 1, 2, 4, 8, 15, 20] as const;

export type SensorMode = 0 | 1 | 2;
/** Offsets inside the performance row. [hub] class qu */
export const PERF = { sensorSleepEnabled: 0, sensorSleep: 2, sensorMode: 4 } as const;
export const SENSOR_MODES: { value: SensorMode; label: string; hint: string }[] = [
  { value: 0, label: "Basic", hint: "Longest battery" },
  { value: 1, label: "Competitive", hint: "Faster sensor" },
  { value: 2, label: "Competitive MAX", hint: "20,000 fps" },
];

export function decodeSensorMode(row: readonly number[]): SensorMode | null {
  const mode = unpair(row[PERF.sensorMode], row[PERF.sensorMode + 1]);
  return mode === 0 || mode === 1 || mode === 2 ? mode : null;
}

/** BCD version bytes, e.g. [0x05, 0x20] -> "5.20". */
export const bcdVersion = (major: number, minor: number) => `${Number(major.toString(16))}.${minor.toString(16).padStart(2, "0")}`;

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

export interface AtkModel {
  name: string;
  sensor: AtkSensor;
  sensorLabel: string;
  /** Writes are enabled only for models whose rows were checked on hardware. */
  verified: boolean;
  debounceFromZero: boolean;
}

/** Mice SYNQ has checked, keyed by the CID/MID they answer with (command 0x10). */
export const ATK_MODELS: Readonly<Record<string, AtkModel>> = {
  // ATK HUB lists it as "ATK X1 Air +" (373b:12a2, cidMid 1,61, x1v2 artwork).
  "1,61": { name: "X1 V2 Air+", sensor: "PAW3955Master", sensorLabel: "PAW3955 Master", verified: true, debounceFromZero: true },
};

/** Receivers and cables SYNQ opens (the bridge allows exactly these). */
export const ATK_LINKS: Readonly<Record<number, { detail: string; wireless: boolean; rates: readonly number[]; verified: boolean }>> = {
  0x1278: { detail: "8K receiver", wireless: true, rates: RATES_8K, verified: true },
  // From ATK HUB's table; not yet seen on this PC, so SYNQ only reads over the cable.
  0x12a2: { detail: "USB cable", wireless: false, rates: RATES_8K, verified: false },
};
