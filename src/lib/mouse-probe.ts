// Which of the plugged-in mice actually answer. A LIGHTSPEED or 8K receiver stays plugged in when
// its mouse is switched off, so "plugged in" alone can't tell which mouse is in use. When more than
// one mouse is listed, this asks each one for a quick read-only reply (a HID++ ping for the Logitech,
// GetMouseOnline + CID/MID for the ATK, the driver's cheapest read for any other), all at once, each
// with a 1 s limit, and keeps the answers for the Mouse page and the sidebar hint.
//
// It runs when the Mouse page opens and when the list of devices changes, never on a timer. One
// mouse (or none) needs no check, so nothing is sent at all then. Nothing is written to any mouse.
import { useSyncExternalStore } from "react";
import { liveHardware, type Connected } from "./backend";
import { sessionHeld } from "./device-session";
import { peekKept } from "./keep";
import { mouseFamilies, sessionKeyOf, type MouseFamily } from "./mouse-family";
import { PROBE_MS, runProbes, type Answer, type Answers } from "./mouse-order";

/** Answers younger than this are used as they are when the Mouse page opens right after a check. */
const FRESH_MS = 2000;
/** Each probe stops itself a little before the limit so its device is closed again by then. */
const SELF_MS = PROBE_MS - 100;

let answers: Answers = new Map();
let doneAt = 0;
interface Round {
  key: string;
  /** What has come in so far this round. */
  partial: Map<MouseFamily, Answer>;
  watchers: Set<(family: MouseFamily, answer: Answer) => void>;
  promise: Promise<Answers>;
}
let inflight: Round | null = null;
const listeners = new Set<() => void>();

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The latest answers per mouse family. A family with no entry hasn't been checked. */
export function useMouseAnswers(): Answers {
  return useSyncExternalStore(subscribe, () => answers);
}

export const peekAnswers = (): Answers => answers;

/** Every one of these was checked within the last couple of seconds. */
export function checkedRecently(families: readonly MouseFamily[]): boolean {
  return Date.now() - doneAt < FRESH_MS && families.every((f) => answers.has(f));
}

/** In the browser preview there are no devices: every mouse answers, except the families named in `?asleep=logitech,atk`. */
const previewQuiet = (): Set<string> => {
  try {
    return new Set((new URLSearchParams(location.search).get("asleep") ?? "").split(",").filter(Boolean));
  } catch {
    return new Set();
  }
};

async function probeOne(family: MouseFamily, devices: readonly Connected[]): Promise<boolean> {
  if (!liveHardware) return !previewQuiet().has(family);
  const key = sessionKeyOf(family);
  // A panel that is showing this mouse and has it connected answers by being there; asking again
  // would only add traffic on a channel it is using.
  if (sessionHeld(key) && peekKept<{ kind: string } | null>(`${key}.phase`, null)?.kind === "ready") return true;
  if (family === "logitech") {
    const pids = devices.filter((d) => d.kind === "mouse" && d.vid === "046d").map((d) => d.pid);
    return (await import("./logitech-probe")).probeLogitech(pids, SELF_MS);
  }
  if (family === "atk") return (await import("./atk-probe")).probeAtk(SELF_MS);
  const [{ genericHost }, { pingGeneric }] = await Promise.all([import("./generic-mice"), import("./openmouse/host")]);
  return pingGeneric(await genericHost(), family.slice(3));
}

/**
 * Checks which of the listed mice answer and keeps the result. With fewer than two mice there is
 * nothing to choose between, and nothing is sent. A check already running for the same mice is
 * joined; `force` skips the "checked a moment ago" shortcut (a changed device list). `onResult`
 * hears each mouse's answer as it comes in (answers already in are replayed to it first), so the
 * caller needn't wait for a mouse that is off to run out its limit.
 */
export function refreshMice(devices: readonly Connected[], opts: { force?: boolean; onResult?: (family: MouseFamily, answer: Answer) => void } = {}): Promise<Answers> {
  const families = mouseFamilies(devices);
  if (families.length < 2) return Promise.resolve(answers);
  const key = families.join();
  const { onResult } = opts;
  if (inflight?.key === key) {
    if (onResult) {
      for (const [f, a] of inflight.partial) onResult(f, a);
      inflight.watchers.add(onResult);
    }
    return inflight.promise;
  }
  if (!opts.force && checkedRecently(families)) {
    for (const f of families) onResult?.(f, answers.get(f)!);
    return Promise.resolve(answers);
  }
  const round: Round = { key, partial: new Map(), watchers: new Set(onResult ? [onResult] : []), promise: Promise.resolve(answers) };
  const store = (family: MouseFamily, answer: Answer) => {
    if (answers.get(family) === answer) return;
    answers = new Map(answers).set(family, answer);
    for (const l of [...listeners]) l();
  };
  round.promise = runProbes(families, (f) => probeOne(f, devices), PROBE_MS, (family, answer) => {
    round.partial.set(family, answer);
    store(family, answer);
    for (const w of [...round.watchers]) w(family, answer);
  })
    .then(() => {
      doneAt = Date.now();
      return answers;
    })
    .finally(() => {
      if (inflight === round) inflight = null;
    });
  inflight = round;
  return round.promise;
}

/**
 * A panel connected to its mouse, so that mouse answers whatever the last check said (it was
 * switched on after it, or picked by hand). Only the label changes; the order of the switcher
 * stays as it was when the page opened.
 */
export function markAnswering(family: MouseFamily): void {
  if (answers.get(family) === "answers") return;
  answers = new Map(answers).set(family, "answers");
  for (const l of [...listeners]) l();
}
