// ANSI key geometry for the Razer analog boards, keyed by Razer firmware key id (fwID, devices.ts
// RAZER_KEY_IDS), in KLE key units. Data only: the generic panel draws it. ISO / JIS variants differ in
// a few keys (Enter, left Shift, NON_US keys); the session only marks keys analog when the board
// answers for them, so an ISO board simply shows its extra keys as non-analog here. The Fn key has no
// fwID and is left out.

import type { RazerKeyboardModel } from "./devices.ts";
import { RAZER_KEY_IDS as K } from "./devices.ts";

export interface RazerKeyGeom {
  id: number;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

type Cell = [label: string, id: number | null, w?: number] | number; // a number = gap in key units

function row(y: number, x0: number, cells: Cell[], out: RazerKeyGeom[]): void {
  let x = x0;
  for (const c of cells) {
    if (typeof c === "number") {
      x += c;
      continue;
    }
    const [label, id, w = 1] = c;
    if (id !== null) out.push({ id, label, x, y, w, h: 1 });
    x += w;
  }
}

const FROW: Cell[] = [["Esc", K.ESC], 1, ["F1", K.F1], ["F2", K.F2], ["F3", K.F3], ["F4", K.F4], 0.5, ["F5", K.F5], ["F6", K.F6], ["F7", K.F7], ["F8", K.F8], 0.5, ["F9", K.F9], ["F10", K.F10], ["F11", K.F11], ["F12", K.F12]];
const NUM: Cell[] = [["`", K.TILDE], ["1", K["1"]], ["2", K["2"]], ["3", K["3"]], ["4", K["4"]], ["5", K["5"]], ["6", K["6"]], ["7", K["7"]], ["8", K["8"]], ["9", K["9"]], ["0", K["0"]], ["-", K.MINUS], ["=", K.EQUAL], ["Backspace", K.BACKSPACE, 2]];
const TOP: Cell[] = [["Tab", K.TAB, 1.5], ["Q", K.Q], ["W", K.W], ["E", K.E], ["R", K.R], ["T", K.T], ["Y", K.Y], ["U", K.U], ["I", K.I], ["O", K.O], ["P", K.P], ["[", K.LBRACKET], ["]", K.RBRACKET], ["\\", K.BACKSLASH, 1.5]];
const HOME: Cell[] = [["Caps", K.CAPS_LOCK, 1.75], ["A", K.A], ["S", K.S], ["D", K.D], ["F", K.F], ["G", K.G], ["H", K.H], ["J", K.J], ["K", K.K], ["L", K.L], [";", K.SEMICOLON], ["'", K.APOSTROPHE], ["Enter", K.ENTER, 2.25]];
const BOT: Cell[] = [["Shift", K.LSHIFT, 2.25], ["Z", K.Z], ["X", K.X], ["C", K.C], ["V", K.V], ["B", K.B], ["N", K.N], ["M", K.M], [",", K.COMMA], [".", K.PERIOD], ["/", K.SLASH], ["Shift", K.RSHIFT, 2.75]];
const MODS: Cell[] = [["Ctrl", K.LCTRL, 1.25], ["Win", K.LGUI, 1.25], ["Alt", K.LALT, 1.25], ["Space", K.SPACE, 6.25], ["Alt", K.RALT, 1.25], ["Fn", null, 1.25], ["Menu", K.MENU, 1.25], ["Ctrl", K.RCTRL, 1.25]];

export function razerLayout(model: RazerKeyboardModel): { keys: RazerKeyGeom[]; width: number; height: number } {
  const keys: RazerKeyGeom[] = [];
  if (model.form === "60" || model.form === "65") {
    row(0, 0, NUM, keys);
    row(1, 0, TOP, keys);
    row(2, 0, HOME, keys);
    if (model.form === "60") {
      row(3, 0, BOT, keys);
      row(4, 0, MODS, keys);
      return { keys, width: 15, height: 5 };
    }
    row(0, 15, [["Del", K.DELETE]], keys);
    row(1, 15, [["PgUp", K.PAGE_UP]], keys);
    row(2, 15, [["PgDn", K.PAGE_DOWN]], keys);
    row(3, 0, [["Shift", K.LSHIFT, 2.25], ["Z", K.Z], ["X", K.X], ["C", K.C], ["V", K.V], ["B", K.B], ["N", K.N], ["M", K.M], [",", K.COMMA], [".", K.PERIOD], ["/", K.SLASH], ["Shift", K.RSHIFT, 1.75], ["↑", K.UP], ["End", K.END]], keys);
    row(4, 0, [["Ctrl", K.LCTRL, 1.25], ["Win", K.LGUI, 1.25], ["Alt", K.LALT, 1.25], ["Space", K.SPACE, 6.25], ["Alt", K.RALT], ["Fn", null], ["Ctrl", K.RCTRL], ["←", K.LEFT], ["↓", K.DOWN], ["→", K.RIGHT]], keys);
    return { keys, width: 16, height: 5 };
  }
  row(0, 0, [...FROW, 0.25, ["PrtSc", K.PRINT_SCREEN], ["ScrLk", K.SCROLL_LOCK], ["Pause", K.PAUSE]], keys);
  row(1.25, 0, [...NUM, 0.25, ["Ins", K.INSERT], ["Home", K.HOME], ["PgUp", K.PAGE_UP]], keys);
  row(2.25, 0, [...TOP, 0.25, ["Del", K.DELETE], ["End", K.END], ["PgDn", K.PAGE_DOWN]], keys);
  row(3.25, 0, HOME, keys);
  row(4.25, 0, [...BOT, 1.25, ["↑", K.UP]], keys);
  row(5.25, 0, [...MODS, 0.25, ["←", K.LEFT], ["↓", K.DOWN], ["→", K.RIGHT]], keys);
  if (model.form !== "full") return { keys, width: 18.25, height: 6.25 };
  row(1.25, 18.5, [["Num", K.NUM_LOCK], ["/", K.KP_SLASH], ["*", K.KP_ASTERISK], ["-", K.KP_MINUS]], keys);
  row(2.25, 18.5, [["7", K.KP_7], ["8", K.KP_8], ["9", K.KP_9]], keys);
  row(3.25, 18.5, [["4", K.KP_4], ["5", K.KP_5], ["6", K.KP_6]], keys);
  row(4.25, 18.5, [["1", K.KP_1], ["2", K.KP_2], ["3", K.KP_3]], keys);
  row(5.25, 18.5, [["0", K.KP_0, 2], [".", K.KP_PERIOD]], keys);
  keys.push({ id: K.KP_PLUS, label: "+", x: 21.5, y: 2.25, w: 1, h: 2 });
  keys.push({ id: K.KP_ENTER, label: "Enter", x: 21.5, y: 4.25, w: 1, h: 2 });
  return { keys, width: 22.5, height: 6.25 };
}
