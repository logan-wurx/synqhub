// The small pieces every lamp page shares: a slider on a coloured track (brightness, white), colour swatches, a
// two-way switch, a section heading and the header's power button. Pure UI.
import type { CSSProperties, ReactNode } from "react";
import { Power, X } from "@phosphor-icons/react";
import type { Rgb } from "@/lib/lighting/govee/frames";
import { cn } from "@/lib/utils";
import { arrowPick } from "@/lib/roving";

export const css = (c: Rgb) => `rgb(${c[0]} ${c[1]} ${c[2]})`;

/** Brushes that are always there; the person's recent and saved colours follow. */
export const BRUSHES = ["#ff2a2a", "#ff8a00", "#ffd400", "#3dff5a", "#00e5ff", "#2a5bff", "#8a2aff", "#ff2ad4", "#ffffff"];

/**
 * A slider on a coloured track: a native range input (keyboard and screen readers for free) drawn by `.light-range`
 * in index.css. `onCommit` fires when a drag or a key press ends.
 */
export function LightSlider({
  label,
  value,
  min,
  max,
  step = 1,
  track,
  thumb,
  onChange,
  onCommit,
  disabled,
  format,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** A CSS background for the track. */
  track: string;
  /** The thumb's fill; white when left out. */
  thumb?: string;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  disabled?: boolean;
  format: (v: number) => string;
  testId?: string;
}) {
  return (
    <label className={cn("block", disabled && "opacity-50")}>
      <span className="flex items-baseline justify-between gap-3 text-[12.5px] text-muted-foreground">
        <span className="truncate">{label}</span>
        <span className="tabular shrink-0 text-foreground">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number(e.currentTarget.value))}
        onKeyUp={(e) => onCommit?.(Number(e.currentTarget.value))}
        className="light-range mt-2 w-full"
        style={{ "--track": track, "--thumb": thumb ?? "#fff" } as CSSProperties}
      />
    </label>
  );
}

/** A round colour chip; `onRemove` adds a small cross on hover (a saved colour). */
export function Swatch({ colour, selected, onClick, onRemove, label, size = 26 }: { colour: string; selected?: boolean; onClick: () => void; onRemove?: () => void; label: string; size?: number }) {
  return (
    <span className="group/swatch relative inline-grid shrink-0">
      <button
        type="button"
        onClick={onClick}
        title={label}
        aria-label={label}
        aria-pressed={selected}
        className={cn(
          "rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.18)] transition-transform duration-300 ease-fluid hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          selected && "ring-2 ring-white ring-offset-2 ring-offset-[#0b0b0e]",
        )}
        style={{ width: size, height: size, background: colour }}
      />
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Forget ${label}`}
          className="absolute -right-1.5 -top-1.5 hidden size-4 place-items-center rounded-full bg-[#1d1d22] text-muted-foreground ring-1 ring-white/15 hover:text-foreground group-hover/swatch:grid group-focus-within/swatch:grid"
        >
          <X size={9} weight="bold" />
        </button>
      )}
    </span>
  );
}

/** A few options in a pill track (Colour / White); with `wrap`, a long set wraps inside its card instead of running past it. */
export function Segmented<T extends string>({ value, options, onChange, label, wrap }: { value: T; options: readonly { id: T; label: string }[]; onChange: (v: T) => void; label: string; wrap?: boolean }) {
  return (
    <div role="radiogroup" onKeyDown={arrowPick} aria-label={label} className={cn("inline-flex items-center gap-0.5 bg-white/[0.04] p-1 ring-1 ring-white/[0.07]", wrap ? "max-w-full flex-wrap rounded-[18px]" : "shrink-0 rounded-full")}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          onClick={() => onChange(o.id)}
          className={cn(
            "h-7 whitespace-nowrap rounded-full px-3.5 text-[12.5px] transition-colors duration-300 ease-fluid",
            o.id === value ? "bg-white/[0.09] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] ring-1 ring-white/[0.08]" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A small heading inside a card ("Recent", "Saved"). */
export function SubHead({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="truncate text-[12px] text-muted-foreground">{children}</p>
      {right}
    </div>
  );
}

/** A round icon button (add, remove, reverse, save). */
export function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.04] text-muted-foreground ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.08] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** A choice among several (a motion style, a music mode's variant). */
export function Chip({ on, small, onClick, children }: { on: boolean; small?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "whitespace-nowrap rounded-full ring-1 transition-colors duration-300 ease-fluid",
        small ? "px-2.5 py-0.5 text-[12px]" : "px-3 py-1 text-[12.5px]",
        on ? "bg-white/[0.1] text-foreground ring-white/25" : "bg-white/[0.03] text-muted-foreground ring-white/[0.08] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** The header's on/off switch for a light. */
export function PowerButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      data-testid="light-power"
      className={cn(
        "group flex h-9 items-center gap-2 rounded-full pl-1.5 pr-4 text-[13px] ring-1 transition-colors duration-300 ease-fluid",
        on ? "bg-primary/[0.12] text-foreground ring-primary/35 hover:bg-primary/[0.18]" : "bg-white/[0.05] text-muted-foreground ring-white/[0.08] hover:bg-white/[0.08] hover:text-foreground",
      )}
    >
      <span className={cn("grid size-6 place-items-center rounded-full", on ? "bg-primary text-primary-foreground shadow-[0_0_14px_-2px_var(--primary)]" : "bg-white/[0.08]")}>
        <Power size={13} weight="bold" />
      </span>
      {on ? "On" : "Off"}
    </button>
  );
}
