// The Devices home's type filter: one pill per group of devices connected ("Mice 2", "Lights 3"), shown only when the
// list is long and mixed enough to need it (src/lib/device-groups.ts), so a desk with a mouse, a keyboard and the
// sound never sees it. Same pill track and sliding highlight as the tab bar (./shell.tsx). The pick lasts for the
// session (src/lib/keep.ts).
import { useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { useKeptState } from "@/lib/keep";
import { filterEntries, type Group } from "@/lib/device-groups";
import { arrowPick } from "@/lib/roving";

export function useKindFilter<T extends { kind: string }>(entries: readonly T[], counts?: (e: T) => boolean) {
  const [picked, setPicked] = useKeptState<string>("home.filter", () => "all");
  return { ...filterEntries(entries, picked, counts), setPicked };
}

/** A narrow window scrolls the row sideways (no scrollbar drawn); the right edge fades so the cut-off pill reads as "more". */
const EDGE_FADE = "[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]";

export function KindFilter({ groups, value, onChange }: { groups: Group[]; value: string; onChange: (id: string) => void }) {
  const pills: { id: string; label: string; n?: number }[] = [{ id: "all", label: "All" }, ...groups];
  const row = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const check = () => setOverflows(el.scrollWidth - el.scrollLeft - el.clientWidth > 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener("scroll", check, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", check);
    };
  }, [groups.length]);
  return (
    <div ref={row} role="radiogroup" onKeyDown={arrowPick} aria-label="Show" className={cn("-mx-1 flex overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", overflows && EDGE_FADE)}>
      <div className="flex items-center gap-0.5 rounded-full bg-white/[0.05] p-1 ring-1 ring-white/[0.1]">
        {pills.map((p) => {
          const on = p.id === value;
          return (
            <button
              key={p.id}
              role="radio"
              aria-checked={on}
              onClick={() => onChange(p.id)}
              className={cn(
                "relative flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] transition-colors duration-500 ease-fluid",
                p.n !== undefined && "pr-2.5",
                on ? "font-semibold text-background" : "font-medium text-foreground/70 hover:text-foreground",
              )}
            >
              {on && (
                <motion.span
                  layoutId="home-kind-filter"
                  transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
                  className="absolute inset-0 rounded-full bg-foreground"
                />
              )}
              <span className="relative">{p.label}</span>
              {p.n !== undefined && (
                <span
                  className={cn(
                    "relative min-w-5 rounded-full px-1.5 text-center font-mono text-[11px] tabular-nums transition-colors duration-500 ease-fluid",
                    on ? "bg-background/[0.12] text-background" : "bg-white/[0.06] text-muted-foreground",
                  )}
                >
                  {p.n}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
