// MAGIC-REFINER X68 HE (USB 2E3C:C365) settings protocol, as spoken by its official configurator,
// the WebHID app at https://www.illumipc.com/ ("iLLumiPC"). Read from the site's public JavaScript on
// 2026-10-12: the current version (v2, /app.js, SDK "1.1.9 build 20261008") and the old version
// (v1, /js/agreement.min.js + wmIndex.min.js, obfuscated; decoded statically). Both send the same
// bytes. No keyboard was connected and nothing was sent to any device. Evidence for every constant:
// docs/keyboard-x68he/PROTOCOL.md.
//
// This replaces an earlier guess (RongYuan RY5088 feature reports on FFFF:0002 from qmk.top). That
// guess was wrong for this keyboard: illumipc talks to usage page 0xFF1B, usage 0x91 with OUTPUT and
// INPUT reports, report id 1, 63 data bytes, and no checksum.
//
// Labels in the doc comments:
//   [v2] / [v1]  byte layout taken from the named illumipc function (code, never captured on hardware)
//   [inferred]   follows from how illumipc uses the bytes, but nothing confirms it on hardware
//
// Pure encode/decode only: no transport, no imports, erasable TypeScript (node runs the tests
// directly). Every frame must pass checkFrame() before it reaches the device; the session does that,
// and the Rust bridge repeats the same allowlist.

export const X68 = {
  vendorId: 0x2e3c,
  productId: 0xc365,
  /** The configurator collection (illumipc filter `usagePage: 65307, usage: 145`). [v2][v1] */
  usagePage: 0xff1b,
  usage: 0x91,
  /** `device.sendReport(1, data)` and input reports with reportId 1. [v2 JQ.send / _onInputReport] */
  reportId: 1,
  /** Every request is `new Uint8Array(63)`. [v2][v1 `new ArrayBuffer(0x3f)`] */
  length: 63,
} as const;

/** First byte of every frame. [v2 consts tC..Oc, plus literals] */
export const CMD = {
  status: 0x01,
  sideLightModes: 0x02,
  light: 0x07,
  sideLight: 0x08,
  customLight: 0x09,
  lightModes: 0x0a,
  bootloader: 0x0b,
  product: 0x0d,
  fnEditable: 0x0e,
  device: 0x14,
  serial: 0x15,
  musicRhythm: 0x17,
  keymap: 0x18,
  macro: 0x19,
  trigger: 0x21,
  advanced: 0x22,
  adc: 0x23,
  socd: 0x24,
  switches: 0x25,
  deadband: 0x26,
} as const;

/** Byte 5 of a 0x21 frame. Writes of per-key triggers put the trigger mode there instead. [v2 XA, NA, WA] */
export const TRIG = {
  testStart: 0x02,
  testStop: 0x03,
  config: 0x04,
  readKey: 0x05,
  resetAll: 0x06,
  calibrateKey: 0x07,
  calibrateAll: 0x08,
  pollRate: 0x09,
  anyKeyStart: 0x0f,
  anyKeyStop: 0x10,
  profileQuery: 0x11,
  profileSet: 0x12,
} as const;

/** Per-key trigger modes illumipc writes (TriggerPanel `ye`): 0 fixed, 12 rapid trigger, 13 rapid trigger with separate press/release. 1 is only read (older firmware). [v2][v1] */
export const TRIGGER_MODE = { normal: 0, rapidLegacy: 1, rapid: 12, rapidSplit: 13 } as const;
export const WRITABLE_TRIGGER_MODES: readonly number[] = [TRIGGER_MODE.normal, TRIGGER_MODE.rapid, TRIGGER_MODE.rapidSplit];

/** Polling-rate codes (frequencyMap {1:1000,2:2000,4:4000,8:8000}). Writing one restarts the keyboard. [v2 NA] */
export const POLL_CODE_TO_HZ: Record<number, number> = { 1: 1000, 2: 2000, 4: 4000, 8: 8000 };
export const POLL_HZ = [1000, 2000, 4000, 8000] as const;

export const COLS = 22;
export const ROWS = 6;
/** Matrix slots: 6 rows x 22 columns (index = row * 22 + col). [v2 `maxKeys = 132`] */
export const SLOTS = 132;
export const KEYMAP_BYTES = SLOTS * 4; // 528
export const KEYMAP_CHUNK = 56; // [v2 _sendKeyData]
export const KEYMAP_PAGES = Math.ceil(KEYMAP_BYTES / KEYMAP_CHUNK); // 10, last page 24 bytes
export const KEYMAP_READ_PER_PAGE = 14; // [v2 _fetchAllKeyData: index = 14 * page + i]
export const DEADBAND_BYTES = SLOTS * 2; // 264
export const DEADBAND_CHUNK = 58;
export const DEADBAND_PAGES = Math.ceil(DEADBAND_BYTES / DEADBAND_CHUNK); // 5
export const DEADBAND_READ_PER_PAGE = 29;
export const ADVANCED_SLOTS = 40; // [v2 YA.maxSlots, sendAdvancedKeys loop]
export const SOCD_SLOTS = 20; // [v2 LA.maxSocdSlots]
export const MACRO_SLOTS = 10; // [v2 KA.totalSlots]
export const MACRO_PAGES = 5; // [v2 KA.totalPages]
export const PROFILE_COUNT = 5; // Default + Profiles 1-4 [v2 `cs = 5`]

export type Frame = Uint8Array;

export const rowOf = (index: number) => Math.floor(index / COLS);
export const colOf = (index: number) => index % COLS;
export const indexAt = (row: number, col: number) => row * COLS + col;

function frame(bytes: Record<number, number>): Frame {
  const f = new Uint8Array(X68.length);
  for (const [k, v] of Object.entries(bytes)) {
    const i = Number(k);
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`Byte ${i} out of range: ${v}`);
    f[i] = v;
  }
  return f;
}

function checkInt(name: string, v: number, min: number, max: number) {
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be a whole number from ${min} to ${max} (got ${v}).`);
}

const pageOf = (r: Uint8Array) => (r[2] << 8) | r[3];

export const hex = (b: ArrayLike<number>, trim = true) => {
  let end = b.length;
  if (trim) while (end > 1 && b[end - 1] === 0) end--;
  return Array.from({ length: end }, (_, i) => (b[i] ?? 0).toString(16).padStart(2, "0")).join(" ");
};

// =============================================================================================
// Reads (requests)
// =============================================================================================

/** Status / capability flags; also illumipc's heartbeat and "storing to flash" probe. [v2 WA.initSupport] */
export const encodeStatus = () => frame({ 0: CMD.status });
/** Product string "a,b,c,d,PRODUCT,FIRMWARE,..." (page 0 of a multi-page reply). [v2 WA.initProduct] */
export const encodeProduct = () => frame({ 0: CMD.product });
/** Serial number text. [v2 SA._readSerialNumber] */
export const encodeSerial = () => frame({ 0: CMD.serial });
/** Bitmap of keys whose Fn-layer entry may be edited. [v2 Nl.getFnKey] */
export const encodeFnEditable = () => frame({ 0: CMD.fnEditable });
/** Lighting modes the keyboard has, plus max brightness and speed. [v2 IA.getLightingList] */
export const encodeLightModes = (side = false) => frame({ 0: side ? CMD.sideLightModes : CMD.lightModes, 1: 0 });
/** Current lighting settings. [v2 IA.getConfig] */
export const encodeLightRead = (side = false) => frame({ 0: side ? CMD.sideLight : CMD.light, 1: 1 });
/** Whole layer keymap: pages 0..9 of 14 entries. layer default = 0x80, fn = 0x82. [v2 Nl.getLayoutKey] */
export const encodeKeymapRead = (layer: Layer) => frame({ 0: CMD.keymap, 1: layer === "default" ? 0x80 : 0x82 });
/** One macro slot (pages 0..4). [v2 KA.initMacroValue] */
export const encodeMacroRead = (slot: number) => {
  checkInt("Macro slot", slot, 0, MACRO_SLOTS - 1);
  return frame({ 0: CMD.macro, 1: 0x80 + slot });
};
/** All 40 advanced-key slots, one page each. [v2 YA.initAdvancedKeys] */
export const encodeAdvancedRead = () => frame({ 0: CMD.advanced, 1: 0x80 });
/** SOCD pairs: 2 pages of 10. [v2 LA.initSocdData] */
export const encodeSocdListRead = () => frame({ 0: CMD.socd, 1: 0x01 });
/** SOCD master switch. [v2 LA.initSocdPower] */
export const encodeSocdPowerRead = () => frame({ 0: CMD.socd, 1: 0x02 });
/** Travel unit, max and min travel. [v2 XA.getTriggerConfig] */
export const encodeTriggerConfigRead = () => frame({ 0: CMD.trigger, 4: 24, 5: TRIG.config });
/** One key's trigger settings, addressed by matrix row and column. [v2 XA.readTriggerData] */
export const encodeKeyTriggerRead = (index: number) => {
  checkInt("Key index", index, 0, SLOTS - 1);
  return frame({ 0: CMD.trigger, 4: 24, 5: TRIG.readKey, 6: rowOf(index), 7: colOf(index) });
};
/** [v2 NA.readPollRate] */
export const encodePollRateRead = () => frame({ 0: CMD.trigger, 4: 1, 5: TRIG.pollRate });
/** Onboard profile index; keyboards without onboard profiles stay silent. [v2 WA.initPresetProfileIndex] */
export const encodeProfileQuery = () => frame({ 0: CMD.trigger, 5: TRIG.profileQuery });
/** Switch types the keyboard knows. [v2 PA.getAxisList] */
export const encodeSwitchListRead = () => frame({ 0: CMD.switches, 1: 0x00 });
/** Switch type per key (pages 0..2 of 58). [v2 PA.initKeyAxis] */
export const encodeKeySwitchRead = () => frame({ 0: CMD.switches, 1: 0x02 });
/** Top/bottom dead zone per key (pages 0..4 of 29 keys). [v2 XA.readDeadBand; v1 calls the same bytes resetDeadBand] */
export const encodeDeadbandRead = () => frame({ 0: CMD.deadband, 1: 0x00 });

// =============================================================================================
// Writes
// =============================================================================================

export interface TriggerSetting {
  mode: number;
  /** Actuation point in travel units (see TriggerConfig.unitMm). */
  travel: number;
  /** Rapid-trigger press sensitivity in travel units ("interval1"). */
  press: number;
  /** Rapid-trigger release sensitivity in travel units ("interval2"). */
  release: number;
}

/**
 * Per-key trigger write for every key in `indexes` (all get the same values). Layout from
 * XA.setTrigger: byte 4 = 24, then 31 bytes at offset 5: mode, a 22-byte column bitmap (bit = row),
 * travel lo, travel lo, press lo, release lo, travel hi, travel hi, press hi, release hi. [v2][v1 setAnyTriggerValue]
 */
export function encodeTriggerWrite(t: TriggerSetting, indexes: number[]): Frame {
  if (!WRITABLE_TRIGGER_MODES.includes(t.mode)) throw new Error(`Trigger mode ${t.mode} isn't one SYNQ writes.`);
  checkInt("Travel", t.travel, 1, 0xffff);
  checkInt("Press sensitivity", t.press, 0, 0xffff);
  checkInt("Release sensitivity", t.release, 0, 0xffff);
  if (!indexes.length) throw new Error("No keys to write.");
  const f = frame({ 0: CMD.trigger, 4: 24, 5: t.mode });
  for (const i of indexes) {
    checkInt("Key index", i, 0, SLOTS - 1);
    f[6 + colOf(i)] |= 1 << rowOf(i);
  }
  f[28] = t.travel & 0xff;
  f[29] = t.travel & 0xff;
  f[30] = t.press & 0xff;
  f[31] = t.release & 0xff;
  f[32] = (t.travel >> 8) & 0xff;
  f[33] = (t.travel >> 8) & 0xff;
  f[34] = (t.press >> 8) & 0xff;
  f[35] = (t.release >> 8) & 0xff;
  return f;
}

/** Groups keys with identical settings into as few frames as possible (as illumipc does). */
export function encodeTriggerWrites(changes: (TriggerSetting & { index: number })[]): Frame[] {
  const groups = new Map<string, { t: TriggerSetting; indexes: number[] }>();
  for (const c of changes) {
    const key = `${c.mode}_${c.travel}_${c.press}_${c.release}`;
    const g = groups.get(key) ?? { t: { mode: c.mode, travel: c.travel, press: c.press, release: c.release }, indexes: [] };
    g.indexes.push(c.index);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => encodeTriggerWrite(g.t, g.indexes));
}

/** Polling rate. The keyboard restarts and re-enumerates afterwards. [v2 NA.setPollRate] */
export function encodePollRateWrite(hz: number): Frame {
  const code = Number(Object.keys(POLL_CODE_TO_HZ).find((c) => POLL_CODE_TO_HZ[Number(c)] === hz));
  if (!code) throw new Error(`Unsupported polling rate ${hz} Hz.`);
  return frame({ 0: CMD.trigger, 5: TRIG.pollRate, 6: 1, 7: code });
}

/** Switch onboard profile 0..4 (0 = Default). Only for keyboards that answer the profile query. [v2 WA.setProfileIndex] */
export function encodeProfileSet(index: number): Frame {
  checkInt("Profile", index, 0, PROFILE_COUNT - 1);
  return frame({ 0: CMD.trigger, 5: TRIG.profileSet, 6: index });
}

export interface LightConfig {
  mode: number;
  brightness: number;
  speed: number;
  color: Rgb;
  background: Rgb;
  direction: number;
  /** 1 = rainbow ("full colour"). */
  fullColor: number;
  /** 0 = lights on, 1 = off (illumipc openLighting/closedLighting). */
  power: number;
  timer: number;
}
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Lighting settings: byte 4 = 14, then mode, brightness, speed, fg RGB, bg RGB, direction, full colour, power, timer. [v2 IA.setConfig] */
export function encodeLightWrite(c: LightConfig, side = false): Frame {
  for (const [k, v] of Object.entries({ mode: c.mode, brightness: c.brightness, speed: c.speed, direction: c.direction, fullColor: c.fullColor, power: c.power, timer: c.timer }))
    checkInt(k, v, 0, 255);
  return frame({
    0: side ? CMD.sideLight : CMD.light,
    4: 14,
    5: c.mode,
    6: c.brightness,
    7: c.speed,
    8: c.color.r,
    9: c.color.g,
    10: c.color.b,
    11: c.background.r,
    12: c.background.g,
    13: c.background.b,
    14: c.direction,
    15: c.fullColor,
    16: c.power,
    17: c.timer,
  });
}

export type Layer = "default" | "fn";

/** Full 528-byte layer table in 10 pages of 56: [0x18, layer (0 default / 2 fn), page hi, page lo, len, data]. [v2 Nl._sendKeyData] */
export function encodeKeymapWrite(layer: Layer, table: Uint8Array): Frame[] {
  if (table.length !== KEYMAP_BYTES) throw new Error(`Keymap table must be ${KEYMAP_BYTES} bytes.`);
  const frames: Frame[] = [];
  for (let page = 0; page < KEYMAP_PAGES; page++) {
    const start = page * KEYMAP_CHUNK;
    const chunk = table.subarray(start, Math.min(start + KEYMAP_CHUNK, KEYMAP_BYTES));
    const f = frame({ 0: CMD.keymap, 1: layer === "default" ? 0 : 2, 2: (page >> 8) & 0xff, 3: page & 0xff, 4: chunk.length });
    f.set(chunk, 5);
    frames.push(f);
  }
  return frames;
}

export interface SocdEntry {
  /** Slot 0..19. */
  index: number;
  /** 0 last input wins, 1 key 1 wins, 2 key 2 wins, 3 neutral (later key only cancels). [v2 SOCD panel options] */
  mode: number;
  /** HID usages of the two keys (A = 0x04, D = 0x07). */
  key1: number;
  key2: number;
  /** 1 = active (illumipc writes 1; reads drop 0 and 7/FF/FF/FF). */
  state?: number;
}

/**
 * SOCD table, 2 pages of 10 four-byte entries [state, mode, key1, key2]: [0x24, 0x00, 0, page, 40, ...].
 * Entries are packed in list order (slot numbers are positions), exactly like LA.sendSocdData. On
 * non-US layouts illumipc writes HID 0x32 when the second key is 0x31; `nonUs` mirrors that. [v2]
 */
export function encodeSocdWrite(entries: SocdEntry[], nonUs = false): Frame[] {
  if (entries.length > SOCD_SLOTS) throw new Error(`At most ${SOCD_SLOTS} SOCD pairs.`);
  const frames: Frame[] = [];
  for (let page = 0; page < 2; page++) {
    const f = frame({ 0: CMD.socd, 1: 0x00, 2: 0, 3: page, 4: 40 });
    for (let slot = 0; slot < 10; slot++) {
      const e = entries[page * 10 + slot];
      if (!e) continue;
      checkInt("SOCD mode", e.mode, 0, 3);
      checkInt("SOCD key 1", e.key1, 1, 255);
      checkInt("SOCD key 2", e.key2, 1, 255);
      const o = 5 + slot * 4;
      f[o] = e.state ?? 1;
      f[o + 1] = e.mode;
      f[o + 2] = e.key1;
      f[o + 3] = nonUs && e.key2 === 0x31 ? 0x32 : e.key2;
    }
    frames.push(f);
  }
  return frames;
}

/** SOCD master switch. [v2 LA.setSocdPower] */
export const encodeSocdPowerWrite = (on: boolean) => frame({ 0: CMD.socd, 1: 0x03, 4: 1, 5: on ? 1 : 0 });

/** Raw 4-byte keymap entry exactly as the keyboard stores it (see ACTION below). */
export type RawAction = [number, number, number, number];

export type AdvancedType = "DKS" | "MT" | "TGL" | "RS" | "RKRT" | "MDS";
export const ADVANCED_TYPE_CODE: Record<AdvancedType, number> = { DKS: 1, MT: 2, TGL: 3, RS: 4, RKRT: 5, MDS: 6 };
const ADVANCED_TYPE_BY_CODE: Record<number, AdvancedType> = { 1: "DKS", 2: "MT", 3: "TGL", 4: "RS", 5: "RKRT", 6: "MDS" };

/**
 * One advanced-key slot. Field meanings from YA.sendAdvancedKeys / parseAdvancedKey [v2]:
 *   DKS  travelPoints (4, in 0.1 mm), actions (4 raw), steps (16 = 4 actions x 4 columns:
 *        press, bottom out, release from bottom, back to top; 0 none, 1 tap, 2 hold, 3 end of hold) [inferred names]
 *   MT   actions [tap, hold], duration in 10 ms units (illumipc default 15 = 150 ms)
 *   TGL  actions [key]
 *   RS   actions [key A, key B], keyIndexes [A, B] (matrix positions)
 *   RKRT actions [main key, extra command on release]
 *   MDS  hidKeys (up to 6 HID usages), duration (16-bit), mdsMode (0 after delay, 1 when all detected)
 */
export interface AdvancedEntry {
  slot: number;
  type: AdvancedType;
  actions: RawAction[];
  travelPoints?: number[];
  steps?: number[];
  duration?: number;
  keyIndexes?: number[];
  hidKeys?: number[];
  mdsMode?: number;
}

/** Writes one advanced slot: [0x22, slot, 0, 0, 50, type, ...]; an empty entry (type 0) clears the slot. [v2 YA.sendAdvancedKeys] */
export function encodeAdvancedWrite(slot: number, e: AdvancedEntry | null): Frame {
  checkInt("Advanced slot", slot, 0, ADVANCED_SLOTS - 1);
  const f = frame({ 0: CMD.advanced, 1: slot, 4: 50 });
  if (!e) return f;
  const type = ADVANCED_TYPE_CODE[e.type];
  if (!type) throw new Error(`Unknown advanced key type ${e.type}.`);
  f[5] = type;
  const put = (o: number, a: RawAction | undefined) => {
    if (!a) return;
    a.forEach((v) => checkInt("Action byte", v, 0, 255));
    f.set(a, o);
  };
  if (e.type === "DKS") {
    const tp = e.travelPoints ?? [0, 0, 0, 0];
    tp.forEach((v, i) => {
      checkInt("DKS travel point", v, 0, 255);
      f[6 + i] = v;
    });
    for (let r = 0; r < 4; r++) {
      put(10 + r * 8, e.actions[r] ?? [0, 0, 0, 0]);
      for (let c = 0; c < 4; c++) {
        const s = e.steps?.[r * 4 + c] ?? 0;
        checkInt("DKS step", s, 0, 3);
        f[14 + r * 8 + c] = s;
      }
    }
  } else if (e.type === "MT") {
    // Stored hold first: bytes 6..9 = actions[1], 10..13 = actions[0], 14 = duration.
    put(6, e.actions[1]);
    put(10, e.actions[0]);
    checkInt("MT duration", e.duration ?? 0, 1, 255);
    f[14] = e.duration ?? 0;
  } else if (e.type === "TGL") {
    put(6, e.actions[0]);
  } else if (e.type === "RS") {
    const [a, b] = e.keyIndexes ?? [];
    if (a === undefined || b === undefined) throw new Error("RS needs two keys.");
    put(6, e.actions[0]);
    f[10] = rowOf(a);
    f[11] = colOf(a);
    put(12, e.actions[1]);
    f[16] = rowOf(b);
    f[17] = colOf(b);
  } else if (e.type === "RKRT") {
    put(6, e.actions[0]);
    put(12, e.actions[1]);
  } else if (e.type === "MDS") {
    const keys = (e.hidKeys ?? []).filter((k) => k).slice(0, 6);
    const d = e.duration ?? 0;
    checkInt("MDS duration", d, 0, 0xffff);
    f[6] = (d >> 8) & 0xff;
    f[7] = d & 0xff;
    f[8] = e.mdsMode ?? 0;
    f[9] = keys.length;
    keys.forEach((k, i) => (f[10 + i] = k));
  }
  return f;
}

/** Whole 40-slot table, as illumipc always sends it. */
export function encodeAdvancedTable(entries: AdvancedEntry[]): Frame[] {
  const bySlot = new Map(entries.map((e) => [e.slot, e]));
  if (bySlot.size !== entries.length) throw new Error("Two advanced keys share a slot.");
  return Array.from({ length: ADVANCED_SLOTS }, (_, s) => encodeAdvancedWrite(s, bySlot.get(s) ?? null));
}

/** Per-key dead zones in travel units, 264-byte table in 5 pages of 58: [0x26, 0x01, 0, page, len, ...]. [v2 XA.setDeadBand] */
export function encodeDeadbandWrite(table: Uint8Array): Frame[] {
  if (table.length !== DEADBAND_BYTES) throw new Error(`Dead-zone table must be ${DEADBAND_BYTES} bytes.`);
  const frames: Frame[] = [];
  for (let page = 0; page < DEADBAND_PAGES; page++) {
    const start = page * DEADBAND_CHUNK;
    const chunk = table.subarray(start, Math.min(start + DEADBAND_CHUNK, DEADBAND_BYTES));
    const f = frame({ 0: CMD.deadband, 1: 0x01, 2: (page >> 8) & 0xff, 3: page & 0xff, 4: chunk.length });
    f.set(chunk, 5);
    frames.push(f);
  }
  return frames;
}

export interface DeviceSettings {
  lockWin: boolean;
  lockShiftTab: boolean;
  lockAltF4: boolean;
  lockAltTab: boolean;
  superPerformance: boolean;
  sixKey: boolean;
}

/**
 * Win-lock / 6-key / "super performance" ("Other Settings"): [0x14, 0, 0, 0, 1, 0, ...]. Byte 5 MUST
 * stay 0: the same frame with byte 5 = 1 is illumipc's resetKeyboard (Factory Reset). [v2 WA._writeDeviceSettings]
 */
export function encodeDeviceSettings(s: DeviceSettings): Frame {
  return frame({
    0: CMD.device,
    4: 1,
    5: 0,
    12: s.lockWin ? 1 : 0,
    13: s.lockShiftTab ? 1 : 0,
    14: s.lockAltF4 ? 1 : 0,
    15: s.lockAltTab ? 1 : 0,
    17: s.superPerformance ? 1 : 0,
    18: s.sixKey ? 1 : 0,
  });
}

// =============================================================================================
// Safety: every outgoing frame is classified; only allowlisted ones may be sent.
// =============================================================================================

export interface FrameCheck {
  ok: boolean;
  name: string;
  access: "read" | "write" | "blocked";
  reason?: string;
}

const ok = (name: string, access: "read" | "write"): FrameCheck => ({ ok: true, name, access });
const blocked = (name: string, reason: string): FrameCheck => ({ ok: false, name, access: "blocked", reason });
const notListed = (f: Uint8Array): FrameCheck => blocked("unknown", `${hex(f.subarray(0, 8))}... isn't on SYNQ's list of known-safe X68 HE commands.`);
const restZero = (f: Uint8Array, from: number) => f.subarray(from).every((b) => b === 0);

/**
 * Hard blocklist + allowlist. Blocked for good (SYNQ must never send them): bootloader/firmware
 * (0x0B), keyboard reset / factory reset (0x14 with byte 5 != 0, 0x14 sub 2), gamepad mode (0x14 sub 3,
 * changes the USB identity), reset of all triggers (0x21/06), switch calibration (0x21/07, 08, 0F, 10),
 * the raw ADC stream (0x23) and per-key switch-type writes (0x25/01, part of Switch Calibration).
 * Everything else must match a known read or write shape exactly.
 */
export function checkFrame(f: Uint8Array): FrameCheck {
  if (f.length !== X68.length) return blocked("bad length", `Frames are ${X68.length} bytes (got ${f.length}).`);
  const [c, b1, b2, b3, b4, b5, b6, b7] = f;
  switch (c) {
    case CMD.bootloader:
      return blocked("bootloader", "Bootloader / firmware update is never sent by SYNQ.");
    case CMD.adc:
      return blocked("adc", "Raw sensor (ADC) streaming belongs to switch calibration, which SYNQ doesn't do.");
    case CMD.device:
      if (b1 === 0x02) return blocked("factory reset", "0x14 02 is illumipc's factoryReset (same bytes as its sleep-timer read). Never sent.");
      if (b1 === 0x03) return blocked("gamepad mode", "Gamepad mode changes the keyboard's USB identity. Not sent.");
      if (b1 === 0x00 && b5 !== 0) return blocked("keyboard reset", "0x14 with byte 5 set resets the keyboard (Factory Reset). Never sent.");
      if (b1 === 0x00 && b2 === 0 && b3 === 0 && b4 === 1 && b5 === 0 && f.subarray(6, 12).every((x) => x === 0) && f[16] === 0 && restZero(f, 19) && [12, 13, 14, 15, 17, 18].every((i) => f[i] <= 1))
        return ok("device settings", "write");
      return notListed(f);
    case CMD.trigger: {
      if (b1 || b2 || b3) return notListed(f);
      if (b5 === TRIG.resetAll) return blocked("reset triggers", "Resetting every key's trigger is part of Factory Reset. Not sent.");
      if (b5 === TRIG.calibrateKey || b5 === TRIG.calibrateAll || b5 === TRIG.anyKeyStart || b5 === TRIG.anyKeyStop)
        return blocked("calibration", "Switch calibration isn't something SYNQ does (yet). Not sent.");
      if (b4 === 24 && b5 === TRIG.config && restZero(f, 6)) return ok("trigger config", "read");
      if (b4 === 24 && b5 === TRIG.readKey && b6 < ROWS && b7 < COLS && restZero(f, 8)) return ok("key trigger", "read");
      if (b4 === 1 && b5 === TRIG.pollRate && restZero(f, 6)) return ok("poll rate", "read");
      if (b4 === 0 && b5 === TRIG.pollRate && b6 === 1 && POLL_CODE_TO_HZ[b7] && restZero(f, 8)) return ok("poll rate", "write");
      if (b4 === 0 && b5 === TRIG.profileQuery && restZero(f, 6)) return ok("profile query", "read");
      if (b4 === 0 && b5 === TRIG.profileSet && b6 < PROFILE_COUNT && restZero(f, 7)) return ok("profile", "write");
      if (b4 === 24 && WRITABLE_TRIGGER_MODES.includes(b5) && restZero(f, 36)) {
        // Bitmap bytes 6..27: only rows 0..5 exist.
        if (f.subarray(6, 28).some((x) => x > 0x3f) || f.subarray(6, 28).every((x) => x === 0)) return notListed(f);
        if (f[28] !== f[29] || f[32] !== f[33] || (f[28] | (f[32] << 8)) === 0) return notListed(f);
        return ok("key triggers", "write");
      }
      return notListed(f);
    }
    case CMD.status:
    case CMD.product:
    case CMD.serial:
    case CMD.fnEditable:
      return restZero(f, 1) ? ok(c === CMD.status ? "status" : c === CMD.product ? "product" : c === CMD.serial ? "serial" : "fn editable", "read") : notListed(f);
    case CMD.lightModes:
    case CMD.sideLightModes:
      return restZero(f, 1) ? ok("light modes", "read") : notListed(f);
    case CMD.light:
    case CMD.sideLight:
      if (b1 === 1 && restZero(f, 2)) return ok("lighting", "read");
      if (b1 === 0 && b2 === 0 && b3 === 0 && b4 === 14 && restZero(f, 18)) return ok("lighting", "write");
      return notListed(f);
    case CMD.customLight:
      if ((b1 === 0x20 || b1 === 0x80 || b1 === 0x81) && restZero(f, 2)) return ok("custom light", "read");
      return notListed(f);
    case CMD.keymap:
      if ((b1 === 0x80 || b1 === 0x82) && restZero(f, 2)) return ok("keymap", "read");
      if ((b1 === 0 || b1 === 2) && b2 === 0 && b3 < KEYMAP_PAGES) {
        const len = b3 === KEYMAP_PAGES - 1 ? KEYMAP_BYTES - KEYMAP_CHUNK * (KEYMAP_PAGES - 1) : KEYMAP_CHUNK;
        if (b4 === len && restZero(f, 5 + len)) return ok("keymap", "write");
      }
      return notListed(f);
    case CMD.macro:
      if (b1 >= 0x80 && b1 < 0x80 + MACRO_SLOTS && restZero(f, 2)) return ok("macro", "read");
      return notListed(f);
    case CMD.advanced:
      if (b1 === 0x80 && restZero(f, 2)) return ok("advanced keys", "read");
      if (b1 < ADVANCED_SLOTS && b2 === 0 && b3 === 0 && b4 === 50 && b5 <= 6 && restZero(f, 42)) return ok("advanced key", "write");
      return notListed(f);
    case CMD.socd:
      if ((b1 === 1 || b1 === 2) && restZero(f, 2)) return ok("socd", "read");
      if (b1 === 0 && b2 === 0 && b3 < 2 && b4 === 40 && restZero(f, 45)) return ok("socd", "write");
      if (b1 === 3 && b2 === 0 && b3 === 0 && b4 === 1 && b5 <= 1 && restZero(f, 6)) return ok("socd switch", "write");
      return notListed(f);
    case CMD.switches:
      if (b1 === 1) return blocked("switch type", "Per-key switch types belong to Switch Calibration. Not sent.");
      if ((b1 === 0 || b1 === 2) && restZero(f, 2)) return ok("switches", "read");
      return notListed(f);
    case CMD.deadband:
      if (b1 === 0 && restZero(f, 2)) return ok("dead zones", "read");
      if (b1 === 1 && b2 === 0 && b3 < DEADBAND_PAGES) {
        const len = b3 === DEADBAND_PAGES - 1 ? DEADBAND_BYTES - DEADBAND_CHUNK * (DEADBAND_PAGES - 1) : DEADBAND_CHUNK;
        if (b4 === len && restZero(f, 5 + len)) return ok("dead zones", "write");
      }
      return notListed(f);
    default:
      return notListed(f);
  }
}

/** Throws unless the frame is allowlisted. */
export function assertSendable(f: Uint8Array): FrameCheck {
  const r = checkFrame(f);
  if (!r.ok) throw new Error(`Blocked: ${r.reason}`);
  return r;
}

// =============================================================================================
// Replies: how to recognise them, and decoders
// =============================================================================================

export interface ReplyRule {
  /** True for a reply (or page) belonging to the request. */
  match: (r: Uint8Array) => boolean;
  /** For multi-page reads: true when this page completes the read. */
  last?: (r: Uint8Array) => boolean;
}

/** How illumipc matches the reply to each read (SA.execute matchers). Writes are fire-and-forget. */
export function replyRule(request: Uint8Array): ReplyRule | null {
  const [c, b1, , , b4, b5, b6, b7] = request;
  switch (c) {
    case CMD.status:
    case CMD.serial:
    case CMD.fnEditable:
    case CMD.lightModes:
    case CMD.sideLightModes:
      return { match: (r) => r[0] === c };
    case CMD.light:
    case CMD.sideLight:
      return b1 === 1 ? { match: (r) => r[0] === c } : null;
    case CMD.product:
      return { match: (r) => r[0] === c, last: (r) => pageOf(r) >= 1 };
    case CMD.keymap:
      return b1 >= 0x80 ? { match: (r) => r[0] === c && r[1] === b1, last: (r) => pageOf(r) >= KEYMAP_PAGES - 1 } : null;
    case CMD.macro:
      return b1 >= 0x80 ? { match: (r) => r[0] === c && r[1] === b1, last: (r) => pageOf(r) >= MACRO_PAGES - 1 || r[4] === 0 } : null;
    case CMD.advanced:
      return b1 === 0x80 ? { match: (r) => r[0] === c && r[1] === 0x80, last: (r) => pageOf(r) >= ADVANCED_SLOTS - 1 } : null;
    case CMD.socd:
      if (b1 === 1) return { match: (r) => r[0] === c && r[1] === 1, last: (r) => pageOf(r) >= 1 };
      if (b1 === 2) return { match: (r) => r[0] === c && r[1] === 2 };
      return null;
    case CMD.switches:
      if (b1 === 0) return { match: (r) => r[0] === c && r[1] === 0 };
      if (b1 === 2) return { match: (r) => r[0] === c && r[1] === 2, last: (r) => pageOf(r) >= 2 };
      return null;
    case CMD.deadband:
      return b1 === 0 ? { match: (r) => r[0] === c && r[1] === 0, last: (r) => pageOf(r) >= DEADBAND_PAGES - 1 } : null;
    case CMD.trigger:
      if (b4 === 24 && b5 === TRIG.config) return { match: (r) => r[0] === c && r[5] === TRIG.config };
      if (b4 === 24 && b5 === TRIG.readKey)
        return { match: (r) => r[0] === c && r[5] === TRIG.readKey && (r.length < 17 || (r[15] === b6 && r[16] === b7) || (r[15] === 0 && r[16] === 0)) };
      if (b4 === 1 && b5 === TRIG.pollRate) return { match: (r) => r[0] === c && r[5] === TRIG.pollRate };
      if (b5 === TRIG.profileQuery) return { match: (r) => r[0] === c && r[5] === TRIG.profileQuery };
      return null;
    default:
      return null;
  }
}

/** Keymap-page writes are acknowledged with [0x18, 0 or layer]; illumipc waits up to 100 ms, then goes on. [v2 Nl._sendKeyData] */
export function writeAck(request: Uint8Array): ((r: Uint8Array) => boolean) | null {
  const [c, b1] = request;
  if (c === CMD.keymap && b1 < 0x80) return (r) => r[0] === c && (r[1] === 0 || r[1] === b1);
  if (c === CMD.deadband && b1 === 1) return (r) => r[0] === c && r[1] === 1;
  if (c === CMD.socd && b1 === 0) return (r) => r[0] === c && r[1] === 0;
  return null;
}

export interface Status {
  /** Bytes 5..22 of the reply (illumipc `supportData`). */
  support: number[];
  triMode: number;
  modeChange: number;
  flags: {
    lockKeyEnable: boolean;
    socd: boolean;
    superPerformanceSupported: boolean;
    superPerformance: boolean;
    anyKeyCalibration: boolean;
    customLight: boolean;
    moreSwitch: boolean;
    pollRate: boolean;
    deadBand: boolean;
    musicRhythm: boolean;
    reportKeySettings: boolean;
    allAnd6KeySwitch: boolean;
    highPrecision: boolean;
    lightPositionSwitch: boolean;
    gamePad: boolean;
    rs: boolean;
    rkrt: boolean;
    dksMouse: boolean;
    mds: boolean;
    travelPrecision: boolean;
    calibrated: boolean;
    musicRhythmOn: boolean;
    sixKeyMode: boolean;
    storing: boolean;
  };
  winLock: { lockWin: boolean; lockShiftTab: boolean; lockAltF4: boolean; lockAltTab: boolean };
}

const bit = (v: number, m: number) => (v & m) === m;

/** [v2 WA.initSupport / _Q case 1] */
export function decodeStatus(r: Uint8Array): Status {
  const n = Array.from(r.subarray(5, 23));
  while (n.length < 18) n.push(0);
  return {
    support: n,
    triMode: r[10] ?? 0,
    modeChange: r[1] ?? 0,
    flags: {
      lockKeyEnable: n[0] === 1,
      socd: n[9] === 1,
      superPerformanceSupported: n[10] === 1,
      superPerformance: n[11] === 1,
      anyKeyCalibration: bit(n[12], 0x01),
      customLight: bit(n[12], 0x02),
      moreSwitch: bit(n[12], 0x04),
      pollRate: bit(n[12], 0x08),
      deadBand: bit(n[12], 0x10),
      musicRhythm: bit(n[12], 0x20),
      reportKeySettings: bit(n[12], 0x40),
      allAnd6KeySwitch: bit(n[12], 0x80),
      highPrecision: bit(n[13], 0x01),
      lightPositionSwitch: bit(n[13], 0x02),
      gamePad: bit(n[13], 0x04),
      rs: bit(n[13], 0x08),
      rkrt: bit(n[13], 0x10),
      dksMouse: bit(n[13], 0x20),
      mds: bit(n[13], 0x40),
      travelPrecision: bit(n[13], 0x80),
      calibrated: n[14] === 1,
      musicRhythmOn: n[16] === 1,
      sixKeyMode: bit(n[17], 0x01),
      storing: bit(n[17], 0x02),
    },
    winLock: { lockWin: bit(n[15], 0x01), lockShiftTab: bit(n[15], 0x02), lockAltF4: bit(n[15], 0x04), lockAltTab: bit(n[15], 0x08) },
  };
}

/** True while the keyboard is still writing to flash (status byte 22 bit 1). [v2 Nl._queryStoringFlag] */
export const isStoring = (r: Uint8Array) => r[0] === CMD.status && bit(r[22] ?? 0, 0x02);

export interface ProductInfo {
  text: string;
  fields: string[];
  product: string;
  firmware: string;
}

const ascii = (b: Uint8Array) => Array.from(b, (x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : x === 0 ? "" : " ")).join("");

/** Page 0: byte 3 = 0 (page), byte 4 = length, then "f0,f1,f2,f3,PRODUCT,FIRMWARE,...". Firmware "V1_0_3" shows as 1.0.3. [v2 WA.initProduct] */
export function decodeProduct(pages: Uint8Array[]): ProductInfo {
  const p0 = pages.find((p) => pageOf(p) === 0) ?? pages[0];
  if (!p0) throw new Error("No product reply.");
  const len = Math.min(p0[4], p0.length - 5);
  const text = ascii(p0.subarray(5, 5 + len)).trim();
  const fields = text.split(",");
  const firmware = (fields[5] ?? "").replace(/V/g, "").replace(/_/g, ".").trim();
  return { text, fields, product: (fields[4] ?? "").trim(), firmware };
}

/** [v2 SA._readSerialNumber] */
export function decodeSerial(r: Uint8Array): string {
  const len = Math.min(r[4] || 32, r.length - 5);
  return ascii(r.subarray(5, 5 + len)).replace(/\s+$/, "").trim();
}

/** Column bytes, bit = row. [v2 Nl.getFnKey] */
export function decodeFnEditable(r: Uint8Array): number[] {
  const len = r[4];
  const out: number[] = [];
  for (let col = 0; col < len && col < COLS; col++) for (let row = 0; row < ROWS; row++) if ((r[5 + col] >> row) & 1) out.push(indexAt(row, col));
  return out.sort((a, b) => a - b);
}

export interface LightModes {
  modes: number[];
  maxBrightness: number;
  maxSpeed: number;
}

/** Payload: mode ids, then 4 trailing bytes ending [.., maxSpeed, maxBrightness]. [v2 IA.getLightingList] */
export function decodeLightModes(r: Uint8Array): LightModes {
  const len = r[4];
  const p = r.subarray(5, 5 + len);
  if (len < 4) return { modes: [], maxBrightness: 4, maxSpeed: 4 };
  return { modes: Array.from(p.subarray(0, len - 4)), maxBrightness: p[len - 1], maxSpeed: p[len - 2] };
}

/** [v2 IA.getConfig] */
export function decodeLight(r: Uint8Array): LightConfig {
  const p = r.subarray(5);
  return {
    mode: p[0],
    brightness: p[1],
    speed: p[2],
    color: { r: p[3], g: p[4], b: p[5] },
    background: { r: p[6], g: p[7], b: p[8] },
    direction: p[9],
    fullColor: p[10],
    power: p[11],
    timer: p[12],
  };
}

/** Rebuilds the 528-byte table from the read pages (14 entries per page). Returns which slots were seen. [v2 Nl._fetchAllKeyData] */
export function decodeKeymapPages(pages: Uint8Array[]): { table: Uint8Array; seen: number } {
  const table = new Uint8Array(KEYMAP_BYTES);
  let seen = 0;
  for (const p of pages) {
    const page = pageOf(p);
    const n = Math.floor(p[4] / 4);
    for (let i = 0; i < n; i++) {
      const slot = KEYMAP_READ_PER_PAGE * page + i;
      if (slot >= SLOTS) break;
      table.set(p.subarray(5 + i * 4, 9 + i * 4), slot * 4);
      seen++;
    }
  }
  return { table, seen };
}

export const actionAt = (table: Uint8Array, index: number): RawAction => [table[index * 4], table[index * 4 + 1], table[index * 4 + 2], table[index * 4 + 3]];
export function withAction(table: Uint8Array, index: number, a: RawAction): Uint8Array {
  checkInt("Key index", index, 0, SLOTS - 1);
  a.forEach((v) => checkInt("Action byte", v, 0, 255));
  const t = new Uint8Array(table);
  t.set(a, index * 4);
  return t;
}

export interface AdvancedPageResult {
  entries: AdvancedEntry[];
  seen: number;
}

/** One page per slot: byte 5 = type (0 empty). [v2 YA.parseAdvancedKey] */
export function decodeAdvancedPages(pages: Uint8Array[]): AdvancedPageResult {
  const entries: AdvancedEntry[] = [];
  const raw = (p: Uint8Array, o: number): RawAction => [p[o], p[o + 1], p[o + 2], p[o + 3]];
  let seen = 0;
  for (const p of pages) {
    if (p[1] !== 0x80) continue;
    seen++;
    const slot = pageOf(p);
    const type = ADVANCED_TYPE_BY_CODE[p[5]];
    if (!type || slot >= ADVANCED_SLOTS) continue;
    if (type === "DKS") {
      const actions: RawAction[] = [];
      const steps: number[] = [];
      for (let r = 0; r < 4; r++) {
        actions.push(raw(p, 10 + r * 8));
        for (let c = 0; c < 4; c++) steps.push(p[14 + r * 8 + c]);
      }
      entries.push({ slot, type, actions, steps, travelPoints: [p[6], p[7], p[8], p[9]] });
    } else if (type === "MT") entries.push({ slot, type, actions: [raw(p, 10), raw(p, 6)], duration: p[14] });
    else if (type === "TGL") entries.push({ slot, type, actions: [raw(p, 6)] });
    else if (type === "RS") entries.push({ slot, type, actions: [raw(p, 6), raw(p, 12)], keyIndexes: [indexAt(p[10], p[11]), indexAt(p[16], p[17])] });
    else if (type === "RKRT") entries.push({ slot, type, actions: [raw(p, 6), raw(p, 12)] });
    else if (type === "MDS") {
      const n = Math.min(p[9] || 0, 6);
      entries.push({ slot, type, actions: [], duration: (p[6] << 8) | p[7], mdsMode: p[8] || 0, hidKeys: Array.from(p.subarray(10, 10 + n)) });
    }
  }
  entries.sort((a, b) => a.slot - b.slot);
  return { entries, seen };
}

/** Pages of 10 x [state, mode, key1, key2]; skips state 0 and 7/FF/FF/FF. Slot = 10 * page + i. [v2 LA.initSocdData] */
export function decodeSocdPages(pages: Uint8Array[]): SocdEntry[] {
  const out: SocdEntry[] = [];
  for (const p of pages) {
    if (p[0] !== CMD.socd || p[1] !== 1) continue;
    const page = pageOf(p);
    for (let i = 0; i < 10; i++) {
      const o = 5 + i * 4;
      const [state, mode, key1, key2] = [p[o], p[o + 1], p[o + 2], p[o + 3]];
      if (state === 0 || (state === 7 && mode === 0xff && key1 === 0xff && key2 === 0xff)) continue;
      out.push({ index: page * 10 + i, state, mode, key1, key2 });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Payload [power, ?, ?, ?, key1, key2]. [v2 LA.initSocdPower] */
export function decodeSocdPower(r: Uint8Array): { on: boolean; key1: number; key2: number } {
  const p = r.subarray(5);
  return { on: p[0] === 1, key1: p[4] ?? 0, key2: p[5] ?? 0 };
}

export interface TriggerConfig {
  /** Millimetres per travel unit. */
  unitMm: number;
  maxUnits: number;
  minUnits: number;
  minMm: number;
  maxMm: number;
  /** Rapid-trigger sensitivity limits in mm (one unit to half the travel). */
  rtMinMm: number;
  rtMaxMm: number;
  highPrecision: boolean;
  raw: { unitRaw: number; quickUnitRaw: number; maxLo: number; maxHi: number; min: number };
}

/**
 * [v2 XA.getTriggerConfig, personal edition (type 0)]: unit = (byte7 || 10) / (highPrecision ? 1000 : 100) mm;
 * max = byte9 << 8 | byte6 units; min = byte10 units, or when 0: 1 for 0.1/0.08 mm units, 3 for 0.04 mm.
 */
export function decodeTriggerConfig(r: Uint8Array, highPrecision: boolean): TriggerConfig {
  const unitRaw = r[7] === 0 ? 10 : r[7];
  const div = highPrecision ? 1000 : 100;
  const unitMm = unitRaw / div;
  const maxUnits = (r[9] << 8) | r[6];
  let minUnits = r[10];
  if (minUnits === 0) minUnits = unitMm === 0.04 ? 3 : unitMm === 0.1 || unitMm === 0.08 ? 1 : 1;
  const round = (v: number) => Math.round(v * 10000) / 10000;
  const maxMm = round(maxUnits * unitMm);
  return {
    unitMm,
    maxUnits,
    minUnits,
    minMm: round(minUnits * unitMm),
    maxMm,
    rtMinMm: unitMm,
    rtMaxMm: round(Math.ceil(maxMm / 2 / unitMm) * unitMm),
    highPrecision,
    raw: { unitRaw, quickUnitRaw: r[8] === 0 ? 10 : r[8], maxLo: r[6], maxHi: r[9], min: r[10] },
  };
}

export interface KeyTrigger extends TriggerSetting {
  index: number;
}

/** [v2 XA.readTriggerData, type 0]: mode 6, travel 11<<8|7, press 13<<8|9, release 14<<8|10, row 15, col 16. */
export function decodeKeyTrigger(r: Uint8Array, index: number): KeyTrigger {
  return { index, mode: r[6], travel: (r[11] << 8) | r[7], press: (r[13] << 8) | r[9], release: (r[14] << 8) | r[10] };
}

/** [v2 NA.readPollRate] */
export const decodePollRate = (r: Uint8Array): { code: number; hz: number | null } => ({ code: r[6], hz: POLL_CODE_TO_HZ[r[6]] ?? null });

/** [v2 _Q case 33/17]: byte 6 = index, byte 7 = 1 when answering a query (else the keyboard switched on its own). */
export const decodeProfileIndex = (r: Uint8Array) => ({ index: r[6], fromQuery: r[7] === 1 });

/** [v2 PA.getAxisList] */
export function decodeSwitchList(r: Uint8Array): number[] {
  const p = r.subarray(5, 5 + r[4]);
  if (p.length < 2) return [];
  const n = (p[0] << 8) | p[1];
  return Array.from(p.subarray(2, 2 + n)).filter((x) => x > 0);
}

/** [v2 PA.initKeyAxis]: 58 keys per page. */
export function decodeKeySwitchPages(pages: Uint8Array[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const p of pages) {
    if (p[0] !== CMD.switches || p[1] !== 2) continue;
    const page = pageOf(p);
    for (let i = 0; i < p[4]; i++) {
      const idx = page * 58 + i;
      if (idx < SLOTS) out[idx] = p[5 + i];
    }
  }
  return out;
}

/** [v2 XA.readDeadBand]: 29 keys per page, [top, bottom] in travel units. Returns the 264-byte table. */
export function decodeDeadbandPages(pages: Uint8Array[]): { table: Uint8Array; seen: number } {
  const table = new Uint8Array(DEADBAND_BYTES);
  let seen = 0;
  for (const p of pages) {
    if (p[0] !== CMD.deadband || p[1] !== 0) continue;
    const page = pageOf(p);
    const len = p[4];
    for (let i = 0; i < DEADBAND_READ_PER_PAGE && 2 * i + 1 < len; i++) {
      const idx = page * DEADBAND_READ_PER_PAGE + i;
      if (idx >= SLOTS) break;
      table[idx * 2] = p[5 + 2 * i];
      table[idx * 2 + 1] = p[6 + 2 * i];
      seen++;
    }
  }
  return { table, seen };
}

/** Macro slot header (page 0): [index|copy bit, type, ?, len, count hi, count lo, ?, ?]. Step bodies are not decoded. [v2 KA._processMacroSlot] */
export function decodeMacroHeader(pages: Uint8Array[]): { macroIndex: number; type: number; count: number; stepBytes: number } | null {
  const p0 = pages.find((p) => pageOf(p) === 0);
  if (!p0) return null;
  const h = p0.subarray(5, 13);
  if (h[3] < 8) return null;
  return { macroIndex: h[0] & 0x7f, type: h[1], count: (h[4] << 8) | h[5], stepBytes: h[3] };
}

// =============================================================================================
// Key actions (what a keymap entry sends)
// =============================================================================================

/** Action type byte (entry byte 0). Values from illumipc's fixed key table (config/keys.json, hex) and SDK. */
export const ACTION = {
  key: 0x00,
  fn: 0x01,
  lightList: 0x02,
  lightBrightness: 0x03,
  lightSpeed: 0x04,
  lightDirection: 0x05,
  lightColor: 0x06,
  media: 0x07,
  macro: 0x10,
  lock: 0x11,
  mouse: 0x12,
  combo: 0x13,
  advanced: 0x17,
  gamepadClassic: 0x18,
  gamepadXbox: 0x19,
} as const;

export const FN_ACTION: RawAction = [ACTION.fn, 0xfa, 0, 0];
export const keyAction = (hid: number): RawAction => [ACTION.key, hid, 0, 0];

/** Media/app keys (type 7). Labels are illumipc's English strings. */
export const MEDIA: { hid: number; label: string }[] = [
  { hid: 0x13, label: "Play/Pause" },
  { hid: 0x16, label: "Stop" },
  { hid: 0x15, label: "Prev Track" },
  { hid: 0x14, label: "Next Track" },
  { hid: 0x12, label: "Mute" },
  { hid: 0x10, label: "Volume +" },
  { hid: 0x11, label: "Volume -" },
  { hid: 0x30, label: "Media player" },
  { hid: 0x34, label: "This PC" },
  { hid: 0x32, label: "Calculator" },
  { hid: 0x20, label: "Email" },
  { hid: 0x23, label: "Browser home" },
  { hid: 0x21, label: "Browser search" },
  { hid: 0x24, label: "Browser back" },
  { hid: 0x25, label: "Browser forward" },
  { hid: 0x22, label: "Browser bookmarks" },
  { hid: 0x27, label: "Browser refresh" },
  { hid: 0x26, label: "Browser stop" },
];

/** Mouse actions (type 0x12), stored [0x12, wheel flag, button/direction, 0]. */
export const MOUSE: { raw: RawAction; label: string }[] = [
  { raw: [ACTION.mouse, 0, 0x01, 0], label: "Mouse left" },
  { raw: [ACTION.mouse, 0, 0x02, 0], label: "Mouse right" },
  { raw: [ACTION.mouse, 0, 0x04, 0], label: "Mouse middle" },
  { raw: [ACTION.mouse, 0, 0x08, 0], label: "Mouse forward" },
  { raw: [ACTION.mouse, 0, 0x10, 0], label: "Mouse back" },
  { raw: [ACTION.mouse, 1, 0x01, 0], label: "Wheel up" },
  { raw: [ACTION.mouse, 1, 0xff, 0], label: "Wheel down" },
];

/** Ready-made shortcuts (type 0x13 = modifier + key). */
export const SHORTCUTS: { raw: RawAction; label: string }[] = [
  { raw: [ACTION.combo, 0xe3, 0x07, 0], label: "Show desktop (Win+D)" },
  { raw: [ACTION.combo, 0xe2, 0x3d, 0], label: "Close window (Alt+F4)" },
  { raw: [ACTION.combo, 0xe3, 0x0f, 0], label: "Lock PC (Win+L)" },
  { raw: [ACTION.combo, 0xe0, 0x1d, 0], label: "Undo (Ctrl+Z)" },
  { raw: [ACTION.combo, 0xe0, 0x06, 0], label: "Copy (Ctrl+C)" },
  { raw: [ACTION.combo, 0xe0, 0x19, 0], label: "Paste (Ctrl+V)" },
  { raw: [ACTION.combo, 0xe0, 0x1b, 0], label: "Cut (Ctrl+X)" },
  { raw: [ACTION.combo, 0xe0, 0x16, 0], label: "Save (Ctrl+S)" },
  { raw: [ACTION.combo, 0xe0, 0x11, 0], label: "New (Ctrl+N)" },
  { raw: [ACTION.combo, 0xe0, 0x13, 0], label: "Print (Ctrl+P)" },
];

/** Keyboard-function keys (lighting and locks). */
export const KEYBOARD_FUNCTIONS: { raw: RawAction; label: string }[] = [
  { raw: [ACTION.lightList, 2, 0, 0], label: "Next lighting effect" },
  { raw: [ACTION.lightBrightness, 0, 0, 0], label: "Brightness +" },
  { raw: [ACTION.lightBrightness, 1, 0, 0], label: "Brightness -" },
  { raw: [ACTION.lightSpeed, 0, 0, 0], label: "Light speed +" },
  { raw: [ACTION.lightSpeed, 1, 0, 0], label: "Light speed -" },
  { raw: [ACTION.lightDirection, 2, 0, 0], label: "Light direction" },
  { raw: [ACTION.lightColor, 0, 0, 0], label: "Full-colour lighting" },
  { raw: [ACTION.lightColor, 1, 0, 0], label: "Next foreground colour" },
  { raw: [ACTION.lightColor, 2, 0, 0], label: "Next background colour" },
  { raw: [ACTION.lock, 4, 0, 0], label: "Lights off" },
  { raw: [ACTION.lock, 0, 0, 0], label: "Lock keyboard" },
  { raw: [ACTION.lock, 2, 0, 0], label: "Lock Win key" },
];

/** HID keyboard usage names (US labels). */
export const HID_NAMES: Record<number, string> = (() => {
  const m: Record<number, string> = {};
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach((c, i) => (m[0x04 + i] = c));
  "1234567890".split("").forEach((c, i) => (m[0x1e + i] = c));
  Object.assign(m, {
    0x28: "Enter",
    0x29: "Esc",
    0x2a: "Backspace",
    0x2b: "Tab",
    0x2c: "Space",
    0x2d: "-",
    0x2e: "=",
    0x2f: "[",
    0x30: "]",
    0x31: "\\",
    0x32: "#",
    0x33: ";",
    0x34: "'",
    0x35: "`",
    0x36: ",",
    0x37: ".",
    0x38: "/",
    0x39: "Caps Lock",
    0x46: "Print Screen",
    0x47: "Scroll Lock",
    0x48: "Pause",
    0x49: "Insert",
    0x4a: "Home",
    0x4b: "Page Up",
    0x4c: "Delete",
    0x4d: "End",
    0x4e: "Page Down",
    0x4f: "Right",
    0x50: "Left",
    0x51: "Down",
    0x52: "Up",
    0x53: "Num Lock",
    0x54: "Num /",
    0x55: "Num *",
    0x56: "Num -",
    0x57: "Num +",
    0x58: "Num Enter",
    0x59: "Num 1",
    0x5a: "Num 2",
    0x5b: "Num 3",
    0x5c: "Num 4",
    0x5d: "Num 5",
    0x5e: "Num 6",
    0x5f: "Num 7",
    0x60: "Num 8",
    0x61: "Num 9",
    0x62: "Num 0",
    0x63: "Num .",
    0x64: "ISO \\",
    0x65: "Menu",
    0x87: "Ro",
    0x88: "Kana",
    0x89: "Yen",
    0x8a: "Henkan",
    0x8b: "Muhenkan",
    0xe0: "Left Ctrl",
    0xe1: "Left Shift",
    0xe2: "Left Alt",
    0xe3: "Left Win",
    0xe4: "Right Ctrl",
    0xe5: "Right Shift",
    0xe6: "Right Alt",
    0xe7: "Right Win",
  });
  for (let i = 0; i < 12; i++) m[0x3a + i] = `F${i + 1}`;
  for (let i = 0; i < 12; i++) m[0x68 + i] = `F${i + 13}`;
  return m;
})();

export const isModifier = (hid: number) => hid >= 0xe0 && hid <= 0xe7;
const SHORT_MOD: Record<number, string> = { 0xe0: "Ctrl", 0xe1: "Shift", 0xe2: "Alt", 0xe3: "Win", 0xe4: "RCtrl", 0xe5: "RShift", 0xe6: "RAlt", 0xe7: "RWin" };

/** Human description of a raw keymap entry. */
export function describeAction(a: RawAction): string {
  const [t, b1, b2, b3] = a;
  const same = (x: RawAction) => x.every((v, i) => v === a[i]);
  if (t === ACTION.key) return b1 === 0 ? "Disabled" : b1 === 0xfa ? "Fn" : (HID_NAMES[b1] ?? `Key 0x${b1.toString(16)}`);
  if (t === ACTION.fn) return "Fn";
  if (t === ACTION.media) return MEDIA.find((m) => m.hid === b1)?.label ?? `Media 0x${b1.toString(16)}`;
  if (t === ACTION.mouse) return MOUSE.find((m) => same(m.raw))?.label ?? "Mouse";
  if (t === ACTION.combo) {
    const known = SHORTCUTS.find((s) => same(s.raw));
    if (known) return known.label;
    return [b1, b2, b3]
      .filter((x) => x)
      .map((x) => SHORT_MOD[x] ?? HID_NAMES[x] ?? `0x${x.toString(16)}`)
      .join("+");
  }
  const fnKey = KEYBOARD_FUNCTIONS.find((k) => same(k.raw));
  if (fnKey) return fnKey.label;
  if (t === ACTION.macro) return `Macro ${b2 + 1}`;
  if (t === ACTION.advanced) return `Advanced key ${b1 + 1}`;
  if (t === ACTION.gamepadClassic || t === ACTION.gamepadXbox) return "Gamepad";
  return `Action ${hex(a)}`;
}

/** Combination key (up to 3 keys): the first must be a modifier; with three keys the first two must be. [v2 setComboKey + UI rules] */
export function comboAction(keys: number[]): RawAction {
  const k = keys.filter((x) => x);
  if (k.length < 2 || k.length > 3) throw new Error("A combination needs 2 or 3 keys.");
  if (!isModifier(k[0]) || (k.length === 3 && !isModifier(k[1]))) throw new Error("Start a combination with modifier keys (Ctrl, Shift, Alt, Win).");
  return [ACTION.combo, k[0], k[1], k[2] ?? 0];
}
