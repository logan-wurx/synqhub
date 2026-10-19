// First: the end-to-end build records console errors from the very start (a no-op in every other build).
import "./lib/e2e";
import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "motion/react";
import App from "./App";
import { isTauri } from "./lib/runtime";
import "./index.css";

const WEB = typeof __ONBOARD_WEB__ !== "undefined" && __ONBOARD_WEB__ === true;

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// The website after an update: a page opened before it may ask for a part the new upload doesn't have. It reloads
// onto the new version, once per tab, rather than leaving a page that doesn't work (release/tools/deploy-web.mjs).
if (WEB) {
  window.addEventListener("vite:preloadError", (e) => {
    try {
      if (sessionStorage.getItem("synq.reloaded")) return;
      sessionStorage.setItem("synq.reloaded", "1");
    } catch {
      return;
    }
    e.preventDefault();
    location.reload();
  });
}

async function boot() {
  // SYNQ Helper started this copy with no window, to put game profiles on (src/lib/profiles/pass.ts): nothing is drawn.
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const mode = await invoke<string>("launch_mode").catch(() => "app");
    if (mode !== "app") return (await import("./lib/profiles/pass")).runPass(mode === "restore");
  }
  if (WEB) {
    if ("hid" in navigator && (navigator as Navigator & { hid?: unknown }).hid) {
      // From here on every `navigator.hid` the drivers see is the guarded one (src/lib/web/hid.ts).
      await (await import("./lib/web/hid")).installWebHid();
    } else {
      // No WebHID (Firefox, Safari, a page that isn't https): SYNQ Helper can do the device work instead
      // (every command then goes to it, src/lib/web/tauri-core.ts). Reconnect when this browser connected it
      // before; otherwise a page that says how, and none of the app's device code is loaded.
      const helper = await import("./lib/web/helper");
      await helper.helperSettled();
      if (!helper.helperReady()) {
        const { UnsupportedBrowser } = await import("./components/web/UnsupportedBrowser");
        root.render(
          <React.StrictMode>
            <UnsupportedBrowser secureContext={window.isSecureContext} />
          </React.StrictMode>,
        );
        return;
      }
    }
  }
  root.render(
    <React.StrictMode>
      {/* With "reduce motion" on in the system, entrances and layout moves happen at once (opacity only). */}
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </React.StrictMode>,
  );
}

void boot();
