// CORSAIR Sabre v2 Pro (0x2B28 Ultralight, 0x2B29 MG, 0x2B25 CF; receivers 0x2B2A / 0x2B34 / 0x2B35).
// Not Bragi: Web Hub hands these to the separate Sabre Web Hub (https://www.corsair.com/sabre-web-hub/),
// whose protocol is the ATK / Endgame Gear "WE" EEPROM family SYNQ already speaks for ATK mice:
//   output report 8, 16 bytes [cmd, 0, addr hi, addr lo, len, data x10, checksum]
//   checksum: report id + all 16 bytes sum to 0x55 (OpenMouse weBuildCmdPayload, AGPL)
//   settings are EEPROM values stored as [value, 0x55 - value] pairs.
// Source: Sabre Web Hub v1.0.77 (obfuscated; decoded statically), `class A` (GetBuffer / SetBuffer /
// GetBatteryStatus) and its EEPROM map, read as documentation 2026-10-13; docs/devices/corsair-bragi.md.
//
// Default-deny: only EEPROM reads, the battery / version reads, and writes of the rows below with valid
// value/checksum pairs. Command 0x09 (factory reset), feature report 6 (pairing), the calibration rows
// 0xDB-0xDF and every other command are refused. Command 0x01 is NOT the ATK firmware upload here (it is
// Sabre's handshake) but SYNQ does not need it, so it stays refused on both.
import { weBuildCmdPayload, weReportChecksum } from "@openmouse/protocol/endgame-gear-we";
import { FrameSession } from "../frame-session.ts";
import { emptyMouseSettings, verdictOf, type BlockedCommand, type BrandMouseSession, type FrameVerdict, type HidLike, type MouseChange, type MouseFeatures, type MouseSettings, type MouseWriteResult } from "../types.ts";
import { CORSAIR_VID, SABRE_V2_PIDS } from "./devices.ts";

export const SABRE_REPORT_ID = 8;
export const SABRE_LENGTH = 16;
export const SABRE_CMD = { battery: 0x04, writeEeprom: 0x07, readEeprom: 0x08, mouseVersion: 0x12, receiverVersion: 0x1d } as const;

export const SABRE_ADDR = {
  polling: 0x00,
  stageCount: 0x02,
  activeStage: 0x04,
  lod: 0x0a,
  dpiStage0: 0x0c,
  motionSync: 0xab,
  sleep: 0xad,
  angleSnap: 0xaf,
  ripple: 0xb1,
} as const;

/** EEPROM polling codes (product JSON `PollingRate`). */
export const SABRE_POLLING: ReadonlyMap<number, number> = new Map([[1, 1000], [16, 2000], [32, 4000], [64, 8000]]);
/** Lift-off codes: Low 0, Medium 3, High 4. */
export const SABRE_LOD: ReadonlyMap<number, string> = new Map([[0, "Low"], [3, "Medium"], [4, "High"]]);
export const SABRE_DPI = { min: 100, max: 33000, step: 50 } as const;
const STAGES = 5;

const hi = (a: number) => (a >> 8) & 0xff;
const lo = (a: number) => a & 0xff;
export const pairOf = (v: number): [number, number] => [v & 0xff, (0x55 - v) & 0xff];

/** DPI -> [code lo X, code lo Y, high nibbles, check] (Sabre Web Hub generic map, X-only sensor). */
export function sabreDpiRow(dpi: number): number[] {
  if (!Number.isInteger(dpi) || dpi < SABRE_DPI.min || dpi > SABRE_DPI.max || dpi % SABRE_DPI.step) throw new RangeError(`DPI ${dpi} (100..33000, step 50)`);
  const i = dpi / 50 - 1;
  const high = i < 0x100 ? 0x00 : i < 0x200 ? 0x44 : 0x88;
  const row = [i & 0xff, i & 0xff, high];
  return [...row, (0x55 - row.reduce((s, b) => s + b, 0)) & 0xff];
}
export function sabreDpiFromRow(r: readonly number[]): number | null {
  if (((r[0] + r[1] + r[2] + r[3]) & 0xff) !== 0x55) return null;
  const band = r[2] & 0x0f;
  const i = r[0] + (band === 0x8 ? 0x200 : band === 0x4 ? 0x100 : 0);
  return (i + 1) * 50;
}

export const sabreRead = (address: number, length: number): Uint8Array => weBuildCmdPayload(SABRE_CMD.readEeprom, [0, hi(address), lo(address), length]);
export const sabreWrite = (address: number, data: readonly number[]): Uint8Array => weBuildCmdPayload(SABRE_CMD.writeEeprom, [0, hi(address), lo(address), data.length, ...data]);
export const sabreCommand = (cmd: number): Uint8Array => weBuildCmdPayload(cmd);

/** Writable rows: address -> length and value check. */
interface WritableRow {
  name: string;
  length: number;
  ok: (d: number[]) => boolean;
}
const WRITABLE: ReadonlyMap<number, WritableRow> = new Map<number, WritableRow>([
  [SABRE_ADDR.polling, { name: "polling", length: 2, ok: (d) => SABRE_POLLING.has(d[0]) }],
  [SABRE_ADDR.activeStage, { name: "active stage", length: 2, ok: (d) => d[0] < STAGES }],
  [SABRE_ADDR.lod, { name: "lift-off", length: 2, ok: (d) => SABRE_LOD.has(d[0]) }],
  [SABRE_ADDR.motionSync, { name: "motion sync", length: 2, ok: (d) => d[0] <= 1 }],
  [SABRE_ADDR.angleSnap, { name: "angle snapping", length: 2, ok: (d) => d[0] <= 1 }],
  [SABRE_ADDR.ripple, { name: "ripple control", length: 2, ok: (d) => d[0] <= 1 }],
  ...Array.from({ length: STAGES }, (_, i): [number, WritableRow] => [SABRE_ADDR.dpiStage0 + 4 * i, { name: `DPI stage ${i + 1}`, length: 4, ok: (d) => sabreDpiFromRow(d) !== null && d[0] === d[1] }]),
]);

export function classifySabreFrame(f: Uint8Array): FrameVerdict {
  if (f.length !== SABRE_LENGTH) return { verdict: "blocked", what: "bad length", why: "unknown", reason: "Sabre frames are 16 bytes" };
  if (f[15] !== weReportChecksum(SABRE_REPORT_ID, Array.from(f.subarray(0, 15)))) return { verdict: "blocked", what: "bad checksum", why: "unknown", reason: "frame checksum" };
  const cmd = f[0];
  if (cmd === 0x09) return { verdict: "blocked", what: "factory reset 0x09", why: "factory-reset", reason: "SetFactoryReset" };
  if (cmd === 0x01 || cmd === 0x02) return { verdict: "blocked", what: `0x0${cmd} handshake / driver mode`, why: "firmware", reason: "the same ids are firmware transfer on the ATK family; not needed" };
  if (cmd === SABRE_CMD.battery || cmd === SABRE_CMD.mouseVersion || cmd === SABRE_CMD.receiverVersion)
    return f.subarray(1, 15).every((b) => b === 0) ? { verdict: "read", what: "status read" } : { verdict: "blocked", what: "status read with payload", why: "unknown" };
  const address = (f[2] << 8) | f[3];
  const len = f[4];
  if (cmd === SABRE_CMD.readEeprom) {
    if (f[1] !== 0 || len < 1 || len > 10 || address > 0x2ff) return { verdict: "blocked", what: "EEPROM read", why: "unknown", reason: "address/length out of range" };
    return f.subarray(5, 15).every((b) => b === 0) ? { verdict: "read", what: `EEPROM read 0x${address.toString(16)}` } : { verdict: "blocked", what: "EEPROM read with data", why: "unknown" };
  }
  if (cmd === SABRE_CMD.writeEeprom) {
    if (address >= 0xdb && address <= 0xdf) return { verdict: "blocked", what: "surface calibration rows 0xDB-0xDF", why: "calibration", reason: "CalibrationDataTable / calibration enable" };
    const row = WRITABLE.get(address);
    if (!row || f[1] !== 0 || len !== row.length) return { verdict: "blocked", what: `EEPROM write 0x${address.toString(16)}`, why: "unknown", reason: "row not on SYNQ's write list" };
    const data = Array.from(f.subarray(5, 5 + len));
    if (!f.subarray(5 + len, 15).every((b) => b === 0)) return { verdict: "blocked", what: "EEPROM write with trailing data", why: "unknown" };
    const pairsOk = len === 2 ? ((data[0] + data[1]) & 0xff) === 0x55 : true;
    if (!pairsOk || !row.ok(data)) return { verdict: "blocked", what: `${row.name} value`, why: "unknown", reason: "bad value or value/checksum pair" };
    return { verdict: "write", what: `EEPROM write ${row.name}` };
  }
  return { verdict: "blocked", what: `command 0x${cmd.toString(16)}`, why: "unknown", reason: "not on the Sabre allowlist" };
}

export const SABRE_BLOCKED: readonly BlockedCommand[] = [
  { what: "Factory reset (0x09)", why: "factory-reset", bytes: "09 ..", source: "Sabre Web Hub SetFactoryReset" },
  { what: "Pairing (feature report 6, [A0 a b])", why: "pairing", bytes: "feature 06", source: "Sabre Web Hub SetPairing" },
  { what: "Surface-calibration rows 0xDB-0xDF", why: "calibration", bytes: "07 00 00 DB..DF", source: "Sabre Web Hub CalibrationDataTable" },
  { what: "Handshake / driver-mode 0x01 / 0x02 (firmware transfer ids on the ATK family)", why: "firmware", bytes: "01 .. / 02 ..", source: "ATK HUB enum `en`" },
];

export const isSabre = (vendorId: number, productId: number): boolean => vendorId === CORSAIR_VID && SABRE_V2_PIDS.has(productId);

export class SabreMouseSession implements BrandMouseSession {
  readonly features: MouseFeatures = {
    dpi: { min: SABRE_DPI.min, max: SABRE_DPI.max, step: SABRE_DPI.step, stages: STAGES, separateXY: false, readBack: "device" },
    polling: { hz: [1000, 2000, 4000, 8000], readBack: "device" },
    liftOff: { values: [0, 3, 4], labels: { 0: "Low", 3: "Medium", 4: "High" }, asymmetric: false, readBack: "device" },
    motionSync: { readBack: "device" },
    angleSnap: { readBack: "device" },
    battery: { readBack: "device" },
  };
  readonly blocked = SABRE_BLOCKED;
  readonly link: FrameSession;

  constructor(device: HidLike, opts: { allowWrites?: () => boolean; log?: (d: "out" | "in", b: Uint8Array, n?: string) => void } = {}) {
    this.link = new FrameSession({
      device,
      reportId: SABRE_REPORT_ID,
      length: SABRE_LENGTH,
      guard: classifySabreFrame,
      isAnswer: (sent, r) => r[0] === sent[0] && (sent[0] !== SABRE_CMD.readEeprom || (r[2] === sent[2] && r[3] === sent[3])),
      timeoutMs: 1000,
      allowWrites: opts.allowWrites,
      log: opts.log,
    });
  }

  async #row(address: number, length: number): Promise<number[]> {
    const r = await this.link.request(sabreRead(address, length));
    return Array.from(r.subarray(5, 5 + length));
  }
  async #pair(address: number): Promise<number | null> {
    const [v, c] = await this.#row(address, 2);
    return ((v + c) & 0xff) === 0x55 ? v : null;
  }

  async read(): Promise<MouseSettings> {
    const s = emptyMouseSettings();
    const poll = await this.#pair(SABRE_ADDR.polling);
    s.pollingHz = poll === null ? null : (SABRE_POLLING.get(poll) ?? null);
    s.activeStage = await this.#pair(SABRE_ADDR.activeStage);
    const lod = await this.#pair(SABRE_ADDR.lod);
    s.liftOff = lod;
    s.liftOffLabel = lod === null ? null : (SABRE_LOD.get(lod) ?? null);
    const ms = await this.#pair(SABRE_ADDR.motionSync);
    s.motionSync = ms === null ? null : ms === 1;
    const snap = await this.#pair(SABRE_ADDR.angleSnap);
    s.angleSnap = snap === null ? null : snap === 1;
    const dpi: number[] = [];
    for (let i = 0; i < STAGES; i++) {
      const d = sabreDpiFromRow(await this.#row(SABRE_ADDR.dpiStage0 + 4 * i, 4));
      if (d !== null) dpi.push(d);
    }
    s.dpi = dpi;
    const bat = await this.link.request(sabreCommand(SABRE_CMD.battery));
    s.battery = { percent: bat[5], charging: bat[6] === 1 ? true : bat[6] === 0 ? false : null };
    const v = await this.link.request(sabreCommand(SABRE_CMD.mouseVersion));
    s.firmware = `${v[5]}.${v[6].toString().padStart(2, "0")}`;
    return s;
  }

  frameFor(c: MouseChange): Uint8Array {
    switch (c.kind) {
      case "polling": {
        const code = [...SABRE_POLLING].find(([, hz]) => hz === c.hz)?.[0];
        if (code === undefined) throw new Error("Sabre v2 Pro polling is 1000 / 2000 / 4000 / 8000 Hz.");
        return sabreWrite(SABRE_ADDR.polling, pairOf(code));
      }
      case "liftOff":
        if (!SABRE_LOD.has(c.value)) throw new Error("Lift-off is 0 (low), 3 (medium) or 4 (high).");
        return sabreWrite(SABRE_ADDR.lod, pairOf(c.value));
      case "motionSync":
        return sabreWrite(SABRE_ADDR.motionSync, pairOf(c.on ? 1 : 0));
      case "angleSnap":
        return sabreWrite(SABRE_ADDR.angleSnap, pairOf(c.on ? 1 : 0));
      case "activeStage":
        if (!Number.isInteger(c.stage) || c.stage < 0 || c.stage >= STAGES) throw new Error("Stages are 0..4.");
        return sabreWrite(SABRE_ADDR.activeStage, pairOf(c.stage));
      case "dpi":
        if (!Number.isInteger(c.stage) || c.stage < 0 || c.stage >= STAGES) throw new Error("Stages are 0..4.");
        return sabreWrite(SABRE_ADDR.dpiStage0 + 4 * c.stage, sabreDpiRow(c.dpi));
      default:
        throw new Error(`${c.kind} isn't supported on the Sabre v2 Pro.`);
    }
  }

  async apply(c: MouseChange): Promise<MouseWriteResult> {
    await this.link.request(this.frameFor(c));
    const s = await this.read();
    const [expected, got] =
      c.kind === "polling" ? [c.hz, s.pollingHz] : c.kind === "liftOff" ? [c.value, s.liftOff] : c.kind === "motionSync" ? [c.on, s.motionSync] : c.kind === "angleSnap" ? [c.on, s.angleSnap] : c.kind === "activeStage" ? [c.stage, s.activeStage] : c.kind === "dpi" ? [c.dpi, s.dpi?.[c.stage]] : [null, null];
    return { verdict: verdictOf(expected, got ?? undefined), expected, got, persistence: "saved" };
  }

  close(): Promise<void> {
    return this.link.close();
  }
}
