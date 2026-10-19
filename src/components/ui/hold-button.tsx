// A button you press and hold for things that are hard to undo (a factory reset, putting a backup back): a fill sweeps
// across while it's held and the action runs only when it reaches the end; let go early and it drains back. Adapted
// from Motion's "Hold to confirm" example (motiondotdev on 21st.dev): the fill moves by transform, the button gives a
// little under the finger, and holding Space or Enter works the same as holding the mouse button.
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform, type AnimationPlaybackControls } from "motion/react";
import { cn } from "@/lib/utils";

export function HoldButton({
  children,
  onConfirm,
  disabled,
  seconds = 1.2,
  tone = "danger",
  className,
}: {
  children: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  seconds?: number;
  tone?: "danger" | "accent";
  className?: string;
}) {
  const reduce = useReducedMotion();
  const progress = useMotionValue(0);
  const scale = useTransform(progress, [0, 1], [1, reduce ? 1 : 0.97]);
  const run = useRef<AnimationPlaybackControls | null>(null);
  const [holding, setHolding] = useState(false);

  const start = () => {
    if (disabled || run.current) return;
    setHolding(true);
    progress.set(0);
    // onComplete runs only when the fill reaches the end, not when a release stops it.
    run.current = animate(progress, 1, {
      duration: seconds,
      ease: "linear",
      onComplete: () => {
        run.current = null;
        setHolding(false);
        onConfirm();
        animate(progress, 0, { duration: 0.5, delay: 0.25, ease: [0.32, 0.72, 0, 1] });
      },
    });
  };
  const cancel = () => {
    if (!run.current) return;
    run.current.stop();
    run.current = null;
    setHolding(false);
    animate(progress, 0, { duration: 0.3, ease: [0.32, 0.72, 0, 1] });
  };
  const key = (e: KeyboardEvent<HTMLButtonElement>, down: boolean) => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    if (down && !e.repeat) start();
    else if (!down) cancel();
  };

  return (
    <motion.button
      type="button"
      disabled={disabled}
      aria-description="Press and hold"
      onPointerDown={(e) => e.button === 0 && start()}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => key(e, true)}
      onKeyUp={(e) => key(e, false)}
      onBlur={cancel}
      style={{ scale }}
      className={cn(
        "relative isolate h-10 select-none overflow-hidden rounded-control px-5 text-[13px] font-medium text-high ring-1 transition-[opacity,box-shadow] duration-300 disabled:cursor-not-allowed disabled:opacity-40",
        tone === "danger" ? "bg-destructive/[0.12] ring-destructive/40" : "bg-primary/[0.12] ring-primary/40",
        className,
      )}
    >
      <motion.span aria-hidden="true" className={cn("absolute inset-0 -z-10 origin-left", tone === "danger" ? "bg-destructive/70" : "bg-primary/80")} style={{ scaleX: progress }} />
      <span className="pointer-events-none">{holding ? "Keep holding" : children}</span>
    </motion.button>
  );
}
