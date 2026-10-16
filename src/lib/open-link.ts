// Opening a web page from the app: the system browser in the desktop app, a new tab elsewhere.
import { inTauri } from "./backend";

/** Where SYNQ's source code lives (it is free software under the GNU AGPL 3.0 or later; see LICENSE). */
export const SOURCE_URL = "https://github.com/logan-wurx/synqhub";

export function openLink(url: string) {
  if (inTauri) void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url));
  else window.open(url, "_blank", "noopener");
}
