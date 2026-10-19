// Lift-off distance in the Sensitivity console (it used to be its own card on another tab): one bar per option, taller
// for higher, the chosen one lit and the ones under it half lit. In the console's right column it is a card of its own
// (title, what it does, the value large in the corner); beside the number it keeps a small header like the rate's.
// It works for a mouse with millimetres (0.7 to 1.7) and one with named levels (Low, Medium, High): fewer options get
// wider bars.
import { useContext } from "react";
import { cn } from "@/lib/utils";
import { arrowPick } from "@/lib/roving";
import { CardFigure, ConsoleCard, InConsoleCard } from "./console-card";

export function LiftOffLevels<T extends string | number>({
  options,
  value,
  label,
  disabled = false,
  onPick,
  width = "fill",
}: {
  options: readonly T[];
  value: T | null;
  /** The option as it is said ("1.2 mm", "Medium"). */
  label: (o: T) => string;
  disabled?: boolean;
  /** Absent when the mouse only reports it. */
  onPick?: (o: T) => void;
  /** A width in px, or "fill" for its column. */
  width?: number | "fill";
}) {
  const card = useContext(InConsoleCard);
  const at = value === null ? -1 : options.indexOf(value);
  const n = options.length;
  const wide = n <= 5;
  const fixed = !onPick;
  const said = value === null ? "—" : label(value);

  const bars = (
    <div className={cn("select-none", disabled && "pointer-events-none opacity-55")} style={{ width: typeof width === "number" ? width : "100%" }}>
      {!card && (
        <div className="mb-3 flex items-end justify-between gap-3">
          <span className="label-caps">Lift-off</span>
          <span className="display-num tabular text-[22px] leading-none tracking-[-0.04em] text-high">{said}</span>
        </div>
      )}
      <div role="radiogroup" aria-label="Lift-off distance" aria-readonly={fixed || undefined} onKeyDown={fixed ? undefined : arrowPick} className={cn("flex items-end", card ? "h-12" : "h-11", wide ? "gap-2" : "gap-1.5")}>
        {options.map((o, i) => (
          <button
            key={String(o)}
            type="button"
            role="radio"
            aria-checked={i === at}
            tabIndex={i === Math.max(at, 0) && !fixed ? 0 : -1}
            disabled={fixed}
            title={label(o)}
            onClick={() => onPick && i !== at && onPick(o)}
            className="group flex h-full flex-1 items-end justify-center disabled:cursor-default"
          >
            <span
              style={{ height: `${30 + (n > 1 ? (i / (n - 1)) * 70 : 70)}%` }}
              className={cn(
                "rounded-[3px] transition-colors duration-500 ease-fluid",
                wide ? "w-full" : "w-full max-w-[14px] rounded-full",
                i === at ? "bg-primary" : i < at ? "bg-primary/30" : cn("bg-white/[0.08]", !fixed && "group-hover:bg-white/20"),
              )}
            />
          </button>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[12px] font-medium tabular-nums text-medium">
        <span>{label(options[0])}</span>
        <span>{label(options[n - 1])}</span>
      </div>
    </div>
  );
  if (!card) return bars;

  // "1.2 mm": the number large, the unit small; a named level ("Medium") as it is.
  const parts = /^([\d.]+)\s*(\D+)$/.exec(said);
  return (
    <ConsoleCard title="Lift-off distance" hint="Tracking stops above this height." figure={<CardFigure unit={parts?.[2]}>{parts ? parts[1] : said}</CardFigure>}>
      {bars}
    </ConsoleCard>
  );
}
