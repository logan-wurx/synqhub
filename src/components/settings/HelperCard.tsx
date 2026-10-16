// Settings > SYNQ Helper (desktop): the opt-in background helper (src-tauri/helper, docs/helper.md).
// Off by default. Turning it on writes the per-user sign-in entry and starts it; turning it off stops it
// and removes the entry. Each of its three jobs can be turned off on its own.
import { useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import { BatteryWarning, GameController, Globe, Lightning } from "@phosphor-icons/react";
import { Card, CardHeader, DetailRows, ToggleCard, type Notice } from "@/components/ui/matte";
import { publishHelper } from "@/lib/helper-state";
import { batteryLevels, DEFAULT_BATTERY_LEVELS, helper, type HelperSettings, type HelperStatus } from "@/lib/helper";
import { isLinux } from "@/lib/runtime";

/** Where it starts from and where its menu is, per OS (Linux: XDG autostart and a tray icon where the desktop shows one). */
const RUNNING_NOTE = isLinux
  ? "Starts when you log in (~/.config/autostart). Its tray icon, where your desktop shows one, has Open, Pause and Quit."
  : "Starts when you sign in. Its icon in the taskbar has Open, Pause and Quit.";

/** The battery alert levels: one notification at each, once per discharge. */
function LevelEditor({ levels, onChange }: { levels: number[]; onChange: (next: number[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const next = batteryLevels([...levels, Number(draft)]);
    if (next) {
      onChange(next);
      setDraft("");
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-2 pl-[68px] pr-3">
      <span className="mr-1 text-[12px] text-muted-foreground">Alert at</span>
      {levels.map((l) => (
        <span key={l} className="tabular inline-flex items-center gap-1 rounded-full bg-primary/10 py-1 pl-2.5 pr-1 text-[12px] text-foreground ring-1 ring-primary/25">
          {l}%
          {levels.length > 1 && (
            <button type="button" aria-label={`Remove the ${l}% alert`} onClick={() => onChange(levels.filter((x) => x !== l))} className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-white/[0.08] hover:text-foreground">
              <X size={11} />
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
          className="tabular h-7 w-14 rounded-full bg-white/[0.04] px-2.5 text-[12px] text-foreground outline-none ring-1 ring-white/[0.08] placeholder:text-muted-foreground/80 focus:ring-primary/60"
        />
      )}
      {levels.join() !== DEFAULT_BATTERY_LEVELS.join() && (
        <button type="button" onClick={() => onChange([...DEFAULT_BATTERY_LEVELS])} className="rounded-full px-2.5 py-1 text-[12px] text-muted-foreground hover:text-foreground">
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
  const state = !status.installed ? "Not installed with this copy" : on ? (status.running ? "On, running" : "On, not running") : "Off";

  return (
    <Card>
      <CardHeader title="SYNQ Helper" hint="Off unless you turn it on. A tiny background process (no window, a few MB of memory, idle when there's nothing to do)." />
      <div className="px-2 pb-2">
        <ToggleCard
          icon={Lightning}
          title="Run SYNQ Helper"
          status={on ? RUNNING_NOTE : "Nothing runs in the background."}
          checked={on}
          onCheckedChange={(v) => void change({ enabled: v })}
        />
        {on && (
          <>
            <ToggleCard
              icon={GameController}
              title="Game profiles"
              status={s.gameProfiles ? "Follows the games on the Games page (by program name only)." : "Off"}
              checked={s.gameProfiles}
              onCheckedChange={(v) => void change({ gameProfiles: v })}
            />
            <ToggleCard
              icon={BatteryWarning}
              title="Battery alerts"
              status={s.batteryAlerts ? "One notification at each level, once per charge. Checked every 5 minutes, less when asleep." : "Off"}
              checked={s.batteryAlerts}
              onCheckedChange={(v) => void change({ batteryAlerts: v })}
            />
            {s.batteryAlerts && <LevelEditor levels={batteryLevels(s.batteryLevels ?? []) ?? DEFAULT_BATTERY_LEVELS} onChange={(batteryLevels) => void change({ batteryLevels })} />}
            <ToggleCard
              icon={Globe}
              title="Website bridge"
              status={s.webBridge ? `Lets the SYNQ website use Razer, the EQ and Advanced here (this PC only, port ${status.port}).` : "Off"}
              checked={s.webBridge}
              onCheckedChange={(v) => void change({ webBridge: v })}
            />
          </>
        )}
      </div>
      <div className="px-5 pb-4">
        <DetailRows
          rows={[
            ["Status", state],
            [isLinux ? "Starts at login" : "Starts at sign-in", status.autostart ? "Yes" : "No"],
            ["Paired websites", status.sites.length ? status.sites.join(", ") : "None"],
          ]}
        />
        {status.sites.length > 0 && (
          <button type="button" onClick={() => void forget()} className="mt-2 rounded-full px-3 py-1.5 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06]">
            Forget paired websites
          </button>
        )}
        <p className="pt-3 text-[12.5px] leading-relaxed text-muted-foreground">
          Everything it sends goes through the same safety checks as this app. It never updates firmware, never opens a device in update mode, and never touches a
          game's process. {isLinux ? "Turning it off here removes its login entry; removing SYNQ stops it." : "Uninstalling SYNQ removes it."}
        </p>
      </div>
    </Card>
  );
}
