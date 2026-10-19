// Pieces both mouse panels use: the DPI step editor, battery ring, empty states, banner, and the
// switcher shown when more than one mouse is plugged in.
import { DetentSlider } from "@/components/ui/detent-slider";
import type { ReactNode } from "react";
import { motion } from "motion/react";
import { Lightning, Minus, Plus, Star, Warning } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/matte";
import { MouseOutline, PlugIn } from "@/components/ui/brand";
import { DeviceThumb, type ArtSpec } from "@/components/devices/DeviceArt";
import type { MouseFamily } from "@/lib/mouse-family";
import { arrowPick } from "@/lib/roving";

export const rateLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}K` : String(hz));
export const DPI_PRESETS = [400, 800, 1200, 1600, 3200];

export function StageEditor({
  index,
  value,
  isDefault,
  step,
  min,
  max,
  disabled,
  onChange,
  onDefault,
  onRemove,
  starTitle = "Start on this step",
}: {
  index: number;
  value: number;
  isDefault: boolean;
  step: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (v: number) => void;
  onDefault: () => void;
  onRemove?: () => void;
  starTitle?: string;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v / step) * step));
  return (
    <div
      className={cn(
        "group relative flex w-[118px] flex-col gap-3 rounded-control px-3 pb-3 pt-2.5 ring-1 transition-colors duration-500 ease-fluid",
        isDefault ? "bg-primary/[0.08] ring-primary/30" : "bg-white/[0.025] ring-white/[0.06]",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-medium">Step {index + 1}</span>
        <button disabled={disabled} onClick={onDefault} title={starTitle} className={cn("rounded-full p-1 transition-colors", isDefault ? "text-primary" : "text-white/25 hover:text-white/60")}>
          <Star size={14} weight={isDefault ? "fill" : "light"} />
        </button>
      </div>
      <input
        aria-label={`Step ${index + 1} DPI`}
        disabled={disabled}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value.replace(/\D/g, ""));
          if (Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => onChange(clamp(value))}
        className="tabular w-full bg-transparent text-[24px] leading-none text-high outline-none"
      />
      <div className="flex gap-1.5">
        {[-1, 1].map((dir) => (
          <button
            key={dir}
            disabled={disabled}
            onClick={() => onChange(clamp(value + dir * (value >= 1600 ? 200 : 50)))}
            className="grid h-7 flex-1 place-items-center rounded-full bg-white/[0.05] text-medium ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.09] hover:text-high"
          >
            {dir < 0 ? <Minus size={12} /> : <Plus size={12} />}
          </button>
        ))}
      </div>
      {onRemove && !disabled && (
        <button
          onClick={onRemove}
          className="absolute -right-2 -top-2 hidden size-6 place-items-center rounded-full bg-[#1d1d22] text-[13px] text-medium ring-1 ring-white/10 hover:text-high group-hover:grid"
          title="Remove step"
        >
          ×
        </button>
      )}
    </div>
  );
}

export function BatteryRing({ percent, charging }: { percent: number | null; charging: boolean }) {
  const r = 38;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent ?? 0));
  return (
    <div className="relative grid size-[96px] shrink-0 place-items-center">
      <svg width="96" height="96" className="-rotate-90">
        <circle cx="48" cy="48" r={r} fill="none" stroke="rgb(255 255 255 / 0.07)" strokeWidth="6" />
        <circle
          cx="48"
          cy="48"
          r={r}
          fill="none"
          stroke={p <= 15 ? "var(--destructive)" : "var(--primary)"}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p / 100)}
          style={{ transition: "stroke-dashoffset 900ms cubic-bezier(0.32,0.72,0,1)", filter: "drop-shadow(0 0 4px color-mix(in srgb, var(--primary) 60%, transparent))" }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="tabular text-[20px] leading-none text-high">{percent === null ? "—" : `${p}%`}</span>
        {charging && <Lightning size={14} weight="fill" className="mt-1 text-primary" />}
      </div>
    </div>
  );
}

export function EmptyCard({ title, text, image, art, plug }: { title: string; text: string; image?: string; art?: ReactNode; plug?: boolean }) {
  return (
    <Card innerClassName="flex flex-col items-center px-8 pb-12 pt-8 text-center">
      {plug && <PlugIn kind="mouse" className="mb-2 h-[200px] w-[267px]" />}
      {image && <img src={image} alt="" className="mb-4 h-[180px] animate-pulse object-contain opacity-80" />}
      {art && <div className="mb-4 h-[180px] animate-pulse opacity-80">{art}</div>}
      <p className="text-[17px] font-medium text-high">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-[13.5px] text-medium">{text}</p>
    </Card>
  );
}

export function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-control bg-chart-3/[0.06] px-4 py-3 text-[13px] leading-relaxed text-chart-3 ring-1 ring-chart-3/20">
      <Warning size={16} weight="light" className="shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export type { MouseFamily };

/**
 * Small segmented control to pick which connected mouse the page shows. A mouse that didn't answer the
 * quick check (its receiver is plugged in but it is off or asleep) is marked quietly; it can still be picked.
 */
export function MouseSwitcher({
  options,
  value,
  onChange,
}: {
  options: { id: MouseFamily; label: string; quiet?: boolean; art?: ArtSpec }[];
  value: MouseFamily;
  onChange: (id: MouseFamily) => void;
}) {
  return (
    <div role="tablist" onKeyDown={arrowPick} aria-label="Mouse" className="flex h-9 shrink-0 items-center gap-0.5 rounded-full bg-white/[0.04] p-1 ring-1 ring-white/[0.07]">
      {/* Mice or keyboards that are off or didn't answer go last, dimmed; they return to their place once they answer. */}
      {[...options].sort((a, b) => Number(!!a.quiet) - Number(!!b.quiet)).map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            role="tab"
            aria-selected={on}
            title={o.quiet ? `${o.label} is off or asleep` : undefined}
            onClick={() => onChange(o.id)}
            className={cn(
              "relative h-7 whitespace-nowrap rounded-full px-3.5 text-[12.5px] transition-colors duration-500 ease-fluid",
              on ? "text-high" : o.quiet ? "text-medium hover:text-medium" : "text-medium hover:text-high",
            )}
          >
            {on && (
              <motion.span
                layoutId="mouse-switcher"
                transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
                className="absolute inset-0 rounded-full bg-white/[0.08] shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] ring-1 ring-white/[0.08]"
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {o.art && <DeviceThumb spec={o.art} className={o.quiet ? "opacity-40" : undefined} />}
              {o.label}
              {o.quiet && <span className="text-[11px] font-normal text-medium">Off or asleep</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export { hzText } from "@/lib/utils";

/**
 * Under the big readout: a DPI fader with the usual values as magnetic detents (src/components/ui/detent-slider.tsx),
 * on a log scale so 400 to 3200 get most of the track, and a field for an exact value. Sent on release.
 */
export function DpiPresets({
  value,
  min = 100,
  max = 26000,
  step = 50,
  disabled,
  onPick,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled: boolean;
  onPick: (dpi: number) => void;
}) {
  return (
    <div className={cn("relative flex flex-col gap-3", disabled && "pointer-events-none opacity-60")}>
      {/* The fader stops at 12800 (unless the mouse is set higher), so the usual values get the track; the field reaches the rest. */}
      <DetentSlider label="Pointer speed (DPI)" value={value} min={min} max={Math.min(max, Math.max(12800, value))} step={step || 50} detents={DPI_PRESETS} curve="log" disabled={disabled} onCommit={onPick} />
      <input
        aria-label="Custom DPI"
        disabled={disabled}
        placeholder="Exact DPI"
        inputMode="numeric"
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const n = Number((e.target as HTMLInputElement).value.replace(/\D/g, ""));
          if (n > 0) onPick(n);
        }}
        className="tabular h-8 w-28 self-start rounded-small bg-white/[0.04] px-3 text-[12.5px] text-high outline-none ring-1 ring-white/[0.07] placeholder:text-medium focus:ring-primary/60"
      />
    </div>
  );
}

/** The mouse picture on the Overview tab: its render, or the outline stand-in. */
export function MouseArt({ src }: { src: string | null | undefined }) {
  return src ? (
    <img src={src} alt="" draggable={false} className="pointer-events-none max-h-full max-w-full select-none object-contain" />
  ) : (
    <MouseOutline className="h-full max-h-[190px]" />
  );
}
