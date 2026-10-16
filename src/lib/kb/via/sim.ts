// A simulated VIA (or Vial) keyboard: a stand-in HIDDevice that answers like QMK's quantum/via.c
// and vial-qmk's quantum/vial.c, for the browser preview and the tests. It records every frame it
// receives, and separately every command SYNQ must never send (bootloader jump, EEPROM reset,
// bulk keymap write, the switch-matrix read, Vial unlock, a bootloader keycode...), so a test can prove
// none arrived. Commands only an Advanced action may send (keymap reset, macro writes and reset, keycodes
// above the basic range) land in `forbidden` too, unless the test says an Advanced token is live
// (`allowAdvanced`), when they land in `advancedFrames` instead. Nothing here touches hardware.
import { parseKle } from "./layout.ts";
import { VIAL_SAMPLE_XZ_HEX } from "./sim-vial.generated.ts";

// ---------------------------------------------------------------------------------------------
// The sample board: a 65% ANSI, 5 x 15 matrix, one layout option (split backspace).
// [row, col, x, width, keycode, option?]
// ---------------------------------------------------------------------------------------------
type K = [number, number, number, number, number, string?];
const K = (row: number, col: number, x: number, w: number, code: number, opt?: string): K => [row, col, x, w, code, opt];
const seq = (row: number, col0: number, x0: number, codes: number[]) => codes.map((c, i) => K(row, col0 + i, x0 + i, 1, c));
const MO1 = 0x5221;

const SAMPLE: K[][] = [
  [K(0, 0, 0, 1, 0x29), ...seq(0, 1, 1, [0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2d, 0x2e]), K(0, 13, 13, 2, 0x2a, "0,0"), K(0, 13, 13, 1, 0x2a, "0,1"), K(4, 4, 14, 1, 0x35, "0,1"), K(0, 14, 15, 1, 0x4a)],
  [K(1, 0, 0, 1.5, 0x2b), ...seq(1, 1, 1.5, [0x14, 0x1a, 0x08, 0x15, 0x17, 0x1c, 0x18, 0x0c, 0x12, 0x13, 0x2f, 0x30]), K(1, 13, 13.5, 1.5, 0x31), K(1, 14, 15, 1, 0x4c)],
  [K(2, 0, 0, 1.75, 0x39), ...seq(2, 1, 1.75, [0x04, 0x16, 0x07, 0x09, 0x0a, 0x0b, 0x0d, 0x0e, 0x0f, 0x33, 0x34]), K(2, 13, 12.75, 2.25, 0x28), K(2, 14, 15, 1, 0x4b)],
  [K(3, 0, 0, 2.25, 0xe1), ...seq(3, 1, 2.25, [0x1d, 0x1b, 0x06, 0x19, 0x05, 0x11, 0x10, 0x36, 0x37, 0x38]), K(3, 11, 12.25, 1.75, 0xe5), K(3, 13, 14, 1, 0x52), K(3, 14, 15, 1, 0x4e)],
  [K(4, 0, 0, 1.25, 0xe0), K(4, 1, 1.25, 1.25, 0xe3), K(4, 2, 2.5, 1.25, 0xe2), K(4, 6, 3.75, 6.25, 0x2c), K(4, 9, 10, 1, 0xe6), K(4, 10, 11, 1, MO1), K(4, 11, 12, 1, 0xe4), K(4, 12, 13, 1, 0x50), K(4, 13, 14, 1, 0x51), K(4, 14, 15, 1, 0x4f)],
];

/** The sample board's KLE rows (Vial's `layouts.keymap` form). Option-1 keys sit where VIA puts them: to the right. */
export function sampleKle(): unknown[] {
  return SAMPLE.map((row) => {
    const out: unknown[] = [];
    let x = 0;
    for (const [r, c, kx, w, , opt] of row) {
      const shown = opt === "0,1" ? kx + 4 : kx; // alternatives drawn off to the side, as VIA's files do
      const props: Record<string, number> = {};
      if (shown !== x) props.x = shown - x;
      if (w !== 1) props.w = w;
      if (Object.keys(props).length) out.push(props);
      out.push(`${r},${c}${opt ? `\n\n\n${opt}` : ""}`);
      x = shown + w;
    }
    return out;
  });
}

export const SAMPLE_ROWS = 5;
export const SAMPLE_COLS = 15;

/** The sample board as VIA's compiled definition (usevia.app/definitions/v3/<id>.json form). */
export function sampleCompiledDefinition(vendorId: number, productId: number, name = "SYNQ Sample 65"): unknown {
  const { keys, optionKeys } = parseKle(sampleKle());
  return {
    name,
    vendorProductId: vendorId * 0x10000 + productId,
    firmwareVersion: 0,
    menus: ["qmk_rgb_matrix"],
    keycodes: ["qmk_lighting"],
    matrix: { rows: SAMPLE_ROWS, cols: SAMPLE_COLS },
    layouts: { width: 16, height: 5, labels: ["Split Backspace"], keys, optionKeys },
  };
}

/** The sample board's Vial definition, exactly the JSON compressed into sim-vial.generated.ts. */
export function sampleVialJson(): string {
  return JSON.stringify({
    name: "SYNQ Sample 65 (Vial)",
    vendorId: "0x4f42",
    productId: "0x5667",
    lighting: "qmk_rgblight",
    matrix: { rows: SAMPLE_ROWS, cols: SAMPLE_COLS },
    layouts: { labels: ["Split Backspace"], keymap: sampleKle() },
  });
}

function sampleKeymap(layers: number): number[][] {
  const base = new Array(SAMPLE_ROWS * SAMPLE_COLS).fill(0);
  for (const row of SAMPLE) for (const [r, c, , , code] of row) base[r * SAMPLE_COLS + c] = code;
  const fn = new Array(SAMPLE_ROWS * SAMPLE_COLS).fill(0x01);
  [0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45].forEach((f, i) => (fn[1 + i] = f));
  fn[0] = 0x35;
  fn[13] = 0x4c;
  fn[14] = 0x7c00; // QK_BOOT on Fn+Home, as many stock VIA keymaps have: shown, never written
  fn[2 * SAMPLE_COLS + 1] = 0xa9;
  fn[2 * SAMPLE_COLS + 2] = 0xaa;
  fn[2 * SAMPLE_COLS + 3] = 0xa8;
  return Array.from({ length: layers }, (_, l) => (l === 0 ? base.slice() : l === 1 ? fn.slice() : new Array(base.length).fill(0x01)));
}

const hexBytes = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

// ---------------------------------------------------------------------------------------------
// The simulated device
// ---------------------------------------------------------------------------------------------

export interface SimOptions {
  vendorId: number;
  productId: number;
  productName: string;
  /** VIA protocol version (12 = current QMK). Vial boards report 9. */
  protocol?: number;
  /** Make it a Vial board (protocol 6) holding the sample definition. */
  vial?: boolean;
  layers?: number;
  layoutOptions?: number;
  firmware?: number;
  /** Reply delay, ms. */
  delayMs?: number;
  /** Macro memory in bytes (default 64) and how many macros it holds (default 4). */
  macroBytes?: number;
  macroCount?: number;
}

/** Commands that must never reach a keyboard from SYNQ, whatever is granted: [first byte, second byte or -1]. */
const NEVER: [number, number][] = [
  [0x0b, -1],
  [0x0a, -1],
  [0x13, -1],
  [0x03, -1],
  [0x15, -1],
  [0x02, 0x03],
];
/** Commands only an Advanced action sends: keymap reset, macro write, macro reset. */
const UNLOCKABLE: [number, number][] = [
  [0x06, -1],
  [0x0f, -1],
  [0x10, -1],
];
/** Keycodes that jump to a bootloader, reboot, clear the EEPROM, or are board-specific: never written. */
const neverCode = (c: number) => (c >= 0x5c00 && c <= 0x5cff) || (c >= 0x7c00 && c <= 0x7cff) || c >= 0x7e00;
const VIAL_NEVER = [0x04, 0x06, 0x07, 0x08, 0x0b, 0x0c, 0x0d];

export class SimViaKeyboard {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: HIDCollectionInfo[];
  opened = false;
  oninputreport: ((e: HIDInputReportEvent) => void) | null = null;
  /** Every frame received. */
  readonly received: Uint8Array[] = [];
  /** Frames that should never have arrived. */
  readonly forbidden: Uint8Array[] = [];
  /** A test sets this while an Advanced token is live; the frames only an Advanced action sends then land in `advancedFrames`. */
  allowAdvanced = false;
  readonly advancedFrames: Uint8Array[] = [];
  readonly macroBytes: number;
  /** EEPROM writes (keycode writes and lighting saves). */
  eepromWrites = 0;
  protocol: number;
  readonly vial: boolean;
  layers: number;
  keymap: number[][];
  layoutOptions: number;
  firmware: number;
  /** Lighting values by "<channel>:<id>" (VIA v3) or "L:<id>" (legacy). */
  lighting = new Map<string, number[]>();
  macros: { count: number; buffer: number[] };
  readonly #delay: number;
  readonly #listeners = new Set<(e: HIDInputReportEvent) => void>();
  readonly #definition = hexBytes(VIAL_SAMPLE_XZ_HEX);

  constructor(o: SimOptions) {
    this.vendorId = o.vendorId;
    this.productId = o.productId;
    this.productName = o.productName;
    this.vial = o.vial === true;
    this.protocol = o.protocol ?? (this.vial ? 9 : 12);
    this.layers = o.layers ?? 4;
    this.keymap = sampleKeymap(this.layers);
    this.layoutOptions = o.layoutOptions ?? 0;
    this.firmware = o.firmware ?? 0;
    this.#delay = o.delayMs ?? 2;
    this.macroBytes = o.macroBytes ?? 64;
    this.macros = { count: o.macroCount ?? 4, buffer: [...new TextEncoder().encode("gg wp"), 0, 0x01, 0x01, 0x04, 0x01, 0x01, 0x05, 0, 0, 0] };
    const io = [{ reportId: 0, items: [{ reportSize: 8, reportCount: 32 }] }];
    this.collections = [{ usagePage: 0xff60, usage: 0x61, type: 1, children: [], inputReports: io, outputReports: io, featureReports: [] } as unknown as HIDCollectionInfo];
    if (this.vial) {
      this.lighting.set("L:128", [120]);
      this.lighting.set("L:129", [1]);
      this.lighting.set("L:130", [128]);
      this.lighting.set("L:131", [170, 255]);
    } else {
      this.lighting.set("3:1", [200]);
      this.lighting.set("3:2", [6]);
      this.lighting.set("3:3", [127]);
      this.lighting.set("3:4", [21, 255]);
    }
  }

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async forget() {
    this.opened = false;
  }
  addEventListener(type: string, l: EventListenerOrEventListenerObject) {
    if (type === "inputreport") this.#listeners.add(l as unknown as (e: HIDInputReportEvent) => void);
  }
  removeEventListener(type: string, l: EventListenerOrEventListenerObject) {
    if (type === "inputreport") this.#listeners.delete(l as unknown as (e: HIDInputReportEvent) => void);
  }
  dispatchEvent() {
    return true;
  }
  async sendFeatureReport() {
    throw new Error("QMK raw HID has no feature reports");
  }
  async receiveFeatureReport(): Promise<DataView> {
    throw new Error("QMK raw HID has no feature reports");
  }

  async sendReport(reportId: number, data: BufferSource) {
    if (!this.opened) throw new Error("The device isn't open.");
    if (reportId !== 0) throw new Error("QMK raw HID has no report ids");
    const f = new Uint8Array(32);
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    f.set(bytes.subarray(0, 32));
    this.received.push(f.slice());
    const code = (f[4] << 8) | f[5];
    const hard = NEVER.some(([a, b]) => f[0] === a && (b < 0 || f[1] === b)) || (f[0] === 0xfe && this.vial && VIAL_NEVER.includes(f[1])) || (f[0] === 0x05 && neverCode(code));
    const unlockable = UNLOCKABLE.some(([a, b]) => f[0] === a && (b < 0 || f[1] === b)) || (f[0] === 0x05 && code > 0xff);
    if (hard) this.forbidden.push(f.slice());
    else if (unlockable) (this.allowAdvanced ? this.advancedFrames : this.forbidden).push(f.slice());
    const reply = this.#handle(f);
    setTimeout(() => this.#emit(reply), this.#delay);
  }

  #emit(reply: Uint8Array) {
    const event = Object.assign(new Event("inputreport"), { device: this, reportId: 0, data: new DataView(reply.buffer) }) as unknown as HIDInputReportEvent;
    this.oninputreport?.(event);
    for (const l of [...this.#listeners]) l(event);
  }

  #handle(f: Uint8Array): Uint8Array {
    const r = f.slice();
    const unhandled = () => {
      r[0] = 0xff;
      return r;
    };
    const cells = SAMPLE_ROWS * SAMPLE_COLS;
    switch (f[0]) {
      case 0x01:
        r[1] = this.protocol >> 8;
        r[2] = this.protocol & 0xff;
        return r;
      case 0x02: {
        const v = f[1] === 0x02 ? this.layoutOptions : f[1] === 0x04 ? this.firmware : f[1] === 0x03 ? 0 : -1;
        if (v < 0) return unhandled();
        r[2] = (v >>> 24) & 0xff;
        r[3] = (v >>> 16) & 0xff;
        r[4] = (v >>> 8) & 0xff;
        r[5] = v & 0xff;
        return r;
      }
      case 0x03:
        return r;
      case 0x04: {
        const code = this.keymap[f[1]]?.[f[2] * SAMPLE_COLS + f[3]] ?? 0;
        r[4] = code >> 8;
        r[5] = code & 0xff;
        return r;
      }
      case 0x05:
        if (this.keymap[f[1]] && f[2] < SAMPLE_ROWS && f[3] < SAMPLE_COLS) {
          this.keymap[f[1]][f[2] * SAMPLE_COLS + f[3]] = (f[4] << 8) | f[5];
          this.eepromWrites++;
        }
        return r;
      case 0x06:
        this.keymap = sampleKeymap(this.layers);
        return r;
      case 0x07: {
        const key = this.#lightKey(f);
        if (!key) return unhandled();
        this.lighting.set(key.id, Array.from(f.subarray(key.at, key.at + 2)));
        return r;
      }
      case 0x08: {
        const key = this.#lightKey(f);
        if (!key) return unhandled();
        const v = this.lighting.get(key.id);
        if (!v) return unhandled();
        r.set(v, key.at);
        return r;
      }
      case 0x09:
        this.eepromWrites++;
        return r;
      case 0x0c:
        r[1] = this.macros.count;
        return r;
      case 0x0d:
        r[1] = this.macroBytes >> 8;
        r[2] = this.macroBytes & 0xff;
        return r;
      case 0x0e: {
        const off = (f[1] << 8) | f[2];
        const buf = new Uint8Array(this.macroBytes);
        buf.set(this.macros.buffer.slice(0, this.macroBytes));
        r.set(buf.subarray(off, off + f[3]), 4);
        return r;
      }
      case 0x0f: {
        // dynamic_keymap_macro_set_buffer: bounded by the macro memory, as the firmware does.
        const off = (f[1] << 8) | f[2];
        const buf = new Array<number>(this.macroBytes).fill(0);
        this.macros.buffer.slice(0, this.macroBytes).forEach((b, i) => (buf[i] = b));
        for (let i = 0; i < f[3] && off + i < this.macroBytes; i++) buf[off + i] = f[4 + i];
        this.macros.buffer = buf;
        this.eepromWrites++;
        return r;
      }
      case 0x10:
        this.macros.buffer = new Array<number>(this.macroBytes).fill(0);
        this.eepromWrites++;
        return r;
      case 0x11:
        r[1] = this.layers;
        return r;
      case 0x12: {
        const off = (f[1] << 8) | f[2];
        for (let i = 0; i < f[3]; i++) {
          const at = off + i;
          const cell = Math.floor(at / 2);
          const code = this.keymap[Math.floor(cell / cells)]?.[cell % cells] ?? 0;
          r[4 + i] = at % 2 ? code & 0xff : code >> 8;
        }
        return r;
      }
      case 0xfe:
        return this.vial ? this.#vial(f) : unhandled();
      default:
        return unhandled();
    }
  }

  /** Where a lighting value lives: VIA v3 channels on protocol 11+, legacy ids before (and on Vial). */
  #lightKey(f: Uint8Array): { id: string; at: number } | null {
    if (this.protocol >= 11 && !this.vial) return f[1] >= 1 && f[1] <= 5 ? { id: `${f[1]}:${f[2]}`, at: 3 } : null;
    return [0x09, 0x0a, 0x80, 0x81, 0x82, 0x83].includes(f[1]) ? { id: `L:${f[1]}`, at: 2 } : null;
  }

  #vial(f: Uint8Array): Uint8Array {
    const r = f.slice();
    const def = this.#definition;
    switch (f[1]) {
      case 0x00:
        r.fill(0);
        r.set([6, 0, 0, 0, 0x4f, 0x42, 0x53, 0x49, 0x4d, 0x56, 0x49, 0x41]);
        return r;
      case 0x01:
        r.fill(0);
        r.set([def.length & 0xff, (def.length >> 8) & 0xff, 0, 0]);
        return r;
      case 0x02: {
        const page = f[2] | (f[3] << 8);
        r.fill(0);
        r.set(def.subarray(page * 32, page * 32 + 32));
        return r;
      }
      case 0x05:
        r.fill(0xff);
        r[0] = 0;
        r[1] = 0;
        return r;
      default:
        return r;
    }
  }
}
