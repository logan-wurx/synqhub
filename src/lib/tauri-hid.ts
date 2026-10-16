// A `navigator.hid` backed by SYNQ's Rust HID bridge (src-tauri/src/hid.rs), so the WebHID
// drivers in @openmouse/protocol run unchanged inside the desktop app. Only vendors the bridge
// allows are ever listed (src-tauri/src/hid.rs: its hand-built devices, and for every other mouse
// only the vendor-defined collections in OpenMouse's own device table, and for the Razer mice that take
// their settings on their mouse or consumer collection, that collection for feature reports only: no
// input report is ever forwarded and no output report is ever written to it). There is no device picker:
// requestDevice() returns the matching devices directly, since SYNQ only talks to the user's gear.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** A collection as the bridge reads it from the report descriptor (WebHID's HIDCollectionInfo shape). */
interface BridgeCollection {
  usagePage: number;
  usage: number;
  type?: number;
  children?: BridgeCollection[];
  inputReports?: { reportId: number; items: { reportSize: number; reportCount: number }[] }[];
  outputReports?: BridgeCollection["inputReports"];
  featureReports?: BridgeCollection["inputReports"];
}

interface Summary {
  key: string;
  vendorId: number;
  productId: number;
  productName: string;
  collections: BridgeCollection[];
}

const LOGITECH = 0x046d;

function toBytes(data: BufferSource): number[] {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return Array.from(bytes);
}

// Report ids and sizes come from each collection's descriptor, so OpenMouse's drivers can find their
// channel the way they do in Chrome (several match on report id and length, not usage alone).
function asCollections(c: BridgeCollection[]): HIDCollectionInfo[] {
  return c.map(
    (x) =>
      ({
        usagePage: x.usagePage,
        usage: x.usage,
        type: x.type ?? 1,
        children: asCollections(x.children ?? []),
        inputReports: x.inputReports ?? [],
        outputReports: x.outputReports ?? [],
        featureReports: x.featureReports ?? [],
      }) as unknown as HIDCollectionInfo,
  );
}

class TauriHidDevice {
  readonly key: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  collections: HIDCollectionInfo[];
  opened = false;
  oninputreport: ((this: this, ev: HIDInputReportEvent) => unknown) | null = null;
  #listeners = new Set<(event: HIDInputReportEvent) => void>();

  constructor(s: Summary) {
    this.key = s.key;
    this.vendorId = s.vendorId;
    this.productId = s.productId;
    this.productName = s.productName;
    this.collections = asCollections(s.collections);
  }

  async open(): Promise<void> {
    if (this.opened) return;
    await invoke("hid_open", { key: this.key });
    this.opened = true;
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    await invoke("hid_close", { key: this.key });
  }

  async forget(): Promise<void> {
    await this.close();
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    await invoke("hid_send_report", { key: this.key, reportId, data: toBytes(data) });
  }

  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    await invoke("hid_send_feature_report", { key: this.key, reportId, data: toBytes(data) });
  }

  /**
   * SYNQ's extension: an output report to one named collection only (QMK raw HID 0xFF60/0x61 for
   * VIA / Vial, whose frames the bridge checks again). WebHID has no such call; drivers fall back to
   * sendReport when it's missing.
   */
  async sendReportTo(usagePage: number, usage: number, reportId: number, data: BufferSource): Promise<void> {
    await invoke("hid_send_report_to", { key: this.key, usagePage, usage, reportId, data: toBytes(data) });
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    const bytes = await invoke<number[]>("hid_receive_feature_report", { key: this.key, reportId });
    return new DataView(Uint8Array.from(bytes).buffer);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | ((e: HIDInputReportEvent) => void)): void {
    if (type !== "inputreport") return;
    this.#listeners.add(typeof listener === "function" ? (listener as (e: HIDInputReportEvent) => void) : (e) => (listener as EventListenerObject).handleEvent(e));
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | ((e: HIDInputReportEvent) => void)): void {
    if (type !== "inputreport") return;
    this.#listeners.delete(listener as (e: HIDInputReportEvent) => void);
  }

  dispatchEvent(): boolean {
    return true;
  }

  /**
   * Called with every input report the bridge forwards for this device (and the collection it came from). A game
   * controller's reports come in timestamped batches; `hostTime` (ms, the bridge's clock) is when the bridge read it.
   */
  deliver(reportId: number, data: number[], usagePage?: number, usage?: number, hostTime?: number): void {
    const event = Object.assign(new Event("inputreport"), {
      device: this as unknown as HIDDevice,
      reportId,
      data: new DataView(Uint8Array.from(data).buffer),
      usagePage,
      usage,
      hostTime,
    }) as HIDInputReportEvent;
    this.oninputreport?.call(this, event);
    for (const l of [...this.#listeners]) {
      try {
        l(event);
      } catch (err) {
        console.warn("[onboard hid] input listener failed", err);
      }
    }
  }
}

function matches(device: TauriHidDevice, f: HIDDeviceFilter): boolean {
  if (f.vendorId !== undefined && f.vendorId !== device.vendorId) return false;
  if (f.productId !== undefined && f.productId !== device.productId) return false;
  if (f.usagePage === undefined && f.usage === undefined) return true;
  return device.collections.some((c) => (f.usagePage === undefined || c.usagePage === f.usagePage) && (f.usage === undefined || c.usage === f.usage));
}

class TauriHid {
  onconnect = null;
  ondisconnect = null;
  #devices = new Map<string, TauriHidDevice>();

  async getDevices(): Promise<HIDDevice[]> {
    const list = await invoke<Summary[]>("hid_list");
    const seen = new Set<string>();
    for (const s of list) {
      seen.add(s.key);
      const existing = this.#devices.get(s.key);
      if (existing) existing.collections = asCollections(s.collections);
      else this.#devices.set(s.key, new TauriHidDevice(s));
    }
    for (const [key, dev] of this.#devices) {
      if (!seen.has(key)) {
        dev.opened = false;
        this.#devices.delete(key);
      }
    }
    return [...this.#devices.values()] as unknown as HIDDevice[];
  }

  async requestDevice(options: HIDDeviceRequestOptions): Promise<HIDDevice[]> {
    const all = (await this.getDevices()) as unknown as TauriHidDevice[];
    const filters = options.filters ?? [];
    return (filters.length ? all.filter((d) => filters.some((f) => matches(d, f))) : all) as unknown as HIDDevice[];
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }

  deliver(key: string, reportId: number, data: number[], usagePage?: number, usage?: number, hostTime?: number): void {
    this.#devices.get(key)?.deliver(reportId, data, usagePage, usage, hostTime);
  }
}

const WEB = typeof __ONBOARD_WEB__ !== "undefined" && __ONBOARD_WEB__ === true;
let installed: Promise<void> | null = null;

/**
 * Replaces navigator.hid with the bridge. Safe to call more than once. On the website the bridge is
 * SYNQ Helper when the person connected it (src/lib/web/helper.ts); otherwise the same call puts the
 * guarded WebHID wrapper in place instead (src/lib/web/hid.ts), so every caller of this function ends up
 * with a `navigator.hid` that only offers checked devices.
 */
export function installTauriHid(): Promise<void> {
  // The website: with SYNQ Helper connected, this same bridge (its commands reach the helper through
  // src/lib/web/tauri-core.ts); without it, the guarded WebHID wrapper.
  if (WEB)
    return (installed ??= import("./web/helper").then(async (h) => {
      await h.helperSettled();
      if (h.helperReady()) return installBridge();
      return import("./web/hid").then((m) => m.installWebHid());
    }));
  installed ??= installBridge();
  return installed;
}

async function installBridge(): Promise<void> {
  const hid = new TauriHid();
  await listen<{ key: string; reportId: number; data: number[]; usagePage?: number; usage?: number }>("hid-input", (e) =>
    hid.deliver(e.payload.key, e.payload.reportId, e.payload.data, e.payload.usagePage, e.payload.usage),
  );
  // A game controller's reports: a batch at a time, each with the time the bridge read it (src-tauri/src/hid.rs PadReport).
  await listen<{ key: string; usagePage: number; usage: number; reports: { t: number; id: number; d: number[] }[] }>("hid-input-batch", (e) => {
    for (const r of e.payload.reports) hid.deliver(e.payload.key, r.id, r.d, e.payload.usagePage, e.payload.usage, r.t / 1000);
  });
  Object.defineProperty(navigator, "hid", { value: hid, configurable: true });
}

export const LOGITECH_VENDOR_ID = LOGITECH;
