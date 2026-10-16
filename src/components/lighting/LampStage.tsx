// The hero of a light's page: the light drawn as it looks (src/lib/lighting/stage.ts, from its model's form): a floor
// lamp's pole on its foot, a TV backlight round a dim TV, two light bars, a strip or neon rope in a wave, panels as a
// cluster of tiles, a light of one colour as a single glow. Each segment is lit in its colour (as the light reports it,
// or as just changed) and glows like the real thing. Tap or drag along the light to paint segments with the brush
// picked beside it; the arrow keys and Enter do the same. Which end each model counts from is UNVERIFIED.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { PaintBrush } from "@phosphor-icons/react";
import type { Rgb } from "@/lib/lighting/govee/frames";
import type { LampView } from "@/lib/lighting/lamp";
import { rgbOf } from "@/lib/lighting/saved";
import { formOf, segmentAt, segmentPath, stageGeometry } from "@/lib/lighting/stage";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/matte";
import { Swatch, css } from "./controls";

export { BRUSHES } from "./controls";

const UNLIT: Rgb = [38, 38, 44];

/** What a segment looks like: its colour, dimmed by its own brightness (the light's brightness drives the glow). */
const shown = (c: Rgb, segment: number): Rgb => {
  const k = 0.3 + 0.7 * (segment / 100);
  return [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];
};

/** What the stage reads of a light (any light: a Bluetooth lamp, a Wi-Fi light, a PC's RGB). */
export type StageView = Pick<LampView, "power" | "brightness" | "mode" | "segments" | "segmentBrightness">;

export function LampStage({
  view,
  segments,
  kind,
  brush,
  onBrush,
  brushes,
  onPaint,
  status,
  className,
}: {
  view: StageView | null;
  segments: number;
  /** The model's form ("floor-lamp", "tv", "bar", "strip", "neon", "panel"...): what the light is drawn as. */
  kind: string;
  brush: Rgb;
  onBrush: (c: Rgb) => void;
  /** The swatches offered as brushes ("#rrggbb"). */
  brushes: readonly string[];
  /** Null while the light can't be painted (not connected). */
  onPaint: ((colours: Rgb[]) => void) | null;
  /** A word over the light while it isn't lit by SYNQ: "Connecting", "Off", ... */
  status: string | null;
  className?: string;
}) {
  const g = useMemo(() => stageGeometry(formOf(kind, segments), segments), [kind, segments]);
  const single = g.form === "single";
  const tall = g.form === "lamp" || g.form === "bars";
  const lit = !!view && view.power !== false;
  const colours = Array.from({ length: segments }, (_, i) => (lit && view ? shown(view.segments[i] ?? UNLIT, view.segmentBrightness[i] ?? 100) : UNLIT));
  const glow = lit && view ? 0.25 + 0.55 * ((view.brightness ?? 60) / 100) : 0;
  const moving = view?.mode === "scene" || view?.mode === "diy" || view?.mode === "music";

  // Painting reads the latest colours (a stroke runs faster than the page redraws).
  const latest = useRef<readonly Rgb[]>(view?.segments ?? []);
  useEffect(() => {
    latest.current = view?.segments ?? [];
  }, [view?.segments]);
  const svg = useRef<SVGSVGElement>(null);
  const from = useRef<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);

  /** The segment under the pointer: near the light when hovering or starting, the nearest one while dragging. */
  const indexAt = (e: PointerEvent, dragging: boolean) => {
    const m = svg.current?.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return segmentAt(g, p.x, p.y, dragging ? Infinity : 30);
  };

  const paint = (to: number) => {
    if (!onPaint) return;
    const a = from.current ?? to;
    const next = Array.from({ length: segments }, (_, i) => latest.current[i] ?? UNLIT);
    for (let i = Math.min(a, to); i <= Math.max(a, to); i++) next[i] = brush;
    from.current = to;
    latest.current = next;
    onPaint(next);
  };

  const down = (e: PointerEvent<SVGSVGElement>) => {
    if (!onPaint) return;
    const i = indexAt(e, false);
    if (i === null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    from.current = null;
    paint(i);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const dragging = e.currentTarget.hasPointerCapture(e.pointerId);
    const i = indexAt(e, dragging);
    setHover(i);
    if (i !== null && dragging && i !== from.current) paint(i);
  };
  const up = (e: PointerEvent<SVGSVGElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    from.current = null;
  };
  const key = (e: KeyboardEvent) => {
    const at = cursor ?? 0;
    const step = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
    if (step) {
      e.preventDefault();
      setCursor(Math.max(0, Math.min(segments - 1, at + step)));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      from.current = null;
      paint(at);
      from.current = null;
    }
  };

  const mark = hover ?? cursor;
  const paths = g.segments.map((s) => segmentPath(g, s));
  const blur = g.stroke ? g.stroke * 1.6 : 14;
  const glowId = `stage-glow-${useId().replace(/:/g, "")}`;
  return (
    <Card className={className} innerClassName={cn("relative flex h-full gap-3 overflow-hidden p-4", !tall && !single && "flex-col")}>
      <div className="relative min-h-0 min-w-0 flex-1" data-testid="lamp-stage" data-mode={view?.mode ?? ""} data-form={g.form}>
        <svg
          ref={svg}
          viewBox={`0 0 ${g.width} ${g.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          tabIndex={onPaint && !single ? 0 : -1}
          aria-label={onPaint && !single ? "The light's segments: tap or drag to paint with the brush; arrow keys and Enter paint from the keyboard" : "The light"}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerLeave={() => setHover(null)}
          onKeyDown={key}
          onBlur={() => setCursor(null)}
          className={cn("absolute inset-0 h-full w-full touch-none overflow-visible rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring/70", onPaint && !single ? "cursor-crosshair" : "cursor-default")}
        >
          <defs>
            <filter id={glowId} filterUnits="userSpaceOnUse" x={-g.width} y={-g.height} width={g.width * 3} height={g.height * 3}>
              <feGaussianBlur stdDeviation={blur} />
            </filter>
          </defs>
          {/* The glow: the segments' colours, blurred behind the light like light on a wall; it breathes while the light
              runs a scene, an effect or music (the light moves the colours itself). */}
          <g
            aria-hidden="true"
            className="light-anim transition-opacity duration-700 ease-fluid"
            filter={`url(#${glowId})`}
            opacity={glow}
            style={{ animation: lit && moving ? "light-breathe 3.2s ease-in-out infinite" : undefined }}
          >
            {paths.map((d, i) =>
              g.stroke ? <path key={i} d={d} fill="none" stroke={css(colours[i])} strokeWidth={g.stroke * 3.2} strokeLinecap="round" /> : <path key={i} d={d} fill={css(colours[i])} />,
            )}
          </g>
          {/* The unlit parts: a lamp's foot, the TV and its stand, the bars' feet. */}
          {g.frame.map((d, i) => (
            <path key={i} d={d} fill={d.endsWith("Z") ? "#141418" : "none"} stroke="rgb(255 255 255 / 0.14)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {g.stroke > 0 && (
            <g aria-hidden="true" fill="none" stroke="#141418" strokeWidth={g.stroke + 6} strokeLinecap="round" strokeLinejoin="round">
              {paths.map((d, i) => (
                <path key={i} d={d} />
              ))}
            </g>
          )}
          {paths.map((d, i) =>
            g.stroke ? (
              <path key={i} d={d} fill="none" stroke={css(colours[i])} strokeWidth={g.stroke} strokeLinecap={i === 0 || i === segments - 1 ? "round" : "butt"} strokeLinejoin="round" className="transition-[stroke] duration-300 ease-fluid" />
            ) : (
              <path key={i} d={d} fill={css(colours[i])} stroke="rgb(255 255 255 / 0.12)" strokeWidth="1.5" strokeLinejoin="round" className="transition-[fill] duration-300 ease-fluid" />
            ),
          )}
          {mark !== null && onPaint && !single && (
            <path d={paths[mark]} fill="none" stroke="rgb(255 255 255 / 0.9)" strokeWidth={g.stroke ? g.stroke + 4 : 3} strokeOpacity={g.stroke ? 0.35 : 0.9} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
          )}
          {mark !== null && onPaint && !single && (
            <g pointerEvents="none">
              <rect x={g.segments[mark].mid[0] - 13} y={g.segments[mark].mid[1] - 27} width="26" height="16" rx="8" fill="rgb(0 0 0 / 0.7)" />
              <text x={g.segments[mark].mid[0]} y={g.segments[mark].mid[1] - 15.5} textAnchor="middle" fontSize="11" fill="white" className="tabular">
                {mark + 1}
              </text>
            </g>
          )}
        </svg>
        {onPaint && !status && !single && (
          <p className="pointer-events-none absolute left-1 top-0 flex items-center gap-1.5 text-[11.5px] text-muted-foreground/80">
            <PaintBrush size={12} /> Tap or drag to paint
          </p>
        )}
        {status && (
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-black/70 px-3 py-1 text-[12px] text-muted-foreground ring-1 ring-white/10 backdrop-blur-sm" data-testid="lamp-stage-status">
            {status}
          </span>
        )}
      </div>
      <div className={cn("flex shrink-0 items-center gap-2.5", tall ? "w-[64px] flex-col" : "flex-row", (!onPaint || single) && "hidden")}>
        <span className="grid size-8 shrink-0 place-items-center rounded-full ring-1 ring-white/15" style={{ background: css(brush) }} title="The brush" aria-hidden="true">
          <PaintBrush size={14} weight="bold" className="text-black/60 mix-blend-luminosity" />
        </span>
        <div role="group" className={cn("place-items-center gap-2 p-1", tall ? "grid grid-cols-2 overflow-y-auto" : "flex flex-wrap")} aria-label="Brushes">
          {brushes.map((h) => (
            <Swatch key={h} colour={h} label={`Brush ${h}`} size={22} selected={css(rgbOf(h)) === css(brush)} onClick={() => onBrush(rgbOf(h))} />
          ))}
        </div>
      </div>
    </Card>
  );
}
