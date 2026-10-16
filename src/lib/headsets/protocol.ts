// Gaming headsets over HID, ported from HeadsetControl (https://github.com/Sapd/HeadsetControl, GPL-3.0, compatible
// with SYNQ's AGPL-3.0; lib/devices/*.hpp as of 2026-10-14): which collection each family talks on, the frames
// SYNQ may build (reads: battery, charging, chat-mix; settings: sidetone, auto-off, lights, mic light, volume
// limiter, the headset's own EQ presets), and how the replies read. Every frame here also passes guard.ts, and the
// desktop bridge checks it again (src-tauri/src/headsets.rs). Pure.
import table from "./headsets.json" with { type: "json" };

export type Family = "ss-nova7" | "logi-g535" | "logi-gpro" | "logi-g633" | "hyperx-cloud2w";

export interface Channel {
  brand: string;
  collections: [number, number][];
  transport: "output";
  reports: number[];
  /** The whole report, report id included. */
  length: number;
}

export interface Model {
  vid: string;
  pid: string;
  family: Family;
  name: string;
  /** How the battery reads: 0-4 levels, a percentage, or a voltage turned into one (`calibration`). */
  battery: "levels" | "percent" | "voltage";
  calibration?: "g535" | "gpro" | "g633";
  /** The Arctis Nova 7 Gen 2 keeps a sidetone change only after a save command. */
  saveAfterSidetone?: boolean;
}

export const CHANNELS = table.families as Record<Family, Channel>;
export const MODELS = table.models as Model[];
export const SOURCE = table.source;

export function findHeadset(vid: string | number, pid: string | number): Model | null {
  const hex = (v: string | number) => (typeof v === "number" ? v.toString(16).padStart(4, "0") : v.toLowerCase());
  return MODELS.find((m) => m.vid === hex(vid) && m.pid === hex(pid)) ?? null;
}

/** One report to send: the report id and its data (without the id, padded to the channel's length). */
export interface Frame {
  reportId: number;
  data: Uint8Array;
}

function frame(family: Family, bytes: readonly number[]): Frame {
  const ch = CHANNELS[family];
  const data = new Uint8Array(ch.length - 1);
  data.set(bytes);
  return { reportId: ch.reports[0], data };
}

const HIDPP = 0xff;

/** The settings a family can take, with the values SYNQ offers (and its guard allows). */
export interface SettingSpec {
  id: SettingId;
  label: string;
  /** Allowed values, in order; `labels` names them. */
  values: readonly number[];
  labels?: Readonly<Record<number, string>>;
  unit?: string;
}

export type SettingId = "sidetone" | "autoOff" | "lights" | "micLight" | "limiter" | "eqPreset";

const NOVA_SIDETONE = { 0: "Off", 1: "Low", 2: "Medium", 3: "High" } as const;
const OFF_ON = { 0: "Off", 1: "On" } as const;
const minutes = (list: readonly number[]) => Object.fromEntries(list.map((m) => [m, m === 0 ? "Never" : `${m} min`])) as Record<number, string>;
const PERCENT = Array.from({ length: 11 }, (_, i) => i * 10);
const LOGI_OFF = [0, 1, 2, 5, 10, 15, 30] as const;
const NOVA_OFF = [0, 1, 5, 10, 15, 30, 60, 90] as const;
const HYPERX_OFF = [0, 5, 10, 15, 20, 30, 60] as const;

/** The Arctis Nova 7's built-in EQ presets (band gains in dB, 10 bands), as HeadsetControl sends them. */
export const NOVA_EQ_PRESETS: readonly { name: string; bands: readonly number[] }[] = [
  { name: "Flat", bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Bass", bands: [3.5, 5.5, 4, 1, -1.5, -1.5, -1, -1, -1, -1] },
  { name: "Focus", bands: [-5, -3.5, -1, -3.5, -2.5, 4, 6, -3.5, 0, 0] },
  { name: "Smiley", bands: [3, 3.5, 1.5, -1.5, -4, -4, -2.5, 1.5, 3, 4] },
];

export function settingsOf(family: Family): SettingSpec[] {
  switch (family) {
    case "ss-nova7":
      return [
        { id: "sidetone", label: "Sidetone", values: [0, 1, 2, 3], labels: NOVA_SIDETONE },
        { id: "autoOff", label: "Turn off after", values: NOVA_OFF, labels: minutes(NOVA_OFF) },
        { id: "eqPreset", label: "Headset EQ", values: [0, 1, 2, 3], labels: Object.fromEntries(NOVA_EQ_PRESETS.map((p, i) => [i, p.name])) },
        { id: "micLight", label: "Mic mute light", values: [0, 1, 2, 3], labels: { 0: "Off", 1: "Low", 2: "Medium", 3: "High" } },
        { id: "limiter", label: "Volume limiter", values: [0, 1], labels: OFF_ON },
      ];
    case "logi-g535":
      return [
        { id: "sidetone", label: "Sidetone", values: PERCENT, unit: "%" },
        { id: "autoOff", label: "Turn off after", values: LOGI_OFF, labels: minutes(LOGI_OFF) },
      ];
    case "logi-gpro":
      return [
        { id: "sidetone", label: "Sidetone", values: PERCENT, unit: "%" },
        { id: "autoOff", label: "Turn off after", values: LOGI_OFF, labels: minutes(LOGI_OFF) },
      ];
    case "logi-g633":
      return [
        { id: "sidetone", label: "Sidetone", values: PERCENT, unit: "%" },
        { id: "lights", label: "Lights", values: [0, 1], labels: OFF_ON },
      ];
    case "hyperx-cloud2w":
      return [{ id: "autoOff", label: "Turn off after", values: HYPERX_OFF, labels: minutes(HYPERX_OFF) }];
  }
}

/** The reads that make up a status check, in order. */
export function statusRequests(family: Family): Frame[] {
  switch (family) {
    case "ss-nova7":
      return [frame(family, [0xb0])];
    case "logi-g535":
      return [frame(family, [HIDPP, 0x05, 0x0d])];
    case "logi-gpro":
      return [frame(family, [HIDPP, 0x06, 0x0d])];
    case "logi-g633":
      return [frame(family, [HIDPP, 0x08, 0x0a])];
    case "hyperx-cloud2w":
      return [frame(family, [0xff, 0xbb, 0x02]), frame(family, [0xff, 0xbb, 0x03]), frame(family, [0xff, 0xbb, 0x07])];
  }
}

const NOVA_EQ_BASELINE = 0x14;

/** The frames that set one setting (a value from `settingsOf`); null for a value SYNQ doesn't offer. */
export function settingFrames(m: Model, id: SettingId, value: number): Frame[] | null {
  const spec = settingsOf(m.family).find((s) => s.id === id);
  if (!spec || !spec.values.includes(value)) return null;
  const f = m.family;
  switch (f) {
    case "ss-nova7":
      if (id === "sidetone") return [frame(f, [0x39, value]), ...(m.saveAfterSidetone ? [frame(f, [0x09])] : [])];
      if (id === "autoOff") return [frame(f, [0xa3, value])];
      if (id === "micLight") return [frame(f, [0xae, value])];
      if (id === "limiter") return [frame(f, [0x3a, value])];
      if (id === "eqPreset") return [frame(f, [0x33, ...NOVA_EQ_PRESETS[value].bands.map((g) => Math.trunc(NOVA_EQ_BASELINE + g)), 0x00])];
      return null;
    case "logi-g535":
      if (id === "sidetone") return [frame(f, [HIDPP, 0x04, 0x1d, value])];
      if (id === "autoOff") return [frame(f, [HIDPP, 0x05, 0x2d, value])];
      return null;
    case "logi-gpro":
      if (id === "sidetone") return [frame(f, [HIDPP, 0x05, 0x1a, value])];
      if (id === "autoOff") return [frame(f, [HIDPP, 0x07, 0x21, value])];
      return null;
    case "logi-g633":
      if (id === "sidetone") return [frame(f, [HIDPP, 0x07, 0x1a, value])];
      if (id === "lights") {
        const zone = (z: number) => frame(f, [HIDPP, 0x04, 0x3c, z, value ? 0x02 : 0x00, 0x00, 0xb6, 0xff, 0x0f, 0xa0, 0x00, 0x64]);
        return [zone(1), zone(0)];
      }
      return null;
    case "hyperx-cloud2w":
      if (id === "autoOff") return [frame(f, [0xff, 0xbb, 0x22, value])];
      return null;
  }
}

export interface Status {
  connected: boolean;
  /** 0-100, or null when the headset didn't say. */
  battery: number | null;
  charging: boolean | null;
  /** Estimated from the battery voltage (Logitech). */
  estimated?: boolean;
  /** Game / chat mix, each 0-100 (SteelSeries' dial). */
  chatmix?: { game: number; chat: number };
  /** Auto-off as the headset reports it (HyperX). */
  autoOff?: number;
}

/** Voltage (mV) to percent on a maker's discharge curve (HeadsetControl's calibration points), linear between them. */
export const CALIBRATIONS: Record<NonNullable<Model["calibration"]>, { mv: readonly number[]; pct: readonly number[] }> = {
  g535: { mv: [4175, 3817, 3766, 3730, 3664, 3310], pct: [100, 50, 30, 20, 5, 0] },
  gpro: { mv: [4150, 3830, 3780, 3740, 3670, 3320], pct: [100, 50, 30, 20, 5, 0] },
  g633: { mv: [4100, 3950, 3850, 3750, 3650, 3500, 3300, 3150], pct: [100, 80, 60, 40, 20, 10, 5, 0] },
};

export function percentFromVoltage(mv: number, cal: keyof typeof CALIBRATIONS): number {
  const { mv: v, pct: p } = CALIBRATIONS[cal];
  if (mv >= v[0]) return 100;
  if (mv <= v[v.length - 1]) return 0;
  for (let i = 1; i < v.length; i++) {
    if (mv >= v[i]) return Math.round(p[i] + ((mv - v[i]) / (v[i - 1] - v[i])) * (p[i - 1] - p[i]));
  }
  return 0;
}

/**
 * Folds one reply (input report data, without the report id) into the status; returns null for a report that isn't
 * an answer to SYNQ's reads.
 */
export function readReply(m: Model, reportId: number, d: Uint8Array, into: Status): Status | null {
  switch (m.family) {
    case "ss-nova7": {
      if (reportId !== 0 || d[0] !== 0xb0 || d.length < 6) return null;
      if (d[3] === 0x00) return { ...into, connected: false, battery: null, charging: null };
      const raw = d[2];
      const battery = m.battery === "levels" ? Math.round((Math.min(raw, 4) / 4) * 100) : Math.min(raw, 100);
      return { ...into, connected: true, battery, charging: d[3] === 0x01 || d[3] === 0x02, chatmix: { game: Math.min(d[4], 100), chat: Math.min(d[5], 100) } };
    }
    case "logi-g535":
    case "logi-gpro":
    case "logi-g633": {
      if (reportId !== 0x11 || d[0] !== HIDPP) return null;
      const read = statusRequests(m.family)[0].data;
      if (d[1] === 0xff) return { ...into, connected: false, battery: null, charging: null };
      if (d[1] !== read[1] || d[2] !== read[2]) return null;
      const mv = (d[3] << 8) | d[4];
      return { ...into, connected: true, battery: percentFromVoltage(mv, m.calibration ?? "gpro"), charging: d[5] === 0x03, estimated: true };
    }
    case "hyperx-cloud2w": {
      if (reportId !== 6 || d[0] !== 0xff || d[1] !== 0xbb) return null;
      if (d[2] === 0x02) return { ...into, connected: true, battery: Math.min(d[6], 100) };
      if (d[2] === 0x03) return { ...into, charging: d[3] === 1 };
      if (d[2] === 0x07) return { ...into, autoOff: d[3] };
      return null;
    }
  }
}
