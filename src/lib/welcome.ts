// The first-run welcome: shown once, then remembered in the app's own data (the WebView's storage lives in
// SYNQ's app data folder, next to the accent). Settings can open it again; that doesn't reset the flag.
import { setKept, useKeptState } from "./keep";
import { isWeb } from "./backend";

const KEY = "onboard.firstRun";

function done(): boolean {
  try {
    return localStorage.getItem(KEY) === "done";
  } catch {
    // No storage: don't nag on every start.
    return true;
  }
}

export const markWelcomeDone = () => {
  try {
    localStorage.setItem(KEY, "done");
  } catch {
    /* nothing to remember it in */
  }
};

/** Whether the welcome is on screen: on the very first launch, and whenever Settings opens it. The website has none. */
export const useWelcomeOpen = () => useKeptState<boolean>("welcome.open", () => !isWeb && !done());
export const openWelcome = () => setKept<boolean>("welcome.open", true);
export const closeWelcome = () => {
  markWelcomeDone();
  setKept<boolean>("welcome.open", false);
};
