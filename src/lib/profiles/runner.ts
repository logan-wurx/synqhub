// Game profiles for every mouse and keyboard while SYNQ runs (the app, its start with no window, or the website with
// SYNQ Helper). Every few seconds it asks which games are running and works out what each profiled device should hold:
// the most recently started running game that has a profile for it and "Apply automatically", else its everyday
// settings. Only what differs changes: a game starting notes the device's everyday feel, then puts the game's on; the
// game ending puts the everyday feel back; two games at once follow the newest; a device plugged in mid-game gets the
// profile when it appears. What each device holds, with its everyday feel, is kept (`saveHeld`), so a crash or a
// restart mid-game still puts everything back.
//
// These are the "live" profiles (games.json keys `live:<family>`): a feel per device, put on through the device's own
// session (./live.ts). Profiles for ATK mice and the X68 HE are also encoded ahead of time and run by SYNQ Helper in
// the background (./encode.ts); this runner leaves those alone.
import type { GamesFile } from "../helper.ts";
import type { Feel, LiveDevice } from "./live.ts";

export const LIVE_PREFIX = "live:";

/** What a live profile keeps in games.json `settings`. */
export interface LiveSettings {
  kind: "feel";
  family: string;
  feel: Feel;
}

/** What a device holds now, and the everyday feel to put back. */
export interface Held {
  game: string;
  saved: number;
  name: string;
  everyday: Feel;
  /** The game's feel went on completely (false: it stopped part way, and is tried again). */
  ok: boolean;
  at: number;
}
export type HeldMap = Record<string, Held>;

export interface LiveProfile {
  game: string;
  auto: boolean;
  name: string;
  feel: Feel;
  saved: number;
}

export function liveSettingsOf(settings: unknown): LiveSettings | null {
  const s = settings as Partial<LiveSettings> | null;
  return s && s.kind === "feel" && typeof s.family === "string" && !!s.feel && typeof s.feel === "object" ? (s as LiveSettings) : null;
}

/** Every live profile, by device family. */
export function liveProfiles(file: GamesFile): Map<string, LiveProfile[]> {
  const out = new Map<string, LiveProfile[]>();
  for (const g of file.games) {
    for (const [key, p] of Object.entries(g.profiles)) {
      const s = key.startsWith(LIVE_PREFIX) ? liveSettingsOf(p.settings) : null;
      if (!s) continue;
      const list = out.get(s.family) ?? [];
      list.push({ game: g.id, auto: g.auto, name: p.name, feel: s.feel, saved: p.saved });
      out.set(s.family, list);
    }
  }
  return out;
}

export interface RunnerDeps {
  /** This SYNQ is the one putting live profiles on (one at a time: the open window, the website, or the start with
   * no window). When it isn't, it leaves every device alone. */
  mine?(): Promise<boolean>;
  /** Game profiles are on (SYNQ Helper's "Game profiles" job). Off puts every device's everyday feel back; null (not
   * known yet) leaves everything as it is. */
  enabled(): Promise<boolean | null>;
  /** The ids of the games running now. */
  running(): Promise<string[]>;
  games(): Promise<GamesFile>;
  loadHeld(): Promise<HeldMap>;
  saveHeld(held: HeldMap): Promise<void>;
  /** The mouse and keyboard families plugged in now. */
  connected(): readonly string[] | Promise<readonly string[]>;
  open(family: string): Promise<LiveDevice | null>;
  /** One line for the person, when a profile couldn't go on (or back) after a few tries. */
  notify(title: string, text: string): void;
  now(): number;
}

/** A change that fails is tried this many times, then left until what is wanted changes. */
export const MAX_TRIES = 3;
export const EVERY_MS = 3000;
/** With no live profile anywhere (and nothing held), a look this often is enough. */
export const IDLE_MS = 15_000;

const message = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");

export class ProfileRunner {
  readonly #d: RunnerDeps;
  /** When each running game was first seen running: the newest one wins a device. */
  readonly #firstSeen = new Map<string, number>();
  readonly #failures = new Map<string, { key: string; tries: number }>();
  #busy = false;
  /** The last look found no live profile and nothing held. */
  #idle = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: RunnerDeps) {
    this.#d = deps;
  }

  /** Looks now and then every few seconds (less often while there's nothing to do), until `stop`. */
  start(): void {
    this.stop();
    const look = () => {
      this.#timer = null;
      void this.tick()
        .catch(() => false)
        .finally(() => {
          if (this.#stopped) return;
          this.#timer = setTimeout(look, this.#idle ? IDLE_MS : EVERY_MS);
        });
    };
    this.#stopped = false;
    look();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #stopped = true;

  /** One pass: every profiled device brought to what it should hold now. True when nothing is left to try (all
   * done, given up on, or not plugged in); false while a change is still to be tried again. */
  async tick(): Promise<boolean> {
    if (this.#busy) return false;
    this.#busy = true;
    let settled = true;
    try {
      const d = this.#d;
      // Read every time: another SYNQ (the website, or the app started with no window) may have changed it.
      const held = await d.loadHeld();
      const file = await d.games();
      const profiles = liveProfiles(file);
      this.#idle = !profiles.size && !Object.keys(held).length;
      if (this.#idle) return true;
      if (d.mine && !(await d.mine())) return true;
      const on = await d.enabled();
      if (on === null) return false;
      const running = on ? await d.running() : [];
      const t = d.now();
      for (const id of running) if (!this.#firstSeen.has(id)) this.#firstSeen.set(id, t);
      for (const id of [...this.#firstSeen.keys()]) if (!running.includes(id)) this.#firstSeen.delete(id);
      const connected = new Set(await d.connected());
      for (const family of new Set([...profiles.keys(), ...Object.keys(held)])) {
        const want = this.#wanted(profiles.get(family) ?? []);
        const h = held[family];
        if (!want && !h) continue;
        if (want && h && h.ok && h.game === want.game && h.saved === want.saved) continue;
        if (!connected.has(family)) continue;
        const key = want ? `${want.game}@${want.saved}` : "everyday";
        const f = this.#failures.get(family);
        if (f && f.key === key && f.tries >= MAX_TRIES) continue;
        await this.#change(family, want, h, held, key);
        const after = this.#failures.get(family);
        if (after && after.key === key && after.tries < MAX_TRIES) settled = false;
      }
      return settled;
    } finally {
      this.#busy = false;
    }
  }

  #wanted(list: readonly LiveProfile[]): LiveProfile | null {
    const seen = this.#firstSeen;
    return list.filter((p) => p.auto && seen.has(p.game)).sort((a, b) => (seen.get(b.game) ?? 0) - (seen.get(a.game) ?? 0))[0] ?? null;
  }

  async #change(family: string, want: LiveProfile | null, h: Held | undefined, held: HeldMap, key: string): Promise<void> {
    const d = this.#d;
    const name = want?.name ?? h?.name ?? family;
    const dev = await d.open(family).catch(() => null);
    if (!dev) return this.#fail(family, key, name, "it couldn't be opened");
    try {
      if (want) {
        const everyday = h?.everyday ?? dev.now();
        if (!everyday) return this.#fail(family, key, name, "SYNQ couldn't read its settings first, so nothing was changed");
        // The everyday feel is kept before anything is written, so a stop part way still knows what to put back.
        if (!h) {
          held[family] = { game: want.game, saved: want.saved, name, everyday, ok: false, at: d.now() };
          await d.saveHeld(held);
        }
        const r = await dev.apply(want.feel);
        held[family] = { game: want.game, saved: want.saved, name, everyday, ok: r.ok, at: d.now() };
        await d.saveHeld(held);
        if (!r.ok) return this.#fail(family, key, name, r.error ?? "a setting didn't read back");
      } else if (h) {
        const r = await dev.apply(h.everyday);
        if (!r.ok) return this.#fail(family, key, name, r.error ?? "a setting didn't read back");
        delete held[family];
        await d.saveHeld(held);
      }
      this.#failures.delete(family);
    } catch (e) {
      this.#fail(family, key, name, message(e));
    } finally {
      await dev.release().catch(() => undefined);
    }
  }

  #fail(family: string, key: string, name: string, why: string): void {
    const f = this.#failures.get(family);
    const tries = f && f.key === key ? f.tries + 1 : 1;
    this.#failures.set(family, { key, tries });
    if (tries === MAX_TRIES) this.#d.notify(key === "everyday" ? "Everyday settings not put back" : "Game profile not applied", `${name}: ${why}.`);
  }
}
