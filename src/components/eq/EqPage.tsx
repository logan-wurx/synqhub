import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, ClockCounterClockwise, FloppyDisk, Gauge, MagnifyingGlass, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { backend, type BackupInfo, type EqSnapshot, type PresetInfo, type SoundName } from "@/lib/backend";
import { autoPreamp, formatDb, peakDb, EQ_CURVE_KEY, type EqCurve, type EqState, type Filter } from "@/lib/eq";
import { setKept } from "@/lib/keep";
import { refreshSound, setSoundNames, soundLabel, useSound } from "@/lib/sound";
import { Card, CardHeader, Readout, ToggleCard, type Notice } from "@/components/ui/matte";
import { DeviceFrame, DeviceHeader, TAB_BODY, type TabDef } from "@/components/devices/shell";
import { SOUND_ID, SOUND_TABS_LEGACY, useDeviceTab } from "@/lib/nav";
import { useViewportHeight } from "@/lib/viewport";
import { Switch } from "@/components/ui/switch";
import { EqGraph } from "./EqGraph";
import { BandStrip, PreampStrip } from "./BandStrip";
import { BandFinder } from "./BandFinder";
import { Banner, EngineBanner, EngineChip, EnginePanel, type EngineAction } from "./EqEngine";
import { PowerSwitch } from "@/components/uiverse";
import { deviceIems } from "@/components/ui/brand";

// AutoEq's presets by model name: its own chunk, loaded when "Find your headphones" is opened.
const AutoEqFinder = lazy(() => import("./AutoEqFinder").then((m) => ({ default: m.AutoEqFinder })));

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

const APPLY_DEBOUNCE_MS = 250;
const FLAT: EqState = { preamp: 0, filters: [] };
const AUTO_KEY = "onboard.eq.autoPreamp";

function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}

const same = (a: EqState, b: EqState) => JSON.stringify(a) === JSON.stringify(b);
const ago = (secs: number) => {
  const d = Math.max(0, Date.now() / 1000 - secs);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(secs * 1000).toLocaleDateString();
};

export function EqPage({ notify }: { notify: Notify }) {
  const [snap, setSnap] = useState<EqSnapshot | null>(null);
  const [eq, setEq] = useState<EqState>(FLAT);
  const [auto, setAuto] = useState(readAuto);
  const [bypass, setBypass] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [markers, setMarkers] = useState<number[]>([]);
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [presetName, setPresetName] = useState("");
  const [finding, setFinding] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The EQ engine and the output it's playing through on this PC (shared with the sidebar).
  const sound = useSound();
  const engine = sound.status;
  const label = soundLabel(sound);
  const [naming, setNaming] = useState(false);
  const [engineBusy, setEngineBusy] = useState(false);
  const tabs: TabDef[] = [
    { id: "eq", label: "EQ" },
    { id: "engine", label: "Engine" },
  ];
  const vh = useViewportHeight();
  const [tab, setTab] = useDeviceTab(SOUND_ID, tabs.map((t) => t.id), SOUND_TABS_LEGACY);
  const [switched, setSwitched] = useState(false);
  const lastOutput = useRef<string | null | undefined>(undefined);
  const engineMissing = engine?.state === "missing";

  const eqRef = useRef(eq);
  eqRef.current = eq;
  const applied = useRef<EqState>(FLAT);
  const modified = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const busy = useRef(false);

  const limits = snap?.limits;
  const fs = limits?.sampleRateHz ?? 48000;
  // Nothing can be saved until the engine is there to read it.
  const readOnly = !!snap?.advanced || engineMissing;
  // The Gear page's Sound tile draws this curve (src/components/devices/EqTileArt.tsx); bypassed, it is flat.
  useEffect(() => setKept<EqCurve | null>(EQ_CURVE_KEY, { eq: bypass ? FLAT : eq, fs }), [eq, fs, bypass]);
  const peak = useMemo(() => peakDb(eq, fs), [eq, fs]);
  const maxPreamp = useMemo(() => Math.floor(-peakDb({ ...eq, preamp: 0 }, fs) * 10 + 1e-9) / 10, [eq, fs]);
  const clipping = limits ? peak > limits.peakToleranceDb : false;

  const refreshLists = useCallback(async () => {
    const [p, b] = await Promise.all([backend.eqPresets(), backend.eqBackups()]);
    setPresets(p);
    setBackups(b);
  }, []);

  const load = useCallback(async (reason?: string) => {
    try {
      const s = await backend.eqLoad();
      setSnap(s);
      setEq(s.state);
      setBypass(s.bypassed);
      bypassRef.current = s.bypassed;
      applied.current = s.state;
      modified.current = s.modified;
      setLoadError(null);
      if (reason) notify({ title: reason, tone: "info" }, "reload");
    } catch (e) {
      setLoadError(String(e));
    }
  }, [notify]);

  useEffect(() => {
    load();
    refreshLists();
  }, [load, refreshLists]);

  // Pick up edits made outside SYNQ (or a closed Editor) when the window regains focus.
  useEffect(() => {
    const onFocus = async () => {
      if (busy.current || timer.current) return;
      const s = await backend.eqLoad().catch(() => null);
      if (!s) return;
      setSnap((prev) => (prev ? { ...prev, editorOpen: s.editorOpen, advanced: s.advanced } : s));
      if (s.modified !== modified.current && (!same(s.state, applied.current) || s.bypassed !== bypassRef.current)) {
        setEq(s.state);
        setBypass(s.bypassed);
        bypassRef.current = s.bypassed;
        applied.current = s.state;
        modified.current = s.modified;
        notify({ title: "config.txt changed outside SYNQ", detail: "Loaded the new version.", tone: "info" }, "reload");
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [notify]);

  // Re-check the engine whenever the window comes back (the default output may have changed).
  useEffect(() => {
    const onFocus = () => void refreshSound();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Say so plainly when Windows switches the sound to an output without the engine.
  useEffect(() => {
    if (!engine) return;
    const id = engine.defaultOutput?.id ?? null;
    if (lastOutput.current !== undefined && lastOutput.current !== id) {
      setSwitched(true);
      setNaming(false);
      const d = engine.defaultOutput;
      if (d && !d.engine) {
        notify({ title: `Sound switched to ${d.name}`, detail: "The EQ engine isn't on it, so there's no EQ there yet.", tone: "info" }, "engine-output");
      }
    }
    lastOutput.current = id;
  }, [engine, notify]);

  const runEngine = useCallback(
    async (a: EngineAction) => {
      setEngineBusy(true);
      try {
        const out =
          a.kind === "install" ? await backend.eqEngineInstall() : a.kind === "undo" ? await backend.eqEngineUndo() : await backend.eqEngineSetup(a.output);
        if (out.result === "cancelled") {
          notify({ title: "Nothing changed", detail: "Windows asked for permission and it wasn't given.", tone: "info" }, "engine");
        } else if (!out.ok) {
          notify({ title: "The EQ engine wasn't changed", detail: out.message, tone: "error" }, "engine");
        } else {
          notify(
            {
              title: out.message,
              detail:
                out.result === "unconfirmed"
                  ? engine?.backend === "pipewire"
                    ? "Log out and back in to finish."
                    : "Restart the PC to finish."
                  : out.restartedAudio
                    ? "Your sound restarted for a moment."
                    : undefined,
              tone: out.result === "unconfirmed" ? "info" : "ok",
              action: a.kind !== "undo" && out.backup ? { label: "Undo", run: () => void runEngineRef.current({ kind: "undo" }) } : undefined,
            },
            "engine",
          );
        }
      } catch (e) {
        notify({ title: "The EQ engine wasn't changed", detail: String(e), tone: "error" }, "engine");
      } finally {
        setEngineBusy(false);
        await refreshSound();
        if (a.kind === "install") void load();
      }
    },
    [notify, load, engine?.backend],
  );
  const runEngineRef = useRef(runEngine);
  runEngineRef.current = runEngine;

  const saveName = async (name: string, picture: SoundName["picture"]) => {
    if (!label.output) return;
    try {
      setSoundNames(await backend.soundNameSave(label.output.id, name, picture));
      setNaming(false);
    } catch (e) {
      notify({ title: "Name not saved", detail: String(e), tone: "error" }, "name");
    }
  };

  /** Saves to the EQ engine's config. While bypassed the EQ is still saved, but with every filter off. */
  const write = useCallback(
    async (state: EqState, bypassed: boolean, opts: { undoTo?: EqState; title?: string } = {}) => {
      if (!limits) return false;
      const p = peakDb(state, fs);
      if (p > limits.peakToleranceDb) {
        // update() keeps the preamp under the clip point, so this is only a safety net.
        notify({ title: "Not saved: it would clip", detail: `Net peak ${formatDb(p)} dB. Lower the preamp or turn on Auto preamp.`, tone: "error" }, "save");
        return false;
      }
      busy.current = true;
      try {
        const res = await backend.eqApply(state, bypassed);
        modified.current = res.modified;
        const before = opts.undoTo;
        notify(
          {
            title: opts.title ?? (bypassed ? "Saved (EQ is bypassed, you'll hear it when you turn it back on)" : "Saved"),
            detail: bypassed ? "Previous version backed up" : `Peak ${formatDb(res.peakDb)} dB · previous version backed up`,
            tone: "ok",
            action: before ? { label: "Undo", run: () => undoTo(before) } : undefined,
          },
          "save",
        );
        refreshLists();
        return true;
      } catch (e) {
        notify({ title: "Not saved", detail: String(e), tone: "error" }, "save");
        return false;
      } finally {
        busy.current = false;
      }
    },
    // undoTo is defined below and only reads refs/setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [limits, fs, notify, refreshLists],
  );

  const undoTo = async (state: EqState) => {
    setEq(state);
    if (await write(state, bypassRef.current, { title: "Restored the previous EQ" })) applied.current = state;
  };

  const bypassRef = useRef(bypass);

  const commit = useCallback(() => {
    if (readOnly) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      timer.current = undefined;
      const state = eqRef.current;
      if (same(state, applied.current)) return;
      const before = applied.current;
      if (await write(state, bypassRef.current, { undoTo: before })) applied.current = state;
    }, APPLY_DEBOUNCE_MS);
  }, [readOnly, write]);

  /**
   * Every edit goes through here. Auto: the preamp follows the shape. Manual: your preamp is kept
   * unless the new shape would clip with it, in which case it drops just enough.
   */
  const update = useCallback(
    (next: EqState) => {
      const safe = autoPreamp(next, fs);
      setEq({ ...next, preamp: auto ? safe : Math.min(next.preamp, Math.floor(-peakDb({ ...next, preamp: 0 }, fs) * 10 + 1e-9) / 10) });
    },
    [auto, fs],
  );

  const patchFilter = useCallback(
    (index: number, patch: Partial<Filter>) => {
      const cur = eqRef.current;
      update({ ...cur, filters: cur.filters.map((f, i) => (i === index ? { ...f, ...patch } : f)) });
    },
    [update],
  );

  const addFilter = (f: Filter) => {
    const cur = eqRef.current;
    update({ ...cur, filters: [...cur.filters, f] });
    setSelected(cur.filters.length);
    commit();
  };

  const removeFilter = (index: number) => {
    const cur = eqRef.current;
    update({ ...cur, filters: cur.filters.filter((_, i) => i !== index) });
    setSelected(null);
    commit();
  };

  const toggleAuto = (on: boolean) => {
    setAuto(on);
    try {
      localStorage.setItem(AUTO_KEY, on ? "1" : "0");
    } catch {
      /* preference only */
    }
    if (on) {
      setEq((cur) => ({ ...cur, preamp: autoPreamp(cur, fs) }));
      commit();
    }
  };

  const toggleBypass = async (on: boolean) => {
    const prev = bypassRef.current;
    setBypass(on);
    bypassRef.current = on;
    const ok = await write(eqRef.current, on, { title: on ? "EQ bypassed: you're hearing flat" : "EQ back on" });
    if (ok) {
      applied.current = eqRef.current;
    } else {
      setBypass(prev);
      bypassRef.current = prev;
    }
  };

  const loadPreset = async (p: PresetInfo) => {
    const parsed = await backend.eqPresetRead(p.path).catch((e) => {
      notify({ title: "Could not read preset", detail: String(e), tone: "error" });
      return null;
    });
    if (!parsed) return;
    if (parsed.advanced) {
      notify({ title: `"${p.name}" uses features SYNQ doesn't edit`, detail: parsed.advanced, tone: "error" });
      return;
    }
    update(parsed.state);
    setSelected(null);
    commit();
  };

  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    try {
      await backend.eqPresetSave(name, eqRef.current);
      setPresetName("");
      notify({ title: `Saved preset "${name}"`, tone: "ok" }, "preset");
      refreshLists();
    } catch (e) {
      notify({ title: "Preset not saved", detail: String(e), tone: "error" }, "preset");
    }
  };

  const restore = async (b: BackupInfo) => {
    try {
      await backend.eqRestoreBackup(b.path);
      await load();
      notify({ title: "Restored backup", detail: `from ${ago(b.modified)}`, tone: "ok" }, "save");
      refreshLists();
    } catch (e) {
      notify({ title: "Restore failed", detail: String(e), tone: "error" }, "save");
    }
  };

  if (loadError) {
    return <div className="p-10 text-[14px] text-destructive">Couldn't read the EQ settings file: {loadError}</div>;
  }
  if (!snap || !limits) {
    return <div className="p-10 text-[14px] text-muted-foreground">Loading your EQ…</div>;
  }

  const activeBands = eq.filters.filter((f) => f.enabled).length;
  const graphH = Math.max(300, Math.min(620, vh - 640));
  const shownTab = tabs.some((t) => t.id === tab) ? tab : "eq";

  return (
    <DeviceFrame
      header={
      <DeviceHeader
        id={SOUND_ID}
        name={engine ? label.title : "Sound"}
        title={
          naming && label.output ? (
            <NameForm key={label.output.id} current={label.custom} placeholder={label.output.title} onSave={saveName} onCancel={() => setNaming(false)} />
          ) : (
            <div className="group mt-3 flex min-w-0 items-center gap-2">
              <h1 className="truncate text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] text-foreground">{engine ? label.title : "Sound"}</h1>
              {label.output && (
                <button
                  onClick={() => setNaming(true)}
                  title="Name your headphones (only on this PC)"
                  aria-label="Name your headphones"
                  className="rounded-full p-1.5 text-muted-foreground/45 transition-colors duration-300 hover:bg-white/[0.06] hover:text-foreground group-hover:text-muted-foreground"
                >
                  <PencilSimple size={16} weight="light" />
                </button>
              )}
            </div>
          )
        }
        subtitle={
          <>
            {engineMissing
              ? "The EQ won't play until the EQ engine is set up."
              : bypass
                ? "Bypassed: you're hearing it flat."
                : `${activeBands} band${activeBands === 1 ? "" : "s"} shaping your sound.`}
            {label.custom && label.output && <span className="text-muted-foreground/80"> · {label.output.name}</span>}
          </>
        }
        pills={<EngineChip status={engine} open={shownTab === "engine"} onClick={() => setTab("engine")} />}
        actions={
          <>
            {/* Only for headphones the person named here and chose the picture for. */}
            {label.custom?.picture === "iems" && (
              <img src={deviceIems} alt="" draggable={false} className="pointer-events-none -my-3 h-[76px] shrink-0 select-none object-contain" />
            )}
            <Readout label="Peak" value={`${formatDb(peak)} dB`} tone={clipping ? "bad" : "ok"} />
            <Readout label="Preamp" value={`${formatDb(eq.preamp)} dB`} />
          </>
        }
        tabs={tabs}
        tab={shownTab}
        onTab={setTab}
      />
      }
    >
      <div key={shownTab} className={TAB_BODY} tabIndex={0}>
        <EngineBanner status={engine} switched={switched} busy={engineBusy} onAction={runEngine} />

        {shownTab === "eq" && (
          <>
            {snap.editorOpen && (
              <Banner tone="warn">
                Close the Configuration Editor window. If you touch it while it's open, it overwrites what you set here.
              </Banner>
            )}
            {snap.advanced && (
              <Banner tone="warn">
                {snap.advanced} SYNQ can show it but won't change it. Load a preset to start an editable EQ (the current file is backed up first).
              </Banner>
            )}
            {!readOnly && clipping && auto && same(eq, applied.current) && (
              // A caution, not an error: one click lowers the preamp and nothing else changes.
              <Banner
                tone="warn"
                action={{
                  label: "Fix it",
                  onClick: () => {
                    update(eq);
                    commit();
                  },
                }}
              >
                Your EQ peaks at {formatDb(peak)} dB, so loud moments can distort. Fixing it only lowers the preamp to {formatDb(autoPreamp(eq, fs))} dB.
              </Banner>
            )}

            <Card innerClassName="px-3 pb-2 pt-4">
              <EqGraph
                state={eq}
                limits={limits}
                selected={selected}
                markers={markers}
                onSelect={setSelected}
                onFilterChange={readOnly ? () => {} : patchFilter}
                onAdd={readOnly ? () => {} : addFilter}
                onCommit={commit}
                height={graphH}
              />
              <p className="px-4 pb-2 pt-1 text-[12px] text-muted-foreground/80">
                Drag a point to move it · scroll on the selected point to change its width · double-click to add a band
              </p>
            </Card>

            <div className="-mx-1 flex gap-2.5 overflow-x-auto px-1 pb-2">
              <PreampStrip
                value={eq.preamp}
                auto={auto}
                peak={peak}
                max={maxPreamp}
                limits={limits}
                readOnly={readOnly}
                onChange={(v) => setEq((cur) => ({ ...cur, preamp: Math.min(v, maxPreamp) }))}
                onCommit={commit}
              />
              {eq.filters.map((f, i) => (
                <BandStrip
                  key={i}
                  index={i}
                  filter={f}
                  limits={limits}
                  selected={selected === i}
                  readOnly={readOnly}
                  onSelect={() => setSelected(i)}
                  onChange={(patch) => patchFilter(i, patch)}
                  onCommit={commit}
                  onRemove={() => removeFilter(i)}
                />
              ))}
              {!readOnly && eq.filters.length < limits.maxFilters && (
                <button
                  onClick={() => addFilter({ enabled: true, kind: "PK", freq: 1000, gain: -2, q: 1.41 })}
                  className="group flex w-[84px] shrink-0 flex-col items-center justify-center gap-2 rounded-[1.35rem] text-muted-foreground border border-dashed border-white/10 transition-colors duration-500 ease-fluid hover:bg-white/[0.03] hover:text-foreground"
                >
                  <span className="grid size-9 place-items-center rounded-full bg-white/[0.05] ring-1 ring-white/10 transition-transform duration-500 ease-fluid group-hover:scale-105">
                    <Plus size={16} weight="light" />
                  </span>
                  <span className="text-[12px]">Add band</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-[minmax(280px,0.85fr)_1.6fr] gap-5">
              <Card innerClassName="flex flex-col gap-1 p-3">
                <div className="flex items-center gap-4 rounded-2xl px-3 py-3">
                  <PowerSwitch checked={!bypass} onChange={(on) => toggleBypass(!on)} size={50} label={bypass ? "Turn the EQ back on" : "Bypass the EQ"} />
                  <div className="min-w-0">
                    <p className="text-[14px] text-foreground">{bypass ? "EQ off" : "EQ on"}</p>
                    <p className="text-[12.5px] text-muted-foreground">{bypass ? "Press to turn it back on" : "Press to compare with flat"}</p>
                  </div>
                </div>
                <div className="mx-3 h-px bg-white/[0.06]" />
                <ToggleCard
                  icon={Gauge}
                  title="Auto preamp"
                  status={auto ? "Keeps it from distorting" : "You're setting it by hand"}
                  checked={auto}
                  onCheckedChange={toggleAuto}
                />
                <p className="px-3 pb-1 pt-2 text-[12px] leading-relaxed text-muted-foreground/80">
                  Saves as you go. Never louder than the original, and every change is backed up.
                </p>
              </Card>

              <Card innerClassName="p-4">
                <p className="mb-3 text-[14px] font-medium tracking-tight text-foreground">Find harsh spots</p>
                <BandFinder
                  markers={markers}
                  onMark={(f) => setMarkers((m) => (m.includes(f) ? m : [...m, f].sort((a, b) => a - b)))}
                  onUnmark={(f) => setMarkers((m) => m.filter((x) => x !== f))}
                  onCut={(f) => {
                    setMarkers((m) => m.filter((x) => x !== f));
                    if (!readOnly) addFilter({ enabled: true, kind: "PK", freq: f, gain: -3, q: 2 });
                  }}
                />
              </Card>
            </div>

          <div className="grid grid-cols-[1.4fr_1fr] gap-5">
            <Card>
              <CardHeader
                title="Presets"
                hint="Save the sound you have now, or load one. Loading backs up the current file first."
                right={
                  <button
                    onClick={() => setFinding(!finding)}
                    aria-expanded={finding}
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] ring-1 transition-colors",
                      finding ? "bg-white/[0.08] text-foreground ring-white/[0.12]" : "bg-white/[0.04] text-muted-foreground ring-white/[0.08] hover:text-foreground",
                    )}
                  >
                    <MagnifyingGlass size={13} /> Find your headphones
                  </button>
                }
              />
              <div className="px-5 pb-5 pt-4">
                {finding && (
                  <div className="mb-4">
                    <Suspense fallback={null}>
                      <AutoEqFinder
                        limits={limits}
                        readOnly={readOnly}
                        notify={notify}
                        onSaved={refreshLists}
                        onUse={(state, name) => {
                          update(state);
                          setSelected(null);
                          commit();
                          notify({ title: `Using ${name}`, detail: "Your previous EQ is in History.", tone: "ok" }, "preset");
                        }}
                      />
                    </Suspense>
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && savePreset()}
                    placeholder="Name this sound…"
                    aria-label="Preset name"
                    className="h-10 flex-1 rounded-full bg-white/[0.04] px-4 text-[13.5px] text-foreground outline-none ring-1 ring-white/[0.08] placeholder:text-muted-foreground/80 focus:ring-primary/60"
                  />
                  <button
                    onClick={savePreset}
                    disabled={!presetName.trim() || clipping}
                    className="group flex h-10 items-center gap-2 rounded-full bg-foreground pl-4 pr-1.5 text-[13px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.98] disabled:opacity-40"
                  >
                    Save
                    <span className="grid size-7 place-items-center rounded-full bg-black/10 transition-transform duration-500 ease-fluid group-hover:-translate-y-px group-hover:translate-x-0.5">
                      <FloppyDisk size={14} />
                    </span>
                  </button>
                </div>
                <ul className="mt-3 max-h-[360px] divide-y divide-white/[0.05] overflow-y-auto">
                  {presets.map((p) => (
                    <li key={p.path} className="flex items-center gap-3 py-2 text-[13.5px]">
                      <span className={cn("size-1.5 rounded-full", p.source === "onboard" ? "bg-primary" : "bg-secondary")} />
                      <span className="flex-1 truncate">{p.name}</span>
                      <span className="text-[11.5px] text-muted-foreground">{p.source === "onboard" ? "Saved here" : "EQ engine folder"}</span>
                      <button
                        disabled={!p.editable || readOnly}
                        onClick={() => loadPreset(p)}
                        className="rounded-full px-3 py-1 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06] disabled:opacity-40"
                      >
                        Load
                      </button>
                      {p.source === "onboard" && (
                        <button
                          onClick={async () => {
                            await backend.eqPresetDelete(p.path);
                            refreshLists();
                          }}
                          className="rounded-full p-1.5 text-muted-foreground transition-colors hover:text-destructive"
                          title="Delete preset"
                        >
                          <Trash size={15} weight="light" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
            <Card>
              <CardHeader title="History" hint="Every save shows up here, so you can always go back." />
              <div className="px-5 pb-5 pt-3">
                {backups.length === 0 ? (
                  <p className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
                    <ClockCounterClockwise size={16} weight="light" /> Nothing saved yet.
                  </p>
                ) : (
                  <ul className="max-h-[360px] divide-y divide-white/[0.05] overflow-y-auto">
                    {backups.map((b) => (
                      <li key={b.path} className="flex items-center gap-3 py-2 text-[13.5px]">
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{new Date(b.modified * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                        <span className="text-[12px] text-muted-foreground/80">{ago(b.modified)}</span>
                        <button
                          onClick={() => restore(b)}
                          className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06]"
                        >
                          <ArrowCounterClockwise size={13} /> Restore
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          </div>
          </>
        )}

        {shownTab === "engine" &&
          (engine ? (
            <EnginePanel status={engine} busy={engineBusy} onAction={runEngine} onClose={() => setTab("eq")} />
          ) : (
            <Card innerClassName="px-6 py-8 text-[13.5px] text-muted-foreground">Reading the EQ engine…</Card>
          ))}
      </div>
    </DeviceFrame>
  );
}

/**
 * "Name your headphones": what this PC calls the headphones on the current output, kept in this
 * PC's app data only. Empty goes back to the output's own name. The IEM picture is opt-in.
 */
function NameForm({
  current,
  placeholder,
  onSave,
  onCancel,
}: {
  current: SoundName | null;
  placeholder: string;
  onSave: (name: string, picture: SoundName["picture"]) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(current?.name ?? "");
  const [picture, setPicture] = useState(current?.picture === "iems");
  const save = () => onSave(name, name.trim() && picture ? "iems" : null);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <input
        autoFocus
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") onCancel();
        }}
        placeholder={placeholder}
        aria-label="Name your headphones"
        className="h-11 w-[300px] rounded-full bg-white/[0.04] px-4 text-[18px] font-medium text-foreground outline-none ring-1 ring-white/[0.08] placeholder:text-muted-foreground/80 focus:ring-primary/60"
      />
      <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted-foreground">
        <Switch checked={picture} onCheckedChange={setPicture} aria-label="Show the IEM picture" />
        IEM picture
      </label>
      <button
        onClick={save}
        className="rounded-full bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.97]"
      >
        Save
      </button>
      <button onClick={onCancel} className="rounded-full px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
        Cancel
      </button>
      <p className="basis-full text-[12px] text-muted-foreground/80">Only on this PC. Leave it empty to use the output's own name.</p>
    </div>
  );
}
