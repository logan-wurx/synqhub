// Games: a grid of the games on this PC (Steam and Epic, read-only from their own files) and the favourites
// SYNQ lists by itself, each with its cover art; and, per game, a profile of mouse and keyboard settings that go on
// while the game runs (docs/helper.md). Profiles are edited as settings (src/lib/profiles): nothing is written to a
// device from this page. ATK mice and the X68 HE are encoded offline for SYNQ Helper; every other mouse and keyboard
// gets a live profile that SYNQ puts on through the device's own session.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, GameController, Plus } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { Connected } from "@/lib/backend";
import { Card, Eyebrow, type Notice } from "@/components/ui/matte";
import { buildEntries } from "@/lib/device-model";
import { usePublishedNames } from "@/lib/device-names";
import { publishHelper } from "@/lib/helper-state";
import { useKeptState } from "@/lib/keep";
import { cleanExe, helper, type Detected, type Game, type GamesFile, type HelperStatus } from "@/lib/helper";
import { isLinux, isWeb } from "@/lib/runtime";
import { useGridRoom } from "@/lib/viewport";
import { useShippedCover } from "@/lib/game-covers";
import { knownDevices } from "@/lib/profiles/state";
import type { KnownDevice } from "@/lib/profiles/encode";
import { liveKind, type LiveKind } from "@/lib/profiles/live";
import { loadSnapshots, type LiveSnapshot } from "@/lib/profiles/snapshots";
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

/** A mouse or keyboard that takes live profiles (every one but ATK mice and the X68 HE, which are encoded). */
export interface LiveCandidate {
  family: string;
  kind: LiveKind;
  name: string;
  connected: boolean;
  snapshot: LiveSnapshot | null;
}

const ENCODED = new Set(["atk", "x68"]);

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

/**
 * The art: the person's own image or Steam's; else the cover SYNQ ships for a popular game that isn't on Steam
 * (src/lib/game-covers.ts); else the program's icon; else the game's name set big on a warm panel, like a title card.
 */
export function Cover({ url: art, name, exes = [], className }: { url: string | null; name: string; exes?: readonly string[]; className?: string }) {
  const shipped = useShippedCover(name, exes, !art || art.startsWith("data:image/x-icon"));
  const url = shipped ?? art;
  const icon = url?.startsWith("data:image/x-icon");
  return (
    <div className={cn("@container relative grid place-items-center overflow-hidden bg-gradient-to-br from-[oklch(30%_0.012_45)] to-[oklch(21%_0.005_50)]", className)}>
      {url ? (
        icon ? (
          <img src={url} alt="" className="size-16 drop-shadow-[0_6px_18px_rgb(0_0_0/0.5)]" decoding="async" />
        ) : (
          <img src={url} alt="" className="absolute inset-0 size-full object-cover" decoding="async" />
        )
      ) : (
        <span aria-hidden="true" className="absolute inset-x-[7cqw] bottom-[8cqw] line-clamp-2 text-[clamp(16px,10cqw,44px)] font-bold leading-[0.95] tracking-[-0.045em] text-high">
          {name}
        </span>
      )}
    </div>
  );
}

/** A cover is a Steam header (460x215); under it, the name and a line. The columns can't get narrower or wider than these. */
const COVER = { minCol: 210, maxCol: 480, caption: 52, gapX: 16, gapY: 20 };

/** The fewest cover columns (the biggest covers) whose rows all fit above the dock; when none do, the most, and the page scrolls. */
function useCoverColumns(count: number) {
  const { ref, w, room } = useGridRoom<HTMLElement>([count]);
  const { minCol, maxCol, caption, gapX, gapY } = COVER;
  const most = Math.max(1, Math.floor((w + gapX) / (minCol + gapX)));
  const least = Math.min(most, Math.max(1, Math.ceil((w + gapX) / (maxCol + gapX))));
  for (let cols = least; cols <= most; cols++) {
    const rows = Math.ceil(count / cols);
    const tile = ((w - gapX * (cols - 1)) / cols) * (215 / 460) + caption;
    if (rows * tile + (rows - 1) * gapY <= room) return { ref, cols };
  }
  return { ref, cols: most };
}

const SOURCE_LABEL: Record<GameEntry["source"], string> = { steam: "Steam", epic: "Epic", builtin: "", custom: "Added" };

function GameTile({ entry, onOpen }: { entry: GameEntry; onOpen: () => void }) {
  const [ref, url] = useArt(entry);
  const devices = entry.game ? Object.values(entry.game.profiles) : [];
  const on = devices.length > 0;
  return (
    <button type="button" onClick={onOpen} data-slot="game-tile" className="group block text-left">
      <div ref={ref} className={cn("overflow-hidden rounded-control ring-1 transition-all duration-500 ease-fluid group-hover:-translate-y-0.5", on ? "ring-primary/40 shadow-[0_8px_30px_-12px_var(--primary)]" : "ring-white/[0.07] group-hover:ring-white/20")}>
        <Cover url={url} name={entry.name} exes={entry.exes} className="aspect-[460/215]" />
      </div>
      <div className="mt-2 flex items-start gap-2 px-0.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] text-high">{entry.name}</p>
          <p className="truncate text-[11.5px] text-medium">
            {on ? `${devices.map((d) => d.name).join(", ")}${entry.game?.auto ? "" : " · manual"}` : entry.installed ? "No profile" : "Not found on this PC"}
          </p>
        </div>
        {on && <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-primary" />}
        {SOURCE_LABEL[entry.source] && !on && <span className="mt-0.5 shrink-0 text-[10.5px] uppercase tracking-[0.12em] text-medium">{SOURCE_LABEL[entry.source]}</span>}
      </div>
    </button>
  );
}

function AddGameTile({ onAdd }: { onAdd: (name: string, exe: string) => boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [exe, setExe] = useState("");
  const input = "h-8 w-full rounded-small bg-white/[0.04] px-3.5 text-[12.5px] text-high outline-none ring-1 ring-white/[0.08] placeholder:text-medium focus:ring-primary/60";
  return (
    <div className="flex aspect-[460/215] flex-col justify-center gap-2 rounded-control border border-dashed border-white/[0.12] p-4">
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
            <button type="button" onClick={() => onAdd(name, exe) && (setOpen(false), setName(""), setExe(""))} className="rounded-small bg-foreground px-3 py-1 text-[12px] font-medium text-background">
              Add
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-small px-3 py-1 text-[12px] text-medium hover:text-high">
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="flex flex-col items-center gap-1.5 text-medium transition-colors hover:text-high">
          <Plus size={20} weight="light" />
          <span className="text-[13px]">Add a game</span>
          <span className="text-[11.5px] text-medium">{isLinux ? "Any program: a Proton game's .exe, or a native game's name" : "Any program, by its .exe name"}</span>
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
  const [snapshots, setSnapshots] = useState<LiveSnapshot[]>([]);
  /** The website: whether SYNQ Helper's game profiles are on (the app reads it from `status`). */
  const [webOn, setWebOn] = useState<boolean | null>(null);
  const [openId, setOpenId] = useKeptState<string | null>(OPEN_GAME_KEY, null);
  const published = usePublishedNames();

  const load = useCallback(() => {
    helper.gamesLoad().then(setFile, (e) => notify({ title: "Couldn't read the game profiles", detail: String(e), tone: "error" }, "games"));
    helper.detect().then(setDetected, () => setDetected([]));
    if (isWeb) helper.prefs().then((p) => setWebOn(p.gameProfiles), () => setWebOn(null));
    else helper.status().then(setStatus, () => setStatus(null));
    knownDevices().then(setKnown, () => setKnown([]));
    loadSnapshots().then(setSnapshots, () => setSnapshots([]));
  }, [notify]);
  useEffect(load, [load]);

  // Plugged in now, or read before: every mouse and keyboard a live profile can be made for.
  const live = useMemo<LiveCandidate[]>(() => {
    const out = new Map<string, LiveCandidate>();
    for (const e of buildEntries(devices, published, "")) {
      const kind = liveKind(e.family);
      if ((e.kind !== "mouse" && e.kind !== "keyboard") || !kind || ENCODED.has(e.family)) continue;
      out.set(e.family, { family: e.family, kind, name: e.name, connected: true, snapshot: snapshots.find((x) => x.family === e.family) ?? null });
    }
    for (const x of snapshots) if (!out.has(x.family) && !ENCODED.has(x.family)) out.set(x.family, { family: x.family, kind: x.kind, name: x.name, connected: false, snapshot: x });
    return [...out.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "mouse" ? -1 : 1));
  }, [devices, published, snapshots]);
  const keepSnapshot = useCallback((x: LiveSnapshot) => setSnapshots((list) => [...list.filter((y) => y.family !== x.family), x]), []);

  const profilesOn = isWeb ? webOn : status ? status.settings.enabled && status.settings.gameProfiles : null;
  /** One click: SYNQ Helper on, with its game profiles (the website's turn asks in SYNQ Helper's box first). */
  const turnOn = useCallback(async () => {
    try {
      if (isWeb) setWebOn((await helper.prefsSet({ gameProfiles: true })).gameProfiles);
      else if (status) {
        const next = await helper.set({ ...status.settings, enabled: true, gameProfiles: true });
        setStatus(next);
        publishHelper(next);
      }
      notify({ title: "Game profiles are on", detail: isWeb ? "They follow your games from now on, with this page open or closed." : "They follow your games from now on, with SYNQ open or closed.", tone: "ok" }, "games");
    } catch (e) {
      notify({ title: "Game profiles weren't turned on", detail: String(e instanceof Error ? e.message : e).replace(/^Error: /, ""), tone: "error" }, "games");
    }
  }, [status, notify]);

  const entries = useMemo(() => merge(file, detected), [file, detected]);
  const open = entries.find((e) => e.id === openId) ?? null;
  const covers = useCoverColumns(entries.length + 1);

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
        live={live}
        onSnapshot={keepSnapshot}
        profilesOn={profilesOn}
        turnOn={turnOn}
        devices={devices}
        claimed={(exe) => entries.some((g) => g.id !== open.id && g.exes.includes(exe))}
        notify={notify}
        onSave={save}
        onBack={() => setOpenId(null)}
      />
    );

  const helperOn = profilesOn !== false;
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-8 pb-[120px] pt-7 [&>*]:shrink-0">
      {/* The title, and beside it (under it on a narrow window) the note about the helper, so the covers get the height. */}
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <header className="min-w-0">
          <Eyebrow>SYNQ Helper</Eyebrow>
          <h1 className="headline mt-3 text-[clamp(56px,6vw,104px)] text-high">Games</h1>
          <p className="mt-2 max-w-[760px] text-[13.5px] text-medium">
            Pick a game to give it its own mouse and keyboard settings. They go on when the game starts and your everyday settings come back when it ends,{" "}
            {isWeb ? "with this page open or closed." : "with SYNQ open or closed."} Games are recognised by their program name only: nothing
            reads or touches a game.
          </p>
        </header>

        {!helperOn && (
          <Card className="min-w-[320px] max-w-[620px] flex-1" innerClassName="flex items-center gap-4 px-5 py-4">
            <span className="grid size-10 shrink-0 place-items-center rounded-control bg-white/[0.04] text-medium ring-1 ring-white/[0.07]">
              <GameController size={20} weight="light" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium tracking-tight text-high">Game profiles are off</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-medium">You can set profiles up now. Turn them on to have them follow your games: SYNQ Helper watches for them in the background.</p>
            </div>
            <button type="button" onClick={() => void turnOn()} className="shrink-0 rounded-small bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background">
              Turn on
            </button>
          </Card>
        )}
      </div>

      <section ref={covers.ref} className="grid gap-x-4 gap-y-5" style={{ gridTemplateColumns: `repeat(${covers.cols}, minmax(0, 1fr))` }} data-slot="games-grid">
        {entries.map((e) => (
          <GameTile key={e.id} entry={e} onOpen={() => setOpenId(e.id)} />
        ))}
        <AddGameTile onAdd={add} />
      </section>
    </div>
  );
}
