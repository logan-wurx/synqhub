// @openmouse/keyboard-protocol keyboards as one KbDriver: claims what the package's own registry
// claims (Wooting 60HE+, Wuque Studio boards, Kochi Hummingbird 68), loading only that vendor's module.
import { isBootloader } from "../../bootloader-ids.ts";
import type { KbDriver } from "../types.ts";
import { OmkbBackend } from "./backend.ts";
import { sparklinkModel } from "../../brands/sparklink/devices.ts";
import { findKbDriver, OMKB_VIDS } from "./registry.ts";

export const omkbDriver: KbDriver = {
  id: "omkb",
  name: "OpenMouse keyboards",
  priority: 20,
  vids: OMKB_VIDS,
  async claims(d) {
    // One driver per id: the SparkLink driver owns the Kochi Hummingbird 68 (it speaks the same Windows / Mac order and more).
    return !isBootloader(d.vendorId, d.productId, d.productName) && !sparklinkModel(d.vendorId, d.productId) && !!(await findKbDriver(d));
  },
  async open(d) {
    const m = await findKbDriver(d);
    if (!m) throw new Error("No OpenMouse keyboard driver claims this keyboard.");
    return OmkbBackend.open(d, m);
  },
  async ping(d) {
    if (sparklinkModel(d.vendorId, d.productId)) return false;
    const m = await findKbDriver(d);
    return m ? OmkbBackend.ping(d, m) : false;
  },
};
