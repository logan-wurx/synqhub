// Games: a grid of the games on this PC (Steam and Epic, read-only from their own files) and the favourites
// SYNQ lists by itself, each with its cover art; and, per game, a profile of mouse and keyboard settings
// that SYNQ Helper applies while the game runs (docs/helper.md). Profiles are edited as settings and
// encoded offline (src/lib/profiles): nothing is sent to a device from this page.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, GameController, Plus } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { Connected } from "@/lib/backend";
import { Card, Eyebrow, type Notice } from "@/components/ui/matte";
import { goSettings } from "@/lib/nav";
import { useKeptState } from "@/lib/keep";
import { cleanExe, helper, type Detected, type Game, type GamesFile, type HelperStatus } from "@/lib/helper";
import { isLinux } from "@/lib/runtime";
import { knownDevices } from "@/lib/profiles/state";
import type { KnownDevice } from "@/lib/profiles/encode";
import { GameProfile } from "./GameProfile";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

/** One tile: a game from the file, the library, or both. */
export interface GameEntry {
  id: string;
  name: string;
  exes: string[];
  appid: number | null;
  iconExe: string | null;
  source: Detected["source"] | "custom";
  installed: boolean;
  game: Game | null;
}

export const OPEN_GAME_KEY = "games.open";

function merge(file: GamesFile | null, detected: Detected[]): GameEntry[] {
  const out: GameEntry[] = [];
  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  // One tile per game: a saved or detected entry that matches by id, Steam app id or name is the same game.
  const find = (id: string, appid: number | null | undefined, name: string) =>
    out.find((x) => x.id === id || (appid != null && x.appid === appid) || sameName(x.name, name));
  for (const d of detected) {
    if (!find(d.id, d.appid, d.name)) out.push({ id: d.id, name: d.name, exes: d.exes, appid: d.appid, iconExe: d.iconExe, source: d.source, installed: d.installed, game: null });
  }
  for (const g of file?.games ?? []) {
    const e = find(g.id, g.appid, g.name);
    if (e) {
      e.game = g;
      e.exes = g.exes;
      e.name = g.name;
    } else out.push({ id: g.id, name: g.name, exes: g.exes, appid: g.appid ?? null, iconExe: null, source: g.builtin ? "builtin" : "custom", installed: true, game: g });
  }
  const rank = (e: GameEntry) => (e.game && Object.keys(e.game.profiles).length ? 0 : e.installed ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// ---- cover art: asked for once per game, only when its tile comes into view

const artCache = new Map<string, Promise<string | null>>();
export function artFor(e: { id: string; appid: number | null; iconExe: string | null }, fresh = false): Promise<string | null> {
  if (fresh) artCache.delete(e.id);
  let p = artCache.get(e.id);
  if (!p) artCache.set(e.id, (p = helper.art(e.id, e.appid, e.iconExe).catch(() => null)));
  return p;
}

export function useArt(e: { id: string; appid: number | null; iconExe: string | null }, version = 0): [React.RefObject<HTMLDivElement | null>, string | null] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const io = new IntersectionObserver(
      (items) => {
        if (!items.some((i) => i.isIntersecting)) return;
        io.disconnect();
        void artFor(e, version > 0).then((u) => alive && setUrl(u));
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
    // e.id / appid / iconExe identify the art; `version` asks again after a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.id, e.appid, e.iconExe, version]);
  return [ref, url];
}

/** The art, or the game's initials on a quiet tile. */
export function Cover({ url, name, className }: { url: string | null; name: string; className?: string }) {
  const initials = name
    .split(/[\s:-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  const icon = url?.startsWith("data:image/x-icon");
  return (
    <div className={cn("relative grid place-items-center overflow-hidden bg-gradient-to-br from-white/[0.06] to-white/[0.01]", className)}>
      {url ? (
        icon ? (
          <img src={url} alt="" className="size-16 drop-shadow-[0_6px_18px_rgb(0_0_0/0.5)]" decoding="async" />
        ) : (
          <img src={url} alt="" className="absolute inset-0 size-full object-cover" decoding="async" />
        )
      ) : (
        <span aria-hidden="true" className="text-[28px] font-semibold tracking-tight text-white/40">{initials}</span>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<GameEntry["source"], string> = { steam: "Steam", epic: "Epic", builtin: "", custom: "Added" };

function GameTile({ entry, onOpen }: { entry: GameEntry; onOpen: () => void }) {
  const [ref, url] = useArt(entry);
  const devices = entry.game ? Object.values(entry.game.profiles) : [];
  const on = devices.length > 0;
  return (
    <button type="button" onClick={onOpen} data-slot="game-tile" className="group block text-left">
      <div ref={ref} className={cn("overflow-hidden rounded-2xl ring-1 transition-all duration-500 ease-fluid group-hover:-translate-y-0.5", on ? "ring-primary/40 shadow-[0_8px_30px_-12px_var(--primary)]" : "ring-white/[0.07] group-hover:ring-white/20")}>
        <Cover url={url} name={entry.name} className="aspect-[460/215]" />
      </div>
      <div className="mt-2 flex items-start gap-2 px-0.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] text-foreground">{entry.name}</p>
          <p className="truncate text-[11.5px] text-muted-foreground">
            {on ? `${devices.map((d) => d.name).join(", ")}${entry.game?.auto ? "" : " · manual"}` : entry.installed ? "No profile" : "Not found on this PC"}
          </p>
        </div>
        {on && <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-primary" />}
        {SOURCE_LABEL[entry.source] && !on && <span className="mt-0.5 shrink-0 text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground/80">{SOURCE_LABEL[entry.source]}</span>}
      </div>
    </button>
  );
}

function AddGameTile({ onAdd }: { onAdd: (name: string, exe: string) => boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [exe, setExe] = useState("");
  const input = "h-8 w-full rounded-full bg-white/[0.04] px-3.5 text-[12.5px] text-foreground outline-none ring-1 ring-white/[0.08] placeholder:text-muted-foreground/80 focus:ring-primary/60";
  return (
    <div className="flex aspect-[460/215] flex-col justify-center gap-2 rounded-2xl border border-dashed border-white/[0.12] p-4">
      {open ? (
        <>
          <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Game name" aria-label="Game name" className={input} />
          <input
            value={exe}
            maxLength={64}
            onChange={(e) => setExe(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onAdd(name, exe) && (setOpen(false), setName(""), setExe(""))}
            placeholder={isLinux ? "game.exe (Proton) or the program's name" : "game.exe (Task Manager > Details)"}
            aria-label="Program name"
            className={cn(input, "tabular")}
          />
          <div className="flex gap-2">
            <button type="button" onClick={() => onAdd(name, exe) && (setOpen(false), setName(""), setExe(""))} className="rounded-full bg-foreground px-3 py-1 text-[12px] font-medium text-background">
              Add
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-full px-3 py-1 text-[12px] text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="flex flex-col items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground">
          <Plus size={20} />
          <span className="text-[13px]">Add a game</span>
          <span className="text-[11.5px] text-muted-foreground/80">{isLinux ? "Any program: a Proton game's .exe, or a native game's name" : "Any program, by its .exe name"}</span>
        </button>
      )}
    </div>
  );
}

export function GamesPage({ devices, notify }: { devices: Connected[]; notify: Notify }) {
  const [file, setFile] = useState<GamesFile | null>(null);
  const [detected, setDetected] = useState<Detected[]>([]);
  const [status, setStatus] = useState<HelperStatus | null>(null);
  const [known, setKnown] = useState<KnownDevice[]>([]);
  const [openId, setOpenId] = useKeptState<string | null>(OPEN_GAME_KEY, null);

  const load = useCallback(() => {
    helper.gamesLoad().then(setFile, (e) => notify({ title: "Couldn't read the game profiles", detail: String(e), tone: "error" }, "games"));
    helper.detect().then(setDetected, () => setDetected([]));
    helper.status().then(setStatus, () => setStatus(null));
    knownDevices().then(setKnown, () => setKnown([]));
  }, [notify]);
  useEffect(load, [load]);

  const entries = useMemo(() => merge(file, detected), [file, detected]);
  const open = entries.find((e) => e.id === openId) ?? null;

  const save = async (next: GamesFile, ok?: string) => {
    // Only what matters is kept: the favourites, games added by hand, and games with a profile.
    const keep = { ...next, games: next.games.filter((g) => g.builtin || g.id.startsWith("custom-") || Object.keys(g.profiles).length) };
    await helper.gamesSave(keep);
    setFile(keep);
    if (ok) notify({ title: ok, tone: "ok" }, "games");
  };

  const add = (name: string, raw: string) => {
    if (!file) return false;
    const exe = cleanExe(raw);
    if ("error" in exe) return notify({ title: "That program name won't work", detail: exe.error, tone: "error" }, "games"), false;
    if (!name.trim()) return notify({ title: "Name the game", tone: "error" }, "games"), false;
    if (entries.some((g) => g.exes.includes(exe.exe))) return notify({ title: `${exe.exe} is already listed`, tone: "error" }, "games"), false;
    const id = `custom-${Date.now().toString(36)}`;
    void save({ ...file, games: [...file.games, { id, name: name.trim().slice(0, 80), exes: [exe.exe], builtin: false, appid: null, auto: true, profiles: {} }] }, `${name.trim()} added`).catch((e) =>
      notify({ title: "Couldn't add it", detail: String(e), tone: "error" }, "games"),
    );
    return true;
  };

  if (open && file)
    return (
      <GameProfile
        entry={open}
        file={file}
        known={known}
        devices={devices}
        claimed={(exe) => entries.some((g) => g.id !== open.id && g.exes.includes(exe))}
        notify={notify}
        onSave={save}
        onBack={() => setOpenId(null)}
      />
    );

  const helperOn = !!status?.settings.enabled && status.settings.gameProfiles;
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-8 pb-10 pt-7 [&>*]:shrink-0">
      <header>
        <Eyebrow>SYNQ Helper</Eyebrow>
        <h1 className="display-num mt-3 text-[clamp(48px,5.4vw,84px)] text-foreground">Games</h1>
        <p className="mt-2 max-w-[760px] text-[13.5px] text-muted-foreground">
          Pick a game to give it its own mouse and keyboard settings. SYNQ Helper applies them when the game starts and puts your everyday settings back when it ends.
          Games are recognised by their program name only: nothing reads or touches a game.
        </p>
      </header>

      {status && !helperOn && (
        <Card innerClassName="flex items-center gap-4 px-5 py-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-muted-foreground ring-1 ring-white/[0.07]">
            <GameController size={20} weight="light" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium tracking-tight text-foreground">Profiles switch only while SYNQ Helper is on</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">You can set profiles up now. Turn the helper and its game profiles on in Settings to have them follow your games.</p>
          </div>
          <button type="button" onClick={() => goSettings()} className="shrink-0 rounded-full bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background">
            Open Settings
          </button>
        </Card>
      )}

      <section className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-x-4 gap-y-5" data-slot="games-grid">
        {entries.map((e) => (
          <GameTile key={e.id} entry={e} onOpen={() => setOpenId(e.id)} />
        ))}
        <AddGameTile onAdd={add} />
      </section>
    </div>
  );
}
