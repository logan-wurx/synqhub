// The drawing a light's page paints on, by the light's form (its model row's `kind`): where each segment sits, in the
// order the light counts them, and which segment a point is over. Pure geometry in the drawing's own units (its
// viewBox); src/components/lighting/LampStage.tsx draws it and maps the pointer into it. Which end a real light counts
// from is UNVERIFIED per model (docs/devices/LIGHTING.md): the drawings follow the usual way each form is laid.

export type StageForm = "lamp" | "tv" | "bars" | "wave" | "tiles" | "single";

type Pt = readonly [number, number];

/** One segment: a stretch of a line (`points`, drawn as a thick stroke) or a tile (`points` is its outline). */
export interface StageSegment {
  points: readonly Pt[];
  /** Where its number is shown and where a tap on it lands. */
  mid: Pt;
}

export interface StageGeometry {
  form: StageForm;
  /** The drawing's size in its own units. */
  width: number;
  height: number;
  segments: readonly StageSegment[];
  /** Line forms: the stroke width; tiles: 0 (each tile is filled). */
  stroke: number;
  /** The unlit parts drawn around the light (a lamp's base and pole foot, a TV's set and stand, the bars' feet), as SVG paths. */
  frame: readonly string[];
}

/** The form for a model's kind ("floor-lamp", "tv", "bar", "strip", "neon", "panel"...); one colour is a single glow. */
export function formOf(kind: string, segments: number): StageForm {
  if (segments <= 1) return "single";
  const forms: Readonly<Record<string, StageForm>> = { "floor-lamp": "lamp", "table-lamp": "lamp", tv: "tv", bar: "bars", strip: "wave", neon: "wave", panel: "tiles", wall: "tiles" };
  return forms[kind] ?? "wave";
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** A polyline cut into `n` equal stretches (by length), each sampled finely enough to hit-test along. */
function cut(path: readonly Pt[], n: number): StageSegment[] {
  const lens = path.slice(1).map((p, i) => dist(path[i], p));
  const total = lens.reduce((a, b) => a + b, 0);
  const at = (d: number): Pt => {
    let left = Math.max(0, Math.min(total, d));
    for (let i = 0; i < lens.length; i++) {
      if (left <= lens[i] || i === lens.length - 1) {
        const f = lens[i] ? Math.min(1, left / lens[i]) : 0;
        return [path[i][0] + (path[i + 1][0] - path[i][0]) * f, path[i][1] + (path[i + 1][1] - path[i][1]) * f];
      }
      left -= lens[i];
    }
    return path[path.length - 1];
  };
  // The path's own vertices inside a stretch are kept, so a segment bends round a TV's corner or along the wave.
  const vertices = lens.map((_, i) => ({ d: lens.slice(0, i + 1).reduce((x, y) => x + y, 0), p: path[i + 1] }));
  return Array.from({ length: n }, (_, i) => {
    const a = (total * i) / n;
    const b = (total * (i + 1)) / n;
    const points = [at(a), ...vertices.filter((v) => v.d > a && v.d < b).map((v) => v.p), at(b)];
    return { points, mid: at((a + b) / 2) };
  });
}

/** A regular outline of `k` corners round a centre: a pointy-top hexagon (6), or a circle near enough (36). */
const ring = ([cx, cy]: Pt, r: number, k = 6): Pt[] =>
  Array.from({ length: k }, (_, i) => {
    const a = ((Math.PI * 2) / k) * i + Math.PI / 6;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });

/** Where each segment of a light of `form` sits, in the order the light counts them. */
export function stageGeometry(form: StageForm, n: number): StageGeometry {
  const count = Math.max(1, n);
  switch (form) {
    case "lamp":
      // A pole, segment 1 at the bottom, on a round foot.
      return { form, width: 200, height: 400, stroke: 14, segments: cut([[100, 352], [100, 28]], count), frame: ["M100 360V372", "M58 382a42 9 0 1 0 84 0a42 9 0 1 0 -84 0Z"] };
    case "tv":
      // Up the left edge, across the top, down the right edge: how a backlight is stuck on behind a TV.
      return {
        form,
        width: 320,
        height: 250,
        stroke: 10,
        segments: cut([[24, 196], [24, 24], [296, 24], [296, 196]], count),
        frame: ["M40 40H280V180H40Z", "M146 180L140 206M174 180L180 206M118 210H202"],
      };
    case "bars": {
      // Two upright bars, the first half of the segments on the left one (from its foot up), the rest on the right.
      const left = Math.ceil(count / 2);
      return {
        form,
        width: 220,
        height: 340,
        stroke: 18,
        segments: [...cut([[70, 290], [70, 34]], left), ...cut([[150, 290], [150, 34]], count - left)],
        frame: ["M70 298V312M48 316H92", "M150 298V312M128 316H172"],
      };
    }
    case "tiles": {
      // Hexagon tiles in rows of up to four, counted along each row and back along the next (how panels are chained).
      const per = Math.min(4, count);
      const rows = Math.ceil(count / per);
      const r = 30;
      const w = r * Math.sqrt(3);
      const width = per * w + w / 2 + 40;
      const height = rows * r * 1.5 + r / 2 + 40;
      const segments = Array.from({ length: count }, (_, i) => {
        const row = Math.floor(i / per);
        const k = i % per;
        const col = row % 2 ? per - 1 - k : k;
        const c: Pt = [20 + w / 2 + col * w + (row % 2 ? w / 2 : 0), 20 + r + row * r * 1.5];
        return { points: ring(c, r - 2), mid: c };
      });
      return { form, width, height, stroke: 0, segments, frame: [] };
    }
    case "single":
      return { form, width: 200, height: 200, stroke: 0, segments: [{ points: ring([100, 100], 66, 36), mid: [100, 100] }], frame: [] };
    default: {
      // A strip or neon rope laid in a gentle wave, segment 1 at the left.
      const pts = Array.from({ length: 49 }, (_, i) => [20 + (280 * i) / 48, 100 + 34 * Math.sin((i / 48) * Math.PI * 2)] as Pt);
      return { form: "wave", width: 320, height: 200, stroke: 12, segments: cut(pts, count), frame: [] };
    }
  }
}

/** Squared distance from a point to a line piece. */
function toPiece(p: Pt, a: Pt, b: Pt): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  const [x, y] = [a[0] + t * dx - p[0], a[1] + t * dy - p[1]];
  return x * x + y * y;
}

/**
 * The segment under a point of the drawing, or null when it is further than `reach` from every segment (a drag passes
 * Infinity, so a stroke keeps painting the nearest one). Tiles are hit inside their outline or nearest centre.
 */
export function segmentAt(g: StageGeometry, x: number, y: number, reach = 26): number | null {
  let best: number | null = null;
  let bestD = reach * reach;
  g.segments.forEach((s, i) => {
    let d = Infinity;
    if (g.stroke === 0) d = dist([x, y], s.mid) ** 2 * 0.6;
    else for (let k = 1; k < s.points.length; k++) d = Math.min(d, toPiece([x, y], s.points[k - 1], s.points[k]));
    if (d <= bestD) [best, bestD] = [i, d];
  });
  return best;
}

/** SVG path data for a segment (an open stroke, or a closed tile). */
export const segmentPath = (g: StageGeometry, s: StageSegment) =>
  s.points.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("") + (g.stroke === 0 ? "Z" : "");
