// A slider drawn as a row of LED bars, like a level meter on a piece of hardware: the bars up to the value are lit
// orange, the rest dark. Point at it and the bars rise, dipping into a valley that follows the pointer. Adapted from
// shadcnspace's Equalizer Bar Slider on 21st.dev. Changed for SYNQ: the bars scale (transform) instead of animating
// their height, steps snap (DPI in 50s), it is a real slider for keyboards and screen readers, and nothing is sent
// while dragging: `onPreview` shows the value as it moves, `onCommit` hands it over on release or key up. `detents`
// (a mouse's own DPI steps) pull the value in as it nears one, eased so it glides onto the step and lets go again
// past it, and each gets a small tick under the bars.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from "motion/react";
import { cn } from "@/lib/utils";

const BARS = 34;
const PAD = 10;
const REST = 0.3;
const LIFTED = 1;
const VALLEY = 0.42;
const REACH = 120;
/** How near a detent (a share of the track) the pull starts. */
const PULL = 0.045;

const clamp = (min: number, max: number, v: number) => Math.min(max, Math.max(min, v));

export function BarSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onPreview,
  onCommit,
  curve = "linear",
  detents = [],
  className,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  /** The value while it moves (null when it stops). */
  onPreview?: (v: number | null) => void;
  onCommit: (v: number) => void;
  /** "log" spreads a wide range (DPI 100 to 26000) so the usual values sit in the middle. */
  curve?: "linear" | "log";
  /** Values the slider eases onto when it comes near them (a mouse's DPI steps). */
  detents?: readonly number[];
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [v, setV] = useState(value);
  useEffect(() => {
    if (!dragging.current) setV(value);
  }, [value]);
  const reduce = useReducedMotion();
  const pointer = useMotionValue(-REACH * 2);
  const smooth = useSpring(pointer, { damping: 30, stiffness: 320 });
  const lift = useSpring(0, { damping: 28, stiffness: 260 });
  const [width, setWidth] = useState(300);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const snap = (raw: number) => clamp(min, max, Math.round(raw / step) * step);
  const log = curve === "log" && min > 0;
  const toShare = (n: number) => (max <= min ? 0 : log ? Math.log(n / min) / Math.log(max / min) : (n - min) / (max - min));
  const marks = detents.filter((d) => d >= min && d <= max).map((d) => ({ d, s: toShare(d) }));
  // Near a detent the share is drawn in: the pull grows as the square of how close it is, so it eases onto the step
  // and meets the plain slider again at the edge of the pull (no jump either way).
  const magnet = (s: number) => {
    let best: { s: number; off: number } | null = null;
    for (const m of marks) {
      const off = s - m.s;
      if (Math.abs(off) < PULL && (!best || Math.abs(off) < Math.abs(best.off))) best = { s: m.s, off };
    }
    if (!best) return s;
    const t = Math.abs(best.off) / PULL;
    return best.s + best.off * t * t;
  };
  const fromShare = (s: number) => {
    const raw = log ? min * Math.pow(max / min, magnet(s)) : min + magnet(s) * (max - min);
    const near = marks.find((m) => Math.abs(m.d - raw) <= step / 2);
    return near ? near.d : snap(raw);
  };
  const fromX = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    return fromShare(clamp(0, 1, (clientX - r.left - PAD) / (r.width - PAD * 2)));
  };
  const show = (n: number) => {
    setV(n);
    onPreview?.(n);
  };
  const finish = (n: number) => {
    onPreview?.(null);
    if (n !== value) onCommit(n);
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    lift.set(1);
    show(fromX(e.clientX));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    pointer.set(e.clientX - r.left);
    if (!reduce) lift.set(1);
    if (dragging.current) {
      const n = fromX(e.clientX);
      if (n !== v) show(n);
    }
  };
  const up = () => {
    if (!dragging.current) return;
    dragging.current = false;
    finish(v);
  };
  const leave = () => {
    if (dragging.current) return;
    lift.set(0);
    pointer.set(-REACH * 2);
  };
  // The wheel walks the detents (the mouse's DPI steps), or a tenth of the range without any; the value goes to the
  // device once the wheel has been still for a moment, like a release.
  const latest = useRef({ v, value, marks, step, min, max, finish, show });
  latest.current = { v, value, marks, step, min, max, finish, show };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let timer: number | undefined;
    const wheel = (e: WheelEvent) => {
      const { v: now, marks: ms, step: st, min: lo, max: hi, show: s, finish: f } = latest.current;
      const dir = (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? -e.deltaY : e.deltaX) > 0 ? 1 : -1;
      const sorted = ms.map((m) => m.d).sort((a, b) => a - b);
      const next = sorted.length
        ? dir > 0
          ? (sorted.find((d) => d > now) ?? now)
          : ([...sorted].reverse().find((d) => d < now) ?? now)
        : clamp(lo, hi, Math.round((now + dir * Math.max(st, (hi - lo) / 10)) / st) * st);
      e.preventDefault();
      if (next === now) return;
      s(next);
      latest.current.v = next;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => f(latest.current.v), 450);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", wheel);
      window.clearTimeout(timer);
    };
  }, []);

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const big = Math.max(step, Math.round((max - min) / 10 / step) * step);
    const next =
      e.key === "ArrowRight" || e.key === "ArrowUp" ? v + step
      : e.key === "ArrowLeft" || e.key === "ArrowDown" ? v - step
      : e.key === "PageUp" ? v + big
      : e.key === "PageDown" ? v - big
      : e.key === "Home" ? min
      : e.key === "End" ? max
      : null;
    if (next === null) return;
    e.preventDefault();
    show(snap(next));
  };

  const share = clamp(0, 1, toShare(v));
  return (
    <div
      ref={box}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={v}
      aria-valuetext={format(v)}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={leave}
      onKeyDown={key}
      onKeyUp={() => finish(v)}
      onBlur={() => onPreview?.(null)}
      className={cn("relative flex h-[46px] cursor-pointer touch-none select-none items-end gap-[3px] rounded-control px-[10px] pb-[6px]", "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", className)}
    >
      {/* The detents: a tick under the bars at each, lit when the value sits on it. */}
      {marks.map((m) => (
        <span
          key={m.d}
          aria-hidden="true"
          className={cn("pointer-events-none absolute bottom-0 h-[3px] w-[3px] -translate-x-1/2 rounded-full transition-colors duration-300", m.d === v ? "bg-primary" : "bg-white/30")}
          style={{ left: `calc(${PAD}px + ${m.s} * (100% - ${PAD * 2}px))` }}
        />
      ))}
      {Array.from({ length: BARS }, (_, i) => (
        <Bar key={i} at={i / (BARS - 1)} lit={i / (BARS - 1) <= share + 1e-6} share={share} pointer={smooth} lift={lift} width={width} />
      ))}
    </div>
  );
}

function Bar({ at, lit, share, pointer, lift, width }: { at: number; lit: boolean; share: number; pointer: MotionValue<number>; lift: MotionValue<number>; width: number }) {
  const scaleY = useTransform([pointer, lift], ([x, l]: number[]) => {
    const bx = PAD + at * (width - PAD * 2);
    const d = Math.abs(x - bx);
    const valley = d < REACH ? (Math.cos((d / REACH) * Math.PI) + 1) / 2 : 0;
    const raised = LIFTED - valley * (LIFTED - VALLEY) + (lit ? Math.sin((at / Math.max(share, 0.01)) * Math.PI) * 0.12 : 0);
    return REST + (raised - REST) * l;
  });
  return <motion.span aria-hidden="true" className={cn("h-[34px] flex-1 origin-bottom rounded-full transition-colors duration-300", lit ? "bg-primary" : "bg-white/[0.16]")} style={{ scaleY }} />;
}
