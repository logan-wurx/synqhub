// Where the website sends people for the desktop app: the newest release's installers on GitHub. Change it here and
// every "Get the desktop app" link follows.
export const DESKTOP_APP_URL = "https://github.com/logan-wurx/synqhub/releases/latest";
/** SYNQ Helper on its own for Windows, the newest release's one file. Double-clicked it installs itself in the
 * person's folder, no administrator (src-tauri/helper/src/standalone.rs); release/tools/build-release.mjs files it. */
export const HELPER_DOWNLOAD_URL = "https://github.com/logan-wurx/synqhub/releases/latest/download/synq-helper.exe";
/** SYNQ's Discord server: a permanent invite (src/components/web/Community.tsx). */
export const DISCORD_URL = "https://discord.gg/WP9HFebp8D";
/** The website's own origin. SYNQ Helper accepts connections from this origin only: keep it in step with
 * src-tauri/src/helper_cfg.rs `SITE_ORIGIN` (scripts/helper-bridge.test.ts checks). */
export const SITE_ORIGIN = "https://synqhub.app";

/** Chrome and Edge are the browsers with WebHID; these are their home pages for the "use another browser" page. */
export const BROWSER_LINKS = {
  chrome: "https://www.google.com/chrome/",
  edge: "https://www.microsoft.com/edge",
  opera: "https://www.opera.com/",
} as const;
