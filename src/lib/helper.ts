// The desktop app's side of SYNQ Helper (src-tauri/helper, docs/helper.md): its switches in Settings,
// and the Games page: the game library (installed games and their cover art) and the per-game profiles,
// which are edited as settings and encoded offline (src/lib/profiles). Off by default: nothing here starts
// anything until the person turns the helper on.
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./backend";
import { isLinux, viaHelper } from "./runtime";
import type { Step } from "./profiles/encode";

export type { Step };

export interface HelperSettings {
  enabled: boolean;
  gameProfiles: boolean;
  batteryAlerts: boolean;
  /** Battery alert levels in %, highest first (default 20, 10, 5). */
  batteryLevels: number[];
  webBridge: boolean;
}

export interface HelperStatus {
  settings: HelperSettings;
  running: boolean;
  /** synq-helper.exe is installed next to the app. */
  installed: boolean;
  /** The sign-in entry is in place. */
  autostart: boolean;
  /** Sites paired with the web bridge. */
  sites: string[];
  port: number;
}

export interface DeviceProfile {
  name: string;
  vendorId: number;
  productId: number;
  /** Sent when the game starts. */
  steps: Step[];
  /** Puts the everyday settings back. */
  restore: Step[];
  /** The settings as the Games page edits them (src/lib/profiles/encode.ts ProfileSettings). */
  settings: unknown;
  saved: number;
}

export interface Game {
  id: string;
  name: string;
  exes: string[];
  builtin: boolean;
  appid?: number | null;
  /** "Apply automatically". */
  auto: boolean;
  profiles: Record<string, DeviceProfile>;
}

export interface GamesFile {
  version: number;
  games: Game[];
}

/** An installed game (or a built-in favourite), from src-tauri/src/library.rs. */
export interface Detected {
  id: string;
  name: string;
  source: "steam" | "epic" | "builtin";
  appid: number | null;
  exes: string[];
  iconExe: string | null;
  installed: boolean;
}

export const DEFAULT_BATTERY_LEVELS = [20, 10, 5];
const OFF: HelperSettings = { enabled: false, gameProfiles: true, batteryAlerts: true, batteryLevels: [...DEFAULT_BATTERY_LEVELS], webBridge: true };

/** A level list the helper keeps (src-tauri/helper/src/battery.rs `levels`): 1 to 5 distinct levels, 1 to 50%, highest first. */
export function batteryLevels(raw: readonly number[]): number[] | null {
  const v = [...new Set(raw.map((n) => Math.round(n)))].sort((a, b) => b - a);
  if (!v.length || v.length > 5 || v.length !== raw.length || v.some((n) => !Number.isFinite(n) || n < 1 || n > 50)) return null;
  return v;
}

// The browser preview: a sample, nothing saved.
// The preview starts with the helper off, like the app; `#settings/helper-on` shows it on (screenshots).
const previewOn = typeof location !== "undefined" && location.hash.includes("helper-on");
let previewStatus: HelperStatus = { settings: { ...OFF, enabled: previewOn }, running: previewOn, installed: true, autostart: previewOn, sites: [], port: 17860 };
let previewGames: GamesFile = { version: 2, games: [] };
const previewArt = new Map<string, string>();

/** The browser preview's library: the favourites and a few Steam games, art straight from Steam's CDN. */
const PREVIEW_LIBRARY: Detected[] = [
  { id: "cs2", name: "Counter-Strike 2", source: "builtin", appid: 730, exes: ["cs2.exe"], iconExe: null, installed: true },
  { id: "valorant", name: "Valorant", source: "builtin", appid: null, exes: ["valorant-win64-shipping.exe"], iconExe: null, installed: true },
  { id: "league", name: "League of Legends", source: "builtin", appid: null, exes: ["league of legends.exe"], iconExe: null, installed: false },
  { id: "fortnite", name: "Fortnite", source: "builtin", appid: null, exes: ["fortniteclient-win64-shipping.exe"], iconExe: null, installed: true },
  { id: "apex", name: "Apex Legends", source: "builtin", appid: 1172470, exes: ["r5apex.exe", "r5apex_dx12.exe"], iconExe: null, installed: true },
  { id: "overwatch2", name: "Overwatch 2", source: "builtin", appid: 2357570, exes: ["overwatch.exe"], iconExe: null, installed: false },
  { id: "rocketleague", name: "Rocket League", source: "builtin", appid: 252950, exes: ["rocketleague.exe"], iconExe: null, installed: false },
  { id: "steam-578080", name: "PUBG: BATTLEGROUNDS", source: "steam", appid: 578080, exes: ["tslgame.exe"], iconExe: null, installed: true },
  { id: "steam-570", name: "Dota 2", source: "steam", appid: 570, exes: ["dota2.exe"], iconExe: null, installed: true },
  { id: "steam-2767030", name: "Marvel Rivals", source: "steam", appid: 2767030, exes: ["marvel-win64-shipping.exe"], iconExe: null, installed: true },
  { id: "steam-252490", name: "Rust", source: "steam", appid: 252490, exes: ["rustclient.exe"], iconExe: null, installed: true },
];

/** The preview's sample: a CS2 profile for the sample ATK X1 and X68 HE, encoded like a real one. */
async function previewSample(): Promise<GamesFile> {
  const { previewDevices } = await import("./profiles/state.ts");
  const { encode, settingsFrom } = await import("./profiles/encode.ts");
  const profiles: Record<string, DeviceProfile> = {};
  for (const k of previewDevices()) {
    const base = settingsFrom(k);
    const settings =
      base.family === "atk"
        ? { ...base, atk: { ...base.atk, stages: [800, 1600], activeStage: 0, pollingHz: 4000, motionSync: false } }
        : base.family === "x68"
          ? { ...base, x68: { ...base.x68, actuationMm: 0.4, rapidTrigger: true, pressMm: 0.1, releaseMm: 0.1 } }
          : base;
    const e = encode(k, settings);
    profiles[k.key] = { name: k.name, vendorId: k.vendorId, productId: k.productId, steps: e.steps, restore: e.restore, settings, saved: Math.floor(Date.now() / 1000) };
  }
  return {
    version: 2,
    games: [
      { id: "cs2", name: "Counter-Strike 2", exes: ["cs2.exe"], builtin: true, appid: 730, auto: true, profiles },
      { id: "valorant", name: "Valorant", exes: ["valorant-win64-shipping.exe"], builtin: true, appid: null, auto: false, profiles: { [Object.keys(profiles)[0]]: Object.values(profiles)[0] } },
    ],
  };
}

/** What the website may change of the helper's jobs (the rest is the desktop app's). */
export interface HelperPrefs {
  gameProfiles: boolean;
  batteryAlerts: boolean;
  batteryLevels: number[];
}

export const helper = {
  status: (): Promise<HelperStatus> => (inTauri ? invoke<HelperStatus>("helper_status") : Promise.resolve(structuredClone(previewStatus))),
  set: (settings: HelperSettings): Promise<HelperStatus> => {
    if (inTauri) return invoke<HelperStatus>("helper_set", { settings });
    previewStatus = { ...previewStatus, settings, running: settings.enabled, autostart: settings.enabled };
    return Promise.resolve(structuredClone(previewStatus));
  },
  forgetSites: (): Promise<HelperStatus> => (inTauri ? invoke<HelperStatus>("helper_forget_sites") : Promise.resolve(structuredClone(previewStatus))),
  /** The website: the helper's game profiles and battery alerts. */
  prefs: (): Promise<HelperPrefs> => invoke<HelperPrefs>("helper_prefs"),
  prefsSet: (change: Partial<HelperPrefs>): Promise<HelperPrefs> => invoke<HelperPrefs>("helper_prefs_set", change),
  gamesLoad: async (): Promise<GamesFile> => {
    if (inTauri || (await viaHelper())) return invoke<GamesFile>("games_load");
    if (!previewGames.games.length) previewGames = await previewSample();
    return structuredClone(previewGames);
  },
  gamesSave: async (file: GamesFile): Promise<void> => {
    if (inTauri || (await viaHelper())) return invoke<void>("games_save", { file });
    previewGames = structuredClone(file);
  },
  detect: async (): Promise<Detected[]> => (inTauri || (await viaHelper()) ? invoke<Detected[]>("games_detect") : structuredClone(PREVIEW_LIBRARY)),
  /** Cover art as a data URL (fetched once and kept by the app); the preview uses Steam's CDN directly. */
  art: async (id: string, appid: number | null, iconExe: string | null): Promise<string | null> => {
    if (inTauri) return invoke<string | null>("game_art", { id, appid, iconExe });
    // Through the helper: Steam's cover, fetched once and kept as the app keeps it (no program icons).
    if (!previewArt.has(id) && (await viaHelper())) return invoke<string | null>("game_art", { id, appid });
    if (previewArt.has(id)) return Promise.resolve(previewArt.get(id)!);
    return Promise.resolve(appid ? `https://shared.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg` : null);
  },
  setArt: async (id: string, file: File): Promise<string> => {
    if (file.size > 2 * 1024 * 1024) throw new Error("Pick an image of 2 MB or less.");
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    if (inTauri) return invoke<string>("game_art_set", { id, bytes });
    const url = URL.createObjectURL(file);
    previewArt.set(id, url);
    return url;
  },
  clearArt: (id: string): Promise<void> => {
    if (inTauri) return invoke<void>("game_art_clear", { id });
    previewArt.delete(id);
    return Promise.resolve();
  },
};

/** Linux: a native game's program ("cs2", "Game.x86_64") is matched as "cs2.exe" / "game.exe", the way the
 * helper names running programs (src-tauri/src/games.rs `process_name`). Proton games keep their .exe name. */
function linuxProgramName(raw: string): string {
  const e = raw.trim().toLowerCase();
  if (!e || e.endsWith(".exe") || /[\\/]/.test(e)) return e;
  return `${e.replace(/\.(x86_64|x86)$/, "")}.exe`;
}

/** A process name a custom game may use (the same rule as src-tauri/src/games.rs `exe_ok`). */
export function cleanExe(raw: string): { exe: string } | { error: string } {
  const e = (isLinux ? linuxProgramName(raw) : raw).trim().toLowerCase();
  if (!e || e.length > 64) return { error: "A game's program name is 1 to 64 characters, like game.exe." };
  if (!e.endsWith(".exe") || e.length <= 4) return { error: "A game's program name ends in .exe (like game.exe)." };
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(e)) return { error: "Just the program's file name, without a folder (like game.exe)." };
  if (["synq.exe", "synq-helper.exe", "explorer.exe", "svchost.exe", "dwm.exe", "csrss.exe", "winlogon.exe"].includes(e)) return { error: `${e} isn't a game.` };
  return { exe: e };
}
