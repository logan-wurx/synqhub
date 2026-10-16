// Settings: the accent colour, and what SYNQ is (version, how it behaves) with the licenses of
// what it is built on. Nothing here talks to a device.
import { lazy, Suspense, useEffect, useState } from "react";
import { Check } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import pkg from "../../../package.json";
import { inTauri, isWeb } from "@/lib/backend";
import { isLinux } from "@/lib/runtime";
import { HelperConnect, WebData } from "@/components/web/lazy";
import type { Notice } from "@/components/ui/matte";
import { ACCENTS, Card, CardHeader, DetailRows, Eyebrow } from "@/components/ui/matte";
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
  { name: "Bricolage Grotesque and DM Mono", license: "OFL-1.1", note: "The typefaces (bundled, src/assets/fonts)" },
  { name: "Uiverse elements", license: "MIT", note: "Switches and radios (credits in the source)" },
];

/** Equalizer APO is the Windows EQ engine and ships with the Windows installer only; Linux uses the system's PipeWire. */
const SHOWN_LICENSES = isLinux ? LICENSES.filter((l) => l.name !== "Equalizer APO") : LICENSES;

export function SettingsPage({ accent, onAccent, notify }: { accent: string; onAccent: (id: string) => void; notify?: (n: Omit<Notice, "id">, key?: string) => void }) {
  const [license, setLicense] = useState(false);
  // Coming from the sidebar's Helper chip: bring the Helper card into view.
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
      <div id="helper-card" className="scroll-mt-4">
        <Suspense fallback={null}>
          <HelperCard notify={notify} />
        </Suspense>
      </div>
    )
  );
  return (
    <div className="h-full overflow-y-auto">
    <div className="mx-auto flex w-full max-w-[1700px] flex-col gap-5 px-8 pb-10 pt-7 [&>*]:shrink-0">
      <header>
        <Eyebrow>SYNQ</Eyebrow>
        <h1 className="display-num mt-3 text-[clamp(48px,5.4vw,84px)] text-foreground">Settings</h1>
        <p className="mt-2 text-[13.5px] text-muted-foreground">SYNQ Helper, looks and credits. Device settings live on each device.</p>
      </header>

      <div className="grid items-start gap-5 min-[1500px]:grid-cols-2">
        <div className="flex flex-col gap-5">
          {helperCard}
          <Card>
            <CardHeader title="Accent" hint="The colour of whatever is on or selected." />
            <div className="flex flex-wrap gap-3 px-5 pb-5 pt-4">
              {ACCENTS.map((a) => {
                const on = accent === a.id;
                return (
                  <button
                    key={a.id}
                    onClick={() => onAccent(a.id)}
                    aria-pressed={on}
                    className={cn(
                      "flex items-center gap-3 rounded-2xl py-2.5 pl-2.5 pr-5 text-[13px] ring-1 transition-colors duration-500 ease-fluid",
                      on ? "bg-white/[0.06] text-foreground ring-white/[0.16]" : "bg-white/[0.025] text-muted-foreground ring-white/[0.06] hover:bg-white/[0.05] hover:text-foreground",
                    )}
                  >
                    <span className="grid size-8 place-items-center rounded-full ring-1 ring-white/20" style={{ background: a.color }}>
                      {on && <Check size={15} weight="bold" className="text-black/70" />}
                    </span>
                    {a.label}
                  </button>
                );
              })}
            </div>
          </Card>
          {!isWeb && (
            <Card innerClassName="flex items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-[14px] text-foreground">Welcome tour</p>
                <p className="text-[12.5px] text-muted-foreground">The short first-run setup: a hello, SYNQ Helper and your accent.</p>
              </div>
              <button onClick={openWelcome} className="rounded-full px-4 py-2 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06]">
                Run it again
              </button>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="About" />
            <div className="px-5 pb-4 pt-2">
              <DetailRows
                rows={[
                  ["Version", <span className="tabular">{pkg.version}</span>],
                  ["Background", isWeb ? "Only while this tab is open" : "Nothing, unless you turn on SYNQ Helper"],
                  ["Settings are kept", "On the device"],
                  ...(isWeb ? ([["Backups are kept", "In this browser"]] as [string, string][]) : []),
                  ["Mode", inTauri ? "Desktop app" : isWeb ? "Website (WebHID)" : "Browser preview"],
                  ["License", "GNU AGPL 3.0 or later"],
                  [
                    "Source code",
                    <button onClick={() => openLink(SOURCE_URL)} className="text-foreground underline decoration-white/20 underline-offset-4 transition-colors hover:decoration-white/60">
                      {SOURCE_URL.replace("https://", "")}
                    </button>,
                  ],
                ]}
              />
              <p className="pt-3 text-[12.5px] leading-relaxed text-muted-foreground">
                SYNQ is free software: you can use, study, share and change it under the GNU Affero General Public License, version 3 or later.
              </p>
              <p className="pt-2 text-[12.5px] leading-relaxed text-muted-foreground">
                SYNQ only changes a device after a backup, and reads every change back. It never sends firmware updates.
              </p>
              <p className="pt-2 text-[12.5px] leading-relaxed text-muted-foreground">
                {isWeb
                  ? "Online only when you use it: a VIA keyboard's layout comes from usevia.app the first time one is connected."
                  : "Online only when you use it: a VIA keyboard's layout (from usevia.app, the first time one is connected), the headphone list in Find your headphones (from GitHub, when you open it) and a Steam game's cover art on the Games page (from Steam, once per game)."}{" "}
                Nothing about you is sent.
              </p>
            </div>
          </Card>
          <Card>
            <CardHeader
              title="Licenses"
              hint="Free software SYNQ is built on."
              right={
                isLinux ? undefined : (
                  <button onClick={() => setLicense(true)} className="rounded-full px-3 py-1.5 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06]">
                    Read the GPL 2.0 text
                  </button>
                )
              }
            />
            <ul className="divide-y divide-white/[0.05] px-5 pb-3 pt-2">
              {SHOWN_LICENSES.map((l) => (
                <li key={l.name} className="flex items-baseline gap-3 py-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {l.name}
                    {l.note && <span className="ml-2 text-[11.5px] text-muted-foreground">{l.note}</span>}
                  </span>
                  <span className="tabular shrink-0 text-[11.5px] text-muted-foreground">{l.license}</span>
                </li>
              ))}
            </ul>
            <p className="border-t border-white/[0.05] px-5 pb-4 pt-3 text-[12px] leading-relaxed text-muted-foreground">
              Product images © their respective owners, shown to identify each device; they aren't covered by SYNQ's license. Want one removed? Open an issue.
            </p>
          </Card>
        </div>
      </div>
      {isWeb && <WebData />}
      {license && <LicenseDialog onClose={() => setLicense(false)} />}
    </div>
    </div>
  );
}
