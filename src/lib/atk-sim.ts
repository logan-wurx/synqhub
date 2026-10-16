// A simulated ATK X1 V2 Air+ behind its 8K receiver, speaking the real config channel (report 0x08,
// 16-byte frames, EEPROM rows). The browser preview connects to it so every panel and Advanced flow runs
// the real code path (Wire, checkFrame, the row writers), and the tests use it to see exactly which
// frames a flow sends and in what order. It touches no hardware and imports nothing from Tauri.
//
// What it models: the EEPROM rows SYNQ reads and writes (DPI, rate, lift-off, function and performance
// rows, the six button rows), the receiver's online / battery / version / CID-MID answers, a pairing
// window, and RestoreFactory. What it does NOT model: anything about the real firmware's timing.
import { weBuildCmdPayload, weReportChecksum } from "@openmouse/protocol/endgame-gear-we";
import * as P from "./atk-protocol.ts";

export interface AtkSimOptions {
  /** Pairing finishes by itself this long after the request (the preview's demo). Default: only when the test says so. */
  autoPairMs?: number;
  /** The mouse is switched on. */
  mouseOn?: boolean;
  /** The receiver stops answering RestoreFactory (to see the app cope). */
  silentReset?: boolean;
}

export interface AtkSim {
  readonly device: HIDDevice;
  /** Every report the app sent, in order. */
  readonly sent: Uint8Array[];
  /** What the mouse's EEPROM holds, byte by byte. */
  readonly eeprom: Map<number, number>;
  /** One line per notable thing the simulated mouse did ("write 0x0064", "pair", "reset"). */
  readonly log: string[];
  /** The mouse joined the receiver while a pairing window was open. */
  completePairing(): void;
  /** The pairing window ran out without the mouse joining. */
  expirePairing(): void;
  readonly pairing: { open: boolean; paired: boolean; secondsLeft: number };
  mouseOn: boolean;
  /** The defaults a RestoreFactory puts back. */
  defaults(): Map<number, number>;
}

const pair = (v: number) => [v, (0x55 - v) & 0xff];

/** The rows of the user's mouse as read on 2026-10-12, plus the factory button rows. */
function factoryEeprom(): Map<number, number> {
  const m = new Map<number, number>();
  const put = (address: number, bytes: readonly number[]) => bytes.forEach((b, i) => m.set(address + i, b));
  put(P.ADDR.system, [...pair(0x01), ...pair(4), ...pair(2), ...pair(0), ...pair(0)]); // 1000 Hz, 4 steps, step 3 active
  put(P.ADDR.liftOff, pair(6)); // 1.2 mm
  put(P.ADDR.function, [...pair(1), ...pair(1), ...pair(6), ...pair(0), ...pair(0)]); // debounce 1, motion sync, 60 s sleep
  put(P.ADDR.performance, [...pair(0), 6, 0x4f, ...pair(0)]); // basic sensor mode
  [400, 800, 1600, 3200, 6400, 12800, 25600, 800].forEach((dpi, i) => put(P.ADDR.paw3955Dpi + i * P.PAW3955_STAGE_LENGTH, P.packPaw3955Stage(dpi)));
  put(P.ADDR.angle, [0, 0x55, 0, 0x55]);
  P.BUTTONS.forEach((b, i) => put(P.keyRowAddress(i), P.packButton(b.factory)));
  return m;
}

export function simulateAtk(opts: AtkSimOptions = {}): AtkSim {
  const eeprom = factoryEeprom();
  const sent: Uint8Array[] = [];
  const log: string[] = [];
  const listeners = new Set<(e: HIDInputReportEvent) => void>();
  const pairing = { open: false, paired: false, secondsLeft: P.PAIR_WINDOW_SECONDS };
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  const sim = { mouseOn: opts.mouseOn ?? true };
  const complete = () => {
    if (pairing.open) pairing.paired = true;
  };

  const reply = (cmd: number, body: readonly number[]) => {
    const f = weBuildCmdPayload(cmd, body);
    const event = { reportId: P.REPORT_ID, data: new DataView(f.buffer) } as unknown as HIDInputReportEvent;
    // Deliver after the send resolves, as a real report would arrive.
    setTimeout(() => [...listeners].forEach((l) => l(event)), 0);
  };
  const read = (address: number, length: number) => Array.from({ length }, (_, i) => eeprom.get(address + i) ?? 0);

  const answer = (f: Uint8Array) => {
    if (f.length !== 16 || f[15] !== weReportChecksum(P.REPORT_ID, Array.from(f.subarray(0, 15)))) return; // a bad frame is ignored
    const cmd = f[0];
    switch (cmd) {
      case 0x03:
        return reply(cmd, [0, 0, 0, 4, sim.mouseOn ? 1 : 0, 0x11, 0x22, 0x33]);
      case 0x04:
        return sim.mouseOn ? reply(cmd, [0, 0, 0, 2, 75, 0]) : undefined;
      case 0x10:
        return sim.mouseOn ? reply(cmd, [0, 0, 0, 3, 1, 61, 0]) : undefined;
      case 0x12:
        return sim.mouseOn ? reply(cmd, [0, 0, 0, 2, 0x05, 0x20]) : undefined;
      case 0x1d:
        return reply(cmd, [0, 0, 0, 2, 0x05, 0x01]);
      case 0x08: {
        if (!sim.mouseOn) return;
        const address = (f[2] << 8) | f[3];
        return reply(cmd, [0, f[2], f[3], f[4], ...read(address, f[4])]);
      }
      case 0x07: {
        if (!sim.mouseOn) return;
        const address = (f[2] << 8) | f[3];
        const data = Array.from(f.subarray(5, 5 + f[4]));
        data.forEach((b, i) => eeprom.set(address + i, b));
        log.push(`write 0x${address.toString(16).padStart(4, "0")}`);
        return reply(cmd, [0, f[2], f[3], f[4], ...data]);
      }
      case 0x05: {
        pairing.open = true;
        pairing.paired = false;
        pairing.secondsLeft = P.PAIR_WINDOW_SECONDS;
        log.push(`pair ${f[5]},${f[6]}`);
        if (opts.autoPairMs !== undefined) autoTimer = setTimeout(complete, opts.autoPairMs);
        return reply(cmd, []);
      }
      case 0x06: {
        const status = pairing.paired ? P.PAIR_STATUS_PAIRED : pairing.open ? 1 : 0;
        const left = pairing.open ? pairing.secondsLeft : 0;
        if (pairing.open && !pairing.paired) pairing.secondsLeft = Math.max(0, pairing.secondsLeft - 1);
        return reply(cmd, [0, 0, 0, 2, status, left]);
      }
      case 0x09: {
        log.push("reset");
        eeprom.clear();
        factoryEeprom().forEach((v, k) => eeprom.set(k, v));
        return opts.silentReset ? undefined : reply(cmd, []);
      }
      default:
        log.push(`ignored 0x${cmd.toString(16)}`);
    }
  };

  const device = {
    vendorId: P.ATK_VENDOR_ID,
    productId: 0x1278,
    productName: "Wireless mouse 8k dongle-L",
    collections: [{ usagePage: P.CONFIG_COLLECTION.usagePage, usage: P.CONFIG_COLLECTION.usage, type: 1, children: [], inputReports: [], outputReports: [], featureReports: [] }],
    opened: false,
    async open() {
      device.opened = true;
    },
    async close() {
      device.opened = false;
      clearTimeout(autoTimer);
    },
    async sendReport(reportId: number, data: BufferSource) {
      const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer.slice((data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteOffset + (data as ArrayBufferView).byteLength));
      if (reportId !== P.REPORT_ID) throw new Error("The receiver only takes report 8.");
      sent.push(bytes);
      answer(bytes);
    },
    addEventListener(type: string, l: (e: HIDInputReportEvent) => void) {
      if (type === "inputreport") listeners.add(l);
    },
    removeEventListener(type: string, l: (e: HIDInputReportEvent) => void) {
      if (type === "inputreport") listeners.delete(l);
    },
  };

  const out: AtkSim = {
    device: device as unknown as HIDDevice,
    sent,
    eeprom,
    log,
    pairing,
    get mouseOn() {
      return sim.mouseOn;
    },
    set mouseOn(v: boolean) {
      sim.mouseOn = v;
    },
    completePairing: complete,
    expirePairing() {
      pairing.open = false;
      pairing.secondsLeft = 0;
    },
    defaults: factoryEeprom,
  };
  return out;
}
