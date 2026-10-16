// Outgoing-frame allowlist for the SparkLink family. Default-deny: only the exact shapes SYNQ's encoders build
// pass (64 bytes, header 0x5C, a valid checksum, zero padding, a known command class with sane fields).
//
// What may be sent (the Rust bridge mirrors this, src-tauri/src/brands.rs `sparklink`):
//   orders, read     protocol version, Win-key lock, Windows / Mac query, travel range, keyboard name, report rate,
//                    active configuration, switch (axis) ids: [type, 0xFF, 0xFF]
//   orders, write    the Windows / Mac mode switch only, in the shape OpenMouse exercised on a Kochi Hummingbird 68
//   sync             the board-info read
//   default keys     the key-table reads (rows 0 to 5)
//   key layouts      reads of mode, actuation, rapid trigger press / release and dead zones; writes of the same, one
//                    layout of one key at a time, values in range (a mode write names no advanced-key mode)
//   global travel    the read, and a write of travel and dead zones
// Never sent: the SDK's bootloader commands (classes 8 to 14) and screen pictures, the factory reset and calibration
// orders, the macro, dynamic-keystroke, mod-tap, toggle, SOCD and rapid-switch commands, key-map (Fn layer) writes,
// the key's switch-type (axis) layout, lighting, and any order or class not listed above.
//
// Two layers, as in the other brand guards:
//   classifyFrame(f)        the static verdict. The bridge repeats this one; its fixture is sparklink-frames.txt.
//   guardFor(ctx)           what a session uses: the static verdict, then narrowed to the keys the board reported and to
//                           reads only when writes aren't allowed.

import { blockVerdict, okVerdict, type BlockReason, type CommandGuard, type OutgoingReport, type Verdict } from "../local-kb.ts";
import { CMD, FRAME_LEN, LAYOUT, MAX_GROUPS, MAX_TRAVEL_UM, MATRIX_ROWS, MODE_ORDERS, NEVER_CMD, ORDER, READ_LAYOUTS, READ_ORDERS, TRAVEL_LAYOUTS, WRITE_LAYOUTS, parseRequest } from "./protocol.ts";

/** What SYNQ never sends to these boards, for the "never sends" panel. */
export const BLOCKED: readonly { what: string; why: BlockReason }[] = [
  { what: "The bootloader commands (sign, erase, reboot, to-app, write, read, crc) and screen-picture writes: the SDK updates firmware over this same channel", why: "firmware" },
  { what: "Order 0x11: restore factory settings", why: "profile-wipe" },
  { what: "Orders 0x04, 0x0C, 0x0D: clear calibration data, start and end sensor calibration", why: "calibration" },
  { what: "Order 0x10 and the macro commands: macro storage erase, macro data and mode", why: "profile-wipe" },
  { what: "The key map (Fn layers) and every key layout but mode, actuation, rapid trigger and dead zones; the key's switch-type (axis) layout", why: "unknown" },
  { what: "Dynamic keystroke, mod-tap, toggle, multi-point, end, SOCD and rapid-switch keys", why: "unknown" },
  { what: "Lighting writes, report-rate and configuration switches (not offered yet)", why: "unknown" },
  { what: "Any order or command class not listed above", why: "unknown" },
];

const notListed = (f: Uint8Array): Verdict =>
  blockVerdict("not listed", "unknown", `Frame ${Array.from(f.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join(" ")}... is not one SYNQ builds.`);

const restZero = (f: Uint8Array, from: number): boolean => {
  for (let i = from; i < f.length; i++) if (f[i] !== 0) return false;
  return true;
};

const ORDER_NAME: Readonly<Record<number, string>> = {
  [ORDER.protocolVersion]: "protocol version",
  [ORDER.lockWinKey]: "Windows key lock",
  [ORDER.queryWin]: "Windows mode",
  [ORDER.queryMac]: "Mac mode",
  [ORDER.precisionStroke]: "travel range",
  [ORDER.keyboardName]: "keyboard name",
  [ORDER.rateOfReturn]: "report rate",
  [ORDER.config]: "active configuration",
  [ORDER.currentAxis]: "current switch",
  [ORDER.axisList]: "switch list",
};

/** The layout of a mode write value is valid: touch mode 0 to 2, no advanced-key mode, high byte zero. */
const modeValueOk = (v: number): boolean => (v & 0xff00) === 0 && (v & 15) === 0 && v >> 4 <= 2;

/** Frame classification. Without `ctx` it is the static verdict (the bridge repeats it); with it, the session's narrowed view. */
export function classifyFrame(f: Uint8Array, ctx?: GuardContext): Verdict {
  if (f.length !== FRAME_LEN) return blockVerdict("bad length", "shape", `Frames are ${FRAME_LEN} bytes (got ${f.length}).`);
  const v = classifyStatic(f);
  if (v.verdict === "blocked" || !ctx) return v;
  return narrow(f, v, ctx);
}

function classifyStatic(f: Uint8Array): Verdict {
  const m = parseRequest(f);
  if (!m) return notListed(f);
  const { cmd, len, data } = m;
  const never = NEVER_CMD[cmd];
  if (never) return blockVerdict(never.name, never.why === "macro" ? "profile-wipe" : never.why, `${never.name[0].toUpperCase()}${never.name.slice(1)} is never sent to these keyboards.`);
  switch (cmd) {
    case CMD.sync:
      return len === 6 && data[0] === 1 && data[1] === 2 && data[2] === 3 && data[3] === 4 && data[4] === 0xff && data[5] === 0xff ? okVerdict("board info", "read") : notListed(f);
    case CMD.order: {
      const type = data[0];
      if (type === ORDER.factoryReset) return blockVerdict("factory reset", "factory-reset", "Order 0x11 restores factory settings. Never sent.");
      if (type === ORDER.clearCalibration || type === ORDER.calibrationStart || type === ORDER.calibrationClose) return blockVerdict("calibration", "calibration", "Sensor calibration is never started from SYNQ.");
      if (type === ORDER.eraseMacroStorage) return blockVerdict("macro erase", "profile-wipe", "Order 0x10 erases macro storage. Never sent.");
      if (len !== 3 || data[1] !== 0xff || data[2] !== 0xff) return notListed(f);
      if (READ_ORDERS.includes(type)) return okVerdict(ORDER_NAME[type] ?? "order", "read");
      if (MODE_ORDERS.includes(type)) return okVerdict(type === ORDER.setWin ? "Windows mode" : "Mac mode", "write");
      return notListed(f);
    }
    case CMD.defKey:
      return len === 3 && data[0] === 0 && data[1] < MATRIX_ROWS && data[2] < MATRIX_ROWS ? okVerdict("default keys", "read") : notListed(f);
    case CMD.db: {
      if (len !== 15) return notListed(f);
      if (data[0] === 0) return restZero(data, 1) ? okVerdict("global travel", "read") : notListed(f);
      if (data[0] !== 1 || data[1] !== 0 || data[2] !== 0 || !restZero(data, 9)) return notListed(f);
      const travel = data[3] | (data[4] << 8);
      const press = data[5] | (data[6] << 8);
      const release = data[7] | (data[8] << 8);
      return travel >= 1 && travel <= MAX_TRAVEL_UM && press <= MAX_TRAVEL_UM && release <= MAX_TRAVEL_UM ? okVerdict("global travel", "write") : notListed(f);
    }
    case CMD.key: {
      if (len < 5 || (len - 1) % 4 !== 0) return notListed(f);
      const groups = (len - 1) / 4;
      if (groups > MAX_GROUPS) return notListed(f);
      if (data[0] === 0) {
        for (let g = 0; g < groups; g++) {
          const at = 1 + g * 4;
          if (data[at] < 1 || !READ_LAYOUTS.includes(data[at + 1]) || data[at + 2] !== 0 || data[at + 3] !== 0) return notListed(f);
        }
        return okVerdict("key settings", "read");
      }
      if (data[0] !== 1 || groups !== 1) return notListed(f);
      const [key, layout] = [data[1], data[2]];
      const value = data[3] | (data[4] << 8);
      if (key < 1) return notListed(f);
      if (layout === LAYOUT.axis) return blockVerdict("switch type", "calibration", "A key's switch type (axis) belongs to the sensor calibration. Never written.");
      if (!WRITE_LAYOUTS.includes(layout)) return notListed(f);
      if (layout === LAYOUT.mode) return modeValueOk(value) ? okVerdict("key mode", "write") : notListed(f);
      if (TRAVEL_LAYOUTS.includes(layout)) return value <= MAX_TRAVEL_UM && (layout === LAYOUT.dp || layout === LAYOUT.dr || value >= 1) ? okVerdict("key travel", "write") : notListed(f);
      return notListed(f);
    }
    default:
      return notListed(f);
  }
}

// ---------------------------------------------------------------------------------------------
// Session narrowing
// ---------------------------------------------------------------------------------------------

export interface GuardContext {
  /** The keys (default key values) the board reported, once its key table has been read; before that only board info, orders and the key table go out. */
  keys: ReadonlySet<number> | null;
  /** False for read-only tiers: every "write" verdict is refused. */
  writes: boolean;
}

const refuse = (name: string, reason: string): Verdict => blockVerdict(name, "unknown", reason);

function narrow(f: Uint8Array, v: Verdict, ctx: GuardContext): Verdict {
  const name = v.name;
  if (v.verdict === "write" && !ctx.writes) return refuse(name, "This keyboard is read-only in SYNQ.");
  const cmd = f[2];
  if (cmd === CMD.sync || cmd === CMD.order || cmd === CMD.defKey) return v;
  if (!ctx.keys) return refuse(name, "Only the board info, orders and the key table are sent until the keyboard's keys are known.");
  if (cmd === CMD.key) {
    const len = f[1];
    for (let at = 5; at + 3 < 4 + len; at += 4) if (!ctx.keys.has(f[at])) return refuse(name, "That is not a key this keyboard reported.");
  }
  return v;
}

function classifyReport(report: OutgoingReport, ctx?: GuardContext): Verdict {
  if (report.type !== "output") return blockVerdict("feature report", "shape", "These keyboards take output reports only; feature reports are never sent.");
  if (report.reportId !== 0) return blockVerdict("report id", "shape", `These keyboards use report id 0 (got ${report.reportId}).`);
  return classifyFrame(report.data, ctx);
}

/** The static allowlist. The bridge repeats it. */
export const SPARKLINK_GUARD: CommandGuard = { classify: (report) => classifyReport(report), blocked: BLOCKED };

/** A session's guard. `ctx` is read on every call, so the session can fill it in once the key table is read. */
export function guardFor(ctx: () => GuardContext): CommandGuard {
  return { classify: (report) => classifyReport(report, ctx()), blocked: BLOCKED };
}

