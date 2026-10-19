// The Advanced Keys tab's flow, the same on every keyboard: pick a type from cards (each with a plain
// description and an Add button), then three guided steps (pick the key, set it up, review and save),
// and a list of what is active, with how many of the keyboard's slots are used. Each type can carry a
// game-legality note. Pure UI: the panel supplies the types, the steps' contents and the writes.
import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, Prohibit, Trash, Warning, type Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "@/components/ui/matte";
import { Pill, StepButton } from "@/components/keyboard/parts";
import { KeyBoard, SelectionBar, type MapLayout } from "./keymap";

export interface Legality {
  /** banned: a rule exists on a big platform. caution: depends on the game or league. */
  level: "banned" | "caution";
  text: string;
}

/** The note for snap tap / SOCD, which several games and leagues forbid. */
export const SOCD_LEGALITY: Legality = {
  level: "banned",
  text: "Banned on CS2 Valve servers, and by most CS2 tournaments. Other games differ, so check the rules before you use it.",
};
export const TOGGLE_LEGALITY: Legality = {
  level: "caution",
  text: "A key that holds itself can count as automation in some games and leagues. Check the rules of yours.",
};
export const MULTI_ACTION_LEGALITY: Legality = {
  level: "caution",
  text: "One press doing several things is allowed in most games, but some competitive leagues limit it. Check yours.",
};

export interface AdvType {
  id: string;
  title: string;
  /** One or two plain sentences. */
  blurb: string;
  icon: Icon;
  /** How many keys step 1 asks for. */
  pick: 1 | 2;
  /** Names of the three steps. */
  steps: readonly [string, string, string];
  legality?: Legality;
  /** Why it can't be added right now (full, nothing to pick from...). */
  unavailable?: string | null;
}

export interface ActiveKey {
  id: string;
  typeId: string;
  title: string;
  detail: string;
  legality?: Legality;
  onRemove: () => void;
}

export interface AdvFlow {
  typeId: string;
  /** 0 pick the key, 1 set it up, 2 review. */
  step: 0 | 1 | 2;
  keys: number[];
}

export function LegalityNote({ legality, compact }: { legality: Legality; compact?: boolean }) {
  const banned = legality.level === "banned";
  const IconCmp = banned ? Prohibit : Warning;
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-control text-[12px] leading-relaxed ring-1",
        compact ? "px-2.5 py-1.5" : "px-3 py-2",
        banned ? "bg-destructive/[0.07] text-destructive ring-destructive/25" : "bg-chart-3/[0.06] text-chart-3 ring-chart-3/20",
      )}
    >
      <IconCmp size={14} weight="light" className="mt-0.5 shrink-0" />
      <span>{legality.text}</span>
    </p>
  );
}

/** The rules in a word or two, the whole note on hover: banned (red) or check your league (amber). */
function LegalityChip({ legality }: { legality: Legality }) {
  const banned = legality.level === "banned";
  const IconCmp = banned ? Prohibit : Warning;
  return (
    <span
      title={legality.text}
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] ring-1",
        banned ? "bg-destructive/[0.07] text-destructive ring-destructive/25" : "bg-chart-3/[0.06] text-chart-3 ring-chart-3/20",
      )}
    >
      <IconCmp size={12} weight="light" className="shrink-0" />
      {banned ? "Banned on CS2 Valve servers" : "Check your league's rules"}
    </span>
  );
}

function TypeCard({ type, disabled, onAdd }: { type: AdvType; disabled: boolean; onAdd: () => void }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-control bg-white/[0.025] p-3.5 ring-1 ring-white/[0.06]">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-small bg-primary/[0.12] text-primary ring-1 ring-primary/25">
          <type.icon size={16} weight="light" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-high">{type.title}</p>
          <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed text-medium" title={type.blurb}>{type.blurb}</p>
        </div>
      </div>
      {/* The rules, short here (the whole note shows again before saving). */}
      {type.legality && <LegalityChip legality={type.legality} />}
      <div className="mt-auto flex items-center gap-3">
        {type.unavailable && <span className="min-w-0 flex-1 text-[11.5px] text-medium">{type.unavailable}</span>}
        <Pill primary className="ml-auto" disabled={disabled || !!type.unavailable} onClick={onAdd}>
          Add
        </Pill>
      </div>
    </div>
  );
}

function Stepper({ steps, at }: { steps: readonly string[]; at: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1.5" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-[12.5px] ring-1 transition-colors duration-500 ease-fluid",
              i === at ? "bg-primary/[0.12] text-high ring-primary/35" : i < at ? "bg-white/[0.03] text-medium ring-white/[0.06]" : "text-medium ring-transparent",
            )}
          >
            <span className={cn("tabular grid size-5 place-items-center rounded-full text-[11px]", i === at ? "bg-primary text-primary-foreground" : "bg-white/[0.07]")}>
              {i < at ? <Check size={12} weight="bold" /> : i + 1}
            </span>
            {s}
          </span>
          {i < steps.length - 1 && <span className="h-px w-4 bg-white/[0.08]" />}
        </li>
      ))}
    </ol>
  );
}

export function AdvancedKeysFlow({
  types,
  active,
  max,
  canWrite,
  lockedNote,
  flow,
  setFlow,
  layout,
  keyNames,
  setup,
  review,
  canSave,
  saving,
  onSave,
  slotsNote,
}: {
  types: readonly AdvType[];
  active: readonly ActiveKey[];
  /** How many advanced keys the keyboard can hold. */
  max: number;
  canWrite: boolean;
  /** Said at the top when changes are off ("Turn on Allow changes first"). */
  lockedNote?: string | null;
  flow: AdvFlow | null;
  setFlow: (f: AdvFlow | null) => void;
  /** The key map for step 1, with any advanced keys already marked. */
  layout: MapLayout;
  keyNames: (ids: number[]) => string;
  /** Step 2's controls for the type being added. Null: this type has nothing to set up. */
  setup: ReactNode | null;
  /** Step 3's summary of what will be written. */
  review: ReactNode;
  /** Step 2 is filled in well enough to review. */
  canSave: boolean;
  saving?: boolean;
  onSave: () => void;
  slotsNote?: string;
}) {
  const type = flow ? types.find((t) => t.id === flow.typeId) : undefined;
  const full = active.length >= max;
  const goNext = () => {
    if (!flow || !type) return;
    if (flow.step === 0) setFlow({ ...flow, step: setup === null ? 2 : 1 });
    else if (flow.step === 1) setFlow({ ...flow, step: 2 });
  };
  const goBack = () => {
    if (!flow) return;
    if (flow.step === 2) setFlow({ ...flow, step: setup === null ? 0 : 1 });
    else if (flow.step === 1) setFlow({ ...flow, step: 0 });
  };
  const picked = flow && type ? flow.keys.length === type.pick : false;

  return (
    <>
      {lockedNote && (
        <p className="flex items-center gap-2 rounded-control bg-chart-3/[0.06] px-4 py-3 text-[13px] text-chart-3 ring-1 ring-chart-3/20">
          <Warning size={16} weight="light" className="shrink-0" />
          {lockedNote}
        </p>
      )}

      {/* Side by side on a wide window: adding one on the left, what the keyboard runs now on the right. */}
      <div className="grid items-start gap-4 min-[1300px]:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          {!flow || !type ? (
            <Card>
              <CardHeader title="Pick a type" hint="Each one changes what a key does. Nothing is written until you review and save." />
              <div className="grid gap-3 px-5 pb-5 pt-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
                {types.map((t) => (
                  <TypeCard key={t.id} type={t} disabled={!canWrite || full} onAdd={() => setFlow({ typeId: t.id, step: 0, keys: [] })} />
                ))}
              </div>
              {full && <p className="px-5 pb-4 text-[12px] text-medium">All {max} slots are used. Remove one below to add another.</p>}
            </Card>
          ) : (
            <Card>
              <CardHeader
                title={`Add: ${type.title}`}
                hint={type.blurb}
                right={
                  <button onClick={() => setFlow(null)} className="rounded-small px-3 py-1.5 text-[12.5px] text-medium transition-colors hover:bg-white/[0.06] hover:text-high">
                    Cancel
                  </button>
                }
              />
              <div className="flex flex-col gap-4 px-5 pb-5 pt-4">
                <Stepper steps={setup === null ? [type.steps[0], type.steps[2]] : type.steps} at={flow.step === 2 && setup === null ? 1 : flow.step} />

                {flow.step === 0 && (
                  <>
                    <KeyBoard layout={layout} selected={flow.keys} multi onSelect={(ids) => setFlow({ ...flow, keys: type.pick === 1 ? ids.slice(-1) : ids.slice(-2) })} label={type.steps[0]} />
                    <SelectionBar
                      count={flow.keys.length}
                      names={keyNames(flow.keys)}
                      onDiscard={() => setFlow({ ...flow, keys: [] })}
                      hint={type.pick === 1 ? "Select the key" : "Select the two keys"}
                      sub={type.pick === 1 ? "One key." : "Two opposite keys, like A and D."}
                    />
                  </>
                )}
                {flow.step === 1 && setup}
                {flow.step === 2 && (
                  <div className="flex flex-col gap-3">
                    {review}
                    {type.legality && <LegalityNote legality={type.legality} />}
                  </div>
                )}

                <div className="flex items-center gap-2 border-t border-white/[0.05] pt-4">
                  {flow.step > 0 && (
                    <Pill onClick={goBack}>
                      <span className="flex items-center gap-1.5">
                        <ArrowLeft size={12} /> Back
                      </span>
                    </Pill>
                  )}
                  <span className="flex-1" />
                  {flow.step < 2 ? (
                    <Pill primary disabled={flow.step === 0 ? !picked : !canSave} onClick={goNext}>
                      <span className="flex items-center gap-1.5">
                        Next <ArrowRight size={12} />
                      </span>
                    </Pill>
                  ) : (
                    <Pill primary disabled={!canWrite || !canSave || saving} onClick={onSave}>
                      {saving ? "Saving…" : "Save to the keyboard"}
                    </Pill>
                  )}
                </div>
              </div>
            </Card>
          )}
        </div>
        <Card>
          <CardHeader
            title="Active advanced keys"
            hint={slotsNote ?? "What the keyboard runs now."}
            right={
              <span role="status" className={cn("tabular rounded-full px-3 py-1 text-[12.5px] ring-1", full ? "bg-chart-3/[0.08] text-chart-3 ring-chart-3/25" : "bg-white/[0.04] text-high ring-white/[0.08]")} aria-label={`${active.length} of ${max} used`}>
                {active.length} / {max}
              </span>
            }
          />
          <div className="flex flex-col gap-2.5 px-5 pb-5 pt-4">
            {active.length === 0 && <p className="text-[12.5px] text-medium">None yet. Pick a type to add one.</p>}
            {active.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-control bg-white/[0.02] px-3.5 py-2.5 ring-1 ring-white/[0.05]">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-high">{a.title}</p>
                  <p className="truncate text-[11.5px] text-medium">{a.detail}</p>
                </div>
                {a.legality?.level === "banned" && (
                  <span className="hidden shrink-0 items-center gap-1 rounded-full bg-destructive/[0.08] px-2 py-0.5 text-[11px] text-destructive ring-1 ring-destructive/25 sm:inline-flex" title={a.legality.text}>
                    <Prohibit size={12} /> Banned on CS2 Valve servers
                  </span>
                )}
                <StepButton label={`Remove ${a.title}`} disabled={!canWrite} onClick={a.onRemove}>
                  <Trash size={12} />
                </StepButton>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
