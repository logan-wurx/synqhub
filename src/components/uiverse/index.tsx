// React wrappers for the Uiverse elements in uiverse.css (MIT, credits there).
import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { useOnScreen, useWindowActive } from "@/lib/activity";
import "./uiverse.css";

const POWER_PATH =
  "M288 32c0-17.7-14.3-32-32-32s-32 14.3-32 32V256c0 17.7 14.3 32 32 32s32-14.3 32-32V32zM143.5 120.6c13.6-11.3 15.4-31.5 4.1-45.1s-31.5-15.4-45.1-4.1C49.7 115.4 16 181.8 16 256c0 132.5 107.5 240 240 240s240-107.5 240-240c0-74.2-33.8-140.6-86.6-184.6c-13.6-11.3-33.8-9.4-45.1 4.1s-9.4 33.8 4.1 45.1c38.9 32.3 63.5 81 63.5 135.4c0 97.2-78.8 176-176 176s-176-78.8-176-176c0-54.4 24.7-103.1 63.5-135.4z";

/** Round glowing power button (vinodjangid07). Lit when `checked`. */
export function PowerSwitch({
  checked,
  onChange,
  size = 56,
  glow = "var(--primary)",
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  size?: number;
  glow?: string;
  label: string;
}) {
  const id = useId();
  return (
    <span className="uv-power" style={{ "--uv-size": `${size}px`, "--uv-glow": glow } as CSSProperties}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id} aria-label={label} title={label}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
          <path d={POWER_PATH} />
        </svg>
      </label>
    </span>
  );
}

/**
 * The lit rocker's flicker: the original 0.2 s dip (1 -> 0.8 -> 1, eased), as four 50 ms steps that
 * each hold that slice's average brightness. 20 repaints a second of one small light instead of a
 * CSS loop that repaints every display frame; it holds still while the window is in the background.
 */
const FLICKER = [0.955, 0.85, 0.807, 0.907];
const FLICKER_STEP_MS = 50;

/** Illuminated red rocker (Nawsome). */
export function RockerSwitch({ checked, onChange, width = 96, label }: { checked: boolean; onChange: (c: boolean) => void; width?: number; label: string }) {
  const light = useRef<HTMLDivElement>(null);
  const active = useWindowActive();
  const shown = useOnScreen(light);
  useEffect(() => {
    const el = light.current;
    if (!el || !checked || !active || !shown) return;
    let i = 0;
    const t = window.setInterval(() => {
      i = (i + 1) % FLICKER.length;
      el.style.setProperty("--uv-flicker", String(FLICKER[i]));
    }, FLICKER_STEP_MS);
    return () => {
      window.clearInterval(t);
      el.style.removeProperty("--uv-flicker");
    };
  }, [checked, active, shown]);
  return (
    <label className="uv-rocker" style={{ "--uv-w": `${width}px`, "--uv-h": `${Math.round(width * 1.3)}px` } as CSSProperties} aria-label={label} title={label}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div className="uv-rocker-button">
        <div ref={light} className="uv-light" />
        <div className="uv-dots" />
        <div className="uv-characters" />
        <div className="uv-shine" />
        <div className="uv-shadow" />
      </div>
    </label>
  );
}

export interface GlassOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** Segmented choice with a springy glass glider (chase2k25). */
export function GlassRadio<T extends string>({
  options,
  value,
  onChange,
  tint = "var(--primary)",
}: {
  options: GlassOption<T>[];
  value: T;
  onChange: (v: T) => void;
  tint?: string;
}) {
  const name = useId();
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className="uv-glass" style={{ "--uv-count": options.length, "--uv-index": index, "--uv-tint": tint } as CSSProperties}>
      {options.map((o) => {
        const id = `${name}-${o.value}`;
        return (
          <span key={o.value} className="contents">
            <input type="radio" name={name} id={id} checked={o.value === value} onChange={() => onChange(o.value)} />
            <label htmlFor={id}>
              {o.label}
              {o.hint && <small>{o.hint}</small>}
            </label>
          </span>
        );
      })}
      <div className="uv-glider" />
    </div>
  );
}

export interface TransportKey<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

/** Chunky hardware key row (m1her); the pressed key lights up. */
export function TransportKeys<T extends string>({
  keys,
  value,
  onChange,
  lit = "var(--primary)",
  keyWidth = 76,
  fill = false,
}: {
  keys: TransportKey<T>[];
  value: T;
  onChange: (v: T) => void;
  lit?: string;
  keyWidth?: number;
  /** The keys share the row's whole width (`keyWidth` is then ignored). */
  fill?: boolean;
}) {
  const name = useId();
  return (
    <div className={fill ? "uv-transport uv-fill" : "uv-transport"} role="radiogroup" style={{ "--uv-lit": lit, "--uv-key-w": `${keyWidth}px` } as CSSProperties}>
      {keys.map((k) => (
        <label key={k.value} className="uv-key" style={k.disabled ? { opacity: 0.45, cursor: "default" } : undefined}>
          <input type="radio" name={name} disabled={k.disabled} checked={k.value === value} onChange={() => onChange(k.value)} />
          <span className="uv-text">
            {k.icon}
            {k.label}
          </span>
        </label>
      ))}
    </div>
  );
}
