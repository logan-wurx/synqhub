// A soft light that follows the pointer across a surface and along its edge, like a desk lamp passing over the device
// tiles. Adapted from kevingirelli's Spotlight on 21st.dev: no Radix Slot (the parent carries the handler and the
// `group/spotlight relative isolate` classes), warm white instead of the theme's foreground. Each move sets two CSS
// variables once a frame; nothing re-renders. Touch skips it; keyboard focus inside lights it where the pointer was.
import type { CSSProperties, PointerEvent } from "react";
import { cn } from "@/lib/utils";

const RING_MASK = "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)";
const LIGHT = "oklch(97% 0.02 60)";
const frames = new WeakMap<HTMLElement, number>();

/** Put on the lit element's onPointerMove. */
export function spotlightMove(event: PointerEvent<HTMLElement>) {
  if (event.pointerType === "touch") return;
  const target = event.currentTarget;
  const { clientX, clientY } = event;
  cancelAnimationFrame(frames.get(target) ?? 0);
  frames.set(
    target,
    requestAnimationFrame(() => {
      const r = target.getBoundingClientRect();
      target.style.setProperty("--spotlight-x", `${clientX - r.left}px`);
      target.style.setProperty("--spotlight-y", `${clientY - r.top}px`);
    }),
  );
}

/** The light and the lit edge; first child of an element with `group/spotlight relative isolate`. */
export function SpotlightLight({ size = 340, strength = 10, ring = true }: { size?: number; strength?: number; ring?: boolean }) {
  const circle = `${size}px circle at var(--spotlight-x, 50%) var(--spotlight-y, 50%)`;
  const layer = cn(
    "pointer-events-none absolute -z-10 rounded-[inherit] opacity-0 transition-opacity duration-300 motion-reduce:transition-none",
    "group-hover/spotlight:opacity-100 group-focus-within/spotlight:opacity-100",
  );
  const ringStyle: CSSProperties = {
    background: `radial-gradient(${circle}, color-mix(in oklab, ${LIGHT} 50%, transparent), transparent 60%)`,
    mask: RING_MASK,
    maskComposite: "exclude",
    WebkitMask: RING_MASK,
    WebkitMaskComposite: "xor",
  };
  return (
    <>
      <span aria-hidden="true" className={cn(layer, "inset-0")} style={{ background: `radial-gradient(${circle}, color-mix(in oklab, ${LIGHT} ${strength}%, transparent), transparent 70%)` }} />
      {ring && <span aria-hidden="true" className={cn(layer, "-inset-px p-px")} style={ringStyle} />}
    </>
  );
}
