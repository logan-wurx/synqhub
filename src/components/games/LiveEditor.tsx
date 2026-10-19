// A live game profile's settings for one mouse or keyboard (src/lib/profiles/live.ts): the same controls as its
// device page, bounded by what the device can take. Nothing is sent while editing; SYNQ puts the settings on when the
// game starts and the everyday ones back when it ends.
import { Plus } from "@phosphor-icons/react";
import { NumberField } from "@/components/ui/number-field";
import { StageEditor, rateLabel } from "@/components/mouse/parts";
import { Chip, SwitchRow } from "@/components/keyboard/parts";
import type { KeyboardFeel, KeyboardTarget, LodLevel, MouseFeel, MouseTarget } from "@/lib/feel/types";

/** A mouse's settings on a wide card: DPI and polling on the left, lift-off, debounce and the switches on the right (so the
 * page fits above the dock without scrolling). */
export const MOUSE_COLS = "grid gap-x-10 gap-y-5 px-5 pb-5 min-[1200px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[12.5px] text-medium">{label}</p>
      {children}
    </div>
  );
}

export function MouseFeelEditor({ target, value, onChange }: { target: MouseTarget; value: MouseFeel; onChange: (v: MouseFeel) => void }) {
  const set = (patch: Partial<MouseFeel>) => onChange({ ...value, ...patch });
  const dpi = target.dpi;
  const stages = target.stages;
  const fixed = stages?.fixedCount != null;
  const max = Math.min(stages?.max ?? 1, 8);
  return (
    <div className={MOUSE_COLS}>
      <div className="flex flex-col gap-5">
        {dpi && stages && (
          <Field label="DPI steps (the star is the one it starts on)">
            <div className="flex flex-wrap gap-3">
              {value.stages.map((d, i) => (
                <StageEditor
                  key={i}
                  index={i}
                  value={d}
                  isDefault={i === value.active}
                  step={dpi.step}
                  min={dpi.min}
                  max={dpi.max}
                  disabled={false}
                  onChange={(v) => set({ stages: value.stages.map((x, j) => (j === i ? v : x)) })}
                  onDefault={() => set({ active: i })}
                  onRemove={!fixed && value.stages.length > 1 ? () => set({ stages: value.stages.filter((_, j) => j !== i), active: Math.min(value.active >= i && value.active > 0 ? value.active - 1 : value.active, value.stages.length - 2) }) : undefined}
                />
              ))}
              {!fixed && value.stages.length < max && (
                <button
                  type="button"
                  aria-label="Add a DPI step"
                  title="Add a DPI step"
                  onClick={() => set({ stages: [...value.stages, Math.min(dpi.max, (value.stages[value.stages.length - 1] ?? 800) * 2)] })}
                  className="grid w-[118px] place-items-center rounded-control text-medium ring-1 ring-dashed ring-white/[0.1] hover:text-high"
                >
                  <Plus size={16} weight="light" />
                </button>
              )}
            </div>
          </Field>
        )}
        {dpi && !stages && (
          <Field label="DPI">
            {dpi.options?.length ? (
              <div className="flex flex-wrap gap-1.5">
                {dpi.options.map((d) => (
                  <Chip key={d} numeric on={value.stages[value.active] === d} onClick={() => set({ stages: [d], active: 0 })}>
                    {d}
                  </Chip>
                ))}
              </div>
            ) : (
              <NumberField label="DPI" value={value.stages[value.active] ?? dpi.min} min={dpi.min} max={dpi.max} step={dpi.step} onChange={(d) => set({ stages: [d], active: 0 })} />
            )}
          </Field>
        )}
        {target.polling && value.pollingHz !== null && (
          <Field label="Polling rate">
            <div className="flex flex-wrap gap-1.5">
              {target.polling.options.map((hz) => (
                <Chip key={hz} numeric on={value.pollingHz === hz} onClick={() => set({ pollingHz: hz })}>
                  {rateLabel(hz)} Hz
                </Chip>
              ))}
            </div>
          </Field>
        )}
      </div>
      <div className="flex flex-col gap-5">
        {(target.lod || target.debounce) && (
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
            {target.lod?.kind === "mm" && value.lod?.kind === "mm" && (
              <Field label="Lift-off distance">
                <NumberField label="Lift-off" value={value.lod.mm} min={target.lod.min} max={target.lod.max} step={target.lod.step} decimals={1} unit="mm" onChange={(mm) => set({ lod: { kind: "mm", mm: Math.round(mm * 10) / 10, min: target.lod?.kind === "mm" ? target.lod.min : undefined, max: target.lod?.kind === "mm" ? target.lod.max : undefined } })} />
              </Field>
            )}
            {target.lod?.kind === "levels" && value.lod?.kind === "level" && (
              <Field label="Lift-off distance">
                <div className="flex flex-wrap gap-1.5">
                  {target.lod.levels.map((level: LodLevel) => (
                    <Chip key={level} on={value.lod?.kind === "level" && value.lod.level === level} onClick={() => set({ lod: { kind: "level", level } })}>
                      {level}
                    </Chip>
                  ))}
                </div>
              </Field>
            )}
            {target.debounce && value.debounceMs !== null && (
              <Field label="Debounce">
                <div className="flex flex-wrap gap-1.5">
                  {target.debounce.options.map((ms) => (
                    <Chip key={ms} numeric on={value.debounceMs === ms} onClick={() => set({ debounceMs: ms })}>
                      {ms} ms
                    </Chip>
                  ))}
                </div>
              </Field>
            )}
          </div>
        )}
        {(target.toggles.motionSync || target.toggles.angleSnapping || target.toggles.ripple) && (
          <div className="divide-y divide-white/[0.05]">
            {target.toggles.motionSync && value.motionSync !== null && <SwitchRow title="Motion sync" hint="Lines sensor frames up with polling; a touch smoother, a touch later." checked={value.motionSync} onChange={(motionSync) => set({ motionSync })} />}
            {target.toggles.angleSnapping && value.angleSnapping !== null && <SwitchRow title="Angle snapping" hint="Straightens slightly wobbly lines." checked={value.angleSnapping} onChange={(angleSnapping) => set({ angleSnapping })} />}
            {target.toggles.ripple && value.ripple !== null && <SwitchRow title="Ripple control" hint="Smooths jitter at high DPI, with a little delay." checked={value.ripple} onChange={(ripple) => set({ ripple })} />}
          </div>
        )}
      </div>
    </div>
  );
}

export function KeyboardFeelEditor({ target, value, onChange }: { target: KeyboardTarget; value: KeyboardFeel; onChange: (v: KeyboardFeel) => void }) {
  const set = (patch: Partial<KeyboardFeel>) => onChange({ ...value, ...patch });
  const a = target.actuation;
  const rt = target.rtSensitivity;
  const rtOn = !!value.rapidTrigger;
  return (
    <div className="flex flex-col gap-4 px-5 pb-5">
      <div className="flex flex-wrap items-end gap-5">
        {a && value.actuationMm !== null && (
          <Field label="Actuation, every key">
            <NumberField label="Actuation" value={value.actuationMm} min={a.min} max={a.max} step={a.step} largeStep={0.1} decimals={2} unit="mm" onChange={(actuationMm) => set({ actuationMm })} />
          </Field>
        )}
        {rt && rtOn && value.rtPressMm !== null && value.rtReleaseMm !== null && (
          rt.independent ? (
            <>
              <Field label="Press sensitivity">
                <NumberField label="Press" value={value.rtPressMm} min={rt.min} max={rt.max} step={rt.step} decimals={2} unit="mm" onChange={(rtPressMm) => set({ rtPressMm })} />
              </Field>
              <Field label="Release sensitivity">
                <NumberField label="Release" value={value.rtReleaseMm} min={rt.min} max={rt.max} step={rt.step} decimals={2} unit="mm" onChange={(rtReleaseMm) => set({ rtReleaseMm })} />
              </Field>
            </>
          ) : (
            <Field label="Rapid trigger sensitivity">
              <NumberField label="Sensitivity" value={value.rtPressMm} min={rt.min} max={rt.max} step={rt.step} decimals={2} unit="mm" onChange={(mm) => set({ rtPressMm: mm, rtReleaseMm: mm })} />
            </Field>
          )
        )}
      </div>
      {target.rapidTrigger && value.rapidTrigger !== null && <SwitchRow title="Rapid trigger" hint="A key resets as soon as it starts to rise, and fires again as soon as it goes down." checked={value.rapidTrigger} onChange={(rapidTrigger) => set({ rapidTrigger })} />}
    </div>
  );
}
