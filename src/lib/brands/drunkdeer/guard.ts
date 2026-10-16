// DrunkDeer outgoing-frame allowlist. Default-deny: only the exact shapes SYNQ's encoders build pass
// (output report id 4, 63 bytes, known command + sub-command, sane values, zero padding).
//
// Two layers:
//   DRUNKDEER_GUARD   static superset over every dialect and model. The Rust bridge mirrors this one
//                     (fixture: drunkdeer-frames.txt, written by scripts/drunkdeer-allowlist-fixture.ts).
//   guardFor(ctx)     what a session uses: the static verdict, then narrowed to the connected keyboard's
//                     dialect, model and firmware features, and to reads only when writes aren't allowed.
// Before the identity reply is in, a session guard lets only the identity read through.

import { blockVerdict, okVerdict, type BlockReason, type CommandGuard, type OutgoingReport, type Verdict } from "../local-kb.ts";
import { ALL_PRESET_CODES, LIGHT_COLOURS, LIGHT_LEVEL_MAX, MAX_LW_PAIRS, MAX_RDT_PAIRS, type Dialect, type DrunkDeerFeatures } from "./devices.ts";
import {
  AUTO_MATCH_VALUES,
  CMD,
  FC,
  FD,
  FIELD_SUB,
  FRAME_LEN,
  LW_FRAME_CAPACITY,
  PULL_REQ,
  RDT_ACTIVE_RAW,
  RDT_FRAME_CAPACITY,
  RDT_RESET_RAW,
  REPORT_ID,
  SLOTS,
  WIRE_RANGE,
  type KeyField,
} from "./protocol.ts";

/** What SYNQ never sends to a DrunkDeer keyboard, for the "never sends" panel. */
export const BLOCKED: readonly { what: string; why: BlockReason }[] = [
  { what: "0xF9 00 / 01 / 02: firmware upgrade (start + length, 56-byte data chunks, end)", why: "firmware" },
  { what: "0xAA 00: reset keyboard (sendResetKeyboardData)", why: "factory-reset" },
  { what: "0xAA 00 01: clear RTP upper (preamble of the old-dialect Last-Win / RDT commit)", why: "factory-reset" },
  { what: "0xA7: RTP authority (old-dialect RT+ / pair commit; semantics of its constant bytes not decoded)", why: "unknown" },
  { what: "0xA8: RTP authority download (old-dialect RT+ / pair commit; writes per-key output codes)", why: "unknown" },
  { what: "0xA0 02 04: keymap layer write (the official save rewrites default, Fn1 and Fn2 from the host copy; no keymap read exists)", why: "profile-wipe" },
  { what: "0xAB: delete a firmware-side profile slot", why: "profile-wipe" },
  { what: "0xA2 n (n > 0): set the firmware profile count (the official app deletes or creates profiles to match)", why: "profile-wipe" },
  { what: "0xFB 05: switch the active firmware profile (carries host-side profile ids)", why: "unknown" },
  { what: "0xC1 03: knob action remap (A75 Ultra / Master)", why: "unknown" },
  { what: "0xC2 20: X60 LED strip", why: "unknown" },
  { what: "0xAE 01 per-key custom light stream (soft-brick risk reported on the A75 Pro)", why: "unknown" },
  { what: "0xAE 01 with brightness or speed above 9 (reported to soft-brick the A75 Pro)", why: "unknown" },
  { what: "Feature reports, other report ids, other lengths", why: "shape" },
  { what: "Anything not listed above", why: "unknown" },
];

const restZero = (f: Uint8Array, from: number): boolean => {
  for (let i = from; i < f.length; i++) if (f[i] !== 0) return false;
  return true;
};
const bool = (v: number): boolean => v === 0 || v === 1;
const notListed = (f: Uint8Array): Verdict =>
  blockVerdict("not listed", "unknown", `Frame ${Array.from(f.subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join(" ")}... is not one SYNQ builds.`);

const FIELD_BY_SUB = new Map<number, KeyField>(Object.entries(FIELD_SUB).map(([k, v]) => [v, k as KeyField]));

/** Static wire ranges across all dialects that use a packet family. */
const OLD_RANGE = (field: KeyField): readonly [number, number] => [
  Math.min(WIRE_RANGE.legacy[field][0], WIRE_RANGE.oldHighPrec[field][0]),
  Math.max(WIRE_RANGE.legacy[field][1], WIRE_RANGE.oldHighPrec[field][1]),
];

/** Frame classification. Without `ctx` it is the static superset (bridge); with it, the session's narrowed view. */
export function classifyFrame(f: Uint8Array, ctx?: GuardContext): Verdict {
  if (f.length !== FRAME_LEN) return blockVerdict("bad length", "shape", `Frames are ${FRAME_LEN} bytes (got ${f.length}).`);
  const v = classifyStatic(f);
  if (v.verdict === "blocked" || !ctx) return v;
  return narrow(f, v, ctx);
}

function classifyStatic(f: Uint8Array): Verdict {
  const [c, s] = f;
  switch (c) {
    case CMD.firmware:
      return blockVerdict("firmware upgrade", "firmware", "0xF9 is the firmware upgrade (start, data, end). SYNQ never sends it.");
    case CMD.reset:
      return blockVerdict("reset / clear RTP", "factory-reset", "0xAA 00 resets the keyboard and 0xAA 00 01 clears the RTP table. Never sent.");
    case CMD.rtpAuthority:
    case CMD.rtpAuthorityDownload:
      return blockVerdict("RTP authority", "unknown", "0xA7 / 0xA8 write the RT+ authority table during the old-dialect pair commit (after 0xAA 00 01). They are writes, not reads. Never sent.");
    case CMD.deleteProfile:
      return blockVerdict("delete profile", "profile-wipe", "0xAB deletes a firmware-side profile slot. Never sent.");
    case CMD.changeProfile:
      return blockVerdict("switch profile", "unknown", "0xFB 05 switches the firmware profile using host-side profile ids SYNQ doesn't have. Not sent.");
    case CMD.knob:
      return blockVerdict("knob remap", "unknown", "0xC1 knob remap is not implemented.");
    case CMD.ledStrip:
      return blockVerdict("LED strip", "unknown", "0xC2 X60 LED strip is not implemented.");
    case CMD.identity:
      if (s === 0x02 && f[2] === 0x04) return blockVerdict("keymap write", "profile-wipe", "0xA0 02 04 rewrites a whole keymap layer; the keyboard can't report its keymap, so SYNQ would overwrite Fn layers it can't read. Not sent.");
      if (s === 0x02 && restZero(f, 2)) return okVerdict("identity", "read");
      return notListed(f);
    case CMD.profileCount:
      if (s !== 0) return blockVerdict("set profile count", "profile-wipe", "0xA2 n sets the firmware profile count. Only the query (0xA2 00) is sent.");
      return restZero(f, 2) ? okVerdict("profile count", "read") : notListed(f);
    case CMD.common:
      if (s === 0 && f[2] === 0x1e && f[3] === 1 && f[4] === 0 && f[5] === 0 && f[6] === 1 && bool(f[7]) && bool(f[8]) && f[9] === 0 && f[10] <= 3 && bool(f[11]) && restZero(f, 12))
        return okVerdict("common switch", "write");
      return notListed(f);
    case CMD.keyPoints: {
      if (s === FD.tracking) return f[2] <= 1 && restZero(f, 3) ? okVerdict("keystroke tracking", "read") : notListed(f);
      const field = FIELD_BY_SUB.get(s);
      if (!field || f[2] !== 0 || f[3] > 2) return notListed(f);
      const n = f[3] < 2 ? 59 : 8;
      const [lo, hi] = OLD_RANGE(field);
      for (let i = 0; i < n; i++) if (f[4 + i] < lo || f[4 + i] > hi) return notListed(f);
      return restZero(f, 4 + n) ? okVerdict(`${field} batch`, "write") : notListed(f);
    }
    case CMD.high: {
      if (s === FD.tracking) return f[2] <= 1 && restZero(f, 3) ? okVerdict("keystroke tracking", "read") : notListed(f);
      if (s === FD.pull) return (Object.values(PULL_REQ) as number[]).includes(f[2]) && restZero(f, 3) ? okVerdict("per-key read-back", "read") : notListed(f);
      if (s === FD.autoMatch) return AUTO_MATCH_VALUES.includes(f[2]) && restZero(f, 3) ? okVerdict("auto-match mode", "write") : notListed(f);
      const field = FIELD_BY_SUB.get(s);
      if (!field || f[2] > 4) return notListed(f);
      const n = f[2] < 4 ? 30 : 6;
      const [lo, hi] = WIRE_RANGE.newHighPrec[field];
      for (let i = 0; i < n; i++) {
        const w = f[3 + i * 2] | (f[4 + i * 2] << 8);
        if (w < lo || w > hi) return notListed(f);
      }
      return restZero(f, 3 + n * 2) ? okVerdict(`${field} batch`, "write") : notListed(f);
    }
    case CMD.pairs:
      switch (s) {
        case FC.lwReplace:
          return bool(f[2]) && restZero(f, 3) ? okVerdict("last-win replace", "write") : notListed(f);
        case FC.clearPairs:
          return f[2] <= 3 && restZero(f, 3) ? okVerdict("pair table mode", "write") : notListed(f);
        case FC.pullLw:
        case FC.pullRdt:
          return restZero(f, 2) ? okVerdict("pair read-back", "read") : notListed(f);
        case FC.lwPairs: {
          const n = f[3];
          if (f[2] !== 0 || n > LW_FRAME_CAPACITY) return notListed(f);
          for (let i = 0; i < n; i++) {
            const e = 4 + i * 4;
            if (f[e] >= SLOTS || f[e + 1] >= SLOTS || f[e] === f[e + 1] || f[e + 2] !== 0 || f[e + 3] !== 0) return notListed(f);
          }
          return restZero(f, 4 + n * 4) ? okVerdict("last-win pairs", "write") : notListed(f);
        }
        case FC.rdtPairs: {
          const n = f[2];
          if (n > RDT_FRAME_CAPACITY) return notListed(f);
          for (let i = 0; i < n; i++) {
            const e = 3 + i * 8;
            const a = f[e + 2] | (f[e + 3] << 8), r = f[e + 4] | (f[e + 5] << 8);
            if (f[e] >= SLOTS || f[e + 1] >= SLOTS || f[e] === f[e + 1]) return notListed(f);
            if (a < RDT_ACTIVE_RAW[0] || a > RDT_ACTIVE_RAW[1] || r < RDT_RESET_RAW[0] || r > RDT_RESET_RAW[1] || f[e + 6] !== 0 || f[e + 7] !== 0) return notListed(f);
          }
          return restZero(f, 3 + n * 8) ? okVerdict("RDT pairs", "write") : notListed(f);
        }
        default:
          return notListed(f);
      }
    case CMD.led:
      if (s !== 1) return notListed(f);
      if (f[5] === 0x06 && f[7] === 0xff) return blockVerdict("custom light stream", "unknown", "The per-key custom light stream (0xAE 01 .. 06 .. FF) is not sent (soft-brick risk on the A75 Pro).");
      if (f[5] > LIGHT_LEVEL_MAX || f[6] > LIGHT_LEVEL_MAX) return blockVerdict("lighting level", "unknown", "Lighting speed / brightness above 9 is reported to soft-brick the A75 Pro. Never sent.");
      if (f[2] === 0 && f[3] === 0 && ALL_PRESET_CODES.includes(f[4]) && f[7] < LIGHT_COLOURS.length && restZero(f, 8)) return okVerdict("lighting mode", "write");
      return notListed(f);
    default:
      return notListed(f);
  }
}

// ---------------------------------------------------------------------------------------------
// Session narrowing
// ---------------------------------------------------------------------------------------------

export interface GuardContext {
  /** Null until the identity reply is decoded (or when the model is unknown). */
  features: DrunkDeerFeatures | null;
  /** Lighting preset codes of the connected model. */
  presetCodes?: readonly number[];
  /** False for readOnly tiers: every "write" verdict is refused. */
  writes: boolean;
}

const refuse = (name: string, reason: string): Verdict => blockVerdict(name, "unknown", reason);

function narrow(f: Uint8Array, v: Verdict, ctx: GuardContext): Verdict {
  const name = v.name;
  const c = f[0], s = f[1];
  const feat = ctx.features;
  if (!feat) return c === CMD.identity ? v : refuse(name, "Only the identity read is sent until the keyboard's model and firmware dialect are known.");
  if (v.verdict === "write" && !ctx.writes) return refuse(name, "This keyboard is read-only in SYNQ.");
  const d: Dialect = feat.dialect;
  const hi = d === "newHighPrec";
  switch (c) {
    case CMD.identity:
      return v;
    case CMD.common:
      if (f[10] !== 0 && !feat.rtp) return refuse(name, "Last-Win / RDT need newer firmware on this keyboard.");
      if (f[11] !== 0 && !feat.autoMatch) return refuse(name, "RT-match isn't offered on this keyboard's firmware.");
      return v;
    case CMD.keyPoints: {
      if (hi) return refuse(name, "This keyboard takes per-key values as 0xFD frames (newHighPrec).");
      if (s === FD.tracking) return v;
      const field = FIELD_BY_SUB.get(s) as KeyField;
      const [lo, hiW] = WIRE_RANGE[d][field];
      const n = f[3] < 2 ? 59 : 8;
      for (let i = 0; i < n; i++) if (f[4 + i] < lo || f[4 + i] > hiW) return refuse(name, `Value outside the ${d} range for ${field}.`);
      return v;
    }
    case CMD.high:
      if (!hi) return refuse(name, "0xFD frames exist only on newHighPrec keyboards.");
      if (s === FD.pull && !feat.pulls) return refuse(name, "This firmware has no per-key read-back.");
      if (s === FD.autoMatch && !feat.autoMatch) return refuse(name, "Auto-match isn't offered on this firmware.");
      return v;
    case CMD.pairs:
      if (!hi) return refuse(name, "0xFC frames exist only on newHighPrec keyboards; older ones commit pairs through 0xAA / 0xA7 / 0xA8, which SYNQ never sends.");
      if ((s === FC.pullLw || s === FC.pullRdt) && !feat.pulls) return refuse(name, "This firmware has no pair read-back.");
      if (s === FC.lwReplace && !feat.lwReplace) return refuse(name, "Last-Win Replace isn't offered on this firmware.");
      if ((s === FC.clearPairs || s === FC.lwPairs || s === FC.rdtPairs) && !feat.pairWrites) return refuse(name, "Pair tables aren't writable on this firmware.");
      if (s === FC.lwPairs && f[3] > MAX_LW_PAIRS) return refuse(name, `At most ${MAX_LW_PAIRS} Last-Win pairs.`);
      if (s === FC.rdtPairs && f[2] > MAX_RDT_PAIRS) return refuse(name, `At most ${MAX_RDT_PAIRS} RDT pairs.`);
      return v;
    case CMD.profileCount:
      return feat.profileCount ? v : refuse(name, "This firmware doesn't keep firmware-side profiles.");
    case CMD.led:
      return (ctx.presetCodes ?? []).includes(f[4]) ? v : refuse(name, "Lighting mode code isn't a preset of this model.");
    default:
      return refuse(name, "Not listed.");
  }
}

function classifyReport(report: OutgoingReport, ctx?: GuardContext): Verdict {
  if (report.type !== "output") return blockVerdict("feature report", "shape", "DrunkDeer settings travel in output reports only; feature reports are never sent.");
  if (report.reportId !== REPORT_ID) return blockVerdict("report id", "shape", `Report id must be ${REPORT_ID} (got ${report.reportId}).`);
  return classifyFrame(report.data, ctx);
}

/** Static allowlist (superset over all dialects). The bridge repeats this one. */
export const DRUNKDEER_GUARD: CommandGuard = {
  classify: (report) => classifyReport(report),
  blocked: BLOCKED,
};

/** A session's guard. `ctx` is read on every call, so the session can fill it in after identity. */
export function guardFor(ctx: () => GuardContext): CommandGuard {
  return { classify: (report) => classifyReport(report, ctx()), blocked: BLOCKED };
}
