// A Govee lamp session for the website, the desktop bridge's src-tauri/src/lighting/govee/session.rs step for step:
// which encryption the lamp wants (PROTOCOL.md §10.3: the `2b12` marker says 2 → v2; otherwise probe `E7 01`, v1 if it
// answers; otherwise plaintext), the handshake, and every 20-byte frame sealed and opened under the session's keys.
// The handshake is the session's own: it never goes through the frame guard (the bridge's rule too). With the same
// padding and nonces, it writes and hears exactly the bridge's bytes (session-wire.txt, scripts/web-govee.test.ts).
import { FRAME_LEN, frame, xorOf } from "../govee/frames.ts";
import { K_COMM, K_HS, deviceKey, gcmOpen, gcmSeal, safe } from "./cipher.ts";

/** What a session needs from its link: write a value to `2b11`, wait for the next `2b10` notification, and the
 * version byte of the `2b12` marker when the lamp has one. */
export interface GoveeWire {
  write(bytes: Uint8Array): Promise<void>;
  /** The next notification within `ms`, or null. */
  recv(ms: number): Promise<Uint8Array | null>;
  readonly marker: number | null;
}

export type Scheme = "plain" | "v1" | "v2";
export const SCHEME_NAME: Record<Scheme, string> = { plain: "plaintext", v1: "encryption v1", v2: "encryption v2" };

type Keys = { kind: "plain" } | { kind: "v1"; key: Uint8Array } | { kind: "v2"; key: Uint8Array; hostIv: Uint8Array; devIv: Uint8Array; hostCtr: number };

/** How long a v1 lamp gets to answer `E7 01` (29 ms measured on the desktop). */
const PROBE_MS = 700;
const CONFIRM_MS = 400;
const V2_MS = 1500;

const valid = (p: Uint8Array | null): p is Uint8Array => !!p && p.length === FRAME_LEN && xorOf(p, FRAME_LEN - 1) === p[FRAME_LEN - 1];
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const counterBytes = (n: number) => Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

/** The first answer `fn` gives (not undefined) for a notification heard before `ms` runs out; undefined when none. */
async function listen<T>(wire: GoveeWire, ms: number, fn: (w: Uint8Array) => T | undefined): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (let left = ms; left >= 0; left = end - Date.now()) {
    const w = await wire.recv(left);
    const answer = w ? fn(w) : undefined;
    if (!w || answer !== undefined) return answer;
  }
}

/** 19 bytes from `random` with `head` over the start, and the checksum (the bridge draws all 19 first, as here). */
function randomFrame(head: readonly number[], random: () => number): Uint8Array {
  const bytes = Array.from({ length: FRAME_LEN - 1 }, () => random() & 0xff);
  head.forEach((b, i) => (bytes[i] = b));
  return frame(bytes);
}

/** v1: `E7 01` under K_COMM; a v1 lamp answers `E7 01` with the session key in [2..18]; then the `E7 02` confirm.
 * Null when the lamp stays silent (not a v1 lamp). */
async function v1Handshake(wire: GoveeWire, random: () => number): Promise<Uint8Array | null> {
  await wire.write(safe(K_COMM, randomFrame([0xe7, 0x01], random), false));
  const key = await listen(wire, PROBE_MS, (w) => {
    const p = safe(K_COMM, w, true);
    return valid(p) && p[0] === 0xe7 && p[1] === 0x01 ? p.slice(2, 18) : undefined;
  });
  if (!key) return null;
  // The confirm round: not load-bearing, but the app always sends it. Its answer is read and dropped.
  await wire.write(safe(K_COMM, randomFrame([0xe7, 0x02], random), false));
  await wire.recv(CONFIRM_MS);
  return key;
}

/** v2: `E7 11 01 ‖ IV(12) ‖ tagLen` + GCM(K_HS, IV, aad = those 16 bytes, client ivKey(8)); the lamp answers
 * `E7 11 status ‖ IV(12)` + GCM(K_HS, IV, aad = those 15 bytes, device ivKey(8) ‖ SKU(5) ‖ MAC(6)). The lamp names
 * its own address there, so the website needs none to derive the key. */
async function v2Handshake(wire: GoveeWire, random: () => number): Promise<{ keys: Keys; sku: string }> {
  const iv = Uint8Array.from({ length: 12 }, () => random() & 0xff);
  const hostIv = Uint8Array.from({ length: 8 }, () => random() & 0xff);
  const head = concat(Uint8Array.from([0xe7, 0x11, 0x01]), iv, Uint8Array.from([16]));
  const { sealed, tag } = gcmSeal(K_HS, iv, head, hostIv);
  await wire.write(concat(head, sealed, tag));
  const answer = await listen(wire, V2_MS, (r): { keys: Keys; sku: string } | string | undefined => {
    if (r.length !== 15 + 19 + 16 || r[0] !== 0xe7 || r[1] !== 0x11) return undefined;
    if (r[2] !== 0) return `The lamp refused the key exchange (status ${r[2]}).`;
    const p = gcmOpen(K_HS, r.slice(3, 15), r.slice(0, 15), r.slice(15, 34), r.slice(34));
    if (!p) return "The lamp's key-exchange reply didn't check out.";
    const sku = p.slice(8, 13);
    return { keys: { kind: "v2", key: deviceKey(sku, p.slice(13, 19)), hostIv, devIv: p.slice(0, 8), hostCtr: 2 }, sku: String.fromCharCode(...sku) };
  });
  if (answer === undefined) throw new Error("The lamp didn't answer its key exchange.");
  if (typeof answer === "string") throw new Error(answer);
  return answer;
}

export class GoveeSession {
  readonly wire: GoveeWire;
  readonly scheme: Scheme;
  /** v2 only: the SKU the lamp names in its handshake. */
  readonly sku: string | null;
  #keys: Keys;

  private constructor(wire: GoveeWire, keys: Keys, scheme: Scheme, sku: string | null) {
    this.wire = wire;
    this.#keys = keys;
    this.scheme = scheme;
    this.sku = sku;
  }

  /** Detects the scheme (or takes a cached one) and runs its handshake. `random` fills padding and nonces. */
  static async start(wire: GoveeWire, cached: Scheme | null, random: () => number): Promise<GoveeSession> {
    if (wire.marker === 2 || cached === "v2") {
      const { keys, sku } = await v2Handshake(wire, random);
      return new GoveeSession(wire, keys, "v2", sku);
    }
    if (cached !== "plain") {
      const key = await v1Handshake(wire, random);
      if (key) return new GoveeSession(wire, { kind: "v1", key }, "v1", null);
      if (cached === "v1") throw new Error("The lamp didn't answer its handshake. It may be out of range or connected to another phone.");
    }
    return new GoveeSession(wire, { kind: "plain" }, "plain", null);
  }

  /** The bytes a plaintext frame goes out as (v2 moves its counter on: one call per frame written). */
  seal(plain: Uint8Array): Uint8Array {
    if (plain.length !== FRAME_LEN) throw new RangeError("frames are 20 bytes");
    const k = this.#keys;
    if (k.kind === "plain") return plain.slice();
    if (k.kind === "v1") return safe(k.key, plain, false);
    const ctr = counterBytes(k.hostCtr);
    const { sealed, tag } = gcmSeal(k.key, concat(k.hostIv, ctr), ctr, plain);
    k.hostCtr = (k.hostCtr + 1) >>> 0;
    return concat(ctr, sealed, tag);
  }

  /** Seals a plaintext frame and writes it. */
  send(plain: Uint8Array): Promise<void> {
    return this.wire.write(this.seal(plain));
  }

  /** Opens a notification into its plaintext frame (null: not a valid frame under this session's keys). */
  open(wire: Uint8Array): Uint8Array | null {
    const k = this.#keys;
    let plain: Uint8Array | null;
    if (k.kind === "plain") plain = wire.slice();
    else if (k.kind === "v1") plain = safe(k.key, wire, true);
    else {
      if (wire.length !== 4 + FRAME_LEN + 16) return null;
      const ctr = wire.slice(0, 4);
      plain = gcmOpen(k.key, concat(k.devIv, ctr), ctr, wire.slice(4, 4 + FRAME_LEN), wire.slice(4 + FRAME_LEN));
    }
    return valid(plain) ? plain : null;
  }

  /** The next valid frame from the lamp within `ms` (the tests' reader; the website's link reads as notifications come). */
  async recv(ms: number): Promise<Uint8Array | null> {
    return (await listen(this.wire, ms, (w) => this.open(w) ?? undefined)) ?? null;
  }
}

/**
 * Notifications waiting for a reader: the handshake waits on `recv`; once the session is up, `drain` hands each one
 * to the link's reader as it comes.
 */
export class Inbox {
  #queue: Uint8Array[] = [];
  #waiting: ((w: Uint8Array | null) => void) | null = null;
  #sink: ((w: Uint8Array) => void) | null = null;

  push(w: Uint8Array) {
    if (this.#sink) return this.#sink(w);
    const wake = this.#waiting;
    if (wake) {
      this.#waiting = null;
      wake(w);
    } else this.#queue.push(w);
  }

  recv(ms: number): Promise<Uint8Array | null> {
    const next = this.#queue.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#waiting === wake) this.#waiting = null;
        resolve(null);
      }, Math.max(0, ms));
      const wake = (w: Uint8Array | null) => {
        clearTimeout(timer);
        resolve(w);
      };
      this.#waiting = wake;
    });
  }

  /** From now on every notification goes to `sink` (those already waiting first). */
  drain(sink: (w: Uint8Array) => void) {
    this.#sink = sink;
    for (const w of this.#queue.splice(0)) sink(w);
  }
}
