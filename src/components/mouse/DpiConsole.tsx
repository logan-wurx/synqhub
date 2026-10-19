// The Sensitivity console every mouse shares on its Overview, with one place to set a speed. On the left, a card for
// the speed: the number the mouse runs now in big rolling digits (NumberFlow), its steps as keys under it (a click
// runs a step; steps are added and removed there and saved with Save), and the DPI fader with its detents
// (src/components/ui/detent-slider.tsx), which sets the step that runs. On the right, a card each for how it tracks:
// the polling rate as a level track of ember pixels (src/components/ui/rate-track.tsx) and the lift-off distance
// (./lift-off.tsx). A mouse SYNQ can't set straight away (no fader) keeps the steps' values editable in a rack on the
// right of one card instead, with the polling rate and lift-off beside the number.
import { useId, useState, type ReactNode } from "react";
import NumberFlow from "@number-flow/react";
import { motion, useReducedMotion } from "motion/react";
import { Lightning, Minus, Plus, X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { RateTrack } from "@/components/ui/rate-track";
import { DpiPresets, rateLabel } from "./parts";
import { CardFigure, ConsoleCard, InConsoleCard } from "./console-card";

/** The rate as rolling digits and a suffix: 8000 is [8, "K"]. */
const rateFigure = (hz: number): [number, string] => (hz >= 1000 ? [hz / 1000, "K"] : [hz, ""]);
/** How often the mouse reports at a rate: "a report every 0.125 ms". */
const reportEvery = (hz: number) => `A report every ${+(1000 / hz).toFixed(3)} ms`;

/** The polling rate, when the mouse can set it: shown as a level track beside the speed. */
export interface PollingPick {
  hz: number;
  options: readonly number[];
  disabled: boolean;
  onPick: (hz: number) => void;
  /** Said on hover: what the rate goes through, what it costs. */
  hint?: string;
  /** Beside the label: where the setting is kept. */
  badge?: ReactNode;
}

export interface DpiSteps {
  stages: number[];
  active: number;
  min: number;
  max: number;
  step: number;
  maxStages: number;
  /** Values can change (some drivers only show them). */
  editable: boolean;
  /** Steps can be added and removed. */
  countEditable: boolean;
  disabled: boolean;
  hint: string;
  dirty: boolean;
  busy: boolean;
  saveLabel: { dirty: string; clean: string };
  onChange: (stages: number[], active: number) => void;
  onSave?: () => void;
}

const METER = 24;
/** The meters and the fader read the same scale: log, up to 12800 unless the mouse goes lower. */
const share = (v: number, min: number, max: number) => {
  const top = Math.min(max, 12800);
  return Math.max(0, Math.min(1, Math.log(Math.max(v, min) / min) / Math.log(top / min)));
};

export function DpiConsole({
  dpi,
  range,
  pick,
  badge,
  footnote,
  steps,
  polling,
  extras,
}: {
  dpi: number;
  range: { min: number; max: number };
  /** The fader and the exact field, when the speed can be set straight away. */
  pick?: { step: number; disabled: boolean; onPick: (dpi: number) => void };
  /** Beside the label: where the setting is kept. */
  badge?: ReactNode;
  footnote?: string;
  steps?: DpiSteps;
  polling?: PollingPick;
  /** After the polling rate: the lift-off distance (LiftOffLevels, which makes its own card on the right). */
  extras?: ReactNode;
}) {
  const reduce = useReducedMotion();
  const uid = useId();
  const clampStep = (v: number) => (steps ? Math.max(steps.min, Math.min(steps.max, Math.round(v / steps.step) * steps.step)) : v);
  const set = (i: number, v: number) => steps && steps.onChange(steps.stages.map((x, j) => (j === i ? v : x)), steps.active);
  // With a fader, the steps are keys that pick the step that runs (straight away, unless steps are being added or
  // removed), and the fader sets its speed: one place for a speed. Without one, the rack edits the steps' values.
  const keys = !!pick && !!steps;
  const rack = !!steps && !pick;
  const run = (i: number) => {
    if (!steps) return;
    if (pick && !steps.dirty) pick.onPick(steps.stages[i]);
    else steps.onChange(steps.stages, i);
  };
  // How it tracks (the polling rate, lift-off): cards on the right when the speed is set with the fader, beside the
  // number when the rack takes the right.
  const rated = !!polling && polling.options.length > 1;
  const tracking = rated || !!extras;
  const cards = tracking && !!pick;
  const right = rack;
  // The rate the polling card's corner shows: the one the thumb is on as it moves.
  const [shownHz, setShownHz] = useState<number | null>(null);
  const hz = shownHz ?? polling?.hz ?? 0;
  const trackingBlock = () => (
    <div className="flex w-[272px] shrink-0 flex-col gap-6 self-center">
      {polling && rated && (
        <div className="flex flex-col items-start gap-2.5" title={polling.hint}>
          <RateTrack label="Polling rate" options={polling.options} value={polling.hz} format={rateLabel} unit="Hz" detail={reportEvery} figure={rateFigure} disabled={polling.disabled} onChange={polling.onPick} width={272} />
          {polling.badge && <span className="flex items-center gap-2">{polling.badge}</span>}
        </div>
      )}
      {extras}
    </div>
  );

  // The speed: the number it runs now, the steps as keys, the fader.
  const speed = (
      <div className="flex min-w-0 flex-1 flex-col px-8 pb-7 pt-7 max-sm:px-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-[18px] font-semibold tracking-[-0.02em] text-high">Pointer speed</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-medium">{keys && steps ? steps.hint : "The speed the mouse runs now."}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3 pt-1">
            {steps && steps.stages.length > 1 && <span className="label-caps text-faint">Step {steps.active + 1}</span>}
            {badge}
          </div>
        </div>
        {/* The number and its keys sit in the middle of the room the console has (it fills the tab on a tall window). */}
        {/* Beside the number (rack mode), the tracking block wraps under it when the number needs the room. */}
        <div className="flex flex-1 flex-wrap items-center gap-x-6 gap-y-5 py-1">
          <div className="flex flex-1 flex-col justify-center">
            <p className="flex items-baseline gap-3">
              <NumberFlow value={dpi} className="display-num tabular text-[clamp(84px,max(min(7vw,112px),min(10vw,calc(100dvh-940px))),168px)] leading-[0.9] tracking-[-0.06em] text-high" />
              <span className="text-[20px] font-medium text-medium">DPI</span>
            </p>
            {keys && steps && (
              <div className="mt-5">
                <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="The step the mouse runs">
                  {steps.stages.map((v, i) => {
                    const on = i === steps.active;
                    return (
                      <span key={i} className="group/key relative">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={on}
                          disabled={steps.disabled || !steps.editable || (on && !steps.dirty)}
                          onClick={() => run(i)}
                          title={on ? "The mouse runs this step" : `Run step ${i + 1} (${v} DPI)`}
                          className={cn(
                            "flex h-10 items-center gap-2.5 rounded-full pl-3 pr-4 text-[14px] ring-1 transition-colors duration-300 ease-fluid disabled:cursor-default",
                            on ? "bg-primary/[0.14] font-semibold text-high ring-primary/45" : "bg-shade/[0.18] text-medium ring-white/[0.08] enabled:hover:text-high",
                          )}
                        >
                          <span className={cn("size-2 rounded-full transition-colors duration-300", on ? "bg-primary" : "bg-white/20")} aria-hidden="true" />
                          <span className="tabular">{v}</span>
                        </button>
                        {steps.countEditable && steps.stages.length > 1 && !steps.disabled && (
                          <button
                            type="button"
                            aria-label={`Remove step ${i + 1}`}
                            onClick={() => steps.onChange(steps.stages.filter((_, j) => j !== i), Math.min(steps.active > i ? steps.active - 1 : steps.active, steps.stages.length - 2))}
                            className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-[oklch(26%_0.006_50)] text-medium opacity-0 ring-1 ring-white/[0.12] transition-opacity hover:text-high focus-visible:opacity-100 group-hover/key:opacity-100"
                          >
                            <X size={10} weight="bold" />
                          </button>
                        )}
                      </span>
                    );
                  })}
                  {steps.countEditable && !steps.disabled && steps.stages.length < steps.maxStages && (
                    <button
                      type="button"
                      aria-label="Add a step"
                      title="Add a step"
                      onClick={() => steps.onChange([...steps.stages, Math.min((steps.stages[steps.stages.length - 1] ?? 800) * 2, steps.max)], steps.active)}
                      className="grid size-10 place-items-center rounded-full border border-dashed border-white/[0.16] text-medium transition-colors hover:bg-white/[0.04] hover:text-high"
                    >
                      <Plus size={14} />
                    </button>
                  )}
                  {steps.onSave && steps.dirty && (
                    <button
                      disabled={steps.busy || steps.disabled}
                      onClick={steps.onSave}
                      className="group flex h-10 items-center gap-2 rounded-control bg-foreground pl-4 pr-1.5 text-[13px] font-medium text-background transition-all duration-300 ease-fluid active:scale-[0.98] disabled:opacity-60"
                    >
                      {steps.busy ? "Saving…" : steps.saveLabel.dirty}
                      <span className="grid size-7 place-items-center rounded bg-shade/10 transition-transform duration-500 ease-fluid group-hover:translate-x-0.5">
                        <Lightning size={12} weight="fill" />
                      </span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
          {tracking && !cards && trackingBlock()}
        </div>
        <div className="pt-1">
          {pick ? (
            <DpiPresets value={dpi} min={range.min} max={range.max} step={pick.step} disabled={pick.disabled} onPick={pick.onPick} />
          ) : (
            !steps?.editable && <p className="text-[12.5px] text-medium">SYNQ shows this mouse's speed; its driver can't change it from here.</p>
          )}
          {footnote && <p className="mt-2 text-[12px] text-medium">{footnote}</p>}
        </div>
      </div>

  );

  if (cards)
    return (
      <div className="grid grow gap-4 min-[1100px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section aria-label="Pointer speed" className="tile relative flex overflow-hidden rounded-card">
          {speed}
        </section>
        {/* How it tracks: a card for the polling rate, one for lift-off. */}
        <div className="flex min-w-0 flex-col gap-4 max-[1099px]:grid max-[1099px]:grid-cols-2 max-sm:grid-cols-1">
          {polling && rated && (
            <ConsoleCard
              title="Polling rate"
              hint="How often your mouse reports movement."
              tip={polling.hint}
              figure={
                <CardFigure unit="Hz">
                  <NumberFlow value={rateFigure(hz)[0]} suffix={rateFigure(hz)[1]} />
                </CardFigure>
              }
            >
              <RateTrack bare label="Polling rate" options={polling.options} value={polling.hz} format={rateLabel} unit="Hz" detail={reportEvery} disabled={polling.disabled} onChange={polling.onPick} onPreview={setShownHz} />
              {polling.badge && <span className="mt-2 flex items-center gap-2">{polling.badge}</span>}
            </ConsoleCard>
          )}
          <InConsoleCard.Provider value={true}>{extras}</InConsoleCard.Provider>
        </div>
      </div>
    );

  return (
    <section aria-label="Sensitivity" className={cn("tile relative grid grow overflow-hidden rounded-card", right && "min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")}>
      {speed}

      {/* Without a fader, the steps' values are set here, as a rack of channels. */}
      {rack && steps && (
        <div className="flex min-w-0 flex-col border-white/[0.08] px-6 pb-6 pt-6 min-[1100px]:border-l max-[1099px]:border-t">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-[18px] font-semibold tracking-[-0.02em] text-high">DPI steps</h3>
              <p className="mt-1 text-[12.5px] leading-relaxed text-medium">{steps.hint}</p>
            </div>
            {steps.onSave && (
              <button
                disabled={!steps.dirty || steps.busy || steps.disabled}
                onClick={steps.onSave}
                className="group flex h-9 shrink-0 items-center gap-2 rounded-control bg-foreground pl-4 pr-1.5 text-[13px] font-medium text-background transition-all duration-300 ease-fluid active:scale-[0.98] disabled:bg-white/[0.06] disabled:text-medium"
              >
                {steps.busy ? "Saving…" : steps.dirty ? steps.saveLabel.dirty : steps.saveLabel.clean}
                <span className="grid size-6 place-items-center rounded bg-shade/10 transition-transform duration-500 ease-fluid group-hover:translate-x-0.5">
                  <Lightning size={12} weight="fill" />
                </span>
              </button>
            )}
          </div>

          <ul className={cn("mt-4 flex flex-1 flex-col justify-center gap-1.5", (steps.disabled || !steps.editable) && "opacity-70")}>
            {steps.stages.map((v, i) => {
              const on = i === steps.active;
              const lit = Math.round(share(v, steps.min, steps.max) * METER);
              const nudge = (dir: number) => set(i, clampStep(v + dir * (v >= 1600 ? 200 : 50)));
              return (
                <li key={i} className="group relative flex min-h-[54px] flex-1 items-center gap-4 rounded-control px-3 [max-height:92px]">
                  {on && (
                    <motion.span
                      layoutId={`${uid}-on`}
                      aria-hidden="true"
                      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 36 }}
                      className="absolute inset-0 rounded-control bg-primary/[0.1] ring-1 ring-primary/30"
                    />
                  )}
                  <button
                    type="button"
                    disabled={steps.disabled || !steps.editable}
                    onClick={() => steps.onChange(steps.stages, i)}
                    title={on ? "The mouse runs this step" : "Run this step"}
                    className={cn("relative grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold tabular-nums transition-colors duration-300", on ? "bg-primary text-primary-foreground" : "bg-white/[0.07] text-medium hover:text-high")}
                  >
                    {i + 1}
                  </button>
                  {/* How fast this step is, as an LED meter (the same scale as the fader). */}
                  <span className="relative flex h-[clamp(24px,42%,52px)] flex-1 items-end justify-between gap-[4px]" aria-hidden="true">
                    {Array.from({ length: METER }, (_, b) => (
                      <span
                        key={b}
                        className={cn("min-w-[5px] max-w-[12px] flex-1 rounded-full transition-colors duration-300", b < lit ? (on ? "bg-primary" : "bg-foreground/60") : "bg-white/[0.1]")}
                        style={{ height: `${40 + (b / (METER - 1)) * 60}%` }}
                      />
                    ))}
                  </span>
                  <input
                    aria-label={`Step ${i + 1} DPI`}
                    disabled={steps.disabled || !steps.editable}
                    value={v}
                    inputMode="numeric"
                    onChange={(e) => {
                      const n = Number(e.target.value.replace(/\D/g, ""));
                      if (Number.isFinite(n)) set(i, n);
                    }}
                    onBlur={() => set(i, clampStep(v))}
                    className="tabular relative w-[clamp(76px,7dvh,96px)] bg-transparent text-right text-[clamp(22px,2.6dvh,30px)] font-bold tracking-[-0.02em] text-high outline-none"
                  />
                  <span className="relative flex shrink-0 gap-1">
                    {[-1, 1].map((dir) => (
                      <button
                        key={dir}
                        type="button"
                        aria-label={`${dir < 0 ? "Lower" : "Raise"} step ${i + 1}`}
                        disabled={steps.disabled || !steps.editable}
                        onClick={() => nudge(dir)}
                        className="grid size-8 place-items-center rounded-full bg-white/[0.06] text-medium ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.1] hover:text-high disabled:opacity-40"
                      >
                        {dir < 0 ? <Minus size={12} /> : <Plus size={12} />}
                      </button>
                    ))}
                  </span>
                  {steps.countEditable && steps.stages.length > 1 && !steps.disabled && (
                    <button
                      type="button"
                      aria-label={`Remove step ${i + 1}`}
                      onClick={() => steps.onChange(steps.stages.filter((_, j) => j !== i), Math.min(steps.active > i ? steps.active - 1 : steps.active, steps.stages.length - 2))}
                      className="relative grid size-7 shrink-0 place-items-center rounded-full text-medium opacity-0 transition-opacity hover:text-high focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <X size={12} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {steps.countEditable && !steps.disabled && steps.stages.length < steps.maxStages && (
            <button
              type="button"
              onClick={() => steps.onChange([...steps.stages, Math.min((steps.stages[steps.stages.length - 1] ?? 800) * 2, steps.max)], steps.active)}
              className="mt-1.5 flex h-[46px] items-center justify-center gap-2 rounded-control border border-dashed border-white/[0.12] text-[13px] text-medium transition-colors hover:bg-white/[0.03] hover:text-high"
            >
              <Plus size={14} /> Add a step
            </button>
          )}
        </div>
      )}
    </section>
  );
}
