// Keyboard geometry for VIA and Vial boards. Two inputs, one output:
//   - a compiled VIA definition (usevia.app/definitions/v3/<id>.json): `layouts.keys` with absolute
//     positions and `layouts.optionKeys[option][choice]` for layout options (split backspace, ISO...);
//   - a Vial definition (from the keyboard itself): `layouts.keymap`, raw KLE rows whose legends carry
//     "row,col" (top-left) and "option,choice" (bottom-right).
// Both become a KbLayout plus the matrix size, with the option choices taken from the keyboard's own
// layout-options value (VIA get_keyboard_value 0x02). Pure.
import type { KbKey, KbLayout } from "../types.ts";

export interface ViaKeyDef {
  row: number;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number;
  rx?: number;
  ry?: number;
  d?: boolean;
}

export interface ParsedDefinition {
  name: string;
  rows: number;
  cols: number;
  /** Layout options: a name plus its choices (a boolean option has two). */
  labels: readonly { name: string; choices: readonly string[] }[];
  keys: readonly ViaKeyDef[];
  optionKeys: Readonly<Record<number, Readonly<Record<number, readonly ViaKeyDef[]>>>>;
  /** VIA v3 menu names / Vial "lighting" value, for the lighting channels. */
  menus: readonly unknown[];
  lighting: string | null;
}

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function labelsOf(raw: unknown): ParsedDefinition["labels"] {
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => (Array.isArray(l) ? { name: String(l[0] ?? ""), choices: l.slice(1).map(String) } : { name: String(l), choices: ["Off", "On"] }));
}

function keyOf(k: Record<string, unknown>): ViaKeyDef {
  return { row: num(k.row), col: num(k.col), x: num(k.x), y: num(k.y), w: num(k.w, 1), h: num(k.h, 1), r: num(k.r), rx: num(k.rx), ry: num(k.ry), d: k.d === true };
}

/** A compiled VIA definition (v2 or v3). Throws on a shape that isn't one. */
export function parseCompiled(json: unknown): ParsedDefinition {
  const j = json as Record<string, unknown>;
  const matrix = j?.matrix as { rows?: unknown; cols?: unknown } | undefined;
  const layouts = j?.layouts as Record<string, unknown> | undefined;
  if (!matrix || !layouts || !Array.isArray(layouts.keys)) throw new Error("Not a VIA keyboard definition.");
  const optionKeys: Record<number, Record<number, ViaKeyDef[]>> = {};
  const rawOptions = (layouts.optionKeys ?? {}) as Record<string, Record<string, unknown[]>>;
  for (const [o, choices] of Object.entries(rawOptions)) {
    optionKeys[Number(o)] = {};
    for (const [c, keys] of Object.entries(choices ?? {})) optionKeys[Number(o)][Number(c)] = (keys ?? []).map((k) => keyOf(k as Record<string, unknown>));
  }
  return {
    name: String(j.name ?? "Keyboard"),
    rows: num(matrix.rows),
    cols: num(matrix.cols),
    labels: labelsOf(layouts.labels),
    keys: (layouts.keys as Record<string, unknown>[]).map(keyOf),
    optionKeys,
    menus: Array.isArray(j.menus) ? j.menus : [],
    lighting: typeof j.lighting === "string" ? j.lighting : typeof j.lighting === "object" && j.lighting ? String((j.lighting as { extends?: unknown }).extends ?? "") || null : null,
  };
}

// KLE: string position -> label index, per alignment (kle-serial's labelMap).
const LABEL_MAP = [
  [0, 6, 2, 8, 9, 11, 3, 5, 1, 4, 7, 10],
  [1, 7, -1, -1, 9, 11, 4, -1, -1, -1, -1, 10],
  [3, -1, 5, -1, 9, 11, -1, -1, 4, -1, -1, 10],
  [4, -1, -1, -1, 9, 11, -1, -1, -1, -1, -1, 10],
  [0, 6, 2, 8, 10, -1, 3, 5, 1, 4, 7, -1],
  [1, 7, -1, -1, 10, -1, 4, -1, -1, -1, -1, -1],
  [3, -1, 5, -1, 10, -1, -1, -1, 4, -1, -1, -1],
  [4, -1, -1, -1, 10, -1, -1, -1, -1, -1, -1, -1],
];

/** Raw KLE rows (Vial's `layouts.keymap`) into keys with their matrix and layout-option legends. */
export function parseKle(rows: unknown): { keys: ViaKeyDef[]; optionKeys: Record<number, Record<number, ViaKeyDef[]>> } {
  const keys: ViaKeyDef[] = [];
  const optionKeys: Record<number, Record<number, ViaKeyDef[]>> = {};
  if (!Array.isArray(rows)) throw new Error("The keyboard's layout isn't in KLE form.");
  const cur = { x: 0, y: 0, w: 1, h: 1, r: 0, rx: 0, ry: 0, d: false, a: 4 };
  for (const row of rows) {
    if (!Array.isArray(row)) continue; // keyboard metadata
    for (const item of row) {
      if (typeof item === "string") {
        const labels: string[] = [];
        item.split("\n").forEach((text, pos) => {
          const at = LABEL_MAP[cur.a]?.[pos] ?? -1;
          if (at >= 0 && text) labels[at] = text;
        });
        const m = /^(\d+),(\d+)$/.exec((labels[0] ?? "").trim());
        if (m && !cur.d) {
          const key: ViaKeyDef = { row: Number(m[1]), col: Number(m[2]), x: cur.x, y: cur.y, w: cur.w, h: cur.h, r: cur.r, rx: cur.rx, ry: cur.ry };
          const opt = /^(\d+),(\d+)$/.exec((labels[8] ?? "").trim());
          if (opt) ((optionKeys[Number(opt[1])] ??= {})[Number(opt[2])] ??= []).push(key);
          else keys.push(key);
        }
        cur.x += cur.w;
        cur.w = 1;
        cur.h = 1;
        cur.d = false;
      } else if (item && typeof item === "object") {
        const p = item as Record<string, unknown>;
        if (typeof p.r === "number") cur.r = p.r;
        if (typeof p.rx === "number") {
          cur.rx = p.rx;
          cur.x = cur.rx;
          cur.y = cur.ry;
        }
        if (typeof p.ry === "number") {
          cur.ry = p.ry;
          cur.x = cur.rx;
          cur.y = cur.ry;
        }
        if (typeof p.a === "number") cur.a = p.a;
        if (typeof p.x === "number") cur.x += p.x;
        if (typeof p.y === "number") cur.y += p.y;
        if (typeof p.w === "number") cur.w = p.w;
        if (typeof p.h === "number") cur.h = p.h;
        if (p.d === true) cur.d = true;
      }
    }
    cur.y += 1;
    cur.x = cur.rx;
  }
  return { keys, optionKeys };
}

/** A Vial definition (JSON from the keyboard) in the same shape as a compiled VIA one. */
export function parseVial(json: unknown): ParsedDefinition {
  const j = json as Record<string, unknown>;
  const matrix = j?.matrix as { rows?: unknown; cols?: unknown } | undefined;
  const layouts = j?.layouts as Record<string, unknown> | undefined;
  if (!matrix || !layouts) throw new Error("The keyboard's Vial definition has no matrix or layout.");
  const { keys, optionKeys } = parseKle(layouts.keymap);
  return {
    name: String(j.name ?? "Keyboard"),
    rows: num(matrix.rows),
    cols: num(matrix.cols),
    labels: labelsOf(layouts.labels),
    keys,
    optionKeys,
    menus: Array.isArray(j.menus) ? j.menus : [],
    lighting: typeof j.lighting === "string" ? j.lighting : null,
  };
}

/** Bits each layout option takes: one for a toggle, ceil(log2(choices)) for a select. */
export const optionBits = (choices: number) => (choices <= 2 ? 1 : Math.ceil(Math.log2(choices)));

/** The chosen value of each layout option from the packed 32-bit value (the last option in the lowest bits). */
export function unpackOptions(labels: ParsedDefinition["labels"], packed: number): number[] {
  const out = labels.map(() => 0);
  let shift = 0;
  for (let i = labels.length - 1; i >= 0; i--) {
    const bits = optionBits(labels[i].choices.length);
    out[i] = Math.floor(packed / 2 ** shift) & ((1 << bits) - 1);
    shift += bits;
  }
  return out;
}

/** The keys on the board as it is set up: the base keys plus each option's chosen keys. */
export function layoutFor(def: ParsedDefinition, choices: readonly number[], source: KbLayout["source"], note?: string): KbLayout {
  const chosen: ViaKeyDef[] = [...def.keys];
  for (const [o, byChoice] of Object.entries(def.optionKeys)) {
    const pick = choices[Number(o)] ?? 0;
    const keys = byChoice[pick] ?? byChoice[0] ?? [];
    // Layout files draw the alternatives off to the side; like VIA, move the chosen ones onto the
    // spot the first choice takes.
    const base = byChoice[0] ?? keys;
    const dx = Math.min(...base.map((k) => k.x)) - Math.min(...keys.map((k) => k.x));
    const dy = Math.min(...base.map((k) => k.y)) - Math.min(...keys.map((k) => k.y));
    const shift = keys === base || !keys.length || !Number.isFinite(dx + dy) ? { dx: 0, dy: 0 } : { dx, dy };
    chosen.push(...keys.map((k) => ({ ...k, x: k.x + shift.dx, y: k.y + shift.dy, ...(k.r ? { rx: (k.rx ?? 0) + shift.dx, ry: (k.ry ?? 0) + shift.dy } : {}) })));
  }
  const keys: KbKey[] = chosen
    .filter((k) => !k.d && k.row < def.rows && k.col < def.cols)
    .map((k) => ({ index: k.row * def.cols + k.col, row: k.row, col: k.col, x: k.x, y: k.y, w: k.w, h: k.h, ...(k.r ? { r: k.r, rx: k.rx, ry: k.ry } : {}) }));
  // Bounding box (rotation ignored: rotated clusters are rare and drawn inside the box closely enough).
  const width = Math.max(1, ...keys.map((k) => k.x + k.w));
  const height = Math.max(1, ...keys.map((k) => k.y + k.h));
  return { source, width, height, keys, note };
}

/** No definition: the matrix itself, one key per row and column. */
export function matrixLayout(rows: number, cols: number, note: string): KbLayout {
  const keys: KbKey[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) keys.push({ index: r * cols + c, row: r, col: c, x: c, y: r, w: 1, h: 1 });
  return { source: "matrix", width: Math.max(1, cols), height: Math.max(1, rows), keys, note };
}
