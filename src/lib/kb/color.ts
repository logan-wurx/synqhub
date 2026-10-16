// The generic Keyboard panel speaks colour as [hue, saturation], 0..255 each (value is the brightness
// setting); most boards store RGB. Pure functions, shared by the drivers that need them.

export function rgbToHs(r: number, g: number, b: number): [number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const s = max === 0 ? 0 : Math.round((d / max) * 255);
  if (d === 0) return [0, s];
  let h = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
  h = (h * 60 + 360) % 360;
  return [Math.round((h / 360) * 255) % 256, s];
}

export function hsToRgb(h: number, s: number): [number, number, number] {
  const hh = ((h / 255) * 360) % 360;
  const ss = s / 255;
  const c = 255 * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = 255 - c;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round(r + m), Math.round(g + m), Math.round(b + m)];
}
