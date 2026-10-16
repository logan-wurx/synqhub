// QMK keycodes as VIA and Vial carry them (16-bit). SYNQ names every code for display, and offers
// only basic keycodes (0x0000-0x00FF: letters, numbers, F-keys, navigation, modifiers, media) for
// writing; the guard (guard.ts) refuses anything above that. Two encodings exist for everything above
// the basic range: QMK before 0.19 ("legacy", VIA protocol <= 11, Vial protocol <= 5) and after
// ("current"); they are only used for labels here. Pure.

export type KeycodeScheme = "legacy" | "current";

const BASIC: Record<number, string> = {
  0x00: "",
  0x01: "▽",
  0x28: "Enter",
  0x29: "Esc",
  0x2a: "Bksp",
  0x2b: "Tab",
  0x2c: "Space",
  0x2d: "-",
  0x2e: "=",
  0x2f: "[",
  0x30: "]",
  0x31: "\\",
  0x32: "#",
  0x33: ";",
  0x34: "'",
  0x35: "`",
  0x36: ",",
  0x37: ".",
  0x38: "/",
  0x39: "Caps",
  0x46: "PrtSc",
  0x47: "ScrLk",
  0x48: "Pause",
  0x49: "Ins",
  0x4a: "Home",
  0x4b: "PgUp",
  0x4c: "Del",
  0x4d: "End",
  0x4e: "PgDn",
  0x4f: "→",
  0x50: "←",
  0x51: "↓",
  0x52: "↑",
  0x53: "NumLk",
  0x54: "KP /",
  0x55: "KP *",
  0x56: "KP -",
  0x57: "KP +",
  0x58: "KP Ent",
  0x62: "KP 0",
  0x63: "KP .",
  0x64: "ISO \\",
  0x65: "Menu",
  0x66: "Power",
  0x67: "KP =",
  0xa5: "Power",
  0xa6: "Sleep",
  0xa7: "Wake",
  0xa8: "Mute",
  0xa9: "Vol +",
  0xaa: "Vol -",
  0xab: "Next",
  0xac: "Prev",
  0xad: "Stop",
  0xae: "Play",
  0xaf: "Media",
  0xb0: "Eject",
  0xb1: "Mail",
  0xb2: "Calc",
  0xb3: "My PC",
  0xb4: "Search",
  0xb5: "Web",
  0xb6: "Back",
  0xb7: "Fwd",
  0xb8: "Web stop",
  0xb9: "Refresh",
  0xba: "Favs",
  0xbb: "FF",
  0xbc: "Rew",
  0xbd: "Bright +",
  0xbe: "Bright -",
  0xe0: "LCtrl",
  0xe1: "LShift",
  0xe2: "LAlt",
  0xe3: "LWin",
  0xe4: "RCtrl",
  0xe5: "RShift",
  0xe6: "RAlt",
  0xe7: "RWin",
};
for (let i = 0; i < 26; i++) BASIC[0x04 + i] = String.fromCharCode(65 + i);
for (let i = 0; i < 9; i++) BASIC[0x1e + i] = String(i + 1);
BASIC[0x27] = "0";
for (let i = 0; i < 12; i++) BASIC[0x3a + i] = `F${i + 1}`;
for (let i = 0; i < 9; i++) BASIC[0x59 + i] = `KP ${i + 1}`;
for (let i = 0; i < 12; i++) BASIC[0x68 + i] = `F${i + 13}`;

const MOD_NAMES = ["Ctrl", "Shift", "Alt", "Win"];
function mods(bits: number): string {
  const right = (bits & 0x10) !== 0;
  const names = MOD_NAMES.filter((_, i) => bits & (1 << i)).map((n) => (right ? `R${n}` : n));
  return names.join("+") || "Mod";
}

/** A short label for a keycode, as on a keycap. */
export function keycodeLabel(code: number, scheme: KeycodeScheme): string {
  if (code <= 0xff) return BASIC[code] ?? `0x${code.toString(16).padStart(2, "0")}`;
  if (code <= 0x1fff) return `${mods(code >> 8)}+${BASIC[code & 0xff] ?? "?"}`;
  const layer = (_base: number) => code & 0x1f;
  if (code >= 0x4000 && code <= 0x4fff) return `LT${(code >> 8) & 0xf} ${BASIC[code & 0xff] ?? ""}`.trim();
  if (scheme === "current") {
    if (code >= 0x2000 && code <= 0x3fff) return `MT ${BASIC[code & 0xff] ?? ""}`.trim();
    if (code >= 0x5000 && code <= 0x51ff) return `LM${(code >> 5) & 0xf}`;
    if (code >= 0x5200 && code <= 0x521f) return `TO${layer(0x5200)}`;
    if (code >= 0x5220 && code <= 0x523f) return `MO${layer(0x5220)}`;
    if (code >= 0x5240 && code <= 0x525f) return `DF${layer(0x5240)}`;
    if (code >= 0x5260 && code <= 0x527f) return `TG${layer(0x5260)}`;
    if (code >= 0x5280 && code <= 0x529f) return `OSL${layer(0x5280)}`;
    if (code >= 0x52a0 && code <= 0x52bf) return `OSM`;
    if (code >= 0x52c0 && code <= 0x52df) return `TT${layer(0x52c0)}`;
    if (code >= 0x5700 && code <= 0x57ff) return `TD${code & 0xff}`;
    if (code >= 0x7700 && code <= 0x777f) return `M${code & 0x7f}`;
    if (code >= 0x7800 && code <= 0x78ff) return "Light";
    if (code === 0x7c00) return "Boot";
    if (code === 0x7c01) return "Reboot";
    if (code === 0x7c03) return "Clear EE";
    if (code >= 0x7e00 && code <= 0x7e3f) return `KB${code - 0x7e00}`;
    if (code >= 0x7e40 && code <= 0x7fff) return `USER${code - 0x7e40}`;
  } else {
    if (code >= 0x5010 && code <= 0x501f) return `TO${code & 0xf}`;
    if (code >= 0x5100 && code <= 0x51ff) return `MO${code & 0xff}`;
    if (code >= 0x5200 && code <= 0x52ff) return `DF${code & 0xff}`;
    if (code >= 0x5300 && code <= 0x53ff) return `TG${code & 0xff}`;
    if (code >= 0x5400 && code <= 0x54ff) return `OSL${code & 0xff}`;
    if (code >= 0x5500 && code <= 0x55ff) return `OSM`;
    if (code >= 0x5700 && code <= 0x57ff) return `TD${code & 0xff}`;
    if (code >= 0x5800 && code <= 0x58ff) return `TT${code & 0xff}`;
    if (code >= 0x5900 && code <= 0x59ff) return `LM${(code >> 4) & 0xf}`;
    if (code === 0x5c00) return "Boot";
    if (code >= 0x5f12 && code <= 0x5f21) return `M${code - 0x5f12}`;
    if (code >= 0x5f80 && code <= 0x5f8f) return `USER${code - 0x5f80}`;
    if (code >= 0x6000 && code <= 0x7fff) return `MT ${BASIC[code & 0xff] ?? ""}`.trim();
  }
  return `0x${code.toString(16).padStart(4, "0")}`;
}

/** A longer name for the inspector. */
export function keycodeName(code: number, scheme: KeycodeScheme): string {
  if (code === 0x00) return "None (KC_NO)";
  if (code === 0x01) return "Transparent (falls through to the layer below)";
  return keycodeLabel(code, scheme);
}

/** What the picker offers: basic keycodes only. */
export const ASSIGNABLE: readonly { code: number; label: string; group: string }[] = (() => {
  const out: { code: number; label: string; group: string }[] = [];
  const add = (group: string, codes: Iterable<number>) => {
    for (const code of codes) out.push({ code, label: code === 0 ? "None" : code === 1 ? "Transparent" : BASIC[code], group });
  };
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  add("Basic", [0x00, 0x01]);
  add("Letters", range(0x04, 0x1d));
  add("Numbers", range(0x1e, 0x27));
  add("Symbols", [0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x64]);
  add("Editing", [0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x39, 0x49, 0x4c, 0x65]);
  add("Navigation", [0x4a, 0x4b, 0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x52, 0x46, 0x47, 0x48]);
  add("Function", [...range(0x3a, 0x45), ...range(0x68, 0x73)]);
  add("Modifiers", range(0xe0, 0xe7));
  add("Media", range(0xa8, 0xae));
  add("Keypad", [0x53, 0x54, 0x55, 0x56, 0x57, 0x58, ...range(0x59, 0x63)]);
  return out;
})();
