// Small number helpers the mapping uses: snapping to a device's step, picking the nearest supported
// value, and the unit changes between millimetres and a keyboard's travel units (0.1 mm or 0.01 mm).

/** How many decimals a step like 0.05 or 10 needs. */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  let d = 0;
  while (d < 8 && Math.abs(Math.round(step * 10 ** d) / 10 ** d - step) > 1e-9) d++;
  return d;
}

/** Rounds away binary noise (0.30000000000000004 -> 0.3). */
export const clean = (n: number, decimals = 6): number => Math.round(n * 10 ** decimals) / 10 ** decimals;

/**
 * The nearest value on a grid that starts at `min` and moves in `step`s, kept inside min..max. A tie goes
 * to the higher value (1.25 mm on a 0.1 grid is 1.3).
 */
export function snap(value: number, min: number, max: number, step: number): number {
  if (!(step > 0)) return clamp(value, min, max);
  const n = Math.floor((clamp(value, min, max) - min) / step + 0.5 + 1e-9);
  const out = clean(min + n * step, Math.max(decimalsOf(step), decimalsOf(min)));
  return out > max ? clean(min + Math.floor((max - min) / step + 1e-9) * step, Math.max(decimalsOf(step), decimalsOf(min))) : out;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Which way a tie between two equally near values goes. "up" is the faster / snappier choice for polling. */
export type Tie = "up" | "down";

/**
 * The option nearest to `want`. `scale: "log"` compares ratios (polling rates, DPI: 1000 is as far from 500
 * as 2000 is), `"linear"` compares differences.
 */
export function nearest(want: number, options: readonly number[], scale: "linear" | "log" = "linear", tie: Tie = "up"): number | null {
  const list = options.filter((o) => Number.isFinite(o));
  if (!list.length) return null;
  const dist = (o: number) => (scale === "log" && want > 0 && o > 0 ? Math.abs(Math.log(o / want)) : Math.abs(o - want));
  let best = list[0];
  for (const o of list) {
    const d = dist(o) - dist(best);
    if (d < -1e-9 || (Math.abs(d) <= 1e-9 && (tie === "up" ? o > best : o < best))) best = o;
  }
  return best;
}

/** Millimetres -> a keyboard's travel units (whole numbers), and back. `unitMm` is 0.1 or 0.01. */
export const mmToUnits = (mm: number, unitMm: number): number => Math.round(mm / unitMm + 1e-9);
export const unitsToMm = (units: number, unitMm: number): number => clean(units * unitMm, decimalsOf(unitMm));

/** "1.2", "1.25", "2.0": the shortest text that shows the value (at least one decimal, at most three). */
export function fmtMm(mm: number): string {
  const v = clean(mm, 3);
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

/** A plain number without binary noise or trailing zeros: 0.55, 1250, 3.182. */
export const fmtNum = (n: number, decimals = 3): string => String(clean(n, decimals));

/** 4000 -> "4 kHz", 500 -> "500 Hz" (the app's polling wording). */
export const hzText = (hz: number): string => (hz >= 1000 ? `${clean(hz / 1000, 3)} kHz` : `${hz} Hz`);
