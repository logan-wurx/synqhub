// Outgoing-report allowlist for Royal Kludge BeiYing boards. Default-deny: only the two shapes SYNQ's encoders
// build pass, as feature reports with id 0x0A and exactly 64 data bytes:
//   - the lighting report (mode 1..21, speed 1..5, brightness 0..5, random 0/1 with zero colours when random, sleep 1..5);
//   - the nine key-map reports (header, then 139 big-endian 4-byte slots, each a key, a modifier, Fn or a consumer
//     key, never a byte pattern outside those).
// The per-key-colour reports (count 7) are refused: SYNQ doesn't send them. There is no firmware, bootloader or
// reset command in this protocol; every other byte pattern is refused all the same.
//
// The Rust bridge mirrors this guard (src-tauri/src/brands.rs `rk_beiying`; fixture: rk-beiying-frames.txt, written
// by scripts/rk-beiying-allowlist-fixture.ts). A session narrows it further (the board's own mode numbers).

import { blockVerdict, okVerdict, type BlockReason, type CommandGuard, type OutgoingReport, type Verdict } from "../local-kb.ts";
import { BRIGHTNESS, DATA_LEN, KEYMAP_FIRST_DATA, KEYMAP_NEXT_DATA, KEYMAP_REPORTS, MODE_MAX, REPORT_ID, SPEED, keymapChunk, keymapOffset } from "./protocol.ts";

/** What SYNQ never sends to these boards, for the "never sends" panel. */
export const BLOCKED: readonly { what: string; why: BlockReason }[] = [
  { what: "Per-key colour reports (count 7, header 03 7E 01): the panel has no per-key colours yet", why: "unknown" },
  { what: "Reads of any kind: these boards never answer, so SYNQ never asks (no GET_FEATURE)", why: "shape" },
  { what: "Output reports, other report ids, other lengths", why: "shape" },
  { what: "Writes to a different layer or to key slots past the 139 the base map holds", why: "unknown" },
  { what: "Firmware update: there is no command for it in this protocol, and the board's upgrader interfaces are never opened", why: "firmware" },
  { what: "Anything not listed above", why: "unknown" },
];

const restZero = (d: Uint8Array, from: number): boolean => {
  for (let i = from; i < d.length; i++) if (d[i] !== 0) return false;
  return true;
};
const notListed = (d: Uint8Array): Verdict =>
  blockVerdict("not listed", "unknown", `Report ${Array.from(d.subarray(0, 6), (b) => b.toString(16).padStart(2, "0")).join(" ")}... is not one SYNQ builds.`);

/** Mode numbers a session allows (the board's own); without it any 1..21. */
export interface GuardContext {
  modes?: readonly number[];
  /** False for read-only tiers: every "write" verdict is refused. */
  writes: boolean;
  /** Key-map reports are refused when the board's map isn't offered. */
  keymap: boolean;
}

/** The static verdict of a 64-byte data block. The bridge repeats this one. */
export function classifyData(d: Uint8Array, ctx?: GuardContext): Verdict {
  if (d.length !== DATA_LEN) return blockVerdict("bad length", "shape", `Reports carry ${DATA_LEN} data bytes (got ${d.length}).`);
  const v = classifyStatic(d);
  if (v.verdict === "blocked" || !ctx) return v;
  if (!ctx.writes) return blockVerdict(v.name, "unknown", "This keyboard is read-only in SYNQ.");
  if (v.name === "lighting" && ctx.modes && !ctx.modes.includes(d[4])) return blockVerdict(v.name, "unknown", `Mode ${d[4]} isn't one of this board's lighting modes.`);
  if (v.name === "key map" && !ctx.keymap) return blockVerdict(v.name, "unknown", "This board's key map isn't offered, so it is never rewritten.");
  return v;
}

function classifyStatic(d: Uint8Array): Verdict {
  if (d[0] === 1 && d[1] === 1) {
    const rgb0 = d[8] === 0 && d[9] === 0 && d[10] === 0;
    const ok =
      d[2] === 2 && d[3] === 0x29 && d[4] >= 1 && d[4] <= MODE_MAX && d[5] === 0 && d[6] >= SPEED.min && d[6] <= SPEED.max && d[7] >= BRIGHTNESS.min && d[7] <= BRIGHTNESS.max && d[11] <= 1 && (d[11] === 0 || rgb0) && d[12] >= 1 && d[12] <= 5 && restZero(d, 13);
    return ok ? okVerdict("lighting", "write") : notListed(d);
  }
  if (d[0] === 7) return blockVerdict("per-key colours", "unknown", "The per-key colour reports aren't sent by SYNQ.");
  if (d[0] !== KEYMAP_REPORTS || d[1] < 1 || d[1] > KEYMAP_REPORTS) return notListed(d);
  const n = d[1];
  if (n === 1 && (d[2] !== 0x01 || d[3] !== 0xf8)) return notListed(d);
  const start = n === 1 ? KEYMAP_FIRST_DATA : KEYMAP_NEXT_DATA;
  const len = keymapChunk(n);
  const g0 = keymapOffset(n);
  for (let j = 0; j < len; j++) {
    const v = d[start + j];
    const pos = (g0 + j) % 4;
    const first = j - pos >= 0 ? d[start + j - pos] : undefined; // the slot's first byte, when it is in this report
    if (pos === 0 && v > 1) return notListed(d);
    if (first === 1 && pos === 1 && v !== 0) return notListed(d); // a consumer code has no modifier byte
    if (first === 0 && pos === 2 && v > 0xe7) return notListed(d); // a key's HID usage (Fn is 0xB0, in range)
    if (first === 0 && pos === 3 && v !== 0) return notListed(d);
  }
  return restZero(d, start + len) ? okVerdict("key map", "write") : notListed(d);
}

function classifyReport(report: OutgoingReport, ctx?: GuardContext): Verdict {
  if (report.type !== "feature") return blockVerdict("output report", "shape", "These keyboards take feature reports only; output reports are never sent.");
  if (report.reportId !== REPORT_ID) return blockVerdict("report id", "shape", `Report id must be 0x0A (got ${report.reportId}).`);
  return classifyData(report.data, ctx);
}

/** The static allowlist. The bridge repeats this one. */
export const RK_BEIYING_GUARD: CommandGuard = {
  classify: (report) => classifyReport(report),
  blocked: BLOCKED,
};

/** A session's guard. `ctx` is read on every call. */
export function guardFor(ctx: () => GuardContext): CommandGuard {
  return { classify: (report) => classifyReport(report, ctx()), blocked: BLOCKED };
}
