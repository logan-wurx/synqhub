// Small pieces the "Keep your feel" screens share: a decimal input for sensitivity and DPI, the labelled
// result lines of the sensitivity calculator.
import { useEffect, useState, type ReactNode } from "react";
import { Sparkle } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { fmtNum } from "@/lib/feel/units";
import { Pill } from "@/components/keyboard/parts";

/** Reads "0,55" and "0.55" alike; null for empty or not a positive number. */
export function parseNumber(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A number the person types: kept as text while editing, committed when they leave the field or press Enter.
 * An empty field commits null.
 */
export function NumInput({
  label,
  value,
  placeholder,
  unit,
  width = "w-[104px]",
  disabled,
  onCommit,
  onType,
  decimals = 3,
}: {
  label: string;
  value: number | null;
  placeholder?: string;
  unit?: string;
  width?: string;
  disabled?: boolean;
  onCommit?: (value: number | null) => void;
  /** Each keystroke, parsed (for a result that follows the typing). */
  onType?: (value: number | null) => void;
  decimals?: number;
}) {
  const shown = value === null ? "" : fmtNum(value, decimals);
  const [text, setText] = useState(shown);
  // A value that changed elsewhere (a different game picked, a feel saved) replaces what was typed; what is
  // being typed ("0." is not a number yet) is left alone while it still reads as the same value.
  useEffect(() => setText((t) => (parseNumber(t) === value ? t : shown)), [shown, value]);
  const commit = () => {
    const n = parseNumber(text);
    setText(n === null ? "" : fmtNum(n, decimals));
    if (n !== value) onCommit?.(n);
  };
  return (
    <label className={cn("flex flex-col gap-1", width)}>
      <span className="px-1 text-[11.5px] text-muted-foreground">{label}</span>
      <span className="flex h-9 items-center rounded-xl bg-white/[0.04] ring-1 ring-white/[0.07] transition-colors focus-within:ring-primary/60 hover:bg-white/[0.06]">
        <input
          inputMode="decimal"
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={label}
          onChange={(e) => {
            setText(e.target.value);
            onType?.(parseNumber(e.target.value));
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="tabular w-full min-w-0 bg-transparent px-2.5 text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/80"
        />
        {unit && <span className="pr-2.5 text-[11.5px] text-muted-foreground">{unit}</span>}
      </span>
    </label>
  );
}

/** The calm banner both the Devices home and a device's Overview show for a mouse or keyboard SYNQ hasn't seen. */
export function OfferBanner({
  title,
  detail,
  primary,
  onPrimary,
  onDismiss,
}: {
  title: string;
  detail: ReactNode;
  primary: string;
  onPrimary: () => void;
  onDismiss: () => void;
}) {
  return (
    <div data-slot="feel-offer" className="flex items-center gap-3.5 rounded-2xl bg-primary/[0.06] px-4 py-3.5 ring-1 ring-primary/20">
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary/[0.14] text-primary ring-1 ring-primary/25">
        <Sparkle size={16} weight="light" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{detail}</p>
      </div>
      <Pill primary onClick={onPrimary}>
        {primary}
      </Pill>
      <Pill onClick={onDismiss}>Not now</Pill>
    </div>
  );
}
