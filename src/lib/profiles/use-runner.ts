// Game profiles for every mouse and keyboard while this window is open (the website too, once SYNQ Helper is
// connected): the runner (./runner.ts) on what the app already knows, the devices plugged in and SYNQ Helper's switches.
import { useEffect, useRef } from "react";
import { inTauri, isWeb, type Connected } from "../backend.ts";
import { helper, type HelperStatus } from "../helper.ts";
import { mouseFamilies } from "../mouse-family.ts";
import { keyboardFamilies } from "../kb/probe.ts";
import { ProfileRunner } from "./runner.ts";
import { liveDeps } from "./wire.ts";

/** The website asks SYNQ Helper whether game profiles are on at most this often. */
const PREFS_MS = 10_000;

export function useProfileRunner(devices: readonly Connected[], status: HelperStatus | null, webHelper: boolean, notify: (title: string, text: string) => void): void {
  const latest = useRef({ devices, status, notify });
  latest.current = { devices, status, notify };
  const on = inTauri || (isWeb && webHelper);
  useEffect(() => {
    if (!on) return;
    let prefs: { at: number; on: boolean } | null = null;
    const enabled = inTauri
      ? async () => {
          const s = latest.current.status?.settings;
          return s ? s.enabled && s.gameProfiles : null;
        }
      : async () => {
          if (!prefs || Date.now() - prefs.at > PREFS_MS) {
            const p = await helper.prefs().catch(() => null);
            if (!p) return null;
            prefs = { at: Date.now(), on: p.gameProfiles };
          }
          return prefs.on;
        };
    const runner = new ProfileRunner(
      liveDeps({
        enabled,
        connected: () => {
          const d = latest.current.devices;
          return [...mouseFamilies(d), ...keyboardFamilies(d)];
        },
        notify: (title, text) => latest.current.notify(title, text),
      }),
    );
    runner.start();
    return () => runner.stop();
  }, [on]);
}
