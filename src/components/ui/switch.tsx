// The app's switch: Base UI's (keyboard, labels, `role="switch"`) with the feel of kuratlielia's Switch on 21st.dev.
// While held, the thumb stretches toward the other side like a finger pressing it; let go and it travels on a spring
// that lands without overshooting, with a brief squash along the way, so it reads as a moving part, not a sliding dot.
// All transforms (the travel, the stretch and the squash each on their own layer), still with reduced motion.
import { useEffect, useRef, useState } from "react";
import { Switch as Base } from "@base-ui/react/switch";
import { animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

const TRAVEL = 16;
/** The thumb's width while pressed, as a share of its own (16 px to 20 px). */
const STRETCH = 1.25;
const GLIDE = { type: "spring", visualDuration: 0.3, bounce: 0 } as const;
const SNAP = { type: "spring", visualDuration: 0.18, bounce: 0 } as const;

export function Switch({
  checked,
  onCheckedChange,
  className,
  disabled,
  ...aria
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const reduce = useReducedMotion();
  const [pressed, setPressed] = useState(false);
  const squash = useMotionValue(1);
  const shown = useRef(checked);
  useEffect(() => {
    if (shown.current === checked) return;
    shown.current = checked;
    if (reduce) return;
    const run = animate(squash, [1, 1.16, 1], { duration: 0.34, times: [0, 0.4, 1], ease: ["easeOut", "easeInOut"] });
    return () => run.stop();
  }, [checked, reduce, squash]);
  const held = pressed && !reduce && !disabled;
  const release = () => setPressed(false);

  return (
    <Base.Root
      checked={checked}
      disabled={disabled}
      onCheckedChange={(c) => onCheckedChange(c)}
      onPointerDown={(e) => e.button === 0 && setPressed(true)}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onKeyDown={(e) => e.key === " " && setPressed(true)}
      onKeyUp={release}
      onBlur={release}
      {...aria}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full bg-white/[0.08] p-[3px] ring-1 ring-white/[0.08] transition-colors duration-300 ease-fluid data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
        "data-[checked]:bg-primary data-[checked]:ring-primary/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      <motion.span className="block" initial={false} animate={{ x: checked ? TRAVEL : 0 }} transition={reduce ? { duration: 0 } : GLIDE}>
        <motion.span
          className="block"
          style={{ originX: checked ? 1 : 0 }}
          initial={false}
          animate={{ scaleX: held ? STRETCH : 1 }}
          transition={reduce ? { duration: 0 } : SNAP}
        >
          <motion.span className="block size-4 rounded-full bg-[oklch(98%_0.004_60)] shadow-[0_1px_3px_rgb(0_0_0/0.45)]" style={{ scaleX: squash }} />
        </motion.span>
      </motion.span>
    </Base.Root>
  );
}
