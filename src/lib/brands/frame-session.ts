// One request/answer channel on a HidLike: every frame is checked by the brand guard, then sent as an
// output report, then the session waits for the device's answer (echo or reply) before the next frame.
// Frames are serialised; a blocked frame never reaches sendReport. Brand sessions build on this.
import { BlockedFrameError, type FrameVerdict, type HidInputEvent, type HidLike } from "./types.ts";

export interface FrameSessionOptions {
  device: HidLike;
  /** Output report id (0 = none). */
  reportId: number;
  /** Exact output payload length. */
  length: number;
  /** The brand allowlist. "blocked" throws BlockedFrameError before anything is sent. */
  guard: (frame: Uint8Array) => FrameVerdict;
  /** Is `received` the answer to `sent`? */
  isAnswer: (sent: Uint8Array, received: Uint8Array) => boolean;
  /** Device-side refusal (ASUS answers FF AA); the request rejects with the reply attached. */
  isRejected?: (sent: Uint8Array, received: Uint8Array) => boolean;
  /** Input report id the answers arrive on (default: `reportId`). */
  inputReportId?: number;
  timeoutMs?: number;
  /** Per-frame timeout (a flash save is slower than a setting write). */
  timeoutFor?: (frame: Uint8Array) => number | undefined;
  /** Write frames are refused unless this returns true (the experimental-tier "Allow changes" switch). */
  allowWrites?: () => boolean;
  log?: (dir: "out" | "in", bytes: Uint8Array, note?: string) => void;
}

export class DeviceRejectedError extends Error {
  readonly reply: Uint8Array;
  constructor(what: string, reply: Uint8Array) {
    super(`The device refused ${what}.`);
    this.name = "DeviceRejectedError";
    this.reply = reply;
  }
}

export class AnswerTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`No answer to ${what} within ${ms} ms.`);
    this.name = "AnswerTimeoutError";
  }
}

interface Waiter {
  sent: Uint8Array;
  what: string;
  resolve: (r: Uint8Array) => void;
  reject: (e: Error) => void;
}

export class FrameSession {
  private readonly o: FrameSessionOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private waiter: Waiter | null = null;
  private readonly onInput = (e: HidInputEvent) => this.input(e);
  private attached = false;
  /** Unsolicited input reports (events) on the answer report id, newest last. */
  readonly unsolicited: Uint8Array[] = [];

  constructor(options: FrameSessionOptions) {
    this.o = options;
  }

  get device(): HidLike {
    return this.o.device;
  }

  async open(): Promise<void> {
    if (!this.o.device.opened) await this.o.device.open();
    if (!this.attached) {
      this.o.device.addEventListener("inputreport", this.onInput);
      this.attached = true;
    }
  }

  async close(): Promise<void> {
    if (this.attached) {
      this.o.device.removeEventListener("inputreport", this.onInput);
      this.attached = false;
    }
    this.waiter?.reject(new Error("session closed"));
    this.waiter = null;
    if (this.o.device.opened) await this.o.device.close();
  }

  /** What the guard says about a frame, without sending it. */
  check(frame: Uint8Array): FrameVerdict {
    if (frame.length !== this.o.length) return { verdict: "blocked", what: "bad length", why: "unknown", reason: `frames are ${this.o.length} bytes (got ${frame.length})` };
    return this.o.guard(frame);
  }

  /** Sends one frame and resolves with the device's answer. Serialised with every other request. */
  request(frame: Uint8Array): Promise<Uint8Array> {
    const run = () => this.send(frame);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Sends frames in order, stopping at the first failure. */
  async requestAll(frames: readonly Uint8Array[]): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    for (const f of frames) out.push(await this.request(f));
    return out;
  }

  private async send(frame: Uint8Array): Promise<Uint8Array> {
    const verdict = this.check(frame);
    if (verdict.verdict === "blocked") throw new BlockedFrameError(verdict, frame);
    if (verdict.verdict === "write" && this.o.allowWrites && !this.o.allowWrites())
      throw new BlockedFrameError({ ...verdict, verdict: "blocked", reason: "writes are switched off for this device" }, frame);
    await this.open();
    const sent = new Uint8Array(frame);
    const ms = this.o.timeoutFor?.(sent) ?? this.o.timeoutMs ?? 1000;
    const answer = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.sent === sent) this.waiter = null;
        reject(new AnswerTimeoutError(verdict.what, ms));
      }, ms);
      this.waiter = {
        sent,
        what: verdict.what,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
    this.o.log?.("out", sent, verdict.what);
    try {
      await this.o.device.sendReport(this.o.reportId, sent);
    } catch (e) {
      this.waiter?.reject(e instanceof Error ? e : new Error(String(e)));
      this.waiter = null;
    }
    return answer;
  }

  private input(e: HidInputEvent): void {
    if (e.reportId !== (this.o.inputReportId ?? this.o.reportId)) return;
    const r = new Uint8Array(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength));
    this.o.log?.("in", r);
    const w = this.waiter;
    if (w && this.o.isRejected?.(w.sent, r)) {
      this.waiter = null;
      w.reject(new DeviceRejectedError(w.what, r));
      return;
    }
    if (w && this.o.isAnswer(w.sent, r)) {
      this.waiter = null;
      w.resolve(r);
      return;
    }
    this.unsolicited.push(r);
    if (this.unsolicited.length > 64) this.unsolicited.shift();
  }
}
