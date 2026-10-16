// The displays screen sync can read (src-tauri/src/lighting/screen.rs `monitors`), named and sized as Windows reports
// them, primary first. A sync tab asks when it opens; a display change stops a running sync, so the list it shows is
// the one the sync reads. The browser preview has two pretend monitors; the website asks SYNQ Helper (none without it).
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { inTauri, isWeb } from "../backend";

export interface ScreenMonitor {
  /** Windows' device name ("\\.\DISPLAY2"), what the bridge's sampler takes. */
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

const PREVIEW: readonly ScreenMonitor[] = [
  { id: "\\\\.\\DISPLAY1", name: "DELL S2721DGF", x: 0, y: 0, width: 2560, height: 1440, primary: true },
  { id: "\\\\.\\DISPLAY2", name: "VG248", x: 2560, y: -240, width: 1080, height: 1920, primary: false },
];

export async function listMonitors(): Promise<ScreenMonitor[]> {
  if (inTauri) return invoke<ScreenMonitor[]>("screen_monitors");
  if (isWeb) return (await import("../web/helper.ts")).helperReady() ? invoke<ScreenMonitor[]>("screen_monitors") : [];
  return [...PREVIEW];
}

/** The displays, asked once when the tab opens (null until they answer). */
export function useMonitors(): ScreenMonitor[] | null {
  const [list, setList] = useState<ScreenMonitor[] | null>(null);
  useEffect(() => {
    let live = true;
    listMonitors().then(
      (l) => live && setList(l),
      () => live && setList([]),
    );
    return () => {
      live = false;
    };
  }, []);
  return list;
}

/** The monitor a sync reads: the kept choice while that display is still there, else the primary (null). */
export const chosenMonitor = (list: readonly ScreenMonitor[] | null, kept: string | null): ScreenMonitor | null =>
  list?.find((m) => m.id === kept) ?? list?.find((m) => m.primary) ?? null;

/** "VG248 · 1080×1920", with "main" for the primary. */
export const monitorLabel = (m: ScreenMonitor) => `${m.name} · ${m.width}×${m.height}${m.primary ? " · main" : ""}`;
