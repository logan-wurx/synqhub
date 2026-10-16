// Each device's last-known settings, kept so the Games page can build profiles offline (encode.ts):
// the device panels call `rememberAtk` / `rememberX68` with what they just read (nothing extra is read or
// sent for it), and it's kept in the app data folder (device-state/). When a device's state changes, the
// profiles for it are encoded again from the new state, so "everyday" stays what the person last set,
// except while SYNQ Helper has a game profile on that device (then what the panel reads is the game's
// settings, not the everyday ones).
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../runtime.ts";
import * as A from "../atk-protocol.ts";
import { encode, familyOf, type AtkRows, type KnownDevice, type ProfileSettings, type X68Known } from "./encode.ts";
import type { GamesFile } from "../helper.ts";

const now = () => Math.floor(Date.now() / 1000);

/** The same device under another serial (src-tauri/src/games.rs `same_device`). */
export function sameDevice(a: string, b: string): boolean {
  if (a === b) return true;
  const x = a.split(":");
  const y = b.split(":");
  return x.length >= 4 && x.length === y.length && x.slice(0, 3).join(":") === y.slice(0, 3).join(":") && x.slice(4).join(":") === y.slice(4).join(":");
}

const keyOf = (device: unknown): string | null => {
  const k = (device as { key?: unknown } | null)?.key;
  return typeof k === "string" && k ? k : null;
};

function remember(k: KnownDevice) {
  if (!isTauri) return;
  void invoke("device_state_save", { id: k.key, json: JSON.stringify(k) })
    .then(() => refreshProfiles(k))
    .catch(() => undefined);
}

/** The ATK panel read its rows (only for a mouse SYNQ may change). */
export function rememberAtk(device: HIDDevice, name: string, rows: AtkRows, view: { pollingOptions: number[]; debounceOptions: number[]; dpiRange: { min: number; max: number; step: number; maxStages: number } }) {
  const key = keyOf(device);
  if (!key || familyOf(device.vendorId, device.productId) !== "atk") return;
  remember({ family: "atk", key, name, vendorId: device.vendorId, productId: device.productId, updated: now(), atk: { rows, pollingOptions: view.pollingOptions, debounceOptions: view.debounceOptions, dpi: view.dpiRange } });
}

/** The X68 HE panel read its trigger table. */
export function rememberX68(key: string, name: string, x68: X68Known, usb: readonly [number, number] = [0x2e3c, 0xc365]) {
  remember({ family: "x68", key, name, vendorId: usb[0], productId: usb[1], updated: now(), x68 });
}

/** Re-encodes this device's profiles from its new state (not while a game profile is on it). */
async function refreshProfiles(k: KnownDevice) {
  const held = await invoke<string[]>("helper_held").catch(() => [] as string[]);
  if (held.some((h) => sameDevice(h, k.key))) return;
  const file = await invoke<GamesFile>("games_load");
  let changed = false;
  for (const g of file.games) {
    for (const [key, p] of Object.entries(g.profiles)) {
      const s = p.settings as ProfileSettings | null;
      if (!sameDevice(key, k.key) || !s || s.family !== k.family) continue;
      try {
        const e = encode(k, s);
        if (JSON.stringify(e.steps) !== JSON.stringify(p.steps) || JSON.stringify(e.restore) !== JSON.stringify(p.restore)) {
          g.profiles[key] = { ...p, steps: e.steps, restore: e.restore, saved: now() };
          changed = true;
        }
      } catch {
        // A setting the device can't take any more stays as it was; the Games page says so when opened.
      }
    }
  }
  if (changed) await invoke("games_save", { file });
}

/** Every device SYNQ knows the settings of. */
export async function knownDevices(): Promise<KnownDevice[]> {
  if (!isTauri) return previewDevices();
  const list = await invoke<string[]>("device_states_load").catch(() => [] as string[]);
  const out: KnownDevice[] = [];
  for (const t of list) {
    try {
      const k = JSON.parse(t) as KnownDevice;
      if (k && (k.family === "atk" || k.family === "x68") && typeof k.key === "string") out.push(k);
    } catch {
      /* a damaged file is skipped */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The browser preview: an ATK X1 and an X68 HE as they might have been read. */
export function previewDevices(): KnownDevice[] {
  const pairs = (...v: number[]) => v.flatMap((x) => A.pair(x));
  return [
    {
      family: "atk",
      key: "373b:1278:2:",
      name: "ATK X1 V2 Air+",
      vendorId: 0x373b,
      productId: 0x1278,
      updated: now(),
      atk: {
        rows: {
          system: pairs(0x01, 4, 1, 0, 0),
          liftOff: A.pair(A.liftOffCode(1.0)),
          function: pairs(2, 1, 6, 0, 0),
          performance: pairs(0, 0, 1),
          stages: [400, 800, 1600, 3200].map((d) => A.packPaw3955Stage(d)),
        },
        pollingOptions: A.RATES_8K,
        debounceOptions: [...A.DEBOUNCE_MS],
        dpi: { ...A.PAW3955_DPI, maxStages: A.PAW3955_MAX_STAGES },
      },
    },
    {
      family: "x68",
      key: "2e3c:c365:1:",
      name: "MAGIC-REFINER X68 HE",
      vendorId: 0x2e3c,
      productId: 0xc365,
      updated: now(),
      x68: {
        trigger: { unitMm: 0.01, minUnits: 10, maxUnits: 400, minMm: 0.1, maxMm: 4, rtMinMm: 0.01, rtMaxMm: 2 },
        keys: Array.from({ length: 68 }, (_, i) => ({ index: i, mode: 0, travel: 150, press: 15, release: 15 })),
      },
    },
  ];
}
