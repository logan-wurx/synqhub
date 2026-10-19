// A product photo that leans toward the pointer, a few degrees at most, adapted from ibelick's Tilt (motion-primitives,
// on 21st.dev). Changed: springs that settle without wobbling, only on a mouse (no hover on touch), still with reduced
// motion, and the pointer read from the whole tile around it (`area`) so the photo turns before the pointer reaches it.
// Transform only.
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";

const SPRING = { stiffness: 170, damping: 26, mass: 0.6 } as const;

export function Tilt({ children, className, area, degrees = 7 }: { children: ReactNode; className?: string; area?: RefObject<HTMLElement | null>; degrees?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const x = useSpring(useMotionValue(0), SPRING);
  const y = useSpring(useMotionValue(0), SPRING);
  const rotateX = useTransform(y, [-0.5, 0.5], [degrees, -degrees]);
  const rotateY = useTransform(x, [-0.5, 0.5], [-degrees, degrees]);
  const transform = useMotionTemplate`perspective(900px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;

  useEffect(() => {
    const el = area?.current ?? ref.current;
    if (!el || reduce || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      x.set((e.clientX - r.left) / r.width - 0.5);
      y.set((e.clientY - r.top) / r.height - 0.5);
    };
    const leave = () => {
      x.set(0);
      y.set(0);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [area, reduce, x, y]);

  return (
    <motion.div ref={ref} className={className} style={{ transform, transformStyle: "preserve-3d" }}>
      {children}
    </motion.div>
  );
}
