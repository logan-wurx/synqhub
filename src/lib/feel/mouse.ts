// Maps a saved mouse feel onto what another mouse can take: its own DPI steps and range, the polling rates
// it offers, its lift-off scale, its debounce list and the toggles it has. Pure: a feel and a device
// description in, a plan out (the steps to run, the preview rows, the differences, the sensitivity to use).
// Nothing here talks to a device.
import { clamp, clean, fmtMm, fmtNum, hzText, nearest } from "./units.ts";
import { sensAdvice } from "./sens.ts";
import type { DpiCaps, Difference, GameSens, LodFeel, LodLevel, MouseDevice, MouseFeel, MouseNow, MouseTarget, Plan, Row, SettingId, Step } from "./types.ts";

/** Where the three lift-off levels sit on a 0..1 scale, to cross between millimetres and levels. */
const LEVEL_T: Record<LodLevel, number> = { Low: 0, Medium: 0.5, High: 1 };
/** The range lift-off is placed on when a mouse reported millimetres without its own range (ATK's: 0.7-1.7). */
export const REFERENCE_LOD_MM = { min: 0.7, max: 1.7 } as const;

const dpiText = (n: number) => `${fmtNum(n)} DPI`;
const stagesText = (values: readonly number[], active: number) => values.map((v, i) => (i === active ? `${fmtNum(v)}*` : fmtNum(v))).join(" / ");
const lodText = (l: LodFeel) => (l.kind === "mm" ? `${fmtMm(l.mm)} mm` : l.level);
const onOff = (b: boolean) => (b ? "On" : "Off");

// ---------------------------------------------------------------------------------------------
// DPI
// ---------------------------------------------------------------------------------------------

/** The grid points on either side of `want`, for a range that starts at `min` and moves in `step`s. */
function gridAround(want: number, min: number, max: number, step: number): number[] {
  if (!(step > 0)) return [clamp(want, min, max)];
  const top = clean(min + Math.floor((max - min) / step + 1e-9) * step);
  const n = (clamp(want, min, top) - min) / step;
  const lo = clean(min + Math.floor(n + 1e-9) * step);
  const hi = Math.min(clean(min + Math.ceil(n - 1e-9) * step), top);
  return lo === hi ? [lo] : [lo, hi];
}

/** The DPI this mouse offers closest to `want`: from its fixed list, or the nearest step inside its range. */
export function nearestDpi(want: number, caps: DpiCaps): number {
  const list = (caps.options ?? []).filter((o) => Number.isFinite(o) && o > 0);
  if (list.length) return nearest(want, list, "log", "up")!;
  return nearest(want, gridAround(want, caps.min, caps.max, caps.step), "log", "up")!;
}

function describeDpi(caps: DpiCaps): string {
  const list = caps.options ?? [];
  if (list.length) return `it offers ${list.map(fmtNum).join(", ")}`;
  return `it goes ${fmtNum(caps.min)} to ${fmtNum(caps.max)} in steps of ${fmtNum(caps.step)}`;
}

interface StagePlan {
  values: number[];
  active: number;
  /** How many of the feel's steps were left out. */
  dropped: number;
  /** The feel's steps that made it, by index. */
  kept: number[];
}

/**
 * The feel's steps on this mouse: each to the nearest DPI it has, as many as it holds (the one in use is
 * always kept, the rest are dropped from the end), or exactly its fixed count when it can't change it.
 */
export function mapStages(feel: Pick<MouseFeel, "stages" | "active">, caps: DpiCaps, stages: NonNullable<MouseTarget["stages"]>, current: readonly number[] | null): StagePlan {
  const mapped = feel.stages.map((s) => nearestDpi(s, caps));
  const room = stages.fixedCount ?? Math.max(1, stages.max);
  let keep = mapped.map((_, i) => i);
  if (mapped.length > room) {
    // Keep the active step; drop the others from the end until it fits.
    const drop = new Set<number>();
    for (let i = mapped.length - 1; i >= 0 && mapped.length - drop.size > room; i--) if (i !== feel.active) drop.add(i);
    keep = keep.filter((i) => !drop.has(i));
  }
  const values = keep.map((i) => mapped[i]);
  const active = Math.max(0, keep.indexOf(feel.active));
  // A mouse with a fixed number of steps keeps the ones the feel doesn't reach.
  if (stages.fixedCount !== null) {
    for (let i = values.length; i < stages.fixedCount; i++) values.push(current?.[i] ?? values[values.length - 1]);
  }
  return { values, active, dropped: mapped.length - keep.length, kept: keep };
}

// ---------------------------------------------------------------------------------------------
// Lift-off
// ---------------------------------------------------------------------------------------------

/** Where a lift-off sits between a mouse's shortest (0) and longest (1) setting. */
export function lodPosition(l: LodFeel): number {
  if (l.kind === "level") return LEVEL_T[l.level];
  const lo = l.min ?? REFERENCE_LOD_MM.min;
  const hi = l.max ?? REFERENCE_LOD_MM.max;
  return hi > lo ? clamp((l.mm - lo) / (hi - lo), 0, 1) : 0;
}

/** The level closest to a position, among the ones this mouse has. */
function levelAt(t: number, levels: readonly LodLevel[]): LodLevel | null {
  const pick = nearest(t, levels.map((l) => LEVEL_T[l]), "linear", "down");
  return pick === null ? null : (levels.find((l) => LEVEL_T[l] === pick) ?? null);
}

interface LodResult {
  step: Step & { kind: "lod" };
  to: string;
  status: Row["status"];
  note?: string;
}

function mapLod(feel: LodFeel, target: NonNullable<MouseTarget["lod"]>): LodResult | null {
  if (target.kind === "mm") {
    const grid = gridAround(feel.kind === "mm" ? feel.mm : target.min + lodPosition(feel) * (target.max - target.min), target.min, target.max, target.step);
    if (feel.kind === "mm") {
      const mm = nearest(feel.mm, grid, "linear", "down")!;
      return { step: { kind: "lod", mm }, to: `${fmtMm(mm)} mm`, status: Math.abs(mm - feel.mm) < 1e-9 ? "exact" : "adjusted" };
    }
    const t = lodPosition(feel);
    const mm = nearest(target.min + t * (target.max - target.min), grid, "linear", "down")!;
    const where = feel.level === "Low" ? "shortest" : feel.level === "High" ? "longest" : "middle";
    return { step: { kind: "lod", mm }, to: `${fmtMm(mm)} mm`, status: "approximate", note: `${feel.level} is the ${where} setting here, ${fmtMm(mm)} mm.` };
  }
  const level = levelAt(lodPosition(feel), target.levels);
  if (!level) return null;
  if (feel.kind === "level") {
    return { step: { kind: "lod", level }, to: level, status: level === feel.level ? "exact" : "adjusted", note: level === feel.level ? undefined : `${feel.level} isn't offered; ${level} is the closest.` };
  }
  return { step: { kind: "lod", level }, to: level, status: "approximate", note: `${fmtMm(feel.mm)} mm sits closest to ${level} among this mouse's lift-off levels (${target.levels.join(", ")}).` };
}

const sameLod = (a: LodFeel | null, b: { mm: number } | { level: LodLevel }): boolean => {
  if (!a) return false;
  if (a.kind === "mm") return "mm" in b && Math.abs(a.mm - b.mm) < 1e-9;
  return "level" in b && a.level === b.level;
};

// ---------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------

const UNAVAILABLE = "Not available on this device";

function unavailableRow(id: SettingId, label: string, from: string): Row {
  return { id, label, from, to: null, status: "unavailable", note: UNAVAILABLE };
}

/**
 * What it takes to give `device` this feel. Every setting the feel holds gets a row; a setting the device
 * can't do is reported as not available; steps that would write what the device already holds are left out.
 * `sens` is the person's in-game sens, to say what to use when the DPI had to change.
 */
export function mapMouse(feel: MouseFeel, device: MouseDevice, sens: GameSens = { cs2: null, valorant: null }): Plan {
  const { target } = device;
  const now: MouseNow | null = device.now;
  const steps: Step[] = [];
  const rows: Row[] = [];
  const differences: Difference[] = [];
  const diff = (d: Difference) => differences.push(d);

  const active = clamp(Math.trunc(feel.active) || 0, 0, Math.max(0, feel.stages.length - 1));
  /** The DPI the device runs now, when it has said. */
  const nowDpi = now && now.stages.length ? now.stages[clamp(now.active, 0, now.stages.length - 1)] : undefined;
  const wantDpi = feel.stages[active];
  let plannedDpi: number | null = null;

  // --- DPI and DPI steps ---
  if (feel.stages.length && target.dpi) {
    const caps = target.dpi;
    if (target.stages) {
      const plan = mapStages({ stages: feel.stages, active }, caps, target.stages, now?.stages ?? null);
      plannedDpi = plan.values[plan.active];
      const same = !!now && now.active === plan.active && now.stages.length === plan.values.length && now.stages.every((v, i) => v === plan.values[i]);
      if (!same) steps.push({ kind: "stages", values: plan.values, active: plan.active });

      const adjustedDpi = plannedDpi !== wantDpi;
      rows.push({
        id: "dpi",
        label: "DPI",
        from: dpiText(wantDpi),
        to: dpiText(plannedDpi),
        now: nowDpi !== undefined && nowDpi !== plannedDpi ? dpiText(nowDpi) : undefined,
        status: same ? "same" : adjustedDpi ? "adjusted" : "exact",
        note: adjustedDpi ? `${plannedDpi} is the closest DPI this mouse offers.` : undefined,
      });
      if (feel.stages.length > 1 || plan.values.length > 1) {
        const exact = plan.values.length === feel.stages.length && plan.values.every((v, i) => v === feel.stages[i]) && plan.active === active;
        rows.push({
          id: "stages",
          label: "DPI steps",
          from: stagesText(feel.stages, active),
          to: stagesText(plan.values, plan.active),
          now: now && !same ? stagesText(now.stages, now.active) : undefined,
          status: same ? "same" : exact ? "exact" : "adjusted",
        });
      }
      const moved = plan.kept.map((i) => [feel.stages[i], nearestDpi(feel.stages[i], caps)] as const).filter(([a, b]) => a !== b);
      if (adjustedDpi) {
        diff({ setting: "dpi", label: "DPI", kind: "adjusted", wanted: dpiText(wantDpi), got: dpiText(plannedDpi), reason: `${wantDpi} DPI isn't offered here (${describeDpi(caps)}), so it becomes ${plannedDpi}.` });
      }
      // The other steps that moved, in one line (the one in use is reported above).
      const others = moved.filter(([a]) => !(a === wantDpi && adjustedDpi));
      if (others.length) {
        const parts = others.map(([a, b]) => `${fmtNum(a)} becomes ${fmtNum(b)}`);
        diff({
          setting: "stages",
          label: others.length === 1 ? "DPI step" : "DPI steps",
          kind: "adjusted",
          wanted: others.map(([a]) => fmtNum(a)).join(" / "),
          got: others.map(([, b]) => fmtNum(b)).join(" / "),
          reason: `This mouse isn't offering those DPIs (${describeDpi(caps)}): ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]}.`,
        });
      }
      if (plan.dropped > 0) {
        diff({
          setting: "stages",
          label: "DPI steps",
          kind: "dropped",
          wanted: `${feel.stages.length} steps`,
          got: `${plan.values.length} steps`,
          reason: `This mouse holds ${plan.values.length} DPI ${plan.values.length === 1 ? "step" : "steps"}, so ${plan.dropped} of yours ${plan.dropped === 1 ? "isn't" : "aren't"} carried over. The one you play on is kept.`,
        });
      }
    } else {
      // One DPI and no steps: only the one in use can be set.
      plannedDpi = nearestDpi(wantDpi, caps);
      const same = nowDpi === plannedDpi;
      if (!same) steps.push({ kind: "dpi", dpi: plannedDpi });
      const adjustedDpi = plannedDpi !== wantDpi;
      rows.push({
        id: "dpi",
        label: "DPI",
        from: dpiText(wantDpi),
        to: dpiText(plannedDpi),
        now: nowDpi !== undefined && !same ? dpiText(nowDpi) : undefined,
        status: same ? "same" : adjustedDpi ? "adjusted" : "exact",
        note: adjustedDpi ? `${plannedDpi} is the closest DPI this mouse offers.` : undefined,
      });
      if (adjustedDpi) diff({ setting: "dpi", label: "DPI", kind: "adjusted", wanted: dpiText(wantDpi), got: dpiText(plannedDpi), reason: `${wantDpi} DPI isn't offered here (${describeDpi(caps)}), so it becomes ${plannedDpi}.` });
      if (feel.stages.length > 1) {
        rows.push({ id: "stages", label: "DPI steps", from: stagesText(feel.stages, active), to: null, status: "unavailable", note: "This mouse has one DPI, not steps" });
        diff({ setting: "stages", label: "DPI steps", kind: "dropped", wanted: `${feel.stages.length} steps`, got: null, reason: "This mouse has one DPI and no steps, so only the one you play on is carried over." });
      }
    }
  } else if (feel.stages.length) {
    rows.push(unavailableRow("dpi", "DPI", dpiText(wantDpi)));
    diff({ setting: "dpi", label: "DPI", kind: "unavailable", wanted: dpiText(wantDpi), got: null, reason: "This mouse's DPI can't be set from here." });
  }

  // --- polling ---
  if (feel.pollingHz !== null) {
    const opts = target.polling?.options ?? [];
    if (opts.length) {
      const hz = nearest(feel.pollingHz, opts, "log", "up")!;
      const same = now?.pollingHz === hz;
      if (!same) steps.push({ kind: "polling", hz });
      const adjusted = hz !== feel.pollingHz;
      rows.push({
        id: "polling",
        label: "Polling rate",
        from: hzText(feel.pollingHz),
        to: hzText(hz),
        now: now?.pollingHz != null && !same ? hzText(now.pollingHz) : undefined,
        status: same ? "same" : adjusted ? "adjusted" : "exact",
        note: adjusted ? `${hzText(feel.pollingHz)} isn't offered; ${hzText(hz)} is the closest.` : undefined,
      });
      if (adjusted) {
        diff({
          setting: "polling",
          label: "Polling rate",
          kind: "adjusted",
          wanted: hzText(feel.pollingHz),
          got: hzText(hz),
          reason: `This mouse offers ${opts.map(hzText).join(", ")}, so ${hzText(feel.pollingHz)} becomes ${hzText(hz)}.`,
        });
      }
    } else {
      rows.push(unavailableRow("polling", "Polling rate", hzText(feel.pollingHz)));
      diff({ setting: "polling", label: "Polling rate", kind: "unavailable", wanted: hzText(feel.pollingHz), got: null, reason: "The polling rate isn't available on this device." });
    }
  }

  // --- lift-off ---
  if (feel.lod) {
    const r = target.lod ? mapLod(feel.lod, target.lod) : null;
    if (r) {
      const same = sameLod(now?.lod ?? null, r.step);
      if (!same) steps.push(r.step);
      rows.push({
        id: "lod",
        label: "Lift-off",
        from: lodText(feel.lod),
        to: r.to,
        now: now?.lod && !same ? lodText(now.lod) : undefined,
        status: same ? "same" : r.status,
        note: r.note,
      });
      if (r.status === "adjusted" || r.status === "approximate") {
        diff({
          setting: "lod",
          label: "Lift-off",
          kind: r.status,
          wanted: lodText(feel.lod),
          got: r.to,
          reason: r.note ?? `Lift-off is ${r.to} here.`,
        });
      }
    } else {
      rows.push(unavailableRow("lod", "Lift-off", lodText(feel.lod)));
      diff({ setting: "lod", label: "Lift-off", kind: "unavailable", wanted: lodText(feel.lod), got: null, reason: "Lift-off distance can't be set on this device." });
    }
  }

  // --- debounce ---
  if (feel.debounceMs !== null) {
    const opts = target.debounce?.options ?? [];
    if (opts.length) {
      const ms = nearest(feel.debounceMs, opts, "linear", "down")!;
      const same = now?.debounceMs === ms;
      if (!same) steps.push({ kind: "debounce", ms });
      const adjusted = ms !== feel.debounceMs;
      rows.push({
        id: "debounce",
        label: "Debounce",
        from: `${fmtNum(feel.debounceMs)} ms`,
        to: `${fmtNum(ms)} ms`,
        now: now?.debounceMs != null && !same ? `${fmtNum(now.debounceMs)} ms` : undefined,
        status: same ? "same" : adjusted ? "adjusted" : "exact",
        note: adjusted ? `${feel.debounceMs} ms isn't offered; ${ms} ms is the closest.` : undefined,
      });
      if (adjusted) {
        diff({ setting: "debounce", label: "Debounce", kind: "adjusted", wanted: `${fmtNum(feel.debounceMs)} ms`, got: `${fmtNum(ms)} ms`, reason: `This mouse offers ${opts.map(fmtNum).join(", ")} ms, so ${feel.debounceMs} ms becomes ${ms} ms.` });
      }
    } else {
      rows.push(unavailableRow("debounce", "Debounce", `${fmtNum(feel.debounceMs)} ms`));
      diff({ setting: "debounce", label: "Debounce", kind: "unavailable", wanted: `${fmtNum(feel.debounceMs)} ms`, got: null, reason: "Debounce time can't be set on this device." });
    }
  }

  // --- angle snapping, motion sync, ripple ---
  const toggles: { id: SettingId; setting: "angleSnapping" | "motionSync" | "rippleControl"; key: "angleSnapping" | "motionSync" | "ripple"; label: string }[] = [
    { id: "angleSnapping", setting: "angleSnapping", key: "angleSnapping", label: "Angle snapping" },
    { id: "motionSync", setting: "motionSync", key: "motionSync", label: "Motion sync" },
    { id: "ripple", setting: "rippleControl", key: "ripple", label: "Ripple control" },
  ];
  for (const t of toggles) {
    const want = feel[t.key];
    if (want === null) continue;
    if (!target.toggles[t.key]) {
      rows.push(unavailableRow(t.id, t.label, onOff(want)));
      diff({ setting: t.id, label: t.label, kind: "unavailable", wanted: onOff(want), got: null, reason: `${t.label} isn't available on this device.` });
      continue;
    }
    const cur = now?.[t.key] ?? null;
    const same = cur === want;
    if (!same) steps.push({ kind: "toggle", setting: t.setting, on: want });
    rows.push({ id: t.id, label: t.label, from: onOff(want), to: onOff(want), now: cur !== null && !same ? onOff(cur) : undefined, status: same ? "same" : "exact" });
  }

  return {
    steps,
    rows,
    differences,
    sens: plannedDpi === null ? null : sensAdvice(wantDpi, plannedDpi, sens),
    nothingToDo: steps.length === 0,
  };
}
