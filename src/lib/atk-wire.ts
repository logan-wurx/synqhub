// One request at a time over the ATK config channel (report 0x08, 16-byte frames), matched to its
// reply. Split out of atk-mouse.ts unchanged so the quick "is the mouse on" check
// (atk-probe.ts) can use the same checked path without loading the whole mouse service.
import * as P from "./atk-protocol.ts";
import type { Grants } from "./advanced/core.ts";

export class NoReply extends Error {}

/** The ATK mouse to talk to: the X1's receiver (the checked path) before its cable, config channel only. */
export function pickAtkDevice(devices: readonly HIDDevice[]): HIDDevice | undefined {
  const candidates = devices.filter(
    (d) =>
      d.vendorId === P.ATK_VENDOR_ID &&
      P.ATK_LINKS[d.productId] !== undefined &&
      d.collections.some((c) => c.usagePage === P.CONFIG_COLLECTION.usagePage && c.usage === P.CONFIG_COLLECTION.usage),
  );
  return candidates.sort((a, b) => Number(P.ATK_LINKS[b.productId].verified) - Number(P.ATK_LINKS[a.productId].verified))[0];
}

const REPLY_MS = 600;
const READ_ATTEMPTS = 3;

export const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
export const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join(" ");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One request at a time over report 0x08, matched to its reply. Refuses anything checkFrame rejects. */
export class Wire {
  #queue: Promise<unknown> = Promise.resolve();
  readonly device: HIDDevice;
  /** The device's AdvancedGate, once a panel has one: which Advanced actions are unlocked right now. Default: none. */
  readonly #grants: Grants | undefined;
  constructor(device: HIDDevice, grants?: Grants) {
    this.device = device;
    this.#grants = grants;
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  exchange(frame: Uint8Array, match: (reply: Uint8Array) => boolean, replyMs: number = REPLY_MS): Promise<Uint8Array> {
    const problem = P.checkFrame(frame, this.#grants);
    if (problem) return Promise.reject(new Error(`SYNQ refused to send that to the mouse: ${problem}.`));
    return this.#serial(
      () =>
        new Promise<Uint8Array>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            this.device.removeEventListener("inputreport", onReport);
          };
          const timer = setTimeout(() => {
            done();
            reject(new NoReply("The mouse did not answer."));
          }, replyMs);
          const onReport = (event: HIDInputReportEvent) => {
            if (event.reportId !== P.REPORT_ID) return;
            const reply = new Uint8Array(event.data.buffer.slice(event.data.byteOffset, event.data.byteOffset + event.data.byteLength));
            if (reply.length < P.FRAME_LENGTH || !match(reply)) return;
            done();
            resolve(reply);
          };
          this.device.addEventListener("inputreport", onReport);
          this.device.sendReport(P.REPORT_ID, frame.slice().buffer).catch((err) => {
            done();
            reject(err);
          });
        }),
    );
  }

  command(cmd: number, replyMs: number = REPLY_MS): Promise<Uint8Array> {
    return this.exchange(P.buildCommand(cmd), (r) => r[0] === cmd && r[1] === 0 && P.frameChecksumOk(r), replyMs);
  }

  async read(address: number, length: number): Promise<number[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.exchange(P.buildRead(address, length), (x) => P.isReadReply(x, address, length));
        return Array.from(r.subarray(P.DATA_OFFSET, P.DATA_OFFSET + length));
      } catch (e) {
        if (!(e instanceof NoReply) || attempt >= READ_ATTEMPTS) throw e;
        await sleep(60 * attempt);
      }
    }
  }

  /** Writes one whole row and checks it by reading it back. The receiver echoes writes; the read-back is what counts. */
  async writeRow(address: number, data: readonly number[]): Promise<void> {
    await this.exchange(P.buildWrite(address, data), (r) => P.isWriteEcho(r, address, data)).catch((e) => {
      if (!(e instanceof NoReply)) throw e;
    });
    const back = await this.read(address, data.length);
    if (!same(back, data)) {
      const row = P.WRITABLE_ROWS.get(address)?.name ?? `row 0x${address.toString(16)}`;
      throw new Error(`The mouse didn't keep the new ${row} (wrote ${hex([...data])}, read ${hex(back)}).`);
    }
  }
}

/**
 * Whether the ATK mouse among `devices` is on and answering, with two reads and nothing else:
 * GetMouseOnline, which the 8K receiver answers by itself (so a mouse that is off is told apart from
 * a receiver that isn't there), then GetMouseCIDMID, which only the mouse answers. Every frame passes
 * checkFrame. `ms` is the whole budget; each read gets about half. The device is opened for it if it
 * wasn't, and closed again unless `held()` says a panel is using it.
 */
export async function probeAtkOn(devices: readonly HIDDevice[], ms: number, held: () => boolean = () => false): Promise<boolean> {
  const device = pickAtkDevice(devices);
  if (!device) return false;
  const each = Math.max(150, Math.floor(ms / 2) - 50);
  const wasOpen = device.opened;
  try {
    if (!wasOpen) await device.open();
    const wire = new Wire(device);
    if (P.ATK_LINKS[device.productId].wireless) {
      const online = await wire.command(P.CMD.getMouseOnline, each);
      if (online[P.DATA_OFFSET] !== 1) return false;
    }
    await wire.command(P.CMD.getCidMid, each);
    return true;
  } catch {
    return false;
  } finally {
    if (!wasOpen && !held()) await device.close().catch(() => undefined);
  }
}
