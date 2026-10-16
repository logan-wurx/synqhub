// Opening each kind of light for a look (wave L5): a Govee lamp through its own controller (its dialect, segments and
// pace), a Wi-Fi light through its brand's controller and guard, a Dynamic Lighting device through Windows (only while
// SYNQ is in front), and a USB hub on the channels chosen on its page, only once the person allowed changes to it.
// Every message still passes the guard of its own kind; nothing here bypasses one.
import { backend } from "../../backend";
import { peekKept } from "../../keep";
import { gradient, type Rgb } from "../govee/frames.ts";
import { specOf } from "../govee/spec.ts";
import { LampController } from "../lamp.ts";
import { openLamp } from "../link.ts";
import { NetLightController } from "../net/control.ts";
import { netSend } from "../net/link.ts";
import { connectHub } from "../hidrgb/connect";
import { ledsFor } from "../hidrgb/protocol";
import { middle, type Driver } from "./control.ts";
import type { LightRef } from "./lights.ts";

/** Room between two writes to a Dynamic Lighting device or a hub (the latest colour wins). */
const LAMPARRAY_MS = 40;
const HUB_MS = 150;

/** Calls `send` with the latest value at most every `ms` (a dragged slider sends its last position). */
function paced<T>(ms: number, send: (v: T) => Promise<unknown>): (v: T) => void {
  let next: { v: T } | null = null;
  let busy = false;
  const run = async () => {
    busy = true;
    while (next) {
      const { v } = next;
      next = null;
      await send(v).catch(() => undefined);
      await new Promise((r) => setTimeout(r, ms));
    }
    busy = false;
  };
  return (v: T) => {
    next = { v };
    if (!busy) void run();
  };
}

async function govee(r: Extract<LightRef, { source: "govee" }>): Promise<Driver> {
  const link = await openLamp(r.lamp);
  const c = new LampController(link, specOf(r.lamp.sku)!);
  c.refresh();
  return {
    key: r.key,
    colour: (rgb) => c.setColour(rgb),
    gradient: (stops) => c.setGradient(stops),
    white: c.spec.kelvin ? (k) => c.setWhite(k) : undefined,
    brightness: (p) => c.setBrightness(p),
    power: (on) => c.setPower(on),
    sync: {
      get can() {
        return c.syncable;
      },
      start: (edge, vivid, monitor) => c.startSync(edge, vivid, monitor),
    },
    close: () => c.close(),
  };
}

function wifi(r: Extract<LightRef, { source: "wifi" }>): Driver {
  const c = new NetLightController(r.device, netSend);
  return {
    key: r.key,
    // A white-only light (a Key Light) takes the look's whites and its brightness, not colours.
    colour: (rgb) => (c.whiteOnly ? undefined : c.setColour(rgb)),
    gradient: (stops) => (c.whiteOnly ? undefined : c.setColour(middle(stops))),
    white: c.spec.kelvin ? (k) => c.setWhite(k) : undefined,
    brightness: (p) => c.setBrightness(p),
    power: (on) => c.setPower(on),
    close: () => c.close(),
  };
}

async function lampArray(r: Extract<LightRef, { source: "lamparray" }>): Promise<Driver> {
  const info = await backend.lampArrayInfo(r.device.id);
  // Lamps from left to right, for a gradient across the device.
  const across = info.lamps.map((l) => (info.width > 0 ? Math.max(0, Math.min(1, l.x / info.width)) : 0));
  const put = paced<Rgb[]>(LAMPARRAY_MS, (cs) => backend.lampArraySet(r.device.id, cs.flatMap((c) => [...c])));
  return {
    key: r.key,
    colour: (rgb) => put(info.lamps.map(() => rgb)),
    gradient: (stops) => {
      const g = gradient(stops, 64);
      put(across.map((x) => g[Math.min(63, Math.round(x * 63))]));
    },
    close: () => backend.lampArrayClose(r.device.id),
  };
}

/** A hub: the channels chosen on its page, each with its LED count; changes go only once the person allowed them. */
async function hub(r: Extract<LightRef, { source: "hub" }>, allowed: boolean): Promise<Driver> {
  const s = await connectHub(r.family);
  if (!s) throw new Error("SYNQ doesn't drive that hub.");
  const facts = await s.identify().catch(() => s.facts);
  s.setAllowChanges(allowed);
  const channels = peekKept<number[]>(`rgbhub.${r.family}.channels`, [0]).filter((ch) => ch < r.model.channels);
  const chosen = peekKept<Record<number, number>>(`rgbhub.${r.family}.leds`, {});
  const leds = (ch: number) => ledsFor(r.model, facts, chosen, ch);
  let last: Rgb = [255, 255, 255];
  const put = paced<Rgb>(HUB_MS, async (rgb) => {
    last = rgb;
    for (const ch of channels) await s.setChannel(ch, rgb, leds(ch));
  });
  return {
    key: r.key,
    colour: (rgb) => put(rgb),
    gradient: (stops) => put(middle(stops)),
    // Before the bridge takes over for screen sync, one change through the session keeps the hub's backup (as its page does).
    sync: { can: allowed && channels.length > 0, start: async () => void (s.backup ?? (await s.setChannel(channels[0], last, leds(channels[0])))) },
    hubChannels: channels.map((ch) => [ch, leds(ch)] as const),
    close: () => s.close(),
  };
}

/** Opens a light for the look; `hubAllowed` says whether the person allowed changes to hubs in the Lights view. */
export async function openDriver(r: LightRef, hubAllowed: (family: string) => boolean): Promise<Driver> {
  if (r.source === "govee") return govee(r);
  if (r.source === "wifi") return wifi(r);
  if (r.source === "lamparray") return lampArray(r);
  return hub(r, hubAllowed(r.family));
}
