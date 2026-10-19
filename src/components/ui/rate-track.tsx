// A level track for a rate: a pill with a tick for each option, a thumb that the options pull toward while it is
// dragged (magnetic detents) and that springs to the nearest one on release, carrying the drag's speed, and a field of
// ember pixels filling the track up to the thumb, denser, brighter and quicker the higher the rate. Adapted from
// zanwei's Claude Model Selector on 21st.dev (its magnet, its spring and its pixel field). Changed for SYNQ: a React
// control instead of a custom element, any number of options with their own labels, SYNQ's dark room and its ember
// dot display instead of violet, the field filling up to the thumb at every level (not only the top one), and the
// field moves only while SYNQ is the focused, visible window (15 frames a second), still with reduced motion.
// It is a real control: drag the thumb or anywhere on the track, click a level, turn the mouse wheel, or use the keys.
// A change is shown at once and held until the mouse confirms it; if it doesn't, the track goes back to what it runs.
import NumberFlow from "@number-flow/react";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a: number, b: number, v: number) => {
  const x = clamp((v - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const hash = (a: number, b: number, k1: number, k2: number, k3: number) => Math.abs(Math.sin(a * k1 + b * k2) * k3) % 1;

/** The welcome panel's embers, dark to light, and the light a hot pixel peaks at. */
const EMBER: [number, number, number][] = [
  [74, 22, 10],
  [120, 34, 14],
  [165, 46, 16],
  [214, 70, 34],
  [255, 94, 58],
];
const PEAK: [number, number, number] = [255, 150, 104];

/** Track geometry (px): the thumb (the DPI fader's cap) and the gap between it and the track's edge. */
const THUMB_W = 16;
const THUMB_H = 26;
const PAD = 2;
const TRACK_H = 30;
/** The spring the thumb settles on: critically damped, so it lands without a bounce. */
const K = 900;
const C = 2 * Math.sqrt(K);

export function RateTrack<T extends string | number>({
  label,
  options,
  value,
  format,
  unit,
  detail,
  figure,
  bare = false,
  onPreview,
  disabled = false,
  onChange,
  width = "fill",
  className,
}: {
  label: string;
  options: readonly T[];
  value: T;
  /** The option's text under its tick and in the header ("1K"). */
  format: (o: T) => string;
  /** After the value in the header ("Hz"). */
  unit?: string;
  /** A quiet line for the chosen option ("a report every 0.125 ms"). */
  detail?: (o: T) => string;
  /** The option as a number and a suffix for the header's rolling digits ([8, "K"]); without it the text is shown. */
  figure?: (o: T) => [number, string];
  /** No header (a card around it shows the label and the value, with onPreview). */
  bare?: boolean;
  /** The option the thumb is nearest, as it moves. */
  onPreview?: (o: T) => void;
  disabled?: boolean;
  /** Called once per change that sticks (a released drag, a click, the wheel or the keys at rest). */
  onChange: (o: T) => void;
  /** A width in px, or "fill" to take the width of its column (measured, so the field and the stops follow it). */
  width?: number | "fill";
  className?: string;
}) {
  const n = options.length;
  const at = Math.max(0, options.indexOf(value));
  const reduce = useReducedMotion();
  // `pos` is continuous (0 .. n-1) while the thumb is dragged or springing; `shown` is the option it is nearest.
  const [pos, setPos] = useState(at);
  const shown = clamp(Math.round(pos), 0, n - 1);
  const posRef = useRef(pos);
  posRef.current = pos;
  // Someone is moving it (a drag, the keys, the wheel, or the spring after them): what the mouse says waits.
  const busy = useRef(false);
  const dragging = useRef(false);
  const spring = useRef(0);
  const rest = useRef(0);
  const wheelTo = useRef(-1);
  const wheelAcc = useRef(0);
  const samples = useRef<{ t: number; v: number }[]>([]);
  const track = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // The latest props, for the timers and listeners that outlive a render.
  const live = useRef({ at, disabled, options, onChange });
  live.current = { at, disabled, options, onChange };
  // The option last sent to the mouse and not yet confirmed by `value`, and the timer that gives up on it.
  const held = useRef<number | null>(null);
  const heldTimer = useRef(0);

  const stop = () => {
    cancelAnimationFrame(spring.current);
    window.clearTimeout(rest.current);
    wheelTo.current = -1;
    wheelAcc.current = 0;
  };
  /** Gives up on a held option after `delay` unless the mouse is still busy with it (the control is disabled). */
  const release = (delay: number) => {
    window.clearTimeout(heldTimer.current);
    const check = () => {
      if (held.current === null) return;
      if (live.current.disabled) {
        heldTimer.current = window.setTimeout(check, 500);
        return;
      }
      held.current = null;
      if (!busy.current) setPos(live.current.at);
    };
    heldTimer.current = window.setTimeout(check, delay);
  };

  // Follow the mouse: a new value lands, a write ends. A held option stays until `value` reaches it, or until the
  // write is over without it (the control enabled again, `value` unmoved), when the track goes back to `value`.
  useEffect(() => {
    if (held.current !== null) {
      if (held.current === at) {
        held.current = null;
        window.clearTimeout(heldTimer.current);
      } else {
        if (!disabled) release(300);
        return;
      }
    }
    if (!busy.current) setPos(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, disabled]);
  useEffect(
    () => () => {
      stop();
      window.clearTimeout(heldTimer.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  useEffect(() => {
    onPreviewRef.current?.(options[shown]);
  }, [shown, options]);

  const root = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(typeof width === "number" ? width : 320);
  useEffect(() => {
    if (typeof width === "number") return setMeasured(width);
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setMeasured(Math.max(160, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  const w = measured;
  const inner = w - PAD * 2 - THUMB_W;
  const xOf = (p: number) => PAD + (n > 1 ? (p / (n - 1)) * inner : 0);
  const valueAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const x = clientX - r.left - PAD - THUMB_W / 2;
    return clamp((x / inner) * (n - 1), 0, n - 1);
  };
  // While dragging, each option pulls the thumb in over the last half step (the original's magnet).
  const magnet = (v: number) => {
    const near = Math.round(v);
    const d = v - near;
    const dist = Math.abs(d);
    if (dist < 0.001 || dist > 0.5) return v;
    const k = 1 - dist / 0.5;
    return v - d * (0.68 + 0.42 * k) * k * k;
  };

  const commit = (target: number) => {
    busy.current = false;
    setPos(target);
    const l = live.current;
    if (target === l.at) {
      held.current = null;
      window.clearTimeout(heldTimer.current);
      return;
    }
    held.current = target;
    release(2500);
    l.onChange(l.options[target]);
  };
  // Springs from where the thumb is to `target`, carrying `velocity` (options a second), in fixed small steps so it
  // moves the same at any frame rate.
  const settle = (target: number, velocity: number) => {
    stop();
    if (reduce) return commit(target);
    busy.current = true;
    let p = posRef.current;
    let v = velocity;
    let last = performance.now();
    const step = (now: number) => {
      let left = Math.min((now - last) / 1000, 0.064);
      last = now;
      while (left > 0) {
        const h = Math.min(left, 1 / 240);
        v += (-K * (p - target) - C * v) * h;
        p += v * h;
        left -= h;
      }
      p = clamp(p, 0, n - 1);
      if (Math.abs(p - target) < 0.002 && Math.abs(v) < 0.02) return commit(target);
      setPos(p);
      spring.current = requestAnimationFrame(step);
    };
    spring.current = requestAnimationFrame(step);
  };
  const latest = useRef({ shown, settle, n });
  latest.current = { shown, settle, n };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    stop();
    busy.current = true;
    dragging.current = true;
    const v = magnet(valueAt(e.clientX));
    samples.current = [{ t: performance.now(), v }];
    setPos(v);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const v = magnet(valueAt(e.clientX));
    const now = performance.now();
    samples.current = [...samples.current, { t: now, v }].filter((s) => now - s.t < 90).slice(-5);
    setPos(v);
  };
  const up = () => {
    if (!dragging.current) return;
    dragging.current = false;
    const s = samples.current;
    samples.current = [];
    const velocity = s.length > 1 ? clamp((s[s.length - 1].v - s[0].v) / Math.max((s[s.length - 1].t - s[0].t) / 1000, 0.016), -8, 8) : 0;
    settle(clamp(Math.round(posRef.current), 0, n - 1), velocity);
  };

  // Once the track has been clicked or tabbed to, the wheel moves it an option a notch (a trackpad, 50 px of
  // scrolling) and sets it once the wheel has rested. Before that, and at either end, the wheel scrolls the page.
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const wheel = (ev: WheelEvent) => {
      const l = latest.current;
      if (live.current.disabled || document.activeElement !== el) return;
      const raw = Math.abs(ev.deltaY) > Math.abs(ev.deltaX) ? -ev.deltaY : ev.deltaX;
      if (!raw) return;
      const from = wheelTo.current < 0 ? l.shown : wheelTo.current;
      if ((raw > 0 && from >= l.n - 1) || (raw < 0 && from <= 0)) {
        wheelAcc.current = 0;
        return;
      }
      ev.preventDefault();
      // A wheel's notch (lines, pages, or 40 px and more at any screen scale) is one option; a trackpad adds up.
      const px = ev.deltaMode === 1 ? raw * 40 : ev.deltaMode === 2 ? raw * 400 : raw;
      if (Math.sign(wheelAcc.current) === -Math.sign(raw)) wheelAcc.current = 0;
      wheelAcc.current += Math.abs(px) >= 40 ? Math.sign(px) : px / 50;
      const steps = Math.trunc(wheelAcc.current);
      if (!steps) return;
      wheelAcc.current -= steps;
      const target = clamp(from + steps, 0, l.n - 1);
      cancelAnimationFrame(spring.current);
      window.clearTimeout(rest.current);
      busy.current = true;
      wheelTo.current = target;
      setPos(target);
      rest.current = window.setTimeout(() => latest.current.settle(target, 0), 450);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  // The keys move it at once and set it when they rest, so a run of presses sends one change.
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowUp" ? shown + 1
      : e.key === "ArrowLeft" || e.key === "ArrowDown" ? shown - 1
      : e.key === "Home" ? 0
      : e.key === "End" ? n - 1
      : null;
    if (next === null) return;
    e.preventDefault();
    stop();
    busy.current = true;
    const target = clamp(next, 0, n - 1);
    setPos(target);
    rest.current = window.setTimeout(() => latest.current.settle(target, 0), 350);
  };
  // Leaving with the keys or the wheel mid-change sets what is shown.
  const blur = () => {
    if (busy.current && !dragging.current) settle(clamp(Math.round(posRef.current), 0, n - 1), 0);
  };

  // The ember field: drawn on a canvas a dot per 5 px, lit up to the thumb and dim past it; it moves at 15 fps while
  // SYNQ is focused and visible, and is painted again whenever the thumb moves.
  const paint = useRef<((now: number) => void) | null>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(w * ratio);
    c.height = Math.round(TRACK_H * ratio);
    let timer = 0;
    let frame = 0;
    const started = performance.now();
    const draw = (now: number) => {
      const p = posRef.current;
      const level = n > 1 ? p / (n - 1) : 1;
      const fill = xOf(p) + THUMB_W / 2;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, w, TRACK_H);
      const cell = 5;
      const gap = 1.1;
      const cols = Math.ceil(w / cell);
      const rows = Math.ceil(TRACK_H / cell);
      const elapsed = now - started;
      // Higher rates: more of the field lit, brighter, quicker.
      const tempo = 0.45 + 1.6 * level;
      const strength = 0.5 + 0.5 * level;
      const flow = elapsed / 4000;
      const flowEased = Math.floor(flow) + smoothstep(0, 1, flow - Math.floor(flow));
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * cell;
          const edge = 1 - smoothstep(fill - 14, fill - 2, x + cell / 2);
          // Past the thumb, the display's unlit dots.
          if (edge <= 0.01) {
            ctx.fillStyle = "rgb(255 236 224)";
            ctx.globalAlpha = 0.045;
            ctx.fillRect(x + gap / 2, row * cell + gap / 2, cell - gap, cell - gap);
            continue;
          }
          const nx = (x + cell / 2) / Math.max(fill, 1);
          const base = hash(col, row, 12.9898, 78.233, 43758.5453);
          const tempoH = hash(col, row, 7.13, 19.41, 19341.731);
          const phase = hash(col, row, 31.17, 11.93, 28437.123);
          const period = (500 + tempoH * 1500) / tempo;
          const local = elapsed + phase * period;
          const cyc = Math.floor(local / period);
          const prog = (local % period) / period;
          const cycH = Math.abs(Math.sin(col * 17.17 + row * 41.73 + cyc * 13.11) * 24634.6345) % 1;
          const widthH = Math.abs(Math.sin(col * 5.37 + row * 29.11 + cyc * 7.43) * 17391.443) % 1;
          const pulse = Math.exp(-(((prog - (0.2 + cycH * 0.55)) / (0.09 + widthH * 0.08)) ** 2) * 1.45) * (cycH > 0.12 ? 1 : 0.26);
          const wave = Math.pow(0.5 + 0.5 * Math.cos((nx * 0.6 + flowEased + row * 0.06 + base * 0.02) * Math.PI * 2), 5);
          const light = Math.max(pulse * (0.48 + wave * 0.58), wave * (0.38 + base * 0.28));
          // A dot is on when its own threshold is under the level's density: the field fills in as the rate climbs.
          const on = base < 0.35 + 0.65 * level ? 1 : 0.12;
          const depth = smoothstep(0, 0.9, nx);
          const tone = clamp(Math.floor((0.45 + depth * 0.3 + light * 0.55 + (base - 0.5) * 0.3) * EMBER.length), 0, EMBER.length - 1);
          const [r0, g0, b0] = EMBER[tone];
          const hot = level > 0.6 && light > 0.62 && cycH > 0.4;
          const k = hot ? 0.7 : 0;
          ctx.fillStyle = `rgb(${Math.round(mix(r0, PEAK[0], k))} ${Math.round(mix(g0, PEAK[1], k))} ${Math.round(mix(b0, PEAK[2], k))})`;
          ctx.globalAlpha = clamp((0.7 + light * 0.3) * strength * on * edge * (0.75 + 0.25 * depth), 0, 1);
          ctx.fillRect(x + gap / 2, row * cell + gap / 2, cell - gap, cell - gap);
        }
      }
      ctx.globalAlpha = 1;
    };
    const awake = () => !reduce && document.visibilityState === "visible" && document.hasFocus();
    const tick = () => {
      frame = 0;
      draw(performance.now());
      timer = awake() ? window.setTimeout(() => (frame = requestAnimationFrame(tick)), 66) : 0;
    };
    const wake = () => {
      if (!timer && !frame && awake()) frame = requestAnimationFrame(tick);
    };
    paint.current = draw;
    draw(performance.now());
    wake();
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      paint.current = null;
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
    // xOf depends on the measured width and n only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, n, reduce]);
  useEffect(() => {
    paint.current?.(performance.now());
  }, [pos]);

  const text = format(options[shown]);
  return (
    <div ref={root} className={cn("select-none", disabled && "pointer-events-none opacity-55", className)} style={{ width: typeof width === "number" ? width : "100%" }}>
      {!bare && (
        <div className="mb-3 flex items-end justify-between gap-3">
          <span className="label-caps">{label}</span>
          <span className="flex items-baseline gap-1.5">
            {figure ? (
              <NumberFlow value={figure(options[shown])[0]} suffix={figure(options[shown])[1]} className="display-num tabular text-[26px] leading-none tracking-[-0.04em] text-high" />
            ) : (
              <span className="display-num tabular text-[26px] leading-none tracking-[-0.04em] text-high">{text}</span>
            )}
            {unit && <span className="text-[12px] font-medium text-medium">{unit}</span>}
          </span>
        </div>
      )}

      <div
        ref={track}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={shown}
        aria-valuetext={`${text}${unit ? ` ${unit}` : ""}${detail ? `, ${detail(options[shown])}` : ""}`}
        aria-disabled={disabled || undefined}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
        onBlur={blur}
        data-rate-track=""
        className="relative cursor-ew-resize touch-none rounded-[10px] bg-[oklch(14.5%_0.006_45)] shadow-[0_1px_0_rgb(255_255_255/0.05)] outline-offset-4 ring-1 ring-white/[0.07]"
        style={{ height: TRACK_H }}
      >
        <canvas ref={canvas} className="pointer-events-none absolute inset-0 size-full rounded-[10px]" aria-hidden="true" />
        {/* The track's lip, over the field so the dots sit inside it. */}
        <span className="pointer-events-none absolute inset-0 rounded-[10px] shadow-[inset_0_1px_2px_rgb(0_0_0/0.6)]" aria-hidden="true" />
        {/* A dot for each option, under the field where the field has reached it. */}
        {options.map((o, i) => (
          <span
            key={String(o)}
            data-rate-stop={i}
            className={cn("pointer-events-none absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-200", i <= pos + 0.01 ? "opacity-0" : "bg-white/25")}
            style={{ left: xOf(i) + THUMB_W / 2 }}
            aria-hidden="true"
          />
        ))}
        <span
          className="pointer-events-none absolute left-0 top-1/2 block rounded-[8px] bg-[oklch(96%_0.004_60)] shadow-[0_2px_6px_rgb(0_0_0/0.55),inset_0_1px_0_rgb(255_255_255/0.9),inset_0_-1px_0_rgb(0_0_0/0.12)] transition-[scale] duration-150 ease-out"
          style={{ width: THUMB_W, height: THUMB_H, translate: `${xOf(pos)}px -50%`, scale: dragging.current ? 0.96 : 1 }}
          aria-hidden="true"
        />
      </div>

      {/* The options, under their ticks; a click picks one. The value itself is in the header, so these stay quiet. */}
      <div className="relative mt-2 h-4">
        {options.map((o, i) => (
          <button
            key={String(o)}
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => !disabled && settle(i, 0)}
            className="absolute top-0 -translate-x-1/2 text-[12px] font-medium tabular-nums text-medium transition-colors duration-200 ease-fluid hover:text-high"
            style={{ left: xOf(i) + THUMB_W / 2 }}
          >
            {format(o)}
          </button>
        ))}
      </div>
      {detail && <p className="mt-2.5 text-[12.5px] text-medium">{detail(options[shown])}</p>}
    </div>
  );
}
