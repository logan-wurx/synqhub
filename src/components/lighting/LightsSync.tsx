// The Lights view's Screen sync tab (wave L5): the lights of the group follow the screen's colours, whatever drives
// them. Lights that can't follow are listed greyed with the reason (Dynamic Lighting devices follow the app in front;
// Yeelight takes about one change a second; a Key Light is white only). Hue lights stream through an Entertainment area:
// one the bridge already has, or SYNQ's own, made only after the person confirms what changes on the bridge. Sync
// runs on with SYNQ in the background until Stop (here or on a light's card), a lock, sleep or a display change.
// With more than one display, the person picks which one they all read.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight, Eye, EyeSlash, Play, Stop } from "@phosphor-icons/react";
import type { SyncEdge } from "@/lib/lighting/models";
import type { LookControl } from "@/lib/lighting/look/control";
import { chosenMonitor, useMonitors } from "@/lib/lighting/monitors";
import { cantSync, type LightRef } from "@/lib/lighting/look/lights";
import { createHueArea, hueAreas, removeHueArea, startLightsSync, stopLightsSync, useLightsSync, type HueArea } from "@/lib/lighting/look/sync";
import { useKeptState } from "@/lib/keep";
import { cn } from "@/lib/utils";
import { Card, CardHeader } from "@/components/ui/matte";
import { Switch } from "@/components/ui/switch";
import { isWeb } from "@/lib/backend";
import { goSettings } from "@/lib/nav";
import { useHelperReady } from "@/lib/web/use-helper";
import { Segmented, css } from "./controls";
import { EDGES, MonitorPicker, ScreenPicture } from "./SyncTab";

/** Why a light in the group can't follow now (null: it can), counting what the open lamp reported. */
function why(r: LightRef, look: LookControl, reached: boolean): string | null {
  const fixed = cantSync(r);
  if (fixed) return fixed;
  // The website's Govee link is the browser's own Bluetooth, which SYNQ Helper's sampler can't reach.
  if (isWeb && r.source === "govee") return "On the website a Govee lamp can't follow the screen; the desktop app can.";
  if (!reached) return "Not reached.";
  if (r.source === "govee" && !look.drivers.find((d) => d.key === r.key)?.sync?.can) return "This lamp's model can't follow the screen yet.";
  if (r.source === "hub" && !look.drivers.find((d) => d.key === r.key)?.sync?.can) return "Allow changes to it first (in the light list).";
  return null;
}

export function LightsSync(props: { members: readonly LightRef[]; look: LookControl; reached: (key: string) => boolean; onError: (why: string) => void }) {
  const helper = useHelperReady();
  if (isWeb && !helper) return <SyncNeedsHelper />;
  return <SyncPanel {...props} />;
}

/** The website without SYNQ Helper: a tab can't read the screen while it's in the background, the helper can. */
function SyncNeedsHelper() {
  return (
    <Card innerClassName="px-7 py-6">
      <p className="text-[15px] text-foreground">Screen sync needs SYNQ Helper</p>
      <p className="mt-1 max-w-xl text-[13px] text-muted-foreground">
        Lights follow the screen while you play or watch, so a browser tab (in the background by then) can't read it. SYNQ Helper reads the screen edge on this PC and sends Wi-Fi lights and RGB hubs their colours; nothing is recorded.
      </p>
      <button
        type="button"
        onClick={goSettings}
        className="mt-4 inline-flex items-center gap-2 rounded-full bg-foreground py-1.5 pl-4 pr-1.5 text-[13px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.97]"
      >
        Get SYNQ Helper
        <span className="grid size-6 place-items-center rounded-full bg-background/10">
          <ArrowUpRight size={13} weight="bold" />
        </span>
      </button>
    </Card>
  );
}

function SyncPanel({ members, look, reached, onError }: { members: readonly LightRef[]; look: LookControl; reached: (key: string) => boolean; onError: (why: string) => void }) {
  const [edge, setEdge] = useKeptState<SyncEdge>("lights.sync.edge", "left");
  const [vivid, setVivid] = useKeptState<boolean>("lights.sync.vivid", true);
  const [off, setOff] = useKeptState<string[]>("lights.sync.off", []);
  const [monitorId, setMonitorId] = useKeptState<string | null>("lights.sync.monitor", null);
  const [busy, setBusy] = useState(false);
  const sync = useLightsSync();
  const monitors = useMonitors();
  const monitor = chosenMonitor(monitors, monitorId);
  const able = members.filter((r) => !why(r, look, reached(r.key)));
  const picked = able.filter((r) => !off.includes(r.key));

  // Hue: the bridges of the picked Hue lights, and the area each streams to.
  const bridges = useMemo(() => [...new Set(picked.flatMap((r) => (r.source === "wifi" && r.device.brand === "hue" ? [r.device.id] : [])))], [picked]);
  const bridge = bridges[0] ?? null;
  const hueLights = picked.flatMap((r) => (r.source === "wifi" && r.device.brand === "hue" && r.device.id === bridge && r.device.sub ? [r.device.sub] : []));
  const [areas, setAreas] = useState<HueArea[] | null>(null);
  const [areaId, setAreaId] = useKeptState<string | null>(`lights.sync.area.${bridge ?? ""}`, null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!bridge) return setAreas(null);
    let live = true;
    hueAreas(bridge).then(
      (a) => live && setAreas(a),
      () => live && setAreas([]),
    );
    return () => {
      live = false;
    };
  }, [bridge]);
  const area = areas?.find((a) => a.id === areaId) ?? areas?.find((a) => a.ours) ?? null;

  const run = async (go: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await go();
    } catch (e) {
      onError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    run(() =>
      startLightsSync(picked, edge, vivid, monitor?.id ?? null, look.drivers, bridge && area ? { bridge, area } : null),
    );

  return (
    <>
      <Card innerClassName="pb-5">
        <CardHeader title="Screen sync" hint="The lights take on the colours at the edge of your screen while you watch or play, each in its own place along the edge." />
        <div className="mt-4 flex flex-wrap items-center gap-5 px-5">
          <ScreenPicture edge={edge} on={sync.running} monitor={monitor} />
          <div className="flex min-w-[260px] flex-1 flex-col items-start gap-3">
            <MonitorPicker monitors={monitors} value={monitor} onChange={setMonitorId} disabled={sync.running} />
            <Segmented wrap label="Part of the screen" value={edge} options={EDGES} onChange={setEdge} />
            <label className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-foreground">
              <Switch checked={vivid} onCheckedChange={setVivid} aria-label="Vivid colours" />
              Vivid colours <span className="text-[12px] text-muted-foreground">(edges tend to grey; this lifts them)</span>
            </label>
          </div>
          <button
            type="button"
            disabled={busy || (!sync.running && picked.length === 0)}
            onClick={() => void (sync.running ? run(stopLightsSync) : start())}
            data-testid="lights-sync-toggle"
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-full px-5 py-2 text-[13.5px] ring-1 transition-colors duration-300 disabled:cursor-not-allowed disabled:opacity-60",
              sync.running ? "bg-white/[0.06] text-foreground ring-white/[0.12] hover:bg-white/[0.1]" : "bg-primary/[0.15] text-foreground ring-primary/40 hover:bg-primary/[0.22]",
            )}
          >
            {sync.running ? <Stop size={14} weight="fill" /> : <Play size={14} weight="fill" />}
            {sync.running ? "Stop" : `Start (${picked.length})`}
          </button>
        </div>
        {(sync.running || sync.ended) && (
          <div className="mx-5 mt-4 flex items-start gap-3 rounded-2xl bg-white/[0.03] px-4 py-3 text-[13px] leading-relaxed ring-1 ring-white/[0.07]" data-testid="lights-sync-status">
            {sync.blind ? <EyeSlash size={17} className="mt-0.5 shrink-0 text-chart-3" /> : <Eye size={17} className="mt-0.5 shrink-0 text-primary" />}
            <span className={sync.blind ? "text-chart-3" : "text-muted-foreground"}>
              {!sync.running
                ? `Screen sync stopped: ${sync.ended}`
                : sync.blind
                  ? "Can't see this window, holding colours. The lights keep their last colours instead of going dark."
                  : "Syncing. It keeps running with SYNQ in the background until you stop it, here or on a light's card."}
            </span>
          </div>
        )}
      </Card>

      {bridge && areas && (
        <Card innerClassName="pb-5">
          <CardHeader
            title="Hue Entertainment"
            hint="Hue lights follow the screen smoothly through an Entertainment area on the bridge (a stream of 25 updates a second). Without one they still follow, more slowly."
          />
          <div className="mt-4 flex flex-col items-start gap-3 px-5 text-[13px]">
            {areas.length > 0 && (
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Entertainment area">
                {areas.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={area?.id === a.id}
                    onClick={() => setAreaId(a.id)}
                    className={cn("rounded-full px-3 py-1 text-[12.5px] ring-1 transition-colors", area?.id === a.id ? "bg-white/[0.09] text-foreground ring-white/25" : "text-muted-foreground ring-white/10 hover:text-foreground")}
                  >
                    {a.name} · {a.lights.length} {a.lights.length === 1 ? "light" : "lights"}
                  </button>
                ))}
              </div>
            )}
            {areas.length === 0 && !confirming && (
              <button type="button" onClick={() => setConfirming(true)} className="rounded-full bg-white/[0.06] px-4 py-1.5 text-[13px] text-foreground ring-1 ring-white/[0.1] hover:bg-white/[0.1]">
                Set up Hue Entertainment
              </button>
            )}
            {confirming && (
              <div className="rounded-2xl bg-white/[0.03] px-4 py-3 ring-1 ring-white/[0.08]">
                <p className="text-foreground">SYNQ will add an Entertainment area named "SYNQ" to your Hue Bridge with these lights ({hueLights.length}). Nothing else on the bridge changes. You can remove it here any time.</p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={busy || hueLights.length === 0}
                    onClick={() =>
                      void run(async () => {
                        const made = await createHueArea(bridge, hueLights);
                        setAreas([...(areas ?? []), made]);
                        setAreaId(made.id);
                        setConfirming(false);
                      })
                    }
                    className="rounded-full bg-primary/[0.15] px-4 py-1.5 text-[13px] text-foreground ring-1 ring-primary/40 hover:bg-primary/[0.22] disabled:opacity-60"
                  >
                    Create
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="rounded-full px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground">
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {areas.some((a) => a.ours) && (
              <button
                type="button"
                disabled={busy || sync.running}
                onClick={() =>
                  void run(async () => {
                    await removeHueArea(bridge);
                    setAreas(areas.filter((a) => !a.ours));
                  })
                }
                className="text-[12.5px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
              >
                Remove SYNQ's area
              </button>
            )}
          </div>
        </Card>
      )}
      <Card innerClassName="pb-4">
        <CardHeader title="Lights that follow" hint="All the lights in this group that can. Take one out for this sync with a tap." />
        <div className="mt-3 flex flex-col gap-1 px-3">
          {members.map((r) => {
            const reason = why(r, look, reached(r.key));
            const on = !reason && !off.includes(r.key);
            const colour = sync.colours[r.key];
            const dropped = sync.dropped[r.key];
            return (
              <button
                key={r.key}
                type="button"
                disabled={!!reason || sync.running}
                onClick={() => setOff(on ? [...off, r.key] : off.filter((k) => k !== r.key))}
                aria-pressed={on}
                className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04] disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className={cn("size-4 shrink-0 rounded-md ring-1", on ? "bg-primary ring-primary" : "ring-white/20", reason && "opacity-40")} />
                <span className={cn("min-w-0 flex-1", reason && "opacity-50")}>
                  <span className="block truncate text-[13px] text-foreground">{r.name}</span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">{dropped ? `Let go: ${dropped}` : (reason ?? r.detail)}</span>
                </span>
                {sync.running && colour && on && <span className="size-4 shrink-0 rounded-full ring-1 ring-white/20" style={{ background: css(colour) }} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </Card>

    </>
  );
}

/** On a Devices home card: a Wi-Fi light (or "All lights") following the screen, with a way to stop the whole sync;
 * `otherwise` (a Govee lamp's own sync chip) when the Lights view's sync isn't running there. */
export function LightsSyncChip({ family, all, otherwise }: { family: string; all: boolean; otherwise?: ReactNode }) {
  const sync = useLightsSync();
  if (!sync.running || !(all || sync.keys.includes(`wifi:${family}`))) return <>{otherwise}</>;
  return (
    <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-black/70 py-1 pl-3 pr-1 text-[12px] text-foreground ring-1 ring-primary/40 backdrop-blur-sm" data-testid="lights-sync-chip">
      <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" aria-hidden="true" />
      Syncing to the screen
      <button type="button" onClick={() => void stopLightsSync()} className="rounded-full bg-white/[0.1] px-2.5 py-0.5 text-[11.5px] ring-1 ring-white/15 transition-colors hover:bg-white/[0.18]">
        Stop
      </button>
    </div>
  );
}
