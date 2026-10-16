// One game's profile: which devices it changes and how, edited with the same controls as the device tabs.
// Nothing is sent to a device here. On save each device's settings are encoded offline with its driver's
// own frame builders (src/lib/profiles/encode.ts), from the device's last-known state, together with the
// reports that put that state back; SYNQ Helper replays them through the Rust guards.
import { useEffect, useMemo, useRef, useState } from "react";
import { ImageSquare, Plus, Prohibit } from "@phosphor-icons/react";
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
import { Cover, artFor, useArt, type GameEntry } from "./GamesPage";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

function AtkEditor({ k, value, onChange }: { k: KnownDevice & { family: "atk" }; value: AtkSettings; onChange: (v: AtkSettings) => void }) {
  const { min, max, step, maxStages } = k.atk.dpi;
  const set = (patch: Partial<AtkSettings>) => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-5 px-5 pb-5">
      <div>
        <p className="mb-2 text-[12.5px] text-muted-foreground">DPI steps (the star is the one it starts on)</p>
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
            <button type="button" aria-label="Add a DPI step" title="Add a DPI step" onClick={() => set({ stages: [...value.stages, Math.min(max, (value.stages[value.stages.length - 1] ?? 800) * 2)] })} className="grid w-[118px] place-items-center rounded-2xl text-muted-foreground ring-1 ring-dashed ring-white/[0.1] hover:text-foreground">
              <Plus size={16} />
            </button>
          )}
        </div>
      </div>
      <div>
        <p className="mb-2 text-[12.5px] text-muted-foreground">Polling rate</p>
        <div className="flex flex-wrap gap-1.5">
          {k.atk.pollingOptions.map((hz) => (
            <Chip key={hz} numeric on={value.pollingHz === hz} onClick={() => set({ pollingHz: hz })}>
              {rateLabel(hz)} Hz
            </Chip>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
        <div>
          <p className="mb-2 text-[12.5px] text-muted-foreground">Lift-off distance</p>
          <NumberField label="Lift-off" value={value.liftOffMm ?? 1} min={0.7} max={1.7} step={0.1} decimals={1} unit="mm" onChange={(v) => set({ liftOffMm: Math.round(v * 10) / 10 })} />
        </div>
        <div>
          <p className="mb-2 text-[12.5px] text-muted-foreground">Debounce</p>
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
  );
}

function X68Editor({ k, value, onChange }: { k: KnownDevice & { family: "x68" }; value: X68Settings; onChange: (v: X68Settings) => void }) {
  const t = k.x68.trigger;
  const set = (patch: Partial<X68Settings>) => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-4 px-5 pb-5">
      <div className="flex flex-wrap items-end gap-5">
        <div>
          <p className="mb-2 text-[12.5px] text-muted-foreground">Actuation, every key</p>
          <NumberField label="Actuation" value={value.actuationMm} min={t.minMm} max={t.maxMm} step={t.unitMm} largeStep={0.1} decimals={2} unit="mm" onChange={(actuationMm) => set({ actuationMm })} />
        </div>
        {value.rapidTrigger && (
          <>
            <div>
              <p className="mb-2 text-[12.5px] text-muted-foreground">Press sensitivity</p>
              <NumberField label="Press" value={value.pressMm} min={t.rtMinMm} max={t.rtMaxMm} step={t.unitMm} decimals={2} unit="mm" onChange={(pressMm) => set({ pressMm })} />
            </div>
            <div>
              <p className="mb-2 text-[12.5px] text-muted-foreground">Release sensitivity</p>
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
  devices,
  claimed,
  notify,
  onSave,
  onBack,
}: {
  entry: GameEntry;
  file: GamesFile;
  known: KnownDevice[];
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
    for (const [key, p] of Object.entries(saved)) if (p.settings) out[key] = p.settings as ProfileSettings;
    return out;
  });
  const [problems, setProblems] = useState<Record<string, string>>({});

  // Connected devices SYNQ can't encode offline, and supported ones it hasn't read yet.
  const unsupported = useMemo(() => devices.filter((d) => d.kind !== "audio" && !familyOf(parseInt(d.vid, 16), parseInt(d.pid, 16))), [devices]);
  const unread = useMemo(
    () => devices.filter((d) => familyOf(parseInt(d.vid, 16), parseInt(d.pid, 16)) && !known.some((k) => k.vendorId === parseInt(d.vid, 16) && k.productId === parseInt(d.pid, 16))),
    [devices, known],
  );
  useEffect(() => setProblems({}), [drafts]);

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
    setProblems(bad);
    if (Object.keys(bad).length) return;
    const game = { id: entry.id, name: entry.name, exes: clean, builtin: entry.game?.builtin ?? entry.source === "builtin", appid: entry.appid, auto, profiles };
    const games = file.games.some((g) => g.id === entry.id) ? file.games.map((g) => (g.id === entry.id ? game : g)) : [...file.games, game];
    setBusy(true);
    try {
      await onSave({ ...file, games }, Object.keys(profiles).length ? `${entry.name} profile saved` : `${entry.name} has no profile now`);
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
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-8 pb-10 pt-7 [&>*]:shrink-0" data-slot="game-profile">
      <BackButton onClick={onBack}>All games</BackButton>
      <header className="flex items-end gap-5">
        <div ref={ref} className="w-[320px] shrink-0 overflow-hidden rounded-2xl ring-1 ring-white/[0.08]">
          <Cover url={art} name={entry.name} className="aspect-[460/215]" />
        </div>
        <div className="min-w-0 flex-1 pb-1">
          <Eyebrow>Game profile</Eyebrow>
          <h1 className="mt-3 truncate text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] text-foreground">{entry.name}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={exes}
              onChange={(e) => setExes(e.target.value)}
              aria-label="Program names"
              placeholder="game.exe"
              className="tabular h-8 w-[300px] rounded-full bg-white/[0.04] px-3.5 text-[12.5px] text-foreground outline-none ring-1 ring-white/[0.08] focus:ring-primary/60"
            />
            <button type="button" onClick={() => picker.current?.click()} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] text-foreground ring-1 ring-white/10 hover:bg-white/[0.06]">
              <ImageSquare size={14} />
              Choose image
            </button>
            <button type="button" onClick={() => void defaultImage()} className="rounded-full px-3 py-1.5 text-[12.5px] text-muted-foreground hover:text-foreground">
              Default image
            </button>
            <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => void pickImage(e.target.files?.[0])} />
          </div>
        </div>
      </header>

      <Card innerClassName="flex items-center gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] text-foreground">Apply automatically</p>
          <p className="text-[12.5px] text-muted-foreground">SYNQ Helper sends this profile when {exes.split(",")[0]?.trim() || "the game"} starts, and puts your everyday settings back when it ends.</p>
        </div>
        <Switch checked={auto} onCheckedChange={setAuto} aria-label="Apply automatically" />
      </Card>

      <p className="text-[12.5px] text-muted-foreground">Nothing is sent to your devices while you edit. Pick the devices this game changes, then save.</p>

      {known.map((k) => {
        const s = drafts[k.key] ?? Object.entries(drafts).find(([key]) => sameDevice(key, k.key))?.[1];
        const on = !!s;
        return (
          <Card key={k.key}>
            <CardHeader
              title={k.name}
              hint={on ? "In this profile" : "Not changed by this game"}
              right={<Switch checked={on} onCheckedChange={(v) => toggle(k, v)} aria-label={`Change ${k.name} for this game`} />}
            />
            {s && k.family === "atk" && s.family === "atk" && <AtkEditor k={k} value={s.atk} onChange={(atk) => setDrafts((d) => ({ ...d, [k.key]: { family: "atk", atk } }))} />}
            {s && k.family === "x68" && s.family === "x68" && <X68Editor k={k} value={s.x68} onChange={(x68) => setDrafts((d) => ({ ...d, [k.key]: { family: "x68", x68 } }))} />}
            {problems[k.key] && <p className="px-5 pb-4 text-[12.5px] text-chart-3">{problems[k.key]}</p>}
          </Card>
        );
      })}

      {(unread.length > 0 || unsupported.length > 0 || !known.length) && (
        <Card>
          <CardHeader title="Other devices" />
          <ul className="divide-y divide-white/[0.05] px-5 pb-3">
            {!known.length && !unread.length && <li className="py-3 text-[12.5px] text-muted-foreground">Open your mouse or keyboard from Devices once, so SYNQ knows its current settings.</li>}
            {unread.map((d) => (
              <li key={`${d.vid}:${d.pid}`} className="flex items-center gap-3 py-3 text-[13px]">
                <span className="min-w-0 flex-1 truncate text-foreground">{d.name}</span>
                <span className="text-[12px] text-muted-foreground">Open it from Devices once so SYNQ knows its current settings</span>
              </li>
            ))}
            {unsupported.map((d) => (
              <li key={`${d.vid}:${d.pid}`} className="flex items-center gap-3 py-3 text-[13px] text-muted-foreground">
                <Prohibit size={15} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                <span className="text-[12px]">{NOT_SUPPORTED}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex items-center gap-3">
        <button type="button" disabled={busy} onClick={() => void save()} className={cn("rounded-full bg-foreground px-4 py-2 text-[13px] font-medium text-background", busy && "opacity-60")}>
          Save profile
        </button>
        {Object.keys(saved).length > 0 && (
          <button
            type="button"
            onClick={() => {
              setDrafts({});
              notify({ title: "Profile cleared", detail: "Save to keep it that way.", tone: "info" }, "games");
            }}
            className="rounded-full px-3.5 py-2 text-[13px] text-muted-foreground ring-1 ring-white/10 hover:text-foreground"
          >
            Remove profile
          </button>
        )}
        <span className="text-[12px] text-muted-foreground">Same safety checks as the device pages; no firmware, pairing, remaps or resets are ever part of a profile.</span>
      </div>
    </div>
  );
}
