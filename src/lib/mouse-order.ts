// Which mouse the Mouse page shows first, decided from which of them answered. Pure rules, no device
// access and no React, so they can be checked without a window (scripts/openmouse-safety.test.ts).
import type { MouseFamily } from "./mouse-family.ts";

/** A mouse that replied to a quick read-only check, or one that didn't (off, asleep, out of range). */
export type Answer = "answers" | "quiet";
export type Answers = ReadonlyMap<MouseFamily, Answer>;

/** How long one mouse gets to answer before it counts as off or asleep. */
export const PROBE_MS = 1000;

const rank = (a: Answer | undefined) => (a === "answers" ? 0 : a === "quiet" ? 2 : 1);

/**
 * Answering mice first, then the ones not checked yet, then the ones that didn't answer. Within each
 * group the order given (the hand-built panels before the generic ones) is kept.
 */
export function orderFamilies(present: readonly MouseFamily[], answers: Answers): MouseFamily[] {
  return present
    .map((family, i) => ({ family, i }))
    .sort((a, b) => rank(answers.get(a.family)) - rank(answers.get(b.family)) || a.i - b.i)
    .map((x) => x.family);
}

/**
 * The mouse to open on, once every mouse has been checked: the one picked last (an explicit click)
 * if it answers, else the one on screen before if it answers, else the first that answers. If none
 * answers, the pick or what was on screen, else the first listed.
 */
export function chooseShown(ordered: readonly MouseFamily[], answers: Answers, explicit: MouseFamily | null, current: MouseFamily | null = null): MouseFamily {
  const here = (f: MouseFamily | null): f is MouseFamily => !!f && ordered.includes(f);
  const answering = (f: MouseFamily | null): f is MouseFamily => here(f) && answers.get(f) === "answers";
  if (answering(explicit)) return explicit;
  if (answering(current)) return current;
  const first = ordered.find((f) => answers.get(f) === "answers");
  if (first) return first;
  if (here(explicit)) return explicit;
  if (here(current)) return current;
  return ordered[0];
}

/**
 * Runs `probe` for every family at once, each with its own time limit. A probe that throws, or
 * doesn't finish in `ms`, means the mouse didn't answer. `onResult` hears each answer as it comes in,
 * so an answer that arrives at once need not wait for a silent mouse to run out its limit. Never rejects.
 */
export async function runProbes(
  families: readonly MouseFamily[],
  probe: (family: MouseFamily) => Promise<boolean>,
  ms: number = PROBE_MS,
  onResult?: (family: MouseFamily, answer: Answer) => void,
): Promise<Map<MouseFamily, Answer>> {
  const results = await Promise.all(
    families.map(async (family): Promise<[MouseFamily, Answer]> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      });
      let answer: Answer;
      try {
        answer = (await Promise.race([probe(family), limit])) ? "answers" : "quiet";
      } catch {
        answer = "quiet";
      } finally {
        clearTimeout(timer);
      }
      onResult?.(family, answer);
      return [family, answer];
    }),
  );
  return new Map(results);
}

/**
 * `chooseShown`, as soon as the answers in so far settle it: the mouse it would pick whatever the
 * mice not heard from yet say, or null while that isn't known. (Same order of preference: the pick
 * by hand, the one on screen, the first that answers; a mouse of higher preference that hasn't
 * been heard from holds the others back.) With every mouse heard from it is never null.
 */
export function decideEarly(ordered: readonly MouseFamily[], answers: Answers, explicit: MouseFamily | null, current: MouseFamily | null = null): MouseFamily | null {
  const here = (f: MouseFamily | null): f is MouseFamily => !!f && ordered.includes(f);
  for (const preferred of [explicit, current]) {
    if (!here(preferred)) continue;
    const a = answers.get(preferred);
    if (a === undefined) return null;
    if (a === "answers") return preferred;
  }
  // The first in order that answers, once every mouse listed before it is known to be silent.
  for (const f of ordered) {
    const a = answers.get(f);
    if (a === undefined) return null;
    if (a === "answers") return f;
  }
  return chooseShown(ordered, answers, explicit, current);
}
