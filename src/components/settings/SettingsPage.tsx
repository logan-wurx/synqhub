// Settings: SYNQ Helper, and what SYNQ is (version, how it behaves) with the licenses of what it is built on.
// Nothing here talks to a device.
import { lazy, Suspense, useEffect, useState } from "react";
import pkg from "../../../package.json";
import { inTauri, isWeb } from "@/lib/backend";
import { isLinux } from "@/lib/runtime";
import { DiscordPanel, HelperConnect, WebData } from "@/components/web/lazy";
import type { Notice } from "@/components/ui/matte";
import { Eyebrow } from "@/components/ui/matte";
import { CaretDown, EyeSlash, GithubLogo, HandWaving, ShieldCheck, type Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { peekKept, setKept } from "@/lib/keep";
import { openWelcome } from "@/lib/welcome";
import { LicenseDialog } from "@/components/eq/EqEngine";
import { openLink, SOURCE_URL } from "@/lib/open-link";

// SYNQ Helper's switches are the desktop app's; the website has its own card (HelperConnect).
const WEB = typeof __ONBOARD_WEB__ !== "undefined" && __ONBOARD_WEB__ === true;
const HelperCard = WEB ? null : lazy(() => import("./HelperCard").then((m) => ({ default: m.HelperCard })));

const LICENSES: { name: string; license: string; note: string }[] = [
  { name: "OpenMouse protocol and keyboard drivers", license: "AGPL-3.0-or-later", note: "@openmouse/protocol, @openmouse/keyboard-protocol" },
  { name: "AnalogSense", license: "MIT", note: "Live key depth (Calamity, Inc.)" },
  { name: "Equalizer APO", license: "GPL-2.0", note: "The EQ engine, by Jonas Thedering" },
  { name: "HeadsetControl", license: "GPL-3.0", note: "Headset protocols, by Sapd and contributors" },
  { name: "AutoEq", license: "MIT", note: "Headphone presets by Jaakko Pasanen, fetched when you pick one; measurements by the source named on each" },
  { name: "ha-govee-led-ble", license: "MIT", note: "Govee lamp protocol notes (Fredde87, teh-hippo and contributors)" },
  { name: "govee_ble_lights", license: "MIT", note: "Govee scene catalogues (Beshelmek)" },
  { name: "OpenRGB", license: "GPL-2.0", note: "USB RGB hub protocol notes (NZXT, Corsair, Lian Li), by Adam Honse and contributors" },
  { name: "Tauri", license: "Apache-2.0 / MIT", note: "The app shell" },
  { name: "React", license: "MIT", note: "" },
  { name: "Base UI", license: "MIT", note: "Number fields and tabs" },
  { name: "Motion", license: "MIT", note: "Animation" },
  { name: "NumberFlow", license: "MIT", note: "Animated numbers" },
  { name: "Phosphor Icons", license: "MIT", note: "" },
  { name: "Lucide", license: "ISC", note: "" },
  { name: "Nimbus Sans", license: "AGPL-3.0", note: "The typeface, Helvetica's design, by URW++ (bundled, src/assets/fonts)" },
  { name: "Geist and DM Mono", license: "OFL-1.1", note: "The fallback and the monospaced typefaces (bundled)" },
  { name: "Uiverse elements", license: "MIT", note: "Switches and radios (credits in the source)" },
  { name: "Paper Shaders", license: "Apache-2.0", note: "The live light (grain and dither looks), adapted through the 21st.dev Shader Builder" },
];

/** Equalizer APO is the Windows EQ engine and ships with the Windows installer only; Linux uses the system's PipeWire. */
const SHOWN_LICENSES = isLinux ? LICENSES.filter((l) => l.name !== "Equalizer APO") : LICENSES;

export function SettingsPage({ notify }: { notify?: (n: Omit<Notice, "id">, key?: string) => void }) {
  const [license, setLicense] = useState(false);
  const [credits, setCredits] = useState(false);
  // Coming from the dock's Helper: bring the Helper card into view.
  useEffect(() => {
    if (peekKept<string | null>("settings.focus", null) !== "helper") return;
    setKept<string | null>("settings.focus", null);
    const t = window.setTimeout(() => document.getElementById("helper-card")?.scrollIntoView({ block: "start", behavior: "smooth" }), 120);
    return () => window.clearTimeout(t);
  }, []);

  const helperCard = isWeb ? (
    <HelperConnect />
  ) : (
    HelperCard && (
      <div id="helper-card" className="h-full scroll-mt-4">
        <Suspense fallback={null}>
          <HelperCard notify={notify} />
        </Suspense>
      </div>
    )
  );
  return (
    <div className="h-full overflow-y-auto">
    <div className="mx-auto flex min-h-full w-full max-w-[1500px] flex-col gap-5 px-8 pb-[120px] pt-6 [&>*]:shrink-0">
      <header>
        <Eyebrow>SYNQ</Eyebrow>
        <h1 className="headline mt-2 text-[clamp(52px,5vw,84px)] text-high">Settings</h1>
        <p className="mt-2 text-[13.5px] text-medium">SYNQ Helper, backups and credits. Device settings live on each device.</p>
      </header>

      {/* A bento: the Helper big (the one thing here people change), what SYNQ is beside it, the two promises under them,
          the credits last. Short lines in each tile; nothing stretched across the window. */}
      <div className="grid grow gap-5 min-[1100px]:grid-cols-12 min-[1100px]:grid-rows-[1fr_auto_auto]">
        <div className="min-w-0 min-[1100px]:col-span-8">{helperCard}</div>

        <div className="flex min-w-0 flex-col gap-5 min-[1100px]:col-span-4">
          <section aria-label="About SYNQ" className="panel flex flex-1 flex-col rounded-card px-7 py-6">
            <span className="label-caps">Version</span>
            <p className="display-num tabular mt-2 text-[44px] text-high">{pkg.version}</p>
            <p className="mt-1 text-[14px] text-medium">{inTauri ? "Desktop app" : isWeb ? "Website (WebHID)" : "Browser preview"}</p>
            <dl className="mt-auto grid grid-cols-2 gap-x-5 gap-y-3 border-t border-white/[0.09] pt-4 text-[13px]">
              <Fact label="License" value="AGPL 3.0+" />
              <Fact label="Settings are kept" value={isWeb ? "On the device, backups here" : "On the device"} />
            </dl>
            <button onClick={() => openLink(SOURCE_URL)} className="mt-4 flex h-11 items-center justify-center gap-2 rounded-control bg-white/[0.06] text-[14px] font-medium text-high ring-1 ring-white/[0.1] transition-colors duration-300 ease-fluid hover:bg-white/[0.1]">
              <GithubLogo size={16} weight="light" /> Source code
            </button>
          </section>
          {!isWeb && (
            <section aria-label="Welcome tour" className="panel flex items-center gap-4 rounded-card px-6 py-5">
              <span className="grid size-11 shrink-0 place-items-center rounded-control bg-white/[0.06] text-high ring-1 ring-white/[0.1]">
                <HandWaving size={20} weight="light" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-semibold text-high">Welcome tour</p>
                <p className="text-[12.5px] text-medium">A hello and SYNQ Helper.</p>
              </div>
              <button onClick={openWelcome} className="shrink-0 rounded-control bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.97]">
                Run it again
              </button>
            </section>
          )}
          {isWeb && <DiscordPanel />}
        </div>

        <Pledge
          className="min-[1100px]:col-span-6"
          icon={ShieldCheck}
          title="Careful with your gear"
          points={["A backup before the first change to a device.", "Every change read back from the device.", "Never firmware, never update mode."]}
        />
        <Pledge
          className="min-[1100px]:col-span-6"
          icon={EyeSlash}
          title={isWeb ? "Nothing that identifies you is sent" : "Nothing about you is sent"}
          points={
            isWeb
              ? [
                  "Your devices and settings stay in this browser. Online only for a VIA keyboard's layout (usevia.app, the first time one is connected).",
                  "Anonymous visit counts (Cloudflare Web Analytics): no cookies, nothing that identifies you.",
                ]
              : [
                  "Nothing runs in the background unless SYNQ Helper is on.",
                  "Online only when you use it: a VIA layout (usevia.app), the headphone list (GitHub), Steam cover art.",
                ]
          }
        />

        <section aria-label="Licenses" className="panel rounded-card px-7 py-5 min-[1100px]:col-span-12">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-[18px] font-semibold tracking-[-0.02em] text-high">Built on free software</h3>
              <p className="mt-0.5 text-[13px] text-medium">SYNQ is free software too: use, study, share and change it under the GNU AGPL, version 3 or later.</p>
            </div>
            <div className="flex items-center gap-2">
              {!isLinux && (
                <button onClick={() => setLicense(true)} className="rounded-small px-3 py-1.5 text-[12.5px] text-high ring-1 ring-white/10 transition-colors hover:bg-white/[0.06]">
                  Equalizer APO's licence (GPL 2.0)
                </button>
              )}
              {/* The list folds away so the page fits; it opens in place. */}
              <button
                onClick={() => setCredits((o) => !o)}
                aria-expanded={credits}
                className="flex items-center gap-1.5 rounded-small bg-white/[0.06] px-3.5 py-1.5 text-[12.5px] font-medium text-high ring-1 ring-white/[0.1] transition-colors hover:bg-white/[0.1]"
              >
                {credits ? "Hide" : `Show all ${SHOWN_LICENSES.length}`}
                <CaretDown size={12} className={cn("transition-transform duration-300 ease-fluid", credits && "rotate-180")} />
              </button>
            </div>
          </div>
          {credits && (
          <>
          <ul className="mt-4 grid gap-x-8 min-[700px]:grid-cols-2 min-[1300px]:grid-cols-3">
            {SHOWN_LICENSES.map((l) => (
              <li key={l.name} className="flex min-w-0 items-baseline gap-3 border-t border-white/[0.06] py-2.5 text-[13px]" title={l.note || undefined}>
                <span className="min-w-0 flex-1 truncate text-high">{l.name}</span>
                <span className="tabular shrink-0 text-[11.5px] text-medium">{l.license}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] leading-relaxed text-medium">
            Product images and game covers © their respective owners, shown to identify each device and game; they aren't covered by SYNQ's license. Want one removed? Open an issue.
          </p>
          </>
          )}
        </section>
      </div>
      {isWeb && <WebData />}
      {license && <LicenseDialog onClose={() => setLicense(false)} />}
    </div>
    </div>
  );
}

/** One of SYNQ's promises: an icon, a short title, three short lines at most. */
function Pledge({ icon: IconCmp, title, points, className }: { icon: Icon; title: string; points: string[]; className?: string }) {
  return (
    <section aria-label={title} className={cn("panel flex gap-5 rounded-card px-7 py-6", className)}>
      <span className="grid size-11 shrink-0 place-items-center rounded-control bg-primary/[0.12] text-primary ring-1 ring-primary/25">
        <IconCmp size={21} weight="light" />
      </span>
      <div className="min-w-0">
        <h3 className="text-[18px] font-semibold tracking-[-0.02em] text-high">{title}</h3>
        <ul className="mt-2 flex flex-col gap-1.5">
          {points.map((p) => (
            <li key={p} className="text-[13.5px] leading-relaxed text-medium">
              {p}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col-reverse justify-end">
      <dt className="mt-0.5 truncate text-[12px] text-medium">{label}</dt>
      <dd className="truncate text-[15px] font-semibold text-high">{value}</dd>
    </div>
  );
}