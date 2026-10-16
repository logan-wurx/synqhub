import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface ItemRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Tracks the rects of registered items (relative to the container) and which one the pointer is
 * over, so a highlight can glide between them.
 */
export function useFluidHover(containerRef: RefObject<HTMLElement | null>, { axis }: { axis: "x" | "y" }) {
  const items = useRef(new Map<number, HTMLElement>());
  const [itemRects, setItemRects] = useState<ItemRect[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const measureItems = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const base = container.getBoundingClientRect();
    const rects: ItemRect[] = [];
    for (const [index, el] of items.current) {
      const r = el.getBoundingClientRect();
      rects[index] = { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
    }
    setItemRects((prev) => (JSON.stringify(prev) === JSON.stringify(rects) ? prev : rects));
  }, [containerRef]);

  const registerItem = useCallback((index: number, el: HTMLElement | null) => {
    if (el) items.current.set(index, el);
    else items.current.delete(index);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => measureItems());
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, measureItems]);

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const base = container.getBoundingClientRect();
      const pos = axis === "x" ? e.clientX - base.left : e.clientY - base.top;
      const hit = itemRects.findIndex((r) =>
        r ? (axis === "x" ? pos >= r.left && pos <= r.left + r.width : pos >= r.top && pos <= r.top + r.height) : false,
      );
      setActiveIndex(hit >= 0 ? hit : null);
    },
    [axis, containerRef, itemRects],
  );

  const onMouseLeave = useCallback(() => setActiveIndex(null), []);

  return { activeIndex, setActiveIndex, itemRects, handlers: { onMouseMove, onMouseLeave }, registerItem, measureItems };
}
