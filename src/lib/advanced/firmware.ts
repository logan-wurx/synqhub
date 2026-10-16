// Firmware stays with the maker's own updater: SYNQ never flashes, enters a bootloader or starts a DFU.
// What it can do is show the version a device reports and point at the official updater. Every address here
// is one the project's own research notes cite (docs/devices/BRANDS.md and the driver sources); a brand with no
// official page on record gets none, and the card says so. `latest` is only ever filled from an official
// source a driver already reads; no driver reads one yet, so it is null and the card says SYNQ can't tell.
// Pure.
import type { FirmwareInfo } from "./types.ts";

export interface Updater {
  name: string;
  url: string;
}

/** By brand name as the drivers spell it (lower-cased; see `updaterFor`). */
const UPDATERS: Readonly<Record<string, Updater>> = {
  atk: { name: "ATK HUB", url: "https://hub.atk.pro" },
  vxe: { name: "ATK HUB", url: "https://hub.atk.pro" },
  logitech: { name: "Logitech G HUB", url: "https://www.logitechg.com/en-us/innovation/g-hub.html" },
  razer: { name: "Razer Synapse", url: "https://synapse.razer.com/dashboard" },
  corsair: { name: "Corsair firmware updater", url: "https://www.corsair.com/firmware-updater/index.html" },
  "corsair icue": { name: "Corsair firmware updater", url: "https://www.corsair.com/firmware-updater/index.html" },
  asus: { name: "ASUS Gear Link", url: "https://gearlink.asus.com" },
  steelseries: { name: "SteelSeries GG", url: "https://steelseries.com/gg" },
  wooting: { name: "Wootility", url: "https://wootility.io" },
  keychron: { name: "Keychron Launcher", url: "https://launcher.keychron.com" },
  monsgeek: { name: "MonsGeek driver", url: "https://app.monsgeek.com" },
  akko: { name: "MonsGeek driver", url: "https://app.monsgeek.com" },
  qmk: { name: "QMK Toolbox", url: "https://qmk.fm/toolbox" },
  via: { name: "VIA", url: "https://usevia.app" },
  vial: { name: "Vial", url: "https://vial.rocks" },
  pulsar: { name: "Pulsar configurator", url: "https://bbb.pulsar.gg/" },
  lamzu: { name: "Lamzu configurator", url: "https://www.lamzu.net/" },
  wlmouse: { name: "WLMouse configurator", url: "https://gm.wlmouse.gg" },
  vgn: { name: "VGN HUB", url: "https://hub.vgnlab.com/" },
  finalmouse: { name: "Finalmouse Xpanel", url: "https://xpanel.finalmouse.com/" },
  nuphy: { name: "NuPhy IO", url: "https://nuphy.io" },
  ducky: { name: "Ducky Hub", url: "https://duckyhub.io" },
  rk: { name: "RK Drive", url: "https://drive.rkgaming.com" },
  varmilo: { name: "Varmilo hub", url: "https://varmilo.kbhub.org" },
  epomaker: { name: "Epomaker hub", url: "https://hub.epomaker.com" },
  "magic-refiner": { name: "illumipc", url: "https://www.illumipc.com/" },
  drunkdeer: { name: "DrunkDeer driver", url: "https://drunkdeer-antler.com" },
};

/** The maker's updater for a brand, or null when no official page is on record. */
export function updaterFor(brand: string): Updater | null {
  const key = brand.trim().toLowerCase();
  if (UPDATERS[key]) return UPDATERS[key];
  const hit = Object.keys(UPDATERS).find((k) => key.startsWith(k));
  return hit ? UPDATERS[hit] : null;
}

/** The card's firmware block for a device. */
export function firmwareInfo(brand: string, versions: readonly { part: string; version: string }[], note?: string): FirmwareInfo {
  return { versions: versions.filter((v) => v.version), latest: null, updater: updaterFor(brand), note };
}

/** Splits driver strings like "Mouse 1.2.6" or "Firmware 5" into a part and a version. */
export function splitVersion(text: string): { part: string; version: string } {
  const m = /^(.*?)[\s:]+v?(\d[\w.\-+]*)$/i.exec(text.trim());
  return m ? { part: m[1].trim() || "Firmware", version: m[2] } : { part: "Firmware", version: text.trim() };
}
