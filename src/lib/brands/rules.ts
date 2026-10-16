// A small, data-only frame allowlist: each rule pins some bytes (exact, set or range), optional
// little-endian u16 fields, and "everything from byte N is zero". The brand guards are tables of these
// rules, so the Rust bridge can load the same table (exported as JSON by
// scripts/brands-allowlist-fixture.ts) and run the same 30-line matcher instead of a hand port.
//
// Evaluation: blocked rules are checked first, then allowed rules; no match = refused ("not listed").
import type { BlockReason, FrameVerdict } from "./types.ts";

export interface ByteRule {
  at: number;
  eq?: number;
  in?: readonly number[];
  min?: number;
  max?: number;
}

export interface U16Rule {
  /** Little-endian u16 at bytes [at, at + 1]. */
  at: number;
  min: number;
  max: number;
}

export interface FrameRule {
  id: string;
  what: string;
  verdict: "read" | "write" | "blocked";
  why?: BlockReason;
  /** Which model families of the brand the rule applies to ("*" = all). */
  families: readonly string[];
  bytes: readonly ByteRule[];
  u16?: readonly U16Rule[];
  /** Bytes from this index to the end must be zero. */
  zeroFrom?: number;
  /** Optional: payload bytes [from, to) must each be <= max (bitmaps, booleans). */
  eachMax?: { from: number; to: number; max: number };
  /** Matches when this byte sequence appears anywhere in the frame (blocked rules: magic strings). */
  contains?: readonly number[];
  note?: string;
}

const byteOk = (f: Uint8Array, r: ByteRule): boolean => {
  if (r.at >= f.length) return false;
  const v = f[r.at];
  if (r.eq !== undefined && v !== r.eq) return false;
  if (r.in && !r.in.includes(v)) return false;
  if (r.min !== undefined && v < r.min) return false;
  if (r.max !== undefined && v > r.max) return false;
  return true;
};

function containsSeq(f: Uint8Array, seq: readonly number[]): boolean {
  outer: for (let i = 0; i + seq.length <= f.length; i++) {
    for (let j = 0; j < seq.length; j++) if (f[i + j] !== seq[j]) continue outer;
    return true;
  }
  return false;
}

export function ruleMatches(rule: FrameRule, family: string, f: Uint8Array): boolean {
  if (!rule.families.includes("*") && !rule.families.includes(family)) return false;
  if (rule.contains && !containsSeq(f, rule.contains)) return false;
  for (const b of rule.bytes) if (!byteOk(f, b)) return false;
  for (const u of rule.u16 ?? []) {
    if (u.at + 1 >= f.length) return false;
    const v = f[u.at] | (f[u.at + 1] << 8);
    if (v < u.min || v > u.max) return false;
  }
  if (rule.eachMax) for (let i = rule.eachMax.from; i < rule.eachMax.to; i++) if (f[i] > rule.eachMax.max) return false;
  if (rule.zeroFrom !== undefined) for (let i = rule.zeroFrom; i < f.length; i++) if (f[i] !== 0) return false;
  return true;
}

/** Blocked rules win; then the first allowed rule; else "not listed". */
export function evaluate(rules: readonly FrameRule[], family: string, f: Uint8Array): FrameVerdict & { rule?: string } {
  for (const r of rules)
    if (r.verdict === "blocked" && ruleMatches(r, family, f)) return { verdict: "blocked", what: r.what, why: r.why ?? "unknown", reason: r.note, rule: r.id };
  for (const r of rules) if (r.verdict !== "blocked" && ruleMatches(r, family, f)) return { verdict: r.verdict, what: r.what, rule: r.id };
  return { verdict: "blocked", what: "unlisted command", why: "unknown", reason: "not on SYNQ's list of known-safe commands" };
}

/** Rule ids must be unique and blocked rules must say why. Used by the tests. */
export function lintRules(rules: readonly FrameRule[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const r of rules) {
    if (ids.has(r.id)) errors.push(`duplicate rule id ${r.id}`);
    ids.add(r.id);
    if (r.verdict === "blocked" && !r.why) errors.push(`${r.id}: blocked without a reason`);
    if (r.verdict !== "blocked" && r.zeroFrom === undefined) errors.push(`${r.id}: allowed rule without zeroFrom (trailing bytes unchecked)`);
  }
  return errors;
}
