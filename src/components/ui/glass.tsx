// The light on SYNQ's glass (the active card, the dock), adapted from educalvolpz's Glass Card on 21st.dev: a soft
// specular highlight and a bright line on the top edge that follow the pointer across the pane on springs that settle
// without wobbling, and a rim that catches the orange (the original's is cyan and magenta). Left out: its refracting
// rim, an SVG displacement filter that would be redrawn on every frame of the live shader under the glass.
// Moves by transform only; still with reduced motion or without a mouse. Goes inside an element with the `glass`
// utility, whose backdrop filter makes it a stacking context: at z -1 the light sits on the glass, under its content.
import { useEffect, useRef } from "react";
import { motion, useReducedMotion, useSpring } from "motion/react";

const SPRING = { damping: 34, mass: 0.5, stiffness: 250 } as const;
const SPOT = 320;
const SPECULAR = "radial-gradient(closest-side, oklch(97% 0.02 60 / 0.16), oklch(97% 0.02 60 / 0.045) 48%, transparent 74%)";
const EDGE = "linear-gradient(90deg, transparent, oklch(98% 0.02 60 / 0.75) 50%, transparent)";
const RIM = "linear-gradient(125deg, oklch(93% 0.05 55 / 0.42) 0%, transparent 32%, transparent 64%, oklch(72% 0.17 38 / 0.38) 100%)";
const RING_MASK = "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)";

export function GlassSheen() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const x = useSpring(0, SPRING);
  const y = useSpring(0, SPRING);
  const edge = useSpring(0, SPRING);

  useEffect(() => {
    const pane = ref.current?.parentElement;
    if (!pane || reduce || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const move = (e: PointerEvent) => {
      const r = pane.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      x.set(px - r.width * 0.3);
      y.set(py - r.height * 0.2);
      edge.set(px - r.width / 2);
    };
    const leave = () => {
      x.set(0);
      y.set(0);
      edge.set(0);
    };
    pane.addEventListener("pointermove", move);
    pane.addEventListener("pointerleave", leave);
    return () => {
      pane.removeEventListener("pointermove", move);
      pane.removeEventListener("pointerleave", leave);
    };
  }, [reduce, x, y, edge]);

  return (
    <div ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]">
      <motion.div
        className="absolute"
        style={{ left: "30%", top: "20%", width: SPOT, height: SPOT, marginLeft: -SPOT / 2, marginTop: -SPOT / 2, backgroundImage: SPECULAR, x, y }}
      />
      <motion.div className="absolute top-0 h-px" style={{ left: "29%", width: "42%", backgroundImage: EDGE, x: edge }} />
      <div
        className="absolute inset-0 rounded-[inherit]"
        style={{ padding: 1, backgroundImage: RIM, mask: RING_MASK, maskComposite: "exclude", WebkitMask: RING_MASK, WebkitMaskComposite: "xor" }}
      />
    </div>
  );
}
