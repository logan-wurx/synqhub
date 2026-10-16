// Pieces the monitor and webcam pages share: a level slider that sends only when let go, and the "Put back" line.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** A labelled slider: it moves freely and calls `onCommit` once, when the pointer or key is let go. */
export function LevelSlider({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  format = (v) => `${v}`,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  format?: (v: number) => string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <label className={cn("block py-2.5", disabled && "opacity-50")}>
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-foreground">{label}</span>
        <span className="tabular text-[13px] text-muted-foreground">{format(draft)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        className="mt-2 w-full accent-[var(--primary)] disabled:cursor-not-allowed"
      />
    </label>
  );
}
