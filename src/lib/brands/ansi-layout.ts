// A plain full-size ANSI key grid (KLE-style units) by KeyboardEvent.code name, so brand drivers whose
// protocol carries no geometry (ASUS Gear Link, CORSAIR Bragi) can still give the generic panel a
// clickable layout. Positions are the standard 104-key ANSI ones; a compact board is drawn as the
// full-size grid filtered to the keys it reports, so gaps can appear. Data only.
import type { KbKey, KbLayout } from "../kb/types.ts";

export interface GridKey {
  x: number;
  y: number;
  w?: number;
  h?: number;
  label: string;
}

const row = (y: number, start: number, keys: readonly (readonly [string, string, number?])[]): Record<string, GridKey> => {
  const out: Record<string, GridKey> = {};
  let x = start;
  for (const [code, label, w = 1] of keys) {
    out[code] = { x, y, w, label };
    x += w;
  }
  return out;
};
const at = (x: number, y: number, label: string, w = 1, h = 1): GridKey => ({ x, y, w, h, label });

const digits = "1234567890".split("").map((d) => [`Digit${d}`, d] as const);
const letters = (s: string) => s.split("").map((c) => [`Key${c}`, c] as const);

/** code -> position. Units: 1 = one key; the nav cluster starts at x 15.25, the numpad at 18.5. */
export const ANSI_GRID: Readonly<Record<string, GridKey>> = {
  Escape: at(0, 0, "Esc"),
  ...row(0, 2, [["F1", "F1"], ["F2", "F2"], ["F3", "F3"], ["F4", "F4"]]),
  ...row(0, 6.5, [["F5", "F5"], ["F6", "F6"], ["F7", "F7"], ["F8", "F8"]]),
  ...row(0, 11, [["F9", "F9"], ["F10", "F10"], ["F11", "F11"], ["F12", "F12"]]),
  ...row(0, 15.25, [["PrintScreen", "PrtSc"], ["ScrollLock", "ScrLk"], ["Pause", "Pause"]]),
  ...row(1.25, 0, [["Backquote", "`"], ...digits, ["Minus", "-"], ["Equal", "="], ["Backspace", "Backspace", 2]]),
  ...row(1.25, 15.25, [["Insert", "Ins"], ["Home", "Home"], ["PageUp", "PgUp"]]),
  ...row(1.25, 18.5, [["NumLock", "Num"], ["NumpadDivide", "/"], ["NumpadMultiply", "*"], ["NumpadSubtract", "-"]]),
  ...row(2.25, 0, [["Tab", "Tab", 1.5], ...letters("QWERTYUIOP"), ["BracketLeft", "["], ["BracketRight", "]"], ["Backslash", "\\", 1.5]]),
  ...row(2.25, 15.25, [["Delete", "Del"], ["End", "End"], ["PageDown", "PgDn"]]),
  ...row(2.25, 18.5, [["Numpad7", "7"], ["Numpad8", "8"], ["Numpad9", "9"]]),
  NumpadAdd: at(21.5, 2.25, "+", 1, 2),
  ...row(3.25, 0, [["CapsLock", "Caps", 1.75], ...letters("ASDFGHJKL"), ["Semicolon", ";"], ["Quote", "'"], ["Enter", "Enter", 2.25]]),
  ...row(3.25, 18.5, [["Numpad4", "4"], ["Numpad5", "5"], ["Numpad6", "6"]]),
  ...row(4.25, 0, [["ShiftLeft", "Shift", 2.25], ...letters("ZXCVBNM"), ["Comma", ","], ["Period", "."], ["Slash", "/"], ["ShiftRight", "Shift", 2.75]]),
  ArrowUp: at(16.25, 4.25, "↑"),
  ...row(4.25, 18.5, [["Numpad1", "1"], ["Numpad2", "2"], ["Numpad3", "3"]]),
  NumpadEnter: at(21.5, 4.25, "Ent", 1, 2),
  ...row(5.25, 0, [["ControlLeft", "Ctrl", 1.25], ["MetaLeft", "Win", 1.25], ["AltLeft", "Alt", 1.25], ["Space", "", 6.25], ["AltRight", "Alt", 1.25], ["FN", "Fn", 1.25], ["ContextMenu", "Menu", 1.25], ["ControlRight", "Ctrl", 1.25]]),
  ...row(5.25, 15.25, [["ArrowLeft", "←"], ["ArrowDown", "↓"], ["ArrowRight", "→"]]),
  Numpad0: at(18.5, 5.25, "0", 2),
  NumpadDecimal: at(20.5, 5.25, "."),
};

/**
 * A KbLayout for the keys a board reports. `keys` maps each driver key index to a grid code; keys
 * with no grid position are left out of the drawing (they stay addressable by index).
 */
export function layoutFromGrid(keys: readonly { index: number; code: string; label?: string }[], note: string): KbLayout {
  const placed: KbKey[] = [];
  for (const k of keys) {
    const g = ANSI_GRID[k.code];
    if (!g) continue;
    placed.push({ index: k.index, x: g.x, y: g.y, w: g.w ?? 1, h: g.h ?? 1, label: k.label ?? g.label });
  }
  const width = Math.max(0, ...placed.map((k) => k.x + k.w));
  const height = Math.max(0, ...placed.map((k) => k.y + k.h));
  return { source: "driver", width, height, keys: placed, note };
}

/** Grid codes present on common form factors (approximate: used only to choose what to draw). */
const NAV = ["Insert", "Home", "PageUp", "Delete", "End", "PageDown"];
const NUMPAD = Object.keys(ANSI_GRID).filter((c) => c.startsWith("Numpad") || c === "NumLock");
const FROW = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];
const ALPHA = Object.keys(ANSI_GRID).filter((c) => !NAV.includes(c) && !NUMPAD.includes(c) && !FROW.includes(c) && !["PrintScreen", "ScrollLock", "Pause"].includes(c));

export function codesForForm(form: "60" | "65" | "75" | "75-split" | "96" | "full"): Set<string> {
  const arrows = ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"];
  switch (form) {
    case "60":
      return new Set(ALPHA.filter((c) => !arrows.includes(c)));
    case "65":
      return new Set([...ALPHA, "Insert", "Delete", "PageUp", "PageDown"]);
    case "75":
    case "75-split":
      return new Set([...ALPHA, ...FROW, "Delete", "PageUp", "PageDown", "Home", "End", "Insert", "PrintScreen"]);
    case "96":
      return new Set([...ALPHA, ...FROW, ...NUMPAD, "Delete", "PageUp", "PageDown", "Home", "End", "Insert", "PrintScreen"]);
    default:
      return new Set(Object.keys(ANSI_GRID));
  }
}
