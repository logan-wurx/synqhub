// Small per-viewer preferences for the website, in localStorage. Storage can be missing or throw (a
// private window, blocked site data), so every read and write is inside try/catch and the page works
// without it. Nothing that must survive (backups, device state) belongs here: that is src/lib/web/store.ts.
const PREFIX = "onboard.web.";

export function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writeSetting(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, value);
  } catch {
    /* a preference only */
  }
}
