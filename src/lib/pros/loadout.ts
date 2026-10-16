// Pro loadouts: a pro's published mouse and keyboard settings, put on the person's own gear with the Keep your feel
// math (nearest legal DPI, polling and rapid trigger on this device) plus the in-game sensitivity that keeps the
// pro's eDPI at the DPI this mouse actually runs. Pure; the dataset is src/lib/pros/pros.json.
import { mapKeyboard } from "../feel/keyboard.ts";
import { mapMouse } from "../feel/mouse.ts";
import { edpi, roundSens } from "../feel/sens.ts";
import type { GameSens, KeyboardDevice, KeyboardFeel, MouseDevice, MouseFeel, Plan } from "../feel/types.ts";

export type ProGame = "cs2" | "valorant";

export interface Pro {
  /** Stable id: "zywoo". */
  id: string;
  /** The handle they play under. */
  name: string;
  team: string;
  game: ProGame;
  dpi: number;
  pollingHz: number;
  /** In-game sensitivity. */
  sens: number;
  mouse: string;
  keyboard: string;
  /** Actuation point and rapid-trigger sensitivity (mm), only where the pro or the maker published them. */
  actuationMm?: number;
  rtMm?: number;
  /** Where the values were read, and when. */
  source: string;
  checked: string;
}

export const GAME_NAME: Record<ProGame, string> = { cs2: "CS2", valorant: "Valorant" };

/** DPI x sens, as the pro runs it. */
export const proEdpi = (p: Pro): number => edpi(p.dpi, p.sens);

/** The pro's sens as the feel's per-game sens (only their own game). */
export const proSens = (p: Pro): GameSens => ({ cs2: p.game === "cs2" ? p.sens : null, valorant: p.game === "valorant" ? p.sens : null });

/**
 * The pro's mouse part as a feel: their DPI on the step this mouse plays on (its other steps stay as they are) and
 * their polling rate. Lift-off, debounce and the tracking switches aren't published reliably, so they're left alone.
 */
export function proMouseFeel(p: Pro, now: MouseFeel | null): MouseFeel {
  const stages = now && now.stages.length ? now.stages.map((s, i) => (i === now.active ? p.dpi : s)) : [p.dpi];
  const active = now && now.stages.length ? now.active : 0;
  return { stages, active, pollingHz: p.pollingHz, lod: null, debounceMs: null, angleSnapping: null, motionSync: null, ripple: null };
}

/** The pro's keyboard part, when they published one (null otherwise: nothing to change on the keyboard). */
export function proKeyboardFeel(p: Pro): KeyboardFeel | null {
  if (p.actuationMm === undefined && p.rtMm === undefined) return null;
  return {
    actuationMm: p.actuationMm ?? null,
    rapidTrigger: p.rtMm === undefined ? null : true,
    rtPressMm: p.rtMm ?? null,
    rtReleaseMm: p.rtMm ?? null,
    socd: null,
  };
}

export interface ProMousePlan {
  plan: Plan;
  /** The DPI this mouse will run (the nearest it offers to the pro's). */
  dpi: number | null;
  /** The in-game value to type so the turn per inch matches the pro's eDPI. */
  sens: number | null;
  /** DPI x that sens. */
  edpi: number | null;
}

/** The pro's mouse settings on this mouse, and the in-game sens that keeps their eDPI. */
export function planProMouse(p: Pro, device: MouseDevice): ProMousePlan {
  const plan = mapMouse(proMouseFeel(p, device.now), device, proSens(p));
  const line = plan.sens ? plan.sens[p.game] : null;
  const dpi = plan.sens?.newDpi ?? null;
  return { plan, dpi, sens: line ? line.next : null, edpi: line ? line.newEdpi : null };
}

/** The pro's keyboard settings on this keyboard; null when they published none. */
export function planProKeyboard(p: Pro, device: KeyboardDevice): Plan | null {
  const feel = proKeyboardFeel(p);
  return feel ? mapKeyboard(feel, device) : null;
}

/** The sens to type at `dpi` so it turns like the pro (their eDPI / this DPI), as typed in game. */
export const sensAt = (p: Pro, dpi: number): number => roundSens((p.sens * p.dpi) / dpi);

/** Search by handle, team, mouse or game ("zyw", "vitality", "viper", "valorant"). */
export function searchPros(list: readonly Pro[], query: string): Pro[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((p) => [p.name, p.team, p.mouse, p.keyboard, GAME_NAME[p.game]].some((s) => s.toLowerCase().includes(q)));
}

/** Entries that don't hold together (a bad sens, an unknown polling rate, a missing source); empty when all do. */
export function checkPros(list: readonly Pro[]): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const p of list) {
    if (ids.has(p.id)) out.push(`${p.id}: duplicate id`);
    ids.add(p.id);
    if (!(p.dpi >= 100 && p.dpi <= 6400)) out.push(`${p.id}: DPI ${p.dpi}`);
    if (![125, 250, 500, 1000, 2000, 4000, 8000].includes(p.pollingHz)) out.push(`${p.id}: polling ${p.pollingHz}`);
    if (!(p.sens > 0 && p.sens < 20)) out.push(`${p.id}: sens ${p.sens}`);
    if (!/^https:\/\//.test(p.source)) out.push(`${p.id}: source`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.checked)) out.push(`${p.id}: checked date`);
    if (p.rtMm !== undefined && !(p.rtMm > 0 && p.rtMm <= 2)) out.push(`${p.id}: rapid trigger ${p.rtMm}`);
    if (p.actuationMm !== undefined && !(p.actuationMm > 0 && p.actuationMm <= 4)) out.push(`${p.id}: actuation ${p.actuationMm}`);
  }
  return out;
}
