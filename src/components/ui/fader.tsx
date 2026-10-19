// Vertical fader with an LED segment column, in the spirit of the "Iso Fader" on 21st.dev
// (written for SYNQ). Bipolar: LEDs light from the zero line up (boost, orange) or down
// (cut, teal). Drag the cap, click the track, scroll, or use arrow keys.
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface FaderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  disabled?: boolean;
  height?: number;
  segments?: number;
  "aria-label"?: string;
}

const CAP = 18;

export function Fader({ value, min, max, step = 0.1, onChange, onCommit, disabled, height = 148, segments = 27, ...aria }: FaderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ startY: number; startValue: number } | null>(null);
  const decimals = step < 1 ? 1 : 0;
  const clamp = (v: number) => Number(Math.max(min, Math.min(max, Math.round(v / step) * step)).toFixed(decimals));
  const travel = height - CAP;
  const toY = (v: number) => ((max - v) / (max - min)) * travel;
  const zero = Math.max(min, Math.min(max, 0));
  const pct = (v: number) => (v - min) / (max - min);

  const fromPointer = (clientY: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return clamp(max - ((clientY - r.top - CAP / 2) / travel) * (max - min));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const onCap = (e.target as HTMLElement).dataset.cap === "1";
    if (onCap) {
      setDrag({ startY: e.clientY, startValue: value });
    } else {
      const v = fromPointer(e.clientY);
      onChange(v);
      setDrag({ startY: e.clientY, startValue: v });
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    // Shift drags at a fifth of the speed for fine moves.
    const scale = e.shiftKey ? 0.2 : 1;
    const v = clamp(drag.startValue - ((e.clientY - drag.startY) / travel) * (max - min) * scale);
    if (v !== value) onChange(v);
  };
  const onPointerUp = () => {
    if (!drag) return;
    setDrag(null);
    onCommit?.(value);
  };
  const onWheel = (e: React.WheelEvent) => {
    // Only a fader you clicked first takes the wheel, so scrolling the page never moves one.
    if (disabled || document.activeElement !== trackRef.current) return;
    const v = clamp(value + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 10 : 1));
    onChange(v);
    onCommit?.(v);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const big = e.shiftKey ? 10 : 1;
    let v: number | null = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") v = value + step * big;
    if (e.key === "ArrowDown" || e.key === "ArrowLeft") v = value - step * big;
    if (e.key === "Home") v = zero;
    if (v === null) return;
    e.preventDefault();
    const c = clamp(v);
    onChange(c);
    onCommit?.(c);
  };

  const lit = (i: number) => {
    // Segment i spans from the bottom; light it if it sits between zero and the value.
    const center = (i + 0.5) / segments;
    const lo = Math.min(pct(zero), pct(value));
    const hi = Math.max(pct(zero), pct(value));
    return center >= lo && center <= hi && Math.abs(value - zero) >= step / 2;
  };
  const boost = value >= zero;

  return (
    <div
      className={cn("flex select-none items-stretch gap-2", disabled && "opacity-40")}
      style={{ height }}
      onWheel={onWheel}
    >
      {/* LED column */}
      <div className="flex flex-col-reverse justify-between py-[9px]">
        {Array.from({ length: segments }).map((_, i) => {
          const isZero = Math.abs((i + 0.5) / segments - pct(zero)) < 0.5 / segments;
          return (
            <span
              key={i}
              className={cn(
                "block h-[2px] w-3 rounded-full transition-colors duration-200",
                lit(i)
                  ? boost
                    ? "bg-primary shadow-[0_0_8px_var(--primary)]"
                    : "bg-secondary shadow-[0_0_8px_var(--secondary)]"
                  : isZero
                    ? "w-4 bg-white/50"
                    : "bg-white/[0.07]",
              )}
            />
          );
        })}
      </div>

      {/* Track */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-orientation="vertical"
        {...aria}
        className="relative w-7 cursor-pointer touch-none rounded-full bg-shade/40 shadow-[inset_0_2px_6px_rgb(0_0_0/0.6)] outline-none ring-1 ring-white/[0.06] focus-visible:ring-primary/70"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className="absolute inset-y-3 left-1/2 w-px -translate-x-1/2 bg-white/[0.08]" />
        <div
          data-cap="1"
          className={cn(
            "absolute left-[3px] right-[3px] flex cursor-grab items-center justify-center rounded-full bg-gradient-to-b from-[#f4f4f6] to-[#b9b9c2] shadow-[0_4px_10px_rgb(0_0_0/0.55),inset_0_1px_0_rgb(255_255_255/0.9)] transition-transform duration-200 ease-fluid active:scale-95",
            drag && "cursor-grabbing",
          )}
          style={{ top: toY(value), height: CAP }}
        >
          <span data-cap="1" className="h-[2px] w-2.5 rounded-full bg-shade/35" />
        </div>
      </div>
    </div>
  );
}
