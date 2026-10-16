// Which 16-bit QMK keycodes the Advanced remap may put on a key (the VIA guard's "remap" scope, and the
// Rust bridge's `advanced_keycode_ok` in src-tauri/src/hid.rs, which mirrors this table; the fixture
// src-tauri/src/via-frames-advanced.txt keeps the two in step).
//
// The same number means different things before QMK 0.19 ("legacy": VIA protocol <= 11, Vial <= 5) and
// after ("current"), so the allowlist is per scheme. It is a list of what IS allowed (basic keys,
// modifier combinations, mod-tap, layer-tap, layer switching, macro keys) rather than of what is not.
// On top of that three ranges are refused in both encodings, so a board that reports the wrong scheme
// still can't be handed a bootloader or EEPROM-clear key:
//   0x5C00-0x5CFF  RESET, debug, clear-EEPROM, magic and lighting keys before QMK 0.19
//   0x7C00-0x7CFF  QK_BOOT, QK_REBOOT, QK_DEBUG_TOGGLE, QK_CLEAR_EEPROM, QK_MAKE ...
//   0x7E00-0xFFFF  keyboard-specific (QK_KB), user and Unicode codes: a vendor may hang anything on them
// Pure.
import type { KeycodeScheme } from "../../advanced/core.ts";

export type Range = readonly [first: number, last: number, what: string];

/** Refused under both encodings. */
export const NEVER_KEYCODES: readonly Range[] = [
  [0x5c00, 0x5cff, "bootloader, reset and EEPROM-clear keys (QMK before 0.19)"],
  [0x7c00, 0x7cff, "bootloader, reboot and EEPROM-clear keys"],
  [0x7e00, 0xffff, "keyboard-specific, user and Unicode codes"],
];

/** Allowed above the basic range 0x0000-0x00FF (which the default path already writes). */
export const ADVANCED_KEYCODES: Readonly<Record<KeycodeScheme, readonly Range[]>> = {
  current: [
    [0x0100, 0x1fff, "modifier + key"],
    [0x2000, 0x3fff, "mod-tap"],
    [0x4000, 0x4fff, "layer-tap"],
    [0x5000, 0x51ff, "layer + modifier"],
    [0x5200, 0x52df, "layer switch (TO, MO, DF, TG, OSL, OSM, TT)"],
    [0x7700, 0x777f, "macro"],
  ],
  legacy: [
    [0x0100, 0x1fff, "modifier + key"],
    [0x4000, 0x4fff, "layer-tap"],
    [0x5010, 0x501f, "TO layer"],
    [0x5100, 0x55ff, "MO, DF, TG, OSL and OSM layer keys"],
    [0x5800, 0x59ff, "TT and layer + modifier"],
    [0x5f12, 0x5f21, "macro"],
    [0x6000, 0x7bff, "mod-tap"],
    [0x7d00, 0x7dff, "mod-tap"],
  ],
};

const within = (code: number, ranges: readonly Range[]) => ranges.some(([a, b]) => code >= a && code <= b);

/** Whether the Advanced remap may write this code on a board that uses `scheme`. */
export function advancedKeycodeOk(code: number, scheme: KeycodeScheme): boolean {
  if (!Number.isInteger(code) || code < 0 || code > 0xffff) return false;
  if (code <= 0x00ff) return true;
  if (within(code, NEVER_KEYCODES)) return false;
  return within(code, ADVANCED_KEYCODES[scheme]);
}

/** Why a code is refused, in words (for the picker and for errors). */
export function keycodeRefusal(code: number, scheme: KeycodeScheme): string | null {
  if (advancedKeycodeOk(code, scheme)) return null;
  const never = NEVER_KEYCODES.find(([a, b]) => code >= a && code <= b);
  if (never) return `That key code is for ${never[2]}. SYNQ never puts it on a key.`;
  return "SYNQ doesn't put that kind of key code on a key.";
}

/** The macro key code for slot `n` in each encoding. */
export function macroKeycode(n: number, scheme: KeycodeScheme): number {
  return scheme === "current" ? 0x7700 + n : 0x5f12 + n;
}

/** Layer-switch key codes for layer `n` in each encoding (the kinds a layout needs). */
export function layerKeycodes(n: number, scheme: KeycodeScheme): { to: number; mo: number; df: number; tg: number; osl: number; tt: number } {
  return scheme === "current"
    ? { to: 0x5200 + n, mo: 0x5220 + n, df: 0x5240 + n, tg: 0x5260 + n, osl: 0x5280 + n, tt: 0x52c0 + n }
    : { to: 0x5010 + n, mo: 0x5100 + n, df: 0x5200 + n, tg: 0x5300 + n, osl: 0x5400 + n, tt: 0x5800 + n };
}
