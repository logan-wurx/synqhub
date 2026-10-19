// The app's frame: the window bar (the desktop app draws its own: a drag area and the three window buttons, no
// Windows title bar) and the dock at the bottom with the sections. The website has the browser's frame, so no bar.
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { CopySimple, Minus, Square, X, type Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { inTauri } from "@/lib/backend";
import { GlassSheen } from "@/components/ui/glass";

type AppWindow = Awaited<ReturnType<typeof windowApi>>;
const windowApi = () => import("@tauri-apps/api/window").then((m) => m.getCurrentWindow());

/** The top strip of the desktop app: drag it to move the window (double-click maximizes), and the window buttons. */
export function TitleBar() {
  const [win, setWin] = useState<AppWindow | null>(null);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!inTauri) return;
    // The window buttons take the top-right corner: headers keep clear of it (--wc, src/index.css).
    document.documentElement.dataset.frame = "own";
    let off: (() => void) | undefined;
    let live = true;
    void windowApi().then(async (w) => {
      if (!live) return;
      setWin(w);
      const read = () => void w.isMaximized().then((m) => live && setMaximized(m));
      read();
      off = await w.onResized(read);
    });
    return () => {
      live = false;
      off?.();
    };
  }, []);
  if (!inTauri) return null;
  const button = "grid h-full w-[46px] place-items-center text-medium transition-colors duration-200 hover:bg-white/[0.08] hover:text-high";
  return (
    <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-50 flex h-10 justify-end">
      <button type="button" aria-label="Minimize" className={button} onClick={() => void win?.minimize()}>
        <Minus size={15} weight="light" />
      </button>
      <button type="button" aria-label={maximized ? "Restore" : "Maximize"} className={button} onClick={() => void win?.toggleMaximize()}>
        {maximized ? <CopySimple size={14} weight="light" className="-scale-x-100" /> : <Square size={13} weight="light" />}
      </button>
      <button type="button" aria-label="Close" className={cn(button, "hover:bg-[#e81123] hover:text-white")} onClick={() => void win?.close()}>
        <X size={15} weight="light" />
      </button>
    </div>
  );
}

export interface DockItem {
  id: string;
  label: string;
  /** Said on hover, and to screen readers after the label. */
  hint: string;
  icon: Icon;
  /** A small dot on the icon (SYNQ Helper is on). */
  dot?: boolean;
  /** Set apart at the end, after a divider (Settings). */
  tail?: boolean;
}

/**
 * The dock at the bottom: the app's sections, the one you're on a lit square with its icon in orange. `underGrid`: on
 * the section homes it sits under their device grid (the right column) on a wide window, not the window's middle.
 */
export function Dock({ items, active, onSelect, onIntent, underGrid = false }: { items: readonly DockItem[]; active: string; onSelect: (id: string) => void; onIntent?: (id: string) => void; underGrid?: boolean }) {
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
          "relative flex h-12 items-center gap-2.5 rounded-[14px] px-[18px] text-[14px] transition-colors duration-500 ease-fluid max-sm:w-12 max-sm:justify-center max-sm:px-0",
          on ? "font-semibold text-high" : "font-medium text-high hover:text-high",
        )}
      >
        {on && (
          <motion.span
            layoutId="dock-active"
            transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }}
            className="absolute inset-0 rounded-[14px] bg-white/[0.11] shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] ring-1 ring-white/[0.1]"
          />
        )}
        <span className="relative">
          <item.icon size={20} weight={on ? "fill" : "light"} className={on ? "text-primary" : undefined} />
          {item.dot && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-[#1d1a18]" aria-hidden="true" />}
        </span>
        <span className="relative max-sm:sr-only">{item.label}</span>
        <span className="sr-only">, {item.hint}</span>
      </button>
    );
  };
  const main = items.filter((i) => !i.tail);
  const tail = items.filter((i) => i.tail);
  return (
    <nav
      aria-label="Sections"
      className={cn(
        "glass fixed bottom-6 left-1/2 z-40 flex translate-x-[calc(var(--dock-shift,0px)-50%)] items-center gap-1 rounded-[22px] p-2 transition-transform duration-500 ease-fluid",
        // Half the left column and its gap (DevicesHome's grid: a 440 px column, then clamp(28px, 3.2vw, 56px)).
        underGrid && "min-[1260px]:[--dock-shift:calc((440px+clamp(28px,3.2vw,56px))/2)]",
      )}
    >
      <GlassSheen />
      {main.map(entry)}
      {tail.length > 0 && <span aria-hidden="true" className="mx-1.5 h-8 w-px bg-white/[0.14]" />}
      {tail.map(entry)}
    </nav>
  );
}
