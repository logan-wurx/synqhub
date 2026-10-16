// The Keyboard page's panel for every keyboard SYNQ has no hand-built code for (VIA / Vial boards,
// @openmouse/keyboard-protocol keyboards, and later Wave 2's drivers). It is built from what the
// driver reports (KbState) and shows only what the keyboard has: analog keys, keymap and layers,
// lighting, polling, profiles, other options, macros (read-only) and device info. Every change goes
// through KbSession (src/lib/kb/session.ts): backup first, then the write, then a read-back.
// No Tauri here: the host comes in as a prop.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowsLeftRight, CaretDown, Hourglass, ShieldCheck, Stack } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { isWeb, type Connected } from "@/lib/backend";
import type { KbHost } from "@/lib/kb/host";
import type { KbSession } from "@/lib/kb/session";
import {
  type AnalogField,
  type AnalogValues,
  type DksStep,
  type SocdMode,
  type KbAnyChange,
  type KbKey,
  type KbLayout,
  type KbOption,
  type KbTier,
  type KbView,
  type KeyIndex,
  type LightingSetting,
  type NumberSpec,
} from "@/lib/kb/types";
import { Card, CardHeader, DetailRows, type Notice } from "@/components/ui/matte";
import { FeelCard, FeelOffer, type FeelDevice } from "@/components/feel/FeelPanel";
import { driveGenericKeyboard, type ApplyOutcome } from "@/lib/feel/drive";
import { feelStore } from "@/lib/feel/persist";
import type { Step } from "@/lib/feel/types";
import { DeviceFrame, DeviceHeader, OverviewHero, ReconnectButton, StatusPill, StatusStrip, TAB_BODY, TierBadge, type TabDef } from "@/components/devices/shell";
import { KeyBoard, MmSlider, ModeSwitch, SelectionBar, type MapKey, type MapLayout } from "@/components/devices/keymap";
import { AdvancedKeysFlow, MULTI_ACTION_LEGALITY, SOCD_LEGALITY, type ActiveKey, type AdvFlow, type AdvType } from "@/components/devices/advkeys";
import { LiveTravel, type LiveSource } from "@/components/devices/live";
import { keyboardId, KEYBOARD_TABS_LEGACY, useDeviceTab } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { linkOf } from "@/lib/device-model";
import { NumberField } from "@/components/ui/number-field";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { Switch } from "@/components/ui/switch";
import { GlassRadio } from "@/components/uiverse";
import { deviceKeyboard } from "@/components/ui/brand";
import { peekKept, useKeptRef, useKeptScroll, useKeptState } from "@/lib/keep";
import { track, useSessionHold } from "@/lib/device-session";
import { markKeyboardAnswering } from "@/lib/kb/probe";
import { AdvancedCard } from "@/components/advanced";
import { Banner, Chip, EmptyCard, Pill, Select } from "./parts";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;
type Phase = { kind: "connecting" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "ready" };

const message = (e: unknown) => String(e).replace(/^Error: /, "");
const rateLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}K` : String(hz));
const mm = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? "—" : `${+v.toFixed(d)}`);

const ANALOG_LABEL: Record<AnalogField, string> = {
  actuationMm: "Actuation",
  releaseMm: "Release point",
  rapidTrigger: "Rapid trigger",
  rtPressMm: "Rapid trigger press",
  rtReleaseMm: "Rapid trigger release",
  deadTopMm: "Top dead zone",
  deadBottomMm: "Bottom dead zone",
};

export function GenericKeyboard({
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
  getHost: () => Promise<KbHost>;
  notify: Notify;
  visible: boolean;
  switcher: ReactNode;
}) {
  const K = `keyboard.kb.${id}`;
  const session = useKeptRef<KbSession | null>(`${K}.session`, null);
  const [phase, setPhase] = useKeptState<Phase>(`${K}.phase`, { kind: "connecting" });
  const [view, setView] = useKeptState<KbView | null>(`${K}.view`, null);
  const [busy, setBusy] = useKeptState(`${K}.busy`, false);
  const [allow, setAllow] = useKeptState(`${K}.allow`, false);
  const [layer, setLayer] = useKeptState(`${K}.layer`, 0);
  const [selected, setSelected] = useKeptState<KeyIndex[]>(`${K}.selected`, []);
  const [live, setLive] = useState(true);
  const connecting = useKeptRef<Promise<boolean> | null>(`${K}.connecting`, null);
  const quietError = useKeptRef<string | null>(`${K}.quietError`, null);
  const entry = devices.find((d) => `${d.vid}:${d.pid}` === id);

  useEffect(() => {
    if (phase.kind === "ready") markKeyboardAnswering(`kb:${id}`);
  }, [phase.kind, id]);

  const connect = useCallback(
    (quiet = false): Promise<boolean> => {
      const work = (async () => {
        if (!quiet) setPhase({ kind: "connecting" });
        await session.current?.close().catch(() => undefined);
        session.current = null;
        try {
          const host = await getHost();
          setLive(host.live);
          const { connectKeyboard } = await import("@/lib/kb/host");
          const s = await connectKeyboard(host, id);
          if (!s) {
            if (quiet) quietError.current = "The keyboard isn't plugged in.";
            else setPhase({ kind: "missing" });
            return false;
          }
          session.current = s;
          quietError.current = null;
          setView(s.setAllowChanges(peekKept(`${K}.allow`, false)));
          setPhase({ kind: "ready" });
          return true;
        } catch (e) {
          if (quiet) quietError.current = message(e);
          else setPhase({ kind: "error", message: message(e) });
          return false;
        }
      })();
      connecting.current = work;
      void work.finally(() => {
        if (connecting.current === work) connecting.current = null;
      });
      return track(K, work);
    },
    [K, id, getHost, setPhase, setView, session, connecting, quietError],
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

  useSessionHold(K, async () => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    resume.current = connectedFor.current;
    connectedFor.current = false;
    await s.close();
  });

  const run = async (change: KbAnyChange) => {
    if (busy) return;
    if (!session.current && phase.kind === "ready") {
      await (connecting.current ?? connect(true));
      if (!session.current) {
        notify({ title: "Not changed", detail: quietError.current ?? "The keyboard didn't answer.", tone: "error" }, "keyboard");
        return;
      }
    }
    const s = session.current;
    if (!s) return;
    setBusy(true);
    try {
      const r = await track(K, s.apply(change));
      setView(r.view);
      const label = labelOf(change);
      notify({ title: r.verdict === "mismatch" ? `${label}: didn't take` : label, detail: r.detail, tone: r.verdict === "mismatch" ? "error" : r.verdict === "confirmed" ? "ok" : "info" }, "keyboard");
      if (r.verdict !== "mismatch") void feelStore.noteConfigured("keyboard", keyboardId(`kb:${id}`));
    } catch (e) {
      notify({ title: "Not changed", detail: message(e), tone: "error" }, "keyboard");
      await s.refresh().then(setView, () => undefined);
    } finally {
      setBusy(false);
    }
  };

  /** "Keep your feel": a plan's steps through this same KbSession (backup first, each change read back). */
  const applyFeel = async (steps: Step[]): Promise<ApplyOutcome<unknown>> => {
    const stop = (error: string): ApplyOutcome<unknown> => ({ ok: false, done: 0, total: steps.length, error, view: null });
    if (busy || !view) return stop("Another change is still being saved.");
    if (!session.current && phase.kind === "ready") {
      await (connecting.current ?? connect(true));
      if (!session.current) return stop(quietError.current ?? "The keyboard didn't answer.");
    }
    const s = session.current;
    if (!s) return stop("The keyboard isn't connected.");
    setBusy(true);
    try {
      const r = await track(K, driveGenericKeyboard(s, s.view, steps, setView));
      if (r.done) void feelStore.noteConfigured("keyboard", keyboardId(`kb:${id}`));
      if (!r.ok) await s.refresh().then(setView, () => undefined);
      return r;
    } finally {
      setBusy(false);
    }
  };

  const toggleAllow = (on: boolean) => {
    setAllow(on);
    const s = session.current;
    if (s) setView(s.setAllowChanges(on));
  };

  const v = view;
  const can = (g: keyof KbView["writable"]) => !!v && v.writable[g] && !busy;

  // What this keyboard has decides the tabs.
  const hasLive = typeof (session.current?.backend as { live?: unknown } | undefined)?.live === "function";
  const analog = v?.analog;
  const keymap = v?.keymap;
  const rtFields = !!analog && (!!analog.fields.rapidTrigger || !!analog.fields.rtPressMm || !!analog.fields.rtReleaseMm);
  const wide = useWide();
  const asideOn = wide && phase.kind === "ready" && !!v;
  const tabs: TabDef[] = [
    ...(asideOn ? [] : [{ id: "overview", label: "Overview" }]),
    ...(analog || hasLive ? [{ id: "keys", label: "Keys" }] : []),
    ...(v?.advanced ? [{ id: "advkeys", label: "Advanced Keys" }] : []),
    ...(keymap || v?.lighting || v?.profiles ? [{ id: "remap", label: "Remap & Lighting" }] : []),
    { id: "advanced", label: "Advanced" },
  ];
  const navId = keyboardId(`kb:${id}`);
  const [tab, pickTab] = useDeviceTab(navId, tabs.map((t) => t.id), KEYBOARD_TABS_LEGACY);
  const goTab = (t: string) => {
    setSelected([]);
    pickTab(t);
  };
  const body = useKeptScroll(`${K}.scroll.${tab}`);
  const [flow, setFlow] = useKeptState<AdvFlow | null>(`${K}.advFlow`, null);
  const [keysModeRaw, setKeysMode] = useKeptState<"actuation" | "rapid">(`${K}.keysMode`, "actuation");
  const keysMode = rtFields ? keysModeRaw : "actuation";
  const modeSwitch = rtFields ? (
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
  ) : null;

  // The board drawn once for every tab: the keymap's layout, else the analog one, else the keys in a row.
  const layout = keymap?.layout ?? analog?.layout ?? (analog ? analogLayout(analog.keys ?? []) : null);
  const drawn = !!layout && layout.keys.length > 0;
  const analogKeys = useMemo(() => new Set(analog?.keys ?? layout?.keys.map((k) => k.index) ?? []), [analog, layout]);
  const layerNow = Math.min(layer, (keymap?.layers ?? 1) - 1);
  const codes = keymap ? (keymap.codes[tab === "remap" ? layerNow : 0] ?? null) : null;
  const keyText = (k: KbKey) => (codes && keymap?.label ? keymap.label(codes[k.index] ?? 0) : (k.label ?? ""));

  const mapFor = (kind: "actuation" | "rapid" | "remap" | "adv"): MapLayout | null => {
    if (!layout || !drawn) return null;
    const g = analog?.global ?? null;
    return {
      width: layout.width,
      height: layout.height,
      keys: layout.keys.map((k) => {
        const own = analog?.perKey[k.index];
        let mark: MapKey["mark"];
        if (kind === "actuation" && analog) {
          const val = own?.actuationMm ?? g?.actuationMm;
          if (val !== undefined && val !== null) mark = { text: mm(val, 2), tone: g?.actuationMm !== undefined && g.actuationMm !== null && own?.actuationMm !== undefined && own.actuationMm !== g.actuationMm ? "lit" : undefined };
        } else if (kind === "rapid" && analog) {
          const on = own?.rapidTrigger ?? g?.rapidTrigger;
          const press = own?.rtPressMm ?? g?.rtPressMm;
          mark = on ? { text: press !== undefined && press !== null ? mm(press, 2).replace(/^0/, "") : "RT", tone: "lit" } : { text: on === undefined ? "—" : "off" };
        }
        return {
          id: k.index,
          x: k.x,
          y: k.y,
          w: k.w,
          h: k.h,
          r: k.r,
          rx: k.rx,
          ry: k.ry,
          label: keyText(k),
          locked: (kind === "actuation" || kind === "rapid") && analog ? !analogKeys.has(k.index) : false,
          title: keyText(k) || `Key ${k.index}`,
          mark,
        };
      }),
    };
  };
  const mapLabel = (ids: KeyIndex[]) => ids.map((i) => { const k = layout?.keys.find((x) => x.index === i); return (k && keyText(k)) || `Key ${i}`; }).join(", ");

  /** The live source for the Actuation tab, if the driver has one. A new object each time the tab opens. */
  const openLive = useCallback((): LiveSource | null => {
    const b = session.current?.backend as { live?: (o?: { maxHz?: number }) => LiveSource } | undefined;
    return b?.live ? b.live({ maxHz: 30 }) : null;
  }, [session]);
  const scanToIndex = useMemo(() => {
    const m = new Map<number, KeyIndex>();
    const c0 = keymap?.codes[0];
    if (c0) for (const [idx, code] of Object.entries(c0)) if (code > 0 && code < 0x100) m.set(code, Number(idx));
    return m;
  }, [keymap]);

  const analogCard = (kind: "actuation" | "rapid", title: string, hint: string, only: AnalogField[]) => {
    if (!analog) return null;
    const map = mapFor(kind);
    const perKeyScope = analog.scope !== "global";
    const globalScope = analog.scope !== "per-key";
    return (
      <>
        {perKeyScope && map && (
          <Card>
            <CardHeader title={title} hint={hint} right={
                <div className="flex items-center gap-2">
                  {modeSwitch}
                  <GroupTier tier={v!.groupTier.analog} />
                </div>
              }
            />
            <div className="px-5 pb-5 pt-4">
              <KeyBoard layout={map} selected={selected} onSelect={setSelected} label={title} />
              <SelectionBar
                count={selected.length}
                names={mapLabel(selected)}
                onSelectAll={() => setSelected([...analogKeys])}
                onDiscard={() => setSelected([])}
              >
                <AnalogInspector analog={analog} target={selected} only={only} disabled={!can("analog")} run={run} />
              </SelectionBar>
              {layout?.note && <p className="mt-2 text-[11.5px] text-muted-foreground/80">{layout.note}</p>}
            </div>
          </Card>
        )}
        {globalScope && (
          <Card>
            <CardHeader title="Whole keyboard" hint={analog.scope === "global" ? "One setting for every key on this keyboard." : "The default for keys without their own value."} right={perKeyScope ? undefined : <div className="flex items-center gap-2">{modeSwitch}<GroupTier tier={v!.groupTier.analog} /></div>} />
            <div className="px-5 pb-5 pt-4">
              <AnalogInspector analog={analog} target="global" only={only} disabled={!can("analog")} run={run} />
            </div>
          </Card>
        )}
        {analog.note && <p className="px-1 text-[11.5px] text-muted-foreground/80">{analog.note}</p>}
      </>
    );
  };

  const feel: FeelDevice | undefined = v
    ? {
        id: keyboardId(`kb:${id}`),
        kind: "keyboard",
        family: `kb:${id}`,
        name: v.name,
        brand: v.brand,
        view: v,
        notify,
        apply: applyFeel,
        gate: {
          // Analog settings and SOCD pairs have their own tiers; the plan names the first one that is locked.
          writable: v.writable.analog || v.writable.advanced,
          reason: v.lockedReason ?? "This keyboard can't be changed from SYNQ yet.",
          allow: v.canAllow ? { on: allow && v.allowChanges, set: toggleAllow } : undefined,
          check: (steps) => {
            const locked = (group: "analog" | "advanced") => !v.writable[group];
            const why = v.lockedReason ?? "That can't be changed on this keyboard yet.";
            if (steps.some((s) => s.kind === "socd") && locked("advanced")) return why;
            if (steps.some((s) => s.kind !== "socd") && locked("analog")) return why;
            return null;
          },
        },
      }
    : undefined;

  const overview = phase.kind === "ready" && !!v ? (
<KbOverview v={v} id={id} feel={feel} />
  ) : null;

  return (
    <DeviceFrame
      aside={overview}
      header={
      <DeviceHeader
        id={navId}
        name={v?.name ?? entry?.name ?? "Keyboard"}
        subtitle={
          <>
            {v ? `${v.brand}${v.info.protocol ? ` · ${v.info.protocol}` : ""}` : (entry?.brand ?? "Keyboard")}
            {!live && <span className="text-chart-3"> · sample keyboard</span>}
          </>
        }
        pills={
          <>
            <StatusPill live={phase.kind === "ready"}>{phase.kind === "ready" && v ? v.info.connection : phase.kind === "connecting" ? "Connecting" : "Not connected"}</StatusPill>
            {v && <TierBadge tier={v.tier} hint={v.tierWhy} />}
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
        onTab={goTab}
      />
      }
    >
      <div key={tab} ref={body} className={TAB_BODY} tabIndex={0}>
        {phase.kind === "connecting" && <EmptyCard title="Looking for your keyboard…" text="Reading its settings. Nothing is changed." image={deviceKeyboard} pulse />}
        {phase.kind === "missing" && <EmptyCard title="Plug it in" text="Connect it with its USB cable, and close the maker's app if it's open." plug />}
        {phase.kind === "error" && <EmptyCard title="Couldn't talk to the keyboard" text={phase.message} plug />}

        {phase.kind === "ready" && v && (
          <>
            {v.notes.map((n) => (
              <Banner key={n} tone="info">
                {n}
              </Banner>
            ))}
            {v.canAllow && <AllowCard allowed={allow && v.allowChanges} onChange={toggleAllow} tested={Object.entries(v.groupTier).some(([, t]) => t === "driver-tested")} />}

            {tab === "overview" && overview}

            {tab === "keys" && keysMode === "actuation" && (
              <>
                {analogCard("actuation", "Actuation, key by key", "Every key shows its actuation point in mm. Tinted keys differ from the board's default. Select keys to change them together.", ["actuationMm", "releaseMm", "deadTopMm", "deadBottomMm"])}
                {hasLive && (
                  <Card>
                    <CardHeader title="Live key travel" hint="Press keys to see how far each one goes. The line is its actuation point." />
                    <LiveTravel
                      open={openLive}
                      travelMm={analog?.travelMm ?? 4}
                      actuationMm={(code) => {
                        const idx = scanToIndex.get(code);
                        const own = idx === undefined ? undefined : analog?.perKey[idx]?.actuationMm;
                        return own ?? analog?.global?.actuationMm ?? null;
                      }}
                    />
                  </Card>
                )}
              </>
            )}

            {tab === "keys" && keysMode === "rapid" &&
              analogCard("rapid", "Rapid trigger, key by key", "Tinted keys use rapid trigger and show their press distance in mm. Select keys to change them together.", ["rapidTrigger", "rtPressMm", "rtReleaseMm"])}

            {tab === "advkeys" && v.advanced && (
              <GenericAdvancedKeys
                v={v}
                flow={flow}
                setFlow={setFlow}
                can={can("advanced")}
                map={mapFor("adv")}
                stateKey={K}
                keyName={(i) => mapLabel([i])}
                keyNames={mapLabel}
                run={run}
              />
            )}

            {tab === "remap" && keymap && (
              <Card>
                <CardHeader
                  title="Remap"
                  hint="Click a key to see what it sends, and change it on this layer."
                  right={
                    <div className="flex items-center gap-2">
                      {Array.from({ length: keymap.layers }, (_, l) => (
                        <Chip key={l} numeric on={l === layerNow} onClick={() => (setLayer(l), setSelected([]))}>
                          Layer {l}
                        </Chip>
                      ))}
                      <GroupTier tier={v.groupTier.keymap} />
                    </div>
                  }
                />
                <div className="px-5 pb-5 pt-4">
                  {mapFor("remap") ? (
                    <>
                      <KeyBoard layout={mapFor("remap")!} selected={selected} onSelect={setSelected} multi={false} label="Remap" />
                      <SelectionBar count={selected.length} names={mapLabel(selected)} onDiscard={() => setSelected([])} hint="Select a key">
                        <KeymapInspector keymap={keymap} layer={layerNow} selected={selected} label={keymap.label ?? ((c: number) => (c ? `0x${c.toString(16)}` : ""))} disabled={!can("keymap") || !keymap.writable} run={run} />
                      </SelectionBar>
                      {layout?.note && <p className="mt-2 text-[11.5px] text-muted-foreground/80">{layout.note}</p>}
                    </>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">This keyboard's layout isn't known, so its keys can't be drawn.</p>
                  )}
                  {keymap.note && <p className="mt-2 text-[11.5px] text-muted-foreground/80">{keymap.note}</p>}
                </div>
              </Card>
            )}

            {tab === "remap" && v.lighting && (
              <Card>
                <CardHeader title="Lighting" hint={v.lighting.note} right={<GroupTier tier={v.groupTier.lighting} />} />
                <div className="flex flex-col gap-4 px-5 pb-5 pt-4">
                  {v.lighting.groups.map((g) => (
                    <div key={g.id} className="rounded-2xl bg-white/[0.02] px-4 py-3 ring-1 ring-white/[0.05]">
                      <p className="mb-2 text-[13px] text-foreground">{g.label}</p>
                      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                        {g.settings.map((s) => (
                          <LightingRow key={s.id} setting={s} disabled={!can("lighting") || !s.writable} onChange={(value) => run({ kind: "lighting", id: s.id, value })} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {tab === "remap" && v.profiles && (
              <Card>
                <CardHeader title="Profile" hint={v.profiles.note ?? "The profile the keyboard runs."} right={<GroupTier tier={v.groupTier.profiles} />} />
                <div className="flex flex-wrap gap-2 px-5 pb-5 pt-4">
                  {Array.from({ length: Math.max(1, v.profiles.count ?? (v.profiles.active ?? 0) + 1) }, (_, i) => (
                    <Chip key={i} on={i === v.profiles!.active} disabled={!can("profiles") || !v.profiles!.writable} onClick={() => i !== v.profiles!.active && run({ kind: "profile", index: i })}>
                      {v.profiles!.names[i] || `Profile ${i + 1}`}
                    </Chip>
                  ))}
                </div>
              </Card>
            )}

            {tab === "advanced" && (
              <>
                {(v.polling || !!v.options?.length) && (
                  <div className={cn("grid gap-5", v.polling && v.options?.length ? "grid-cols-[1.45fr_1fr]" : "grid-cols-1")}>
                    {v.polling && (
                      <Card>
                        <CardHeader title="Polling rate" hint={v.polling.note ?? "Reports per second."} right={<GroupTier tier={v.groupTier.polling} />} />
                        <div className={cn("px-5 pb-5 pt-4", (!can("polling") || !v.polling.writable) && "pointer-events-none opacity-60")}>
                          <GlassRadio<string>
                            value={String(v.polling.hz ?? "")}
                            onChange={(hz) => run({ kind: "polling", hz: Number(hz) })}
                            options={v.polling.options.slice(-7).map((hz) => ({ value: String(hz), label: rateLabel(hz), hint: "Hz" }))}
                          />
                        </div>
                      </Card>
                    )}
                    {!!v.options?.length && (
                      <Card>
                        <CardHeader title="Options" right={<GroupTier tier={v.groupTier.options} />} />
                        <div className="flex flex-col gap-3 px-5 pb-5 pt-4">
                          {v.options.map((o) => (
                            <OptionRow key={o.id} option={o} disabled={!can("options") || !o.writable} onChange={(value) => run({ kind: "option", id: o.id, value })} />
                          ))}
                        </div>
                      </Card>
                    )}
                  </div>
                )}

                {v.macros && (
                  <Card>
                    <CardHeader title="Macros" hint={v.macros.note ?? "Shown, not changed."} />
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 px-5 pb-5 pt-3">
                      {v.macros.summaries.map((m, i) => (
                        <p key={i} className="truncate text-[12.5px] text-muted-foreground">
                          <span className="tabular mr-2 text-foreground/80">M{i}</span>
                          {m}
                        </p>
                      ))}
                    </div>
                  </Card>
                )}

                {session.current && (
                  <AdvancedCard
                    id={`kb.${id}`}
                    panel={session.current.advanced}
                    lockedReason={v.lockedReason}
                    notify={notify}
                    hold={(p) => track(K, p)}
                    onChanged={() => void session.current?.refresh().then(setView)}
                    renderKeys={
                      keymap
                        ? ({ label, selected, onPick, indexes }) => (
                            <KeyBoard
                              layout={{
                                width: keymap.layout.width,
                                height: keymap.layout.height,
                                keys: keymap.layout.keys.map((k) => ({
                                  id: k.index,
                                  x: k.x,
                                  y: k.y,
                                  w: k.w,
                                  h: k.h,
                                  r: k.r,
                                  rx: k.rx,
                                  ry: k.ry,
                                  label: indexes.includes(k.index) ? label(k.index) : "",
                                  locked: !indexes.includes(k.index),
                                })),
                              }}
                              selected={selected === null ? [] : [selected]}
                              multi={false}
                              onSelect={(ids) => ids[0] !== undefined && onPick(ids[0])}
                              label="Keys"
                            />
                          )
                        : undefined
                    }
                  />
                )}

                <NeverSends view={v} />
                <p className="px-1 text-[12px] leading-relaxed text-muted-foreground/80">
                  {v.tierWhy} Before the first change SYNQ saves everything it read{v.backupPath ? ` (${v.backupPath})` : ""}, and it reads each change back. Every change is logged {isWeb ? "in this browser" : "in its data folder"}.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </DeviceFrame>
  );
}

/** The Overview tab: the board, the connection, and what it is set to right now. */
function KbOverview({ v, id, feel }: { v: KbView; id: string; feel?: FeelDevice }) {
  const a = v.analog;
  const g = a?.global ?? null;
  const per = Object.values(a?.perKey ?? {});
  const pick = (f: (x: AnalogValues) => number | null | undefined): number | null => {
    const gv = g ? f(g) : undefined;
    if (gv !== undefined && gv !== null) return gv;
    const counts = new Map<number, number>();
    for (const x of per) {
      const val = f(x);
      if (val !== undefined && val !== null) counts.set(val, (counts.get(val) ?? 0) + 1);
    }
    return [...counts].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  };
  const actuation = pick((x) => x.actuationMm);
  const rtOn = (g?.rapidTrigger ? 1 : 0) + per.filter((x) => x.rapidTrigger).length;
  const rtKnown = g?.rapidTrigger !== undefined || per.some((x) => x.rapidTrigger !== undefined && x.rapidTrigger !== null);
  const press = pick((x) => x.rtPressMm);
  const release = pick((x) => x.rtReleaseMm);
  const prof = v.profiles?.active;
  return (
    <>
      {feel && <FeelOffer {...feel} />}
      <OverviewHero
        art={<DeviceArt spec={{ kind: "keyboard", family: `kb:${id}`, name: v.name, brand: v.brand }} />}
        live
        connection={linkOf(v.info.connection) ?? null}
        name={v.name}
        detail={`${v.brand}${v.info.protocol ? ` · ${v.info.protocol}` : ""}. What the keyboard reports right now is below.`}
        badges={<TierBadge tier={v.tier} hint={v.tierWhy} />}
      />
      <StatusStrip
        stats={[
          { label: "Type", value: a ? "Analog" : "Standard", note: a ? (a.scope === "global" ? "One actuation point" : "Per-key actuation") : "Fixed actuation" },
          { label: "Actuation", value: actuation === null ? "—" : `${mm(actuation, 2)} mm` },
          { label: "Rapid trigger", value: !a || !rtKnown ? "—" : rtOn ? "On" : "Off" },
          { label: "Sensitivity", value: press === null ? "—" : release !== null && release !== press ? `${mm(press, 2)} / ${mm(release, 2)} mm` : `${mm(press, 2)} mm` },
          { label: "Profile", value: prof === null || prof === undefined ? "—" : v.profiles?.names[prof] || `Profile ${prof + 1}` },
        ]}
      />
      {feel && <FeelCard {...feel} />}
      <Card innerClassName="px-6 py-4">
        <DetailRows
          rows={[
            ["Firmware", <span className="tabular block max-w-[320px] truncate text-[12px]" title={v.info.firmware.join(", ")}>{v.info.firmware.join(" · ") || "—"}</span>],
            ...(v.info.extra ?? []).map(([k, val]) => [k, <span className="block max-w-[320px] truncate text-[12px]">{val}</span>] as [string, ReactNode]),
            ...(v.info.serial ? ([["Serial", <span className="tabular text-[12px]">{v.info.serial}</span>]] as [string, ReactNode][]) : []),
            ["USB id", <span className="tabular text-[12px]">{id}</span>],
          ]}
        />
      </Card>
    </>
  );
}

function labelOf(change: KbAnyChange): string {
  switch (change.kind) {
    case "analog":
      return `${Object.keys(change.values).map((k) => ANALOG_LABEL[k as AnalogField]).join(", ")} set`;
    case "keycode":
      return `Key changed on layer ${change.layer}`;
    case "lighting":
      return "Lighting changed";
    case "polling":
      return `Polling rate set to ${rateLabel(change.hz)} Hz`;
    case "profile":
      return `Profile ${change.index + 1}`;
    case "option":
      return "Option changed";
    case "socd":
      return change.mode === "last" ? "Snap tap set" : "SOCD pair set";
    case "dks":
      return "Dynamic keystroke set";
    case "modTap":
      return "Mod-tap set";
    case "advancedClear":
      return "Advanced keys cleared";
  }
}

// ---------------------------------------------------------------------------------------------
// Keys: analog settings and keymap on the board's own layout
// ---------------------------------------------------------------------------------------------

/** A keyboard with analog settings but no keymap: its analog keys in a row. */
function analogLayout(keys: readonly KeyIndex[]): KbLayout {
  return { source: "matrix", width: Math.max(1, Math.min(16, keys.length)), height: Math.max(1, Math.ceil(keys.length / 16)), keys: keys.map((index, i) => ({ index, x: i % 16, y: Math.floor(i / 16), w: 1, h: 1 })) };
}

/**
 * The controls that apply to the picked keys (or the whole keyboard): a slider for each number the board has,
 * a switch for each on/off field, and one Apply. `only` limits it to the fields of the tab it sits on.
 */
function AnalogInspector({
  analog,
  target,
  only,
  disabled,
  run,
}: {
  analog: NonNullable<KbView["analog"]>;
  target: "global" | KeyIndex[];
  only: AnalogField[];
  disabled: boolean;
  run: (c: KbAnyChange) => Promise<void>;
}) {
  const global = target === "global";
  const selected = global ? [] : target;
  const seed: AnalogValues = global ? (analog.global ?? {}) : (analog.perKey[selected[0]] ?? analog.global ?? {});
  const seedKey = `${global ? "g" : selected.join()}|${JSON.stringify(seed)}|${only.join()}`;
  const [draft, setDraft] = useState<AnalogValues>(seed);
  useEffect(() => setDraft(seed), [seedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const entries = Object.entries(analog.fields).filter(([f, spec]) => spec && only.includes(f as AnalogField)) as [AnalogField, NumberSpec | "toggle"][];
  const sliders = entries.filter(([, spec]) => spec !== "toggle") as [AnalogField, NumberSpec][];
  const toggles = entries.filter(([, spec]) => spec === "toggle").map(([f]) => f);
  if (!entries.length) return <p className="text-[13px] text-muted-foreground">This keyboard has no settings of this kind.</p>;
  const raw = draft as Record<string, unknown>;
  const was = seed as Record<string, unknown>;
  const changed = Object.fromEntries(entries.filter(([f]) => raw[f] !== was[f] && raw[f] !== undefined && raw[f] !== null).map(([f]) => [f, raw[f]])) as AnalogValues;
  const dirty = Object.keys(changed).length > 0;
  const canChange = entries.some(([f]) => analog.writable.includes(f));
  return (
    <div className="flex flex-col gap-3.5">
      {global && <p className="text-[13px] text-muted-foreground">Whole keyboard</p>}
      {!global && selected.length > 1 && <p className="text-[12px] text-muted-foreground">Showing the first key's values; applying sets all {selected.length}.</p>}
      <div className="flex flex-wrap items-end gap-x-7 gap-y-4">
        {toggles.map((f) => (
          <label key={f} className={cn("flex h-9 items-center gap-2.5 text-[12.5px] text-muted-foreground", (!analog.writable.includes(f) || disabled) && "pointer-events-none opacity-60")}>
            <Switch checked={raw[f] === true} aria-label={ANALOG_LABEL[f]} onCheckedChange={(on) => setDraft({ ...draft, [f]: on })} />
            {ANALOG_LABEL[f]}
          </label>
        ))}
        {sliders.map(([f, spec]) => (
          <MmSlider
            key={f}
            label={ANALOG_LABEL[f]}
            value={typeof raw[f] === "number" ? (raw[f] as number) : spec.min}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            decimals={spec.decimals ?? (spec.step < 0.1 ? 2 : 1)}
            disabled={!analog.writable.includes(f) || disabled}
            onChange={(val) => setDraft({ ...draft, [f]: val })}
            className="w-[250px]"
          />
        ))}
      </div>
      {canChange && (
        <div className="flex items-center gap-2">
          <Pill primary disabled={!dirty || disabled} onClick={() => void run({ kind: "analog", target: global ? "global" : selected, values: changed })}>
            Apply to {global ? "the keyboard" : selected.length === 1 ? "this key" : `${selected.length} keys`}
          </Pill>
          {dirty && (
            <Pill onClick={() => setDraft(seed)} disabled={disabled}>
              Undo
            </Pill>
          )}
        </div>
      )}
    </div>
  );
}

function KeymapInspector({
  keymap,
  layer,
  selected,
  label,
  disabled,
  run,
}: {
  keymap: NonNullable<KbView["keymap"]>;
  layer: number;
  selected: KeyIndex[];
  label: (code: number) => string;
  disabled: boolean;
  run: (c: KbAnyChange) => Promise<void>;
}) {
  const key = selected[0];
  const code = key === undefined ? null : (keymap.codes[layer]?.[key] ?? null);
  const groups = useMemo(() => {
    const by = new Map<string, { value: string; label: string }[]>();
    for (const a of keymap.assignable) (by.get(a.group) ?? by.set(a.group, []).get(a.group)!).push({ value: String(a.code), label: a.label });
    return [...by].map(([g, options]) => ({ label: g, options }));
  }, [keymap.assignable]);
  const [pick, setPick] = useState<string>("");
  useEffect(() => setPick(code === null ? "" : String(code)), [code, key, layer]);
  if (key === undefined) return null;
  const assignable = keymap.assignable.some((a) => String(a.code) === pick);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-[13px] text-foreground">
        <span className="text-muted-foreground">Layer {layer}: </span>
        {code === null ? "—" : label(code) || (code === 0 ? "None" : `0x${code.toString(16)}`)}
        {code !== null && <span className="tabular ml-2 text-[11.5px] text-muted-foreground">0x{code.toString(16).padStart(4, "0")}</span>}
      </p>
      {keymap.writable && groups.length > 0 && (
        <div className="ml-auto flex items-center gap-2">
          <Select<string> label="New key" value={assignable ? pick : ""} onChange={setPick} groups={[{ options: [{ value: "", label: "Pick a key…" }] }, ...groups]} className="w-[180px]" />
          <Pill primary disabled={disabled || !assignable || Number(pick) === code} onClick={() => void run({ kind: "keycode", layer, key, code: Number(pick) })}>
            Put on key
          </Pill>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Advanced keys: snap tap / SOCD, dynamic keystroke, mod-tap (what the driver offers)
// ---------------------------------------------------------------------------------------------

const SOCD_MODE_LABEL: Record<SocdMode, string> = {
  last: "Last pressed wins (snap tap)",
  neutral: "Both cancel out (neutral)",
  priorityA: "First key always wins",
  priorityB: "Second key always wins",
  first: "First pressed wins",
  deeper: "The deeper press wins",
  deeperSingle: "The deeper press wins (single key)",
};
const DKS_STEPS: DksStep[] = ["none", "tap", "hold", "release"];
const DKS_STEP_LABEL: Record<DksStep, string> = { none: "·", tap: "Tap", hold: "Hold", release: "Release" };
const DKS_COLUMNS = ["Press", "Bottom out", "Let go from bottom", "Fully up"];

interface AdvForm {
  socdMode: SocdMode;
  tap: string;
  hold: string;
  holdMs: number;
  dks: { code: string; steps: DksStep[] }[];
}
const blankAdv = (): AdvForm => ({ socdMode: "last", tap: "", hold: "", holdMs: 150, dks: [{ code: "", steps: ["tap", "none", "none", "none"] }] });

function GenericAdvancedKeys({
  v,
  stateKey,
  flow,
  setFlow,
  can,
  map,
  keyName,
  keyNames,
  run,
}: {
  v: KbView;
  stateKey: string;
  flow: AdvFlow | null;
  setFlow: (f: AdvFlow | null) => void;
  can: boolean;
  map: MapLayout | null;
  keyName: (i: KeyIndex) => string;
  keyNames: (ids: KeyIndex[]) => string;
  run: (c: KbAnyChange) => Promise<void>;
}) {
  const adv = v.advanced!;
  const keymap = v.keymap;
  const [form, setForm] = useKeptState<AdvForm>(`${stateKey}.advForm`, blankAdv);
  const can_ = new Set(adv.writable);
  const groups = useMemo(() => {
    const by = new Map<string, { value: string; label: string }[]>();
    for (const a of keymap?.assignable ?? []) (by.get(a.group) ?? by.set(a.group, []).get(a.group)!).push({ value: String(a.code), label: a.label });
    return [{ options: [{ value: "", label: "Pick a key…" }] }, ...[...by].map(([g, options]) => ({ label: g, options }))];
  }, [keymap]);
  const codeText = (c: string) => (c === "" ? "nothing" : (keymap?.assignable.find((a) => String(a.code) === c)?.label ?? `0x${Number(c).toString(16)}`));

  const socdPairs = adv.socd?.pairs ?? [];
  const dksKeys = adv.dks?.keys ?? [];
  const modTapKeys = adv.modTap?.keys ?? [];
  const nKeys = map?.keys.length ?? 0;
  const max = (adv.socd ? (adv.socd.maxPairs ?? Math.max(1, Math.floor(nKeys / 2))) : 0) + (adv.dks?.slots ?? 0) + (adv.modTap ? Math.max(modTapKeys.length, nKeys) : 0);

  const needsKeys = keymap && keymap.assignable.length > 0 ? null : "Needs the key list, which this keyboard didn't give.";
  const types: AdvType[] = [
    ...(adv.socd
      ? [
          {
            id: "socd",
            title: "Snap tap (SOCD)",
            blurb: "Two opposite keys, like A and D. Choose what happens when both are held, so strafing turns around at once.",
            icon: ArrowsLeftRight,
            pick: 2 as const,
            steps: ["Pick the two keys", "Choose what wins", "Review"] as const,
            legality: SOCD_LEGALITY,
            unavailable: !can_.has("socd") ? "This keyboard's driver can't change it yet." : adv.socd.maxPairs !== undefined && socdPairs.length >= adv.socd.maxPairs ? "All pair slots are used." : null,
          },
        ]
      : []),
    ...(adv.dks
      ? [
          {
            id: "dks",
            title: "Dynamic keystroke (DKS)",
            blurb: "One key does up to four different things, depending on how far you press it and where you let go.",
            icon: Stack,
            pick: 1 as const,
            steps: ["Pick the key", "Set the actions", "Review"] as const,
            legality: MULTI_ACTION_LEGALITY,
            unavailable: !can_.has("dks") ? "This keyboard's driver can't change it yet." : needsKeys ?? (dksKeys.length >= adv.dks.slots ? "All slots are used." : null),
          },
        ]
      : []),
    ...(adv.modTap
      ? [
          {
            id: "modTap",
            title: "Mod-tap (tap and hold)",
            blurb: "Tap the key for one thing, hold it for another. For example: tap for Esc, hold for Ctrl.",
            icon: Hourglass,
            pick: 1 as const,
            steps: ["Pick the key", "Set tap and hold", "Review"] as const,
            unavailable: !can_.has("modTap") ? "This keyboard's driver can't change it yet." : needsKeys,
          },
        ]
      : []),
  ];

  const clear = (keys: KeyIndex[]) => void run({ kind: "advancedClear", keys });
  const active: ActiveKey[] = [
    ...socdPairs.map((p) => ({
      id: `socd-${p.keys.join("-")}`,
      typeId: "socd",
      title: `Snap tap: ${keyName(p.keys[0])} and ${keyName(p.keys[1])}`,
      detail: SOCD_MODE_LABEL[p.mode] ?? p.mode,
      legality: SOCD_LEGALITY,
      onRemove: () => clear([...p.keys]),
    })),
    ...dksKeys.map((k) => ({ id: `dks-${k}`, typeId: "dks", title: `Dynamic keystroke on ${keyName(k)}`, detail: "Set on the keyboard", onRemove: () => clear([k]) })),
    ...modTapKeys.map((k) => ({ id: `mt-${k}`, typeId: "modTap", title: `Mod-tap on ${keyName(k)}`, detail: "Tap and hold set on the keyboard", onRemove: () => clear([k]) })),
  ];

  const type = flow?.typeId;
  const setup =
    type === "socd" ? (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-foreground">
          <span className="text-muted-foreground">Keys: </span>
          {flow ? keyNames(flow.keys) : ""}
        </p>
        <div className="flex flex-col gap-1">
          <span className="px-1 text-[11.5px] text-muted-foreground">When both are held</span>
          <Select<SocdMode>
            label="SOCD mode"
            value={form.socdMode}
            groups={[{ options: adv.socd!.modes.map((m) => ({ value: m, label: SOCD_MODE_LABEL[m] })) }]}
            onChange={(socdMode) => setForm({ ...form, socdMode })}
            className="w-[260px]"
          />
        </div>
      </div>
    ) : type === "modTap" ? (
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="px-1 text-[11.5px] text-muted-foreground">Tap</span>
          <Select<string> label="Tap key" value={form.tap} groups={groups} onChange={(tap) => setForm({ ...form, tap })} className="w-[200px]" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="px-1 text-[11.5px] text-muted-foreground">Hold</span>
          <Select<string> label="Hold key" value={form.hold} groups={groups} onChange={(hold) => setForm({ ...form, hold })} className="w-[200px]" />
        </div>
        <NumberField
          label="Hold after"
          value={form.holdMs}
          min={adv.modTap!.holdMs.min}
          max={adv.modTap!.holdMs.max}
          step={adv.modTap!.holdMs.step}
          unit="ms"
          onChange={(holdMs) => setForm({ ...form, holdMs })}
          className="w-[120px]"
        />
      </div>
    ) : type === "dks" ? (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-[210px_repeat(4,1fr)] items-end gap-2">
          <span />
          {DKS_COLUMNS.map((c) => (
            <span key={c} className="px-1 text-center text-[11.5px] text-muted-foreground">
              {c}
            </span>
          ))}
          {form.dks.slice(0, adv.dks!.bindingsPerKey).map((row, r) => (
            <div key={r} className="contents">
              <Select<string>
                label={`Action ${r + 1}`}
                value={row.code}
                groups={groups}
                onChange={(code) => setForm({ ...form, dks: form.dks.map((x, j) => (j === r ? { ...x, code } : x)) })}
                className="w-[210px]"
              />
              {row.steps.map((step, c) => (
                <button
                  key={c}
                  onClick={() => setForm({ ...form, dks: form.dks.map((x, j) => (j === r ? { ...x, steps: x.steps.map((s2, k) => (k === c ? DKS_STEPS[(DKS_STEPS.indexOf(s2) + 1) % 4] : s2)) } : x)) })}
                  className={cn(
                    "h-9 rounded-xl text-[12px] ring-1 transition-colors",
                    step !== "none" ? "bg-primary/[0.16] text-foreground ring-primary/45" : "bg-white/[0.03] text-muted-foreground ring-white/[0.06] hover:bg-white/[0.06]",
                  )}
                >
                  {DKS_STEP_LABEL[step]}
                </button>
              ))}
            </div>
          ))}
        </div>
        {form.dks.length < adv.dks!.bindingsPerKey && (
          <button
            onClick={() => setForm({ ...form, dks: [...form.dks, { code: "", steps: ["none", "none", "none", "none"] }] })}
            className="self-start rounded-full px-3 py-1.5 text-[12.5px] text-muted-foreground ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.05] hover:text-foreground"
          >
            Add an action
          </button>
        )}
        <p className="text-[11.5px] text-muted-foreground">Click a cell to cycle it: Tap fires once there, Hold starts holding, Release lets go.</p>
      </div>
    ) : null;

  const dksRows = form.dks.filter((r) => r.code !== "");
  const canSave = type === "modTap" ? form.tap !== "" && form.hold !== "" : type === "dks" ? dksRows.length > 0 : true;
  const review = (
    <div className="text-[13px] text-foreground">
      <p>
        <span className="text-muted-foreground">{flow && flow.keys.length > 1 ? "Keys: " : "Key: "}</span>
        {flow ? keyNames(flow.keys) : ""}
      </p>
      <p className="mt-1.5 text-[12.5px] text-muted-foreground">
        {type === "socd" && SOCD_MODE_LABEL[form.socdMode]}
        {type === "modTap" && `Tap sends ${codeText(form.tap)}, hold sends ${codeText(form.hold)} after ${form.holdMs} ms.`}
        {type === "dks" && `${dksRows.map((r) => codeText(r.code)).join(", ") || "No actions"}.`}
      </p>
    </div>
  );

  const save = async () => {
    if (!flow) return;
    if (flow.typeId === "socd" && flow.keys.length === 2) await run({ kind: "socd", keys: [flow.keys[0], flow.keys[1]], mode: form.socdMode });
    else if (flow.typeId === "modTap") await run({ kind: "modTap", key: flow.keys[0], hold: Number(form.hold), tap: Number(form.tap), holdMs: form.holdMs });
    else if (flow.typeId === "dks")
      await run({ kind: "dks", key: flow.keys[0], bindings: dksRows.map((r) => ({ code: Number(r.code), steps: [r.steps[0], r.steps[1], r.steps[2], r.steps[3]] as const })) });
    setFlow(null);
  };

  return (
    <AdvancedKeysFlow
      types={types}
      active={active}
      max={max}
      canWrite={can}
      lockedNote={can ? null : (v.lockedReason ?? "Advanced keys can't be changed on this keyboard right now.")}
      slotsNote={adv.note}
      flow={flow}
      setFlow={setFlow}
      layout={map ?? { width: 1, height: 1, keys: [] }}
      keyNames={keyNames}
      setup={setup}
      review={review}
      canSave={canSave}
      onSave={() => void save()}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

function LightingRow({ setting, disabled, onChange }: { setting: LightingSetting; disabled: boolean; onChange: (v: number | readonly [number, number]) => void }) {
  const [draft, setDraft] = useState(setting.value);
  useEffect(() => setDraft(setting.value), [JSON.stringify(setting.value)]); // eslint-disable-line react-hooks/exhaustive-deps
  const wrap = (body: ReactNode) => (
    <div className={cn("flex flex-col gap-1.5", disabled && "pointer-events-none opacity-60")}>
      <span className="text-[12.5px] text-muted-foreground">{setting.label}</span>
      {body}
    </div>
  );
  if (setting.value === null) return wrap(<span className="text-[12.5px] text-muted-foreground/80">Not reported</span>);
  if (setting.kind === "toggle") return wrap(<Switch checked={draft === 1} onCheckedChange={(on) => onChange(on ? 1 : 0)} aria-label={setting.label} />);
  if (setting.kind === "choice" && setting.choice)
    return wrap(
      <Select<string> label={setting.label} value={String(draft)} onChange={(x) => onChange(Number(x))} groups={[{ options: setting.choice.options.map((o) => ({ value: String(o.value), label: `${o.value} · ${o.label}` })) }]} />,
    );
  if (setting.kind === "color" && Array.isArray(draft)) {
    const [h, s] = draft as readonly [number, number];
    return wrap(
      <div className="flex items-center gap-3">
        <span className="size-7 shrink-0 rounded-full ring-1 ring-white/10" style={{ background: `hsl(${(h / 255) * 360} ${(s / 255) * 100}% 50%)` }} />
        <div className="flex flex-1 flex-col gap-1">
          <input type="range" min={0} max={255} value={h} aria-label="Hue" onChange={(e) => setDraft([Number(e.target.value), s])} onPointerUp={() => onChange([h, s])} onKeyUp={() => onChange([h, s])} className="accent-[var(--primary)]" />
          <input type="range" min={0} max={255} value={s} aria-label="Saturation" onChange={(e) => setDraft([h, Number(e.target.value)])} onPointerUp={() => onChange([h, s])} onKeyUp={() => onChange([h, s])} className="accent-[var(--primary)]" />
        </div>
      </div>,
    );
  }
  const spec = setting.spec ?? { min: 0, max: 255, step: 1, unit: "level" as const };
  const n = typeof draft === "number" ? draft : spec.min;
  return wrap(
    <div className="flex items-center gap-3">
      <input type="range" aria-label={setting.label} min={spec.min} max={spec.max} step={spec.step} value={n} onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={() => onChange(n)} onKeyUp={() => onChange(n)} className="flex-1 accent-[var(--primary)]" />
      <span className="tabular w-9 text-right text-[12.5px] text-foreground">{n}</span>
    </div>,
  );
}

function OptionRow({ option, disabled, onChange }: { option: KbOption; disabled: boolean; onChange: (v: number) => void }) {
  return (
    <div className={cn("flex items-center gap-3", disabled && "pointer-events-none opacity-60")}>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-foreground">{option.label}</span>
        {option.hint && <span className="block text-[11.5px] text-muted-foreground">{option.hint}</span>}
      </span>
      {option.kind === "toggle" && <Switch checked={option.value === 1} onCheckedChange={(on) => onChange(on ? 1 : 0)} aria-label={option.label} />}
      {option.kind === "choice" &&
        option.choice?.options.map((o) => (
          <Chip key={o.value} on={o.value === option.value} disabled={disabled} onClick={() => o.value !== option.value && onChange(o.value)}>
            {o.label}
          </Chip>
        ))}
      {option.kind === "range" && <span className="tabular text-[13px] text-foreground">{option.value ?? "—"}</span>}
    </div>
  );
}

function NeverSends({ view }: { view: KbView }) {
  const [open, setOpen] = useState(false);
  if (!view.blocked.length) return null;
  return (
    <Card innerClassName="px-5 py-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left text-[13px] text-foreground">
        <ShieldCheck size={16} className="text-primary" />
        What SYNQ never sends this keyboard
        <CaretDown size={13} className={cn("ml-auto text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="mt-3 flex flex-col gap-1.5 pl-6">
          {view.blocked.map((b) => (
            <li key={b.what} className="list-disc text-[12.5px] text-muted-foreground">
              {b.what}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** A group's tier when it differs from "read-only" (driver-tested groups get the amber chip). */
function GroupTier({ tier }: { tier: KbTier }) {
  if (tier === "read-only") return null;
  return <TierBadge tier={tier} />;
}

function AllowCard({ allowed, onChange, tested }: { allowed: boolean; onChange: (on: boolean) => void; tested: boolean }) {
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
        <p className="text-[15px] font-medium text-foreground">{tested ? "Some settings are read-only until you allow changes" : "Read-only until you allow changes"}</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
          SYNQ hasn't been tried on this keyboard{tested ? ", so only what its driver's authors tested can be changed now" : ""}. Everything below was read from it. When you allow changes, SYNQ saves a
          backup first and reads every change back.
        </p>
      </div>
      <Switch checked={false} onCheckedChange={onChange} aria-label="Allow changes" />
    </Card>
  );
}
