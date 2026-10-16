// The website's host for the generic Keyboard panel: the browser's WebHID through the guarded proxy,
// backups and the write log in this browser's storage, VIA layouts fetched from usevia.app and cached in
// the same storage.
//
// CORS: usevia.app serves /definitions/<v2|v3>/<id>.json with `Access-Control-Allow-Origin: *`
// (checked 2026-10-14), so a plain GET from any origin works. Its OPTIONS answer is 405, so the request
// must stay a "simple" one: no custom headers, and `cache: "no-cache"` (which some browsers turn into a
// conditional-request header) is dropped. If the fetch is blocked anyway (offline, a content blocker, a
// proxy), the panel says so in plain words instead of guessing: see `problem()`.
import { viaDefinitions } from "./via/definitions.ts";
import { viaFetcher } from "../web/via-fetch.ts";
import { CORE_DRIVERS } from "./registry.ts";
import { PLUGIN_DRIVERS } from "./plugins.ts";
import type { KbHost } from "./host.ts";
import type { DefinitionSource } from "./types.ts";

const store = () => import("../web/store.ts").then((m) => m.browserStore());

function webDefinitions(): DefinitionSource {
  let problem: string | null = null;
  const source = viaDefinitions(
    {
      load: async (key) => (await store()).loadDefinition(key),
      save: async (key, json) => (await store()).saveDefinition(key, json),
    },
    viaFetcher((why) => (problem = why)),
  );
  return { get: source.get, kept: "this browser", problem: () => problem };
}

export const webKbHost: KbHost = {
  live: true,
  store: {
    saveBackup: async (prefix, json) => (await store()).saveBackup(prefix, json),
    log: async (prefix, lines) => (await store()).log(`log-${prefix}`, lines),
  },
  async devices() {
    // SYNQ Helper when it's connected (the desktop bridge's guards), else the guarded WebHID.
    const { installTauriHid } = await import("../tauri-hid.ts");
    await installTauriHid();
    return navigator.hid.getDevices();
  },
  drivers: [...CORE_DRIVERS, ...PLUGIN_DRIVERS.filter((p) => !CORE_DRIVERS.some((c) => c.id === p.id))],
  definitions: webDefinitions(),
};
