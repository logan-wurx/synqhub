// The saved feel: building it from a device's settings, reading it back from storage (anything damaged or
// out of range is dropped rather than trusted), and the one-line summaries the home page shows.
import { fmtMm, fmtNum, hzText } from "./units.ts";
import { isPositive } from "./sens.ts";
import type { FeelProfile, FeelSource, GameSens, KeyboardFeel, LodFeel, LodLevel, MouseFeel, SocdMode, SocdPairFeel } from "./types.ts";

export const PROFILE_VERSION = 1;
const MAX_STAGES = 16;
const SOCD_MODES: readonly SocdMode[] = ["last", "neutral", "priorityA", "priorityB", "first", "deeper", "deeperSingle"];
const LEVELS: readonly LodLevel[] = ["Low", "Medium", "High"];

export const emptySens = (): GameSens => ({ cs2: null, valorant: null });

export function emptyProfile(now = Date.now()): FeelProfile {
  return { version: PROFILE_VERSION, updatedAt: now, mouse: null, keyboard: null, sens: emptySens() };
}

// ---------------------------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------------------------

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function lodOf(v: unknown): LodFeel | null {
  const o = obj(v);
  if (!o) return null;
  if (o.kind === "level" && LEVELS.includes(o.level as LodLevel)) return { kind: "level", level: o.level as LodLevel };
  if (o.kind === "mm") {
    const mm = num(o.mm, 0, 20);
    if (mm === null) return null;
    const min = num(o.min, 0, 20);
    const max = num(o.max, 0, 20);
    return min !== null && max !== null && max > min ? { kind: "mm", mm, min, max } : { kind: "mm", mm };
  }
  return null;
}

/** A mouse feel from stored JSON, or null when it has no usable DPI. */
export function mouseFeelOf(v: unknown): MouseFeel | null {
  const o = obj(v);
  if (!o || !Array.isArray(o.stages)) return null;
  const stages = o.stages.map((s) => num(s, 50, 100_000));
  if (!stages.length || stages.length > MAX_STAGES || stages.some((s) => s === null)) return null;
  const active = typeof o.active === "number" && Number.isInteger(o.active) && o.active >= 0 && o.active < stages.length ? o.active : 0;
  return {
    stages: stages as number[],
    active,
    pollingHz: num(o.pollingHz, 1, 32_000),
    lod: lodOf(o.lod),
    debounceMs: num(o.debounceMs, 0, 1000),
    angleSnapping: bool(o.angleSnapping),
    motionSync: bool(o.motionSync),
    ripple: bool(o.ripple),
  };
}

function pairsOf(v: unknown): SocdPairFeel[] | null {
  if (!Array.isArray(v)) return null;
  const out: SocdPairFeel[] = [];
  for (const p of v) {
    const o = obj(p);
    if (!o || typeof o.a !== "string" || typeof o.b !== "string" || !o.a || !o.b || o.a.length > 16 || o.b.length > 16 || !SOCD_MODES.includes(o.mode as SocdMode)) continue;
    out.push({ a: o.a, b: o.b, mode: o.mode as SocdMode });
  }
  return out.slice(0, 40);
}

/** A keyboard feel from stored JSON, or null when it holds nothing at all. */
export function keyboardFeelOf(v: unknown): KeyboardFeel | null {
  const o = obj(v);
  if (!o) return null;
  const feel: KeyboardFeel = {
    actuationMm: num(o.actuationMm, 0.01, 20),
    rapidTrigger: bool(o.rapidTrigger),
    rtPressMm: num(o.rtPressMm, 0.01, 20),
    rtReleaseMm: num(o.rtReleaseMm, 0.01, 20),
    socd: pairsOf(o.socd),
  };
  return feel.actuationMm === null && feel.rapidTrigger === null && feel.rtPressMm === null && feel.rtReleaseMm === null && !feel.socd?.length ? null : feel;
}

function sourceOf(v: unknown): FeelSource | null {
  const o = obj(v);
  if (!o || typeof o.deviceId !== "string" || !o.deviceId || typeof o.name !== "string") return null;
  const out: FeelSource = { deviceId: o.deviceId.slice(0, 80), name: o.name.slice(0, 120), savedAt: num(o.savedAt, 0, Number.MAX_SAFE_INTEGER) ?? 0 };
  if (typeof o.brand === "string" && o.brand) out.brand = o.brand.slice(0, 60);
  return out;
}

export function sensOf(v: unknown): GameSens {
  const o = obj(v);
  return { cs2: o && isPositive(o.cs2) && o.cs2 < 1000 ? o.cs2 : null, valorant: o && isPositive(o.valorant) && o.valorant < 1000 ? o.valorant : null };
}

/** A profile from stored JSON. null when it is not one (wrong shape or a version this build doesn't know). */
export function profileOf(v: unknown): FeelProfile | null {
  const o = obj(v);
  if (!o || o.version !== PROFILE_VERSION) return null;
  const m = obj(o.mouse);
  const k = obj(o.keyboard);
  const mouseFeel = m ? mouseFeelOf(m.feel) : null;
  const mouseFrom = m ? sourceOf(m.from) : null;
  const kbFeel = k ? keyboardFeelOf(k.feel) : null;
  const kbFrom = k ? sourceOf(k.from) : null;
  return {
    version: PROFILE_VERSION,
    updatedAt: num(o.updatedAt, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    mouse: mouseFeel && mouseFrom ? { feel: mouseFeel, from: mouseFrom } : null,
    keyboard: kbFeel && kbFrom ? { feel: kbFeel, from: kbFrom } : null,
    sens: sensOf(o.sens),
  };
}

export const isEmptyProfile = (p: FeelProfile | null): boolean => !p || (!p.mouse && !p.keyboard && !p.sens.cs2 && !p.sens.valorant);

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

export const lodLabel = (l: LodFeel): string => (l.kind === "mm" ? `${fmtMm(l.mm)} mm` : l.level);

/** "1600 DPI · 4 kHz · Low lift-off" */
export function mouseSummary(f: MouseFeel): string {
  const dpi = f.stages[f.active];
  return [`${fmtNum(dpi)} DPI`, f.pollingHz !== null ? hzText(f.pollingHz) : null, f.lod ? `${lodLabel(f.lod)} lift-off` : null].filter(Boolean).join(" · ");
}

/** "1.2 mm · rapid trigger 0.3 mm" */
export function keyboardSummary(f: KeyboardFeel): string {
  const press = f.rtPressMm ?? f.rtReleaseMm;
  const rt = f.rapidTrigger === false ? "rapid trigger off" : press !== null ? `rapid trigger ${fmtMm(press)} mm` : f.rapidTrigger ? "rapid trigger on" : null;
  const socd = f.socd?.length ? `${f.socd.length} SOCD ${f.socd.length === 1 ? "pair" : "pairs"}` : null;
  return [f.actuationMm !== null ? `${fmtMm(f.actuationMm)} mm` : null, rt, socd].filter(Boolean).join(" · ");
}

/** Two feels are the same setup, whatever order their keys were written in. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
export const sameFeel = (a: unknown, b: unknown): boolean => stable(a) === stable(b);
