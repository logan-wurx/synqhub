// The Sound tile's picture on the Gear page: the EQ you have on now, as a curve in the accent over a faint grid. It
// reads what the Sound page keeps (src/lib/eq.ts EQ_CURVE_KEY); before that page has read the EQ, a flat line.
import { useMemo } from "react";
import { EQ_CURVE_KEY, eqResponse, logFreqs, type EqCurve } from "@/lib/eq";
import { useKeptState } from "@/lib/keep";

const W = 400;
const H = 220;
/** The drawing's range: ±12 dB around the middle line. */
const RANGE_DB = 12;
const FREQS = logFreqs(96, 20, 20000);

export function EqTileArt({ className }: { className?: string }) {
  const [curve] = useKeptState<EqCurve | null>(EQ_CURVE_KEY, null);
  const d = useMemo(() => {
    const db = curve ? eqResponse(curve.eq, FREQS, curve.fs) : FREQS.map(() => 0);
    const y = (v: number) => H / 2 - (Math.max(-RANGE_DB, Math.min(RANGE_DB, v)) / RANGE_DB) * (H / 2 - 16);
    return db.map((v, i) => `${i ? "L" : "M"}${((i / (FREQS.length - 1)) * W).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  }, [curve]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} preserveAspectRatio="none" role="img" aria-label="Your EQ curve">
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="rgb(255 255 255 / 0.07)" strokeWidth={f === 0.5 ? 1.2 : 1} vectorEffect="non-scaling-stroke" />
      ))}
      {[0.2, 0.4, 0.6, 0.8].map((f) => (
        <line key={f} y1={0} y2={H} x1={W * f} x2={W * f} stroke="rgb(255 255 255 / 0.05)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
      <path d={`${d}L${W} ${H}L0 ${H}Z`} fill="var(--primary)" opacity={0.08} />
      <path d={d} fill="none" stroke="var(--primary)" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
