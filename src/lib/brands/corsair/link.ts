// A guarded Bragi channel: framing (1.0 / 1.5), the host session a 1.5 device asks for, property
// GET/SET, whole-file read/write, and the "host-controlled" wrap Web Hub puts around file work.
// Every frame passes BragiGuardState before FrameSession sends it.
import { FrameSession } from "../frame-session.ts";
import type { HidLike } from "../types.ts";
import * as B from "./bragi.ts";
import type { CorsairModel } from "./devices.ts";
import { BragiGuardState } from "./guard.ts";

export class BragiStatusError extends Error {
  readonly status: number;
  constructor(what: string, status: number) {
    super(`${what}: ${B.statusText(status)}`);
    this.name = "BragiStatusError";
    this.status = status;
  }
}

export interface BragiLinkOptions {
  /** Output report length from the 0xFF42 usage 1 descriptor (default 64). */
  length?: number;
  /** Device address: 0 = the USB device; 1..7 = a device behind a receiver. */
  addr?: number;
  /** Session nonce source (tests pass a fixed one). */
  nonce?: () => number[];
  timeoutMs?: number;
  log?: (dir: "out" | "in", bytes: Uint8Array, note?: string) => void;
}

const randomNonce = (): number[] => {
  const b = new Uint8Array(4);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b);
};

export class BragiLink {
  readonly model: CorsairModel;
  readonly framing: B.Framing;
  readonly length: number;
  readonly guard: BragiGuardState;
  readonly fs: FrameSession;
  addr: number;
  #session: number | null = null;
  readonly #nonce: () => number[];

  constructor(device: HidLike, model: CorsairModel, o: BragiLinkOptions = {}) {
    if (!model.framing) throw new Error(`${model.name} does not speak Bragi`);
    this.model = model;
    this.framing = model.framing;
    this.length = o.length ?? B.BRAGI_DEFAULT_LENGTH;
    this.addr = o.addr ?? 0;
    this.#nonce = o.nonce ?? randomNonce;
    this.guard = new BragiGuardState(this.framing, model.family, this.length);
    this.fs = new FrameSession({
      device,
      reportId: B.BRAGI_REPORT_ID,
      length: this.length,
      guard: (f) => this.guard.classify(f),
      isAnswer: (sent, r) => B.isReplyTo(this.framing, sent, r),
      // Web Hub: 3 s, 6 s for the MAKR 75, 10 s for the Sabre v3 family.
      timeoutMs: o.timeoutMs ?? (model.pid === 0x2b04 ? 6000 : [0x2b3f, 0x2b40, 0x2b41, 0x2b43, 0x2b44, 0x2b45].includes(model.pid) ? 10000 : 3000),
      log: o.log,
    });
  }

  get session(): number | null {
    return this.#session;
  }

  opts(addr = this.addr): B.FrameOpts {
    return { framing: this.framing, addr, session: this.#session ?? 0, length: this.length };
  }

  async #send(f: Uint8Array): Promise<Uint8Array> {
    const r = await this.fs.request(f);
    this.guard.observe(f);
    return r;
  }

  /** Starts a host session (Bragi 1.5): `AA 01 00 1B 01 n0..n3 00`, id from reply byte 9. */
  async startSession(addr = this.addr): Promise<number> {
    const nonce = this.#nonce();
    const r = await this.#send(B.encodeSessionStart(nonce, addr, this.length));
    this.#session = B.decodeSessionReply(r, nonce);
    this.guard.session = this.#session;
    return this.#session;
  }

  /** Sends one command; on a v1.5 "session needed" answer starts a session and resends once. */
  async command(build: (o: B.FrameOpts) => Uint8Array, what: string, addr = this.addr): Promise<B.Reply> {
    let r = await this.#send(build(this.opts(addr)));
    if (B.needsSession(this.framing, r)) {
      await this.startSession(addr);
      r = await this.#send(build(this.opts(addr)));
    }
    const rep = B.decodeReply(this.framing, r);
    if (rep.status !== B.STATUS.ok) throw new BragiStatusError(what, rep.status);
    return rep;
  }

  async get(prop: number, addr = this.addr): Promise<Uint8Array> {
    return (await this.command((o) => B.encodeGet(o, prop), `GET 0x${prop.toString(16)}`, addr)).data;
  }
  async getU32(prop: number, addr = this.addr): Promise<number> {
    return B.u32le(await this.get(prop, addr));
  }
  /** GET that answers null when the device says the property is unsupported. */
  async tryU32(prop: number, addr = this.addr): Promise<number | null> {
    try {
      return await this.getU32(prop, addr);
    } catch (e) {
      if (e instanceof BragiStatusError) return null;
      throw e;
    }
  }
  async set(prop: number, value: number | readonly number[], addr = this.addr): Promise<void> {
    await this.command((o) => B.encodeSet(o, prop, value), `SET 0x${prop.toString(16)}`, addr);
  }

  /** Runs `work` in operating mode 2 (host controlled) and always returns the device to mode 1. */
  async withHostControl<T>(work: () => Promise<T>, addr = this.addr): Promise<T> {
    await this.set(B.PROP.operatingMode, B.MODE.hostControlled, addr);
    try {
      return await work();
    } finally {
      await this.set(B.PROP.operatingMode, B.MODE.selfOperated, addr);
    }
  }

  /** Open, describe, read until `size` bytes, close. */
  async readFile(fileId: number): Promise<Uint8Array> {
    await this.command((o) => B.encodeOpenFile(o, fileId), `open file ${fileId}`);
    try {
      const size = B.u32le((await this.command((o) => B.encodeDescribeBuffer(o), "describe buffer")).data, 2);
      if (size > 65536) throw new Error(`file ${fileId} reports ${size} bytes`);
      const out = new Uint8Array(size);
      let at = 0;
      while (at < size) {
        const chunk = (await this.command((o) => B.encodeReadBuffer(o), "read buffer")).data;
        const n = Math.min(chunk.length, size - at);
        if (n <= 0) throw new Error("empty read");
        out.set(chunk.subarray(0, n), at);
        at += n;
      }
      return out;
    } finally {
      await this.command((o) => B.encodeUnbindBuffer(o), "close buffer");
    }
  }

  /** Open, write the whole file (06 then 07...), close. The guard only lets this reach profile sub-files. */
  async writeFile(fileId: number, data: Uint8Array): Promise<void> {
    await this.command((o) => B.encodeOpenFile(o, fileId), `open file ${fileId}`);
    try {
      for (const f of B.encodeWriteFile(this.opts(), data)) {
        const r = await this.#send(f);
        const rep = B.decodeReply(this.framing, r);
        if (rep.status !== B.STATUS.ok) throw new BragiStatusError(`write file ${fileId}`, rep.status);
      }
    } finally {
      await this.command((o) => B.encodeUnbindBuffer(o), "close buffer");
    }
  }

  close(): Promise<void> {
    return this.fs.close();
  }
}
