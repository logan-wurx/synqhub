// A simulated board of the 0x19F5 firmware family, for the browser preview (src/lib/kb/mock.ts) and the tests
// (scripts/fw19f5-session.sim.mjs). It speaks the protocol the way FCC's documentation and svumo's capture describe it:
// 64-byte reports with no report id, [0x55, cmd, 0, checksum, len, offset, flag, data] in, [0xAA, ...] out, memory areas
// behind them, four profiles. It checks every request (envelope, checksum), refuses the areas SYNQ never writes
// (a thrown error and a note in `violations`), and notes writes to a profile other than the active one.
// Nothing here talks to a device.
import { AREA, BLOCK, FRAME_LEN, FUNC, checksum, parseRequest } from "./protocol.ts";

/** Write areas -> the area they change. */
const READ_OF: Readonly<Record<number, number>> = { 6: 5, 9: 8, 11: 10, 13: 12, 161: 160, 165: 164, 167: 166 };
/** Areas no SYNQ code may ever send. */
const NEVER: ReadonlySet<number> = new Set([AREA.keysSet, AREA.colorsSet, AREA.macrosSet, AREA.modTapSet, AREA.toggleSet, AREA.factoryReset]);

export interface SimFw19f5Options {
  vendorId: number;
  productId: number;
  productName: string;
  /** Raw units per mm of the key records to fill (omit: no key records, as on a NuPhy). */
  step?: number;
  /** The key slots that hold a live record. */
  layoutSlots?: readonly number[];
  /** False: the board never answers (a masked NuPhy). */
  answer?: boolean;
  /** The active profile (0..3). */
  profile?: number;
  /** Add one key in an advanced mode and one with fine precision and dead zones (to check they survive). */
  oddKeys?: boolean;
  /** Reply delay, ms (the preview uses a few to look alive). */
  latencyMs?: number;
}

type Listener = (e: { reportId: number; data: DataView }) => void;

export class SimFw19f5Board {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections = [
    { usagePage: 1, usage: 6 },
    { usagePage: 1, usage: 0 },
  ];
  opened = false;
  /** Every frame the board received, in order. */
  readonly sent: Uint8Array[] = [];
  /** Things that must never happen (a forbidden area, a malformed frame, a write to another profile). */
  readonly violations: string[] = [];
  /** Every write the board took. */
  readonly writes: { cmd: number; offset: number; len: number; flag: number }[] = [];
  readonly area: Record<number, Uint8Array>;
  readonly profile: number;
  answer: boolean;
  readonly #listeners = new Set<Listener>();
  readonly #latency: number;

  constructor(o: SimFw19f5Options) {
    this.vendorId = o.vendorId;
    this.productId = o.productId;
    this.productName = o.productName;
    this.answer = o.answer ?? true;
    this.profile = o.profile ?? 0;
    this.#latency = o.latencyMs ?? 1;
    const mem = (n: number) => new Uint8Array(n);
    this.area = { 3: mem(64), 4: mem(64), 5: mem(BLOCK.func * 4), 160: mem(BLOCK.trigger * 4) };
    this.area[3].set([0x20, 0x01]);
    this.area[4].set([this.profile, 4, 0, 1, 2, 3]);
    for (let p = 0; p < 4; p++) {
      const f = this.area[5].subarray(BLOCK.func * p, BLOCK.func * p + BLOCK.func);
      f[1] = 0x02; // OS mode: untouched by SYNQ
      f[4] = 0x35; // polling / tick: untouched
      f[FUNC.winLock] = 0x01;
      f[FUNC.flags] = 0x44;
      f[FUNC.effect] = 3;
      f[FUNC.brightness] = 80;
      f[FUNC.speed] = 2;
      f[FUNC.red] = 255;
      f[FUNC.blue] = 128;
      f[FUNC.sleep] = 4;
      f[40] = 0x7e; // a byte nobody documents: must survive every write
    }
    const slots = o.layoutSlots ?? [];
    if (o.step !== undefined) {
      for (let p = 0; p < 4; p++) {
        for (const slot of slots) {
          const r = this.area[160].subarray(BLOCK.trigger * p + slot * 8, BLOCK.trigger * p + slot * 8 + 8);
          const act = Math.round(1.5 * o.step) - 1;
          r.set([0xa0, 0x10, act & 0xff, (act >> 8) & 1, 28, 0, 28, 0]);
        }
      }
      if (o.oddKeys && slots.length > 4) {
        this.area[160].subarray(BLOCK.trigger * this.profile + slots[3] * 8, BLOCK.trigger * this.profile + slots[3] * 8 + 8).set([0xa3, 0x03, 0x4a, 0, 0x0a, 0, 0x0a, 0]);
        this.area[160].subarray(BLOCK.trigger * this.profile + slots[4] * 8, BLOCK.trigger * this.profile + slots[4] * 8 + 8).set([0xa0, 0x11, 0x4a, (1 << 3) | (2 << 1), 0x0a, 5 << 1, 0x0a, 9 << 1]);
      }
    }
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

  #emit(bytes: ArrayLike<number>): void {
    const f = new Uint8Array(FRAME_LEN);
    f.set(Array.from(bytes).slice(0, FRAME_LEN));
    for (const l of this.#listeners) setTimeout(() => l({ reportId: 0, data: new DataView(f.buffer) }), this.#latency);
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    if (reportId !== 0) throw new Error(`report id ${reportId}`);
    const f = Uint8Array.from(new Uint8Array(data as ArrayBuffer));
    if (f.length !== FRAME_LEN) throw new Error(`length ${f.length}`);
    this.sent.push(f);
    const r = parseRequest(f);
    if (!r) {
      this.violations.push(`malformed ${f.subarray(0, 8)}`);
      throw new Error("MALFORMED FRAME REACHED THE BOARD");
    }
    if (NEVER.has(r.cmd)) {
      this.violations.push(`never ${f.subarray(0, 8)}`);
      throw new Error(`BLOCKED FRAME REACHED THE BOARD: area ${r.cmd}`);
    }
    if (!this.answer) return;
    const write = r.cmd in READ_OF;
    const area = this.area[write ? READ_OF[r.cmd] : r.cmd];
    if (!area) {
      this.violations.push(`unknown area ${r.cmd}`);
      return;
    }
    if (write) {
      const profileOf = Math.floor(r.offset / (r.cmd === AREA.funcSet ? BLOCK.func : BLOCK.trigger));
      if (profileOf !== this.profile) this.violations.push(`write to profile ${profileOf}`);
      area.set(r.data, r.offset);
      this.writes.push({ cmd: r.cmd, offset: r.offset, len: r.len, flag: r.flag });
    }
    const reply = new Uint8Array(FRAME_LEN);
    reply.set([0xaa, r.cmd, 0, 0, r.len, r.offset & 0xff, r.offset >> 8, r.flag]);
    if (!write) reply.set(area.subarray(r.offset, r.offset + r.len), 8);
    reply[3] = checksum(reply);
    this.#emit(reply);
  }
}
