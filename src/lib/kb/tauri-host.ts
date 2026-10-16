// The desktop app's host for the generic Keyboard panel: HID through SYNQ's Rust bridge, backups
// and the write log in the app's data folder (keyboard-backups/), VIA layouts cached in via-definitions/.
import { invoke } from "@tauri-apps/api/core";
import { installTauriHid } from "../tauri-hid.ts";
import { viaDefinitions } from "./via/definitions.ts";
import { CORE_DRIVERS } from "./registry.ts";
import { PLUGIN_DRIVERS } from "./plugins.ts";
import type { KbHost } from "./host.ts";

export const tauriKbHost: KbHost = {
  live: true,
  store: {
    saveBackup: (prefix, json) => invoke<string>("kb_backup_save", { json, prefix }),
    log: (prefix, lines) => invoke<void>("kb_log", { prefix, lines }),
  },
  async devices() {
    await installTauriHid();
    return navigator.hid ? navigator.hid.getDevices() : [];
  },
  drivers: [...CORE_DRIVERS, ...PLUGIN_DRIVERS.filter((p) => !CORE_DRIVERS.some((c) => c.id === p.id))],
  definitions: viaDefinitions({
    load: (key) => invoke<string | null>("kb_definition_load", { key }),
    save: (key, json) => invoke<void>("kb_definition_save", { key, json }),
  }),
};
