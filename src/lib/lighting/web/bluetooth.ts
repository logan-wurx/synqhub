// The browser's Bluetooth side of a Govee lamp (Chrome and Edge's Web Bluetooth), what src-tauri/src/lighting/govee/
// ble.rs does with Windows Bluetooth: the GATT link of an open lamp, service `…1910`, write `…2b11` (without response),
// notify `…2b10`, and the `…2b12` version marker when the lamp has one. A site reaches only a lamp the person picked
// in the browser's own chooser, so there is no scan here: the chooser is the list.
//
// The types are the few parts of Web Bluetooth used here (TypeScript's DOM library has none of it), so the tests can
// hand in a pretend device.
import { Inbox, type GoveeWire } from "./session.ts";

export const SERVICE = "00010203-0405-0607-0809-0a0b0c0d1910";
export const WRITE = "00010203-0405-0607-0809-0a0b0c0d2b11";
export const NOTIFY = "00010203-0405-0607-0809-0a0b0c0d2b10";
export const MARKER = "00010203-0405-0607-0809-0a0b0c0d2b12";

export interface BtCharacteristic extends EventTarget {
  readonly value?: DataView | null;
  readonly properties?: { readonly writeWithoutResponse?: boolean };
  readValue(): Promise<DataView>;
  writeValueWithoutResponse(value: Uint8Array<ArrayBuffer>): Promise<void>;
  writeValueWithResponse(value: Uint8Array<ArrayBuffer>): Promise<void>;
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
}
export interface BtService {
  getCharacteristic(uuid: string): Promise<BtCharacteristic>;
}
export interface BtServer {
  getPrimaryService(uuid: string): Promise<BtService>;
}
export interface BtDevice extends EventTarget {
  readonly id: string;
  readonly name?: string | null;
  readonly gatt?: { connect(): Promise<BtServer>; disconnect(): void; readonly connected: boolean } | null;
}
export interface BtRequest {
  filters: { namePrefix: string }[];
  optionalServices: string[];
}
export interface WebBluetooth {
  requestDevice(options: BtRequest): Promise<BtDevice>;
}

/** The browser's Web Bluetooth, when it has one (Chrome and Edge on Windows, macOS, ChromeOS and Android). */
export const browserBluetooth = (): WebBluetooth | null =>
  typeof navigator !== "undefined" && "bluetooth" in navigator ? ((navigator as Navigator & { bluetooth: WebBluetooth }).bluetooth ?? null) : null;

const CONNECT_TRIES = 3;
const RETRY_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An open GATT link to one lamp. `lost` hears the browser dropping the connection (not `close`). */
export class GattWire implements GoveeWire {
  readonly device: BtDevice;
  readonly marker: number | null;
  readonly #write: BtCharacteristic;
  readonly #notify: BtCharacteristic;
  readonly #inbox = new Inbox();
  readonly #onValue = (e: Event) => {
    const v = (e.target as BtCharacteristic | null)?.value;
    if (v) this.#inbox.push(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
  };
  readonly #onDrop = () => {
    if (this.#closed) return;
    this.#closed = true;
    this.lost(this.#writeFailed ?? "The lamp went out of reach.");
  };
  #closed = false;
  #writeFailed: string | null = null;
  lost: (why: string) => void = () => {};

  private constructor(device: BtDevice, write: BtCharacteristic, notify: BtCharacteristic, marker: number | null) {
    this.device = device;
    this.#write = write;
    this.#notify = notify;
    this.marker = marker;
    notify.addEventListener("characteristicvaluechanged", this.#onValue);
    device.addEventListener("gattserverdisconnected", this.#onDrop);
  }

  /** Connects (three tries, as the desktop does), finds the Govee service and subscribes to the lamp's reports. */
  static async connect(device: BtDevice): Promise<GattWire> {
    const gatt = device.gatt;
    if (!gatt) throw new Error("The browser can't open this lamp.");
    let service: BtService | null = null;
    let last = "";
    for (let attempt = 0; attempt < CONNECT_TRIES && !service; attempt++) {
      try {
        service = await (await gatt.connect()).getPrimaryService(SERVICE);
      } catch (e) {
        last = why(e);
        if (attempt < CONNECT_TRIES - 1) await sleep(RETRY_MS);
      }
    }
    if (!service) {
      gatt.disconnect();
      throw new Error(`The lamp didn't answer. It may be out of range, switched off at the wall, or connected to a phone.${last ? ` (${last})` : ""}`);
    }
    try {
      const write = await service.getCharacteristic(WRITE).catch(() => Promise.reject(new Error("This lamp has no Govee control characteristic.")));
      const notify = await service.getCharacteristic(NOTIFY).catch(() => Promise.reject(new Error("This lamp has no Govee report characteristic.")));
      // The encryption-version marker: [01, version]. Absent on many lamps, which proves nothing (§10.3).
      const marker = await service
        .getCharacteristic(MARKER)
        .then((c) => c.readValue())
        .then((v) => (v.byteLength >= 2 && v.getUint8(0) === 0x01 ? v.getUint8(1) : null))
        .catch(() => null);
      const wire = new GattWire(device, write, notify, marker);
      await notify.startNotifications().catch((e: unknown) => {
        wire.close();
        throw new Error(`The lamp didn't accept SYNQ's report subscription. (${why(e)})`);
      });
      return wire;
    } catch (e) {
      gatt.disconnect();
      throw e;
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("The lamp isn't open.");
    const value = new Uint8Array(bytes);
    try {
      if (this.#write.properties?.writeWithoutResponse === false) await this.#write.writeValueWithResponse(value);
      else await this.#write.writeValueWithoutResponse(value);
    } catch (e) {
      this.#writeFailed = `The lamp went out of reach. (${why(e)})`;
      throw new Error(this.#writeFailed);
    }
  }

  recv(ms: number): Promise<Uint8Array | null> {
    return this.#inbox.recv(ms);
  }

  /** Every report from now on goes to `sink` as it comes (once the handshake is done). */
  drain(sink: (w: Uint8Array) => void) {
    this.#inbox.drain(sink);
  }

  /** Lets go of the lamp: no more reports, and the browser's connection is closed. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#notify.removeEventListener("characteristicvaluechanged", this.#onValue);
    this.device.removeEventListener("gattserverdisconnected", this.#onDrop);
    void this.#notify.stopNotifications().catch(() => undefined);
    this.device.gatt?.disconnect();
  }
}
