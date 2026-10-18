// The Mouse page's panel for every mouse SYNQ has no hand-built code for: it is built from what
// the mouse's OpenMouse driver reports (MouseStatus and its `ui` hints), and shows only what the
// driver supports. Every change goes through SafeMouse (src/lib/openmouse/safe-mouse.ts): backup
// first, then the write, then a read-back. No Tauri here: the host comes in as a prop.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import NumberFlow from "@number-flow/react";
import { Lightning, LineSegment, Plus, Pulse, WaveSine, type Icon } from "@phosphor-icons/react";
import type { MouseLighting, MouseLightingMode } from "@openmouse/protocol/drivers";
import { cn } from "@/lib/utils";
import type { Connected } from "@/lib/backend";
import { connectGeneric, type GenericHost } from "@/lib/openmouse/host";
import type { Change, GenericView, SafeMouse, ToggleSetting } from "@/lib/openmouse/safe-mouse";
import { PERSISTENCE_LABEL, TIER_LABEL, type Persistence } from "@/lib/openmouse/policy";
import { Card, CardHeader, ToggleCard, type Notice } from "@/components/ui/matte";
import { Switch } from "@/components/ui/switch";
import { GlassRadio } from "@/components/uiverse";
import { MouseOutline } from "@/components/ui/brand";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { Banner, DpiPresets, EmptyCard, StageEditor, hzText, rateLabel } from "./parts";
import { MouseOverview } from "./overview";
import { DeviceFrame, DeviceHeader, ReconnectButton, StatusPill, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";
import { MOUSE_TABS_LEGACY, mouseId, useDeviceTab } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { linkOf } from "@/lib/device-model";
import { peekKept, useKeptRef, useKeptScroll, useKeptState } from "@/lib/keep";
import { track, useSessionHold } from "@/lib/device-session";
import { markAnswering } from "@/lib/mouse-probe";
import { AdvancedCard } from "@/components/advanced";
import type { FeelDevice } from "@/components/feel/FeelPanel";
import { driveGenericMouse, type ApplyOutcome } from "@/lib/feel/drive";
import { feelStore } from "@/lib/feel/persist";
import type { Step } from "@/lib/feel/types";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
type Phase = { kind: "connecting" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "ready" };
type Draft = { stages: number[]; active: number };

const message = (e: unknown) => String(e).replace(/^Error: /, "");
const ASLEEP = /timeout|timed out|no reply|did not answer|didn't answer|asleep/i;
const friendly = (e: unknown) => (ASLEEP.test(message(e)) ? "The mouse didn't answer. Move it to wake it up, then try again." : message(e));

const isDirty = (view: GenericView | null, draft: Draft | null) =>
  !!view?.stages && !!draft && (draft.active !== view.stages.active || draft.stages.join() !== view.stages.values.join());

const TOGGLES: Record<ToggleSetting, { title: string; icon: Icon; on: string; off: string }> = {
  motionSync: { title: "Motion sync", icon: Pulse, on: "On: reports line up with sensor frames", off: "Off: a hair less delay" },
  angleSnapping: { title: "Angle snapping", icon: LineSegment, on: "On: nearly straight moves come out straight", off: "Off: the sensor's raw path" },
  rippleControl: { title: "Ripple control", icon: WaveSine, on: "On: smooths jitter at high DPI", off: "Off: no smoothing" },
};

const seconds = (s: number) => (s >= 3600 ? `${+(s / 3600).toFixed(1)} h` : s >= 60 ? `${+(s / 60).toFixed(1)} min` : `${s} s`);

export function GenericMouse({
  id,
  devices,
  getHost,
  notify,
  visible,
  switcher,
}: {
  /** "vid:pid" in lower-case hex. */
  id: string;
  devices: Connected[];
  getHost: () => Promise<GenericHost>;
  notify: Notify;
  visible: boolean;
  switcher: ReactNode;
}) {
  const K = `mouse.om.${id}`;
  const session = useKeptRef<SafeMouse | null>(`${K}.session`, null);
  const [phase, setPhase] = useKeptState<Phase>(`${K}.phase`, { kind: "connecting" });
  const [view, setView] = useKeptState<GenericView | null>(`${K}.view`, null);
  const [draft, setDraft] = useKeptState<Draft | null>(`${K}.draft`, null);
  const [busy, setBusy] = useKeptState(`${K}.busy`, false);
  const [allow, setAllow] = useKeptState(`${K}.allow`, false);
  const [live, setLive] = useState(true);
  const connecting = useKeptRef<Promise<boolean> | null>(`${K}.connecting`, null);
  const quietError = useKeptRef<string | null>(`${K}.quietError`, null);
  const entry = devices.find((d) => `${d.vid}:${d.pid}` === id);
  // Connected, so the switcher doesn't call it "Off or asleep" (src/lib/mouse-probe.ts).
  useEffect(() => {
    if (phase.kind === "ready") markAnswering(`om:${id}`);
  }, [phase.kind, id]);

  const show = useCallback(
    (v: GenericView) => {
      setView(v);
      setDraft(v.stages ? { stages: v.stages.values, active: v.stages.active } : null);
    },
    [setView, setDraft],
  );

  const connect = useCallback(
    (quiet = false): Promise<boolean> => {
      const work = (async () => {
        if (!quiet) setPhase({ kind: "connecting" });
        await session.current?.close().catch(() => undefined);
        session.current = null;
        try {
          const host = await getHost();
          setLive(host.live);
          const s = await connectGeneric(host, id);
          if (!s) {
            if (quiet) quietError.current = "The mouse isn't plugged in.";
            else setPhase({ kind: "missing" });
            return false;
          }
          session.current = s;
          quietError.current = null;
          // The allow switch is kept for this mouse until it's unplugged.
          show(s.setAllowChanges(peekKept(`${K}.allow`, false)));
          setPhase({ kind: "ready" });
          return true;
        } catch (e) {
          if (quiet) quietError.current = friendly(e);
          else setPhase({ kind: "error", message: friendly(e) });
          return false;
        }
      })();
      connecting.current = work;
      void work.finally(() => {
        if (connecting.current === work) connecting.current = null;
      });
      return track(K, work);
    },
    [K, id, getHost, setPhase, show, session, connecting, quietError],
  );

  const connectedFor = useKeptRef<boolean>(`${K}.connectedFor`, false);
  const resume = useKeptRef<boolean>(`${K}.resume`, false);
  useEffect(() => {
    if (!visible || connectedFor.current) return;
    const quiet = resume.current;
    resume.current = false;
    connectedFor.current = true;
    void connect(quiet).then((ok) => {
      if (!ok && quiet) {
        connectedFor.current = false;
        resume.current = true;
      }
    });
  }, [visible, connect, connectedFor, resume]);

  useSessionHold(
    K,
    async () => {
      const s = session.current;
      if (!s) return;
      session.current = null;
      resume.current = connectedFor.current;
      connectedFor.current = false;
      await s.close();
    },
    () => !isDirty(peekKept<GenericView | null>(`${K}.view`, null), peekKept<Draft | null>(`${K}.draft`, null)),
  );

  const run = async (label: string, change: Change) => {
    if (busy) return;
    if (!session.current && phase.kind === "ready") {
      await (connecting.current ?? connect(true));
      if (!session.current) {
        notify({ title: "Not changed", detail: quietError.current ?? "The mouse didn't answer.", tone: "error" }, "mouse");
        return;
      }
    }
    const s = session.current;
    if (!s) return;
    setBusy(true);
    try {
      const r = await track(K, s.apply(change));
      show(r.view);
      notify({ title: r.verdict === "mismatch" ? `${label}: didn't take` : label, detail: r.detail, tone: r.verdict === "mismatch" ? "error" : r.verdict === "confirmed" ? "ok" : "info" }, "mouse");
      if (r.verdict !== "mismatch") void feelStore.noteConfigured("mouse", mouseId(`om:${id}`));
    } catch (e) {
      notify({ title: "Not changed", detail: friendly(e), tone: "error" }, "mouse");
      // What the mouse holds now, whatever happened.
      await s.refresh().then(show, () => undefined);
    } finally {
      setBusy(false);
    }
  };

  /** "Keep your feel": a plan's steps through this same SafeMouse (backup first, each change read back). */
  const applyFeel = async (steps: Step[]): Promise<ApplyOutcome<unknown>> => {
    const stop = (error: string): ApplyOutcome<unknown> => ({ ok: false, done: 0, total: steps.length, error, view: null });
    if (busy) return stop("Another change is still being saved.");
    if (!session.current && phase.kind === "ready") {
      await (connecting.current ?? connect(true));
      if (!session.current) return stop(quietError.current ?? "The mouse didn't answer.");
    }
    const s = session.current;
    if (!s) return stop("The mouse isn't connected.");
    setBusy(true);
    try {
      const r = await track(K, driveGenericMouse(s, steps, show));
      if (r.done) void feelStore.noteConfigured("mouse", mouseId(`om:${id}`));
      // What the mouse holds now, whatever happened.
      if (!r.ok) await s.refresh().then(show, () => undefined);
      return r;
    } finally {
      setBusy(false);
    }
  };

  const toggleAllow = (on: boolean) => {
    setAllow(on);
    const s = session.current;
    if (s) show(s.setAllowChanges(on));
  };

  const locked = !view?.writable;
  const off = (canSet: boolean | undefined) => busy || locked || !canSet;
  const dirty = isDirty(view, draft);
  const wantsDpi = !!view && (view.dpi.canSet || !!view.stages);
  const wantsPerformance = !!view && (!!view.polling || !!view.lod || view.toggles.length > 0 || !!view.sleep);
  const wantsButtons = !!view && (!!view.debounce || !!view.magnetic);
  const wide = useWide();
  const asideOn = wide && phase.kind === "ready" && !!view;
  const tabs: TabDef[] = [
    ...(asideOn ? [] : [{ id: "overview", label: "Overview" }]),
    ...(wantsDpi && !asideOn ? [{ id: "sensitivity", label: "Sensitivity" }] : []),
    ...(wantsPerformance || wantsButtons || view?.lighting || (asideOn && wantsDpi) ? [{ id: "controls", label: asideOn ? "Settings" : "Controls" }] : []),
    { id: "advanced", label: "Advanced" },
  ];
  const navId = mouseId(`om:${id}`);
  const [tab, setTab] = useDeviceTab(navId, tabs.map((t) => t.id), MOUSE_TABS_LEGACY);
  const body = useKeptScroll(`${K}.scroll.${tab}`);

  const feel: FeelDevice | undefined = view
    ? {
        id: mouseId(`om:${id}`),
        kind: "mouse",
        family: `om:${id}`,
        name: view.name,
        brand: view.brand,
        view,
        notify,
        apply: applyFeel,
        gate: {
          writable: view.writable,
          reason: view.lockedReason,
          // A mouse SYNQ hasn't been tried on stays read-only until the person turns changes on.
          allow: view.canAllow ? { on: allow && view.allowChanges, set: toggleAllow } : undefined,
        },
      }
    : undefined;

  const overview = phase.kind === "ready" && !!view ? (
              <MouseOverview
                feel={feel}
                art={<DeviceArt spec={{ kind: "mouse", family: `om:${id}`, name: view.name, brand: view.brand }} />}
                link={linkOf(view.connection ?? entry?.connection) ?? null}
                name={view.name}
                detail={`${view.brand} · ${view.dpi.min}–${view.dpi.max} DPI. What the mouse reports right now is below.`}
                stats={[
                  { label: "DPI", value: view.dpi.value },
                  { label: "Polling", value: view.polling ? hzText(view.polling.hz) : "—" },
                  { label: "Lift-off", value: view.lod?.value ?? "—" },
                  { label: "Battery", value: view.showBattery && view.batteryPercent !== null ? `${view.batteryPercent}%` : "—", note: view.showBattery && view.batteryState !== "Unknown" ? view.batteryState : undefined },
                ]}
                battery={{
                  show: view.showBattery,
                  percent: view.batteryPercent,
                  charging: /charg/i.test(view.batteryState) && !/discharg/i.test(view.batteryState),
                  state: view.showBattery ? (view.batteryState === "Unknown" ? "—" : view.batteryState) : view.brand,
                  title: view.showBattery ? "Battery" : "Mouse",
                  rows: [
                    ["Firmware", <span className="tabular block max-w-[240px] truncate text-[12px]" title={view.firmware.join(", ")}>{view.firmware.join(" · ") || "—"}</span>],
                    ["Driver", <span className="block max-w-[240px] truncate text-[12px]" title={view.driver}>{view.driver.replace(/HidClient$|Client$/, "")}</span>],
                    ["USB id", <span className="tabular text-[12px]">{id}</span>],
                  ],
                }}
              />
  ) : null;

  return (
    <DeviceFrame
      aside={overview}
      header={
      <DeviceHeader
        id={navId}
        name={view?.name ?? entry?.name ?? "Mouse"}
        subtitle={
          <>
            {view ? `${view.brand} · OpenMouse driver` : (entry?.brand ?? "Mouse")}
            {!live && <span className="text-chart-3"> · sample mouse</span>}
          </>
        }
        pills={
          <>
            <StatusPill live={phase.kind === "ready"}>
              {phase.kind === "ready" && view ? (view.connection ?? entry?.connection ?? "Connected") : phase.kind === "connecting" ? "Connecting" : "Not connected"}
            </StatusPill>
            {view && <TierBadge tier={view.tier} hint={TIER_LABEL[view.tier].hint} />}
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
        {phase.kind === "connecting" && <EmptyCard title="Looking for your mouse…" text="Reading its settings. Nothing is changed." art={<MouseOutline className="h-full" />} />}
        {phase.kind === "missing" && <EmptyCard title="Plug it in" text="Connect its receiver or cable, and close the maker's app if it's open." plug />}
        {phase.kind === "error" && <EmptyCard title="Couldn't talk to the mouse" text={phase.message} plug />}

        {phase.kind === "ready" && view && (
          <>
            {view.notes.map((n) => (
              <Banner key={n}>{n}</Banner>
            ))}
            {view.mode === "Host" && <Banner>The mouse is in host mode: changes here last until it turns off.</Banner>}
            {view.lockedReason && !view.canAllow && <Banner>{view.lockedReason}</Banner>}
            {view.canAllow && <AllowCard allowed={allow && view.allowChanges} onChange={toggleAllow} />}

            {tab === "overview" && overview}

            {(tab === "sensitivity" || (asideOn && tab === "controls")) && (
              <>
                <Card innerClassName="relative overflow-hidden px-6 pb-6 pt-5">
                  <div className="flex items-center gap-2">
                    <p className="text-[13px] text-muted-foreground">Sensitivity</p>
                    {(view.dpi.canSet || view.stages?.canSet) && <Kept p={view.persistence[view.stages?.canSet ? "setDpiStageValue" : "setDpi"]} />}
                  </div>
                  <div className="mt-3 flex items-baseline gap-3">
                    <NumberFlow
                      value={view.dpi.value}
                      className="tabular text-[86px] font-medium leading-none tracking-[-0.06em] text-foreground [text-shadow:0_0_28px_color-mix(in_srgb,var(--primary)_30%,transparent)]"
                    />
                    <span className="text-[18px] text-muted-foreground">DPI</span>
                  </div>
                  {view.dpi.canSet && !view.stages?.canSet && (
                    <DpiPresets value={view.dpi.value} min={view.dpi.min} max={view.dpi.max} disabled={off(true)} onPick={(dpi) => run(`Now running ${dpi} DPI`, { kind: "dpi", dpi })} />
                  )}
                  <p className="mt-5 text-[12px] text-muted-foreground">
                    {view.dpi.min}–{view.dpi.max} DPI
                  </p>
                </Card>

                {view.stages && draft && (
                  <Card>
                    <CardHeader
                      title="DPI steps"
                      hint={view.stages.canSet ? "The mouse runs the starred step. The DPI button cycles through the rest." : "The steps the mouse holds. This driver can't change them."}
                      right={
                        view.stages.canSet && (
                          <button
                            disabled={!dirty || busy || locked}
                            onClick={() => run("DPI steps changed", { kind: "stages", values: draft.stages, active: draft.active })}
                            className="group flex h-9 items-center gap-2 rounded-full bg-foreground pl-4 pr-1.5 text-[13px] font-medium text-background transition-all duration-300 ease-fluid active:scale-[0.98] disabled:bg-white/[0.06] disabled:text-muted-foreground"
                          >
                            {busy ? "Saving…" : dirty ? "Send to mouse" : "Up to date"}
                            <span className="grid size-6 place-items-center rounded-full bg-black/10">
                              <Lightning size={12} weight="fill" />
                            </span>
                          </button>
                        )
                      }
                    />
                    <div className={cn("flex flex-wrap items-stretch gap-3 px-5 pb-5 pt-4", off(view.stages.canSet) && "opacity-60")}>
                      {draft.stages.map((dpi, i) => (
                        <StageEditor
                          key={i}
                          index={i}
                          value={dpi}
                          isDefault={i === draft.active}
                          step={view.stages!.step}
                          min={view.stages!.min}
                          max={view.stages!.max}
                          disabled={off(view.stages!.canSet)}
                          starTitle="Run this step"
                          onChange={(v) => setDraft({ ...draft, stages: draft.stages.map((x, j) => (j === i ? v : x)) })}
                          onDefault={() => setDraft({ ...draft, active: i })}
                          onRemove={
                            view.stages!.countEditable && draft.stages.length > 1
                              ? () =>
                                  setDraft({
                                    stages: draft.stages.filter((_, j) => j !== i),
                                    active: Math.min(draft.active > i ? draft.active - 1 : draft.active, draft.stages.length - 2),
                                  })
                              : undefined
                          }
                        />
                      ))}
                      {!locked && view.stages.countEditable && draft.stages.length < view.stages.maxStages && (
                        <button
                          onClick={() => setDraft({ ...draft, stages: [...draft.stages, Math.min((draft.stages[draft.stages.length - 1] ?? 800) * 2, view.stages!.max)] })}
                          className="flex w-[118px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/10 text-[12.5px] text-muted-foreground transition-colors hover:bg-white/[0.03] hover:text-foreground"
                        >
                          <Plus size={16} weight="light" /> Add step
                        </button>
                      )}
                    </div>
                  </Card>
                )}
              </>
            )}

            {tab === "controls" && (
              <>
                {(view.polling || view.lod) && (
                  <div className={cn("grid gap-5", view.polling && view.lod ? "grid-cols-[1.45fr_1fr]" : "grid-cols-1")}>
                    {view.polling && (
                      <Card>
                        <CardHeader title="Polling rate" hint={view.polling.note ?? "Reports per second. Higher costs more battery and CPU."} right={view.polling.canSet && <Kept p={view.persistence.setPollingRate} />} />
                        <div className={cn("px-5 pb-5 pt-4", off(view.polling.canSet) && "pointer-events-none opacity-60")}>
                          <GlassRadio<string>
                            value={String(view.polling.hz)}
                            onChange={(v) => run(`Polling rate set to ${rateLabel(Number(v))} Hz`, { kind: "polling", hz: Number(v) })}
                            options={view.polling.options.map((hz) => ({ value: String(hz), label: rateLabel(hz), hint: "Hz" }))}
                          />
                        </div>
                      </Card>
                    )}
                    {view.lod && (
                      <Card>
                        <CardHeader title="Lift-off distance" hint="How high you can lift before it stops tracking." right={view.lod.canSet && <Kept p={view.persistence.setLiftOffDistance} />} />
                        <div className={cn("px-5 pb-5 pt-4", off(view.lod.canSet) && "pointer-events-none opacity-60")}>
                          <GlassRadio<string>
                            value={view.lod.value ?? ""}
                            onChange={(v) => run(`Lift-off set to ${v.toLowerCase()}`, { kind: "lod", value: v as never })}
                            options={view.lod.options.map((l) => ({ value: l, label: l }))}
                          />
                        </div>
                      </Card>
                    )}
                  </div>
                )}

                {(view.toggles.length > 0 || view.sleep) && (
                  <div className={cn("grid gap-5", view.toggles.length && view.sleep ? "grid-cols-[1.45fr_1fr]" : "grid-cols-1")}>
                    {view.toggles.length > 0 && (
                      <Card>
                        <CardHeader title="Tracking" hint="Sensor filters, sent to the mouse the moment you flip them." right={<Kept p={view.persistence[`set${cap(view.toggles[0].setting)}` as "setMotionSync"]} />} />
                        <div className="px-2 pb-2 pt-2">
                          {view.toggles.map((t) => {
                            const c = TOGGLES[t.setting];
                            return (
                              <div key={t.setting} className={cn(off(t.canSet) && "pointer-events-none opacity-60")}>
                                <ToggleCard
                                  icon={c.icon}
                                  title={c.title}
                                  status={t.value === null ? "Unknown: the mouse didn't report it" : t.value ? c.on : c.off}
                                  checked={t.value === true}
                                  onCheckedChange={(on) => run(`${c.title} ${on ? "on" : "off"}`, { kind: "toggle", setting: t.setting, on })}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </Card>
                    )}
                    {view.sleep && (
                      <Card>
                        <CardHeader title="Sleeps after" hint="Idle time before the mouse sleeps to save battery." right={view.sleep.canSet && <Kept p={view.persistence.setSleepTimeout} />} />
                        <div className={cn("px-5 pb-5 pt-4", off(view.sleep.canSet) && "pointer-events-none opacity-60")}>
                          {view.sleep.options.length ? (
                            <GlassRadio<string>
                              value={String(view.sleep.value)}
                              onChange={(v) => run(`Sleeps after ${seconds(Number(v) * view.sleep!.secondsPerUnit)}`, { kind: "sleep", value: Number(v) })}
                              options={view.sleep.options.slice(0, 7).map((v) => {
                                const [n, unit] = seconds(v * view.sleep!.secondsPerUnit).split(" ");
                                return { value: String(v), label: n, hint: unit };
                              })}
                            />
                          ) : (
                            <p className="tabular text-[15px] text-foreground">{view.sleep.value === null ? "—" : seconds(view.sleep.value * view.sleep.secondsPerUnit)}</p>
                          )}
                        </div>
                      </Card>
                    )}
                  </div>
                )}
              </>
            )}

            {tab === "controls" && (
              <>
                {view.debounce && (
                  <Card>
                    <CardHeader title="Click debounce" hint="Lower is faster; raise it if a button double-clicks." right={view.debounce.canSet && <Kept p={view.persistence.setDebounceTime} />} />
                    <div className={cn("px-5 pb-5 pt-4", off(view.debounce.canSet && view.debounce.options.length > 0) && "pointer-events-none opacity-60")}>
                      {view.debounce.options.length ? (
                        <GlassRadio<string>
                          value={String(view.debounce.ms)}
                          onChange={(v) => run(`Debounce set to ${v} ms`, { kind: "debounce", ms: Number(v) })}
                          options={view.debounce.options.slice(0, 8).map((ms) => ({ value: String(ms), label: String(ms), hint: "ms" }))}
                        />
                      ) : (
                        <p className="tabular text-[15px] text-foreground">{view.debounce.ms === null ? "—" : `${view.debounce.ms} ms`}</p>
                      )}
                    </div>
                  </Card>
                )}
                {view.magnetic && (
                  <Card>
                    <CardHeader title="Magnetic buttons" hint="Where each click registers, and rapid trigger." right={view.magnetic.canTrigger && <Kept p={view.persistence.setMagneticTriggerPoint} />} />
                    <div className="grid grid-cols-2 gap-3 px-5 pb-5 pt-4">
                      {view.magnetic.status.buttons.slice(0, 2).map((b, i) => (
                        <MagneticButton
                          key={i}
                          label={i === 0 ? "Left click" : "Right click"}
                          button={b}
                          view={view.magnetic!}
                          disabled={busy || locked}
                          onTrigger={(point) => run(`${i === 0 ? "Left" : "Right"} click trigger point set`, { kind: "magneticTrigger", button: i as 0 | 1, point })}
                          onRapid={(enabled, level) => run(`${i === 0 ? "Left" : "Right"} click rapid trigger ${enabled ? "on" : "off"}`, { kind: "magneticRapid", button: i as 0 | 1, enabled, level })}
                        />
                      ))}
                    </div>
                    <p className="px-5 pb-4 text-[12px] text-muted-foreground">Where this mouse supports calibration, it's under Advanced.</p>
                  </Card>
                )}
              </>
            )}

            {tab === "controls" && view.lighting && (
              <Card>
                <CardHeader title="Lighting" hint="Effect and colour per lit zone." right={view.lighting.canSet && <Kept p={view.persistence.setLighting} />} />
                <div className="flex flex-col gap-1 px-5 pb-5 pt-3">
                  {view.lighting.zones.map((z) => (
                    <LightingZone key={z.zone} zone={z} disabled={off(view.lighting!.canSet)} onApply={(l) => run(`${z.zone}: ${l.mode ?? "lighting"}`, { kind: "lighting", lighting: l })} />
                  ))}
                </div>
              </Card>
            )}

            {tab === "advanced" && session.current && (
              <AdvancedCard
                id={`om.${id}`}
                panel={session.current.advanced}
                lockedReason={view.lockedReason}
                notify={notify}
                hold={(p) => track(K, p)}
                onChanged={() => void session.current?.refresh().then(show)}
              />
            )}
          </>
        )}
      </div>
    </DeviceFrame>
  );
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Where a change to this setting lives: on the mouse, until power-off, or not known. */
function Kept({ p }: { p: Persistence }) {
  return (
    <span
      title={p === "unknown" ? "SYNQ can't tell from this mouse's driver whether the mouse keeps this after it turns off." : undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ring-1",
        p === "saved" && "text-muted-foreground ring-white/[0.08]",
        p === "volatile" && "text-chart-3 ring-chart-3/25",
        p === "unknown" && "text-muted-foreground/80 ring-white/[0.06]",
      )}
    >
      <span className={cn("size-1 rounded-full", p === "saved" ? "bg-primary" : p === "volatile" ? "bg-chart-3" : "bg-white/30")} />
      {PERSISTENCE_LABEL[p]}
    </span>
  );
}

function AllowCard({ allowed, onChange }: { allowed: boolean; onChange: (on: boolean) => void }) {
  if (allowed)
    return (
      <div className="flex items-center gap-3 px-1 text-[12px] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" />
        Changes are allowed. A backup is saved before the first one, and each is read back after.
        <button onClick={() => onChange(false)} className="ml-auto text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Make read-only
        </button>
      </div>
    );
  return (
    <Card innerClassName="flex items-center gap-5 px-6 py-5">
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium text-foreground">Read-only until you allow changes</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
          SYNQ drives this mouse with OpenMouse's driver library. This model isn't marked tested yet, and SYNQ hasn't been tried on one. Everything below was read from your mouse.
          When you allow changes, SYNQ saves a backup first and reads every change back.
        </p>
      </div>
      <Switch checked={false} onCheckedChange={onChange} aria-label="Allow changes" />
    </Card>
  );
}

function LightingZone({ zone, disabled, onApply }: { zone: MouseLighting; disabled: boolean; onApply: (l: MouseLighting) => void }) {
  const [color, setColor] = useState(zone.color ?? "#ffffff");
  useEffect(() => setColor(zone.color ?? "#ffffff"), [zone.color]);
  const usesColor = !!zone.mode && zone.colorModes.includes(zone.mode);
  const pick = (mode: MouseLightingMode) => mode !== zone.mode && onApply({ ...zone, mode });
  return (
    <div className={cn("flex flex-wrap items-center gap-3 rounded-2xl px-1 py-2", disabled && "pointer-events-none opacity-60")}>
      <span className="w-20 shrink-0 text-[13px] text-foreground">{zone.zone}</span>
      <div className="flex flex-1 flex-wrap gap-1.5">
        {zone.modes.map((m) => (
          <button
            key={m}
            onClick={() => pick(m)}
            className={cn(
              "rounded-full px-3 py-1 text-[12px] ring-1 transition-colors duration-500 ease-fluid",
              m === zone.mode ? "bg-primary text-primary-foreground ring-primary" : "bg-white/[0.04] text-muted-foreground ring-white/[0.07] hover:bg-white/[0.08] hover:text-foreground",
            )}
          >
            {m}
          </button>
        ))}
      </div>
      {usesColor && (
        <div className="flex items-center gap-2">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label={`${zone.zone} colour`} className="size-8 cursor-pointer rounded-full bg-transparent" />
          {color.toLowerCase() !== (zone.color ?? "").toLowerCase() && (
            <button onClick={() => onApply({ ...zone, color })} className="rounded-full bg-foreground px-3 py-1 text-[12px] font-medium text-background">
              Apply
            </button>
          )}
        </div>
      )}
      {zone.writeOnly && <span className="w-full pl-[92px] text-[11.5px] text-muted-foreground">This zone can't report its effect, so what's shown is the last one sent.</span>}
    </div>
  );
}

function MagneticButton({
  label,
  button,
  view,
  disabled,
  onTrigger,
  onRapid,
}: {
  label: string;
  button: NonNullable<GenericView["magnetic"]>["status"]["buttons"][number];
  view: NonNullable<GenericView["magnetic"]>;
  disabled: boolean;
  onTrigger: (point: number) => void;
  onRapid: (enabled: boolean, level: number) => void;
}) {
  const range = view.status.triggerPointRange;
  const rapid = view.status.rapidTriggerRange;
  const [point, setPoint] = useState(button.triggerPoint ?? range.min);
  const [level, setLevel] = useState(button.rapidTrigger ?? rapid?.min ?? 0);
  useEffect(() => setPoint(button.triggerPoint ?? range.min), [button.triggerPoint, range.min]);
  useEffect(() => setLevel(button.rapidTrigger ?? rapid?.min ?? 0), [button.rapidTrigger, rapid?.min]);
  const step = (range.max - range.min) / 100;
  return (
    <div className={cn("flex flex-col gap-3 rounded-2xl bg-white/[0.025] px-4 py-3 ring-1 ring-white/[0.06]", disabled && "pointer-events-none opacity-60")}>
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] text-foreground">{label}</span>
        <span className="tabular text-[12.5px] text-muted-foreground">{button.triggerPoint === null ? "—" : `${+point.toFixed(2)}`} trigger</span>
      </div>
      <input type="range" aria-label={`${label} trigger point`} min={range.min} max={range.max} step={step} value={point} disabled={!view.canTrigger} onChange={(e) => setPoint(Number(e.target.value))} className="accent-[var(--primary)]" />
      {point !== button.triggerPoint && view.canTrigger && (
        <button onClick={() => onTrigger(point)} className="self-start rounded-full bg-foreground px-3 py-1 text-[12px] font-medium text-background">
          Apply trigger point
        </button>
      )}
      {rapid && view.canRapid && (
        <div className="flex items-center gap-3">
          <span className="text-[12.5px] text-muted-foreground">Rapid trigger</span>
          <input type="range" aria-label={`${label} rapid trigger sensitivity`} min={rapid.min} max={rapid.max} step={(rapid.max - rapid.min) / 100} value={level} onChange={(e) => setLevel(Number(e.target.value))} className="flex-1 accent-[var(--primary)]" />
          <Switch checked={button.rapidTriggerEnabled === true} onCheckedChange={(on) => onRapid(on, level)} aria-label={`${label} rapid trigger`} />
        </div>
      )}
      {rapid && view.canRapid && level !== button.rapidTrigger && button.rapidTriggerEnabled && (
        <button onClick={() => onRapid(true, level)} className="self-start rounded-full bg-foreground px-3 py-1 text-[12px] font-medium text-background">
          Apply rapid trigger
        </button>
      )}
    </div>
  );
}
