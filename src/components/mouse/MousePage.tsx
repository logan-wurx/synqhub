import { useCallback, useEffect, useState, type ReactNode } from "react";
import NumberFlow from "@number-flow/react";
import { Lightning, Plus } from "@phosphor-icons/react";
import { goHome, MOUSE_TABS_LEGACY, mouseId, useDeviceTab } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { isWeb, type Connected } from "@/lib/backend";
import { connectMouse, type Lod, type MouseSession, type MouseView } from "@/lib/mouse";
import { Card, CardHeader, Eyebrow, type Notice } from "@/components/ui/matte";
import { GlassRadio } from "@/components/uiverse";
import { deviceMouse, deviceMouseSuperlight2 } from "@/components/ui/brand";
import { isSuperlight2, publishDeviceName, usePublishedNames } from "@/lib/device-names";
import { forgetKept, peekKept, useKeptRef, useKeptScroll, useKeptState } from "@/lib/keep";
import { endSession, track, useSessionHold } from "@/lib/device-session";
import { genericHost } from "@/lib/generic-mice";
import { familyOf, mouseFamilies, sessionKeyOf } from "@/lib/mouse-family";
import { decideEarly, orderFamilies, type Answer } from "@/lib/mouse-order";
import { markAnswering, refreshMice, useMouseAnswers } from "@/lib/mouse-probe";
import { AtkMouse } from "./AtkMouse";
import { InfoAdvanced } from "@/components/advanced";
import { GenericMouse } from "./GenericMouse";
import { Banner, DpiPresets, EmptyCard, MouseSwitcher, StageEditor, hzText, rateLabel, type MouseFamily } from "./parts";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { MouseOverview } from "./overview";
import { BackButton, DeviceFrame, DeviceHeader, ReconnectButton, StatusPill, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";
import { BOOTLOADER_NOTE } from "@/lib/bootloader-ids";
import type { FeelDevice } from "@/components/feel/FeelPanel";
import { driveLogitech, type ApplyOutcome } from "@/lib/feel/drive";
import { feelStore } from "@/lib/feel/persist";
import type { Step } from "@/lib/feel/types";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
type Phase = { kind: "connecting" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "ready" };

/** The LIGHTSPEED receiver serves several models, so the Logitech label is the name the mouse reports once read. */
const FAMILY_LABEL: Record<string, string> = { logitech: "Logitech", atk: "X1 V2 Air+" };
/** The render that matches the model: the Superlight 2 has its own, the DEX uses the default. */
const logitechRender = (name: string | null | undefined) => (isSuperlight2(name) ? deviceMouseSuperlight2 : deviceMouse);

/**
 * Shows one mouse at a time: whichever is plugged in, or the one picked in the switcher when several
 * are. Only the panel on screen is mounted; its connection and any unsaved edit are kept (see
 * src/lib/keep.ts and src/lib/device-session.ts), so switching never drops either. A mouse that's
 * unplugged has its session closed and starts fresh when it's back. With none plugged in, a neutral
 * empty state.
 *
 * A receiver stays plugged in when its mouse is off, so with several mice listed the page first asks
 * each one for a quick read-only reply (src/lib/mouse-probe.ts, about a second at most) and opens on
 * the one that answers: the last one picked by hand if it answers, else the one on screen last time
 * if it answers, else the first that does. A mouse that doesn't answer goes last in the switcher,
 * marked "Off or asleep"; it can still be picked.
 */
const PICKED_KEY = "onboard.mouse";
/** The mouse picked by hand last time (only a click in the switcher writes this). */
const readPicked = (): MouseFamily | null => {
  try {
    const v = localStorage.getItem(PICKED_KEY);
    return v || null;
  } catch {
    return null;
  }
};

export function MousePage({ devices, notify, visible, family }: { devices: Connected[]; notify: Notify; visible: boolean; /** The mouse opened from the Devices home. */ family?: MouseFamily }) {
  // `picked` is the mouse on screen and outlives the page being closed; the explicit pick lives in localStorage.
  const [picked, setPickedState] = useKeptState<MouseFamily | null>("mouse.picked", readPicked);
  const setPicked = useCallback(
    (family: MouseFamily) => {
      setPickedState(family);
      try {
        localStorage.setItem(PICKED_KEY, family);
      } catch {
        // Storage can be unavailable; the pick then lasts for this session only.
      }
    },
    [setPickedState],
  );
  const published = usePublishedNames();
  const answers = useMouseAnswers();
  // Only what's plugged in: the hand-built panels first, then each mouse an OpenMouse driver claimed.
  const present = mouseFamilies(devices);
  const seen = useKeptRef<string[]>("mouse.seen", []);
  const presentKey = present.join();

  // The order of the switcher is settled once per visit, from who answered, and then stays put (a
  // mouse that wakes up while you look at the page changes its label, not its place).
  const [order, setOrder] = useState<MouseFamily[]>([]);
  const stable = [...order.filter((f) => present.includes(f)), ...present.filter((f) => !order.includes(f))];
  // With several mice listed when the page opens, nothing is shown until the check is in (a lone
  // mouse needs no check, and a second one plugged in later doesn't blank the page).
  const [decided, setDecided] = useState(present.length === 1 || !!family);
  useEffect(() => {
    if (decided) return;
    if (present.length === 1) return setDecided(true);
    if (present.length < 2) return;
    let alive = true;
    let done = false;
    const heard = new Map<MouseFamily, Answer>();
    // Decides as soon as the answers so far settle it: a mouse that answers at once (the one picked, or
    // the one on screen last time) doesn't wait for another that is off to run out its second.
    const decide = () => {
      if (!alive || done) return;
      const pick = decideEarly(present, heard, readPicked(), peekKept<MouseFamily | null>("mouse.picked", null));
      if (!pick) return;
      done = true;
      setOrder(orderFamilies(present, heard));
      setPickedState(pick);
      setDecided(true);
    };
    void refreshMice(devices, {
      onResult: (family, answer) => {
        heard.set(family, answer);
        decide();
      },
    }).then(decide);
    return () => {
      alive = false;
    };
    // presentKey stands in for `present`/`devices`, which are new arrays every render.
  }, [presentKey, decided]);

  // Stay on the mouse being shown when another one is plugged in; move only when it goes away.
  useEffect(() => {
    // A fallback, not a choice, so it isn't remembered.
    if (decided && present.length && (!picked || !present.includes(picked))) setPickedState(stable[0]);
    // A mouse that went away: close its session now and forget its panel, as unmounting the panel
    // used to, so it starts fresh when it's plugged back in.
    for (const family of new Set(["logitech", "atk", ...seen.current])) {
      if (present.includes(family)) continue;
      const k = sessionKeyOf(family);
      endSession(k);
      forgetKept(`${k}.`);
    }
    seen.current = present;
    // presentKey stands in for `present`, which is a new array every render.
  }, [presentKey, picked, decided]);
  // A mouse or receiver in firmware-update mode is never opened; it is only named here.
  const updating = devices.filter((d) => d.kind === "mouse" && d.bootloader);
  const note = updating.length ? <Banner>{updating.map((d) => d.name).join(", ")}: {BOOTLOADER_NOTE}</Banner> : null;
  if (!present.length || (family && !present.includes(family))) {
    return (
      <div className="flex h-full flex-col gap-5 overflow-y-auto px-8 pb-10 pt-5 [&>*]:shrink-0">
        <header>
          <BackButton onClick={goHome}>Gear</BackButton>
          <div className="mt-5">
            <Eyebrow>Not connected</Eyebrow>
          </div>
          <h1 className="mt-3 text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] text-foreground">Mouse</h1>
          <p className="mt-2 text-[13.5px] text-muted-foreground">{family ? "This mouse isn't plugged in any more." : isWeb ? "SYNQ shows the mouse you added in this browser." : "SYNQ shows the mouse that's plugged into this PC."}</p>
        </header>
        {note}
        <EmptyCard title="Plug in your mouse" text="Connect its receiver or cable. SYNQ finds it as soon as it's there." plug />
      </div>
    );
  }
  if (!decided) {
    return (
      <div className="flex h-full flex-col gap-5 overflow-y-auto px-8 pb-10 pt-7 [&>*]:shrink-0">
        <header>
          <Eyebrow>Connecting</Eyebrow>
          <h1 className="mt-3 text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] text-foreground">Mouse</h1>
          <p className="mt-2 text-[13.5px] text-muted-foreground">{present.length} mice are plugged in.</p>
        </header>
        <EmptyCard title="Looking for your mouse…" text="Checking which one is on. This takes a second." />
      </div>
    );
  }
  const shown: MouseFamily = family && present.includes(family) ? family : picked && present.includes(picked) ? picked : stable[0];
  const label = (id: MouseFamily) => {
    if (id === "logitech") return published.get("logitech") ?? FAMILY_LABEL.logitech;
    if (!id.startsWith("om:")) return FAMILY_LABEL[id] ?? id;
    const d = devices.find((x) => familyOf(x) === id);
    return (d?.name ?? "Mouse").replace(/\s+(4K|8K)?\s*(Dongle|Receiver)$/i, "");
  };
  // Opened from the Devices home, a mouse needs no switcher: the home is the switcher.
  const artOf = (id: MouseFamily) => {
    const d = id.startsWith("om:") ? devices.find((x) => familyOf(x) === id) : undefined;
    return { kind: "mouse" as const, family: id, name: label(id), brand: d?.brand, vid: d?.vid, pid: d?.pid };
  };
  const switcher =
    present.length > 1 && !family ? <MouseSwitcher options={stable.map((id) => ({ id, label: label(id), quiet: answers.get(id) === "quiet", art: artOf(id) }))} value={shown} onChange={setPicked} /> : null;
  if (note)
    return (
      <div className="flex h-full flex-col">
        <div className="px-8 pt-5">{note}</div>
        <div className="min-h-0 flex-1">{panelFor(shown)}</div>
      </div>
    );
  return <div className="h-full">{panelFor(shown)}</div>;

  function panelFor(shown: MouseFamily) {
    return (
      <>
      {shown === "logitech" ? (
        <LogitechMouse devices={devices} notify={notify} visible={visible} switcher={switcher} />
      ) : shown === "atk" ? (
        <AtkMouse devices={devices} notify={notify} visible={visible} switcher={switcher} />
      ) : (
        // Keyed by mouse, so each one has its own panel state.
        <GenericMouse key={shown} id={shown.slice(3)} devices={devices} getHost={genericHost} notify={notify} visible={visible} switcher={switcher} />
      )}
      </>
    );
  }
}

/** Kept-state names of the Logitech panel (see src/lib/keep.ts). */
const LOGI = "mouse.logitech";
type Draft = { stages: number[]; defaultStage: number };
const isDirty = (view: MouseView | null, draft: Draft | null) =>
  !!view && !!draft && (draft.defaultStage !== view.defaultStage || draft.stages.join() !== view.stages.join());

function LogitechMouse({ devices, notify, visible, switcher }: { devices: Connected[]; notify: Notify; visible: boolean; switcher: ReactNode }) {
  const session = useKeptRef<MouseSession | null>(`${LOGI}.session`, null);
  const [phase, setPhase] = useKeptState<Phase>(`${LOGI}.phase`, { kind: "connecting" });
  const [view, setView] = useKeptState<MouseView | null>(`${LOGI}.view`, null);
  const [draft, setDraft] = useKeptState<Draft | null>(`${LOGI}.draft`, null);
  const [busy, setBusy] = useKeptState(`${LOGI}.busy`, false);
  /** The connect in flight, and why the last quiet one failed (see `quiet` below). */
  const connecting = useKeptRef<Promise<boolean> | null>(`${LOGI}.connecting`, null);
  const quietError = useKeptRef<string | null>(`${LOGI}.quietError`, null);
  // Connected, so the switcher doesn't call it "Off or asleep" (src/lib/mouse-probe.ts).
  useEffect(() => {
    if (phase.kind === "ready") markAnswering("logitech");
  }, [phase.kind]);

  // Reconnect whenever the way the mouse is attached changes (cable <-> receiver).
  const attachKey = devices.filter((d) => d.kind === "mouse" && d.vid === "046d").map((d) => d.pid).sort().join(",");

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
          const s = await connectMouse();
          if (!s) {
            if (quiet) quietError.current = "The mouse isn't plugged in. Connect the LIGHTSPEED receiver or the cable, and close G HUB if it's open.";
            else setPhase({ kind: "missing" });
            return false;
          }
          session.current = s;
          quietError.current = null;
          setView(s.view);
          setDraft({ stages: s.view.stages, defaultStage: s.view.defaultStage });
          setPhase({ kind: "ready" });
          // The model name comes from the mouse (HID++ device name); the receiver alone can't tell.
          publishDeviceName("logitech", s.view.name || null);
          return true;
        } catch (e) {
          const raw = String(e).replace(/^Error: /, "");
          const message = /timeout|no reply|did not answer/i.test(raw) ? "The mouse didn't answer. Wiggle it to wake it up, then try again." : raw;
          if (quiet) quietError.current = message;
          else setPhase({ kind: "error", message });
          return false;
        }
      })();
      connecting.current = work;
      void work.finally(() => {
        if (connecting.current === work) connecting.current = null;
      });
      return track(LOGI, work);
    },
    [setPhase, setView, setDraft, session, connecting, quietError],
  );

  // Connect the first time the page is shown, and again only when the attachment changes.
  const connectedFor = useKeptRef<string | null>(`${LOGI}.connectedFor`, null);
  const resumeFor = useKeptRef<string | null>(`${LOGI}.resumeFor`, null);
  useEffect(() => {
    if (!visible || connectedFor.current === attachKey) return;
    const quiet = resumeFor.current === attachKey;
    resumeFor.current = null;
    connectedFor.current = attachKey;
    void connect(quiet).then((ok) => {
      // Try again quietly the next time the panel is shown.
      if (!ok && quiet && connectedFor.current === attachKey) {
        connectedFor.current = null;
        resumeFor.current = attachKey;
      }
    });
  }, [attachKey, visible, connect, connectedFor, resumeFor]);

  // The session stays open while the panel is away and closes after a short idle; unsaved DPI
  // steps keep it open.
  useSessionHold(
    LOGI,
    async () => {
      const s = session.current;
      if (!s) return;
      session.current = null;
      resumeFor.current = connectedFor.current;
      connectedFor.current = null;
      await s.close();
    },
    () => !isDirty(peekKept<MouseView | null>(`${LOGI}.view`, null), peekKept<Draft | null>(`${LOGI}.draft`, null)),
  );

  const run = async (label: string, action: (s: MouseSession) => Promise<MouseView>) => {
    if (busy) return;
    if (!session.current && phase.kind === "ready") {
      // Reopening after the idle close: wait for it (or start it), and report why if it can't.
      await (connecting.current ?? connect(true));
      if (!session.current) {
        notify({ title: "Not saved", detail: quietError.current ?? "The mouse didn't answer.", tone: "error" }, "mouse");
        return;
      }
    }
    const s = session.current;
    if (!s) return;
    setBusy(true);
    try {
      const v = await track(LOGI, action(s));
      setView(v);
      setDraft({ stages: v.stages, defaultStage: v.defaultStage });
      notify({ title: label, detail: "Saved to the mouse's memory", tone: "ok" }, "mouse");
      void feelStore.noteConfigured("mouse", mouseId("logitech"));
    } catch (e) {
      notify({ title: "Not saved", detail: String(e).replace(/^Error: /, ""), tone: "error" }, "mouse");
    } finally {
      setBusy(false);
    }
  };

  /** "Keep your feel": a plan's steps through this same session (one backup first, each change checked). */
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
      const r = await track(
        LOGI,
        driveLogitech(s, steps, (v) => {
          setView(v);
          setDraft({ stages: v.stages, defaultStage: v.defaultStage });
        }),
      );
      if (r.done) void feelStore.noteConfigured("mouse", mouseId("logitech"));
      return r;
    } finally {
      setBusy(false);
    }
  };

  const dirty = isDirty(view, draft);
  const caps = view?.caps;
  const wide = useWide();
  const asideOn = wide && phase.kind === "ready" && !!view;
  const tabs: TabDef[] = [
    ...(asideOn ? [] : [{ id: "overview", label: "Overview" }]),
    ...(asideOn ? [] : [{ id: "sensitivity", label: "Sensitivity" }]),
    { id: "controls", label: asideOn ? "Settings" : "Controls" },
    { id: "advanced", label: "Advanced" },
  ];
  const [tab, setTab] = useDeviceTab(mouseId("logitech"), tabs.map((t) => t.id), MOUSE_TABS_LEGACY);
  const body = useKeptScroll(`${LOGI}.scroll.${tab}`);
  const ready = phase.kind === "ready" && view && draft;
  const name = view?.name ?? devices.find((d) => d.kind === "mouse" && d.vid === "046d")?.name ?? "Logitech mouse";

  const feel: FeelDevice | undefined = view
    ? {
        id: mouseId("logitech"),
        kind: "mouse",
        family: "logitech",
        name: view.name || "Logitech mouse",
        brand: "Logitech",
        view,
        notify,
        apply: applyFeel,
        gate: {
          writable: view.writable && view.mode !== "Host",
          reason: !view.writable
            ? "This mouse's memory layout isn't confirmed yet, so SYNQ shows its settings without changing them."
            : view.mode === "Host"
              ? "The mouse is in host mode, so some other app's settings are running. Switch it back to its own memory first."
              : null,
        },
      }
    : undefined;

  const overview = phase.kind === "ready" && !!view ? (
              <MouseOverview
                feel={feel}
                art={<DeviceArt spec={{ kind: "mouse", family: "logitech", name: view.name ?? "" }} />}
                link={view.connection}
                name={view.name}
                detail={`${view.connectionDetail}. What the mouse reports right now is below.`}
                stats={[
                  { label: "DPI", value: view.dpi },
                  { label: "Polling", value: hzText(view.pollingHz) },
                  { label: "Lift-off", value: view.lod ?? "—" },
                  { label: "Battery", value: view.batteryPercent === null ? "—" : `${view.batteryPercent}%`, note: view.batteryState === "Unknown" ? undefined : view.batteryState },
                ]}
                battery={{
                  show: true,
                  percent: view.batteryPercent,
                  charging: /charg/i.test(view.batteryState),
                  state: view.batteryState === "Unknown" ? "—" : view.batteryState,
                  title: "Battery",
                  rows: [
                    ["Firmware", <span className="tabular block max-w-[240px] truncate text-[12px]" title={view.firmware.join(", ")}>{view.firmware.join(" · ") || "—"}</span>],
                    ["Memory", view.mode === "Onboard" ? "Onboard" : view.mode],
                  ],
                }}
              />
  ) : null;

  return (
    <DeviceFrame
      aside={overview}
      header={
      <DeviceHeader
        id={mouseId("logitech")}
        name={view?.name ?? "Mouse"}
        subtitle={view && phase.kind === "ready" ? "Changes are saved to the mouse itself, so they work on cable and wireless." : name}
        pills={
          <>
            <StatusPill live={phase.kind === "ready"}>
              {phase.kind === "ready" && view
                ? `${view.connection === "Wired" ? "Cable" : "Wireless"} · ${view.connectionDetail}`
                : phase.kind === "connecting"
                  ? "Connecting"
                  : "Not connected"}
            </StatusPill>
            {ready && (
              <TierBadge
                tier={view.writable ? "verified" : "read-only"}
                hint={view.writable ? undefined : "This mouse's memory layout isn't confirmed yet, so SYNQ shows its settings without changing them."}
              />
            )}
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
        {phase.kind === "connecting" && <EmptyCard title="Looking for your mouse…" text="This takes a second." image={logitechRender(view?.name)} />}
        {phase.kind === "missing" && (
          <EmptyCard title="Plug it in" text="Connect the LIGHTSPEED receiver or the cable, and close G HUB if it's open." plug />
        )}
        {phase.kind === "error" && <EmptyCard title="Couldn't talk to the mouse" text={phase.message} plug />}

        {ready && (
          <>
            {view.mode === "Host" && (
              <Banner>
                The mouse is in host mode, so some other app's settings are running and your saved ones are ignored. Switch it back to its own memory.
                <button
                  disabled={busy}
                  onClick={() => run("Back on the mouse's memory", (s) => s.useOnboard())}
                  className="ml-3 rounded-full bg-chart-3 px-3 py-1 text-[12px] font-medium text-black"
                >
                  Use onboard memory
                </button>
              </Banner>
            )}
            {view.writable && view.mode === "Onboard" && view.stages.length > 0 && view.dpi !== view.stages[view.defaultStage] && (
              <Banner>
                The mouse is running {view.dpi} DPI, but its starred step is {view.stages[view.defaultStage]} DPI.
                <button
                  disabled={busy}
                  onClick={() => run("Saved settings applied", (s) => s.applySaved())}
                  className="ml-3 rounded-full bg-chart-3 px-3 py-1 text-[12px] font-medium text-black"
                >
                  Apply now
                </button>
              </Banner>
            )}
            {!view.writable && view.mode !== "Host" && (
              <Banner>This mouse's memory layout isn't confirmed yet, so SYNQ shows its settings without changing them.</Banner>
            )}

            {tab === "overview" && overview}

            {(tab === "sensitivity" || (asideOn && tab === "controls")) && (
              <>
                <Card innerClassName="relative overflow-hidden px-6 pb-6 pt-5">
                  <p className="text-[13px] text-muted-foreground">Sensitivity</p>
                  <div className="mt-3 flex items-baseline gap-3">
                    <NumberFlow
                      value={view.dpi}
                      className="tabular text-[86px] font-medium leading-none tracking-[-0.06em] text-foreground [text-shadow:0_0_28px_color-mix(in_srgb,var(--primary)_30%,transparent)]"
                    />
                    <span className="text-[18px] text-muted-foreground">DPI</span>
                  </div>
                  <DpiPresets value={view.dpi} disabled={busy || !view.writable} onPick={(dpi) => run(`Now running ${dpi} DPI`, (s) => s.setActiveDpi(dpi))} />
                </Card>

                <Card>
                  <CardHeader
                    title="DPI steps"
                    hint="The mouse runs the starred step. Extra steps only matter if a button is set to cycle DPI; Logitech's PRO mice have no DPI button by default."
                    right={
                      <button
                        disabled={!dirty || busy || !view.writable}
                        onClick={() => run("DPI steps saved", (s) => s.saveStages(draft.stages, draft.defaultStage))}
                        className="group flex h-9 items-center gap-2 rounded-full bg-foreground pl-4 pr-1.5 text-[13px] font-medium text-background transition-all duration-300 ease-fluid active:scale-[0.98] disabled:bg-white/[0.06] disabled:text-muted-foreground"
                      >
                        {busy ? "Saving…" : dirty ? "Save to mouse" : "Saved"}
                        <span className="grid size-6 place-items-center rounded-full bg-black/10 transition-transform duration-500 ease-fluid group-hover:translate-x-0.5">
                          <Lightning size={12} weight="fill" />
                        </span>
                      </button>
                    }
                  />
                  <div className="flex flex-wrap items-stretch gap-3 px-5 pb-5 pt-4">
                    {draft.stages.map((dpi, i) => (
                      <StageEditor
                        key={i}
                        index={i}
                        value={dpi}
                        isDefault={i === draft.defaultStage}
                        step={caps?.stepDpi ?? 50}
                        min={caps?.minDpi ?? 100}
                        max={caps?.maxDpi ?? 44000}
                        disabled={!view.writable}
                        onChange={(v) => setDraft({ ...draft, stages: draft.stages.map((x, j) => (j === i ? v : x)) })}
                        onDefault={() => setDraft({ ...draft, defaultStage: i })}
                        onRemove={
                          draft.stages.length > 1
                            ? () =>
                                setDraft({
                                  stages: draft.stages.filter((_, j) => j !== i),
                                  defaultStage: Math.min(draft.defaultStage > i ? draft.defaultStage - 1 : draft.defaultStage, draft.stages.length - 2),
                                })
                            : undefined
                        }
                      />
                    ))}
                    {view.writable && draft.stages.length < (caps?.maxStages ?? 5) && (
                      <button
                        onClick={() => setDraft({ ...draft, stages: [...draft.stages, Math.min((draft.stages[draft.stages.length - 1] ?? 800) * 2, caps?.maxDpi ?? 44000)] })}
                        className="flex w-[118px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/10 text-[12.5px] text-muted-foreground transition-colors hover:bg-white/[0.03] hover:text-foreground"
                      >
                        <Plus size={16} weight="light" /> Add step
                      </button>
                    )}
                  </div>
                </Card>
              </>
            )}

            {tab === "controls" && (
              <div className="grid grid-cols-[1.45fr_1fr] gap-5">
                <Card>
                  <CardHeader
                    title="Polling rate"
                    hint={`Wireless rate. Saved for cable too${view.pollingWiredHz && view.pollingWiredHz !== view.pollingHz ? ` (cable is ${rateLabel(view.pollingWiredHz)} Hz now)` : ""}.`}
                  />
                  <div className="px-5 pb-5 pt-4">
                    <GlassRadio<string>
                      value={String(view.pollingHz)}
                      onChange={(v) => run(`Polling rate set to ${rateLabel(Number(v))} Hz`, (s) => s.setPolling(Number(v)))}
                      options={view.pollingOptions.map((hz) => ({ value: String(hz), label: rateLabel(hz), hint: "Hz" }))}
                    />
                  </div>
                </Card>
                <Card>
                  <CardHeader title="Lift-off distance" hint="How high you can lift before it stops tracking." />
                  <div className="px-5 pb-5 pt-4">
                    {view.lods.length > 0 && view.lod ? (
                      <GlassRadio<Lod>
                        value={view.lod}
                        onChange={(v) => run(`Lift-off set to ${v.toLowerCase()}`, (s) => s.setLod(v))}
                        options={view.lods.map((l) => ({ value: l, label: l }))}
                      />
                    ) : (
                      <p className="py-2 text-[13px] text-muted-foreground">Not adjustable on this mouse.</p>
                    )}
                  </div>
                </Card>
              </div>
            )}

            {tab === "advanced" && (
              <InfoAdvanced
                id="logitech"
                deviceName={view.name}
                kind="mouse"
                brand="Logitech"
                firmware={view.firmware.filter((f) => !/^(BL|BOT)/i.test(f))}
                why="Logitech's pairing, button and profile commands aren't part of SYNQ's checked command set for the DEX yet, so they stay in G HUB."
                notify={notify}
              />
            )}
          </>
        )}
      </div>
    </DeviceFrame>
  );
}
