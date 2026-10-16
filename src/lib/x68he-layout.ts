// Key positions of the keyboards the illumipc driver speaks to: matrix index (row * 22 + col) and the factory keymap entry of
// every key, from illumipc's per-product layout files (https://www.illumipc.com/config/keys/<product>.json).
//
//   - The X68 HE family (AK1680 / AK1681 product codes, fetched 2026-10-12): all 58 boards on 2E3C:C365 share one matrix; the
//     only index that moves is Backslash (58 on ANSI boards, 79 on ISO ones). Geometry is SYNQ's own 65% drawing in key
//     units (16 wide, 5 rows), not illumipc's pixels.
//   - Every other board in src/lib/illumipc/catalog.generated.ts (Redragon, Epomaker, Womier; fetched 2026-10-14): the layout
//     file's keys, with illumipc's pixel positions turned into key units. Fn, rotary-knob and custom G keys are locked: they
//     are drawn and left alone.
// A product code in neither table opens read-only (see layoutForProduct).
import { ILLUMIPC_BOARDS, ILLUMIPC_LAYOUTS, type IllumipcBoard } from "./illumipc/catalog.generated.ts";
import { FN_ACTION, HID_NAMES, keyAction, type RawAction } from "./x68he-protocol.ts";

/** "ansi" | "iso" | "iso-uk" | "iso-br" for the X68 family; "catalog-<n>" for a layout from the catalogue. */
export type X68LayoutId = string;

export interface X68Key {
  index: number;
  /** Factory keymap entry (what "reset" restores). */
  factory: RawAction;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Fn can't be remapped or given its own trigger here. */
  locked?: boolean;
}

export interface X68Layout {
  id: X68LayoutId;
  name: string;
  /** illumipc's layout "type": anything but "us" swaps HID 0x31 for 0x32 as SOCD key 2. */
  usType: boolean;
  units: { w: number; h: number };
  keys: X68Key[];
}

const LABEL: Record<number, string> = { 0x29: "Esc", 0x2a: "Back", 0x2b: "Tab", 0x39: "Caps", 0x28: "Enter", 0x2c: "", 0x49: "Ins", 0x4a: "Home", 0x4c: "Del", 0x4b: "PgUp", 0x4e: "PgDn", 0x52: "↑", 0x50: "←", 0x51: "↓", 0x4f: "→", 0xe0: "Ctrl", 0xe1: "Shift", 0xe2: "Alt", 0xe3: "Win", 0xe4: "Ctrl", 0xe5: "Shift", 0xe6: "Alt", 0x87: "/", 0x64: "\\" };
const labelFor = (hid: number) => LABEL[hid] ?? HID_NAMES[hid] ?? "?";

function row(y: number, x0: number, items: [number, number, number?][]): X68Key[] {
  // items: [index, hid, width]
  let x = x0;
  return items.map(([index, hid, w = 1]) => {
    const k: X68Key = { index, factory: keyAction(hid), label: labelFor(hid), x, y, w, h: 1 };
    x += w;
    return k;
  });
}

const DIGITS: [number, number][] = [23, 24, 25, 26, 27, 28, 29, 30, 31, 32].map((i, n) => [i, 0x1e + n]);
const QWERTY: [number, number][] = [
  [45, 0x14],
  [46, 0x1a],
  [47, 0x08],
  [48, 0x15],
  [49, 0x17],
  [50, 0x1c],
  [51, 0x18],
  [52, 0x0c],
  [53, 0x12],
  [54, 0x13],
  [55, 0x2f],
  [56, 0x30],
];
const HOME: [number, number][] = [
  [68, 0x04],
  [69, 0x16],
  [70, 0x07],
  [71, 0x09],
  [72, 0x0a],
  [73, 0x0b],
  [74, 0x0d],
  [75, 0x0e],
  [76, 0x0f],
  [77, 0x33],
  [78, 0x34],
];
const BOTTOM_LETTERS: [number, number][] = [
  [90, 0x1d],
  [91, 0x1b],
  [92, 0x06],
  [93, 0x19],
  [94, 0x05],
  [95, 0x11],
  [96, 0x10],
  [97, 0x36],
  [98, 0x37],
];

function bottomRow(): X68Key[] {
  const keys = row(4, 0, [
    [110, 0xe0, 1.25],
    [111, 0xe3, 1.25],
    [112, 0xe2, 1.25],
    [116, 0x2c, 6.25],
    [119, 0xe6],
    [121, 0, 1],
    [122, 0xe4],
    [124, 0x50],
    [125, 0x51],
    [126, 0x4f],
  ]);
  const fn = keys.find((k) => k.index === 121)!;
  fn.factory = FN_ACTION;
  fn.label = "Fn";
  fn.locked = true;
  return keys;
}

function build(id: X68LayoutId): X68Layout {
  const iso = id !== "ansi";
  // Per illumipc's files: AK1680UKX68 has Home top right and sends 0x32 from the key left of Enter;
  // AK1680GUKX68 (here "iso") and AK1680BRX68 keep Insert and 0x31; BR sends Ro (0x87) next to Right Shift.
  const topRight = id === "iso-uk" ? 0x4a : 0x49;
  const keys: X68Key[] = [
    ...row(0, 0, [[22, 0x29], ...DIGITS, [33, 0x2d], [34, 0x2e], [36, 0x2a, 2], [38, topRight]]),
    ...row(1, 0, [[44, 0x2b, 1.5], ...QWERTY]),
    ...(iso ? [] : row(1, 13.5, [[58, 0x31, 1.5]])),
    ...row(1, 15, [[60, 0x4c]]),
    ...row(2, 0, [[66, 0x39, 1.75], ...HOME]),
    ...(iso ? row(2, 12.75, [[79, id === "iso-uk" ? 0x32 : 0x31]]) : row(2, 12.75, [[80, 0x28, 2.25]])),
    ...row(2, 15, [[82, 0x4b]]),
    ...(iso
      ? row(3, 0, [[88, 0xe1, 1.25], [89, 0x64], ...BOTTOM_LETTERS, [99, id === "iso-br" ? 0x87 : 0x38], [101, 0xe5, 1.75], [103, 0x52], [104, 0x4e]])
      : row(3, 0, [[88, 0xe1, 2.25], ...BOTTOM_LETTERS, [99, 0x38], [101, 0xe5, 1.75], [103, 0x52], [104, 0x4e]])),
    ...bottomRow(),
  ];
  if (iso) keys.push({ index: 80, factory: keyAction(0x28), label: "Enter", x: 13.75, y: 1, w: 1.25, h: 2 });
  return {
    id,
    name: id === "ansi" ? "ANSI (US)" : id === "iso-uk" ? "ISO (UK)" : id === "iso-br" ? "ISO (ABNT/BR)" : "ISO",
    usType: id === "ansi",
    units: { w: 16, h: 5 },
    keys: keys.sort((a, b) => a.y - b.y || a.x - b.x),
  };
}

export const X68_LAYOUTS: Record<"ansi" | "iso" | "iso-uk" | "iso-br", X68Layout> = { ansi: build("ansi"), iso: build("iso"), "iso-uk": build("iso-uk"), "iso-br": build("iso-br") };

/** illumipc's X68 HE entries on 2E3C:C365 (config/device.json). */
export const KNOWN_X68_PRODUCTS: Record<string, "ansi" | "iso" | "iso-uk" | "iso-br"> = {
  AK1680UKX68ZAXHEARGB: "iso-uk", // "X68HE"
  AK1680BRX68ZAXHEARGB: "iso-br", // "X68 HE"
  AK1680GUKX68XYXCPHEARGB: "iso",
};

// ---------------------------------------------------------------------------------------------
// The catalogue of other boards
// ---------------------------------------------------------------------------------------------

const BOARDS = new Map<string, IllumipcBoard>(ILLUMIPC_BOARDS.map((b) => [b.product.toUpperCase(), b]));

/** The catalogue entry for a product code (case does not matter), or null. */
export const boardForProduct = (product: string): IllumipcBoard | null => BOARDS.get(product.trim().toUpperCase()) ?? null;

const built = new Map<number, X68Layout>();

/** A catalogue layout as the panel draws it. */
function catalogLayout(index: number): X68Layout {
  const cached = built.get(index);
  if (cached) return cached;
  const src = ILLUMIPC_LAYOUTS[index];
  const keys: X68Key[] = src.keys.map(([matrix, hid, x, y, w, h, kind, legend]) => ({
    index: matrix,
    factory: kind === 1 ? FN_ACTION : kind === 0 ? keyAction(hid) : keyAction(0),
    label: kind === 0 ? labelFor(hid) : kind === 1 ? "Fn" : kind === 2 ? "" : legend,
    x,
    y,
    w,
    h,
    ...(kind !== 0 ? { locked: true } : {}),
  }));
  const us = src.type === "us";
  const layout: X68Layout = {
    id: `catalog-${index}`,
    name: `${us ? "ANSI (US)" : "ISO"} · ${keys.filter((k) => !k.locked).length} keys`,
    usType: us,
    units: { w: Math.ceil(Math.max(...keys.map((k) => k.x + k.w)) * 4) / 4, h: Math.ceil(Math.max(...keys.map((k) => k.y + k.h)) * 4) / 4 },
    keys: keys.sort((a, b) => a.y - b.y || a.x - b.x),
  };
  built.set(index, layout);
  return layout;
}

/**
 * Picks the layout for the product code the keyboard reports (command 0x0D). Known X68 codes map directly; the other
 * AK1680/AK1681 codes share their matrix, so "UK"/"BR" in the code means ISO and anything else ANSI; a code in the catalogue
 * gets that board's own layout. `board` is the catalogue row when there is one. Returns null for any other code (then SYNQ
 * stays read-only).
 */
export function layoutForProduct(product: string): { layout: X68Layout; known: boolean; board: IllumipcBoard | null } | null {
  const p = product.trim().toUpperCase();
  const board = BOARDS.get(p) ?? null;
  const known = KNOWN_X68_PRODUCTS[p];
  if (known) return { layout: X68_LAYOUTS[known], known: true, board };
  if (board && board.layout !== null) return { layout: catalogLayout(board.layout), known: true, board };
  if (!/^AK168[01]/.test(p)) return null;
  const id = /BR/.test(p.slice(6)) ? "iso-br" : /UK/.test(p.slice(6)) ? "iso" : "ansi";
  return { layout: X68_LAYOUTS[id], known: false, board };
}

/** Who a keyboard is, for the panel's headings. */
export interface Identity {
  /** "Redragon", "MAGIC-REFINER", or "" when nobody told us. */
  brand: string;
  /** "K556RGB-M", "X68 HE", or the product code. */
  model: string;
  /** Brand and model: "Redragon K556RGB-M". */
  name: string;
  /** The X68 HE family (its photo and its history in this app). */
  x68: boolean;
}

/**
 * The identity of a keyboard from its product code and the name it reports over USB. A catalogue board is named by the
 * catalogue; a keyboard whose code is an X68 code, or whose USB name says X68, is the MAGIC-REFINER X68 HE (the friend's
 * board, whichever AK168x code it reports); anything else is an "HE keyboard" known by its product code.
 */
export function identityFor(product: string, usbName: string): Identity {
  const board = boardForProduct(product);
  const x68Name = usbName.toUpperCase().replace(/[ \-]/g, "").includes("X68");
  if (board && board.brand !== "MAGIC-REFINER") {
    const model = board.name || board.product;
    return { brand: board.brand, model, name: `${board.brand} ${model}`, x68: false };
  }
  if (board || KNOWN_X68_PRODUCTS[product.trim().toUpperCase()] || x68Name) return { brand: "MAGIC-REFINER", model: "X68 HE", name: "MAGIC-REFINER X68 HE", x68: true };
  const model = product.trim() || usbName.trim() || "HE keyboard";
  return { brand: "", model, name: `HE keyboard (${model})`, x68: false };
}
