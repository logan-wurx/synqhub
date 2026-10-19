// "Try a pro's setup", inside Keep your feel on the Devices home: find a pro, see their setup next to yours and as it
// would land on your own mouse, then apply it on the mouse's page (backup first, Undo, the in-game sens to type).
// Its own chunk, loaded when the section is opened. Reads only what the panels keep; it never opens a device.
import { useMemo, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Chip, Pill } from "@/components/keyboard/parts";
import type { DeviceEntry } from "@/lib/device-model";
import { describeMouse } from "@/lib/feel/devices";
import { fmtNum, hzText } from "@/lib/feel/units";
import { peekKept } from "@/lib/keep";
import { openDevice } from "@/lib/nav";
import { requestChange } from "@/lib/feel/pending";
import { GAME_NAME, proEdpi, searchPros, type Pro, type ProGame } from "@/lib/pros/loadout";
import { PROS } from "@/lib/pros/data";
import { ProDiff } from "./ProDiff";

const checkedOn = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function ProPicker({ mice }: { mice: readonly DeviceEntry[] }) {
  const [query, setQuery] = useState("");
  const [game, setGame] = useState<ProGame | "all">("all");
  const [picked, setPicked] = useState<Pro | null>(null);
  const [mouseId, setMouseId] = useState<string | null>(mice[0]?.id ?? null);
  const list = useMemo(() => searchPros(PROS, query).filter((p) => game === "all" || p.game === game), [query, game]);
  const mouse = mice.find((m) => m.id === mouseId) ?? mice[0] ?? null;
  const device = mouse ? describeMouse(mouse.family, mouse.viewKey ? peekKept<unknown>(mouse.viewKey, null) : null) : null;

  const apply = (p: Pro) => {
    if (!mouse) return;
    // Straight to Apply when the translation was shown here; otherwise the mouse's page shows it first.
    requestChange(mouse.id, { kind: "pro", pro: p.id, at: Date.now(), auto: !!device });
    openDevice(mouse.id);
  };

  return (
    <div className="grid gap-x-8 gap-y-5 min-[1100px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" data-slot="pro-picker">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-control bg-white/[0.04] px-3 ring-1 ring-white/[0.07] focus-within:ring-primary/60">
            <MagnifyingGlass size={14} className="shrink-0 text-medium" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a pro, team or mouse"
              aria-label="Search pros"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-high outline-none placeholder:text-medium"
            />
          </label>
          <div className="flex gap-1.5">
            {(["all", "cs2", "valorant"] as const).map((g) => (
              <Chip key={g} on={game === g} onClick={() => setGame(g)}>
                {g === "all" ? "All" : GAME_NAME[g]}
              </Chip>
            ))}
          </div>
        </div>
        <ul className="mt-3 max-h-[300px] overflow-y-auto pr-1 [scrollbar-gutter:stable]" role="listbox" aria-label="Pros">
          {list.map((p) => (
            <li key={p.id}>
              <button
                role="option"
                aria-selected={picked?.id === p.id}
                onClick={() => setPicked(p)}
                className={cn("flex w-full items-center gap-3 rounded-small px-3 py-2 text-left transition-colors", picked?.id === p.id ? "bg-white/[0.07] ring-1 ring-white/[0.1]" : "hover:bg-white/[0.04]")}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-high">{p.name}</span>
                  <span className="block truncate text-[11.5px] text-medium">
                    {GAME_NAME[p.game]} · {p.team}
                  </span>
                </span>
                <span className="tabular shrink-0 text-right text-[11.5px] text-medium">
                  {p.dpi} · {fmtNum(p.sens)}
                  <span className="block text-medium">eDPI {fmtNum(proEdpi(p), 1)}</span>
                </span>
              </button>
            </li>
          ))}
          {!list.length && <li className="px-3 py-4 text-[12.5px] text-medium">No pro matches that.</li>}
        </ul>
      </div>

      <div className="min-w-0">
        {picked ? (
          <div className="space-y-4">
            <div>
              <p className="text-[15px] font-medium tracking-tight text-high">{picked.name}</p>
              <p className="mt-0.5 text-[12px] text-medium">
                {picked.mouse} · {hzText(picked.pollingHz)}
              </p>
            </div>
            {mice.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {mice.map((m) => (
                  <Chip key={m.id} on={m.id === mouse?.id} onClick={() => setMouseId(m.id)}>
                    {m.name}
                  </Chip>
                ))}
              </div>
            )}
            <ProDiff pro={picked} mouse={mouse ? { device, name: mouse.name } : undefined} />
            <p className="text-[11.5px] leading-relaxed text-medium">
              Keyboard: {picked.keyboard}. {picked.name} hasn't published actuation or rapid trigger values, so the keyboard stays as it is.
            </p>
            <div className="flex flex-wrap items-center gap-2.5">
              {mouse ? (
                <Pill primary onClick={() => apply(picked)}>
                  {device ? `Apply to ${mouse.name}` : `Open ${mouse.name} to apply`}
                </Pill>
              ) : (
                <p className="text-[12.5px] text-medium">Plug in a mouse to apply it.</p>
              )}
              <span className="text-[11.5px] text-medium">Backed up first, with Undo. You type the sens in the game; SYNQ doesn't edit game files.</span>
            </div>
            <p className="text-[11px] text-medium" title={picked.source}>
              Values from {new URL(picked.source).hostname.replace(/^www\./, "")}, checked {checkedOn(picked.checked)}.
            </p>
          </div>
        ) : (
          <p className="pt-2 text-[12.5px] leading-relaxed text-medium">Pick a pro to see their DPI, polling and sens next to yours, and what your own mouse can do of it.</p>
        )}
      </div>
    </div>
  );
}
