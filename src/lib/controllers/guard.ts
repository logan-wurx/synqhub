// What SYNQ may send to a controller, checked report by report before it leaves (wave C1). The same rules are
// compiled into the bridge (src-tauri/src/pads.rs); both judge every line of src-tauri/src/pad-frames.txt
// (scripts/pad-fixtures.ts) the same way.
//
// - Every pad: input reports are read; nothing is sent unless its guard below allows it.
// - DualSense / Edge (`ds5`): output 0x02 (USB) / 0x31 (Bluetooth, sealed with its CRC) carrying exactly one volatile
//   effect: rumble, lightbar, player LEDs, mic LED, the adaptive-trigger test, or releasing the LEDs. Feature GET
//   0x05 (calibration) and 0x20 (firmware) only. Never 0x09 (pairing), never a feature SET.
// - DualShock 4 (`ds4`): output 0x05 (USB) / 0x11 (Bluetooth): rumble or lightbar only. Feature GET 0x02 / 0x05
//   (calibration) and 0xA3 (firmware). Never 0x12 (addresses), never a feature SET.
// - Switch Pro / Joy-Con (`switch`): output 0x80 (status, handshake, high speed, USB only, allow timeout), 0x10 (the
//   stop or the test-pulse rumble frame, nothing else) and 0x01 with the neutral rumble and one of the subcommands
//   0x02, 0x03 (0x30 / 0x3F), 0x10 (SPI read inside the calibration ranges), 0x30, 0x38, 0x40, 0x48. No features.
// - `input` (everyone else): nothing, ever.
//
// Pure functions: no DOM, no React, no device access.
import { DS4, DS4_BIT, DS5, DS5_AT, DS5_BIT, DS5_TRIGGER_EFFECTS, SWITCH, SWITCH_RUMBLE, SWITCH_SPI_MAX, SWITCH_SPI_READABLE, SWITCH_SUB, SWITCH_USB, sonyBtCrc } from "./frames.ts";
import { EDGE_READS, edgeFeatureSetProblem } from "./edge.ts";
import { checkGamesirOutput, type GamesirModel } from "./gamesir.ts";
import { checkScufOutput } from "./scuf.ts";
import { checkEbdOutput } from "./eightbitdo.ts";
import { checkFlydigiOutput } from "./flydigi.ts";

/** The GameSir guard families and the register map each one checks against. */
export const GAMESIR_GUARDS: Readonly<Partial<Record<PadGuard, GamesirModel>>> = { "gamesir-cyclone2": "cyclone2", "gamesir-g7pro8k": "g7pro8k", "gamesir-tarantula": "tarantula" };
import type { PadGuard } from "./types.ts";

export type PadVerdict = { ok: true; what: string } | { ok: false; why: string };

const ok = (what: string): PadVerdict => ({ ok: true, what });
const no = (why: string): PadVerdict => ({ ok: false, why });
const hex2 = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;
const zero = (d: Uint8Array, from: number, to = d.length) => d.subarray(from, to).every((b) => b === 0);
const same = (d: ArrayLike<number>, want: ArrayLike<number>) => d.length === want.length && Array.prototype.every.call(want, (b: number, i: number) => d[i] === b);

// ---- Sony

/** The 47-byte DualSense effects block: exactly one allowed effect, every other byte zero. */
function ds5Common(c: Uint8Array): PadVerdict {
  const e1 = c[DS5_AT.enable1];
  const e2 = c[DS5_AT.enable2];
  const effects: string[] = [];
  if (e1 & ~(DS5_BIT.vibration | DS5_BIT.hapticsSelect | DS5_BIT.rightTrigger | DS5_BIT.leftTrigger)) return no(`DualSense: enable flags ${hex2(e1)} aren't SYNQ's.`);
  if (e2 & ~(DS5_BIT.micLed | DS5_BIT.lightbar | DS5_BIT.releaseLeds | DS5_BIT.playerLeds)) return no(`DualSense: LED flags ${hex2(e2)} aren't SYNQ's.`);
  const rumble = e1 & (DS5_BIT.vibration | DS5_BIT.hapticsSelect);
  const triggers = e1 & (DS5_BIT.rightTrigger | DS5_BIT.leftTrigger);
  if (rumble && rumble !== (DS5_BIT.vibration | DS5_BIT.hapticsSelect)) return no("DualSense: rumble needs both of its flags.");
  if (triggers && triggers !== (DS5_BIT.rightTrigger | DS5_BIT.leftTrigger)) return no("DualSense: the trigger test sets both triggers.");
  if (rumble) effects.push("rumble");
  else if (c[DS5_AT.rumbleRight] || c[DS5_AT.rumbleLeft]) return no("DualSense: motor values without the rumble flags.");
  const right = c.subarray(DS5_AT.rightTrigger, DS5_AT.rightTrigger + 11);
  const left = c.subarray(DS5_AT.leftTrigger, DS5_AT.leftTrigger + 11);
  if (triggers) {
    const name = (Object.keys(DS5_TRIGGER_EFFECTS) as (keyof typeof DS5_TRIGGER_EFFECTS)[]).find((k) => same(right, DS5_TRIGGER_EFFECTS[k]));
    if (!name || !same(left, right)) return no("DualSense: only the off, resistance and vibration trigger tests are sent.");
    effects.push(`triggers ${name}`);
  } else if (!zero(right, 0) || !zero(left, 0)) return no("DualSense: trigger bytes without the trigger flags.");
  if (e2 & DS5_BIT.micLed) {
    if (c[DS5_AT.micLed] > 2) return no("DualSense: the mic LED is off, on or pulsing.");
    effects.push("mic LED");
  } else if (c[DS5_AT.micLed]) return no("DualSense: mic LED value without its flag.");
  if (e2 & DS5_BIT.lightbar) effects.push("lightbar");
  else if (c[DS5_AT.red] || c[DS5_AT.green] || c[DS5_AT.blue]) return no("DualSense: lightbar colour without its flag.");
  if (e2 & DS5_BIT.playerLeds) {
    if (c[DS5_AT.playerLeds] > 0x3f) return no("DualSense: player LED pattern out of range.");
    effects.push("player LEDs");
  } else if (c[DS5_AT.playerLeds]) return no("DualSense: player LEDs without their flag.");
  if (e2 & DS5_BIT.releaseLeds) effects.push("release LEDs");
  // Audio (4..7, 9), the unknown block (32..37), enable bits 3 (38), 39..42 (lightbar setup, brightness): never.
  for (const [from, to] of [[4, 8], [9, 10], [32, 43]] as const) if (!zero(c, from, to)) return no(`DualSense: bytes ${from}..${to - 1} are audio or setup controls SYNQ never sends.`);
  if (effects.length !== 1) return no(effects.length ? `DualSense: one effect per report (${effects.join(", ")}).` : "DualSense: an empty effects report isn't sent.");
  return ok(`DualSense ${effects[0]}`);
}

function ds5Output(reportId: number, d: Uint8Array): PadVerdict {
  if (reportId === DS5.USB_OUTPUT) {
    if (d.length < DS5.USB_LEN) return no("DualSense: USB output report too short.");
    if (!zero(d, DS5.USB_LEN)) return no("DualSense: bytes after the effects block.");
    return ds5Common(d.subarray(0, DS5.COMMON));
  }
  if (reportId === DS5.BT_OUTPUT) {
    if (d.length !== DS5.BT_LEN) return no(`DualSense: Bluetooth output report is ${DS5.BT_LEN} bytes.`);
    if (d[0] & 0x0f || d[1] !== DS5.BT_TAG) return no("DualSense: Bluetooth sequence/tag bytes.");
    if (!zero(d, 2 + DS5.COMMON, DS5.BT_LEN - 4)) return no("DualSense: padding before the CRC.");
    const crc = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(DS5.BT_LEN - 4, true);
    if (crc !== sonyBtCrc(reportId, d.subarray(0, DS5.BT_LEN - 4))) return no("DualSense: Bluetooth CRC doesn't match.");
    return ds5Common(d.subarray(2, 2 + DS5.COMMON));
  }
  return no(`DualSense: output report ${hex2(reportId)} isn't one SYNQ sends.`);
}

/** DualShock 4 common block (10 bytes): rumble or lightbar, no blink, nothing else. */
function ds4Common(c: Uint8Array): PadVerdict {
  const f = c[0];
  if (c[1] || c[2] || c[8] || c[9]) return no("DualShock 4: flags 2, reserved and blink bytes stay zero.");
  if (f === DS4_BIT.motor) return c[5] || c[6] || c[7] ? no("DualShock 4: colour without the LED flag.") : ok("DualShock 4 rumble");
  if (f === DS4_BIT.led) return c[3] || c[4] ? no("DualShock 4: motor values without the rumble flag.") : ok("DualShock 4 lightbar");
  return no(`DualShock 4: flags ${hex2(f)}: one of rumble or lightbar per report.`);
}

function ds4Output(reportId: number, d: Uint8Array): PadVerdict {
  if (reportId === DS4.USB_OUTPUT) {
    if (d.length < 10) return no("DualShock 4: USB output report too short.");
    if (!zero(d, 10)) return no("DualShock 4: bytes after the effects.");
    return ds4Common(d.subarray(0, 10));
  }
  if (reportId === DS4.BT_OUTPUT) {
    if (d.length !== DS4.BT_LEN) return no(`DualShock 4: Bluetooth output report is ${DS4.BT_LEN} bytes.`);
    if (d[0] !== DS4.BT_HW_CONTROL || d[1] !== 0) return no("DualShock 4: Bluetooth control bytes.");
    if (!zero(d, 12, DS4.BT_LEN - 4)) return no("DualShock 4: padding before the CRC.");
    const crc = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(DS4.BT_LEN - 4, true);
    if (crc !== sonyBtCrc(reportId, d.subarray(0, DS4.BT_LEN - 4))) return no("DualShock 4: Bluetooth CRC doesn't match.");
    return ds4Common(d.subarray(2, 12));
  }
  return no(`DualShock 4: output report ${hex2(reportId)} isn't one SYNQ sends.`);
}

// ---- Nintendo

const SUBCOMMAND_NAMES: Record<number, string> = {
  0x01: "Bluetooth pairing",
  0x06: "HCI state (sleep, reboot, pairing)",
  0x07: "reset pairing",
  0x08: "shipment mode",
  0x11: "SPI flash write",
  0x12: "SPI flash erase",
  0x41: "IMU sensitivity",
  0x42: "IMU register write",
  0x50: "GPIO",
  0x51: "GPIO",
  0x52: "GPIO",
};

/** Why a subcommand is refused, by name where it's a known dangerous one. */
function refusedSub(id: number): string {
  if (id >= 0x20 && id <= 0x2b) return `Switch: subcommand ${hex2(id)} (NFC/IR MCU) is never sent.`;
  return `Switch: subcommand ${hex2(id)}${SUBCOMMAND_NAMES[id] ? ` (${SUBCOMMAND_NAMES[id]})` : ""} is never sent.`;
}

function switchOutput(reportId: number, d: Uint8Array): PadVerdict {
  if (d.length !== SWITCH.BT_LEN && d.length !== SWITCH.USB_LEN) return no(`Switch: output reports are ${SWITCH.BT_LEN} (Bluetooth) or ${SWITCH.USB_LEN} (USB) bytes.`);
  if (reportId === SWITCH.USB_COMMAND) {
    const cmd = d[0];
    if (!Object.values(SWITCH_USB).includes(cmd as never)) return no(`Switch: USB command ${hex2(cmd)} is never sent${cmd === 0x06 ? " (MCU reset)" : ""}.`);
    return zero(d, 1) ? ok(`Switch USB ${hex2(cmd)}`) : no("Switch: USB commands carry no data.");
  }
  if (d[0] > 0x0f) return no("Switch: the packet counter is 4 bits.");
  const rumble = d.subarray(1, 9);
  if (reportId === SWITCH.RUMBLE) {
    if (!zero(d, 9)) return no("Switch: the rumble report carries rumble only.");
    if (same(rumble, SWITCH_RUMBLE.stop)) return ok("Switch rumble stop");
    if (same(rumble, SWITCH_RUMBLE.pulse)) return ok("Switch rumble test pulse");
    return no("Switch: only the stop and test-pulse rumble frames are sent.");
  }
  if (reportId !== SWITCH.SUBCOMMAND) return no(`Switch: output report ${hex2(reportId)} isn't one SYNQ sends.`);
  if (!same(rumble, SWITCH_RUMBLE.stop)) return no("Switch: a subcommand carries the neutral rumble.");
  const sub = d[9];
  const args = d.subarray(10);
  const rest = (n: number) => zero(args, n);
  switch (sub) {
    case SWITCH_SUB.deviceInfo:
      return rest(0) ? ok("Switch device info") : no("Switch: device info takes no arguments.");
    case SWITCH_SUB.inputMode:
      return (args[0] === 0x30 || args[0] === 0x3f) && rest(1) ? ok(`Switch input mode ${hex2(args[0])}`) : no("Switch: input mode 0x30 (full) or 0x3F (simple, to restore) only.");
    case SWITCH_SUB.spiRead: {
      const address = new DataView(args.buffer, args.byteOffset, 4).getUint32(0, true);
      const length = args[4];
      if (!rest(5) || length < 1 || length > SWITCH_SPI_MAX) return no("Switch: SPI read of 1 to 29 bytes, no other arguments.");
      const inside = SWITCH_SPI_READABLE.some(([first, last]) => address >= first && address + length - 1 <= last);
      return inside ? ok(`Switch SPI read 0x${address.toString(16)}+${length}`) : no(`Switch: SPI 0x${address.toString(16)}+${length} is outside the calibration ranges.`);
    }
    case SWITCH_SUB.playerLights:
      return rest(1) ? ok("Switch player lights") : no("Switch: player lights take one byte.");
    case SWITCH_SUB.homeLight: {
      const i = args[1] >> 4;
      return args[0] === 0x01 && args[1] === i << 4 && args[2] === i << 4 && args[3] === 0 && rest(4) ? ok("Switch HOME light") : no("Switch: HOME light takes SYNQ's one steady pattern.");
    }
    case SWITCH_SUB.imu:
      return args[0] <= 1 && rest(1) ? ok(`Switch IMU ${args[0] ? "on" : "off"}`) : no("Switch: IMU on or off only.");
    case SWITCH_SUB.vibration:
      return args[0] <= 1 && rest(1) ? ok(`Switch vibration ${args[0] ? "on" : "off"}`) : no("Switch: vibration on or off only.");
    default:
      return no(refusedSub(sub));
  }
}

// ---- the guard

const NAME: Record<PadGuard, string> = {
  ds5: "DualSense",
  edge: "DualSense Edge",
  ds4: "DualShock 4",
  switch: "Switch controller",
  "gamesir-cyclone2": "GameSir Cyclone 2",
  "gamesir-g7pro8k": "GameSir G7 Pro 8K",
  "gamesir-tarantula": "GameSir Tarantula Pro 8K",
  scuf: "SCUF Envision",
  "8bitdo": "8BitDo Ultimate",
  flydigi: "Flydigi",
  input: "This controller",
};

export function checkPadOutput(guard: PadGuard, reportId: number, data: Uint8Array): PadVerdict {
  switch (guard) {
    case "ds5":
    case "edge":
      return ds5Output(reportId, data);
    case "ds4":
      return ds4Output(reportId, data);
    case "switch":
      return switchOutput(reportId, data);
    case "gamesir-cyclone2":
    case "gamesir-g7pro8k":
    case "gamesir-tarantula":
      return checkGamesirOutput(GAMESIR_GUARDS[guard]!, reportId, data);
    case "scuf":
      return checkScufOutput(reportId, data);
    case "8bitdo":
      return checkEbdOutput(reportId, data);
    case "flydigi":
      return checkFlydigiOutput(reportId, data);
    case "input":
      return no(`${NAME.input} is read only: SYNQ sends it nothing.`);
  }
}

export function checkPadFeatureGet(guard: PadGuard, reportId: number): PadVerdict {
  if (guard === "edge" && EDGE_READS.includes(reportId)) return ok("DualSense Edge profile read");
  if (guard === "ds5" || guard === "edge") {
    if (reportId === DS5.FEATURE_CALIBRATION) return ok("DualSense calibration read");
    if (reportId === DS5.FEATURE_FIRMWARE) return ok("DualSense firmware read");
    return no(`DualSense: feature ${hex2(reportId)} isn't read${reportId === DS5.FEATURE_PAIRING ? " (it holds the Bluetooth addresses)" : ""}.`);
  }
  if (guard === "ds4") {
    if (reportId === DS4.FEATURE_CALIBRATION_USB || reportId === DS4.FEATURE_CALIBRATION_BT) return ok("DualShock 4 calibration read");
    if (reportId === DS4.FEATURE_FIRMWARE) return ok("DualShock 4 firmware read");
    return no(`DualShock 4: feature ${hex2(reportId)} isn't read${reportId === DS4.FEATURE_SERIAL ? " (it holds the Bluetooth addresses)" : ""}.`);
  }
  return no(`${NAME[guard]}: no feature report is read.`);
}

/**
 * A feature SET. Only the DualSense Edge takes any: its three custom profile slots (0x60-0x62, each part checked:
 * part index, the fields' ranges, its CRC) and their deletes (0x68, slots 2-4). Never 0x63 (the default profile).
 */
export function checkPadFeatureSet(guard: PadGuard, reportId: number, data: Uint8Array = new Uint8Array()): PadVerdict {
  if (guard === "edge") {
    const why = edgeFeatureSetProblem(reportId, data);
    return why ? no(`DualSense Edge: ${why}.`) : ok(reportId === 0x68 ? "DualSense Edge profile delete" : "DualSense Edge profile part");
  }
  return no(`${NAME[guard]}: feature report ${hex2(reportId)} would change the pad; SYNQ sets no feature reports on controllers.`);
}
