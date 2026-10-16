// The frame every device page shares: a header with the way back to its tab (Devices, Lights or Displays), the connection and
// support-tier pills, and a tab bar; plus the pieces the Overview tab is made of (the big render and
// the "Current status" strip). Pure layout: nothing here talks to a device.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowClockwise, CaretLeft, DotsThree, Eye, Flask, SealCheck, Stethoscope, TestTube, type Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { goCheckup, goSection, sectionOfDevice } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { TIER_LABEL, type KbTier } from "@/lib/kb/types";
import { Card } from "@/components/ui/matte";
import { arrowPick } from "@/lib/roving";

export interface TabDef {
  id: string;
  label: string;
}

/** Dot + text pill: the connection ("Connected · Wireless"). */
export function StatusPill({ live, children }: { live: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-1 text-[12px] text-muted-foreground ring-1 ring-white/[0.06]">
      <span className={cn("size-1.5 rounded-full", live ? "bg-primary shadow-[0_0_8px_var(--primary)]" : "bg-white/20")} />
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
        tier === "read-only" && "bg-white/[0.04] text-muted-foreground ring-white/[0.08]",
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
        "flex h-10 w-fit shrink-0 items-center gap-1.5 rounded-full bg-white/[0.06] pl-3.5 pr-[18px] text-[14px] font-medium text-foreground ring-1 ring-white/[0.12] transition-colors duration-500 ease-fluid hover:bg-white/[0.1]",
        className,
      )}
    >
      <CaretLeft size={14} /> {children}
    </button>
  );
}

/** The tab bar: a glass pill track whose chosen tab is a solid pill, like the dock's. */
export function TabBar({ id, tabs, value, onChange }: { id: string; tabs: readonly TabDef[]; value: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" onKeyDown={arrowPick} aria-label="Sections" className="-mx-1 flex overflow-x-auto px-1 pb-1">
      <div className="flex items-center gap-0.5 rounded-full bg-white/[0.05] p-1 ring-1 ring-white/[0.1]">
        {tabs.map((t) => {
          const on = t.id === value;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={on}
              onClick={() => onChange(t.id)}
              className={cn(
                "relative h-9 whitespace-nowrap rounded-full px-[18px] text-[14px] transition-colors duration-500 ease-fluid",
                on ? "font-semibold text-background" : "font-medium text-foreground/70 hover:text-foreground",
              )}
            >
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
      className="group flex h-9 items-center gap-2 rounded-full bg-white/[0.05] pl-4 pr-1.5 text-[13px] text-foreground ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.08]"
    >
      Reconnect
      <span className="grid size-6 place-items-center rounded-full bg-white/[0.08] transition-transform duration-500 ease-fluid group-hover:rotate-90">
        <ArrowClockwise size={13} />
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
        className={cn("grid size-9 place-items-center rounded-full ring-1 transition-colors", open ? "bg-white/[0.09] text-foreground ring-white/[0.12]" : "bg-white/[0.05] text-muted-foreground ring-white/[0.08] hover:bg-white/[0.08] hover:text-foreground")}
      >
        <DotsThree size={18} weight="bold" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
            className="absolute right-0 top-11 z-40 w-[248px] rounded-2xl bg-[#141418]/95 p-1.5 shadow-[0_18px_40px_-12px_rgb(0_0_0/0.8)] ring-1 ring-white/[0.08] backdrop-blur-xl"
          >
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                goCheckup(id);
              }}
              className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]"
            >
              <Stethoscope size={17} weight="light" className="mt-0.5 shrink-0 text-primary" />
              <span>
                <span className="block text-[13px] text-foreground">Check this device</span>
                <span className="block text-[11.5px] leading-snug text-muted-foreground">A guided checkup, about a minute</span>
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
    <header className="shrink-0 px-8 pt-7">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <BackButton onClick={() => goSection(back)} className="mt-0.5">
          {BACK_LABEL[back]}
        </BackButton>
        <div className="mr-auto min-w-0">
          {title ?? <h1 className="truncate text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] text-foreground">{name}</h1>}
          {subtitle && <p className="mt-1.5 text-[13px] text-muted-foreground">{subtitle}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">{pills}</div>
        </div>
        <div className="flex items-center gap-3">
          {actions}
          <DeviceMenu id={id} />
        </div>
      </div>
      {/* One tab is just the page: no bar for it. */}
      {tabs.length > 1 && (
        <div className="mt-4">
          <TabBar id={id} tabs={tabs} value={tab} onChange={onTab} />
        </div>
      )}
    </header>
  );
}

const BACK_LABEL = { devices: "Gear", lights: "Lights", displays: "Displays" } as const;

/** The scrolling area under a device header. `key` it by tab so each tab keeps its own scroll. */
/** A tab's scrolling body. It takes focus (tabIndex 0 where it is used) so the keyboard can scroll a tab with no controls; its ring is drawn inside. */
export const TAB_BODY = "flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-8 pb-10 pt-5 [scrollbar-gutter:stable] [&>*]:shrink-0 focus-visible:outline-offset-[-3px]";

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
            <aside className="flex w-[440px] shrink-0 flex-col gap-5 overflow-y-auto pb-10 pl-8 pt-5 [scrollbar-gutter:stable]">{aside}</aside>
          </AsideCtx.Provider>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}

/** "Current status": a row of small tiles, each one a setting and its value right now. */
export function StatusStrip({ stats, title = "Current status" }: { stats: readonly Stat[]; title?: string }) {
  const aside = useContext(AsideCtx);
  return (
    <section aria-label={title}>
      <p className="label-mono mb-3 px-1">{title}</p>
      {/* Beside the page: two columns. Full width: up to five a row, wrapping before a tile gets narrower than 150 px (the app's smallest window). */}
      <div className="grid gap-3" style={{ gridTemplateColumns: aside ? "repeat(2, minmax(0, 1fr))" : "repeat(auto-fit, minmax(max(150px, calc((100% - 3rem) / 5)), 1fr))" }}>
        {stats.map((s) => (
          <div key={s.label} className="min-w-0 rounded-[1.4rem] bg-white/[0.045] p-1.5 ring-1 ring-white/[0.09]">
            <div className="h-full rounded-[calc(1.4rem-0.375rem)] bg-[#0c0c0f]/[0.62] bg-[linear-gradient(160deg,rgb(255_255_255/0.06),rgb(255_255_255/0.012)_55%)] px-4 py-3.5 shadow-[inset_0_1px_1px_rgb(255_255_255/0.1)]">
              <p className="label-mono truncate">{s.label}</p>
              <p className="display-num mt-2.5 truncate pb-0.5 text-[32px] leading-none tracking-[-0.04em] text-foreground">{s.value}</p>
              {s.note && <p className="mt-1.5 truncate text-[11.5px] text-muted-foreground/80">{s.note}</p>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The Overview tab's big picture: the render (or outline art) with the connection line beside it. */
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
  return (
    <Card innerClassName={cn("relative flex overflow-hidden", aside ? "flex-col gap-5 px-6 py-6" : "items-center gap-8 px-8 py-6")}>
      <div className={cn("flex items-center justify-center [&>img]:max-h-full [&>img]:max-w-full [&>svg]:max-h-full", aside ? "order-first h-[220px] w-full" : "order-last h-[210px] w-[46%] shrink-0")}>{art}</div>
      <div className="min-w-0 flex-1">
        <StatusPill live={live}>{live ? `Connected${connection ? ` · ${connection}` : ""}` : "Not connected"}</StatusPill>
        <p className="mt-4 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-foreground">{name}</p>
        {detail && <div className="mt-2 max-w-[420px] text-[13px] leading-relaxed text-muted-foreground">{detail}</div>}
        {badges && <div className="mt-4 flex flex-wrap items-center gap-2">{badges}</div>}
      </div>
    </Card>
  );
}
