// One scene in a light's Scenes tab, whatever the light: its picture (a moving preview for Govee's catalogue, static
// swatches for a Hue or Nanoleaf scene), its name, and a dot while it is being sent or is on.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SceneTile({ name, picture, on, sending, disabled, onClick }: { name: string; picture: ReactNode; on: boolean; sending: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={cn(
        "group flex flex-col gap-2.5 rounded-2xl bg-white/[0.025] p-2.5 text-left ring-1 transition-[background-color,box-shadow] duration-300 ease-fluid hover:bg-white/[0.05] disabled:cursor-wait",
        on ? "ring-primary/60 shadow-[0_0_18px_-6px_var(--primary)]" : "ring-white/[0.06]",
      )}
    >
      {picture}
      <span className="flex items-center gap-2 px-0.5">
        <span className="min-w-0 flex-1 text-[13px] leading-tight text-foreground [overflow-wrap:anywhere]">{name}</span>
        {(on || sending) && <span role="img" className={cn("size-1.5 shrink-0 rounded-full", sending ? "animate-pulse bg-white/60" : "bg-primary shadow-[0_0_8px_var(--primary)]")} aria-label={sending ? "Sending" : "On"} />}
      </span>
    </button>
  );
}
