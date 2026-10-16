// The paint drawing of a light's page, by form (src/lib/lighting/stage.ts): every segment is where the light counts it,
// in order along the drawing, and a tap on a segment lands on that segment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formOf, segmentAt, stageGeometry, type StageForm, type StageGeometry } from "../src/lib/lighting/stage.ts";

const mids = (g: StageGeometry) => g.segments.map((s) => s.mid);
const gap = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Each segment's own middle hits it, and a point far from the light hits nothing. */
function hitsItself(g: StageGeometry) {
  g.segments.forEach((s, i) => assert.equal(segmentAt(g, s.mid[0], s.mid[1]), i, `${g.form}: segment ${i + 1} is hit at its middle`));
  assert.equal(segmentAt(g, -500, -500), null, `${g.form}: nothing is hit far away`);
  // A drag (no reach) always lands somewhere.
  assert.notEqual(segmentAt(g, -500, -500, Infinity), null);
}

/** Consecutive segments sit next to each other (no jumps) except across `breaks`. */
function contiguous(g: StageGeometry, breaks: readonly number[] = []) {
  const m = mids(g);
  const steps = m.slice(1).map((p, i) => gap(m[i], p));
  const typical = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)];
  steps.forEach((d, i) => {
    if (!breaks.includes(i)) assert.ok(d <= typical * 1.6, `${g.form}: segments ${i + 1} and ${i + 2} are neighbours (${d.toFixed(1)} vs ${typical.toFixed(1)})`);
  });
}

test("each model kind gets its drawing", () => {
  const want: [string, number, StageForm][] = [
    ["floor-lamp", 14, "lamp"],
    ["tv", 15, "tv"],
    ["bar", 10, "bars"],
    ["strip", 15, "wave"],
    ["neon", 10, "wave"],
    ["panel", 7, "tiles"],
    ["wall", 6, "tiles"],
    ["light", 12, "wave"],
    ["tv", 1, "single"],
    ["floor-lamp", 0, "single"],
  ];
  for (const [kind, n, form] of want) assert.equal(formOf(kind, n), form, `${kind} with ${n} segments`);
});

test("a floor lamp counts from the foot of the pole up", () => {
  const g = stageGeometry("lamp", 14);
  assert.equal(g.segments.length, 14);
  mids(g).slice(1).forEach((p, i) => assert.ok(p[1] < mids(g)[i][1], `segment ${i + 2} is above segment ${i + 1}`));
  contiguous(g);
  hitsItself(g);
});

test("a TV backlight runs up the left edge, across the top and down the right edge", () => {
  for (const n of [15, 14, 20, 7]) {
    const g = stageGeometry("tv", n);
    const m = mids(g);
    const [w, h] = [g.width, g.height];
    assert.ok(m[0][0] < w * 0.2 && m[0][1] > h * 0.5, `${n}: segment 1 is low on the left`);
    assert.ok(m[n - 1][0] > w * 0.8 && m[n - 1][1] > h * 0.5, `${n}: the last segment is low on the right`);
    const top = m.filter((p) => p[1] < h * 0.2);
    assert.ok(top.length >= Math.floor(n / 3), `${n}: about half the strip runs across the top`);
    // Left edge going up, then the top going right, then the right edge going down: x never goes back.
    m.slice(1).forEach((p, i) => assert.ok(p[0] >= m[i][0] - 0.01, `${n}: segment ${i + 2} is not left of segment ${i + 1}`));
    const leftEdge = m.filter((p) => p[0] < w * 0.2);
    leftEdge.slice(1).forEach((p, i) => assert.ok(p[1] < leftEdge[i][1], `${n}: up the left edge`));
    contiguous(g);
    hitsItself(g);
  }
});

test("light bars: the first half on the left bar from its foot up, the rest on the right bar", () => {
  for (const n of [10, 9, 6]) {
    const g = stageGeometry("bars", n);
    const m = mids(g);
    const left = Math.ceil(n / 2);
    m.forEach((p, i) => assert.ok(i < left ? p[0] < g.width / 2 : p[0] > g.width / 2, `${n}: segment ${i + 1} is on the ${i < left ? "left" : "right"} bar`));
    for (const part of [m.slice(0, left), m.slice(left)]) part.slice(1).forEach((p, i) => assert.ok(p[1] < part[i][1], `${n}: each bar counts upwards`));
    contiguous(g, [left - 1]);
    hitsItself(g);
  }
});

test("a strip or neon rope lies in a wave from left to right", () => {
  for (const n of [15, 10, 3]) {
    const g = stageGeometry("wave", n);
    const m = mids(g);
    m.slice(1).forEach((p, i) => assert.ok(p[0] > m[i][0], `${n}: segment ${i + 2} is right of segment ${i + 1}`));
    assert.ok(Math.max(...m.map((p) => p[1])) - Math.min(...m.map((p) => p[1])) > 10 || n < 4, `${n}: it waves`);
    contiguous(g);
    hitsItself(g);
  }
});

test("panels are a cluster of tiles, each chained to the next", () => {
  for (const n of [7, 4, 10, 1]) {
    const g = stageGeometry("tiles", n);
    assert.equal(g.segments.length, n);
    const m = mids(g);
    // Neighbouring hexagons: centres one tile apart (along a row, or diagonally to the next row).
    const tile = 30 * Math.sqrt(3);
    m.slice(1).forEach((p, i) => assert.ok(gap(p, m[i]) <= tile * 1.05, `${n}: tile ${i + 2} touches tile ${i + 1}`));
    hitsItself(g);
  }
});

test("a light of one colour is one glow", () => {
  const g = stageGeometry("single", 1);
  assert.equal(g.segments.length, 1);
  assert.equal(segmentAt(g, 100, 100), 0);
});
