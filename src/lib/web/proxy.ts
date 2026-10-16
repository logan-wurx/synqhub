// A WebHID device wrapped in the guard (src/lib/web/guard.ts). It looks like the real HIDDevice to the
// drivers, with three differences that mirror the desktop bridge:
//   - `collections` lists only the collections SYNQ may use (src/lib/web/policy.ts), so a driver
//     can't pick a typing, pointing or consumer collection that the desktop never lists;
//   - every `sendReport`, `sendFeatureReport` and `receiveFeatureReport` passes the guard first and a
//     refused one throws before anything reaches the device. The bytes that were checked are a copy,
//     and the copy is what is sent;
//   - `sendReportTo(usagePage, usage, reportId, data)` is SYNQ's own call (the desktop shim has it
//     too): VIA / Vial and the X68 HE send their checked frames through it.
// Pure TypeScript over a small interface, so the tests drive it with a simulated device.
import { DeviceGuard, GuardRefusal, type CollectionShape } from "./guard.ts";

/** The part of WebHID's HIDDevice the proxy uses. */
export interface RawHidDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: readonly CollectionShape[];
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  addEventListener(type: "inputreport", listener: (event: RawInputEvent) => void): void;
  removeEventListener(type: "inputreport", listener: (event: RawInputEvent) => void): void;
}

export interface RawInputEvent {
  reportId: number;
  data: DataView;
}

/** What a driver receives for an input report: the same fields, and `device` is the guarded proxy. */
export interface GuardedInputEvent {
  type: "inputreport";
  device: GuardedHidDevice;
  reportId: number;
  data: DataView;
  timeStamp: number;
}

type Listener = (event: GuardedInputEvent) => unknown;

const toBytes = (data: BufferSource): Uint8Array<ArrayBuffer> => {
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return Uint8Array.from(view);
};

export class GuardedHidDevice {
  readonly raw: RawHidDevice;
  readonly guard: DeviceGuard;
  oninputreport: Listener | null = null;
  readonly #listeners = new Set<Listener>();
  #attached = false;
  readonly #relay = (e: RawInputEvent) => {
    const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    this.guard.observeInput(e.reportId, bytes);
    const event: GuardedInputEvent = { type: "inputreport", device: this, reportId: e.reportId, data: e.data, timeStamp: Date.now() };
    try {
      this.oninputreport?.call(this, event);
    } catch (err) {
      console.warn("[onboard hid] oninputreport failed", err);
    }
    for (const l of [...this.#listeners]) {
      try {
        l(event);
      } catch (err) {
        console.warn("[onboard hid] input listener failed", err);
      }
    }
  };

  private constructor(raw: RawHidDevice, guard: DeviceGuard) {
    this.raw = raw;
    this.guard = guard;
  }

  static async wrap(raw: RawHidDevice): Promise<GuardedHidDevice> {
    const guard = await DeviceGuard.create({ vendorId: raw.vendorId, productId: raw.productId, productName: raw.productName, collections: raw.collections });
    return new GuardedHidDevice(raw, guard);
  }

  get vendorId(): number {
    return this.raw.vendorId;
  }
  get productId(): number {
    return this.raw.productId;
  }
  get productName(): string {
    return this.raw.productName;
  }
  get opened(): boolean {
    return this.raw.opened;
  }
  /** Only the collections SYNQ may use, as the desktop bridge lists them. */
  get collections(): readonly CollectionShape[] {
    return this.raw.collections.filter((c) => this.guard.open.some((o) => o.usagePage === c.usagePage && o.usage === c.usage));
  }

  async open(): Promise<void> {
    if (this.guard.bootloader) throw new GuardRefusal("This device is in firmware-update mode; SYNQ never opens it.");
    await this.raw.open();
    if (!this.#attached) {
      this.raw.addEventListener("inputreport", this.#relay);
      this.#attached = true;
    }
  }

  async close(): Promise<void> {
    if (this.#attached) {
      this.raw.removeEventListener("inputreport", this.#relay);
      this.#attached = false;
    }
    await this.raw.close();
  }

  async forget(): Promise<void> {
    await this.close();
    await this.raw.forget?.();
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    const bytes = toBytes(data);
    this.guard.output(reportId, bytes);
    await this.raw.sendReport(reportId, bytes);
  }

  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    const bytes = toBytes(data);
    this.guard.feature(reportId, bytes);
    await this.raw.sendFeatureReport(reportId, bytes);
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    this.guard.receiveFeature(reportId);
    return this.raw.receiveFeatureReport(reportId);
  }

  /** SYNQ's extension: an output report to one named collection only (VIA / Vial raw HID, the X68 HE). */
  async sendReportTo(usagePage: number, usage: number, reportId: number, data: BufferSource): Promise<void> {
    const bytes = toBytes(data);
    this.guard.outputTo(usagePage, usage, reportId, bytes);
    await this.raw.sendReport(reportId, bytes);
  }

  addEventListener(type: string, listener: Listener | { handleEvent(e: GuardedInputEvent): unknown }): void {
    if (type !== "inputreport") return;
    this.#listeners.add(typeof listener === "function" ? listener : (e) => listener.handleEvent(e));
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type !== "inputreport") return;
    this.#listeners.delete(listener);
  }

  dispatchEvent(): boolean {
    return true;
  }
}
