// CI's end-to-end build (`npm run build:e2e`, see src/lib/runtime.ts `isE2E`): every console error, uncaught
// error and unhandled rejection is recorded on `window.__onboardE2E`, so the WebDriver tests can check that
// none happened (WebKitGTK's driver can't read the console). Imported first in main.tsx; in every other build
// `isE2E` is false and this does nothing.
import { isE2E } from "./runtime";

declare global {
  interface Window {
    __onboardE2E?: { errors: string[] };
  }
}

if (isE2E && typeof window !== "undefined") {
  const errors: string[] = [];
  window.__onboardE2E = { errors };
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
    original(...args);
  };
  window.addEventListener("error", (e) => errors.push(`uncaught: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => errors.push(`unhandled rejection: ${String(e.reason)}`));
}

export {};
