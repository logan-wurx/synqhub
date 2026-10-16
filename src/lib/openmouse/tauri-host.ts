// The desktop app's host for the generic mouse panel: HID through SYNQ's Rust bridge, backups
// and logs in the app's data folder (mouse-backups/, next to the Logitech and ATK backups).
import { invoke } from "@tauri-apps/api/core";
import { installTauriHid } from "../tauri-hid.ts";
import { findDriver } from "./registry.ts";
import type { GenericHost } from "./host.ts";
import type { MouseStore } from "./store.ts";

const tauriStore: MouseStore = {
  saveBackup: (prefix, json) => invoke<string>("mouse_backup_save", { json, prefix }),
  log: (prefix, lines) => invoke<void>("mouse_log", { prefix, lines }),
};

export const tauriHost: GenericHost = {
  live: true,
  store: tauriStore,
  async devices() {
    await installTauriHid();
    return navigator.hid ? navigator.hid.getDevices() : [];
  },
  match: findDriver,
};
