// Small pieces shared by the keyboard panels (Falchion and X68 HE): chips, buttons, banners, the
// keycap look and the model switcher.
import type { ReactNode } from "react";
import { motion } from "motion/react";
import { Warning } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/matte";
import { Switch } from "@/components/ui/switch";
import { PlugIn } from "@/components/ui/brand";
import { DeviceThumb, type ArtSpec } from "@/components/devices/DeviceArt";
import { arrowPick } from "@/lib/roving";

export function Chip({ on, numeric, onClick, disabled, children }: { on: boolean; numeric?: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={cn(
        "rounded-full px-3.5 py-1.5 text-[12.5px] ring-1 transition-colors duration-500 ease-fluid disabled:opacity-40",
        numeric && "tabular",
        on ? "bg-primary text-primary-foreground ring-primary shadow-[0_0_16px_-4px_var(--primary)]" : "bg-white/[0.04] text-medium ring-white/[0.07] hover:bg-white/[0.08] hover:text-high",
      )}
    >
      {children}
    </button>
  );
}

export function StepButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="grid h-8 w-10 place-items-center rounded-full bg-white/[0.05] text-medium ring-1 ring-white/[0.07] transition-colors hover:bg-white/[0.09] hover:text-high disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function Pill({ primary, className, onClick, disabled, children }: { primary?: boolean; className?: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-9 whitespace-nowrap rounded-control px-4 text-[12.5px] transition-all duration-300 ease-fluid active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
        primary ? "bg-foreground font-medium text-background" : "bg-white/[0.05] text-high ring-1 ring-white/[0.08] hover:bg-white/[0.09]",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function MiniKey({ lit, children }: { lit: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "grid h-10 min-w-10 place-items-center rounded-small px-2.5 text-[13px] ring-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.06),inset_0_-2px_0_rgb(0_0_0/0.45)] transition-colors duration-300",
        lit ? "bg-primary/[0.16] text-high ring-primary/45 shadow-[0_0_16px_-6px_var(--primary)]" : "bg-white/[0.035] text-medium ring-white/[0.07]",
      )}
    >
      {children}
    </span>
  );
}

export function SwitchRow({ title, hint, checked, onChange }: { title: string; hint: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-high">{title}</span>
        <span className="block text-[11.5px] text-medium">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} />
    </label>
  );
}

export function Banner({ children, tone = "warn" }: { children: ReactNode; tone?: "warn" | "info" }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-control px-4 py-3 text-[13px] leading-relaxed ring-1",
        tone === "warn" ? "bg-chart-3/[0.06] text-chart-3 ring-chart-3/20" : "bg-white/[0.03] text-medium ring-white/[0.07]",
      )}
    >
      <Warning size={16} weight="light" className="shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/** Empty state: the plug-in drawing, or a (pulsing) render while looking. */
export function EmptyCard({ title, text, plug, image, pulse }: { title: string; text: string; plug?: boolean; image?: string; pulse?: boolean }) {
  return (
    <Card innerClassName="flex flex-col items-center px-8 pb-12 pt-8 text-center">
      {plug && <PlugIn kind="keyboard" className="mb-2 h-[200px] w-[267px]" />}
      {!plug && image && <img src={image} alt="" className={cn("mb-4 h-[180px] object-contain opacity-80", pulse && "animate-pulse")} />}
      <p className="text-[17px] font-medium text-high">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-[13.5px] text-medium">{text}</p>
    </Card>
  );
}

/** A key on a keyboard map: plain, lit (setting active), dim (set but off), selected. */
export function keycapClass({ tone, selected, locked }: { tone?: "lit" | "dim"; selected: boolean; locked?: boolean }) {
  return cn(
    "absolute flex flex-col items-start justify-between overflow-hidden rounded-tight px-2 py-1.5 text-left ring-1 transition-[background-color,box-shadow,color] duration-300 ease-fluid",
    "shadow-[inset_0_1px_0_rgb(255_255_255/0.06),inset_0_-2px_0_rgb(0_0_0/0.45)]",
    locked && "cursor-default opacity-35",
    !tone && "bg-white/[0.035] text-medium ring-white/[0.06] hover:bg-white/[0.07] hover:text-high",
    tone === "lit" &&
      "bg-primary/[0.16] text-high ring-primary/45 shadow-[inset_0_1px_0_rgb(255_255_255/0.08),inset_0_-2px_0_rgb(0_0_0/0.4),0_0_16px_-6px_var(--primary)]",
    tone === "dim" && "bg-white/[0.035] text-high ring-primary/30",
    selected && "ring-2 ring-white/85",
  );
}

/** "falchion", "x68", or "kb:<vid>:<pid>" for a keyboard on the generic panel. */
export type KeyboardModel = string;

/** Pill switcher shown in a keyboard panel's header when more than one keyboard is plugged in. */
export function KeyboardSwitcher({
  options,
  value,
  onChange,
}: {
  options: { id: KeyboardModel; label: string; quiet?: boolean; art?: ArtSpec }[];
  value: KeyboardModel;
  onChange: (id: KeyboardModel) => void;
}) {
  return (
    <div role="tablist" onKeyDown={arrowPick} aria-label="Keyboard" className="flex h-9 items-center gap-0.5 rounded-full bg-white/[0.04] p-1 ring-1 ring-white/[0.07]">
      {/* Mice or keyboards that are off or didn't answer go last, dimmed; they return to their place once they answer. */}
      {[...options].sort((a, b) => Number(!!a.quiet) - Number(!!b.quiet)).map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            role="tab"
            aria-selected={on}
            title={o.quiet ? `${o.label} didn't answer` : undefined}
            onClick={() => onChange(o.id)}
            className={cn(
              "relative h-7 whitespace-nowrap rounded-full px-3.5 text-[12.5px] transition-colors duration-500 ease-fluid",
              on ? "text-high" : o.quiet ? "text-medium hover:text-medium" : "text-medium hover:text-high",
            )}
          >
            {on && (
              <motion.span
                layoutId="keyboard-switcher"
                transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
                className="absolute inset-0 rounded-full bg-white/[0.08] shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] ring-1 ring-white/[0.08]"
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {o.art && <DeviceThumb spec={o.art} className={o.quiet ? "opacity-40" : undefined} />}
              {o.label}
              {o.quiet && <span className="text-[11px] font-normal text-medium">Not answering</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A plain dark select in the app's style. */
export function Select<T extends string>({
  value,
  onChange,
  groups,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  groups: { label?: string; options: { value: T; label: string }[] }[];
  label: string;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(
        "h-9 min-w-0 rounded-control bg-white/[0.04] px-2.5 text-[13px] text-high outline-none ring-1 ring-white/[0.07] transition-colors hover:bg-white/[0.06] focus:ring-primary/60 [&>optgroup]:bg-[#16171d] [&>option]:bg-[#16171d]",
        className,
      )}
    >
      {groups.map((g, i) =>
        g.label ? (
          <optgroup key={i} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : (
          g.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))
        ),
      )}
    </select>
  );
}
