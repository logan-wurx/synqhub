// The section pages, in one layout: the headline ("Your setup.") with the active device's card on the left, and on the
// right a tile for every connected device of the section, each with its product photo. Gear: each mouse, keyboard,
// controller, headset and webcam, and the sound output. Lights: each lamp in Bluetooth range ("All lights" first once
// there are two), each Wi-Fi light found, Dynamic Lighting devices and RGB hubs. Displays: each monitor.
// A tile shows the photo, the name, whether it answers and its battery where known; the active device's tile carries the
// orange tick. Clicking opens the device. Reads only what the panels already keep (src/lib/keep.ts); a change made on
// the active card is handed to the device's own page (src/lib/feel/pending.ts).
import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowRight, ArrowUpRight, Check, MagnifyingGlass, Rows, SquareHalfBottom, SquaresFour, WifiHigh, X, type Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { isWeb, type Connected } from "@/lib/backend";
import { isLinux } from "@/lib/runtime";
import { useGridRoom } from "@/lib/viewport";
import { buildEntries, type DeviceEntry } from "@/lib/device-model";
import { usePublishedNames } from "@/lib/device-names";
import { setKept, useKeptState } from "@/lib/keep";
import { goCheckup, goSettings, openDevice } from "@/lib/nav";
import { useMouseAnswers } from "@/lib/mouse-probe";
import { useKeyboardAnswers } from "@/lib/kb/probe";
import { usePadAnswers } from "@/lib/controllers/probe";
import { useLampScan } from "@/lib/lighting/lamps";
import { useLampArrays } from "@/lib/lighting/lamparrays";
import { useNetLights } from "@/lib/lighting/net/lights";
import { FindLightsTile } from "@/components/lighting/FindLights";
import { stopLampSync, webBluetooth } from "@/lib/lighting/link";
import { ALL_LAMPS } from "@/lib/lighting/models";
import { soundLabel, useSound } from "@/lib/sound";
import { useHelperReady } from "@/lib/web/use-helper";
import { BOOTLOADER_NOTE } from "@/lib/bootloader-ids";
import { requestSet } from "@/lib/feel/pending";
import { Card } from "@/components/ui/matte";
import { Mark, PlugIn, Wordmark } from "@/components/ui/brand";
import { SpotlightLight, spotlightMove } from "@/components/ui/spotlight";
import { SoftBlurIn } from "@/components/ui/soft-blur-in";
import { openCommandMenu } from "@/components/CommandMenu";
import { useGearLayout, type GearLayout } from "@/lib/gear-layout";
import { arrowPick } from "@/lib/roving";
import { ActiveCard } from "./ActiveCard";
import { FaceArt, isIdle, useDeviceFace } from "./device-face";
import { GearBento } from "./gear/Bento";
import { byGroup, sectionOf, type Section } from "@/lib/device-groups";
import { Banner } from "@/components/keyboard/parts";
import type { Notice } from "@/components/ui/matte";
import { AddDeviceButton, AddLightButton, WebNoteCards, WebPicked, WebStart } from "@/components/web/lazy";
// "Keep your feel" (offers and the panel) is its own chunk: the device tiles paint first.
const FeelOffers = lazy(() => import("@/components/feel/FeelHome").then((m) => ({ default: m.FeelOffers })));
const KeepYourFeel = lazy(() => import("@/components/feel/FeelHome").then((m) => ({ default: m.KeepYourFeel })));
// Shows on a light's tile only while a screen sync runs; the sync engine behind it loads after the home has painted.
const LightsSyncChip = lazy(() => import("@/components/lighting/LightsSync").then((m) => ({ default: m.LightsSyncChip })));
// Linux only: the device-access card (SYNQ's udev rule), its own small chunk.
const DeviceAccessCard = isLinux ? lazy(() => import("./DeviceAccess").then((m) => ({ default: m.DeviceAccessCard }))) : null;
// The Gear page's other two layouts load only when picked (bento is the default, in this chunk).
const GearShelves = lazy(() => import("./gear/Shelves"));
const GearSpotlight = lazy(() => import("./gear/Spotlight"));

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

export function DevicesHome({
  section = "devices",
  devices,
  onIntent,
  notify,
}: {
  /** Which dock section this is (src/lib/device-groups.ts sectionOf). */
  section?: Section;
  devices: Connected[];
  /** The pointer or focus is on a tile: get that page's code ready. */
  onIntent?: (kind: DeviceEntry["kind"]) => void;
  /** The website's "Add device" button and the active card's changes report through the app's notices. */
  notify?: Notify;
}) {
  const published = usePublishedNames();
  const sound = useSound();
  const mouseAnswers = useMouseAnswers();
  const kbAnswers = useKeyboardAnswers();
  const padAnswers = usePadAnswers();
  // Devices that aren't active (a mouse that is off or asleep behind its receiver, one that didn't answer, a controller
  // receiver with no pad on) go to the end. Within each part, tiles come in their group's order (mice, keyboards,
  // sound, controllers, lights, …; src/lib/device-groups.ts). From the answers the probes already gathered.
  const idle = (e: DeviceEntry) => isIdle(e, mouseAnswers, kbAnswers, padAnswers, sound.status?.state);
  // The lamp scan and the Dynamic Lighting watcher run only on the Lights page.
  const lights = section === "lights";
  const lamps = useLampScan(lights);
  const lampArrays = useLampArrays(lights);
  const netLights = useNetLights();
  // The website reaches Wi-Fi lights and monitors only through SYNQ Helper.
  const helper = useHelperReady();
  const needsHelper = isWeb && !helper;
  const entries = byGroup(buildEntries(devices, published, isWeb ? "Sound and EQ" : soundLabel(sound).title, lamps, lampArrays ?? [], netLights))
    .filter((e) => sectionOf(e.kind) === section)
    .map((e, i) => ({ e, i, off: idle(e) }))
    // "All lights" leads the Lights page; otherwise idle devices go last.
    // On the website the Sound tile only points to the desktop app: it goes last.
    .sort((a, b) => Number(b.e.family === ALL_LAMPS) - Number(a.e.family === ALL_LAMPS) || Number(isWeb && a.e.kind === "sound") - Number(isWeb && b.e.kind === "sound") || Number(a.off) - Number(b.off) || a.i - b.i)
    .map((x) => x.e);
  // Gear (a mix of kinds) is laid out by kind, in the layout picked in its header; Lights and Displays are tiles.
  const typed = section === "devices";
  const [gearLayout, setGearLayout] = useGearLayout();
  const shown = entries;
  // The tiles fill the window down to the dock; their size follows from how many there are and the room.
  const fit = useTileFit(shown.length + (lights ? 1 : 0));
  const dense = fit.size !== "big";
  const compact = fit.size === "compact";
  const updating = devices.filter((d) => d.bootloader);
  const hasInput = entries.some((e) => e.kind === "mouse" || e.kind === "keyboard" || e.kind === "controller");
  const real = entries.filter((e) => e.kind !== "sound" && e.family !== ALL_LAMPS).length;
  // The website's Sound tile only points to the app until SYNQ Helper is connected: it isn't a device here.
  const tiles = entries.filter((e) => e.family !== ALL_LAMPS && !(needsHelper && e.kind === "sound")).length;
  // The dock's Gear line shows the same count as this page (it can't see every source itself).
  const connected = real ? real + (isWeb ? 0 : 1) : null;
  useEffect(() => {
    if (typed) setKept<number | null>("home.connected", connected);
    // The Lights line too: the dock hears Govee lamps only, this page also sees Dynamic Lighting and hubs.
    else if (lights) setKept<number | null>("lights.count", real);
  }, [typed, lights, connected, real]);
  const head = HEAD[section];

  // The active device: the one picked with the card's chevron while it's still here; else the mouse that answers, the
  // first device that does, or the first one. On the website the Sound tile points to the app, so it's never active.
  const [picked, setPicked] = useKeptState<string | null>(`home.active.${section}`, null);
  const pickable = entries.filter((e) => !(isWeb && e.kind === "sound"));
  const active =
    pickable.find((e) => e.id === picked) ?? pickable.find((e) => e.kind === "mouse" && !idle(e)) ?? pickable.find((e) => !idle(e)) ?? pickable[0] ?? null;
  const onSet = (entry: DeviceEntry, steps: Parameters<typeof requestSet>[1], said: string) => {
    requestSet(entry.id, steps, said);
    notify?.({ title: `${entry.name}: ${said}`, detail: "Sent through its page: backed up first and read back.", tone: "info" }, `set-${entry.id}`);
  };
  const [feelOpen, setFeelOpen] = useState(false);
  // The app keeps the active device's page running out of sight while a change from the card waits (App.tsx).
  const activeId = typed ? (active?.id ?? null) : null;
  useEffect(() => {
    if (typed) setKept<string | null>("home.active.resolved", activeId);
  }, [typed, activeId]);

  return (
    <div className="h-full overflow-y-auto">
      {/* The page runs under the dock; its padding at the bottom lets the last row scroll up above it. */}
      <div className="mx-auto grid min-h-full w-full max-w-[1760px] grid-cols-[minmax(0,1fr)] content-start gap-x-[clamp(28px,3.2vw,56px)] gap-y-6 px-[clamp(16px,3.4vw,60px)] pb-[116px] pt-[clamp(18px,2.6vh,30px)] min-[1180px]:grid-cols-[minmax(360px,440px)_minmax(0,1fr)]">
        {/* Clear of the window buttons when the page reaches the window's right edge (1760 px wide at most, centred). */}
        <header className="flex flex-wrap items-center gap-x-5 gap-y-3 min-[1180px]:col-span-2" style={{ paddingRight: "max(0px, calc(var(--wc) - (100vw - min(100vw, 1760px)) / 2 - clamp(16px, 3.4vw, 60px)))" }}>
          <span className="flex items-center gap-2.5 text-high" role="img" aria-label="SYNQ">
            <Mark size={32} />
            <Wordmark height={26} />
          </span>
          <span className="flex-1" />
          {typed && entries.length > 1 && <LayoutSwitch value={gearLayout} onChange={setGearLayout} />}
          <button
            type="button"
            onClick={openCommandMenu}
            className="flex h-10 items-center gap-2.5 rounded-control pl-3.5 pr-2 text-[13.5px] text-medium ring-1 ring-white/[0.1] transition-colors duration-300 ease-fluid hover:bg-white/[0.06] hover:text-high max-sm:hidden"
          >
            <MagnifyingGlass size={14} />
            Search
            <kbd className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-high">{/Mac/.test(navigator.platform) ? "⌘K" : "Ctrl K"}</kbd>
          </button>
          <span className="text-[14px] text-high" data-slot="device-count">
            {typed ? (tiles ? `${tiles} ${tiles === 1 ? "device" : "devices"}` : isWeb ? "In your browser" : "No devices yet") : lights && isWeb && !real ? "None added yet" : head.count(real)}
          </span>
          {typed && <CheckupButton />}
          {/* On the website the browser lists only what was picked: mice and keyboards on Gear; on Lights, Govee lamps
              (Bluetooth) and RGB hubs and Dynamic Lighting devices (USB). */}
          {lights && webBluetooth && notify && <AddLightButton notify={notify} label="Add Govee lamp" />}
          {(typed || lights) && isWeb && notify && <AddDeviceButton notify={notify} label={lights ? "Add USB lights" : "Add device"} />}
        </header>

        {/* Wide: a column, pinned while the window is tall enough to show all of it. Medium: the headline and Keep your
            feel beside the card. Narrow: one column. */}
        <aside className="grid min-w-0 content-start gap-6 min-[760px]:grid-cols-[minmax(0,1fr)_minmax(0,480px)] min-[1180px]:grid-cols-[minmax(0,1fr)] min-[1180px]:self-start min-[1180px]:[@media(min-height:880px)]:sticky min-[1180px]:[@media(min-height:880px)]:top-6">
          <div>
            <h1 key={head.title} className="headline text-[clamp(64px,7.2vw,128px)] text-high">
              <SoftBlurIn>{head.title}</SoftBlurIn>
            </h1>
            <p className="mt-4 max-w-[30ch] text-[clamp(18px,1.55vw,25px)] leading-snug tracking-[-0.015em] text-medium">{lights && isWeb ? WEB_LIGHTS_TEXT : head.text}</p>
          </div>
          {/* Spotlight's stage is the active card in that layout. */}
          {active && !(typed && gearLayout === "spotlight") && (
            <div className="min-[760px]:row-span-2 min-[1180px]:row-span-1">
              <ActiveCard entries={pickable} active={active} onPick={setPicked} onSet={onSet} label={typed ? "Active device" : lights ? "Light" : "Display"} />
            </div>
          )}
          {typed && <FeelLink onOpen={() => setFeelOpen(true)} />}
        </aside>

        <section aria-label={head.title} className="flex min-w-0 flex-col gap-5">
          {isWeb && <WebPicked />}
          {typed && DeviceAccessCard && (
            <Suspense fallback={null}>
              <DeviceAccessCard notify={notify} />
            </Suspense>
          )}
          {typed && updating.length > 0 && (
            <Banner>
              {updating.map((d) => d.name).join(", ")}: {BOOTLOADER_NOTE}
            </Banner>
          )}
          {typed && (
            <Suspense fallback={null}>
              <FeelOffers entries={entries} />
            </Suspense>
          )}
          {/* The website before anything is added: the two first steps (the mouse or keyboard, then SYNQ Helper). */}
          {typed && !hasInput && isWeb && notify && <WebStart notify={notify} />}
          {typed && !hasInput && !isWeb && (
            <Card innerClassName="flex items-center gap-6 px-8 py-6 max-sm:flex-col max-sm:items-start max-sm:px-5">
              <PlugIn kind="mouse" className="h-[110px] w-[146px] shrink-0" />
              <div>
                <p className="text-[16px] font-semibold text-high">{isWeb ? "No mouse or keyboard added yet" : "No mouse or keyboard found"}</p>
                <p className="mt-1 max-w-md text-[13.5px] text-medium">
                  {isWeb ? "Plug one in (a receiver or a cable), press Add device and pick it in the browser's list. The browser remembers it for next time." : "Plug one in (a receiver or a cable) and it shows up here on its own."}
                </p>
                {isWeb && notify && <AddDeviceButton notify={notify} className="mt-3" />}
              </div>
            </Card>
          )}
          {typed && isWeb && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4 empty:hidden">
              <WebNoteCards />
            </div>
          )}

          {/* Gear: the devices by kind, in the layout picked in the header. */}
          {/* On the website the Sound tile only points to the desktop app: before a mouse or keyboard is added the
              first steps say that (SYNQ Helper brings the EQ), so the page leads with them rather than that tile. */}
          {typed && entries.length > 0 && (hasInput || !isWeb) && gearLayout === "bento" && <GearBento entries={entries} activeId={active?.id ?? null} onIntent={onIntent} />}
          {typed && entries.length > 0 && (hasInput || !isWeb) && gearLayout !== "bento" && (
            <Suspense fallback={null}>
              {gearLayout === "shelves" ? (
                <GearShelves entries={entries} activeId={active?.id ?? null} onIntent={onIntent} />
              ) : (
                <GearSpotlight entries={pickable} activeId={active?.id ?? null} active={active} onPick={setPicked} onSet={onSet} onIntent={onIntent} />
              )}
            </Suspense>
          )}

          {/* Lights and Displays: few devices, the mockup's big tiles; more, smaller ones, as many rows as fit above the dock. */}
          <div
            ref={fit.ref}
            className={cn("grid", typed && "hidden")}
            style={{ gap: fit.gap, gridTemplateColumns: `repeat(${fit.cols}, minmax(0, 1fr))`, gridAutoRows: `${fit.row}px` }}
          >
            {shown.map((e, i) => (
              <motion.div
                key={e.id}
                layout="position"
                className="h-full min-w-0"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, delay: Math.min(i, 8) * 0.05, ease: [0.32, 0.72, 0, 1] }}
              >
                <DeviceTile entry={e} active={e.id === active?.id} dense={dense} compact={compact} onIntent={onIntent} />
              </motion.div>
            ))}
            {!typed && isWeb && <WebNoteCards />}
            {/* Wi-Fi lights are looked for only when asked: a quiet tile at the end of the Lights page.
                (On the website with nothing added yet, the empty card below says the same.) */}
            {lights && (needsHelper ? entries.length > 0 && <HelperLightsTile /> : <FindLightsTile />)}
          </div>

          {!typed && entries.length === 0 && <EmptySection section={section} needsHelper={needsHelper} notify={notify} />}
        </section>
      </div>
      {feelOpen && <FeelSheet entries={entries} onClose={() => setFeelOpen(false)} />}
    </div>
  );
}

/** "Keep your feel" under the active card: opens the panel with the saved feel and the pros' setups. */
function FeelLink({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group flex items-center gap-6 text-left" data-slot="feel-link">
      <span className="min-w-0 flex-1">
        <span className="block text-[26px] font-bold tracking-[-0.035em] text-high">Keep your feel</span>
        <span className="mt-0.5 block text-[16px] text-medium">Transfer your setup across devices.</span>
      </span>
      <ArrowRight size={34} weight="thin" className="shrink-0 text-high transition-transform duration-500 ease-fluid group-hover:translate-x-1.5" />
    </button>
  );
}

/** The Keep your feel panel, sliding in from the right. Escape or the cross closes it. */
function FeelSheet({ entries, onClose }: { entries: readonly DeviceEntry[]; onClose: () => void }) {
  useEffect(() => {
    setKept<boolean>("feel.card.open", true);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[45] flex justify-end bg-shade/55 backdrop-blur-[2px]" onClick={onClose} role="presentation">
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Keep your feel"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-[min(780px,100%)] flex-col overflow-y-auto bg-[#141414] px-7 pb-32 pt-14 shadow-[-30px_0_60px_rgb(0_0_0/0.5)] ring-1 ring-white/[0.08] max-sm:px-4"
      >
        <div className="mb-6 flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="headline text-[48px] text-high">Keep your feel</h2>
            <p className="mt-3 text-[16px] text-medium">Save your setup once, and carry it to any mouse or keyboard you plug in.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-10 shrink-0 place-items-center rounded-full text-high ring-1 ring-white/[0.12] transition-colors hover:bg-white/[0.08]">
            <X size={16} weight="light" />
          </button>
        </div>
        <Suspense fallback={null}>
          <KeepYourFeel entries={entries} />
        </Suspense>
      </motion.div>
    </div>
  );
}

/** Each section page's headline, the line under it, and its count. */
const HEAD: Record<Section, { title: string; text: string; count: (n: number) => string }> = {
  devices: { title: "Your setup.", text: "Every device. One system.", count: (n) => `${n} ${n === 1 ? "device" : "devices"}` },
  lights: {
    title: "Your lights.",
    text: "Govee, Hue, Nanoleaf, Dynamic Lighting and RGB hubs, without their apps.",
    count: (n) => (n ? `${n} ${n === 1 ? "light" : "lights"}` : "None found yet"),
  },
  displays: { title: "Your displays.", text: "Brightness, colour and input, straight from the monitor.", count: (n) => (n ? `${n} connected` : "None found") },
};

/** The website's Lights page: what a browser reaches itself, and what comes through SYNQ Helper. */
const WEB_LIGHTS_TEXT = "Govee lamps over Bluetooth, RGB hubs and Dynamic Lighting over USB, right from the browser; Wi-Fi lights through SYNQ Helper.";

/** Lights or Displays with nothing to show: what turns them up (on the website: each kind of light and its way in). */
function EmptySection({ section, needsHelper, notify }: { section: Section; needsHelper: boolean; notify?: (n: Omit<Notice, "id">, key?: string) => void }) {
  const lights = section === "lights";
  if (lights && isWeb) return <WebLightsEmpty needsHelper={needsHelper} notify={notify} />;
  return (
    <Card innerClassName="px-8 py-6 max-sm:px-5">
      <p className="text-[15px] text-high">{lights ? "No lights yet" : needsHelper ? "Monitors need SYNQ Helper" : "No monitor found"}</p>
      <p className="mt-1 max-w-xl text-[13px] text-medium">
        {needsHelper
          ? "A browser can't talk to monitors. With SYNQ Helper (one small download that waits in the tray), this page reads and changes brightness, colour and input the way the desktop app does."
          : lights
            ? "Govee lights show up here when they're on and near this PC. For Hue, Nanoleaf, Elgato and other Wi-Fi lights, press Find Wi-Fi lights."
            : "Monitors show up here on their own. A monitor that doesn't answer may need DDC/CI switched on in its own menu."}
      </p>
      {needsHelper && <GetHelper className="mt-4" />}
    </Card>
  );
}

/** Leads to Settings, where SYNQ Helper is downloaded or connected. */
function GetHelper({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={goSettings}
      data-testid="get-helper"
      className={cn("inline-flex items-center gap-2 rounded-small bg-foreground py-1.5 pl-4 pr-1.5 text-[13px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.97]", className)}
    >
      Get SYNQ Helper
      <span className="grid size-6 place-items-center rounded bg-background/10">
        <ArrowUpRight size={12} weight="bold" />
      </span>
    </button>
  );
}

/** The website's empty Lights page: each kind of light, and how it gets here from a browser. */
function WebLightsEmpty({ needsHelper, notify }: { needsHelper: boolean; notify?: (n: Omit<Notice, "id">, key?: string) => void }) {
  const rows: { what: string; how: string; text: string; action: ReactNode }[] = [
    {
      what: "Govee lamps",
      how: "Bluetooth",
      text: webBluetooth
        ? "Switch the lamp on and pick it in the browser's Bluetooth list. Close Govee Home first: a lamp takes one connection at a time. The browser forgets a lamp when the tab closes."
        : "This browser can't reach Bluetooth lamps. Open SYNQ in Chrome or Edge, or use the desktop app.",
      action: webBluetooth && notify ? <AddLightButton notify={notify} label="Add Govee lamp" /> : null,
    },
    {
      what: "RGB hubs and Dynamic Lighting",
      how: "USB",
      text: "NZXT, Corsair and Lian Li hubs, and keyboards, mice and strips that speak Windows' lighting standard: pick them in the browser's device list.",
      action: notify ? <AddDeviceButton notify={notify} label="Add USB lights" className="bg-white/[0.07] text-high ring-1 ring-white/10" /> : null,
    },
    {
      what: "Wi-Fi lights",
      how: "Your network",
      text: needsHelper
        ? "Hue, Nanoleaf, Elgato, LIFX and more. A browser can't reach your home network; SYNQ Helper (one small download that waits in the tray) can."
        : "Hue, Nanoleaf, Elgato, LIFX and more: press Find Wi-Fi lights.",
      action: needsHelper ? <GetHelper /> : null,
    },
  ];
  return (
    <Card innerClassName="px-8 py-6 max-sm:px-5">
      <p className="text-[15px] text-high">No lights added yet</p>
      <ul className="mt-4 grid gap-4">
        {rows.map((r) => (
          <li key={r.what} className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-white/[0.06] pt-4 first:border-t-0 first:pt-0">
            <div className="min-w-[220px] flex-1">
              <p className="text-[13.5px] text-high">
                {r.what} <span className="label-caps ml-1.5">{r.how}</span>
              </p>
              <p className="mt-1 max-w-xl text-[12.5px] text-medium">{r.text}</p>
            </div>
            {r.action}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The Lights page's last tile on the website without SYNQ Helper: Wi-Fi lights are found through it (Settings has it). */
function HelperLightsTile() {
  return (
    <button
      type="button"
      onClick={goSettings}
      data-testid="lights-need-helper"
      className="flex h-full min-h-[160px] w-full flex-col items-center justify-center gap-1.5 rounded-card border border-dashed border-white/[0.14] p-5 text-medium transition-colors hover:border-white/[0.24] hover:text-high"
    >
      <WifiHigh size={20} weight="light" />
      <span className="text-[13px]">Wi-Fi lights</span>
      <span className="text-[11.5px] text-medium">Found through SYNQ Helper · Get it in Settings</span>
    </button>
  );
}


/** The way into the gear checkup (Gear Doctor). */
function CheckupButton() {
  return (
    <button
      onClick={() => goCheckup(null)}
      title="A guided checkup of everything connected, about a minute"
      className="group flex h-11 items-center gap-2.5 rounded-control px-5 text-[15px] font-medium text-high ring-1 ring-white/[0.2] transition-[background-color,transform] duration-500 ease-fluid hover:bg-white/[0.07] active:scale-[0.98]"
    >
      Run a checkup
      <ArrowUpRight size={16} weight="light" className="transition-transform duration-500 ease-fluid group-hover:-translate-y-px group-hover:translate-x-0.5" />
    </button>
  );
}


/** `dense`: more than six on the page, so the tiles are smaller and more fit without scrolling. */
function DeviceTile({ entry, active, dense, compact = false, onIntent }: { entry: DeviceEntry; active: boolean; dense: boolean; compact?: boolean; onIntent?: (kind: DeviceEntry["kind"]) => void }) {
  const face = useDeviceFace(entry);
  const { top, status, live, idle, desktopOnly } = face;
  const soundOn = face.eqOn;
  const syncing = entry.kind === "light" ? (entry.lamps ?? []).filter((l) => l.sync) : [];

  return (
    <div className="relative h-full">
      <button
        onClick={() => openDevice(entry.id)}
        onPointerEnter={() => onIntent?.(entry.kind)}
        onPointerMove={spotlightMove}
        onFocus={() => onIntent?.(entry.kind)}
        className={cn(
          "tile group group/spotlight relative isolate flex h-full w-full flex-col overflow-hidden rounded-card text-left transition-[transform,border-color] duration-500 ease-fluid hover:border-white/[0.22] active:scale-[0.995] max-sm:px-5",
          dense ? "px-5 pb-4 pt-4" : "px-7 pb-6 pt-6",
          active && "border-white/[0.18]",
        )}
        aria-label={`Open ${entry.name}`}
        aria-current={active ? "true" : undefined}
      >
        <SpotlightLight size={dense ? 260 : 340} />
        <span className={cn("label-caps relative block truncate", dense ? "pr-10" : "pr-14", compact && "sr-only")}>{top}</span>
        {/* The one track is exactly the box's size, so a picture's max-height: 100% means the box, not its own height. */}
        <span className={cn("relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center", compact ? "py-0.5" : dense ? "py-2" : "py-3", idle && "opacity-75")}>
          {/* Sound: the EQ you have on (or the headphones' picture, when one was picked); on the website, where the EQ
              lives in the desktop app, the app's icon. */}
          <FaceArt entry={entry} face={face} imgClassName="drop-shadow-[0_28px_30px_rgb(0_0_0/0.55)] transition-transform duration-700 ease-fluid group-hover:scale-[1.04]" />
        </span>
        <span className="relative flex items-end gap-3">
          <span className="min-w-0 flex-1">
            {/* Smaller tiles give the name two lines: the name is how people tell their gear apart. */}
            <span className={cn("block font-bold tracking-[-0.03em] text-high", dense ? "line-clamp-2 text-[17px] leading-[1.12]" : "truncate text-[24px]")}>{entry.name}</span>
            <span className={cn("flex items-center gap-2 text-medium", dense ? "mt-1 text-[13px]" : "mt-1.5 text-[15px]")}>
              <span className={cn("size-2 shrink-0 rounded-full", live ? "bg-[var(--live)]" : "bg-[var(--asleep)]")} aria-hidden="true" />
              <span className="truncate">{status}</span>
            </span>
          </span>
          {entry.kind === "sound" && soundOn && !desktopOnly && !compact && (
            <span className={cn("shrink-0 rounded-tight bg-primary font-semibold text-primary-foreground", dense ? "px-2.5 py-1 text-[12.5px]" : "px-3 py-1.5 text-[14px]")}>EQ active</span>
          )}
        </span>
        {/* A compact tile has no room beside the name: the badge sits in the top corner (the kind label's place). */}
        {entry.kind === "sound" && soundOn && !desktopOnly && compact && (
          <span className="absolute left-4 top-4 rounded-tight bg-primary px-2 py-0.5 text-[11.5px] font-semibold text-primary-foreground">EQ active</span>
        )}
        {/* The active device: the orange corner with a tick. */}
        {active && (
          <span aria-hidden="true" className={cn("absolute right-0 top-0 grid place-items-center rounded-tr-[17px] bg-primary", dense ? "size-[46px] rounded-bl-[22px]" : "size-[62px] rounded-bl-[30px]")}>
            <Check size={dense ? 20 : 26} weight="bold" className="-translate-y-0.5 translate-x-0.5 text-primary-foreground" />
          </span>
        )}
      </button>
      {entry.kind === "light" && (
        <Suspense fallback={syncing.length > 0 && <SyncChip ids={syncing.map((l) => l.id)} />}>
          <LightsSyncChip family={entry.family} all={entry.family === ALL_LAMPS} otherwise={syncing.length > 0 && <SyncChip ids={syncing.map((l) => l.id)} />} />
        </Suspense>
      )}
    </div>
  );
}

/** A lamp syncing to the screen, shown on its card (it runs in the background until stopped) with a way to stop it. */
function SyncChip({ ids }: { ids: readonly string[] }) {
  const [stopping, setStopping] = useState(false);
  if (stopping) return null;
  return (
    <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-shade/70 py-1 pl-3 pr-1 text-[12px] text-high ring-1 ring-primary/40 backdrop-blur-sm" data-testid="lamp-sync-chip">
      <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
      Syncing to the screen
      <button
        type="button"
        onClick={() => {
          setStopping(true);
          void Promise.all(ids.map((id) => stopLampSync(id))).catch(() => setStopping(false));
        }}
        className="rounded-full bg-white/[0.1] px-2.5 py-0.5 text-[11.5px] ring-1 ring-white/15 transition-colors hover:bg-white/[0.18]"
      >
        Stop
      </button>
    </div>
  );
}

/** Tile limits: narrowest column, lowest and tallest row (taller for one or two, a showcase), and the shape aimed for (height over width). */
const TILE = { minCol: 150, lo: 132, hi: 420, few: 620, aspect: 1.15, gap: 16 };

export type TileSize = "big" | "dense" | "compact";

/**
 * The tiles' grid, so it fills the window down to the dock at any size (1920x1080 as much as 1480x920): of the column
 * counts whose rows fit the height left under the grid, the one whose tiles come closest to the mockup's shape. None
 * fit: the narrowest columns at the lowest rows, and the page scrolls. The tile's type size follows its box.
 */
function useTileFit(count: number) {
  const { ref, w: gridW, room } = useGridRoom<HTMLDivElement>([count]);
  const { minCol, lo, aspect, gap } = TILE;
  const hi = count <= 2 ? TILE.few : TILE.hi;
  const most = Math.max(1, Math.floor((gridW + gap) / (minCol + gap)));
  const width = (cols: number) => (gridW - gap * (cols - 1)) / cols;
  let best: { cols: number; row: number; off: number } | null = null;
  for (let cols = 1; cols <= most; cols++) {
    const rows = Math.ceil(count / cols);
    const row = Math.min(hi, (room - gap * (rows - 1)) / rows);
    if (row < lo) continue;
    // Off the shape, plus a share for empty cells in the last row (a tile alone on a row looks lost).
    const off = Math.abs(Math.log(row / width(cols) / aspect)) + (1.5 * (cols * rows - count)) / (cols * rows);
    if (!best || off < best.off) best = { cols, row, off };
  }
  const cols = best?.cols ?? most;
  const row = Math.round(best?.row ?? Math.min(hi, Math.max(lo, width(most) * aspect)));
  const w = width(cols);
  const size: TileSize = row < 200 || w < 190 ? "compact" : row < 280 || w < 260 ? "dense" : "big";
  return { ref, cols, row, size, gap };
}

const LAYOUTS: { id: GearLayout; label: string; hint: string; icon: Icon }[] = [
  { id: "bento", label: "Bento", hint: "Bento: a card for each kind", icon: SquaresFour },
  { id: "shelves", label: "Shelves", hint: "Shelves: a row for each kind", icon: Rows },
  { id: "spotlight", label: "Spotlight", hint: "Spotlight: one device on a stage, the rest in a rail", icon: SquareHalfBottom },
];

/** The Gear page's layout, in its header: the same pill track and sliding highlight as the tab bar. */
function LayoutSwitch({ value, onChange }: { value: GearLayout; onChange: (next: GearLayout) => void }) {
  return (
    <div role="radiogroup" aria-label="Layout" onKeyDown={arrowPick} className="flex items-center gap-0.5 rounded-full bg-white/[0.05] p-1 ring-1 ring-white/[0.1] max-sm:hidden">
      {LAYOUTS.map((l) => {
        const on = l.id === value;
        return (
          <button
            key={l.id}
            type="button"
            role="radio"
            aria-checked={on}
            title={l.hint}
            onClick={() => onChange(l.id)}
            className={cn("relative grid size-8 place-items-center rounded-full transition-colors duration-500 ease-fluid", on ? "text-background" : "text-medium hover:text-high")}
          >
            {on && <motion.span layoutId="gear-layout" transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }} className="absolute inset-0 rounded-full bg-foreground" />}
            <l.icon size={16} weight={on ? "fill" : "light"} className="relative" />
            <span className="sr-only">{l.label}</span>
          </button>
        );
      })}
    </div>
  );
}