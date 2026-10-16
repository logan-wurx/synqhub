// MonsGeek / Akko magnetic keyboards: USB identities, the vendor collection, and the model table keyed
// by the id the board reports (command 0x8F). Data only.
//
// The USB product id is shared by dozens of models (3151:5030 alone covers FUN60 Pro/Max/Ultra, M1/M2/M3
// V5, Akko MOD007 V5 HE ...), so SYNQ never picks a model, a command set or a tier from the PID: the
// session asks the board (0x8F dev id) and looks it up here. Unknown dev ids are read-only.
//
// Where the rows come from (each row lists its sources):
//   FCC       shybruh/FightingControlCenter-FCC app/src/devices/ry-catalog.json, GPL-3.0, generated
//             2026-10-10 from MonsGeek's web driver: profiles, factory key positions (keyMask), lighting
//             class (top speed, rainbow / fixed-colour nibbles), travel limits.
//   SHARKFIN  dniminenn/sharkfin app/src-tauri/data/devices.json + led-flags.vendor.json, GPL-3.0-or-later:
//             command family (gen2 / yc500), USB ids, profiles; used to cross-check FCC.
//   WEB       app.monsgeek.com js/index.dc20bdb4.js (read 2026-10-13, documentation only, no code copied):
//             device records (layer count, travelSetting, deBounce) and the WebHID filter list (which
//             USB ids the vendor app offers 8 kHz polling on: `reportRate: 8e3`).
// A scratch script joined the three; where they disagree the row says so in `notes` (profile counts:
// the web driver wins; USB ids: FCC + web driver win; lighting nibble on 4211/4212: FCC + current web
// driver win over sharkfin's older vendor snapshot, and SYNQ refuses colour-mode changes there).
//
// Tiers: "experimental" = in the vendor's own RY5088 class list (FCC) and gen2 in sharkfin, never tested
// by SYNQ on hardware: reads always, writes only behind the session's allowWrites() and unit checks.
// "readOnly" = everything else (YC3121 boards, ids without a vendor class, unknown ids).

import type { Channel, DeviceEntry, KeyboardCaps, NumRange, Source, SupportTier } from "../local-kb.ts";
import type { Family, LightClass } from "./protocol.ts";
import { POLL_CODE_HZ } from "./protocol.ts";

/** Vendor collection: usage page 0xFFFF, usage 2 (USB interface 2), feature report id 0, 64 bytes. [FCC][SF][WEB filters] */
export const MONSGEEK_CHANNEL: Channel = { usagePage: 0xffff, usage: 0x02, transport: "feature", reportId: 0, length: 64 };

export const VID = { royuan: 0x3151, akko: 0x38ee, monsgeekJp: 0x39ab } as const;

/** Wired USB ids SYNQ opens (bridge allowances are built from this). */
export const MONSGEEK_USB: readonly { vendorId: number; productIds: readonly number[]; note: string }[] = [
  {
    vendorId: VID.royuan,
    productIds: [0x5030, 0x5029, 0x502d, 0x502f, 0x502e, 0x4035],
    note: "RongYuan VID shared by MonsGeek and Akko. 5030/5029/502D/502F/502E: RY5088 (gen2) HE boards; 4035: YC3121 (yc500) HE boards, read-only. Model from the 0x8F dev id.",
  },
  { vendorId: VID.akko, productIds: [0x0001, 0x0009, 0x0040], note: "Newer MonsGeek/Akko RY5088 boards (FUN60 Ultra TMR, FUN68 ISO, FUN87 HE, M1 V5 TMR, Akko V5 HE). Model from the 0x8F dev id." },
  { vendorId: VID.monsgeekJp, productIds: [0x9016], note: "MonsGeek FUN60 Pro (dev id 4294) and FUN60 Pro JP (4180). Not in the vendor's WebHID filter list; sharkfin's udev rule covers 39AB." },
];

/** 2.4 GHz receivers seen for these boards. Detected only; SYNQ doesn't relay through them. */
export const MONSGEEK_RECEIVERS: readonly { vendorId: number; productId: number; note: string; source: Source }[] = [
  { vendorId: 0x3151, productId: 0x5026, note: "FUN60 Pro 2.4 GHz receiver (1 kHz)", source: { kind: "open-source", ref: "Lightning-13/monsgeek-rgb README + app.monsgeek.com filter (dongle, reportRate 1e3)", license: "MIT" } },
  { vendorId: 0x3151, productId: 0x503a, note: "M1 V5 HE 2.4 GHz (the vendor's filter list types it 'mouse')", source: { kind: "community-doc", ref: "echtzeit-solutions/monsgeek-akko-linux README (docs only) + app.monsgeek.com filter" } },
  { vendorId: 0x3151, productId: 0x5038, note: "8 kHz receiver", source: { kind: "configurator-js", ref: "app.monsgeek.com filter (dongle, reportRate 8e3)" } },
  { vendorId: 0x3151, productId: 0x4011, note: "YC3121-era receiver", source: { kind: "open-source", ref: "sharkfin docs/PROTOCOL.md (2.4 GHz receiver)", license: "GPL-3.0-or-later" } },
];

const FCC: Source = { kind: "open-source", ref: "FCC app/src/devices/ry-catalog.json (built 2026-10-10 from app.monsgeek.com)", license: "GPL-3.0" };
const SHARKFIN: Source = { kind: "open-source", ref: "sharkfin app/src-tauri/data/devices.json", license: "GPL-3.0-or-later" };
const WEB: Source = { kind: "configurator-js", ref: "app.monsgeek.com js/index.dc20bdb4.js device list + HID filters (2026-10-13, docs only)" };

/** Lighting classes: top speed, rainbow nibble, fixed-colour nibble. [FCC lights[] / WEB DAZZLE, NORMAL, MAXSPEED] */
export const L478: LightClass = { maxSpeed: 4, rainbow: 7, fixed: 8 };
export const L487: LightClass = { maxSpeed: 4, rainbow: 8, fixed: 7 };
export const L378: LightClass = { maxSpeed: 3, rainbow: 7, fixed: 8 };
/** yc500: speed wire 1..5 (host 0 -> wire 5) [SF]; rainbow 7 / fixed 8 on these three boards [SF led-flags.vendor.json]. Read-only. */
export const LYC: LightClass = { maxSpeed: 5, rainbow: 7, fixed: 8 };
const LIGHT_DISPUTE_M1TMR = "FCC and the current web driver (class T8 extends DAZZLE 7 / NORMAL 8) say rainbow 7, fixed 8; sharkfin's vendor snapshot says rainbow 8, fixed 7.";

export interface TravelLimits {
  min?: number;
  max?: number;
  step?: number;
  rtMin?: number;
  rtMax?: number;
  deadMax?: number;
}

export interface MonsGeekModel {
  /** Model id from 0x8F (u32 at bytes 1..4). */
  devId: number;
  name: string;
  brand: "MonsGeek" | "Akko";
  /** Vendor's internal (firmware) name: ry5088_* = RY5088, yc3121_* = YC3121. */
  internal: string;
  family: Family;
  /** USB ids this model shows up as. */
  usb: readonly (readonly [number, number])[];
  tier: SupportTier;
  tierWhy?: string;
  /** Onboard profiles (the vendor record's `layer`). */
  profiles: number;
  /** 128-bit mask of matrix positions with a factory key, hex, bit p = byte p >> 3, bit p & 7. [FCC] */
  keyMask?: string;
  keys?: number;
  light?: LightClass;
  /** Sources disagree on the lighting nibbles: colour-mode writes are refused. */
  lightDisputed?: string;
  /** Vendor travelSetting where the record has one (mm). */
  travel?: TravelLimits;
  /** The vendor app offers polling (up to 8 kHz) on this USB id, when firmware >= 0x400. [WEB isSupportReportRate] */
  polling8k: boolean;
  /** The vendor shows a debounce setting (0..max ms) only when the record has `deBounce`. */
  debounceMax?: number;
  sources: readonly Source[];
  notes?: string;
}

export const MONSGEEK_MODELS: readonly MonsGeekModel[] = [
  { devId: 2299, name: "FUN60", brand: "MonsGeek", internal: "ry5088_fun60_nolight_1k_005", family: "gen2", usb: [[0x3151, 0x502e]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9ee7fbb60b0000000000", keys: 61, light: L478, polling8k: false, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2304, name: "FUN60 PRO", brand: "MonsGeek", internal: "ry5088_akko_fun60pro_1m_8k", family: "gen2", usb: [[0x3151, 0x502d]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9ee7fbb60b0000000000", keys: 61, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2305, name: "FUN60 PRO", brand: "MonsGeek", internal: "ry5088_fun60pro_8k_002", family: "gen2", usb: [[0x3151, 0x502f]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9ee7fbb60b0000000000", keys: 61, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2464, name: "FUN60 PRO", brand: "MonsGeek", internal: "ry5088_fun60pro_8k_dm", family: "gen2", usb: [[0x3151, 0x502d]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9ee7fbb60b0000000000", keys: 61, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2600, name: "FUN60 PRO", brand: "MonsGeek", internal: "ry5088_akko_fun60_1m_8k", family: "gen2", usb: [[0x3151, 0x5029]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9ee7fbb60b0000000000", keys: 61, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2785, name: "FUN60 PRO", brand: "MonsGeek", internal: "ry5088_akko_fun60_3m_8k_1k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9ee7fbb60b0000000000", keys: 61, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 3722, name: "FUN60 PRO ISO", brand: "MonsGeek", internal: "ry5088_akko_fun60_b_uk_3m_8k_1k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "bee7fb9ee77b9ee7fbbe0a0000000000", keys: 62, light: L478, travel: { min: 0.1, max: 3.3, step: 0.01, rtMin: 0.01, rtMax: 2, deadMax: 1 }, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 4294, name: "FUN60 PRO", brand: "MonsGeek", internal: "ry5088_akko_fun60_d_1m_8k", family: "gen2", usb: [[0x39ab, 0x9016]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9ee7fbb60b0000000000", keys: 61, light: L478, polling8k: false, sources: [FCC, WEB] },
  { devId: 4180, name: "FUN60 Pro JP", brand: "MonsGeek", internal: "ry5088_akko_fun60_pro_jp_8k", family: "gen2", usb: [[0x39ab, 0x9016]], tier: "experimental", profiles: 4, keyMask: "beebfb9ee7f99eeffbbe0f0000000000", keys: 65, light: L478, travel: { min: 0.1, max: 3.3, step: 0.01, rtMin: 0.01, rtMax: 2 }, polling8k: false, sources: [FCC, WEB] },
  { devId: 2306, name: "FUN60 MAX", brand: "MonsGeek", internal: "ry5088_fun60max_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9ee7fbb60b0000000000", keys: 61, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 3299, name: "FUN60 MAX", brand: "MonsGeek", internal: "ry5088_akko_fun60max_3m_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9ee7fbb60b0000000000", keys: 61, light: L478, travel: { min: 0.1, max: 3.4, step: 0.01, rtMin: 0.01, rtMax: 2.5, deadMax: 1 }, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 3906, name: "FUN60 MAX", brand: "MonsGeek", internal: "ry5088_fun60maxc_3m_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9ee7fbb60b0000000000", keys: 61, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2307, name: "FUN60 Ultra", brand: "MonsGeek", internal: "ry5088_fun60max2_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9eeffbb6030000000000", keys: 61, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2352, name: "FUN60 Ultra", brand: "MonsGeek", internal: "ry5088_fun60ultra_8k_dm_dfn4", family: "gen2", usb: [[0x3151, 0x5029]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9eeffbb6030000000000", keys: 61, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2381, name: "FUN60 Ultra", brand: "MonsGeek", internal: "ry5088_fun60ultra_8k_dm", family: "gen2", usb: [[0x3151, 0x502d]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9ee7fbb60b0000000000", keys: 61, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2387, name: "FUN60 Ultra", brand: "MonsGeek", internal: "ry5088_fun60ultra_8k_2049e", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "bee3fb9ee77b9ee7fbb60b0000000000", keys: 61, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 3853, name: "FUN60 Ultra TMR", brand: "MonsGeek", internal: "ry5088_akko_fun60_ultra_tmr_3m_8k_8k", family: "gen2", usb: [[0x38ee, 0x0001]], tier: "experimental", profiles: 4, keyMask: "beeb7b9ee77b9eeffbb6030000000000", keys: 61, light: L487, travel: { min: 0.1, max: 3.4, step: 0.005 }, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2811, name: "FUN68", brand: "MonsGeek", internal: "ry5088_akko_fun68_8k_8k_3m", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "beeb7b9ee77b9eeffbb6ef0300000000", keys: 68, light: L478, travel: { min: 0.1, max: 3.3, step: 0.005 }, polling8k: true, sources: [FCC, SHARKFIN, WEB], notes: "profiles: FCC 4, sharkfin 2, web 4" },
  { devId: 3091, name: "FUN68", brand: "MonsGeek", internal: "ry5088_akko_fun68_8k_1m", family: "gen2", usb: [[0x3151, 0x5029]], tier: "experimental", profiles: 4, keyMask: "beeb7b9ee77b9eeffbb6ef0300000000", keys: 68, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 3429, name: "FUN68 ISO", brand: "MonsGeek", internal: "ry5088_fun68_uk_dm_8k", family: "gen2", usb: [[0x38ee, 0x0009]], tier: "experimental", profiles: 4, keyMask: "beef7b9ee77b9eeffbbeee0300000000", keys: 69, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2648, name: "FUN75", brand: "MonsGeek", internal: "ry5088_mgk_fun75_8k_dm", family: "gen2", usb: [[0x3151, 0x502d]], tier: "experimental", profiles: 4, keyMask: "fff7ffdff77fdfffffffff0300000000", keys: 85, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 4088, name: "FUN87 HE", brand: "MonsGeek", internal: "ry5088_akko_fun87_he_1m_8k", family: "gen2", usb: [[0x38ee, 0x0001]], tier: "experimental", profiles: 4, keyMask: "fffb7fdff77fdffffff7fbff00000000", keys: 88, light: L478, travel: { min: 0.1, max: 3.3, step: 0.005, rtMin: 0.005 }, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2819, name: "M1 V5 HE", brand: "MonsGeek", internal: "ry5088_akko_m1v5_3m_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "fffb7fdff77fdffffff7ef1f03000000", keys: 87, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2247, name: "M1 V5 TMR", brand: "MonsGeek", internal: "ry5088_m1w_v5_soc_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "fff3ffdff77fdffffff7ef1f03000000", keys: 87, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2536, name: "M1 V5 TMR", brand: "MonsGeek", internal: "ry5088_akko_m1_v5_uk_3m_pan1080_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "fff7ffdff77fdfffffffee1f03000000", keys: 88, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2679, name: "M1 V5 TMR", brand: "MonsGeek", internal: "ry5088_m1v5heb_soc_8k_dfn4", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "fff3ffdff77fdffffff7ef1f03000000", keys: 87, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2949, name: "M1 V5 TMR", brand: "MonsGeek", internal: "ry5088_akko_m1v5he_3m_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 2, keyMask: "fffb7fdff77fdffffff7ef1f03000000", keys: 87, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB], notes: "profiles: FCC 2, sharkfin 4, web 2" },
  { devId: 4212, name: "M1 V5 TMR", brand: "MonsGeek", internal: "ry5088_001_akko_m1_tmr_iso_c_3m_8k_8k_ry1033_dfn4_v400h", family: "gen2", usb: [[0x38ee, 0x0040]], tier: "experimental", profiles: 4, keyMask: "fffb7fdff77fdffffff7ef1f03000000", keys: 87, light: L478, travel: { min: 0.1, max: 3.3, step: 0.01, deadMax: 1 }, lightDisputed: LIGHT_DISPUTE_M1TMR, polling8k: true, sources: [FCC, SHARKFIN, WEB], notes: "profiles: FCC 4, sharkfin 2, web 4" },
  { devId: 4158, name: "M1 V5 TMR ISO", brand: "MonsGeek", internal: "ry5088_akko_m1v5_tmr_iso_3m_8k_8k", family: "gen2", usb: [[0x38ee, 0x0001]], tier: "experimental", profiles: 2, keyMask: "ffff7fdff77fdfffffffee1f03000000", keys: 88, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 4211, name: "M1 V5 TMR ISO", brand: "MonsGeek", internal: "ry5088_001_akko_m1_tmr_iso_b_3m_8k_8k_ry1033_dfn4_v400h", family: "gen2", usb: [[0x38ee, 0x0040]], tier: "experimental", profiles: 4, keyMask: "ffff7fdff77fdfffffffee1f03000000", keys: 88, light: L478, travel: { min: 0.1, max: 3.3, step: 0.01, deadMax: 1 }, lightDisputed: LIGHT_DISPUTE_M1TMR, polling8k: true, sources: [FCC, SHARKFIN, WEB], notes: "profiles: FCC 4, sharkfin 2, web 4" },
  { devId: 2601, name: "M2 V5", brand: "MonsGeek", internal: "ry5088_akko_mjk_m2v5_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "ffff7fdff77fdff7ffffffffff090000", keys: 100, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2845, name: "M2 V5 HE", brand: "MonsGeek", internal: "ry5088_akko_m2v5_3m_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "fffb7fdff77ffffffff7ff7fdf050000", keys: 98, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB], notes: "profiles: FCC 4, sharkfin 2, web 4" },
  { devId: 2585, name: "M3 V5", brand: "MonsGeek", internal: "ry5088_akko_mjk_m3v5_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "ffff7fdff77fdff7ffbf7bde27000000", keys: 89, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2874, name: "M3 V5 HE", brand: "MonsGeek", internal: "ry5088_akko_m3v5_3m_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 2, keyMask: "fffb7fdff77fdfffffb7fbff00000000", keys: 87, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2721, name: "Verve68", brand: "MonsGeek", internal: "ry5088_veekosk0038_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "beeb7b9ee77b9eeffbb6ef0300000000", keys: 68, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 3099, name: "Verve68", brand: "MonsGeek", internal: "ry5088_akko_k0038_1m_8k_3099", family: "gen2", usb: [[0x3151, 0x5029]], tier: "experimental", profiles: 4, keyMask: "beeb7b9ee77b9eeffbb6ef0300000000", keys: 68, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 3463, name: "Verve68", brand: "MonsGeek", internal: "ry5088_akko_k0038_1m_8k", family: "gen2", usb: [[0x3151, 0x5029]], tier: "experimental", profiles: 4, keyMask: "beeb7b9ee77b9eeffbb6ef0300000000", keys: 68, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 3460, name: "Verve68T", brand: "MonsGeek", internal: "ry5088_akko_k0038b_3m_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "beeb7b9ee77b9eeffbb6ef0300000000", keys: 68, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 3269, name: "Shine68", brand: "MonsGeek", internal: "ry5088_akko_veekosshine68_3m_8k", family: "gen2", usb: [[0x38ee, 0x0001]], tier: "experimental", profiles: 4, keyMask: "beeb7b9ee77b9eeffbb6ef0300000000", keys: 68, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 3270, name: "Shine68", brand: "MonsGeek", internal: "ry5088_akko_veekosshine68_1m_8k", family: "gen2", usb: [[0x38ee, 0x0009]], tier: "experimental", profiles: 2, keyMask: "beeb7b9ee77b9eeffbb6ef0300000000", keys: 68, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2807, name: "5075B V2 HE", brand: "Akko", internal: "ry5088_akko5075b_3m_8k_1k_1049es", family: "gen2", usb: [[0x3151, 0x502f]], tier: "experimental", profiles: 4, keyMask: "fffb7fdff77fdffffff7ef1f03000000", keys: 87, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 3129, name: "5075S HE", brand: "Akko", internal: "ry5088_akko_5075bv2he_1m", family: "gen2", usb: [[0x3151, 0x502d]], tier: "experimental", profiles: 4, keyMask: "fffb7fdff77fdffffff7ef1f03000000", keys: 87, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 3131, name: "5087S V2 HE", brand: "Akko", internal: "ry5088_akko_5087bv2he_1m_8k", family: "gen2", usb: [[0x3151, 0x5029]], tier: "experimental", profiles: 4, keyMask: "fffb7fdff77fdffffff7fbff00000000", keys: 88, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2453, name: "MOD007 V5 HE", brand: "Akko", internal: "ry5088_mod007v5he_soc_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "ffff7fdfff7ddff7ffa7ef1f07000000", keys: 86, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2839, name: "MOD007 V5 HE", brand: "Akko", internal: "ry5088_akko_mod007_v5_3m_8k_8k", family: "gen2", usb: [[0x3151, 0x502f]], tier: "experimental", profiles: 4, keyMask: "fffb7fdff77fdff7ffb7ef1f07000000", keys: 86, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2683, name: "MOD007S V3-HE", brand: "Akko", internal: "ry5088_mod007sv3he_dm_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "fff3ffdff77fdffffff7ef1f00000000", keys: 85, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB], notes: "sharkfin lists 3151:5029" },
  { devId: 2704, name: "MOD007S V3-HE UK", brand: "Akko", internal: "ry5088_mod007sv3he_uk_8k_dm", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "fff7ffdff77fdfffffffee1f00000000", keys: 86, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB], notes: "sharkfin lists 3151:5029" },
  { devId: 2782, name: "TAC75 HE", brand: "Akko", internal: "ry5088_akko_tac75he_8k_dm", family: "gen2", usb: [[0x3151, 0x502d]], tier: "experimental", profiles: 2, keyMask: "fff7ffdff77fdfffffffff0300000000", keys: 85, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2743, name: "RAY68", brand: "Akko", internal: "ry5088_k0026_8k_1k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "beeb7b9ee77b9eeffbb6ef0300000000", keys: 68, light: L378, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2924, name: "RAY68", brand: "Akko", internal: "ry5088_k0026_8k_dm", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "beeb7b9ee77b9eeffbb6ef0300000000", keys: 68, light: L378, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2619, name: "Gem02", brand: "Akko", internal: "ry5088_mjk_gem02_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "fffb7fdff77fdff7fff7fffedf7f0200", keys: 102, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2881, name: "K0039", brand: "Akko", internal: "ry5088_k0039_8k_1k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "ffff7fdff77fdffffffffffe00000000", keys: 90, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2903, name: "Mineral01", brand: "Akko", internal: "ry5088_mjk_mineral01_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "fffb7fdff77fdff7fff7ff0200000000", keys: 81, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2581, name: "Mineral02", brand: "Akko", internal: "ry5088_mjk_mineral02_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "fffb7fdff77fdff7fff7fffedf7f0200", keys: 102, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2885, name: "Mineral02", brand: "Akko", internal: "ry5088_mjk_mineral02_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "experimental", profiles: 4, keyMask: "fffb7fdff77fdff7fff7fffedf7f0200", keys: 102, light: L478, polling8k: true, sources: [FCC, SHARKFIN, WEB] },
  { devId: 2829, name: "5087 V3 HE", brand: "Akko", internal: "ry5088_akko_5087b_3m_8k_1k", family: "gen2", usb: [[0x3151, 0x502f]], tier: "readOnly", tierWhy: "Not in MonsGeek's web driver class list (no FCC entry): no vendor matrix or lighting constants to check writes against.", profiles: 4, polling8k: true, sources: [SHARKFIN, WEB] },
  { devId: 3113, name: "MOD007 V5 HE", brand: "Akko", internal: "ry5088_akko_mod007_v5_he_1m_8k", family: "gen2", usb: [[0x3151, 0x5029]], tier: "readOnly", tierWhy: "Not in MonsGeek's web driver class list (no FCC entry): no vendor matrix or lighting constants to check writes against.", profiles: 4, polling8k: true, sources: [SHARKFIN, WEB] },
  { devId: 2871, name: "MOD007B V3-HE(US)", brand: "Akko", internal: "ry5088_mod007sv3he_8k_soc", family: "gen2", usb: [[0x3151, 0x5030]], tier: "readOnly", tierWhy: "Only in sharkfin's registry (Akko driver data): no vendor matrix or lighting constants to check writes against.", profiles: 4, polling8k: true, sources: [SHARKFIN] },
  { devId: 2872, name: "MOD007B V3-HE(UK)", brand: "Akko", internal: "ry5088_mod007sv3he_uk_8k_soc", family: "gen2", usb: [[0x3151, 0x5030]], tier: "readOnly", tierWhy: "Only in sharkfin's registry (Akko driver data): no vendor matrix or lighting constants to check writes against.", profiles: 4, polling8k: true, sources: [SHARKFIN] },
  { devId: 4030, name: "MOD007B V3-HE(UK)", brand: "Akko", internal: "ry5088_mod007sv3he_uk_8k_soc", family: "gen2", usb: [[0x3151, 0x5030]], tier: "readOnly", tierWhy: "Only in sharkfin's registry (Akko driver data): no vendor matrix or lighting constants to check writes against.", profiles: 4, polling8k: true, sources: [SHARKFIN] },
  { devId: 3163, name: "MOD68", brand: "Akko", internal: "ry5088_akko_mod68_8k_1m", family: "gen2", usb: [[0x3151, 0x5029]], tier: "readOnly", tierWhy: "Only in sharkfin's registry (Akko driver data): no vendor matrix or lighting constants to check writes against.", profiles: 4, polling8k: true, sources: [SHARKFIN] },
  { devId: 3779, name: "5075 V5 HE", brand: "Akko", internal: "ry5088_akko_5075_v5_he_3m_8k_8k", family: "gen2", usb: [[0x38ee, 0x0001]], tier: "readOnly", tierWhy: "Listed by app.monsgeek.com but no device class in its RY5088 chunk; sharkfin has not established the command set.", profiles: 4, polling8k: true, sources: [SHARKFIN, WEB], notes: "sharkfin family 'unknown'" },
  { devId: 3773, name: "5108 V5 HE", brand: "Akko", internal: "ry5088_akko_5108_v5_he_3m_8k_8k", family: "gen2", usb: [[0x38ee, 0x0001]], tier: "readOnly", tierWhy: "Listed by app.monsgeek.com but no device class in its RY5088 chunk; sharkfin has not established the command set.", profiles: 4, polling8k: true, sources: [SHARKFIN, WEB], notes: "sharkfin family 'unknown'" },
  { devId: 3869, name: "5108 V5 HE", brand: "Akko", internal: "ry5088_akko_5108_v5_he_b_3m_8k_8k", family: "gen2", usb: [[0x38ee, 0x0001]], tier: "readOnly", tierWhy: "Listed by app.monsgeek.com but no device class in its RY5088 chunk; sharkfin has not established the command set.", profiles: 4, travel: { min: 0.1, max: 3.3, step: 0.001 }, polling8k: true, sources: [SHARKFIN, WEB], notes: "sharkfin family 'unknown'" },
  { devId: 3300, name: "M1 V5 HE", brand: "Akko", internal: "ry5088_m1v5he_3m_8k_8k", family: "gen2", usb: [[0x3151, 0x5030]], tier: "readOnly", tierWhy: "Only in sharkfin's registry, command set not established.", profiles: 2, polling8k: true, sources: [SHARKFIN], notes: "sharkfin family 'unknown'" },
  { devId: 1604, name: "M1W HE", brand: "MonsGeek", internal: "yc3121_m1whes_hall_8k", family: "yc500", usb: [[0x3151, 0x4035]], tier: "readOnly", tierWhy: "YiChip YC3121 board: yc500 command set (opcodes collide with RY5088 writes). SYNQ reads it only.", profiles: 5, light: LYC, polling8k: false, sources: [SHARKFIN, WEB] },
  { devId: 1674, name: "MG75S HE", brand: "MonsGeek", internal: "yc3121_mg75s_hes_dm_hall_8k", family: "yc500", usb: [[0x3151, 0x4035]], tier: "readOnly", tierWhy: "YiChip YC3121 board: yc500 command set (opcodes collide with RY5088 writes). SYNQ reads it only.", profiles: 4, light: LYC, polling8k: false, debounceMax: 10, sources: [SHARKFIN, WEB] },
  { devId: 1637, name: "MOD007B HE PC", brand: "Akko", internal: "yc3121_mod007bv3he_soc_8k", family: "yc500", usb: [[0x3151, 0x4035]], tier: "readOnly", tierWhy: "YiChip YC3121 board: yc500 command set (opcodes collide with RY5088 writes). SYNQ reads it only.", profiles: 5, light: LYC, polling8k: false, sources: [SHARKFIN] },
];

const BY_DEV_ID = new Map<number, MonsGeekModel>(MONSGEEK_MODELS.map((m) => [m.devId, m]));
export const modelByDevId = (devId: number): MonsGeekModel | undefined => BY_DEV_ID.get(devId);

/** Matrix positions with a factory key (from keyMask), or null when the row has no mask. */
export function keyPositions(model: MonsGeekModel | undefined | null): number[] | null {
  if (!model?.keyMask) return null;
  const out: number[] = [];
  for (let p = 0; p < 128; p++) if ((parseInt(model.keyMask.slice((p >> 3) * 2, (p >> 3) * 2 + 2), 16) >> (p & 7)) & 1) out.push(p);
  return out;
}

const familyLabel = (vid: number, pid: number) => {
  const names = [...new Set(MONSGEEK_MODELS.filter((m) => m.usb.some(([v, p]) => v === vid && p === pid)).map((m) => `${m.brand} ${m.name}`))];
  return names.length ? names.join(" / ") : "MonsGeek / Akko keyboard";
};

/**
 * One entry per USB id. Several models share each id, so `model` lists the models known on it and
 * `tier` is the best case: the session drops to read-only unless the 0x8F dev id is a known
 * experimental model.
 */
export const MONSGEEK_DEVICES: readonly DeviceEntry[] = [
  ...MONSGEEK_USB.flatMap((u) =>
    u.productIds.map(
      (pid): DeviceEntry => ({
        vendor: "MonsGeek / Akko",
        vendorId: u.vendorId,
        productId: pid,
        model: familyLabel(u.vendorId, pid),
        kind: "keyboard",
        connection: "usb",
        channel: MONSGEEK_CHANNEL,
        tier: pid === 0x4035 ? "readOnly" : "experimental",
        sources: [FCC, SHARKFIN, WEB],
        notes: pid === 0x4035 ? "YiChip YC3121 boards (yc500 command set): read-only." : "Model, command set and tier come from the 0x8F dev id; unknown ids are read-only.",
      }),
    ),
  ),
  ...MONSGEEK_RECEIVERS.map(
    (r): DeviceEntry => ({
      vendor: "MonsGeek / Akko",
      vendorId: r.vendorId,
      productId: r.productId,
      model: r.note,
      kind: "receiver",
      connection: "receiver",
      channel: MONSGEEK_CHANNEL,
      tier: "detectOnly",
      sources: [r.source],
      notes: "Receivers relay the settings channel through their own opcodes (0xF6/0xF7/0xFC) and not every one relays at all [SF]. SYNQ asks for the cable.",
    }),
  ),
];

/** Defaults when the vendor record has no travelSetting (vendor default max 3.3 mm, RT 0.01..2 mm). [WEB maxTravel][FCC] */
export const DEFAULT_TRAVEL: Required<TravelLimits> = { min: 0.1, max: 3.3, step: 0.01, rtMin: 0.01, rtMax: 2, deadMax: 1 };

export function travelLimits(model: MonsGeekModel | null | undefined): Required<TravelLimits> {
  return { ...DEFAULT_TRAVEL, ...(model?.travel ?? {}) };
}

/**
 * Capabilities in mm for a model at the detected unit size. `pollingAllowed` is the runtime result of
 * the vendor rule (8 kHz USB id and firmware >= 0x400).
 */
export function capsFor(model: MonsGeekModel | null | undefined, unitMm: number, pollingAllowed: boolean): KeyboardCaps {
  const t = travelLimits(model);
  const step = model?.family === "yc500" ? 0.1 : unitMm;
  const range = (min: number, max: number): NumRange => ({ min: Math.max(min, step), max, step });
  return {
    analog: {
      perKey: true,
      actuation: range(t.min, t.max),
      release: range(t.min, t.max),
      rapidTrigger: { press: range(t.rtMin, t.rtMax), release: range(t.rtMin, t.rtMax), perKey: true },
      deadzones: { bottom: { min: 0, max: t.deadMax, step } },
      socd: { modes: ["last"], maxPairs: 64 },
      dks: { slots: 4 },
      modTap: { holdMs: { min: 10, max: 2550, step: 10 } },
      toggleKey: true,
      liveDepth: model?.family !== "yc500",
    },
    keymap: { layers: 1, remap: true },
    lighting: { effects: true, perKey: false, brightness: { min: 0, max: 4, step: 1 } },
    polling: model?.polling8k && pollingAllowed ? [...POLL_CODE_HZ].reverse() : undefined,
    profiles: model?.profiles,
    debounceMs: model?.debounceMax ? { min: 0, max: model.debounceMax, step: 1 } : undefined,
  };
}
