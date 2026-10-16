// USB RGB hubs (wave L4): NZXT HUE 2 / RGB & Fan Controller, Corsair Lighting Node / Commander Pro and the Lian Li Uni Hub
// SL, from the protocol facts OpenRGB documents (GPL-2.0; credited in Settings and docs/devices/LIGHTING.md, no code
// copied). The table is hubs.json, shared with the bridge (src-tauri/src/lighting/hidrgb.rs). SYNQ reads what a hub
// says about itself and sends one colour per channel; nothing else. Pure: no device here.
import HUBS from "./hubs.json" with { type: "json" };

export type Rgb = readonly [number, number, number];
export type Family = "nzxt-hue2" | "corsair-node" | "lianli-sl";

export interface HubModel {
  vid: string;
  pid: string;
  family: Family;
  name: string;
  channels: number;
}

export interface IdentifyOnly {
  vid: string;
  pid: string;
  name: string;
  what: string;
  why: string;
}

/** A report as it goes over the wire: its id and the bytes after it. */
export interface Frame {
  reportId: number;
  data: Uint8Array;
}

export const MODELS = HUBS.models as HubModel[];
export const IDENTIFY_ONLY = HUBS.identifyOnly as IdentifyOnly[];
export const FAMILIES = HUBS.families as Record<Family, { brand: string; maxLeds: number; collection: [number, number] | null }>;

const hex = (v: string | number) => (typeof v === "number" ? v.toString(16).padStart(4, "0") : v.toLowerCase().replace(/^0x/, "").padStart(4, "0"));
export const findHub = (vid: string | number, pid: string | number): HubModel | null => MODELS.find((m) => m.vid === hex(vid) && m.pid === hex(pid)) ?? null;
export const findIdentifyOnly = (vid: string | number, pid: string | number): IdentifyOnly | null => IDENTIFY_ONLY.find((m) => m.vid === hex(vid) && m.pid === hex(pid)) ?? null;

/** The length of a family's reports after the report id. Lian Li's colour report is longer than its control reports. */
export const DATA_LEN: Record<Family, number> = { "nzxt-hue2": 63, "corsair-node": 64, "lianli-sl": 10 };
export const LIANLI_COLOUR_LEN = 1 + 64 * 3;
/** Lian Li SL: up to four fans of 16 LEDs on a channel. */
export const LIANLI_LEDS_PER_FAN = 16;
export const LIANLI_MAX_FANS = 4;

/** NZXT: what the hub reports on each channel (accessory id: name and LED count). */
export const NZXT_ACCESSORIES: Record<number, { name: string; leds: number }> = {
  0x01: { name: "HUE 1 strip", leds: 10 },
  0x02: { name: "Aer 1 fan", leds: 8 },
  0x04: { name: "HUE 2 strip", leds: 10 },
  0x05: { name: "HUE 2 strip", leds: 8 },
  0x06: { name: "HUE 2 strip", leds: 6 },
  0x08: { name: "HUE 2 cable comb", leds: 14 },
  0x09: { name: "HUE 2 underglow (300 mm)", leds: 15 },
  0x0a: { name: "HUE 2 underglow (200 mm)", leds: 10 },
  0x0b: { name: "Aer 2 fan (120 mm)", leds: 8 },
  0x0c: { name: "Aer 2 fan (140 mm)", leds: 8 },
  0x10: { name: "Kraken X3 ring", leds: 8 },
  0x11: { name: "Kraken X3 logo", leds: 1 },
  0x13: { name: "F120 RGB fan", leds: 18 },
  0x14: { name: "F140 RGB fan", leds: 18 },
  0x15: { name: "F120 RGB Duo fan", leds: 20 },
  0x16: { name: "F140 RGB Duo fan", leds: 20 },
  0x17: { name: "F120 RGB Core fan", leds: 8 },
  0x18: { name: "F140 RGB Core fan", leds: 8 },
  0x19: { name: "F120 RGB Core fan (case)", leds: 8 },
  0x1c: { name: "F280 RGB Core fan (case)", leds: 16 },
  0x1d: { name: "F360 RGB Core fan (case)", leds: 24 },
  0x1e: { name: "Kraken Elite ring", leds: 24 },
  0x1f: { name: "F420 RGB fan", leds: 24 },
};

/** Corsair's hardware effect for one colour (the hub keeps it with no app running), and the commands around it. */
const CORSAIR = { firmware: 0x02, commit: 0x33, begin: 0x34, effect: 0x35, reset: 0x37, portState: 0x38, hardware: 0x01, static: 0x04 } as const;
const NZXT = { firmware: [0x10, 0x01], deviceList: [0x20, 0x03], colour: 0x22, direct: 0x10, apply: 0xa0 } as const;
const LIANLI = { report: 0xe0, activate: [0x10, 0x32], colour: 0x30, mode: 0x10, static: 0x01, slowest: 0x02, brightest: 0x00 } as const;

function frame(reportId: number, len: number, bytes: readonly number[], at = 0): Frame {
  const data = new Uint8Array(len);
  data.set(bytes, at);
  return { reportId, data };
}

/** What SYNQ asks a hub to learn about it (read only): NZXT's firmware and accessory list, Corsair's firmware. Lian Li has none. */
export function identifyFrames(m: HubModel): Frame[] {
  if (m.family === "nzxt-hue2") return [frame(NZXT.firmware[0], 63, [NZXT.firmware[1]]), frame(NZXT.deviceList[0], 63, [NZXT.deviceList[1]])];
  if (m.family === "corsair-node") return [frame(0, 64, [CORSAIR.firmware])];
  return [];
}

/** How many LEDs a channel may be given: up to the family's maximum (Lian Li counts fans of 16). */
export const maxLeds = (m: HubModel) => FAMILIES[m.family].maxLeds;
const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * The frames that light one channel in one colour, or null when the channel or LED count is out of range.
 * NZXT: the colours (green, red, blue per LED; 20 per frame), then apply. Corsair: reset, begin, hardware control and a
 * static effect in that colour, then commit. Lian Li SL: activate the channel's fans, the colours (red, blue, green),
 * then static mode at full brightness.
 */
export function colourFrames(m: HubModel, channel: number, rgb: Rgb, leds: number): Frame[] | null {
  if (!Number.isInteger(channel) || channel < 0 || channel >= m.channels) return null;
  if (!Number.isInteger(leds) || leds < 1 || leds > maxLeds(m)) return null;
  const [r, g, b] = rgb.map(clamp8);
  if (m.family === "nzxt-hue2") {
    const out: Frame[] = [];
    for (let group = 0; group * 20 < leds; group++) {
      const n = Math.min(20, leds - group * 20);
      out.push(frame(NZXT.colour, 63, [NZXT.direct | group, 1 << channel, 0, ...Array.from({ length: n }, () => [g, r, b]).flat()]));
    }
    out.push(frame(NZXT.colour, 63, [NZXT.apply, 1 << channel, 0x00, 0x01, 0, 0, 0x28, 0, 0, 0x80, 0, 0x32, 0, 0, 0x01]));
    return out;
  }
  if (m.family === "corsair-node") {
    return [
      frame(0, 64, [CORSAIR.reset, channel]),
      frame(0, 64, [CORSAIR.begin, channel]),
      frame(0, 64, [CORSAIR.portState, channel, CORSAIR.hardware]),
      frame(0, 64, [CORSAIR.effect, channel, 0, leds, CORSAIR.static, 0, 0, 0, 0, r, g, b]),
      frame(0, 64, [CORSAIR.commit, 0xff]),
    ];
  }
  if (leds % LIANLI_LEDS_PER_FAN !== 0) return null;
  const fans = leds / LIANLI_LEDS_PER_FAN;
  const colour = new Uint8Array(LIANLI_COLOUR_LEN);
  colour[0] = LIANLI.colour + channel;
  for (let i = 0; i < leds; i++) colour.set([r, b, g], 1 + i * 3);
  return [
    frame(LIANLI.report, 10, [...LIANLI.activate, 0x10 * channel + fans]),
    { reportId: LIANLI.report, data: colour },
    frame(LIANLI.report, 10, [LIANLI.mode + channel, LIANLI.static, LIANLI.slowest, 0, LIANLI.brightest]),
  ];
}

export interface HubFacts {
  firmware: string | null;
  /** NZXT: what is plugged into each channel, as the hub reports it. */
  accessories: { channel: number; items: { id: number; name: string; leds: number }[] }[] | null;
}

/** Folds one reply into what SYNQ knows; replies it doesn't recognise change nothing. */
export function readReply(m: HubModel, reply: Uint8Array, facts: HubFacts): HubFacts {
  if (m.family === "nzxt-hue2") {
    // Replies carry their report id in the first byte: 0x11 0x01 (firmware) and 0x21 0x03 (accessories).
    if (reply[0] === 0x11 && reply[1] === 0x01) return { ...facts, firmware: `${reply[0x11]}.${reply[0x12]}.${reply[0x13]}` };
    if (reply[0] === 0x21 && reply[1] === 0x03) {
      const accessories = Array.from({ length: m.channels }, (_, channel) => ({
        channel,
        items: Array.from({ length: 6 }, (_, i) => reply[0x0f + 6 * channel + i])
          .filter((id) => id !== 0)
          .map((id) => ({ id, ...(NZXT_ACCESSORIES[id] ?? { name: `Accessory 0x${id.toString(16).padStart(2, "0")}`, leds: 0 }) })),
      }));
      return { ...facts, accessories };
    }
    return facts;
  }
  if (m.family === "corsair-node" && reply.length >= 4) return { ...facts, firmware: `${reply[1]}.${reply[2]}.${reply[3]}` };
  return facts;
}

/** NZXT: the LED count the hub's own report gives a channel (0 when it reports nothing there). */
export const reportedLeds = (facts: HubFacts, channel: number) => facts.accessories?.find((a) => a.channel === channel)?.items.reduce((n, i) => n + i.leds, 0) ?? 0;

/** What each channel drives, as the person set it (Corsair and Lian Li can't report it) or the hub reported it (NZXT).
 * Shared by the hub's page and the Lights view (src/lib/lighting/look). */
export function ledsFor(m: HubModel, facts: HubFacts, chosen: Record<number, number>, ch: number): number {
  if (chosen[ch]) return chosen[ch];
  if (m.family === "nzxt-hue2") return reportedLeds(facts, ch) || maxLeds(m);
  return m.family === "lianli-sl" ? LIANLI_LEDS_PER_FAN : 16;
}
