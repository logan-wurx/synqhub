// EQ types and response math for drawing. The Rust side (src-tauri/src/eq.rs) is the authority
// for what may be written; this mirrors its biquad math so the curve matches what it checks.

export type FilterKind = "PK" | "LSC" | "HSC" | "LPQ" | "HPQ" | "NO";

export interface Filter {
  enabled: boolean;
  kind: FilterKind;
  freq: number;
  gain: number;
  q: number;
}

export interface EqState {
  preamp: number;
  filters: Filter[];
}

/** The EQ as the Sound page has it now (flat while bypassed), kept under EQ_CURVE_KEY for the Gear page's Sound tile. */
export interface EqCurve {
  eq: EqState;
  fs: number;
}
export const EQ_CURVE_KEY = "eq.curve";

export interface Limits {
  maxBoostDb: number;
  maxCutDb: number;
  preampRangeDb: [number, number];
  freqRangeHz: [number, number];
  qRange: [number, number];
  maxFilters: number;
  peakToleranceDb: number;
  sampleRateHz: number;
}

export const KIND_LABEL: Record<FilterKind, string> = {
  PK: "Peak",
  LSC: "Low shelf",
  HSC: "High shelf",
  LPQ: "Low-pass",
  HPQ: "High-pass",
  NO: "Notch",
};

export const hasGain = (kind: FilterKind) => kind === "PK" || kind === "LSC" || kind === "HSC";

type Coeffs = [number, number, number, number, number, number];

function coefficients(f: Filter, fs: number): Coeffs {
  const w0 = (2 * Math.PI * f.freq) / fs;
  const sin = Math.sin(w0);
  const cos = Math.cos(w0);
  const alpha = sin / (2 * f.q);
  const a = 10 ** (f.gain / 40);
  const sa = 2 * Math.sqrt(a) * alpha;
  switch (f.kind) {
    case "PK":
      return [1 + alpha * a, -2 * cos, 1 - alpha * a, 1 + alpha / a, -2 * cos, 1 - alpha / a];
    case "LSC":
      return [
        a * (a + 1 - (a - 1) * cos + sa),
        2 * a * (a - 1 - (a + 1) * cos),
        a * (a + 1 - (a - 1) * cos - sa),
        a + 1 + (a - 1) * cos + sa,
        -2 * (a - 1 + (a + 1) * cos),
        a + 1 + (a - 1) * cos - sa,
      ];
    case "HSC":
      return [
        a * (a + 1 + (a - 1) * cos + sa),
        -2 * a * (a - 1 + (a + 1) * cos),
        a * (a + 1 + (a - 1) * cos - sa),
        a + 1 - (a - 1) * cos + sa,
        2 * (a - 1 - (a + 1) * cos),
        a + 1 - (a - 1) * cos - sa,
      ];
    case "LPQ":
      return [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
    case "HPQ":
      return [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
    case "NO":
      return [1, -2 * cos, 1, 1 + alpha, -2 * cos, 1 - alpha];
  }
}

function magnitudeDb([b0, b1, b2, a0, a1, a2]: Coeffs, freq: number, fs: number): number {
  const w = (2 * Math.PI * freq) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2;
  const ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2;
  const di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

export function filterResponse(f: Filter, freqs: number[], fs: number): number[] {
  const c = coefficients(f, fs);
  return freqs.map((x) => magnitudeDb(c, x, fs));
}

/** Summed response of the enabled filters, without preamp. */
export function eqResponse(state: EqState, freqs: number[], fs: number): number[] {
  const out = new Array(freqs.length).fill(0);
  for (const f of state.filters) {
    if (!f.enabled) continue;
    const r = filterResponse(f, freqs, fs);
    for (let i = 0; i < out.length; i++) out[i] += r[i];
  }
  return out;
}

export function logFreqs(count: number, lo = 10, hi = 22000): number[] {
  const a = Math.log(lo), b = Math.log(hi);
  return Array.from({ length: count }, (_, i) => Math.exp(a + ((b - a) * i) / (count - 1)));
}

const PEAK_GRID = logFreqs(1025);

/** Highest net gain (preamp + filters); mirrors eq::peak_db. */
export function peakDb(state: EqState, fs: number): number {
  const freqs = PEAK_GRID.concat(state.filters.map((f) => f.freq));
  return state.preamp + Math.max(...eqResponse(state, freqs, fs));
}

/**
 * The preamp that puts the net peak at 0 dB, rounded down to 0.1 dB. Never positive: an EQ that
 * only cuts keeps the preamp at 0 rather than raising the volume.
 */
export function autoPreamp(state: EqState, fs: number): number {
  const boost = peakDb({ ...state, preamp: 0 }, fs);
  if (boost <= 0) return 0;
  return -Math.ceil(boost * 10 - 1e-9) / 10;
}

export const round = (v: number, step: number) => Math.round(v / step) * step;

export function formatHz(hz: number): string {
  if (hz >= 1000) {
    const k = hz / 1000;
    return `${k >= 10 ? k.toFixed(1).replace(/\.0$/, "") : k.toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}k`;
  }
  return `${Math.round(hz)}`;
}

export const formatDb = (db: number) => `${db > 0 ? "+" : ""}${db.toFixed(1)}`;
