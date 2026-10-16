// What the sidebar calls the Mouse page: the plugged-in mouse, the one that answers when several are
// plugged in, or a count. Pure (no React, no Tauri), so it can be checked without a window.
import type { Connected } from "./backend.ts";
import { familyOf, mouseFamilies } from "./mouse-family.ts";
import type { Answers } from "./mouse-order.ts";

const shortMouse = (d: Connected, names: ReadonlyMap<string, string>) => (d.vid === "046d" && d.pid === "c54d" ? (names.get("logitech") ?? d.name) : d.name.replace(/^ATK /, "").replace(/\s+(4K|8K)?\s*(Dongle|Receiver)$/i, ""));

/**
 * Sidebar hint for the Mouse page: the detected mouse, "2 mice", or "Not connected". When several are
 * plugged in and exactly one of them answered the quick check (src/lib/mouse-probe.ts), it names that
 * one, since a receiver stays plugged in when its mouse is off.
 */
export function mouseHint(devices: readonly Connected[], names: ReadonlyMap<string, string>, answers?: Answers): string {
  const mice = [...new Set(devices.filter((d) => d.kind === "mouse" && !d.bootloader).map((d) => shortMouse(d, names)))];
  if (mice.length > 1 && answers) {
    const families = mouseFamilies(devices);
    const live = families.filter((f) => answers.get(f) === "answers");
    if (families.length > 1 && families.every((f) => answers.has(f)) && live.length === 1) {
      const d = devices.find((x) => familyOf(x) === live[0]);
      if (d) return shortMouse(d, names);
    }
  }
  return mice.length > 1 ? `${mice.length} mice` : (mice[0] ?? "Not connected");
}
