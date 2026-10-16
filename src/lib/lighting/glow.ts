// The room light's colours (src/components/ui/ambient.tsx): the ones last set on your lights, brightest-enough first,
// with a warm sunset filling in. Pure, so a test can run it.

/** Before any light has been set, and to fill in when fewer than three colours are bright enough. */
export const SUNSET = ["#ff5e3a", "#8a5cf6", "#ff9f43"] as const;

/** Too dark to glow (a light set nearly off): below this brightest channel the colour is skipped. */
const MIN_GLOW = 48;

/** The three pools' colours from the recent colours, newest first ("#rrggbb"). */
export function glowColours(recent: readonly string[]): [string, string, string] {
  const bright = recent.filter((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return Math.max((n >> 16) & 255, (n >> 8) & 255, n & 255) >= MIN_GLOW;
  });
  const out = [...new Set(bright.map((h) => h.toLowerCase()))].slice(0, 3);
  for (const c of SUNSET) if (out.length < 3 && !out.includes(c)) out.push(c);
  return [out[0], out[1], out[2]];
}

const channels = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c: readonly number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Below this the colour is too dark to read as text or a dot on the near-black app, and is lifted towards white. */
const MIN_ACCENT_LUMINANCE = 0.16;

/**
 * The "Room light" accent from the room's first colour: lifted towards white just enough to read on the near-black app
 * (a deep blue would vanish), and the text that goes on it, near-black or white, whichever reads better.
 */
export function roomAccent(hex: string): { accent: string; fg: string } {
  const c = channels(hex);
  let accent = hex.toLowerCase();
  for (let t = 0.1; luminance(accent) < MIN_ACCENT_LUMINANCE && t <= 1; t += 0.1) accent = toHex(c.map((v) => v + (255 - v) * t));
  const l = luminance(accent);
  // Contrast with near-black text against with white text: the higher one wins.
  const fg = (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#08080a" : "#f4f4f6";
  return { accent, fg };
}
