// The key map as the control: every key shows its current value, click or drag to select keys, and one
// bar under the map applies a value to the whole selection. Shared by the Actuation, Rapid Trigger,
// Remap and Advanced Keys tabs of every keyboard panel. Pure UI: the panels own the data and the writes.
import { useEffect, useRef, type ReactNode } from "react";
import { CursorClick } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { keycapClass } from "@/components/keyboard/parts";
import { arrowPick } from "@/lib/roving";

export interface MapKey {
  /** The key's id in its panel's protocol; opaque here. */
  id: number;
  /** Position and size in key units. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** KLE-style rotation, degrees about (rx, ry). */
  r?: number;
  rx?: number;
  ry?: number;
  /** What the key prints. */
  label: string;
  /** Can't be selected (Fn, keys the board doesn't tune). */
  locked?: boolean;
  /** The current value shown on the key. `lit` = set on this key, `dim` = set but switched off, none = the default. */
  mark?: { text: string; tone?: "lit" | "dim" };
  title?: string;
}

export interface MapLayout {
  width: number;
  height: number;
  keys: readonly MapKey[];
}

/** Rows of keys (each key a width in units) as a MapLayout; `build` gives each key its id, label and so on. */
export function rowsLayout<T extends { w: number }>(rows: readonly (readonly T[])[], width: number, build: (k: T) => Omit<MapKey, "x" | "y" | "w" | "h">): MapLayout {
  const keys: MapKey[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    for (const k of row) {
      keys.push({ ...build(k), x, y, w: k.w, h: 1 });
      x += k.w;
    }
  });
  return { width, height: rows.length, keys };
}

/** Key height as a share of its width: a touch under square, as on a real board. */
const ROW_RATIO = 0.9;
/** The map never grows past this: keys stay about the size of real keycaps on a big screen, and the map sits in the middle. */
const MAX_MAP_WIDTH = 1080;

export function KeyBoard({
  layout,
  selected,
  onSelect,
  multi = true,
  label = "Keys",
}: {
  layout: MapLayout;
  selected: readonly number[];
  onSelect: (ids: number[]) => void;
  /** False: one key at a time (remap). */
  multi?: boolean;
  label?: string;
}) {
  const W = layout.width;
  const H = layout.height;
  // The selection as the drag builds it: a fast drag crosses several keys before React renders.
  const work = useRef<number[]>([...selected]);
  work.current = selected as number[];
  const drag = useRef<"add" | "remove" | null>(null);

  useEffect(() => {
    const end = () => {
      drag.current = null;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  const apply = (id: number, mode: "add" | "remove") => {
    const cur = work.current;
    const has = cur.includes(id);
    if (mode === "add" ? has : !has) return;
    work.current = mode === "add" ? [...cur, id] : cur.filter((x) => x !== id);
    onSelect(work.current);
  };

  return (
    <div role="group" aria-label={label} className="mx-auto w-full rounded-[18px] bg-black/45 p-2.5 ring-1 ring-white/[0.05] shadow-[inset_0_2px_12px_rgb(0_0_0/0.55)]" style={{ maxWidth: MAX_MAP_WIDTH }}>
      <div className="relative w-full" style={{ aspectRatio: `${W} / ${H * ROW_RATIO}` }}>
        {layout.keys.map((k) => {
          const on = selected.includes(k.id);
          return (
            <button
              key={`${k.id}-${k.x}-${k.y}`}
              type="button"
              disabled={k.locked}
              aria-pressed={on}
              title={k.title ?? (k.label || `Key ${k.id}`)}
              onPointerDown={(e) => {
                if (k.locked || e.button !== 0) return;
                if (!multi) {
                  onSelect(on ? [] : [k.id]);
                  return;
                }
                drag.current = on ? "remove" : "add";
                apply(k.id, drag.current);
              }}
              onPointerEnter={() => {
                if (drag.current && !k.locked) apply(k.id, drag.current);
              }}
              onClick={(e) => {
                // A click from the keyboard (Enter / Space) has no pointer; pointer clicks were handled on press.
                if (e.detail === 0 && !k.locked) (multi ? apply(k.id, on ? "remove" : "add") : onSelect(on ? [] : [k.id]));
              }}
              style={{
                left: `calc(${(k.x / W) * 100}% + 2.5px)`,
                top: `calc(${(k.y / H) * 100}% + 2.5px)`,
                width: `calc(${(k.w / W) * 100}% - 5px)`,
                height: `calc(${(k.h / H) * 100}% - 5px)`,
                ...(k.r ? { transform: `rotate(${k.r}deg)`, transformOrigin: `${(((k.rx ?? k.x) - k.x) / k.w) * 100}% ${(((k.ry ?? k.y) - k.y) / k.h) * 100}%` } : {}),
              }}
              className={cn(keycapClass({ tone: k.mark?.tone, selected: on, locked: k.locked }), "touch-none")}
            >
              <span className="w-full truncate text-[11px] leading-none">{k.label}</span>
              {k.mark?.text && (
                <span className={cn("tabular w-full truncate text-right text-[10px] leading-none", k.mark.tone === "lit" ? "text-primary" : "text-muted-foreground/80")}>{k.mark.text}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BarButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="h-8 whitespace-nowrap rounded-full bg-white/[0.05] px-3.5 text-[12.5px] text-foreground ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.09] disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * The bar under a key map: how many keys are picked, "Select all" and "Discard selection", and (once
 * something is picked) the controls that apply one value to all of them. With nothing picked it says so
 * gently instead of showing dead controls.
 */
export function SelectionBar({
  count,
  names,
  onSelectAll,
  onDiscard,
  hint = "Select keys to adjust",
  sub = "Click one, or drag across several.",
  extra,
  children,
}: {
  count: number;
  /** The picked keys, by name. */
  names?: string;
  /** Omit for a map where only one key can be picked. */
  onSelectAll?: () => void;
  onDiscard: () => void;
  hint?: string;
  sub?: string;
  /** Always shown at the right, next to the buttons. */
  extra?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mt-4 rounded-2xl bg-white/[0.02] ring-1 ring-white/[0.05]">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-[200px] flex-1">
          {count > 0 ? (
            <p className="truncate text-[13px] text-foreground">
              <span className="text-muted-foreground">{count === 1 ? "1 key selected" : `${count} keys selected`}</span>
              {names && <span className="ml-2">{names}</span>}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <CursorClick size={16} weight="light" className="shrink-0" />
              <span>
                {hint}. <span className="text-muted-foreground/80">{sub}</span>
              </span>
            </p>
          )}
        </div>
        {extra}
        {onSelectAll && <BarButton onClick={onSelectAll}>Select all</BarButton>}
        <BarButton onClick={onDiscard} disabled={count === 0}>
          Discard selection
        </BarButton>
      </div>
      {count > 0 && children && <div className="border-t border-white/[0.05] px-4 py-3.5">{children}</div>}
    </div>
  );
}

/** A labelled slider with its value beside it. */
export function MmSlider({
  label,
  value,
  min,
  max,
  step,
  decimals = 1,
  unit = "mm",
  disabled,
  onChange,
  className,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  unit?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
  className?: string;
}) {
  return (
    <label className={cn("flex min-w-[200px] flex-col gap-2", disabled && "opacity-60", className)}>
      <span className="flex items-baseline justify-between text-[12.5px] text-muted-foreground">
        {label}
        <span className="tabular text-[13px] text-foreground">
          {value.toFixed(decimals)} {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-5 w-full cursor-pointer accent-[var(--primary)]"
      />
    </label>
  );
}

/** A small segmented switch for the mode a key map is showing (Actuation / Rapid trigger). */
export function ModeSwitch<T extends string>({ options, value, onChange, label }: { options: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div role="radiogroup" onKeyDown={arrowPick} aria-label={label} className="flex items-center gap-0.5 rounded-full bg-white/[0.04] p-1 ring-1 ring-white/[0.07]">
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={o.id === value}
          onClick={() => o.id !== value && onChange(o.id)}
          className={cn(
            "h-7 whitespace-nowrap rounded-full px-3.5 text-[12.5px] transition-colors duration-300 ease-fluid",
            o.id === value ? "bg-white/[0.09] text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
