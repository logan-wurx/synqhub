// The website's gate for Govee frames: what the desktop bridge's `send` and `upload` do before a frame reaches the
// radio (src-tauri/src/lighting/govee/mod.rs), with the same allowlist. guard.rs is the bridge's copy of `checkLightFrame`
// and `checkLightUpload` (src/lib/lighting/govee/frames.ts); the website uses those very functions, and
// scripts/web-govee.test.ts sends every line of guard.rs's fixture (frames.txt) through this gate: a frame the bridge
// refuses never reaches the website's session either. Single frames are judged against the lamp's model; an upload
// is judged as a whole and framed here (a loose `A3` frame is always refused); the handshake is the session's own and
// never comes through here. Pure: the writer is handed in.
import { UPLOAD, a3Frames, checkLightFrame, checkLightUpload, type UploadKind } from "../govee/frames.ts";
import { specOf, type GoveeSpec } from "../govee/spec.ts";

/** Name prefixes Govee lamps advertise with (src-tauri/src/lighting/govee/ble.rs `PREFIXES`). */
export const PREFIXES = ["Govee_", "ihoment_", "GBK_", "GVH_"] as const;

/** The SKU in an advertised name: `Govee_H6076_7A21` -> `H6076` (mod.rs `sku_of`). */
export const skuOf = (name: string) => name.split("_").find((p) => p.length >= 4 && p.startsWith("H") && /^[0-9A-Za-z]+$/.test(p.slice(1))) ?? "";

/** The model SYNQ drives under this advertised name, or null: another Govee device (a thermometer, a model not in the
 * table) is never opened (mod.rs `supported`). */
export const modelOf = (name: string): GoveeSpec | null => (PREFIXES.some((p) => name.startsWith(p)) ? specOf(skuOf(name)) : null);

export interface GatePace {
  /** Room between two frames of one send, and between the frames of an upload (the app paces scene uploads at 100 ms). */
  gapMs: number;
  uploadGapMs: number;
  /** How long an upload waits for the lamp's acknowledgement. */
  ackMs: number;
}

/** The bridge's pace (mod.rs `GAP`, `UPLOAD_GAP` and the upload's 1.5 s wait). */
export const BRIDGE_PACE: GatePace = { gapMs: 25, uploadGapMs: 100, ackMs: 1500 };

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export class GoveeGate {
  readonly spec: GoveeSpec;
  readonly #write: (plain: Uint8Array) => Promise<void>;
  readonly #pace: GatePace;
  #ack: ((f: Uint8Array) => void) | null = null;

  /** `write` seals and writes one checked plaintext frame. */
  constructor(spec: GoveeSpec, write: (plain: Uint8Array) => Promise<void>, pace: GatePace = BRIDGE_PACE) {
    this.spec = spec;
    this.#write = write;
    this.#pace = pace;
  }

  /** Single frames, a little apart. Every one is checked before any is written: a batch with a refused frame sends
   * nothing (the bridge stops at the refused one; this is stricter, never looser). */
  async send(frames: readonly Uint8Array[]): Promise<void> {
    // Copies: the bytes checked are the bytes written, whatever the caller does with its arrays meanwhile.
    const checked = frames.map((f) => f.slice());
    for (const f of checked) {
      const v = checkLightFrame(this.spec, f);
      if (!v.ok) throw new Error(v.why);
    }
    for (let i = 0; i < checked.length; i++) {
      if (i > 0) await sleep(this.#pace.gapMs);
      await this.#write(checked[i]);
    }
  }

  /** A checked upload, framed here and paced like the app; true when the lamp acknowledged it.
   * `code`: the scene the data is for (a scene upload must be that scene's own data). */
  async upload(kind: UploadKind, data: Uint8Array, code?: number): Promise<boolean> {
    const body = data.slice();
    const v = checkLightUpload(this.spec, kind, body, code);
    if (!v.ok) throw new Error(v.why);
    const type = UPLOAD[kind];
    // The acknowledgement: a3 <type> <result>, result 0 = taken. One that comes while the frames still go is kept.
    const results: number[] = [];
    let wake: (() => void) | null = null;
    this.#ack = (f) => {
      if (f[1] !== type) return;
      results.push(f[2]);
      wake?.();
    };
    try {
      for (const f of a3Frames(type, body)) {
        await this.#write(f);
        await sleep(this.#pace.uploadGapMs);
      }
      if (!results.length)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.#pace.ackMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
    } finally {
      this.#ack = null;
    }
    if (!results.length) return false;
    if (results[0] !== 0) throw new Error(`The lamp refused the data (code ${results[0]}).`);
    return true;
  }

  /** A frame the lamp sent: an upload's acknowledgement goes to the upload waiting for it. */
  heard(f: Uint8Array) {
    if (f[0] === 0xa3) this.#ack?.(f);
  }
}
