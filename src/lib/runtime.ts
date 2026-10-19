// Where this copy of SYNQ runs. Three modes share one codebase:
//   tauri    the desktop app: HID and files go through the Rust bridge (src-tauri/src/hid.rs).
//   web      the static website (`npm run build:web`): the browser's own WebHID, wrapped in the
//            guarded proxy (src/lib/web/guard.ts); backups in IndexedDB, settings in localStorage.
//   preview  `vite dev` in a plain browser: sample devices, nothing real.
// `__ONBOARD_WEB__` is set by vite.web.config.ts, so the web-only code is dead code everywhere else.
declare const __ONBOARD_WEB__: boolean | undefined;
// CI's end-to-end build (`npm run build:e2e`, vite mode "e2e"): the real desktop app with the preview's sample
// devices, so the UI can be driven in a CI runner with no hardware. Never in a release build.
declare const __ONBOARD_E2E__: boolean | undefined;

export type RunMode = "tauri" | "web" | "preview";

/** The website build (vite.web.config.ts defines `__ONBOARD_WEB__`; the desktop config defines it false). */
export const isWeb: boolean = typeof __ONBOARD_WEB__ !== "undefined" && __ONBOARD_WEB__ === true;
/** The end-to-end test build: inside the app, but every call goes to the preview's samples. */
export const isE2E: boolean = typeof __ONBOARD_E2E__ !== "undefined" && __ONBOARD_E2E__ === true;
export const isTauri: boolean = !isWeb && !isE2E && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const runMode: RunMode = isWeb ? "web" : isTauri ? "tauri" : "preview";
let helperProbe: () => boolean = () => false;
/** src/lib/web/helper.ts says here, when it loads, how to tell whether SYNQ Helper is connected. */
export function registerHelperProbe(probe: () => boolean): void {
  helperProbe = probe;
}
/** The website with SYNQ Helper connected: the Games page and the helper's jobs go to the helper, which keeps
 * them where the desktop app does and asks the person before saving profiles (src-tauri/helper/src/bridge.rs). */
export async function viaHelper(): Promise<boolean> {
  return isWeb && helperProbe();
}
/** Real hardware behind the page (the desktop bridge or WebHID); false only in the sample-device preview. */
export const liveHardware: boolean = isWeb || isTauri;

/** What the website says for a feature only the desktop app has (Sound / EQ, the Advanced actions). */
export const WEB_DESKTOP_ONLY = "This needs the SYNQ desktop app.";
/** What the website says for something SYNQ Helper does for it (monitors, webcams, Wi-Fi lights, the EQ) while it isn't connected. */
export const WEB_HELPER_ONLY = "This needs SYNQ Helper. Get it in Settings, then try again.";

export type Platform = "windows" | "linux" | "macos" | "other";

/**
 * The OS this copy runs on, from the web view (WebView2 on Windows, WebKitGTK on Linux). The preview can be
 * shown as another with `?platform=linux` (or windows / macos), to see the Linux pages in a browser.
 */
function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  if (!isTauri && typeof location !== "undefined") {
    const asked = new URLSearchParams(location.search).get("platform");
    if (asked === "linux" || asked === "windows" || asked === "macos") return asked;
  }
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return "other";
}

export const platform: Platform = detectPlatform();
/** The desktop app (or its preview) on Linux: PipeWire's EQ, udev device access, XDG autostart. */
export const isLinux: boolean = !isWeb && platform === "linux";
