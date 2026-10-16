// A lamp page's Screen sync tab: the lamp follows the colours at the edge of the screen. The bridge reads thin strips
// a few times a second and sends only the segments that changed (src-tauri/src/lighting/screen.rs); it keeps the lamp
// connected until it is stopped here, on the Devices home card, or by changing the lamp's look by hand. Off by
// default; nothing runs while it is off. With more than one display, the person picks which one it reads.
import { useState } from "react";
import { Eye, EyeSlash, Monitor, Play, Stop } from "@phosphor-icons/react";
import type { LampControl, LampView } from "@/lib/lighting/lamp";
import type { SyncEdge } from "@/lib/lighting/models";
import { chosenMonitor, monitorLabel, useMonitors, type ScreenMonitor } from "@/lib/lighting/monitors";
import { useKeptState } from "@/lib/keep";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "@/components/ui/matte";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "./controls";

export const EDGES: readonly { id: SyncEdge; label: string }[] = [
  { id: "left", label: "Left edge" },
  { id: "right", label: "Right edge" },
  { id: "both", label: "Both edges" },
  { id: "full", label: "Whole screen" },
];

/** A small screen, shaped like the monitor read (when known), with the strips that are read lit up. */
export function ScreenPicture({ edge, on, monitor }: { edge: SyncEdge; on: boolean; monitor?: ScreenMonitor | null }) {
  const strip = (where: string) => <span className={cn("absolute inset-y-1.5 w-1.5 rounded-full transition-colors duration-500", where, on ? "bg-primary shadow-[0_0_10px_var(--primary)]" : "bg-white/40")} />;
  const width = monitor && monitor.height > 0 ? Math.round(Math.min(124, Math.max(44, (72 * monitor.width) / monitor.height))) : 124;
  return (
    <div aria-hidden="true" className="relative h-[72px] shrink-0 rounded-xl bg-white/[0.03] ring-1 ring-white/15 transition-[width] duration-300" style={{ width }}>
      {(edge === "left" || edge === "both" || edge === "full") && strip("left-1.5")}
      {edge === "full" && strip("left-1/2 -translate-x-1/2")}
      {(edge === "right" || edge === "both" || edge === "full") && strip("right-1.5")}
      <span className="absolute -bottom-2 left-1/2 h-1.5 w-8 -translate-x-1/2 rounded-b-md bg-white/15" />
    </div>
  );
}

/** Which display sync reads, shown only when there is more than one (primary first, as Windows lists them). */
export function MonitorPicker({ monitors, value, onChange, disabled }: { monitors: readonly ScreenMonitor[] | null; value: ScreenMonitor | null; onChange: (id: string) => void; disabled?: boolean }) {
  if (!monitors || monitors.length < 2) return null;
  return (
    <fieldset disabled={disabled} className="m-0 min-w-0 max-w-full border-0 p-0 disabled:opacity-60" data-testid="sync-monitor">
      <Segmented wrap label="Display" value={value?.id ?? monitors[0].id} options={monitors.map((m) => ({ id: m.id, label: monitorLabel(m) }))} onChange={onChange} />
    </fieldset>
  );
}

export function SyncTab({ control, view, onError }: { control: LampControl; view: LampView; onError: (why: string) => void }) {
  const [edge, setEdge] = useKeptState<SyncEdge>("light.sync.edge", "left");
  const [vivid, setVivid] = useKeptState<boolean>("light.sync.vivid", true);
  const [monitorId, setMonitorId] = useKeptState<string | null>("light.sync.monitor", null);
  const [busy, setBusy] = useState(false);
  const running = view.sync;
  const monitors = useMonitors();
  const monitor = chosenMonitor(monitors, running ? (running.monitor ?? null) : monitorId);

  const run = async (go: () => Promise<void>) => {
    setBusy(true);
    try {
      await go();
    } catch (e) {
      onError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };
  const start = (e: SyncEdge, v: boolean, m: string | null = monitor?.id ?? null) => run(() => control.startSync(e, v, m));

  return (
    <>
      <Card innerClassName="pb-5">
        <CardHeader title="Screen sync" hint="The light takes on the colours at the edge of your screen while you watch or play." />
        <div className="mt-4 flex flex-wrap items-center gap-5 px-5">
          <ScreenPicture edge={running?.edge ?? edge} on={!!running} monitor={monitor} />
          <div className="flex min-w-[260px] flex-1 flex-col items-start gap-3">
            <MonitorPicker
              monitors={monitors}
              value={monitor}
              onChange={(id) => {
                setMonitorId(id);
                if (running) void start(running.edge, vivid, id);
              }}
            />
            <Segmented
              wrap
              label="Part of the screen"
              value={running?.edge ?? edge}
              options={EDGES}
              onChange={(e) => {
                setEdge(e);
                if (running) void start(e, vivid);
              }}
            />
            <label className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-foreground">
              <Switch
                checked={vivid}
                onCheckedChange={(v) => {
                  setVivid(v);
                  if (running) void start(running.edge, v);
                }}
                aria-label="Vivid colours"
              />
              Vivid colours <span className="text-[12px] text-muted-foreground">(edges tend to grey; this lifts them)</span>
            </label>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void (running ? run(() => control.stopSync()) : start(edge, vivid))}
            data-testid="sync-toggle"
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-full px-5 py-2 text-[13.5px] ring-1 transition-colors duration-300 disabled:cursor-wait disabled:opacity-60",
              running ? "bg-white/[0.06] text-foreground ring-white/[0.12] hover:bg-white/[0.1]" : "bg-primary/[0.15] text-foreground ring-primary/40 hover:bg-primary/[0.22]",
            )}
          >
            {running ? <Stop size={14} weight="fill" /> : <Play size={14} weight="fill" />}
            {running ? "Stop" : "Start"}
          </button>
        </div>
        {running && (
          <div className="mx-5 mt-4 flex items-start gap-3 rounded-2xl bg-white/[0.03] px-4 py-3 text-[13px] leading-relaxed ring-1 ring-white/[0.07]" data-testid="sync-status">
            {running.blind ? <EyeSlash size={17} className="mt-0.5 shrink-0 text-chart-3" /> : <Eye size={17} className="mt-0.5 shrink-0 text-primary" />}
            <span className={running.blind ? "text-chart-3" : "text-muted-foreground"}>
              {running.blind
                ? "Can't see this window, holding colours. Games in exclusive full screen and protected video can't be read; the light keeps its last colours instead of going dark."
                : "Syncing. The light stays connected until you stop it, even with SYNQ in the background; its card on the Devices home has a Stop button too."}
            </span>
          </div>
        )}
      </Card>
      <Card innerClassName="px-5 py-4">
        <div className="flex items-start gap-3">
          <Monitor size={17} className="mt-0.5 shrink-0 text-muted-foreground" />
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-[12.5px] leading-relaxed text-muted-foreground">
            <li>SYNQ reads thin strips of one screen, the main one unless you pick another (1 % of its width), never the whole picture, about 6 times a second while it moves and twice a second once it stands still. Each read costs about 0.2 ms of CPU.</li>
            <li>Nothing is recorded or kept: only the colours go to the light, and only the segments that changed.</li>
            <li>It stops by itself when the screen locks, the PC sleeps, the displays change or the light stops answering, and when you change its colour, scene, effect or music.</li>
          </ul>
        </div>
      </Card>
    </>
  );
}
