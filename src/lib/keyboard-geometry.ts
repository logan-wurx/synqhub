// Key positions to draw a keyboard that has no photo: SYNQ's own drawing of a form factor (60 / 65 / 75 / TKL /
// full size), or the board's real layout when the app already holds one (X68 HE, the Sonix boards). Key units,
// 1 = one key. Pure data and small functions; the pieces that pull a lot of tables in are loaded on demand.
import { ANSI_GRID } from "./brands/ansi-layout.ts";
import type { KeyboardForm } from "./device-shape.ts";

export interface RenderKey {
  x: number;
  y: number;
  w: number;
  h: number;
  /** "space" and "mod" are drawn a touch darker; "esc" carries the accent. */
  tone?: "key" | "mod" | "space" | "esc";
}

export interface RenderGeometry {
  width: number;
  height: number;
  keys: readonly RenderKey[];
}

/** Rows of keys (a width and a tone) -> positions. A string "g<units>" skips that much. */
function rows(spec: readonly (readonly (readonly [number, RenderKey["tone"]?] | string)[])[], y0 = 0, x0 = 0): RenderKey[] {
  const out: RenderKey[] = [];
  spec.forEach((row, r) => {
    let x = x0;
    for (const k of row) {
      if (typeof k === "string") {
        x += Number(k.slice(1));
        continue;
      }
      out.push({ x, y: y0 + r, w: k[0], h: 1, tone: k[1] ?? "key" });
      x += k[0];
    }
  });
  return out;
}

const K = (w = 1, tone?: RenderKey["tone"]) => [w, tone] as const;
const many = (n: number, w = 1) => Array.from({ length: n }, () => K(w));

const FN_ROW_75 = [K(1, "esc"), ...many(12), K(1, "mod"), K(1)];
const MAIN = (right: "none" | "col" | "arrows") => [
  [...many(13), K(2, "mod"), ...(right === "none" ? [] : [K(1, "mod")])],
  [K(1.5, "mod"), ...many(12), K(1.5), ...(right === "none" ? [] : [K(1, "mod")])],
  [K(1.75, "mod"), ...many(11), K(2.25, "mod"), ...(right === "none" ? [] : [K(1, "mod")])],
  [K(2.25, "mod"), ...many(10), K(right === "none" ? 2.75 : 1.75, "mod"), ...(right === "none" ? [] : [K(1, "mod"), K(1, "mod")])],
  right === "none"
    ? [K(1.25, "mod"), K(1.25, "mod"), K(1.25, "mod"), K(6.25, "space"), K(1.25, "mod"), K(1.25, "mod"), K(1.25, "mod"), K(1.25, "mod")]
    : [K(1.25, "mod"), K(1.25, "mod"), K(1.25, "mod"), K(6.25, "space"), K(1, "mod"), K(1, "mod"), K(1, "mod"), K(1, "mod"), K(1, "mod"), K(1, "mod")],
];

const cache = new Map<KeyboardForm, RenderGeometry>();

/** SYNQ's drawing of a form factor. */
export function formGeometry(form: KeyboardForm): RenderGeometry {
  const hit = cache.get(form);
  if (hit) return hit;
  let g: RenderGeometry;
  if (form === "60") {
    g = { width: 15, height: 5, keys: rows(MAIN("none")) };
    // The first key of a 60% is Esc.
    (g.keys as RenderKey[])[0] = { ...g.keys[0], tone: "esc" };
  } else if (form === "65") {
    const keys = rows(MAIN("arrows"));
    keys[0] = { ...keys[0], tone: "esc" };
    g = { width: 16, height: 5, keys };
  } else if (form === "75") {
    const keys = [...rows([FN_ROW_75]), ...rows(MAIN("arrows"), 1)];
    g = { width: 16, height: 6, keys };
  } else {
    const keep = (code: string) => form === "full" || form === "96" || !(code.startsWith("Numpad") || code === "NumLock");
    const keys: RenderKey[] = [];
    let width = 0;
    let height = 0;
    for (const [code, k] of Object.entries(ANSI_GRID)) {
      if (!keep(code)) continue;
      const w = k.w ?? 1;
      const h = k.h ?? 1;
      const tone: RenderKey["tone"] = code === "Escape" ? "esc" : code === "Space" ? "space" : /Shift|Control|Alt|Meta|Caps|Tab|Enter|Backspace|FN|ContextMenu/.test(code) ? "mod" : "key";
      keys.push({ x: k.x, y: k.y, w, h, tone });
      width = Math.max(width, k.x + w);
      height = Math.max(height, k.y + h);
    }
    g = { width, height, keys };
  }
  cache.set(form, g);
  return g;
}

/** A key's tone from where it sits: wide keys are modifiers, the long one on the bottom row is the space bar. */
function toneOf(x: number, y: number, w: number, maxY: number): RenderKey["tone"] {
  if (y === maxY && w >= 5) return "space";
  if (w >= 1.4) return "mod";
  return x === 0 && y === 0 ? "esc" : "key";
}

/** Keys from a [x, y, w, h] list (the Sonix and X68 layouts). */
export function geometryFromRects(rects: readonly { x: number; y: number; w: number; h: number }[]): RenderGeometry | null {
  if (rects.length < 20) return null;
  const maxY = Math.max(...rects.map((r) => r.y));
  const keys = rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, tone: toneOf(r.x, r.y, r.w, maxY) }));
  const width = Math.max(...keys.map((k) => k.x + k.w));
  const height = Math.max(...keys.map((k) => k.y + k.h));
  return { width, height, keys };
}

