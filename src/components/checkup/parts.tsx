// The checkup's pieces: the progress ring, the colour of a result, one finding with its Fix it, and the live
// pictures each step shows (the click pad, the keys, the held key, a countdown). Pure drawing.
import type { ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowRight, Check, Lock, Warning, WarningOctagon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { MiniKey } from "@/components/keyboard/parts";
import { keyLabel } from "@/lib/checkup/keyboard";
import type { Finding, Level } from "@/lib/checkup/types";

/** The colours a result can have: green, amber, red (fixed hues, so a red accent never reads as a problem). */
export const LEVEL_TONE: Record<Level, { text: string; dot: string; ring: string; stroke: string; label: string }> = {
  good: { text: "text-emerald-300", dot: "bg-emerald-300 shadow-[0_0_8px_rgb(110_231_183/0.6)]", ring: "bg-emerald-300/[0.08] ring-emerald-300/25", stroke: "rgb(110 231 183)", label: "Good" },
  warn: { text: "text-chart-3", dot: "bg-chart-3 shadow-[0_0_8px_var(--chart-3)]", ring: "bg-chart-3/[0.07] ring-chart-3/25", stroke: "var(--chart-3)", label: "Have a look" },
  bad: { text: "text-destructive", dot: "bg-destructive shadow-[0_0_8px_var(--destructive)]", ring: "bg-destructive/[0.08] ring-destructive/25", stroke: "var(--destructive)", label: "Needs attention" },
};

/** A ring that fills clockwise; the middle holds whatever the step shows (a count, seconds, a tick). */
export function ProgressRing({ value, size = 132, stroke = 7, color = "var(--primary)", children }: { value: number; size?: number; stroke?: number; color?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.min(1, Math.max(0, value));
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.06)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={false}
          animate={{ strokeDashoffset: c * (1 - v) }}
          transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

export function LevelPill({ level }: { level: Level }) {
  const t = LEVEL_TONE[level];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] ring-1", t.ring, t.text)}>
      <span className={cn("size-1.5 rounded-full", t.dot)} aria-hidden="true" />
      {t.label}
    </span>
  );
}

const LEVEL_ICON = { good: Check, warn: Warning, bad: WarningOctagon } as const;

/** One finding: what was found, the numbers, and Fix it (or what to do instead). */
export function FindingRow({ f, onFix, onOpen, fixed }: { f: Finding; onFix?: () => void; onOpen?: () => void; fixed?: boolean }) {
  const Icon = LEVEL_ICON[f.level];
  const t = LEVEL_TONE[f.level];
  return (
    <li className="flex gap-3 py-3 first:pt-1 last:pb-1" data-finding={f.id}>
      <Icon size={16} weight={f.level === "good" ? "bold" : "light"} className={cn("mt-0.5 shrink-0", t.text)} aria-label={t.label} />
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] leading-snug text-high">{f.title}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-medium">{f.detail}</p>
        {f.advice && <p className="mt-1 text-[12.5px] leading-relaxed text-medium">{f.advice}</p>}
        {(f.fix || f.open) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {f.fix &&
              (fixed ? (
                <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-300">
                  <Check size={12} /> Fixed on the device
                </span>
              ) : (
                <button
                  onClick={onFix}
                  disabled={!!f.fix.blocked}
                  title={f.fix.blocked}
                  className="group inline-flex h-8 items-center gap-2 rounded-small bg-foreground pl-3.5 pr-1.5 text-[12.5px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.98] disabled:bg-white/[0.06] disabled:font-normal disabled:text-medium"
                >
                  {f.fix.blocked && <Lock size={12} />}
                  Fix it: {f.fix.label.replace(/^./, (c) => c.toLowerCase())}
                  <span className="grid size-5 place-items-center rounded bg-background/10 transition-transform duration-500 ease-fluid group-hover:translate-x-0.5 group-disabled:hidden">
                    <ArrowRight size={12} weight="bold" />
                  </span>
                </button>
              ))}
            {f.open && (
              <button onClick={onOpen} className="inline-flex h-8 items-center rounded-small bg-white/[0.05] px-3.5 text-[12.5px] text-high ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.09]">
                {f.open.label}
              </button>
            )}
            {f.fix?.blocked && !fixed && <span className="text-[11.5px] text-medium">{f.fix.blocked}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

/** The click pad: a big quiet target with the count in the middle. */
export function ClickPad({ count, target }: { count: number; target: number }) {
  return (
    <div className="grid h-[220px] w-full cursor-pointer select-none place-items-center rounded-control bg-white/[0.02] ring-1 ring-dashed ring-white/[0.08]" data-slot="click-pad">
      <ProgressRing value={count / target} size={148}>
        <motion.div key={count} initial={{ scale: 0.92, opacity: 0.6 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.18 }}>
          <p className="tabular text-[34px] font-medium leading-none tracking-tight text-high">{count}</p>
          <p className="mt-1 text-[11.5px] text-medium">of {target}</p>
        </motion.div>
      </ProgressRing>
    </div>
  );
}

/** The keys to press, each lighting up once it has been pressed and let go. */
export function KeyRow({ codes, done, down }: { codes: readonly string[]; done: ReadonlySet<string>; down: ReadonlySet<string> }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2" data-slot="key-row">
      {codes.map((c) => (
        <span key={c} className={cn("transition-transform duration-150", down.has(c) && "translate-y-[1px]")}>
          <MiniKey lit={done.has(c) || down.has(c)}>
            <span className={cn(c === "Space" && "px-6")}>{keyLabel(c)}</span>
          </MiniKey>
        </span>
      ))}
    </div>
  );
}

/** The held key: it fills while it stays down. */
export function HoldKey({ code, progress, down }: { code: string; progress: number; down: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3" data-slot="hold-key">
      <div className={cn("relative grid size-[88px] place-items-center overflow-hidden rounded-control ring-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.06),inset_0_-3px_0_rgb(0_0_0/0.45)] transition-colors", down ? "bg-primary/[0.12] ring-primary/45" : "bg-white/[0.035] ring-white/[0.08]")}>
        <motion.span className="absolute inset-x-0 bottom-0 bg-primary/25" initial={false} animate={{ height: `${Math.min(1, progress) * 100}%` }} transition={{ duration: 0.12, ease: "linear" }} />
        <span className="relative text-[26px] font-medium text-high">{keyLabel(code)}</span>
      </div>
      <p className="text-[12px] text-medium">{down ? <span className="tabular">{(Math.min(1, progress) * 2).toFixed(1)} s</span> : progress >= 1 ? "Let go" : "Press and hold"}</p>
    </div>
  );
}

/** Seconds left, as a ring. */
export function Countdown({ total, left, label }: { total: number; left: number; label?: string }) {
  return (
    <ProgressRing value={1 - left / total} size={148}>
      <div>
        <p className="tabular text-[34px] font-medium leading-none tracking-tight text-high">{Math.max(0, Math.ceil(left))}</p>
        <p className="mt-1 text-[11.5px] text-medium">{label ?? "seconds"}</p>
      </div>
    </ProgressRing>
  );
}

/** A slow orbit to follow while moving the mouse in circles. */
export function CircleGuide({ moving }: { moving: boolean }) {
  return (
    <div className="relative grid size-[148px] place-items-center" aria-hidden="true">
      <span className="absolute inset-3 rounded-full ring-1 ring-white/[0.08]" />
      <motion.span className="absolute inset-0" animate={{ rotate: 360 }} transition={{ duration: moving ? 0.9 : 2.4, ease: "linear", repeat: Infinity }}>
        <span className="absolute left-1/2 top-3 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_12px_var(--primary)]" />
      </motion.span>
      <p className="text-[12px] text-medium">{moving ? "Keep going" : "Start moving"}</p>
    </div>
  );
}
