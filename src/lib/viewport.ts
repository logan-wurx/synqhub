// The window's size as the layout needs it. Both hooks re-render only when the answer changes (a media
// query for the wide layout) or while the window is being resized (the height); nothing runs otherwise.
import { useEffect, useState, useSyncExternalStore } from "react";

/** From this window width on, a device page puts its picture and status in a column beside the tab content. */
export const WIDE_PX = 1500;

const query = `(min-width: ${WIDE_PX}px)`;
const subscribe = (cb: () => void) => {
  const m = window.matchMedia(query);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};

export const useWide = (): boolean => useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);

/** The window's inner height, updated while it is resized. */
export function useViewportHeight(): number {
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener("resize", on, { passive: true });
    return () => window.removeEventListener("resize", on);
  }, []);
  return h;
}
