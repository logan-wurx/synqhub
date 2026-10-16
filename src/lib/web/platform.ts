// What the page is running on: the OS, the Chromium browser and its major version. Read from the user
// agent and (where there is one) navigator.userAgentData. Pure: pass the strings in, so the tests don't
// need a browser.
export type Os = "windows" | "mac" | "linux" | "chromeos" | "android" | "other";
export type Browser = "chrome" | "edge" | "opera" | "chromium" | "firefox" | "safari" | "other";

export interface Platform {
  os: Os;
  browser: Browser;
  /** The Chromium major version (Chrome, Edge, Opera and other Chromium browsers share it), or null when unknown. */
  chromium: number | null;
}

export function parsePlatform(userAgent: string, platformHint = ""): Platform {
  const ua = userAgent;
  const fromUa = (u: string): Os =>
    /CrOS/.test(u) ? "chromeos" : /Android/.test(u) ? "android" : /Windows/.test(u) ? "windows" : /Mac OS X|Macintosh/.test(u) ? "mac" : /Linux|X11/.test(u) ? "linux" : "other";
  // The user agent string wins; the platform hint only fills in when the string says nothing.
  const hint: Os = /^win/i.test(platformHint) ? "windows" : /^mac/i.test(platformHint) ? "mac" : /^linux/i.test(platformHint) ? "linux" : "other";
  const os: Os = fromUa(ua) !== "other" ? fromUa(ua) : hint;
  const major = (re: RegExp) => {
    const m = ua.match(re);
    return m ? Number(m[1]) : null;
  };
  const edge = /\bEdg(?:e|A|iOS)?\/(\d+)/.test(ua);
  const opera = /\bOPR\/(\d+)/.test(ua);
  const firefox = /\b(Firefox|FxiOS)\/(\d+)/.test(ua);
  const chromium = major(/\bChrom(?:e|ium)\/(\d+)/);
  let browser: Browser = "other";
  if (firefox) browser = "firefox";
  else if (edge) browser = "edge";
  else if (opera) browser = "opera";
  else if (chromium !== null) browser = /\bChrome\//.test(ua) ? "chrome" : "chromium";
  else if (/\bSafari\//.test(ua)) browser = "safari";
  return { os, browser, chromium: browser === "firefox" || browser === "safari" ? null : chromium };
}

/**
 * Whether SYNQ Helper (src-tauri/helper) exists for this system, so a browser without WebHID (Firefox,
 * a Chromium with it switched off) can still reach devices through it. Windows and Linux only for now; there
 * is no Mac build yet, and Safari refuses a ws:// connection from an https page anyway.
 */
export function helperOffered(p: Platform): boolean {
  return (p.os === "windows" || p.os === "linux") && p.browser !== "safari";
}

/** The platform of the page this code runs in. */
export function currentPlatform(): Platform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return parsePlatform(navigator.userAgent, nav.userAgentData?.platform ?? navigator.platform ?? "");
}

export const OS_NAMES: Record<Os, string> = { windows: "Windows", mac: "macOS", linux: "Linux", chromeos: "ChromeOS", android: "Android", other: "this system" };
