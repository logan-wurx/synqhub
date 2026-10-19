// The runner (./runner.ts) on the real thing: which games are running and what is held come from the app's bridge
// (src-tauri/src/lib.rs) or, on the website, from SYNQ Helper (src-tauri/helper/src/bridge.rs); devices open through
// their own sessions (./live.ts).
import { invoke } from "@tauri-apps/api/core";
import { inTauri, isWeb } from "../backend.ts";
import { helper } from "../helper.ts";
import { openLive } from "./live.ts";
import type { HeldMap, RunnerDeps } from "./runner.ts";

/** The games running now (ids), and for the website whether the SYNQ app is open (it puts profiles on then). */
export interface Running {
  ids: string[];
  app: boolean;
}

export const gamesRunning = (): Promise<Running> => invoke<Running>("games_running");

export async function loadHeld(): Promise<HeldMap> {
  const text = await invoke<string | null>("live_held_load");
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as HeldMap) : {};
  } catch {
    return {};
  }
}

export const saveHeld = (held: HeldMap): Promise<void> => invoke<void>("live_held_save", { json: JSON.stringify(held) });

/** Desktop: one SYNQ at a time (an open window, or the start with no window) holds this until it exits. */
export const claim = (): Promise<boolean> => invoke<boolean>("profiles_claim").catch(() => false);

/** What the runner needs, given how this copy says whether game profiles are on, what is plugged in, and how it
 * tells the person. */
export function liveDeps(own: Pick<RunnerDeps, "enabled" | "connected" | "notify">): RunnerDeps {
  // The website asks once per look: the answer says both what is running and whether the app is open.
  let last: Running | null = null;
  const mine = inTauri
    ? claim
    : isWeb
      ? async () => {
          last = await gamesRunning();
          return !last.app;
        }
      : async () => false;
  return {
    ...own,
    mine,
    running: async () => {
      const r = last ?? (await gamesRunning());
      last = null;
      return r.ids;
    },
    games: () => helper.gamesLoad(),
    loadHeld,
    saveHeld,
    open: openLive,
    now: () => Date.now(),
  };
}
