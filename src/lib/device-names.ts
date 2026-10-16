// What the sidebar calls each kind of device, from what is actually detected on this PC. Panels
// that learn a better name from the device itself publish it here (a LIGHTSPEED receiver can't tell
// a PRO X 2 DEX from a Superlight 2; the mouse's own HID++ name can).
import { useSyncExternalStore } from "react";
import { liveHardware, type Connected } from "./backend";
import { mouseHint } from "./mouse-hint";

const published = new Map<string, string>();
const listeners = new Set<() => void>();
let snapshot = new Map<string, string>();

export { mouseHint };

export function publishDeviceName(slot: "logitech", name: string | null) {
  if ((name ?? null) === (published.get(slot) ?? null)) return;
  if (name) published.set(slot, name);
  else published.delete(slot);
  snapshot = new Map(published);
  for (const l of [...listeners]) l();
}

export function usePublishedNames(): Map<string, string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

const SHORT_KEYBOARD: Record<string, string> = { "ROG Falchion Ace HFX ZywOo": "Falchion Ace HFX", "MAGIC-REFINER X68 HE": "X68 HE" };

/** Sidebar hint for the Keyboard page. */
export function keyboardHint(devices: Connected[]): string {
  const kb = [...new Set(devices.filter((d) => d.kind === "keyboard" && !d.bootloader).map((d) => SHORT_KEYBOARD[d.name] ?? d.name))];
  return kb.length > 1 ? `${kb.length} keyboards` : (kb[0] ?? "Not connected");
}

/** Model-matched Logitech render: the Superlight 2 has its own; the DEX (and anything unknown) uses the default. */
export function isSuperlight2(name: string | null | undefined): boolean {
  if (!name || /DEX/i.test(name)) return false;
  return /SUPERLIGHT\s*2|PRO X 2|PRO X SUPERLIGHT/i.test(name);
}

/**
 * The browser preview (no Tauri) shows every supported device, so both switchers are visible.
 * Real detection (devices_list) only ever lists what is plugged in.
 */
const PREVIEW_EXTRA: Connected[] = [
  { kind: "keyboard", name: "MAGIC-REFINER X68 HE", connection: "USB", vid: "2e3c", pid: "c365", reported: "X68HE" },
  // Sample controllers (src/lib/controllers/sim.ts): a DualSense and an Edge, the developer's G7 SE through XInput, a Switch
  // Pro over Bluetooth, GameSir's Cyclone 2 and G7 Pro 8K (their settings), a SCUF Envision Pro receiver (BRAGI reads), an 8BitDo Ultimate in its config mode, a Flydigi Apex 4 in D-input, and an 8BitDo receiver whose pad is off
  // (shown greyed, last).
  { kind: "controller", name: "DualSense Wireless Controller", connection: "USB", vid: "054c", pid: "0ce6", reported: "DualSense Wireless Controller", pad: { via: "hid", kind: "ps5" } },
  { kind: "controller", name: "DualSense Edge Wireless Controller", connection: "USB", vid: "054c", pid: "0df2", reported: "DualSense Edge Wireless Controller", pad: { via: "hid", kind: "ps5edge" } },
  { kind: "controller", name: "Game controller", connection: "USB", vid: "3537", pid: "1010", reported: null, pad: { via: "xinput", kind: "xboxone", slot: 0, battery: ["wired", 3] } },
  { kind: "controller", name: "Pro Controller", connection: "Bluetooth", vid: "057e", pid: "2009", reported: "Pro Controller", pad: { via: "hid", kind: "switchpro" } },
  { kind: "controller", name: "GameSir-Cyclone 2", connection: "USB", vid: "3537", pid: "1053", reported: "GameSir-Cyclone 2", pad: { via: "hid", kind: "gamesir" } },
  { kind: "controller", name: "GameSir G7 Pro 8K", connection: "USB", vid: "3537", pid: "10c7", reported: "GameSir G7 Pro 8K", pad: { via: "hid", kind: "gamesir" } },
  { kind: "controller", name: "8BitDo Ultimate Wireless Controller", connection: "USB", vid: "2dc8", pid: "6007", reported: "8BitDo Ultimate Wireless Controller", pad: { via: "hid", kind: "8bitdo" } },
  { kind: "controller", name: "Flydigi Apex 4", connection: "USB", vid: "04b4", pid: "2412", reported: "Flydigi Apex 4", pad: { via: "hid", kind: "flydigi" } },
  { kind: "controller", name: "SCUF ENVISION PRO WIRELESS RECEIVER", connection: "USB", vid: "2e95", pid: "434e", reported: "SCUF ENVISION PRO WIRELESS RECEIVER", pad: { via: "hid", kind: "xboxone" } },
  { kind: "controller", name: "8BitDo Ultimate 2 Wireless", connection: "USB", vid: "2dc8", pid: "6013", reported: "8BitDo Ultimate 2 Wireless", pad: { via: "hid", kind: "8bitdo" } },
  // A monitor and a webcam answering like DDC/CI and UVC would (src/lib/displays/sim.ts).
  { kind: "monitor", name: "VG248", connection: "Display", vid: "aus", pid: "24ab", reported: null, path: "AUS24AB/preview" },
  { kind: "webcam", name: "C920 HD Pro Webcam", connection: "USB", vid: "046d", pid: "082d", reported: null, path: "preview-webcam" },
  // A USB RGB hub over its simulated firmware (src/lib/lighting/hidrgb/sim.ts).
  { kind: "rgbhub", name: "NZXT RGB & Fan Controller", connection: "USB", vid: "1e71", pid: "2011", reported: null },
  // A gaming headset over its simulated firmware (src/lib/headsets/sim.ts).
  { kind: "headset", name: "SteelSeries Arctis Nova 7", connection: "Wireless", vid: "1038", pid: "2202", reported: "Arctis Nova 7" },
  // Sample mice for the generic (OpenMouse) panel; their drivers are src/lib/openmouse/mock.ts.
  { kind: "mouse", name: "Razer Viper V3 Pro", connection: "Receiver", vid: "1532", pid: "00c1", reported: "Razer Viper V3 Pro", generic: true },
  { kind: "mouse", name: "Pulsar X2 HE 4K Dongle", connection: "Receiver", vid: "3710", pid: "5406", reported: "Pulsar X2 HE 4K Dongle", generic: true },
  { kind: "mouse", name: "SYNQ Sample Mouse", connection: "USB cable", vid: "4f42", pid: "5642", reported: "SYNQ Sample Mouse", generic: true },
  // Sample keyboards for the generic Keyboard panel; their drivers are src/lib/kb/mock.ts.
  { kind: "keyboard", name: "Wooting 60HE+", connection: "USB", vid: "31e3", pid: "1322", reported: "Wooting 60HE+", generic: true, kb: "omkb" },
  { kind: "keyboard", name: "BABAO60 HE", connection: "USB", vid: "1ca6", pid: "1b10", reported: "BABAO60 HE", generic: true, kb: "omkb" },
  { kind: "keyboard", name: "SYNQ Sample 65", connection: "USB", vid: "4f42", pid: "5641", reported: "SYNQ Sample 65", generic: true, kb: "qmk", qmk: true },
  // Two brand boards through their real drivers over simulated hardware (the 0x19F5 firmware family; Royal Kludge's write-only channel).
  { kind: "keyboard", name: "MCHOSE Ace 60 Pro", brand: "MCHOSE", connection: "USB", vid: "41e4", pid: "2103", reported: "MCHOSE Ace 60 Pro", generic: true, kb: "brand" },
  { kind: "keyboard", name: "RK-M75", brand: "Royal Kludge", connection: "USB", vid: "258a", pid: "0147", reported: "RK-M75", generic: true, kb: "brand" },
  // Wave B: a SparkLink Hall-effect board (its own driver) and a Keychron HE board (VIA plus the analog layer), both over simulated hardware.
  { kind: "keyboard", name: "RK M75HE", brand: "Royal Kludge", connection: "USB", vid: "1ca2", pid: "1619", reported: "RK M75HE", generic: true, kb: "brand" },
  { kind: "keyboard", name: "Keychron Q1 HE", brand: "Keychron", connection: "USB", vid: "3434", pid: "0b10", reported: "Keychron Q1 HE", generic: true, kb: "qmk", qmk: true },
];
/**
 * `?photos` shows a spread of devices for looking at the Devices home's pictures: makers' photos, a keyboard drawn from
 * its layout (MonsGeek FUN75, which has no published picture), and the maker photos second pass added. Preview only; they open nothing real.
 */
const PHOTO_PREVIEW: Connected[] = [
  { kind: "mouse", name: "Corsair SABRE v2 PRO", brand: "Corsair", connection: "Receiver", vid: "1b1c", pid: "2b28", reported: "SABRE V2 PRO", generic: true },
  { kind: "mouse", name: "Endgame Gear OP1we", brand: "Endgame Gear", connection: "Receiver", vid: "3367", pid: "1961", reported: "OP1we", generic: true },
  { kind: "mouse", name: "ATK F1 Ultimate", brand: "ATK", connection: "Receiver", vid: "373b", pid: "1190", reported: "ATK F1 Ultimate", generic: true },
  { kind: "mouse", name: "Razer DeathAdder V3 Pro", brand: "Razer", connection: "Receiver", vid: "1532", pid: "00c3", reported: "Razer DeathAdder V3 Pro", generic: true },
  { kind: "mouse", name: "Lamzu Thorn Mini", brand: "Lamzu", connection: "USB cable", vid: "3554", pid: "f50f", reported: "Lamzu Thorn Mini", generic: true },
  { kind: "keyboard", name: "MonsGeek FUN60 Pro", brand: "MonsGeek", connection: "USB", vid: "3151", pid: "5030", reported: "MonsGeek FUN60 Pro", generic: true, kb: "brand" },
  { kind: "keyboard", name: "SteelSeries Apex Pro TKL (2024, Gen 3)", brand: "SteelSeries", connection: "USB", vid: "1038", pid: "1642", reported: "Apex Pro TKL Gen 3", generic: true, kb: "brand" },
  { kind: "keyboard", name: "Fighting68", brand: "Sonix", connection: "USB", vid: "0c45", pid: "8030", reported: "Fighting68", generic: true, kb: "brand" },
  { kind: "mouse", name: "Pulsar X2F", brand: "Pulsar", connection: "Receiver", vid: "25a7", pid: "ff2f", reported: "Pulsar X2F", generic: true },
  { kind: "mouse", name: "VAXEE XE-S Wireless", brand: "VAXEE", connection: "Receiver", vid: "3057", pid: "1007", reported: "XE-S Wireless", generic: true },
  { kind: "mouse", name: "Razer Naga Trinity", brand: "Razer", connection: "USB cable", vid: "1532", pid: "0067", reported: "Razer Naga Trinity", generic: true },
  { kind: "mouse", name: "Razer Lancehead Wireless (Wired)", brand: "Razer", connection: "USB cable", vid: "1532", pid: "0070", reported: "Razer Lancehead Wireless", generic: true },
  { kind: "keyboard", name: "NuPhy Air75 HE", brand: "NuPhy", connection: "USB", vid: "19f5", pid: "6120", reported: "NuPhy Air75 HE", generic: true, kb: "brand" },
  { kind: "keyboard", name: "MonsGeek FUN75", brand: "MonsGeek", connection: "USB", vid: "3151", pid: "fff7", reported: "MonsGeek FUN75", generic: true, kb: "brand" },
  { kind: "keyboard", name: "ROG AZOTH EXTREME", brand: "ASUS", connection: "USB", vid: "0b05", pid: "1b3f", reported: "ROG AZOTH EXTREME", generic: true, kb: "brand" },
  { kind: "keyboard", name: "Corsair K70 PRO TKL", brand: "Corsair", connection: "USB", vid: "1b1c", pid: "1bc4", reported: "K70 PRO TKL", generic: true, kb: "brand" },
];
/** The gallery preview (`?photos`) skips the driver claim, so its sample devices stay in the list. */
export const photoGallery = (): boolean => !liveHardware && typeof location !== "undefined" && new URLSearchParams(location.search).has("photos");

/**
 * `?arrive` holds back five of the sample devices (three mice and two keyboards) until the
 * address ends in `#arrived`, so "a new mouse or keyboard was just plugged in" can be seen (src/lib/feel).
 */
const PREVIEW_ARRIVALS = new Set(["1532:00c1", "3710:5406", "4f42:5642", "31e3:1322", "1ca6:1b10"]);

export function withPreviewDevices(list: Connected[]): Connected[] {
  if (liveHardware) return list;
  // `?plain` leaves out the sample generic mice, so the page looks like a PC with just the DEX and the X1.
  const params = new URLSearchParams(location.search);
  const plain = params.has("plain");
  const waiting = params.has("arrive") && location.hash !== "#arrived";
  const extra = (params.has("photos") ? [...PREVIEW_EXTRA, ...PHOTO_PREVIEW] : PREVIEW_EXTRA).filter((p) => !(waiting && PREVIEW_ARRIVALS.has(`${p.vid}:${p.pid}`)));
  return [...list, ...extra.filter((p) => !(plain && p.generic) && !list.some((d) => d.vid === p.vid && d.pid === p.pid))];
}
