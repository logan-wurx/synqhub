// The one place that decides what picture a device gets, for the Devices home cards, the Overview of every
// device and the little pictures in the switchers:
//
//   1. SYNQ's own renders (the hand-made ones for the developer's devices, src/assets/brand)
//   2. the maker's product photo (src/assets/devices, loaded only when the device is shown)
//   3. a keyboard drawn from its key layout, or a silhouette for anything else
//
// Product images are (c) their respective owners (src/assets/devices/SOURCES.json).
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { isSuperlight2 } from "@/lib/device-names";
import { photoKeyFor } from "@/lib/device-images";
import { loadDeviceImage } from "@/lib/device-images.generated";
import { lampArrayDrawnAs, shapeClass, keyboardForm, type ShapeClass } from "@/lib/device-shape";
import { formGeometry, type RenderGeometry } from "@/lib/keyboard-geometry";
import { keyboardGeometry } from "@/lib/keyboard-art";
import { deviceIems, deviceKeyboard, deviceKeyboardX68, deviceMouse, deviceMouseAtk, deviceMouseSuperlight2, modelRender } from "@/components/ui/brand";
import { Silhouette } from "@/components/ui/silhouettes";
import { KeyboardRender } from "@/components/ui/keyboard-render";
import { LIGHT_MODELS, NET_MAKERS, netModel, type NetLightInfo } from "@/lib/lighting/models";

export interface ArtSpec {
  kind: "mouse" | "keyboard" | "sound" | "controller" | "light" | "headset" | "monitor" | "webcam" | "lamparray" | "rgbhub";
  /** The navigation family of the device ("logitech", "atk", "falchion", "x68", "om:<vid>:<pid>", "kb:<vid>:<pid>"). */
  family?: string | null;
  vid?: string | null;
  pid?: string | null;
  /** The name it reports, or the name a panel read from it. */
  name: string;
  /** The maker, when a driver knows it. */
  brand?: string | null;
  /** A light's form, from its model's row: what to draw when it has no picture. */
  form?: string | null;
  /** A Dynamic Lighting device: Windows' LampArrayKind, which picks its drawing. */
  lampKind?: number | null;
  /** The sound card's own picture ("iems"). */
  picture?: "iems" | null;
}

/** A light's picture: found by maker and model ("Govee H6076"), drawn by its form when there is none. */
export function lightArt(sku: string): ArtSpec {
  const m = LIGHT_MODELS[sku];
  return { kind: "light", name: `${m?.brand ?? ""} ${sku}`, brand: m?.brand ?? "", form: m?.kind };
}

/** A Wi-Fi light's picture: by maker and model ("Elgato Key Light"); drawn as a strip, panels or a bulb until it has one. */
export function netLightArt(d: Pick<NetLightInfo, "brand" | "model">): ArtSpec {
  const maker = NET_MAKERS[d.brand];
  const form = /strip|stripe/i.test(d.model) ? "strip" : d.brand === "nanoleaf" ? "panel" : null;
  return { kind: "light", name: `${maker} ${netModel(d)}`, brand: maker, form };
}

/** vid and pid from a family id like "om:3367:1961" or "kb:1ca6:1b10". */
function idsOf(s: ArtSpec): { vid: string | null; pid: string | null } {
  if (s.vid && s.pid) return { vid: s.vid, pid: s.pid };
  const m = s.family?.match(/^(?:(?:om|kb):)?([0-9a-f]{4}):([0-9a-f]{4})/i);
  return { vid: m?.[1] ?? null, pid: m?.[2] ?? null };
}

/** SYNQ's own renders: the developer's devices, and any per-model render dropped in src/assets/brand/models. */
export function handmadeArt(s: ArtSpec): string | null {
  if (s.kind === "sound") return s.picture === "iems" ? deviceIems : null;
  if (s.kind === "controller" || s.kind === "light") return null;
  if (s.kind === "mouse") {
    // The developer's two Logitechs have renders of their own; another Logitech uses its photo, and one whose model isn't
    // known yet keeps the default render, as before.
    if (s.family === "logitech") return isSuperlight2(s.name) ? deviceMouseSuperlight2 : /DEX/i.test(s.name) || !photoKeyOf(s) ? deviceMouse : null;
    if (s.family === "atk") return deviceMouseAtk;
    return modelRender(s.brand ?? "", s.name);
  }
  if (s.family === "falchion") return deviceKeyboard;
  if (s.family === "x68") return deviceKeyboardX68;
  return null;
}

/** The product photo's key, when the maker's picture of this device is bundled. */
export function photoKeyOf(s: ArtSpec): string | null {
  if (s.kind === "sound") return null;
  // A Dynamic Lighting device that is also a device SYNQ has a picture of (same USB id): that picture, whatever its kind.
  if (s.kind === "lamparray") return s.vid && s.pid ? photoKeyFor({ vid: s.vid, pid: s.pid, name: s.name }) : null;
  // RGB hubs have lighting-group pictures by USB id.
  const { vid, pid } = idsOf(s);
  // Controllers' photos are matched as kind "gamepad" (the controller-photos branch adds them); otherwise a drawn gamepad.
  if (s.kind === "controller") return photoKeyFor({ kind: "gamepad", vid, pid, name: s.name, brand: s.brand });
  // Lamps are found by the model in their Bluetooth name (the art's name is "Govee H6076").
  if (s.kind === "light") return photoKeyFor({ kind: "light", name: s.name, brand: s.brand });
  if (s.kind === "rgbhub") return photoKeyFor({ kind: "light", vid, pid, name: s.name, brand: s.brand });
  // Monitors too, by their EDID name: their "vid" is the EDID maker code ("aoc"), which must never be read as a USB id.
  if (s.kind === "monitor") return photoKeyFor({ kind: "monitor", name: s.name, brand: s.brand });
  return photoKeyFor({ kind: s.kind, vid, pid, name: s.name, brand: s.brand });
}

const urls = new Map<string, Promise<string | null>>();
const load = (key: string) => {
  let p = urls.get(key);
  if (!p) urls.set(key, (p = loadDeviceImage(key).catch(() => null)));
  return p;
};

export type Art = { type: "image"; src: string; photo: boolean } | { type: "keyboard"; geometry: RenderGeometry } | { type: "silhouette"; shape: ShapeClass } | { type: "pending" };

/** The picture to show right now, and the better one once it has loaded. */
export function useDeviceArt(s: ArtSpec): Art {
  const handmade = handmadeArt(s);
  const key = handmade ? null : photoKeyOf(s);
  const [photo, setPhoto] = useState<{ key: string; src: string | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    load(key).then((src) => live && setPhoto({ key, src }));
    return () => {
      live = false;
    };
  }, [key]);

  const { vid, pid } = idsOf(s);
  // A Dynamic Lighting keyboard is drawn like any keyboard (its own layout when SYNQ knows its USB id).
  const keyboardLike = s.kind === "keyboard" || (s.kind === "lamparray" && lampArrayDrawnAs(s.lampKind) === "keyboard");
  const wantsGeometry = keyboardLike && !handmade && !key;
  const [geo, setGeo] = useState<{ id: string; g: RenderGeometry } | null>(null);
  const geoId = `${vid ?? ""}:${pid ?? ""}|${s.name}`;
  useEffect(() => {
    if (!wantsGeometry) return;
    let live = true;
    keyboardGeometry({ vid, pid, name: s.name }).then((g) => live && setGeo({ id: geoId, g }));
    return () => {
      live = false;
    };
  }, [wantsGeometry, geoId, vid, pid, s.name]);

  if (handmade) return { type: "image", src: handmade, photo: false };
  if (key) {
    if (photo?.key === key && photo.src) return { type: "image", src: photo.src, photo: true };
    // Still loading: say nothing yet rather than flash a drawing and swap it. A picture that failed to load falls through.
    if (!(photo?.key === key && photo.src === null)) return { type: "pending" };
  }
  if (keyboardLike) return { type: "keyboard", geometry: geo?.id === geoId ? geo.g : formGeometry(keyboardForm(s.name)) };
  return { type: "silhouette", shape: shapeClass({ kind: s.kind, name: s.name, brand: s.brand, form: s.form, lampKind: s.lampKind }) };
}

/** A device's picture, sized by its container: it never grows past it. */
export function DeviceArt({ spec, className, imgClassName }: { spec: ArtSpec; className?: string; imgClassName?: string }) {
  const art = useDeviceArt(spec);
  const [shown, setShown] = useState(false);
  if (art.type === "pending") return <span className={cn("block", className)} aria-hidden="true" />;
  if (art.type === "image")
    return (
      <img
        src={art.src}
        alt=""
        draggable={false}
        onLoad={() => setShown(true)}
        className={cn("pointer-events-none max-h-full max-w-full select-none object-contain transition-opacity duration-500", art.photo && !shown ? "opacity-0" : "opacity-100", className, imgClassName)}
      />
    );
  if (art.type === "keyboard") return <KeyboardRender geometry={art.geometry} className={cn("h-full w-full max-h-full max-w-full opacity-90", className)} />;
  return <Silhouette shape={art.shape} className={cn("h-[88%] w-auto max-w-full opacity-80", className)} />;
}

/** The small picture beside a device's name in a switcher. */
export function DeviceThumb({ spec, className }: { spec: ArtSpec; className?: string }) {
  return (
    <span className={cn("grid h-5 w-8 shrink-0 place-items-center opacity-90", className)} aria-hidden="true">
      <DeviceArt spec={spec} className="max-h-5 max-w-8" />
    </span>
  );
}
