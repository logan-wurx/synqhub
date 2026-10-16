// What a checkup "Fix it" asks for, and how that becomes a change on one device. A fix is an intent ("debounce of
// at least 8 ms") until the device's page has read the device: then it is resolved against what that device
// offers (its debounce list, its polling list, its rapid-trigger grid) into the same steps a hand-made change
// sends, through the same guarded session (backup first, read back). Pure: no device access here.
import { fmtMm, hzText } from "../feel/units.ts";
import type { KeyboardDevice, MouseDevice, Step } from "../feel/types.ts";

export type FixIntent =
  | { kind: "debounce"; atLeastMs: number }
  | { kind: "polling"; atMostHz: number }
  | { kind: "rtSensitivity"; atLeastMm: number };

export interface Resolved {
  steps: Step[];
  /** "Debounce 4 ms → 8 ms". */
  label: string;
}

export type Resolution = Resolved | { reason: string };

export const isResolved = (r: Resolution): r is Resolved => "steps" in r;

/** The intent in words, before the device is read: "Raise debounce to 8 ms or more". */
export function intentLabel(i: FixIntent): string {
  if (i.kind === "debounce") return `Raise debounce to ${i.atLeastMs} ms or more`;
  if (i.kind === "polling") return `Lower polling to ${hzText(i.atMostHz)}`;
  return `Raise rapid-trigger sensitivity to ${fmtMm(i.atLeastMm)} mm`;
}

/** The smallest value on a min/step grid that is at least `want` (inside the range); null above the range. */
export function ceilToGrid(want: number, min: number, max: number, step: number): number | null {
  if (want > max + 1e-9) return null;
  if (want <= min) return min;
  const n = Math.ceil((want - min) / step - 1e-9);
  const v = Math.round((min + n * step) * 1e6) / 1e6;
  return v > max + 1e-9 ? null : v;
}

export function resolveMouseFix(i: FixIntent, d: MouseDevice): Resolution {
  const now = d.now;
  if (i.kind === "debounce") {
    const opts = [...(d.target.debounce?.options ?? [])].sort((a, b) => a - b);
    if (!opts.length) return { reason: "This mouse has no debounce setting SYNQ can change." };
    const cur = now?.debounceMs ?? null;
    const pick = opts.find((o) => o >= i.atLeastMs && (cur === null || o > cur));
    if (pick === undefined) {
      const top = opts[opts.length - 1];
      return { reason: cur !== null && cur >= top ? `Debounce is already at its longest (${top} ms).` : `Its longest debounce, ${top} ms, is shorter than the bounces measured.` };
    }
    return { steps: [{ kind: "debounce", ms: pick }], label: cur === null ? `Debounce to ${pick} ms` : `Debounce ${cur} ms → ${pick} ms` };
  }
  if (i.kind === "polling") {
    const opts = [...(d.target.polling?.options ?? [])].sort((a, b) => a - b);
    if (!opts.length) return { reason: "This mouse's polling rate can't be set from SYNQ." };
    const cur = now?.pollingHz ?? null;
    if (cur !== null && cur <= i.atMostHz) return { reason: `Polling is already ${hzText(cur)}.` };
    const lower = opts.filter((o) => o <= i.atMostHz);
    if (!lower.length) return { reason: "This mouse has no slower rate to choose." };
    const pick = lower[lower.length - 1];
    return { steps: [{ kind: "polling", hz: pick }], label: cur === null ? `Polling to ${hzText(pick)}` : `Polling ${hzText(cur)} → ${hzText(pick)}` };
  }
  return { reason: "That fix is for keyboards." };
}

export function resolveKeyboardFix(i: FixIntent, d: KeyboardDevice): Resolution {
  if (i.kind !== "rtSensitivity") return { reason: "That fix is for mice." };
  const r = d.target.rtSensitivity;
  if (!r) return { reason: "This keyboard's rapid-trigger sensitivity can't be set from SYNQ." };
  const press = d.now?.rtPressMm ?? null;
  const release = d.now?.rtReleaseMm ?? press;
  const want = ceilToGrid(i.atLeastMm, r.min, r.max, r.step);
  if (want === null) return { reason: `Its least sensitive rapid trigger is ${fmtMm(r.max)} mm.` };
  const nextPress = Math.max(want, press ?? 0);
  const nextRelease = r.independent ? Math.max(want, release ?? 0) : nextPress;
  if (press !== null && nextPress === press && nextRelease === release) return { reason: `Rapid trigger is already ${fmtMm(press)} mm or coarser.` };
  const from = press === null ? "" : `${fmtMm(press)} mm → `;
  return { steps: [{ kind: "rtSensitivity", pressMm: nextPress, releaseMm: nextRelease }], label: `Rapid trigger ${from}${fmtMm(nextPress)} mm` };
}

const MOUSE_LABEL: Partial<Record<Step["kind"], string>> = { debounce: "Debounce", polling: "Polling rate", rtSensitivity: "Rapid trigger" };

/** A resolved fix as preview rows: the setting, what the device holds now and what it becomes. */
export function fixRows(steps: readonly Step[], now: { debounceMs?: number | null; pollingHz?: number | null; rtPressMm?: number | null } | null): { label: string; from: string; to: string }[] {
  const rows: { label: string; from: string; to: string }[] = [];
  for (const s of steps) {
    const label = MOUSE_LABEL[s.kind] ?? s.kind;
    if (s.kind === "debounce") rows.push({ label, from: now?.debounceMs != null ? `${now.debounceMs} ms` : "—", to: `${s.ms} ms` });
    else if (s.kind === "polling") rows.push({ label, from: now?.pollingHz != null ? hzText(now.pollingHz) : "—", to: hzText(s.hz) });
    else if (s.kind === "rtSensitivity") rows.push({ label, from: now?.rtPressMm != null ? `${fmtMm(now.rtPressMm)} mm` : "—", to: `${fmtMm(s.pressMm)} mm` });
  }
  return rows;
}
