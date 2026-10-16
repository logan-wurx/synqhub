// The "0x19F5" firmware family: one OEM keyboard firmware (MCHOSE calls it "glw", Royal Kludge "Gcome") that
// MCHOSE, NuPhy, Royal Kludge and DrunkDeer's newer boards all ship, with one framing on the Generic
// Desktop collection 0x0001:0x0000: 64-byte output/input reports, [0x55, cmd, 0, checksum, len, offset
// lo, offset hi, flag, data...] and a [0xAA, ...] reply (protocol.ts).
//
// Which boards, and what SYNQ does with each (the family decides the guard, see guard.ts):
//   mchose     28 first-generation MCHOSE magnetic keyboards (31 USB ids on 0x41E4 / 0x3837 / 0x19F5). Protocol,
//              areas and model table from Fighting Control Center (FCC, GPL-3.0-or-later; mc-catalog.json,
//              docs/PROTOCOL-MC.md). FCC lists all 28 as untested, so every one starts read-only behind "Allow
//              changes". 3837:3033 is shared by four models, so it is read-only too (no layout to draw).
//   drunkdeer  DrunkDeer's newer boards on 0x19F5 (7 ids). The same 0x55 framing is confirmed for the A75 Pro OEM
//              relabel 19F5:FB5C by a USB capture (svumo/DrunkDeer-Control, MIT, docs/gen2-wire-format-confirmed.md):
//              key triggers read with area 160, written with area 161, the last chunk flagged. Only FB5C may be
//              written (behind "Allow changes"); the other six ids are shown read-only.
//   nuphy      NuPhy V3 / HE boards (38 ids). The framing is the same (NuPhyIO's web driver, docs only), but its
//              area numbers are not documented anywhere SYNQ can use, and the newest firmware masks traffic
//              with a per-session XOR key whose key exchange is documented nowhere. So: read-only, and only the
//              firmware version is read.
//   rk-gcome   Royal Kludge boards that RK's web driver tags "Gcome" (9 USB ids): the same firmware by its "GLW"
//              firmware paths. Read-only like NuPhy.
//
// Update-mode ("upgrader") ids of the family are listed in FW_UPGRADERS and refused by every layer
// (src/lib/bootloader-ids.ts, hid.rs). 19F5:AFxx is already a whole range there.
//
// Nothing here talks to a device. Erasable TypeScript only (node runs scripts/ directly).
import type { Channel, DeviceEntry, Source, SupportTier } from "../local-kb.ts";
import { OEM_19F5_PIDS as DRUNKDEER_19F5_PIDS } from "../drunkdeer/devices.ts";
import { MC_BOARDS, MC_LAYOUTS, type McBoard, type McLayoutKey } from "./mchose-catalog.generated.ts";

export const VID_19F5 = 0x19f5;
export const VID_41E4 = 0x41e4;
export const VID_3837 = 0x3837;
/** Vendor ids this family's boards use. */
export const FW_VIDS: readonly number[] = [VID_19F5, VID_41E4, VID_3837];

/**
 * The configuration collection: Generic Desktop (usage page 0x0001) with usage 0x0000 ("undefined"), which is
 * not the keyboard (usage 6), mouse (2), keypad (7) or system-control (0x80) collection. 64-byte reports with
 * no report id, out and in. [FCC PROTOCOL-MC.md "Transport"; NuPhyIO filters {usage:0, usagePage:1}]
 */
export const FW_CHANNEL: Channel = { usagePage: 0x0001, usage: 0x0000, transport: "output+input", reportId: 0, length: 64 };

export type FwFamily = "mchose" | "drunkdeer" | "nuphy" | "rk-gcome";

export const FAMILY_LABEL: Readonly<Record<FwFamily, string>> = {
  mchose: "MCHOSE",
  drunkdeer: "DrunkDeer",
  nuphy: "NuPhy",
  "rk-gcome": "Royal Kludge",
};

const SRC_FCC: Source = { kind: "open-source", ref: "github.com/shybruh/FightingControlCenter-FCC (docs/PROTOCOL-MC.md, app/src/hid/mc.ts, mc-catalog.json)", license: "GPL-3.0-or-later" };
const SRC_SVUMO: Source = { kind: "open-source", ref: "github.com/svumo/DrunkDeer-Control (docs/gen2-wire-format-confirmed.md)", license: "MIT" };
const SRC_NUPHY: Source = { kind: "configurator-js", ref: "nuphy.io main.23dc78ef.js (device table only; docs only)" };
const SRC_RK: Source = { kind: "configurator-js", ref: "drive.rkgaming.com (protocolType Gcome entries; docs only)" };
const SRC_KBCN: Source = { kind: "configurator-js", ref: "drunkdeer.keybord.net.cn (0x19F5 app page.js; docs only)" };

/** Travel facts for boards whose catalogue row lacks them (DrunkDeer gen 2: 0.01 mm units, 128 key records). */
export interface Travel {
  /** Raw units per mm. */
  step: number;
  /** The smallest rapid-trigger step in mm. */
  precision: number;
  /** Plausibility ceiling, mm. */
  maxTravel: number;
  /** Key records in the trigger table. */
  maxKeyCount: number;
  /** What the panel lets the person pick, mm. */
  actuation: readonly [number, number];
  rapidTrigger: readonly [number, number];
}

export interface FwModel extends DeviceEntry {
  family: FwFamily;
  /** Brand as shown ("MCHOSE", "NuPhy"). */
  brand: string;
  /** Name without the brand ("Ace 60 Pro"). */
  name: string;
  /** The catalogue row, when this id names exactly one MCHOSE board. */
  board: McBoard | null;
  /** More than one board shares this id (3837:3033): their names, no layout. */
  candidates: readonly McBoard[];
  /** Travel facts when the board has no catalogue row (DrunkDeer gen 2). */
  travel: Travel | null;
}

/** DrunkDeer gen 2: unit and range from svumo's capture (0.01 mm) and the official bundle's slider limits. */
const DRUNKDEER_TRAVEL: Travel = { step: 100, precision: 0.01, maxTravel: 3.8, maxKeyCount: 128, actuation: [0.2, 3.3], rapidTrigger: [0.05, 3.1] };

const base = (vendorId: number, productId: number, brand: string, name: string, family: FwFamily, tier: SupportTier, sources: readonly Source[], notes: string): FwModel => ({
  vendor: brand,
  vendorId,
  productId,
  model: `${brand} ${name}`,
  kind: "keyboard",
  connection: "usb",
  channel: FW_CHANNEL,
  tier,
  sources,
  notes,
  family,
  brand,
  name,
  board: null,
  candidates: [],
  travel: null,
});

// ---------------------------------------------------------------------------------------------
// MCHOSE (FCC)
// ---------------------------------------------------------------------------------------------

const key = (v: number, p: number) => v * 0x10000 + p;

function mchoseModels(): FwModel[] {
  const byId = new Map<number, McBoard[]>();
  for (const b of MC_BOARDS) for (const [v, p] of b.ids) byId.set(key(v, p), [...(byId.get(key(v, p)) ?? []), b]);
  const out: FwModel[] = [];
  for (const [k, boards] of byId) {
    const vendorId = Math.floor(k / 0x10000);
    const productId = k % 0x10000;
    if (boards.length === 1) {
      const b = boards[0];
      out.push({ ...base(vendorId, productId, "MCHOSE", b.name, "mchose", "experimental", [SRC_FCC], `${b.id}: FCC lists it as untested. ${b.effects.length ? "" : "The official driver offers no lighting effects for it. "}Travel ${b.step} units per mm, up to ${b.maxTravel} mm.`), board: b });
    } else {
      const names = boards.map((b) => b.name).join(" / ");
      out.push({
        ...base(vendorId, productId, "MCHOSE", names, "mchose", "readOnly", [SRC_FCC], `Shared by ${boards.length} models (${names}): the official driver tells them apart only by asking the person. Nothing is written, and the keys can't be drawn.`),
        candidates: boards,
      });
    }
  }
  return out.sort((a, b) => a.vendorId - b.vendorId || a.productId - b.productId);
}

// ---------------------------------------------------------------------------------------------
// NuPhy (NuPhyIO's device table: [app id, upgrader id, name])
// ---------------------------------------------------------------------------------------------

/** [app PID, upgrader PID (null: not listed), name]. All on 19F5. */
const NUPHY: readonly (readonly [number, number | null, string])[] = [
  [0x102d, 0x072d, "Air100 V3"], [0x1039, 0x0739, "Air100 V3 (ISO)"], [0x103f, 0x073f, "Air100 V3 (JIS)"],
  [0xfee0, 0xff20, "Air60 HE"],
  [0x102b, 0x072b, "Air65 V3"], [0x1040, 0x0740, "Air65 V3 (ISO)"], [0x1042, 0x0742, "Air65 V3 (JIS)"],
  [0x6120, 0x6f10, "Air75 HE"],
  [0x1028, 0x0722, "Air75 V3"], [0x102a, 0x0724, "Air75 V3 (ISO)"], [0x1029, 0x0723, "Air75 V3 (JIS)"],
  [0x6130, 0xff5a, "BH65 HE"],
  [0xfe70, 0xff02, "Field75 HE"], [0x6132, 0xaf0f, "Field75 HE V2"],
  [0x6100, null, "Gem80 HE"],
  [0x6112, 0x6f03, "Halo65 HE"], [0x6113, 0x6f04, "Halo65 HE Pro"],
  [0x102f, 0x072f, "Halo65 Lite"], [0x102c, 0x072c, "Halo75 Lite"], [0x1043, 0x0743, "Halo75 V2 (ISO)"],
  [0x102e, 0x072e, "Halo96 Lite"], [0x1044, 0x0744, "Halo96 V2 (ISO)"],
  [0x1026, 0x0720, "Kick75"], [0x1027, 0x0721, "Kick75 High"],
  [0x1037, 0x0737, "Node100"], [0x1036, 0x0736, "Node100 High"], [0x1038, 0x0738, "Node100 High (ISO)"], [0x103a, 0x073a, "Node100 High (JIS)"], [0x103b, 0x073b, "Node100 (ISO)"], [0x103c, 0x073c, "Node100 (JIS)"],
  [0x1030, 0x0730, "Node75"], [0x1031, 0x0731, "Node75 High"], [0x1035, 0x0735, "Node75 High (ISO)"], [0x1033, 0x0733, "Node75 High (JIS)"], [0x1034, 0x0734, "Node75 (ISO)"], [0x1032, 0x0732, "Node75 (JIS)"],
  [0x6131, 0x6f11, "Type2nd"],
  [0xa011, 0x8a04, "WH80"],
];

const NUPHY_NOTE =
  "NuPhyIO speaks this framing, but SYNQ has no documented area or command numbers for NuPhy, and the newest NuPhy firmware masks traffic with a per-session XOR key. So SYNQ reads the firmware version and nothing else.";

// ---------------------------------------------------------------------------------------------
// Royal Kludge "Gcome" (RK's web driver: USB entries; the 2.4 GHz dongles are not claimed)
// ---------------------------------------------------------------------------------------------

/** [PID, name, upgrader PID]. All on 19F5. */
const RK_GCOME: readonly (readonly [number, string, number])[] = [
  [0xa01c, "K99", 0x8a11],
  [0xa049, "K99 (2nd revision)", 0x8a44],
  [0xa021, "R87 Pro V2", 0x8a1a],
  [0xa023, "T98", 0x8a1c],
  [0xa042, "R98 Pro GT", 0x8a3d],
  [0xa024, "T87", 0x8a1d],
  [0xa02c, "R99", 0x8a27],
  [0xa043, "R99 (2nd revision)", 0x8a3e],
  [0xa045, "R99 (UK)", 0x8a40],
];
/** Royal Kludge's 2.4 GHz receiver upgrader that serves several of those boards. */
const RK_DONGLE_UPGRADER = 0xfe00;
const RK_NOTE = "RK's web driver tags this board Gcome (firmware paths under GLW), the same firmware as MCHOSE's. SYNQ has no documented command numbers for it, so it reads the firmware version and nothing else.";

// ---------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------

export const FW_MODELS: readonly FwModel[] = [
  ...mchoseModels(),
  ...DRUNKDEER_19F5_PIDS.map((pid) =>
    pid === 0xfb5c
      ? { ...base(VID_19F5, pid, "DrunkDeer", "A75 Pro (OEM)", "drunkdeer", "experimental", [SRC_SVUMO, SRC_KBCN], "A75 Pro relabel with USB strings 'DrunkDeer' / 'DrunkDeer A75 Pro' (firmware 1.7). svumo's USB capture confirms the 0x55 framing, area 160 reads and area 161 writes; replies may arrive on a collection Windows does not let apps read, so the board may not answer here."), travel: DRUNKDEER_TRAVEL }
      : { ...base(VID_19F5, pid, "DrunkDeer", "gen 2 (OEM)", "drunkdeer", "readOnly", [SRC_KBCN], "Another DrunkDeer board on the OEM platform. Only the A75 Pro (FB5C) has been captured, so this one is read-only."), travel: DRUNKDEER_TRAVEL },
  ),
  ...NUPHY.map(([pid, , name]) => base(VID_19F5, pid, "NuPhy", name, "nuphy", "readOnly", [SRC_NUPHY], NUPHY_NOTE)),
  ...RK_GCOME.map(([pid, name]) => base(VID_19F5, pid, "Royal Kludge", name, "rk-gcome", "readOnly", [SRC_RK], RK_NOTE)),
];

const byKey = new Map<number, FwModel>(FW_MODELS.map((m) => [key(m.vendorId, m.productId), m]));
const dup = FW_MODELS.length - byKey.size;
if (dup !== 0) throw new Error(`fw19f5 devices: ${dup} duplicate USB id(s)`);

/** The model for a USB id, or null. No I/O. */
export const fwModel = (vendorId: number, productId: number): FwModel | null => byKey.get(key(vendorId, productId)) ?? null;

/** Every [vendor id, product id] this family claims. */
export const FW_IDS: readonly (readonly [number, number])[] = FW_MODELS.map((m) => [m.vendorId, m.productId] as const);

/** The ids of one family, for the bridge tables. */
export const fwIdsOf = (family: FwFamily): readonly (readonly [number, number])[] => FW_MODELS.filter((m) => m.family === family).map((m) => [m.vendorId, m.productId] as const);

/** The layout rows of a catalogue row. */
export const layoutOf = (b: McBoard): readonly McLayoutKey[] => MC_LAYOUTS[b.layout] ?? [];

// ---------------------------------------------------------------------------------------------
// Update-mode ids
// ---------------------------------------------------------------------------------------------

export interface FwUpgrader {
  vendorId: number;
  productId: number;
  what: string;
  source: string;
}

/**
 * Upgrader (firmware-update) ids of this family. NuPhyIO's upgrader PIDs are 36 explicit ids plus
 * 19F5:AF0F, which sits in the 19F5:AFxx range src/lib/bootloader-ids.ts already refuses as a whole; RK's
 * are the "Upgrader" entries of its web driver. SYNQ never lists, opens or sends to any of them.
 */
export const FW_UPGRADERS: readonly FwUpgrader[] = [
  ...NUPHY.flatMap(([, up, name]) => (up === null ? [] : [{ vendorId: VID_19F5, productId: up, what: `NuPhy ${name} (upgrader)`, source: "NuPhyIO device table (nuphy.io)" }])),
  ...RK_GCOME.map(([, name, up]) => ({ vendorId: VID_19F5, productId: up, what: `Royal Kludge ${name} (upgrader)`, source: "drive.rkgaming.com device table" })),
  { vendorId: VID_19F5, productId: RK_DONGLE_UPGRADER, what: "Royal Kludge 2.4 GHz receiver (upgrader)", source: "drive.rkgaming.com device table" },
];

/** Any 19F5:0xAFxx is an upgrader too, listed or not (the range src/lib/bootloader-ids.ts refuses). */
export const isAfRange = (vendorId: number, productId: number): boolean => vendorId === VID_19F5 && (productId & 0xff00) === 0xaf00;

export const isFwUpgrader = (vendorId: number, productId: number): boolean => isAfRange(vendorId, productId) || FW_UPGRADERS.some((u) => u.vendorId === vendorId && u.productId === productId);

/** The upgrader ids that need their own row in the bootloader tables (the AFxx ones are covered by the range). */
export const FW_UPGRADER_ROWS: readonly FwUpgrader[] = FW_UPGRADERS.filter((u) => !isAfRange(u.vendorId, u.productId));

// ---------------------------------------------------------------------------------------------
// Lighting effects (FCC PROTOCOL-MC.md "Function config")
// ---------------------------------------------------------------------------------------------

export const MC_EFFECT_NAMES: Readonly<Record<number, string>> = {
  0: "Custom per-key",
  1: "Rainbow cycle",
  2: "Gradient",
  3: "Static",
  4: "Breathing",
  5: "Disco",
  6: "Horizontal wave",
  7: "Vertical wave",
  8: "Centre spread",
  9: "Starlight",
  10: "Spiral",
  11: "Rise and fall",
  12: "Bounce",
  13: "Reactive ripple",
  14: "Ripple",
  15: "Afterimage",
  16: "Reactive fireworks",
  17: "Light pillars",
  18: "Diagonal flow",
  19: "Laser rain",
  20: "Twinkle",
  21: "Fireworks",
  22: "Triangle bounce",
  255: "Off",
};
