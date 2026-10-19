// Rotary dial with a tick ring, in the spirit of the "Angle Slider" on 21st.dev (written for
// SYNQ). Logarithmic, which suits Q. Drag up/down, scroll, or use arrow keys.
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface KnobProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  label?: string;
  decimals?: number;
  size?: number;
  disabled?: boolean;
}

const SWEEP = 270;
const TICKS = 25;

export function Knob({ value, min, max, onChange, onCommit, label = "Q", decimals = 2, size = 60, disabled }: KnobProps) {
  const [drag, setDrag] = useState<{ y: number; t: number } | null>(null);
  const dialRef = useRef<HTMLDivElement>(null);
  const lmin = Math.log(min), lmax = Math.log(max);
  const toT = (v: number) => (Math.log(Math.max(min, Math.min(max, v))) - lmin) / (lmax - lmin);
  const fromT = (t: number) => Number(Math.exp(lmin + Math.max(0, Math.min(1, t)) * (lmax - lmin)).toFixed(decimals));
  const t = toT(value);
  const angle = -SWEEP / 2 + t * SWEEP;
  const r = size / 2;

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ y: e.clientY, t });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const speed = e.shiftKey ? 0.0012 : 0.006;
    const v = fromT(drag.t + (drag.y - e.clientY) * speed);
    if (v !== value) onChange(v);
  };
  const onPointerUp = () => {
    if (!drag) return;
    setDrag(null);
    onCommit?.(value);
  };
  const nudge = (dir: number, big: boolean) => {
    const v = fromT(t + dir * (big ? 0.08 : 0.02));
    onChange(v);
    onCommit?.(v);
  };

  return (
    <div className={cn("flex flex-col items-center gap-1", disabled && "opacity-40")}>
      <div
        ref={dialRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        className="relative cursor-ns-resize touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ width: size, height: size }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // Only a dial you clicked first takes the wheel, so scrolling the page never turns one.
        onWheel={(e) => !disabled && document.activeElement === dialRef.current && nudge(e.deltaY < 0 ? 1 : -1, e.shiftKey)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowUp" || e.key === "ArrowRight") nudge(1, e.shiftKey);
          else if (e.key === "ArrowDown" || e.key === "ArrowLeft") nudge(-1, e.shiftKey);
          else return;
          e.preventDefault();
        }}
      >
        <svg width={size} height={size} className="absolute inset-0">
          {Array.from({ length: TICKS }).map((_, i) => {
            const tt = i / (TICKS - 1);
            const a = ((-SWEEP / 2 + tt * SWEEP - 90) * Math.PI) / 180;
            const on = tt <= t + 1e-6;
            const major = i % 6 === 0;
            const r1 = r - 1, r2 = r - (major ? 7 : 5);
            return (
              <line
                key={i}
                x1={r + r1 * Math.cos(a)}
                y1={r + r1 * Math.sin(a)}
                x2={r + r2 * Math.cos(a)}
                y2={r + r2 * Math.sin(a)}
                stroke={on ? "var(--primary)" : "var(--foreground)"}
                strokeOpacity={on ? 1 : 0.18}
                strokeWidth={major ? 1.6 : 1.1}
                strokeLinecap="round"
              />
            );
          })}
        </svg>
        <div
          className="absolute rounded-full bg-gradient-to-b from-[#2e2a27] to-[#151210] shadow-[0_6px_14px_rgb(0_0_0/0.6),inset_0_1px_0_rgb(255_255_255/0.12)] ring-1 ring-white/[0.06]"
          style={{ inset: 10, transform: `rotate(${angle}deg)` }}
        >
          <span className="absolute left-1/2 top-1 h-2 w-[2px] -translate-x-1/2 rounded-full bg-primary shadow-[0_0_6px_var(--primary)]" />
        </div>
        <span className="tabular pointer-events-none absolute inset-0 flex items-center justify-center text-[11.5px] text-high">
          {value.toFixed(decimals)}
        </span>
      </div>
      <span className="text-[11.5px] text-medium">{label}</span>
    </div>
  );
}
