// MAGIC-REFINER X68 HE panel: what illumipc.com's configurator does well (actuation and rapid
// trigger per key, SOCD and advanced keys, remaps on both layers, profiles, polling, lighting), in
// SYNQ's look. Everything shown was read from the keyboard; changes are off until the user allows
// them, are backed up first and read back after. See src/lib/x68he.ts.
import { InfoAdvanced } from "@/components/advanced";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { peekKept, peekKeptRef, useKeptDraft, useKeptRef, useKeptScroll, useKeptState } from "@/lib/keep";
import { sharePage, type Session } from "@/lib/profiles/live";
import { track, useSessionHold } from "@/lib/device-session";
import NumberFlow from "@number-flow/react";
import { ArrowRight, ArrowUDownLeft, ArrowsDownUp, ArrowsLeftRight, DownloadSimple, Hourglass, Stack, ToggleLeft } from "@phosphor-icons/react";
import { cn, hzText } from "@/lib/utils";
import type { Connected } from "@/lib/backend";
import * as P from "@/lib/x68he-protocol";
import type { X68Key } from "@/lib/x68he-layout";
import { isIllumipcHex } from "@/lib/illumipc/ids";
import { connectX68, type X68Session, type X68State, type X68View } from "@/lib/x68he";
import { Card, CardHeader, type Notice } from "@/components/ui/matte";
import { DeviceFrame, DeviceHeader, OverviewStrip, ReconnectButton, StatusPill, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";
import { KeyBoard, MmSlider, ModeSwitch, SelectionBar, type MapKey, type MapLayout } from "@/components/devices/keymap";
import { AdvancedKeysFlow, MULTI_ACTION_LEGALITY, SOCD_LEGALITY, TOGGLE_LEGALITY, type ActiveKey, type AdvFlow, type AdvType } from "@/components/devices/advkeys";
import { keyboardId, KEYBOARD_TABS_LEGACY, useDeviceTab } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { GlassRadio } from "@/components/uiverse";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { deviceKeyboardX68 } from "@/components/ui/brand";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { Banner, Chip, EmptyCard, Pill, Select, SwitchRow } from "./parts";
import { FeelCard, FeelOffer, type FeelDevice } from "@/components/feel/FeelPanel";
import { driveX68, type ApplyOutcome } from "@/lib/feel/drive";
import { feelStore } from "@/lib/feel/persist";
import type { Step } from "@/lib/feel/types";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
type Phase = { kind: "connecting"; step: string } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "ready" };
type Mode = "actuation" | "rapid" | "remap" | "fn";
type Run = (label: string, op: (s: X68Session) => Promise<string>) => void;

const errText = (e: unknown) => String(e).replace(/^Error: /, "");
/** Kept-state names of this panel (see src/lib/keep.ts); it unmounts while another page is shown. */
const X68 = "keyboard.x68";
const RT_MODES: readonly number[] = [P.TRIGGER_MODE.rapidLegacy, P.TRIGGER_MODE.rapid, P.TRIGGER_MODE.rapidSplit];
const isRt = (k?: P.KeyTrigger) => !!k && RT_MODES.includes(k.mode);
const sameAction = (a: P.RawAction, b: P.RawAction) => a.every((v, i) => v === b[i]);

function mostCommon(values: number[], fallback: number): number {
  const count = new Map<number, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  let best = fallback;
  let n = 0;
  for (const [v, c] of count) if (c > n) [best, n] = [v, c];
  return best;
}

/** Unit helpers for one keyboard: travel units <-> mm. */
function units(st: X68State) {
  const unit = st.trigger?.unitMm ?? 0.1;
  const decimals = unit < 0.1 ? 2 : 1;
  return {
    unit,
    decimals,
    mm: (u: number) => (u * unit).toFixed(decimals),
    toUnits: (mm: number) => Math.round(mm / unit),
  };
}

const keyName = (st: X68State, index: number) => {
  const k = st.layout.keys.find((x) => x.index === index);
  if (!k) return `#${index}`;
  return k.label || (k.index === 116 ? "Space" : `#${index}`);
};
const names = (st: X68State, keys: number[]) => keys.map((k) => keyName(st, k)).join(", ");
const hidName = (st: X68State, hid: number) => st.layout.keys.find((k) => k.factory[0] === 0 && k.factory[1] === hid)?.label || P.HID_NAMES[hid] || `0x${hid.toString(16)}`;
const actionOf = (st: X68State, layer: P.Layer, index: number): P.RawAction => P.actionAt(Uint8Array.from(st.keymap![layer]), index);

// A game profile (src/lib/profiles/live.ts) goes on through this panel's session while it has one open, and shows here.
sharePage((family) =>
  family === "x68"
    ? {
        session: () => peekKeptRef<Session>(`${X68}.session`),
        busy: () => !!peekKept<X68View | null>(`${X68}.view`, null)?.busy,
      }
    : null,
);

export function X68Panel({ devices, notify, visible, switcher }: { devices: Connected[]; notify: Notify; visible: boolean; switcher: ReactNode }) {
  const session = useKeptRef<X68Session | null>(`${X68}.session`, null);
  const unsubscribe = useKeptRef<(() => void) | null>(`${X68}.unsubscribe`, null);
  const first = useKeptRef<X68State | null>(`${X68}.first`, null);
  const [phase, setPhase] = useKeptState<Phase>(`${X68}.phase`, { kind: "connecting", step: "Looking for the keyboard" });
  const [view, setView] = useKeptState<X68View | null>(`${X68}.view`, null);
  const [layer, setLayer] = useKeptState<P.Layer>(`${X68}.layer`, "default");
  const [selected, setSelected] = useKeptState<number[]>(`${X68}.selected`, []);
  const mapRef = useRef<HTMLDivElement>(null);
  /** The connect in flight, and why the last quiet one failed (see `quiet` below). */
  const connecting = useKeptRef<Promise<boolean> | null>(`${X68}.connecting`, null);
  const quietError = useKeptRef<string | null>(`${X68}.quietError`, null);
  const detected = devices.find((d) => isIllumipcHex(d.vid, d.pid));
  const attachKey = detected ? `${detected.vid}:${detected.pid}` : "";

  const drop = async () => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    const s = session.current;
    session.current = null;
    await s?.close().catch(() => undefined);
  };

  /**
   * `quiet`: reopening after the idle close (src/lib/device-session.ts). The last view stays on
   * screen while it reads the keyboard again, and if it doesn't answer the panel stays as it was,
   * with the error kept for the next change, as an open session that lost the keyboard would behave.
   */
  const connect = useCallback(
    (quiet = false): Promise<boolean> => {
      const work = (async () => {
        if (!quiet) setPhase({ kind: "connecting", step: "Looking for the keyboard" });
        await drop();
        try {
          const s = await connectX68((step) => !quiet && setPhase({ kind: "connecting", step }));
          if (!s) {
            if (quiet) quietError.current = "The keyboard isn't plugged in. Connect it with its USB cable.";
            else setPhase({ kind: "missing" });
            return false;
          }
          session.current = s;
          quietError.current = null;
          first.current ??= s.view.state;
          unsubscribe.current = s.subscribe(setView);
          setView(s.view);
          setPhase({ kind: "ready" });
          return true;
        } catch (e) {
          const message = errText(e);
          const text = /no answer/i.test(message) ? "The keyboard didn't answer. Close illumipc.com in your browser, unplug the keyboard, plug it back in, then press Reconnect." : message;
          if (quiet) quietError.current = text;
          else setPhase({ kind: "error", message: text });
          return false;
        }
      })();
      connecting.current = work;
      void work.finally(() => {
        if (connecting.current === work) connecting.current = null;
      });
      return track(X68, work);
    },
    // drop only reads kept refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setPhase, setView],
  );

  const connectedFor = useKeptRef<string | null>(`${X68}.connectedFor`, null);
  const resumeFor = useKeptRef<string | null>(`${X68}.resumeFor`, null);
  useEffect(() => {
    if (!visible || !attachKey || connectedFor.current === attachKey) return;
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

  // The session stays open while the panel is away (a change in flight still finishes) and closes
  // after a short idle.
  useSessionHold(X68, async () => {
    if (!session.current) return;
    resumeFor.current = connectedFor.current;
    connectedFor.current = null;
    await drop();
  });

  /** The open session, reopening it first after the idle close; null (with a notice) if it can't. */
  const liveSession = async (): Promise<X68Session | null> => {
    if (!session.current && phase.kind === "ready") {
      await (connecting.current ?? connect(true));
      if (!session.current) {
        notify({ title: "Not saved", detail: quietError.current ?? "The keyboard didn't answer.", tone: "error" }, "x68");
        return null;
      }
    }
    return session.current;
  };
  const liveRef = useRef(liveSession);
  liveRef.current = liveSession;

  const run: Run = useCallback(
    (label, op) => {
      const go = (s: X68Session) =>
        track(X68, op(s)).then(
          (detail) => {
            notify({ title: label, detail, tone: "ok" }, "x68");
            void feelStore.noteConfigured("keyboard", keyboardId("x68"));
          },
          (e) => notify({ title: "Not saved", detail: errText(e), tone: "error" }, "x68"),
        );
      const s = session.current;
      if (s) go(s);
      else void liveRef.current().then((r) => r && go(r));
    },
    [notify, session],
  );

  const exportDiagnostics = () => {
    const s = session.current;
    if (!s) return;
    track(X68, s.exportDiagnostics()).then(
      (path) => notify({ title: "Diagnostics saved", detail: path, tone: "ok" }, "x68-diag"),
      (e) => notify({ title: "Couldn't save diagnostics", detail: errText(e), tone: "error" }, "x68-diag"),
    );
  };

  const st = view?.state;
  const live = phase.kind === "ready" && view && st;
  const canWrite = !!view && view.writable && view.writesEnabled && view.link === "ok" && !view.busy;

  /** "Keep your feel": a plan's steps through this same session (it backs up first and reads each change back). */
  const applyFeel = async (steps: Step[]): Promise<ApplyOutcome<unknown>> => {
    const stop = (error: string): ApplyOutcome<unknown> => ({ ok: false, done: 0, total: steps.length, error, view: null });
    if (!session.current && phase.kind === "ready") {
      await (connecting.current ?? connect(true));
      if (!session.current) return stop(quietError.current ?? "The keyboard didn't answer.");
    }
    const s = session.current;
    if (!s) return stop("The keyboard isn't connected.");
    const r = await track(X68, driveX68(s, s.view.state, steps));
    if (r.done) void feelStore.noteConfigured("keyboard", keyboardId("x68"));
    return r;
  };
  const feel: FeelDevice | undefined = live
    ? {
        id: keyboardId("x68"),
        kind: "keyboard",
        family: "x68",
        name: st?.info.model ?? "X68 HE",
        brand: st?.info.brand || "MAGIC-REFINER",
        view,
        notify,
        apply: applyFeel,
        gate: {
          writable: canWrite,
          reason: !view.writable
            ? (view.readOnlyReason ?? "SYNQ couldn't read this board completely, so it only shows its settings.")
            : !view.writesEnabled
              ? "Read-only until you allow changes."
              : view.link !== "ok"
                ? "The keyboard is reconnecting. Try again in a moment."
                : "The keyboard is busy. Try again in a moment.",
          allow: view.writable ? { on: view.writesEnabled, set: (on) => (session.current ? session.current.setWritesEnabled(on) : void liveSession().then((r) => r?.setWritesEnabled(on))) } : undefined,
        },
      }
    : undefined;

  const wide = useWide();
  const asideOn = wide && live;
  const tabs: TabDef[] = [
    ...(asideOn ? [] : [{ id: "overview", label: "Overview" }]),
    ...(st?.keymap && (st.advanced || st.socd) ? [{ id: "advkeys", label: "Advanced Keys" }] : []),
    ...(st?.keymap || st?.light || (st && st.profile !== null) ? [{ id: "remap", label: "Remap & Lighting" }] : []),
    { id: "advanced", label: "Advanced" },
  ];
  const [tab, pickTab] = useDeviceTab(keyboardId("x68"), tabs.map((t) => t.id), KEYBOARD_TABS_LEGACY);
  const goTab = (t: string) => {
    setSelected([]);
    pickTab(t);
  };
  const body = useKeptScroll(`${X68}.scroll.${tab}`);
  const [keysMode, setKeysMode] = useKeptState<"actuation" | "rapid">(`${X68}.keysMode`, "actuation");
  const mode: Mode = tab === "overview" ? keysMode : tab === "remap" ? (layer === "fn" ? "fn" : "remap") : "actuation";

  const mapLayout = useMemo<MapLayout | null>(() => {
    if (!st) return null;
    const marks = marksFor(mode, st);
    return {
      width: st.layout.units.w,
      height: st.layout.units.h,
      keys: st.layout.keys.map((k) => ({
        id: k.index,
        x: k.x,
        y: k.y,
        w: k.w,
        h: k.h,
        label: k.label || (k.index === 116 ? "" : "?"),
        locked: k.locked || ((mode === "actuation" || mode === "rapid") && !st.keys[k.index]),
        title: keyName(st, k.index),
        mark: marks.get(k.index) as MapKey["mark"],
      })),
    };
  }, [st, mode]);
  const keysSwitch = (
    <ModeSwitch
      label="Key map shows"
      value={keysMode}
      onChange={(m) => {
        setKeysMode(m);
        setSelected([]);
      }}
      options={[
        { id: "actuation", label: "Actuation" },
        { id: "rapid", label: "Rapid trigger" },
      ]}
    />
  );
  const focusMap = () => mapRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });

  const mapCard = (title: string, hint: string, inspector: ReactNode, opts: { multi?: boolean; right?: ReactNode } = {}) =>
    mapLayout && (
      <div ref={mapRef}>
        <Card>
          <CardHeader title={title} hint={hint} right={opts.right} />
          <div className="px-5 pb-5 pt-4">
            <KeyBoard layout={mapLayout} selected={selected} onSelect={setSelected} multi={opts.multi ?? true} label={title} />
            <SelectionBar
              count={selected.length}
              names={st ? names(st, selected) : ""}
              onSelectAll={opts.multi === false ? undefined : () => setSelected(mapLayout.keys.filter((k) => !k.locked).map((k) => k.id))}
              onDiscard={() => setSelected([])}
            >
              {inspector}
            </SelectionBar>
          </div>
        </Card>
      </div>
    );

  const overview = live ? (
<X68Overview st={st} view={view} feel={feel} />
  ) : null;

  return (
    <DeviceFrame
      aside={overview}
      header={
      <DeviceHeader
        id={keyboardId("x68")}
        name={live ? st.info.model : (detected?.name ?? "X68 HE")}
        subtitle={live ? `${st.info.brand ? `${st.info.brand} · ` : ""}${st.layout.name}` : (detected?.name ?? "MAGIC-REFINER X68 HE")}
        pills={
          <>
            <StatusPill live={!!live}>
              {live
                ? view.link !== "ok"
                  ? "Reconnecting"
                  : view.busy
                    ? view.busy
                    : `USB${st.profile !== null ? ` · ${st.profile === 0 ? "Default profile" : `Profile ${st.profile}`}` : ""}${view.writable && view.writesEnabled ? "" : " · Read-only"}`
                : phase.kind === "connecting"
                  ? phase.step
                  : "Not connected"}
            </StatusPill>
            {live && <TierBadge tier={view.writable ? "driver-tested" : "read-only"} hint={view.readOnlyReason ?? "Built from the maker's own configurator. Changes stay off until you allow them."} />}
          </>
        }
        actions={
          <>
            {switcher}
            {live && <HeaderButton onClick={exportDiagnostics} label="Save diagnostics" icon={<DownloadSimple size={12} />} />}
            <ReconnectButton onClick={() => void connect()} />
          </>
        }
        tabs={tabs}
        tab={tab}
        onTab={goTab}
      />
      }
    >
      <div key={tab} ref={body} className={TAB_BODY} tabIndex={0}>
        {phase.kind === "connecting" && <EmptyCard title="Reading the keyboard…" text={`${phase.step}. Nothing is changed while SYNQ reads.`} image={deviceKeyboardX68} pulse />}
        {phase.kind === "missing" && <EmptyCard title="Plug it in" text="Connect the keyboard with its USB cable, and close illumipc.com if it's open in a browser." plug />}
        {phase.kind === "error" && <EmptyCard title="Couldn't talk to the keyboard" text={phase.message} plug />}
        {live && view.link === "lost" && <EmptyCard title="The keyboard went away" text="It stopped answering. Check the cable, then press Reconnect." plug />}

        {live && view.link !== "lost" && (
          <>
            {view.link === "reconnecting" && <Banner>The keyboard dropped off USB for a moment (it does this after a polling-rate change). Waiting for it…</Banner>}
            {view.readOnlyReason && <Banner>Read-only: {view.readOnlyReason} Save diagnostics and send the file so support can be added.</Banner>}
            {st.problems.length > 0 && !view.readOnlyReason && (
              <Banner tone="info">Some extras couldn't be read ({st.problems.map((p) => p.split(":")[0]).join(", ")}). Everything else works; the diagnostics file has the details.</Banner>
            )}
            <WritesCard view={view} onChange={(on) => (session.current ? session.current.setWritesEnabled(on) : void liveSession().then((r) => r?.setWritesEnabled(on)))} />

            {tab === "overview" && overview}

            {tab === "overview" && st.trigger && (
              // The map and the setting side by side on a wide window, so the tab fits without scrolling.
              <div className="grid items-start gap-4 min-[1380px]:grid-cols-[minmax(0,1fr)_340px]">
                {keysMode === "actuation"
                  ? mapCard(
                      "Actuation, key by key",
                      "Every key shows its actuation point in mm. Tinted keys differ from the rest. Select keys to change them together.",
                      <ActuationInspector st={st} selected={selected} canWrite={canWrite} run={run} />,
                      { right: keysSwitch },
                    )
                  : mapCard(
                      "Rapid trigger, key by key",
                      "Tinted keys use rapid trigger and show their sensitivity in mm. Select keys to turn it on or off for them.",
                      <RapidInspector st={st} selected={selected} canWrite={canWrite} run={run} />,
                      { right: keysSwitch },
                    )}
                {keysMode === "actuation" ? (
                  <ActuationCard st={st} canWrite={canWrite} run={run} onKeys={focusMap} />
                ) : (
                  <RapidTriggerCard st={st} canWrite={canWrite} run={run} onKeys={focusMap} />
                )}
              </div>
            )}

            {tab === "advkeys" && <AdvancedKeysTab st={st} first={first.current} canWrite={canWrite} run={run} />}

            {tab === "remap" && (
              // A short wide window (1480x920) puts the lighting and profile beside the map, so the tab fits above the dock.
              <div className="grid items-start gap-4 [@media(max-height:1000px)]:min-[1380px]:grid-cols-[minmax(0,1fr)_340px]">
                <div className="min-w-0">
                  {st.keymap &&
                    mapCard(
                    layer === "fn" ? "Remap, Fn layer" : "Remap",
                    layer === "fn" ? "What each key sends while Fn is held. Tinted keys have their own." : "What each key sends. Tinted keys already send something else. Fn can't be remapped.",
                    <RemapInspector st={st} first={first.current} layer={layer} selected={selected[0]} canWrite={canWrite} run={run} />,
                    {
                      multi: false,
                      right: (
                        <div className="flex gap-2">
                          <Chip on={layer === "default"} onClick={() => (setLayer("default"), setSelected([]))}>
                            Normal layer
                          </Chip>
                          <Chip on={layer === "fn"} onClick={() => (setLayer("fn"), setSelected([]))}>
                            Fn layer
                          </Chip>
                        </div>
                      ),
                    },
                  )}
                </div>
                <div className="flex min-w-0 flex-col gap-4">
                  {st.light && <LightingCard st={st} canWrite={canWrite} run={run} />}
                  {st.profile !== null && <ProfileCard st={st} canWrite={canWrite} run={run} />}
                </div>
              </div>
            )}


            {tab === "advanced" && (
              <>
                <PollingCard st={st} canWrite={canWrite} run={run} />
                <OtherCard st={st} canWrite={canWrite} run={run} />
                <InfoAdvanced
                  id="x68he"
                  deviceName={st.layout.name}
                  kind="keyboard"
                  brand="illumipc"
                  firmware={st.info.firmware ? [`Firmware ${st.info.firmware}`] : []}
                  why="This keyboard's factory reset and switch calibration need steps SYNQ has not verified, so they stay in illumipc.com."
                  notify={notify}
                />
                <p className="px-1 text-[12px] leading-relaxed text-medium">
                  Everything here was read from the keyboard ({new Date(st.readAt).toLocaleTimeString()}). Each change is read back to confirm it. Every report SYNQ
                  sends and receives is logged to {view.logFile}
                  {view.backup ? `; this session's backup is ${view.backup}` : "; a backup of everything is saved before the first change"}. Factory reset and switch calibration stay in
                  illumipc.com for now, and SYNQ never sends firmware updates.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </DeviceFrame>
  );
}

/** The top of the Overview: the keyboard, its connection and what it is set to right now (the keys sit under it). */
function X68Overview({ st, view, feel }: { st: X68State; view: X68View; feel?: FeelDevice }) {
  const u = units(st);
  const keys = editable(st);
  const global = st.trigger ? mostCommon(keys.map((k) => st.keys[k.index].travel), st.trigger.minUnits) : null;
  const rtKeys = keys.filter((k) => isRt(st.keys[k.index]));
  const split = rtKeys.some((k) => st.keys[k.index].mode === P.TRIGGER_MODE.rapidSplit);
  const fallback = u.toUnits(0.5);
  const press = mostCommon(rtKeys.map((k) => st.keys[k.index].press), fallback);
  const release = mostCommon(rtKeys.map((k) => st.keys[k.index].release), fallback);
  return (
    <>
      {feel && <FeelOffer {...feel} />}
      <OverviewStrip
        art={<DeviceArt spec={st.info.x68 ? { kind: "keyboard", family: "x68", name: "X68 HE", brand: "MAGIC-REFINER" } : { kind: "keyboard", name: st.info.model, brand: st.info.brand || null, vid: st.info.usbId.slice(0, 4), pid: st.info.usbId.slice(5) }} />}
        connection="Wired"
        detail={`${st.layout.name}. ${view.writable && view.writesEnabled ? "Changes are on: each is backed up first and read back." : "Read-only until you allow changes."}`}
        stats={[
          { label: "Type", value: "Hall effect" },
          { label: "Actuation", value: global === null ? "—" : `${u.mm(global)} mm`, note: global === null ? undefined : `${keys.filter((k) => st.keys[k.index].travel !== global).length} keys differ` },
          { label: "Rapid trigger", value: rtKeys.length ? `On · ${rtKeys.length} keys` : "Off" },
          { label: "Sensitivity", value: rtKeys.length ? (split ? `${u.mm(press)} / ${u.mm(release)} mm` : `${u.mm(press)} mm`) : "—" },
          { label: "Profile", value: st.profile === null ? "—" : st.profile === 0 ? "Default" : `Profile ${st.profile}` },
        ]}
        line={feel && <FeelCard {...feel} compact />}
        facts={[
          ["Firmware", st.info.firmware || "?"],
          ["Polling", hzText(st.pollHz)],
          ["Travel step", st.trigger ? `${st.trigger.unitMm} mm` : "—"],
          ["Board", st.info.product || "unknown"],
        ]}
      />
    </>
  );
}


function HeaderButton({ onClick, label, icon }: { onClick: () => void; label: string; icon: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="group flex h-8 items-center gap-2 rounded-small bg-white/[0.05] pl-3.5 pr-1 text-[12.5px] text-high ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.08]"
    >
      {label}
      <span className="grid size-6 place-items-center rounded bg-white/[0.08] transition-transform duration-500 ease-fluid group-hover:rotate-90">{icon}</span>
    </button>
  );
}

function WritesCard({ view, onChange }: { view: X68View; onChange: (on: boolean) => void }) {
  if (!view.writable) return null;
  const other = !view.state.info.x68;
  if (view.writesEnabled)
    return (
      <div className="flex items-center gap-3 px-1 text-[12px] text-medium">
        <span className="size-1.5 rounded-full bg-primary" />
        Changes are allowed. Each one is backed up first and read back after.
        <button onClick={() => onChange(false)} className="ml-auto text-medium underline-offset-2 hover:text-high hover:underline">
          Make read-only
        </button>
      </div>
    );
  return (
    <Card innerClassName="flex items-center gap-5 px-6 py-5">
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium text-high">Read-only until you allow changes</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-medium">
          SYNQ learned this keyboard's protocol from illumipc.com and hasn't been tried on one yet.{other ? " This model shares the protocol of every board that site drives, but nobody has run SYNQ on it." : ""} Everything below was read from your
          keyboard. When you allow changes, SYNQ saves a full backup first and checks every change by reading it back.
        </p>
      </div>
      <Switch checked={false} onCheckedChange={onChange} aria-label="Allow changes" />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Global actuation and rapid trigger
// ---------------------------------------------------------------------------------------------

const editable = (st: X68State) => st.layout.keys.filter((k) => !k.locked && st.keys[k.index]);

function ActuationCard({ st, canWrite, run, onKeys }: { st: X68State; canWrite: boolean; run: Run; onKeys: () => void }) {
  const t = st.trigger!;
  const u = units(st);
  const keys = editable(st);
  const global = mostCommon(keys.map((k) => st.keys[k.index].travel), t.minUnits);
  const own = keys.filter((k) => st.keys[k.index].travel !== global).length;
  const [draft, setDraft] = useKeptDraft(`${X68}.actuationCard`, global * u.unit, `${global}|${u.unit}`);
  const presets = [0.5, 1.0, 1.5, 2.0].filter((v) => v >= t.minMm && v <= t.maxMm);

  const apply = (mm: number) => {
    const travel = Math.max(t.minUnits, Math.min(t.maxUnits, u.toUnits(mm)));
    const changes = keys.map((k) => ({ ...st.keys[k.index], travel }));
    run(`Actuation set to ${u.mm(travel)} mm on every key`, (s) => s.setTriggers("actuation", changes));
  };

  return (
    <Card innerClassName="relative flex gap-6 px-6 pb-6 pt-5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-medium">Actuation point</p>
        <div className="mt-3 flex items-baseline gap-3">
          <NumberFlow
            value={global * u.unit}
            format={{ minimumFractionDigits: u.decimals, maximumFractionDigits: u.decimals }}
            className="display-num tabular text-[clamp(64px,5.6vw,84px)] leading-none tracking-[-0.06em] text-high"
          />
          <span className="text-[18px] text-medium">mm</span>
        </div>
        <p className="mt-1 text-[12.5px] text-medium">
          How far a key goes down before it registers ({t.minMm}–{t.maxMm} mm). Setting it here applies it to every key.
        </p>
        <div className="mt-5 flex flex-wrap items-end gap-2">
          <NumberField
            label="Every key"
            value={draft}
            min={t.minMm}
            max={t.maxMm}
            step={u.unit}
            smallStep={u.unit}
            largeStep={0.1}
            decimals={u.decimals}
            unit="mm"
            onChange={setDraft}
            className="w-[150px]"
          />
          <Pill primary disabled={!canWrite || u.toUnits(draft) === global} onClick={() => apply(draft)}>
            Apply to all
          </Pill>
          <span className="mx-1 h-5 w-px self-center bg-white/[0.08]" />
          {presets.map((v) => (
            <Chip key={v} numeric disabled={!canWrite} on={u.toUnits(v) === global && own === 0} onClick={() => apply(v)}>
              {v.toFixed(1)}
            </Chip>
          ))}
        </div>
        <button onClick={onKeys} className="mt-4 flex items-center gap-1.5 text-[12.5px] text-medium transition-colors hover:text-high">
          {own === 0 ? "Set keys individually" : own === 1 ? "1 key has its own value" : `${own} keys have their own values`}
          <ArrowRight size={12} />
        </button>
      </div>
      <TravelGauge st={st} global={global} />
    </Card>
  );
}

function TravelGauge({ st, global }: { st: X68State; global: number }) {
  const H = 236;
  const t = st.trigger!;
  const y = (units: number) => Math.min(H, (units * t.unitMm * H) / t.maxMm);
  const ticks = Array.from({ length: Math.floor(t.maxMm) + 1 }, (_, i) => i);
  const others = [...new Set(editable(st).map((k) => st.keys[k.index].travel))].filter((v) => v !== global);
  return (
    <div className="flex shrink-0 select-none gap-2.5 pt-1" aria-hidden="true">
      <div className="relative text-right text-[10.5px] text-medium tabular" style={{ height: H, width: 10 }}>
        {ticks.map((v) => (
          <span key={v} className="absolute right-0 leading-none" style={{ top: Math.min(H - 8, (v / t.maxMm) * H) }}>
            {v}
          </span>
        ))}
      </div>
      <div className="relative w-9 overflow-hidden rounded-full bg-shade/40 ring-1 ring-white/[0.06] shadow-[inset_0_2px_6px_rgb(0_0_0/0.6)]" style={{ height: H }}>
        {others.map((o) => (
          <div key={o} className="absolute inset-x-2 h-px bg-white/30 transition-all duration-500 ease-fluid" style={{ top: y(o) }} />
        ))}
        <div className="absolute inset-x-0 h-[3px] -translate-y-1/2 bg-primary shadow-[0_0_12px_var(--primary)] transition-all duration-500 ease-fluid" style={{ top: y(global) }} />
      </div>
    </div>
  );
}

function RapidTriggerCard({ st, canWrite, run, onKeys }: { st: X68State; canWrite: boolean; run: Run; onKeys: () => void }) {
  const t = st.trigger!;
  const u = units(st);
  const keys = editable(st);
  const rtKeys = keys.filter((k) => isRt(st.keys[k.index]));
  const on = rtKeys.length > 0;
  const split = rtKeys.some((k) => st.keys[k.index].mode === P.TRIGGER_MODE.rapidSplit);
  const fallback = u.toUnits(0.5);
  const press = mostCommon(rtKeys.map((k) => st.keys[k.index].press), fallback);
  const release = mostCommon(rtKeys.map((k) => st.keys[k.index].release), fallback);
  const [draft, setDraft] = useKeptDraft(`${X68}.rapidCard`, { press: press * u.unit, release: release * u.unit }, `${press}|${release}|${u.unit}`);

  const write = (label: string, which: X68Key[], m: number, p: number, r: number) =>
    run(label, (s) =>
      s.setTriggers(
        "rapid trigger",
        which.map((k) => ({ ...st.keys[k.index], mode: m, press: p, release: m === P.TRIGGER_MODE.rapid ? p : r })),
      ),
    );

  return (
    <Card innerClassName="flex flex-col px-6 pb-5 pt-5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium text-high">Rapid trigger</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-medium">
            {on ? (rtKeys.length === keys.length ? "On for every key" : `On for ${rtKeys.length} keys: ${names(st, rtKeys.map((k) => k.index)).slice(0, 80)}`) : "Off for every key"}
          </p>
        </div>
        <Switch
          checked={on}
          aria-label="Rapid trigger on every key"
          onCheckedChange={(v) =>
            canWrite &&
            (v
              ? write("Rapid trigger on for every key", keys, split ? P.TRIGGER_MODE.rapidSplit : P.TRIGGER_MODE.rapid, press, release)
              : write("Rapid trigger off", rtKeys, P.TRIGGER_MODE.normal, press, release))
          }
        />
      </div>
      <div className="mt-3 divide-y divide-white/[0.05]">
        <SwitchRow
          title="Separate press and release"
          hint="Different distances for re-pressing and releasing."
          checked={split}
          onChange={(v) => canWrite && on && write(v ? "Press and release now separate" : "One sensitivity for press and release", rtKeys, v ? P.TRIGGER_MODE.rapidSplit : P.TRIGGER_MODE.rapid, press, release)}
        />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <NumberField
          label={split ? "Press" : "Sensitivity"}
          value={draft.press}
          min={t.rtMinMm}
          max={t.rtMaxMm}
          step={u.unit}
          smallStep={u.unit}
          largeStep={0.1}
          decimals={u.decimals}
          unit="mm"
          onChange={(v) => setDraft((d) => ({ ...d, press: v }))}
        />
        {split && (
          <NumberField
            label="Release"
            value={draft.release}
            min={t.rtMinMm}
            max={t.rtMaxMm}
            step={u.unit}
            smallStep={u.unit}
            largeStep={0.1}
            decimals={u.decimals}
            unit="mm"
            onChange={(v) => setDraft((d) => ({ ...d, release: v }))}
          />
        )}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Pill
          primary
          disabled={!canWrite || !on || (u.toUnits(draft.press) === press && (!split || u.toUnits(draft.release) === release))}
          onClick={() =>
            write(
              `Rapid trigger set to ${draft.press.toFixed(u.decimals)}${split ? ` / ${draft.release.toFixed(u.decimals)}` : ""} mm`,
              rtKeys,
              split ? P.TRIGGER_MODE.rapidSplit : P.TRIGGER_MODE.rapid,
              u.toUnits(draft.press),
              u.toUnits(draft.release),
            )
          }
        >
          Apply to rapid-trigger keys
        </Pill>
        <button onClick={onKeys} className="ml-auto flex items-center gap-1.5 text-[12.5px] text-medium transition-colors hover:text-high">
          Choose keys <ArrowRight size={12} />
        </button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Key map
// ---------------------------------------------------------------------------------------------

interface Mark {
  /** Lit: set on this key. Dim: set but off. None: the default. */
  tone?: "lit" | "dim";
  text?: string;
}

const ADV_SHORT: Record<P.AdvancedType, string> = { DKS: "DKS", MT: "Tap/hold", TGL: "Toggle", RS: "RS", RKRT: "RKRT", MDS: "Combo" };

/** What each key shows on the map for this tab: its current value, so the map reads like a settings sheet. */
function marksFor(mode: Mode, st: X68State): Map<number, Mark> {
  const m = new Map<number, Mark>();
  const u = units(st);
  const keys = editable(st);
  if (mode === "actuation") {
    const global = mostCommon(keys.map((k) => st.keys[k.index].travel), 0);
    for (const k of keys) {
      const travel = st.keys[k.index].travel;
      m.set(k.index, { tone: travel !== global ? "lit" : undefined, text: u.mm(travel) });
    }
  } else if (mode === "rapid") {
    const short = (x: number) => u.mm(x).replace(/^0/, "");
    for (const k of keys) {
      const t = st.keys[k.index];
      m.set(k.index, isRt(t) ? { tone: "lit", text: t.mode === P.TRIGGER_MODE.rapidSplit ? `${short(t.press)}/${short(t.release)}` : short(t.press) } : { text: "off" });
    }
  } else if (st.keymap) {
    const layer: P.Layer = mode === "fn" ? "fn" : "default";
    for (const k of st.layout.keys) {
      const a = actionOf(st, layer, k.index);
      if (a[0] === P.ACTION.advanced) {
        const e = st.advanced?.find((x) => x.slot === a[1]);
        m.set(k.index, { tone: "lit", text: e ? ADV_SHORT[e.type] : "Adv" });
      } else if (layer === "default" ? !sameAction(a, k.factory) : !sameAction(a, [0, 0, 0, 0])) {
        m.set(k.index, { tone: layer === "fn" ? "dim" : "lit", text: `${layer === "default" ? "→ " : ""}${P.describeAction(a)}` });
      }
    }
  }
  return m;
}

function ActuationInspector({ st, selected, canWrite, run }: { st: X68State; selected: number[]; canWrite: boolean; run: Run }) {
  const t = st.trigger;
  const u = units(st);
  const firstKey = selected.length ? st.keys[selected[0]] : undefined;
  const dz = (i: number) => (st.deadband ? { top: st.deadband[i * 2], bottom: st.deadband[i * 2 + 1] } : null);
  const seed = { travel: (firstKey?.travel ?? 0) * u.unit, top: (dz(selected[0])?.top ?? 0) * u.unit, bottom: (dz(selected[0])?.bottom ?? 0) * u.unit };
  const seedKey = `${selected.join()}|${firstKey?.travel}|${seed.top}|${seed.bottom}`;
  const [draft, setDraft] = useKeptDraft(`${X68}.actuationInspector`, seed, seedKey);
  if (!t) return null;
  const dzMax = Math.ceil(1 / u.unit) * u.unit;
  const travel = Math.max(t.minUnits, Math.min(t.maxUnits, u.toUnits(draft.travel)));
  return (
    <div className="flex flex-wrap items-end gap-5">
      <MmSlider
        label="Actuation"
        value={draft.travel}
        min={t.minMm}
        max={t.maxMm}
        step={u.unit}
        decimals={u.decimals}
        onChange={(v) => setDraft((d) => ({ ...d, travel: v }))}
        className="w-[280px]"
      />
      <Pill
        primary
        disabled={!canWrite}
        onClick={() =>
          run(`Actuation set to ${u.mm(travel)} mm for ${names(st, selected)}`, (s) =>
            s.setTriggers(
              "actuation",
              selected.map((i) => ({ ...st.keys[i], travel })),
            ),
          )
        }
      >
        Apply to {selected.length === 1 ? "this key" : `${selected.length} keys`}
      </Pill>
      {st.deadband && (
        <>
          <span className="h-9 w-px self-center bg-white/[0.08]" />
          <NumberField label="Top dead zone" value={draft.top} min={0} max={dzMax} step={u.unit} smallStep={u.unit} largeStep={0.1} decimals={u.decimals} unit="mm" onChange={(v) => setDraft((d) => ({ ...d, top: v }))} className="w-[130px]" />
          <NumberField label="Bottom dead zone" value={draft.bottom} min={0} max={dzMax} step={u.unit} smallStep={u.unit} largeStep={0.1} decimals={u.decimals} unit="mm" onChange={(v) => setDraft((d) => ({ ...d, bottom: v }))} className="w-[130px]" />
          <Pill
            disabled={!canWrite}
            onClick={() =>
              run(`Dead zones set for ${names(st, selected)}`, (s) =>
                s.setDeadbands(
                  "dead zones",
                  selected.map((index) => ({ index, top: u.toUnits(draft.top), bottom: u.toUnits(draft.bottom) })),
                ),
              )
            }
          >
            Apply dead zones
          </Pill>
        </>
      )}
    </div>
  );
}

function RapidInspector({ st, selected, canWrite, run }: { st: X68State; selected: number[]; canWrite: boolean; run: Run }) {
  const t = st.trigger;
  const u = units(st);
  const firstKey = selected.length ? st.keys[selected[0]] : undefined;
  const seed = {
    on: isRt(firstKey),
    split: firstKey?.mode === P.TRIGGER_MODE.rapidSplit,
    press: (isRt(firstKey) ? firstKey!.press : u.toUnits(0.5)) * u.unit,
    release: (isRt(firstKey) ? firstKey!.release : u.toUnits(0.5)) * u.unit,
  };
  const seedKey = `${selected.join()}|${firstKey?.mode}|${firstKey?.press}|${firstKey?.release}`;
  const [draft, setDraft] = useKeptDraft(`${X68}.rapidInspector`, seed, seedKey);
  if (!t) return null;
  const apply = () => {
    const m = !draft.on ? P.TRIGGER_MODE.normal : draft.split ? P.TRIGGER_MODE.rapidSplit : P.TRIGGER_MODE.rapid;
    const p = u.toUnits(draft.press);
    const r = draft.split ? u.toUnits(draft.release) : p;
    run(draft.on ? `Rapid trigger set for ${names(st, selected)}` : `Rapid trigger off for ${names(st, selected)}`, (s) =>
      s.setTriggers(
        "rapid trigger",
        selected.map((i) => ({ ...st.keys[i], mode: m, press: draft.on ? p : st.keys[i].press, release: draft.on ? r : st.keys[i].release })),
      ),
    );
  };
  return (
    <div className="flex flex-wrap items-end gap-5">
      <label className="flex h-9 items-center gap-2 text-[12.5px] text-medium">
        <Switch checked={draft.on} onCheckedChange={(on) => setDraft((d) => ({ ...d, on }))} aria-label="Rapid trigger" />
        Rapid trigger
      </label>
      <label className="flex h-9 items-center gap-2 text-[12.5px] text-medium">
        <Switch checked={draft.split} onCheckedChange={(split) => setDraft((d) => ({ ...d, split }))} aria-label="Separate press and release" />
        Separate
      </label>
      <MmSlider
        label={draft.split ? "Press" : "Sensitivity"}
        value={draft.press}
        min={t.rtMinMm}
        max={t.rtMaxMm}
        step={u.unit}
        decimals={u.decimals}
        disabled={!draft.on}
        onChange={(v) => setDraft((d) => ({ ...d, press: v }))}
        className="w-[220px]"
      />
      {draft.split && (
        <MmSlider label="Release" value={draft.release} min={t.rtMinMm} max={t.rtMaxMm} step={u.unit} decimals={u.decimals} disabled={!draft.on} onChange={(v) => setDraft((d) => ({ ...d, release: v }))} className="w-[220px]" />
      )}
      <Pill primary disabled={!canWrite} onClick={apply}>
        Apply to {selected.length === 1 ? "this key" : `${selected.length} keys`}
      </Pill>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Remapping (both layers) and the action picker
// ---------------------------------------------------------------------------------------------

function encodeChoice(a: P.RawAction): string {
  return a.join(",");
}
function decodeChoice(s: string): P.RawAction {
  const [a, b, c, d] = s.split(",").map(Number);
  return [a, b, c, d];
}

function actionGroups(st: X68State, current: P.RawAction) {
  const letters: { value: string; label: string }[] = [];
  const nav: { value: string; label: string }[] = [];
  const fkeys: { value: string; label: string }[] = [];
  const mods: { value: string; label: string }[] = [];
  const pad: { value: string; label: string }[] = [];
  for (const [hidStr, name] of Object.entries(P.HID_NAMES)) {
    const hid = Number(hidStr);
    const opt = { value: encodeChoice(P.keyAction(hid)), label: name };
    if (P.isModifier(hid)) mods.push(opt);
    else if (/^F\d+$/.test(name)) fkeys.push(opt);
    else if (/^Num /.test(name)) pad.push(opt);
    else if (hid >= 0x04 && hid <= 0x38) letters.push(opt);
    else nav.push(opt);
  }
  const groups: { label?: string; options: { value: string; label: string }[] }[] = [
    { label: "Letters, numbers and symbols", options: letters },
    { label: "Modifiers", options: mods },
    { label: "Navigation and editing", options: nav },
    { label: "Function keys", options: fkeys },
    { label: "Number pad", options: pad },
    { label: "Media and apps", options: P.MEDIA.map((m) => ({ value: encodeChoice([P.ACTION.media, m.hid, 0, 0]), label: m.label })) },
    { label: "Mouse", options: P.MOUSE.map((m) => ({ value: encodeChoice(m.raw), label: m.label })) },
    { label: "Shortcuts", options: P.SHORTCUTS.map((m) => ({ value: encodeChoice(m.raw), label: m.label })) },
    { label: "Keyboard", options: [...P.KEYBOARD_FUNCTIONS.map((m) => ({ value: encodeChoice(m.raw), label: m.label })), { value: encodeChoice([0, 0, 0, 0]), label: "Disabled (sends nothing)" }] },
  ];
  const cur = encodeChoice(current);
  if (!groups.some((g) => g.options.some((o) => o.value === cur))) groups.unshift({ label: "Current", options: [{ value: cur, label: P.describeAction(current) }] });
  void st;
  return groups;
}

function ActionPicker({ st, value, onChange, label }: { st: X68State; value: P.RawAction; onChange: (a: P.RawAction) => void; label: string }) {
  const groups = useMemo(() => actionGroups(st, value), [st, value]);
  return <Select<string> label={label} value={encodeChoice(value)} groups={groups} onChange={(v) => onChange(decodeChoice(v))} className="w-[220px]" />;
}

const MOD_OPTIONS = [0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7].map((h) => ({ value: String(h), label: P.HID_NAMES[h] }));

function RemapInspector({ st, first, layer, selected, canWrite, run }: { st: X68State; first: X68State | null; layer: P.Layer; selected?: number; canWrite: boolean; run: Run }) {
  const current = selected !== undefined ? actionOf(st, layer, selected) : ([0, 0, 0, 0] as P.RawAction);
  const curKey = `${selected}|${current.join()}|${layer}`;
  const [draft, setDraft] = useKeptDraft<P.RawAction>(`${X68}.remapDraft`, current, curKey);
  const [combo, setCombo] = useKeptState(`${X68}.remapCombo`, { on: false, m1: "224", m2: "0", key: "6" });
  // Another key (or its action changed): the combo editor closes, keeping what was typed in it.
  const comboFor = useKeptRef<string | null>(`${X68}.remapComboFor`, null);
  useEffect(() => {
    if (comboFor.current !== null && comboFor.current !== curKey) setCombo((c) => ({ ...c, on: false }));
    comboFor.current = curKey;
  }, [curKey, comboFor, setCombo]);
  if (selected === undefined) return null;
  const key = st.layout.keys.find((k) => k.index === selected)!;
  const fnLocked = layer === "fn" && st.fnEditable.length > 0 && !st.fnEditable.includes(selected);
  const isAdvanced = current[0] === P.ACTION.advanced;
  const original = first?.keymap ? P.actionAt(Uint8Array.from(first.keymap[layer]), selected) : null;
  const target = combo.on ? safeCombo(combo) : draft;
  const save = (a: P.RawAction, label: string) => run(label, (s) => s.setKeymap(label, layer, [{ index: selected, action: a }]));
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="min-w-[180px] flex-1">
        <p className="text-[13px] text-high">
          <span className="text-medium">{layer === "fn" ? "Fn + " : ""}</span>
          {keyName(st, selected)}
          <span className="text-medium"> sends </span>
          {P.describeAction(current)}
        </p>
        {fnLocked && <p className="mt-1 text-[12px] text-chart-3">The keyboard keeps this Fn-layer key for itself.</p>}
        {isAdvanced && <p className="mt-1 text-[12px] text-medium">Bound to an advanced key; change it in Advanced keys.</p>}
      </div>
      {!fnLocked && !isAdvanced && (
        <>
          {combo.on ? (
            <div className="flex items-end gap-2">
              <Select<string> label="Modifier" value={combo.m1} onChange={(m1) => setCombo((c) => ({ ...c, m1 }))} groups={[{ options: MOD_OPTIONS }]} className="w-[120px]" />
              <Select<string> label="Second modifier" value={combo.m2} onChange={(m2) => setCombo((c) => ({ ...c, m2 }))} groups={[{ options: [{ value: "0", label: "(none)" }, ...MOD_OPTIONS] }]} className="w-[120px]" />
              <Select<string>
                label="Key"
                value={combo.key}
                onChange={(k) => setCombo((c) => ({ ...c, key: k }))}
                groups={[{ options: Object.entries(P.HID_NAMES).filter(([h]) => !P.isModifier(Number(h))).map(([h, n]) => ({ value: h, label: n })) }]}
                className="w-[120px]"
              />
            </div>
          ) : (
            <ActionPicker st={st} label="New action" value={draft} onChange={setDraft} />
          )}
          <label className="flex h-9 items-center gap-2 text-[12.5px] text-medium">
            <Switch checked={combo.on} onCheckedChange={(on) => setCombo((c) => ({ ...c, on }))} aria-label="Key combination" />
            Combination
          </label>
          <Pill primary disabled={!canWrite || !target || sameAction(target, current)} onClick={() => target && save(target, `${layer === "fn" ? "Fn + " : ""}${keyName(st, selected)} now sends ${P.describeAction(target)}`)}>
            Apply
          </Pill>
          {layer === "default" && !sameAction(current, key.factory) && (
            <Pill disabled={!canWrite} onClick={() => save(key.factory, `${keyName(st, selected)} back to ${P.describeAction(key.factory)}`)}>
              Factory key
            </Pill>
          )}
          {original && !sameAction(original, current) && (
            <Pill disabled={!canWrite} onClick={() => save(original, `${keyName(st, selected)} restored`)}>
              Undo
            </Pill>
          )}
        </>
      )}
    </div>
  );
}

function safeCombo(c: { m1: string; m2: string; key: string }): P.RawAction | null {
  try {
    return P.comboAction([Number(c.m1), Number(c.m2), Number(c.key)].filter((x) => x));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// SOCD
// ---------------------------------------------------------------------------------------------

const SOCD_MODES = [
  { value: "0", label: "Last pressed wins" },
  { value: "1", label: "Key 1 wins" },
  { value: "2", label: "Key 2 wins" },
  { value: "3", label: "Neutral (both off)" },
];

// ---------------------------------------------------------------------------------------------
// Advanced keys (DKS, tap/hold, toggle, RS, RKRT; combo macros shown)
// ---------------------------------------------------------------------------------------------

const ADV_LABEL: Record<P.AdvancedType, string> = {
  DKS: "Dynamic keystroke (DKS)",
  MT: "Tap / hold (MT)",
  TGL: "Toggle (TGL)",
  RS: "Rapid stroke (RS)",
  RKRT: "Release trigger (RKRT)",
  MDS: "Combo macro (MDS)",
};

function boundKeys(st: X68State, slot: number): { layer: P.Layer; index: number }[] {
  if (!st.keymap) return [];
  const out: { layer: P.Layer; index: number }[] = [];
  for (const layer of ["default", "fn"] as const)
    for (const k of st.layout.keys) {
      const a = actionOf(st, layer, k.index);
      if (a[0] === P.ACTION.advanced && a[1] === slot) out.push({ layer, index: k.index });
    }
  return out;
}

function describeAdvanced(st: X68State, e: P.AdvancedEntry): string {
  const d = (a?: P.RawAction) => (a ? P.describeAction(a) : "?");
  switch (e.type) {
    case "MT":
      return `tap ${d(e.actions[0])}, hold ${d(e.actions[1])} (${(e.duration ?? 0) * 10} ms)`;
    case "TGL":
      return `toggles ${d(e.actions[0])}`;
    case "RS":
      return `${keyName(st, e.keyIndexes?.[0] ?? 0)} vs ${keyName(st, e.keyIndexes?.[1] ?? 0)}: the deeper one wins`;
    case "RKRT":
      return `${d(e.actions[0])}, plus ${d(e.actions[1])} on release`;
    case "DKS":
      return `${e.actions.filter((a) => a[0] || a[1]).map(d).join(", ") || "no actions"} at ${(e.travelPoints ?? []).map((v) => (v / 10).toFixed(1)).join("/")} mm`;
    case "MDS":
      return `${(e.hidKeys ?? []).map((h) => P.HID_NAMES[h] ?? h).join(" + ")} (mode ${e.mdsMode ?? 0})`;
  }
}

type AdvForm = {
  type: "MT" | "TGL" | "RS" | "RKRT" | "DKS";
  key: string;
  key2: string;
  a1: P.RawAction;
  a2: P.RawAction;
  holdMs: number;
  dks: P.RawAction[];
  steps: number[];
  points: number[];
};

const STEP_LABEL = ["·", "Tap", "Hold", "End"];

// ---------------------------------------------------------------------------------------------
// Advanced keys: the guided flow (DKS, tap/hold, toggle, snap tap / SOCD, deeper wins, release trigger)
// ---------------------------------------------------------------------------------------------

const X68_ADV_TYPES: AdvType[] = [
  {
    id: "DKS",
    title: "Dynamic keystroke (DKS)",
    blurb: "One key does up to four different things, depending on how far you press it and where you let go.",
    icon: Stack,
    pick: 1,
    steps: ["Pick the key", "Set the actions", "Review"],
    legality: MULTI_ACTION_LEGALITY,
  },
  {
    id: "MT",
    title: "Mod-tap (tap and hold)",
    blurb: "Tap the key for one thing, hold it for another. For example: tap for Esc, hold for Ctrl.",
    icon: Hourglass,
    pick: 1,
    steps: ["Pick the key", "Set tap and hold", "Review"],
  },
  {
    id: "TGL",
    title: "Toggle",
    blurb: "Press the key once to hold something down, press it again to let go.",
    icon: ToggleLeft,
    pick: 1,
    steps: ["Pick the key", "Choose what it holds", "Review"],
    legality: TOGGLE_LEGALITY,
  },
  {
    id: "SOCD",
    title: "Snap tap (SOCD)",
    blurb: "Two opposite keys, like A and D. Choose what happens when both are held, so strafing turns around at once.",
    icon: ArrowsLeftRight,
    pick: 2,
    steps: ["Pick the two keys", "Choose what wins", "Review"],
    legality: SOCD_LEGALITY,
  },
  {
    id: "RS",
    title: "Deeper wins (rapid stroke)",
    blurb: "Two keys: when both are held, the one pressed deeper is the one that counts.",
    icon: ArrowsDownUp,
    pick: 2,
    steps: ["Pick the two keys", "Set it up", "Review"],
    legality: SOCD_LEGALITY,
  },
  {
    id: "RKRT",
    title: "Release trigger",
    blurb: "A key that also sends something extra when you let go of it.",
    icon: ArrowUDownLeft,
    pick: 1,
    steps: ["Pick the key", "Choose the extra key", "Review"],
  },
];

const SOCD_FOR = (st: X68State, index: number) => {
  const k = st.layout.keys.find((x) => x.index === index);
  return k && k.factory[0] === 0 && k.factory[1] ? k.factory[1] : null;
};

function AdvancedKeysTab({ st, first, canWrite, run }: { st: X68State; first: X68State | null; canWrite: boolean; run: Run }) {
  const list = st.advanced ?? [];
  const socd = st.socd;
  const t = st.trigger;
  const maxMm = t ? t.maxMm : 4;
  const defaultPoints = [1.5, Math.max(0.5, +(maxMm - 0.4).toFixed(1)), Math.max(0.5, +(maxMm - 0.4).toFixed(1)), 1.5];
  const blank = (): AdvForm => ({
    type: "MT",
    key: "66",
    key2: "70",
    a1: P.keyAction(0x29),
    a2: P.keyAction(0xe0),
    holdMs: 150,
    dks: [P.keyAction(0x2c), [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    steps: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    points: defaultPoints,
  });
  const [form, setForm] = useKeptState<AdvForm>(`${X68}.advancedForm`, blank);
  const [socdMode, setSocdMode] = useKeptState(`${X68}.socdMode`, "0");
  const [flow, setFlow] = useKeptState<AdvFlow | null>(`${X68}.advFlow`, null);
  const marks = useMemo(() => marksFor("remap", st), [st]);

  const type = flow?.typeId;
  const isSocd = type === "SOCD";
  const layout = useMemo<MapLayout>(
    () => ({
      width: st.layout.units.w,
      height: st.layout.units.h,
      keys: st.layout.keys.map((k) => ({
        id: k.index,
        x: k.x,
        y: k.y,
        w: k.w,
        h: k.h,
        label: k.label || (k.index === 116 ? "" : "?"),
        // Snap tap works on keys the keyboard knows by a plain key code.
        locked: k.locked || (isSocd && !SOCD_FOR(st, k.index)),
        title: keyName(st, k.index),
        mark: marks.get(k.index) as MapKey["mark"],
      })),
    }),
    [st, marks, isSocd],
  );

  const restoreAction = (b: { layer: P.Layer; index: number }): P.RawAction => {
    const k = st.layout.keys.find((x) => x.index === b.index)!;
    if (b.layer === "default") return k.factory;
    const orig = first?.keymap ? P.actionAt(Uint8Array.from(first.keymap.fn), b.index) : null;
    return orig && orig[0] !== P.ACTION.advanced ? orig : [0, 0, 0, 0];
  };

  const remove = (e: P.AdvancedEntry) => {
    const label = `${ADV_LABEL[e.type]} removed`;
    run(label, (s) =>
      s.setAdvanced(
        label,
        list.filter((x) => x.slot !== e.slot),
        boundKeys(st, e.slot).map((b) => ({ ...b, action: restoreAction(b) })),
      ),
    );
  };

  const f: AdvForm = { ...form, type: (type && type !== "SOCD" ? type : "MT") as AdvForm["type"], key: String(flow?.keys[0] ?? form.key), key2: String(flow?.keys[1] ?? form.key2) };

  const save = () => {
    if (!flow) return;
    if (flow.typeId === "SOCD") {
      if (!socd || flow.keys.length !== 2) return;
      const [k1, k2] = flow.keys.map((i) => SOCD_FOR(st, i));
      if (!k1 || !k2) return;
      const label = `SOCD ${hidName(st, k1)}/${hidName(st, k2)} added`;
      run(label, (s) =>
        s.setSocd(label, [...socd.entries, { index: socd.entries.length, mode: Number(socdMode), key1: k1, key2: k2 }], true).then((r) => (setFlow(null), r)),
      );
      return;
    }
    const used = new Set(list.map((x) => x.slot));
    const slot = Array.from({ length: P.ADVANCED_SLOTS }, (_, i) => i).find((i) => !used.has(i));
    if (slot === undefined) return;
    const keyIndex = Number(f.key);
    const base = st.layout.keys.find((k) => k.index === keyIndex)!.factory;
    let entry: P.AdvancedEntry;
    let bind = true;
    if (f.type === "MT") entry = { slot, type: "MT", actions: [f.a1, f.a2], duration: Math.max(1, Math.min(255, Math.round(f.holdMs / 10))) };
    else if (f.type === "TGL") entry = { slot, type: "TGL", actions: [f.a1] };
    else if (f.type === "RKRT") {
      entry = { slot, type: "RKRT", actions: [base, f.a2] };
      bind = false; // illumipc stores RKRT by key code, without a keymap binding
    } else if (f.type === "RS") {
      const k2 = st.layout.keys.find((k) => k.index === Number(f.key2))!;
      entry = { slot, type: "RS", actions: [base, k2.factory], keyIndexes: [keyIndex, k2.index] };
      bind = false; // RS addresses both keys by matrix position
    } else entry = { slot, type: "DKS", actions: f.dks, steps: f.steps, travelPoints: f.points.map((mm) => Math.round(mm * 10)) };
    const label = `${ADV_LABEL[f.type]} on ${keyName(st, keyIndex)}`;
    run(label, (s) => s.setAdvanced(label, [...list, entry], bind ? [{ layer: "default", index: keyIndex, action: [P.ACTION.advanced, slot, slot, 0] }] : []).then((r) => (setFlow(null), r)));
  };

  const advFull = list.length >= P.ADVANCED_SLOTS;
  const socdFull = (socd?.entries.length ?? 0) >= P.SOCD_SLOTS;
  const types = X68_ADV_TYPES.filter((x) => (x.id === "SOCD" ? !!socd : !!st.advanced)).map((x) => ({
    ...x,
    unavailable: x.id === "SOCD" ? (socdFull ? `All ${P.SOCD_SLOTS} pair slots are used.` : null) : advFull ? `All ${P.ADVANCED_SLOTS} slots are used.` : null,
  }));

  const active: ActiveKey[] = [
    ...list.map((e) => {
      const bound = boundKeys(st, e.slot);
      return {
        id: `adv-${e.slot}`,
        typeId: e.type,
        title: `${ADV_LABEL[e.type]}${bound.length ? ` on ${bound.map((b) => `${b.layer === "fn" ? "Fn+" : ""}${keyName(st, b.index)}`).join(", ")}` : ""}`,
        detail: describeAdvanced(st, e),
        legality: e.type === "RS" ? SOCD_LEGALITY : e.type === "TGL" ? TOGGLE_LEGALITY : undefined,
        onRemove: () => remove(e),
      };
    }),
    ...(socd?.entries ?? []).map((e, i) => ({
      id: `socd-${e.index}`,
      typeId: "SOCD",
      title: `Snap tap (SOCD): ${hidName(st, e.key1)} and ${hidName(st, e.key2)}`,
      detail: `${SOCD_MODES[e.mode]?.label ?? `Mode ${e.mode}`}${socd?.on ? "" : " (SOCD is switched off below)"}`,
      legality: SOCD_LEGALITY,
      onRemove: () =>
        run("SOCD pair removed", (s) =>
          s.setSocd(
            "SOCD pair removed",
            socd!.entries.filter((_, j) => j !== i),
            socd!.on,
          ),
        ),
    })),
  ];

  const setup =
    type === "DKS" ? (
      <DksEditor st={st} form={f} maxMm={maxMm} onChange={(next) => setForm({ ...form, ...next })} />
    ) : type === "MT" ? (
      <div className="flex flex-wrap items-end gap-3">
        <Labeled label="Tap">
          <ActionPicker st={st} label="Tap action" value={f.a1} onChange={(a1) => setForm({ ...form, a1 })} />
        </Labeled>
        <Labeled label="Hold">
          <ActionPicker st={st} label="Hold action" value={f.a2} onChange={(a2) => setForm({ ...form, a2 })} />
        </Labeled>
        <NumberField label="Hold after" value={f.holdMs} min={10} max={2550} step={10} unit="ms" onChange={(holdMs) => setForm({ ...form, holdMs })} className="w-[120px]" />
      </div>
    ) : type === "TGL" ? (
      <Labeled label="Holds down">
        <ActionPicker st={st} label="Toggle action" value={f.a1} onChange={(a1) => setForm({ ...form, a1 })} />
      </Labeled>
    ) : type === "RKRT" ? (
      <Labeled label="Also sends on release">
        <ActionPicker st={st} label="Release action" value={f.a2} onChange={(a2) => setForm({ ...form, a2 })} />
      </Labeled>
    ) : type === "SOCD" ? (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-high">
          <span className="text-medium">Keys: </span>
          {flow ? names(st, flow.keys) : ""}
        </p>
        <Labeled label="When both are held">
          <Select<string> label="SOCD mode" value={socdMode} groups={[{ options: SOCD_MODES }]} onChange={setSocdMode} className="w-[240px]" />
        </Labeled>
      </div>
    ) : null;

  const review = (
    <div className="text-[13px] text-high">
      <p>
        <span className="text-medium">{flow && flow.keys.length > 1 ? "Keys: " : "Key: "}</span>
        {flow ? names(st, flow.keys) : ""}
      </p>
      <p className="mt-1.5 text-[12.5px] text-medium">
        {type === "MT" && `Tap sends ${P.describeAction(f.a1)}, hold sends ${P.describeAction(f.a2)} after ${f.holdMs} ms.`}
        {type === "TGL" && `Each press toggles ${P.describeAction(f.a1)}.`}
        {type === "RKRT" && `Sends the key itself, plus ${P.describeAction(f.a2)} when you let go.`}
        {type === "RS" && "When both keys are held, the one pressed deeper counts."}
        {type === "DKS" && `${f.dks.filter((a) => a[0] || a[1]).map((a) => P.describeAction(a)).join(", ") || "No actions"} at ${f.points.map((v) => v.toFixed(1)).join(" / ")} mm.`}
        {type === "SOCD" && (SOCD_MODES[Number(socdMode)]?.label ?? "")}
      </p>
    </div>
  );

  return (
    <>
      {socd && socd.entries.length > 0 && (
        <Card innerClassName="flex items-center gap-4 px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] text-high">Snap tap / SOCD is {socd.on ? "on" : "off"}</p>
            <p className="text-[12px] text-medium">One switch for every pair below.</p>
          </div>
          <Switch checked={socd.on} aria-label="SOCD" onCheckedChange={(on) => canWrite && run(on ? "SOCD on" : "SOCD off", (s) => s.setSocd(on ? "SOCD on" : "SOCD off", socd.entries, on))} />
        </Card>
      )}
      <AdvancedKeysFlow
        types={types}
        active={active}
        max={P.ADVANCED_SLOTS + P.SOCD_SLOTS}
        canWrite={canWrite}
        lockedNote={canWrite ? null : "Changes are off. Allow changes at the top of the page to add or remove advanced keys."}
        slotsNote={`${P.ADVANCED_SLOTS} advanced-key slots and ${P.SOCD_SLOTS} snap-tap pairs on this keyboard.`}
        flow={flow}
        setFlow={setFlow}
        layout={layout}
        keyNames={(ids) => names(st, ids)}
        setup={type === "RS" ? null : setup}
        review={review}
        canSave
        onSave={save}
      />
    </>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="px-1 text-[11.5px] text-medium">{label}</span>
      {children}
    </div>
  );
}

const DKS_COLUMNS = ["Press", "Bottom out", "Release", "Back up"];

function DksEditor({ st, form, maxMm, onChange }: { st: X68State; form: AdvForm; maxMm: number; onChange: (f: AdvForm) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[220px_repeat(4,1fr)] items-end gap-2">
        <span />
        {DKS_COLUMNS.map((c, i) => (
          <NumberField
            key={c}
            label={c}
            value={form.points[i]}
            min={0.1}
            max={maxMm}
            step={0.1}
            decimals={1}
            unit="mm"
            onChange={(v) => onChange({ ...form, points: form.points.map((p, j) => (j === i ? v : p)) })}
          />
        ))}
        {form.dks.map((a, r) => (
          <DksRow key={r} st={st} a={a} r={r} form={form} onChange={onChange} />
        ))}
      </div>
      <p className="text-[11.5px] text-medium">Click a cell to cycle: Tap fires once there, Hold starts holding, End releases a hold.</p>
    </div>
  );
}

function DksRow({ st, a, r, form, onChange }: { st: X68State; a: P.RawAction; r: number; form: AdvForm; onChange: (f: AdvForm) => void }) {
  return (
    <>
      <ActionPicker st={st} label={`Action ${r + 1}`} value={a} onChange={(v) => onChange({ ...form, dks: form.dks.map((x, j) => (j === r ? v : x)) })} />
      {[0, 1, 2, 3].map((c) => {
        const v = form.steps[r * 4 + c];
        return (
          <button
            key={c}
            onClick={() => onChange({ ...form, steps: form.steps.map((s, j) => (j === r * 4 + c ? (s + 1) % 4 : s)) })}
            className={cn(
              "h-9 rounded-control text-[12px] ring-1 transition-colors",
              v ? "bg-primary/[0.16] text-high ring-primary/45" : "bg-white/[0.03] text-medium ring-white/[0.06] hover:bg-white/[0.06]",
            )}
          >
            {STEP_LABEL[v]}
          </button>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Lighting, polling, profiles, other settings
// ---------------------------------------------------------------------------------------------

const LIGHT_NAMES: Record<number, string> = {
  0: "Static",
  1: "Breathing",
  2: "Wave",
  3: "Neon",
  4: "Radar",
  5: "Off",
  6: "Single key",
  7: "Aurora",
  8: "Ripple",
  9: "Stars",
  10: "Custom",
  11: "Crosshair",
  12: "Speed response",
  14: "Auto ripple",
  15: "Marquee",
  16: "Fireworks",
};
/** Direction illumipc picks when switching to a mode. */
const DEFAULT_DIRECTION = (mode: number) => (mode === 2 || mode === 4 || mode === 15 ? 1 : mode === 7 ? 5 : mode === 12 ? 2 : 0);
const toHex = (c: P.Rgb) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const fromHex = (h: string): P.Rgb => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });

function LightingCard({ st, canWrite, run }: { st: X68State; canWrite: boolean; run: Run }) {
  const l = st.light;
  const colorTimer = useRef(0);
  const [color, setColor] = useKeptDraft(
    `${X68}.lightColor`,
    l ? toHex(l.config.color) : "#ffffff",
    l ? `${l.config.color.r},${l.config.color.g},${l.config.color.b}` : "",
  );
  if (!l)
    return (
      <Card>
        <CardHeader title="Lighting" hint="Couldn't be read from this keyboard." />
      </Card>
    );
  const c = l.config;
  const save = (label: string, change: Partial<P.LightConfig>) => run(label, (s) => s.setLighting(label, { ...c, ...change }));
  const on = c.power === 0;
  const modes = l.modes.modes.filter((m) => m !== 10 && m !== 100);
  return (
    <Card>
      <CardHeader title="Lighting" right={<Switch checked={on} aria-label="Lighting" onCheckedChange={(v) => canWrite && save(v ? "Lights on" : "Lights off", { power: v ? 0 : 1 })} />} />
      <div className={cn("px-5 pb-5 pt-4 transition-opacity", !on && "opacity-50")}>
        <div className="flex flex-wrap gap-2">
          {modes.map((m) => (
            <Chip key={m} disabled={!canWrite} on={m === c.mode} onClick={() => m !== c.mode && save(`Lighting set to ${LIGHT_NAMES[m] ?? `effect ${m}`}`, { mode: m, direction: DEFAULT_DIRECTION(m) })}>
              {LIGHT_NAMES[m] ?? `Effect ${m}`}
            </Chip>
          ))}
          {c.mode === 10 && <Chip on onClick={() => undefined}>Custom (set in illumipc)</Chip>}
        </div>
        <LevelRow label="Brightness" value={c.brightness} max={l.modes.maxBrightness} disabled={!canWrite} onPick={(v) => save(`Brightness ${v} of ${l.modes.maxBrightness}`, { brightness: v })} />
        {c.mode !== 0 && <LevelRow label="Speed" value={c.speed} max={l.modes.maxSpeed} disabled={!canWrite} onPick={(v) => save(`Speed ${v} of ${l.modes.maxSpeed}`, { speed: v })} />}
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <span className="w-20 shrink-0 text-[12.5px] text-medium">Colour</span>
          <label
            className={cn("relative size-9 overflow-hidden rounded-full ring-1 ring-white/20 transition-transform duration-300 ease-fluid hover:scale-105", c.fullColor ? "opacity-40" : "cursor-pointer")}
            style={{ background: color, boxShadow: `0 0 18px -4px ${color}` }}
            title="Colour"
          >
            <input
              type="color"
              value={color}
              disabled={!canWrite || !!c.fullColor}
              onChange={(e) => {
                const v = e.target.value;
                setColor(v);
                window.clearTimeout(colorTimer.current);
                colorTimer.current = window.setTimeout(() => save("Lighting colour changed", { color: fromHex(v) }), 450);
              }}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
          <label className="flex items-center gap-2 text-[12.5px] text-medium">
            <Switch checked={!!c.fullColor} aria-label="Rainbow" onCheckedChange={(v) => canWrite && save(v ? "Rainbow colours on" : "Rainbow colours off", { fullColor: v ? 1 : 0 })} />
            Rainbow
          </label>
        </div>
      </div>
    </Card>
  );
}

function LevelRow({ label, value, max, disabled, onPick }: { label: string; value: number; max: number; disabled: boolean; onPick: (v: number) => void }) {
  return (
    <div className="mt-5 flex items-center gap-4">
      <span className="w-20 shrink-0 text-[12.5px] text-medium">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: max + 1 }, (_, v) => (
          <Chip key={v} numeric disabled={disabled} on={v === value} onClick={() => v !== value && onPick(v)}>
            {v}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function PollingCard({ st, canWrite, run }: { st: X68State; canWrite: boolean; run: Run }) {
  const [pending, setPending] = useKeptDraft<number | null>(`${X68}.pollingPending`, null, String(st.pollHz));
  if (!st.pollHz) return null;
  const shown = pending ?? st.pollHz;
  return (
    <Card>
      <CardHeader title="Polling rate" hint="How often the keyboard reports to the PC." />
      <div className="px-5 pb-5 pt-4">
        <GlassRadio<string>
          value={String(shown)}
          onChange={(v) => setPending(Number(v) === st.pollHz ? null : Number(v))}
          options={P.POLL_HZ.map((hz) => ({ value: String(hz), label: `${hz / 1000}K`, hint: "Hz" }))}
        />
        {pending !== null && (
          <div className="mt-3 rounded-control bg-chart-3/[0.06] px-4 py-3 text-[12.5px] leading-relaxed text-chart-3 ring-1 ring-chart-3/20">
            The keyboard restarts to switch, so it disconnects for a moment and keys won't type until it's back. SYNQ waits for it and checks the new rate.
            <div className="mt-2.5 flex gap-2">
              <button
                disabled={!canWrite}
                onClick={() => {
                  const hz = pending;
                  setPending(null);
                  run(`Polling rate set to ${hz / 1000}K`, (s) => s.setPollRate(hz));
                }}
                className="rounded-small bg-chart-3 px-3 py-1 text-[12px] font-medium text-black disabled:opacity-50"
              >
                Switch to {pending / 1000}K
              </button>
              <button onClick={() => setPending(null)} className="rounded-small px-3 py-1 text-[12px] text-chart-3/90 ring-1 ring-chart-3/30 hover:bg-chart-3/10">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function ProfileCard({ st, canWrite, run }: { st: X68State; canWrite: boolean; run: Run }) {
  if (st.profile === null)
    return (
      <Card>
        <CardHeader title="Profiles" />
        <p className="px-5 pb-5 pt-3 text-[12.5px] leading-relaxed text-medium">
          This keyboard didn't answer the profile query, so it keeps one set of settings. illumipc's Profiles 1–4 are stored in the browser, and switching them there
          rewrites the keyboard. SYNQ shows and edits what's on the keyboard now.
        </p>
      </Card>
    );
  return (
    <Card>
      <CardHeader title="Profiles" hint="Stored on the keyboard. Switching reads the new profile back." />
      <div className="flex flex-wrap gap-2 px-5 pb-5 pt-4">
        {Array.from({ length: P.PROFILE_COUNT }, (_, i) => (
          <Chip key={i} disabled={!canWrite} on={i === st.profile} onClick={() => i !== st.profile && run(i === 0 ? "Default profile" : `Profile ${i}`, (s) => s.setProfile(i))}>
            {i === 0 ? "Default" : `Profile ${i}`}
          </Chip>
        ))}
      </div>
    </Card>
  );
}

function OtherCard({ st, canWrite, run }: { st: X68State; canWrite: boolean; run: Run }) {
  const s = st.status;
  if (!s || !s.flags.lockKeyEnable) return null;
  const current: P.DeviceSettings = { ...s.winLock, superPerformance: s.flags.superPerformance, sixKey: s.flags.sixKeyMode };
  const set = (label: string, change: Partial<P.DeviceSettings>) => canWrite && run(label, (x) => x.setDeviceSettings(label, { ...current, ...change }));
  return (
    <Card>
      <CardHeader title="Win lock" hint="Keys and shortcuts the keyboard ignores while Win lock is on." />
      <div className="divide-y divide-white/[0.05] px-5 pb-3 pt-1">
        <SwitchRow title="Windows key" hint="Disable the Win key" checked={current.lockWin} onChange={(v) => set(v ? "Win key locked" : "Win key unlocked", { lockWin: v })} />
        <SwitchRow title="Alt+Tab" hint="Disable Alt+Tab" checked={current.lockAltTab} onChange={(v) => set(v ? "Alt+Tab locked" : "Alt+Tab unlocked", { lockAltTab: v })} />
        <SwitchRow title="Alt+F4" hint="Disable Alt+F4" checked={current.lockAltF4} onChange={(v) => set(v ? "Alt+F4 locked" : "Alt+F4 unlocked", { lockAltF4: v })} />
        <SwitchRow title="Shift+Tab" hint="Disable Shift+Tab" checked={current.lockShiftTab} onChange={(v) => set(v ? "Shift+Tab locked" : "Shift+Tab unlocked", { lockShiftTab: v })} />
        {s.flags.allAnd6KeySwitch && (
          <SwitchRow title="6-key mode" hint="Report at most six keys at once (for old BIOSes)" checked={current.sixKey} onChange={(v) => set(v ? "6-key mode on" : "6-key mode off", { sixKey: v })} />
        )}
      </div>
    </Card>
  );
}

