// What the Devices home shows for each connected device: one entry per mouse, keyboard and the sound
// output, with the capabilities and support tier worked out from what is already known. Everything
// here is a pure function of the detected list plus the views the panels keep (src/lib/keep.ts); it
// never opens a device, so the home costs no device I/O.
import type { Connected } from "./backend";
import { mouseFamilies, familyOf } from "./mouse-family";
import { keyboardFamilies, keyboardFamilyOf } from "./kb/probe";
import { headsetId, keyboardId, monitorId, mouseId, padId, SOUND_ID, webcamId } from "./nav";
import { findHeadset, settingsOf } from "./headsets/protocol";
import type { KbTier } from "./kb/types";
import { identifyConnected, type PadIdentity } from "./controllers/identify";
import { ALL_LAMPS, LIGHT_MODELS, NET_MAKERS, groupNoun, lampTitle, netKey, type LampInfo, type NetLightInfo } from "./lighting/models";
import { hubId, lampArrayId, lightId } from "./nav";
import { findHub, findIdentifyOnly, FAMILIES } from "./lighting/hidrgb/protocol";
import type { LampArrayDevice } from "./lighting/lamparray";

export type DeviceKind = "mouse" | "keyboard" | "sound" | "controller" | "light" | "headset" | "monitor" | "webcam" | "lamparray" | "rgbhub";

/** What a device can do, as small icons on its card. */
export type CapId =
  | "dpi"
  | "polling"
  | "lod"
  | "battery"
  | "tracking"
  | "buttons"
  | "lighting"
  | "analog"
  | "rapid"
  | "remap"
  | "advanced"
  | "profiles"
  | "eq"
  | "presets"
  | "engine"
  // Controllers (CONTROLLERS.md §7): sticks, triggers, haptics, motion, the link, the live tester.
  | "sticks"
  | "triggers"
  | "haptics"
  | "motion"
  | "link"
  | "live"
  // Lamps (LIGHTING.md): colour and white, segments, scenes, music.
  | "colour"
  | "segments"
  | "scenes"
  | "music"
  // Headsets: what you hear of your own voice, the mic's light.
  | "sidetone"
  | "mic"
  // Monitors and webcams: the picture (brightness, contrast, colour), the input, the camera's own controls.
  | "picture"
  | "input"
  | "camera";

export interface DeviceEntry {
  /** The id used by the navigation (`mouse:atk`, `kb:falchion`, `sound`). */
  id: string;
  kind: DeviceKind;
  family: string;
  name: string;
  brand: string;
  /** How the detected list says it is attached ("USB cable", "8K receiver"). */
  connection: string;
  /** A mouse's or keyboard's own full name, when the shown one is shortened ("ROG Falchion Ace HFX ZywOo" for
   * "Falchion Ace HFX"): its photo is found by this, so an edition gets its own picture. */
  reported?: string;
  /** The kept-state key of the panel's view, once the panel has read the device. */
  viewKey: string | null;
  /** A controller: what it is and the listed device behind it. */
  pad?: { identity: PadIdentity; device: Connected };
  /** A monitor or webcam: what the bridge opens it by. */
  path?: string;
  /** A light the Bluetooth scan heard; "All lamps" (or "All lights") carries every one. */
  lamps?: readonly LampInfo[];
  /** A Wi-Fi light discovery found. */
  net?: NetLightInfo;
  /** A Dynamic Lighting device: Windows' LampArrayKind (its drawing) and its USB ids (its photo, when SYNQ has one). */
  lampArray?: { kind: number; vid: string; pid: string };
}

export interface Summary {
  caps: CapId[];
  tier: KbTier;
  tierHint?: string;
  /** "Wired" / "Wireless", when known. */
  link: "Wired" | "Wireless" | null;
  battery: number | null;
  charging: boolean;
}

const SHORT_KEYBOARD: Record<string, string> = { falchion: "Falchion Ace HFX", x68: "X68 HE" };
const BRAND: Record<string, string> = { logitech: "Logitech", atk: "ATK", falchion: "ASUS ROG", x68: "MAGIC-REFINER" };

/** EDID maker ids (PNP) of the common monitor makers. */
const MONITOR_MAKERS: Record<string, string> = { aus: "ASUS", del: "Dell", gsm: "LG", sam: "Samsung", aoc: "AOC", bnq: "BenQ", acr: "Acer", msi: "MSI", gbt: "Gigabyte", hpn: "HP", lgd: "LG", vsc: "ViewSonic", phl: "Philips", lnv: "Lenovo", ivm: "iiyama" };

const deDongle = (name: string) => name.replace(/\s+(4K|8K)?\s*(Dongle|Receiver)$/i, "").replace(/\s+(Keyboard)$/i, "");

/** The brand a detected device carries, from the driver that claimed it or the vendor id. */
function brandOf(d: Connected | undefined, family: string): string {
  if (BRAND[family]) return BRAND[family];
  return d?.brand ?? "";
}

export function buildEntries(
  devices: readonly Connected[],
  published: ReadonlyMap<string, string>,
  soundName: string,
  lamps: readonly LampInfo[] = [],
  lampArrays: readonly LampArrayDevice[] = [],
  net: readonly NetLightInfo[] = [],
): DeviceEntry[] {
  const out: DeviceEntry[] = [];
  for (const family of mouseFamilies(devices)) {
    const d = devices.find((x) => familyOf(x) === family);
    const name =
      family === "logitech" ? (published.get("logitech") ?? d?.name ?? "Logitech mouse") : family === "atk" ? "X1 V2 Air+" : deDongle(d?.name ?? "Mouse");
    const key = family.startsWith("om:") ? `mouse.om.${family.slice(3)}` : `mouse.${family}`;
    out.push({ id: mouseId(family), kind: "mouse", family, name, brand: brandOf(d, family), connection: d?.connection ?? "", viewKey: `${key}.view`, reported: d?.name });
  }
  for (const family of keyboardFamilies(devices)) {
    const d = devices.find((x) => keyboardFamilyOf(x) === family);
    const name = SHORT_KEYBOARD[family] ?? deDongle(d?.name ?? "Keyboard");
    const key = family.startsWith("kb:") ? `keyboard.kb.${family.slice(3)}` : `keyboard.${family}`;
    out.push({ id: keyboardId(family), kind: "keyboard", family, name, brand: brandOf(d, family), connection: d?.connection ?? "", viewKey: `${key}.view`, reported: d?.name });
  }
  // Controllers: one card for each one plugged in (two of the same model get their own family).
  const seen = new Map<string, number>();
  for (const d of devices) {
    const identity = identifyConnected(d);
    if (!identity) continue;
    const n = (seen.get(identity.family) ?? 0) + 1;
    seen.set(identity.family, n);
    const family = n > 1 ? `${identity.family}~${n}` : identity.family;
    out.push({ id: padId(family), kind: "controller", family, name: identity.name, brand: identity.brand, connection: d.connection, viewKey: `pad.${family}.view`, pad: { identity, device: d } });
  }
  // Gaming headsets (src/lib/headsets): one card each.
  for (const d of devices) {
    if (d.kind !== "headset") continue;
    const family = `${d.vid}:${d.pid}`;
    const model = findHeadset(d.vid, d.pid);
    const brand = { "1038": "SteelSeries", "046d": "Logitech", "03f0": "HyperX" }[d.vid] ?? d.brand ?? "";
    out.push({ id: headsetId(family), kind: "headset", family, name: model ? model.name : d.name, brand, connection: d.connection, viewKey: `headset.${family}.view` });
  }
  // Monitors and webcams: one card each (two of the same model get their own family).
  const twins = new Map<string, number>();
  for (const d of devices) {
    if ((d.kind !== "monitor" && d.kind !== "webcam") || !d.path) continue;
    const base = `${d.vid}:${d.pid}`;
    const n = (twins.get(`${d.kind}:${base}`) ?? 0) + 1;
    twins.set(`${d.kind}:${base}`, n);
    const family = n > 1 ? `${base}~${n}` : base;
    const id = d.kind === "monitor" ? monitorId(family) : webcamId(family);
    const brand = d.kind === "monitor" ? (MONITOR_MAKERS[d.vid] ?? d.vid.toUpperCase()) : (d.brand ?? "");
    out.push({ id, kind: d.kind, family, name: d.name, brand, connection: d.connection, viewKey: `${d.kind}.${family}.view`, path: d.path });
  }
  // Lights: one card each.
  for (const l of lamps) {
    out.push({ id: lightId(l.id), kind: "light", family: l.id, name: lampTitle(l), brand: LIGHT_MODELS[l.sku]?.brand ?? "", connection: "Bluetooth", viewKey: null, lamps: [l] });
  }
  for (const d of net) out.push({ id: lightId(netKey(d)), kind: "light", family: netKey(d), name: d.name, brand: NET_MAKERS[d.brand], connection: "Wi-Fi", viewKey: null, net: d });
  // The Lights view (wave L5): every light at once, whatever drives it. "All lamps" while they are all Govee lamps.
  const lights = lamps.length + net.filter((d) => d.paired && !(d.brand === "hue" && !d.sub)).length + lampArrays.length + devices.filter((d) => d.kind === "rgbhub" && findHub(d.vid, d.pid)).length;
  if (lights > 1) {
    const noun = lights === lamps.length ? groupNoun(lamps) : "light";
    const how = [lamps.length && "Bluetooth", net.length && "Wi-Fi", (lampArrays.length || devices.some((d) => d.kind === "rgbhub")) && "USB"].filter(Boolean).join(" · ");
    out.push({ id: lightId(ALL_LAMPS), kind: "light", family: ALL_LAMPS, name: `All ${noun}s`, brand: `${lights} ${noun}s`, connection: how, viewKey: null, lamps });
  }
  // Windows Dynamic Lighting devices and USB RGB hubs (wave L4).
  for (const a of lampArrays)
    out.push({ id: lampArrayId(a.id), kind: "lamparray", family: a.id, name: a.name || "Dynamic Lighting device", brand: "Dynamic Lighting", connection: "", viewKey: null, lampArray: { kind: a.kind ?? -1, vid: a.vid ?? "", pid: a.pid ?? "" } });
  for (const d of devices) {
    if (d.kind !== "rgbhub") continue;
    const family = `${d.vid}:${d.pid}`;
    const hub = findHub(d.vid, d.pid);
    const only = findIdentifyOnly(d.vid, d.pid);
    out.push({ id: hubId(family), kind: "rgbhub", family, name: hub?.name ?? only?.name ?? d.name, brand: hub ? FAMILIES[hub.family].brand : "", connection: d.connection, viewKey: null });
  }
  out.push({ id: SOUND_ID, kind: "sound", family: "sound", name: soundName, brand: "Sound output", connection: "", viewKey: null });
  return out;
}

/** The controllers among the listed devices, as the Devices home and the Controller page name them. */
export function controllerEntries(devices: readonly Connected[]): DeviceEntry[] {
  return buildEntries(devices, new Map(), "").filter((e) => e.kind === "controller");
}

/** "USB cable" / "8K receiver" / "Bluetooth" -> Wired or Wireless. */
export function linkOf(text: string | null | undefined): "Wired" | "Wireless" | null {
  if (!text) return null;
  if (/receiver|dongle|wireless|2\.4|bluetooth|lightspeed|bt\b/i.test(text)) return "Wireless";
  if (/cable|usb|wired/i.test(text)) return "Wired";
  return null;
}

// The shapes below are the parts of each panel's kept view that the home reads. They are written
// out here (not imported) so this file stays free of the panels and their drivers.
interface MouseLike {
  connection?: string | null;
  batteryPercent?: number | null;
  charging?: boolean | null;
  batteryState?: string;
  tier?: KbTier;
  showBattery?: boolean;
  polling?: unknown;
  lod?: unknown;
  lighting?: unknown;
  magnetic?: unknown;
  debounce?: unknown;
  toggles?: unknown[];
  stages?: unknown;
  dpi?: unknown;
}
interface KbLike {
  tier?: KbTier;
  tierWhy?: string;
  info?: { connection?: string };
  analog?: { fields?: Record<string, unknown> };
  keymap?: unknown;
  lighting?: unknown;
  profiles?: unknown;
  advanced?: unknown;
  polling?: unknown;
}

/** Capabilities, tier and live numbers for one entry, from its kept view (null before the panel read it). */
export function summarize(e: DeviceEntry, view: unknown): Summary {
  const base = { link: linkOf(e.connection), battery: null as number | null, charging: false };
  if (e.kind === "sound") return { ...base, caps: ["eq", "presets", "engine"], tier: "verified", tierHint: "The EQ engine has been run and checked on this PC." };
  if (e.kind === "light" && e.net)
    return { link: null, battery: null, charging: false, caps: ["colour"], tier: "experimental", tierHint: `Sent exactly as ${e.brand}'s own local API describes; not yet seen on a real light.` };
  if (e.kind === "light")
    return {
      link: null,
      battery: null,
      charging: false,
      caps: ["colour", "segments", "scenes", "music"],
      tier: "experimental",
      tierHint: "Power, brightness and colour have been seen on the developer's lamp; segments, scenes and music are sent exactly as the references describe and are being checked.",
    };

  if (e.kind === "controller" && e.pad) {
    const { identity, device } = e.pad;
    const c = identity.caps;
    const caps: CapId[] = [];
    if (c.sticks) caps.push("sticks");
    if (c.triggers) caps.push("triggers");
    // The rumble test: Sony's, Nintendo's and GameSir's pads whose motors are mapped.
    if (c.rumble && ["ds5", "edge", "ds4", "switch", "gamesir-cyclone2", "gamesir-g7pro8k", "8bitdo", "flydigi"].includes(identity.guard)) caps.push("haptics");
    if (c.gyro) caps.push("motion");
    caps.push("link");
    if (identity.support !== "detect") caps.push("live");
    const v = view as { batteryPercent?: number | null; charging?: boolean } | null;
    const xb = device.pad?.battery;
    const battery = typeof v?.batteryPercent === "number" ? v.batteryPercent : xb && xb[0] !== "wired" && xb[0] !== "disconnected" ? [0, 33, 66, 100][xb[1]] ?? null : null;
    const receiver = /dongle|receiver|adapter|puck/i.test(identity.personality ?? "");
    const link = device.pad?.via === "xinput" ? (device.connection === "Wireless" ? "Wireless" : "Wired") : receiver ? "Wireless" : linkOf(device.connection);
    if (identity.support === "detect") return { link, battery, charging: false, caps, tier: "read-only", tierHint: "SYNQ can only name this pad here; nothing is read or sent." };
    if (identity.guard.startsWith("gamesir-") || identity.guard === "8bitdo" || identity.guard === "flydigi")
      return { link, battery, charging: !!v?.charging, caps, tier: "experimental", tierHint: "The tester reads it; its settings are written only while Allow changes is on, after a full backup, and each one is read back." };
    if (identity.guard === "scuf")
      return { link, battery, charging: !!v?.charging, caps, tier: "read-only", tierHint: "The tester reads it, and SYNQ asks it (and its receiver) for firmware, battery and which pad is connected. Nothing is changed on the pad." };
    if (identity.guard === "edge")
      return { link, battery, charging: !!v?.charging, caps, tier: "experimental", tierHint: "The tester reads it; its profiles are written only while Allow changes is on, after a full backup, and read back. Tests are sent only when you click them." };
    if (identity.guard !== "input")
      return { link, battery, charging: !!v?.charging, caps, tier: "experimental", tierHint: "The tester reads it; its lights, rumble and trigger tests are sent only when you click them, and don't stay on the pad." };
    return { link, battery, charging: !!v?.charging, caps, tier: "read-only", tierHint: "Tester only: SYNQ reads this pad and sends it nothing." };
  }

  if (e.kind === "mouse") {
    const v = view as (MouseLike & Record<string, unknown>) | null;
    const link = (v?.connection === "Wired" || v?.connection === "Wireless" ? v.connection : linkOf(v?.connection ?? e.connection)) ?? base.link;
    const battery = v && typeof v.batteryPercent === "number" ? v.batteryPercent : null;
    const charging = !!v && (v.charging === true || (typeof v.batteryState === "string" && /charg/i.test(v.batteryState) && !/discharg/i.test(v.batteryState)));
    if (e.family === "logitech") return { link, battery, charging, caps: ["dpi", "polling", "lod", "battery"], tier: "verified" };
    if (e.family === "atk") return { link, battery, charging, caps: ["dpi", "polling", "lod", "tracking", "buttons", "battery"], tier: "verified" };
    if (!v) return { link, battery, charging, caps: ["dpi", "polling"], tier: "read-only", tierHint: "Open it to see what SYNQ can read and change on this mouse." };
    const caps: CapId[] = [];
    if (v.dpi || v.stages) caps.push("dpi");
    if (v.polling) caps.push("polling");
    if (v.lod) caps.push("lod");
    if (v.toggles?.length) caps.push("tracking");
    if (v.debounce || v.magnetic) caps.push("buttons");
    if (v.lighting) caps.push("lighting");
    if (v.showBattery) caps.push("battery");
    return { link, battery: v.showBattery ? battery : null, charging, caps, tier: v.tier ?? "read-only" };
  }

  if (e.kind === "monitor") {
    return { ...base, link: null, caps: ["picture", "input"], tier: "experimental", tierHint: "DDC/CI is the monitors' standard way to be set, but SYNQ hasn't been tried on this one. Reads are free; a change waits for Allow changes, with a backup first." };
  }
  if (e.kind === "lamparray") {
    return { ...base, link: null, caps: ["colour"], tier: "experimental", tierHint: "Windows' own Dynamic Lighting standard. Windows gives these lights only to the app in front, so SYNQ sets them while it is open and in front." };
  }
  if (e.kind === "rgbhub") {
    const [vid, pid] = e.family.split(":");
    if (!findHub(vid, pid)) return { ...base, link: null, caps: [], tier: "read-only", tierHint: "SYNQ knows this device and sends it nothing: no open project documents how to drive it." };
    return { ...base, link: null, caps: ["colour"], tier: "experimental", tierHint: "From the protocol OpenRGB documents; SYNQ hasn't been tried on this hub. One colour per channel, sent once you allow changes." };
  }
  if (e.kind === "webcam") {
    return { ...base, link: null, caps: ["camera"], tier: "experimental", tierHint: "UVC is the webcams' standard way to be set, but SYNQ hasn't been tried on this one. Reads are free; a change waits for Allow changes, with a backup first." };
  }
  if (e.kind === "headset") {
    const [vid, pid] = e.family.split(":");
    const model = findHeadset(vid, pid);
    const v = view as { battery?: number | null; charging?: boolean | null } | null;
    const caps: CapId[] = ["battery"];
    for (const s of model ? settingsOf(model.family) : []) {
      const cap: CapId | null = s.id === "sidetone" ? "sidetone" : s.id === "lights" ? "lighting" : s.id === "eqPreset" ? "presets" : s.id === "micLight" ? "mic" : null;
      if (cap && !caps.includes(cap)) caps.push(cap);
    }
    return {
      ...base,
      link: "Wireless",
      battery: typeof v?.battery === "number" ? v.battery : null,
      charging: !!v?.charging,
      caps,
      tier: "experimental",
      tierHint: "Built from HeadsetControl's open protocol; SYNQ hasn't been tried on one yet. Battery and chat-mix are read freely; a setting changes only while Allow changes is on.",
    };
  }

  // Keyboards
  if (e.family === "falchion") return { ...base, caps: ["analog", "rapid", "advanced", "remap", "lighting", "polling"], tier: "verified" };
  if (e.family === "x68") {
    // Read-only only when SYNQ couldn't read the whole board; "Allow changes" is a separate switch.
    const readable = (view as { writable?: boolean } | null)?.writable !== false;
    return {
      ...base,
      caps: ["analog", "rapid", "advanced", "remap", "lighting", "profiles", "polling"],
      tier: readable ? "driver-tested" : "read-only",
      tierHint: readable ? "Built from the maker's own configurator. Changes stay off until you allow them." : "SYNQ couldn't read this board completely, so it only shows its settings.",
    };
  }
  const v = view as KbLike | null;
  if (!v) return { ...base, link: base.link ?? "Wired", caps: [], tier: "read-only", tierHint: "Open it to see what SYNQ can read and change on this keyboard." };
  const caps: CapId[] = [];
  if (v.analog) {
    caps.push("analog");
    const f = v.analog.fields ?? {};
    if (f.rapidTrigger || f.rtPressMm || f.rtReleaseMm) caps.push("rapid");
  }
  if (v.advanced) caps.push("advanced");
  if (v.keymap) caps.push("remap");
  if (v.lighting) caps.push("lighting");
  if (v.profiles) caps.push("profiles");
  if (v.polling) caps.push("polling");
  return { ...base, link: linkOf(v.info?.connection) ?? base.link ?? "Wired", caps, tier: v.tier ?? "read-only", tierHint: v.tierWhy };
}

/** A mouse's pointer speed and report rate as its page last read them (the Gear home's big numbers); null before then.
 * Logitech and ATK keep plain numbers, the OpenMouse panel keeps `{ value }` / `{ hz }`. */
export function mouseNumbers(view: unknown): { dpi: number | null; pollingHz: number | null } {
  const v = view as { dpi?: number | { value?: number }; pollingHz?: number; polling?: { hz?: number } | null } | null;
  if (!v) return { dpi: null, pollingHz: null };
  const dpi = typeof v.dpi === "number" ? v.dpi : typeof v.dpi?.value === "number" ? v.dpi.value : null;
  const pollingHz = typeof v.pollingHz === "number" ? v.pollingHz : typeof v.polling?.hz === "number" ? v.polling.hz : null;
  return { dpi: dpi && dpi > 0 ? dpi : null, pollingHz: pollingHz && pollingHz > 0 ? pollingHz : null };
}
