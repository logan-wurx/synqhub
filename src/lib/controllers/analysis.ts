// The tester's figures (CONTROLLERS.md §6): stick drift, circularity, inner and outer deadzone, resolution, trigger
// range and bit depth, button chatter, gyro bias, and the polling rate.
//
// Polling follows Gamepadla's method (https://gamepadla.com, MIT): the time between successive changes while a stick
// moves; the median interval gives the rate, with p1 / p99 and the jitter beside it. The first 200 ms and any gap over
// 50 ms (the pad idle or asleep) are left out. Credit: Gamepadla Polling (MIT).
//
// Pure functions: no DOM, no React, no device access.
import type { PadState, StickState } from "./parse.ts";

const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);
const quantile = (s: readonly number[], q: number) => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] : 0);
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs: readonly number[]) => {
  const m = mean(xs);
  return xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : 0;
};

export interface PollingStats {
  /** Intervals used. */
  count: number;
  medianMs: number;
  /** 1000 / median. */
  hz: number;
  meanHz: number;
  p1Ms: number;
  p99Ms: number;
  /** Standard deviation of the intervals (ms). */
  jitterMs: number;
  /** Intervals dropped (the first 200 ms, gaps over 50 ms). */
  dropped: number;
}

/** Polling from the times (ms) of successive reports or changes. Null with fewer than 20 usable intervals. */
export function pollingStats(times: readonly number[], opts: { warmupMs?: number; maxGapMs?: number } = {}): PollingStats | null {
  const warmup = opts.warmupMs ?? 200;
  const maxGap = opts.maxGapMs ?? 50;
  if (times.length < 2) return null;
  const start = times[0] + warmup;
  const intervals: number[] = [];
  let dropped = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (times[i - 1] < start || gap > maxGap || gap <= 0) {
      dropped++;
      continue;
    }
    intervals.push(gap);
  }
  if (intervals.length < 20) return null;
  const s = sorted(intervals);
  const median = quantile(s, 0.5);
  return { count: s.length, medianMs: median, hz: 1000 / median, meanHz: 1000 / mean(s), p1Ms: quantile(s, 0.01), p99Ms: quantile(s, 0.99), jitterMs: stdev(s), dropped };
}

/** The times at which the state changed (sticks, triggers or buttons), from a stream of states. */
export function changeTimes(states: readonly PadState[]): number[] {
  const out: number[] = [];
  let last = "";
  for (const s of states) {
    const key = JSON.stringify([s.sticksRaw ?? s.sticks, s.triggersRaw ?? s.triggers, s.buttons]);
    if (key !== last) out.push(s.t);
    last = key;
  }
  return out;
}

export interface Drift {
  /** Mean offset from centre at rest. */
  x: number;
  y: number;
  /** Distance of that offset from centre (0..1 of the radius). */
  magnitude: number;
  /** Noise (standard deviation of the distance from the mean). */
  noise: number;
  samples: number;
}

/** Stick drift over a stretch at rest (the stick untouched). */
export function drift(samples: readonly StickState[]): Drift | null {
  if (samples.length < 10) return null;
  const x = mean(samples.map((s) => s.x));
  const y = mean(samples.map((s) => s.y));
  return { x, y, magnitude: Math.hypot(x, y), noise: stdev(samples.map((s) => Math.hypot(s.x - x, s.y - y))), samples: samples.length };
}

export interface Circularity {
  /** Largest distance from centre in each 5-degree bin (72 bins); 0 for a bin never reached. */
  bins: number[];
  /** Mean absolute deviation from a perfect circle at full tilt, % of the radius, over the bins reached. */
  errorPct: number;
  /** Bins reached, of 72. */
  covered: number;
  /** % of the bins at (or past) the full radius: a square gate reads above 100 in the corners. */
  outerPct: number;
}

export const CIRCLE_BINS = 72;

/** Circularity from a spin of the stick at full tilt (CONTROLLERS.md §6.1). */
export function circularity(samples: readonly StickState[]): Circularity {
  const bins = new Array<number>(CIRCLE_BINS).fill(0);
  for (const s of samples) {
    const r = Math.hypot(s.x, s.y);
    if (r < 0.25) continue;
    const a = (Math.atan2(s.y, s.x) + 2 * Math.PI) % (2 * Math.PI);
    const i = Math.min(CIRCLE_BINS - 1, Math.floor((a / (2 * Math.PI)) * CIRCLE_BINS));
    bins[i] = Math.max(bins[i], r);
  }
  const reached = bins.filter((b) => b > 0);
  return {
    bins,
    errorPct: reached.length ? mean(reached.map((r) => Math.abs(r - 1))) * 100 : 0,
    covered: reached.length,
    outerPct: reached.length ? (reached.filter((r) => r >= 0.98).length / reached.length) * 100 : 0,
  };
}

export interface Deadzones {
  /** Smallest distance from centre the pad reported once the stick left centre (0..1). */
  inner: number;
  /** Whether the output jumped straight past a gap when it left centre (an anti-deadzone). */
  jumps: boolean;
  /** Distance where the output stops growing (0..1 of travel). */
  outer: number;
}

/** Deadzones from a slow push from the centre to the edge and back (samples in time order). */
export function deadzones(samples: readonly StickState[]): Deadzones | null {
  const r = samples.map((s) => Math.hypot(s.x, s.y));
  const moving = r.filter((v) => v > 0.002);
  if (moving.length < 5) return null;
  const inner = Math.min(...moving);
  const max = Math.max(...r);
  return { inner, jumps: inner > 0.08, outer: max };
}

export interface Resolution {
  /** Distinct raw values seen on each axis. */
  distinct: [number, number];
  /** log2 of that: the effective bits. */
  bits: [number, number];
}

/** Stick resolution from the raw values seen (move the stick slowly through its range). */
export function resolution(raw: readonly StickState[]): Resolution {
  const xs = new Set(raw.map((s) => s.x));
  const ys = new Set(raw.map((s) => s.y));
  return { distinct: [xs.size, ys.size], bits: [Math.log2(Math.max(1, xs.size)), Math.log2(Math.max(1, ys.size))] };
}

export interface TriggerStats {
  min: number;
  max: number;
  /** Distinct values seen. */
  steps: number;
  /** Bits the pad reports (8 or 10) by the largest raw value. */
  bits: number;
  /** Only rest and full were ever seen: a digital (hair) trigger. */
  hair: boolean;
}

export function triggerStats(raw: readonly number[], reportedBits?: number): TriggerStats | null {
  if (!raw.length) return null;
  const min = Math.min(...raw);
  const max = Math.max(...raw);
  const steps = new Set(raw).size;
  const bits = reportedBits ?? (max > 255 ? 10 : 8);
  return { min, max, steps, bits, hair: steps <= 2 && max > 0 };
}

/** Button presses that came back within `ms` of their release (chatter), per button. */
export function chatter(states: readonly PadState[], ms = 5): Record<string, number> {
  const out: Record<string, number> = {};
  const released: Record<string, number> = {};
  const was: Record<string, boolean> = {};
  for (const s of states) {
    for (const [b, down] of Object.entries(s.buttons)) {
      if (was[b] && !down) released[b] = s.t;
      if (!was[b] && down && released[b] !== undefined && s.t - released[b] < ms) out[b] = (out[b] ?? 0) + 1;
      was[b] = !!down;
    }
  }
  return out;
}

/** Gyro bias (mean at rest) and noise per axis, deg/s. */
export function gyroBias(samples: readonly (readonly [number, number, number])[]): { bias: [number, number, number]; noise: [number, number, number] } | null {
  if (samples.length < 10) return null;
  const axis = (i: number) => samples.map((s) => s[i]);
  return { bias: [mean(axis(0)), mean(axis(1)), mean(axis(2))], noise: [stdev(axis(0)), stdev(axis(1)), stdev(axis(2))] };
}

/** Whether a polling figure only shows how fast it was sampled (CONTROLLERS.md §6.3: XInput counts changes). */
export const sampleLimited = (hz: number, sampleHz: number | null) => sampleHz !== null && sampleHz > 0 && hz >= sampleHz / 2;
