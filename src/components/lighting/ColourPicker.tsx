// One colour for a PC light (a Dynamic Lighting device, a hub channel): the lamp pages' wheel with its hex readout, a
// row of ready colours, and the recent and saved colours they share (src/lib/lighting/saved.ts): every light picks alike.
import { Plus } from "@phosphor-icons/react";
import type { Rgb } from "@/lib/lighting/govee/frames";
import { forgetColour, hexOf, rememberColour, rgbOf, saveColour, useLightingKeep } from "@/lib/lighting/saved";
import { ColourWheel } from "./ColourWheel";
import { BRUSHES, SubHead, Swatch, css } from "./controls";

export function ColourPicker({ value, onChange, disabled, caption = "On the wheel" }: { value: Rgb; onChange: (c: Rgb, done: boolean) => void; disabled?: boolean; caption?: string }) {
  const keep = useLightingKeep();
  const pick = (c: Rgb) => {
    rememberColour(c);
    onChange(c, true);
  };
  const row = (hexes: readonly string[], remove?: (h: string) => void) =>
    hexes.map((h) => <Swatch key={h} colour={h} label={h} selected={h === hexOf(value)} onClick={() => !disabled && pick(rgbOf(h))} onRemove={remove && (() => remove(h))} />);
  return (
    <div className="grid grid-cols-[minmax(150px,240px)_minmax(0,1fr)] items-start gap-6">
      <ColourWheel value={value} disabled={disabled} onChange={(c) => onChange(c, false)} onCommit={pick} />
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className="size-10 shrink-0 rounded-2xl ring-1 ring-white/15" style={{ background: css(value) }} aria-hidden="true" />
          <div className="min-w-0">
            <p className="tabular truncate text-[15px] uppercase text-foreground">{hexOf(value)}</p>
            <p className="truncate text-[12px] text-muted-foreground">{caption}</p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <SubHead>Colours</SubHead>
          <div className="flex flex-wrap gap-2">{row(BRUSHES)}</div>
        </div>
        <div className="flex flex-col gap-2">
          <SubHead>Recent</SubHead>
          <div className="flex flex-wrap gap-2">{keep.recent.length ? row(keep.recent) : <p className="text-[12px] text-muted-foreground/80">Colours you pick show up here.</p>}</div>
        </div>
        <div className="flex flex-col gap-2">
          <SubHead
            right={
              <button
                type="button"
                onClick={() => saveColour(value)}
                className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] text-muted-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                <Plus size={11} /> Save colour
              </button>
            }
          >
            Saved
          </SubHead>
          <div className="flex flex-wrap gap-2">{keep.saved.length ? row(keep.saved, forgetColour) : <p className="text-[12px] text-muted-foreground/80">Save colour keeps the one on the wheel.</p>}</div>
        </div>
      </div>
    </div>
  );
}
