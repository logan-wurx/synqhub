// Linux: the device-access card on the Devices home. Linux lets an app open a mouse or keyboard only when a
// udev rule says so. The .deb installs SYNQ's rule (70-onboard-hub.rules) itself; the AppImage can't, so on
// first run this card explains it and offers the rule: one click (pkexec, the system's own password prompt,
// only after that click) or a command to paste in a terminal. It shows only while the rule is missing or out
// of date, or a listed device can't be opened; "Not now" hides it until SYNQ is opened again.
import { useEffect, useState } from "react";
import { Copy, Check, ShieldCheck } from "@phosphor-icons/react";
import { backend, type DeviceAccess } from "@/lib/backend";
import { Card, type Notice } from "@/components/ui/matte";

const HIDE_KEY = "onboard.deviceAccess.later";

function hiddenForNow(): boolean {
  try {
    return sessionStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function DeviceAccessCard({ notify }: { notify?: (n: Omit<Notice, "id">, key?: string) => void }) {
  const [status, setStatus] = useState<DeviceAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(hiddenForNow);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void backend.deviceAccess().then(setStatus, () => setStatus(null));
  }, []);

  if (!status?.needed || hidden) return null;

  const later = () => {
    setHidden(true);
    try {
      sessionStorage.setItem(HIDE_KEY, "1");
    } catch {
      /* hidden for this view only */
    }
  };

  const install = async () => {
    setBusy(true);
    try {
      const message = await backend.deviceAccessInstall();
      notify?.({ title: "Device access is set up", detail: message, tone: "ok" }, "device-access");
      setStatus(await backend.deviceAccess());
    } catch (e) {
      notify?.({ title: "The device rule wasn't installed", detail: String(e), tone: "error" }, "device-access");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(status.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      notify?.({ title: "Couldn't copy", detail: "Select the command and copy it by hand.", tone: "error" }, "device-access");
    }
  };

  const outdated = status.installed && !status.upToDate;
  return (
    <div data-testid="device-access">
    <Card innerClassName="flex flex-col gap-3 px-6 py-5">
      <div className="flex items-start gap-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/[0.12] text-primary ring-1 ring-primary/25">
          <ShieldCheck size={17} weight="light" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] text-foreground">{outdated ? "Update SYNQ's device rule" : "Let SYNQ reach your mouse and keyboard"}</p>
          <p className="mt-1 max-w-[760px] text-[12.5px] leading-relaxed text-muted-foreground">
            Linux lets an app open a mouse or keyboard only when a device rule allows it. SYNQ's rule covers the devices it supports and nothing
            else, for whoever is logged in at this computer{status.appimage ? "; an AppImage can't put it in place by itself" : ""}.
            {outdated ? ` The one at ${status.installed} is from another version of SYNQ.` : ""}
          </p>
          {status.blocked.length > 0 && <p className="mt-1 text-[12.5px] text-chart-3">Waiting for it: {status.blocked.join(", ")}.</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-[52px]">
        {status.canInstall && (
          <button
            onClick={() => void install()}
            disabled={busy}
            className="rounded-full bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.97] disabled:opacity-50"
          >
            {busy ? "Working…" : outdated ? "Update the rule" : "Install the rule"}
          </button>
        )}
        <button onClick={later} className="rounded-full px-3 py-1.5 text-[12.5px] text-muted-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06] hover:text-foreground">
          Not now
        </button>
        <span className="text-[11.5px] text-muted-foreground/80">
          {status.canInstall ? "Your system asks for your password once (pkexec); SYNQ never sees it." : "Paste the command below in a terminal."}
        </span>
      </div>
      <div className="ml-[52px] flex items-start gap-2 rounded-xl bg-black/25 px-3 py-2 ring-1 ring-white/[0.06]">
        <code className="min-w-0 flex-1 select-all break-all font-mono text-[11.5px] leading-relaxed text-muted-foreground">{status.command}</code>
        <button onClick={() => void copy()} aria-label="Copy the command" className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground">
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
    </Card>
    </div>
  );
}
