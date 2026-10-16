// Where the person is in the app: the Devices home, one device, Games, Settings, or the gear checkup. Kept in src/lib/keep.ts
// (so it outlives the pages that read it), plus the last tab picked on each device. Nothing here
// talks to a device or runs a timer.
import { useCallback } from "react";
import { peekKept, setKept, useKeptState } from "./keep";

export type View = "devices" | "lights" | "displays" | "device" | "settings" | "games" | "checkup";
export interface Nav {
  view: View;
  /** `mouse:<family>`, `kb:<family>`, `pad:<family>`, `hs:<vid>:<pid>`, `light:<address>` (`light:all` for every lamp) or `sound`; for the checkup, the one device checked (null: all). */
  device: string | null;
}

const NAV = "nav.state";
const HOME: Nav = { view: "devices", device: null };

export const mouseId = (family: string) => `mouse:${family}`;
export const keyboardId = (family: string) => `kb:${family}`;
/** A controller: `pad:<model id>` (or `pad:pad:<vid>:<pid>` for a pad without a model). */
export const padId = (family: string) => `pad:${family}`;
/** A gaming headset: `hs:<vid>:<pid>` (src/lib/headsets). */
export const headsetId = (family: string) => `hs:${family}`;
/** A monitor (`mon:<EDID maker>:<product>`) and a webcam (`cam:<vid>:<pid>`). */
export const monitorId = (family: string) => `mon:${family}`;
export const webcamId = (family: string) => `cam:${family}`;
/** A lamp, by its Bluetooth address; `light:all` is every lamp at once. */
export const lightId = (id: string) => `light:${id}`;
/** A Windows Dynamic Lighting device (`dl:<Windows interface id>`) and a USB RGB hub (`rgb:<vid>:<pid>`). */
export const lampArrayId = (id: string) => `dl:${id}`;
export const hubId = (family: string) => `rgb:${family}`;
export const SOUND_ID = "sound";

/**
 * The browser preview (`vite dev`, no Tauri) can open a page from the address: `#games`, `#games/<id>`,
 * `#settings`, `#lights`, `#displays`, `#checkup`, `#checkup/<device>`. Used for screenshots; the app and the website ignore it.
 */
function fromHash(): Nav {
  if (typeof window === "undefined" || "__TAURI_INTERNALS__" in window || (typeof __ONBOARD_WEB__ !== "undefined" && __ONBOARD_WEB__)) return HOME;
  const [view, id] = window.location.hash.replace(/^#/, "").split("/");
  if (view === "games") {
    if (id) setKept<string | null>("games.open", decodeURIComponent(id));
    return { view: "games", device: null };
  }
  if (view === "settings") return { view: "settings", device: null };
  if (view === "lights" || view === "displays") return { view, device: null };
  if (view === "checkup") return { view: "checkup", device: id ? decodeURIComponent(id) : null };
  return HOME;
}

export const useNav = () => useKeptState<Nav>(NAV, fromHash);
export const openDevice = (device: string) => setKept<Nav>(NAV, { view: "device", device });
export const goHome = () => setKept<Nav>(NAV, HOME);
export const goLights = () => setKept<Nav>(NAV, { view: "lights", device: null });
export const goDisplays = () => setKept<Nav>(NAV, { view: "displays", device: null });
/** The sidebar tab a device page belongs to, from its id: lights (`light:`, Dynamic Lighting `dl:`, hubs `rgb:`) and
 * monitors (`mon:`) have their own; everything else is a Devices page. */
export function sectionOfDevice(id: string): "devices" | "lights" | "displays" {
  if (/^(light|dl|rgb):/.test(id)) return "lights";
  if (id.startsWith("mon:")) return "displays";
  return "devices";
}
/** Back to a section's page. */
export const goSection = (section: "devices" | "lights" | "displays") => (section === "lights" ? goLights() : section === "displays" ? goDisplays() : goHome());
export const goSettings = () => setKept<Nav>(NAV, { view: "settings", device: null });
export const goGames = () => setKept<Nav>(NAV, { view: "games", device: null });
/** The gear checkup: every connected device, or just `device`. */
export const goCheckup = (device: string | null = null) => setKept<Nav>(NAV, { view: "checkup", device });
/** Back to the last checkup's results (its page keeps them under `checkup.run`). */
export const goCheckupResults = () => goCheckup(peekKept<{ scope: string | null } | null>("checkup.run", null)?.scope ?? null);

const TAB_PREFIX = "onboard.tab.";
const readTab = (id: string): string | null => {
  try {
    return localStorage.getItem(TAB_PREFIX + id);
  } catch {
    return null;
  }
};

/**
 * The tab shown on a device, remembered per device (here and in localStorage). A remembered tab that
 * this device doesn't have (yet: its tabs depend on what it reports) falls back to the first tab
 * without forgetting the choice.
 */
export function useDeviceTab(id: string, tabs: readonly string[], legacy: Readonly<Record<string, string>> = {}): [string, (tab: string) => void] {
  const [stored, setStored] = useKeptState<string | null>(`tab.${id}`, () => readTab(id));
  // A tab id from before the tabs were merged maps to the one that holds its content now.
  const mapped = stored ? (legacy[stored] ?? stored) : null;
  const tab = mapped && tabs.includes(mapped) ? mapped : tabs[0];
  const set = useCallback(
    (next: string) => {
      setStored(next);
      try {
        localStorage.setItem(TAB_PREFIX + id, next);
      } catch {
        // Storage can be unavailable; the tab is then remembered for this session only.
      }
    },
    [id, setStored],
  );
  return [tab, set];
}

/** Old tab ids -> the merged tabs that hold their content (the remembered tab survives the merge). */
export const MOUSE_TABS_LEGACY = { performance: "controls", buttons: "controls", lighting: "controls" } as const;
export const KEYBOARD_TABS_LEGACY = { actuation: "keys", rapid: "keys", lighting: "remap", profiles: "remap" } as const;
export const SOUND_TABS_LEGACY = { presets: "eq" } as const;
