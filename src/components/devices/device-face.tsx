// What a device shows wherever the section pages list it (a tile, a kind card, a shelf, the spotlight): its picture,
// its status line with the dot, whether it is idle, and its one number at a glance (the active card's big value).
// Everything comes from what the probes and the device pages already keep (src/lib/keep.ts); nothing new is asked.
import { inTauri, isWeb } from "@/lib/backend";
import { summarize, type DeviceEntry } from "@/lib/device-model";
import { useKeptState } from "@/lib/keep";
import { useMouseAnswers } from "@/lib/mouse-probe";
import { useKeyboardAnswers } from "@/lib/kb/probe";
import { padLive, usePadAnswers } from "@/lib/controllers/probe";
import { ALL_LAMPS, weak } from "@/lib/lighting/models";
import { soundLabel, useSound } from "@/lib/sound";
import { useHelperReady } from "@/lib/web/use-helper";
import { AppTile } from "@/components/ui/brand";
import { EqTileArt } from "./EqTileArt";
import { DeviceArt, lightArt, netLightArt } from "./DeviceArt";
import { glanceOf } from "./ActiveCard";

/** A headset whose page read it last as switched off (its receiver answered, the headset didn't). */
export const headsetOff = (v: unknown): boolean => typeof v === "object" && v !== null && "connected" in v && !(v as { connected: boolean }).connected;

/** Whether a device is not active right now, from what the probes already know (no new checks). */
export function isIdle(e: DeviceEntry, mice: ReadonlyMap<string, string>, keyboards: ReadonlyMap<string, string>, pads: ReadonlyMap<string, "live" | "quiet">, soundState: string | undefined): boolean {
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
export function lampStatus(e: DeviceEntry): string {
  if (e.net) return e.net.paired ? "On your network" : "Needs pairing";
  const lamps = e.lamps ?? [];
  const near = lamps.filter((l) => !weak(l)).length;
  if (e.family === ALL_LAMPS) return !lamps.length || isWeb ? "One look for all of them" : near === lamps.length ? `${near} in Bluetooth range` : `${near} of ${lamps.length} in Bluetooth range`;
  // The website hears no signal strength: a lamp is listed because it was picked in this tab.
  if (isWeb) return "Added in this tab";
  return near ? "In range" : "Weak signal";
}

/** The capitals over a tile. */
export const KIND_LABEL: Record<DeviceEntry["kind"], string> = {
  mouse: "Mouse",
  keyboard: "Keyboard",
  sound: "Audio",
  controller: "Controller",
  light: "Light",
  headset: "Headset",
  monitor: "Display",
  webcam: "Webcam",
  lamparray: "Dynamic Lighting",
  rgbhub: "RGB hub",
};

export interface DeviceFace {
  brand: string;
  /** The capitals over it: the kind, or for "All lights" the count. */
  top: string;
  status: string;
  /** The dot is green. */
  live: boolean;
  /** Not active right now: it goes last and dims. */
  idle: boolean;
  /** The website's Sound tile: a pointer to the desktop app. */
  desktopOnly: boolean;
  /** The EQ is running (the Sound device). */
  eqOn: boolean;
  /** Its one number at a glance ("1600 DPI", "1.2 mm", "75%"), when the device's page has read it. */
  fact: string | null;
  /** The same as a figure: the value and its unit ("1600" and "DPI"), for a layout that sets it as a stat. */
  figure: { value: string; unit: string } | null;
  /** The headphones picked for the Sound device: their photo key (or "iems", SYNQ's drawing). */
  picture?: string | null;
}

export function useDeviceFace(entry: DeviceEntry): DeviceFace {
  const [view] = useKeptState<unknown>(entry.viewKey ?? `home.none.${entry.id}`, null);
  const mouseAnswers = useMouseAnswers();
  const kbAnswers = useKeyboardAnswers();
  const padAnswers = usePadAnswers();
  const sound = useSound();
  const label = soundLabel(sound);
  const helper = useHelperReady();
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
  const eqOn = sound.status?.state === "active";
  const idle = isIdle(entry, mouseAnswers, kbAnswers, padAnswers, sound.status?.state);
  // On the website the Sound tile is a pointer to the desktop app (browsers can't reach system audio), unless SYNQ
  // Helper is connected.
  const desktopOnly = isWeb && !helper && entry.kind === "sound";
  const live = entry.kind === "sound" ? !idle && !desktopOnly : !asleep;
  const battery = s.battery !== null ? `${s.charging ? "Charging " : ""}${s.battery}%` : null;
  const status = desktopOnly
    ? "In the desktop app"
    : entry.kind === "light"
      ? lampStatus(entry)
      : entry.kind === "sound"
        ? idle
          ? "No sound output"
          : [s.link, "Connected"].filter(Boolean).join(" · ")
        : asleep
          ? entry.kind === "controller"
            ? "No pad on this receiver"
            : "Asleep"
          : [s.link, "Connected", battery].filter(Boolean).join(" · ");
  const g = glanceOf(entry, view, sound.status ? eqOn : null, label.title);
  const figure =
    entry.kind === "mouse" || entry.kind === "keyboard"
      ? g.value
        ? { value: g.value, unit: g.unit ?? "" }
        : null
      : entry.kind === "sound"
        ? eqOn
          ? { value: "On", unit: "EQ" }
          : null
        : s.battery !== null
          ? { value: String(s.battery), unit: "%" }
          : null;
  const fact = !figure ? null : entry.kind === "sound" ? "EQ on" : figure.unit === "%" ? `${figure.value}%` : `${figure.value} ${figure.unit}`;
  return {
    brand,
    top: entry.family === ALL_LAMPS ? brand : KIND_LABEL[entry.kind],
    status,
    live,
    idle,
    desktopOnly,
    eqOn,
    fact,
    figure,
    picture: entry.kind === "sound" ? label.custom?.picture : undefined,
  };
}

/** The device's picture: its product photo (or drawing), the EQ curve for the Sound device, the app's icon for the website's. */
export function FaceArt({ entry, face, className, imgClassName, appTile = 88 }: { entry: DeviceEntry; face: DeviceFace; className?: string; imgClassName?: string; appTile?: number }) {
  if (face.desktopOnly) return <AppTile size={appTile} />;
  if (entry.kind === "sound" && !face.picture) return <EqTileArt className="h-full max-h-[170px] w-full" />;
  return (
    <DeviceArt
      className={className}
      spec={
        entry.kind === "light"
          ? entry.net
            ? netLightArt(entry.net)
            : lightArt(entry.lamps?.[0]?.sku ?? "")
          : {
              kind: entry.kind,
              family: entry.family,
              // The full name when it is the shown one plus an edition ("... ZywOo"); a receiver's name says nothing.
              name: entry.reported && entry.reported.length > entry.name.length && entry.reported.toLowerCase().includes(entry.name.toLowerCase()) ? entry.reported : entry.name,
              brand: face.brand,
              picture: face.picture,
              vid: entry.pad?.device.vid ?? (entry.lampArray?.vid || undefined),
              pid: entry.pad?.device.pid ?? (entry.lampArray?.pid || undefined),
              lampKind: entry.lampArray?.kind,
            }
      }
      imgClassName={imgClassName}
    />
  );
}
