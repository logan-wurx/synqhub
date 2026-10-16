// A simulated Royal Kludge BeiYing keyboard, for the browser preview (src/lib/kb/mock.ts) and the tests
// (scripts/rk-beiying-session.sim.mjs): it takes HID feature reports with id 0x0A and 64 data bytes on its System Control
// collection and never answers, like the real ones. It notes anything the guard would have refused. Nothing here talks
// to a device.
import { RK_BEIYING_GUARD } from "./guard.ts";
import { KEYMAP_REPORTS, REPORT_ID, decodeKeymap } from "./protocol.ts";

export class SimRkBoard {
  readonly vendorId = 0x258a;
  readonly productId: number;
  readonly productName: string;
  readonly collections = [
    { usagePage: 1, usage: 6 },
    { usagePage: 1, usage: 0x80 },
  ];
  opened = false;
  /** The 64 data bytes of every feature report received, in order. */
  readonly reports: Uint8Array[] = [];
  /** Reports the guard would have refused. */
  readonly violations: string[] = [];

  constructor(productId: number, productName = "RK Keyboard") {
    this.productId = productId;
    this.productName = productName;
  }

  async open(): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
  }
  addEventListener(): void {
    throw new Error("these keyboards never answer: nothing may listen");
  }
  removeEventListener(): void {}
  async sendReport(): Promise<void> {
    throw new Error("output reports are never sent");
  }
  async receiveFeatureReport(): Promise<DataView> {
    throw new Error("nothing is ever read back from these keyboards");
  }
  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    if (reportId !== REPORT_ID) throw new Error(`report id ${reportId}`);
    const f = Uint8Array.from(new Uint8Array(data as ArrayBuffer));
    if (f.length !== 64) throw new Error(`length ${f.length}`);
    this.reports.push(f);
    if (RK_BEIYING_GUARD.classify({ type: "feature", reportId, data: f }).verdict === "blocked") this.violations.push(Array.from(f.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join(" "));
  }

  /** The key map the board would hold after the last nine key-map reports; null before there were nine. */
  lastMap(): Map<number, number> | null {
    const maps = this.reports.filter((r) => r[0] === KEYMAP_REPORTS);
    return maps.length >= KEYMAP_REPORTS ? decodeKeymap(maps.slice(-KEYMAP_REPORTS)) : null;
  }
}
