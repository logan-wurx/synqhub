// Maps a saved keyboard feel onto what another keyboard can take: its actuation range and step (0.1 mm or
// 0.01 mm), whether it has rapid trigger and one sensitivity or separate press and release distances, and the
// SOCD pairs it supports. Pure: a feel and a device description in, a plan out. Nothing talks to a device.
import { fmtMm, fmtNum, snap } from "./units.ts";
import type { Difference, KeyboardDevice, KeyboardFeel, Plan, Range, Row, SettingId, SocdMode, SocdPairFeel, Step } from "./types.ts";

const UNAVAILABLE = "Not available on this device";
const MM_EPS = 1e-6;

export const SOCD_LABEL: Record<SocdMode, string> = {
  last: "last input wins",
  neutral: "both cancel",
  priorityA: "first key wins",
  priorityB: "second key wins",
  first: "first input wins",
  deeper: "deeper press wins",
  deeperSingle: "deeper press wins",
};

const mmText = (mm: number) => `${fmtMm(mm)} mm`;
const onOff = (b: boolean) => (b ? "On" : "Off");

function rangeText(r: Range): string {
  return `${fmtMm(r.min)} to ${fmtMm(r.max)} mm in steps of ${fmtNum(r.step)}`;
}

/** A pair as the person reads it: "A + D, last input wins". */
export const socdText = (p: SocdPairFeel): string => `${p.a} + ${p.b}, ${SOCD_LABEL[p.mode]}`;

const canonical = (name: string) => name.trim().toLowerCase();
const samePair = (x: SocdPairFeel, y: SocdPairFeel) => (canonical(x.a) === canonical(y.a) && canonical(x.b) === canonical(y.b)) || (canonical(x.a) === canonical(y.b) && canonical(x.b) === canonical(y.a));

/** A distance on this keyboard's grid, and how it came out. */
function onGrid(mm: number, r: Range): { mm: number; adjusted: boolean } {
  const out = snap(mm, r.min, r.max, r.step);
  return { mm: out, adjusted: Math.abs(out - mm) > MM_EPS };
}

function whyAdjusted(mm: number, got: number, r: Range): string {
  if (mm < r.min - MM_EPS || mm > r.max + MM_EPS) return `${mmText(mm)} is outside what this keyboard allows (${rangeText(r)}), so it becomes ${mmText(got)}.`;
  return `This keyboard works in steps of ${fmtNum(r.step)} mm, so ${mmText(mm)} becomes ${mmText(got)}.`;
}

export function mapKeyboard(feel: KeyboardFeel, device: KeyboardDevice): Plan {
  const { target, now } = device;
  const steps: Step[] = [];
  const rows: Row[] = [];
  const differences: Difference[] = [];
  const unavailable = (id: SettingId, label: string, from: string, reason: string) => {
    rows.push({ id, label, from, to: null, status: "unavailable", note: UNAVAILABLE });
    differences.push({ setting: id, label, kind: "unavailable", wanted: from, got: null, reason });
  };

  // --- actuation point ---
  if (feel.actuationMm !== null) {
    if (target.actuation) {
      const { mm, adjusted } = onGrid(feel.actuationMm, target.actuation);
      const same = now?.actuationMm != null && Math.abs(now.actuationMm - mm) < MM_EPS;
      if (!same) steps.push({ kind: "actuation", mm });
      rows.push({
        id: "actuation",
        label: "Actuation point",
        from: mmText(feel.actuationMm),
        to: mmText(mm),
        now: now?.actuationMm != null && !same ? mmText(now.actuationMm) : undefined,
        status: same ? "same" : adjusted ? "adjusted" : "exact",
        note: adjusted ? whyAdjusted(feel.actuationMm, mm, target.actuation) : undefined,
      });
      if (adjusted) differences.push({ setting: "actuation", label: "Actuation point", kind: "adjusted", wanted: mmText(feel.actuationMm), got: mmText(mm), reason: whyAdjusted(feel.actuationMm, mm, target.actuation) });
    } else unavailable("actuation", "Actuation point", mmText(feel.actuationMm), "This keyboard has a fixed actuation point.");
  }

  // --- rapid trigger distances ---
  const wantPress = feel.rtPressMm ?? feel.rtReleaseMm;
  const wantRelease = feel.rtReleaseMm ?? feel.rtPressMm;
  if (wantPress !== null && wantRelease !== null) {
    const from = Math.abs(wantPress - wantRelease) < MM_EPS ? mmText(wantPress) : `${fmtMm(wantPress)} / ${fmtMm(wantRelease)} mm`;
    const label = "Rapid trigger sensitivity";
    if (target.rtSensitivity) {
      const r = target.rtSensitivity;
      const press = onGrid(wantPress, r);
      const release = r.independent ? onGrid(wantRelease, r) : { mm: press.mm, adjusted: false };
      // One sensitivity for both directions: the press distance is the one kept.
      const merged = !r.independent && Math.abs(wantPress - wantRelease) > MM_EPS;
      const adjusted = press.adjusted || release.adjusted || merged;
      const to = Math.abs(press.mm - release.mm) < MM_EPS ? mmText(press.mm) : `${fmtMm(press.mm)} / ${fmtMm(release.mm)} mm`;
      const same =
        now?.rtPressMm != null && now.rtReleaseMm != null && Math.abs(now.rtPressMm - press.mm) < MM_EPS && Math.abs(now.rtReleaseMm - release.mm) < MM_EPS;
      if (!same) steps.push({ kind: "rtSensitivity", pressMm: press.mm, releaseMm: release.mm });
      const note = merged
        ? `This keyboard has one rapid-trigger sensitivity, so the press distance (${mmText(press.mm)}) is used for release too.`
        : press.adjusted
          ? whyAdjusted(wantPress, press.mm, r)
          : release.adjusted
            ? whyAdjusted(wantRelease, release.mm, r)
            : undefined;
      rows.push({
        id: "rtSensitivity",
        label,
        from,
        to,
        now:
          now?.rtPressMm != null && now.rtReleaseMm != null && !same
            ? Math.abs(now.rtPressMm - now.rtReleaseMm) < MM_EPS
              ? mmText(now.rtPressMm)
              : `${fmtMm(now.rtPressMm)} / ${fmtMm(now.rtReleaseMm)} mm`
            : undefined,
        status: same ? "same" : adjusted ? "adjusted" : "exact",
        note,
      });
      if (adjusted && note) differences.push({ setting: "rtSensitivity", label, kind: "adjusted", wanted: from, got: to, reason: note });
    } else unavailable("rtSensitivity", label, from, "This keyboard has no adjustable rapid-trigger sensitivity.");
  }

  // --- rapid trigger on / off ---
  if (feel.rapidTrigger !== null) {
    if (target.rapidTrigger) {
      const same = now?.rapidTrigger === feel.rapidTrigger;
      if (!same) steps.push({ kind: "rapidTrigger", on: feel.rapidTrigger });
      rows.push({
        id: "rapidTrigger",
        label: "Rapid trigger",
        from: onOff(feel.rapidTrigger),
        to: onOff(feel.rapidTrigger),
        now: now?.rapidTrigger != null && !same ? onOff(now.rapidTrigger) : undefined,
        status: same ? "same" : "exact",
      });
    } else unavailable("rapidTrigger", "Rapid trigger", onOff(feel.rapidTrigger), "This keyboard has no rapid trigger.");
  }

  // --- SOCD pairs ---
  if (feel.socd && feel.socd.length) {
    const label = "SOCD pairs";
    const from = feel.socd.map(socdText).join("; ");
    if (!target.socd) {
      unavailable("socd", label, from, "This keyboard doesn't have SOCD pairs, or SYNQ can't set them on it.");
    } else {
      const t = target.socd;
      const have = new Set(t.keys.map(canonical));
      const carried: SocdPairFeel[] = [];
      const skipped: { pair: SocdPairFeel; why: string }[] = [];
      let room = t.maxPairs === null ? Infinity : t.maxPairs - t.existing.length;
      for (const p of feel.socd) {
        if (t.existing.some((e) => samePair(e, p) && e.mode === p.mode)) {
          carried.push(p);
          continue;
        }
        if (!have.has(canonical(p.a)) || !have.has(canonical(p.b))) skipped.push({ pair: p, why: `${!have.has(canonical(p.a)) ? p.a : p.b} isn't a key SYNQ can find on this keyboard.` });
        else if (!t.modes.includes(p.mode)) skipped.push({ pair: p, why: `This keyboard can't do "${SOCD_LABEL[p.mode]}".` });
        else if (room < 1) skipped.push({ pair: p, why: "All the SOCD pair slots on this keyboard are used." });
        else {
          room--;
          carried.push(p);
        }
      }
      const add = carried.filter((p) => !t.existing.some((e) => samePair(e, p) && e.mode === p.mode));
      if (add.length) steps.push({ kind: "socd", pairs: add });
      const same = add.length === 0 && skipped.length === 0;
      rows.push({
        id: "socd",
        label,
        from,
        to: carried.length ? carried.map(socdText).join("; ") : null,
        status: same ? "same" : skipped.length ? (carried.length ? "adjusted" : "unavailable") : "exact",
        note: skipped.length ? (carried.length ? "Some pairs can't be carried over." : UNAVAILABLE) : undefined,
      });
      for (const s of skipped) differences.push({ setting: "socd", label, kind: "unavailable", wanted: socdText(s.pair), got: null, reason: s.why });
    }
  }

  return { steps, rows, differences, sens: null, nothingToDo: steps.length === 0 };
}
