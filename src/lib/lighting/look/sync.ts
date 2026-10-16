// Screen sync across lights (wave L5): Govee lamps keep their own Bluetooth sync (each lamp's bridge thread), Wi-Fi
// lights and USB hubs follow one sampler in the bridge (src-tauri/src/lighting/sync.rs), and Hue lights in an
// Entertainment area go through its stream. Dynamic Lighting devices are left out (Windows lets only the app in front drive them, and sync
// is for when SYNQ isn't in front); the Lights view says so, and why for any other light that can't follow.
// The browser preview runs a pretend sync with no screen and no network. On the website the sampler is SYNQ Helper's
// (a page can't read the screen while it's in the background): Wi-Fi lights and hubs follow, through it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { inTauri, isWeb } from "../../backend";
import { WEB_HELPER_ONLY } from "../../runtime";
import type { Rgb } from "../govee/frames.ts";
import { stopLampSync } from "../link.ts";
import type { SyncEdge } from "../models.ts";
import type { Driver } from "./control.ts";
import type { LightRef } from "./lights.ts";

export interface HueArea {
  id: string;
  name: string;
  lights: string[];
  /** SYNQ made it (only this one can be removed here). */
  ours: boolean;
}

export interface LightsSync {
  running: boolean;
  /** The lights following the screen, by key. */
  keys: readonly string[];
  colours: Readonly<Record<string, Rgb>>;
  /** The screen can't be seen; the lights hold their colours. */
  blind: boolean;
  /** Lights let go during the sync, and why. */
  dropped: Readonly<Record<string, string>>;
  /** Why the last sync ended. */
  ended: string | null;
}

const IDLE: LightsSync = { running: false, keys: [], colours: {}, blind: false, dropped: {}, ended: null };
let state: LightsSync = IDLE;
const subs = new Set<() => void>();
const set = (patch: Partial<LightsSync>) => {
  state = { ...state, ...patch };
  subs.forEach((cb) => cb());
};
let listening: Promise<void> | null = null;
let pretend: ReturnType<typeof setInterval> | null = null;

/** Whether a bridge runs the sync: the desktop app's, or on the website SYNQ Helper once it is connected. */
async function bridged(): Promise<boolean> {
  if (inTauri) return true;
  if (!isWeb) return false;
  if ((await import("../../web/helper.ts")).helperReady()) return true;
  throw new Error(WEB_HELPER_ONLY);
}

async function listenOnce() {
  if (!(await bridged())) return;
  listening ??= Promise.all([
    listen<{ keys: string[]; colours: Rgb[]; blind: boolean }>("net-sync", (e) => set({ colours: { ...state.colours, ...Object.fromEntries(e.payload.keys.map((k, i) => [k, e.payload.colours[i]])) }, blind: e.payload.blind })),
    listen<{ key: string; why: string }>("net-sync-dropped", (e) => set({ dropped: { ...state.dropped, [e.payload.key]: e.payload.why } })),
    listen<{ why: string }>("net-sync-stopped", (e) => set({ running: false, ended: e.payload.why === "Stopped." ? null : e.payload.why })),
  ]).then(() => undefined);
  return listening;
}

/** A light as the bridge's sync takes it: a Wi-Fi light by its brand and address, a hub by its ids and channels. */
function member(r: LightRef, d: Driver | undefined) {
  const base = { key: r.key, sub: null as string | null, mac: null as string | null, model: "", channels: null as (readonly (readonly [number, number])[]) | null };
  if (r.source === "wifi") return { ...base, brand: r.device.brand, id: r.device.id, sub: r.device.sub ?? null, mac: r.device.mac ?? null, model: r.device.model };
  if (r.source === "hub") return { ...base, brand: "hub", id: r.family, channels: d?.hubChannels ?? [] };
  return null;
}

/**
 * Starts screen sync on these lights, all reading one display (`monitor`; null: the primary): each Govee lamp's own,
 * each hub made ready (its backup kept), then the Wi-Fi lights and hubs in the bridge together, Hue lights in `area`
 * through its stream.
 */
export async function startLightsSync(
  members: readonly LightRef[],
  edge: SyncEdge,
  vivid: boolean,
  monitor: string | null,
  drivers: readonly Driver[],
  area: { bridge: string; area: HueArea } | null,
): Promise<void> {
  await listenOnce();
  const driver = (key: string) => drivers.find((d) => d.key === key);
  set({ ...IDLE, running: true, keys: members.map((r) => r.key) });
  await Promise.all(members.filter((r) => r.source === "govee" || r.source === "hub").map((r) => driver(r.key)?.sync?.start(edge, vivid, monitor)));
  const wifi = members.flatMap((r) => member(r, driver(r.key)) ?? []);
  if (!wifi.length) return;
  if (await bridged()) {
    await invoke("net_sync_start", { members: wifi, edge, vivid, monitor, area: area ? { bridge: area.bridge, area: area.area.id, lights: area.area.lights } : null });
    return;
  }
  // The preview: colours drift along a hue wheel, as if a film played.
  let t = 0;
  if (pretend) clearInterval(pretend);
  pretend = setInterval(() => {
    t += 1;
    const colours = Object.fromEntries(wifi.map((m, i) => [m.key, hsl((t * 9 + i * 40) % 360)]));
    set({ colours: { ...state.colours, ...colours } });
  }, 400);
}

export async function stopLightsSync(): Promise<void> {
  const govee = state.keys.filter((k) => k.startsWith("govee:")).map((k) => k.slice(6));
  set({ running: false });
  if (pretend) clearInterval(pretend);
  pretend = null;
  await Promise.allSettled([bridged().then((b) => b && invoke("net_sync_stop")), ...govee.map((id) => stopLampSync(id))]);
}

function hsl(h: number): Rgb {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

export const useLightsSync = (): LightsSync => useSyncExternalStore((cb) => (subs.add(cb), () => void subs.delete(cb)), () => state);

// ---- Hue Entertainment areas (the preview keeps pretend ones in memory)

const pretendAreas = new Map<string, HueArea[]>();

export async function hueAreas(bridge: string): Promise<HueArea[]> {
  if (await bridged()) return invoke<HueArea[]>("hue_areas", { bridge });
  return pretendAreas.get(bridge) ?? [];
}

/** Makes SYNQ's area with these lights (after the person confirmed what changes on the bridge). */
export async function createHueArea(bridge: string, lights: readonly string[]): Promise<HueArea> {
  if (await bridged()) return invoke<HueArea>("hue_area_create", { bridge, lights });
  const area = { id: "7", name: "SYNQ", lights: [...lights], ours: true };
  pretendAreas.set(bridge, [...(pretendAreas.get(bridge) ?? []), area]);
  return area;
}

/** Removes the area SYNQ made, and only that one. */
export async function removeHueArea(bridge: string): Promise<void> {
  if (await bridged()) return invoke("hue_area_remove", { bridge });
  pretendAreas.set(bridge, (pretendAreas.get(bridge) ?? []).filter((a) => !a.ours));
}
