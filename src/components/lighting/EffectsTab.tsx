// A lamp page's Effects tab (Govee's "DIY"): the person's own effects, kept in SYNQ (lighting.json), and the editor
// that makes them: up to eight colours, a motion style and its variant (or a mix of up to four styles), and a speed.
// "Try it" and a saved effect's Apply upload the effect (the bridge checks its shape) and switch the lamp to it.
import { useState } from "react";
import { Lightning, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";
import type { Rgb } from "@/lib/lighting/govee/frames";
import { DIY_STYLES } from "@/lib/lighting/govee/diy";
import type { DiyEffect, LampControl } from "@/lib/lighting/lamp";
import { forgetDiy, hexOf, rgbOf, saveDiy, useLightingKeep } from "@/lib/lighting/saved";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "@/components/ui/matte";
import { ColourWheel } from "./ColourWheel";
import { Chip, IconButton, LightSlider, SubHead, Swatch, css } from "./controls";
import { LightPreview, type Motion } from "./preview";

const MAX_COLOURS = 8;
const MAX_MIX = 4;

/** How each style's preview moves (by family). */
const MOTION: Record<number, Motion> = { 0: "flow", 1: "jump", 2: "flash", 3: "stripes", 4: "flash", 8: "flow", 9: "flow", 10: "stripes" };
const previewSeconds = (speed: number) => 8 - 6.8 * (speed / 100);

const styleOf = (family: number) => DIY_STYLES.find((s) => s.family === family) ?? DIY_STYLES[0];
const variantName = (family: number, variant: number) => styleOf(family).variants.find((v) => v.variant === variant)?.name ?? "";

/** What a saved effect is, in a few words ("Marquee · Gather · speed 70"). */
export function diySummary(d: DiyEffect): string {
  if (d.combo && d.combo.length > 1) return `Mix of ${d.combo.map((p) => styleOf(p.family).name).join(", ")} · speed ${d.speed}`;
  const s = styleOf(d.family);
  return [s.name, s.variants.length > 1 ? variantName(d.family, d.variant) : "", s.rate === "speed" ? `speed ${d.speed}` : "with the music"].filter(Boolean).join(" · ");
}

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `diy-${Date.now()}`);

/** Effects to start from while none are saved. */
const STARTERS: readonly Omit<DiyEffect, "id">[] = [
  { name: "Sunset fade", family: 0, variant: 0, speed: 30, colours: [[255, 60, 0], [255, 138, 61], [255, 42, 138]] },
  { name: "Ocean flow", family: 9, variant: 9, speed: 45, colours: [[0, 42, 255], [0, 179, 255], [0, 255, 213]] },
  { name: "Party marquee", family: 3, variant: 4, speed: 75, colours: [[255, 42, 212], [138, 42, 255], [0, 229, 255], [255, 212, 0]] },
];

const previewOf = (d: DiyEffect) => {
  const family = d.combo && d.combo.length > 1 ? d.combo[0].family : d.family;
  return { colours: d.colours.map(hexOf), motion: MOTION[family] ?? "flow", seconds: previewSeconds(d.speed), reverse: variantName(d.family, d.variant) === "Backward" };
};

export function EffectsTab({ control, onError }: { control: LampControl; onError: (why: string) => void }) {
  const keep = useLightingKeep();
  const [draft, setDraft] = useState<DiyEffect>(() => ({ ...STARTERS[0], id: newId() }));
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const style = styleOf(draft.family);
  const mix = draft.combo ?? [];

  const edit = (patch: Partial<DiyEffect>) => setDraft((d) => ({ ...d, ...patch }));
  const pickStyle = (family: number) => edit({ family, variant: styleOf(family).variants[0].variant });
  const setColour = (c: Rgb) => edit({ colours: draft.colours.map((x, i) => (i === at ? c : x)) });

  const apply = async (d: DiyEffect) => {
    setBusy(d.id);
    try {
      await control.applyDiy(d);
    } catch (e) {
      onError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(null);
    }
  };
  const open = (d: Omit<DiyEffect, "id"> & { id?: string }) => {
    setDraft({ ...d, id: d.id ?? newId(), colours: [...d.colours], combo: d.combo ? [...d.combo] : undefined });
    setAt(0);
  };
  const saved = keep.diy.some((d) => d.id === draft.id);

  return (
    <>
      <Card innerClassName="pb-5">
        <CardHeader title="Your effects" hint="Made here and kept in SYNQ. Apply sends one to the light." />
        <div className="mt-4 grid gap-3 px-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }} data-testid="light-effects">
          {keep.diy.map((d) => (
            <div key={d.id} className={cn("flex flex-col gap-2.5 rounded-control bg-white/[0.025] p-2.5 ring-1", d.id === draft.id ? "ring-white/20" : "ring-white/[0.06]")}>
              <LightPreview {...previewOf(d)} className="h-12 w-full" />
              <div className="flex items-start gap-2 px-0.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-tight text-high [overflow-wrap:anywhere]">{d.name}</p>
                  <p className="mt-0.5 text-[11.5px] leading-snug text-medium">{diySummary(d)}</p>
                </div>
                <IconButton label={`Edit ${d.name}`} onClick={() => open(d)}>
                  <PencilSimple size={14} />
                </IconButton>
                <IconButton label={`Delete ${d.name}`} onClick={() => forgetDiy(d.id)}>
                  <Trash size={14} />
                </IconButton>
              </div>
              <button
                type="button"
                onClick={() => void apply(d)}
                disabled={busy !== null}
                className="inline-flex items-center justify-center gap-1.5 rounded-small bg-white/[0.06] py-1.5 text-[12.5px] text-high ring-1 ring-white/[0.1] transition-colors hover:bg-white/[0.1] disabled:cursor-wait disabled:opacity-60"
              >
                {busy === d.id ? <span className="size-1.5 animate-pulse rounded-full bg-white/70" /> : <Lightning size={12} />}
                {busy === d.id ? "Sending" : "Apply"}
              </button>
            </div>
          ))}
          {!keep.diy.length && (
            <div className="col-span-full flex flex-wrap items-center gap-2 text-[12.5px] text-medium">
              <span>Nothing saved yet. Start from:</span>
              {STARTERS.map((s) => (
                <button key={s.name} type="button" onClick={() => open(s)} className="inline-flex items-center gap-2 rounded-full bg-white/[0.04] py-1 pl-1 pr-3 text-high ring-1 ring-white/[0.08] hover:bg-white/[0.08]">
                  <LightPreview colours={s.colours.map(hexOf)} motion={MOTION[s.family]} seconds={previewSeconds(s.speed)} className="h-4 w-8 rounded-full" />
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card innerClassName="pb-5">
        <CardHeader
          title={saved ? "Edit effect" : "Make an effect"}
          hint="Colours, a motion and its speed. Try it on the light, then save it."
          right={
            <button type="button" onClick={() => open({ ...STARTERS[0], name: "My effect" })} className="inline-flex shrink-0 items-center gap-1 rounded-small px-2.5 py-1 text-[12px] text-medium ring-1 ring-white/10 hover:bg-white/[0.06] hover:text-high">
              <Plus size={12} /> New
            </button>
          }
        />
        <div className="mt-4 flex flex-col gap-4 px-5">
          <LightPreview {...previewOf(draft)} className="h-12 w-full" />
          {/* Side by side on a wide card: what it is and how it moves on the left, its colours on the right. */}
          <div className="@container">
          <div className="grid items-start gap-6 @min-[700px]:grid-cols-[minmax(0,1fr)_minmax(300px,0.85fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <label className="flex max-w-sm flex-col gap-1.5 text-[12.5px] text-medium">
                Name
                <input
                  value={draft.name}
                  maxLength={32}
                  onChange={(e) => edit({ name: e.target.value })}
                  className="h-9 rounded-control bg-white/[0.04] px-3 text-[13.5px] text-high outline-none ring-1 ring-white/[0.08] focus:ring-white/25"
                  data-testid="diy-name"
                />
              </label>
              <div className="flex flex-col gap-2.5">
                <SubHead>Motion</SubHead>
                <div className="flex flex-wrap gap-2">
                  {DIY_STYLES.map((s) => (
                    <Chip key={s.family} on={s.family === draft.family} onClick={() => pickStyle(s.family)}>
                      {s.name}
                    </Chip>
                  ))}
                </div>
                {style.variants.length > 1 && (
                  <div className="flex flex-wrap gap-2">
                    {style.variants.map((v) => (
                      <Chip key={v.variant} on={v.variant === draft.variant} small onClick={() => edit({ variant: v.variant })}>
                        {v.name}
                      </Chip>
                    ))}
                  </div>
                )}
                {style.combo && (
                  <div className="flex flex-wrap items-center gap-2 text-[12px] text-medium">
                    <button
                      type="button"
                      disabled={mix.length >= MAX_MIX}
                      onClick={() => edit({ combo: [...mix, { family: draft.family, variant: draft.variant }] })}
                      className="inline-flex items-center gap-1 rounded-small px-2.5 py-1 ring-1 ring-white/10 hover:bg-white/[0.06] hover:text-high disabled:opacity-40"
                    >
                      <Plus size={12} /> Add to a mix
                    </button>
                    {mix.map((p, i) => (
                      <span key={i} className="inline-flex items-center gap-1 rounded-full bg-white/[0.05] py-0.5 pl-2.5 pr-1 text-high ring-1 ring-white/[0.08]">
                        {styleOf(p.family).name}
                        {styleOf(p.family).variants.length > 1 ? ` · ${variantName(p.family, p.variant)}` : ""}
                        <button type="button" aria-label="Remove from the mix" onClick={() => edit({ combo: mix.filter((_, j) => j !== i) })} className="grid size-4 place-items-center rounded-full hover:bg-white/10">
                          <X size={10} weight="bold" />
                        </button>
                      </span>
                    ))}
                    {mix.length === 1 && <span>A mix needs two or more.</span>}
                  </div>
                )}
              </div>
              {style.rate === "speed" || mix.length > 1 ? (
                <LightSlider label="Speed" value={draft.speed} min={0} max={100} track="linear-gradient(to right, #1c1c22, #8b8b95)" format={(v) => `${v}`} onChange={(v) => edit({ speed: v })} />
              ) : (
                <p className="text-[12.5px] text-medium">This style follows the music the light hears with its own microphone.</p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void apply(effectOf(draft))}
                  disabled={busy !== null}
                  data-testid="diy-try"
                  className="inline-flex items-center gap-1.5 rounded-small bg-primary/[0.14] px-4 py-1.5 text-[13px] text-high ring-1 ring-primary/35 transition-colors hover:bg-primary/[0.2] disabled:cursor-wait disabled:opacity-60"
                >
                  <Lightning size={12} /> {busy === draft.id ? "Sending" : "Try it on the light"}
                </button>
                <button
                  type="button"
                  onClick={() => saveDiy(effectOf(draft))}
                  data-testid="diy-save"
                  className="rounded-small bg-white/[0.06] px-4 py-1.5 text-[13px] text-high ring-1 ring-white/[0.1] transition-colors hover:bg-white/[0.1]"
                >
                  {saved ? "Save changes" : "Save"}
                </button>
              </div>
            </div>
              <div className="grid grid-cols-[minmax(110px,170px)_minmax(0,1fr)] items-start gap-5">
                <ColourWheel value={draft.colours[at] ?? [255, 255, 255]} onChange={setColour} />
                <div className="flex min-w-0 flex-col gap-3">
                  <SubHead>Colours ({draft.colours.length} of {MAX_COLOURS})</SubHead>
                  <div className="flex flex-wrap items-center gap-2">
                    {draft.colours.map((c, i) => (
                      <Swatch key={i} colour={css(c)} label={`Colour ${i + 1}: ${hexOf(c)}`} selected={i === at} onClick={() => setAt(i)} size={28} />
                    ))}
                    <IconButton
                      label="Add a colour"
                      disabled={draft.colours.length >= MAX_COLOURS}
                      onClick={() => {
                        edit({ colours: [...draft.colours, draft.colours[at] ?? [255, 255, 255]] });
                        setAt(draft.colours.length);
                      }}
                    >
                      <Plus size={14} />
                    </IconButton>
                    <IconButton
                      label="Remove the picked colour"
                      disabled={draft.colours.length <= 1}
                      onClick={() => {
                        edit({ colours: draft.colours.filter((_, i) => i !== at) });
                        setAt(Math.max(0, at - 1));
                      }}
                    >
                      <Trash size={14} />
                    </IconButton>
                  </div>
                  {keep.saved.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {keep.saved.map((h) => (
                        <Swatch key={h} colour={h} label={`Use ${h}`} size={20} onClick={() => setColour(rgbOf(h))} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
          </div>
          </div>
        </div>
      </Card>
    </>
  );
}

/** The effect as sent and kept: a name, and a mix only when it has two styles or more. */
function effectOf(d: DiyEffect): DiyEffect {
  return { ...d, name: d.name.trim() || "My effect", combo: d.combo && d.combo.length > 1 ? d.combo : undefined };
}
