// A mouse's battery as a cell you can read across the room: a capsule with its terminal, filled with warm liquid to
// the charge (a wave on its surface, moving only while it charges, with a bolt), and the level beside it in big
// figures. Adapted from ravikatiyar162's Battery Card on 21st.dev. Changed for SYNQ: the room's dark recessed capsule,
// SYNQ orange liquid with the dot display's fine grid over it (red at 15% and under while it isn't charging), no
// time estimate (SYNQ shows only what the mouse reports), the waves still unless it is charging, and the level as the
// big number beside the cell instead of inside it.
import { Lightning } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

const WAVE = "M800 56.9c-155.5 0-204.9-50-405.5-49.9-200 0-250 49.9-394.5 49.9v31.7h800v-.2-31.4z";

export function BatteryCell({ percent, charging, state, className }: { percent: number | null; charging: boolean; state: string; className?: string }) {
  const p = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const low = percent !== null && p <= 15 && !charging;
  const liquid = low ? "var(--destructive)" : "var(--primary)";
  return (
    <div className={cn("flex items-center gap-5", className)}>
      {/* The cell: a terminal on top, the capsule, the liquid to the charge. */}
      <div className="relative flex shrink-0 flex-col items-center" aria-hidden="true">
        <span className="h-[5px] w-[18px] rounded-t-[3px] bg-white/[0.14]" />
        <div className="relative h-[92px] w-[56px] overflow-hidden rounded-[15px] bg-[oklch(14.5%_0.006_45)] shadow-[inset_0_1px_3px_rgb(0_0_0/0.6),0_1px_0_rgb(255_255_255/0.05)] ring-1 ring-white/[0.09]">
          <div className="absolute inset-x-0 bottom-0 transition-[height] duration-700 ease-fluid" style={{ height: `${p}%` }}>
            <div className="absolute inset-0 top-[6px]" style={{ background: `linear-gradient(180deg, ${liquid}, color-mix(in oklch, ${liquid} 62%, black))` }} />
            {/* The dot display's grid, faint, over the liquid. */}
            <div className="absolute inset-0 top-[6px] opacity-[0.16] [background-image:radial-gradient(circle,rgb(0_0_0)_0.9px,transparent_1.2px)] [background-size:4px_4px]" />
            {p > 0 && p < 100 && (
              <>
                {/* Two periods of the wave side by side: shifting by one period loops without a seam. */}
                <svg viewBox="0 0 1600 88.6" preserveAspectRatio="none" className={cn("absolute -top-[2px] left-0 h-[10px] w-[400%] opacity-50", charging && "animate-[battery-wave_10s_linear_infinite] motion-reduce:animate-none")} style={{ fill: liquid }}>
                  <path d={WAVE} />
                  <path d={WAVE} transform="translate(800 0)" />
                </svg>
                <svg viewBox="0 0 1600 88.6" preserveAspectRatio="none" className={cn("absolute -top-[1px] left-[-70%] h-[8px] w-[400%]", charging && "animate-[battery-wave_7s_linear_infinite] motion-reduce:animate-none")} style={{ fill: liquid }}>
                  <path d={WAVE} />
                  <path d={WAVE} transform="translate(800 0)" />
                </svg>
              </>
            )}
          </div>
          {charging && (
            <span className="absolute inset-0 grid place-items-center">
              <Lightning size={22} weight="fill" className="text-[oklch(99%_0.006_45)] drop-shadow-[0_1px_2px_rgb(0_0_0/0.45)]" />
            </span>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="label-caps">Battery</span>
        <span className={cn("display-num tabular mt-2 text-[44px] leading-none tracking-[-0.045em]", low ? "text-destructive" : "text-high")}>{percent === null ? "—" : `${percent}%`}</span>
        <span className="mt-1.5 whitespace-nowrap text-[12.5px] text-medium">{state}</span>
      </div>
    </div>
  );
}
