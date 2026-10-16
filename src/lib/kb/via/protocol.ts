// The VIA and Vial commands SYNQ uses, on top of ViaTransport (every frame is guarded there).
// VIA command ids and layouts are from QMK's quantum/via.h; Vial's from vial-qmk quantum/vial.c
// (its replies overwrite the frame from byte 0 instead of echoing the command). Pure codec + calls.
import { CHANNEL, MACRO_CHUNK, VIA, VIA_VALUE, VIAL } from "./guard.ts";
import type { ViaTransport } from "./transport.ts";
import { xzDecompress } from "./xz.ts";

/** Bytes of keymap per bulk read (32-byte frame minus the 4-byte header). */
const BUFFER_CHUNK = 28;
/** Largest Vial definition SYNQ will read (a big board's is a few kB). */
const VIAL_MAX_DEFINITION = 64 * 1024;

export type LightingScheme = "channel" | "legacy";

export class ViaClient {
  readonly #t: ViaTransport;
  constructor(t: ViaTransport) {
    this.#t = t;
  }

  /** VIA protocol version (QMK's VIA_PROTOCOL_VERSION), or null when the board doesn't speak VIA. */
  async protocolVersion(): Promise<number | null> {
    const r = await this.#t.request([VIA.getProtocolVersion]);
    if (r[0] !== VIA.getProtocolVersion) return null;
    return (r[1] << 8) | r[2];
  }

  async #keyboardValue(id: number): Promise<number | null> {
    const r = await this.#t.request([VIA.getKeyboardValue, id]);
    if (r[0] !== VIA.getKeyboardValue || r[1] !== id) return null;
    return ((r[2] << 24) | (r[3] << 16) | (r[4] << 8) | r[5]) >>> 0;
  }

  /** The packed layout options (split backspace, ISO enter...). */
  layoutOptions(): Promise<number | null> {
    return this.#keyboardValue(VIA_VALUE.layoutOptions);
  }

  /** The firmware's VIA_FIRMWARE_VERSION (0 on most boards). */
  firmwareVersion(): Promise<number | null> {
    return this.#keyboardValue(VIA_VALUE.firmwareVersion);
  }

  async layerCount(): Promise<number> {
    const r = await this.#t.request([VIA.getLayerCount]);
    if (r[0] !== VIA.getLayerCount) throw new Error("The keyboard doesn't report its layers.");
    return r[1];
  }

  /** The whole dynamic keymap: codes[layer][row * cols + col]. */
  async readKeymap(layers: number, rows: number, cols: number): Promise<number[][]> {
    const total = layers * rows * cols * 2;
    const bytes = new Uint8Array(total);
    for (let off = 0; off < total; off += BUFFER_CHUNK) {
      const size = Math.min(BUFFER_CHUNK, total - off);
      const r = await this.#t.request([VIA.keymapGetBuffer, off >> 8, off & 0xff, size]);
      if (r[0] !== VIA.keymapGetBuffer || ((r[1] << 8) | r[2]) !== off) throw new Error("The keyboard sent a keymap page out of order.");
      bytes.set(r.subarray(4, 4 + size), off);
    }
    const out: number[][] = [];
    for (let l = 0; l < layers; l++) {
      const layer: number[] = [];
      for (let i = 0; i < rows * cols; i++) {
        const at = (l * rows * cols + i) * 2;
        layer.push((bytes[at] << 8) | bytes[at + 1]);
      }
      out.push(layer);
    }
    return out;
  }

  async getKeycode(layer: number, row: number, col: number): Promise<number> {
    const r = await this.#t.request([VIA.getKeycode, layer, row, col]);
    if (r[0] !== VIA.getKeycode || r[1] !== layer || r[2] !== row || r[3] !== col) throw new Error("The keyboard didn't report that key.");
    return (r[4] << 8) | r[5];
  }

  async setKeycode(layer: number, row: number, col: number, code: number): Promise<void> {
    const r = await this.#t.request([VIA.setKeycode, layer, row, col, code >> 8, code & 0xff]);
    if (r[0] !== VIA.setKeycode) throw new Error("The keyboard didn't take the key change.");
  }

  /** A lighting value: `channel` is the VIA v3 channel (1-3) or null for the legacy ids. */
  async getLighting(scheme: LightingScheme, channel: number, valueId: number, bytes: number): Promise<number[] | null> {
    const req = scheme === "channel" ? [VIA.customGetValue, channel, valueId] : [VIA.customGetValue, valueId];
    const r = await this.#t.request(req);
    if (r[0] !== VIA.customGetValue) return null;
    const at = req.length;
    return Array.from(r.subarray(at, at + bytes));
  }

  async setLighting(scheme: LightingScheme, channel: number, valueId: number, data: readonly number[]): Promise<void> {
    const req = scheme === "channel" ? [VIA.customSetValue, channel, valueId, ...data] : [VIA.customSetValue, valueId, ...data];
    const r = await this.#t.request(req);
    if (r[0] !== VIA.customSetValue) throw new Error("The keyboard didn't take the lighting change.");
  }

  /** Writes the lighting channel to the keyboard's EEPROM, so it survives unplugging. */
  async saveLighting(scheme: LightingScheme, channel: number): Promise<void> {
    await this.#t.request(scheme === "channel" ? [VIA.customSave, channel] : [VIA.customSave]);
  }

  async macroCount(): Promise<number> {
    const r = await this.#t.request([VIA.macroGetCount]);
    return r[0] === VIA.macroGetCount ? r[1] : 0;
  }

  async macroBufferSize(): Promise<number> {
    const r = await this.#t.request([VIA.macroGetBufferSize]);
    return r[0] === VIA.macroGetBufferSize ? (r[1] << 8) | r[2] : 0;
  }

  async readMacroBuffer(size: number): Promise<Uint8Array> {
    const out = new Uint8Array(size);
    for (let off = 0; off < size; off += BUFFER_CHUNK) {
      const n = Math.min(BUFFER_CHUNK, size - off);
      const r = await this.#t.request([VIA.macroGetBuffer, off >> 8, off & 0xff, n]);
      if (r[0] !== VIA.macroGetBuffer) throw new Error("The keyboard didn't send its macros.");
      out.set(r.subarray(4, 4 + n), off);
    }
    return out;
  }

  /**
   * Writes `data` into the macro buffer at `offset`, one frame at a time. Advanced only: the guard refuses
   * it without a live "macros" token (src/lib/kb/via/guard.ts).
   */
  async writeMacroBuffer(offset: number, data: ArrayLike<number>): Promise<void> {
    for (let at = 0; at < data.length; at += MACRO_CHUNK) {
      const n = Math.min(MACRO_CHUNK, data.length - at);
      const o = offset + at;
      const r = await this.#t.request([VIA.macroSetBuffer, o >> 8, o & 0xff, n, ...Array.from({ length: n }, (_, i) => data[at + i])]);
      if (r[0] !== VIA.macroSetBuffer) throw new Error("The keyboard didn't take the macro change.");
    }
  }

  /** Back to the keymap the firmware was built with (dynamic keymap reset). Advanced only: needs a live "reset" token. */
  async resetKeymap(): Promise<void> {
    const r = await this.#t.request([VIA.keymapReset]);
    if (r[0] !== VIA.keymapReset) throw new Error("The keyboard didn't reset its keymap.");
  }

  /** Erases every macro. Advanced only: needs a live "reset" token. */
  async resetMacros(): Promise<void> {
    const r = await this.#t.request([VIA.macroReset]);
    if (r[0] !== VIA.macroReset) throw new Error("The keyboard didn't erase its macros.");
  }

  /** Vial's id and protocol, or null when the board isn't a Vial board (it echoes the frame back). */
  async vialId(): Promise<{ protocol: number; uid: string } | null> {
    const r = await this.#t.request([VIA.vialPrefix, VIAL.getKeyboardId], "next");
    if (r[0] === VIA.vialPrefix && r[1] === VIAL.getKeyboardId) return null;
    if (r[0] === VIA.unhandled) return null;
    const protocol = (r[0] | (r[1] << 8) | (r[2] << 16) | (r[3] << 24)) >>> 0;
    if (protocol === 0 || protocol > 1000) return null;
    const uid = Array.from(r.subarray(4, 12), (b) => b.toString(16).padStart(2, "0")).join("");
    return { protocol, uid };
  }

  /** The keyboard definition a Vial board keeps (xz-compressed JSON), decoded. */
  async vialDefinition(): Promise<unknown> {
    const s = await this.#t.request([VIA.vialPrefix, VIAL.getSize], "next");
    const size = (s[0] | (s[1] << 8) | (s[2] << 16) | (s[3] << 24)) >>> 0;
    if (!size || size > VIAL_MAX_DEFINITION) throw new Error(`The Vial definition size looks wrong (${size} bytes).`);
    const page = this.#t.size;
    const bytes = new Uint8Array(size);
    for (let p = 0; p * page < size; p++) {
      const r = await this.#t.request([VIA.vialPrefix, VIAL.getDefinition, p & 0xff, (p >> 8) & 0xff], "next");
      bytes.set(r.subarray(0, Math.min(page, size - p * page)), p * page);
    }
    return JSON.parse(new TextDecoder().decode(xzDecompress(bytes)));
  }

  /** Vial's lock state (read-only; SYNQ never unlocks or locks). */
  async vialUnlocked(): Promise<boolean | null> {
    const r = await this.#t.request([VIA.vialPrefix, VIAL.getUnlockStatus], "next");
    return r[0] === 0 || r[0] === 1 ? r[0] === 1 : null;
  }
}

export { CHANNEL };
