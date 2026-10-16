// The website has no Sound page (browsers can't reach the system audio), so vite.web.config.ts swaps
// the EQ page for this empty one. That keeps the equalizer's code out of the website bundle without
// touching App.tsx, which never mounts it there (it shows the "desktop app" card instead).
export function EqPage(_props: { notify: unknown }): null {
  return null;
}
