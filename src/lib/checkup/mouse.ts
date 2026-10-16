// The mouse half of the checkup: button bounce from press timings, and polling, dropouts and sensor jumps from
// the motion reports of a few fast circles. Pure functions over recorded events; no DOM, no device access.
import { CLICKS, MOTION, REST } from "./thresholds.ts";
import type { ButtonEvent, MotionReport } from "./types.ts";

const byTime = <T extends { t: number }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => a.t - b.t);
const median = (xs: readonly number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const size = (r: MotionReport) => Math.hypot(r.dx, r.dy);

/** The polling rates mice are sold with. */
export const STANDARD_HZ = [125, 250, 500, 1000, 2000, 4000, 8000] as const;

/** The standard rate nearest to a measured one (on a log scale: 1500 is as far from 1000 as 2250 is from 1500). */
export function nominalHz(hz: number): number {
  let best: number = STANDARD_HZ[0];
  for (const s of STANDARD_HZ) if (Math.abs(Math.log(s / hz)) < Math.abs(Math.log(best / hz))) best = s;
  return best;
}

export interface ClickStats {
  presses: number;
  /** Presses that came back within CLICKS.chatterGapMs of the release before them. */
  bounces: number;
  /** The release-to-press gap of each bounce (ms). */
  gaps: number[];
  /** Median time from one press to the next (ms), for "your pace". */
  paceMs: number | null;
}

/** Presses of one button and how many of them were the switch bouncing. */
export function clickStats(events: readonly ButtonEvent[], button: number): ClickStats {
  let lastUp: number | null = null;
  let lastDown: number | null = null;
  let presses = 0;
  const gaps: number[] = [];
  const pace: number[] = [];
  let isDown = false;
  for (const e of byTime(events)) {
    if (e.button !== button) continue;
    if (e.down) {
      // A second "down" with no "up" between is the same press reported twice.
      if (isDown) continue;
      isDown = true;
      presses++;
      if (lastUp !== null && e.t - lastUp < CLICKS.chatterGapMs) gaps.push(Math.max(0, e.t - lastUp));
      else if (lastDown !== null) pace.push(e.t - lastDown);
      lastDown = e.t;
    } else if (isDown) {
      isDown = false;
      lastUp = e.t;
    }
  }
  return { presses, bounces: gaps.length, gaps, paceMs: pace.length ? median(pace) : null };
}

export interface MotionStats {
  reports: number;
  /** Time spent moving (pauses over MOTION.idleGapMs left out). */
  movingMs: number;
  /** Reports per second while the mouse moved fast enough to fill every poll; null when it never did. */
  hz: number | null;
  /** The standard rate that is closest to `hz`. */
  nominalHz: number | null;
  /** Silences of MOTION.dropoutMs or more in the middle of fast motion. */
  dropouts: number;
  longestDropMs: number;
  /** Share of the moving time lost to dropouts (%). */
  dropPct: number;
  /** How much the report count per time slice varies (coefficient of variation); null without enough slices. */
  unevenCv: number | null;
  /** Reports far bigger than their neighbours (the sensor skipping). */
  jumps: number;
}

/** Splits reports into stretches of motion: a pause longer than MOTION.idleGapMs ends one. */
function segments(reports: readonly MotionReport[]): MotionReport[][] {
  const out: MotionReport[][] = [];
  let cur: MotionReport[] = [];
  for (const r of reports) {
    if (cur.length && r.t - cur[cur.length - 1].t > MOTION.idleGapMs) {
      out.push(cur);
      cur = [];
    }
    cur.push(r);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Mean size of up to `n` reports before index `i` (exclusive) or from it onward. */
function sideSize(seg: readonly MotionReport[], i: number, n: number, before: boolean): number {
  const part = before ? seg.slice(Math.max(0, i - n), i) : seg.slice(i, i + n);
  return part.length ? mean(part.map(size)) : 0;
}

/**
 * Polling, dropouts, unevenness and sensor jumps from the motion of a few fast circles. Null with too few reports
 * to say anything.
 */
export function motionStats(input: readonly MotionReport[]): MotionStats | null {
  const reports = byTime(input).filter((r) => r.dx !== 0 || r.dy !== 0);
  if (reports.length < MOTION.minReports) return null;
  const segs = segments(reports);
  let movingMs = 0;
  const intervals: number[] = [];
  for (const seg of segs) {
    if (seg.length > 1) movingMs += seg[seg.length - 1].t - seg[0].t;
    for (let i = 1; i < seg.length; i++) intervals.push(seg[i].t - seg[i - 1].t);
  }
  const typical = median(intervals.filter((g) => g > 0));

  // Dropouts: a long silence with fast motion on both sides (a slow turn-around isn't one).
  let dropouts = 0;
  let dropMs = 0;
  let longestDropMs = 0;
  const afterDrop = new Set<MotionReport>();
  for (const seg of segs) {
    for (let i = 1; i < seg.length; i++) {
      const gap = seg[i].t - seg[i - 1].t;
      if (gap < MOTION.dropoutMs) continue;
      const fast = sideSize(seg, i, 5, true) >= MOTION.saturatedCounts && sideSize(seg, i, 5, false) >= MOTION.saturatedCounts;
      if (!fast) continue;
      dropouts++;
      dropMs += gap - typical;
      longestDropMs = Math.max(longestDropMs, gap);
      // A mouse sends what it gathered during a dropout in one report: that one isn't a sensor jump.
      for (let k = i; k < Math.min(seg.length, i + 3); k++) afterDrop.add(seg[k]);
    }
  }

  // The delivered rate, counted in slices where every poll has motion to report.
  const sliceMs = Math.max(MOTION.windowMs, 10 * typical);
  const counts: number[] = [];
  for (const seg of segs) {
    if (seg.length < 2) continue;
    const start = seg[0].t;
    const end = seg[seg.length - 1].t;
    let j = 0;
    for (let from = start; from + sliceMs <= end; from += sliceMs) {
      let n = 0;
      let sum = 0;
      while (j < seg.length && seg[j].t < from) j++;
      let k = j;
      while (k < seg.length && seg[k].t < from + sliceMs) {
        n++;
        sum += Math.abs(seg[k].dx) + Math.abs(seg[k].dy);
        k++;
      }
      if (n >= 2 && sum / n >= MOTION.saturatedCounts) counts.push(n);
    }
  }
  const hz = counts.length ? (median(counts) / sliceMs) * 1000 : null;
  const m = mean(counts);
  const unevenCv = counts.length >= 8 && m > 0 ? Math.sqrt(mean(counts.map((c) => (c - m) ** 2))) / m : null;

  // Sensor jumps: a report many times the size of its neighbours.
  let jumps = 0;
  for (const seg of segs) {
    for (let i = 0; i < seg.length; i++) {
      if (afterDrop.has(seg[i])) continue;
      const s = size(seg[i]);
      if (s < MOTION.jumpMinCounts) continue;
      const near = [...seg.slice(Math.max(0, i - MOTION.jumpSpan), i), ...seg.slice(i + 1, i + 1 + MOTION.jumpSpan)].map(size);
      if (near.length >= 4 && s >= MOTION.jumpFactor * Math.max(1, median(near))) jumps++;
    }
  }

  return {
    reports: reports.length,
    movingMs,
    hz,
    nominalHz: hz === null ? null : nominalHz(hz),
    dropouts,
    longestDropMs,
    dropPct: movingMs > 0 ? (Math.max(0, dropMs) / movingMs) * 100 : 0,
    unevenCv,
    jumps,
  };
}

export interface RestStats {
  reports: number;
  counts: number;
  /** The mouse moved while nobody was meant to touch it. */
  moved: boolean;
}

/** Motion during the hands-off step. */
export function restStats(reports: readonly MotionReport[]): RestStats {
  const moving = reports.filter((r) => r.dx !== 0 || r.dy !== 0);
  const counts = moving.reduce((a, r) => a + Math.abs(r.dx) + Math.abs(r.dy), 0);
  return { reports: moving.length, counts, moved: moving.length >= REST.mouseReports && counts > REST.mouseCounts };
}
