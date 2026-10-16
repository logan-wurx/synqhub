// SCUF Envision Pro and Envision Pro V2 (wave C2): read only. Their receiver and the pad speak Corsair's BRAGI on the
// vendor collection 0xFF42:0x0001 (iCUE's `Bragi_dongle` packages, CONTROLLERS.md §4.3). SYNQ asks for identity,
// firmware, battery and which pad is connected, with BRAGI 1.0 GETs only; nothing is ever set, and no file, session,
// calibration, pairing, reset or firmware command goes out (guard.ts and src-tauri/src/pads.rs check every frame).
// What writes would need is written down in CONTROLLERS.md §4.5. Pure data and functions: no DOM, no device access.
import { CMD, PROP, decodeFirmware, decodeReply, frame, u32le } from "../brands/corsair/bragi.ts";

/** BRAGI request collection (answers come back on it as input reports, report id 0). */
export const SCUF_COLLECTION = [0xff42, 0x0001] as const;
export const SCUF_REPORT_ID = 0;
/** Report length the iCUE packages' devices use (UNVERIFIED for the Envision: every BRAGI device seen uses 64). */
export const SCUF_LEN = 64;

/** The only properties SYNQ reads: battery level and status, USB vid / pid, firmware, the connected-pad bitmap. */
export const SCUF_READS: readonly number[] = [PROP.batteryLevel, PROP.batteryStatus, PROP.usbVid, PROP.usbPid, PROP.firmware, PROP.subdevices];

export type ScufVerdict = { ok: true; what: string } | { ok: false; why: string };

/** The guard for one output report to a SCUF Envision (`data` excludes the report id). */
export function checkScufOutput(reportId: number, data: Uint8Array): ScufVerdict {
  const no = (why: string): ScufVerdict => ({ ok: false, why: `SCUF Envision: ${why}.` });
  if (reportId !== SCUF_REPORT_ID) return no(`report 0x${reportId.toString(16)} isn't its BRAGI channel's`);
  if (data.length !== SCUF_LEN) return no(`BRAGI frames are ${SCUF_LEN} bytes`);
  if ((data[0] & 0xf8) !== 0x08) return no("only BRAGI 1.0 frames (08..0F) are sent");
  if (data[1] !== CMD.get) return no(`command 0x${data[1].toString(16)} isn't sent: SYNQ only reads this pad`);
  const prop = data[2] | (data[3] << 8);
  if (!SCUF_READS.includes(prop)) return no(`property 0x${prop.toString(16)} isn't read`);
  if (!data.subarray(4).every((b) => b === 0)) return no("a GET carries nothing after the property");
  return { ok: true, what: `read property 0x${prop.toString(16)}` };
}

/** A GET of `prop` from the device at `addr` (0: the USB device itself; 1-7: a pad paired to the receiver). */
export const scufGet = (prop: number, addr = 0): { reportId: number; data: Uint8Array } => ({ reportId: SCUF_REPORT_ID, data: frame({ framing: "v1", addr, length: SCUF_LEN }, CMD.get, [prop & 0xff, prop >> 8]) });

/** A BRAGI 1.0 answer to a GET: its status and value (null: not an answer to a GET). */
export function scufAnswer(data: Uint8Array): { ok: boolean; data: Uint8Array } | null {
  if (data.length < 4) return null;
  const r = decodeReply("v1", data);
  if (r.cmd !== CMD.get) return null;
  return { ok: r.status === 0, data: r.data };
}

/** The connected pads' addresses from the receiver's bitmap (bit n: a device at address n). */
export const scufPads = (bitmap: number): number[] => [1, 2, 3, 4, 5, 6, 7].filter((a) => bitmap & (1 << a));

/** Battery status codes (BRAGI 0x10), as the Corsair mice read them. */
const BATTERY_STATUS: Readonly<Record<number, string>> = { 1: "charging", 2: "on battery", 3: "full" };

export interface ScufFacts {
  receiverFirmware?: string;
  pad?: { addr: number; vid?: number; pid?: number; firmware?: string; battery?: number; status?: string };
  /** The receiver answered but no pad is connected to it. */
  noPad?: boolean;
}

export const scufFirmware = (d: Uint8Array): string => decodeFirmware(d);
export const scufU32 = (d: Uint8Array): number => u32le(d, 0);
/** Battery level is tenths of a percent. */
export const scufBattery = (d: Uint8Array): number => Math.min(100, Math.round(u32le(d, 0) / 10));
export const scufBatteryStatus = (d: Uint8Array): string | undefined => BATTERY_STATUS[u32le(d, 0)];
