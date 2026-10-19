// A lamp page's Music tab: the lamp's own music modes, which listen with the lamp's microphone (SYNQ doesn't listen
// or send any sound). A mode, its sensitivity, its style, and the lamp's own colours or one colour of yours; every
// change goes to the lamp at once.
import { useState } from "react";
import { MusicNotes, Pulse, Waveform, Wind } from "@phosphor-icons/react";
import type { Rgb } from "@/lib/lighting/govee/frames";
import type { LampControl, LampView, MusicSettings } from "@/lib/lighting/lamp";
import { hexOf, rgbOf, useLightingKeep } from "@/lib/lighting/saved";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "@/components/ui/matte";
import { ColourWheel } from "./ColourWheel";
import { LightSlider, Segmented, SubHead, Swatch, css } from "./controls";

const ABOUT: Record<number, { text: string; icon: typeof Pulse }> = {
  0x05: { text: "Bright bursts on the beat", icon: MusicNotes },
  0x03: { text: "Pulses with the rhythm", icon: Pulse },
  0x04: { text: "Colours follow lows and highs", icon: Waveform },
  0x06: { text: "Light rolls along it", icon: Wind },
};

const DEFAULT: Omit<MusicSettings, "mode"> = { sensitivity: 70, style: 0, colour: null };

export function MusicTab({ control, view }: { control: LampControl; view: LampView }) {
  const keep = useLightingKeep();
  const modes = control.spec.music;
  const [m, setM] = useState<MusicSettings>(view.music ?? { ...DEFAULT, mode: modes[0]?.id ?? 0 });
  const [colour, setColour] = useState<Rgb>(view.music?.colour ?? [255, 42, 212]);
  const playing = view.mode === "music";

  const send = (next: MusicSettings) => {
    setM(next);
    control.setMusic(next);
  };
  const change = (patch: Partial<MusicSettings>) => send({ ...m, ...patch });

  return (
    <>
      <Card innerClassName="pb-5">
        <CardHeader title="Music" hint="The light listens with its own microphone and moves to what it hears. SYNQ doesn't listen or send any sound." />
        <div className="mt-4 grid gap-3 px-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" }} data-testid="light-music">
          {modes.map((mode) => {
            const on = playing && m.mode === mode.id;
            const IconCmp = ABOUT[mode.id]?.icon ?? MusicNotes;
            return (
              <button
                key={mode.id}
                type="button"
                aria-pressed={on}
                onClick={() => change({ mode: mode.id })}
                className={cn(
                  "flex items-start gap-3 rounded-control bg-white/[0.025] p-3.5 text-left ring-1 transition-[background-color,box-shadow] duration-300 ease-fluid hover:bg-white/[0.05]",
                  on ? "ring-primary/60 shadow-[0_0_18px_-6px_var(--primary)]" : "ring-white/[0.06]",
                )}
              >
                <span className={cn("grid size-8 shrink-0 place-items-center rounded-small ring-1", on ? "bg-primary/[0.15] text-primary ring-primary/30" : "bg-white/[0.04] text-medium ring-white/[0.08]")}>
                  <IconCmp size={16} weight="light" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] text-high">{mode.name}</span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-medium">{ABOUT[mode.id]?.text}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-5 flex flex-col gap-4 px-5">
          <LightSlider label="Sensitivity" value={m.sensitivity} min={0} max={99} track="linear-gradient(to right, #1c1c22, #8b8b95)" format={(v) => `${v}`} onChange={(v) => change({ sensitivity: v })} testId="music-sensitivity" />
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[12.5px] text-medium">Style</span>
            <Segmented
              label="Style"
              value={String(m.style)}
              options={[
                { id: "0", label: "Dynamic" },
                { id: "1", label: "Calm" },
              ]}
              onChange={(v) => change({ style: Number(v) })}
            />
          </div>
        </div>
      </Card>
      <Card innerClassName="pb-5">
        <CardHeader
          title="Colours"
          hint={m.colour ? "One colour of yours, moving to the music." : "The light picks its own colours as the music changes."}
          right={
            <Segmented
              label="Music colours"
              value={m.colour ? "mine" : "lamp"}
              options={[
                { id: "lamp", label: "Its own" },
                { id: "mine", label: "One colour" },
              ]}
              onChange={(v) => change({ colour: v === "mine" ? colour : null })}
            />
          }
        />
        {m.colour && (
          <div className="mt-4 grid grid-cols-[minmax(130px,200px)_minmax(0,1fr)] items-start gap-6 px-5">
            <ColourWheel
              value={colour}
              onChange={(c) => {
                setColour(c);
                change({ colour: c });
              }}
            />
            <div className="flex min-w-0 flex-col gap-2">
              <SubHead>Saved colours</SubHead>
              <div className="flex flex-wrap gap-2">
                {keep.saved.length ? (
                  keep.saved.map((h) => (
                    <Swatch
                      key={h}
                      colour={h}
                      label={h}
                      selected={h === hexOf(colour)}
                      onClick={() => {
                        setColour(rgbOf(h));
                        change({ colour: rgbOf(h) });
                      }}
                    />
                  ))
                ) : (
                  <span className="text-[12px] text-medium">Colours saved on the Light tab show up here.</span>
                )}
              </div>
              <span className="mt-1 size-10 rounded-control ring-1 ring-white/15" style={{ background: css(colour) }} aria-hidden="true" />
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
