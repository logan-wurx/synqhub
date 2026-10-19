// The ATK X1 V2 Air+ panel of the Mouse page. Same layout and feel as the Logitech one; every
// change goes straight to the mouse's memory through src/lib/atk-mouse.ts and is read back.
import { DpiConsole } from "./DpiConsole";
import { useCallback, useEffect, type ReactNode } from "react";
import { LineSegment, Pulse, WaveSine } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { Connected } from "@/lib/backend";
import { connectAtk, MouseAsleep, type AtkSession, type AtkView } from "@/lib/atk-mouse";
import { LIFT_OFF, SENSOR_MODES, type SensorMode } from "@/lib/atk-protocol";
import { Card, CardHeader, ToggleCard, type Notice } from "@/components/ui/matte";
import { GlassRadio } from "@/components/uiverse";
import { MouseOutline, deviceMouseAtk } from "@/components/ui/brand";
import { Banner, EmptyCard, hzText, rateLabel } from "./parts";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { MouseOverview } from "./overview";
import { LiftOffLevels } from "./lift-off";
import { DeviceFrame, DeviceHeader, ReconnectButton, StatusPill, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";
import { MOUSE_TABS_LEGACY, mouseId, useDeviceTab } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { peekKept, peekKeptRef, setKept, useKeptRef, useKeptScroll, useKeptState } from "@/lib/keep";
import { sharePage, type Session } from "@/lib/profiles/live";
import { track, useSessionHold } from "@/lib/device-session";
import { AdvancedCard } from "@/components/advanced";
import { markAnswering } from "@/lib/mouse-probe";
import type { FeelDevice } from "@/components/feel/FeelPanel";
import { driveAtk, type ApplyOutcome } from "@/lib/feel/drive";
import { feelStore } from "@/lib/feel/persist";
import type { Step } from "@/lib/feel/types";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
type Phase = { kind: "connecting" } | { kind: "missing" } | { kind: "asleep" } | { kind: "error"; message: string } | { kind: "ready" };

const ASLEEP = /asleep|did not answer|didn't answer/i;
const message = (e: unknown) => String(e).replace(/^Error: /, "");

/** Kept-state names of this panel (see src/lib/keep.ts); it unmounts while another page is shown. */
const ATK = "mouse.atk";
type Draft = { stages: number[]; activeStage: number };
const isDirty = (view: AtkView | null, draft: Draft | null) =>
  !!view && !!draft && (draft.activeStage !== view.activeStage || draft.stages.join() !== view.stages.join());

// A game profile (src/lib/profiles/live.ts) goes on through this panel's session while it has one open, and shows here.
sharePage((family) =>
  family === "atk"
    ? {
        session: () => peekKeptRef<Session>(`${ATK}.session`),
        busy: () => peekKept(`${ATK}.busy`, false),
        onView: (v: AtkView) => {
          setKept(`${ATK}.view`, v);
          setKept<Draft | null>(`${ATK}.draft`, { stages: v.stages, activeStage: v.activeStage });
        },
      }
    : null,
);

/** 0.7 to 1.7 mm in 0.1 mm steps, the lift-off distances the mouse takes. */
const LIFT_STEPS = Array.from({ length: LIFT_OFF.maxCode - LIFT_OFF.minCode + 1 }, (_, i) => Math.round((LIFT_OFF.minMm + i * LIFT_OFF.stepMm) * 10) / 10);

export function AtkMouse({ devices, notify, visible, switcher }: { devices: Connected[]; notify: Notify; visible: boolean; switcher: ReactNode }) {
  const session = useKeptRef<AtkSession | null>(`${ATK}.session`, null);
  const [phase, setPhase] = useKeptState<Phase>(`${ATK}.phase`, { kind: "connecting" });
  const [view, setView] = useKeptState<AtkView | null>(`${ATK}.view`, null);
  const [draft, setDraft] = useKeptState<Draft | null>(`${ATK}.draft`, null);
  const [busy, setBusy] = useKeptState(`${ATK}.busy`, false);
  /** The connect in flight, and why the last quiet one failed (see `quiet` below). */
  const connecting = useKeptRef<Promise<boolean> | null>(`${ATK}.connecting`, null);
  const quietError = useKeptRef<string | null>(`${ATK}.quietError`, null);
  // Connected, so the switcher doesn't call it "Off or asleep" (src/lib/mouse-probe.ts).
  useEffect(() => {
    if (phase.kind === "ready") markAnswering("atk");
  }, [phase.kind]);

  // Reconnect when the receiver or cable comes and goes.
  const attachKey = devices.filter((d) => d.kind === "mouse" && d.vid === "373b").map((d) => d.pid).sort().join(",");

  /**
   * `quiet`: reopening after the idle close (src/lib/device-session.ts). The last view stays on
   * screen while it reconnects, and if the mouse doesn't answer the panel stays as it was, with
   * the error kept for the next change, as an open session that lost the mouse would behave.
   */
  const connect = useCallback(
    (quiet = false): Promise<boolean> => {
      const work = (async () => {
        if (!quiet) setPhase({ kind: "connecting" });
        await session.current?.close().catch(() => undefined);
        session.current = null;
        try {
          const s = await connectAtk();
          if (!s) {
            if (quiet) quietError.current = "The receiver isn't plugged in. Connect the 8K receiver, and close ATK HUB if it's open in a browser.";
            else setPhase({ kind: "missing" });
            return false;
          }
          session.current = s;
          quietError.current = null;
          setView(s.view);
          setDraft({ stages: s.view.stages, activeStage: s.view.activeStage });
          setPhase({ kind: "ready" });
          return true;
        } catch (e) {
          const asleep = e instanceof MouseAsleep || ASLEEP.test(message(e));
          if (quiet) quietError.current = asleep ? "The mouse didn't answer. Move it to wake it up, then try again." : message(e);
          else setPhase(asleep ? { kind: "asleep" } : { kind: "error", message: message(e) });
          return false;
        }
      })();
      connecting.current = work;
      void work.finally(() => {
        if (connecting.current === work) connecting.current = null;
      });
      return track(ATK, work);
    },
    [setPhase, setView, setDraft, session, connecting, quietError],
  );

  // Connect the first time the panel is shown, when the attachment changes, and on coming back to a
  // mouse that was asleep. No polling.
  const connectedFor = useKeptRef<string | null>(`${ATK}.connectedFor`, null);
  const resumeFor = useKeptRef<string | null>(`${ATK}.resumeFor`, null);
  useEffect(() => {
    if (!visible) return;
    if (connectedFor.current !== attachKey || phase.kind === "asleep") {
      const quiet = resumeFor.current === attachKey && phase.kind === "ready";
      resumeFor.current = null;
      connectedFor.current = attachKey;
      void connect(quiet).then((ok) => {
        // Try again quietly the next time the panel is shown.
        if (!ok && quiet && connectedFor.current === attachKey) {
          connectedFor.current = null;
          resumeFor.current = attachKey;
        }
      });
    }
    // phase is read, not watched: an asleep mouse is retried when the panel is shown again, not in a loop.
  }, [attachKey, visible, connect, connectedFor, resumeFor]);

  // The session stays open while the panel is away and closes after a short idle; unsaved DPI
  // steps keep it open.
  useSessionHold(
    ATK,
    async () => {
      const s = session.current;
      if (!s) return;
      session.current = null;
      resumeFor.current = connectedFor.current;
      connectedFor.current = null;
      await s.close();
    },
    () => !isDirty(peekKept<AtkView | null>(`${ATK}.view`, null), peekKept<Draft | null>(`${ATK}.draft`, null)),
  );

  const run = async (label: string, action: (s: AtkSession) => Promise<AtkView>) => {
    if (busy) return;
    if (!session.current && phase.kind === "ready") {
      // Reopening after the idle close: wait for it (or start it), and report why if it can't.
      await (connecting.current ?? connect(true));
      if (!session.current) {
        notify({ title: "Not saved", detail: quietError.current ?? "The mouse didn't answer. Move it to wake it up, then try again.", tone: "error" }, "mouse");
        return;
      }
    }
    const s = session.current;
    if (!s) return;
    setBusy(true);
    try {
      const v = await track(ATK, action(s));
      setView(v);
      setDraft({ stages: v.stages, activeStage: v.activeStage });
      notify({ title: label, detail: "Saved to the mouse's memory", tone: "ok" }, "mouse");
      void feelStore.noteConfigured("mouse", mouseId("atk"));
    } catch (e) {
      const m = message(e);
      notify({ title: "Not saved", detail: ASLEEP.test(m) ? "The mouse didn't answer. Move it to wake it up, then try again." : m, tone: "error" }, "mouse");
    } finally {
      setBusy(false);
    }
  };

  /** "Keep your feel": a plan's steps through this same session (one backup first, each change read back). */
  const applyFeel = async (steps: Step[]): Promise<ApplyOutcome<unknown>> => {
    const stop = (error: string): ApplyOutcome<unknown> => ({ ok: false, done: 0, total: steps.length, error, view: null });
    if (busy) return stop("Another change is still being saved.");
    if (!session.current && phase.kind === "ready") {
      await (connecting.current ?? connect(true));
      if (!session.current) return stop(quietError.current ?? "The mouse didn't answer. Move it to wake it up, then try again.");
    }
    const s = session.current;
    if (!s) return stop("The mouse isn't connected.");
    setBusy(true);
    try {
      const r = await track(
        ATK,
        driveAtk(s, steps, (v) => {
          setView(v);
          setDraft({ stages: v.stages, activeStage: v.activeStage });
        }),
      );
      if (r.done) void feelStore.noteConfigured("mouse", mouseId("atk"));
      return r;
    } finally {
      setBusy(false);
    }
  };

  const dirty = isDirty(view, draft);
  const locked = !view?.writable;
  const range = view?.dpiRange;
  const wide = useWide();
  const asideOn = wide && phase.kind === "ready" && !!view;
  const tabs: TabDef[] = [
    ...(asideOn ? [] : [{ id: "overview", label: "Overview" }]),
    { id: "controls", label: asideOn ? "Settings" : "Controls" },
    { id: "advanced", label: "Advanced" },
  ];
  const [tab, setTab] = useDeviceTab(mouseId("atk"), tabs.map((t) => t.id), MOUSE_TABS_LEGACY);
  const body = useKeptScroll(`${ATK}.scroll.${tab}`);
  const ready = phase.kind === "ready" && view && draft && range;

  const feel: FeelDevice | undefined = view
    ? {
        id: mouseId("atk"),
        kind: "mouse",
        family: "atk",
        name: view.name || "X1 V2 Air+",
        brand: "ATK",
        view,
        notify,
        apply: applyFeel,
        gate: { writable: view.writable, reason: view.readOnlyReason ?? (view.writable ? null : "This mouse can't be changed from SYNQ yet.") },
      }
    : undefined;

  const overview = phase.kind === "ready" && !!view ? (
              <MouseOverview
                feel={feel}
                pollingInConsole={true}
                liftOffInConsole={true}
                art={<DeviceArt spec={{ kind: "mouse", family: "atk", name: "X1 V2 Air+", brand: "ATK" }} />}
                link={view.connection}
                name={view.name}
                detail={`${view.connectionDetail}. What the mouse reports right now is below.`}
                stats={[
                  { label: "DPI", value: view.dpi },
                  { label: "Polling", value: hzText(view.pollingHz) },
                  { label: "Lift-off", value: view.liftOffMm === null ? "—" : `${view.liftOffMm.toFixed(1)} mm` },
                  { label: "Battery", value: view.batteryPercent === null ? "—" : `${view.batteryPercent}%`, note: view.charging === null ? undefined : view.charging ? "Charging" : "On battery" },
                ]}
                battery={{
                  show: true,
                  percent: view.batteryPercent,
                  charging: view.charging === true,
                  state: view.charging === null ? "—" : view.charging ? "Charging" : "On battery",
                  title: "Battery",
                  rows: [
                    ["Firmware", <span className="text-[12.5px]">{[view.firmware && `Mouse ${view.firmware}`, view.receiverFirmware && `Receiver ${view.receiverFirmware}`].filter(Boolean).join(" · ") || "—"}</span>],
                    ["Sensor", view.sensorLabel],
                    ["Sleeps after", view.sleepSeconds >= 60 ? `${view.sleepSeconds / 60} min` : `${view.sleepSeconds} s`],
                  ],
                }}
              />
  ) : null;

  return (
    <DeviceFrame
      aside={overview}
      header={
      <DeviceHeader
        id={mouseId("atk")}
        name={view?.name ?? "X1 V2 Air+"}
        subtitle={view && phase.kind === "ready" ? "Changes are saved to the mouse itself, so they stay without any app running." : "ATK X1 V2 Air+"}
        pills={
          <>
            <StatusPill live={phase.kind === "ready"}>
              {phase.kind === "ready" && view
                ? `${view.connection === "Wired" ? "Cable" : "Wireless"} · ${view.connectionDetail}`
                : phase.kind === "connecting"
                  ? "Connecting"
                  : phase.kind === "asleep"
                    ? "Receiver connected"
                    : "Not connected"}
            </StatusPill>
            {ready && <TierBadge tier={view.writable ? "verified" : "read-only"} hint={view.readOnlyReason ?? undefined} />}
          </>
        }
        actions={
          <>
            {switcher}
            <ReconnectButton onClick={() => void connect()} />
          </>
        }
        tabs={tabs}
        tab={tab}
        onTab={setTab}
      />
      }
    >
      <div key={tab} ref={body} className={TAB_BODY} tabIndex={0}>
        {phase.kind === "connecting" && <EmptyCard title="Looking for your mouse…" text="This takes a second." {...hero()} />}
        {phase.kind === "missing" && <EmptyCard title="Plug it in" text="Connect the 8K receiver, and close ATK HUB if it's open in a browser." plug />}
        {phase.kind === "asleep" && <EmptyCard title="The mouse is asleep" text="The receiver is here, but the mouse didn't answer. Move it to wake it up, then press Reconnect." {...hero()} />}
        {phase.kind === "error" && <EmptyCard title="Couldn't talk to the mouse" text={phase.message} plug />}

        {ready && (
          <>
            {view.readOnlyReason && <Banner>{view.readOnlyReason}</Banner>}

            {tab === "overview" && overview}

            {/* The Sensitivity console, on the Overview: most people come to change the DPI and go. */}
            {tab === "overview" && (
              <>
                <DpiConsole
                  polling={{ hz: view.pollingHz, options: view.pollingOptions, disabled: busy || locked, hint: `Through the ${view.connectionDetail}. 2K and up cost more battery and CPU.`, onPick: (hz) => run(`Polling rate set to ${rateLabel(hz)} Hz`, (s) => s.setPolling(hz)) }}
                  dpi={view.dpi}
                  range={{ min: range.min, max: range.max }}
                  pick={{ step: range.step, disabled: busy || locked, onPick: (dpi) => run(`Now running ${dpi} DPI`, (s) => s.setActiveDpi(dpi)) }}
                  extras={
                    <LiftOffLevels
                      options={LIFT_STEPS}
                      value={view.liftOffMm === null ? null : Math.round(view.liftOffMm * 10) / 10}
                      label={(mm) => `${mm.toFixed(1)} mm`}
                      disabled={busy || locked}
                      onPick={(mm) => run(`Lift-off set to ${mm.toFixed(1)} mm`, (s) => s.setLiftOff(mm))}
                    />
                  }
                  steps={{
                    stages: draft.stages,
                    active: draft.activeStage,
                    min: range.min,
                    max: range.max,
                    step: range.step,
                    maxStages: range.maxStages,
                    editable: true,
                    countEditable: true,
                    disabled: locked,
                    hint: "Click a step to run it; the fader sets its speed. The DPI button cycles through them.",
                    dirty,
                    busy,
                    saveLabel: { dirty: "Save to mouse", clean: "Saved" },
                    onChange: (stages, activeStage) => setDraft({ stages, activeStage }),
                    onSave: () => run("DPI steps saved", (s) => s.saveStages(draft.stages, draft.activeStage)),
                  }}
                />
              </>
            )}

            {tab === "controls" && (
              <>
                {/* The polling rate and lift-off are on the Overview, with the DPI. */}
                <div className="grid grid-cols-[1.45fr_1fr] gap-5">
                  <Card>
                    <CardHeader title="Tracking" hint="Sensor filters, saved to the mouse the moment you flip them." />
                    <div className={cn("px-2 pb-2 pt-2", locked && "pointer-events-none opacity-60")}>
                      <ToggleCard
                        icon={LineSegment}
                        title="Angle snapping"
                        status={view.angleSnapping ? "On: nearly straight moves come out straight" : "Off: the sensor's raw path"}
                        checked={view.angleSnapping}
                        onCheckedChange={(on) => run(`Angle snapping ${on ? "on" : "off"}`, (s) => s.setAngleSnapping(on))}
                      />
                      <ToggleCard
                        icon={WaveSine}
                        title="Ripple control"
                        status={view.rippleControl ? "On: smooths jitter at high DPI" : "Off: no smoothing"}
                        checked={view.rippleControl}
                        onCheckedChange={(on) => run(`Ripple control ${on ? "on" : "off"}`, (s) => s.setRippleControl(on))}
                      />
                      <ToggleCard
                        icon={Pulse}
                        title="Motion sync"
                        status={view.motionSync ? "On: reports line up with sensor frames" : "Off: a hair less delay"}
                        checked={view.motionSync}
                        onCheckedChange={(on) => run(`Motion sync ${on ? "on" : "off"}`, (s) => s.setMotionSync(on))}
                      />
                    </div>
                  </Card>
                  <Card>
                    <CardHeader title="Sensor mode" hint={SENSOR_MODES.find((m) => m.value === view.sensorMode)?.hint ?? "Unknown mode"} />
                    <div className={cn("px-5 pb-5 pt-4", (busy || locked || view.sensorMode === null) && "pointer-events-none opacity-60")}>
                      <GlassRadio<string>
                        value={String(view.sensorMode ?? 0)}
                        onChange={(v) => {
                          const mode = Number(v) as SensorMode;
                          run(`Sensor mode: ${SENSOR_MODES.find((m) => m.value === mode)?.label ?? mode}`, (s) => s.setSensorMode(mode));
                        }}
                        options={SENSOR_MODES.map((m) => ({ value: String(m.value), label: m.label }))}
                      />
                    </div>
                  </Card>
                </div>
              </>
            )}

            {tab === "controls" && (
              <Card>
                <CardHeader title="Click debounce" hint="Lower is faster; raise it if a button double-clicks." />
                <div className={cn("px-5 pb-5 pt-4", (busy || locked) && "pointer-events-none opacity-60")}>
                  <GlassRadio<string>
                    value={String(view.debounceMs)}
                    onChange={(v) => run(`Debounce set to ${v} ms`, (s) => s.setDebounce(Number(v)))}
                    options={view.debounceOptions.map((ms) => ({ value: String(ms), label: String(ms), hint: "ms" }))}
                  />
                </div>
                <p className="px-5 pb-4 text-[12px] text-medium">Button remapping and macros are under Advanced, with their own confirmations.</p>
              </Card>
            )}

            {tab === "advanced" && session.current && (
              <AdvancedCard
                id="atk"
                panel={session.current.advanced}
                lockedReason={view.readOnlyReason}
                notify={notify}
                hold={(p) => track(ATK, p)}
                onChanged={() =>
                  void session.current?.refresh().then((v) => {
                    setView(v);
                    setDraft({ stages: v.stages, activeStage: v.activeStage });
                  })
                }
              />
            )}
          </>
        )}
      </div>
    </DeviceFrame>
  );
}

/** The X1 render when it's in the assets folder, else the outline stand-in. */
function hero(): { image?: string; art?: ReactNode } {
  return deviceMouseAtk ? { image: deviceMouseAtk } : { art: <MouseOutline className="h-full" /> };
}
