// The Falchion Ace HFX's 65% layout (68 keys), 16 units wide, with the firmware key index of each
// key from keyboard-protocol.ts (Gear Link's normal key table). Two positions are best guesses:
// the top-left key prints Esc and is mapped to Escape (110), and the key right of Fn (the logo key
// on the ZywOo edition) is mapped to Right Ctrl (64).
import { FW_KEY, type KeyName } from "@/lib/keyboard-protocol";

export interface MapKey {
  name: KeyName;
  index: number;
  label: string;
  /** Width in key units. */
  w: number;
  /** Fn can't be remapped or tuned here. */
  locked?: boolean;
}

const k = (name: KeyName, label: string, w = 1, locked = false): MapKey => ({ name, index: FW_KEY[name], label, w, locked });
const letters = (s: string) => s.split("").map((c) => k(`Key${c}` as KeyName, c));

export const UNITS = 16;

export const FALCHION_ROWS: MapKey[][] = [
  [
    k("Escape", "Esc"),
    ...("1234567890".split("").map((d) => k(`Digit${d}` as KeyName, d))),
    k("Minus", "-"),
    k("Equal", "="),
    k("Backspace", "Backspace", 2),
    k("Insert", "Ins"),
  ],
  [k("Tab", "Tab", 1.5), ...letters("QWERTYUIOP"), k("BracketLeft", "["), k("BracketRight", "]"), k("Backslash", "\\", 1.5), k("Delete", "Del")],
  [k("CapsLock", "Caps", 1.75), ...letters("ASDFGHJKL"), k("Semicolon", ";"), k("Quote", "'"), k("Enter", "Enter", 2.25), k("PageUp", "PgUp")],
  [k("ShiftLeft", "Shift", 2.25), ...letters("ZXCVBNM"), k("Comma", ","), k("Period", "."), k("Slash", "/"), k("ShiftRight", "Shift", 1.75), k("ArrowUp", "↑"), k("PageDown", "PgDn")],
  [
    k("ControlLeft", "Ctrl", 1.25),
    k("MetaLeft", "Win", 1.25),
    k("AltLeft", "Alt", 1.25),
    k("Space", "", 6.25),
    k("AltRight", "Alt"),
    k("FN", "Fn", 1, true),
    k("ControlRight", "Ctrl"),
    k("ArrowLeft", "←"),
    k("ArrowDown", "↓"),
    k("ArrowRight", "→"),
  ],
];

// The X68 HE's 65% layouts (ANSI 68 keys, ISO 69) live next to its protocol, since the matrix
// indexes and factory keys come from illumipc's layout files: src/lib/x68he-layout.ts.
export { X68_LAYOUTS, layoutForProduct, type X68Key, type X68Layout } from "@/lib/x68he-layout";
