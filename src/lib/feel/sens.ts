// The sensitivity calculator. Moving to a mouse that can't reach the exact DPI keeps the same
// distance-per-turn by changing the in-game sensitivity:  new sens = old sens x old DPI / new DPI.
// Valorant's sensitivity is the CS2 one divided by 3.181818 (its yaw is 0.07 against CS2's 0.022).

import { clean } from "./units.ts";
import type { GameSens, SensAdvice, SensLine } from "./types.ts";

/** Valorant yaw 0.07 / CS2 yaw 0.022: a Valorant sens x this = the same turn in CS2. */
export const VALORANT_PER_CS2 = 3.181818;

export type Game = "cs2" | "valorant";

export const GAME_LABEL: Record<Game, string> = { cs2: "CS2", valorant: "Valorant" };

export const cs2FromValorant = (v: number): number => v * VALORANT_PER_CS2;
export const valorantFromCs2 = (c: number): number => c / VALORANT_PER_CS2;

/** A usable DPI or sensitivity: finite and above zero. */
export const isPositive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * In-game sensitivities are typed to three decimals (two once they are 10 or more); anything finer is
 * noise below what a hand can tell apart.
 */
export function roundSens(sens: number): number {
  return sens >= 10 ? clean(sens, 2) : clean(sens, 3);
}

/** DPI x sensitivity, shown to one decimal. */
export const edpi = (dpi: number, sens: number): number => clean(dpi * sens, 1);

/** The sens to use at `newDpi` so the mouse turns the same as `oldSens` at `oldDpi` (not rounded). */
export function convertSens(oldSens: number, oldDpi: number, newDpi: number): number {
  if (!isPositive(oldSens) || !isPositive(oldDpi) || !isPositive(newDpi)) return NaN;
  return (oldSens * oldDpi) / newDpi;
}

function line(oldSens: number, oldDpi: number, newDpi: number, derived: boolean): SensLine {
  const next = roundSens(convertSens(oldSens, oldDpi, newDpi));
  return { old: roundSens(oldSens), next, oldEdpi: edpi(oldDpi, oldSens), newEdpi: edpi(newDpi, next), derived };
}

/**
 * What to tell the person after the DPI changed from `oldDpi` to `newDpi`. With CS2 typed in, Valorant is
 * worked out from it (and the other way round); with both typed, each is kept as typed. null when either
 * DPI isn't a real number.
 */
export function sensAdvice(oldDpi: number, newDpi: number, sens: GameSens): SensAdvice | null {
  if (!isPositive(oldDpi) || !isPositive(newDpi)) return null;
  const cs2Given = isPositive(sens.cs2);
  const valGiven = isPositive(sens.valorant);
  const cs2Old = cs2Given ? sens.cs2! : valGiven ? cs2FromValorant(sens.valorant!) : null;
  const valOld = valGiven ? sens.valorant! : cs2Given ? valorantFromCs2(sens.cs2!) : null;
  return {
    oldDpi,
    newDpi,
    exact: oldDpi === newDpi,
    factor: clean(oldDpi / newDpi, 4),
    cs2: cs2Old === null ? null : line(cs2Old, oldDpi, newDpi, !cs2Given),
    valorant: valOld === null ? null : line(valOld, oldDpi, newDpi, !valGiven),
  };
}

/** A standalone question: "I play CS2 at 0.55 on 800 DPI. What do I use at 1000?" */
export function calculate(input: { game: Game; sens: number; oldDpi: number; newDpi: number }): SensAdvice | null {
  return sensAdvice(input.oldDpi, input.newDpi, input.game === "cs2" ? { cs2: input.sens, valorant: null } : { cs2: null, valorant: input.sens });
}
