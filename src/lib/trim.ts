// Hands memory back to Windows at quiet moments: a while after a device page was closed, and a
// while after the window went to the background. The app (src-tauri/src/sleep.rs) sets WebView2's
// memory target to Low for a moment and back to Normal: scripts keep running and nothing on screen
// changes, but what the page isn't using is released. Minimized is handled there on its own.
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./backend";
import { isActive, onActivityChange } from "./activity";

/** After closing the Mouse or Keyboard page: long enough for its garbage to be collected first. */
const AFTER_PAGE_MS = 15_000;
/** After the window lost focus (say, back to a game). */
const BACKGROUND_MS = 30_000;

const trim = () => void invoke("memory_trim").catch(() => undefined);

let pageTimer = 0;
/** A device page was closed (`closed`) or opened (`!closed`, which cancels a pending trim). */
export function devicePageClosed(closed: boolean) {
  if (!inTauri) return;
  window.clearTimeout(pageTimer);
  pageTimer = closed ? window.setTimeout(trim, AFTER_PAGE_MS) : 0;
}

let backgroundTimer = 0;
let wasActive = isActive();
if (inTauri) {
  onActivityChange(() => {
    const active = isActive();
    window.clearTimeout(backgroundTimer);
    backgroundTimer = 0;
    // Shown but no longer focused: trim once it's stayed that way a while.
    if (wasActive && !active && !document.hidden) backgroundTimer = window.setTimeout(trim, BACKGROUND_MS);
    wasActive = active;
  });
}
