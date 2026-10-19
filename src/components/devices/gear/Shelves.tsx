// The Gear page as shelves: one glass pane, a labelled row per kind on it, and the photos standing on their row with no
// boxes, like a hardware lineup. Every shelf has the same columns, so the photos line up; a long kind takes two rows.
// Loaded only when picked (the header's layout switch).
import { cn } from "@/lib/utils";
import { useGridRoom } from "@/lib/viewport";
import { openDevice } from "@/lib/nav";
import type { DeviceEntry } from "@/lib/device-model";
import { Check } from "@phosphor-icons/react";
import { GlassSheen } from "@/components/ui/glass";
import { FaceArt, useDeviceFace } from "../device-face";
import { useGroups, type LayoutProps } from "./shared";

/** Narrowest a device gets on a shelf; the kind's name takes the column on the left; the pane's padding top and bottom. */
const SHELF = { minCell: 168, label: 220, padY: 12, padX: 32 };

export default function GearShelves({ entries, activeId, onIntent }: LayoutProps) {
  const groups = useGroups(entries);
  const { ref, w, room } = useGridRoom<HTMLDivElement>([groups.length]);
  const inner = w - SHELF.padX * 2;
  const cols = Math.max(1, Math.floor((inner - SHELF.label) / SHELF.minCell));
  const units = groups.reduce((s, g) => s + Math.ceil(g.items.length / cols), 0);
  const unit = Math.max(120, Math.min(260, (room - SHELF.padY * 2) / Math.max(1, units)));
  return (
    // The pane: the same glass as the active card and the dock, drawn without a live blur (its backdrop is the still
    // dot pattern, so a blur would only cost frames).
    <div ref={ref} className="glass-still relative overflow-hidden rounded-card" style={{ padding: `${SHELF.padY}px ${SHELF.padX}px` }} data-slot="gear-shelves">
      <GlassSheen />
      {groups.map((g, i) => {
        const rows = Math.ceil(g.items.length / cols);
        return (
          <section
            key={g.id}
            aria-label={g.label}
            className={cn("relative grid items-stretch", i > 0 && "border-t border-white/[0.08]")}
            style={{ gridTemplateColumns: `${SHELF.label}px minmax(0, 1fr)`, gridTemplateRows: "minmax(0, 1fr)", height: rows * unit }}
          >
            <header className="flex flex-col justify-center pr-6">
              <h2 className="text-[34px] font-bold leading-none tracking-[-0.045em] text-high">{g.label}</h2>
              <p className="mt-2 text-[13px] text-medium">
                {g.items.length} {g.items.length === 1 ? "device" : "devices"}
              </p>
            </header>
            <div className="grid min-h-0" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
              {g.items.map((e) => (
                <ShelfItem key={e.id} entry={e} active={e.id === activeId} onIntent={onIntent} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ShelfItem({ entry, active, onIntent }: { entry: DeviceEntry; active: boolean; onIntent?: LayoutProps["onIntent"] }) {
  const face = useDeviceFace(entry);
  const link = face.status.split(" · ")[0];
  return (
    <button
      type="button"
      onClick={() => openDevice(entry.id)}
      onPointerEnter={() => onIntent?.(entry.kind)}
      onFocus={() => onIntent?.(entry.kind)}
      aria-label={`Open ${entry.name}`}
      aria-current={active ? "true" : undefined}
      className="group relative flex min-h-0 flex-col items-center px-2 pb-3 pt-3 text-center"
    >
      {/* The photo stands on the shelf; a soft floor shadow under it narrows as it lifts. */}
      <span className={cn("relative grid min-h-0 w-full flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center transition-transform duration-700 ease-fluid group-hover:-translate-y-1.5", face.idle && "opacity-70")}>
        <FaceArt entry={entry} face={face} appTile={56} imgClassName="drop-shadow-[0_18px_22px_rgb(0_0_0/0.6)]" />
      </span>
      <span aria-hidden="true" className="mx-auto h-2 w-3/5 rounded-[50%] bg-shade/70 blur-[6px] transition-all duration-700 ease-fluid group-hover:w-2/5 group-hover:opacity-60" />
      <span className="mt-2 flex max-w-full items-center gap-1.5">
        {active && (
          <span className="grid size-4 shrink-0 place-items-center rounded-full bg-primary" aria-hidden="true">
            <Check size={10} weight="bold" className="text-primary-foreground" />
          </span>
        )}
        <span className="truncate text-[14.5px] font-bold tracking-[-0.025em] text-high">{entry.name}</span>
      </span>
      <span className="mt-0.5 flex max-w-full items-center gap-1.5 text-[12px] text-medium">
        <span className={cn("size-1.5 shrink-0 rounded-full", face.live ? "bg-live" : "bg-asleep")} aria-hidden="true" />
        <span className="truncate">{face.fact ? `${link} · ${face.fact}` : link}</span>
      </span>
    </button>
  );
}
