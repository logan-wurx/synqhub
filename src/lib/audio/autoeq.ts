// AutoEq presets (https://github.com/jaakkopasanen/AutoEq, MIT, (c) Jaakko Pasanen): the index of ~6000 headphones
// and IEMs, search by model name, and its ParametricEQ.txt turned into SYNQ's own EQ (the same shape the EQ engine
// and the preset files use), kept inside the engine's limits. The measurements behind the presets come from the
// sources AutoEq lists (oratory1990, crinacle, Rtings, Innerfidelity, ...); AutoEq states no redistribution terms
// for them, so nothing is bundled: the index and one preset are fetched from GitHub when the person asks. Pure.
import type { EqState, Filter, FilterKind, Limits } from "../eq.ts";

export const AUTOEQ_RESULTS = "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results";
export const AUTOEQ_INDEX = `${AUTOEQ_RESULTS}/README.md`;

export interface AutoEqEntry {
  name: string;
  /** Who measured it ("oratory1990", "crinacle"). */
  source: string;
  /** The rig or form the source files it under ("in-ear", "711 in-ear", "over-ear"). */
  rig: string;
  /** Folder under results/: "<source>/<rig>/<name>". */
  path: string;
}

export type Form = "IEM" | "Headphones" | "Earbuds" | "Other";

export function formOf(e: AutoEqEntry): Form {
  const r = e.rig.toLowerCase();
  if (r.includes("in-ear")) return "IEM";
  if (r.includes("over-ear") || r.includes("on-ear")) return "Headphones";
  if (r.includes("earbud")) return "Earbuds";
  return "Other";
}

/** The list lines of results/README.md: `- [7Hz Salnotes Zero 2](./ToneDeafMonk/in-ear/7Hz%20Salnotes%20Zero%202)`. */
export function parseIndex(md: string): AutoEqEntry[] {
  const out: AutoEqEntry[] = [];
  for (const m of md.matchAll(/^- \[(.+?)\]\(\.\/(.+?)\)\s*$/gm)) {
    let path: string;
    try {
      path = decodeURIComponent(m[2]);
    } catch {
      continue;
    }
    const parts = path.split("/");
    if (parts.length < 3) continue;
    out.push({ name: m[1], source: parts[0], rig: parts.slice(1, -1).join("/"), path });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Models matching every word typed ("zero 2", "Zero:2", "hd600"), best first; at most `limit`. */
export function searchAutoEq(list: readonly AutoEqEntry[], query: string, limit = 40): AutoEqEntry[] {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(" ");
  const compact = q.replace(/ /g, "");
  const scored: { e: AutoEqEntry; score: number; exact: number }[] = [];
  for (const e of list) {
    const n = norm(e.name);
    const nc = n.replace(/ /g, "");
    const all = words.every((w) => n.includes(w)) || nc.includes(compact);
    if (!all) continue;
    const score = n.startsWith(q) || nc.startsWith(compact) ? 0 : words.every((w) => (` ${n}`).includes(` ${w}`)) ? 1 : 2;
    const own = new Set(n.split(" "));
    scored.push({ e, score, exact: words.filter((w) => own.has(w)).length });
  }
  scored.sort((a, b) => a.score - b.score || b.exact - a.exact || a.e.name.length - b.e.name.length || a.e.name.localeCompare(b.e.name));
  return scored.slice(0, limit).map((s) => s.e);
}

/** Where one model's ParametricEQ.txt lives. */
export function presetUrl(e: AutoEqEntry): string {
  return `${AUTOEQ_RESULTS}/${e.path.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(`${e.name} ParametricEQ.txt`)}`;
}

/** The engine's limits a preset must fit (src-tauri/src/eq.rs LIMITS). */
export type EqLimits = Pick<Limits, "maxBoostDb" | "maxCutDb" | "preampRangeDb" | "freqRangeHz" | "qRange" | "maxFilters">;

export interface Imported {
  state: EqState;
  /** What had to change to fit the engine, in words ("Filter 4: +7.2 dB kept at +6 dB"). */
  adjusted: string[];
}

const KINDS: readonly FilterKind[] = ["PK", "LSC", "HSC", "LPQ", "HPQ", "NO"];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * AutoEq's ParametricEQ.txt (Equalizer APO syntax: `Preamp: -3.5 dB`, `Filter 1: ON LSC Fc 105 Hz Gain -3.3 dB Q 0.70`)
 * as SYNQ's EQ. Anything outside the engine's limits is brought inside and said; a file without filters is an error.
 */
export function importParametricEq(text: string, limits: EqLimits): Imported | { error: string } {
  let preamp = 0;
  const filters: Filter[] = [];
  const adjusted: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const pre = /^Preamp:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(line);
    if (pre) {
      preamp += Number(pre[1]);
      continue;
    }
    const f = /^Filter\s*\d*:\s*(ON|OFF)\s+([A-Z]+)\s+Fc\s+(\d+(?:\.\d+)?)\s*Hz(?:\s+Gain\s+(-?\d+(?:\.\d+)?)\s*dB)?(?:\s+Q\s+(\d+(?:\.\d+)?))?/i.exec(line);
    if (!f) continue;
    const kind = f[2].toUpperCase() as FilterKind;
    if (!KINDS.includes(kind)) {
      adjusted.push(`A ${f[2]} filter was left out (SYNQ's EQ doesn't have that kind).`);
      continue;
    }
    const label = `Filter ${filters.length + 1}`;
    let gain = f[4] === undefined ? 0 : Number(f[4]);
    if (gain > limits.maxBoostDb) {
      adjusted.push(`${label}: +${gain} dB kept at +${limits.maxBoostDb} dB, the most SYNQ boosts.`);
      gain = limits.maxBoostDb;
    } else if (gain < limits.maxCutDb) {
      adjusted.push(`${label}: ${gain} dB kept at ${limits.maxCutDb} dB.`);
      gain = limits.maxCutDb;
    }
    const freq = clamp(Number(f[3]), limits.freqRangeHz[0], limits.freqRangeHz[1]);
    const q = clamp(f[5] === undefined ? 0.71 : Number(f[5]), limits.qRange[0], limits.qRange[1]);
    filters.push({ enabled: f[1].toUpperCase() === "ON", kind, freq, gain, q });
  }
  if (!filters.length) return { error: "That file has no EQ filters in it." };
  if (filters.length > limits.maxFilters) {
    adjusted.push(`${filters.length - limits.maxFilters} filters past the ${limits.maxFilters} SYNQ holds were left out.`);
    filters.length = limits.maxFilters;
  }
  const p = clamp(preamp, limits.preampRangeDb[0], limits.preampRangeDb[1]);
  if (p !== preamp) adjusted.push(`Preamp ${preamp} dB kept at ${p} dB.`);
  return { state: { preamp: p, filters }, adjusted };
}

/** A preset name for it, as it shows in the Presets list. */
export const presetName = (e: AutoEqEntry): string => `AutoEq · ${e.name}`;
