// Frequency-response graph. Drag a node to move its frequency/gain, scroll over the graph to
// change the selected filter's Q, double-click empty space to add a peak filter.
//
// The orange curve is the EQ shape without preamp. The dashed line sits at -preamp: the shape
// may touch it but crossing it means the output would exceed 0 dB (clip).
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { filterResponse, formatDb, formatHz, hasGain, logFreqs, round, type EqState, type Filter, type Limits } from "@/lib/eq";

const F_MIN = 20;
const F_MAX = 20000;
const DB_MIN = -18;
const DB_MAX = 9;
const M = { left: 34, right: 10, top: 10, bottom: 22 };
const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const FREQ_MINOR = [30, 40, 60, 70, 80, 90, 300, 400, 600, 700, 800, 900, 3000, 4000, 6000, 7000, 8000, 9000];
const POINTS = 360;
const CURVE_CACHE = 64;

interface EqGraphProps {
  state: EqState;
  limits: Limits;
  selected: number | null;
  markers: number[];
  onSelect: (index: number | null) => void;
  onFilterChange: (index: number, patch: Partial<Filter>) => void;
  onAdd: (filter: Filter) => void;
  onCommit: () => void;
  height?: number;
}

export function EqGraph({ state, limits, selected, markers, onSelect, onFilterChange, onAdd, onCommit, height = 300 }: EqGraphProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(800);
  const [dragging, setDragging] = useState<number | null>(null);
  // The Hz/dB readout re-renders on its own, so moving over the graph doesn't redraw the graph.
  const showCursor = useRef<(text: string | null) => void>(() => {});
  const fs = limits.sampleRateHz;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // The Sound page stays mounted while hidden, where it measures 0 wide: keep the last real width then (a
    // negative plot width would draw a negative <rect>), and take the new one when it's shown again.
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = width - M.left - M.right;
  const plotH = height - M.top - M.bottom;
  const lf0 = Math.log(F_MIN), lf1 = Math.log(F_MAX);
  const x = (f: number) => M.left + ((Math.log(f) - lf0) / (lf1 - lf0)) * plotW;
  const y = (db: number) => M.top + ((DB_MAX - Math.max(DB_MIN - 3, Math.min(DB_MAX + 3, db))) / (DB_MAX - DB_MIN)) * plotH;
  const fAt = (px: number) => Math.exp(lf0 + ((px - M.left) / plotW) * (lf1 - lf0));
  const dbAt = (py: number) => DB_MAX - ((py - M.top) / plotH) * (DB_MAX - DB_MIN);

  const freqs = useMemo(() => logFreqs(POINTS, F_MIN, F_MAX), []);
  // Each band's curve is kept by its values, so dragging one band recomputes one curve, not all.
  const cache = useRef<{ fs: number; curves: Map<string, number[]> }>({ fs, curves: new Map() });
  if (cache.current.fs !== fs || cache.current.curves.size > CURVE_CACHE) cache.current = { fs, curves: new Map() };
  const curveOf = (f: Filter) => {
    const key = `${f.kind} ${f.freq} ${f.gain} ${f.q}`;
    let c = cache.current.curves.get(key);
    if (!c) cache.current.curves.set(key, (c = filterResponse(f, freqs, fs)));
    return c;
  };
  // Same sum as eqResponse (enabled bands, in order, from 0), from the kept curves.
  const total = useMemo(() => {
    const out = new Array<number>(freqs.length).fill(0);
    for (const f of state.filters) {
      if (!f.enabled) continue;
      const r = curveOf(f);
      for (let i = 0; i < out.length; i++) out[i] += r[i];
    }
    return out;
    // curveOf reads the cache, which follows fs and freqs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.filters, freqs, fs]);
  const path = (values: number[]) => values.map((v, i) => `${i ? "L" : "M"}${x(freqs[i]).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const totalPath = useMemo(() => path(total), [total, plotW, plotH]); // eslint-disable-line react-hooks/exhaustive-deps
  const bandPaths = useMemo(
    () => state.filters.map((f) => (f.enabled ? path(curveOf(f)) : null)),
    [state.filters, plotW, plotH, fs], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const areaPath = `${totalPath}L${x(F_MAX)},${y(0)}L${x(F_MIN)},${y(0)}Z`;
  const clipDb = -state.preamp;
  const clipping = total.some((v) => v > clipDb + limits.peakToleranceDb);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };
  const snapFreq = (f: number) => {
    const clamped = Math.max(F_MIN, Math.min(F_MAX, f));
    return clamped < 1000 ? Math.round(clamped) : round(clamped, 10);
  };
  const clampGain = (g: number) => Number(Math.max(limits.maxCutDb, Math.min(limits.maxBoostDb, g)).toFixed(1));

  // Wheel needs a non-passive listener to stop the page from scrolling.
  const nodeAt = (i: number) => {
    const f = state.filters[i];
    return { x: x(Math.max(F_MIN, Math.min(F_MAX, f.freq))), y: y(hasGain(f.kind) ? f.gain : 0) };
  };
  const wheelState = useRef({ selected, state, limits, nodeAt });
  wheelState.current = { selected, state, limits, nodeAt };
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    let timer: number | undefined;
    const onWheel = (e: WheelEvent) => {
      const { selected: sel, state: s, limits: l, nodeAt } = wheelState.current;
      if (sel === null || !s.filters[sel]) return;
      // Only steal the wheel near the selected point; anywhere else the page scrolls.
      const r = svg.getBoundingClientRect();
      const node = nodeAt(sel);
      if (Math.hypot(e.clientX - r.left - node.x, e.clientY - r.top - node.y) > 48) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      const q = Number(Math.max(l.qRange[0], Math.min(l.qRange[1], s.filters[sel].q * factor)).toFixed(2));
      onFilterChange(sel, { q });
      window.clearTimeout(timer);
      timer = window.setTimeout(onCommit, 350);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [onFilterChange, onCommit]);

  const onNodeDown = (index: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    onSelect(index);
    setDragging(index);
  };

  const onMove = (e: React.PointerEvent) => {
    const { px, py } = local(e);
    const inside = px >= M.left && px <= width - M.right && py >= M.top && py <= height - M.bottom;
    showCursor.current(inside ? `${formatHz(fAt(px))} Hz · ${formatDb(dbAt(py))} dB` : null);
    if (dragging === null) return;
    const f = state.filters[dragging];
    const patch: Partial<Filter> = { freq: snapFreq(fAt(px)) };
    if (hasGain(f.kind)) patch.gain = clampGain(dbAt(py));
    onFilterChange(dragging, patch);
  };

  const onUp = () => {
    if (dragging !== null) {
      setDragging(null);
      onCommit();
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (state.filters.length >= limits.maxFilters) return;
    const { px, py } = local(e);
    onAdd({ enabled: true, kind: "PK", freq: snapFreq(fAt(px)), gain: clampGain(dbAt(py)), q: 1.41 });
  };

  const dbTicks: number[] = [];
  for (let d = DB_MIN; d <= DB_MAX; d += 3) dbTicks.push(d);

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg
        ref={svgRef}
        width={width}
        height={height}
        className="block touch-none"
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => showCursor.current(null)}
        onPointerDown={() => onSelect(null)}
        onDoubleClick={onDoubleClick}
      >
        <defs>
          <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.04" />
          </linearGradient>
          <filter id="eq-glow" x="-10%" y="-50%" width="120%" height="200%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <clipPath id="plot">
            <rect x={M.left} y={M.top} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        {/* grid */}
        {FREQ_MINOR.map((f) => (
          <line key={`m${f}`} x1={x(f)} x2={x(f)} y1={M.top} y2={M.top + plotH} stroke="var(--foreground)" strokeOpacity="0.04" />
        ))}
        {FREQ_TICKS.map((f) => (
          <g key={f}>
            <line x1={x(f)} x2={x(f)} y1={M.top} y2={M.top + plotH} stroke="var(--foreground)" strokeOpacity="0.09" />
            <text x={x(f)} y={height - 6} textAnchor="middle" className="fill-muted-foreground text-[11px]">
              {formatHz(f)}
            </text>
          </g>
        ))}
        {dbTicks.map((d) => (
          <g key={d}>
            <line
              x1={M.left}
              x2={M.left + plotW}
              y1={y(d)}
              y2={y(d)}
              stroke="var(--foreground)"
              strokeOpacity={d === 0 ? 0.22 : 0.06}
            />
            {d % 6 === 0 && (
              <text x={M.left - 6} y={y(d) + 3} textAnchor="end" className="fill-muted-foreground text-[11px]">
                {d > 0 ? `+${d}` : d}
              </text>
            )}
          </g>
        ))}

        <g clipPath="url(#plot)">
          {/* band-finder marks */}
          {markers.map((f) => (
            <g key={`mk${f}`}>
              <line x1={x(f)} x2={x(f)} y1={M.top} y2={M.top + plotH} stroke="var(--chart-3)" strokeOpacity="0.55" strokeDasharray="2 3" />
              <text x={x(f) + 5} y={M.top + 12} className="fill-chart-3 text-[11px]">
                {formatHz(f)}
              </text>
            </g>
          ))}

          {/* clip line */}
          <line
            x1={M.left}
            x2={M.left + plotW}
            y1={y(clipDb)}
            y2={y(clipDb)}
            stroke={clipping ? "var(--destructive)" : "var(--chart-4)"}
            strokeOpacity={clipping ? 0.9 : 0.5}
            strokeDasharray="5 4"
          />
          <text x={M.left + plotW - 6} y={y(clipDb) - 6} textAnchor="end" className={cn("text-[11px]", clipping ? "fill-destructive" : "fill-muted-foreground")}>
            {clipping ? "Clipping" : "Clip point"}
          </text>

          {/* individual filters */}
          {state.filters.map((f, i) =>
            f.enabled ? (
              <path
                key={i}
                d={bandPaths[i] ?? undefined}
                fill="none"
                stroke={i === selected ? "var(--foreground)" : "var(--foreground)"}
                strokeOpacity={i === selected ? 0.55 : 0.1}
                strokeWidth={i === selected ? 1.5 : 1}
              />
            ) : null,
          )}

          <path d={areaPath} fill="url(#eq-fill)" />
          <path d={totalPath} fill="none" stroke="var(--primary)" strokeWidth="2.4" strokeLinejoin="round" filter="url(#eq-glow)" />
        </g>

        {/* nodes */}
        {state.filters.map((f, i) => {
          const cx = x(Math.max(F_MIN, Math.min(F_MAX, f.freq)));
          const cy = y(hasGain(f.kind) ? f.gain : 0);
          const isSel = i === selected;
          return (
            <g key={`n${i}`} onPointerDown={onNodeDown(i)} className="cursor-grab active:cursor-grabbing">
              <circle cx={cx} cy={cy} r={14} fill="transparent" />
              {isSel && <circle cx={cx} cy={cy} r={13} fill="var(--primary)" fillOpacity="0.18" />}
              <circle
                cx={cx}
                cy={cy}
                r={isSel ? 7.5 : 6}
                fill={f.enabled ? (isSel ? "#ffffff" : "#110f0e") : "#1d1a18"}
                stroke={f.enabled ? (isSel ? "#ffffff" : "var(--primary)") : "rgb(255 255 255 / 0.25)"}
                strokeWidth="2"
              />
              <text x={cx} y={cy - 13} textAnchor="middle" className="pointer-events-none fill-muted-foreground text-[10.5px]">
                {i + 1}
              </text>
            </g>
          );
        })}
      </svg>

      <CursorReadout bind={showCursor} />
    </div>
  );
}

/** The Hz/dB chip in the corner. Only re-renders when its text changes. */
function CursorReadout({ bind }: { bind: React.RefObject<(text: string | null) => void> }) {
  const [text, setText] = useState<string | null>(null);
  bind.current = setText;
  if (!text) return null;
  return (
    <div className="tabular pointer-events-none absolute right-4 top-3 rounded-full bg-shade/50 px-3 py-1 text-[11.5px] text-medium ring-1 ring-white/[0.06]">
      {text}
    </div>
  );
}
