// A lamp page's Segments tab: a gradient across two to six colours (each stop edited on the wheel, the lamp following
// live), ready-made and saved gradients, and each segment's own brightness. Painting single segments is on the lamp
// drawing itself (LampStage).
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowsLeftRight, FloppyDisk, Minus, Plus } from "@phosphor-icons/react";
import { gradient, type Rgb } from "@/lib/lighting/govee/frames";
import type { LampControl, LampView } from "@/lib/lighting/lamp";
import { forgetGradient, hexOf, rgbOf, saveGradient, useLightingKeep } from "@/lib/lighting/saved";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "@/components/ui/matte";
import { ColourWheel } from "./ColourWheel";
import { IconButton, SubHead, Swatch, css } from "./controls";

const PRESETS: readonly { name: string; stops: readonly string[] }[] = [
  { name: "Sunset", stops: ["#ff3c00", "#ff8a3d", "#ff2a8a"] },
  { name: "Ocean", stops: ["#002aff", "#00b3ff", "#00ffd5"] },
  { name: "Aurora", stops: ["#00ff8a", "#00c8ff", "#a12aff"] },
  { name: "Fire", stops: ["#ff1a00", "#ff7a00", "#ffd000"] },
  { name: "Forest", stops: ["#0a5c00", "#3dff5a", "#d4ff3d"] },
  { name: "Candy", stops: ["#ff2ad4", "#8a2aff", "#2a8aff"] },
  { name: "Ice", stops: ["#ffffff", "#9ae6ff", "#2a5bff"] },
];

const MAX_STOPS = 6;
const bar = (stops: readonly Rgb[], n: number) => `linear-gradient(to right, ${gradient(stops, n).map(css).join(", ")})`;

export function SegmentsTab({ control, view, segments }: { control: LampControl; view: LampView; segments: number }) {
  const keep = useLightingKeep();
  const [stops, setStops] = useState<Rgb[]>(() => PRESETS[0].stops.map(rgbOf));
  const [at, setAt] = useState(0);

  const apply = (next: Rgb[], select = at) => {
    setStops(next);
    setAt(Math.min(select, next.length - 1));
    control.setGradient(next);
  };

  return (
    <>
      <Card innerClassName="pb-5">
        <CardHeader title="Gradient" hint={`Two to ${MAX_STOPS} colours, spread over the ${segments} segments from the bottom up. Pick a stop, then its colour.`} />
        <div className="mt-4 flex flex-col gap-4 px-5">
          <div className="h-4 w-full rounded-full ring-1 ring-white/10" style={{ background: bar(stops, segments) }} aria-hidden="true" />
          <div className="flex flex-wrap items-center gap-2">
            {stops.map((c, i) => (
              <Swatch key={i} colour={css(c)} label={`Stop ${i + 1}: ${hexOf(c)}`} selected={i === at} onClick={() => setAt(i)} size={28} />
            ))}
            <span className="mx-1 h-5 w-px bg-white/10" aria-hidden="true" />
            <IconButton label="Add a stop" disabled={stops.length >= MAX_STOPS} onClick={() => apply([...stops, stops[stops.length - 1]], stops.length)}>
              <Plus size={14} />
            </IconButton>
            <IconButton label="Remove the picked stop" disabled={stops.length <= 2} onClick={() => apply(stops.filter((_, i) => i !== at))}>
              <Minus size={14} />
            </IconButton>
            <IconButton label="Reverse" onClick={() => apply([...stops].reverse(), stops.length - 1 - at)}>
              <ArrowsLeftRight size={14} />
            </IconButton>
            <IconButton label="Save this gradient" onClick={() => saveGradient(stops)}>
              <FloppyDisk size={14} />
            </IconButton>
          </div>
          <div className="grid grid-cols-[minmax(130px,200px)_minmax(0,1fr)] items-start gap-6">
            <ColourWheel value={stops[at]} onChange={(c) => apply(stops.map((s, i) => (i === at ? c : s)))} />
            <div className="flex min-w-0 flex-col gap-3">
              <SubHead>Ready-made</SubHead>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <GradientChip key={p.name} name={p.name} stops={p.stops} onClick={() => apply(p.stops.map(rgbOf), 0)} />
                ))}
              </div>
              {keep.gradients.length > 0 && (
                <>
                  <SubHead>Saved</SubHead>
                  <div className="flex flex-wrap gap-2">
                    {keep.gradients.map((g, i) => (
                      <GradientChip key={g.join()} name={`Saved ${i + 1}`} stops={g} onClick={() => apply(g.map(rgbOf), 0)} onRemove={() => forgetGradient(i)} />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </Card>
      {control.dialect === 0x15 && <Card innerClassName="pb-5">
        <CardHeader title="Segment brightness" hint="Each segment's own brightness, on top of the light's. Drag across the bars to shape it." />
        <SegmentBars values={view.segmentBrightness} colours={view.segments} onChange={(i, v) => control.setSegmentBrightness(v, 1 << i)} />
      </Card>}
    </>
  );
}

function GradientChip({ name, stops, onClick, onRemove }: { name: string; stops: readonly string[]; onClick: () => void; onRemove?: () => void }) {
  return (
    <span className="group/chip relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-2 rounded-full bg-white/[0.04] py-1 pl-1 pr-3 text-[12.5px] text-medium ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.08] hover:text-high"
      >
        <span className="h-4 w-8 rounded-full ring-1 ring-white/15" style={{ background: `linear-gradient(to right, ${stops.join(", ")})` }} />
        {name}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Forget ${name}`}
          className="absolute -right-1 -top-1.5 hidden size-4 place-items-center rounded-full bg-[#1d1d22] text-[10px] leading-none text-medium ring-1 ring-white/15 hover:text-high group-hover/chip:grid group-focus-within/chip:grid"
        >
          ×
        </button>
      )}
    </span>
  );
}

/** A bar per segment (segment 1 on the left), its height its brightness. Drag across them, or use the arrow keys. */
function SegmentBars({ values, colours, onChange }: { values: readonly number[]; colours: readonly Rgb[]; onChange: (segment: number, percent: number) => void }) {
  const row = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<number | null>(null);

  const at = (e: PointerEvent) => {
    const r = row.current?.getBoundingClientRect();
    if (!r) return null;
    const i = Math.floor(((e.clientX - r.left) / r.width) * values.length);
    const v = Math.round(((r.bottom - e.clientY) / r.height) * 100);
    return { i: Math.max(0, Math.min(values.length - 1, i)), v: Math.max(0, Math.min(100, v)) };
  };
  const set = (e: PointerEvent) => {
    const p = at(e);
    if (p && p.v !== values[p.i]) onChange(p.i, p.v);
  };
  const key = (i: number) => (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 5;
    const v = e.key === "ArrowUp" ? values[i] + step : e.key === "ArrowDown" ? values[i] - step : e.key === "Home" ? 0 : e.key === "End" ? 100 : null;
    if (v === null) return;
    e.preventDefault();
    onChange(i, Math.max(0, Math.min(100, v)));
  };

  return (
    <div className="mt-4 px-5">
      <div
        ref={row}
        className="flex h-[132px] touch-none items-end gap-1.5"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          set(e);
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && set(e)}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      >
        {values.map((v, i) => (
          <div
            key={i}
            role="slider"
            tabIndex={0}
            aria-label={`Segment ${i + 1} brightness`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={v}
            onKeyDown={key(i)}
            onFocus={() => setFocus(i)}
            onBlur={() => setFocus(null)}
            className={cn("relative flex h-full flex-1 cursor-ns-resize items-end rounded-small bg-white/[0.04] ring-1 ring-white/[0.06] outline-none", focus === i && "ring-2 ring-ring")}
          >
            <span className="block w-full rounded-small transition-[height] duration-150" style={{ height: `${Math.max(v, 3)}%`, background: css(colours[i] ?? [255, 255, 255]), opacity: 0.35 + 0.65 * (v / 100) }} />
          </div>
        ))}
      </div>
      <div className="tabular mt-2 flex gap-1.5 text-center text-[10.5px] text-medium" aria-hidden="true">
        {values.map((v, i) => (
          <span key={i} className="min-w-0 flex-1 truncate" title={`${v}%`}>
            {i + 1}
          </span>
        ))}
      </div>
    </div>
  );
}
