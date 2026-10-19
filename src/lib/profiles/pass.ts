// SYNQ started by SYNQ Helper with no window (`synq --game-profiles`, src-tauri/helper/src/pass.rs): a game with a
// live profile started or ended while SYNQ was closed (or asleep, minimized). This brings every profiled mouse and
// keyboard to what it should hold now, then SYNQ exits. Nothing is drawn and the window never shows; what couldn't be
// done goes back to the helper, which shows it as a notification.
import { invoke } from "@tauri-apps/api/core";
import { backend } from "../backend.ts";
import { helper } from "../helper.ts";
import { mouseFamilies } from "../mouse-family.ts";
import { keyboardFamilies } from "../kb/probe.ts";
import { EVERY_MS, ProfileRunner } from "./runner.ts";
import { liveDeps } from "./wire.ts";

/** Looks at most (a change that fails is tried MAX_TRIES times, one look apart). */
const MAX_LOOKS = 6;

/** `restore`: game profiles are off or the helper is paused, so only everyday settings go back. */
export async function runPass(restore: boolean): Promise<void> {
  const notices: [string, string][] = [];
  try {
    let list = await backend.devicesList();
    if (list.some((d) => d.generic)) list = await (await import("../generic-mice.ts")).confirmGeneric(list);
    const families = [...mouseFamilies(list), ...keyboardFamilies(list)];
    const { settings } = await helper.status();
    const runner = new ProfileRunner(
      liveDeps({
        enabled: async () => !restore && settings.enabled && settings.gameProfiles,
        connected: () => families,
        notify: (title, text) => notices.push([title, text]),
      }),
    );
    for (let i = 0; i < MAX_LOOKS && !(await runner.tick()); i++) await new Promise((r) => setTimeout(r, EVERY_MS));
  } catch (e) {
    notices.push(["Game profiles not applied", String(e instanceof Error ? e.message : e).replace(/^Error: /, "")]);
  } finally {
    await invoke("profiles_pass_done", { notices });
  }
}
