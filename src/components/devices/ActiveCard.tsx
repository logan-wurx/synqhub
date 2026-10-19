// The Gear page's active device: the one in use (picked with the chevron), its main settings at a glance and the one
// you change most as a slider, and the way into its page. Lights and Displays show their first device the same way.
// The numbers are what the device's page last read (src/lib/keep.ts); a slider's change is handed to that page
// (src/lib/feel/pending.ts), which makes it through its guarded session: a backup first, "Allow changes" honoured,
// every change read back.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, CaretDown, Check } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { useKeptState } from "@/lib/keep";
import { openDevice, SOUND_ID } from "@/lib/nav";
import { summarize, type DeviceEntry } from "@/lib/device-model";
import { ALL_LAMPS } from "@/lib/lighting/models";
import { describeKeyboard, describeMouse } from "@/lib/feel/devices";
import type { LodFeel, Step } from "@/lib/feel/types";
import { soundLabel, useSound } from "@/lib/sound";
import { Shader } from "@/components/ui/shader";
import { GlassSheen } from "@/components/ui/glass";
import { BarSlider } from "@/components/ui/bar-slider";

/** The slab's light, dark to bright: all SYNQ orange. */
const SLAB = ["#e2441c", "#ff5e3a", "#ff7a52", "#ff9b72"] as const;

/** What the card shows for a device: its big number (with a slider when it can be set from here) and two smaller ones. */
interface Glance {
  section: string;
  value: string | null;
  unit?: string;
  slider?: { value: number; min: number; max: number; step: number; curve?: "linear" | "log"; detents?: readonly number[]; set: (v: number) => Step[]; format: (v: number) => string };
  stats: { value: string; label: string }[];
}

const NONE = "Not read";
const hz = (n: number | null) => (n === null ? NONE : n >= 1000 ? `${n / 1000} kHz` : `${n} Hz`);
const mm = (n: number | null) => (n === null ? NONE : `${Number(n.toFixed(2))} mm`);
const lod = (l: LodFeel | null) => (!l ? NONE : l.kind === "mm" ? mm(l.mm) : l.level);

export function glanceOf(entry: DeviceEntry, view: unknown, eqOn: boolean | null, output: string): Glance {
  if (entry.kind === "mouse") {
    const d = describeMouse(entry.family, view);
    const dpi = d?.now ? d.now.stages[d.now.active] ?? null : null;
    const caps = d?.target.dpi;
    return {
      section: "Performance",
      value: dpi === null ? null : String(dpi),
      unit: "DPI",
      slider:
        dpi !== null && caps
          ? { value: dpi, min: caps.min, max: caps.max, step: caps.step || 50, curve: "log" as const, detents: d?.now?.stages ?? [], set: (v) => [{ kind: "dpi", dpi: v }], format: (v) => String(v) }
          : undefined,
      stats: [
        { value: hz(d?.now?.pollingHz ?? null), label: "Polling rate" },
        { value: lod(d?.now?.lod ?? null), label: "Lift-off distance" },
      ],
    };
  }
  if (entry.kind === "keyboard") {
    const d = describeKeyboard(entry.family, view);
    const act = d?.now?.actuationMm ?? null;
    const range = d?.target.actuation;
    const rt = d?.now?.rapidTrigger;
    return {
      section: "Actuation",
      value: act === null ? null : String(Number(act.toFixed(2))),
      unit: "mm",
      slider:
        act !== null && range
          ? { value: act, min: range.min, max: range.max, step: range.step, set: (v) => [{ kind: "actuation", mm: v }], format: (v) => String(Number(v.toFixed(2))) }
          : undefined,
      stats: [
        { value: rt == null ? NONE : rt ? "On" : "Off", label: "Rapid trigger" },
        { value: mm(d?.now?.rtPressMm ?? null), label: "Sensitivity" },
      ],
    };
  }
  if (entry.kind === "sound") {
    return {
      section: "Equalizer",
      value: eqOn === null ? null : eqOn ? "On" : "Off",
      stats: [
        { value: output, label: "Output" },
        { value: "Equalizer APO", label: "Engine" },
      ],
    };
  }
  // The rest: only what SYNQ knows without opening the device (no made-up "On").
  const s = summarize(entry, view);
  const link = s.link ?? (entry.connection || null);
  if (s.battery !== null)
    return {
      section: "Battery",
      value: String(s.battery),
      unit: "%",
      stats: [
        { value: link ?? "Unknown", label: "Connection" },
        { value: entry.brand || "Unknown", label: "Maker" },
      ],
    };
  // "All lights": its brand is the count ("6 lights").
  if (entry.kind === "light" && entry.family === ALL_LAMPS) {
    const [count, ...noun] = entry.brand.split(" ");
    return { section: "In the group", value: count, unit: noun.join(" "), stats: [{ value: link ?? "Unknown", label: "Connection" }] };
  }
  return {
    section: "Connection",
    value: link ?? "Unknown",
    stats: [
      { value: entry.brand || "Unknown", label: "Maker" },
      { value: KIND_NAME[entry.kind] ?? entry.kind, label: "Type" },
    ],
  };
}

const KIND_NAME: Partial<Record<DeviceEntry["kind"], string>> = { controller: "Controller", headset: "Headset", monitor: "Monitor", webcam: "Webcam", light: "Light", lamparray: "Dynamic Lighting", rgbhub: "RGB hub" };

export function ActiveCard({ entries, active, onPick, onSet, label = "Active device" }: { entries: readonly DeviceEntry[]; active: DeviceEntry; onPick: (id: string) => void; onSet: (entry: DeviceEntry, steps: Step[], said: string) => void; label?: string }) {
  const [view] = useKeptState<unknown>(active.viewKey ?? `home.none.${active.id}`, null);
  const sound = useSound();
  const g = glanceOf(active, view, sound.status ? sound.status.state === "active" : null, soundLabel(sound).title);
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [menu]);
  const others = entries.length > 1;
  // The value while the bars are being dragged, shown in the big number before it goes to the device.
  const [preview, setPreview] = useState<number | null>(null);
  useEffect(() => setPreview(null), [active.id]);
  const big = preview !== null && g.slider ? g.slider.format(preview) : g.value;

  return (
    <div className="relative pl-9 pt-6 max-sm:pl-5 max-sm:pt-5">
      {/* The orange slab the card sits on: live light (src/components/ui/shader.tsx) over the same orange as a CSS
          gradient, which is what shows without WebGL. It casts a warm glow; the glass frosts it. */}
      <div
        aria-hidden="true"
        className="absolute bottom-10 left-0 right-14 top-0 rounded-card bg-[linear-gradient(150deg,#ff7a52,var(--primary)_45%,#f0461f)] shadow-[0_30px_90px_-30px_rgb(255_94_58/0.55)]"
      >
        <Shader look="grain" colors={SLAB} className="absolute inset-0 rounded-card" />
      </div>
      <div className="glass relative rounded-card px-7 pb-6 pt-7 max-sm:px-5" data-slot="active-card">
        <GlassSheen />
        <div ref={box} className="relative">
          <span className="label-caps">{label}</span>
          <button
            type="button"
            disabled={!others}
            onClick={() => setMenu((m) => !m)}
            aria-haspopup="listbox"
            aria-expanded={menu}
            className="mt-1.5 flex w-full items-center gap-3 text-left disabled:cursor-default"
          >
            <span className="min-w-0 flex-1 truncate text-[30px] font-bold tracking-[-0.035em] text-high">{active.name}</span>
            {others && <CaretDown size={20} weight="light" className={cn("shrink-0 text-medium transition-transform duration-300 ease-fluid", menu && "rotate-180")} />}
          </button>
          {menu && (
            <ul role="listbox" aria-label="Pick the active device" className="absolute inset-x-0 top-full z-30 mt-2 overflow-hidden rounded-popover bg-popover py-1.5 shadow-[0_24px_48px_rgb(0_0_0/0.6)] ring-1 ring-white/[0.12]">
              {entries.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={e.id === active.id}
                    onClick={() => {
                      onPick(e.id);
                      setMenu(false);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[14px] text-high transition-colors hover:bg-white/[0.06]"
                  >
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    {e.id === active.id && <Check size={14} className="text-primary" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-3.5 border-t border-white/[0.09] pt-4">
          <p className="text-[16px] font-medium text-high">{g.section}</p>
          <p className="mt-1 flex items-baseline gap-2">
            {big !== null ? (
              <span className={cn("display-num tabular text-high", big.length > 6 ? "text-[34px] leading-[1.53]" : "text-[52px]")}>{big}</span>
            ) : (
              <span className="display-num text-[34px] leading-[1.53] text-medium">Not read yet</span>
            )}
            {g.unit && g.value !== null && <span className="text-[16px] font-medium text-medium">{g.unit}</span>}
          </p>
          {g.slider ? (
            <BarSlider
              {...g.slider}
              className="-mx-2.5 mt-1"
              label={`${g.section} of the ${active.name}`}
              onPreview={setPreview}
              onCommit={(v) => onSet(active, g.slider!.set(v), `${g.slider!.format(v)}${g.unit ? ` ${g.unit}` : ""}`)}
            />
          ) : (
            g.value === null && <p className="mt-2 text-[13px] text-medium">Open it once and SYNQ reads its settings.</p>
          )}
        </div>

        {/* Nothing read yet: the hint above says so once, not a row of "Not read". */}
        {!g.stats.every((s) => s.value === NONE) && (
          <div className={cn("mt-3 grid border-t border-white/[0.09] pt-3.5", g.stats.length > 1 && "grid-cols-2")}>
            {g.stats.map((s, i) => (
              <Stat key={s.label} value={s.value} label={s.label} divider={i > 0} />
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => openDevice(active.kind === "sound" ? SOUND_ID : active.id)}
          className="mt-4 flex h-[50px] w-full items-center justify-center gap-2 rounded-control bg-white/[0.06] text-[15px] font-medium text-high ring-1 ring-white/[0.1] transition-colors duration-300 ease-fluid hover:bg-white/[0.1] active:scale-[0.99]"
        >
          Configure device
          <ArrowUpRight size={16} weight="light" />
        </button>
      </div>
    </div>
  );
}

function Stat({ value, label, divider }: { value: ReactNode; label: string; divider: boolean }) {
  return (
    <div className={cn("min-w-0", divider && "border-l border-white/[0.09] pl-6")}>
      <p className="truncate text-[22px] font-semibold tracking-[-0.02em] text-high">{value}</p>
      <p className="mt-0.5 truncate text-[13px] text-medium">{label}</p>
    </div>
  );
}
