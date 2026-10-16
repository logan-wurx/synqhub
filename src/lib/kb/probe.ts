// Which of the plugged-in keyboards answer, so the Keyboard page opens on the one in use (as the
// Mouse page does, src/lib/mouse-probe.ts). The hand-built Falchion and X68 HE panels count as
// answering without being asked (they're wired; their panels check them themselves). A generic
// keyboard is asked its driver's one cheapest read (VIA: the protocol version), all at once, each with
// a 1 s limit, and only when two or more keyboards are listed. No timer, no poll; nothing is written.
import { useSyncExternalStore } from "react";
import { liveHardware, type Connected } from "../backend";
import { sessionHeld } from "../device-session";
import { peekKept } from "../keep";
import { PROBE_MS, runProbes, type Answer, type Answers } from "../mouse-order";
import { isIllumipcHex } from "../illumipc/ids";

/** "falchion", "x68", or "kb:<vid>:<pid>". */
export type KeyboardFamily = string;

export const keyboardFamilyOf = (d: Pick<Connected, "kind" | "vid" | "pid" | "generic" | "bootloader">): KeyboardFamily | null => {
  if (d.kind !== "keyboard" || d.bootloader) return null;
  if (d.vid === "0b05" && d.pid === "1d1d") return "falchion";
  if (isIllumipcHex(d.vid, d.pid)) return "x68";
  return d.generic ? `kb:${d.vid}:${d.pid}` : null;
};

/** Every keyboard family plugged in, once each: the hand-built panels first. */
export function keyboardFamilies(devices: readonly Connected[]): KeyboardFamily[] {
  return [...new Set(devices.map(keyboardFamilyOf).filter((f): f is KeyboardFamily => !!f))].sort((a, b) => Number(a.startsWith("kb:")) - Number(b.startsWith("kb:")));
}

/** The session / kept-state key of a family's panel. */
export const keyboardSessionKey = (f: KeyboardFamily) => (f.startsWith("kb:") ? `keyboard.kb.${f.slice(3)}` : `keyboard.${f}`);

let answers: Answers = new Map();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of [...listeners]) l();
};

export function useKeyboardAnswers(): Answers {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => answers,
  );
}

async function probeOne(family: KeyboardFamily): Promise<boolean> {
  if (!family.startsWith("kb:")) return true;
  const key = keyboardSessionKey(family);
  if (sessionHeld(key) && peekKept<{ kind: string } | null>(`${key}.phase`, null)?.kind === "ready") return true;
  if (!liveHardware) return true;
  const [{ kbHost }, { pingKeyboard }] = await Promise.all([import("./confirm"), import("./host")]);
  return pingKeyboard(await kbHost(), family.slice(3));
}

/**
 * Checks which of the listed keyboards answer; `onResult` hears each as it comes in. With fewer than
 * two keyboards, or none on the generic panel, nothing is sent.
 */
export function refreshKeyboards(devices: readonly Connected[], onResult?: (family: KeyboardFamily, answer: Answer) => void): Promise<Answers> {
  const families = keyboardFamilies(devices);
  if (families.length < 2 || !families.some((f) => f.startsWith("kb:"))) {
    for (const f of families) onResult?.(f, "answers");
    return Promise.resolve(answers);
  }
  return runProbes(families, probeOne, PROBE_MS, (family, answer) => {
    if (answers.get(family) !== answer) {
      answers = new Map(answers).set(family, answer);
      emit();
    }
    onResult?.(family, answer);
  }).then(() => answers);
}

/** A panel connected to its keyboard, so it answers whatever the last check said. */
export function markKeyboardAnswering(family: KeyboardFamily): void {
  if (answers.get(family) === "answers") return;
  answers = new Map(answers).set(family, "answers");
  emit();
}
