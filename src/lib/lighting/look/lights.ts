// Every light SYNQ can drive, from all four sources, as one list (wave L5, "one look everywhere"): Govee lamps over
// Bluetooth, Wi-Fi lights found on the network, Windows Dynamic Lighting devices, and USB RGB hubs (each hub one light:
// the channels chosen on its page). Pure: the hooks that gather the sources live with the Lights view.
import type { NetDevice } from "../net/brands.ts";
import type { LampArrayDevice } from "../lamparray.ts";
import { FAMILIES, type HubModel } from "../hidrgb/protocol.ts";
import { LIGHT_MODELS, NET_MAKERS, lampTitle, netKey, type LampInfo } from "../models.ts";

export type Source = "govee" | "wifi" | "lamparray" | "hub";

export type LightRef =
  | { key: string; source: "govee"; name: string; detail: string; lamp: LampInfo }
  | { key: string; source: "wifi"; name: string; detail: string; device: NetDevice }
  | { key: string; source: "lamparray"; name: string; detail: string; device: LampArrayDevice }
  | { key: string; source: "hub"; name: string; detail: string; family: string; model: HubModel };

/** How a Dynamic Lighting device is attached, from Windows' device interface id (null when the id doesn't say). */
export function lampArrayLink(id: string): "USB" | "Bluetooth" | null {
  // HID over Bluetooth (classic, 0x1124, or LE, 0x1812) names its service; a USB device names its vendor id.
  if (/HID#\{0000(1124|1812)-0000-1000-8000-00805f9b34fb\}/i.test(id)) return "Bluetooth";
  if (/HID#VID_/i.test(id)) return "USB";
  return null;
}

/**
 * The lights in one list, in source order (Govee, Wi-Fi, Dynamic Lighting, hubs), each with a key that stays the same
 * and a detail line saying its maker and how it is reached, each once ("NZXT · USB", "Philips Hue · Wi-Fi").
 */
export function lightRefs(
  lamps: readonly LampInfo[],
  net: readonly NetDevice[],
  lampArrays: readonly LampArrayDevice[],
  hubs: readonly { family: string; model: HubModel }[],
): LightRef[] {
  return [
    ...lamps.map((l): LightRef => ({ key: `govee:${l.id}`, source: "govee", name: lampTitle(l), detail: `${LIGHT_MODELS[l.sku]?.brand ?? "Govee"} ${l.sku} · Bluetooth`, lamp: l })),
    // A Hue bridge that isn't paired yet is not a light (its lights are, once it is).
    ...net.filter((d) => d.paired && !(d.brand === "hue" && !d.sub)).map((d): LightRef => ({ key: `wifi:${netKey(d)}`, source: "wifi", name: d.name, detail: `${NET_MAKERS[d.brand]} · Wi-Fi`, device: d })),
    ...lampArrays.map((a): LightRef => ({ key: `dl:${a.id}`, source: "lamparray", name: a.name || "Dynamic Lighting device", detail: ["Dynamic Lighting", lampArrayLink(a.id)].filter(Boolean).join(" · "), device: a })),
    ...hubs.map((h): LightRef => ({ key: `hub:${h.family}`, source: "hub", name: h.model.name, detail: `${FAMILIES[h.model.family]?.brand ?? "USB RGB hub"} · USB`, family: h.family, model: h.model })),
  ];
}

/** Why a light can't follow the screen (null: it can). */
export function cantSync(r: LightRef): string | null {
  if (r.source === "lamparray") return "Dynamic Lighting devices follow the app in front, so they can't follow the screen.";
  if (r.source === "wifi" && r.device.brand === "yeelight") return "Yeelight takes about one change a second, too few to follow the screen.";
  if (r.source === "wifi" && r.device.brand === "elgato" && !/strip/i.test(r.device.model)) return "A Key Light shows white only.";
  return null;
}
