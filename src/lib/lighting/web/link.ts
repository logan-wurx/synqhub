// Govee lamps on the website: the lamps the person added this visit (each picked in the browser's Bluetooth chooser),
// and a LampLink to one, the same interface the desktop's Rust link gives the lamp page (src/lib/lighting/link.ts). Under
// it, the desktop bridge's steps in the browser: the GATT link (./bluetooth.ts), the encryption and handshake
// (./session.ts), every frame through the bridge's allowlist (./guard.ts), and a keep-alive while the lamp is open.
// Loaded only on the website (src/lib/lighting/link.ts imports it behind `__ONBOARD_WEB__`).
//
// What a browser doesn't give a site, so the website does without:
// - The lamp's Bluetooth address. Web Bluetooth names a device by an id of its own, so that id is the lamp's id here
//   (the desktop uses the address), and the same lamp has two ids, one per app. Nothing else needs the address: a v2
//   lamp names it in its own handshake reply, where the key is derived from.
// - Lamps from an earlier visit. `getDevices()` is still behind a flag in Chrome and Edge, so the lamps added are kept
//   for this tab only: the person picks a lamp again on the next visit.
// - Signal strength. `watchAdvertisements()` is behind the same flag, so a lamp has no reading (rssi 0, never "weak").
// - Screen sync, which reads the screen's edges in the desktop app.
import { CMD, queryFrame } from "../govee/frames.ts";
import type { LampLink } from "../link.ts";
import type { LampInfo } from "../models.ts";
import { browserBluetooth, GattWire, SERVICE, type BtDevice, type WebBluetooth } from "./bluetooth.ts";
import { BRIDGE_PACE, GoveeGate, PREFIXES, modelOf, skuOf, type GatePace } from "./guard.ts";
import { GoveeSession, SCHEME_NAME, type GoveeWire, type Scheme } from "./session.ts";

export const WEB_NO_SYNC = "Screen sync needs the SYNQ desktop app: a browser tab can't follow your screen's colours.";
export const WEB_FORGETS = "The browser forgets a lamp when the tab closes: add it again from its Bluetooth list next visit.";

/** Traffic keeps the link alive: a power query when nothing went out for this long (the bridge's `KEEP_ALIVE`). */
const KEEP_ALIVE_MS = 5000;

interface Added {
  info: LampInfo;
  device: BtDevice;
}

const added = new Map<string, Added>();
/** The scheme each lamp answered with this visit (a property of its firmware). */
const schemes = new Map<string, Scheme>();

/** The lamps added in this tab, by name. */
export const webLamps = (): LampInfo[] => [...added.values()].map((a) => a.info).sort((a, b) => a.name.localeCompare(b.name));

export type PickResult =
  | { status: "added"; lamp: LampInfo }
  | { status: "cancelled" }
  | { status: "unsupported"; name: string }
  | { status: "blocked"; message: string };

/** The request for the browser's chooser: every name prefix a Govee lamp advertises with, and the Govee service. */
export const pickRequest = () => ({ filters: PREFIXES.map((namePrefix) => ({ namePrefix })), optionalServices: [SERVICE] });

/**
 * Opens the browser's Bluetooth chooser and keeps the lamp picked in it. It has to be the first thing a click does
 * (the browser needs the click). Nothing is connected or sent here: the lamp's page connects when it opens.
 */
export async function pickLamp(bluetooth: WebBluetooth | null = browserBluetooth()): Promise<PickResult> {
  if (!bluetooth) return { status: "blocked", message: "This browser can't reach Bluetooth lamps. Use Chrome or Edge on a PC with Bluetooth." };
  let device: BtDevice;
  try {
    device = await bluetooth.requestDevice(pickRequest());
  } catch (e) {
    const err = e as { name?: string; message?: string };
    if (err.name === "NotFoundError" && /cancel/i.test(err.message ?? "")) return { status: "cancelled" };
    if (err.name === "NotFoundError" && /adapter|not available/i.test(err.message ?? ""))
      return { status: "blocked", message: "Bluetooth is off, or this PC has none. Switch it on in Windows' Bluetooth settings, then try again." };
    return { status: "blocked", message: err.message ?? String(e) };
  }
  const name = device.name ?? "";
  if (!modelOf(name)) return { status: "unsupported", name: name || "That device" };
  const info: LampInfo = { id: device.id, name, sku: skuOf(name), rssi: 0, weak: false, heardMs: 0, sync: null };
  added.set(device.id, { info, device });
  return { status: "added", lamp: info };
}

/** Padding and nonces from the browser's random source. */
function randomBytes(): () => number {
  const pool = new Uint8Array(64);
  let at = pool.length;
  return () => {
    if (at === pool.length) {
      crypto.getRandomValues(pool);
      at = 0;
    }
    return pool[at++];
  };
}

/** What `openWebLamp` needs, handed in by the tests (a pretend GATT link, quick pacing). */
export interface WebLampDeps {
  connect: (device: BtDevice) => Promise<GoveeWire & { drain(sink: (w: Uint8Array) => void): void; close(): void; lost: (why: string) => void }>;
  random: () => number;
  pace: GatePace;
}

const browserDeps = (): WebLampDeps => ({ connect: (d) => GattWire.connect(d), random: randomBytes(), pace: BRIDGE_PACE });

interface Open {
  scheme: Scheme;
  gate: GoveeGate;
  /** Pages holding the lamp; the last to close lets it go. */
  users: number;
  /** The link dropped or was let go. */
  ended: boolean;
  reports: Set<(f: Uint8Array) => void>;
  lost: Set<(why: string) => void>;
  /** Runs `fn` after everything queued before it (one operation on the radio at a time, an upload's frames together). */
  serial: <T>(fn: () => Promise<T>) => Promise<T>;
  shut: () => void;
}

/** Lamps being opened or open, shared by every page that has the same lamp open. */
const opens = new Map<string, Promise<Open>>();

/** Connects and runs the handshake; `release` takes the lamp off the open list once its link has ended. */
async function connectLamp(entry: Added, deps: WebLampDeps, release: () => void): Promise<Open> {
  const spec = modelOf(entry.info.name);
  if (!spec) throw new Error(`SYNQ doesn't drive the Govee ${entry.info.sku || "device"} yet.`);
  const wire = await deps.connect(entry.device);
  let session: GoveeSession;
  try {
    session = await GoveeSession.start(wire, schemes.get(entry.info.id) ?? null, deps.random);
  } catch (e) {
    wire.close();
    throw e;
  }
  schemes.set(entry.info.id, session.scheme);
  let lastWrite = Date.now();
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
  const gate = new GoveeGate(
    spec,
    async (plain) => {
      await session.send(plain);
      lastWrite = Date.now();
    },
    deps.pace,
  );
  const o: Open = { scheme: session.scheme, gate, users: 0, ended: false, reports: new Set(), lost: new Set(), serial, shut: () => undefined };
  wire.drain((w) => {
    const plain = session.open(w);
    if (!plain) return;
    gate.heard(plain);
    o.reports.forEach((cb) => cb(plain));
  });
  const end = (why: string | null) => {
    if (o.ended) return;
    o.ended = true;
    clearInterval(keepAlive);
    wire.close();
    release();
    if (why) o.lost.forEach((cb) => cb(why));
  };
  // A power query whenever nothing else went out for a few seconds; one that doesn't go through ends the link, as
  // the bridge's keep-alive does.
  const keepAlive = setInterval(() => {
    if (Date.now() - lastWrite < KEEP_ALIVE_MS) return;
    lastWrite = Date.now();
    serial(() => gate.send([queryFrame(CMD.power)])).catch((e: unknown) => end(e instanceof Error ? e.message : String(e)));
  }, 500);
  o.shut = () => end(null);
  wire.lost = (why) => end(why);
  return o;
}

/** Opens a lamp added this visit: connect, find its encryption, handshake, then reports and a keep-alive until the
 * last page holding it closes. */
export async function openWebLamp(lamp: LampInfo, deps: WebLampDeps = browserDeps()): Promise<LampLink> {
  const entry = added.get(lamp.id);
  if (!entry) throw new Error(WEB_FORGETS);
  let opening = opens.get(lamp.id);
  if (!opening) {
    const p: Promise<Open> = connectLamp(entry, deps, () => opens.get(lamp.id) === p && opens.delete(lamp.id));
    opens.set(lamp.id, p);
    p.catch(() => opens.get(lamp.id) === p && opens.delete(lamp.id));
    opening = p;
  }
  const o = await opening;
  if (o.ended) throw new Error("The lamp went out of reach.");
  o.users++;
  let closed = false;
  const mine = { reports: new Set<(f: Uint8Array) => void>(), lost: new Set<(why: string) => void>() };
  const add = <T>(all: Set<T>, own: Set<T>, cb: T) => {
    all.add(cb);
    own.add(cb);
    return () => {
      all.delete(cb);
      own.delete(cb);
    };
  };
  return {
    id: lamp.id,
    scheme: SCHEME_NAME[o.scheme],
    sync: null,
    send: (frames) => o.serial(() => o.gate.send(frames)),
    upload: (kind, body, code) => o.serial(() => o.gate.upload(kind, body, code)),
    onReport: (cb) => add(o.reports, mine.reports, cb),
    onLost: (cb) => add(o.lost, mine.lost, cb),
    startSync: () => Promise.reject(new Error(WEB_NO_SYNC)),
    stopSync: () => Promise.reject(new Error(WEB_NO_SYNC)),
    onSync: () => () => undefined,
    onSyncStopped: () => () => undefined,
    close: async () => {
      if (closed) return;
      closed = true;
      mine.reports.forEach((cb) => o.reports.delete(cb));
      mine.lost.forEach((cb) => o.lost.delete(cb));
      if (--o.users === 0) o.shut();
    },
  };
}

/** The tests' way to start from no lamps (a fresh tab). */
export function forgetWebLamps() {
  added.clear();
  schemes.clear();
  opens.clear();
}
