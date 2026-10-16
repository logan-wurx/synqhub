// What the person keeps for their lights: saved colours, the ones used last, saved gradients, their DIY effects and the
// groups of lights they named (wave L5).
// The desktop app writes it to lighting.json in its data folder (`lighting_load` / `lighting_save`); the browser
// preview keeps it in memory ("Preview: nothing is saved"). Nothing here talks to a lamp.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../runtime.ts";
import type { Rgb } from "./govee/frames.ts";
import type { DiyEffect } from "./lamp.ts";

export interface LightingKeep {
  /** Colours the person saved, "#rrggbb". */
  saved: string[];
  /** The last colours used, newest first. */
  recent: string[];
  gradients: string[][];
  diy: DiyEffect[];
  /** Groups of lights the person named, by the lights' keys (src/lib/lighting/look/lights.ts). */
  groups: LightGroup[];
}

export interface LightGroup {
  id: string;
  name: string;
  members: string[];
}

export const MAX_SAVED = 16;
export const MAX_RECENT = 8;
const SAVE_MS = 600;

const EMPTY: LightingKeep = { saved: [], recent: [], gradients: [], diy: [], groups: [] };

export const hexOf = (c: Rgb) => `#${c.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
export const rgbOf = (hex: string): Rgb => {
  const n = parseInt(hex.replace("#", ""), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

let keep: LightingKeep = EMPTY;
let loaded: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

/** A kept file from an older or hand-edited SYNQ: whatever doesn't fit is dropped, nothing throws. */
function parse(text: string | null): LightingKeep {
  if (!text) return EMPTY;
  try {
    const j = JSON.parse(text) as Partial<Record<keyof LightingKeep, unknown>>;
    const list = (v: unknown) => (Array.isArray(v) ? v : []);
    return {
      saved: list(j.saved).filter(isHex).slice(0, MAX_SAVED),
      recent: list(j.recent).filter(isHex).slice(0, MAX_RECENT),
      gradients: list(j.gradients).filter((g): g is string[] => Array.isArray(g) && g.length >= 2 && g.every(isHex)),
      diy: list(j.diy).filter((d): d is DiyEffect => typeof d === "object" && d !== null && typeof (d as DiyEffect).id === "string" && Array.isArray((d as DiyEffect).colours)),
      groups: list(j.groups).filter(
        (g): g is LightGroup => typeof g === "object" && g !== null && typeof (g as LightGroup).id === "string" && typeof (g as LightGroup).name === "string" && Array.isArray((g as LightGroup).members) && (g as LightGroup).members.every((m) => typeof m === "string"),
      ),
    };
  } catch {
    return EMPTY;
  }
}

function load() {
  loaded ??= (isTauri ? invoke<string | null>("lighting_load") : Promise.resolve(null)).then(
    (text) => {
      keep = parse(text);
      subs.forEach((cb) => cb());
    },
    () => undefined,
  );
  return loaded;
}

function change(next: Partial<LightingKeep>) {
  keep = { ...keep, ...next };
  subs.forEach((cb) => cb());
  if (!isTauri) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void invoke("lighting_save", { json: JSON.stringify(keep) }).catch(() => undefined), SAVE_MS);
}

function subscribe(cb: () => void) {
  void load();
  subs.add(cb);
  return () => subs.delete(cb);
}

export const useLightingKeep = (): LightingKeep => useSyncExternalStore(subscribe, () => keep);

/** A colour was used: it goes to the front of the recent ones. */
export function rememberColour(c: Rgb) {
  const hex = hexOf(c);
  if (keep.recent[0] === hex) return;
  change({ recent: [hex, ...keep.recent.filter((h) => h !== hex)].slice(0, MAX_RECENT) });
}

export function saveColour(c: Rgb) {
  const hex = hexOf(c);
  if (keep.saved.includes(hex)) return;
  change({ saved: [...keep.saved, hex].slice(-MAX_SAVED) });
}

export const forgetColour = (hex: string) => change({ saved: keep.saved.filter((h) => h !== hex) });

export function saveGradient(stops: readonly Rgb[]) {
  const g = stops.map(hexOf);
  if (keep.gradients.some((x) => x.join() === g.join())) return;
  change({ gradients: [...keep.gradients, g].slice(-12) });
}

export const forgetGradient = (i: number) => change({ gradients: keep.gradients.filter((_, j) => j !== i) });

export const saveDiy = (d: DiyEffect) => change({ diy: [...keep.diy.filter((x) => x.id !== d.id), d] });

/** A group of lights, new or changed (by its id). */
export const saveGroup = (g: LightGroup) => change({ groups: [...keep.groups.filter((x) => x.id !== g.id), g] });
export const forgetGroup = (id: string) => change({ groups: keep.groups.filter((x) => x.id !== id) });
export const forgetDiy = (id: string) => change({ diy: keep.diy.filter((x) => x.id !== id) });
