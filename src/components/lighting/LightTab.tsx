// A lamp page's main tab: the whole lamp in one colour (the wheel, the recent and saved colours) or in white (warm
// to cool), and its brightness, all in one card: the wheel, the colours, and a tall brightness pill filled with the
// light's own colour (src/components/ui/squish-slider.tsx). Every change shows on the lamp drawing at once and goes to
// the lamp at about 14 writes a second (src/lib/lighting/lamp.ts).
import { useState, type CSSProperties } from "react";
import { Plus } from "@phosphor-icons/react";
import { kelvinRgb, type Rgb } from "@/lib/lighting/govee/frames";
import { KELVIN_STEP } from "@/lib/lighting/govee/kelvin";
import type { LampControl, LampView } from "@/lib/lighting/lamp";
import { forgetColour, hexOf, rememberColour, rgbOf, saveColour, useLightingKeep } from "@/lib/lighting/saved";
import { Card, CardHeader } from "@/components/ui/matte";
import { SquishSlider } from "@/components/ui/squish-slider";
import { ColourWheel } from "./ColourWheel";
import { LightSlider, Segmented, SubHead, Swatch, css } from "./controls";

const WHITES = [
  { k: 2700, name: "Candle" },
  { k: 3000, name: "Warm" },
  { k: 4000, name: "Neutral" },
  { k: 5000, name: "Daylight" },
  { k: 6500, name: "Cool" },
] as const;

/** Warm to cool, across a light's white range. */
const whiteTrack = ([lo, hi]: readonly [number, number]) => `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((f) => css(kelvinRgb(lo + (hi - lo) * f))).join(", ")})`;

const same = (a: Rgb, b: Rgb) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** What the Light tab drives: a Bluetooth lamp (or all of them), or a Wi-Fi light (src/lib/lighting/net/control.ts). */
export type BasicLight = Pick<LampControl, "setColour" | "setWhite" | "setBrightness" | "segments"> & { spec: { kelvin: readonly [number, number] | null }; whiteOnly?: boolean };

/** `group`: the Lights view, where a change goes to every light in the group (the copy says so). */
/** `compact`: the scenes sit under it on the same tab, so the wheel and the brightness pill are smaller and the card keeps its height. */
export function LightTab({ control, view, group = false, compact = false }: { control: BasicLight; view: LampView; group?: boolean; compact?: boolean }) {
  const keep = useLightingKeep();
  // A light without a white range (its model's table has none) shows colour only; one without colour, white only.
  const range = control.spec.kelvin;
  const [K_MIN, K_MAX] = range ?? [2700, 6500];
  // Until the person picks, the controls follow what the lamp reports (its first reports arrive just after opening).
  const [modePick, setMode] = useState<"colour" | "white" | null>(null);
  const mode = control.whiteOnly && range ? "white" : range ? (modePick ?? (view.mode === "white" ? "white" : "colour")) : "colour";
  const uniform = view.segments.every((c) => same(c, view.segments[0]));
  const [pick, setPicked] = useState<Rgb | null>(null);
  const picked: Rgb = pick ?? (uniform ? view.segments[0] : [255, 42, 212]);
  const [kelvinPick, setKelvin] = useState<number | null>(null);
  const kelvin = kelvinPick ?? view.kelvin ?? 4000;
  const brightness = view.brightness ?? 50;
  const lit = css(mode === "white" ? kelvinRgb(kelvin) : picked);

  const colour = (c: Rgb, commit = false) => {
    setPicked(c);
    control.setColour(c);
    if (commit) rememberColour(c);
  };

  return (
    <Card className={compact ? undefined : "grow"} innerClassName="flex flex-col pb-5">
      <CardHeader
        title={mode === "colour" ? "Colour" : "White"}
        hint={
          mode === "white"
            ? `${K_MIN}-${K_MAX} K, from candle-warm to cool daylight.${group ? " A light without a white of its own shows it as a colour." : ""}`
            : group
              ? "Every light in the group in one colour."
              : control.segments > 1
                ? "The whole light in one colour. To give each segment its own, paint on the drawing."
                : "The whole light in one colour."
        }
        right={
          range && !control.whiteOnly && <Segmented
            label="Colour or white"
            value={mode}
            options={[
              { id: "colour", label: "Colour" },
              { id: "white", label: "White" },
            ]}
            onChange={(m) => {
              setMode(m);
              if (m === "white") control.setWhite(kelvin);
              else colour(picked);
            }}
          />
        }
      />
      {/* Narrow: the wheel (or the whites) beside the brightness pill, the colours under them. Wide: all three in a row. */}
      <div className="@container mt-4 flex flex-1 items-center px-5">
        <div className="grid w-full grid-cols-[minmax(0,1fr)_88px] items-center gap-5 @min-[620px]:grid-cols-[minmax(160px,var(--wheel))_minmax(0,1fr)_96px] @min-[620px]:gap-7" style={{ "--wheel": compact ? "clamp(190px, calc(100dvh - 820px), 260px)" : "clamp(220px, calc(100dvh - 700px), 380px)" } as CSSProperties}>
          {mode === "colour" ? (
            <>
              <div className="mx-auto w-full max-w-[var(--wheel)]">
                <ColourWheel value={picked} onChange={(c) => colour(c)} onCommit={(c) => rememberColour(c)} />
              </div>
              <div className="col-span-2 row-start-2 flex min-w-0 max-w-[440px] flex-col gap-4 @min-[620px]:col-span-1 @min-[620px]:row-start-auto">
                <div className="flex items-center gap-3">
                  <span className="size-10 shrink-0 rounded-control ring-1 ring-white/15" style={{ background: css(picked) }} aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="tabular truncate text-[15px] uppercase text-high">{hexOf(picked)}</p>
                    <p className="truncate text-[12px] text-medium">On the wheel</p>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <SubHead>Recent</SubHead>
                  <div className="flex flex-wrap gap-2">
                    {keep.recent.length ? keep.recent.map((h) => <Swatch key={h} colour={h} label={h} selected={h === hexOf(picked)} onClick={() => colour(rgbOf(h), true)} />) : <p className="text-[12px] text-medium">Colours you pick show up here.</p>}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <SubHead
                    right={
                      <button
                        type="button"
                        onClick={() => saveColour(picked)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-tight px-2 py-0.5 text-[12px] text-medium ring-1 ring-white/10 transition-colors hover:bg-white/[0.06] hover:text-high"
                      >
                        <Plus size={12} /> Save colour
                      </button>
                    }
                  >
                    Saved
                  </SubHead>
                  <div className="flex flex-wrap gap-2">
                    {keep.saved.length ? (
                      keep.saved.map((h) => <Swatch key={h} colour={h} label={h} selected={h === hexOf(picked)} onClick={() => colour(rgbOf(h), true)} onRemove={() => forgetColour(h)} />)
                    ) : (
                      <p className="text-[12px] text-medium">Save colour keeps the one on the wheel.</p>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex min-w-0 flex-col gap-4 @min-[620px]:col-span-2">
              <LightSlider
                label="Colour temperature"
                value={kelvin}
                min={K_MIN}
                max={K_MAX}
                step={KELVIN_STEP}
                track={whiteTrack([K_MIN, K_MAX])}
                thumb={css(kelvinRgb(kelvin))}
                format={(k) => `${k} K`}
                onChange={(k) => {
                  setKelvin(k);
                  control.setWhite(k);
                }}
                testId="light-kelvin"
              />
              <div className="flex flex-wrap gap-2">
                {WHITES.filter((w) => w.k >= K_MIN && w.k <= K_MAX).map((w) => (
                  <button
                    key={w.k}
                    type="button"
                    onClick={() => {
                      setKelvin(w.k);
                      control.setWhite(w.k);
                    }}
                    className="inline-flex items-center gap-2 rounded-full bg-white/[0.04] py-1 pl-1.5 pr-3 text-[12.5px] text-medium ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.08] hover:text-high aria-pressed:text-high aria-pressed:ring-white/25"
                    aria-pressed={kelvin === w.k}
                  >
                    <span className="size-4 rounded-full ring-1 ring-white/20" style={{ background: css(kelvinRgb(w.k)) }} />
                    {w.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-col items-center gap-2">
            <span className="tabular text-[14px] font-semibold text-high">{brightness}%</span>
            <SquishSlider label="Brightness" value={brightness} fill={lit} onChange={(v) => control.setBrightness(v)} testId="light-brightness" className="h-[var(--wheel)] min-h-[180px] w-full" />
            <span className="text-[11.5px] text-medium">Brightness</span>
          </div>
        </div>
      </div>
    </Card>
  );
}
