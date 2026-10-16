// MonsGeek / Akko outgoing-frame allowlist. Default deny: a frame passes only if it has exactly the
// shape one of SYNQ's encoders (protocol.ts) produces: feature report, report id 0, 64 bytes, a
// valid checksum (byte 7, or byte 8 for lighting), a known opcode, parameters in range and zero
// padding. Destructive opcodes (BLOCKED in protocol.ts) are refused with their reason first.
//
// Four scopes:
//   "identify" before the model is known: 0x8F, 0x80 and 0xE6 reads only.
//   "gen2"     RY5088 boards: gen2 reads and writes.
//   "yc500"    YC3121 boards: yc500 reads only (their write opcodes collide with gen2 ones).
//   "any"      union of the three. This is the table the Rust bridge mirrors (monsgeek-frames.txt):
//              it can't know a board's command set, so its job is to keep every destructive or
//              unknown frame out; the session keeps gen2 writes away from yc500 boards.
//
// Sources: FCC (GPL-3.0) ALLOWED set + refusal list, sharkfin (GPL-3.0) destructive opcodes and
// bounds, echtzeit docs (firmware doesn't bounds-check chunk indexes). See protocol.ts header.

import type { BridgeAllowance, CommandGuard, OutgoingReport, Verdict } from "../local-kb.ts";
import { blockVerdict, okVerdict } from "../local-kb.ts";
import {
  BLOCKED,
  CMD,
  COLOUR_NIBBLES,
  DATA_AT,
  DATA_MAX,
  FRAME_LEN,
  KEYMAP_BYTES,
  KEYMAP_READ_PAGES,
  KEYMAP_WRITE_PAGES,
  KINDS,
  LIGHT_MODES,
  MAX_PROFILES,
  POSITIONS,
  READ_TABLES,
  REPORT_ID,
  SNAP_NONE,
  SUBLAYERS,
  TABLE,
  TABLE_LIMITS,
  U16_TABLES,
  USER_PICTURE_MODE,
  YC,
  YC_MAX_SLOT,
  YC_READ_TABLES,
  blockedOpcode,
  checksum,
  checksumAt,
  entryOk,
  readPages,
  variantsOf,
} from "./protocol.ts";
import { MONSGEEK_CHANNEL, MONSGEEK_USB } from "./devices.ts";

export { BLOCKED };

export type GuardScope = "identify" | "gen2" | "yc500" | "any";

const zeroFrom = (f: Uint8Array, from: number, to = FRAME_LEN) => {
  for (let i = from; i < to; i++) if (f[i] !== 0) return false;
  return true;
};
/** Bytes 1..6 hold `params` exactly (missing ones zero). */
const paramsAre = (f: Uint8Array, ...params: number[]) => {
  for (let i = 1; i <= 6; i++) if (f[i] !== (params[i - 1] ?? 0)) return false;
  return true;
};
const bare = (f: Uint8Array) => paramsAre(f) && zeroFrom(f, DATA_AT);

const notListed = (f: Uint8Array, why = "not a frame SYNQ builds"): Verdict =>
  blockVerdict(`0x${f[0].toString(16).padStart(2, "0")}`, "unknown", `Refused: ${why}.`);
const shape = (name: string, reason: string): Verdict => blockVerdict(name, "shape", reason);

function identifyScope(f: Uint8Array): Verdict | null {
  switch (f[0]) {
    case CMD.identify:
      return bare(f) ? okVerdict("identify", "read") : null;
    case CMD.rfVersion:
      return bare(f) ? okVerdict("version", "read") : null;
    case CMD.featureList:
      return bare(f) ? okVerdict("feature list", "read") : null;
    default:
      return null;
  }
}

function keyEntriesOk(data: Uint8Array, len: number): boolean {
  for (let o = 0; o < len; o += 4) if (!entryOk(data.subarray(o, o + 4))) return false;
  return true;
}

function gen2Scope(f: Uint8Array): Verdict | null {
  const id = identifyScope(f);
  if (id) return id;
  const [c, b1, b2, b3, b4, b5, b6] = f;
  switch (c) {
    case CMD.getProfile:
    case CMD.getPolling:
    case CMD.getDebounce:
    case CMD.getLighting:
    case CMD.getOptions:
      return bare(f) ? okVerdict({ 0x84: "profile", 0x83: "polling", 0x86: "debounce", 0x87: "lighting", 0x89: "options" }[c] ?? "read", "read") : null;
    case CMD.setProfile:
      return b1 < MAX_PROFILES && paramsAre(f, b1) && zeroFrom(f, DATA_AT) ? okVerdict("profile", "write") : null;
    case CMD.setPolling:
      return b1 === 0 && b2 <= 6 && paramsAre(f, 0, b2) && zeroFrom(f, DATA_AT) ? okVerdict("polling", "write") : null;
    case CMD.setDebounce:
      return b1 <= 10 && paramsAre(f, b1) && zeroFrom(f, DATA_AT) ? okVerdict("debounce", "write") : null;
    case CMD.setOptions:
      return b1 === 0 && b2 <= 3 && b3 <= 1 && b4 <= 5 && b5 <= 1 && b6 === 0 && zeroFrom(f, DATA_AT) ? okVerdict("options", "write") : null;
    case CMD.setLighting: {
      // Bit8 frame: bytes 1..7 parameters, checksum at 8, nothing after.
      const mode = b1;
      if (!(mode in LIGHT_MODES) || b2 > 4 || b3 > 4 || !zeroFrom(f, 9)) return null;
      const variant = b4 >> 4;
      const nibble = b4 & 0x0f;
      if (variant >= variantsOf(mode)) return null;
      if (mode === USER_PICTURE_MODE ? nibble !== 0 : !COLOUR_NIBBLES.includes(nibble)) return null;
      return okVerdict("lighting", "write");
    }
    case CMD.getKeymap:
      return b1 < MAX_PROFILES && b2 === 0xff && b3 < KEYMAP_READ_PAGES && b4 < SUBLAYERS && b5 === 0 && b6 === 0 && zeroFrom(f, DATA_AT) ? okVerdict("keymap", "read") : null;
    case CMD.setKeymap: {
      if (b1 >= MAX_PROFILES) return null;
      if (b2 === 0xff) {
        // Whole sub-layer, page b3 of 10: 56 bytes (8 on page 9), last flag on page 9 only.
        const page = b3;
        if (page >= KEYMAP_WRITE_PAGES || b6 >= SUBLAYERS) return null;
        const len = page === KEYMAP_WRITE_PAGES - 1 ? KEYMAP_BYTES - DATA_MAX * (KEYMAP_WRITE_PAGES - 1) : DATA_MAX;
        if (b4 !== len || b5 !== (page === KEYMAP_WRITE_PAGES - 1 ? 1 : 0)) return null;
        if (!zeroFrom(f, DATA_AT + len) || !keyEntriesOk(f.subarray(DATA_AT), len)) return null;
        return okVerdict("keymap page", "write");
      }
      // One key: [0x0A, profile, position, 0, 0, 1, sub-layer, ck, entry].
      if (b2 >= POSITIONS || b3 !== 0 || b4 !== 0 || b5 !== 1 || b6 >= SUBLAYERS) return null;
      if (!entryOk(f.subarray(DATA_AT, DATA_AT + 4)) || !zeroFrom(f, DATA_AT + 4)) return null;
      return okVerdict("key", "write");
    }
    case CMD.getTable: {
      const table = b1;
      if (!READ_TABLES.includes(table) || b2 !== 1 || b3 >= readPages(table) || !paramsAre(f, table, 1, b3) || !zeroFrom(f, DATA_AT)) return null;
      return okVerdict(table === TABLE.liveTravel ? "live travel" : `table ${table}`, "read");
    }
    case CMD.setTable: {
      const table = b1;
      if (b2 === 1) return null; // bulk table pages are never built (see encodeTableWrite)
      if (b2 !== 0 || b3 >= POSITIONS || b4 > 1 || b5 !== 0 || b6 !== 0) return null;
      const v8 = f[DATA_AT];
      if (table === TABLE.mode) return (v8 & 0x78) === 0 && KINDS.includes(v8 & 0x07) && zeroFrom(f, DATA_AT + 1) ? okVerdict("key mode", "write") : null;
      if (table === TABLE.snap) return ((v8 < POSITIONS && v8 !== b3) || v8 === SNAP_NONE) && zeroFrom(f, DATA_AT + 1) ? okVerdict("snap tap", "write") : null;
      if (table === TABLE.dksBindingsSet) return zeroFrom(f, DATA_AT + 4) ? okVerdict("dks bindings", "write") : null;
      const lim = TABLE_LIMITS[table];
      if (!lim) return null; // unknown or read-only table
      const wide = U16_TABLES.includes(table);
      const v = wide ? v8 | (f[DATA_AT + 1] << 8) : v8;
      if (v < lim.min || v > lim.max || !zeroFrom(f, DATA_AT + (wide ? 2 : 1))) return null;
      return okVerdict(`table ${table}`, "write");
    }
    default:
      return null;
  }
}

function yc500Scope(f: Uint8Array): Verdict | null {
  const [c, b1, b2, b3] = f;
  switch (c) {
    case YC.identify:
    case YC.revision:
    case YC.getProfile:
    case YC.getOptions:
    case YC.getLighting:
    case YC.getDebounce:
      return bare(f) ? okVerdict(`yc500 0x${c.toString(16)}`, "read") : null;
    case YC.getKeymap:
      return b1 <= YC_MAX_SLOT && b2 < KEYMAP_READ_PAGES && paramsAre(f, b1, b2) && zeroFrom(f, DATA_AT) ? okVerdict("yc500 keymap", "read") : null;
    case YC.getTable:
      return YC_READ_TABLES.includes(b1) && b2 === 1 && b3 < readPages(b1, "yc500") && paramsAre(f, b1, 1, b3) && zeroFrom(f, DATA_AT) ? okVerdict(`yc500 table ${b1}`, "read") : null;
    default:
      return null;
  }
}

/** Verdict for 64 data bytes in a scope. */
export function classifyFrame(f: Uint8Array, scope: GuardScope = "any"): Verdict {
  if (f.length !== FRAME_LEN) return shape("length", `Frames are ${FRAME_LEN} bytes (got ${f.length}).`);
  const b = blockedOpcode(f[0]);
  if (b) return blockVerdict(b.what, b.why, `${b.what} (0x${b.opcode.toString(16).padStart(2, "0")}) is never sent by SYNQ: ${b.reason}`);
  const at = checksumAt(f[0]);
  if (f[at] !== checksum(f, at)) return shape("checksum", `Bad checksum at byte ${at}.`);
  let v: Verdict | null = null;
  if (scope === "identify") v = identifyScope(f);
  else if (scope === "gen2") v = gen2Scope(f);
  else if (scope === "yc500") v = yc500Scope(f) ?? identifyScope(f);
  else v = gen2Scope(f) ?? yc500Scope(f);
  return v ?? notListed(f, scope === "any" ? "not a frame SYNQ builds" : `not allowed in the ${scope} scope`);
}

/** The guard for one scope. Feature reports on report id 0 only; output reports are refused. */
export function createGuard(scope: GuardScope): CommandGuard {
  return {
    classify(report: OutgoingReport): Verdict {
      if (report.type !== "feature") return shape("report type", "MonsGeek boards take feature reports only.");
      if (report.reportId !== REPORT_ID) return shape("report id", `Report id must be ${REPORT_ID}.`);
      return classifyFrame(report.data, scope);
    },
    blocked: BLOCKED.map((b) => ({ what: `${b.what} (0x${b.opcode.toString(16).padStart(2, "0")})`, why: b.why })),
  };
}

/** Union guard (what the desktop bridge mirrors). */
export const MONSGEEK_GUARD: CommandGuard = createGuard("any");

/**
 * What src-tauri/src/hid.rs must allow for MonsGeek / Akko boards: the vendor collection FFFF:0002,
 * feature report id 0 with 64 data bytes, nothing else. `featureOnly` because every exchange is
 * SET_FEATURE then GET_FEATURE [FCC][SF][WEB]; SYNQ never needs input or output reports (the
 * travel stream 0x1B, which uses input reports, is blocked; live travel is read with 0xE5 254).
 * 2.4 GHz receivers (5026, 503A, 5038, 4011) are not listed: SYNQ doesn't relay through them.
 */
export const MONSGEEK_BRIDGE: readonly BridgeAllowance[] = MONSGEEK_USB.map((u) => ({
  vendorId: u.vendorId,
  productIds: u.productIds,
  usagePage: MONSGEEK_CHANNEL.usagePage,
  usage: MONSGEEK_CHANNEL.usage,
  access: "featureOnly" as const,
  reportIds: [MONSGEEK_CHANNEL.reportId],
  length: MONSGEEK_CHANNEL.length,
  note: u.note,
}));
