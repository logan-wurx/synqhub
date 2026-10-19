// Settings > SYNQ Helper (desktop): the opt-in background helper (src-tauri/helper, docs/helper.md).
// Off by default. Turning it on writes the per-user sign-in entry and starts it; turning it off stops it
// and removes the entry. Each of its three jobs can be turned off on its own.
import { useEffect, useState, type ReactNode } from "react";
import { BatteryWarning, GameController, Globe, Lightning, X, type Icon } from "@phosphor-icons/react";
import type { Notice } from "@/components/ui/matte";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { publishHelper } from "@/lib/helper-state";
import { batteryLevels, DEFAULT_BATTERY_LEVELS, helper, type HelperSettings, type HelperStatus } from "@/lib/helper";
import { isLinux } from "@/lib/runtime";

/** Where it starts from and where its menu is, per OS (Linux: XDG autostart and a tray icon where the desktop shows one). */
const RUNNING_NOTE = isLinux
  ? "Starts when you log in (~/.config/autostart). Its tray icon, where your desktop shows one, has Open, Pause and Quit."
  : "Starts when you sign in. Its icon in the taskbar has Open, Pause and Quit.";

/** The battery alert levels: one notification at each, once per discharge. */
export function LevelEditor({ levels, onChange }: { levels: number[]; onChange: (next: number[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const next = batteryLevels([...levels, Number(draft)]);
    if (next) {
      onChange(next);
      setDraft("");
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[12px] text-medium">Alert at</span>
      {levels.map((l) => (
        <span key={l} className="tabular inline-flex items-center gap-1 rounded-full bg-primary/10 py-1 pl-2.5 pr-1 text-[12px] text-high ring-1 ring-primary/25">
          {l}%
          {levels.length > 1 && (
            <button type="button" aria-label={`Remove the ${l}% alert`} onClick={() => onChange(levels.filter((x) => x !== l))} className="grid size-5 place-items-center rounded-full text-medium hover:bg-white/[0.08] hover:text-high">
              <X size={12} />
            </button>
          )}
        </span>
      ))}
      {levels.length < 5 && (
        <input
          value={draft}
          inputMode="numeric"
          maxLength={2}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && add()}
          onBlur={() => draft && add()}
          placeholder="+ %"
          aria-label="Add an alert level (1 to 50%)"
          className="tabular h-7 w-14 rounded-small bg-white/[0.04] px-2.5 text-[12px] text-high outline-none ring-1 ring-white/[0.08] placeholder:text-medium focus:ring-primary/60"
        />
      )}
      {levels.join() !== DEFAULT_BATTERY_LEVELS.join() && (
        <button type="button" onClick={() => onChange([...DEFAULT_BATTERY_LEVELS])} className="rounded-small px-2.5 py-1 text-[12px] text-medium hover:text-high">
          Reset to 20, 10, 5
        </button>
      )}
    </div>
  );
}

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

export function HelperCard({ notify }: { notify?: Notify }) {
  const [status, setStatus] = useState<HelperStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    helper.status().then((st) => (setStatus(st), publishHelper(st)), () => setStatus(null));
  }, []);

  const change = async (patch: Partial<HelperSettings>) => {
    if (!status || busy) return;
    setBusy(true);
    try {
      const next = await helper.set({ ...status.settings, ...patch });
      setStatus(next);
      publishHelper(next);
    } catch (e) {
      notify?.({ title: "SYNQ Helper wasn't changed", detail: String(e), tone: "error" }, "helper");
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    try {
      const next = await helper.forgetSites();
      setStatus(next);
      publishHelper(next);
    } catch (e) {
      notify?.({ title: "Couldn't forget the sites", detail: String(e), tone: "error" }, "helper");
    }
  };

  if (!status) return null;
  const s = status.settings;
  const on = s.enabled;
  const state = !status.installed ? "Not installed with this copy" : on ? (status.running ? "Running" : "On, not running") : "Off";

  return (
    <section aria-label="SYNQ Helper" className="tile relative flex h-full flex-col overflow-hidden rounded-card px-7 pb-6 pt-7 max-sm:px-5">
      {/* The helper itself: what it is, whether it runs, the one switch. */}
      <div className="flex items-start gap-5">
        <span className={cn("grid size-14 shrink-0 place-items-center rounded-control transition-colors duration-500 ease-fluid", on ? "bg-primary text-primary-foreground" : "bg-white/[0.06] text-medium ring-1 ring-white/[0.1]")}>
          <Lightning size={24} weight={on ? "fill" : "light"} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[28px] font-bold leading-tight tracking-[-0.035em] text-high">SYNQ Helper</h2>
          <p className="mt-1 flex items-center gap-2 text-[14px] text-high">
            <span className={cn("size-2 shrink-0 rounded-full", on && status.running ? "bg-live" : "bg-asleep")} aria-hidden="true" />
            {state}
          </p>
        </div>
        <Switch aria-label="Run SYNQ Helper" checked={on} onCheckedChange={(v) => void change({ enabled: v })} className="mt-2" />
      </div>
      <p className="mt-4 max-w-[62ch] text-[14px] leading-relaxed text-medium">
        {on ? RUNNING_NOTE : "Off unless you turn it on: a tiny background process with no window, a few MB of memory, idle when there's nothing to do."}
      </p>

      {/* Its three jobs, side by side, each with its own switch (shown while it's off too, dimmed: what turning it on gives). */}
      <div className="mt-4 grid gap-3 min-[900px]:grid-cols-3">
        <Job icon={GameController} title="Game profiles" text={!on || s.gameProfiles ? "Follows the games on the Games page, by program name only." : "Off"} on={on && s.gameProfiles} disabled={!on} onChange={(v) => void change({ gameProfiles: v })} />
        <Job icon={BatteryWarning} title="Battery alerts" text={!on || s.batteryAlerts ? "A notification at each level, once per charge." : "Off"} on={on && s.batteryAlerts} disabled={!on} onChange={(v) => void change({ batteryAlerts: v })}>
          {on && s.batteryAlerts && <LevelEditor levels={batteryLevels(s.batteryLevels ?? []) ?? DEFAULT_BATTERY_LEVELS} onChange={(batteryLevels) => void change({ batteryLevels })} />}
        </Job>
        <Job icon={Globe} title="Website bridge" text={!on || s.webBridge ? `Lets synqhub.app use Razer, the EQ and Advanced here (this PC only, port ${status.port}).` : "Off"} on={on && s.webBridge} disabled={!on} onChange={(v) => void change({ webBridge: v })} />
      </div>

      {/* On a tall window the card matches the column beside it: the facts sit at its foot. */}
      <div className="min-h-4 flex-1" aria-hidden="true" />
      <dl className="grid grid-cols-3 border-t border-white/[0.09] pt-4">
        <Fact label="Status" value={state} />
        <Fact label={isLinux ? "Starts at login" : "Starts at sign-in"} value={status.autostart ? "Yes" : "No"} divider />
        <Fact label="Paired websites" value={status.sites.length ? String(status.sites.length) : "None"} divider />
      </dl>
      {status.sites.length > 0 && (
        <button type="button" onClick={() => void forget()} className="mt-3 rounded-small px-3 py-1.5 text-[12.5px] text-high ring-1 ring-white/10 transition-colors hover:bg-white/[0.06]">
          Forget {status.sites.join(", ")}
        </button>
      )}
      <p className="mt-4 text-[12.5px] leading-relaxed text-medium">
        Everything it sends goes through the same safety checks as this app. It never updates firmware, never opens a device in update mode, and never touches a game's
        process. {isLinux ? "Turning it off here removes its login entry; removing SYNQ stops it." : "Uninstalling SYNQ removes it."}
      </p>
    </section>
  );
}

/** One of the helper's jobs: a small panel with its icon, what it does and its switch. */
export function Job({ icon: IconCmp, title, text, on, disabled, onChange, children }: { icon: Icon; title: string; text: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-control bg-shade/[0.18] p-4 ring-1 ring-white/[0.07] transition-opacity duration-500 ease-fluid", disabled && "opacity-55")}>
      <div className="flex items-center gap-3">
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-small transition-colors duration-500 ease-fluid", on ? "bg-primary/15 text-primary" : "bg-white/[0.05] text-medium")}>
          <IconCmp size={18} weight={on ? "fill" : "light"} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-high">{title}</span>
        <Switch aria-label={title} checked={on} disabled={disabled} onCheckedChange={onChange} />
      </div>
      <p className="text-[12.5px] leading-relaxed text-medium">{text}</p>
      {children}
    </div>
  );
}

function Fact({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-col-reverse justify-end", divider && "border-l border-white/[0.09] pl-5")}>
      <dt className="mt-0.5 truncate text-[12.5px] text-medium">{label}</dt>
      <dd className="truncate text-[18px] font-semibold tracking-[-0.02em] text-high">{value}</dd>
    </div>
  );
}
