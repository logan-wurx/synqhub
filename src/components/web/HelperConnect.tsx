// Settings on the website: SYNQ Helper, the small tray app that lets this page reach what a browser can't. Get it
// (one file for Windows that installs itself, src-tauri/helper/src/standalone.rs) and the page finds it on its own
// while it installs; or Connect one that's already running (the desktop app's). Once connected, the page reloads
// onto it, as OpenMouse's site does with its Bridge.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DownloadSimple, Plugs } from "@phosphor-icons/react";
import { Card, CardHeader, DetailRows } from "@/components/ui/matte";
import { connectHelper, expectHelper, expectingHelper, forgetHelper, helperError, helperState, onHelperChange, waitForHelper, wantsHelper, HELPER_PORT } from "@/lib/web/helper";
import { DESKTOP_APP_URL, HELPER_DOWNLOAD_URL } from "@/lib/web/links";
import { currentPlatform } from "@/lib/web/platform";

export function HelperConnect() {
  const state = useSyncExternalStore(onHelperChange, helperState);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const stop = useRef<AbortController | null>(null);
  const error = helperError();
  const os = currentPlatform().os;

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
    const ok = await waitForHelper(ctl.signal);
    setWaiting(false);
    // Devices are listed by whichever transport the page loaded with: start over on the helper.
    if (ok) location.reload();
  }

  const connect = async () => {
    setBusy(true);
    const ok = await connectHelper(true);
    setBusy(false);
    if (ok) location.reload();
  };
  const disconnect = () => {
    forgetHelper();
    location.reload();
  };

  const status = state === "ready" ? "Connected" : waiting ? "Waiting for it to start" : state === "connecting" ? "Connecting" : wantsHelper() && state === "failed" ? "Not running" : "Not connected";

  return (
    <Card>
      <CardHeader
        title="SYNQ Helper"
        hint="Lets this page reach what a browser can't: monitors, webcams, Wi-Fi lights, Razer on Windows, the EQ and the Advanced actions."
        right={
          state === "ready" ? (
            <button type="button" onClick={disconnect} className="rounded-full px-3 py-1.5 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06]">
              Disconnect
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || waiting}
                onClick={() => void connect()}
                className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06] disabled:opacity-60"
              >
                <Plugs size={14} />
                {busy ? "Waiting for the helper" : "Connect"}
              </button>
              {os === "windows" ? (
                <a
                  href={HELPER_DOWNLOAD_URL}
                  onClick={() => {
                    expectHelper();
                    void look();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.97]"
                >
                  <DownloadSimple size={14} weight="bold" />
                  Get SYNQ Helper
                </a>
              ) : (
                os === "linux" && (
                  <a href={DESKTOP_APP_URL} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background">
                    <DownloadSimple size={14} weight="bold" />
                    Get SYNQ
                  </a>
                )
              )}
            </div>
          )
        }
      />
      <div className="px-5 pb-4 pt-2">
        <DetailRows
          rows={[
            ["Status", status],
            ["Where", `This PC only (127.0.0.1:${HELPER_PORT})`],
            ["Checks", "The desktop app's own, in Rust"],
          ]}
        />
        {state !== "ready" && (
          <p className="pt-3 text-[12.5px] leading-relaxed text-muted-foreground">
            {os === "windows"
              ? "One small file. Run it and it installs itself (no administrator), starts with Windows and waits in the tray; this page finds it on its own. Windows may say the file is from an unknown publisher (it isn't signed yet): choose More info, then Run anyway. With the SYNQ desktop app installed, it turns that app's helper on instead."
              : os === "linux"
                ? "On Linux SYNQ Helper comes with the SYNQ app (.deb or AppImage): install it, turn the helper on in its Settings, then press Connect."
                : "SYNQ Helper runs on Windows and Linux."}{" "}
            Your browser may ask to let this page reach devices on your network (that's the helper on this PC), and the helper asks once whether to allow this site. Firmware is never touched.
          </p>
        )}
        {waiting && <p className="pt-2 text-[12.5px] text-foreground">Looking for SYNQ Helper… run the file you downloaded.</p>}
        {state === "failed" && !waiting && error && <p className="pt-2 text-[12.5px] text-chart-3">{error}</p>}
      </div>
    </Card>
  );
}

/** The dock's Helper pill on the website: lit once connected; otherwise it says how to get one, and leads to Settings. */
export function WebHelperChip({ onOpen }: { onOpen: () => void }) {
  const state = useSyncExternalStore(onHelperChange, helperState);
  const on = state === "ready";
  return (
    <button
      type="button"
      onClick={onOpen}
      title={on ? "SYNQ Helper is connected: this page reaches monitors, webcams, Wi-Fi lights, Razer and the EQ through it." : "Get SYNQ Helper: the page reaches what a browser can't through it."}
      className="flex h-11 items-center gap-2 rounded-full px-4 text-[14px] font-medium text-foreground/75 transition-colors duration-500 ease-fluid hover:text-foreground max-sm:hidden"
    >
      <span className={on ? "size-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" : "size-1.5 shrink-0 rounded-full bg-white/25"} aria-hidden="true" />
      {on ? "Helper" : "Get Helper"}
    </button>
  );
}
