// "Keep your feel", the pure core (src/lib/feel): number helpers, the sensitivity calculator, and mapping a
// saved mouse or keyboard feel onto another device's own steps, ranges and scales. No device I/O, no React.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, decimalsOf, fmtMm, hzText, mmToUnits, nearest, snap, unitsToMm } from "../src/lib/feel/units.ts";
import { VALORANT_PER_CS2, calculate, convertSens, cs2FromValorant, edpi, roundSens, sensAdvice, valorantFromCs2 } from "../src/lib/feel/sens.ts";
import { REFERENCE_LOD_MM, lodPosition, mapMouse, mapStages, nearestDpi } from "../src/lib/feel/mouse.ts";
import { mapKeyboard } from "../src/lib/feel/keyboard.ts";
import type { KeyboardDevice, KeyboardFeel, MouseDevice, MouseFeel, MouseTarget, Plan } from "../src/lib/feel/types.ts";

const NO_SENS = { cs2: null, valorant: null };

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function feel(over: Partial<MouseFeel> = {}): MouseFeel {
  return { stages: [400, 800, 1600], active: 1, pollingHz: 1000, lod: { kind: "level", level: "Low" }, debounceMs: null, angleSnapping: null, motionSync: null, ripple: null, ...over };
}

function target(over: Partial<MouseTarget> = {}): MouseTarget {
  return {
    dpi: { min: 100, max: 26000, step: 50 },
    stages: { max: 5, fixedCount: null },
    polling: { options: [125, 250, 500, 1000, 2000, 4000, 8000] },
    lod: { kind: "levels", levels: ["Low", "Medium", "High"] },
    debounce: null,
    toggles: { angleSnapping: false, motionSync: false, ripple: false },
    ...over,
  };
}

const mouse = (t: Partial<MouseTarget> = {}, now: MouseFeel | null = null): MouseDevice => ({ target: target(t), now });
const row = (p: Plan, id: string) => p.rows.find((r) => r.id === id);

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

test("snap lands on the device's grid, inside its range, ties going up", () => {
  assert.equal(snap(1.25, 0.1, 4, 0.1), 1.3);
  assert.equal(snap(1.24, 0.1, 4, 0.1), 1.2);
  assert.equal(snap(1.25, 0.1, 4, 0.01), 1.25);
  assert.equal(snap(1.25, 0.05, 4, 0.05), 1.25);
  assert.equal(snap(0.03, 0.1, 4, 0.1), 0.1, "below the range");
  assert.equal(snap(9, 0.1, 4, 0.1), 4, "above the range");
  assert.equal(snap(3.97, 0.1, 3.95, 0.1), 3.9, "a maximum that is not on the grid is never passed");
  assert.equal(snap(0.30000000000000004, 0.1, 4, 0.1), 0.3, "no binary noise");
});

test("polling rates are worded the way the app words them", () => {
  assert.equal(hzText(125), "125 Hz");
  assert.equal(hzText(1000), "1 kHz");
  assert.equal(hzText(4000), "4 kHz");
  assert.equal(hzText(1500), "1.5 kHz");
});

test("decimals, clean and the two-way unit change", () => {
  assert.equal(decimalsOf(0.1), 1);
  assert.equal(decimalsOf(0.01), 2);
  assert.equal(decimalsOf(0.05), 2);
  assert.equal(decimalsOf(50), 0);
  assert.equal(clean(0.1 + 0.2), 0.3);
  assert.equal(mmToUnits(1.2, 0.1), 12);
  assert.equal(mmToUnits(1.25, 0.01), 125);
  assert.equal(mmToUnits(0.3, 0.1), 3, "0.3 / 0.1 is 2.9999999999999996 in floating point");
  assert.equal(unitsToMm(125, 0.01), 1.25);
  assert.equal(unitsToMm(12, 0.1), 1.2);
  assert.equal(fmtMm(2), "2.0");
  assert.equal(fmtMm(1.25), "1.25");
  assert.equal(fmtMm(0.30000000000000004), "0.3");
});

test("nearest compares ratios on the log scale and breaks ties toward the snappier side", () => {
  assert.equal(nearest(1000, [500, 2000], "log", "up"), 2000);
  assert.equal(nearest(1000, [500, 2000], "log", "down"), 500);
  assert.equal(nearest(3, [2, 4], "linear", "down"), 2);
  assert.equal(nearest(3, [2, 4], "linear", "up"), 4);
  assert.equal(nearest(1000, []), null);
  assert.equal(nearest(1000, [NaN, 800]), 800);
  // On the log scale 1000 is nearer 1600 (1.6x away) than 600 (1.67x away), though 600 is the smaller difference.
  assert.equal(nearest(1000, [600, 1600], "log"), 1600);
  assert.equal(nearest(1000, [600, 1600], "linear"), 600);
});

// ---------------------------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------------------------

test("new sens = old sens x old DPI / new DPI", () => {
  assert.ok(Math.abs(convertSens(0.55, 800, 1000) - 0.44) < 1e-12);
  assert.equal(convertSens(1, 1600, 800), 2);
  assert.ok(Number.isNaN(convertSens(0, 800, 800)));
  assert.ok(Number.isNaN(convertSens(1, -800, 800)));
  assert.ok(Number.isNaN(convertSens(1, 800, 0)));
  assert.ok(Number.isNaN(convertSens(NaN, 800, 800)));
});

test("Valorant is CS2 divided by 3.181818, and back", () => {
  assert.equal(VALORANT_PER_CS2, 3.181818);
  assert.equal(roundSens(valorantFromCs2(0.55)), 0.173);
  assert.equal(roundSens(cs2FromValorant(0.173)), 0.55);
  assert.equal(roundSens(valorantFromCs2(3.181818)), 1);
});

test("sens is rounded to three decimals, two from 10 up; eDPI to one", () => {
  assert.equal(roundSens(0.528846), 0.529);
  assert.equal(roundSens(12.3456), 12.35);
  assert.equal(roundSens(0.1), 0.1);
  assert.equal(edpi(800, 0.55), 440);
  assert.equal(edpi(1300, 0.529), 687.7);
});

test("advice from CS2 only works the Valorant sens out; from Valorant only, the CS2 one", () => {
  const a = sensAdvice(1250, 1300, { cs2: 0.55, valorant: null })!;
  assert.equal(a.exact, false);
  assert.equal(a.factor, 0.9615);
  assert.deepEqual(a.cs2, { old: 0.55, next: 0.529, oldEdpi: 687.5, newEdpi: 687.7, derived: false });
  assert.equal(a.valorant!.derived, true);
  assert.equal(a.valorant!.old, 0.173);
  assert.equal(a.valorant!.next, roundSens((valorantFromCs2(0.55) * 1250) / 1300));

  const v = sensAdvice(800, 1000, { cs2: null, valorant: 0.4 })!;
  assert.equal(v.valorant!.next, 0.32);
  assert.equal(v.valorant!.derived, false);
  assert.equal(v.cs2!.derived, true);
  assert.equal(v.cs2!.old, roundSens(0.4 * VALORANT_PER_CS2));
});

test("with both sens typed, each is converted as typed", () => {
  const a = sensAdvice(800, 400, { cs2: 1, valorant: 0.5 })!;
  assert.equal(a.cs2!.next, 2);
  assert.equal(a.valorant!.next, 1);
  assert.equal(a.cs2!.derived, false);
  assert.equal(a.valorant!.derived, false);
});

test("the same DPI keeps the sens; no sens typed still gives the factor", () => {
  const same = sensAdvice(800, 800, { cs2: 0.55, valorant: null })!;
  assert.equal(same.exact, true);
  assert.equal(same.cs2!.next, same.cs2!.old);
  assert.equal(same.cs2!.newEdpi, same.cs2!.oldEdpi);
  const none = sensAdvice(1600, 800, NO_SENS)!;
  assert.equal(none.factor, 2);
  assert.equal(none.cs2, null);
  assert.equal(none.valorant, null);
});

test("bad numbers give no advice", () => {
  assert.equal(sensAdvice(0, 800, NO_SENS), null);
  assert.equal(sensAdvice(800, NaN, NO_SENS), null);
  assert.equal(sensAdvice(-1, 800, NO_SENS), null);
  const z = sensAdvice(800, 1000, { cs2: 0, valorant: -2 })!;
  assert.equal(z.cs2, null, "a zero sens is not a sens");
  assert.equal(z.valorant, null);
});

test("the standalone calculator answers in both games", () => {
  const c = calculate({ game: "cs2", sens: 0.55, oldDpi: 800, newDpi: 1000 })!;
  assert.equal(c.cs2!.next, 0.44);
  assert.equal(c.cs2!.newEdpi, 440);
  assert.equal(c.valorant!.next, roundSens((valorantFromCs2(0.55) * 800) / 1000));
  const v = calculate({ game: "valorant", sens: 0.3, oldDpi: 1600, newDpi: 800 })!;
  assert.equal(v.valorant!.next, 0.6);
  assert.equal(v.cs2!.next, roundSens(cs2FromValorant(0.3) * 2));
});

// ---------------------------------------------------------------------------------------------
// DPI
// ---------------------------------------------------------------------------------------------

test("nearest DPI: on a step grid", () => {
  const caps = { min: 100, max: 16000, step: 50 };
  assert.equal(nearestDpi(800, caps), 800);
  assert.equal(nearestDpi(1230, caps), 1250);
  assert.equal(nearestDpi(1210, caps), 1200);
  assert.equal(nearestDpi(50, caps), 100, "below the range");
  assert.equal(nearestDpi(30000, caps), 16000, "above the range");
});

test("nearest DPI: the grid starts at the minimum and ends at the last step inside the range", () => {
  assert.equal(nearestDpi(1000, { min: 100, max: 1030, step: 100 }), 1000);
  assert.equal(nearestDpi(1100, { min: 100, max: 1030, step: 100 }), 1000, "1100 is past the last step the range holds");
  assert.equal(nearestDpi(1250, { min: 100, max: 26000, step: 100 }), 1300, "a step of 100 puts 1250 between 1200 and 1300; 1300 is the nearer ratio");
});

test("nearest DPI: from a fixed list", () => {
  const caps = { min: 400, max: 3200, step: 400, options: [400, 800, 1600, 3200] };
  assert.equal(nearestDpi(800, caps), 800);
  assert.equal(nearestDpi(1000, caps), 800);
  assert.equal(nearestDpi(1200, caps), 1600);
  assert.equal(nearestDpi(100, caps), 400);
  assert.equal(nearestDpi(9000, caps), 3200);
  assert.equal(nearestDpi(200, { min: 100, max: 400, step: 100, options: [100, 400] }), 400, "an exact tie goes to the higher DPI");
});

test("a DPI the target has comes through exact, with no sens change", () => {
  const p = mapMouse(feel({ stages: [400, 800, 1600], active: 1 }), mouse(), { cs2: 0.55, valorant: null });
  assert.deepEqual(p.steps[0], { kind: "stages", values: [400, 800, 1600], active: 1 });
  assert.equal(row(p, "dpi")!.status, "exact");
  assert.equal(row(p, "dpi")!.to, "800 DPI");
  assert.equal(p.sens!.exact, true);
  assert.equal(p.sens!.cs2!.next, 0.55);
  assert.equal(p.differences.filter((d) => d.setting === "dpi" || d.setting === "stages").length, 0);
});

test("a DPI the target can't reach becomes the nearest one, and the plan says what sens to use", () => {
  const p = mapMouse(feel({ stages: [800, 1250], active: 1 }), mouse({ dpi: { min: 100, max: 26000, step: 100 } }), { cs2: 0.55, valorant: null });
  assert.deepEqual(p.steps[0], { kind: "stages", values: [800, 1300], active: 1 });
  assert.equal(row(p, "dpi")!.status, "adjusted");
  assert.equal(row(p, "dpi")!.from, "1250 DPI");
  assert.equal(row(p, "dpi")!.to, "1300 DPI");
  const d = p.differences.find((x) => x.setting === "dpi")!;
  assert.equal(d.kind, "adjusted");
  assert.equal(d.wanted, "1250 DPI");
  assert.equal(d.got, "1300 DPI");
  assert.match(d.reason, /steps of 100/);
  assert.equal(p.sens!.exact, false);
  assert.equal(p.sens!.oldDpi, 1250);
  assert.equal(p.sens!.newDpi, 1300);
  assert.equal(p.sens!.cs2!.next, 0.529);
});

test("steps are carried to the nearest of a fixed list, each one reported", () => {
  const caps = { min: 400, max: 3200, step: 400, options: [400, 800, 1600, 3200] };
  const p = mapMouse(feel({ stages: [400, 1000, 2000], active: 2 }), mouse({ dpi: caps }), NO_SENS);
  assert.deepEqual(p.steps[0], { kind: "stages", values: [400, 800, 1600], active: 2 });
  assert.equal(p.differences.filter((d) => d.setting === "stages" && d.kind === "adjusted").length, 1, "1000 -> 800; the active one is reported once under DPI");
  assert.equal(p.differences.find((d) => d.setting === "dpi")!.got, "1600 DPI");
  assert.match(p.differences.find((d) => d.setting === "stages")!.reason, /1000 becomes 800\./);
  // Several steps that moved are one difference, in one sentence.
  const many = mapMouse(feel({ stages: [400, 1000, 1200, 2000], active: 0 }), mouse({ dpi: caps }), NO_SENS);
  const diffs = many.differences.filter((d) => d.setting === "stages");
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].label, "DPI steps");
  assert.equal(diffs[0].wanted, "1000 / 1200 / 2000");
  assert.equal(diffs[0].got, "800 / 1600 / 1600");
  assert.match(diffs[0].reason, /1000 becomes 800, 1200 becomes 1600 and 2000 becomes 1600\./);
});

test("a mouse that holds fewer steps keeps the active one and drops from the end", () => {
  const m = mapStages({ stages: [400, 800, 1200, 1600, 3200], active: 3 }, { min: 100, max: 26000, step: 50 }, { max: 3, fixedCount: null }, null);
  assert.deepEqual(m.values, [400, 800, 1600]);
  assert.equal(m.active, 2);
  assert.equal(m.dropped, 2);
  assert.deepEqual(m.kept, [0, 1, 3]);
  const low = mapStages({ stages: [400, 800, 1200], active: 0 }, { min: 100, max: 26000, step: 50 }, { max: 2, fixedCount: null }, null);
  assert.deepEqual(low.values, [400, 800]);
  assert.equal(low.active, 0);
  const p = mapMouse(feel({ stages: [400, 800, 1200, 1600, 3200], active: 3 }), mouse({ stages: { max: 3, fixedCount: null } }), NO_SENS);
  const dropped = p.differences.find((d) => d.kind === "dropped")!;
  assert.match(dropped.reason, /holds 3 DPI steps, so 2 of yours aren't carried over/);
});

test("a mouse with a fixed number of steps keeps the ones the feel doesn't reach", () => {
  const now = feel({ stages: [400, 800, 1600, 3200], active: 0 });
  const p = mapMouse(feel({ stages: [500, 1000], active: 1 }), mouse({ stages: { max: 4, fixedCount: 4 } }, now), NO_SENS);
  assert.deepEqual(p.steps[0], { kind: "stages", values: [500, 1000, 1600, 3200], active: 1 });
  const more = mapMouse(feel({ stages: [400, 800, 1200, 1600, 2000, 2400], active: 5 }), mouse({ stages: { max: 4, fixedCount: 4 } }), NO_SENS);
  const s = more.steps[0] as { values: number[]; active: number };
  assert.equal(s.values.length, 4);
  assert.equal(s.values[s.active], 2400, "the active step survives the cut");
});

test("a mouse with one DPI and no steps takes only the one in use", () => {
  const p = mapMouse(feel({ stages: [400, 800, 1600], active: 1 }), mouse({ stages: null, dpi: { min: 100, max: 6000, step: 100 } }), NO_SENS);
  assert.deepEqual(p.steps[0], { kind: "dpi", dpi: 800 });
  assert.equal(row(p, "stages")!.status, "unavailable");
  assert.ok(p.differences.some((d) => d.setting === "stages" && d.kind === "dropped"));
});

test("a mouse whose DPI can't be set reports it, and gives no sens advice", () => {
  const p = mapMouse(feel(), mouse({ dpi: null, stages: null }), { cs2: 0.5, valorant: null });
  assert.equal(row(p, "dpi")!.status, "unavailable");
  assert.equal(row(p, "dpi")!.note, "Not available on this device");
  assert.equal(p.sens, null);
  assert.ok(!p.steps.some((s) => s.kind === "stages" || s.kind === "dpi"));
});

test("steps that would write what the mouse already holds are left out", () => {
  const same = feel({ debounceMs: 2, angleSnapping: true, motionSync: false, ripple: null });
  const t = target({ debounce: { options: [0, 1, 2, 4] }, toggles: { angleSnapping: true, motionSync: true, ripple: true } });
  const p = mapMouse(same, { target: t, now: same });
  assert.deepEqual(p.steps, []);
  assert.equal(p.nothingToDo, true);
  assert.ok(p.rows.every((r) => r.status === "same"));
  assert.deepEqual(p.differences, []);
});

test("a mouse that differs only in polling gets only the polling step", () => {
  const p = mapMouse(feel(), mouse({}, feel({ pollingHz: 500 })), NO_SENS);
  assert.deepEqual(p.steps, [{ kind: "polling", hz: 1000 }]);
  assert.equal(row(p, "polling")!.now, "500 Hz");
  assert.equal(p.nothingToDo, false);
});

// ---------------------------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------------------------

test("polling is clamped to the rates the mouse offers", () => {
  const t = { polling: { options: [125, 500, 1000] } };
  const high = mapMouse(feel({ pollingHz: 8000 }), mouse(t), NO_SENS);
  assert.deepEqual(high.steps.find((s) => s.kind === "polling"), { kind: "polling", hz: 1000 });
  assert.equal(row(high, "polling")!.status, "adjusted");
  assert.match(high.differences.find((d) => d.setting === "polling")!.reason, /offers 125 Hz, 500 Hz, 1 kHz, so 8 kHz becomes 1 kHz/);
  assert.equal(row(high, "polling")!.to, "1 kHz");
  const low = mapMouse(feel({ pollingHz: 125 }), mouse({ polling: { options: [500, 1000] } }), NO_SENS);
  assert.deepEqual(low.steps.find((s) => s.kind === "polling"), { kind: "polling", hz: 500 });
});

test("polling: an exact rate is exact; a tie goes to the faster rate; no list is not available", () => {
  assert.equal(row(mapMouse(feel({ pollingHz: 1000 }), mouse(), NO_SENS), "polling")!.status, "exact");
  const tie = mapMouse(feel({ pollingHz: 4000 }), mouse({ polling: { options: [1000, 2000, 8000] } }), NO_SENS);
  assert.deepEqual(tie.steps.find((s) => s.kind === "polling"), { kind: "polling", hz: 8000 });
  const none = mapMouse(feel(), mouse({ polling: null }), NO_SENS);
  assert.equal(row(none, "polling")!.status, "unavailable");
  assert.ok(none.differences.some((d) => d.setting === "polling" && d.kind === "unavailable"));
});

// ---------------------------------------------------------------------------------------------
// Lift-off
// ---------------------------------------------------------------------------------------------

const MM = { kind: "mm" as const, min: 0.7, max: 1.7, step: 0.1 };

test("lift-off position puts both scales on 0..1", () => {
  assert.equal(lodPosition({ kind: "level", level: "Low" }), 0);
  assert.equal(lodPosition({ kind: "level", level: "Medium" }), 0.5);
  assert.equal(lodPosition({ kind: "level", level: "High" }), 1);
  assert.equal(lodPosition({ kind: "mm", mm: 1.2, min: 0.7, max: 1.7 }), 0.5);
  assert.equal(lodPosition({ kind: "mm", mm: 3, min: 1, max: 3 }), 1);
  assert.equal(lodPosition({ kind: "mm", mm: 0.2, min: 0.7, max: 1.7 }), 0, "below the range");
  assert.equal(lodPosition({ kind: "mm", mm: 1.2 }), (1.2 - REFERENCE_LOD_MM.min) / (REFERENCE_LOD_MM.max - REFERENCE_LOD_MM.min), "no range: the reference one");
});

test("lift-off: levels to levels", () => {
  const same = mapMouse(feel({ lod: { kind: "level", level: "High" } }), mouse(), NO_SENS);
  assert.deepEqual(same.steps.find((s) => s.kind === "lod"), { kind: "lod", level: "High" });
  assert.equal(row(same, "lod")!.status, "exact");
  const gap = mapMouse(feel({ lod: { kind: "level", level: "Medium" } }), mouse({ lod: { kind: "levels", levels: ["Low", "High"] } }), NO_SENS);
  assert.deepEqual(gap.steps.find((s) => s.kind === "lod"), { kind: "lod", level: "Low" }, "Medium is halfway; a tie goes to the lower lift-off");
  assert.equal(row(gap, "lod")!.status, "adjusted");
});

test("lift-off: levels to millimetres spans the target's own range", () => {
  const pick = (level: "Low" | "Medium" | "High") => mapMouse(feel({ lod: { kind: "level", level } }), mouse({ lod: MM }), NO_SENS);
  assert.deepEqual(pick("Low").steps.find((s) => s.kind === "lod"), { kind: "lod", mm: 0.7 });
  assert.deepEqual(pick("Medium").steps.find((s) => s.kind === "lod"), { kind: "lod", mm: 1.2 });
  assert.deepEqual(pick("High").steps.find((s) => s.kind === "lod"), { kind: "lod", mm: 1.7 });
  assert.equal(row(pick("High"), "lod")!.status, "approximate");
  assert.equal(row(pick("High"), "lod")!.to, "1.7 mm");
  assert.equal(pick("Low").differences[0].kind, "approximate");
  const wide = mapMouse(feel({ lod: { kind: "level", level: "Medium" } }), mouse({ lod: { kind: "mm", min: 1, max: 3, step: 0.5 } }), NO_SENS);
  assert.deepEqual(wide.steps.find((s) => s.kind === "lod"), { kind: "lod", mm: 2 });
});

test("lift-off: millimetres to levels, placed on the source's own range", () => {
  const at = (mm: number, min = 0.7, max = 1.7) => mapMouse(feel({ lod: { kind: "mm", mm, min, max } }), mouse(), NO_SENS).steps.find((s) => s.kind === "lod");
  assert.deepEqual(at(0.7), { kind: "lod", level: "Low" });
  assert.deepEqual(at(0.9), { kind: "lod", level: "Low" });
  assert.deepEqual(at(1.0), { kind: "lod", level: "Medium" });
  assert.deepEqual(at(1.2), { kind: "lod", level: "Medium" });
  assert.deepEqual(at(1.6), { kind: "lod", level: "High" });
  // The same millimetres mean something else on a mouse that goes 1 to 3 mm.
  assert.deepEqual(at(1.2, 1, 3), { kind: "lod", level: "Low" });
  assert.deepEqual(at(3, 1, 3), { kind: "lod", level: "High" });
  assert.equal(mapMouse(feel({ lod: { kind: "mm", mm: 1.2, min: 0.7, max: 1.7 } }), mouse(), NO_SENS).rows.find((r) => r.id === "lod")!.status, "approximate");
});

test("lift-off: millimetres to millimetres is absolute, snapped and clamped", () => {
  const at = (mm: number, t = MM) => mapMouse(feel({ lod: { kind: "mm", mm } }), mouse({ lod: t }), NO_SENS);
  assert.equal(row(at(1.0), "lod")!.status, "exact");
  assert.deepEqual(at(1.0).steps.find((s) => s.kind === "lod"), { kind: "lod", mm: 1 });
  const snapped = at(1.25);
  assert.equal(row(snapped, "lod")!.status, "adjusted");
  assert.equal(snapped.steps.find((s) => s.kind === "lod")!["mm" as never], 1.2, "a tie goes to the lower lift-off");
  assert.deepEqual(at(0.5).steps.find((s) => s.kind === "lod"), { kind: "lod", mm: 0.7 });
  assert.deepEqual(at(2.4).steps.find((s) => s.kind === "lod"), { kind: "lod", mm: 1.7 });
  assert.equal(at(2.4).differences[0].kind, "adjusted");
});

test("lift-off: not available on a mouse without it", () => {
  const p = mapMouse(feel(), mouse({ lod: null }), NO_SENS);
  assert.equal(row(p, "lod")!.status, "unavailable");
  assert.equal(row(p, "lod")!.to, null);
  assert.ok(!p.steps.some((s) => s.kind === "lod"));
});

test("lift-off already at the planned value is left alone", () => {
  const now = feel({ lod: { kind: "mm", mm: 0.7, min: 0.7, max: 1.7 } });
  const p = mapMouse(feel({ lod: { kind: "level", level: "Low" } }), mouse({ lod: MM }, now), NO_SENS);
  assert.ok(!p.steps.some((s) => s.kind === "lod"));
  assert.equal(row(p, "lod")!.status, "same");
});

// ---------------------------------------------------------------------------------------------
// Debounce and toggles
// ---------------------------------------------------------------------------------------------

test("debounce snaps to the nearest offered value, ties to the shorter", () => {
  const t = { debounce: { options: [0, 1, 2, 4, 8] } };
  const exact = mapMouse(feel({ debounceMs: 2 }), mouse(t), NO_SENS);
  assert.deepEqual(exact.steps.find((s) => s.kind === "debounce"), { kind: "debounce", ms: 2 });
  assert.equal(row(exact, "debounce")!.status, "exact");
  const tie = mapMouse(feel({ debounceMs: 3 }), mouse(t), NO_SENS);
  assert.deepEqual(tie.steps.find((s) => s.kind === "debounce"), { kind: "debounce", ms: 2 });
  assert.equal(row(tie, "debounce")!.status, "adjusted");
  assert.deepEqual(mapMouse(feel({ debounceMs: 20 }), mouse(t), NO_SENS).steps.find((s) => s.kind === "debounce"), { kind: "debounce", ms: 8 });
});

test("debounce, angle snapping, motion sync and ripple the target lacks are not available", () => {
  const p = mapMouse(feel({ debounceMs: 2, angleSnapping: true, motionSync: false, ripple: true }), mouse(), NO_SENS);
  for (const id of ["debounce", "angleSnapping", "motionSync", "ripple"]) {
    assert.equal(row(p, id)!.status, "unavailable", id);
    assert.equal(row(p, id)!.note, "Not available on this device", id);
    assert.equal(row(p, id)!.to, null, id);
  }
  assert.equal(p.differences.filter((d) => d.kind === "unavailable").length, 4);
  assert.ok(!p.steps.some((s) => s.kind === "debounce" || s.kind === "toggle"));
});

test("toggles the target has are set, and only when they differ", () => {
  const t = { toggles: { angleSnapping: true, motionSync: true, ripple: true } };
  const p = mapMouse(feel({ angleSnapping: true, motionSync: false, ripple: null }), mouse(t, feel({ angleSnapping: false, motionSync: false, ripple: false })), NO_SENS);
  assert.deepEqual(p.steps.filter((s) => s.kind === "toggle"), [{ kind: "toggle", setting: "angleSnapping", on: true }]);
  assert.equal(row(p, "angleSnapping")!.now, "Off");
  assert.equal(row(p, "motionSync")!.status, "same");
  assert.equal(row(p, "ripple"), undefined, "not in the feel, not in the plan");
});

test("settings the feel doesn't hold are not in the plan", () => {
  const p = mapMouse(feel({ pollingHz: null, lod: null, debounceMs: null }), mouse(), NO_SENS);
  assert.deepEqual(p.rows.map((r) => r.id), ["dpi", "stages"]);
});

test("steps come out in a safe order: DPI, polling, lift-off, debounce, toggles", () => {
  const t = { debounce: { options: [2] }, toggles: { angleSnapping: true, motionSync: true, ripple: true } };
  const p = mapMouse(feel({ debounceMs: 2, angleSnapping: true, motionSync: true, ripple: true }), mouse(t), NO_SENS);
  assert.deepEqual(p.steps.map((s) => s.kind), ["stages", "polling", "lod", "debounce", "toggle", "toggle", "toggle"]);
});

test("an odd active index in a stored feel can't point outside its steps", () => {
  const p = mapMouse(feel({ stages: [800], active: 7 }), mouse(), NO_SENS);
  assert.deepEqual(p.steps[0], { kind: "stages", values: [800], active: 0 });
});

// ---------------------------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------------------------

const kfeel = (over: Partial<KeyboardFeel> = {}): KeyboardFeel => ({ actuationMm: 1.2, rapidTrigger: true, rtPressMm: 0.3, rtReleaseMm: 0.3, socd: null, ...over });
const FALCHION: KeyboardDevice["target"] = {
  actuation: { min: 0.1, max: 4, step: 0.1 },
  rapidTrigger: true,
  rtSensitivity: { min: 0.1, max: 2, step: 0.1, independent: true },
  socd: null,
};
const X68: KeyboardDevice["target"] = { ...FALCHION, actuation: { min: 0.1, max: 4, step: 0.01 }, rtSensitivity: { min: 0.01, max: 2, step: 0.01, independent: true } };
const kb = (t: Partial<KeyboardDevice["target"]> = {}, now: KeyboardFeel | null = null): KeyboardDevice => ({ target: { ...FALCHION, ...t }, now });

test("actuation and rapid trigger that the keyboard has come through exact", () => {
  const p = mapKeyboard(kfeel(), kb());
  assert.deepEqual(p.steps, [
    { kind: "actuation", mm: 1.2 },
    { kind: "rtSensitivity", pressMm: 0.3, releaseMm: 0.3 },
    { kind: "rapidTrigger", on: true },
  ]);
  assert.deepEqual(p.rows.map((r) => [r.id, r.status]), [["actuation", "exact"], ["rtSensitivity", "exact"], ["rapidTrigger", "exact"]]);
  assert.equal(p.sens, null);
});

test("0.01 mm to 0.1 mm: the value snaps to the coarser grid and says so", () => {
  const p = mapKeyboard(kfeel({ actuationMm: 1.25, rtPressMm: 0.35, rtReleaseMm: 0.35 }), kb());
  assert.deepEqual(p.steps[0], { kind: "actuation", mm: 1.3 });
  assert.equal(row(p, "actuation")!.status, "adjusted");
  assert.match(row(p, "actuation")!.note!, /steps of 0\.1 mm, so 1\.25 mm becomes 1\.3 mm/);
  assert.deepEqual(p.steps[1], { kind: "rtSensitivity", pressMm: 0.4, releaseMm: 0.4 });
});

test("0.1 mm to 0.01 mm: finer grids keep the value exactly", () => {
  const p = mapKeyboard(kfeel({ actuationMm: 1.2, rtPressMm: 0.3, rtReleaseMm: 0.3 }), kb(X68));
  assert.deepEqual(p.steps[0], { kind: "actuation", mm: 1.2 });
  assert.equal(row(p, "actuation")!.status, "exact");
  assert.equal(p.differences.length, 0);
  const fine = mapKeyboard(kfeel({ actuationMm: 1.25 }), kb(X68));
  assert.equal(row(fine, "actuation")!.status, "exact");
});

test("a value outside the keyboard's range is clamped, and the reason names the range", () => {
  const hi = mapKeyboard(kfeel({ actuationMm: 5 }), kb({ actuation: { min: 0.2, max: 3.8, step: 0.1 } }));
  assert.deepEqual(hi.steps[0], { kind: "actuation", mm: 3.8 });
  assert.match(hi.differences[0].reason, /outside what this keyboard allows \(0\.2 to 3\.8 mm in steps of 0\.1\)/);
  const lo = mapKeyboard(kfeel({ actuationMm: 0.05 }), kb({ actuation: { min: 0.2, max: 3.8, step: 0.1 } }));
  assert.deepEqual(lo.steps[0], { kind: "actuation", mm: 0.2 });
});

test("separate press and release distances; a keyboard with one sensitivity uses the press one", () => {
  const split = mapKeyboard(kfeel({ rtPressMm: 0.2, rtReleaseMm: 0.5 }), kb());
  assert.deepEqual(split.steps[1], { kind: "rtSensitivity", pressMm: 0.2, releaseMm: 0.5 });
  assert.equal(row(split, "rtSensitivity")!.from, "0.2 / 0.5 mm");
  assert.equal(row(split, "rtSensitivity")!.status, "exact");
  const merged = mapKeyboard(kfeel({ rtPressMm: 0.2, rtReleaseMm: 0.5 }), kb({ rtSensitivity: { min: 0.1, max: 2, step: 0.1, independent: false } }));
  assert.deepEqual(merged.steps[1], { kind: "rtSensitivity", pressMm: 0.2, releaseMm: 0.2 });
  assert.equal(row(merged, "rtSensitivity")!.status, "adjusted");
  assert.match(merged.differences[0].reason, /one rapid-trigger sensitivity/);
  const equal = mapKeyboard(kfeel(), kb({ rtSensitivity: { min: 0.1, max: 2, step: 0.1, independent: false } }));
  assert.equal(row(equal, "rtSensitivity")!.status, "exact");
});

test("a keyboard with only one of press or release saved still gets both", () => {
  const p = mapKeyboard(kfeel({ rtPressMm: 0.4, rtReleaseMm: null }), kb());
  assert.deepEqual(p.steps[1], { kind: "rtSensitivity", pressMm: 0.4, releaseMm: 0.4 });
});

test("features the keyboard lacks are reported as not available", () => {
  const p = mapKeyboard(kfeel({ socd: [{ a: "A", b: "D", mode: "last" }] }), kb({ actuation: null, rapidTrigger: false, rtSensitivity: null, socd: null }));
  assert.deepEqual(p.steps, []);
  for (const id of ["actuation", "rtSensitivity", "rapidTrigger", "socd"]) {
    assert.equal(row(p, id)!.status, "unavailable", id);
    assert.equal(row(p, id)!.note, "Not available on this device", id);
  }
  assert.equal(p.differences.length, 4);
  assert.equal(p.nothingToDo, true);
});

test("rapid trigger off is carried too", () => {
  const p = mapKeyboard(kfeel({ rapidTrigger: false }), kb({}, kfeel({ rapidTrigger: true })));
  assert.deepEqual(p.steps.find((s) => s.kind === "rapidTrigger"), { kind: "rapidTrigger", on: false });
  assert.equal(row(p, "rapidTrigger")!.now, "On");
});

test("a keyboard that already matches has nothing to do", () => {
  const now = kfeel();
  const p = mapKeyboard(kfeel(), kb({}, now));
  assert.equal(p.nothingToDo, true);
  assert.ok(p.rows.every((r) => r.status === "same"));
});

const SOCD_TARGET = { modes: ["last", "neutral", "priorityA"] as const, maxPairs: 4, keys: ["A", "D", "W", "S", "Left", "Right"], existing: [] };

test("SOCD pairs are carried by key name", () => {
  const f = kfeel({ socd: [{ a: "A", b: "D", mode: "last" }, { a: "W", b: "S", mode: "neutral" }] });
  const p = mapKeyboard(f, kb({ socd: { ...SOCD_TARGET, modes: [...SOCD_TARGET.modes] } }));
  assert.deepEqual(p.steps.at(-1), { kind: "socd", pairs: f.socd });
  assert.equal(row(p, "socd")!.status, "exact");
  assert.equal(row(p, "socd")!.from, "A + D, last input wins; W + S, both cancel");
});

test("SOCD: pairs the keyboard has already are not written again", () => {
  const f = kfeel({ socd: [{ a: "A", b: "D", mode: "last" }] });
  const p = mapKeyboard(f, kb({ socd: { ...SOCD_TARGET, modes: [...SOCD_TARGET.modes], existing: [{ a: "D", b: "A", mode: "last" }] } }));
  assert.ok(!p.steps.some((s) => s.kind === "socd"));
  assert.equal(row(p, "socd")!.status, "same");
});

test("SOCD: a mode, a key or a slot the keyboard doesn't have is left out and named", () => {
  const f = kfeel({
    socd: [
      { a: "A", b: "D", mode: "deeper" },
      { a: "A", b: "Q", mode: "last" },
      { a: "Left", b: "Right", mode: "last" },
      { a: "W", b: "S", mode: "last" },
    ],
  });
  const p = mapKeyboard(f, kb({ socd: { ...SOCD_TARGET, modes: [...SOCD_TARGET.modes], maxPairs: 2, existing: [{ a: "Left", b: "S", mode: "neutral" }] } }));
  // Room for one more pair: Left + Right takes it, W + S finds none.
  assert.deepEqual(p.steps.at(-1), { kind: "socd", pairs: [{ a: "Left", b: "Right", mode: "last" }] });
  const why = p.differences.filter((d) => d.setting === "socd").map((d) => d.reason);
  assert.equal(why.length, 3);
  assert.match(why[0], /can't do "deeper press wins"/);
  assert.match(why[1], /Q isn't a key/);
  assert.match(why[2], /slots on this keyboard are used/);
  assert.equal(row(p, "socd")!.status, "adjusted");
});

test("SOCD: nothing the keyboard can take means not available", () => {
  const p = mapKeyboard(kfeel({ socd: [{ a: "A", b: "D", mode: "deeper" }] }), kb({ socd: { ...SOCD_TARGET, modes: ["last"] } }));
  assert.ok(!p.steps.some((s) => s.kind === "socd"));
  assert.equal(row(p, "socd")!.status, "unavailable");
});

test("an empty SOCD list asks for nothing", () => {
  const p = mapKeyboard(kfeel({ socd: [] }), kb());
  assert.equal(row(p, "socd"), undefined);
});

test("keyboard steps come out as actuation, sensitivity, rapid trigger, SOCD", () => {
  const f = kfeel({ socd: [{ a: "A", b: "D", mode: "last" }] });
  const p = mapKeyboard(f, kb({ socd: { ...SOCD_TARGET, modes: [...SOCD_TARGET.modes] } }));
  assert.deepEqual(p.steps.map((s) => s.kind), ["actuation", "rtSensitivity", "rapidTrigger", "socd"]);
});
