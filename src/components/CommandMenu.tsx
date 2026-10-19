// Ctrl K (⌘K on a Mac): a command menu to open any device, any section, or the few things SYNQ does now and then
// (a checkup, the Helper, the welcome) without the mouse. Adapted from ddoemonn's Command Palette on 21st.dev: its
// fuzzy ranking (word starts and runs score higher), arrow keys, Home/End, Enter, Escape, and the panel that springs
// in. Changed for SYNQ: the panel and rows in the app's own surfaces, each device with its little picture, and a
// combobox with a live count for screen readers.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, GameController, GearSix, HandWaving, Lightbulb, Lightning, MagnifyingGlass, Monitor, SquaresFour, Stethoscope } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { isWeb, type Connected } from "@/lib/backend";
import { useHelperReady } from "@/lib/web/use-helper";
import { buildEntries, type DeviceEntry } from "@/lib/device-model";
import { usePublishedNames } from "@/lib/device-names";
import { soundLabel, useSound } from "@/lib/sound";
import { goCheckup, goDisplays, goGames, goHome, goLights, goSettings, openDevice, SOUND_ID } from "@/lib/nav";
import { setKept } from "@/lib/keep";
import { openWelcome } from "@/lib/welcome";
import { DeviceThumb } from "@/components/devices/DeviceArt";

interface Command {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon: ReactNode;
  run: () => void;
}

const BOUNDARY = /[\s\-_/.:]/;

function scoreOne(text: string, query: string): number {
  const t = text.toLowerCase();
  let cursor = 0;
  let total = 0;
  let streak = 0;
  for (let i = 0; i < query.length; i++) {
    const at = t.indexOf(query[i], cursor);
    if (at < 0) return -1;
    streak = at === cursor && i > 0 ? streak + 1 : 0;
    total += 2 + streak * 4;
    if (at === 0) total += 12;
    else if (BOUNDARY.test(t[at - 1])) total += 8;
    cursor = at + 1;
  }
  return total;
}

function rank(items: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items
    .map((item, order) => {
      const best = Math.max(scoreOne(item.label, q), item.keywords ? scoreOne(item.keywords, q) - 3 : -1);
      return { item, order, score: best - item.label.length * 0.05, best };
    })
    .filter((s) => s.best >= 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((s) => s.item);
}

const KIND_WORD: Partial<Record<DeviceEntry["kind"], string>> = { mouse: "Mouse", keyboard: "Keyboard", controller: "Controller", headset: "Headset", monitor: "Monitor", webcam: "Webcam", sound: "Sound", lamparray: "Dynamic Lighting", rgbhub: "RGB hub", light: "Light" };
const icon = (I: typeof Lightbulb) => <I size={16} weight="light" />;

/** Every command: the sections, then the devices plugged in, then the things SYNQ does now and then. */
function useCommands(devices: readonly Connected[]): Command[] {
  const published = usePublishedNames();
  const sound = useSound();
  const helperReady = useHelperReady();
  return useMemo(() => {
    const entries = buildEntries(devices, published, isWeb ? "Sound and EQ" : soundLabel(sound).title);
    const sections: Command[] = [
      { id: "s:gear", label: "Gear", hint: "Section", keywords: "home devices mice keyboards", icon: icon(SquaresFour), run: goHome },
      { id: "s:lights", label: "Lights", hint: "Section", keywords: "lamps govee hue rgb", icon: icon(Lightbulb), run: goLights },
      { id: "s:displays", label: "Displays", hint: "Section", keywords: "monitors webcams", icon: icon(Monitor), run: goDisplays },
      ...(isWeb && !helperReady ? [] : [{ id: "s:games", label: "Games", hint: "Section", keywords: "profiles", icon: icon(GameController), run: goGames }]),
      { id: "s:settings", label: "Settings", hint: "Section", keywords: "about licenses version", icon: icon(GearSix), run: goSettings },
    ];
    const gear: Command[] = entries.map((e) => ({
      id: `d:${e.id}`,
      label: e.name,
      hint: KIND_WORD[e.kind] ?? e.kind,
      keywords: `${e.brand} ${KIND_WORD[e.kind] ?? ""} open`,
      icon: <DeviceThumb spec={{ kind: e.kind, family: e.family, name: e.name, brand: e.brand, vid: e.pad?.device.vid, pid: e.pad?.device.pid }} />,
      run: () => openDevice(e.kind === "sound" ? SOUND_ID : e.id),
    }));
    const actions: Command[] = [
      { id: "a:checkup", label: "Run a checkup", hint: "About a minute", keywords: "doctor test drift", icon: icon(Stethoscope), run: () => goCheckup() },
      ...(isWeb
        ? []
        : [
            {
              id: "a:helper",
              label: "SYNQ Helper",
              hint: "Game profiles, battery alerts",
              keywords: "background tray",
              icon: icon(Lightning),
              run: () => {
                setKept<string | null>("settings.focus", "helper");
                goSettings();
              },
            },
            { id: "a:welcome", label: "Run the welcome tour", keywords: "first run hello", icon: icon(HandWaving), run: openWelcome },
          ]),
    ];
    return [...sections, ...gear, ...actions];
  }, [devices, published, sound, helperReady]);
}

const PANEL = { type: "spring", stiffness: 420, damping: 36, mass: 0.9 } as const;

export function CommandMenu({ devices }: { devices: readonly Connected[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    const ask = () => setOpen(true);
    window.addEventListener("synq:command-menu", ask);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("synq:command-menu", ask);
    };
  }, []);
  const reduce = useReducedMotion();
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="command-menu"
          className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.18, ease: [0.23, 1, 0.32, 1] }}
          onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-background/70" />
          <motion.div
            className="relative w-full max-w-[580px]"
            initial={reduce ? false : { opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 6 }}
            transition={reduce ? { duration: 0 } : PANEL}
          >
            <Palette devices={devices} onClose={() => setOpen(false)} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

const ROW = 46;

function Palette({ devices, onClose }: { devices: readonly Connected[]; onClose: () => void }) {
  const uid = useId();
  const reduce = useReducedMotion();
  const items = useCommands(devices);
  const [query, setQuery] = useState("");
  const [pinned, setPinned] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const last = useRef({ x: -1, y: -1 });
  const results = useMemo(() => rank(items, query), [items, query]);
  const activeId = results.some((r) => r.id === pinned) ? pinned : (results[0]?.id ?? null);
  const activeIndex = results.findIndex((r) => r.id === activeId);

  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
  }, [query]);

  const reveal = (i: number) => {
    const row = list.current?.children[i];
    if (!list.current || !(row instanceof HTMLElement)) return;
    const top = row.offsetTop - 6;
    const bottom = row.offsetTop + row.offsetHeight + 6;
    if (top < list.current.scrollTop) list.current.scrollTop = top;
    else if (bottom > list.current.scrollTop + list.current.clientHeight) list.current.scrollTop = bottom - list.current.clientHeight;
  };
  const jump = (i: number) => {
    if (!results.length) return;
    const n = Math.max(0, Math.min(results.length - 1, i));
    setPinned(results[n].id);
    reveal(n);
  };
  const run = (c?: Command) => {
    const target = c ?? results.find((r) => r.id === activeId);
    if (!target) return;
    onClose();
    target.run();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => jump(((activeIndex < 0 ? 0 : activeIndex) + 1) % Math.max(1, results.length)),
      ArrowUp: () => jump(((activeIndex < 0 ? 0 : activeIndex) - 1 + results.length) % Math.max(1, results.length)),
      Home: () => jump(0),
      End: () => jump(results.length - 1),
      Enter: () => run(),
      Escape: onClose,
    };
    const act = keys[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  };
  const hover = (id: string, e: PointerEvent) => {
    if (e.clientX === last.current.x && e.clientY === last.current.y) return;
    last.current = { x: e.clientX, y: e.clientY };
    if (id !== activeId) setPinned(id);
  };

  return (
    <div className="panel overflow-hidden rounded-card shadow-[0_40px_90px_-30px_rgb(0_0_0/0.9)]">
      <div className="flex h-14 items-center gap-3 border-b border-white/[0.08] px-5">
        <MagnifyingGlass size={16} weight="light" className="shrink-0 text-medium" />
        <input
          autoFocus
          type="text"
          role="combobox"
          aria-label="Open a device, a section or an action"
          aria-expanded
          aria-controls={`${uid}-list`}
          aria-autocomplete="list"
          aria-activedescendant={activeId ? `${uid}-${activeId}` : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="Open a device, a section or an action"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-high outline-none placeholder:text-medium"
        />
        <kbd className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] text-medium ring-1 ring-white/[0.12]">Esc</kbd>
      </div>
      <ul ref={list} id={`${uid}-list`} role="listbox" aria-label="Results" onMouseDown={(e) => e.preventDefault()} className="flex max-h-[min(420px,52vh)] flex-col gap-0.5 overflow-y-auto overscroll-contain p-1.5">
        {results.map((c) => {
          const on = c.id === activeId;
          return (
            <motion.li
              key={c.id}
              id={`${uid}-${c.id}`}
              role="option"
              aria-selected={on}
              layout={reduce ? false : "position"}
              transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.45 }}
              onPointerMove={(e) => hover(c.id, e)}
              onClick={() => run(c)}
              className="relative flex shrink-0 cursor-default items-center gap-3 rounded-[12px] px-3"
              style={{ height: ROW }}
            >
              {on && <motion.span layoutId={`${uid}-hl`} aria-hidden="true" transition={{ type: "spring", stiffness: 520, damping: 40 }} className="absolute inset-0 rounded-[12px] bg-white/[0.08]" />}
              <span className={cn("relative grid w-8 shrink-0 place-items-center", on ? "text-primary" : "text-medium")}>{c.icon}</span>
              <span className="relative min-w-0 flex-1 truncate text-[14px] font-medium text-high">{c.label}</span>
              {c.hint && <span className="relative shrink-0 text-[12px] text-medium">{c.hint}</span>}
              <ArrowRight size={14} className={cn("relative shrink-0 transition-opacity duration-200", on ? "text-medium opacity-100" : "opacity-0")} />
            </motion.li>
          );
        })}
        {!results.length && <li className="px-3 py-8 text-center text-[13px] text-medium">Nothing matches "{query}"</li>}
      </ul>
      <p role="status" aria-live="polite" className="sr-only">
        {results.length} {results.length === 1 ? "result" : "results"}
      </p>
    </div>
  );
}

/** Opens the command menu from a button (the Gear page's search). */
export const openCommandMenu = () => window.dispatchEvent(new Event("synq:command-menu"));
