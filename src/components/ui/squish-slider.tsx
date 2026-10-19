// A tall brightness pill you drag up and down, filled with the light's own colour, adapted from Motion's iOS slider
// (motiondotdev on 21st.dev). Pull past either end and the pill stretches and narrows like something soft, then springs
// back. Changed for SYNQ: controlled (value in, onChange and onCommit out), a real slider for keyboards and screen
// readers (arrows, Page Up/Down, Home/End on the element itself), the fill in any colour, the sun drawn so it reads on
// the fill and off it. Transforms only.
import { useEffect, useRef, type KeyboardEvent } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { Sun } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

const MAX_PULL = 18;
const SQUISH = 0.92;
const STRETCH = 1.07;

const clamp = (min: number, max: number, v: number) => Math.min(max, Math.max(min, v));

export function SquishSlider({
  label,
  value,
  min = 1,
  max = 100,
  fill,
  onChange,
  onCommit,
  format = (v) => `${v}%`,
  disabled,
  className,
  testId,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  /** The fill's CSS colour (the light's colour). */
  fill: string;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  format?: (v: number) => string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const reduce = useReducedMotion();
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const panned = useRef(false);
  const start = useRef({ y: 0, at: 0, top: 0, bottom: 0 });
  const toShare = (v: number) => (max > min ? (v - min) / (max - min) : 1);
  // The position as a share of the track; past 0 or 1 while pulled beyond an end.
  const share = useMotionValue(toShare(value));
  useEffect(() => {
    if (!dragging.current) share.set(toShare(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useTransform(() => clamp(0, 1, share.get()));
  const pull = useTransform(share, [-1, 0, 1, 2], [MAX_PULL, 0, 0, -MAX_PULL]);
  const scaleX = useTransform(pull, [-MAX_PULL, 0, MAX_PULL], [SQUISH, 1, SQUISH]);
  const scaleY = useTransform(pull, [-MAX_PULL, 0, MAX_PULL], [STRETCH, 1, STRETCH]);
  const iconX = useTransform(() => 1 / scaleX.get());
  const iconY = useTransform(() => 1 / scaleY.get());

  const emit = (s: number) => {
    const v = Math.round(min + clamp(0, 1, s) * (max - min));
    if (v !== value) onChange(v);
    return v;
  };
  const settle = () => {
    const s = share.get();
    if (s < 0 || s > 1) animate(share, clamp(0, 1, s), reduce ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 26 });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = e.key === "PageUp" || e.key === "PageDown" ? 10 : 1;
    let next: number | null = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight" || e.key === "PageUp") next = value + step;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "PageDown") next = value - step;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    const v = clamp(min, max, next);
    share.set(toShare(v));
    if (v !== value) onChange(v);
    onCommit?.(v);
  };

  return (
    <motion.div
      ref={track}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={format(value)}
      aria-disabled={disabled || undefined}
      aria-orientation="vertical"
      data-testid={testId}
      onKeyDown={onKeyDown}
      className={cn(
        "relative flex cursor-grab touch-none select-none flex-col items-center justify-end overflow-hidden rounded-[30px] bg-white/[0.07] pb-4 ring-1 ring-white/[0.1] active:cursor-grabbing",
        "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
      style={{ y: pull, scaleX, scaleY }}
      onTapStart={(e) => {
        const r = track.current?.getBoundingClientRect();
        if (!r) return;
        dragging.current = true;
        panned.current = false;
        const y = "clientY" in e ? e.clientY : 0;
        start.current = { y, at: r.bottom - share.get() * r.height, top: r.top, bottom: r.bottom };
      }}
      onTap={(e) => {
        dragging.current = false;
        // A click without a drag jumps there.
        if (panned.current) return;
        const { top, bottom } = start.current;
        const v = emit((bottom - ("clientY" in e ? e.clientY : bottom)) / (bottom - top));
        share.set(toShare(v));
        onCommit?.(v);
      }}
      onPanStart={() => {
        panned.current = true;
      }}
      onPan={(e) => {
        const { y, at, top, bottom } = start.current;
        const clientY = "clientY" in e ? e.clientY : y;
        const s = (bottom - (at + (clientY - y))) / (bottom - top);
        share.set(s);
        emit(s);
      }}
      onPanEnd={() => {
        dragging.current = false;
        const v = emit(share.get());
        settle();
        onCommit?.(v);
      }}
    >
      <motion.div aria-hidden="true" className="absolute inset-0 origin-bottom" style={{ scaleY: shown, background: fill }} />
      <motion.span aria-hidden="true" className="relative text-white mix-blend-difference" style={{ scaleX: iconX, scaleY: iconY }}>
        <Sun size={24} weight="fill" />
      </motion.span>
    </motion.div>
  );
}
