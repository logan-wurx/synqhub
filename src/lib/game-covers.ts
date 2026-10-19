// Covers SYNQ ships for popular games that aren't on Steam (Steam's own header art covers the rest): in
// src/assets/games, with where each came from in covers.json. Images are (c) their respective owners. A game is matched
// by its program name, or by its name (every word of one of a cover's names in the game's name); a cover loads only
// when a tile with it is shown.
import { useEffect, useState } from "react";
import { normName } from "./device-images";
import index from "@/assets/games/covers.json";

interface CoverRow {
  key: string;
  name: string;
  aliases: string[];
  owner: string;
}

const files = import.meta.glob<string>("/src/assets/games/*.webp", { query: "?url", import: "default" });
const ROWS = (index as CoverRow[]).filter((r) => files[`/src/assets/games/${r.key}.webp`]);

/** Words beside a one-word game name that still mean that game. */
const LAUNCHER_WORDS = new Set(["launcher", "client", "game", "live", "beta", "pc", "windows", "edition"]);

/** The cover's key for a game, by program name first, then by name; null when SYNQ ships none. */
export function coverKeyFor(name: string, exes: readonly string[] = []): string | null {
  const exe = new Set(exes.map((e) => e.toLowerCase()));
  for (const r of ROWS) if (r.aliases.some((a) => exe.has(a.toLowerCase()))) return r.key;
  const words = new Set(normName(name).split(" ").filter(Boolean));
  if (!words.size) return null;
  for (const r of ROWS) {
    for (const a of [r.name, ...r.aliases]) {
      if (/\.exe$/i.test(a)) continue;
      const need = normName(a).split(" ").filter(Boolean);
      // A one-word name must be the game's whole name, or that plus a launcher word ("Minecraft Launcher"), so
      // "Minecraft Dungeons" or "Roblox Studio" doesn't borrow the cover.
      const extra = [...words].filter((w) => !need.includes(w));
      if (need.length && need.every((w) => words.has(w)) && (need.length > 1 || extra.every((w) => LAUNCHER_WORDS.has(w)))) return r.key;
    }
  }
  return null;
}

/** The URL of a game's shipped cover, once loaded; null without one. */
export function useShippedCover(name: string, exes: readonly string[], wanted: boolean): string | null {
  const key = wanted ? coverKeyFor(name, exes) : null;
  const [url, setUrl] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    void files[`/src/assets/games/${key}.webp`]?.().then((u) => live && setUrl({ key, url: u }));
    return () => {
      live = false;
    };
  }, [key]);
  return key && url?.key === key ? url.url : null;
}
