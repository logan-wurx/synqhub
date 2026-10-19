// SYNQ Helper on the website: the small tray app that lets this page reach what a browser can't. Get it (one file for
// Windows that installs itself, src-tauri/helper/src/standalone.rs) and the page finds it on its own while it
// installs; or Connect one that's already running (the desktop app's). Once connected, the page reloads onto it.
// `useHelperOffer` is the flow; `HelperConnect` is its card in Settings and
// `HelperSteps` the same offer on the Gear page's first visit (./WebStart.tsx).
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BatteryWarning, CheckCircle, DownloadSimple, GameController, Lightning, Monitor, Mouse, Plugs, Waveform, WifiHigh } from "@phosphor-icons/react";
import { Job, LevelEditor } from "@/components/settings/HelperCard";
import { helper, type HelperPrefs } from "@/lib/helper";
import { cn } from "@/lib/utils";
import { connectHelper, expectHelper, expectingHelper, forgetHelper, helperError, helperState, localAccess, onHelperChange, waitForHelper, wantsHelper, HELPER_PORT, type LocalAccess } from "@/lib/web/helper";
import { DESKTOP_APP_URL, HELPER_DOWNLOAD_URL } from "@/lib/web/links";
import { currentPlatform } from "@/lib/web/platform";

/** What the helper adds to this page, in the order people ask for it. */
export const HELPER_UNLOCKS: readonly { icon: typeof Waveform; text: string }[] = [
  { icon: Waveform, text: "The EQ for your headphones" },
  { icon: Mouse, text: "Razer on Windows" },
  { icon: Monitor, text: "Monitors and webcams" },
  { icon: WifiHigh, text: "Wi-Fi lights" },
  { icon: GameController, text: "Game profiles and battery alerts" },
];

export function useHelperOffer() {
  const state = useSyncExternalStore(onHelperChange, helperState);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  /** It looked for the helper for the whole wait and never found it. */
  const [missed, setMissed] = useState(false);
  const [access, setAccess] = useState<LocalAccess>("unknown");
  const stop = useRef<AbortController | null>(null);
  const os = currentPlatform().os;

  // Chrome's "reach apps on this PC" permission, read while the page looks for the helper: it says which step is next.
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    const read = () => void localAccess().then((a) => live && setAccess(a));
    read();
    const t = setInterval(read, 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [waiting]);

  // Downloaded earlier and still not connected (the page was reloaded while it installed): keep looking.
  useEffect(() => {
    if (state !== "ready" && expectingHelper()) void look();
    return () => stop.current?.abort();
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function look() {
    stop.current?.abort();
    const ctl = new AbortController();
    stop.current = ctl;
    setWaiting(true);
    setMissed(false);
    const ok = await waitForHelper(ctl.signal);
    setWaiting(false);
    if (!ok && !ctl.signal.aborted) setMissed(true);
    // Devices are listed by whichever transport the page loaded with: start over on the helper.
    if (ok) location.reload();
  }

  return {
    state,
    os,
    busy,
    waiting,
    missed,
    access,
    error: helperError(),
    ready: state === "ready",
    status: state === "ready" ? "Connected" : waiting ? "Waiting for it to start" : state === "connecting" ? "Connecting" : wantsHelper() && state === "failed" ? "Not running" : "Not connected",
    /** The download link was clicked: watch for the helper while it installs. */
    got: () => {
      expectHelper();
      void look();
    },
    /** "Already have it": connects, or, when it isn't running yet, waits for it rather than failing. */
    connect: async () => {
      setBusy(true);
      const ok = await connectHelper(true);
      setBusy(false);
      if (ok) location.reload();
      else if (/isn't running/.test(helperError())) void look();
    },
    disconnect: () => {
      forgetHelper();
      location.reload();
    },
  };
}

type Offer = ReturnType<typeof useHelperOffer>;

/** The way to get it: one file on Windows, the app on Linux, nothing elsewhere. */
function GetButton({ offer, className }: { offer: Offer; className?: string }) {
  const cls = cn("inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-control bg-foreground px-4 text-[13.5px] font-semibold text-background transition-transform duration-300 ease-fluid active:scale-[0.97]", className);
  if (offer.os === "windows")
    return (
      <a href={HELPER_DOWNLOAD_URL} onClick={offer.got} className={cls}>
        <DownloadSimple size={14} weight="bold" />
        Get SYNQ Helper
      </a>
    );
  if (offer.os === "linux")
    return (
      <a href={DESKTOP_APP_URL} target="_blank" rel="noopener" className={cls}>
        <DownloadSimple size={14} weight="bold" />
        Get SYNQ
      </a>
    );
  return null;
}

function ConnectButton({ offer }: { offer: Offer }) {
  return (
    <button
      type="button"
      disabled={offer.busy || offer.waiting}
      onClick={() => void offer.connect()}
      className="inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-control px-4 text-[13.5px] text-high ring-1 ring-white/[0.14] transition-colors hover:bg-white/[0.06] disabled:opacity-60"
    >
      <Plugs size={14} />
      {offer.busy ? "Looking…" : "Already have it? Connect"}
    </button>
  );
}

/** The three steps, each lit as it's done: get it, run it, allow this site. */
function Steps({ offer }: { offer: Offer }) {
  const steps: { title: string; text: ReactNode }[] =
    offer.os === "linux"
      ? [
          { title: "Get SYNQ", text: "The .deb or AppImage. SYNQ Helper comes with it." },
          { title: "Turn the helper on", text: "In SYNQ's Settings." },
          { title: "Connect", text: "Then allow this site once." },
        ]
      : [
          { title: "Download", text: "One file for Windows." },
          { title: "Allow", text: "Chrome asks once to let this page reach apps on this PC." },
          { title: "Open it", text: "From your downloads. If Windows warns: More info, Run anyway." },
        ];
  // Each step is lit when it is done, whatever the order the person did them in; Chrome's question comes first when
  // it is asking (it asks as soon as the page looks for the helper).
  const asking = offer.waiting && (offer.access === "prompt" || offer.access === "denied");
  const done =
    offer.os === "linux"
      ? [offer.ready, offer.ready, offer.ready]
      : [offer.waiting || offer.ready, offer.ready || offer.access === "granted", offer.ready];
  const now = offer.ready ? -1 : asking && offer.os !== "linux" ? 1 : done.findIndex((d) => !d);
  return (
    <ol className="grid gap-3 min-[900px]:grid-cols-3">
      {steps.map((s, i) => {
        const lit = done[i];
        return (
          <li key={s.title} className={cn("flex gap-3 rounded-control p-3.5 ring-1 transition-colors duration-500 ease-fluid", lit ? "bg-primary/[0.08] ring-primary/30" : i === now ? "bg-white/[0.04] ring-white/[0.14]" : "bg-shade/20 ring-white/[0.06]")}>
            <span className={cn("grid size-7 shrink-0 place-items-center rounded-full text-[12.5px] font-bold", lit ? "bg-primary text-primary-foreground" : "bg-white/[0.08] text-high")}>{lit ? <CheckCircle size={14} weight="fill" /> : i + 1}</span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold text-high">{s.title}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-medium">{s.text}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** What to do now while the page looks for the helper: Chrome's question first when it is asking. */
function waitingText(access: LocalAccess): string {
  if (access === "prompt") return "Click Allow when Chrome asks (by the address bar), then open synq-helper.exe from your downloads.";
  if (access === "denied") return "Chrome is blocking this page from reaching apps on this PC: click the icon left of the address bar and allow it.";
  return "Waiting for SYNQ Helper: open synq-helper.exe from your downloads. This page connects by itself.";
}

/** The offer as the Gear page shows it on a first visit: what it unlocks, the steps, the buttons. */
export function HelperSteps({ offer }: { offer: Offer }) {
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-wrap gap-2">
        {HELPER_UNLOCKS.map(({ icon: I, text }) => (
          <li key={text} className="inline-flex items-center gap-2 rounded-full bg-white/[0.04] py-1.5 pl-2.5 pr-3.5 text-[12.5px] text-high ring-1 ring-white/[0.08]">
            <I size={14} className="text-primary" />
            {text}
          </li>
        ))}
      </ul>
      {offer.os === "windows" || offer.os === "linux" ? <Steps offer={offer} /> : <p className="text-[13px] text-medium">SYNQ Helper runs on Windows and Linux.</p>}
      {!offer.ready && (
        <div className="flex flex-wrap items-center gap-3">
          <GetButton offer={offer} />
          {!offer.waiting && <ConnectButton offer={offer} />}
          {offer.waiting && (
            <span className="flex items-center gap-2 text-[12.5px] text-high" role="status">
              <span className="relative flex size-2 shrink-0">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/70" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              {waitingText(offer.access)}
            </span>
          )}
          {offer.missed && !offer.waiting && <span className="text-[12.5px] text-chart-3">Didn't find SYNQ Helper yet. Open synq-helper.exe from your downloads, then press Connect.</span>}
          {offer.state === "failed" && !offer.waiting && !offer.missed && offer.error && !/isn't running/.test(offer.error) && <span className="text-[12.5px] text-chart-3">{offer.error}</span>}
        </div>
      )}
    </div>
  );
}

/** With the helper connected: its two background jobs, as the desktop app's Settings has them. Turning game profiles
 * on, like every profile save, is confirmed in SYNQ Helper's own box on this PC. */
function HelperJobs() {
  const [prefs, setPrefs] = useState<HelperPrefs | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    helper.prefs().then(setPrefs, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const change = async (c: Partial<HelperPrefs>) => {
    setError("");
    try {
      setPrefs(await helper.prefsSet(c));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  if (!prefs) return error ? <p className="mt-4 text-[12.5px] text-chart-3">{error}</p> : null;
  return (
    <div className="mt-5 grid gap-3 min-[900px]:grid-cols-2">
      <Job icon={GameController} title="Game profiles" text={prefs.gameProfiles ? "Follows the games on the Games page, by program name only. Each save asks you on this PC first." : "Off"} on={prefs.gameProfiles} onChange={(v) => void change({ gameProfiles: v })} />
      <Job icon={BatteryWarning} title="Battery alerts" text={prefs.batteryAlerts ? "A notification at each level, once per charge." : "Off"} on={prefs.batteryAlerts} onChange={(v) => void change({ batteryAlerts: v })}>
        {prefs.batteryAlerts && <LevelEditor levels={prefs.batteryLevels} onChange={(l) => void change({ batteryLevels: l })} />}
      </Job>
      {error && <p className="text-[12.5px] text-chart-3 min-[900px]:col-span-2">{error}</p>}
    </div>
  );
}

/** Settings on the website: the helper as a card like the desktop app's (src/components/settings/HelperCard.tsx). */
export function HelperConnect() {
  const offer = useHelperOffer();
  return (
    <section aria-label="SYNQ Helper" className="tile relative flex h-full flex-col overflow-hidden rounded-card px-7 pb-6 pt-7 max-sm:px-5">
      <div className="flex items-start gap-5">
        <span className={cn("grid size-14 shrink-0 place-items-center rounded-control transition-colors duration-500 ease-fluid", offer.ready ? "bg-primary text-primary-foreground" : "bg-white/[0.06] text-medium ring-1 ring-white/[0.1]")}>
          <Lightning size={24} weight={offer.ready ? "fill" : "light"} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[28px] font-bold leading-tight tracking-[-0.035em] text-high">SYNQ Helper</h2>
          <p className="mt-1 flex items-center gap-2 text-[14px] text-high">
            <span className={cn("size-2 shrink-0 rounded-full", offer.ready ? "bg-live" : "bg-asleep")} aria-hidden="true" />
            {offer.status}
          </p>
        </div>
        {offer.ready && (
          <button type="button" onClick={offer.disconnect} className="mt-2 rounded-small px-3.5 py-1.5 text-[12.5px] text-high ring-1 ring-white/10 transition-colors hover:bg-white/[0.06]">
            Disconnect
          </button>
        )}
      </div>
      <p className="mt-4 max-w-[62ch] text-[14px] leading-relaxed text-medium">
        {offer.ready
          ? "Every device on this PC is listed through it. It checks every command the way the desktop app does, and never touches firmware."
          : "A light tray app for this PC that lets this page reach what a browser can't. It checks every command the way the desktop app does, and never touches firmware."}
      </p>
      <div className="mt-5">
        <HelperSteps offer={offer} />
      </div>
      {offer.ready && <HelperJobs />}
      <div className="min-h-4 flex-1" aria-hidden="true" />
      <p className="border-t border-white/[0.09] pt-3.5 text-[12px] text-faint">This PC only (127.0.0.1:{HELPER_PORT}). Your browser may ask to let this page reach local devices: that's the helper.</p>
    </section>
  );
}
