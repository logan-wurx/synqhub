// Equalizer Bar Slider, adapted from shadcnspace's "slider-05" (21st.dev).
// Changes for SYNQ: controlled value, fractional steps, a bipolar fill that grows from zero
// (boost in primary, cut in teal), a compact fixed-height track, pointer capture instead of
// window listeners, and keyboard support.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform, type MotionValue } from "motion/react";
import NumberFlow from "@number-flow/react";
import { cn } from "@/lib/utils";

interface EqBarSliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Fires continuously while dragging. */
  onChange: (value: number) => void;
  /** Fires once when a drag or key press finishes. */
  onCommit?: (value: number) => void;
  unit?: string;
  /** Show a + on positive values in the tooltip (dB gains). Off for plain levels like brightness. */
  signed?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

const PADDING = 10;
const BARS = 36;

export function EqBarSlider({
  value,
  min,
  max,
  step = 0.1,
  onChange,
  onCommit,
  unit = "dB",
  signed = true,
  disabled,
  className,
  ...aria
}: EqBarSliderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(200);
  const [hovering, setHovering] = useState(false);
  const [dragging, setDragging] = useState(false);
  const mouseX = useMotionValue(0);
  const smoothX = useSpring(mouseX, { damping: 20, stiffness: 300 });
  const active = !disabled && (hovering || dragging);
  const decimals = step < 1 ? 1 : 0;

  // Measured before the first paint, so a page that mounts again (pages unmount while hidden)
  // never shows a frame laid out for the placeholder width.
  useLayoutEffect(() => {
    if (containerRef.current) setWidth(containerRef.current.offsetWidth);
  }, []);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toValue = (x: number) => {
    const pct = Math.max(0, Math.min(1, (x - PADDING) / (width - PADDING * 2)));
    const raw = min + pct * (max - min);
    return Number((Math.round(raw / step) * step).toFixed(decimals));
  };
  const toPct = (v: number) => (v - min) / (max - min);
  const zero = toPct(Math.max(min, Math.min(max, 0)));
  const current = toPct(value);

  const localX = (e: React.PointerEvent) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    const x = localX(e);
    mouseX.set(x);
    const v = toValue(x);
    if (v !== value) onChange(v);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (disabled) return;
    const x = localX(e);
    mouseX.set(x);
    if (dragging) {
      const v = toValue(x);
      if (v !== value) onChange(v);
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    onCommit?.(value);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const big = e.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + step * big;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - step * big;
    if (e.key === "Home") next = min;
    if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    next = Number(Math.max(min, Math.min(max, next)).toFixed(decimals));
    onChange(next);
    onCommit?.(next);
  };

  const tooltipLeft = useTransform(smoothX, [0, width], ["0%", "100%"]);
  const boost = value >= 0;

  return (
    <div className={cn("relative w-full", className)}>
      <AnimatePresence>
        {active && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.85 }}
            animate={{ opacity: 1, y: -34, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.85 }}
            transition={{ type: "spring", damping: 15, stiffness: 400 }}
            className="tabular pointer-events-none absolute top-0 z-30 flex items-center gap-1 rounded-full bg-[#1d1d22] px-2.5 py-1 text-[12px] text-foreground shadow-[0_8px_20px_-6px_rgb(0_0_0/0.7)] ring-1 ring-white/10"
            style={{ left: dragging ? `${current * 100}%` : tooltipLeft, translateX: "-50%" }}
          >
            <NumberFlow value={value} format={{ minimumFractionDigits: decimals, maximumFractionDigits: decimals, signDisplay: signed ? "exceptZero" : "auto" }} />
            <span className="text-muted-foreground">{unit}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        ref={containerRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-disabled={disabled}
        {...aria}
        className={cn(
          "relative flex h-10 cursor-pointer touch-none select-none items-end overflow-hidden rounded-full bg-black/30 px-4 pb-2.5 shadow-[inset_0_2px_6px_rgb(0_0_0/0.5)] outline-none ring-1 ring-white/[0.06]",
          "focus-visible:ring-primary/60",
          disabled && "cursor-default opacity-40",
        )}
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => setHovering(false)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className="flex w-full items-end gap-[3px]">
          {Array.from({ length: BARS }).map((_, i) => {
            const p = i / (BARS - 1);
            const filled = boost ? p >= zero - 1e-9 && p <= current + 1e-9 : p <= zero + 1e-9 && p >= current - 1e-9;
            return (
              <Bar
                key={i}
                position={p}
                mouseX={smoothX}
                active={active}
                width={width}
                filled={filled}
                isZero={Math.abs(p - zero) < 0.5 / (BARS - 1)}
                tone={boost ? "boost" : "cut"}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Bar({
  position,
  mouseX,
  active,
  width,
  filled,
  isZero,
  tone,
}: {
  position: number;
  mouseX: MotionValue<number>;
  active: boolean;
  width: number;
  filled: boolean;
  isZero: boolean;
  tone: "boost" | "cut";
}) {
  const height = useTransform(mouseX, (x: number) => {
    const rest = isZero ? 14 : 8;
    if (!active) return rest;
    const barX = PADDING + position * (width - PADDING * 2);
    const distance = Math.abs(x - barX);
    const reach = 70;
    const lifted = 18;
    if (distance >= reach) return Math.max(rest, lifted - 6);
    const dip = (Math.cos((distance / reach) * Math.PI) + 1) / 2;
    return lifted - dip * 8;
  });
  const smooth = useSpring(height, { damping: 35, stiffness: 300 });
  return (
    <motion.div
      style={{ height: smooth }}
      className={cn(
        "flex-1 rounded-full transition-colors duration-300",
        filled ? (tone === "boost" ? "bg-primary shadow-[0_0_6px_var(--primary)]" : "bg-secondary shadow-[0_0_6px_var(--secondary)]") : isZero ? "bg-white/40" : "bg-white/[0.09]",
      )}
    />
  );
}
