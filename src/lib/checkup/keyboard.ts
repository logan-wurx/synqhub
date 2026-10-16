// The keyboard half of the checkup: keys that fire twice (switch chatter, or rapid trigger set finer than a finger
// can hold still), keys that stay down, keys that never registered, and keys that pressed themselves while
// nobody typed. Pure functions over recorded key events; the OS's auto-repeat is never counted as a press.
import { HOLD, KEYS } from "./thresholds.ts";
import type { KeyEvent } from "./types.ts";

const byTime = (xs: readonly KeyEvent[]) => [...xs].sort((a, b) => a.t - b.t);

export interface KeyStats {
  presses: number;
  /** Presses that came back within KEYS.chatterGapMs of the release before them. */
  bounces: number;
  gaps: number[];
  /** Down at the end and never released. */
  stuck: boolean;
}

/**
 * Per key: presses, quick re-presses and whether it was left down. `end`: when the step finished (a key still down
 * KEYS.stuckAfterMs before that counts as stuck).
 */
export function keyStats(events: readonly KeyEvent[], end: number): Map<string, KeyStats> {
  const out = new Map<string, KeyStats>();
  const lastUp = new Map<string, number>();
  const downAt = new Map<string, number>();
  for (const e of byTime(events)) {
    let s = out.get(e.code);
    if (!s) out.set(e.code, (s = { presses: 0, bounces: 0, gaps: [], stuck: false }));
    if (e.down) {
      if (e.repeat || downAt.has(e.code)) continue;
      downAt.set(e.code, e.t);
      s.presses++;
      const up = lastUp.get(e.code);
      if (up !== undefined && e.t - up < KEYS.chatterGapMs) {
        s.bounces++;
        s.gaps.push(Math.max(0, e.t - up));
      }
    } else {
      downAt.delete(e.code);
      lastUp.set(e.code, e.t);
    }
  }
  for (const [code, t] of downAt) {
    const s = out.get(code);
    if (s && end - t >= KEYS.stuckAfterMs) s.stuck = true;
  }
  return out;
}

export interface HoldStats {
  /** The key went down at least once. */
  pressed: boolean;
  /** Releases (each followed by a new press) while it was being held. */
  toggles: number;
  /** Longest unbroken hold (ms). */
  longestMs: number;
  /** From the first press to the last release (ms). */
  spanMs: number;
  /** It came back up at the end. */
  released: boolean;
}

/** One key held down for a while: every release-and-press in the middle is the key letting go on its own. */
export function holdStats(events: readonly KeyEvent[], code: string = HOLD.code): HoldStats {
  const own = byTime(events).filter((e) => e.code === code && !e.repeat);
  let down: number | null = null;
  let firstDown: number | null = null;
  let toggles = 0;
  let longest = 0;
  let lastUp: number | null = null;
  for (const e of own) {
    if (e.down) {
      if (down !== null) continue;
      down = e.t;
      if (firstDown === null) firstDown = e.t;
      else if (lastUp !== null && e.t - lastUp < HOLD.toggleGapMs) toggles++;
    } else if (down !== null) {
      longest = Math.max(longest, e.t - down);
      down = null;
      lastUp = e.t;
    }
  }
  const span = firstDown !== null && lastUp !== null ? lastUp - firstDown : 0;
  return { pressed: firstDown !== null, toggles, longestMs: longest, spanMs: span, released: down === null && firstDown !== null };
}

/** Keys that went down during the hands-off step (a key pressing itself, or one auto-repeating because it's stuck). */
export function phantomKeys(events: readonly KeyEvent[]): string[] {
  return [...new Set(events.filter((e) => e.down).map((e) => e.code))];
}

/** "KeyW" -> "W", "Space" -> "Space", "ShiftLeft" -> "Left Shift". */
export function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  const side = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code);
  if (side) return `${side[2]} ${side[1] === "Control" ? "Ctrl" : side[1]}`;
  if (code.startsWith("Arrow")) return code.slice(5);
  return code;
}
