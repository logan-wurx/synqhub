// A simulated SparkLink-family board, for the browser preview (src/lib/kb/mock.ts) and the tests
// (scripts/sparklink-session.sim.mjs). It speaks the protocol the way the SDK's code and the AureTrix driver use it:
// 64-byte reports with no report id, [0x5C, len, cmd, checksum, data] in, [0x5C, len, cmd | 0x80, checksum, data] out,
// the default key table in two rows per message, per-key layouts (mode, actuation, rapid trigger, dead zones), a global
// travel message whose dead zones are always zero (AureTrix notes the real board doesn't report them), orders for the
// name, travel range, Windows / Mac mode and report rate. It checks every request (envelope, checksum, padding), refuses
// the commands SYNQ never sends (a thrown error and a note in `violations`), and keeps the state in memory.
// Nothing here talks to a device.
import { CMD, FRAME_LEN, LAYOUT, ORDER, TOUCH, checksum, modeValue, parseRequest } from "./protocol.ts";
import { classifyFrame } from "./guard.ts";

export interface SimKey {
  /** The default key value (HID usage). */
  key: number;
  row: number;
  col: number;
}

export interface SimSparkLinkOptions {
  vendorId: number;
  productId: number;
  productName: string;
  keys: readonly SimKey[];
  /** The name the board reports (order 0x26). */
  name?: string;
  /** False: a mechanical board: the travel range order is refused and key layouts come back unavailable. */
  hallEffect?: boolean;
  /** Travel unit, range, micrometres. */
  stepUm?: number;
  minUm?: number;
  maxUm?: number;
  /** Whether the board has a Windows / Mac switch, and its start. */
  winMode?: boolean | null;
  /** The sync reply says the board is in its bootloader. */
  bootloader?: boolean;
  /** False: the board never answers. */
  answer?: boolean;
  /** Put one key in dynamic-keystroke mode (to check it survives). */
  advancedKey?: number;
  latencyMs?: number;
}

interface KeyMem {
  mode: number;
  db0: number;
  rtp: number;
  rtr: number;
  dp: number;
  dr: number;
}

type Listener = (e: { reportId: number; data: DataView }) => void;

const NEVER_CLASSES = new Set([8, 9, 10, 11, 12, 13, 14, 18, 32, 33, 36, 37, 38, 39, 40, 44, 45, 48, 49]);
const BAD_ORDERS = new Set<number>([ORDER.factoryReset, ORDER.clearCalibration, ORDER.calibrationStart, ORDER.calibrationClose, ORDER.eraseMacroStorage]);

export class SimSparkLinkBoard {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections = [
    { usagePage: 1, usage: 6 },
    { usagePage: 0xffa0, usage: 1 },
  ];
  opened = false;
  /** Every frame the board received, in order. */
  readonly sent: Uint8Array[] = [];
  /** Things that must never happen (a bootloader command, a malformed frame, a write to a layout SYNQ doesn't write). */
  readonly violations: string[] = [];
  /** Every write the board took: [class, key, layout, value] or [class, ...]. */
  readonly writes: number[][] = [];
  readonly mem = new Map<number, KeyMem>();
  readonly keys: readonly SimKey[];
  globalUm: number;
  winMode: boolean | null;
  answer: boolean;
  readonly #o: Required<Pick<SimSparkLinkOptions, "stepUm" | "minUm" | "maxUm" | "hallEffect" | "bootloader" | "latencyMs">> & SimSparkLinkOptions;
  readonly #listeners = new Set<Listener>();

  constructor(o: SimSparkLinkOptions) {
    this.vendorId = o.vendorId;
    this.productId = o.productId;
    this.productName = o.productName;
    this.keys = o.keys;
    this.answer = o.answer ?? true;
    this.winMode = o.winMode === undefined ? true : o.winMode;
    this.globalUm = 2000;
    this.#o = { stepUm: 10, minUm: 100, maxUm: 3500, hallEffect: true, bootloader: false, latencyMs: 1, ...o };
    for (const k of o.keys) this.mem.set(k.key, { mode: modeValue("global"), db0: 1500, rtp: 300, rtr: 300, dp: 200, dr: 200 });
    if (o.advancedKey !== undefined && this.mem.has(o.advancedKey)) this.mem.get(o.advancedKey)!.mode = modeValue("single", 3);
  }

  async open(): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
  }
  addEventListener(type: string, l: Listener): void {
    if (type === "inputreport") this.#listeners.add(l);
  }
  removeEventListener(type: string, l: Listener): void {
    if (type === "inputreport") this.#listeners.delete(l);
  }
  async sendFeatureReport(): Promise<void> {
    throw new Error("feature reports are never used");
  }
  async receiveFeatureReport(): Promise<DataView> {
    throw new Error("feature reports are never used");
  }

  #emit(cmd: number, data: ArrayLike<number>): void {
    const f = new Uint8Array(FRAME_LEN);
    f[0] = 0x5c;
    f[1] = data.length;
    f[2] = cmd;
    for (let i = 0; i < data.length; i++) f[4 + i] = data[i] & 0xff;
    f[3] = checksum(f);
    for (const l of this.#listeners) setTimeout(() => l({ reportId: 0, data: new DataView(f.buffer.slice(0)) }), this.#o.latencyMs);
  }

  #fail(): void {
    this.#emit(0xff, [0]);
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    if (reportId !== 0) throw new Error(`report id ${reportId}`);
    const f = Uint8Array.from(new Uint8Array(data as ArrayBuffer));
    if (f.length !== FRAME_LEN) throw new Error(`length ${f.length}`);
    this.sent.push(f);
    const m = parseRequest(f);
    if (!m) {
      this.violations.push(`malformed ${f.subarray(0, 8)}`);
      throw new Error("MALFORMED FRAME REACHED THE BOARD");
    }
    if (NEVER_CLASSES.has(m.cmd) || (m.cmd === CMD.order && BAD_ORDERS.has(m.data[0]))) {
      this.violations.push(`never ${f.subarray(0, 8)}`);
      throw new Error(`BLOCKED FRAME REACHED THE BOARD: class ${m.cmd} order ${m.data[0]}`);
    }
    // The static guard must have let it through; a frame it would refuse is a violation too.
    const verdict = classifyFrame(f);
    if (verdict.verdict === "blocked") {
      this.violations.push(`unlisted ${f.subarray(0, 8)}`);
      throw new Error(`UNLISTED FRAME REACHED THE BOARD: ${verdict.reason}`);
    }
    if (!this.answer) return;
    this.#handle(m.cmd, m.data);
  }

  #handle(cmd: number, d: Uint8Array): void {
    const o = this.#o;
    switch (cmd) {
      case CMD.sync: {
        const p = new Uint8Array(56);
        p.set([1, 0x01, 0x00, 0x30, 0x00]);
        p[5] = 123 & 0xff; // V1.2.3
        p[6] = 0;
        p[7] = 0;
        new TextEncoder().encodeInto("SIMSN00000000001", p.subarray(9, 25));
        new TextEncoder().encodeInto(o.bootloader ? "Boot_1.0.0.0" : "APP_1.2.34", p.subarray(26, 38));
        new TextEncoder().encodeInto("Oct 14 2026", p.subarray(43, 54));
        this.#emit(CMD.sync | 0x80, p);
        return;
      }
      case CMD.order: {
        const type = d[0];
        const reply = new Uint8Array(40);
        reply[1] = type;
        switch (type) {
          case ORDER.protocolVersion:
            reply[2] = 0x12;
            reply[3] = 0x01;
            break;
          case ORDER.keyboardName:
            new TextEncoder().encodeInto(o.name ?? o.productName, reply.subarray(2, 34));
            break;
          case ORDER.precisionStroke:
            if (!o.hallEffect) return this.#fail();
            reply[2] = o.stepUm;
            reply[3] = o.minUm & 0xff;
            reply[4] = o.minUm >> 8;
            reply[5] = o.maxUm & 0xff;
            reply[6] = o.maxUm >> 8;
            break;
          case ORDER.queryWin:
            reply[2] = this.winMode === null ? 255 : this.winMode ? 1 : 0;
            break;
          case ORDER.queryMac:
            reply[2] = this.winMode === null ? 255 : this.winMode ? 0 : 1;
            break;
          case ORDER.setWin:
          case ORDER.setMac:
            if (this.winMode === null) return this.#fail();
            this.winMode = type === ORDER.setWin;
            this.writes.push([cmd, type]);
            reply[2] = 1;
            reply[3] = 0xff;
            break;
          case ORDER.rateOfReturn:
            reply[2] = 3;
            break;
          case ORDER.config:
            reply[2] = 0;
            break;
          default:
            // Orders SYNQ reads that this board doesn't implement: no answer.
            return;
        }
        this.#emit(cmd | 0x80, reply.subarray(0, type === ORDER.keyboardName ? 36 : 8));
        return;
      }
      case CMD.defKey: {
        const reply = new Uint8Array(46);
        reply[0] = 0;
        reply[1] = d[1];
        reply[23] = d[2];
        for (const k of this.keys) {
          if (k.row === d[1]) reply[2 + k.col] = k.key;
          if (k.row === d[2]) reply[24 + k.col] = k.key;
        }
        this.#emit(cmd | 0x80, reply);
        return;
      }
      case CMD.db: {
        const reply = new Uint8Array(15);
        if (d[0] === 1) {
          this.globalUm = d[3] | (d[4] << 8);
          this.writes.push([cmd, this.globalUm, d[5] | (d[6] << 8), d[7] | (d[8] << 8)]);
        }
        reply[0] = d[0];
        reply[3] = this.globalUm & 0xff;
        reply[4] = this.globalUm >> 8;
        // Dead zones are not reported by the global message on this board.
        this.#emit(cmd | 0x80, reply);
        return;
      }
      case CMD.key: {
        const write = d[0] === 1;
        const out: number[] = [d[0]];
        for (let at = 1; at + 3 < d.length; at += 4) {
          const [key, layout] = [d[at], d[at + 1]];
          const value = d[at + 2] | (d[at + 3] << 8);
          const m = this.mem.get(key);
          if (!m || !o.hallEffect) {
            out.push(key, 0xff, 0xff, 0xff);
            continue;
          }
          const field = layout === LAYOUT.mode ? "mode" : layout === LAYOUT.db0 ? "db0" : layout === LAYOUT.rtp ? "rtp" : layout === LAYOUT.rtr ? "rtr" : layout === LAYOUT.dp ? "dp" : layout === LAYOUT.dr ? "dr" : null;
          if (!field) {
            out.push(key, 0xff, 0xff, 0xff);
            continue;
          }
          if (write) {
            if ((m.mode & 15) !== 0 && field === "mode") this.violations.push(`mode write to advanced key ${key}`);
            m[field] = value;
            this.writes.push([cmd, key, layout, value]);
          }
          out.push(key, layout, m[field] & 0xff, m[field] >> 8);
        }
        this.#emit(cmd | 0x80, out);
        return;
      }
    }
  }
}

export { TOUCH };
