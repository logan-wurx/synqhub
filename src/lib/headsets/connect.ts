// Opening a headset's session: through the desktop bridge (which opens only the family's one collection and checks
// every report again), or, in the browser preview, a simulated headset through the very same session code.
// SYNQ's copy of the settings and the backups go to the app's data folder (the keyboard files, `headset-` names).
import { invoke } from "@tauri-apps/api/core";
import { liveHardware } from "../backend";
import { installTauriHid } from "../tauri-hid";
import { findHeadset } from "./protocol";
import { HeadsetSession, type HeadsetStore, type HidLike } from "./session";

const serial = (key: string) => `headset-${key.replace(":", "-")}`;

const appStore: HeadsetStore = {
  saveBackup: (prefix, json) => invoke<string>("kb_backup_save", { json, prefix }),
  load: async (key) => {
    const text = await invoke<string | null>("keyboard_state_load", { serial: serial(key) });
    return text ? (JSON.parse(text) as Record<string, number>) : null;
  },
  save: (key, values) => invoke("keyboard_state_save", { serial: serial(key), json: JSON.stringify(values) }),
};

function memoryStore(): HeadsetStore {
  const kept = new Map<string, Record<string, number>>();
  return {
    saveBackup: async (prefix) => `(preview) ${prefix}.json`,
    load: async (key) => kept.get(key) ?? null,
    save: async (key, values) => void kept.set(key, values as Record<string, number>),
  };
}
const previewStore = memoryStore();

/** The session for a listed headset (`vid:pid`), opened; null when it isn't there any more. */
export async function connectHeadset(family: string): Promise<HeadsetSession | null> {
  const [vid, pid] = family.split(":");
  const model = findHeadset(vid, pid);
  if (!model) return null;
  if (!liveHardware) {
    const { simulateHeadset } = await import("./sim");
    const s = new HeadsetSession(simulateHeadset(model), model, previewStore);
    await s.open();
    return s;
  }
  await installTauriHid();
  const devices = await navigator.hid.getDevices();
  const dev = devices.find((d) => d.vendorId === parseInt(vid, 16) && d.productId === parseInt(pid, 16));
  if (!dev) return null;
  const s = new HeadsetSession(dev as unknown as HidLike, model, appStore);
  await s.open();
  return s;
}
