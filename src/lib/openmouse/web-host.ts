// The website's host for the generic mouse panel: the browser's WebHID through the guarded proxy
// (src/lib/web/hid.ts), backups and logs in this browser's storage (IndexedDB, with a download button
// in Settings). Same shape as tauri-host.ts.
import { findDriver } from "./registry.ts";
import type { GenericHost } from "./host.ts";
import type { MouseStore } from "./store.ts";

const store = () => import("../web/store.ts").then((m) => m.browserStore());

const webStore: MouseStore = {
  saveBackup: async (prefix, json) => (await store()).saveBackup(prefix, json),
  log: async (prefix, lines) => (await store()).log(`log-${prefix}`, lines),
};

export const webMouseHost: GenericHost = {
  live: true,
  store: webStore,
  async devices() {
    // SYNQ Helper when it's connected (the desktop bridge's guards), else the guarded WebHID.
    const { installTauriHid } = await import("../tauri-hid.ts");
    await installTauriHid();
    return navigator.hid.getDevices();
  },
  match: findDriver,
};
