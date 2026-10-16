// The "Ambient" shell: the room light behind every page and the floating dock that replaces the left rail.
// The light is three soft pools of colour (index.css .ambient). Their colours are the ones last set on your lights
// (lighting.json's recent colours, src/lib/lighting/saved.ts), so the app glows the way your room does; before any
// light has been set, a warm sunset. The default accent ("Room light") is the first of them. Nothing here talks to a light.
import { useLayoutEffect, useMemo } from "react";
import { motion } from "motion/react";
import type { Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { isWeb } from "@/lib/backend";
import { useLightingKeep } from "@/lib/lighting/saved";
import { glowColours, roomAccent } from "@/lib/lighting/glow";

export function AmbientLight() {
  // The website has no lights: always the sunset.
  const { recent } = useLightingKeep();
  const [a, b, c] = useMemo(() => glowColours(isWeb ? [] : recent), [recent]);
  // On the root, so the "Room light" accent (index.css) follows the same colours; they fade over (registered properties).
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    const { accent, fg } = roomAccent(a);
    root.setProperty("--glow-a", a);
    root.setProperty("--glow-b", b);
    root.setProperty("--glow-c", c);
    root.setProperty("--room-accent", accent);
    root.setProperty("--room-fg", fg);
  }, [a, b, c]);
  return (
    <div aria-hidden="true" className="ambient">
      <span />
      <span />
      <span />
    </div>
  );
}

export interface DockItem {
  id: string;
  label: string;
  /** Said on hover, and to screen readers after the label. */
  hint: string;
  icon: Icon;
  /** Shown as the icon alone (Settings). The label stays for screen readers. */
  iconOnly?: boolean;
}

/** The floating glass dock at the bottom: the app's sections, the active one a solid pill. */
export function Dock({ items, active, onSelect, onIntent, extra }: { items: readonly DockItem[]; active: string; onSelect: (id: string) => void; onIntent?: (id: string) => void; extra?: React.ReactNode }) {
  const main = items.filter((i) => !i.iconOnly);
  const tail = items.filter((i) => i.iconOnly);
  const entry = (item: DockItem) => {
    const on = item.id === active;
    return (
      <button
        key={item.id}
        onClick={() => onSelect(item.id)}
        onPointerEnter={() => onIntent?.(item.id)}
        onFocus={() => onIntent?.(item.id)}
        title={`${item.label}: ${item.hint}`}
        aria-current={on ? "page" : undefined}
        className={cn(
          "relative flex h-11 items-center justify-center rounded-full text-[15px] transition-colors duration-500 ease-fluid",
          item.iconOnly ? "w-11" : "px-[22px] max-sm:w-11 max-sm:px-0",
          on ? "font-semibold text-background" : "font-medium text-foreground/75 hover:text-foreground",
        )}
      >
        {on && <motion.span layoutId="dock-active" transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }} className="absolute inset-0 rounded-full bg-foreground" />}
        <item.icon size={18} weight={on ? "regular" : "light"} className={cn("relative", item.iconOnly ? "" : "hidden max-sm:block")} />
        <span className={cn("relative", item.iconOnly ? "sr-only" : "max-sm:sr-only")}>{item.label}</span>
        <span className="sr-only">, {item.hint}</span>
      </button>
    );
  };
  return (
    <nav
      aria-label="Sections"
      className="fixed bottom-7 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full bg-[#141416]/75 p-1.5 shadow-[0_20px_50px_rgb(0_0_0/0.5),inset_0_1px_1px_rgb(255_255_255/0.08)] ring-1 ring-white/[0.12] backdrop-blur-2xl"
    >
      {main.map(entry)}
      {(tail.length > 0 || extra) && <span aria-hidden="true" className="mx-1 h-7 w-px bg-white/[0.14]" />}
      {extra}
      {tail.map(entry)}
    </nav>
  );
}

/** The room the dock needs at the bottom of every page (the dock's height, its gap, and air). */
export const DOCK_SPACE = "pb-[104px]";
