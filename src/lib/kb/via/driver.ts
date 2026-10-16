// The VIA / Vial driver for the generic Keyboard panel: claims any device that has QMK's raw-HID
// collection (0xFF60/0x61), whatever its vendor id; a more specific driver (an OpenMouse keyboard,
// Wave 2's FCC boards) wins by priority. Pinging asks for the VIA protocol version and nothing else.
import { isBootloader } from "../../bootloader-ids.ts";
import type { KbDriver } from "../types.ts";
import { ViaBackend } from "./backend.ts";
import { ViaClient } from "./protocol.ts";
import { hidChannel, RAW_PAGE, RAW_USAGE, ViaTransport } from "./transport.ts";

export const hasRawHid = (d: HIDDevice) => d.collections.some((c) => c.usagePage === RAW_PAGE && c.usage === RAW_USAGE);

export const viaDriver: KbDriver = {
  id: "via",
  name: "VIA / Vial",
  priority: 10,
  vids: null,
  claims: (d) => hasRawHid(d) && !isBootloader(d.vendorId, d.productId, d.productName),
  open: (d, ctx) => ViaBackend.open(d, ctx),
  async ping(d) {
    const t = new ViaTransport(hidChannel(d), { timeoutMs: 400 });
    try {
      await t.open();
      return (await new ViaClient(t).protocolVersion()) !== null;
    } catch {
      return false;
    } finally {
      await t.close().catch(() => undefined);
    }
  },
};
