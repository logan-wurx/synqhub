// A keyboard drawn from its key positions: the stand-in for a photo, and the same drawing at thumbnail size in
// the device switchers. Not interactive (the clickable key map is components/devices/keymap.tsx). It uses the
// brand's line style: a faint case, keycaps in the text colour at low strength, the accent on Esc.
import { cn } from "@/lib/utils";
import type { RenderGeometry } from "@/lib/keyboard-geometry";

const PAD = 0.55;

export function KeyboardRender({ geometry, className }: { geometry: RenderGeometry; className?: string }) {
  const { width, height, keys } = geometry;
  return (
    <svg viewBox={`${-PAD} ${-PAD} ${width + PAD * 2} ${height + PAD * 2}`} className={cn("pointer-events-none", className)} aria-hidden="true" preserveAspectRatio="xMidYMid meet">
      <rect x={-PAD} y={-PAD} width={width + PAD * 2} height={height + PAD * 2} rx={0.7} fill="rgb(240 235 230 / 0.06)" stroke="rgb(240 235 230 / 0.38)" strokeWidth={0.07} />
      {keys.map((k, i) => (
        <rect
          key={i}
          x={k.x + 0.06}
          y={k.y + 0.06}
          width={Math.max(0.2, k.w - 0.12)}
          height={Math.max(0.2, k.h - 0.12)}
          rx={0.16}
          fill={k.tone === "esc" ? "var(--primary)" : k.tone === "mod" || k.tone === "space" ? "rgb(240 235 230 / 0.1)" : "rgb(240 235 230 / 0.18)"}
          fillOpacity={k.tone === "esc" ? 0.32 : 1}
          stroke={k.tone === "esc" ? "var(--primary)" : "rgb(240 235 230 / 0.46)"}
          strokeWidth={0.05}
        />
      ))}
    </svg>
  );
}
