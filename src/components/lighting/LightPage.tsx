// A lamp's page, or "All lamps" (a Wi-Fi light's page is NetLightPage.tsx): the lamp drawn tall and lit as it is
// (paint on it), its colour, white and brightness, and its segments. A lamp is connected only while this page is open and the window is in use
// (src/lib/lighting/session.ts), and every frame it is sent passes the lighting guard in the bridge (on the website,
// the same allowlist in front of Web Bluetooth: src/lib/lighting/web/guard.ts).
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Rgb } from "@/lib/lighting/govee/frames";
import { sceneOf, type LampControl, type LampView } from "@/lib/lighting/lamp";
import { scenesFor } from "@/lib/lighting/govee/scenes.generated";
import { specOf, type GoveeSpec } from "@/lib/lighting/govee/spec";
import { useLampScan } from "@/lib/lighting/lamps";
import { ALL_LAMPS, GOVEE_TOGETHER, LIGHT_MODELS, groupNoun, isNetKey, lampTitle, nounOf, weak, type LampInfo } from "@/lib/lighting/models";
import { isWeb, type Connected } from "@/lib/backend";
import { useLightingKeep } from "@/lib/lighting/saved";
import { useLampSession, type LampPhase } from "@/lib/lighting/session";
import { useKeptState } from "@/lib/keep";
import { lightId, openDevice, useDeviceTab } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { cn } from "@/lib/utils";
import { summarize } from "@/lib/device-model";
import { Card, type Notice } from "@/components/ui/matte";
import { DeviceFrame, DeviceHeader, ReconnectButton, StatusPill, StatusStrip, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";
import { Banner } from "@/components/keyboard/parts";
import { AddLightButton } from "@/components/web/lazy";
import { BRUSHES, LampStage } from "./LampStage";
import { LightTab } from "./LightTab";
import { NetLightPage } from "./NetLightPage";
import { LightsView } from "./LightsView";
import { PowerButton } from "./controls";
import { EffectsTab } from "./EffectsTab";
import { MusicTab } from "./MusicTab";
import { ScenesTab } from "./ScenesTab";
import { SegmentsTab } from "./SegmentsTab";
import { SyncTab } from "./SyncTab";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

const TABS: TabDef[] = [
  { id: "light", label: "Light" },
  { id: "scenes", label: "Scenes" },
  { id: "segments", label: "Segments" },
  { id: "effects", label: "Effects" },
  { id: "music", label: "Music" },
  { id: "sync", label: "Screen sync" },
];

/** The tabs a light's model has (before it is connected: what its table says; then what it reports). */
function tabsFor(spec: GoveeSpec | null, control: LampControl | null): TabDef[] {
  if (!spec) return TABS.slice(0, 1);
  const has: Record<string, boolean> = {
    light: true,
    scenes: scenesFor(spec.sku).length > 0,
    segments: (control?.segments ?? (spec.segments || 1)) > 1,
    effects: spec.diy,
    music: spec.music.length > 0,
    // Screen sync reads the screen in the desktop app; a browser tab can't (src/lib/lighting/web/link.ts).
    sync: !isWeb && (control ? control.syncable : spec.segments > 0 && spec.dialects.includes(0x15)),
  };
  return TABS.filter((t) => has[t.id]);
}
/** How long the page waits for a lamp the scan hasn't heard before saying so. */
const LOOK_MS = 15000;
/** "All lamps" opened before every light was heard (the app just started) waits this long for the rest. */
const GATHER_MS = 3000;
const noStore = () => () => {};
const noView = () => null;

const PILL: Record<LampPhase["kind"], string> = {
  looking: "Looking for it",
  connecting: "Connecting",
  ready: "Connected · Bluetooth",
  failed: "Not connected",
  paused: "Paused (window not focused)",
  lost: "Connection lost",
};

const MODE_TEXT: Record<NonNullable<LampView["mode"]>, string> = { colour: "Colour", white: "White", segments: "Painted", scene: "Scene", music: "Music", diy: "Effect", other: "Its own effect" };

/** What the lamp shows, in a word (a lamp in colour mode whose segments differ was painted). */
function showing(v: LampView, sku: string): string {
  if (!v.mode) return "–";
  if (v.mode === "colour" && v.segments.some((c) => c.join() !== v.segments[0].join())) return MODE_TEXT.segments;
  if (v.mode === "scene") return sceneOf(sku, v.scene)?.name ?? MODE_TEXT.scene;
  return MODE_TEXT[v.mode];
}

/** A light's page: every light at once (the Lights view, wave L5), a Wi-Fi light's (L3), or a Bluetooth lamp's (or the
 * Govee lamps together). */
export function LightPage({ id, notify, devices }: { id: string; notify: Notify; devices: readonly Connected[] }) {
  if (id === ALL_LAMPS) return <LightsView devices={devices} notify={notify} />;
  return isNetKey(id) ? <NetLightPage id={id} notify={notify} /> : <LampPage id={id} notify={notify} />;
}

function LampPage({ id, notify }: { id: string; notify: Notify }) {
  const all = id === GOVEE_TOGETHER;
  // The lamps this page opens, fixed when they are first heard (a refreshed list doesn't reconnect them). The scan
  // runs only until then: the radio is the lamp's while it is connected.
  const [targets, setTargets] = useState<readonly LampInfo[] | null>(null);
  const lamps = useLampScan(!targets);
  const [gaveUp, setGaveUp] = useState(false);
  const [gathered, setGathered] = useState(false);
  useEffect(() => {
    if (targets) return;
    const found = all ? (lamps.length > 1 || gathered ? lamps : []) : lamps.filter((l) => l.id === id);
    if (found.length) setTargets(found);
  }, [lamps, targets, all, id, gathered]);
  useEffect(() => {
    if (targets) return;
    const look = setTimeout(() => setGaveUp(true), LOOK_MS);
    const gather = setTimeout(() => setGathered(true), GATHER_MS);
    return () => {
      clearTimeout(look);
      clearTimeout(gather);
    };
  }, [targets]);

  const { phase, retry } = useLampSession(targets);
  const control = phase.kind === "ready" ? phase.control : null;
  const view = useSyncExternalStore(control?.subscribe ?? noStore, control?.getView ?? noView);
  // "lamp" for lamps, "light" for strips, bars and panels; a group by its members.
  const noun = targets ? groupNoun(targets) : all ? groupNoun(lamps) : nounOf(lamps.find((l) => l.id === id)?.sku ?? "");
  const failed = useCallback((why: string) => notify({ tone: "error", title: `The ${noun} didn't take that`, detail: why }, "light-write"), [notify, noun]);
  useEffect(() => {
    if (!control) return;
    control.onError = failed;
    control.onSyncStopped = (why) => notify({ tone: "info", title: "Screen sync stopped", detail: why }, "light-sync");
  }, [control, failed, notify]);

  const keep = useLightingKeep();
  const [brush, setBrush] = useKeptState<Rgb>(`light.${id}.brush`, [255, 42, 212]);
  const brushes = [...new Set([...BRUSHES, ...keep.recent, ...keep.saved])].slice(0, 22);
  const wide = useWide();

  const first = targets?.[0] ?? lamps.find((l) => l.id === id) ?? null;
  const model = first ? LIGHT_MODELS[first.sku] : undefined;
  const spec = control?.spec ?? (first ? specOf(first.sku) : null);
  const segments = control?.segments ?? (spec?.segments || 1);
  const tabs = tabsFor(spec, control);
  const [tab, setTab] = useDeviceTab(lightId(id), tabs.map((t) => t.id));
  const name = all ? `All ${noun}s` : first ? lampTitle(first) : "Light";
  const summary = summarize({ id: lightId(id), kind: "light", family: id, name, brand: model?.brand ?? "", connection: "Bluetooth", viewKey: null }, null);
  const ready = phase.kind === "ready" && view ? { control: phase.control, view } : null;

  const stageStatus =
    phase.kind === "ready" ? (view?.power === false ? "Off" : null)
    : phase.kind === "connecting" ? "Connecting…"
    : phase.kind === "looking" ? (gaveUp ? "Not in range" : "Looking…")
    : phase.kind === "paused" ? "Paused"
    : phase.kind === "lost" ? "Connection lost"
    : "Out of reach";
  const stage = (className: string) => (
    <LampStage
      className={className}
      view={view}
      segments={segments}
      kind={model?.kind ?? "light"}
      brush={brush}
      onBrush={setBrush}
      brushes={brushes}
      onPaint={ready && segments > 1 ? (c) => ready.control.paint(c) : null}
      status={stageStatus}
    />
  );

  const body = ready ? (
    tab === "scenes" ? (
      <ScenesTab control={ready.control} view={ready.view} onError={failed} />
    ) : tab === "segments" ? (
      <SegmentsTab control={ready.control} view={ready.view} segments={segments} />
    ) : tab === "effects" ? (
      <EffectsTab control={ready.control} onError={failed} />
    ) : tab === "music" ? (
      <MusicTab control={ready.control} view={ready.view} />
    ) : tab === "sync" ? (
      <SyncTab control={ready.control} view={ready.view} onError={failed} />
    ) : (
      <LightTab control={ready.control} view={ready.view} />
    )
  ) : isWeb && phase.kind === "looking" && !all && !lamps.some((l) => l.id === id) ? (
    // The website lists only the lamps picked in this tab: one from an earlier visit has to be picked again.
    <Card innerClassName="flex flex-col items-start px-7 py-7">
      <p className="text-[17px] font-medium text-foreground">Add the {noun} again</p>
      <p className="mt-2 max-w-xl text-[13.5px] leading-relaxed text-muted-foreground">
        The browser lets SYNQ reach a {noun} only after you pick it in its Bluetooth list, and forgets it when the tab closes.
      </p>
      <AddLightButton notify={notify} className="mt-5" />
    </Card>
  ) : (
    <PhaseCard phase={phase} name={name} noun={noun} all={all} gaveUp={gaveUp} faint={!!targets?.some(weak)} onRetry={retry} />
  );

  return (
    <DeviceFrame
      header={
        <DeviceHeader
          id={lightId(id)}
          name={name}
          pills={
            <>
              <StatusPill live={phase.kind === "ready"}>{PILL[phase.kind]}</StatusPill>
              <TierBadge tier={summary.tier} hint={summary.tierHint} />
            </>
          }
          subtitle={all ? `${targets?.length ?? lamps.length} ${noun}s · every change goes to each one` : first ? `${model?.brand ?? ""} ${first.sku}${phase.kind === "ready" ? ` · ${phase.scheme}` : ""}` : undefined}
          actions={
            ready ? (
              <PowerButton on={ready.view.power !== false} onClick={() => ready.control.setPower(ready.view.power === false)} />
            ) : (phase.kind === "failed" || phase.kind === "lost") && <ReconnectButton onClick={retry} />
          }
          tabs={tabs}
          tab={tab}
          onTab={setTab}
        />
      }
      aside={
        <>
          {stage("h-[clamp(420px,calc(100vh-360px),720px)]")}
          {ready && (
            <StatusStrip
              stats={[
                { label: "Power", value: ready.view.power === null ? "–" : ready.view.power ? "On" : "Off" },
                { label: "Brightness", value: ready.view.brightness === null ? "–" : `${ready.view.brightness}%` },
                { label: "Showing", value: showing(ready.view, ready.control.spec.sku) },
                { label: "Firmware", value: ready.view.firmware ?? "–" },
              ]}
            />
          )}
        </>
      }
    >
      <div key={tab} className={TAB_BODY} tabIndex={0} data-testid={`light-tab-${tab}`}>
        {all && targets && <Members targets={targets} phase={phase} />}
        {phase.kind === "ready" && phase.missed.length > 0 && (
          <Banner>
            {phase.missed.map((m) => lampTitle(m.lamp)).join(", ")} didn't answer, so {phase.missed.length === 1 ? "it isn't" : "they aren't"} following along. Reconnect to try again.
          </Banner>
        )}
        {wide ? (
          body
        ) : (
          <div className="grid grid-cols-[minmax(240px,300px)_minmax(0,1fr)] items-start gap-5">
            {stage("sticky top-0 h-[min(560px,calc(100vh-260px))] min-h-[380px]")}
            <div className="flex min-w-0 flex-col gap-5">{body}</div>
          </div>
        )}
      </div>
    </DeviceFrame>
  );
}

/** "All lamps" (or "All lights"): the lights in the group, each a way to its own page. */
function Members({ targets, phase }: { targets: readonly LampInfo[]; phase: LampPhase }) {
  return (
    <div role="group" className="flex flex-wrap items-center gap-2" aria-label="Lights in this group">
      {targets.map((l) => {
        const reached = phase.kind === "ready" && phase.reached.some((r) => r.id === l.id);
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => openDevice(lightId(l.id))}
            className="inline-flex items-center gap-2 rounded-full bg-white/[0.04] px-3 py-1 text-[12.5px] text-muted-foreground ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.08] hover:text-foreground"
          >
            <span className={cn("size-1.5 rounded-full", reached ? "bg-primary shadow-[0_0_8px_var(--primary)]" : "bg-white/20")} aria-hidden="true" />
            {lampTitle(l)}
          </button>
        );
      })}
    </div>
  );
}

/** What the page says while there is no lamp to drive: looking, connecting, out of reach, paused or lost. */
function PhaseCard({ phase, name, noun, all, gaveUp, faint, onRetry }: { phase: LampPhase; name: string; noun: "lamp" | "light"; all: boolean; gaveUp: boolean; faint: boolean; onRetry: () => void }) {
  const card = (title: string, text: ReactNode, extra?: ReactNode) => (
    <Card innerClassName="flex flex-col items-start px-7 py-7" >
      <p className="text-[17px] font-medium text-foreground">{title}</p>
      <div className="mt-2 max-w-xl text-[13.5px] leading-relaxed text-muted-foreground">{text}</div>
      {extra}
    </Card>
  );
  if (phase.kind === "looking")
    return gaveUp
      ? card(`The ${noun} isn't in range`, "SYNQ hasn't heard it for a while. Check that it is plugged in and switched on at the wall; it shows up on its own once it is heard.")
      : card(`Looking for the ${noun}…`, `SYNQ listens for it over Bluetooth. A ${noun} is heard within a few seconds of being switched on.`);
  if (phase.kind === "connecting") return card(`Connecting to ${name}…`, `This takes a second or two. Nothing on the ${noun} changes until you change something here.`);
  if (phase.kind === "paused") return card("Paused", "SYNQ lets go of lights while its window is in the background, and reconnects when you click back in.");
  if (phase.kind === "lost")
    return card("Lost the connection", `${phase.why.replace(/\.$/, "")}. Reconnect to carry on where you left off.`, <RetryButton onClick={onRetry} />);
  if (phase.kind === "failed")
    return card(
      all ? `None of the ${noun}s answered` : `Can't reach ${name}`,
      <ul className="flex list-disc flex-col gap-1 pl-4">
        <li>It may be out of Bluetooth range{faint ? " (it is heard only faintly)" : ""}: bring the PC and the {noun} closer.</li>
        <li>It may be switched off at the wall.</li>
        <li>A phone may be connected to it: close the Govee Home app, since a {noun} takes one connection at a time.</li>
      </ul>,
      <>
        <RetryButton onClick={onRetry} />
        {phase.missed[0] && <p className="mt-3 text-[11.5px] text-muted-foreground/80">{phase.missed[0].why}</p>}
      </>,
    );
  return null;
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mt-5 rounded-full bg-white/[0.06] px-4 py-1.5 text-[13px] text-foreground ring-1 ring-white/[0.1] transition-colors hover:bg-white/[0.1]">
      Try again
    </button>
  );
}
