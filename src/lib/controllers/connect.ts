// Finding a listed controller and opening it for the tester: through navigator.hid (the bridge's shim on the desktop,
// guarded WebHID on the website), XInput (Windows desktop) or the browser's Gamepad API; the browser preview and the
// end-to-end build get the simulated pads (sim.ts).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { inTauri, isWeb, liveHardware, type Connected } from "../backend";
import { installTauriHid } from "../tauri-hid";
import { gamepadIds, type PadIdentity } from "./identify.ts";
import { openGamepadLink, openHidLink, openXInputLink, type PadLink, type XInputBackend } from "./link.ts";
import type { XInputReading } from "./parse.ts";
import { gamesirModelOf } from "./gamesir.ts";
import { FLYDIGI_PAGE, GAMESIR_PAGE } from "./pads.ts";
import { simulate8BitDo, simulateFlydigi, simulateDualSense, simulateDualSenseEdge, simulateGamesir, simulateReadOnlyPad, simulateScuf, simulateSwitchPro, simulatedXInput, type SimPad } from "./sim.ts";
import { padGuardOf } from "./pads.ts";

const hexId = (s: string) => parseInt(s, 16);

// identifyConnected lives in identify.ts so the Devices home can name controllers without loading this module.
export { identifyConnected } from "./identify.ts";

// ---- the preview's pads

const sims = new Map<string, SimPad>();
function simFor(d: Connected): SimPad {
  const key = `${d.vid}:${d.pid}`;
  let s = sims.get(key);
  if (!s) {
    const gamesir = d.vid === "3537" ? gamesirModelOf(hexId(d.pid)) : null;
    s =
      key === "054c:0ce6"
        ? simulateDualSense()
        : key === "054c:0df2"
          ? simulateDualSenseEdge()
          : key === "057e:2009"
            ? simulateSwitchPro()
            : gamesir
              ? simulateGamesir(gamesir, hexId(d.pid))
              : padGuardOf(hexId(d.vid), hexId(d.pid)) === "8bitdo"
                ? simulate8BitDo(hexId(d.pid))
                : padGuardOf(hexId(d.vid), hexId(d.pid)) === "flydigi"
                  ? simulateFlydigi()
                : padGuardOf(hexId(d.vid), hexId(d.pid)) === "scuf"
                ? simulateScuf(hexId(d.vid), hexId(d.pid), d.reported ?? d.name, /dongle|receiver/i.test(d.reported ?? d.name) || ["2e95:434e", "2e95:5046", "1b1c:3a08", "1b1c:3a09"].includes(key))
                : simulateReadOnlyPad(hexId(d.vid), hexId(d.pid), d.reported ?? d.name, /receiver|dongle/i.test(d.reported ?? d.name) || key === "2dc8:6013");
    sims.set(key, s);
  }
  return s;
}

let previewXInput: XInputBackend | null = null;

/** XInput through the bridge (src-tauri/src/xinput.rs); a simulated pad in the preview. */
export function xinputBackend(): XInputBackend {
  if (!inTauri) return (previewXInput ??= simulatedXInput());
  return {
    read: (slot) => invoke<XInputReading | null>("xinput_read", { slot }),
    async sample(slot, seconds, onBatch) {
      const off = await listen<{ slot: number; readings: XInputReading[]; sampleHz: number; done: boolean }>("xinput-batch", (e) => {
        if (e.payload.slot === slot) onBatch(e.payload);
      });
      try {
        await invoke("xinput_sample", { slot, seconds });
      } catch (err) {
        off();
        throw err;
      }
      return off;
    },
    stop: () => invoke("xinput_stop"),
  };
}

/** The HID device behind a listed pad: its gamepad (or Valve input, or GameSir vendor) collection. */
export async function findHidDevice(d: Connected): Promise<HIDDevice | null> {
  if (!liveHardware) return simFor(d).device;
  await installTauriHid();
  const vid = hexId(d.vid);
  const pid = hexId(d.pid);
  const all = await navigator.hid.getDevices();
  const ours = (c: HIDCollectionInfo) => (c.usagePage === 0x0001 && (c.usage === 0x0004 || c.usage === 0x0005)) || (c.usagePage === 0xff00 && c.usage === 0x0001) || c.usagePage === GAMESIR_PAGE || c.usagePage === FLYDIGI_PAGE || (c.usagePage === 0xff42 && c.usage === 0x0001);
  return all.find((x) => x.vendorId === vid && x.productId === pid && x.collections.some(ours)) ?? null;
}

/** The browser gamepad that is this pad (by the ids in its Gamepad id), if the browser sees it. */
export function findGamepad(vid: number, pid: number): number | null {
  const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
  for (const g of pads) {
    if (!g) continue;
    const ids = gamepadIds(g.id);
    if (ids && ids.vid === vid && ids.pid === pid) return g.index;
  }
  return null;
}

/** Opens the tester's link to a listed pad. */
export async function openPad(d: Connected, identity: PadIdentity): Promise<PadLink> {
  if (d.pad?.via === "xinput") {
    if (!inTauri && liveHardware) throw new Error("XInput pads are read by the desktop app.");
    return openXInputLink(identity, d.pad.slot ?? 0, xinputBackend(), d.pad.battery);
  }
  const device = await findHidDevice(d);
  if (!device) {
    const g = findGamepad(identity.vid, identity.pid);
    if (g !== null) return openGamepadLink({ ...identity, via: "gamepad", guard: "input" }, g);
    throw new Error(isWeb ? "The browser hasn't given SYNQ this controller: add it with Add device." : "The controller isn't there any more.");
  }
  return openHidLink(identity, device);
}

/**
 * Whether a receiver or dongle has a pad behind it: a short, read-only look at its input reports (nothing is sent and
 * no mode changes; the device is closed again at once). Only for those personalities: a pad that is on but idle may
 * send nothing, so it isn't asked.
 */
export async function probeReceiver(d: Connected, identity: PadIdentity, ms = 400): Promise<"live" | "quiet"> {
  if (!/dongle|receiver|adapter|puck/i.test(identity.personality ?? "")) return "live";
  const device = await findHidDevice(d).catch(() => null);
  if (!device) return "quiet";
  let seen = false;
  const onInput = () => {
    seen = true;
  };
  const wasOpen = device.opened;
  try {
    if (!wasOpen) await device.open();
    device.addEventListener("inputreport", onInput);
    await new Promise((r) => setTimeout(r, ms));
  } catch {
    return "quiet";
  } finally {
    device.removeEventListener("inputreport", onInput);
    if (!wasOpen) await device.close().catch(() => undefined);
  }
  return seen ? "live" : "quiet";
}
