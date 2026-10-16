// SYNQ's surfaces: layered glass panels ("double bezel": a hairline tray holding an inner
// plate), toggle rows, notices and small readouts. The dock and the room light are in ./ambient.tsx.
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Switch } from "./switch";

/** Outer tray + inner plate with concentric corners. */
export function Card({ className, innerClassName, children }: { className?: string; innerClassName?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-[1.6rem] bg-white/[0.045] p-1.5 ring-1 ring-white/[0.09]", className)}>
      <div
        className={cn(
          // Glass over the room light: dark enough under the text for AA contrast, a faint sheen from the top-left.
          "h-full rounded-[calc(1.6rem-0.375rem)] bg-[#0c0c0f]/[0.62] bg-[linear-gradient(160deg,rgb(255_255_255/0.06),rgb(255_255_255/0.012)_55%)] shadow-[inset_0_1px_1px_rgb(255_255_255/0.1),0_20px_50px_-24px_rgb(0_0_0/0.8)]",
          innerClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function CardHeader({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-4">
      <div className="min-w-0">
        <h3 className="text-[14px] font-medium tracking-tight text-foreground">{title}</h3>
        {hint && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

/** Small mono label that sits above a heading, with the accent's dot. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="label-mono inline-flex items-center gap-2">
      <span className="size-1.5 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" aria-hidden="true" />
      {children}
    </span>
  );
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
    <label className="group flex cursor-pointer items-center gap-3.5 rounded-2xl px-3 py-3 transition-colors duration-500 ease-fluid hover:bg-white/[0.03]">
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-white/[0.07] transition-colors duration-500 ease-fluid",
          checked ? "bg-primary/15 text-primary" : "bg-white/[0.03] text-muted-foreground",
        )}
      >
        <IconCmp size={19} weight="light" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] text-foreground">{title}</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={status}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
            className="block truncate text-[12.5px] text-muted-foreground"
          >
            {status}
          </motion.span>
        </AnimatePresence>
      </span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={title} />
    </label>
  );
}

export function DetailRows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-white/[0.05]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-4 py-2.5 text-[13px]">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="truncate text-right text-foreground">{v}</dd>
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
    <div className="pointer-events-none fixed inset-x-0 bottom-[104px] z-50 flex flex-col items-center gap-2">
      <AnimatePresence initial={false}>
        {notices.map((n) => (
          <motion.div
            key={n.id}
            layout
            initial={{ opacity: 0, y: 18, scale: 0.96, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: 10, scale: 0.97, filter: "blur(4px)" }}
            transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
            className="pointer-events-auto flex min-w-[340px] max-w-[580px] items-center gap-3 rounded-full bg-[#141418]/80 py-2 pl-4 pr-2 shadow-[0_18px_40px_-12px_rgb(0_0_0/0.7)] ring-1 ring-white/[0.08] backdrop-blur-xl"
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                n.tone === "ok" && "bg-primary shadow-[0_0_10px_var(--primary)]",
                n.tone === "error" && "bg-destructive shadow-[0_0_10px_var(--destructive)]",
                n.tone === "info" && "bg-secondary shadow-[0_0_10px_var(--secondary)]",
              )}
            />
            <div className="min-w-0 flex-1 py-0.5">
              <p className="truncate text-[13px] text-foreground">{n.title}</p>
              {n.detail && <p className="truncate text-[12px] text-muted-foreground">{n.detail}</p>}
            </div>
            {n.action && (
              <button
                onClick={() => {
                  n.action!.run();
                  onDismiss(n.id);
                }}
                className="rounded-full bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.97]"
              >
                {n.action.label}
              </button>
            )}
            <button
              onClick={() => onDismiss(n.id)}
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
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

export const ACCENTS = [
  // The swatch is the room light's own colours (index.css), so it shows what the accent is right now.
  { id: "room", color: "linear-gradient(135deg, var(--glow-a), var(--glow-b))", label: "Room light" },
  { id: "iris", color: "#8b5cf6", label: "Violet" },
  { id: "ice", color: "#42d4ff", label: "Ice" },
  { id: "lime", color: "#c6f24e", label: "Lime" },
  { id: "ember", color: "#ff9e45", label: "Ember" },
  { id: "rog", color: "#ff3d57", label: "Red" },
] as const;

/** Label + value chip for headline numbers. */
export function Readout({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "ok" | "bad" }) {
  return (
    <div className="flex items-baseline gap-2 rounded-full bg-white/[0.03] px-3.5 py-1.5 ring-1 ring-white/[0.07]">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className={cn("tabular text-[13px]", tone === "ok" && "text-primary", tone === "bad" && "text-destructive", tone === "default" && "text-foreground")}>
        {value}
      </span>
    </div>
  );
}
