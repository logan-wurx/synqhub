// Compact numeric input on Base UI's NumberField: drag the label to scrub, type, or use the
// arrow keys / mouse wheel. Commits on release, blur or Enter.
import { NumberField as Base } from "@base-ui/react/number-field";
import { cn } from "@/lib/utils";

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  smallStep?: number;
  largeStep?: number;
  decimals?: number;
  unit?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  className?: string;
}

export function NumberField({
  label,
  value,
  min,
  max,
  step,
  smallStep,
  largeStep,
  decimals = 0,
  unit,
  disabled,
  onChange,
  onCommit,
  className,
}: NumberFieldProps) {
  return (
    <Base.Root
      value={value}
      min={min}
      max={max}
      step={step}
      smallStep={smallStep}
      largeStep={largeStep}
      disabled={disabled}
      format={{ minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false }}
      onValueChange={(v) => v !== null && onChange(v)}
      onValueCommitted={(v) => v !== null && onCommit?.(v)}
      className={cn("flex flex-col gap-1", className)}
    >
      <Base.ScrubArea direction="horizontal" pixelSensitivity={3} className="cursor-ew-resize px-1" title="Drag sideways to adjust">
        <span className="text-[11.5px] text-medium">{label}</span>
        <Base.ScrubAreaCursor className="drop-shadow-[0_1px_1px_#000]">
          <svg width="22" height="10" viewBox="0 0 22 10" fill="currentColor" className="text-high">
            <path d="M0 5 6 0v10L0 5Zm22 0-6 5V0l6 5Z" />
          </svg>
        </Base.ScrubAreaCursor>
      </Base.ScrubArea>
      <Base.Group className="flex h-9 items-center rounded-control bg-white/[0.04] ring-1 ring-white/[0.07] transition-colors focus-within:ring-primary/60 hover:bg-white/[0.06]">
        <Base.Input className="tabular w-full min-w-0 bg-transparent px-2.5 text-[13.5px] text-high outline-none" />
        {unit && <span className="pr-2.5 text-[11.5px] text-medium">{unit}</span>}
      </Base.Group>
    </Base.Root>
  );
}
