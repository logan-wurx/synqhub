// The Windows Dynamic Lighting devices, for the Lights page and the Dynamic Lighting pages: a device watcher in the
// bridge runs while one of them is on screen and tells them when a device arrives or leaves (no timer, nothing opened).
// On the website: the added devices with a LampArray collection, read again when one is added or unplugged.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { backend, isWeb } from "../backend";
import { isTauri } from "../runtime";
import type { LampArrayDevice } from "./lamparray";

/** The devices known now; null until the watcher first answers. `on`: false keeps the watcher off (a page that doesn't show lights). */
export function useLampArrays(on = true): LampArrayDevice[] | null {
  const [list, setList] = useState<LampArrayDevice[] | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    let unlisten: (() => void) | null = null;
    (async () => {
      if (isTauri) {
        const off = await listen<LampArrayDevice[]>("lamparray-changed", (e) => live && setList(e.payload));
        if (!live) return off();
        unlisten = off;
      }
      if (isWeb) {
        const off = (await import("../web/hid")).onHidChange(() => void backend.lampArrayWatch(true).then((l) => live && setList(l), () => undefined));
        if (!live) return off();
        unlisten = off;
      }
      const now = await backend.lampArrayWatch(true).catch(() => [] as LampArrayDevice[]);
      if (live) setList(now);
    })();
    return () => {
      live = false;
      unlisten?.();
      void backend.lampArrayWatch(false).catch(() => undefined);
    };
  }, [on]);
  return on ? list : null;
}
