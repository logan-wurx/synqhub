// One filter as a channel strip: type, frequency, gain fader, Q dial.
import { X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Fader } from "@/components/ui/fader";
import { Knob } from "@/components/ui/knob";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { formatDb, hasGain, type Filter, type FilterKind, type Limits } from "@/lib/eq";

const KINDS: FilterKind[] = ["PK", "LSC", "HSC", "LPQ", "HPQ", "NO"];
export const KIND_NAME: Record<FilterKind, string> = {
  PK: "Peak",
  LSC: "Bass shelf",
  HSC: "Treble shelf",
  LPQ: "High cut",
  HPQ: "Low cut",
  NO: "Notch",
};

const STRIP = "group relative flex w-[112px] shrink-0 flex-col items-center gap-3 rounded-[1.35rem] px-2.5 pb-3 pt-3 ring-1 transition-[background-color,box-shadow] duration-500 ease-fluid";

interface BandStripProps {
  index: number;
  filter: Filter;
  limits: Limits;
  selected: boolean;
  readOnly: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<Filter>) => void;
  onCommit: () => void;
  onRemove: () => void;
}

export function BandStrip({ index, filter, limits, selected, readOnly, onSelect, onChange, onCommit, onRemove }: BandStripProps) {
  const gainable = hasGain(filter.kind);
  return (
    <div
      onPointerDownCapture={onSelect}
      className={cn(
        STRIP,
        selected
          ? "bg-white/[0.055] ring-white/[0.14] shadow-[inset_0_1px_0_rgb(255_255_255/0.07),0_0_0_1px_color-mix(in_srgb,var(--primary)_25%,transparent)]"
          : "bg-white/[0.025] ring-white/[0.06] hover:bg-white/[0.04]",
      )}
    >
      <div className="flex w-full items-center justify-between">
        <span
          className={cn(
            "grid size-6 place-items-center rounded-full text-[11.5px] font-medium tabular-nums",
            selected ? "bg-primary text-primary-foreground" : "bg-white/[0.06] text-muted-foreground",
          )}
        >
          {index + 1}
        </span>
        {!readOnly && (
          <Switch
            checked={filter.enabled}
            onCheckedChange={(on) => {
              onChange({ enabled: on });
              onCommit();
            }}
            aria-label={`Band ${index + 1} on`}
          />
        )}
      </div>

      <select
        disabled={readOnly}
        value={filter.kind}
        onChange={(e) => {
          const kind = e.target.value as FilterKind;
          onChange({ kind, gain: hasGain(kind) ? filter.gain || -2 : 0, q: kind === "LSC" || kind === "HSC" ? 0.71 : filter.q });
          onCommit();
        }}
        className="w-full cursor-pointer appearance-none rounded-full bg-white/[0.04] px-2 py-1.5 text-center text-[12.5px] text-foreground outline-none ring-1 ring-white/[0.07] transition-colors hover:bg-white/[0.07] focus:ring-primary/60"
      >
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_NAME[k]}
          </option>
        ))}
      </select>

      <NumberField
        label="Frequency"
        value={filter.freq}
        min={limits.freqRangeHz[0]}
        max={limits.freqRangeHz[1]}
        step={1}
        largeStep={100}
        unit="Hz"
        disabled={readOnly}
        onChange={(freq) => onChange({ freq })}
        onCommit={onCommit}
        className="w-full"
      />

      <Fader
        aria-label={`Band ${index + 1} gain`}
        value={gainable ? filter.gain : 0}
        min={-12}
        max={limits.maxBoostDb}
        step={0.1}
        disabled={readOnly || !gainable || !filter.enabled}
        onChange={(gain) => onChange({ gain })}
        onCommit={onCommit}
      />
      <span
        className={cn(
          "tabular text-[15px]",
          !gainable || !filter.enabled ? "text-muted-foreground" : filter.gain >= 0 ? "text-primary" : "text-secondary",
        )}
      >
        {gainable ? `${formatDb(filter.gain)} dB` : "—"}
      </span>

      <Knob value={filter.q} min={0.2} max={10} disabled={readOnly || !filter.enabled} onChange={(q) => onChange({ q })} onCommit={onCommit} size={56} />

      {!readOnly && (
        <button
          onClick={onRemove}
          className="absolute -right-2 -top-2 hidden size-6 items-center justify-center rounded-full bg-[#1d1d22] text-muted-foreground ring-1 ring-white/10 transition-colors hover:text-foreground group-hover:flex"
          title="Remove band"
        >
          <X size={12} weight="bold" />
        </button>
      )}
    </div>
  );
}

export function PreampStrip({
  value,
  auto,
  peak,
  max,
  limits,
  readOnly,
  onChange,
  onCommit,
}: {
  value: number;
  auto: boolean;
  peak: number;
  /** Highest preamp that keeps the net peak at 0 dB for the current shape. */
  max: number;
  limits: Limits;
  readOnly: boolean;
  onChange: (v: number) => void;
  onCommit: () => void;
}) {
  const clip = peak > limits.peakToleranceDb;
  return (
    <div className={cn(STRIP, "bg-primary/[0.05] ring-primary/25")}>
      <div className="flex w-full items-center justify-between">
        <span className="text-[13px] font-medium text-foreground">Preamp</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px]", auto ? "bg-primary/15 text-primary" : "bg-white/[0.06] text-muted-foreground")}>
          {auto ? "Auto" : "Manual"}
        </span>
      </div>
      <div className="flex w-full flex-col items-center rounded-2xl bg-black/30 py-2 ring-1 ring-white/[0.06]">
        <span className="text-[11.5px] text-muted-foreground">Peak</span>
        <span className={cn("tabular text-[17px]", clip ? "text-destructive" : "text-foreground")}>{formatDb(peak)}</span>
      </div>
      <div className="h-[46px]" />
      <Fader
        aria-label="Preamp"
        value={value}
        min={-20}
        max={Math.max(-20, Math.min(limits.maxBoostDb, max))}
        step={0.1}
        disabled={readOnly || auto}
        onChange={onChange}
        onCommit={onCommit}
      />
      <span className="tabular text-[15px] text-foreground">{formatDb(value)} dB</span>
      <p className="flex h-[76px] items-center px-0.5 text-center text-[11.5px] leading-snug text-muted-foreground">
        {clip ? "Too loud: lower it" : auto ? "Keeps the loudest part at 0 dB" : "Can't go past 0 dB peak"}
      </p>
    </div>
  );
}
