// USB identities a mouse, keyboard or receiver takes while it is in firmware-update (bootloader / DFU)
// mode. SYNQ never lists, opens or sends anything to one of these: a device in that mode belongs to
// the maker's update tool until the update finishes or is cancelled. Some bootloaders latch (the
// Endgame Gear OP1 8K v2 stays in its bootloader across replugs until a full flash completes), so a
// stray report could leave a mouse unusable.
//
// The desktop bridge refuses the same ids (src-tauri/src/hid.rs `BOOTLOADER_IDS`, compared with this
// table by scripts/kb-safety.test.ts), and the device list shows them only as a plain note.
// Sources are the brand research notes of 2026-10-13 (mice-enth1, mice-big2, kb-analog) and
// @openmouse/protocol 0.41 (LOGITECH_BOOTLOADER_PRODUCT_IDS, lamzu/index.js). No Tauri, no React.

import { PAD_BOOT_IDS } from "./controllers/models.ts";

export type BootloaderKind = "mouse" | "keyboard" | "receiver" | "device" | "controller";

export interface BootloaderId {
  vid: number;
  pid: number;
  /** What it is, for the note: "Endgame Gear OP1 8K v2". */
  what: string;
  kind: BootloaderKind;
  source: string;
}

const b = (vid: number, pid: number, what: string, kind: BootloaderKind, source: string): BootloaderId => ({ vid, pid, what, kind, source });

export const BOOTLOADER_IDS: readonly BootloaderId[] = [
  // Endgame Gear: product string "Bootloader"; entered by command A1 3A or LEFT+RIGHT while plugging in.
  b(0x3367, 0x1977, "Endgame Gear OP1 8K v2", "mouse", "daohhuynh/egg-mouse README (mice-enth1)"),
  // Lamzu / CompX ODM (Lamzu Aurora env-models.json DeviceBLPID / receiver BL PIDs).
  b(0x373e, 0xb01c, "Lamzu Maya X", "mouse", "lamzu.net env-models.json (mice-enth1)"),
  b(0x373e, 0xb01d, "Lamzu Maya X 1K receiver", "receiver", "lamzu.net env-models.json (mice-enth1)"),
  b(0x373e, 0xb01e, "Lamzu Maya X 4K/8K receiver", "receiver", "lamzu.net env-models.json (mice-enth1)"),
  b(0x37b0, 0x0002, "Lamzu 4K/8K receiver", "receiver", "lamzu.net env-models.json; @openmouse/protocol lamzu/index.js"),
  b(0x37b0, 0x0004, "Lamzu Paro 1K receiver", "receiver", "@openmouse/protocol lamzu/index.js"),
  b(0x37b0, 0x0006, "Lamzu Tachi", "mouse", "lamzu.net env-models.json (mice-enth1)"),
  b(0x37b0, 0x0008, "Lamzu Paro", "mouse", "@openmouse/protocol lamzu/index.js"),
  b(0x37b0, 0x000a, "Lamzu Inca", "mouse", "@openmouse/protocol lamzu/index.js"),
  b(0x37b0, 0x0012, "Lamzu Maya", "mouse", "lamzu.net env-models.json (mice-enth1)"),
  b(0x37b0, 0x0018, "Lamzu Thorn", "mouse", "lamzu.net env-models.json (mice-enth1)"),
  b(0x37b0, 0x0033, "Lamzu Thorn V2 receiver", "receiver", "lamzu.net env-models.json (mice-enth1)"),
  b(0x37b0, 0x0041, "Lamzu Thorn V2", "mouse", "lamzu.net env-models.json (mice-enth1)"),
  // LunaFury (CompX VID 0x373E): "firmware-update bootloaders" per @openmouse/protocol lamzu/index.js.
  b(0x373e, 0xb032, "LunaFury mouse", "mouse", "@openmouse/protocol lamzu/index.js"),
  b(0x373e, 0xb033, "LunaFury mouse", "mouse", "@openmouse/protocol lamzu/index.js"),
  b(0x373e, 0xb054, "LunaFury mouse", "mouse", "@openmouse/protocol lamzu/index.js"),
  b(0x373e, 0xb084, "LunaFury mouse", "mouse", "@openmouse/protocol lamzu/index.js"),
  // Finalmouse (Xpanel): the ULX mouse bootloader (a Web Serial port; listed in case it also shows
  // up as HID), the keyboard bootloader, and the NXP bootloaders Xpanel asks for.
  b(0x361d, 0x0111, "Finalmouse UltralightX", "mouse", "Xpanel constants (mice-enth1)"),
  b(0x361d, 0x0201, "Finalmouse keyboard", "keyboard", "Xpanel constants (mice-enth1)"),
  b(0x1fc9, 0x0021, "Finalmouse (NXP bootloader)", "device", "Xpanel constants (mice-enth1)"),
  b(0x1fc9, 0x0022, "Finalmouse UltralightX receiver", "receiver", "Xpanel ULX_DONGLE_BOOTLOADER (mice-enth1)"),
  // Pulsar ZywOo route: requested next to its VIA-style mice; assumed to be their bootloader.
  b(0x2e3c, 0xaf01, "Pulsar ZywOo (assumed bootloader)", "device", "bbb.pulsar.gg /zywoo filters (mice-enth1, UNVERIFIED role)"),
  // ASUS Gear Link OTA `bootloader_pid` fields.
  // (kept equal to src/lib/brands/asus/devices.ts ASUS_BOOTLOADER_PIDS by scripts/kb-safety.test.ts)
  ...[0x1948, 0x194a, 0x1aaf, 0x1ab6, 0x1acf, 0x1ad1, 0x1b40, 0x1b7f, 0x1c11, 0x1c6a, 0x1c7e, 0x1cad, 0x1ce9, 0x1cf0, 0x1d46, 0x1d4d, 0x1d69, 0x1d6d, 0x1d7b, 0x1da3, 0x1ddf, 0x1de1, 0x1df4, 0x1df6, 0x1e0b, 0x1e4d, 0x1e5c].map((pid) =>
    b(0x0b05, pid, "ASUS ROG device", "device", "Gear Link ota bootloader_pid (mice-big2, asus devices.ts)"),
  ),
  // SteelSeries Apex: each keyboard's PID + 1 (src/lib/brands/steelseries/devices.ts BOOTLOADER_PIDS).
  ...[0x1611, 0x1613, 0x1615, 0x1617, 0x1619, 0x161b, 0x161d, 0x1623, 0x1625, 0x1627, 0x1629, 0x1631, 0x1633, 0x1641, 0x1643, 0x1645, 0x1647, 0x1651, 0x1653, 0x1661, 0x1663].map((pid) =>
    b(0x1038, pid, "SteelSeries Apex keyboard", "keyboard", "steelseries devices.ts BOOTLOADER_PIDS (PID + 1)"),
  ),
  // The 0x19F5 firmware family's upgraders: NuPhyIO's device table (36 ids; Field75 HE V2's 19F5:AF0F is in the
  // AFxx range below) and Royal Kludge's "Upgrader" entries (9 boards + its 2.4 GHz receiver, FE00).
  // (kept equal to src/lib/brands/fw19f5/devices.ts FW_UPGRADER_ROWS by scripts/kb-safety.test.ts)
  ...[0x0720, 0x0721, 0x0722, 0x0723, 0x0724, 0x072b, 0x072c, 0x072d, 0x072e, 0x072f, 0x0730, 0x0731, 0x0732, 0x0733, 0x0734, 0x0735, 0x0736, 0x0737, 0x0738, 0x0739, 0x073a, 0x073b, 0x073c, 0x073f, 0x0740, 0x0742, 0x0743, 0x0744, 0x6f03, 0x6f04, 0x6f10, 0x6f11, 0x8a04, 0x8a11, 0x8a1a, 0x8a1c, 0x8a1d, 0x8a27, 0x8a3d, 0x8a3e, 0x8a40, 0x8a44, 0xfe00, 0xff02, 0xff20, 0xff5a].map((pid) =>
    b(0x19f5, pid, "NuPhy / Royal Kludge keyboard (upgrader)", "keyboard", "nuphy.io and drive.rkgaming.com device tables (fw19f5 devices.ts)"),
  ),
  // Logitech: OpenMouse's LOGITECH_BOOTLOADER_PRODUCT_IDS, and a LIGHTSPEED receiver's bootloader seen live.
  ...[0x0ad0, 0x0ad2, 0x0ad3, 0x0ad6].map((pid) => b(0x046d, pid, "Logitech device", "device", "@openmouse/protocol LOGITECH_BOOTLOADER_PRODUCT_IDS")),
  b(0x046d, 0xab24, "Logitech LIGHTSPEED receiver", "receiver", "@openmouse/protocol drivers/vendors.js (observed live)"),
  // HID bootloaders QMK/TMK keyboards use (PJRC HalfKay, V-USB bootloadHID, QMK HID bootloader).
  b(0x16c0, 0x0478, "Keyboard (Teensy HalfKay bootloader)", "keyboard", "PJRC HalfKay"),
  b(0x16c0, 0x05df, "Keyboard (bootloadHID)", "keyboard", "V-USB bootloadHID"),
  b(0x03eb, 0x2067, "Keyboard (QMK HID bootloader)", "keyboard", "QMK HID bootloader"),
  b(0x0483, 0xdf11, "STM32 bootloader (DFU)", "device", "docs/devices/BRANDS.md §7"),
];

/** Whole product-id ranges a vendor uses only for update mode. */
export const BOOTLOADER_RANGES: readonly (Omit<BootloaderId, "pid"> & { from: number; to: number })[] = [
  { vid: 0x19f5, from: 0xaf00, to: 0xafff, what: "NuPhy keyboard (upgrader)", kind: "keyboard", source: "docs/devices/BRANDS.md §7 (NuPhyIO upgrader PIDs)" },
  { vid: 0x03eb, from: 0x2ff0, to: 0x2ff9, what: "Keyboard (Atmel DFU bootloader)", kind: "keyboard", source: "docs/devices/BRANDS.md §7" },
];

/**
 * Product strings that only a device in update mode reports ("Bootloader", "STM32 DFU", "Boot Device").
 * Checked as whole words so "Reboot" or a model name can't trip it.
 */
const BOOT_NAME = /\bbootloader\b|\bdfu\b|\bboot\s*device\b|\bfirmware\s*update\s*mode\b/i;

export function bootloaderEntry(vid: number, pid: number): BootloaderId | undefined {
  const range = BOOTLOADER_RANGES.find((x) => x.vid === vid && pid >= x.from && pid <= x.to);
  const pad = PAD_BOOT_IDS.find((x) => x.vid === vid && x.pid === pid);
  return (
    BOOTLOADER_IDS.find((x) => x.vid === vid && x.pid === pid) ??
    (range && { vid, pid, what: range.what, kind: range.kind, source: range.source }) ??
    // Controllers' boot and recovery identities (src/lib/controllers/models.ts; the bridge: pads.rs `boot`).
    (pad && { vid, pid, what: pad.what, kind: "controller", source: "docs/devices/CONTROLLERS.md" })
  );
}

/** True for a known bootloader id, or a device whose own product string says it's in update mode. */
export function isBootloader(vid: number, pid: number, productName?: string | null): boolean {
  return !!bootloaderEntry(vid, pid) || (!!productName && BOOT_NAME.test(productName));
}

/** The note shown instead of a device in update mode. */
export const BOOTLOADER_NOTE = "This device is in firmware-update mode; finish or cancel it in the maker's tool.";
