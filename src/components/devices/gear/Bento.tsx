// The Gear page's default layout: a card per kind (Mice, Keyboards, Sound, Controllers, ...), each as wide as the
// devices it holds call for, and inside it every device with its photo, name, status and its one number ("1600 DPI").
// The cards fill the window down to the dock (src/lib/viewport.ts).
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { useGridRoom } from "@/lib/viewport";
import { openDevice } from "@/lib/nav";
import type { DeviceEntry } from "@/lib/device-model";
import { SpotlightLight, spotlightMove } from "@/components/ui/spotlight";
import { FaceArt, useDeviceFace } from "../device-face";
import { ActiveTick, useGroups, type KindGroup, type LayoutProps } from "./shared";

const GAP = 16;

export function GearBento({ entries, activeId, onIntent }: LayoutProps) {
  const groups = useGroups(entries);
  const { ref, room } = useGridRoom<HTMLDivElement>([groups.length]);
  // Two kinds on the top row (the ones people change most: mice, keyboards), the rest share the row under them.
  const rows = groups.length <= 2 ? [groups] : groups.length <= 5 ? [groups.slice(0, 2), groups.slice(2)] : chunk(groups, 3);
  const rowH = Math.max(240, (room - GAP * (rows.length - 1)) / rows.length);
  return (
    <div ref={ref} className="flex flex-col" style={{ gap: GAP }} data-slot="gear-bento">
      {rows.map((row, r) => (
        <div key={r} className="flex" style={{ gap: GAP, height: rowH }}>
          {row.map((g) => (
            // A card's width follows how many it holds (a square root, so ten pads don't squeeze a lone webcam out).
            <KindCard key={g.id} group={g} activeId={activeId} onIntent={onIntent} style={{ flexGrow: Math.sqrt(g.items.length), flexBasis: 0 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function KindCard({ group, activeId, onIntent, style }: { group: KindGroup; activeId: string | null; onIntent?: LayoutProps["onIntent"]; style?: CSSProperties }) {
  const n = group.items.length;
  const cols = n <= 3 ? n : n === 4 ? 2 : Math.ceil(n / 2);
  const small = n > 3;
  return (
    <section aria-label={group.label} onPointerMove={spotlightMove} className="tile group/spotlight relative isolate flex min-w-[180px] flex-col overflow-hidden rounded-card" style={style}>
      <SpotlightLight size={420} />
      <header className="relative flex items-baseline gap-2.5 px-6 pt-5">
        <h2 className="text-[26px] font-bold leading-none tracking-[-0.04em] text-high">{group.label}</h2>
        <span className="font-mono text-[13px] tabular-nums text-medium">{n}</span>
      </header>
      {/* The cells sit 12 px in from the card's edge, so their corners are 24 - 12 = 12 px (concentric). */}
      <div className="relative grid min-h-0 flex-1 gap-1 p-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: "minmax(0, 1fr)" }}>
        {group.items.map((e) => (
          <BentoCell key={e.id} entry={e} active={e.id === activeId} small={small} onIntent={onIntent} />
        ))}
      </div>
    </section>
  );
}

function BentoCell({ entry, active, small, onIntent }: { entry: DeviceEntry; active: boolean; small: boolean; onIntent?: LayoutProps["onIntent"] }) {
  const face = useDeviceFace(entry);
  return (
    <button
      type="button"
      onClick={() => openDevice(entry.id)}
      onPointerEnter={() => onIntent?.(entry.kind)}
      onFocus={() => onIntent?.(entry.kind)}
      aria-label={`Open ${entry.name}`}
      aria-current={active ? "true" : undefined}
      className={cn(
        "@container group relative flex min-h-0 flex-col overflow-hidden rounded-tight text-left transition-colors duration-500 ease-fluid hover:bg-white/[0.05]",
        small ? "px-2.5 pb-2.5 pt-2" : "px-4 pb-4 pt-3",
      )}
    >
      <span className={cn("relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center", face.idle && "opacity-70")}>
        <FaceArt entry={entry} face={face} appTile={small ? 52 : 80} imgClassName="drop-shadow-[0_22px_26px_rgb(0_0_0/0.55)] transition-transform duration-700 ease-fluid group-hover:scale-[1.05]" />
      </span>
      {/* The name (two lines, shrinking with a narrow cell: it's how people tell their gear apart) and its status; on a
          roomy cell its one number sits beside them as a stat, set like the active card's ("800 DPI"). */}
      <span className="relative flex items-end gap-3">
        <span className="min-w-0 flex-1">
          <span className={cn("block font-bold tracking-[-0.03em] text-high", small ? "line-clamp-2 text-[13.5px] leading-[1.15]" : "line-clamp-2 text-[clamp(14px,8cqw,19px)] leading-[1.1]")}>{entry.name}</span>
          <span className={cn("mt-1 flex min-w-0 items-center gap-1.5 text-medium", small ? "text-[11.5px]" : "text-[13px]")}>
            <span className={cn("size-1.5 shrink-0 rounded-full", face.live ? "bg-live" : "bg-asleep")} aria-hidden="true" />
            <span className="truncate">{small ? face.status.split(" · ")[0] : face.status}{entry.kind === "sound" && face.eqOn && !face.desktopOnly ? " · EQ on" : ""}</span>
          </span>
        </span>
        {/* Only where the cell has room for it beside the name (a container query), and never for the sound output (its
            EQ is in the status line). */}
        {!small && face.figure && entry.kind !== "sound" && (
          <span className="hidden shrink-0 items-baseline gap-1 pb-px @min-[260px]:flex">
            <span className="display-num tabular text-[clamp(22px,10cqw,36px)] leading-[0.85] tracking-[-0.05em] text-high">
              {face.figure.unit === "%" ? `${face.figure.value}%` : face.figure.value}
            </span>
            {face.figure.unit !== "%" && <span className="text-[12px] font-medium text-medium">{face.figure.unit}</span>}
          </span>
        )}
      </span>      {active && <ActiveTick radius={12} size={small ? 26 : 34} />}
    </button>
  );
}
