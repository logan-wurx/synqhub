// Whether anyone is looking at SYNQ: the window is shown and has focus. When it isn't, the app
// goes quiet: CSS loops pause (html[data-idle], see index.css), JS loops stop and device polling
// slows down or stops. Nothing here talks to a device.
import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

const read = () => !document.hidden && document.hasFocus();

let active = read();
const listeners = new Set<() => void>();

function update() {
  const next = read();
  if (next === active) return;
  active = next;
  document.documentElement.toggleAttribute("data-idle", !active);
  for (const l of listeners) l();
}

document.documentElement.toggleAttribute("data-idle", !active);
window.addEventListener("focus", update);
window.addEventListener("blur", update);
document.addEventListener("visibilitychange", update);

export const isActive = () => active;

export function onActivityChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the window is shown and focused. */
export function useWindowActive(): boolean {
  return useSyncExternalStore(onActivityChange, isActive);
}

/** True while the element is laid out and at least partly in view (false on a hidden page). */
export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setOn(entries[entries.length - 1].isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}
