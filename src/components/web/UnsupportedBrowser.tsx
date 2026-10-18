// The page for a browser without WebHID (Firefox, Safari, Brave with it switched off, an insecure page).
// On Windows and Linux it leads with SYNQ Helper, which does the device work for any browser; elsewhere
// it points at a browser that has WebHID. Shown before the app loads, so it imports none of the app's
// device code (the helper link is a WebSocket and nothing else). The controller tester runs on the Gamepad API alone,
// so it works here too; it is its own chunk, loaded only when opened.
import { Suspense, lazy, useState, useSyncExternalStore } from "react";
import { Desktop, GameController, Globe, Plugs } from "@phosphor-icons/react";
import { AppTile } from "@/components/ui/brand";
import { Card, Eyebrow } from "@/components/ui/matte";
import { DesktopLink } from "./DesktopCard";
import { BROWSER_LINKS } from "@/lib/web/links";
import { helperOffered, OS_NAMES, parsePlatform } from "@/lib/web/platform";
import { connectHelper, helperError, helperState, onHelperChange } from "@/lib/web/helper";

const GamepadTester = lazy(() => import("@/components/controller/GamepadTester").then((m) => ({ default: m.GamepadTester })));

const NAMES: Record<string, string> = { firefox: "Firefox", safari: "Safari", other: "This browser", chrome: "This version of Chrome", edge: "This version of Edge", opera: "This version of Opera", chromium: "This browser" };

/** Brave sends Chrome's user agent; it can be told apart by `navigator.brave`. */
const isBrave = () => typeof (navigator as Navigator & { brave?: unknown }).brave === "object";

export function UnsupportedBrowser({ secureContext = true }: { secureContext?: boolean }) {
  const [tester, setTester] = useState(false);
  const p = parsePlatform(navigator.userAgent);
  const brave = isBrave();
  const name = brave ? "Brave" : (NAMES[p.browser] ?? "This browser");
  // From a page that isn't https the helper refuses the connection (it only answers the site's own origin).
  const helper = secureContext && helperOffered(p);
  const desktopApp = p.os === "windows" || p.os === "linux";
  const link = "rounded-full px-3.5 py-1.5 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06]";
  const icon = "grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-muted-foreground ring-1 ring-white/[0.07]";

  const title = !secureContext ? "This page has to be opened over https" : helper ? `${name} works with SYNQ Helper` : "SYNQ needs Chrome or Edge here";
  const lead = !secureContext
    ? "Browsers only offer device access on pages served over https (or from localhost). Open SYNQ from its https address."
    : helper
      ? `In ${name}, SYNQ Helper reaches your mouse and keyboard for this page: a small tray app (on its own, or part of the desktop app), with the desktop app's own safety checks. Nothing leaves this PC.`
      : p.os === "mac"
        ? `Reaching a mouse or keyboard from a web page needs WebHID, which Chrome, Edge and Opera have. SYNQ Helper for macOS isn't out yet.`
        : `Reaching a mouse or keyboard from a web page needs WebHID, which Chrome, Edge and Opera have (version 89 and newer, on Windows, macOS, Linux and ChromeOS). Phones and tablets don't have it yet.`;

  if (tester)
    return (
      <Suspense fallback={null}>
        <GamepadTester onBack={() => setTester(false)} />
      </Suspense>
    );

  return (
    <div className="mx-auto flex min-h-full max-w-[640px] flex-col justify-center gap-6 px-6 py-12" data-slot="unsupported-browser">
      <div className="flex items-center gap-3">
        <AppTile size={40} />
        <span className="text-[17px] font-semibold tracking-tight text-foreground">
          SYNQ <span className="font-medium text-muted-foreground">Hub</span>
        </span>
      </div>
      <div>
        <Eyebrow>{!secureContext ? "Needs a secure page" : helper ? `No WebHID in ${name === "This browser" ? "this browser" : name}` : "Browser not supported"}</Eyebrow>
        <h1 className="mt-4 text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] text-foreground">{title}</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">{lead}</p>
      </div>
      <Card innerClassName="flex flex-col gap-4 p-5">
        {helper && <HelperSteps os={OS_NAMES[p.os]} icon={icon} />}
        <div className={helper ? "flex items-start gap-3 border-t border-white/[0.05] pt-4" : "flex items-start gap-3"}>
          <span className={icon}>
            <Globe size={18} weight="light" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-foreground">{helper ? "Or open this page in" : "Open this page in"}</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <a className={link} href={BROWSER_LINKS.chrome} target="_blank" rel="noopener noreferrer">
                Chrome
              </a>
              <a className={link} href={BROWSER_LINKS.edge} target="_blank" rel="noopener noreferrer">
                Edge
              </a>
              <a className={link} href={BROWSER_LINKS.opera} target="_blank" rel="noopener noreferrer">
                Opera
              </a>
            </div>
            {brave && (
              <p className="mt-2.5 text-[12px] leading-relaxed text-muted-foreground/90" data-slot="brave-note">
                Brave is missing WebHID on this page: a Brave setting, a policy or an extension can switch it off.{helper ? " SYNQ Helper works either way." : ""}
              </p>
            )}
          </div>
        </div>
        {/* The controller tester needs no WebHID and no helper: the Gamepad API is in every browser. */}
        {typeof navigator.getGamepads === "function" && (
          <div className="flex items-start gap-3 border-t border-white/[0.05] pt-4" data-slot="controller-tester">
            <span className={icon}>
              <GameController size={18} weight="light" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-foreground">Testing a controller?</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">The controller tester works in this browser: sticks, triggers, buttons and a polling estimate. Nothing is sent to the controller.</p>
              <button type="button" onClick={() => setTester(true)} className={`${link} mt-2.5`}>
                Open the controller tester
              </button>
            </div>
          </div>
        )}
        {/* The helper steps already link the app; there is no app for macOS, ChromeOS or phones yet. */}
        {!helper && desktopApp && (
          <div className="flex items-start gap-3 border-t border-white/[0.05] pt-4">
            <span className={icon}>
              <Desktop size={18} weight="light" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-foreground">Or use the desktop app</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">It works without a browser, and it also has the Sound EQ.</p>
              <DesktopLink className="mt-2.5" />
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Get the app, turn the helper on, press Connect. A good connect reloads the page onto the helper. */
function HelperSteps({ os, icon }: { os: string; icon: string }) {
  const state = useSyncExternalStore(onHelperChange, helperState);
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    const ok = await connectHelper(true);
    setBusy(false);
    // The page loads its devices through whichever transport it started with: start over on the helper.
    if (ok) location.reload();
  };
  const error = state === "failed" ? helperError() : "";
  return (
    <div className="flex items-start gap-3" data-slot="helper-steps">
      <span className={icon}>
        <Plugs size={18} weight="light" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-foreground">Connect SYNQ Helper</p>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-[12.5px] leading-relaxed text-muted-foreground marker:text-muted-foreground/80">
          <li>Get the desktop app for {os} (the helper comes with it).</li>
          <li>In the app, turn on Settings, SYNQ Helper.</li>
          <li>Press Connect. Your browser may ask to let this page reach apps on this device, and the helper asks once whether to allow this site.</li>
        </ol>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void connect()}
            data-slot="helper-connect"
            className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-[12.5px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.97] disabled:opacity-60"
          >
            <Plugs size={14} />
            {busy ? "Waiting for the helper" : "Connect"}
          </button>
          <DesktopLink className="bg-transparent text-foreground ring-1 ring-white/10 hover:bg-white/[0.06]" children="Get the desktop app" />
        </div>
        {error && <p className="pt-2 text-[12.5px] text-chart-3">{error}</p>}
      </div>
    </div>
  );
}
