// Which controller a detected id is (CONTROLLERS-ROADMAP.md rule 2: identify by what the device says, not its PID
// alone). The PID gives the candidates (models.ts, then the SDL / xpad table); the device's own answers confirm or
// correct: its product string, the collections it has, and where it was reached (HID, an XInput slot, the browser's
// Gamepad API). A pad whose answers don't fit its PID keeps its own name and gets no model-specific output.
//
// Pure functions: no DOM, no React, no device access.
import type { Connected } from "../backend";
import { PAD_MODELS } from "./models.ts";
import { padCollection, padGuardOf, padRow } from "./pads.ts";
import type { PadCaps, PadGuard, PadKind, PadModel, PadSettings, PadSupport, PadTransport } from "./types.ts";

/** Vendors by USB id (SDL usb_ids.h and the brand tables), for pads the table names without a brand. */
const VENDORS: Record<number, string> = {
  0x045e: "Microsoft",
  0x054c: "Sony",
  0x057e: "Nintendo",
  0x28de: "Valve",
  0x2dc8: "8BitDo",
  0x3537: "GameSir",
  0x04b4: "Flydigi",
  0x37d7: "Flydigi",
  0x1532: "Razer",
  0x0f0d: "HORI",
  0x0e6f: "PDP",
  0x24c6: "PowerA",
  0x20d6: "PowerA",
  0x046d: "Logitech",
  0x0738: "Mad Catz",
  0x1bad: "Mad Catz",
  0x044f: "Thrustmaster",
  0x10f5: "Turtle Beach",
  0x3285: "Nacon",
  0x146b: "Nacon",
  0x2e95: "SCUF",
  0x1b1c: "Corsair",
  0x2e24: "Hyperkin",
  0x0079: "DragonRise",
  0x2563: "ShanWan",
  0x2345: "Machenike",
  0x0b05: "ASUS",
  0x03f0: "HyperX",
  0x0c12: "Zeroplus",
  0x2c22: "Qanba",
  0x33dd: "ZUIKI",
  0x2e8a: "Raspberry Pi (GP2040-CE / SInput)",
  0x0955: "NVIDIA",
  0x18d1: "Google",
  0x1949: "Amazon",
  0x358a: "Backbone",
  0x3651: "CRKD",
};

/** A name for a pad of this type when nothing better is known. */
const KIND_NAMES: Record<PadKind, string> = {
  xbox360: "Xbox 360-compatible controller",
  xboxone: "Xbox-compatible controller",
  xboxelite: "Xbox Elite controller",
  ps3: "PlayStation 3-style controller",
  ps4: "PlayStation 4-style controller",
  ps5: "PlayStation 5-style controller",
  ps5edge: "DualSense Edge",
  switchpro: "Switch Pro-compatible controller",
  switchinput: "Switch controller",
  joycon: "Joy-Con",
  switch2: "Switch 2 controller",
  steam: "Steam Controller",
  steamdeck: "Steam Deck controls",
  steamtriton: "Steam Controller",
  horisteam: "HORIPAD for Steam",
  "8bitdo": "8BitDo controller",
  gamesir: "GameSir controller",
  flydigi: "Flydigi controller",
  generic: "Game controller",
};

const KIND_CAPS: Partial<Record<PadKind, Partial<PadCaps>>> = {
  ps4: { gyro: true, touchpad: true, battery: true },
  ps5: { gyro: true, touchpad: true, battery: true },
  switchpro: { gyro: true, triggers: null },
  joycon: { gyro: true, sticks: 1, triggers: null },
  steam: { gyro: true },
  steamtriton: { gyro: true, paddles: 4 },
  steamdeck: { gyro: true, paddles: 4 },
};

const BASE_CAPS: PadCaps = { sticks: 2, triggers: { bits: 8 }, paddles: 0, gyro: false, touchpad: false, battery: false, rumble: false, lights: false, adaptiveTriggers: false };

/** How the pad was reached. */
export type PadVia = "hid" | "xinput" | "gamepad";

export interface PadQuery {
  vid: number;
  pid: number;
  /** The product string the device reports (HID) or the browser's Gamepad id. */
  product?: string | null;
  via: PadVia;
  /** HID collections the device lists (usage page, usage). */
  collections?: readonly { usagePage: number; usage: number }[];
}

export interface PadIdentity {
  /** Navigation family: the model id, or `pad:<vid>:<pid>` for a pad without a model. */
  family: string;
  model: PadModel | null;
  name: string;
  brand: string;
  kind: PadKind;
  transport: PadTransport;
  /** What may be sent to it here (HID only; an XInput or Gamepad-API pad gets nothing). */
  guard: PadGuard;
  support: PadSupport;
  settings: PadSettings;
  personality: string | null;
  vid: number;
  pid: number;
  via: PadVia;
  caps: PadCaps;
  /** Why the answers didn't fit the PID, when they didn't (the model-specific parts are then off). */
  mismatch: string | null;
}

const MODEL_BY_ID = new Map<number, { model: PadModel; personality: string; transport: PadTransport }>();
for (const model of PAD_MODELS) for (const i of model.ids) MODEL_BY_ID.set(i.vid * 0x10000 + i.pid, { model, personality: i.personality, transport: i.transport });

export const padModel = (id: string): PadModel | undefined => PAD_MODELS.find((m) => m.id === id);
export const vendorName = (vid: number): string => VENDORS[vid] ?? "";

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** The product string, when it plainly names some other maker's pad than the one the PID was assigned to. */
function contradicts(model: PadModel, product: string): boolean {
  const p = product.toLowerCase();
  if (!p || /^(wireless controller|controller|gamepad|game controller|usb gamepad|hid-compliant game controller|pro controller|xbox|x-box)/.test(p)) return false;
  const brands = Object.values(VENDORS).map((b) => b.toLowerCase());
  const own = model.brand.toLowerCase();
  // It names a different brand outright ("8BitDo Pro 2" on a Sony id): another maker's pad borrowing the id.
  return brands.some((b) => b !== own && b.length > 3 && p.includes(b.split(" ")[0])) && !p.includes(own.split(" ")[0]);
}

/**
 * What this pad is. Null when the id isn't a controller SYNQ knows, or a HID device that carries none of the
 * collections the pad rule opens (pads.ts `padCollection`: gamepad or joystick, Valve's input collection, GameSir's
 * settings channel), such as a pad's keyboard or mouse emulation.
 */
export function identifyPad(q: PadQuery): PadIdentity | null {
  const row = padRow(q.vid, q.pid);
  const known = MODEL_BY_ID.get(q.vid * 0x10000 + q.pid);
  // An XInput slot or a browser gamepad is a controller whatever its id (Windows' own XInput ids included).
  if (!row && !known && q.via === "hid") return null;
  if (q.via === "hid" && q.collections && !q.collections.some((c) => padCollection(q.vid, q.pid, c.usagePage, c.usage))) return null;
  const product = clean(q.product);
  let model = known?.model ?? null;
  let mismatch: string | null = null;
  if (model && product && contradicts(model, product)) {
    mismatch = `It calls itself "${product}", not ${model.brand} ${model.name}: it is shown as what it says it is, and only read.`;
    model = null;
  }
  // Windows' XInput ids: xboxgip's 045E:02FF for any Xbox One-class pad, xusb22's 045E:02A1.
  const gipShim = q.vid === 0x045e && q.pid === 0x02ff;
  const kind: PadKind = row?.[2] ?? (q.via === "xinput" ? (gipShim ? "xboxone" : "xbox360") : "generic");
  const transport: PadTransport = q.via === "xinput" ? (row?.[3] === "gip" || gipShim ? "gip" : "xusb") : (known?.transport ?? row?.[3] ?? "hid");
  // Outputs only for a confirmed model reached as HID; never through XInput or the Gamepad API.
  const guard: PadGuard = q.via === "hid" && model ? (padGuardOf(q.vid, q.pid) ?? "input") : "input";
  // An XInput slot whose ids Windows didn't give (no XInputGetCapabilitiesEx, or Windows' own id): an Xbox-compatible pad.
  const unnamedXInput = q.via === "xinput" && !row && !known;
  const name = model?.name ?? (unnamedXInput ? "Xbox-compatible controller" : product && !/^(hid-compliant game controller|usb gamepad|game controller)$/i.test(product) ? product : (row?.[4] ?? KIND_NAMES[kind]));
  const brand = model?.brand ?? vendorName(q.vid);
  const caps: PadCaps = model?.caps ?? { ...BASE_CAPS, ...(KIND_CAPS[kind] ?? {}), battery: q.via === "xinput" };
  return {
    family: model ? model.id : `pad:${q.vid.toString(16).padStart(4, "0")}:${q.pid.toString(16).padStart(4, "0")}`,
    model,
    name,
    brand,
    kind,
    transport,
    guard,
    support: model?.support ?? (transport === "usb" ? "detect" : "tester"),
    settings: model?.settings ?? "none",
    personality: known?.personality ?? null,
    vid: q.vid,
    pid: q.pid,
    via: q.via,
    caps,
    mismatch,
  };
}

/**
 * The USB ids in a browser Gamepad id: Chromium "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c
 * Product: 0ce6)", Firefox and Safari "054c-0ce6-DualSense Wireless Controller". Null when it has none (Chromium's
 * XInput pads: "Xbox 360 Controller (XInput STANDARD GAMEPAD)").
 */
export function gamepadIds(id: string): { vid: number; pid: number; name: string } | null {
  const chromium = id.match(/^(.*?)\s*\((?:.*?)Vendor:\s*([0-9a-f]{4})\s*Product:\s*([0-9a-f]{4})\)\s*$/i);
  if (chromium) return { vid: parseInt(chromium[2], 16), pid: parseInt(chromium[3], 16), name: clean(chromium[1]) };
  const dashed = id.match(/^([0-9a-f]{1,4})-([0-9a-f]{1,4})-(.*)$/i);
  if (dashed) return { vid: parseInt(dashed[1], 16), pid: parseInt(dashed[2], 16), name: clean(dashed[3]) };
  return null;
}

const hexId = (s: string) => parseInt(s, 16);

/** What a listed device is, as a controller (null when it isn't one SYNQ knows). */
export function identifyConnected(d: Connected): PadIdentity | null {
  if (d.kind !== "controller" || !d.pad) return null;
  return identifyPad({ vid: hexId(d.vid), pid: hexId(d.pid), product: d.reported, via: d.pad.via, collections: d.collections });
}
