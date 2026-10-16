// USB RGB hubs on the website: the counterpart of src-tauri/src/lighting/hidrgb.rs. A hub isn't a driver's device, so
// it isn't in the guarded navigator.hid; its vendor collection is opened here, straight from WebHID, and every report
// is checked by the hub guard before it is sent, as the bridge does (the session in hidrgb/session.ts checked it once
// already). Replies are handed back the way hidapi reads them, so the session code is the same on both.
import { checkHubFrame } from "../lighting/hidrgb/guard.ts";
import { findHub, type HubModel } from "../lighting/hidrgb/protocol.ts";
import { hubCollection } from "./policy.ts";
import { rawGranted } from "./hid.ts";

/** Replies kept between reads; older ones are dropped (a hub that sends status reports on its own). */
const QUEUE = 32;

interface OpenHub {
  dev: HIDDevice;
  queue: Uint8Array[];
  wake: (() => void) | null;
  off: () => void;
}

const open = new Map<string, OpenHub>();
const keyOf = (m: HubModel) => `${m.vid}:${m.pid}`;

async function opened(m: HubModel): Promise<OpenHub> {
  const have = open.get(keyOf(m));
  if (have) return have;
  const cols = (d: HIDDevice) => d.collections.map((c) => ({ usagePage: c.usagePage ?? 0, usage: c.usage ?? 0 }));
  const dev = (await rawGranted()).find((d) => findHub(d.vendorId, d.productId)?.pid === m.pid && hubCollection(m, cols(d)));
  if (!dev) throw new Error("The hub isn't added on this page (press Add device and pick it), or it was unplugged.");
  if (!dev.opened) await dev.open();
  const hub: OpenHub = { dev, queue: [], wake: null, off: () => {} };
  const tap = (e: HIDInputReportEvent) => {
    const data = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    // As hidapi reads it: the report id first, except report 0 (a hub without numbered reports).
    hub.queue.push(e.reportId === 0 ? Uint8Array.from(data) : Uint8Array.from([e.reportId, ...data]));
    if (hub.queue.length > QUEUE) hub.queue.shift();
    hub.wake?.();
  };
  dev.addEventListener("inputreport", tap);
  hub.off = () => dev.removeEventListener("inputreport", tap);
  open.set(keyOf(m), hub);
  return hub;
}

/** One report to a hub, after the guard; what the guard said it is. */
export async function hubWrite(vid: string, pid: string, reportId: number, data: readonly number[]): Promise<string> {
  const m = findHub(vid, pid);
  if (!m) throw new Error("Refused: not a hub SYNQ drives.");
  const bytes = Uint8Array.from(data);
  const v = checkHubFrame(m, { reportId, data: bytes });
  if (!v.ok) throw new Error(`Refused: ${v.why}`);
  await (await opened(m)).dev.sendReport(reportId, bytes);
  return v.what;
}

/** The next reply from an open hub, or null when none came within `timeoutMs` (at most 2 s, as on the desktop). */
export async function hubRead(vid: string, pid: string, timeoutMs: number): Promise<number[] | null> {
  const m = findHub(vid, pid);
  const hub = m && open.get(keyOf(m));
  if (!hub) return null;
  if (!hub.queue.length)
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        hub.wake = null;
        resolve();
      };
      const timer = setTimeout(done, Math.min(Math.max(timeoutMs, 0), 2000));
      hub.wake = done;
    });
  const r = hub.queue.shift();
  return r ? Array.from(r) : null;
}

export async function hubClose(vid: string, pid: string): Promise<void> {
  const m = findHub(vid, pid);
  const hub = m && open.get(keyOf(m));
  if (!m || !hub) return;
  open.delete(keyOf(m));
  hub.off();
  hub.wake?.();
  await hub.dev.close().catch(() => undefined);
}
