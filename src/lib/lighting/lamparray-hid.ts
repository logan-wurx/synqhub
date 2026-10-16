// The HID LampArray standard (HID Usage Tables, Lighting And Illumination page 0x59), spoken directly: the website's way
// to Dynamic Lighting devices, where Windows' own API (src-tauri/src/lighting/lamparray.rs) isn't reachable. Report ids
// and field sizes differ per device, so the layout is read from the device's own report descriptor (WebHID hands it over
// as collections and report items). Feature reports only, and only these: read the array's and each lamp's attributes,
// ask for a lamp, set lamp colours (by list or by range), and switch the device's own effect off and back on. Every
// report SYNQ builds passes `checkLampFrame` before it goes. ASUS devices are never touched (as on the desktop). Pure.
import type { Lamp, LampArrayInfo } from "./lamparray.ts";

export const LIGHTING_PAGE = 0x59;
export const LAMP_ARRAY = 0x01;

/** The usages SYNQ reads or writes (page 0x59). */
const U = {
  lampCount: 0x03,
  width: 0x04,
  height: 0x05,
  depth: 0x06,
  kind: 0x07,
  minInterval: 0x08,
  lampId: 0x21,
  x: 0x23,
  y: 0x24,
  z: 0x25,
  purposes: 0x26,
  latency: 0x27,
  redLevels: 0x28,
  greenLevels: 0x29,
  blueLevels: 0x2a,
  intensityLevels: 0x2b,
  programmable: 0x2c,
  red: 0x51,
  green: 0x52,
  blue: 0x53,
  intensity: 0x54,
  flags: 0x55,
  idStart: 0x61,
  idEnd: 0x62,
  autonomous: 0x71,
} as const;

/** What WebHID says about a report item (the parts used here). */
export interface ReportItem {
  usages?: readonly number[];
  usageMinimum?: number;
  usageMaximum?: number;
  isRange?: boolean;
  isConstant?: boolean;
  reportSize?: number;
  reportCount?: number;
  logicalMaximum?: number;
}
export interface ReportInfo {
  reportId?: number;
  items?: readonly ReportItem[];
}
export interface Collection {
  usagePage?: number;
  usage?: number;
  children?: readonly Collection[];
  featureReports?: readonly ReportInfo[];
}

/** One field of a report: its usage on page 0x59 (null for padding or another page), where it sits, its size. */
export interface Field {
  usage: number | null;
  bit: number;
  bits: number;
  max: number;
}
export interface Report {
  id: number;
  bytes: number;
  fields: Field[];
}
export type Role = "attributes" | "request" | "response" | "multi" | "range" | "control";
export type Layout = Record<Role, Report>;

/** Whether a device has a LampArray application collection. */
export const hasLampArray = (cols: readonly Collection[]): boolean => cols.some((c) => c.usagePage === LIGHTING_PAGE && c.usage === LAMP_ARRAY);
/** ASUS (Aura, Armoury Crate, ROG): never listed, opened or lit, by vendor or by name (lamparray.rs `asus`). */
export const asusLamp = (vendorId: number, name: string): boolean => {
  const n = name.toLowerCase();
  return vendorId === 0x0b05 || ["asus", "aura", "armoury", "rog "].some((w) => n.includes(w)) || n.startsWith("rog");
};

function fieldsOf(items: readonly ReportItem[]): { fields: Field[]; bits: number } {
  const fields: Field[] = [];
  let bit = 0;
  for (const it of items) {
    const size = it.reportSize ?? 0;
    const count = it.reportCount ?? 0;
    const usages = it.usages ?? [];
    for (let j = 0; j < count; j++) {
      let full: number | null = null;
      if (!it.isConstant) {
        if (it.isRange && it.usageMinimum !== undefined) full = Math.min(it.usageMinimum + j, it.usageMaximum ?? it.usageMinimum);
        else if (usages.length) full = usages[Math.min(j, usages.length - 1)];
      }
      // Extended usages carry their page in the top 16 bits; a usage without one is on the collection's page (0x59).
      const page = full !== null && full > 0xffff ? full >>> 16 : LIGHTING_PAGE;
      const usage = full === null || page !== LIGHTING_PAGE ? null : full & 0xffff;
      const max = it.logicalMaximum !== undefined && it.logicalMaximum > 0 ? it.logicalMaximum : size >= 32 ? 0xffffffff : 2 ** size - 1;
      fields.push({ usage, bit, bits: size, max });
      bit += size;
    }
  }
  return { fields, bits: bit };
}

function reportsUnder(c: Collection): ReportInfo[] {
  return [...(c.featureReports ?? []), ...(c.children ?? []).flatMap(reportsUnder)];
}

/**
 * The LampArray's six feature reports, recognised by what they carry (not by id, which each device picks). Null when
 * the device lacks one of them: SYNQ then leaves it alone.
 */
export function layoutOf(app: Collection): Layout | null {
  const byId = new Map<number, ReportItem[]>();
  for (const r of reportsUnder(app)) {
    if (r.reportId === undefined || r.reportId === 0) continue;
    byId.set(r.reportId, [...(byId.get(r.reportId) ?? []), ...(r.items ?? [])]);
  }
  const found: Partial<Layout> = {};
  for (const [id, items] of byId) {
    const { fields, bits } = fieldsOf(items);
    const has = (u: number) => fields.some((f) => f.usage === u);
    const report: Report = { id, bytes: Math.ceil(bits / 8), fields };
    const role: Role | null = has(U.kind) && has(U.lampCount)
      ? "attributes"
      : has(U.x) && has(U.lampId)
        ? "response"
        : has(U.idStart) && has(U.idEnd)
          ? "range"
          : has(U.red) && has(U.lampId) && has(U.lampCount)
            ? "multi"
            : has(U.autonomous)
              ? "control"
              : has(U.lampId) && fields.filter((f) => f.usage !== null).length === 1
                ? "request"
                : null;
    if (role && !found[role]) found[role] = report;
  }
  const roles: Role[] = ["attributes", "request", "response", "multi", "range", "control"];
  return roles.every((r) => found[r]) ? (found as Layout) : null;
}

function readBits(data: Uint8Array, f: Field): number {
  let v = 0;
  for (let i = 0; i < f.bits; i++) {
    const at = f.bit + i;
    if (data[at >> 3] & (1 << (at & 7))) v += 2 ** i;
  }
  return v;
}

function writeBits(data: Uint8Array, f: Field, value: number) {
  const v = Math.max(0, Math.min(Math.round(value), f.max));
  for (let i = 0; i < f.bits; i++) {
    const at = f.bit + i;
    if (Math.floor(v / 2 ** i) % 2) data[at >> 3] |= 1 << (at & 7);
  }
}

const first = (r: Report, usage: number) => r.fields.find((f) => f.usage === usage);
const all = (r: Report, usage: number) => r.fields.filter((f) => f.usage === usage);
const get = (r: Report, data: Uint8Array, usage: number) => {
  const f = first(r, usage);
  return f ? readBits(data, f) : 0;
};

/** The array's attributes (sizes in micrometres on the wire, metres here). */
export interface ArrayAttributes {
  lampCount: number;
  width: number;
  height: number;
  depth: number;
  kind: number;
  minIntervalUs: number;
}

export function readAttributes(l: Layout, data: Uint8Array): ArrayAttributes {
  const r = l.attributes;
  return {
    lampCount: get(r, data, U.lampCount),
    width: get(r, data, U.width) / 1e6,
    height: get(r, data, U.height) / 1e6,
    depth: get(r, data, U.depth) / 1e6,
    kind: get(r, data, U.kind),
    minIntervalUs: get(r, data, U.minInterval),
  };
}

/** One lamp as its attributes report gives it, with the colour levels it takes. */
export interface LampAttributes extends Lamp {
  id: number;
  levels: [number, number, number, number];
  programmable: boolean;
}

export function readLamp(l: Layout, data: Uint8Array): LampAttributes {
  const r = l.response;
  const n = (u: number) => get(r, data, u);
  return {
    id: n(U.lampId),
    x: n(U.x) / 1e6,
    y: n(U.y) / 1e6,
    z: n(U.z) / 1e6,
    purposes: n(U.purposes),
    levels: [n(U.redLevels), n(U.greenLevels), n(U.blueLevels), n(U.intensityLevels)],
    // A device that doesn't say is taken as programmable (the field is optional in some descriptors).
    programmable: first(r, U.programmable) ? n(U.programmable) !== 0 : true,
  };
}

const blank = (r: Report) => new Uint8Array(r.bytes);

/** Asks for one lamp's attributes (the next attributes read answers it; later reads go on to the next lamps). */
export function requestFrame(l: Layout, lampId: number): Uint8Array {
  const d = blank(l.request);
  writeBits(d, first(l.request, U.lampId)!, lampId);
  return d;
}

/** The device's own effect off (SYNQ sets the colours) or back on. */
export function controlFrame(l: Layout, autonomous: boolean): Uint8Array {
  const d = blank(l.control);
  writeBits(d, first(l.control, U.autonomous)!, autonomous ? 1 : 0);
  return d;
}

/** A colour scaled to the levels a lamp takes (0: the device didn't say; 256 levels: as is). */
const level = (v: number, levels: number) => (levels > 1 && levels < 256 ? (v * (levels - 1)) / 255 : v);
const intensityOf = (levels: number) => (levels > 1 ? levels - 1 : 255);

/** How many lamps one list report carries. */
export const slotsOf = (l: Layout) => Math.min(all(l.multi, U.lampId).length, all(l.multi, U.red).length, all(l.multi, U.green).length, all(l.multi, U.blue).length);

/** Colours for up to `slotsOf` lamps; `complete` on the last report of a frame (the device shows the frame then). */
export function multiFrame(l: Layout, lamps: readonly { id: number; rgb: readonly [number, number, number]; levels?: readonly number[] }[], complete: boolean): Uint8Array {
  const r = l.multi;
  const d = blank(r);
  writeBits(d, first(r, U.lampCount)!, lamps.length);
  const flags = first(r, U.flags);
  if (flags) writeBits(d, flags, complete ? 1 : 0);
  const [ids, reds, greens, blues, intens] = [all(r, U.lampId), all(r, U.red), all(r, U.green), all(r, U.blue), all(r, U.intensity)];
  lamps.forEach((lamp, i) => {
    const lv = lamp.levels ?? [0, 0, 0, 0];
    writeBits(d, ids[i], lamp.id);
    writeBits(d, reds[i], level(lamp.rgb[0], lv[0]));
    writeBits(d, greens[i], level(lamp.rgb[1], lv[1]));
    writeBits(d, blues[i], level(lamp.rgb[2], lv[2]));
    if (intens[i]) writeBits(d, intens[i], intensityOf(lv[3]));
  });
  return d;
}

/** One colour for lamps `start` to `end` (inclusive). */
export function rangeFrame(l: Layout, start: number, end: number, rgb: readonly [number, number, number], levels: readonly number[] = [0, 0, 0, 0]): Uint8Array {
  const r = l.range;
  const d = blank(r);
  const flags = first(r, U.flags);
  if (flags) writeBits(d, flags, 1);
  writeBits(d, first(r, U.idStart)!, start);
  writeBits(d, first(r, U.idEnd)!, end);
  writeBits(d, first(r, U.red)!, level(rgb[0], levels[0]));
  writeBits(d, first(r, U.green)!, level(rgb[1], levels[1]));
  writeBits(d, first(r, U.blue)!, level(rgb[2], levels[2]));
  const i = first(r, U.intensity);
  if (i) writeBits(d, i, intensityOf(levels[3]));
  return d;
}

export type LampVerdict = { ok: true; what: "request" | "multi" | "range" | "control" } | { ok: false; why: string };

/**
 * Whether SYNQ may send this feature report to this LampArray: only the four it builds, the right length, lamp ids
 * the device has, flags and modes it defines. The attributes reports are only ever read.
 */
export function checkLampFrame(l: Layout, lampCount: number, reportId: number, data: Uint8Array): LampVerdict {
  const no = (why: string): LampVerdict => ({ ok: false, why });
  const role = (["request", "multi", "range", "control"] as const).find((r) => l[r].id === reportId);
  if (!role) return no("Not a report SYNQ sends a LampArray (its attributes are only read).");
  const r = l[role];
  if (data.length !== r.bytes) return no(`That report is ${r.bytes} bytes.`);
  const n = (u: number) => get(r, data, u);
  const flagOk = !first(r, U.flags) || n(U.flags) <= 1;
  switch (role) {
    case "request":
      return n(U.lampId) < lampCount ? { ok: true, what: role } : no("Not one of this device's lamps.");
    case "control":
      return n(U.autonomous) <= 1 ? { ok: true, what: role } : no("Not an effect switch SYNQ sends.");
    case "range":
      return flagOk && n(U.idStart) <= n(U.idEnd) && n(U.idEnd) < lampCount ? { ok: true, what: role } : no("Not a lamp range this device has.");
    case "multi": {
      const count = n(U.lampCount);
      const ids = all(r, U.lampId).slice(0, count);
      if (!flagOk || count < 1 || count > slotsOf(l)) return no("Not a lamp count one report carries.");
      return ids.every((f) => readBits(data, f) < lampCount) ? { ok: true, what: role } : no("Not one of this device's lamps.");
    }
  }
}

/** The info the Dynamic Lighting page shows, from what the device reported. */
export function infoOf(id: string, name: string, vid: string, pid: string, a: ArrayAttributes, lamps: readonly LampAttributes[]): LampArrayInfo {
  return { id, name, kind: a.kind, width: a.width, height: a.height, depth: a.depth, vid, pid, available: true, enabled: true, lamps: lamps.map(({ x, y, z, purposes }) => ({ x, y, z, purposes })) };
}
