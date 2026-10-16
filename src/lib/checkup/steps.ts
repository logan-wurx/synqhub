// The guided checkup, step by step: which steps run for the gear in scope, what each one asks the person to do,
// and how long it lasts or how many presses finish it. Pure data; the page runs them.
import { CLICKS, HOLD, KEYS, MOTION, REST, STICKS } from "./thresholds.ts";
import { keyLabel } from "./keyboard.ts";

export type StepId = "rest" | "clicks" | "circles" | "keys" | "hold" | "sticks";

export interface StepDef {
  id: StepId;
  /** What to do, as one instruction: "Click the left button 30 times". */
  title: string;
  /** How, in a short line. */
  hint: string;
  /** Timed steps: how long SYNQ listens once it starts. */
  seconds?: number;
  /** Counted steps: presses that finish it. */
  target?: number;
  /** A counted step ends by itself after this long anyway (the person may stop early). */
  limitSeconds?: number;
}

export interface Scope {
  mice: number;
  keyboards: number;
  controllers: number;
}

const restWhat = (s: Scope) => {
  const parts = [s.mice && "the mouse", s.keyboards && "the keyboard", s.controllers && (s.controllers > 1 ? "the controllers" : "the controller")].filter(Boolean) as string[];
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "everything";
};

/** The steps for the gear in scope, in the order they run. Sound needs none: it's read from the config. */
export function planSteps(s: Scope): StepDef[] {
  const steps: StepDef[] = [];
  if (s.mice + s.keyboards + s.controllers > 0) {
    steps.push({ id: "rest", title: `Hands off for ${REST.seconds} seconds`, hint: `Let go of ${restWhat(s)}. SYNQ listens for anything that moves or presses on its own.`, seconds: REST.seconds });
  }
  if (s.mice) {
    steps.push({ id: "clicks", title: `Click the left button ${CLICKS.target} times`, hint: "At your normal pace, anywhere in this window.", target: CLICKS.target, limitSeconds: 40 });
    steps.push({ id: "circles", title: "Move the mouse in big, fast circles", hint: `Keep it moving for ${MOTION.seconds} seconds, the way you'd flick in a game.`, seconds: MOTION.seconds });
  }
  if (s.keyboards) {
    steps.push({ id: "keys", title: "Press each of these keys once", hint: "One at a time, the way you'd tap them in a game.", target: KEYS.codes.length, limitSeconds: 30 });
    steps.push({ id: "hold", title: `Hold ${keyLabel(HOLD.code)} down for ${HOLD.seconds} seconds`, hint: "Rest your finger on it as you would while walking in a game, then let go.", seconds: HOLD.seconds + 1 });
  }
  if (s.controllers) {
    steps.push({ id: "sticks", title: "Spin both sticks slowly around the edge", hint: "Three full turns each, pushed all the way out.", seconds: STICKS.seconds });
  }
  return steps;
}

/** About how long the steps take, with a little time to read each one. */
export function estimateSeconds(steps: readonly StepDef[]): number {
  return Math.round(steps.reduce((a, s) => a + (s.seconds ?? (s.id === "clicks" ? 10 : 7)) + 3, 0) / 5) * 5;
}
