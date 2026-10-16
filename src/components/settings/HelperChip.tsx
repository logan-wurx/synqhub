// The dock's small "Helper" pill: SYNQ Helper's state at a glance (its dot), and a way into its settings.
import { cn } from "@/lib/utils";
import { setKept } from "@/lib/keep";
import { goSettings } from "@/lib/nav";
import { useHelperStatus } from "@/lib/helper-state";

export function HelperChip() {
  const status = useHelperStatus();
  if (!status) return null;
  const on = status.settings.enabled;
  return (
    <button
      onClick={() => {
        setKept<string | null>("settings.focus", "helper");
        goSettings();
      }}
      title={`SYNQ Helper: ${on ? (status.running ? "on, running in the tray" : "on, not running") : "off"}. Game profiles, battery alerts and the website bridge. Open its settings.`}
      className="flex h-11 items-center gap-2 rounded-full px-4 text-[14px] font-medium text-foreground/75 transition-colors duration-500 ease-fluid hover:text-foreground max-sm:hidden"
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-primary shadow-[0_0_8px_var(--primary)]" : "bg-white/25")} aria-hidden="true" />
      Helper
      <span className="sr-only">{on ? "on" : "off"}</span>
    </button>
  );
}
