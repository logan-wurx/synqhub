// React glue for the tester: the window's focus (handles are released when SYNQ isn't the focused window), and the
// live pad state drawn at most once a frame however fast the pad reports.
import { useEffect, useRef, useState } from "react";
import { liveHardware } from "../backend";
import type { PadLink } from "./link";
import type { PadState, StickState } from "./parse";

/**
 * Whether SYNQ's window (or the browser tab) is focused and visible. The preview and the end-to-end build talk to
 * simulated pads only, so there it always counts as focused (a headless browser may never report focus).
 */
export function useWindowFocus(): boolean {
  const get = () => !liveHardware || typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus());
  const [focused, setFocused] = useState(get);
  useEffect(() => {
    const update = () => setFocused(get());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return focused;
}

const TRAIL = 48;

export interface LiveView {
  state: PadState | null;
  trails: StickState[][];
  /** Buttons pressed at least once since the tester opened. */
  seen: ReadonlySet<string>;
  /** Reports per second over the last second, as they arrive (a rough live figure; the Polling tab measures properly). */
  rate: number;
}

/** The pad's latest state, its stick trails and the buttons seen, refreshed once per animation frame. */
export function useLiveState(link: PadLink | null): LiveView {
  const [view, setView] = useState<LiveView>({ state: null, trails: [[], []], seen: new Set(), rate: 0 });
  const latest = useRef<PadState | null>(null);
  const times = useRef<number[]>([]);
  useEffect(() => {
    if (!link) return;
    const seen = new Set<string>();
    const trails: StickState[][] = [[], []];
    const offState = link.onState((s) => {
      latest.current = s;
      for (const [b, down] of Object.entries(s.buttons)) if (down) seen.add(b);
    });
    const offRaw = link.onRaw((r) => times.current.push(r.t));
    let frame = 0;
    let shown: PadState | null = null;
    const tick = () => {
      const s = latest.current;
      const now = performance.now();
      const t = times.current;
      // Keep only the last second of report times (the bridge's clock; compare with the newest).
      if (t.length) {
        const newest = t[t.length - 1];
        while (t.length && t[0] < newest - 1000) t.shift();
      }
      if (s && s !== shown) {
        shown = s;
        s.sticks.forEach((st, i) => {
          const tr = (trails[i] ??= []);
          tr.push(st);
          if (tr.length > TRAIL) tr.shift();
        });
        setView({ state: s, trails: trails.map((x) => [...x]), seen: new Set(seen), rate: t.length });
      } else if (now % 500 < 17) {
        setView((v) => (v.rate === t.length ? v : { ...v, rate: t.length }));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      offState();
      offRaw();
      latest.current = null;
      times.current = [];
    };
  }, [link]);
  return view;
}
