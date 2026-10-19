// The Gear page as a stage: the active device big, with its one number and the slider that sets it (the active card's
// job, so the page shows no active card in this layout), and every device in a rail of small photos grouped by kind.
// Pointing at a photo shows that device on the stage; clicking makes it the active device; a double click opens it.
// Loaded only when picked (the header's layout switch).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, Check } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { useGridRoom } from "@/lib/viewport";
import { useKeptState } from "@/lib/keep";
import { openDevice, SOUND_ID } from "@/lib/nav";
import { soundLabel, useSound } from "@/lib/sound";
import type { DeviceEntry } from "@/lib/device-model";
import type { Step } from "@/lib/feel/types";
import { SpotlightLight, spotlightMove } from "@/components/ui/spotlight";
import { Tilt } from "@/components/ui/tilt";
import { BarSlider } from "@/components/ui/bar-slider";
import { FaceArt, useDeviceFace } from "../device-face";
import { glanceOf } from "../ActiveCard";
import { useGroups, type LayoutProps } from "./shared";

interface SpotlightProps extends LayoutProps {
  active: DeviceEntry | null;
  onPick: (id: string) => void;
  onSet: (entry: DeviceEntry, steps: Step[], said: string) => void;
}

export default function GearSpotlight({ entries, active, onPick, onSet, onIntent }: SpotlightProps) {
  const groups = useGroups(entries);
  const { ref, w, room } = useGridRoom<HTMLDivElement>([groups.length]);
  const [hover, setHover] = useState<string | null>(null);
  const spot = entries.find((e) => e.id === hover) ?? active ?? entries[0] ?? null;
  // A group is as wide as its chips or its label, whichever is wider ("WEBCAMS 1" is wider than one chip).
  const labels = useRef<(HTMLSpanElement | null)[]>([]);
  const [labelW, setLabelW] = useState<number[]>([]);
  useLayoutEffect(() => {
    const measure = () => {
      const next = groups.map((_, i) => Math.ceil(labels.current[i]?.getBoundingClientRect().width ?? 0));
      setLabelW((was) => (was.join() === next.join() ? was : next));
    };
    measure();
    // Again once the type has loaded and whenever a label changes width.
    const ro = new ResizeObserver(measure);
    for (const el of labels.current.slice(0, groups.length)) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [groups, w]);
  const fit = fitRail(w, groups.map((g, i) => ({ n: g.items.length, label: labelW[i] ?? 0 })));
  return (
    <div ref={ref} className="flex flex-col gap-4" style={{ height: Math.max(420, room) }} data-slot="gear-spotlight">
      {spot && <Stage entry={spot} active={spot.id === active?.id} onSet={onSet} />}
      <nav
        aria-label="All devices"
        className={cn("panel flex shrink-0 items-end rounded-card px-6 pb-4 pt-3", fit.scroll ? "overflow-x-auto overflow-y-hidden" : "overflow-hidden")}
        style={{ height: fit.chip + 64, columnGap: fit.gap }}
        onPointerLeave={() => setHover(null)}
      >
        {groups.map((g, gi) => (
          <div key={g.id} className="flex shrink-0 flex-col gap-2">
            <span
              ref={(el) => {
                labels.current[gi] = el;
              }}
              className="label-caps w-fit whitespace-nowrap"
            >
              {g.label} <span className="font-mono text-medium">{g.items.length}</span>
            </span>
            <div className="flex gap-2">
              {g.items.map((e) => (
                <RailChip
                  key={e.id}
                  entry={e}
                  size={fit.chip}
                  on={e.id === spot?.id}
                  active={e.id === active?.id}
                  onShow={() => {
                    setHover(e.id);
                    onIntent?.(e.kind);
                  }}
                  onPick={() => {
                    onPick(e.id);
                    setHover(null);
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>
    </div>
  );
}

const CHIP_GAP = 8;
const PAD_X = 50; // px-6 on both sides and the panel's 1 px edge

/** The rail's photos as big as one line of them allows (34 to 76 px), the gap between kinds tightening from 28 to
 *  18 to 12 px before the photos get smaller; when even that is too wide, the rail scrolls sideways rather than let
 *  groups run into each other. */
function fitRail(width: number, groups: { n: number; label: number }[]): { chip: number; gap: number; scroll: boolean } {
  const need = (chip: number, gap: number) =>
    PAD_X + gap * Math.max(0, groups.length - 1) + groups.reduce((sum, g) => sum + Math.max(g.label, g.n * chip + (g.n - 1) * CHIP_GAP), 0);
  for (const [gap, least] of [[28, 40], [18, 36], [12, 34]] as const) {
    for (let chip = 76; chip >= least; chip--) if (need(chip, gap) <= width) return { chip, gap, scroll: false };
  }
  return { chip: 34, gap: 12, scroll: true };
}

function RailChip({ entry, size, on, active, onShow, onPick }: { entry: DeviceEntry; size: number; on: boolean; active: boolean; onShow: () => void; onPick: () => void }) {
  const face = useDeviceFace(entry);
  return (
    <button
      type="button"
      onPointerEnter={onShow}
      onFocus={onShow}
      onClick={onPick}
      onDoubleClick={() => openDevice(entry.id)}
      title={`${entry.name}: ${face.status}`}
      aria-label={`Show ${entry.name}`}
      aria-pressed={active}
      className={cn(
        // One fixed cell, so a tall photo (a mouse, headphones) scales down into the chip instead of stretching it.
        "group relative grid shrink-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center rounded-control p-1.5 ring-1 transition-[background-color,box-shadow,transform] duration-500 ease-fluid active:scale-[0.97]",
        on ? "bg-white/[0.1] ring-white/35" : "bg-white/[0.035] ring-white/[0.06] hover:bg-white/[0.07]",
      )}
      style={{ width: size, height: size }}
    >
      <span className={cn("grid size-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center", face.idle && "opacity-60")}>
        <FaceArt entry={entry} face={face} appTile={Math.round(size * 0.6)} className="max-h-full max-w-full" imgClassName="drop-shadow-[0_6px_8px_rgb(0_0_0/0.5)]" />
      </span>
      <span className={cn("absolute bottom-1 right-1 size-1.5 rounded-full", face.live ? "bg-live" : "bg-asleep")} aria-hidden="true" />
      {active && (
        <span className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-primary ring-2 ring-[var(--panel-bottom)]" aria-hidden="true">
          <Check size={10} weight="bold" className="text-primary-foreground" />
        </span>
      )}
    </button>
  );
}

function Stage({ entry, active, onSet }: { entry: DeviceEntry; active: boolean; onSet: SpotlightProps["onSet"] }) {
  const face = useDeviceFace(entry);
  const [view] = useKeptState<unknown>(entry.viewKey ?? `home.none.${entry.id}`, null);
  const sound = useSound();
  const g = glanceOf(entry, view, sound.status ? face.eqOn : null, soundLabel(sound).title);
  // The value while the bars are dragged, shown in the big number before it goes to the device.
  const [preview, setPreview] = useState<number | null>(null);
  useEffect(() => setPreview(null), [entry.id]);
  const big = preview !== null && g.slider ? g.slider.format(preview) : g.value;
  const tile = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  return (
    <section ref={tile} aria-label={entry.name} onPointerMove={spotlightMove} className="tile group/spotlight relative isolate min-h-0 flex-1 overflow-hidden rounded-card">
      <SpotlightLight size={620} />
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={entry.id}
          initial={reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, x: -24 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-0 grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-center gap-6 px-10 py-9"
        >
          <div className="flex min-w-0 flex-col">
            <span className="label-caps">
              {active ? "Active device" : face.top}
              {face.brand ? ` · ${face.brand}` : ""}
            </span>
            <h2 className="mt-3 text-[clamp(40px,3.6vw,64px)] font-bold leading-[0.95] tracking-[-0.05em] text-high">{entry.name}</h2>
            <p className="mt-4 flex items-center gap-2 text-[15px] text-high">
              <span className={cn("size-2 shrink-0 rounded-full", face.live ? "bg-live" : "bg-asleep")} aria-hidden="true" />
              {face.status}
            </p>
            {big !== null ? (
              <>
                <p className="mt-7 flex items-baseline gap-2.5">
                  <span className="display-num tabular text-[clamp(64px,6.4vw,112px)] leading-[0.85] tracking-[-0.06em] text-high">{big}</span>
                  {g.unit && <span className="text-[20px] font-medium text-medium">{g.unit}</span>}
                </p>
                <p className="mt-2 text-[13px] text-medium">{g.section}</p>
              </>
            ) : (
              <p className="mt-7 text-[14px] text-medium">Open it once and SYNQ reads its settings.</p>
            )}
            {/* The active device's slider, as on the active card: sent through its page, backed up and read back. */}
            {active && g.slider && (
              <BarSlider
                {...g.slider}
                className="-mx-2.5 mt-3 max-w-[440px]"
                label={`${g.section} of the ${entry.name}`}
                onPreview={setPreview}
                onCommit={(v) => onSet(entry, g.slider!.set(v), `${g.slider!.format(v)}${g.unit ? ` ${g.unit}` : ""}`)}
              />
            )}
            {!g.stats.every((s) => s.value === "Not read") && (
              <dl className="mt-6 grid max-w-[440px] grid-cols-2 gap-x-6 border-t border-white/[0.09] pt-4">
                {g.stats.map((s) => (
                  <div key={s.label} className="flex min-w-0 flex-col-reverse">
                    <dt className="mt-0.5 truncate text-[12.5px] text-medium">{s.label}</dt>
                    <dd className="truncate text-[20px] font-bold tracking-[-0.03em] text-high">{s.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <button
              type="button"
              onClick={() => openDevice(entry.kind === "sound" ? SOUND_ID : entry.id)}
              className="group/open mt-7 flex h-12 w-fit items-center gap-3 rounded-control bg-foreground pl-6 pr-1.5 text-[14.5px] font-semibold text-background transition-transform duration-500 ease-fluid active:scale-[0.98]"
            >
              Configure {entry.name}
              <span className="grid size-9 place-items-center rounded bg-background/10 transition-transform duration-500 ease-fluid group-hover/open:-translate-y-px group-hover/open:translate-x-0.5">
                <ArrowUpRight size={16} />
              </span>
            </button>
          </div>
          <Tilt area={tile} className="flex h-full min-h-0 items-center justify-center">
            <div className={cn("grid size-full grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center", face.idle && "opacity-75")}>
              <FaceArt entry={entry} face={face} appTile={160} className="max-h-full max-w-full" imgClassName="drop-shadow-[0_40px_50px_rgb(0_0_0/0.6)]" />
            </div>
          </Tilt>
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
