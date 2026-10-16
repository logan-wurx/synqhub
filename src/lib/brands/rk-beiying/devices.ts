// Royal Kludge "BeiYing" boards (SinoWealth, VID 0x258A): the keyboards RK's older Windows software, Rangoli
// (rnayabed/rangoli, GPL-3.0), KludgeKnight (vinc3m1/kludgeknight, GPL-3.0, WebHID) and Fighting Control Center
// (FCC, GPL-3.0-or-later, the M75 family) drive over one write-only channel:
//
//   System Control collection 0x0001:0x0080, HID feature report id 0x0A, 64 data bytes, nothing ever answers.
//
// Chromium hides the System Control collection from WebHID (src/lib/web/availability.ts), so the website can only
// reach these boards through SYNQ Helper; the desktop app's bridge opens exactly this collection, for feature
// reports only (src-tauri/src/brands.rs), never the board's keyboard or any input collection.
//
// The table (catalog.generated.ts, made by scripts/gen-rk-beiying-catalog.mjs) names 168 boards: every board in
// RK's own software list whose data SYNQ can read, minus Rangoli's "not supported" boards, the boards with a
// screen (a newer data format) and the ones with no lighting table. Every board starts read-only behind "Allow
// changes", and nothing it does can be read back: every write is "unconfirmed".
//
// Nothing here talks to a device. Erasable TypeScript only (node runs scripts/ directly).
import type { Channel, DeviceEntry, Source, SupportTier } from "../local-kb.ts";
import { RK_BOARDS, RK_LAYOUTS, RK_OWN_MODES, RK_RGB_OLD_MODES, type RkBoard, type RkLayoutKey } from "./catalog.generated.ts";

export const RK_VID = 0x258a;
/** The one collection and report these boards are configured through. [FCC PROTOCOL-RK.md "Transport"; KludgeKnight HIDDeviceManager] */
export const RK_CHANNEL: Channel = { usagePage: 0x0001, usage: 0x0080, transport: "feature", reportId: 0x0a, length: 64 };
export const RK_REPORT_ID = RK_CHANNEL.reportId;
export const RK_DATA_LEN = RK_CHANNEL.length;
/** Key slots in the base layer's map: (60 + 8 x 62) bytes at 4 bytes each. */
export const RK_KEY_SLOTS = 139;

const SRC_RANGOLI: Source = { kind: "open-source", ref: "github.com/rnayabed/rangoli (keyboards-list.md, src/keyboardconfiguratorcontroller.cpp)", license: "GPL-3.0" };
const SRC_KK: Source = { kind: "open-source", ref: "github.com/vinc3m1/kludgeknight (public/rk/Dev, docs/lighting-protocol.md)", license: "GPL-3.0" };
const SRC_FCC: Source = { kind: "open-source", ref: "github.com/shybruh/FightingControlCenter-FCC (docs/PROTOCOL-RK.md, app/src/hid/rk.ts)", license: "GPL-3.0-or-later" };

export interface RkModel extends DeviceEntry {
  board: RkBoard;
  /** Why SYNQ shows this board read-only: who has (not) confirmed it. */
  evidence: string;
}

const EVIDENCE: Record<RkBoard["status"], string> = {
  confirmed: "Rangoli's author confirmed this board fully working.",
  listed: "Rangoli (or FCC) lists this board as working; nobody has confirmed it with SYNQ.",
  partial: "Rangoli says this board only partly works.",
  "rk-only": "Only RK's own software lists this board; no open-source tool has confirmed it.",
};

function model(b: RkBoard): RkModel {
  const quirk = b.quirks.includes("swap-red-green") ? " Rangoli reports red and green swapped on this board; SYNQ swaps them back." : "";
  const noMap = b.keymap ? "" : " The key map isn't offered: not every key's default is known, and SYNQ rewrites the whole map.";
  const tier: SupportTier = "experimental";
  return {
    vendor: "Royal Kludge",
    vendorId: RK_VID,
    productId: b.pid,
    model: b.name,
    kind: "keyboard",
    connection: "usb",
    channel: RK_CHANNEL,
    tier,
    sources: [SRC_RANGOLI, SRC_KK, SRC_FCC],
    notes: `${EVIDENCE[b.status]}${quirk}${noMap}`,
    board: b,
    evidence: EVIDENCE[b.status],
  };
}

export const RK_MODELS: readonly RkModel[] = RK_BOARDS.map(model);
const byPid = new Map<number, RkModel>(RK_MODELS.map((m) => [m.productId, m]));
if (byPid.size !== RK_MODELS.length) throw new Error("rk-beiying devices: a duplicate product id");

/** The model for a USB id, or null. No I/O. */
export const rkModel = (vendorId: number, productId: number): RkModel | null => (vendorId === RK_VID ? (byPid.get(productId) ?? null) : null);

/** Every [vendor id, product id] this driver claims. */
export const RK_IDS: readonly (readonly [number, number])[] = RK_MODELS.map((m) => [RK_VID, m.productId] as const);

/** The layout rows of a board: [slot, default firmware code, x, y, w, h]. */
export const layoutOf = (b: RkBoard): readonly RkLayoutKey[] => RK_LAYOUTS[b.layout] ?? [];

/** The board's default firmware code per slot. */
export const defaultCodes = (b: RkBoard): Map<number, number> => new Map(layoutOf(b).map((k) => [k[0], k[1]]));

// ---------------------------------------------------------------------------------------------
// Lighting modes
// ---------------------------------------------------------------------------------------------

/** The standard mode names, by mode number - 1 (RK's global led.xml; also Rangoli's non-RGB table). */
export const STANDARD_MODES: readonly string[] = [
  "Steady",
  "Customize",
  "Breathing",
  "Press and destroy",
  "Neon stream",
  "Streamer",
  "Ambilight",
  "Dripping ripples",
  "Brilliant point",
  "Flash away",
  "Shadow disappear",
  "Ripples shining",
  "Rich and honored",
  "Marquee effect",
  "Rotating storm",
  "Serpentine horse race",
  "Stars twinkle",
  "Retro snake",
  "Diagonal transformation",
  "Sine wave",
];

export interface RkMode {
  /** The number sent in byte 5 of the lighting report. */
  n: number;
  name: string;
  speed: boolean;
  brightness: boolean;
  /** 0 none, 1 left / right, 2 up / down. */
  direction: number;
  random: boolean;
  color: boolean;
  /** The per-key colour mode: needs 7 more reports SYNQ doesn't send, so it isn't offered. */
  custom: boolean;
}

export function modeName(b: RkBoard, n: number): string {
  if (b.gen === "own") return RK_OWN_MODES[b.pid]?.[n] ?? `Mode ${n}`;
  if (b.gen === "rgb-old") return RK_RGB_OLD_MODES[n - 1] ?? `Mode ${n}`;
  return STANDARD_MODES[n - 1] ?? `Mode ${n}`;
}

/** All of a board's modes with their capabilities. */
export function modesOf(b: RkBoard): RkMode[] {
  return b.modes.map(([n, f]) => {
    const name = modeName(b, n);
    return { n, name, speed: !!(f & 1), brightness: !!(f & 2), direction: (f >> 2) & 3, random: !!(f & 16), color: !!(f & 32), custom: /^custom(ize)?$/i.test(name) };
  });
}

/** The modes SYNQ offers: the board's own, without the per-key colour mode. */
export const offeredModes = (b: RkBoard): RkMode[] => modesOf(b).filter((m) => !m.custom);
