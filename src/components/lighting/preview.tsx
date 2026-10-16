// A small animated picture of a lighting effect (a scene card, a DIY effect): its colours moving the way the effect
// moves, drawn with CSS transforms and opacity only (index.css `light-*` keyframes). An impression, not a recording
// of the lamp. Pure UI.
import { cn } from "@/lib/utils";

export type Motion = "flow" | "breathe" | "flash" | "jump" | "stripes" | "still";

/** Colours once round the strip; written twice so a half-width slide loops without a seam. */
function strip(colours: readonly string[], hard: boolean): string {
  const cs = colours.length ? colours.map((c) => (c.startsWith("#") ? c : `#${c}`)) : ["#ffffff"];
  const loop = [...cs, ...cs];
  if (!hard) return `linear-gradient(to right, ${[...loop, loop[0]].join(", ")})`;
  const step = 100 / loop.length;
  return `linear-gradient(to right, ${loop.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`).join(", ")})`;
}

export function LightPreview({
  colours,
  motion,
  seconds = 4,
  reverse,
  className,
}: {
  colours: readonly string[];
  motion: Motion;
  /** One round of the motion. */
  seconds?: number;
  reverse?: boolean;
  className?: string;
}) {
  const n = Math.max(colours.length, 1);
  const slide =
    motion === "still" || motion === "breathe"
      ? undefined
      : `light-flow ${motion === "stripes" ? seconds / 2 : seconds}s ${motion === "jump" ? `steps(${n})` : "linear"} infinite${reverse ? " reverse" : ""}`;
  const stripes = motion === "stripes" ? `repeating-linear-gradient(90deg, transparent 0 10px, rgb(0 0 0 / 0.55) 10px 20px), ` : "";
  return (
    <div
      aria-hidden="true"
      className={cn("light-anim relative overflow-hidden rounded-xl bg-black ring-1 ring-white/10", className)}
      style={{ animation: motion === "breathe" ? `light-breathe ${seconds}s ease-in-out infinite` : motion === "flash" ? `light-flash ${Math.max(0.3, seconds / 6)}s steps(1) infinite` : undefined }}
    >
      <div className="absolute inset-y-0 left-0 w-[200%]" style={{ background: `${stripes}${strip(colours, motion === "jump" || motion === "flash")}`, animation: slide }} />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgb(255_255_255/0.14),transparent_45%,rgb(0_0_0/0.25))]" />
    </div>
  );
}
