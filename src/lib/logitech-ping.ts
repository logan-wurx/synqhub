// Is a Logitech mouse on and answering? One HID++ ping (IRoot.GetProtocolVersion, a read that
// changes nothing) to each place a mouse can answer from: the receiver's six pairing slots, or the
// mouse itself on its cable. A paired mouse that is off or asleep either gets an HID++ 1.0 error
// back from the receiver or no reply at all; both mean "not answering". This is small on purpose:
// it doesn't load the HID++ driver the Logitech panel uses, so it is cheap to run when the Mouse
// page opens or the device list changes. Nothing is written to the mouse.

const LOGITECH = 0x046d;
const SHORT_REPORT = 0x10;
const LONG_REPORT = 0x11;
/** HID++ 2.0 short requests are [device index, feature index, function | software id, 3 parameter bytes]. */
const ROOT = 0x00;
const PING = 0x10;
/** The HID++ driver's own software id is 0x05; a different one keeps its pending requests from matching these replies. */
const SOFTWARE_ID = 0x0b;
const HIDPP_PAGE = 0xff00;
const RECEIVER_SLOTS = [1, 2, 3, 4, 5, 6];
/** A mouse on its cable is addressed as itself (0xFF); some answer on slot 1 as well. */
const DIRECT = [0xff, 0x01];

type Reply = "pong" | "absent";

/** What a report from the mouse or its receiver says about our ping, or null if it isn't about it. */
export function readReply(reportId: number, data: ArrayLike<number>): { index: number; reply: Reply } | null {
  if (reportId !== SHORT_REPORT && reportId !== LONG_REPORT) return null;
  const [index, feature, third, fourth] = [data[0], data[1], data[2], data[3]];
  const fn = PING | SOFTWARE_ID;
  // Answer: [index, root, ping | id, protocol major, minor, echo]
  if (feature === ROOT && third === fn) return { index, reply: "pong" };
  // HID++ 2.0 error: [index, 0xFF, root, ping | id, code]. The device is there; it just rejects the ping.
  if (feature === 0xff && third === ROOT && fourth === fn) return { index, reply: "pong" };
  // HID++ 1.0 error from the receiver: [index, 0x8F, root, ping | id, code]. Nothing answers on that slot.
  if (feature === 0x8f && third === ROOT && fourth === fn) return { index, reply: "absent" };
  return null;
}

/** The ping as a short report (6 bytes after the id) or, for an endpoint that only has the long collection, a long one (19). */
export const pingFrame = (index: number, long = false) => {
  const frame = new Uint8Array(long ? 19 : 6);
  frame.set([index, ROOT, PING | SOFTWARE_ID, 0, 0, 0xa5]);
  return frame;
};

const isReceiver = (productId: number) => (productId & 0xff00) === 0xc500;
const hasUsage = (d: HIDDevice, usage: number) => d.collections.some((c) => c.usagePage === HIDPP_PAGE && c.usage === usage);
const hasShort = (d: HIDDevice) => hasUsage(d, 0x0001);
const hasLong = (d: HIDDevice) => hasUsage(d, 0x0002);

/**
 * Pings one HID++ endpoint on every candidate index at once. True as soon as one answers, false
 * when every index says nobody is there or `ms` pass. The device is opened for it if it wasn't,
 * and closed again unless `held()` says a panel is using it; the listener is always taken off.
 */
async function pingEndpoint(device: HIDDevice, indexes: number[], ms: number, held: () => boolean): Promise<boolean> {
  const wasOpen = device.opened;
  let onReport: ((event: HIDInputReportEvent) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!wasOpen) await device.open();
    return await new Promise<boolean>((resolve) => {
      const absent = new Set<number>();
      onReport = (event) => {
        const r = readReply(event.reportId, new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
        if (!r || !indexes.includes(r.index)) return;
        if (r.reply === "pong") return resolve(true);
        absent.add(r.index);
        if (absent.size === indexes.length) resolve(false);
      };
      device.addEventListener("inputreport", onReport);
      timer = setTimeout(() => resolve(false), ms);
      // The short collection takes short requests; an endpoint with only the long one gets long ones.
      const long = !hasShort(device);
      Promise.all(indexes.map((i) => device.sendReport(long ? LONG_REPORT : SHORT_REPORT, pingFrame(i, long)))).catch(() => resolve(false));
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (onReport) device.removeEventListener("inputreport", onReport);
    if (!wasOpen && !held()) await device.close().catch(() => undefined);
  }
}

/**
 * Whether a Logitech mouse answers, among `devices` (the HID devices the bridge lists). `pids` are the
 * product ids (lower-case hex, as the device list has them) of the Logitech mice that are plugged in.
 */
export async function probeLogitechOn(devices: readonly HIDDevice[], pids: readonly string[], ms: number, held: () => boolean = () => false): Promise<boolean> {
  const wanted = new Set(pids.map((p) => parseInt(p, 16)));
  const endpoints = devices.filter((d) => d.vendorId === LOGITECH && wanted.has(d.productId) && (hasShort(d) || hasLong(d)));
  const answers = await Promise.all(endpoints.map((d) => pingEndpoint(d, isReceiver(d.productId) ? RECEIVER_SLOTS : DIRECT, ms, held)));
  return answers.some(Boolean);
}
