// The controller half of the checkup: stick drift at rest and how round each stick's full circle is, worked out
// with the tester's own figures (src/lib/controllers/analysis.ts) from what the pad sent while it was left alone
// and while the sticks were spun.
import { circularity, drift, type Circularity, type Drift } from "../controllers/analysis.ts";
import type { PadState } from "../controllers/parse.ts";

export interface StickCheck {
  /** "Left stick" / "Right stick". */
  label: string;
  drift: Drift | null;
  round: Circularity | null;
}

/** Both sticks: drift from the hands-off states, circularity from the spin. Pads with one stick give one. */
export function stickChecks(rest: readonly PadState[], spin: readonly PadState[]): StickCheck[] {
  const count = Math.max(0, ...rest.map((s) => s.sticks.length), ...spin.map((s) => s.sticks.length));
  const out: StickCheck[] = [];
  for (let i = 0; i < Math.min(count, 2); i++) {
    const r = rest.map((s) => s.sticks[i]).filter(Boolean);
    const s = spin.map((x) => x.sticks[i]).filter(Boolean);
    out.push({ label: i === 0 ? "Left stick" : "Right stick", drift: drift(r), round: s.length ? circularity(s) : null });
  }
  return out;
}
