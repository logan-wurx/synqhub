// Outgoing-frame allowlist for the 0x19F5 family. Default-deny: only the exact shapes SYNQ's encoders
// build pass (64 bytes, the 0x55 envelope with a valid checksum, a known area, an in-block offset, zero
// padding, sane record bytes).
//
// What each family may send (the Rust bridge mirrors all three, src-tauri/src/brands.rs `fw19f5`):
//   readonly   NuPhy and Royal Kludge Gcome boards: the info and base reads. Nothing else, ever. NuPhyIO's
//              area numbers are undocumented and its newest firmware masks traffic, so no write is possible.
//   mchose     the info and base reads, function-config reads, key-trigger reads; function-config writes
//              (flags, lighting, sleep) and key-trigger writes (actuation, rapid trigger).
//   drunkdeer  the info and base reads, function-config reads, key-trigger reads and key-trigger writes
//              (the last chunk of a stream may carry flag 1, as svumo's capture shows).
// Never sent by any of them: the key map, colour, macro, mod-tap and toggle writes (areas 9, 11, 13, 165, 167),
// the factory reset (area 238), and any area the firmware-update commands might live in (they are
// undocumented, so the list of areas is an allowlist, not a blocklist).
//
// Two layers, as in the other brand guards:
//   classifyFrame(f, family)   the static verdict. The bridge repeats this one; its fixture is fw19f5-frames.txt.
//   guardFor(ctx)              what a session uses: the static verdict, then narrowed to the connected board
//                              (family, active profile) and to reads only when writes aren't allowed.

import { blockVerdict, okVerdict, type BlockReason, type CommandGuard, type OutgoingReport, type Verdict } from "../local-kb.ts";
import { AREA, BLOCK, CHUNK, FRAME_LEN, FUNC, HEADER_LEN, MAX_KEYS, PROFILES, TRIGGER_BYTES, checksum } from "./protocol.ts";
import { MC_EFFECT_NAMES, type FwFamily } from "./devices.ts";

/** How a family is guarded. NuPhy and Royal Kludge share one. */
export type GuardFamily = "mchose" | "drunkdeer" | "readonly";

export const guardFamilyOf = (family: FwFamily): GuardFamily => (family === "mchose" ? "mchose" : family === "drunkdeer" ? "drunkdeer" : "readonly");

/** What SYNQ never sends to these boards, for the "never sends" panel. */
export const BLOCKED: readonly { what: string; why: BlockReason }[] = [
  { what: "Boot mode, ROM erase / write and every firmware-update command (MCHOSE's, NuPhy's and Royal Kludge's upgraders; no number is documented, so only the listed areas are ever sent)", why: "firmware" },
  { what: "Area 238: factory reset ([255])", why: "factory-reset" },
  { what: "Areas 9, 11, 13, 165, 167: key map, per-key colour, macro, mod-tap and toggle writes (not offered yet; a wrong write loses the board's own key functions)", why: "profile-wipe" },
  { what: "Any write to a NuPhy or Royal Kludge Gcome board (undocumented areas; NuPhy's newest firmware also masks traffic with a per-session XOR key)", why: "unknown" },
  { what: "Reads of any area but the board's info, base, function config and key triggers", why: "unknown" },
  { what: "Writes to a profile other than the active one", why: "profile-wipe" },
  { what: "Feature reports, other report ids, other lengths", why: "shape" },
  { what: "Anything not listed above", why: "unknown" },
];

const notListed = (f: Uint8Array): Verdict =>
  blockVerdict("not listed", "unknown", `Frame ${Array.from(f.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join(" ")}... is not one SYNQ builds.`);

const restZero = (f: Uint8Array, from: number): boolean => {
  for (let i = from; i < f.length; i++) if (f[i] !== 0) return false;
  return true;
};

/** Function-block bytes that have a known range; everything else in the block is written back as read. */
function funcBytesOk(block: number, f: Uint8Array): boolean {
  // block-relative position of data byte j is (offset within block) + j
  const rel = block;
  for (let j = 0; j < f[4]; j++) {
    const pos = rel + j;
    const v = f[HEADER_LEN + j];
    if (pos === FUNC.effect && !(v in MC_EFFECT_NAMES)) return false;
    if (pos === FUNC.brightness && v > 100) return false;
    if (pos === FUNC.speed && v > 4) return false;
  }
  return true;
}

/** A record the key-trigger table can hold: byte 0's high nibble is 0xA, precision codes are 0..2. */
const recordOk = (f: Uint8Array, at: number): boolean => (f[at] & 0xf0) === 0xa0 && ((f[at + 3] >> 3) & 3) <= 2 && ((f[at + 3] >> 1) & 3) <= 2;

/** Frame classification. Without `ctx` it is the family's static verdict (the bridge repeats it); with it, the session's narrowed view. */
export function classifyFrame(f: Uint8Array, family: GuardFamily, ctx?: GuardContext): Verdict {
  if (f.length !== FRAME_LEN) return blockVerdict("bad length", "shape", `Frames are ${FRAME_LEN} bytes (got ${f.length}).`);
  const v = classifyStatic(f, family);
  if (v.verdict === "blocked" || !ctx) return v;
  return narrow(f, v, ctx);
}

function classifyStatic(f: Uint8Array, family: GuardFamily): Verdict {
  if (f[0] !== 0x55) return notListed(f);
  if (f[2] !== 0 || f[4] < 1 || f[4] > CHUNK || f[3] !== checksum(f)) return notListed(f);
  const cmd = f[1];
  const len = f[4];
  const offset = f[5] | (f[6] << 8);
  const flag = f[7];
  // Areas that are never sent, by name.
  switch (cmd) {
    case AREA.factoryReset:
      return blockVerdict("factory reset", "factory-reset", "Area 238 resets the keyboard to factory settings. Never sent.");
    case AREA.keysSet:
    case AREA.colorsSet:
    case AREA.macrosSet:
    case AREA.modTapSet:
    case AREA.toggleSet:
      return blockVerdict("key map / colour / macro write", "profile-wipe", "SYNQ doesn't write the key map, per-key colours, macros, mod-tap or toggle slots on these keyboards; a wrong write would lose their own key functions.");
  }
  const block = (size: number): { profile: number; rel: number } | null => {
    const profile = Math.floor(offset / size);
    return profile < PROFILES ? { profile, rel: offset - profile * size } : null;
  };
  switch (cmd) {
    case AREA.info:
    case AREA.base:
      return flag === 0 && offset === 0 && restZero(f, HEADER_LEN) ? okVerdict(cmd === AREA.info ? "info" : "base", "read") : notListed(f);
    case AREA.funcGet: {
      if (family === "readonly") return blockVerdict("function config read", "unknown", "NuPhy and Royal Kludge boards are only asked for their firmware version.");
      const b = block(BLOCK.func);
      return b && flag === 0 && b.rel + len <= BLOCK.func && restZero(f, HEADER_LEN) ? okVerdict("function config", "read") : notListed(f);
    }
    case AREA.triggerGet: {
      if (family === "readonly") return blockVerdict("key trigger read", "unknown", "NuPhy and Royal Kludge boards are only asked for their firmware version.");
      const b = block(BLOCK.trigger);
      return b && flag === 0 && b.rel + len <= BLOCK.trigger && restZero(f, HEADER_LEN) ? okVerdict("key triggers", "read") : notListed(f);
    }
    case AREA.funcSet: {
      if (family !== "mchose") return blockVerdict("function config write", "unknown", "Only MCHOSE boards take function-config writes from SYNQ.");
      const b = block(BLOCK.func);
      // The 64-byte block goes out as bytes 0-55 and bytes 8-63: two 56-byte writes.
      if (!b || flag !== 0 || len !== CHUNK || (b.rel !== 0 && b.rel !== BLOCK.func - CHUNK) || !restZero(f, HEADER_LEN + len)) return notListed(f);
      return funcBytesOk(b.rel, f) ? okVerdict("function config", "write") : notListed(f);
    }
    case AREA.triggerSet: {
      if (family === "readonly") return blockVerdict("key trigger write", "unknown", "NuPhy and Royal Kludge boards are never written.");
      const b = block(BLOCK.trigger);
      if (!b || len % TRIGGER_BYTES !== 0 || b.rel % TRIGGER_BYTES !== 0 || b.rel + len > BLOCK.trigger || !restZero(f, HEADER_LEN + len)) return notListed(f);
      if (flag !== 0 && !(flag === 1 && family === "drunkdeer")) return notListed(f);
      if (b.rel / TRIGGER_BYTES + len / TRIGGER_BYTES > MAX_KEYS) return notListed(f);
      for (let at = HEADER_LEN; at < HEADER_LEN + len; at += TRIGGER_BYTES) if (!recordOk(f, at)) return notListed(f);
      return okVerdict("key triggers", "write");
    }
    default:
      return notListed(f);
  }
}

// ---------------------------------------------------------------------------------------------
// Session narrowing
// ---------------------------------------------------------------------------------------------

export interface GuardContext {
  /** The active profile, once the base area has been read; before that only the info and base reads go out. */
  profile: number | null;
  /** False for read-only tiers: every "write" verdict is refused. */
  writes: boolean;
}

const refuse = (name: string, reason: string): Verdict => blockVerdict(name, "unknown", reason);

function narrow(f: Uint8Array, v: Verdict, ctx: GuardContext): Verdict {
  const name = v.name;
  const cmd = f[1];
  if (cmd === AREA.info || cmd === AREA.base) return v;
  if (ctx.profile === null) return refuse(name, "Only the info and base reads are sent until the keyboard's active profile is known.");
  if (v.verdict === "write" && !ctx.writes) return refuse(name, "This keyboard is read-only in SYNQ.");
  const offset = f[5] | (f[6] << 8);
  const size = cmd === AREA.funcGet || cmd === AREA.funcSet ? BLOCK.func : BLOCK.trigger;
  if (Math.floor(offset / size) !== ctx.profile) return blockVerdict(name, "profile-wipe", "That is not the keyboard's active profile; SYNQ only reads and writes the active one.");
  return v;
}

function classifyReport(family: GuardFamily, report: OutgoingReport, ctx?: GuardContext): Verdict {
  if (report.type !== "output") return blockVerdict("feature report", "shape", "These keyboards take output reports only; feature reports are never sent.");
  if (report.reportId !== 0) return blockVerdict("report id", "shape", `These keyboards use report id 0 (got ${report.reportId}).`);
  return classifyFrame(report.data, family, ctx);
}

/** The static allowlist of a family. The bridge repeats these. */
export const fwGuard = (family: GuardFamily): CommandGuard => ({ classify: (report) => classifyReport(family, report), blocked: BLOCKED });

export const FW_GUARDS: Readonly<Record<GuardFamily, CommandGuard>> = { mchose: fwGuard("mchose"), drunkdeer: fwGuard("drunkdeer"), readonly: fwGuard("readonly") };

/** A session's guard. `ctx` is read on every call, so the session can fill it in after the base area is read. */
export function guardFor(family: GuardFamily, ctx: () => GuardContext): CommandGuard {
  return { classify: (report) => classifyReport(family, report, ctx()), blocked: BLOCKED };
}
