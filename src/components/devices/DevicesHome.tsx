// The section pages: one tile for every connected device of that section. Gear: each mouse, keyboard, controller,
// headset and webcam, and the sound output. Lights: each lamp in Bluetooth range ("All lights" first once there are
// two), each Wi-Fi light found, Dynamic Lighting devices and RGB hubs. Displays: each monitor.
// The Gear page opens with big live numbers (pointer speed, report rate, battery, lights) from what the device pages
// last read. The tiles sit in a bento grid, the first one large: the render, the name, whether it answers, its battery
// where known, and how far SYNQ has been tried on it when that's short of verified. Clicking opens the device.
// Reads only what the panels already keep (src/lib/keep.ts); it never opens a device.
import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowUpRight, CaretRight, GameController, WifiHigh } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { inTauri, isWeb, type Connected } from "@/lib/backend";
import { isLinux } from "@/lib/runtime";
import { buildEntries, mouseNumbers, summarize, type DeviceEntry } from "@/lib/device-model";
import { usePublishedNames } from "@/lib/device-names";
import { setKept, useKeptState, useKeptValues } from "@/lib/keep";
import { goCheckup, goGames, goLights, goSettings, openDevice, SOUND_ID } from "@/lib/nav";
import { useMouseAnswers } from "@/lib/mouse-probe";
import { useKeyboardAnswers } from "@/lib/kb/probe";
import { padLive, usePadAnswers } from "@/lib/controllers/probe";
import { useLampScan, useLamps } from "@/lib/lighting/lamps";
import { useLampArrays } from "@/lib/lighting/lamparrays";
import { useNetLights } from "@/lib/lighting/net/lights";
import { FindLightsTile } from "@/components/lighting/FindLights";
import { stopLampSync, webBluetooth } from "@/lib/lighting/link";
import { ALL_LAMPS, weak } from "@/lib/lighting/models";
import { soundLabel, useSound } from "@/lib/sound";
import { useHelperReady } from "@/lib/web/use-helper";
import { BOOTLOADER_NOTE } from "@/lib/bootloader-ids";
import { Card } from "@/components/ui/matte";
import { AppTile, Mark, PlugIn, Wordmark } from "@/components/ui/brand";
import { EqTileArt } from "./EqTileArt";
import { DeviceArt, lightArt, netLightArt } from "./DeviceArt";
import { KindFilter, useKindFilter } from "./KindFilter";
import { byGroup, sectionOf, type Section } from "@/lib/device-groups";
import { TierBadge } from "./shell";
import { Banner } from "@/components/keyboard/parts";
import type { Notice } from "@/components/ui/matte";
import { AddDeviceButton, AddLightButton, WebNoteCards, WebPicked } from "@/components/web/lazy";
// "Keep your feel" (banners and card) is its own chunk: the device cards paint first, the card follows.
const FeelOffers = lazy(() => import("@/components/feel/FeelHome").then((m) => ({ default: m.FeelOffers })));
const KeepYourFeel = lazy(() => import("@/components/feel/FeelHome").then((m) => ({ default: m.KeepYourFeel })));
// Shows on a light card only while a screen sync runs; the sync engine behind it loads after the home has painted.
const LightsSyncChip = lazy(() => import("@/components/lighting/LightsSync").then((m) => ({ default: m.LightsSyncChip })));
// Linux only: the device-access card (SYNQ's udev rule), its own small chunk.
const DeviceAccessCard = isLinux ? lazy(() => import("./DeviceAccess").then((m) => ({ default: m.DeviceAccessCard }))) : null;

export function DevicesHome({
  section = "devices",
  devices,
  onIntent,
  notify,
}: {
  /** Which sidebar tab this is (src/lib/device-groups.ts sectionOf). */
  section?: Section;
  devices: Connected[];
  /** The pointer or focus is on a card: get that page's code ready. */
  onIntent?: (kind: DeviceEntry["kind"]) => void;
  /** The website's "Add device" button reports through the app's notices. */
  notify?: (n: Omit<Notice, "id">, key?: string) => void;
}) {
  const published = usePublishedNames();
  const sound = useSound();
  const mouseAnswers = useMouseAnswers();
  const kbAnswers = useKeyboardAnswers();
  const padAnswers = usePadAnswers();
  // Devices that aren't active (a mouse that is off or asleep behind its receiver, one that didn't answer, a controller
  // receiver with no pad on) go to the end, greyed out. Within each part, cards come in their group's order (mice,
  // keyboards, sound, controllers, lights, …; src/lib/device-groups.ts). From the answers the probes already gathered.
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
    // On the website the Sound tile only points to the desktop app: it goes last, never the big first tile.
    .sort((a, b) => Number(b.e.family === ALL_LAMPS) - Number(a.e.family === ALL_LAMPS) || Number(isWeb && a.e.kind === "sound") - Number(isWeb && b.e.kind === "sound") || Number(a.off) - Number(b.off) || a.i - b.i)
    .map((x) => x.e);
  const filter = useKindFilter(entries, (e) => e.family !== ALL_LAMPS);
  // The type pills are for the Devices page's mix; Lights and Displays are one kind each.
  const typed = section === "devices";
  const shown = typed ? filter.shown : entries;
  const pick = typed ? filter.value : "all";
  const updating = devices.filter((d) => d.bootloader);
  const hasInput = entries.some((e) => e.kind === "mouse" || e.kind === "keyboard" || e.kind === "controller");
  const real = entries.filter((e) => e.kind !== "sound" && e.family !== ALL_LAMPS).length;
  // The sidebar's Devices line shows the same count as this page (it can't see every source itself).
  const connected = real ? real + (isWeb ? 0 : 1) : null;
  useEffect(() => {
    if (typed) setKept<number | null>("home.connected", connected);
    // The Lights line too: the sidebar hears Govee lamps only, this page also sees Dynamic Lighting and hubs.
    else if (lights) setKept<number | null>("lights.count", real);
  }, [typed, lights, connected, real]);
  const head = HEAD[section];

  const heardLights = useLamps().length + netLights.length;

  return (
    <div className="h-full overflow-y-auto">
    <div className="mx-auto flex min-h-full w-full max-w-[2100px] flex-col gap-7 px-14 pb-8 pt-9 max-lg:px-8 max-md:px-4 [&>*]:shrink-0">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="flex items-center gap-2 text-foreground" role="img" aria-label="SYNQ">
          <Mark size={24} />
          <Wordmark height={19} />
        </span>
        <span className="rounded-full bg-white/[0.08] px-2.5 py-1 font-mono text-[11.5px] text-foreground/70">
          {typed ? (isWeb ? (real ? `${real} connected` : "In your browser") : real ? `${real + 1} connected` : "Sound output") : lights && isWeb && !real ? "None added yet" : head.count(real)}
        </span>
        <span className="flex-1" />
        {typed && <CheckupButton />}
        {/* On the website the browser lists only what was picked: mice and keyboards on Gear; on Lights, Govee lamps
            (Bluetooth) and RGB hubs and Dynamic Lighting devices (USB). */}
        {lights && webBluetooth && notify && <AddLightButton notify={notify} label="Add Govee lamp" />}
        {(typed || lights) && isWeb && notify && (
          <AddDeviceButton notify={notify} label={lights ? "Add USB lights" : "Add device"} className={lights ? "bg-white/[0.07] text-foreground ring-1 ring-white/10" : undefined} />
        )}
      </header>

      {typed ? (
        <>
          <h1 className="sr-only">{head.title}</h1>
          <LiveNumbers entries={entries} lights={isWeb ? 0 : heardLights} />
        </>
      ) : (
        <div>
          <h1 className="display-num text-[clamp(48px,5.4vw,84px)] text-foreground">{head.title}</h1>
          <p className="mt-3 max-w-2xl text-[14px] text-muted-foreground">{lights && isWeb ? WEB_LIGHTS_TEXT : head.text}</p>
        </div>
      )}

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

      {typed && filter.offered && <KindFilter groups={filter.groups} value={filter.value} onChange={filter.setPicked} />}

      {/* A bento: the first tile (the device in use, or All lights) takes two columns and two rows once there are three columns. */}
      <div className="@container">
        <div className="grid grid-flow-row-dense gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 232px), 1fr))", gridAutoRows: "clamp(200px, 25vh, 300px)" }}>
          {shown.map((e, i) => (
            <motion.div
              key={e.id}
              layout="position"
              className={cn("h-full min-w-0", i === 0 && !(isWeb && e.kind === "sound") && "@min-[740px]:col-span-2 @min-[740px]:row-span-2")}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: Math.min(i, 8) * 0.045, ease: [0.32, 0.72, 0, 1] }}
            >
              <DeviceTile entry={e} hero={i === 0 && !(isWeb && e.kind === "sound")} onIntent={onIntent} />
            </motion.div>
          ))}
          {isWeb && <WebNoteCards />}
          {/* Wi-Fi lights are looked for only when asked: a quiet tile at the end of the Lights page. */}
          {/* (On the website with nothing added yet, the empty card below says the same.) */}
          {lights && (needsHelper ? entries.length > 0 && <HelperLightsTile /> : <FindLightsTile />)}
        </div>
      </div>

      {typed && !hasInput && (
        <Card innerClassName="flex items-center gap-6 px-8 py-6 max-sm:flex-col max-sm:items-start max-sm:px-5">
          <PlugIn kind="mouse" className="h-[110px] w-[146px] shrink-0" />
          <div>
            <p className="text-[15px] text-foreground">{isWeb ? "No mouse or keyboard added yet" : "No mouse or keyboard found"}</p>
            <p className="mt-1 max-w-md text-[13px] text-muted-foreground">
              {isWeb ? "Plug one in (a receiver or a cable), press Add device and pick it in the browser's list. The browser remembers it for next time." : "Plug one in (a receiver or a cable) and it shows up here on its own."}
            </p>
            {isWeb && notify && <AddDeviceButton notify={notify} className="mt-3" />}
          </div>
        </Card>
      )}

      {/* Keep your feel and Games are about mice and keyboards: they stay out of a Lights or Controllers view. */}
      {!typed && entries.length === 0 && <EmptySection section={section} needsHelper={needsHelper} notify={notify} />}

      {typed && (pick === "all" || pick === "mice" || pick === "keyboards") && (
        <div className="mt-auto grid grid-cols-[minmax(0,1fr)] gap-5">
          <Suspense fallback={null}>
            <KeepYourFeel entries={entries} />
          </Suspense>
          {!isWeb && <GamesTeaser />}
        </div>
      )}
    </div>
    </div>
  );
}

/** Each section page's header. */
const HEAD: Record<Section, { title: string; text: string; count: (n: number) => string }> = {
  devices: { title: "Gear", text: "Pick one to tune. Settings are written to the device itself, so they stay without SYNQ running.", count: (n) => `${n} connected` },
  lights: {
    title: "Lights",
    text: "Govee over Bluetooth, Wi-Fi lights on your network, Dynamic Lighting and RGB hubs, without their apps.",
    count: (n) => (n ? `${n} ${n === 1 ? "light" : "lights"}` : "None found yet"),
  },
  displays: { title: "Displays", text: "Brightness, colour and input, straight from the monitor. Read-only until you allow changes.", count: (n) => (n ? `${n} connected` : "None found") },
};

/** The website's Lights page: what a browser reaches itself, and what comes through SYNQ Helper. */
const WEB_LIGHTS_TEXT = "Govee lamps over Bluetooth, RGB hubs and Dynamic Lighting over USB, right from the browser; Wi-Fi lights through SYNQ Helper.";

/** Lights or Displays with nothing to show: what turns them up (on the website: each kind of light and its way in). */
function EmptySection({ section, needsHelper, notify }: { section: Section; needsHelper: boolean; notify?: (n: Omit<Notice, "id">, key?: string) => void }) {
  const lights = section === "lights";
  if (lights && isWeb) return <WebLightsEmpty needsHelper={needsHelper} notify={notify} />;
  return (
    <Card innerClassName="px-8 py-6 max-sm:px-5">
      <p className="text-[15px] text-foreground">{lights ? "No lights yet" : needsHelper ? "Monitors need SYNQ Helper" : "No monitor found"}</p>
      <p className="mt-1 max-w-xl text-[13px] text-muted-foreground">
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
      className={cn("inline-flex items-center gap-2 rounded-full bg-foreground py-1.5 pl-4 pr-1.5 text-[13px] font-medium text-background transition-transform duration-300 ease-fluid active:scale-[0.97]", className)}
    >
      Get SYNQ Helper
      <span className="grid size-6 place-items-center rounded-full bg-background/10">
        <ArrowUpRight size={13} weight="bold" />
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
      action: notify ? <AddDeviceButton notify={notify} label="Add USB lights" className="bg-white/[0.07] text-foreground ring-1 ring-white/10" /> : null,
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
      <p className="text-[15px] text-foreground">No lights added yet</p>
      <ul className="mt-4 grid gap-4">
        {rows.map((r) => (
          <li key={r.what} className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-white/[0.06] pt-4 first:border-t-0 first:pt-0">
            <div className="min-w-[220px] flex-1">
              <p className="text-[13.5px] text-foreground">
                {r.what} <span className="label-mono ml-1.5">{r.how}</span>
              </p>
              <p className="mt-1 max-w-xl text-[12.5px] text-muted-foreground">{r.text}</p>
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
      className="flex h-full min-h-[160px] w-full flex-col items-center justify-center gap-1.5 rounded-[1.6rem] border border-dashed border-white/[0.12] p-5 text-muted-foreground transition-colors hover:border-white/[0.2] hover:text-foreground"
    >
      <WifiHigh size={20} />
      <span className="text-[13px]">Wi-Fi lights</span>
      <span className="text-[11.5px] text-muted-foreground/80">Found through SYNQ Helper · Get it in Settings</span>
    </button>
  );
}

/** A headset whose page read it last as switched off (its receiver answered, the headset didn't). */
const headsetOff = (v: unknown): boolean => typeof v === "object" && v !== null && "connected" in v && !(v as { connected: boolean }).connected;

/** Whether a device is not active right now, from what the probes already know (no new checks). */
function isIdle(e: DeviceEntry, mice: ReadonlyMap<string, string>, keyboards: ReadonlyMap<string, string>, pads: ReadonlyMap<string, "live" | "quiet">, soundState: string | undefined): boolean {
  // The browser preview can pretend a device is asleep (`#idle-atk`) so the greyed-out look can be seen.
  if (!inTauri && !isWeb && typeof location !== "undefined" && location.hash.includes(`idle-${e.family}`)) return true;
  if (e.kind === "mouse") return mice.get(e.family) === "quiet";
  if (e.kind === "keyboard") return keyboards.get(e.family) === "quiet";
  if (e.kind === "controller") return !padLive(pads, e.pad?.device);
  if (e.kind === "headset" || e.kind === "monitor" || e.kind === "webcam") return false;
  if (e.kind === "light") return e.family !== ALL_LAMPS && !!e.lamps?.every(weak);
  if (e.kind === "lamparray" || e.kind === "rgbhub") return false;
  return soundState === "noOutput";
}

/** A lamp card's status line: how well it is heard (a lamp connects only while its page is open). */
function lampStatus(e: DeviceEntry): string {
  if (e.net) return e.net.paired ? "On your network" : "Needs pairing";
  const lamps = e.lamps ?? [];
  const near = lamps.filter((l) => !weak(l)).length;
  if (e.family === ALL_LAMPS) return !lamps.length || isWeb ? "One look for all of them" : near === lamps.length ? `${near} in Bluetooth range` : `${near} of ${lamps.length} in Bluetooth range`;
  // The website hears no signal strength: a lamp is listed because it was picked in this tab.
  if (isWeb) return "Added in this tab";
  return near ? "In range" : "Weak signal";
}


/** The way into the gear checkup (Gear Doctor). */
function CheckupButton() {
  return (
    <button
      onClick={() => goCheckup(null)}
      title="A guided checkup of everything connected, about a minute"
      className="group flex h-10 items-center gap-3 rounded-full bg-white/[0.06] pl-[18px] pr-1.5 text-[14px] font-semibold text-foreground ring-1 ring-white/[0.14] transition-[background-color,transform] duration-500 ease-fluid hover:bg-white/[0.1] active:scale-[0.98]"
    >
      Run a checkup
      <span className="grid size-7 place-items-center rounded-full bg-foreground text-background transition-transform duration-500 ease-fluid group-hover:-translate-y-px group-hover:translate-x-0.5">
        <ArrowUpRight size={13} weight="bold" />
      </span>
    </button>
  );
}

interface LiveNumber {
  key: string;
  value: string;
  unit?: string;
  label: string;
  /** Opens this when clicked. */
  go?: () => void;
  tone?: "glow" | "low";
}

/** The most numbers the strip shows. */
const MAX_NUMBERS = 4;
const hz = (n: number) => (n >= 1000 && n % 1000 === 0 ? `${n / 1000}K` : String(n));

/**
 * The Gear page's big numbers, from what the device pages last read (nothing is asked of a device here): the pointer
 * speed and report rate of the first mouse read, the lowest battery known, the lights heard, the EQ. Up to four.
 */
function LiveNumbers({ entries, lights }: { entries: readonly DeviceEntry[]; lights: number }) {
  const views = useKeptValues(entries.map((e) => e.viewKey ?? `home.none.${e.id}`));
  const sound = useSound();
  const nums: LiveNumber[] = [];
  const mouse = entries.map((e, i) => ({ e, n: mouseNumbers(views[i]) })).find((m) => m.e.kind === "mouse" && m.n.dpi !== null);
  if (mouse) {
    nums.push({ key: "dpi", value: String(mouse.n.dpi), label: `DPI · ${mouse.e.name}`, go: () => openDevice(mouse.e.id) });
    if (mouse.n.pollingHz) nums.push({ key: "hz", value: hz(mouse.n.pollingHz), unit: "Hz", label: "Polling", go: () => openDevice(mouse.e.id) });
  }
  const low = entries
    .map((e, i) => ({ e, b: summarize(e, views[i]).battery }))
    .filter((x): x is { e: DeviceEntry; b: number } => x.b !== null)
    .sort((x, y) => x.b - y.b)[0];
  if (low) nums.push({ key: "battery", value: String(low.b), unit: "%", label: `Battery · ${low.e.name}`, go: () => openDevice(low.e.id), tone: low.b <= 15 ? "low" : undefined });
  if (lights) nums.push({ key: "lights", value: String(lights), label: lights === 1 ? "Light" : "Lights", go: goLights, tone: "glow" });
  if (!isWeb && sound.status) nums.push({ key: "eq", value: sound.status.state === "active" ? "On" : "Off", label: `EQ · ${soundLabel(sound).title}`, go: () => openDevice(SOUND_ID) });
  const real = entries.filter((e) => e.kind !== "sound").length;
  const connected = real + (isWeb ? 0 : 1);
  if (nums.length < 2 && connected) nums.push({ key: "connected", value: String(connected), label: "Connected" });
  // Nothing to show yet (the website before a device is added): no strip, rather than a lone 0.
  if (!nums.length) return null;
  return (
    <section aria-label="Live numbers" className="flex flex-wrap items-end gap-x-[clamp(28px,3.6vw,56px)] gap-y-5">
      {nums.slice(0, MAX_NUMBERS).map((n, i) => (
        <motion.button
          key={n.key}
          type="button"
          onClick={n.go}
          disabled={!n.go}
          initial={{ opacity: 0, y: 18, filter: "blur(8px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.8, delay: i * 0.06, ease: [0.32, 0.72, 0, 1] }}
          className="group min-w-0 rounded-2xl text-left disabled:cursor-default"
        >
          <span
            className={cn(
              "display-num block text-[clamp(56px,7.2vw,104px)] transition-opacity duration-500 ease-fluid group-enabled:group-hover:opacity-80",
              n.tone === "glow" ? "text-[var(--glow-a)]" : n.tone === "low" ? "text-destructive" : "text-foreground",
            )}
          >
            {n.value}
            {n.unit && <span className="ml-0.5 text-[0.35em] tracking-normal">{n.unit}</span>}
          </span>
          <span className="label-mono mt-2 block max-w-[260px] truncate">{n.label}</span>
        </motion.button>
      ))}
    </section>
  );
}

/** A pointer to the Games page (SYNQ Helper's per-game profiles). */
function GamesTeaser() {
  return (
    <button
      onClick={goGames}
      className="group flex items-center gap-4 rounded-[1.6rem] bg-white/[0.025] px-6 py-4 text-left ring-1 ring-white/[0.06] transition-colors duration-500 ease-fluid hover:bg-white/[0.045]"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/[0.12] text-primary ring-1 ring-primary/25">
        <GameController size={17} weight="light" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] text-foreground">Games</p>
        <p className="text-[12.5px] text-muted-foreground">A profile per game: your DPI, polling and key settings switch when the game starts.</p>
      </div>
      <CaretRight size={16} className="shrink-0 text-muted-foreground/80 transition-transform duration-500 ease-fluid group-hover:translate-x-0.5 group-hover:text-foreground" />
    </button>
  );
}

/** The small word over a tile. */
const KIND_LABEL: Record<DeviceEntry["kind"], string> = {
  mouse: "Mouse",
  keyboard: "Keyboard",
  sound: "Sound",
  controller: "Controller",
  light: "Light",
  headset: "Headset",
  monitor: "Display",
  webcam: "Webcam",
  lamparray: "Dynamic Lighting",
  rgbhub: "RGB hub",
};

function DeviceTile({ entry, hero, onIntent }: { entry: DeviceEntry; hero: boolean; onIntent?: (kind: DeviceEntry["kind"]) => void }) {
  const [view] = useKeptState<unknown>(entry.viewKey ?? `home.none.${entry.id}`, null);
  const mouseAnswers = useMouseAnswers();
  const kbAnswers = useKeyboardAnswers();
  const padAnswers = usePadAnswers();
  const sound = useSound();
  const label = soundLabel(sound);
  const s = summarize(entry, view);
  const brand = (view as { brand?: string } | null)?.brand ?? entry.brand;

  const asleep =
    entry.kind === "mouse"
      ? mouseAnswers.get(entry.family) === "quiet"
      : entry.kind === "keyboard"
        ? kbAnswers.get(entry.family) === "quiet"
        : entry.kind === "controller"
          ? !padLive(padAnswers, entry.pad?.device)
          : entry.kind === "headset"
            ? headsetOff(view)
          : entry.kind === "light"
            ? entry.family !== ALL_LAMPS && !!entry.lamps?.every(weak)
            : false;
  const soundOn = sound.status?.state === "active";
  const idle = isIdle(entry, mouseAnswers, kbAnswers, padAnswers, sound.status?.state);
  const live = entry.kind === "sound" ? soundOn : !asleep;
  // On the website the Sound tile is a pointer to the desktop app (browsers can't reach system audio),
  // unless SYNQ Helper is connected.
  const helper = useHelperReady();
  const desktopOnly = isWeb && !helper && entry.kind === "sound";
  const statusText = desktopOnly
    ? "Equalizer, presets and the engine on your output"
    : entry.kind === "light"
      ? lampStatus(entry)
      : entry.kind === "sound"
      ? idle
        ? "No sound output"
        : soundOn
        ? "EQ running"
        : sound.status
          ? "EQ off"
          : "Checking"
      : asleep
        ? entry.kind === "controller"
          ? "No pad on this receiver"
          : "Off or asleep"
        : s.link
          ? `Connected · ${s.link}`
          : "Connected";
  // "6 lights" says it all for the All lights tile; the sound output has no maker.
  const top = entry.family === ALL_LAMPS ? brand : [KIND_LABEL[entry.kind], entry.kind === "sound" ? null : brand].filter(Boolean).join(" · ");
  // How far SYNQ has been tried on it, short of verified: its icon on the tile, the word on hover and to screen readers.
  const badged = !desktopOnly && s.tier !== "verified";

  const syncing = entry.kind === "light" ? (entry.lamps ?? []).filter((l) => l.sync) : [];
  return (
    <div className="relative h-full">
    <button
      onClick={() => openDevice(entry.id)}
      onPointerEnter={() => onIntent?.(entry.kind)}
      onFocus={() => onIntent?.(entry.kind)}
      className="group block h-full w-full text-left transition-transform duration-300 ease-fluid active:scale-[0.995]"
      aria-label={`Open ${entry.name}`}
    >
      <div
        className={cn(
          "h-full bg-white/[0.045] p-1.5 ring-1 ring-white/[0.09] transition-[background-color,box-shadow,opacity,filter] duration-500 ease-fluid group-hover:bg-white/[0.07] group-hover:ring-white/[0.16] group-focus-visible:ring-primary/60",
          hero ? "rounded-[1.9rem]" : "rounded-[1.6rem]",
          idle && "opacity-80 saturate-0 group-hover:opacity-95",
        )}
      >
        <div
          className={cn(
            "flex h-full flex-col bg-[#0c0c0f]/[0.62] bg-[linear-gradient(160deg,rgb(255_255_255/0.07),rgb(255_255_255/0.015)_55%)] shadow-[inset_0_1px_1px_rgb(255_255_255/0.1)]",
            hero ? "rounded-[calc(1.9rem-0.375rem)] p-6" : "rounded-[calc(1.6rem-0.375rem)] px-[18px] py-4",
          )}
        >
          <div className="flex items-center gap-2.5">
            <span className="label-mono min-w-0 flex-1 truncate">{top}</span>
            {badged && <TierBadge tier={s.tier} hint={s.tierHint} iconOnly />}
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] text-foreground/70">
              <span className={cn("size-1.5 rounded-full", live ? "bg-emerald-300 shadow-[0_0_8px_rgb(110_231_168/0.7)]" : "bg-white/25")} aria-hidden="true" />
              {s.battery !== null && (
                <span className={cn("tabular", s.battery <= 15 && "text-destructive")} title="Battery">
                  {s.charging ? "⚡ " : ""}
                  {s.battery} %
                </span>
              )}
            </span>
          </div>
          {/* The one track is exactly the box's size, so a picture's max-height: 100% means the box, not its own height. */}
          {/* An idle device's picture fades further than its text, which stays readable (AA contrast). */}
          <div className={cn("relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center", hero ? "py-6" : "py-3", idle && "opacity-60")}>
            {/* Sound: the EQ you have on (or the headphones' picture, when one was picked); on the website, where the EQ
                lives in the desktop app, the app's icon. */}
            {desktopOnly ? (
              <AppTile size={hero ? 120 : 76} />
            ) : entry.kind === "sound" && !label.custom?.picture ? (
              <EqTileArt className="h-full max-h-[160px] w-full" />
            ) : (
            <DeviceArt
              spec={
                entry.kind === "light"
                  ? (entry.net ? netLightArt(entry.net) : lightArt(entry.lamps?.[0]?.sku ?? ""))
                  : {
                      kind: entry.kind,
                      family: entry.family,
                      name: entry.name,
                      brand,
                      picture: label.custom?.picture,
                      vid: entry.pad?.device.vid ?? (entry.lampArray?.vid || undefined),
                      pid: entry.pad?.device.pid ?? (entry.lampArray?.pid || undefined),
                      lampKind: entry.lampArray?.kind,
                    }
              }
              imgClassName={cn("drop-shadow-[0_26px_32px_rgb(0_0_0/0.55)] transition-transform duration-700 ease-fluid group-hover:scale-[1.04]", hero && "max-w-[82%]")}
            />
            )}
          </div>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <p className={cn("truncate font-semibold", hero ? "text-[30px] tracking-[-0.03em]" : "text-[19px] tracking-[-0.02em]", idle ? "text-muted-foreground" : "text-foreground")}>{entry.name}</p>
              <p className="mt-1 truncate font-mono text-[11.5px] text-muted-foreground">{statusText}</p>
            </div>
            {desktopOnly && <span className="shrink-0 rounded-full bg-white/[0.04] px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground ring-1 ring-white/[0.06]">Desktop</span>}
          </div>
        </div>
      </div>
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
    <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-black/70 py-1 pl-3 pr-1 text-[12px] text-foreground ring-1 ring-primary/40 backdrop-blur-sm" data-testid="lamp-sync-chip">
      <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" aria-hidden="true" />
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
