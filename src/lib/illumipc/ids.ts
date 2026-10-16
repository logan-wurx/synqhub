// The USB ids of the keyboards illumipc.com's configurator drives, and the one collection it talks on. These are the ids
// SYNQ's X68 HE / illumipc driver (src/lib/x68he*.ts, src/components/keyboard/X68Panel.tsx) opens: 2E3C:C365 is shared
// by hundreds of boards (the product code a keyboard reports tells them apart, see catalog.generated.ts), 2E3C:C366..C368
// are the gamepad-mode personalities of the same firmware, and 0416:7372 carries the Redragon boards on a Winbond vendor id.
// The Rust bridge's list is generated from this one (scripts/gen-brand-bridge.ts); scripts/kb-safety.test.ts compares.
//
// No heavy imports: the website policy, the device list and the bridge generator all read this file.

/** [vendor id, product id]. */
export const ILLUMIPC_USB_IDS: readonly (readonly [number, number])[] = [
  [0x2e3c, 0xc365],
  [0x2e3c, 0xc366],
  [0x2e3c, 0xc367],
  [0x2e3c, 0xc368],
  [0x0416, 0x7372],
];

/** illumipc's configurator collection: usage page 0xFF1B, usage 0x91, report 1, 63-byte output and input reports. */
export const ILLUMIPC_COLLECTION = { usagePage: 0xff1b, usage: 0x91, reportId: 1, frameLen: 63 } as const;

export const isIllumipcId = (vendorId: number, productId: number): boolean => ILLUMIPC_USB_IDS.some(([v, p]) => v === vendorId && p === productId);

const hex = (v: string | number) => (typeof v === "number" ? v : parseInt(String(v).replace(/^0x/i, ""), 16));
/** The same for ids written as hex strings ("2e3c", "c365"). */
export const isIllumipcHex = (vid: string | number | null | undefined, pid: string | number | null | undefined): boolean => {
  if (vid === null || vid === undefined || pid === null || pid === undefined) return false;
  const v = hex(vid);
  const p = hex(pid);
  return Number.isFinite(v) && Number.isFinite(p) && isIllumipcId(v, p);
};

/** "2e3c:c365" */
export const idKey = (vendorId: number, productId: number): string => `${vendorId.toString(16).padStart(4, "0")}:${productId.toString(16).padStart(4, "0")}`;
