// The window's size as the layout needs it. Both hooks re-render only when the answer changes (a media
// query for the wide layout) or while the window is being resized (the height); nothing runs otherwise.
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

/**
 * From this window width on, a device page would put its picture and status in a column beside the tab content.
 * Retired with the final design: every page uses its tabs at every width (the Overview is a tab), laid out to fit
 * 1920x1080 and 1480x920 alike, so there is one layout to get right.
 */
export const WIDE_PX = 100_000;

const query = `(min-width: ${WIDE_PX}px)`;
const subscribe = (cb: () => void) => {
  const m = window.matchMedia(query);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};

export const useWide = (): boolean => useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);

/** Room kept under a page's content for the dock and its gap (the pages scroll under the dock). */
export const DOCK_CLEAR = 124;

/**
 * A grid's width and the height left under its top down to the dock, for grids that size their tiles to fill the
 * window (the Gear and Lights tiles, the Games covers). The top is measured in the page's scroll space, so it holds
 * while the page is scrolled.
 */
export function useGridRoom<T extends HTMLElement>(deps: readonly unknown[] = []) {
  // A callback ref: the grid can mount after the page (Games shows it again after a game's page).
  const [el, ref] = useState<T | null>(null);
  const vh = useViewportHeight();
  const [box, setBox] = useState({ w: 0, top: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const scroller = el.closest(".overflow-y-auto");
      setBox((b) => {
        const next = { w: Math.round(r.width), top: Math.round(r.top + (scroller?.scrollTop ?? 0)) };
        return b.w === next.w && b.top === next.top ? b : next;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, vh, ...deps]);
  return { ref, w: box.w, room: vh - box.top - DOCK_CLEAR };
}

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
