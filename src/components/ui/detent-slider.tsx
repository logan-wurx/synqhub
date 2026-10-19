// A wide fader with magnetic detents: drag near one of the usual values (400, 800, 1600, 3200 DPI) and the thumb
// pulls onto it; the detents are marked and named under the track, and a name is a button that jumps there. Adapted
// from ddoemonn's Slider Detents on 21st.dev: the carriage that springs to the value (the fill and the thumb ride one
// translated layer), Shift with an arrow or Page Up/Down to go detent to detent. Changed for SYNQ: a log scale for
// wide ranges, the orange fill and a light fader cap, a value bubble while dragging, and nothing sent until release
// (`onCommit`), like every slider that writes to a device.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AnimatePresence, motion, useMotionTemplate, useReducedMotion, useSpring } from "motion/react";
import { cn } from "@/lib/utils";

const CARRIAGE = { stiffness: 520, damping: 40, mass: 0.45 } as const;
const THUMB = 16;

const clamp = (min: number, max: number, v: number) => Math.min(max, Math.max(min, v));

export function DetentSlider({
  label,
  value,
  min,
  max,
  step,
  detents,
  curve = "linear",
  format = String,
  onCommit,
  disabled,
  className,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  detents: readonly number[];
  curve?: "linear" | "log";
  format?: (v: number) => string;
  onCommit: (v: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const track = useRef<HTMLDivElement>(null);
  const [v, setV] = useState(value);
  const [dragging, setDragging] = useState(false);
  // After a release the thumb stays where it was let go until the device reports that value, instead of springing back
  // to the old one while the write is under way. If the write never lands, it returns to what the device reports.
  const latest = useRef(value);
  latest.current = value;
  const held = useRef<number | null>(null);
  const release = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (dragging) return;
    if (held.current !== null && held.current !== value) return;
    held.current = null;
    setV(value);
  }, [value, dragging]);
  useEffect(() => () => window.clearTimeout(release.current), []);

  const log = curve === "log" && min > 0;
  const toShare = (n: number) => (max <= min ? 0 : clamp(0, 1, log ? Math.log(n / min) / Math.log(max / min) : (n - min) / (max - min)));
  const fromShare = (s: number) => (log ? min * Math.pow(max / min, s) : min + s * (max - min));
  const marks = useMemo(() => detents.filter((d) => d >= min && d <= max), [detents, min, max]);

  // Within this share of the track of a detent, the thumb snaps onto it.
  const PULL = 0.03;
  const fromX = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const s = clamp(0, 1, (clientX - r.left - THUMB / 2) / (r.width - THUMB));
    const near = marks.find((d) => Math.abs(toShare(d) - s) <= PULL);
    return near ?? clamp(min, max, Math.round(fromShare(s) / step) * step);
  };

  const carriage = useSpring(toShare(value) * 100, CARRIAGE);
  useEffect(() => {
    if (reduce) carriage.jump(toShare(v) * 100);
    else carriage.set(toShare(v) * 100);
  }, [v, reduce]); // eslint-disable-line react-hooks/exhaustive-deps
  const offset = useMotionTemplate`${carriage}%`;

  const commit = (n: number) => n !== value && onCommit(n);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    setDragging(true);
    setV(fromX(e.clientX));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const n = fromX(e.clientX);
    if (n !== v) setV(n);
  };
  const up = () => {
    if (!dragging) return;
    if (v !== value) {
      held.current = v;
      window.clearTimeout(release.current);
      release.current = window.setTimeout(() => {
        if (held.current === null) return;
        held.current = null;
        setV(latest.current);
      }, 2500);
    }
    setDragging(false);
    commit(v);
  };
  const toDetent = (dir: 1 | -1) => (dir > 0 ? marks.find((d) => d > v) ?? max : [...marks].reverse().find((d) => d < v) ?? min);
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const fwd = e.key === "ArrowRight" || e.key === "ArrowUp";
    const back = e.key === "ArrowLeft" || e.key === "ArrowDown";
    let n: number | null = null;
    if (fwd || back) n = e.shiftKey ? toDetent(fwd ? 1 : -1) : clamp(min, max, v + (fwd ? step : -step));
    else if (e.key === "PageUp") n = toDetent(1);
    else if (e.key === "PageDown") n = toDetent(-1);
    else if (e.key === "Home") n = min;
    else if (e.key === "End") n = max;
    if (n === null) return;
    e.preventDefault();
    setV(n);
  };

  return (
    <div className={cn("w-full select-none", disabled && "pointer-events-none opacity-60", className)}>
      <div
        ref={track}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={v}
        aria-valuetext={format(v)}
        aria-disabled={disabled || undefined}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
        onKeyUp={() => !dragging && commit(v)}
        className={cn("relative h-10 w-full touch-none rounded-control outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", dragging ? "cursor-grabbing" : "cursor-grab")}
      >
        {/* The track, filled up to the carriage. */}
        <div className="pointer-events-none absolute inset-x-0 top-[15px] h-[10px] overflow-hidden rounded-full bg-white/[0.1]">
          <div className="absolute inset-y-0" style={{ left: THUMB / 2, right: THUMB / 2 }}>
            <motion.div className="absolute inset-0" style={{ x: offset }}>
              <div className="absolute inset-y-0 right-full w-[4000px] bg-primary" />
            </motion.div>
          </div>
        </div>
        {/* The detents: a notch in the track for each. */}
        <div className="pointer-events-none absolute inset-y-0" style={{ left: THUMB / 2, right: THUMB / 2 }}>
          {marks.map((d) => (
            <span key={d} aria-hidden="true" className={cn("absolute top-[30px] h-[6px] w-[2px] -translate-x-1/2 rounded-full", d <= v ? "bg-primary/70" : "bg-white/25")} style={{ left: `${toShare(d) * 100}%` }} />
          ))}
        </div>
        {/* The fader cap, and the value over it while dragging. */}
        <div className="pointer-events-none absolute inset-y-0" style={{ left: THUMB / 2, right: THUMB / 2 }}>
          <motion.div className="absolute inset-0" style={{ x: offset }}>
            <motion.div
              className="absolute top-[5px] h-[30px] w-[16px] rounded-[8px] bg-[oklch(98%_0.004_60)] shadow-[0_4px_12px_rgb(0_0_0/0.5),inset_0_-2px_0_rgb(0_0_0/0.12)]"
              style={{ marginLeft: -THUMB / 2 }}
              initial={false}
              animate={{ scale: dragging && !reduce ? 1.1 : 1 }}
              transition={{ type: "spring", stiffness: 700, damping: 46, mass: 0.5 }}
            />
            <AnimatePresence>
              {dragging && (
                <motion.span
                  initial={{ opacity: 0, y: 6, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.95 }}
                  transition={{ type: "spring", stiffness: 500, damping: 32 }}
                  className="tabular absolute -top-8 -translate-x-1/2 whitespace-nowrap rounded-small bg-popover px-2.5 py-1 text-[13px] font-semibold text-high shadow-[0_8px_20px_rgb(0_0_0/0.5)] ring-1 ring-white/[0.12]"
                >
                  {format(v)}
                </motion.span>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      </div>
      {/* The detents' names: each a button that jumps there. */}
      <div className="relative mt-1 h-6" style={{ marginLeft: THUMB / 2, marginRight: THUMB / 2 }}>
        {marks.map((d) => (
          <button
            key={d}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onClick={() => {
              setV(d);
              commit(d);
            }}
            className={cn("tabular absolute -translate-x-1/2 rounded-tight px-1.5 py-0.5 text-[12px] transition-colors duration-300", d === v ? "font-semibold text-primary" : "text-medium hover:text-high")}
            style={{ left: `${toShare(d) * 100}%` }}
          >
            {format(d)}
          </button>
        ))}
      </div>
    </div>
  );
}
