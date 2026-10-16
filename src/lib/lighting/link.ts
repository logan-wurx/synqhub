// Reaching lamps: the list the bridge's Bluetooth scan heard (src-tauri/src/lighting), and a link to one open lamp
// (its decrypted reports come back as events), with screen sync, which the bridge runs. The browser preview and the
// end-to-end build get the simulated lamps (loaded only when one is opened). The website lists the lamps the person
// added in the browser's Bluetooth chooser and reaches them through Web Bluetooth (./web/link.ts, loaded only there).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { inTauri } from "../backend";
import type { Rgb, UploadKind } from "./govee/frames.ts";
import { SIM_LAMPS, type LampInfo, type SyncEdge, type SyncInfo } from "./models.ts";

// The website build defines `__ONBOARD_WEB__`; everywhere else the website's Bluetooth code below is dead and stays
// out of the bundle.
const WEB = typeof __ONBOARD_WEB__ !== "undefined" && __ONBOARD_WEB__ === true;

/** The website can reach Govee lamps: the browser has Web Bluetooth (Chrome and Edge). */
export const webBluetooth: boolean = WEB && typeof navigator !== "undefined" && "bluetooth" in navigator;

export interface LampLink {
  readonly id: string;
  /** How the lamp's link is protected: "encryption v1", "encryption v2" or "plaintext". */
  readonly scheme: string;
  /** A screen sync that was already running when the page opened the lamp. */
  readonly sync: SyncInfo | null;
  send(frames: readonly Uint8Array[]): Promise<void>;
  /** A catalogue scene's data (with the scene's code) or a DIY effect; true when the lamp acknowledged it. */
  upload(kind: UploadKind, body: Uint8Array, code?: number): Promise<boolean>;
  onReport(cb: (f: Uint8Array) => void): () => void;
  onLost(cb: (why: string) => void): () => void;
  startSync(edge: SyncEdge, vivid: boolean, monitor: string | null): Promise<SyncInfo>;
  stopSync(): Promise<void>;
  /** The colours sync sent, or holds (`blind`: the screen can't be seen, the last colours stay). */
  onSync(cb: (colours: Rgb[], blind: boolean) => void): () => void;
  onSyncStopped(cb: (why: string) => void): () => void;
  close(): Promise<void>;
}

// The preview's sync state, kept here (not in the page) because a sync outlives the lamp's page, as the bridge's does.
const previewSync = new Map<string, SyncInfo>();
const syncHeard = new Map<string, Set<(colours: Rgb[], blind: boolean) => void>>();
const syncEnded = new Map<string, Set<(why: string) => void>>();
const listenersOf = <T>(map: Map<string, Set<T>>, id: string) => map.get(id) ?? map.set(id, new Set()).get(id)!;
const subscribe = <T>(map: Map<string, Set<T>>, id: string, cb: T) => {
  listenersOf(map, id).add(cb);
  return () => void listenersOf(map, id).delete(cb);
};

export async function listLamps(): Promise<LampInfo[]> {
  if (WEB) return webBluetooth ? (await import("./web/link.ts")).webLamps() : [];
  if (!inTauri) return SIM_LAMPS.map((s) => ({ id: s.id, name: s.name, sku: s.name.split("_")[1], rssi: s.rssi, heardMs: 600, sync: previewSync.get(s.id) ?? null }));
  return invoke<LampInfo[]>("lights_list");
}

/** Stops a lamp's screen sync from anywhere (the Devices home card), whether or not its page is open. */
export async function stopLampSync(id: string): Promise<void> {
  if (inTauri) return invoke("light_sync_stop", { id });
  // No lamp syncs on the website (src/lib/lighting/web/link.ts `WEB_NO_SYNC`): there is nothing to stop.
  if (WEB) return;
  const sim = await import("./govee/sim.ts");
  if (sim.simSyncStop(id)) {
    previewSync.delete(id);
    listenersOf(syncEnded, id).forEach((cb) => cb("Stopped."));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function openLamp(lamp: LampInfo): Promise<LampLink> {
  if (WEB) return (await import("./web/link.ts")).openWebLamp(lamp);
  if (!inTauri) {
    const spec = SIM_LAMPS.find((s) => s.id === lamp.id);
    await sleep(700);
    if (!spec?.reachable) throw new Error("The lamp didn't answer.");
    const simModule = await import("./govee/sim.ts");
    const sim = simModule.simLamp(spec);
    const lost = new Set<(why: string) => void>();
    return {
      id: lamp.id,
      scheme: "encryption v1",
      sync: previewSync.get(lamp.id) ?? null,
      send: async (frames) => {
        for (const f of frames) sim.send(f);
      },
      upload: async (kind, body, code) => sim.upload(kind, body, code),
      onReport: (cb) => sim.onReport(cb),
      onLost: (cb) => {
        lost.add(cb);
        return () => lost.delete(cb);
      },
      startSync: async (edge, vivid, monitor) => {
        const info = { edge, vivid, monitor };
        previewSync.set(lamp.id, info);
        simModule.simSyncStart(spec, edge, (c, blind) => listenersOf(syncHeard, lamp.id).forEach((cb) => cb(c, blind)));
        return info;
      },
      stopSync: () => stopLampSync(lamp.id),
      onSync: (cb) => subscribe(syncHeard, lamp.id, cb),
      onSyncStopped: (cb) => subscribe(syncEnded, lamp.id, cb),
      close: async () => lost.clear(),
    };
  }
  const opened = await invoke<{ scheme: string; sync: SyncInfo | null }>("light_open", { id: lamp.id });
  const reports = new Set<(f: Uint8Array) => void>();
  const lost = new Set<(why: string) => void>();
  const synced = new Set<(colours: Rgb[], blind: boolean) => void>();
  const ended = new Set<(why: string) => void>();
  const offs = await Promise.all([
    listen<{ id: string; frame: number[] }>("light-report", (e) => {
      if (e.payload.id === lamp.id) reports.forEach((cb) => cb(Uint8Array.from(e.payload.frame)));
    }),
    listen<{ id: string; why: string }>("light-lost", (e) => {
      if (e.payload.id === lamp.id) lost.forEach((cb) => cb(e.payload.why));
    }),
    listen<{ id: string; colours: [number, number, number][]; blind: boolean }>("light-sync", (e) => {
      if (e.payload.id === lamp.id) synced.forEach((cb) => cb(e.payload.colours, e.payload.blind));
    }),
    listen<{ id: string; why: string }>("light-sync-stopped", (e) => {
      if (e.payload.id === lamp.id) ended.forEach((cb) => cb(e.payload.why));
    }),
  ]);
  const add = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    return () => void set.delete(cb);
  };
  return {
    id: lamp.id,
    scheme: opened.scheme,
    sync: opened.sync,
    send: (frames) => invoke("light_send", { id: lamp.id, frames: frames.map((f) => Array.from(f)) }),
    upload: (kind, body, code) => invoke<boolean>("light_upload", { id: lamp.id, kind, body: Array.from(body), code: code ?? null }),
    onReport: (cb) => add(reports, cb),
    onLost: (cb) => add(lost, cb),
    startSync: (edge, vivid, monitor) => invoke<SyncInfo>("light_sync_start", { id: lamp.id, edge, vivid, monitor }),
    stopSync: () => invoke("light_sync_stop", { id: lamp.id }),
    onSync: (cb) => add(synced, cb),
    onSyncStopped: (cb) => add(ended, cb),
    close: async () => {
      offs.forEach((off) => off());
      await invoke("light_close", { id: lamp.id });
    },
  };
}
