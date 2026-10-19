// The frame every device page shares: a header with the way back to its tab (Devices, Lights or Displays), the connection and
// support-tier pills, and a tab bar; plus the pieces the Overview tab is made of (the big render and
// the "Current status" strip). Pure layout: nothing here talks to a device.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { BatteryCell } from "@/components/ui/battery-cell";
import { AnimatePresence, motion } from "motion/react";
import { ArrowClockwise, CaretLeft, DotsThree, Eye, Flask, SealCheck, Stethoscope, TestTube, type Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { goCheckup, goSection, sectionOfDevice } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { TIER_LABEL, type KbTier } from "@/lib/kb/types";
import { Tilt } from "@/components/ui/tilt";
import { arrowPick } from "@/lib/roving";

export interface TabDef {
  id: string;
  label: string;
}

/** Dot + text pill: the connection ("Connected · Wireless"). */
export function StatusPill({ live, children }: { live: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-1 text-[12px] text-medium ring-1 ring-white/[0.06]">
      <span className={cn("size-1.5 rounded-full", live ? "bg-live" : "bg-asleep")} />
      {children}
    </span>
  );
}

const TIER_ICON: Record<KbTier, Icon> = { verified: SealCheck, "driver-tested": Flask, "read-only": Eye, experimental: TestTube };

/** Verified / Driver-tested / Read-only: how far SYNQ has been tried on this device. */
export function TierBadge({ tier, hint, compact, iconOnly }: { tier: KbTier; hint?: string; compact?: boolean; iconOnly?: boolean }) {
  const IconCmp = TIER_ICON[tier];
  return (
    <span
      title={iconOnly ? `${TIER_LABEL[tier].label}: ${hint ?? TIER_LABEL[tier].hint}` : (hint ?? TIER_LABEL[tier].hint)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full ring-1",
        iconOnly ? "size-[22px] justify-center" : compact ? "px-2 py-0.5 text-[11.5px]" : "px-2.5 py-1 text-[12px]",
        // The accent alone is a little dark for small text on its own tint: lifted towards white for AA contrast.
        tier === "verified" && "bg-primary/[0.1] text-[color-mix(in_oklab,var(--primary)_68%,white)] ring-primary/30",
        tier === "driver-tested" && "bg-chart-3/[0.06] text-chart-3 ring-chart-3/20",
        tier === "read-only" && "bg-white/[0.04] text-medium ring-white/[0.08]",
        tier === "experimental" && "bg-amber-300/[0.06] text-amber-200 ring-amber-200/20",
      )}
    >
      <IconCmp size={compact || iconOnly ? 12 : 13} weight={tier === "verified" ? "fill" : "regular"} aria-hidden="true" />
      <span className={iconOnly ? "sr-only" : undefined}>{TIER_LABEL[tier].label}</span>
    </span>
  );
}

/** "‹ Gear": the way back from a page to the tab it belongs to, a glass pill. */
export function BackButton({ onClick, children, className }: { onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-10 w-fit shrink-0 items-center gap-1.5 rounded-control bg-white/[0.06] pl-3.5 pr-[18px] text-[14px] font-medium text-high ring-1 ring-white/[0.12] transition-colors duration-500 ease-fluid hover:bg-white/[0.1]",
        className,
      )}
    >
      <CaretLeft size={14} /> {children}
    </button>
  );
}

/**
 * The tab bar: a glass pill track whose chosen tab is a solid pill that slides to the new tab, and a faint highlight
 * that glides from tab to tab under the pointer (the fluid hover of micka_design's Segmented Tabs on 21st.dev).
 */
export function TabBar({ id, tabs, value, onChange }: { id: string; tabs: readonly TabDef[]; value: string; onChange: (id: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div role="tablist" onKeyDown={arrowPick} aria-label="Sections" className="-mx-1 flex overflow-x-auto px-1 pb-1">
      <div className="flex items-center gap-0.5 rounded-full bg-white/[0.05] p-1 ring-1 ring-white/[0.1]" onPointerLeave={() => setHover(null)}>
        {tabs.map((t) => {
          const on = t.id === value;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={on}
              onClick={() => onChange(t.id)}
              onPointerEnter={() => setHover(t.id)}
              className={cn(
                "relative h-9 whitespace-nowrap rounded-full px-[18px] text-[14px] transition-colors duration-500 ease-fluid",
                on ? "font-semibold text-background" : "font-medium text-medium hover:text-high",
              )}
            >
              <AnimatePresence>
                {hover === t.id && !on && (
                  <motion.span
                    layoutId={`tab-hover-${id}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
                    className="absolute inset-0 rounded-full bg-white/[0.09]"
                  />
                )}
              </AnimatePresence>
              {on && (
                <motion.span
                  layoutId={`tab-${id}`}
                  transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
                  className="absolute inset-0 rounded-full bg-foreground"
                />
              )}
              <span className="relative">{t.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ReconnectButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex h-9 items-center gap-2 rounded-control bg-white/[0.05] pl-4 pr-1.5 text-[13px] text-high ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.08]"
    >
      Reconnect
      <span className="grid size-6 place-items-center rounded bg-white/[0.08] transition-transform duration-500 ease-fluid group-hover:rotate-90">
        <ArrowClockwise size={12} />
      </span>
    </button>
  );
}

/** The "⋯" menu at the end of a device page's header: the things a page does now and then (a checkup of this device). */
/** Pages whose devices the checkup has no steps for (headsets, monitors, webcams, lights): no "Check this device". */
const UNCHECKED = /^(hs|mon|cam|light|dl|rgb):/;

export function DeviceMenu({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (UNCHECKED.test(id)) return null;
  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn("grid size-9 place-items-center rounded-full ring-1 transition-colors", open ? "bg-white/[0.09] text-high ring-white/[0.12]" : "bg-white/[0.05] text-medium ring-white/[0.08] hover:bg-white/[0.08] hover:text-high")}
      >
        <DotsThree size={16} weight="bold" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
            className="absolute right-0 top-11 z-40 w-[248px] rounded-popover bg-popover/95 p-1.5 shadow-[0_18px_40px_-12px_rgb(0_0_0/0.8)] ring-1 ring-white/[0.08] backdrop-blur-xl"
          >
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                goCheckup(id);
              }}
              className="flex w-full items-start gap-3 rounded-small px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]"
            >
              <Stethoscope size={16} weight="light" className="mt-0.5 shrink-0 text-primary" />
              <span>
                <span className="block text-[13px] text-high">Check this device</span>
                <span className="block text-[11.5px] leading-snug text-medium">A guided checkup, about a minute</span>
              </span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The top of a device page. `pills` sit above the name (connection, tier); `actions` sit on the right
 * (Reconnect, ...), then the "⋯" menu. The tab bar is part of the header so it stays put while the tab's content scrolls.
 */
export function DeviceHeader({
  id,
  name,
  title,
  subtitle,
  pills,
  actions,
  tabs,
  tab,
  onTab,
}: {
  id: string;
  name: string;
  /** Replaces the plain name heading (the Sound page edits its name in place). */
  title?: ReactNode;
  subtitle?: ReactNode;
  pills: ReactNode;
  actions?: ReactNode;
  tabs: readonly TabDef[];
  tab: string;
  onTab: (id: string) => void;
}) {
  // Back to the tab this page belongs to: a light's page goes back to Lights, a monitor's to Displays.
  const back = sectionOfDevice(id);
  return (
    // Two rows, so the tab has the window: the way back, the name and its pills, the actions; then the tabs, with the
    // line about the device beside them (it moves under them on a narrow window).
    <header className="shrink-0 px-8 pt-5">
      {/* The top row keeps clear of the window buttons when the page reaches the window's right edge (DeviceFrame is
          1800 px wide at most, centred, with 32 px sides). */}
      <div className="flex items-center gap-4" style={{ paddingRight: "max(0px, calc(var(--wc) - (100vw - min(100vw, 1800px)) / 2 - 32px))" }}>
        <BackButton onClick={() => goSection(back)}>{BACK_LABEL[back]}</BackButton>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
          {title ?? <h1 className="min-w-0 truncate pb-0.5 text-[clamp(30px,2.9vw,42px)] font-bold leading-[1.05] tracking-[-0.045em] text-high">{name}</h1>}
          <div className="flex flex-wrap items-center gap-2">{pills}</div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {actions}
          <DeviceMenu id={id} />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        {/* One tab is just the page: no bar for it. */}
        {tabs.length > 1 && <TabBar id={id} tabs={tabs} value={tab} onChange={onTab} />}
        {subtitle && <p className={cn("min-w-0 flex-1 text-[13px] text-medium", tabs.length > 1 && "min-[1100px]:text-right")}>{subtitle}</p>}
      </div>
    </header>
  );
}

const BACK_LABEL = { devices: "Gear", lights: "Lights", displays: "Displays" } as const;

/** The scrolling area under a device header. `key` it by tab so each tab keeps its own scroll. */
/** A tab's scrolling body. It takes focus (tabIndex 0 where it is used) so the keyboard can scroll a tab with no controls; its ring is drawn inside. */
export const TAB_BODY = "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-8 pb-[120px] pt-4 [scrollbar-gutter:stable] [&>*]:shrink-0 focus-visible:outline-offset-[-3px]";

export interface Stat {
  label: string;
  value: ReactNode;
  /** A second, smaller line. */
  note?: string;
}

/** True inside the wide layout's left column, where the pieces stack instead of spreading. */
const AsideCtx = createContext(false);
/** Whether this piece sits in the wide layout's left column (it should stack there). */
export const useAside = () => useContext(AsideCtx);

/**
 * The frame of a device page. On a narrow window: the header, then the tab content. On a wide one the
 * picture and the status (`aside`, the same Overview content) sit in a column beside the tab content, so
 * the page uses the whole window; the Overview tab is then left out (the panels drop it).
 */
export function DeviceFrame({ header, aside, children }: { header: ReactNode; aside?: ReactNode; children: ReactNode }) {
  const wide = useWide();
  return (
    <div className="mx-auto flex h-full w-full max-w-[1800px] flex-col">
      {header}
      <div className="flex min-h-0 flex-1">
        {wide && aside && (
          <AsideCtx.Provider value>
            <aside className="flex w-[440px] shrink-0 flex-col gap-5 overflow-y-auto pb-[120px] pl-8 pt-5 [scrollbar-gutter:stable]">{aside}</aside>
          </AsideCtx.Provider>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}

/**
 * "Current status": one panel, its settings side by side between hairlines, each value over its name (like the Gear
 * page's active card). The hairlines are shadows on each cell's top and left edge; the panel clips the outer ones.
 */
export function StatusStrip({ stats, title = "Current status" }: { stats: readonly Stat[]; title?: string }) {
  const aside = useContext(AsideCtx);
  return (
    <section aria-label={title}>
      <p className="label-caps mb-3 px-1">{title}</p>
      {/* Beside the page: two columns. Full width: up to five a row, wrapping before one gets narrower than 150 px (the app's smallest window). */}
      <dl className="panel grid overflow-hidden rounded-card" style={{ gridTemplateColumns: aside ? "repeat(2, minmax(0, 1fr))" : "repeat(auto-fit, minmax(max(150px, calc(100% / 5)), 1fr))" }}>
        {stats.map((s) => (
          <div key={s.label} className="flex min-w-0 flex-col-reverse justify-end px-6 py-5 shadow-[-1px_0_0_rgb(255_255_255/0.08),0_-1px_0_rgb(255_255_255/0.08)]">
            <dt className="mt-1 truncate text-[13px] text-medium">
              {s.label}
              {s.note && <span className="block truncate text-[12px] text-medium">{s.note}</span>}
            </dt>
            <dd className="truncate pb-0.5 text-[26px] font-semibold leading-tight tracking-[-0.03em] text-high">{s.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The Overview tab's big picture: the device's photo on a lit tile, like its tile on the Gear page, leaning toward the
 * pointer (src/components/ui/tilt.tsx), with the connection, a line about it and its badges. The page's header already
 * says its name, so the tile doesn't.
 */
export function OverviewHero({
  art,
  connection,
  name,
  detail,
  live,
  badges,
}: {
  art: ReactNode;
  /** "Wired", "Wireless", ... shown as "Connected · Wired". */
  connection: string | null;
  name: string;
  detail?: ReactNode;
  live: boolean;
  badges?: ReactNode;
}) {
  const aside = useContext(AsideCtx);
  const tile = useRef<HTMLElement>(null);
  return (
    // It takes the tab's spare height (a tall window shows the photo bigger) so the page reaches down to the dock.
    <figure ref={tile} aria-label={name} className={cn("tile relative m-0 flex overflow-hidden rounded-card", aside ? "flex-col gap-4 px-6 pb-6 pt-4" : "grow items-center gap-8 px-8 py-5")}>
      <Tilt
        area={tile}
        className={cn("flex items-center justify-center [&>img]:size-full [&>img]:drop-shadow-[0_24px_30px_rgb(0_0_0/0.45)] [&>svg]:max-h-full", aside ? "order-first h-[230px] w-full" : "order-last h-[clamp(200px,calc(100dvh-740px),400px)] w-[50%] shrink-0")}
      >
        {art}
      </Tilt>
      <figcaption className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[15px] text-high">
          <span className={cn("size-2 shrink-0 rounded-full", live ? "bg-live" : "bg-asleep")} aria-hidden="true" />
          {live ? `${connection ? `${connection} · ` : ""}Connected` : "Not connected"}
        </p>
        {detail && <div className="mt-3 max-w-[440px] text-[14px] leading-relaxed text-medium">{detail}</div>}
        {badges && <div className="mt-5 flex flex-wrap items-center gap-2">{badges}</div>}
      </figcaption>
    </figure>
  );
}

/**
 * The top of a device's Overview when the page's main controls sit right under it (a mouse's DPI, a keyboard's keys,
 * a pad's tester, a monitor's picture): one compact card with the device leaning toward the pointer, how it's
 * connected, what it reports (values over their names between hairlines, a battery as a small ring), and one quiet
 * line under them: "Keep your feel" (or any line the page gives) on the left, the firmware and other facts on the right.
 */
export function OverviewStrip({
  art,
  live = true,
  connection,
  detail,
  badges,
  stats,
  lead,
  battery,
  line,
  facts,
}: {
  art: ReactNode;
  live?: boolean;
  /** "Wired", "Wireless", ... shown as "Wired · Connected". */
  connection: string | null;
  detail?: ReactNode;
  badges?: ReactNode;
  stats: readonly Stat[];
  /** A control set like a stat, before the stats (a mouse's polling rate picker). */
  lead?: ReactNode;
  battery?: { percent: number | null; charging: boolean; state: string } | null;
  /** The quiet line's left side (the compact Keep your feel). */
  line?: ReactNode;
  /** The quiet line's right side: name and value pairs ("Firmware", "1.00.03"). */
  facts?: readonly (readonly [string, ReactNode])[];
}) {
  const tile = useRef<HTMLElement>(null);
  const quiet = !!line || !!facts?.length;
  return (
    <figure ref={tile} className="tile relative m-0 grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-9 overflow-hidden rounded-card py-5 pl-6 pr-8 max-[1100px]:grid-cols-[auto_minmax(0,1fr)]">
      <Tilt area={tile} className={cn("flex h-[clamp(110px,calc(100dvh-910px),180px)] w-[clamp(170px,15vw,270px)] items-center justify-center", quiet && "row-span-2")}>
        <div className="flex size-full items-center justify-center [&>img]:max-h-full [&>img]:max-w-full [&>img]:drop-shadow-[0_26px_32px_rgb(0_0_0/0.5)] [&>svg]:max-h-full">{art}</div>
      </Tilt>
      <figcaption className={cn("min-w-0", quiet && "self-end")}>
        <p className="flex items-center gap-2 text-[15px] font-medium text-high">
          <span className={cn("size-2 shrink-0 rounded-full", live ? "bg-live" : "bg-asleep")} aria-hidden="true" />
          {live ? `${connection ? `${connection} · ` : ""}Connected` : "Not connected"}
        </p>
        {detail && <div className="mt-1.5 max-w-[480px] text-[13px] leading-relaxed text-medium">{detail}</div>}
        {badges && <div className="mt-3 flex flex-wrap items-center gap-2">{badges}</div>}
      </figcaption>
      <dl className={cn("flex items-center max-[1100px]:col-start-2 max-[1100px]:mt-4", quiet && "self-end")}>
        {lead && <div className="pr-6">{lead}</div>}
        {stats.map((s, i) => (
          <div key={s.label} className={cn("flex min-w-0 flex-col-reverse px-6", (i > 0 || lead) && "border-l border-white/[0.09]")}>
            <dt className="mt-1 whitespace-nowrap text-[12.5px] text-medium">
              {s.label}
              {s.note && <span className="text-faint"> · {s.note}</span>}
            </dt>
            <dd className="whitespace-nowrap text-[24px] font-bold leading-none tracking-[-0.035em] text-high">{s.value}</dd>
          </div>
        ))}
        {battery && (
          // The battery as a cell, big enough to read at a glance (src/components/ui/battery-cell.tsx).
          <div className={cn("pl-7", stats.length > 0 && "border-l border-white/[0.09]")}>
            <BatteryCell percent={battery.percent} charging={battery.charging} state={battery.state} />
          </div>
        )}
      </dl>
      {quiet && (
        <div className="col-span-2 col-start-2 mt-4 flex min-w-0 items-center gap-6 border-t border-white/[0.07] pt-3.5 max-[1100px]:col-span-1">
          <div className="min-w-0 flex-1">{line}</div>
          {facts && facts.length > 0 && (
            <p className="min-w-0 shrink truncate text-[12px] text-medium">
              {facts.map(([k, v], i) => (
                <span key={k}>
                  {i > 0 && <span className="px-2 text-faint">·</span>}
                  <span className="text-faint">{k} </span>
                  <span className="text-medium">{v}</span>
                </span>
              ))}
            </p>
          )}
        </div>
      )}
    </figure>
  );
}
