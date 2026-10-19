// SYNQ's surfaces: panels (dark, a fine light edge, warm at the top-left), toggle rows, notices and small readouts.
// Device tiles are the `tile` utility (index.css); the window bar and the dock are in ./chrome.tsx.
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Switch } from "./switch";

/** A panel; `innerClassName` lays out what's inside it. */
export function Card({ className, innerClassName, children }: { className?: string; innerClassName?: string; children: ReactNode }) {
  return (
    <div className={cn("panel rounded-card", className)}>
      <div className={cn("h-full rounded-[inherit]", innerClassName)}>{children}</div>
    </div>
  );
}

export function CardHeader({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-4">
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold tracking-[-0.015em] text-high">{title}</h3>
        {hint && <p className="mt-0.5 text-[13px] text-medium">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

/** The small capitals label that sits above a heading ("ACTIVE DEVICE"). */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="label-caps inline-flex items-center gap-2">{children}</span>;
}

/** Icon + title + status line + switch. */
export function ToggleCard({
  icon: IconCmp,
  title,
  status,
  checked,
  onCheckedChange,
}: {
  icon: Icon;
  title: string;
  status: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="group flex cursor-pointer items-center gap-3.5 rounded-control px-3 py-3 transition-colors duration-500 ease-fluid hover:bg-white/[0.03]">
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-control ring-1 ring-white/[0.07] transition-colors duration-500 ease-fluid",
          checked ? "bg-primary/15 text-primary" : "bg-white/[0.03] text-medium",
        )}
      >
        <IconCmp size={19} weight="light" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] text-high">{title}</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={status}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
            className="block truncate text-[12.5px] text-medium"
          >
            {status}
          </motion.span>
        </AnimatePresence>
      </span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={title} />
    </label>
  );
}

/**
 * Facts about a device (maker, connection, firmware): each value over its name, in as many columns as fit, never a
 * name on the far left and its value on the far right of a wide card.
 */
export function DetailRows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 [grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex min-w-0 flex-col-reverse justify-end border-t border-white/[0.06] py-3">
          <dt className="mt-0.5 truncate text-[12px] text-medium">{k}</dt>
          <dd className="text-[14px] font-medium text-high [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface Notice {
  id: number;
  title: string;
  detail?: string;
  tone: "ok" | "error" | "info";
  action?: { label: string; run: () => void };
}

/** Floating glass pills at the bottom, with an optional action. */
export function NoticeStack({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[112px] z-50 flex flex-col items-center gap-2">
      <AnimatePresence initial={false}>
        {notices.map((n) => (
          <motion.div
            key={n.id}
            layout
            initial={{ opacity: 0, y: 18, scale: 0.96, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: 10, scale: 0.97, filter: "blur(4px)" }}
            transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
            className="pointer-events-auto flex min-w-[340px] max-w-[580px] items-center gap-3 rounded-popover bg-[#1c1c1c]/90 py-2 pl-4 pr-2 shadow-[0_18px_40px_-12px_rgb(0_0_0/0.7)] ring-1 ring-white/[0.1] backdrop-blur-xl"
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                n.tone === "ok" && "bg-[var(--live)]",
                n.tone === "error" && "bg-destructive",
                n.tone === "info" && "bg-white/60",
              )}
            />
            <div className="min-w-0 flex-1 py-0.5">
              <p className="truncate text-[13px] text-high">{n.title}</p>
              {n.detail && <p className="truncate text-[12px] text-medium">{n.detail}</p>}
            </div>
            {n.action && (
              <button
                onClick={() => {
                  n.action!.run();
                  onDismiss(n.id);
                }}
                className="rounded-small bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.97]"
              >
                {n.action.label}
              </button>
            )}
            <button
              onClick={() => onDismiss(n.id)}
              className="flex size-7 items-center justify-center rounded-full text-medium transition-colors hover:bg-white/[0.06] hover:text-high"
              aria-label="Dismiss"
            >
              ×
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Label + value chip for headline numbers. */
export function Readout({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "ok" | "bad" }) {
  return (
    <div className="flex items-baseline gap-2 rounded-full bg-white/[0.03] px-3.5 py-1.5 ring-1 ring-white/[0.07]">
      <span className="text-[12px] text-medium">{label}</span>
      <span className={cn("tabular text-[13px]", tone === "ok" && "text-primary", tone === "bad" && "text-destructive", tone === "default" && "text-high")}>
        {value}
      </span>
    </div>
  );
}
