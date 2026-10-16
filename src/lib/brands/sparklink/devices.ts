// The SparkLink ("PlayJoy" / 星闪) keyboard family: one OEM firmware that Royal Kludge, AULA and Kochi ship, configured
// on the vendor-defined collection 0xFFA0:0x0001 with 64-byte reports (protocol.ts). The USB ids come from two web
// drivers (read as data, not copied): Royal Kludge's (drive.rkgaming.com: 21 USB entries tagged protocolType
// "SparkLink", usagePage 65440, usage 1, 2026-10-13) and AULA's magnet.aulastar.com (its requestDevice filter list:
// 34 entries on 0xFFA0, 2026-10-13); Kochi's 1CA2:0901 comes from @openmouse/keyboard-protocol, which exercised it on
// hardware. Which of these boards have Hall-effect keys is not in either list: SYNQ asks the board (the travel
// range order) and shows the analog section only when it answers.
//
// Every id starts "experimental": shown read-only until the person turns on "Allow changes". Nothing here is verified
// on hardware by SYNQ; the Kochi mode switch is the one setting a third party has exercised on a real board.
//
// Update-mode (bootloader) ids of this family are not listed by either web driver: the SDK reboots the same board into
// a boot application (its sync reply then starts with "Boot") rather than naming a second id. SYNQ refuses a board
// whose sync reply says so (session.ts), and never sends the SDK's bootloader commands (guard.ts).
//
// Nothing here talks to a device. Erasable TypeScript only (node runs scripts/ directly).
import type { Channel, DeviceEntry, Source, SupportTier } from "../local-kb.ts";

/** The configuration collection: vendor page 0xFFA0, usage 1, 64-byte reports with no report id. */
export const SPARKLINK_CHANNEL: Channel = { usagePage: 0xffa0, usage: 0x0001, transport: "output+input", reportId: 0, length: 64 };

export const VID_1CA2 = 0x1ca2;
export const VID_1CA3 = 0x1ca3;
export const VID_1CA5 = 0x1ca5;
export const VID_1C4F = 0x1c4f;
/** Vendor ids this family's boards use. */
export const SPARKLINK_VIDS: readonly number[] = [VID_1CA2, VID_1CA3, VID_1CA5, VID_1C4F];

export type SparkLinkBrand = "Royal Kludge" | "AULA" | "Kochi";

export interface SparkLinkModel extends DeviceEntry {
  brand: SparkLinkBrand;
  /** Name without the brand ("M75HE UK"). */
  name: string;
  /** Hall-effect keys are known (by the maker's own name for the board); otherwise the board decides. */
  he: boolean | null;
}

const SRC_RK: Source = { kind: "configurator-js", ref: "drive.rkgaming.com (protocolType SparkLink entries; ids and names only, docs only)" };
const SRC_AULA: Source = { kind: "configurator-js", ref: "magnet.aulastar.com (requestDevice filter list: vendor 0x1CA5 / 0x1CA2 / 0x1CA3 / 0x1C4F on usage page 0xFFA0; ids only, docs only)" };
const SRC_OM: Source = { kind: "open-source", ref: "@openmouse/keyboard-protocol 1.1.0 kochi (1CA2:0901, exercised on hardware by OpenMouse)", license: "AGPL-3.0-or-later" };
const SRC_SDK: Source = { kind: "open-source", ref: "@sparklinkplayjoy/sdk-keyboard 1.0.24 + protocol-keyboard 1.0.7 (npm) and AureTrix-Solutions/AureTrix_driver", license: "MIT" };

const key = (v: number, p: number) => v * 0x10000 + p;

const make = (vendorId: number, productId: number, brand: SparkLinkBrand, name: string, he: boolean | null, sources: readonly Source[], notes: string, tier: SupportTier = "experimental"): SparkLinkModel => ({
  vendor: brand,
  vendorId,
  productId,
  model: `${brand} ${name}`,
  kind: "keyboard",
  connection: "usb",
  channel: SPARKLINK_CHANNEL,
  tier,
  sources,
  notes,
  brand,
  name,
  he,
});

const RK_NOTE = "Royal Kludge's web driver lists this board as SparkLink (its newer platform). Whether it has Hall-effect keys is not in that list; SYNQ asks the board.";
const AULA_NOTE = "Listed by AULA's web driver (magnet.aulastar.com) on the SparkLink collection; the list carries no model names, so the board's own name is shown once it answers.";

/** [PID, name, HE]. All on 1CA2, wired USB (RK's "wire" entries). */
const RK: readonly (readonly [number, string, boolean | null])[] = [
  [0x1604, "C98", null],
  [0x1605, "C68", null],
  [0x1606, "C84", null],
  [0x1607, "C87", null],
  [0x1608, "C96", null],
  [0x1609, "C61", null],
  [0x160a, "M75", null],
  [0x160b, "X87", null],
  [0x160e, "C98 (DE)", null],
  [0x160f, "C98 (FR)", null],
  [0x1610, "C98 (ES)", null],
  [0x1611, "C98 (JP)", null],
  [0x1612, "C68 (FR)", null],
  [0x1613, "C68 (DE)", null],
  [0x1614, "C68 (ES)", null],
  [0x1615, "C68 (JP)", null],
  [0x1616, "C68 (V2)", null],
  [0x1617, "C61 (ES)", null],
  [0x1619, "M75HE (UK)", true],
  [0x161a, "C61 (FR)", null],
  [0x161b, "M75HE (ES)", true],
];

/** AULA's filter list, in its own order. */
const AULA: readonly (readonly [number, number])[] = [
  [VID_1C4F, 0xee88],
  ...[0x0401, 0x0402, 0x0403, 0x0404, 0x0405, 0x0406, 0x0407, 0x0408, 0x0409, 0x040a, 0x040b, 0x040c, 0x040d, 0x040e, 0x040f, 0x0413, 0x0418].map((p) => [VID_1CA5, p] as const),
  ...[0x1901, 0x1902, 0x1903, 0x1904, 0x1905, 0x1906, 0x1907, 0x1908, 0x1909, 0x190a, 0x190b].map((p) => [VID_1CA2, p] as const),
  ...[0x0e01, 0x0e02, 0x0e03, 0x0e04, 0x0701].map((p) => [VID_1CA3, p] as const),
];

export const KOCHI_HB68: readonly [number, number] = [VID_1CA2, 0x0901];

export const SPARKLINK_MODELS: readonly SparkLinkModel[] = [
  ...RK.map(([pid, name, he]) => make(VID_1CA2, pid, "Royal Kludge", name, he, [SRC_RK, SRC_SDK], RK_NOTE)),
  ...AULA.map(([vid, pid]) =>
    make(vid, pid, "AULA", `HE board ${vid.toString(16)}:${pid.toString(16).padStart(4, "0")}`, null, [SRC_AULA, SRC_SDK], AULA_NOTE),
  ),
  make(KOCHI_HB68[0], KOCHI_HB68[1], "Kochi", "Hummingbird 68", null, [SRC_OM, SRC_SDK], "OpenMouse exercised the Windows / Mac switch of this board on hardware. SYNQ also reads the board for key settings; it did not know them before."),
];

const byKey = new Map<number, SparkLinkModel>(SPARKLINK_MODELS.map((m) => [key(m.vendorId, m.productId), m]));
if (byKey.size !== SPARKLINK_MODELS.length) throw new Error(`sparklink devices: ${SPARKLINK_MODELS.length - byKey.size} duplicate USB id(s)`);

/** The model for a USB id, or null. No I/O. */
export const sparklinkModel = (vendorId: number, productId: number): SparkLinkModel | null => byKey.get(key(vendorId, productId)) ?? null;

/** Every [vendor id, product id] this family claims. */
export const SPARKLINK_IDS: readonly (readonly [number, number])[] = SPARKLINK_MODELS.map((m) => [m.vendorId, m.productId] as const);

/** Whether this id is Kochi's Hummingbird 68, the one board whose mode switch is third-party tested. */
export const isKochi = (vendorId: number, productId: number): boolean => vendorId === KOCHI_HB68[0] && productId === KOCHI_HB68[1];
