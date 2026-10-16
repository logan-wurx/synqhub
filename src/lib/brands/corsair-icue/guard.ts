// Safety allowlist for the iCUE (BRAGI / Corsair V2) path. The byte-level encoding of iCUE's magnetic
// actuation writes and its firmware/reset/pairing/calibration commands is NOT known (abstracted in the
// DLL, device package encrypted), so the guard is a strict allowlist of only the BRAGI operations
// confirmed safe from OpenRGB: identity/layout reads, the render-mode switch, and the lighting
// transaction. Anything else — any other command byte, any other address, a transaction opened on a
// non-lighting endpoint — is refused. That makes every dangerous iCUE command and every unverified
// actuation write unreachable by construction.
//
// why-codes are from ../local-kb.ts BlockReason. Nothing here touches a device.

import { blockVerdict, okVerdict, type BlockReason, type CommandGuard, type OutgoingReport, type Verdict } from "../local-kb.ts";
import { ADDR, BRAGI, CMD, WRITE_ID } from "./protocol.ts";

const WRITE_IDS = new Set<number>([WRITE_ID.wired, WRITE_ID.wireless]);
/** Addresses SYNQ may GET (identity, layout, lighting-control endpoints). */
const READ_ADDRS = new Set<number>([ADDR.firmwareVid, ADDR.pid, ADDR.keyboardLayout, ADDR.lightCtrl1, ADDR.lightCtrl2]);
/** Lighting-control endpoints a transaction may use. */
const LIGHT_CTRL = new Set<number>([ADDR.lightCtrl1, ADDR.lightCtrl2]);

/** Documented blocks for the "What SYNQ never sends" panel (iCUE command names → why). */
export const BLOCKED_COMMANDS: readonly { what: string; why: BlockReason }[] = [
  { what: "SetFirmwareUpdatingState / firmware transfer", why: "firmware" },
  { what: "Reset / PowerReset", why: "factory-reset" },
  { what: "ResetHardwareStorage / ResetHardwareProfile / ClearHardwareProfile", why: "profile-wipe" },
  { what: "StartPairing / SetPairingId", why: "pairing" },
  { what: "StartCalibration / ApplyCalibration / InitJoystickCalibrationStep", why: "calibration" },
  { what: "SetKeyActuationSetting / SetRapidTriggerSetting (exact bytes unverified)", why: "unknown" },
  { what: "CommitKeyActuationSettings / CommitHwSettings (flash commit)", why: "profile-wipe" },
  { what: "SetPollingRate / SetDpiData / SetKeyMapping (unverified BRAGI bytes)", why: "unknown" },
];

function classifyFrame(report: OutgoingReport): Verdict {
  if (report.type !== "output") return blockVerdict("non-output report", "unknown", "BRAGI requests are output reports on report id 0.");
  if (report.reportId !== BRAGI.reportId) return blockVerdict("wrong report id", "unknown", `BRAGI uses report id 0 (got 0x${report.reportId.toString(16)})`);
  if (report.data.length !== BRAGI.length) return blockVerdict("bad length", "unknown", `BRAGI frames are ${BRAGI.length} bytes (got ${report.data.length})`);
  const d = report.data;
  if (!WRITE_IDS.has(d[0])) return blockVerdict("bad write id", "unknown", `byte 0 must be 0x08 (wired) or 0x09 (wireless); got 0x${d[0].toString(16)}`);
  const cmd = d[1];
  const addr = d[2];
  switch (cmd) {
    case CMD.get:
      if (READ_ADDRS.has(addr)) return okVerdict("read property", "read");
      return blockVerdict("read of unlisted address", "unknown", `GET 0x${addr.toString(16)} is not an identity/lighting read SYNQ uses`);
    case CMD.set:
      if (addr === ADDR.renderMode) return okVerdict("set render mode", "write");
      return blockVerdict("set of unlisted address", "unknown", `SET 0x${addr.toString(16)} is not the render-mode switch`);
    case CMD.startTx:
      // Lighting transaction only: opt1 (byte 2) = 0 and the light-control endpoint (byte 3) is 0x01/0x22.
      if (addr === 0x00 && LIGHT_CTRL.has(d[3])) return okVerdict("open lighting transaction", "write");
      return blockVerdict("transaction on a non-lighting endpoint", "device-mode", `START_TX opt1=0x${addr.toString(16)} ctrl=0x${d[3].toString(16)} is not the lighting endpoint (firmware/other endpoints are refused)`);
    case CMD.stopTx:
      if (addr === 0x01 && (d[3] === 0x00 || LIGHT_CTRL.has(d[3]))) return okVerdict("close lighting transaction", "write");
      return blockVerdict("stop transaction mismatch", "unknown", "STOP_TX must close a lighting transaction");
    case CMD.blockW1:
    case CMD.blockWn:
      return okVerdict("lighting data block", "write");
    default:
      return blockVerdict("unlisted command", "unknown", `BRAGI command 0x${cmd.toString(16)} is not on SYNQ's list (firmware/reset/pairing/actuation are all refused)`);
  }
}

export class CorsairIcueGuard implements CommandGuard {
  readonly blocked: readonly { what: string; why: BlockReason }[] = BLOCKED_COMMANDS;
  classify(report: OutgoingReport): Verdict {
    return classifyFrame(report);
  }
}
