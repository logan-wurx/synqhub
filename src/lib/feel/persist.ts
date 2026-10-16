// Where the feel is kept. The desktop app writes one file in its data folder (`feel.json`, through the
// `feel_load` / `feel_save` commands); the website keeps the same text in this browser's IndexedDB (the
// `states` table, so "Download backup" includes it); the browser preview keeps it in memory ("Preview:
// nothing is saved"). The file only ever holds the feel, the seen list and the last-configured marks.
import { invoke } from "@tauri-apps/api/core";
import { isTauri, isWeb } from "../runtime.ts";
import { createFeelStore, type Persist } from "./store.ts";

export function memoryPersist(initial: string | null = null): Persist & { text(): string | null } {
  let text = initial;
  return {
    load: async () => text,
    save: async (json) => {
      text = json;
    },
    text: () => text,
  };
}

export function appPersist(): Persist {
  if (isTauri || isWeb) {
    return {
      load: () => invoke<string | null>("feel_load"),
      save: (json) => invoke<void>("feel_save", { json }),
    };
  }
  return memoryPersist();
}

/** The one store the app uses. */
export const feelStore = createFeelStore(appPersist());
