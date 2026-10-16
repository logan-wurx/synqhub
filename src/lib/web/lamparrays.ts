// Dynamic Lighting devices on the website: the counterpart of the desktop's lamparray_* commands, over the HID
// LampArray standard (src/lib/lighting/lamparray-hid.ts) instead of Windows' API. A device is listed when the person
// added it (its LampArray collection), opened when its page asks, and every feature report passes the LampArray guard
// before it goes. Opening it switches the device's own effect off; closing it (or leaving the page) switches it back on.
// ASUS devices are never listed, opened or lit.
import type { LampArrayDevice, LampArrayInfo } from "../lighting/lamparray.ts";
import { asusLamp, checkLampFrame, controlFrame, hasLampArray, infoOf, layoutOf, multiFrame, rangeFrame, readAttributes, readLamp, requestFrame, slotsOf, LAMP_ARRAY, LIGHTING_PAGE, type ArrayAttributes, type LampAttributes, type Layout } from "../lighting/lamparray-hid.ts";
import { isBootloader } from "../bootloader-ids.ts";
import { rawGranted } from "./hid.ts";

const hex4 = (n: number) => n.toString(16).padStart(4, "0");

interface OpenArray {
  dev: HIDDevice;
  layout: Layout;
  attrs: ArrayAttributes;
  lamps: LampAttributes[];
  /** It was open already (a keyboard's driver uses the same device): left open on close. */
  shared: boolean;
  /** A frame waiting while one is being sent: only the newest is kept. */
  next: number[] | null;
  sending: boolean;
}

const open = new Map<string, OpenArray>();

/** The granted devices with a LampArray SYNQ may light, by id (`vid:pid`, then `#2`… for a second of the same kind). */
async function arrays(): Promise<Map<string, HIDDevice>> {
  const out = new Map<string, HIDDevice>();
  for (const d of await rawGranted()) {
    if (!hasLampArray(d.collections) || asusLamp(d.vendorId, d.productName ?? "") || isBootloader(d.vendorId, d.productId, d.productName ?? null)) continue;
    const base = `${hex4(d.vendorId)}:${hex4(d.productId)}`;
    let id = base;
    for (let n = 2; out.has(id); n++) id = `${base}#${n}`;
    out.set(id, d);
  }
  return out;
}

export async function lampArrayList(): Promise<LampArrayDevice[]> {
  return [...(await arrays())].map(([id, d]) => ({ id, name: d.productName?.trim() || "Dynamic Lighting device", kind: -1, vid: hex4(d.vendorId), pid: hex4(d.productId) }));
}

async function send(a: OpenArray, reportId: number, data: Uint8Array) {
  const v = checkLampFrame(a.layout, a.attrs.lampCount, reportId, data);
  if (!v.ok) throw new Error(`Refused before sending: ${v.why}`);
  await a.dev.sendFeatureReport(reportId, data as Uint8Array<ArrayBuffer>);
}

/** A feature report's bytes after its id (Chromium on some systems hands the id back as the first byte). */
async function receive(dev: HIDDevice, reportId: number, bytes: number): Promise<Uint8Array> {
  const v = await dev.receiveFeatureReport(reportId);
  const all = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return all.length === bytes + 1 && all[0] === reportId ? all.subarray(1) : all;
}

export async function lampArrayInfo(id: string): Promise<LampArrayInfo> {
  const dev = (await arrays()).get(id);
  if (!dev) throw new Error("This device isn't added on this page any more. Add it again from the Lights page.");
  const app = dev.collections.find((c) => c.usagePage === LIGHTING_PAGE && c.usage === LAMP_ARRAY)!;
  const layout = layoutOf(app);
  if (!layout) throw new Error("Its LampArray doesn't have every report the standard defines, so SYNQ leaves it alone.");
  const shared = dev.opened;
  if (!shared) await dev.open();
  const attrs = readAttributes(layout, await receive(dev, layout.attributes.id, layout.attributes.bytes));
  if (attrs.lampCount < 1 || attrs.lampCount > 4096) throw new Error(`It reports ${attrs.lampCount} lamps, which isn't a LampArray SYNQ can light.`);
  const a: OpenArray = { dev, layout, attrs, lamps: [], shared, next: null, sending: false };
  // Ask for lamp 0 once; each read goes on to the next lamp. A device that doesn't move on is asked for each one.
  await send(a, layout.request.id, requestFrame(layout, 0));
  for (let i = 0; i < attrs.lampCount; i++) {
    let lamp = readLamp(layout, await receive(dev, layout.response.id, layout.response.bytes));
    if (lamp.id !== i) {
      await send(a, layout.request.id, requestFrame(layout, i));
      lamp = readLamp(layout, await receive(dev, layout.response.id, layout.response.bytes));
    }
    a.lamps.push(lamp);
  }
  // SYNQ sets the colours from here on: the device's own effect is switched off.
  await send(a, layout.control.id, controlFrame(layout, false));
  open.set(id, a);
  return infoOf(id, dev.productName?.trim() || "Dynamic Lighting device", hex4(dev.vendorId), hex4(dev.productId), attrs, a.lamps);
}

async function paint(a: OpenArray, colors: readonly number[]) {
  const { layout, lamps } = a;
  if (colors.length === 3) {
    const rgb = [colors[0], colors[1], colors[2]] as const;
    await send(a, layout.range.id, rangeFrame(layout, 0, lamps.length - 1, rgb, lamps[0]?.levels));
    return;
  }
  const slots = slotsOf(layout);
  const set = lamps.filter((l) => l.programmable).map((l) => ({ id: l.id, rgb: [colors[3 * l.id], colors[3 * l.id + 1], colors[3 * l.id + 2]] as const, levels: l.levels }));
  for (let i = 0; i < set.length; i += slots) await send(a, layout.multi.id, multiFrame(layout, set.slice(i, i + slots), i + slots >= set.length));
}

/** Colours for an open device: three numbers (all lamps) or three per lamp. A frame that comes while one is going waits; only the newest. */
export async function lampArraySet(id: string, colors: readonly number[]): Promise<void> {
  const a = open.get(id);
  if (!a) throw new Error("This device isn't open. Open its page again.");
  if (colors.length !== 3 && colors.length !== a.lamps.length * 3) throw new Error(`${colors.length} colour values for ${a.lamps.length} lamps: one colour, or one per lamp.`);
  if (a.sending) {
    a.next = [...colors];
    return;
  }
  a.sending = true;
  try {
    let frame: readonly number[] | null = colors;
    while (frame) {
      a.next = null;
      await paint(a, frame);
      frame = a.next;
    }
  } finally {
    a.sending = false;
  }
}

/** Gives the device its own effect back and lets go of it. */
export async function lampArrayClose(id: string): Promise<void> {
  const a = open.get(id);
  if (!a) return;
  open.delete(id);
  a.next = null;
  await send(a, a.layout.control.id, controlFrame(a.layout, true)).catch(() => undefined);
  if (!a.shared) await a.dev.close().catch(() => undefined);
}
