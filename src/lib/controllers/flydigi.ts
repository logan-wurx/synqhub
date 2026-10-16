// Flydigi Apex 4 (wave C3), in its D-input mode (04B4:2412): its four profile slots over the vendor collection 0xFFA0
// (output report 5, input report 4). A slot is a 790-byte config read in 79 ten-byte parcels and written the same way;
// a write only lasts once it is saved to flash (read the slot's random id, save with id + 1), which SYNQ does only
// when the person presses Save. Source (MIT): uiltonlopes/flydigi-space-station-mac docs/protocol.md and FlydigiKit
// (checked on an Apex 4, device id 84). 04B4:2412 is shared by Flydigi's older pads, so the pad is identified by its
// device-info answer: SYNQ writes only to device id 84 (the source's verified Apex 4); every other id is read only.
//
// Safety: SYNQ sends device info, config reads, the config write (header + parcels) checked field by field where a
// field lies inside a parcel, the random-id read, save-to-flash, and the motor test. Never the mode switch to XInput
// (0xED: it re-enumerates), update mode (0x17), LED or screen writes, ForceAdapt, mapping enable, or anything else.
// The Apex 5 / Vader 5 Pro / Apex 6 (37D7) speak a newer protocol whose config isn't in an open-source reference:
// nothing is sent to them (so Space Station's "allow third-party apps" switch is never overridden).
// Pure data and functions: no DOM, no React, no device access.

export const FD_OUT = 0x05;
export const FD_IN = 0x04;
export const FD_LEN = 63;
export const FD_CONFIG_SIZE = 790;
export const FD_PARCELS = 79;
export const FD_SLOTS = 4;
/** The device id the source verified (Flydigi Apex 4); writes go to it only. */
export const FD_WRITABLE_IDS: readonly number[] = [84];
export const FD_CMD = { deviceInfo: 0xec, dongleInfo: 0x11, readConfig: 0xeb, writeStart: 0xea, writeData: 0x22, sub: 0x50, motor: 0x0f } as const;
const SPECIFY = 0xa0;

/** Byte-sum checksum over the report (its id included), as Space Station writes it. */
const sum = (bytes: readonly number[]) => bytes.reduce((a, b) => (a + b) & 0xff, 0);

// ---- the config blob

export const FD_AT = { keys: 13, sticks: 109, vibration: 145, dataVersion: 225, title: 770 } as const;
/** Gamepad keys by id (ControllerKey), the ones a mapping may target. */
export const FD_KEYS: readonly { id: number; name: string }[] = [
  { id: 0, name: "Up" },
  { id: 1, name: "Right" },
  { id: 2, name: "Down" },
  { id: 3, name: "Left" },
  { id: 4, name: "A" },
  { id: 5, name: "B" },
  { id: 6, name: "Select" },
  { id: 7, name: "X" },
  { id: 8, name: "Y" },
  { id: 9, name: "Start" },
  { id: 10, name: "LB" },
  { id: 11, name: "RB" },
  { id: 12, name: "LT" },
  { id: 13, name: "RT" },
  { id: 14, name: "LS" },
  { id: 15, name: "RS" },
  { id: 16, name: "C" },
  { id: 17, name: "Z" },
  { id: 18, name: "M1" },
  { id: 19, name: "M2" },
  { id: 20, name: "M3" },
  { id: 21, name: "M4" },
  { id: 22, name: "M5" },
  { id: 23, name: "M6" },
];
export const FD_IDENTITY = 0xff;
/** Key-table targets the firmware uses: keys 0-31, macro 0x20, stick directions 0xA0-0xA8, sticks / wheel 0xF0-0xF2, keyboard / mouse 0xFE, identity 0xFF. */
const knownTarget = (t: number) => t <= 0x20 || (t >= 0xa0 && t <= 0xa8) || (t >= 0xf0 && t <= 0xf2) || t === 0xfe || t === 0xff;
export const FD_CURVES = ["Default", "Quick", "Slow"] as const;

/** Why the 10 bytes of parcel `index` aren't a config SYNQ writes (fields inside the parcel only), or null. */
export function fdParcelProblem(index: number, data: Uint8Array): string | null {
  const offset = index * 10;
  const has = (at: number, n: number) => at >= offset && at + n <= offset + data.length;
  const b = (at: number) => data[at - offset];
  for (let i = 0; i < 32; i++) {
    const at = FD_AT.keys + i * 3;
    if (has(at, 1) && !knownTarget(b(at))) return "a key mapping SYNQ doesn't know";
    if (has(at + 1, 1) && b(at + 1) > 2) return "a turbo mode SYNQ doesn't know";
  }
  for (const at of [FD_AT.sticks, FD_AT.sticks + 7]) {
    if (has(at, 1) && b(at) > 3) return "a stick curve SYNQ doesn't know";
    if (has(at + 1, 1) && b(at + 1) > 127) return "a stick dead zone over 127";
  }
  if (has(FD_AT.vibration, 1) && b(FD_AT.vibration) > 1) return "the vibration switch";
  return null;
}

export type FdVerdict = { ok: true; what: string } | { ok: false; why: string };

/** The guard for one output report to a Flydigi pad in D-input mode (`data` excludes the report id). */
export function checkFlydigiOutput(reportId: number, data: Uint8Array): FdVerdict {
  const no = (why: string): FdVerdict => ({ ok: false, why: `Flydigi: ${why}.` });
  if (reportId !== FD_OUT) return no(`output report 0x${reportId.toString(16)} isn't the config channel's`);
  if (data.length !== FD_LEN) return no("config reports are 64 bytes");
  const rest = (from: number) => data.subarray(from).every((x) => x === 0);
  switch (data[0]) {
    case FD_CMD.deviceInfo:
    case FD_CMD.dongleInfo:
      return rest(1) ? { ok: true, what: "info" } : no("info queries carry no data");
    case FD_CMD.readConfig:
      return data[1] < FD_SLOTS && rest(2) ? { ok: true, what: `read slot ${data[1]}` } : no("a read of slot 0-3");
    case FD_CMD.writeStart:
      return data[1] === FD_PARCELS && data[2] === SPECIFY && data[3] < FD_SLOTS && rest(4) ? { ok: true, what: `write slot ${data[3]}` } : no("the config write header (79 parcels, slot 0-3)");
    case FD_CMD.writeData: {
      if (data[11] !== SPECIFY || data[12] >= FD_PARCELS || !rest(13)) return no("a config parcel (0-78)");
      const why = fdParcelProblem(data[12], data.subarray(1, 11));
      return why ? no(why) : { ok: true, what: `parcel ${data[12]}` };
    }
    case FD_CMD.sub:
      if (data[1] === 0x02 && data[2] < FD_SLOTS && data[3] === sum([FD_OUT, FD_CMD.sub, 0x02, data[2]]) && rest(4)) return { ok: true, what: "random id" };
      if (data[1] === 0x03 && data[4] === sum([FD_OUT, FD_CMD.sub, 0x03, data[2], data[3]]) && rest(5)) return { ok: true, what: "save to flash" };
      return no(`sub-command 0x${data[1].toString(16)} isn't sent`);
    case FD_CMD.motor:
      return rest(3) ? { ok: true, what: "motor test" } : no("the motor test");
    default:
      return no(`command 0x${data[0].toString(16)} is never sent${data[0] === 0xed ? " (the switch to XInput: it re-enumerates)" : data[0] === 0x17 ? " (update mode)" : ""}`);
  }
}

// ---- frames

const frame = (bytes: number[]) => {
  const d = new Uint8Array(FD_LEN);
  d.set(bytes);
  return { reportId: FD_OUT, data: d };
};
export const fdDeviceInfo = () => frame([FD_CMD.deviceInfo]);
export const fdReadConfig = (slot: number) => frame([FD_CMD.readConfig, slot]);
export const fdReadRandomId = (slot: number) => frame([FD_CMD.sub, 0x02, slot, sum([FD_OUT, FD_CMD.sub, 0x02, slot])]);
export const fdSave = (id: number) => frame([FD_CMD.sub, 0x03, (id >> 8) & 0xff, id & 0xff, sum([FD_OUT, FD_CMD.sub, 0x03, (id >> 8) & 0xff, id & 0xff])]);
/** The motor test (0-255 each); `fdMotor(0, 0)` stops it. */
export const fdMotor = (left: number, right: number) => frame([FD_CMD.motor, left & 0xff, right & 0xff]);

/** A whole config written to a slot: the header, then 79 parcels. */
export function fdWrites(slot: number, config: Uint8Array): { reportId: number; data: Uint8Array }[] {
  if (config.length !== FD_CONFIG_SIZE) throw new RangeError("a Flydigi config is 790 bytes");
  const out = [frame([FD_CMD.writeStart, FD_PARCELS, SPECIFY, slot])];
  for (let i = 0; i < FD_PARCELS; i++) out.push(frame([FD_CMD.writeData, ...config.subarray(i * 10, i * 10 + 10), SPECIFY, i]));
  return out;
}

// ---- answers (input report 4, data without the id)

export type FdAnswer =
  | { kind: "info"; deviceId: number; firmware: string; battery: number; wired: boolean }
  | { kind: "parcel"; index: number; data: Uint8Array }
  | { kind: "ack"; index: number }
  | { kind: "randomId"; id: number; slot: number }
  | { kind: "saved"; ok: boolean };

export function parseFlydigiAnswer(d: Uint8Array): FdAnswer | null {
  if (d.length < 15) return null;
  if (d[2] === FD_CMD.sub && d[3] === 0x02) return { kind: "randomId", id: (d[4] << 8) | d[5], slot: d[6] };
  if (d[2] === FD_CMD.sub && d[3] === 0x03) return { kind: "saved", ok: d[4] === 1 };
  switch (d[14]) {
    case FD_CMD.deviceInfo:
      return { kind: "info", deviceId: d[2], firmware: `${d[9] >> 4}.${d[9] & 15}.${d[8] >> 4}.${d[8] & 15}`, battery: d[10], wired: d[12] === 1 };
    case FD_CMD.readConfig:
      return { kind: "parcel", index: d[2], data: d.slice(4, 14) };
    case FD_CMD.writeStart:
    case FD_CMD.writeData:
    case 0xe7:
    case 0x33:
      return { kind: "ack", index: d[2] };
  }
  return null;
}

// ---- the config as the page shows it

export interface FdProfile {
  slot: number;
  title: string;
  /** Per key id 0-31: the target byte (0xFF: its own function). */
  keys: number[];
  /** Per key id: turbo frequency (a turbo mapping is kept as it is). */
  turbo: number[];
  sticks: [{ curve: number; deadZone: number }, { curve: number; deadZone: number }];
  vibration: boolean;
  dataVersion: number;
}

export function parseFlydigiConfig(slot: number, bytes: Uint8Array): FdProfile {
  if (bytes.length !== FD_CONFIG_SIZE) throw new RangeError("a Flydigi config is 790 bytes");
  const titleBytes = bytes.subarray(FD_AT.title, FD_AT.title + 20);
  let title = "";
  for (let i = 0; i < 20; i += 2) {
    const c = titleBytes[i] | (titleBytes[i + 1] << 8);
    if (c === 0 || c === 0xffff) break;
    title += String.fromCharCode(c);
  }
  return {
    slot,
    title,
    keys: Array.from({ length: 32 }, (_, i) => bytes[FD_AT.keys + i * 3]),
    turbo: Array.from({ length: 32 }, (_, i) => bytes[FD_AT.keys + i * 3 + 2]),
    sticks: [0, 1].map((s) => ({ curve: bytes[FD_AT.sticks + s * 7], deadZone: bytes[FD_AT.sticks + s * 7 + 1] })) as FdProfile["sticks"],
    vibration: bytes[FD_AT.vibration] === 0,
    dataVersion: (bytes[FD_AT.dataVersion] << 8) | bytes[FD_AT.dataVersion + 1],
  };
}

/** A mapping SYNQ edits: its own function or another gamepad key, without turbo. */
export const fdEditable = (p: FdProfile, key: number): boolean => p.turbo[key] === 0 && (p.keys[key] === FD_IDENTITY || p.keys[key] === key || FD_KEYS.some((k) => k.id === p.keys[key]));

/** Why an edit can't be written, or null. */
export function checkFlydigiEdit(p: FdProfile): string | null {
  if (p.title.length > 10) return "Titles are at most 10 characters.";
  if (p.sticks.some((s) => s.curve > 2 && s.curve !== 3) || p.sticks.some((s) => s.deadZone < 0 || s.deadZone > 127)) return "Stick curves are the three presets; dead zones 0-127.";
  if (p.keys.some((k) => !knownTarget(k))) return "A key mapping SYNQ doesn't know.";
  return null;
}

/** The slot's config with SYNQ's edits applied (every other byte as the pad has it). */
export function flydigiApply(bytes: Uint8Array, before: FdProfile, p: FdProfile): Uint8Array {
  const out = bytes.slice();
  if (p.title !== before.title) {
    out.fill(0, FD_AT.title, FD_AT.title + 20);
    [...p.title.slice(0, 10)].forEach((c, i) => {
      out[FD_AT.title + i * 2] = c.charCodeAt(0) & 0xff;
      out[FD_AT.title + i * 2 + 1] = c.charCodeAt(0) >> 8;
    });
  }
  p.keys.forEach((k, i) => {
    if (k === before.keys[i]) return;
    out.set([k === i ? FD_IDENTITY : k, 0, 0], FD_AT.keys + i * 3);
  });
  p.sticks.forEach((s, i) => {
    if (s.curve !== before.sticks[i].curve) out[FD_AT.sticks + i * 7] = s.curve;
    if (s.deadZone !== before.sticks[i].deadZone) out[FD_AT.sticks + i * 7 + 1] = s.deadZone;
  });
  if (p.vibration !== before.vibration) out[FD_AT.vibration] = p.vibration ? 0 : 1;
  return out;
}

/** A config like a factory Apex 4 slot, for the sims and fixtures. */
export function flydigiSampleConfig(slot: number): Uint8Array {
  const b = new Uint8Array(FD_CONFIG_SIZE);
  b.set([0x00, 0x03, 77], 0);
  for (let i = 0; i < 32; i++) b.set([FD_IDENTITY, 0, 0], FD_AT.keys + i * 3);
  if (slot === 1) b.set([5, 0, 0, 4, 0, 0], FD_AT.keys + 4 * 3); // A <-> B
  if (slot === 2) b[FD_AT.keys + 18 * 3] = 0x20; // M1 runs a macro
  b.set([0, 15, 15, 23, 100, 108, 127], FD_AT.sticks);
  b.set([0, 15, 15, 23, 100, 108, 127], FD_AT.sticks + 7);
  b.set([0, 0, 0, 255, 100, 0, 0, 255, 100], FD_AT.vibration);
  b.set([0x12, 0x34 + slot], FD_AT.dataVersion);
  const title = ["General", "Shooter", "Fighting", "Racing"][slot];
  [...title].forEach((c, i) => (b[FD_AT.title + i * 2] = c.charCodeAt(0)));
  return b;
}
