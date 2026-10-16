// Guard rails for remaps. The Advanced card can change what buttons and keys do, but never so far that
// the device stops being usable:
//
//   - a mouse's left button always stays left click (and something must always send left click);
//   - a keyboard always keeps a way back: enough plain typing keys on layer 0, and no layer switch that
//     leaves you on a layer with no key that returns.
//
// Pure functions over plain data, so each rule has a test. The ATK Rust guard also enforces the first
// rule on the wire (src-tauri/src/hid.rs `atk_frame_allowed`); the keyboard rule needs the whole keymap,
// so it runs here, before anything is sent.
import type { KeycodeScheme } from "./core.ts";
import { layerKeycodes } from "../kb/via/keycode-safety.ts";

export const LEFT_CLICK_LOCK = "The left button always stays left click, so you can always click.";

/** Why this mouse change is refused, or null. `leftSlot` is the button that sends left click. */
export function mouseChangeProblem(change: { slot: string; toLeftClick: boolean }, leftSlot: string): string | null {
  if (change.slot === leftSlot && !change.toLeftClick) return LEFT_CLICK_LOCK;
  return null;
}

/** The state of a mouse's buttons after a change must still send left click from the left button. */
export function mouseButtonsProblem(slots: readonly { id: string; leftClick: boolean }[], leftSlot: string): string | null {
  const left = slots.find((s) => s.id === leftSlot);
  if (!left || !left.leftClick) return LEFT_CLICK_LOCK;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------------------------

/** Letters, digits, Enter, Esc, Backspace, Tab, Space: what a keyboard needs to be typed on. */
export const isTypable = (code: number): boolean => code >= 0x04 && code <= 0x2c;

/** How many plain typing keys layer 0 must keep: 8, or all of them on a pad with fewer keys. */
export const MIN_TYPABLE = 8;

export type LayerMove = { kind: "to" | "mo" | "df" | "tg" | "osl" | "tt"; layer: number };

/** The layer move a keycode is, or null. */
export function layerMove(code: number, scheme: KeycodeScheme): LayerMove | null {
  for (let n = 0; n < 32; n++) {
    const k = layerKeycodes(n, scheme);
    for (const kind of ["to", "mo", "df", "tg", "osl", "tt"] as const) if (k[kind] === code) return { kind, layer: n };
  }
  return null;
}

/**
 * Why this whole keymap would leave the keyboard without a way back, or null. `codes[layer][key]`;
 * `keys` are the key indexes that exist on the layout.
 */
export function keymapProblem(codes: readonly Readonly<Record<number, number>>[], keys: readonly number[], scheme: KeycodeScheme): string | null {
  if (!codes.length || !keys.length) return null;
  const base = codes[0];
  const need = Math.min(MIN_TYPABLE, keys.length);
  const typable = keys.filter((k) => isTypable(base[k] ?? 0)).length;
  if (typable < need) return `Layer 0 must keep at least ${need} typing keys (letters, digits, Enter, Esc, Backspace, Tab, Space) so the keyboard stays usable.`;
  // A layer you can enter for good (TO, DF, TG) must have a key that leads back.
  for (let layer = 0; layer < codes.length; layer++) {
    for (const k of keys) {
      const move = layerMove(codes[layer][k] ?? 0, scheme);
      if (!move || (move.kind !== "to" && move.kind !== "df" && move.kind !== "tg")) continue;
      // Layer 0 is home: moving to it needs no way back. A move to the layer you're on does nothing.
      if (move.layer === 0 || move.layer === layer || move.layer >= codes.length) continue;
      if (!hasWayBack(codes, keys, move.layer, move.kind === "tg" ? k : null, scheme)) {
        return `Layer ${move.layer} would have no key that goes back, so you could get stuck on it. Leave a "go to layer 0" key there first.`;
      }
    }
  }
  return null;
}

/** Layer `n` has a key that returns to a lower layer: TO(0) / DF(0), a toggle off, or (for a toggle) a transparent key in the same place. */
function hasWayBack(codes: readonly Readonly<Record<number, number>>[], keys: readonly number[], n: number, toggleAt: number | null, scheme: KeycodeScheme): boolean {
  const layer = codes[n];
  const TRANSPARENT = 0x0001;
  for (const k of keys) {
    const code = layer[k] ?? 0;
    const move = layerMove(code, scheme);
    if (move && (move.kind === "to" || move.kind === "df") && move.layer < n) return true;
    if (move && move.kind === "tg" && move.layer === n) return true;
    if (toggleAt !== null && k === toggleAt && code === TRANSPARENT) return true;
  }
  return false;
}
