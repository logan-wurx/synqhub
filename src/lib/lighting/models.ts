// The lamps SYNQ knows, as plain data the Devices home can use without loading any lamp code: the models it
// drives (the generated Govee table), how a lamp is named on its card, the signal below which a connection is unlikely,
// and the preview's simulated lights. Nothing here talks to a lamp.
import { GOVEE_MODELS } from "./govee/models.generated.ts";

export interface LampInfo {
  /** The Bluetooth address, 12 hex digits. */
  id: string;
  /** The advertised name (`Govee_H6076_7A21`). */
  name: string;
  /** The model from the name. */
  sku: string;
  rssi: number;
  /** The settled weak-signal state (src/lib/lighting/lamps.ts: a median of recent readings, with a margin each way), so a
   * lamp near the line doesn't flip with every reading. Absent: judged from `rssi` alone. */
  weak?: boolean;
  /** Milliseconds since the scan last heard it. */
  heardMs: number;
  /** Screen sync is running on it (it then stays connected without its page). */
  sync?: SyncInfo | null;
}

/** Which part of the screen a lamp follows in screen sync (src-tauri/src/lighting/screen.rs `Edge`). */
export type SyncEdge = "left" | "right" | "both" | "full";
export interface SyncInfo {
  edge: SyncEdge;
  vivid: boolean;
  /** The display read (its id from src/lib/lighting/monitors.ts); null: the primary. */
  monitor?: string | null;
}

/** The models SYNQ drives (the bridge lists and opens only these: src-tauri/src/lighting/govee/catalogue.rs MODELS). */
export const LIGHT_MODELS: Readonly<Record<string, { brand: string; name: string; kind: string; segments: number }>> = Object.fromEntries(
  Object.values(GOVEE_MODELS).map((m) => [m.sku, { brand: "Govee", name: m.name, kind: m.kind, segments: m.segments }]),
);

/** The Wi-Fi lights' makers (wave L3: src/lib/lighting/net), by brand. */
export const NET_MAKERS = { hue: "Philips Hue", nanoleaf: "Nanoleaf", elgato: "Elgato", twinkly: "Twinkly", wiz: "WiZ", yeelight: "Yeelight", lifx: "LIFX" } as const;

/** A Wi-Fi light as the Devices home lists it (src/lib/lighting/net/brands.ts `NetDevice`). */
export interface NetLightInfo {
  brand: keyof typeof NET_MAKERS;
  id: string;
  name: string;
  model: string;
  paired: boolean;
  /** A Hue light's number on its bridge. */
  sub?: string;
}

/** A Wi-Fi light's id on the page: `net~<brand>~<id>`, and `~<n>` for a light behind a Hue bridge. */
export const netKey = (d: Pick<NetLightInfo, "brand" | "id" | "sub">) => `net~${d.brand}~${d.id}${d.sub ? `~${d.sub}` : ""}`;
export const isNetKey = (id: string) => id.startsWith("net~");
/** A Wi-Fi light's model without its maker in front ("Key Light", not "Elgato Key Light"). */
export const netModel = (d: Pick<NetLightInfo, "brand" | "model">) => d.model.replace(new RegExp(`^${NET_MAKERS[d.brand]}\\s+`, "i"), "");

/** What a page calls a model: "lamp" for a floor or table lamp, "light" for everything else (strips, bars, panels). */
export const nounOf = (sku: string): "lamp" | "light" => (LIGHT_MODELS[sku]?.kind.endsWith("lamp") ? "lamp" : "light");
/** "lamp" when every one is a lamp, else "light" (the group is "All lamps" or "All lights"). */
export const groupNoun = (lamps: readonly Pick<LampInfo, "sku">[]): "lamp" | "light" => (lamps.length > 0 && lamps.every((l) => nounOf(l.sku) === "lamp") ? "lamp" : "light");

/** Every light at once: the Devices home's "All lights" card and the Lights view (wave L5). */
export const ALL_LAMPS = "all";
/** Every Govee lamp at once with all of a lamp's tabs (scenes, effects, music), mirrored to each: from the Lights view. */
export const GOVEE_TOGETHER = "together";

/** How loud a lamp has to be heard for a connection to be worth trying (the weak lamp sits around -94 dBm). */
export const WEAK_RSSI = -92;
export const weak = (l: Pick<LampInfo, "rssi" | "weak">) => l.weak ?? l.rssi < WEAK_RSSI;

/** "Floor Lamp 7A21": the model and the end of its Bluetooth name, so two of the same lamp are told apart. */
export function lampTitle(l: Pick<LampInfo, "name" | "sku">): string {
  const parts = l.name.split("_");
  const tail = parts[parts.length - 1] ?? "";
  return `${LIGHT_MODELS[l.sku]?.name ?? "Lamp"}${/^[0-9A-F]{4}$/i.test(tail) ? ` ${tail.toUpperCase()}` : ""}`;
}

export interface SimLampSpec {
  id: string;
  name: string;
  rssi: number;
  /** The weak lamp: heard, but a connection doesn't come up. */
  reachable: boolean;
  /** A model the table doesn't know the segments or the dialect of: what this one turns out to have. */
  segments?: number;
  dialect?: number;
}

/**
 * The browser preview's and the end-to-end build's lights: the developer's two floor lamps (one in reach, one usually out
 * of range), a TV backlight (0x15, 15 segments) and light bars the table knows little about (they report 0x0b and 10
 * segments themselves).
 */
export const SIM_LAMPS: readonly SimLampSpec[] = [
  { id: "a4c138127a21", name: "Govee_H6076_7A21", rssi: -87, reachable: true },
  { id: "a4c13813b308", name: "Govee_H6076_B308", rssi: -94, reachable: false },
  { id: "a4c138197a1c", name: "Govee_H6199_7A1C", rssi: -71, reachable: true },
  { id: "a4c1380e2b9d", name: "ihoment_H6046_2B9D", rssi: -78, reachable: true, segments: 10, dialect: 0x0b },
];
