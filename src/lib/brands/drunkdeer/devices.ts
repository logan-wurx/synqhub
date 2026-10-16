// DrunkDeer Hall-effect keyboards: USB identities, firmware type codes, per-model capabilities and the
// firmware "wire dialect" rules (which per-key packet shape and mm scale a board speaks).
//
// Sources (what came from where):
//   [antler]  Official web configurator https://drunkdeer-antler.com, bundle js/index.CJWCGjvj.js (live
//             2026-10-13, same hash as the saved copy). DOCS ONLY: facts read from it (filter list, type-byte
//             dispatch, firmware cutoffs, colour-mode tables, slider limits); no code copied.
//   [kbcn]    Official second deployment https://drunkdeer.keybord.net.cn/drunk/ js/index.QC8Mvgui.js (live
//             2026-10-13). DOCS ONLY. Same dispatch and cutoffs as [antler] (cross-checked).
//   [svumo]   svumo/DrunkDeer-Control (MIT, C#; docs/keyboard-protocol.md, protocol-findings-keybord-net-cn.md,
//             Driver/FirmwareCapabilities.cs, KeyboardSpecs.cs). Hardware-tested on A75 Pro fw 0.023 and G65.
//             Code may be ported (MIT); the latest-firmware table and named-slot counts come from here.
//   [mojobojo] mojobojo/drunkdeer-daemon README (no licence: docs only). PID/type-byte table, lsusb names.
//   [halljoy] PashOK7/HallJoy (AGPL-3.0). Confirms the 6 x 21 = 126-slot firmware grid and the 0xB7 stream.
//   [cli]     2xxn/cli-drunkdeer (Apache-2.0). Confirms the LED frame shape and 0..9 brightness/speed.
//
// Nothing here talks to a device. Erasable TypeScript only (node runs scripts/ directly).

import type { BridgeAllowance, Channel, DeviceEntry, KeyboardCaps, NumRange, Source, SupportTier } from "../local-kb.ts";

// ---------------------------------------------------------------------------------------------
// USB identities
// ---------------------------------------------------------------------------------------------

/** DrunkDeer's own USB vendor id (13613). [antler filter list][mojobojo] */
export const DRUNKDEER_VID = 0x352d;
/** VID the official filter pairs with PID 0x2094 (X60). Not DrunkDeer's own VID. [antler] */
export const X60_VID = 0x1a81;
/**
 * OEM platform shared with NuPhy / MCHOSE gen-1 HE boards; a different protocol (the 0x55 framing). It is driven by
 * the 0x19F5 family driver (src/lib/brands/fw19f5), not by this one: the ids stay here as "detectOnly" (nothing in
 * this driver's gen-1 protocol is ever sent to them) so one driver claims each id. [antler][svumo gen2 docs]
 */
export const OEM_19F5_VID = 0x19f5;

/**
 * The configuration collection: vendor-defined usage page 0xFF00 (HID vendor range 0xFF00-0xFFFF), usage
 * 0x00. Output reports go out with report id 4 and 63 data bytes; the keyboard answers with input reports
 * on the same collection (echo or reply). No feature reports. [antler `requestDevice({filters})`,
 * `keyboard_report_id=4`, every builder `new Uint8Array(63)`; svumo REPORT_ID 4 / PACKET_SIZE 63]
 * This is NOT the boot-keyboard (0x01/0x06) or consumer (0x0C) collection.
 */
export const DD_CHANNEL: Channel = { usagePage: 0xff00, usage: 0x00, transport: "output+input", reportId: 4, length: 63 };

/** The firmware's key grid: 6 rows x 21 columns, slot = row * 21 + col. [halljoy kRows/kColumns][svumo 126-slot grid] */
export const GRID = { rows: 6, cols: 21, slots: 126 } as const;
export const slotOf = (row: number, col: number): number => row * GRID.cols + col;

const SRC_ANTLER: Source = { kind: "configurator-js", ref: "drunkdeer-antler.com js/index.CJWCGjvj.js (docs only)" };
const SRC_KBCN: Source = { kind: "configurator-js", ref: "drunkdeer.keybord.net.cn/drunk js/index.QC8Mvgui.js (docs only)" };
const SRC_SVUMO: Source = { kind: "open-source", ref: "github.com/svumo/DrunkDeer-Control", license: "MIT" };
const SRC_MOJO: Source = { kind: "community-doc", ref: "github.com/mojobojo/drunkdeer-daemon README (no licence, docs only)" };
const SRC_HALLJOY: Source = { kind: "open-source", ref: "github.com/PashOK7/HallJoy", license: "AGPL-3.0" };
const SRC_OEM_APP: Source = { kind: "configurator-js", ref: "drunkdeer.keybord.net.cn (0x19F5 app, page.js; docs only)" };

/** USB PIDs on VID 0x352D in the official filter (all on page 0xFF00 usage 0). Model comes from the 0xA0 identity. [antler] */
export const DRUNKDEER_PIDS: readonly number[] = [
  0x2382, 0x2383, 0x2384, 0x2386, 0x2387, 0x238f, 0x2390, 0x2391, 0x2394, 0x23b3, 0x23b4, 0x23b5, 0x23b6,
];

/** 0x19F5 boards the official Antler app hands off to the OEM app (page 0x0001 usage 0x0000). [antler][kbcn page.js] */
export const OEM_19F5_PIDS: readonly number[] = [0xfb3e, 0xfb42, 0xfb50, 0xfb5c, 0xfb5e, 0xfb63, 0xfb7b];
/** 0x19F5 upgrader / bootloader PIDs the OEM app opens (page 0xFF00 usage 1). Never opened by SYNQ. [kbcn page.js] */
export const OEM_19F5_UPGRADER_PIDS: readonly number[] = [0xaf12, 0xaf16, 0xaf26, 0xaf3a, 0xaf3c, 0xaf49];
/** Any 0x19F5:0xAFxx is treated as an upgrader, listed or not. */
export const isOemUpgrader = (vendorId: number, productId: number): boolean => vendorId === OEM_19F5_VID && (productId & 0xff00) === 0xaf00;

function entry(
  vendorId: number,
  productId: number,
  model: string,
  tier: SupportTier,
  sources: readonly Source[],
  notes: string,
  channel: Channel = DD_CHANNEL,
): DeviceEntry {
  return { vendor: "DrunkDeer", vendorId, productId, model, kind: "keyboard", connection: "usb", channel, tier, sources, notes };
}

const BY_IDENTITY = "Model is resolved from the 0xA0 identity type bytes; the final tier is the model's (MODELS).";
const OEM_CHANNEL: Channel = { usagePage: 0x0001, usage: 0x0000, transport: "output+input", reportId: 0, length: 64 };

/**
 * Every USB identity this brand table knows. PID-level tier: "experimental" = SYNQ may open the vendor
 * collection and send the identity read; what it may write is decided per model after identity.
 */
export const DEVICES: readonly DeviceEntry[] = [
  entry(DRUNKDEER_VID, 0x2382, "G65 family (G65, G65 Lite)", "experimental", [SRC_ANTLER, SRC_MOJO], `Demo table "G65-0x2382"; mojobojo G65/G65Lite 9090. ${BY_IDENTITY}`),
  entry(DRUNKDEER_VID, 0x2383, "A75 family (A75, A75 Pro, A75 ISO, A75 Ultra, A75 Master)", "experimental", [SRC_ANTLER, SRC_MOJO], `Demo table maps A75/A75Pro/ISO/Ultra/Master to 0x2383; mojobojo 9091. ${BY_IDENTITY}`),
  entry(DRUNKDEER_VID, 0x2384, "G60", "experimental", [SRC_ANTLER, SRC_MOJO], `Demo table "G60-0x2384"; lsusb "Drunkdeer G60 ANSI". ${BY_IDENTITY}`),
  entry(DRUNKDEER_VID, 0x2386, "G75", "experimental", [SRC_ANTLER, SRC_MOJO], `Demo table "G75-0x2386"; mojobojo 9094. ${BY_IDENTITY}`),
  entry(DRUNKDEER_VID, 0x2387, "DrunkDeer (model unknown)", "experimental", [SRC_ANTLER], `In the official filter, model not named anywhere (svumo's comment "A75 Ultra" is unsourced). ${BY_IDENTITY}`),
  entry(DRUNKDEER_VID, 0x238f, "DrunkDeer (model unknown)", "experimental", [SRC_ANTLER], `In the official filter, model not named anywhere. ${BY_IDENTITY}`),
  entry(DRUNKDEER_VID, 0x2390, "G65 M1", "experimental", [SRC_ANTLER], `Demo table "G65m1-0x2390". ${BY_IDENTITY}`),
  entry(DRUNKDEER_VID, 0x2391, "G75 JP", "experimental", [SRC_ANTLER, SRC_MOJO], `Demo table "G75JP-0x2391"; mojobojo 9105. ${BY_IDENTITY}`),
  entry(DRUNKDEER_VID, 0x2394, "G60 M1", "experimental", [SRC_ANTLER], `Demo table "G60m1-0x2394". ${BY_IDENTITY}`),
  entry(DRUNKDEER_VID, 0x23b3, "G60 M2", "experimental", [SRC_ANTLER], `Demo table "G60m2-0x23b3". ${BY_IDENTITY}`),
  entry(DRUNKDEER_VID, 0x23b4, "G65 M2", "experimental", [SRC_ANTLER], `Demo table "G65m2-0x23b4". ${BY_IDENTITY}`),
  entry(DRUNKDEER_VID, 0x23b5, "G65 M3", "experimental", [SRC_ANTLER], `Demo table "G65m3-0x23b5". ${BY_IDENTITY}`),
  entry(DRUNKDEER_VID, 0x23b6, "G60 M3", "experimental", [SRC_ANTLER], `Demo table "G60m3-0x23b6". ${BY_IDENTITY}`),
  entry(X60_VID, 0x2094, "X60", "experimental", [SRC_ANTLER],
    'Official filter {vendorId:6785, productId:8340, usagePage:65280}; demo table "X60-0x2094". VID 0x1A81 is not DrunkDeer\'s, so the session also requires a DrunkDeer/X60 product string before sending anything, and X60 identity bytes (11,6,5) before any write.'),
  entry(DRUNKDEER_VID, 0x2a08, "DrunkDeer (unverified interface)", "detectOnly", [SRC_SVUMO],
    'Only in svumo\'s list ("A75 Pro second interface"), not in either official filter. Not opened.'),
  entry(0x05ac, 0x024f, "Unknown board using Apple's VID/PID", "detectOnly", [SRC_ANTLER],
    "In the official filter on page 0xFF00, but 05AC:024F is Apple's keyboard id and is reused by many non-DrunkDeer boards (FCC lists Sonix-family dongles under it). Never opened: an identity probe could reach another vendor's command set.",
    DD_CHANNEL),
  ...OEM_19F5_PIDS.map((pid) =>
    entry(OEM_19F5_VID, pid, "DrunkDeer gen-2 (OEM 0x19F5 platform)", "detectOnly", [SRC_ANTLER, SRC_OEM_APP, SRC_SVUMO],
      "Shared OEM platform (NuPhy / MCHOSE lineage): no report id, 64-byte 0x55 'extended gateway' frames with checksums and address/length block reads (svumo gen2-wire-format-confirmed.md). Not this driver's protocol: the 0x19F5 family driver (src/lib/brands/fw19f5) claims these ids. The official Antler app redirects them to drunkdeer.keybord.net.cn.",
      OEM_CHANNEL)),
];

// ---------------------------------------------------------------------------------------------
// Firmware type codes -> models
// ---------------------------------------------------------------------------------------------

/**
 * Per-key wire dialect, chosen per (type bytes, firmware number) exactly as the official app does
 * (`precision` / `oldOpenHighPrecision`). [antler yC dispatch][kbcn same]
 *   legacy       precision 1:            0xB6 01/04/05, 3 packets (59+59+8 keys), 1 byte/key, mm x 10
 *   oldHighPrec  precision 2 + old flag: 0xB6 01/04/05, 3 packets, 1 byte/key, mm x 100 (AP/DS/US capped 2.0 mm)
 *   newHighPrec  precision 2:            0xFD 01/04/05, 5 packets (30x4+6 keys), u16 LE/key, mm x 200
 * Only newHighPrec boards have the 0xFC/0xFD extras (pair tables, read-back pulls, auto-match, LW replace):
 * the official builder object exposes them only in its high-precision set.
 */
export type Dialect = "legacy" | "oldHighPrec" | "newHighPrec";

export type DialectRule = { kind: "fixed"; dialect: Dialect } | { kind: "cutoff"; highPrecFrom: number };

export type ColourTableId = "standard" | "a75" | "g65lite" | "ultra" | "x60";

export interface DrunkDeerModel {
  /** Firmware TypeCode as the official app names it (keyboard_type). */
  typeCode: number;
  name: string;
  /** Identity response bytes 4, 5, 6. First entry is the canonical one. */
  typeBytes: readonly (readonly [number, number, number])[];
  family: "A75" | "G75" | "G65" | "G60" | "X60";
  /** Official layout table name (126-slot array). */
  layout: string;
  /** Named (physical) slots in that layout. [svumo keyboard-protocol.md §4] */
  keyCount: number;
  /** USB identities this model has been seen on (vendor:product). */
  usb: readonly (readonly [number, number])[];
  dialect: DialectRule;
  /** RTP_version: firmware from which Last-Win / RDT are offered. [antler RQ] */
  rtpFrom: number;
  /** custom_lighting_version for the family (per-key custom light; SYNQ doesn't write it). [antler pQ] */
  customLightingFrom?: number;
  /** firmware_synchronization: per-key / pair read-back pulls (0xFD 07, 0xFC 05/07). Only on newHighPrec boards. [antler] */
  pullFrom?: number;
  /** rtMathMode (RT auto-match modes, 0xFD 0C) from this firmware. [antler] */
  autoMatchFrom?: number;
  /** Last-Win Replace (0xFC 0B) is shown only on 756/757 at firmware >= 73. [antler setShowLwReplace] */
  lwReplaceFrom?: number;
  /** Firmware-side profile count query (0xA2 00) from this firmware. [antler event_send_profile_len] */
  profileCountFrom?: number;
  /** At or below this firmware the official app doesn't read the profile index (is_m_u_l). [antler Tg.v34] */
  profileIndexUnreadableUpTo?: number;
  /** Firmware range in which the official app pushes its firmware updater (exclusive bounds). [antler Tg] */
  officialUpdatePrompt?: { above: number; below: number };
  /** Latest firmware in the official updater bundle (DrunkdeerUpdaterV2.3.4 config.ini), informational. [svumo] */
  latestKnownFirmware?: number;
  colourTable: ColourTableId;
  /** Custom-light stream packet count (6 for G60/G65 families, else 7). Informational. [antler transmit_color_report_packet] */
  colourPackets: 6 | 7;
  /** Tier for writes. A cutoff model below its cutoff (legacy) uses `tierLegacy` when given. */
  tier: SupportTier;
  tierLegacy?: SupportTier;
  sources: readonly Source[];
  notes?: string;
}

const STD_SRC: readonly Source[] = [SRC_ANTLER, SRC_KBCN, SRC_SVUMO];

/** Every type code the official dispatch can reach. (11,4,1) also names "K82" in the bundle, but the A75 branch matches first, so K82 is unreachable there and isn't listed. */
export const MODELS: readonly DrunkDeerModel[] = [
  { typeCode: 75, name: "A75", typeBytes: [[11, 4, 1], [11, 1, 1]], family: "A75", layout: "ddeerA75Profile", keyCount: 91, usb: [[DRUNKDEER_VID, 0x2383]], dialect: { kind: "cutoff", highPrecFrom: 35 }, rtpFrom: 24, customLightingFrom: 20, latestKnownFirmware: 0x27, colourTable: "a75", colourPackets: 7, tier: "experimental", sources: [...STD_SRC, SRC_MOJO], notes: "(11,1,1) is the legacy A75 alias." },
  { typeCode: 750, name: "A75 Pro", typeBytes: [[11, 4, 3]], family: "A75", layout: "ddeerA75ProProfile", keyCount: 91, usb: [[DRUNKDEER_VID, 0x2383]], dialect: { kind: "cutoff", highPrecFrom: 17 }, rtpFrom: 5, customLightingFrom: 3, latestKnownFirmware: 0x17, colourTable: "a75", colourPackets: 7, tier: "community", tierLegacy: "experimental", sources: [...STD_SRC, SRC_MOJO], notes: "svumo hardware-verified fw 0.023 (= 23, oldHighPrec): AP/DS/US x100 by WebHID capture, common switch, lighting modes Off/Always-on/Breath, brightness 0..9. Below fw 17 (legacy x10) svumo dropped support; experimental here." },
  { typeCode: 751, name: "A75 ISO (UK / FR / DE)", typeBytes: [[11, 4, 2]], family: "A75", layout: "ddeerA75UKProfile", keyCount: 92, usb: [[DRUNKDEER_VID, 0x2383]], dialect: { kind: "cutoff", highPrecFrom: 25 }, rtpFrom: 21, customLightingFrom: 19, latestKnownFirmware: 0x23, colourTable: "a75", colourPackets: 7, tier: "experimental", sources: STD_SRC, notes: "UK/FR/DE share type bytes; the official app asks the user (localStorage current_iso 751/752/753). Only keycap labels differ." },
  { typeCode: 756, name: "A75 Ultra", typeBytes: [[11, 4, 4]], family: "A75", layout: "ddeerA75UltraProfile", keyCount: 91, usb: [[DRUNKDEER_VID, 0x2383]], dialect: { kind: "fixed", dialect: "newHighPrec" }, rtpFrom: 1, pullFrom: 33, autoMatchFrom: 37, lwReplaceFrom: 73, profileCountFrom: 81, profileIndexUnreadableUpTo: 34, officialUpdatePrompt: { above: 63, below: 81 }, latestKnownFirmware: 0x55, colourTable: "ultra", colourPackets: 7, tier: "experimental", sources: STD_SRC, notes: "Knob (0xC1 remap) not implemented. svumo parked the 0xFD dialect for lack of hardware tests; both official bundles use it." },
  { typeCode: 757, name: "A75 Master", typeBytes: [[11, 5, 4]], family: "A75", layout: "ddeerA75MasterProfile", keyCount: 91, usb: [[DRUNKDEER_VID, 0x2383]], dialect: { kind: "fixed", dialect: "newHighPrec" }, rtpFrom: 1, pullFrom: 33, autoMatchFrom: 37, lwReplaceFrom: 73, profileCountFrom: 81, profileIndexUnreadableUpTo: 34, officialUpdatePrompt: { above: 63, below: 81 }, latestKnownFirmware: 0x55, colourTable: "ultra", colourPackets: 7, tier: "experimental", sources: STD_SRC, notes: "Same platform as A75 Ultra." },
  { typeCode: 754, name: "G75", typeBytes: [[11, 4, 5]], family: "G75", layout: "ddeerG75Profile", keyCount: 86, usb: [[DRUNKDEER_VID, 0x2386]], dialect: { kind: "cutoff", highPrecFrom: 13 }, rtpFrom: 5, customLightingFrom: 4, latestKnownFirmware: 0x17, colourTable: "standard", colourPackets: 7, tier: "experimental", sources: [...STD_SRC, SRC_MOJO] },
  { typeCode: 755, name: "G75 JP", typeBytes: [[11, 4, 7]], family: "G75", layout: "ddeerG75JPProfile", keyCount: 86, usb: [[DRUNKDEER_VID, 0x2391]], dialect: { kind: "cutoff", highPrecFrom: 6 }, rtpFrom: 2, customLightingFrom: 1, latestKnownFirmware: 0x12, colourTable: "standard", colourPackets: 7, tier: "experimental", sources: [...STD_SRC, SRC_MOJO] },
  { typeCode: 65, name: "G65", typeBytes: [[11, 2, 1], [15, 1, 1]], family: "G65", layout: "ddeerG65Profile", keyCount: 70, usb: [[DRUNKDEER_VID, 0x2382]], dialect: { kind: "cutoff", highPrecFrom: 19 }, rtpFrom: 9, customLightingFrom: 7, latestKnownFirmware: 0x15, colourTable: "standard", colourPackets: 6, tier: "experimental", sources: [...STD_SRC, SRC_MOJO, SRC_HALLJOY], notes: "Sources disagree: both official bundles switch G65 to x100 at fw >= 19; svumo v2.4+ always sends x10 to G65. SYNQ follows the official bundles. (15,1,1) is the legacy alias." },
  { typeCode: 650, name: "G65 Lite", typeBytes: [[11, 2, 5]], family: "G65", layout: "ddeerG65liteProfile", keyCount: 70, usb: [[DRUNKDEER_VID, 0x2382]], dialect: { kind: "fixed", dialect: "legacy" }, rtpFrom: 1, colourTable: "g65lite", colourPackets: 6, tier: "experimental", sources: [...STD_SRC, SRC_MOJO], notes: "Official app disables custom lighting (getLinkMessage(8))." },
  { typeCode: 651, name: "G65 M1", typeBytes: [[11, 2, 3]], family: "G65", layout: "ddeerG65m1Profile", keyCount: 70, usb: [[DRUNKDEER_VID, 0x2390]], dialect: { kind: "fixed", dialect: "oldHighPrec" }, rtpFrom: 1, colourTable: "standard", colourPackets: 6, tier: "experimental", sources: STD_SRC },
  { typeCode: 652, name: "G65 M2", typeBytes: [[11, 16, 1]], family: "G65", layout: "ddeerG65m2Profile", keyCount: 70, usb: [[DRUNKDEER_VID, 0x23b4]], dialect: { kind: "fixed", dialect: "oldHighPrec" }, rtpFrom: 1, colourTable: "standard", colourPackets: 6, tier: "experimental", sources: STD_SRC },
  { typeCode: 653, name: "G65 M3", typeBytes: [[11, 18, 1]], family: "G65", layout: "ddeerG65m3Profile", keyCount: 70, usb: [[DRUNKDEER_VID, 0x23b5]], dialect: { kind: "fixed", dialect: "oldHighPrec" }, rtpFrom: 1, colourTable: "standard", colourPackets: 6, tier: "experimental", sources: STD_SRC },
  { typeCode: 60, name: "G60", typeBytes: [[11, 3, 1]], family: "G60", layout: "ddeerG60Profile", keyCount: 63, usb: [[DRUNKDEER_VID, 0x2384]], dialect: { kind: "cutoff", highPrecFrom: 21 }, rtpFrom: 17, customLightingFrom: 7, latestKnownFirmware: 0x17, colourTable: "standard", colourPackets: 6, tier: "experimental", sources: [...STD_SRC, SRC_MOJO] },
  { typeCode: 600, name: "G60 M1", typeBytes: [[11, 3, 3]], family: "G60", layout: "ddeerG60m1Profile", keyCount: 63, usb: [[DRUNKDEER_VID, 0x2394]], dialect: { kind: "fixed", dialect: "oldHighPrec" }, rtpFrom: 1, colourTable: "standard", colourPackets: 6, tier: "experimental", sources: STD_SRC },
  { typeCode: 601, name: "G60 M2", typeBytes: [[11, 19, 1]], family: "G60", layout: "ddeerG60m2Profile", keyCount: 63, usb: [[DRUNKDEER_VID, 0x23b3]], dialect: { kind: "fixed", dialect: "oldHighPrec" }, rtpFrom: 1, colourTable: "standard", colourPackets: 6, tier: "experimental", sources: STD_SRC },
  { typeCode: 602, name: "G60 M3", typeBytes: [[11, 21, 1]], family: "G60", layout: "ddeerG60m3Profile", keyCount: 63, usb: [[DRUNKDEER_VID, 0x23b6]], dialect: { kind: "fixed", dialect: "oldHighPrec" }, rtpFrom: 1, colourTable: "standard", colourPackets: 6, tier: "experimental", sources: STD_SRC, notes: "Antler lists 602 in firmware_synchronization/rtMathMode, but it is an old-dialect board whose builder set has no pull/auto-match packets; SYNQ doesn't send them." },
  { typeCode: 603, name: "X60", typeBytes: [[11, 6, 5]], family: "X60", layout: "ddeerX60Profile", keyCount: 91, usb: [[X60_VID, 0x2094]], dialect: { kind: "fixed", dialect: "newHighPrec" }, rtpFrom: 1, customLightingFrom: 1, pullFrom: 1, autoMatchFrom: 1, profileCountFrom: 19, officialUpdatePrompt: { above: -1, below: 19 }, colourTable: "x60", colourPackets: 7, tier: "experimental", sources: STD_SRC, notes: "LED strip (0xC2 0x20) not implemented." },
];

export function modelForTypeBytes(b4: number, b5: number, b6: number): DrunkDeerModel | null {
  for (const m of MODELS) for (const t of m.typeBytes) if (t[0] === b4 && t[1] === b5 && t[2] === b6) return m;
  return null;
}

export function modelForTypeCode(code: number): DrunkDeerModel | null {
  return MODELS.find((m) => m.typeCode === code) ?? null;
}

export function deviceEntry(vendorId: number, productId: number): DeviceEntry | null {
  return DEVICES.find((d) => d.vendorId === vendorId && d.productId === productId) ?? null;
}

/** Which dialect a model speaks at a firmware number (null model = unknown). */
export function dialectFor(model: DrunkDeerModel | null, firmware: number): Dialect | null {
  if (!model) return null;
  if (model.dialect.kind === "fixed") return model.dialect.dialect;
  return firmware >= model.dialect.highPrecFrom ? "oldHighPrec" : "legacy";
}

/** Final tier for a resolved model + firmware (unknown type code = readOnly). */
export function tierFor(model: DrunkDeerModel | null, firmware: number): SupportTier {
  if (!model) return "readOnly";
  if (model.tierLegacy && dialectFor(model, firmware) === "legacy") return model.tierLegacy;
  return model.tier;
}

export const tierAllowsWrites = (t: SupportTier): boolean => t === "verified" || t === "community" || t === "experimental";

// ---------------------------------------------------------------------------------------------
// Units and ranges per dialect
// ---------------------------------------------------------------------------------------------

export interface DialectUnits {
  /** mm per wire unit. */
  unitMm: number;
  /** Bytes per key on the wire. */
  bytesPerKey: 1 | 2;
  /** Packets per field (AP / DS / US). */
  packets: 3 | 5;
  actuation: NumRange;
  /** Rapid-trigger downstroke (press sensitivity) and upstroke (release sensitivity). */
  downstroke: NumRange;
  upstroke: NumRange;
  /** UI coupling in the official app: actuation + downstroke never exceeds this (it lowers DS when AP rises). */
  apPlusDownstrokeMax: number;
}

/**
 * Ranges are the official slider limits: AP min te=0.2, AP max `oldOpenHighPrecision ? 2 : Ng(3.3)`,
 * DS/US max `precision===2 ? 2 : Yg(3.1)`, min 0. The 2.0 mm cap on oldHighPrec also keeps x100 values in
 * one byte (the official builder would wrap 3.3 x 100 = 330 in its Uint8Array). Step = the official slider
 * step: 0.01 when the keyboard is 603/756/757 or (precision 2 and identity byte 25 != 0), else 0.1. [antler]
 */
export function unitsFor(dialect: Dialect, fineStep: boolean): DialectUnits {
  const step = dialect === "legacy" ? 0.1 : fineStep ? 0.01 : 0.1;
  switch (dialect) {
    case "legacy":
      return { unitMm: 0.1, bytesPerKey: 1, packets: 3, actuation: { min: 0.2, max: 3.3, step }, downstroke: { min: 0, max: 3.1, step }, upstroke: { min: 0, max: 3.1, step }, apPlusDownstrokeMax: 3.1 };
    case "oldHighPrec":
      return { unitMm: 0.01, bytesPerKey: 1, packets: 3, actuation: { min: 0.2, max: 2.0, step }, downstroke: { min: 0, max: 2.0, step }, upstroke: { min: 0, max: 2.0, step }, apPlusDownstrokeMax: 2.0 };
    case "newHighPrec":
      return { unitMm: 0.005, bytesPerKey: 2, packets: 5, actuation: { min: 0.2, max: 3.3, step }, downstroke: { min: 0, max: 2.0, step }, upstroke: { min: 0, max: 2.0, step }, apPlusDownstrokeMax: 2.0 };
  }
}

/** Factory per-key values (svumo capture: the default load writes every slot at 2.0 mm, DS = US = 0). */
export const FACTORY_KEYPOINTS = { actuation: 2.0, downstroke: 0, upstroke: 0 } as const;

/** Official UI caps on pair tables ("lw_max_length" at 5 groups; RDT list also stops at 5). [antler] */
export const MAX_LW_PAIRS = 5;
export const MAX_RDT_PAIRS = 5;

// ---------------------------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------------------------

/** English names of the official colour-mode keys color1..color26 (locale block). [svumo §RGB catalog from kbcn] */
export const COLOUR_MODE_NAMES: Readonly<Record<string, string>> = {
  color1: "Off", color2: "Rotate marquee", color3: "Wave spectrum", color4: "Surf to the right", color5: "Breath",
  color6: "Center surfing", color7: "Spectrum", color8: "Ripple", color9: "Always on", color10: "Light by press",
  color11: "Serpentine to the center", color12: "Colorful fountain", color13: "Laser key", color14: "Glowing fish",
  color15: "Surfing cross", color16: "Heart", color17: "Traffic", color18: "Gluttonous snake", color19: "Raindrops",
  color20: "Turbo-mode custom light", color21: "Custom light", color22: "Stars", color23: "Surfing down",
  color24: "Repeat surfing", color25: "Random fountain", color26: "Dance of demons",
};

/**
 * Per-model colour-mode tables, in the official order (m_color_names). Wire code rule [antler
 * apiSaveColourSolution]: newHighPrec boards send the entry's `code`; others send the list index, minus 2
 * when the list contains the two custom entries (color20/color21 at indices 1 and 2). Custom entries use the
 * per-key stream instead and are not presets.
 * Data extracted from the bundle by a read-only research script (not published).
 */
const ORDER: Record<Exclude<ColourTableId, "ultra" | "x60">, readonly number[]> = {
  standard: [1, 20, 21, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  a75: [1, 20, 21, 2, 9, 7, 5, 10, 22, 3, 6, 23, 8, 14, 12, 17, 18, 24, 15, 13, 25],
  g65lite: [1, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 16],
};
const CODED: Record<"ultra" | "x60", readonly (readonly [number, number])[]> = {
  ultra: [[1, 240], [20, 18], [21, 18], [7, 0], [9, 1], [4, 2], [5, 3], [11, 4], [10, 5], [2, 6], [6, 7], [12, 8], [13, 9], [15, 10], [17, 11], [14, 12], [8, 13], [26, 14], [18, 15], [25, 16], [16, 17]],
  x60: [[1, 240], [20, 20], [21, 20], [7, 5], [9, 7], [4, 2], [5, 3], [11, 9], [10, 8], [2, 0], [6, 4], [12, 10], [13, 11], [15, 13], [17, 15], [14, 12], [8, 6], [18, 16], [16, 14], [19, 17]],
};

export interface ColourPreset {
  /** Official key, e.g. "color5". */
  key: string;
  name: string;
  /** Byte 4 of the 0xAE 01 frame. */
  code: number;
}

/** Preset (non-custom) modes a model accepts, with their wire codes. */
export function colourPresets(table: ColourTableId): readonly ColourPreset[] {
  const out: ColourPreset[] = [];
  if (table === "ultra" || table === "x60") {
    for (const [n, code] of CODED[table]) if (n !== 20 && n !== 21) out.push({ key: `color${n}`, name: COLOUR_MODE_NAMES[`color${n}`], code });
    return out;
  }
  const order = ORDER[table];
  const hasCustom = order.includes(20);
  order.forEach((n, i) => {
    if (n === 20 || n === 21) return;
    out.push({ key: `color${n}`, name: COLOUR_MODE_NAMES[`color${n}`], code: hasCustom ? Math.max(0, i - 2) : i });
  });
  return out;
}

/** Union of every preset code any model accepts (the static guard's superset). */
export const ALL_PRESET_CODES: readonly number[] = Array.from(
  new Set((["standard", "a75", "g65lite", "ultra", "x60"] as const).flatMap((t) => colourPresets(t).map((p) => p.code))),
).sort((a, b) => a - b);

/** Brightness / speed sliders are 0..9 in the official UI; >= 10 is reported to soft-brick the A75 Pro. [antler sliders][svumo rgb-protocol.md][cli] */
export const LIGHT_LEVEL_MAX = 9;
/** Colour byte: 0 = colourful / rainbow, 1..7 = preset colours (m_default_rgbs). [antler] */
export const LIGHT_COLOURS: readonly string[] = ["colourful", "ff0000", "00ff00", "0000ff", "ffff00", "ff00ff", "00ffff", "ffffff"];

// ---------------------------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------------------------

export interface DrunkDeerFeatures {
  dialect: Dialect;
  units: DialectUnits;
  /** Last-Win / RDT offered by the official app (fw >= RTP_version). */
  rtp: boolean;
  /** Pair tables writable by SYNQ (newHighPrec FC 0A + FC 01/03; old boards need 0xAA/0xA7/0xA8, which are blocked). */
  pairWrites: boolean;
  /** Per-key + pair read-back pulls available. */
  pulls: boolean;
  autoMatch: boolean;
  lwReplace: boolean;
  profileCount: boolean;
  profileIndex: boolean;
  /** Identity bytes 20..32 (profile, lighting, RT-match, auto-match, LW replace) are meaningful. */
  extendedIdentity: boolean;
  lightingPresets: readonly ColourPreset[];
  officialUpdatePrompt: boolean;
}

export function featuresFor(model: DrunkDeerModel, firmware: number, fineStepFlag: boolean): DrunkDeerFeatures {
  const dialect = dialectFor(model, firmware) as Dialect;
  const hi = dialect === "newHighPrec";
  const fine = hi || (dialect === "oldHighPrec" && fineStepFlag);
  const at = (from: number | undefined) => from !== undefined && firmware >= from;
  const prompt = model.officialUpdatePrompt;
  return {
    dialect,
    units: unitsFor(dialect, fine),
    rtp: firmware >= model.rtpFrom,
    pairWrites: hi && firmware >= model.rtpFrom,
    pulls: hi && at(model.pullFrom),
    autoMatch: hi && at(model.autoMatchFrom),
    lwReplace: hi && at(model.lwReplaceFrom),
    profileCount: hi && at(model.profileCountFrom),
    profileIndex: hi && !(model.profileIndexUnreadableUpTo !== undefined && firmware <= model.profileIndexUnreadableUpTo),
    extendedIdentity: hi,
    lightingPresets: colourPresets(model.colourTable),
    officialUpdatePrompt: !!prompt && firmware > prompt.above && firmware < prompt.below,
  };
}

/** KeyboardCaps (shared shape) for a resolved model. */
export function capsFor(model: DrunkDeerModel, firmware: number, fineStepFlag: boolean): KeyboardCaps {
  const f = featuresFor(model, firmware, fineStepFlag);
  return {
    analog: {
      perKey: true,
      actuation: f.units.actuation,
      rapidTrigger: { press: f.units.downstroke, release: f.units.upstroke, perKey: true },
      socd: f.rtp ? { modes: ["last"], maxPairs: MAX_LW_PAIRS } : undefined,
      liveDepth: true,
    },
    keymap: { layers: 3, remap: true, macros: 0 },
    lighting: { effects: true, perKey: model.typeCode !== 650, brightness: { min: 0, max: LIGHT_LEVEL_MAX, step: 1 } },
    profiles: f.profileCount ? 5 : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Bridge allowances
// ---------------------------------------------------------------------------------------------

/**
 * What the Rust bridge (src-tauri/src/hid.rs) must allow for DrunkDeer, and nothing more: `full` access
 * (output + input reports) on the vendor-defined collection 0xFF00/0x00 only, report id 4, 63 data bytes.
 * Feature reports are never used. 05AC:024F, 352D:2A08 and every 0x19F5 PID are deliberately absent.
 */
export const DRUNKDEER_BRIDGE: readonly BridgeAllowance[] = [
  {
    vendorId: DRUNKDEER_VID,
    productIds: DRUNKDEER_PIDS,
    usagePage: 0xff00,
    usage: 0x00,
    access: "full",
    reportIds: [4],
    length: 63,
    note: "Vendor-defined page 0xFF00 usage 0 (not keyboard 0x01/0x06, not consumer 0x0C). Output reports (id 4, 63 bytes) out; input reports (id 4, 63 bytes) back: echoes, the 0xA0 identity reply, 0xB7/0xFD06 depth streams, pull replies. Every outgoing frame must pass the DrunkDeer allowlist (drunkdeer-frames.txt).",
  },
  {
    vendorId: X60_VID,
    productIds: [0x2094],
    usagePage: 0xff00,
    usage: 0x00,
    access: "full",
    reportIds: [4],
    length: 63,
    note: "DrunkDeer X60 (official filter 6785:8340 on 0xFF00). VID is the MCU vendor's, so the TS session additionally requires a DrunkDeer/X60 product string before the first frame. Same allowlist.",
  },
];
