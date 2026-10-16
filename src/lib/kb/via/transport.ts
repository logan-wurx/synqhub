// VIA / Vial over QMK's raw-HID collection (usage page 0xFF60, usage 0x61): 32-byte output reports
// without a report id, answered by one 32-byte input report. One request at a time; every frame
// passes the guard (guard.ts) before it leaves, so a refused command never reaches the device.
// In the desktop app the bridge sends to that one collection (`sendReportTo`) and checks the frame
// again in Rust; in a browser, WebHID's sendReport on the raw-HID interface does the same job.
// No Tauri import: the bridge's extension is detected on the device object.
import type { Grants } from "../../advanced/core.ts";
import { checkViaFrame, type Verdict } from "./guard.ts";

export const RAW_PAGE = 0xff60;
export const RAW_USAGE = 0x61;

/** What the transport needs from a device: send a frame, hear replies. */
export interface RawChannel {
  /** Report size in bytes (32 on every QMK board). */
  readonly size: number;
  open(): Promise<void>;
  close(): Promise<void>;
  send(frame: Uint8Array): Promise<void>;
  /** Subscribes to input reports; returns the unsubscribe. */
  listen(onReport: (data: Uint8Array) => void): () => void;
}

type BridgeDevice = HIDDevice & {
  /** The desktop bridge's extension (src/lib/tauri-hid.ts): an output report to one named collection. */
  sendReportTo?: (usagePage: number, usage: number, reportId: number, data: BufferSource) => Promise<void>;
};

/** The raw-HID collection of a WebHID device (or the bridge's stand-in). */
export function hidChannel(device: HIDDevice): RawChannel {
  const dev = device as BridgeDevice;
  const raw = device.collections.find((c) => c.usagePage === RAW_PAGE && c.usage === RAW_USAGE);
  const declared = raw?.outputReports?.[0]?.items?.reduce((n, it) => n + ((it.reportSize ?? 8) * (it.reportCount ?? 0)) / 8, 0);
  const size = declared === 64 ? 64 : 32;
  let openedHere = false;
  return {
    size,
    async open() {
      if (!device.opened) {
        await device.open();
        openedHere = true;
      }
    },
    async close() {
      if (openedHere && device.opened) await device.close();
      openedHere = false;
    },
    async send(frame) {
      const data = frame.slice() as Uint8Array<ArrayBuffer>;
      if (typeof dev.sendReportTo === "function") await dev.sendReportTo(RAW_PAGE, RAW_USAGE, 0, data);
      else await device.sendReport(0, data);
    },
    listen(onReport) {
      const handler = (e: Event) => {
        const ev = e as HIDInputReportEvent & { usagePage?: number; usage?: number };
        // The bridge says which collection a report came from; ignore any other collection's.
        if (ev.usagePage !== undefined && (ev.usagePage !== RAW_PAGE || ev.usage !== RAW_USAGE)) return;
        onReport(new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength).slice());
      };
      device.addEventListener("inputreport", handler);
      return () => device.removeEventListener("inputreport", handler);
    },
  };
}

export interface TransportOptions {
  /** How long one reply may take. */
  timeoutMs?: number;
  /** Every frame in and out, for the diagnostics log. */
  trace?: (line: string) => void;
  /** The keyboard's AdvancedGate: which Advanced actions are unlocked right now. Default: none. */
  grants?: Grants;
  /**
   * A second tier for frames VIA's own guard refuses (the Keychron Hall-effect commands, keychron/guard.ts): it returns a verdict
   * for the frames it knows and null for the rest, which stay refused. It can only widen what is sent to this one keyboard; it
   * never sees VIA's bootloader jump or EEPROM reset (those are not in its range).
   */
  extension?: (frame: Uint8Array) => Verdict | null;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const trimmed = (b: Uint8Array) => {
  let end = b.length;
  while (end > 1 && b[end - 1] === 0) end--;
  return hex(b.subarray(0, end));
};

export class ViaTransport {
  readonly #ch: RawChannel;
  readonly #timeout: number;
  readonly #trace?: (line: string) => void;
  readonly #grants?: Grants;
  readonly #extension?: (frame: Uint8Array) => Verdict | null;
  #queue: Promise<unknown> = Promise.resolve();
  #waiter: ((data: Uint8Array) => void) | null = null;
  #unlisten: (() => void) | null = null;

  constructor(ch: RawChannel, opts: TransportOptions = {}) {
    this.#ch = ch;
    this.#timeout = opts.timeoutMs ?? 600;
    this.#trace = opts.trace;
    this.#grants = opts.grants;
    this.#extension = opts.extension;
  }

  get size(): number {
    return this.#ch.size;
  }

  async open(): Promise<void> {
    await this.#ch.open();
    this.#unlisten ??= this.#ch.listen((data) => {
      this.#trace?.(`in  ${trimmed(data)}`);
      this.#waiter?.(data);
    });
  }

  async close(): Promise<void> {
    this.#unlisten?.();
    this.#unlisten = null;
    await this.#ch.close();
  }

  /**
   * Sends one frame (padded to the report size) and resolves with the reply. `match`: "echo" waits
   * for a reply whose first byte is the command (or 0xFF, QMK's "unhandled"); "next" takes the next
   * report (Vial's replies don't echo). A refused frame throws before anything is sent.
   */
  request(bytes: readonly number[] | Uint8Array, match: "echo" | "next" = "echo"): Promise<Uint8Array> {
    const frame = new Uint8Array(this.#ch.size);
    frame.set(bytes.slice(0, frame.length));
    let verdict = checkViaFrame(frame, this.#grants);
    if (!verdict.ok && this.#extension) verdict = this.#extension(frame) ?? verdict;
    if (!verdict.ok) return Promise.reject(new Error(verdict.why));
    const run = async () => {
      const attempts = verdict.write ? 1 : 2;
      let last: unknown;
      for (let i = 0; i < attempts; i++) {
        try {
          return await this.#once(frame, match);
        } catch (e) {
          last = e;
        }
      }
      throw last;
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    return p;
  }

  #once(frame: Uint8Array, match: "echo" | "next"): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = null;
        reject(new Error("The keyboard didn't answer."));
      }, this.#timeout);
      this.#waiter = (data) => {
        if (match === "echo" && data[0] !== frame[0] && data[0] !== 0xff) return;
        clearTimeout(timer);
        this.#waiter = null;
        resolve(data);
      };
      this.#trace?.(`out ${trimmed(frame)}`);
      this.#ch.send(frame).catch((e) => {
        clearTimeout(timer);
        this.#waiter = null;
        reject(e);
      });
    });
  }
}
