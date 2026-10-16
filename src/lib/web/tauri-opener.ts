// The website's stand-in for @tauri-apps/plugin-opener: a link opens in a new tab.
export function openUrl(url: string): Promise<void> {
  window.open(url, "_blank", "noopener");
  return Promise.resolve();
}
