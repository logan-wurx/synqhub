// Opening a USB RGB hub: through the bridge (which opens only the hub's vendor collection and checks every report
// against the same allowlist), or, in the browser preview, a simulated hub through the very same session code.
import { invoke } from "@tauri-apps/api/core";
import { liveHardware } from "../../backend";
import { findHub } from "./protocol";
import { HubSession, type HubStore, type HubTransport } from "./session";

function bridge(vid: string, pid: string): HubTransport {
  return {
    write: (f) => invoke("rgbhub_write", { vid, pid, reportId: f.reportId, data: Array.from(f.data) }),
    read: async (timeoutMs) => {
      const r = await invoke<number[] | null>("rgbhub_read", { vid, pid, timeoutMs });
      return r ? Uint8Array.from(r) : null;
    },
    close: () => invoke("rgbhub_close", { vid, pid }),
  };
}

/** Backups go where the keyboards' do (the app's data folder, `rgbhub-` names); the preview keeps nothing. */
const appStore: HubStore = { saveBackup: (prefix, json) => invoke<string>("kb_backup_save", { json, prefix }) };
const previewStore: HubStore = { saveBackup: async (prefix) => `(preview) ${prefix}.json` };

/** The session for a listed hub (`vid:pid`); null when SYNQ doesn't drive that model. */
export async function connectHub(family: string): Promise<HubSession | null> {
  const [vid, pid] = family.split(":");
  const model = findHub(vid, pid);
  if (!model) return null;
  if (!liveHardware) {
    const { simulateHub } = await import("./sim");
    return new HubSession(simulateHub(model), model, previewStore);
  }
  return new HubSession(bridge(model.vid, model.pid), model, appStore);
}
