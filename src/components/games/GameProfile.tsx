// One game's profile: which devices it changes and how, edited with the same controls as the device tabs.
// Nothing is written to a device here. ATK mice and the X68 HE: on save their settings are encoded offline with
// the driver's own frame builders (src/lib/profiles/encode.ts), from the device's last-known state, together with
// the reports that put that state back; SYNQ Helper replays them through the Rust guards. Every other mouse and
// keyboard: the profile is a feel (src/lib/feel), which SYNQ puts on through the device's own session when the game
// starts and takes off again when it ends (src/lib/profiles/runner.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, ImageSquare, Plus, Prohibit } from "@phosphor-icons/react";
import { BackButton } from "@/components/devices/shell";
import { cn } from "@/lib/utils";
import type { Connected } from "@/lib/backend";
import { Card, CardHeader, Eyebrow, type Notice } from "@/components/ui/matte";
import { Switch } from "@/components/ui/switch";
import { NumberField } from "@/components/ui/number-field";
import { StageEditor, rateLabel } from "@/components/mouse/parts";
import { Chip, SwitchRow } from "@/components/keyboard/parts";
import { cleanExe, helper, type DeviceProfile, type GamesFile } from "@/lib/helper";
import { isLinux } from "@/lib/runtime";
import { encode, familyOf, NOT_SUPPORTED, settingsFrom, type AtkSettings, type KnownDevice, type ProfileSettings, type X68Settings } from "@/lib/profiles/encode";
import { sameDevice } from "@/lib/profiles/state";
import { LIVE_PREFIX, liveSettingsOf, type LiveSettings } from "@/lib/profiles/runner";
import type { Feel } from "@/lib/profiles/live";
import { fromPage, readNow, type LiveSnapshot } from "@/lib/profiles/snapshots";
import type { KeyboardFeel, KeyboardTarget, MouseFeel, MouseTarget } from "@/lib/feel/types";
import { Cover, artFor, useArt, type GameEntry, type LiveCandidate } from "./GamesPage";
import { KeyboardFeelEditor, MOUSE_COLS, MouseFeelEditor } from "./LiveEditor";
import { familyOf as mouseFamilyOf } from "@/lib/mouse-family";
import { keyboardFamilyOf } from "@/lib/kb/probe";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

const errText = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");
/** A profile starts from the device's settings now; SOCD pairs are left as the keyboard has them. */
const startFrom = (x: LiveSnapshot): Feel => (x.kind === "keyboard" ? { ...(x.now as KeyboardFeel), socd: null } : structuredClone(x.now));

function AtkEditor({ k, value, onChange }: { k: KnownDevice & { family: "atk" }; value: AtkSettings; onChange: (v: AtkSettings) => void }) {
  const { min, max, step, maxStages } = k.atk.dpi;
  const set = (patch: Partial<AtkSettings>) => onChange({ ...value, ...patch });
  return (
    <div className={MOUSE_COLS}>
      <div className="flex flex-col gap-5">
        <div>
          <p className="mb-2 text-[12.5px] text-medium">DPI steps (the star is the one it starts on)</p>
          <div className="flex flex-wrap gap-3">
            {value.stages.map((d, i) => (
              <StageEditor
                key={i}
                index={i}
                value={d}
                isDefault={i === value.activeStage}
                step={step}
                min={min}
                max={max}
                disabled={false}
                onChange={(v) => set({ stages: value.stages.map((x, j) => (j === i ? v : x)) })}
                onDefault={() => set({ activeStage: i })}
                onRemove={value.stages.length > 1 ? () => set({ stages: value.stages.filter((_, j) => j !== i), activeStage: Math.min(value.activeStage >= i && value.activeStage > 0 ? value.activeStage - 1 : value.activeStage, value.stages.length - 2) }) : undefined}
              />
            ))}
            {value.stages.length < maxStages && (
              <button type="button" aria-label="Add a DPI step" title="Add a DPI step" onClick={() => set({ stages: [...value.stages, Math.min(max, (value.stages[value.stages.length - 1] ?? 800) * 2)] })} className="grid w-[118px] place-items-center rounded-control text-medium ring-1 ring-dashed ring-white/[0.1] hover:text-high">
                <Plus size={16} weight="light" />
              </button>
            )}
          </div>
        </div>
        <div>
          <p className="mb-2 text-[12.5px] text-medium">Polling rate</p>
          <div className="flex flex-wrap gap-1.5">
            {k.atk.pollingOptions.map((hz) => (
              <Chip key={hz} numeric on={value.pollingHz === hz} onClick={() => set({ pollingHz: hz })}>
                {rateLabel(hz)} Hz
              </Chip>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
          <div>
            <p className="mb-2 text-[12.5px] text-medium">Lift-off distance</p>
            <NumberField label="Lift-off" value={value.liftOffMm ?? 1} min={0.7} max={1.7} step={0.1} decimals={1} unit="mm" onChange={(v) => set({ liftOffMm: Math.round(v * 10) / 10 })} />
          </div>
          <div>
            <p className="mb-2 text-[12.5px] text-medium">Debounce</p>
            <div className="flex flex-wrap gap-1.5">
              {k.atk.debounceOptions.map((ms) => (
                <Chip key={ms} numeric on={value.debounceMs === ms} onClick={() => set({ debounceMs: ms })}>
                  {ms} ms
                </Chip>
              ))}
            </div>
          </div>
        </div>
        <div className="divide-y divide-white/[0.05]">
          <SwitchRow title="Motion sync" hint="Lines sensor frames up with polling; a touch smoother, a touch later." checked={value.motionSync} onChange={(motionSync) => set({ motionSync })} />
          <SwitchRow title="Angle snapping" hint="Straightens slightly wobbly lines." checked={value.angleSnapping} onChange={(angleSnapping) => set({ angleSnapping })} />
        </div>
      </div>
    </div>
  );
}

function X68Editor({ k, value, onChange }: { k: KnownDevice & { family: "x68" }; value: X68Settings; onChange: (v: X68Settings) => void }) {
  const t = k.x68.trigger;
  const set = (patch: Partial<X68Settings>) => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-4 px-5 pb-5">
      <div className="flex flex-wrap items-end gap-5">
        <div>
          <p className="mb-2 text-[12.5px] text-medium">Actuation, every key</p>
          <NumberField label="Actuation" value={value.actuationMm} min={t.minMm} max={t.maxMm} step={t.unitMm} largeStep={0.1} decimals={2} unit="mm" onChange={(actuationMm) => set({ actuationMm })} />
        </div>
        {value.rapidTrigger && (
          <>
            <div>
              <p className="mb-2 text-[12.5px] text-medium">Press sensitivity</p>
              <NumberField label="Press" value={value.pressMm} min={t.rtMinMm} max={t.rtMaxMm} step={t.unitMm} decimals={2} unit="mm" onChange={(pressMm) => set({ pressMm })} />
            </div>
            <div>
              <p className="mb-2 text-[12.5px] text-medium">Release sensitivity</p>
              <NumberField label="Release" value={value.releaseMm} min={t.rtMinMm} max={t.rtMaxMm} step={t.unitMm} decimals={2} unit="mm" onChange={(releaseMm) => set({ releaseMm })} />
            </div>
          </>
        )}
      </div>
      <SwitchRow title="Rapid trigger" hint="A key resets as soon as it starts to rise, and fires again as soon as it goes down." checked={value.rapidTrigger} onChange={(rapidTrigger) => set({ rapidTrigger })} />
    </div>
  );
}

export function GameProfile({
  entry,
  file,
  known,
  live,
  onSnapshot,
  profilesOn,
  turnOn,
  devices,
  claimed,
  notify,
  onSave,
  onBack,
}: {
  entry: GameEntry;
  file: GamesFile;
  known: KnownDevice[];
  /** The mice and keyboards that take live profiles. */
  live: LiveCandidate[];
  onSnapshot: (x: LiveSnapshot) => void;
  /** SYNQ Helper's game profiles are on (null: not known yet). */
  profilesOn: boolean | null;
  turnOn: () => Promise<void>;
  devices: Connected[];
  claimed: (exe: string) => boolean;
  notify: Notify;
  onSave: (next: GamesFile, ok?: string) => Promise<void>;
  onBack: () => void;
}) {
  const saved = entry.game?.profiles ?? {};
  const [artVersion, setArtVersion] = useState(0);
  const [ref, art] = useArt(entry, artVersion);
  const picker = useRef<HTMLInputElement | null>(null);
  const [auto, setAuto] = useState(entry.game?.auto ?? true);
  const [exes, setExes] = useState(entry.exes.join(", "));
  const [busy, setBusy] = useState(false);
  // Device key -> draft settings (present = in this profile).
  const [drafts, setDrafts] = useState<Record<string, ProfileSettings>>(() => {
    const out: Record<string, ProfileSettings> = {};
    for (const [key, p] of Object.entries(saved)) if (p.settings && !key.startsWith(LIVE_PREFIX)) out[key] = p.settings as ProfileSettings;
    return out;
  });
  // Device family -> the feel this game puts on it (present = in this profile).
  const [feels, setFeels] = useState<Record<string, Feel>>(() => {
    const out: Record<string, Feel> = {};
    for (const [key, p] of Object.entries(saved)) {
      const st = key.startsWith(LIVE_PREFIX) ? liveSettingsOf(p.settings) : null;
      if (st) out[st.family] = st.feel;
    }
    return out;
  });
  /** The family being read right now (turning it on with nothing read yet, or "Start from its settings now"). */
  const [reading, setReading] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});

  // Connected devices SYNQ can't encode offline, and supported ones it hasn't read yet.
  // A mouse or keyboard SYNQ drives at all takes a profile (encoded, or live); the rest can't.
  const unsupported = useMemo(() => devices.filter((d) => (d.kind === "mouse" || d.kind === "keyboard") && !familyOf(parseInt(d.vid, 16), parseInt(d.pid, 16)) && !mouseFamilyOf(d) && !keyboardFamilyOf(d)), [devices]);
  const unread = useMemo(
    () => devices.filter((d) => familyOf(parseInt(d.vid, 16), parseInt(d.pid, 16)) && !known.some((k) => k.vendorId === parseInt(d.vid, 16) && k.productId === parseInt(d.pid, 16))),
    [devices, known],
  );
  useEffect(() => setProblems({}), [drafts, feels]);

  /** What the device holds and can take: its page's (nothing sent), what was read before, or read now. */
  const describe = async (c: LiveCandidate, fresh: boolean): Promise<LiveSnapshot | null> => {
    const fromItsPage = c.connected ? fromPage(c.family, c.name) : null;
    if (fromItsPage) return onSnapshot(fromItsPage), fromItsPage;
    if (c.snapshot && !fresh) return c.snapshot;
    if (!c.connected) return c.snapshot;
    setReading(c.family);
    try {
      const x = await readNow(c.family, c.name);
      onSnapshot(x);
      return x;
    } catch (e) {
      notify({ title: `Couldn't read ${c.name}`, detail: errText(e), tone: "error" }, "games");
      return null;
    } finally {
      setReading(null);
    }
  };

  // The device strip: what can be in this profile, then what can't (yet).
  const items = [
    ...known.map((k) => ({ id: `enc:${k.key}`, name: k.name, on: !!(drafts[k.key] ?? Object.keys(drafts).find((key) => sameDevice(key, k.key))) })),
    ...live.map((c) => ({ id: `live:${c.family}`, name: c.name, on: !!feels[c.family] })),
    ...unread.map((d) => ({ id: `unread:${d.vid}:${d.pid}`, name: d.name, on: false })),
    ...unsupported.map((d) => ({ id: `none:${d.vid}:${d.pid}`, name: d.name, on: false })),
  ];
  const [picked, setPicked] = useState<string | null>(null);
  const current = items.find((i) => i.id === picked) ?? items.find((i) => i.on) ?? items[0] ?? null;
  const currentKnown = current?.id.startsWith("enc:") ? (known.find((k) => `enc:${k.key}` === current.id) ?? null) : null;
  const currentLive = current?.id.startsWith("live:") ? (live.find((c) => `live:${c.family}` === current.id) ?? null) : null;

  const toggleLive = async (c: LiveCandidate, on: boolean) => {
    if (!on) return setFeels((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== c.family)));
    const savedFeel = liveSettingsOf(saved[`${LIVE_PREFIX}${c.family}`]?.settings)?.feel;
    if (savedFeel) return setFeels((f) => ({ ...f, [c.family]: savedFeel }));
    const x = await describe(c, false);
    if (x) setFeels((f) => ({ ...f, [c.family]: startFrom(x) }));
  };

  const fromNow = async (c: LiveCandidate) => {
    const x = await describe(c, true);
    if (x) setFeels((f) => ({ ...f, [c.family]: startFrom(x) }));
  };

  const toggle = (k: KnownDevice, on: boolean) =>
    setDrafts((d) => {
      const next = { ...d };
      if (on) next[k.key] = saved[k.key]?.settings ? (saved[k.key].settings as ProfileSettings) : settingsFrom(k);
      else delete next[k.key];
      return next;
    });

  const save = async () => {
    const list = exes.split(",").map((s) => s.trim()).filter(Boolean);
    const clean: string[] = [];
    for (const raw of list) {
      const c = cleanExe(raw);
      if ("error" in c) return notify({ title: "That program name won't work", detail: c.error, tone: "error" }, "games");
      if (claimed(c.exe)) return notify({ title: `${c.exe} belongs to another game`, tone: "error" }, "games");
      if (!clean.includes(c.exe)) clean.push(c.exe);
    }
    if (!clean.length || clean.length > 4) return notify({ title: "Name 1 to 4 programs", detail: isLinux ? "The game's .exe (Proton), or a native game's program name as System Monitor shows it." : "The game's .exe as Task Manager's Details tab shows it.", tone: "error" }, "games");
    const profiles: Record<string, DeviceProfile> = {};
    const bad: Record<string, string> = {};
    const now = Math.floor(Date.now() / 1000);
    for (const [key, s] of Object.entries(drafts)) {
      const k = known.find((x) => sameDevice(x.key, key));
      if (!k) continue;
      try {
        const e = encode(k, s);
        const same = saved[key] && JSON.stringify(saved[key].settings) === JSON.stringify(s) && JSON.stringify(saved[key].steps) === JSON.stringify(e.steps);
        profiles[k.key] = { name: k.name, vendorId: k.vendorId, productId: k.productId, steps: e.steps, restore: e.restore, settings: s, saved: same ? saved[key].saved : now };
      } catch (err) {
        bad[key] = err instanceof Error ? err.message : String(err);
      }
    }
    for (const [family, feel] of Object.entries(feels)) {
      const c = live.find((x) => x.family === family);
      const key = `${LIVE_PREFIX}${family}`;
      const settings: LiveSettings = { kind: "feel", family, feel };
      const same = saved[key] && JSON.stringify(saved[key].settings) === JSON.stringify(settings);
      profiles[key] = { name: c?.name ?? saved[key]?.name ?? family, vendorId: 0, productId: 0, steps: [], restore: [], settings, saved: same ? saved[key].saved : now };
    }
    setProblems(bad);
    if (Object.keys(bad).length) return;
    const game = { id: entry.id, name: entry.name, exes: clean, builtin: entry.game?.builtin ?? entry.source === "builtin", appid: entry.appid, auto, profiles };
    const games = file.games.some((g) => g.id === entry.id) ? file.games.map((g) => (g.id === entry.id ? game : g)) : [...file.games, game];
    setBusy(true);
    try {
      await onSave({ ...file, games }, Object.keys(profiles).length ? `${entry.name} profile saved` : `${entry.name} has no profile now`);
      if (Object.keys(profiles).length && profilesOn === false)
        notify({ title: "Game profiles are off", detail: "Turn them on to have this one follow the game.", tone: "info", action: { label: "Turn on", run: () => void turnOn() } }, "games-on");
    } catch (e) {
      notify({ title: "Couldn't save the profile", detail: String(e), tone: "error" }, "games");
    } finally {
      setBusy(false);
    }
  };

  const pickImage = async (f: File | undefined) => {
    if (!f) return;
    try {
      await helper.setArt(entry.id, f);
      await artFor(entry, true);
      setArtVersion((v) => v + 1);
    } catch (e) {
      notify({ title: "That image wasn't used", detail: String(e instanceof Error ? e.message : e), tone: "error" }, "games");
    }
  };
  const defaultImage = async () => {
    await helper.clearArt(entry.id);
    await artFor(entry, true);
    setArtVersion((v) => v + 1);
  };

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-8 pb-[120px] pt-7 [&>*]:shrink-0" data-slot="game-profile">
      <BackButton onClick={onBack}>All games</BackButton>
      <header className="flex items-end gap-5">
        <div ref={ref} className="w-[320px] shrink-0 overflow-hidden rounded-control ring-1 ring-white/[0.08]">
          <Cover url={art} name={entry.name} exes={entry.exes} className="aspect-[460/215]" />
        </div>
        <div className="min-w-0 flex-1 pb-1">
          <Eyebrow>Game profile</Eyebrow>
          <h1 className="mt-3 truncate text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] text-high">{entry.name}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={exes}
              onChange={(e) => setExes(e.target.value)}
              aria-label="Program names"
              placeholder="game.exe"
              className="tabular h-8 w-[300px] rounded-small bg-white/[0.04] px-3.5 text-[12.5px] text-high outline-none ring-1 ring-white/[0.08] focus:ring-primary/60"
            />
            <button type="button" onClick={() => picker.current?.click()} className="inline-flex items-center gap-1.5 rounded-small px-3 py-1.5 text-[12.5px] text-high ring-1 ring-white/10 hover:bg-white/[0.06]">
              <ImageSquare size={12} />
              Choose image
            </button>
            <button type="button" onClick={() => void defaultImage()} className="rounded-small px-3 py-1.5 text-[12.5px] text-medium hover:text-high">
              Default image
            </button>
            <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => void pickImage(e.target.files?.[0])} />
          </div>
        </div>
        <label className="flex max-w-[340px] shrink-0 cursor-pointer items-start gap-4 pb-1">
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] text-high">Apply automatically</span>
            <span className="block text-[12.5px] leading-relaxed text-medium">On when {exes.split(",")[0]?.trim() || "the game"} starts; your everyday settings come back when it ends.</span>
          </span>
          <Switch checked={auto} onCheckedChange={setAuto} aria-label="Apply automatically" />
        </label>
      </header>

      {/* One device at a time: the strip says which are in this profile, the card below edits the one picked. */}
      <nav aria-label="Devices" className="flex flex-wrap gap-2" data-slot="profile-devices">
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            aria-pressed={current?.id === i.id}
            onClick={() => setPicked(i.id)}
            title={i.id.startsWith("none:") ? NOT_SUPPORTED : undefined}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-full px-4 text-[13px] ring-1 transition-colors duration-200",
              current?.id === i.id ? "bg-white/[0.08] text-high ring-white/[0.16]" : "text-medium ring-white/[0.07] hover:text-high",
            )}
          >
            {i.id.startsWith("none:") ? <Prohibit size={13} className="shrink-0" /> : <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", i.on ? "bg-primary" : "bg-white/20")} />}
            <span className="max-w-[220px] truncate">{i.name}</span>
            <span className="sr-only">{i.on ? "(in this profile)" : ""}</span>
          </button>
        ))}
      </nav>

      {!current && (
        <Card innerClassName="px-5 py-4">
          <p className="text-[13px] text-medium">Plug in your mouse or keyboard to give this game its settings.</p>
        </Card>
      )}

      {currentKnown &&
        (() => {
          const k = currentKnown;
          const s = drafts[k.key] ?? Object.entries(drafts).find(([key]) => sameDevice(key, k.key))?.[1];
          return (
            <Card>
              <CardHeader title={k.name} hint={s ? "In this profile" : "Not changed by this game"} right={<Switch checked={!!s} onCheckedChange={(v) => toggle(k, v)} aria-label={`Change ${k.name} for this game`} />} />
              {s && k.family === "atk" && s.family === "atk" && <AtkEditor k={k} value={s.atk} onChange={(atk) => setDrafts((d) => ({ ...d, [k.key]: { family: "atk", atk } }))} />}
              {s && k.family === "x68" && s.family === "x68" && <X68Editor k={k} value={s.x68} onChange={(x68) => setDrafts((d) => ({ ...d, [k.key]: { family: "x68", x68 } }))} />}
              {problems[k.key] && <p className="px-5 pb-4 text-[12.5px] text-chart-3">{problems[k.key]}</p>}
            </Card>
          );
        })()}

      {currentLive &&
        (() => {
          const c = currentLive;
          const feel = feels[c.family];
          const x = c.snapshot;
          const busyReading = reading === c.family;
          const hint = busyReading ? "Reading its settings" : feel ? "In this profile" : c.connected || x ? "Not changed by this game" : "Plug it in to add it";
          return (
            <Card>
              <CardHeader
                title={c.name}
                hint={hint}
                right={
                  <div className="flex items-center gap-3">
                    {feel && c.connected && (
                      <button type="button" disabled={busyReading} onClick={() => void fromNow(c)} title="Start again from what it holds now" className="inline-flex items-center gap-1.5 rounded-small px-2.5 py-1 text-[12px] text-medium ring-1 ring-white/10 hover:text-high disabled:opacity-60">
                        <ArrowCounterClockwise size={12} />
                        Use current settings
                      </button>
                    )}
                    <Switch checked={!!feel} disabled={busyReading || (!feel && !c.connected && !x)} onCheckedChange={(v) => void toggleLive(c, v)} aria-label={`Change ${c.name} for this game`} />
                  </div>
                }
              />
              {feel && x && x.kind === "mouse" && "stages" in feel && <MouseFeelEditor target={x.target as MouseTarget} value={feel as MouseFeel} onChange={(v) => setFeels((f) => ({ ...f, [c.family]: v }))} />}
              {feel && x && x.kind === "keyboard" && "actuationMm" in feel && <KeyboardFeelEditor target={x.target as KeyboardTarget} value={feel as KeyboardFeel} onChange={(v) => setFeels((f) => ({ ...f, [c.family]: v }))} />}
              {feel && !x && <p className="px-5 pb-4 text-[12.5px] text-medium">Plug it in to edit these settings. They stay in the profile meanwhile.</p>}
            </Card>
          );
        })()}

      {current?.id.startsWith("unread:") && (
        <Card innerClassName="px-5 py-4">
          <p className="text-[14px] text-high">{current.name}</p>
          <p className="mt-0.5 text-[12.5px] text-medium">Open it from Devices once, so SYNQ knows its current settings.</p>
        </Card>
      )}
      {current?.id.startsWith("none:") && (
        <Card innerClassName="px-5 py-4">
          <p className="text-[14px] text-high">{current.name}</p>
          <p className="mt-0.5 text-[12.5px] text-medium">{NOT_SUPPORTED}.</p>
        </Card>
      )}

      <div className="flex items-center gap-3">
        <button type="button" disabled={busy} onClick={() => void save()} className={cn("rounded-control bg-foreground px-4 py-2 text-[13px] font-medium text-background", busy && "opacity-60")}>
          Save profile
        </button>
        {Object.keys(saved).length > 0 && (
          <button
            type="button"
            onClick={() => {
              setDrafts({});
              setFeels({});
              notify({ title: "Profile cleared", detail: "Save to keep it that way.", tone: "info" }, "games");
            }}
            className="rounded-control px-3.5 py-2 text-[13px] text-medium ring-1 ring-white/10 hover:text-high"
          >
            Remove profile
          </button>
        )}
        <span className="text-[12px] text-medium">Nothing is sent while you edit. Same safety checks as the device pages; no firmware, pairing, remaps or resets are ever part of a profile.</span>
      </div>
    </div>
  );
}
