// Controller input reports (and the few replies SYNQ reads) as one shape the tester draws: sticks, triggers,
// buttons, motion and battery. Layouts: Linux hid-playstation and hid-nintendo (GPL-2.0+), SDL's PS4 / PS5 / Switch
// drivers (zlib), Microsoft's XInput and the W3C Gamepad API standard mapping.
//
// Bluetooth and pairing addresses are never kept: the parsers that see one (Switch device info, the USB status reply)
// drop it here, so it can't reach the screen, a log or a diagnostics file.
//
// Pure functions: no DOM, no React, no device access.

export type PadButton =
  | "a"
  | "b"
  | "x"
  | "y"
  | "lb"
  | "rb"
  | "lt"
  | "rt"
  | "ls"
  | "rs"
  | "view"
  | "menu"
  | "guide"
  | "share"
  | "dUp"
  | "dDown"
  | "dLeft"
  | "dRight"
  | "p1"
  | "p2"
  | "p3"
  | "p4"
  | "touchpad"
  | "mic"
  | "fnL"
  | "fnR"
  | "sl"
  | "sr";

export interface StickState {
  /** -1 (left) .. 1 (right). */
  x: number;
  /** -1 (up) .. 1 (down), as the Gamepad API. */
  y: number;
}

export interface PadState {
  /** When it was read, in ms (the source's clock). */
  t: number;
  sticks: StickState[];
  /** The raw stick values and their bit depth, for resolution and deadzone figures. */
  sticksRaw?: StickState[];
  stickBits?: number;
  /** 0 .. 1. */
  triggers: number[];
  triggersRaw?: number[];
  triggerBits?: number;
  buttons: Partial<Record<PadButton, boolean>>;
  /** Degrees per second (uncalibrated where the pad's calibration wasn't read). */
  gyro?: [number, number, number];
  /** g. */
  accel?: [number, number, number];
  battery?: { percent: number | null; charging: boolean };
  /** Which report it came from ("ds5 usb", "switch 0x30"...). */
  form: string;
}

const s16 = (d: DataView, at: number) => d.getInt16(at, true);
const u8 = (d: DataView, at: number) => d.getUint8(at);
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const axis8 = (v: number) => Math.max(-1, Math.min(1, (v - 128) / 127.5));

/** A hat switch value (0 = up, clockwise, 8 or more = centred) as d-pad buttons. */
function hat(v: number): Pick<PadState["buttons"], "dUp" | "dDown" | "dLeft" | "dRight"> {
  const up = v === 7 || v === 0 || v === 1;
  const right = v >= 1 && v <= 3;
  const down = v >= 3 && v <= 5;
  const left = v >= 5 && v <= 7;
  return { dUp: v < 8 && up, dRight: v < 8 && right, dDown: v < 8 && down, dLeft: v < 8 && left };
}

// ---- Sony

/** hid-playstation's 63-byte DualSense report body (USB report 0x01, Bluetooth 0x31 from byte 1). */
function ds5Body(d: DataView, at: number, t: number, form: string): PadState {
  const b0 = u8(d, at + 7);
  const b1 = u8(d, at + 8);
  const b2 = u8(d, at + 9);
  const status = u8(d, at + 52);
  const cap = status & 0x0f;
  const charge = status >> 4;
  const raw = [u8(d, at), u8(d, at + 1), u8(d, at + 2), u8(d, at + 3)];
  return {
    t,
    form,
    sticks: [
      { x: axis8(raw[0]), y: axis8(raw[1]) },
      { x: axis8(raw[2]), y: axis8(raw[3]) },
    ],
    sticksRaw: [
      { x: raw[0], y: raw[1] },
      { x: raw[2], y: raw[3] },
    ],
    stickBits: 8,
    triggers: [u8(d, at + 4) / 255, u8(d, at + 5) / 255],
    triggersRaw: [u8(d, at + 4), u8(d, at + 5)],
    triggerBits: 8,
    buttons: {
      ...hat(b0 & 0x0f),
      x: !!(b0 & 0x10), // square
      a: !!(b0 & 0x20), // cross
      b: !!(b0 & 0x40), // circle
      y: !!(b0 & 0x80), // triangle
      lb: !!(b1 & 0x01),
      rb: !!(b1 & 0x02),
      lt: !!(b1 & 0x04),
      rt: !!(b1 & 0x08),
      view: !!(b1 & 0x10), // create
      menu: !!(b1 & 0x20), // options
      ls: !!(b1 & 0x40),
      rs: !!(b1 & 0x80),
      guide: !!(b2 & 0x01),
      touchpad: !!(b2 & 0x02),
      mic: !!(b2 & 0x04),
      fnL: !!(b2 & 0x10),
      fnR: !!(b2 & 0x20),
      p1: !!(b2 & 0x40),
      p2: !!(b2 & 0x80),
    },
    gyro: [s16(d, at + 15) / 1024, s16(d, at + 17) / 1024, s16(d, at + 19) / 1024],
    accel: [s16(d, at + 21) / 8192, s16(d, at + 23) / 8192, s16(d, at + 25) / 8192],
    battery: charge === 2 ? { percent: 100, charging: false } : charge <= 1 ? { percent: Math.min(cap * 10 + 5, 100), charging: charge === 1 } : undefined,
  };
}

/** The Bluetooth "simple" report both Sony pads send before a calibration read switches them to the full one. */
function sonySimple(d: DataView, t: number, form: string): PadState {
  const b0 = u8(d, 4);
  const b1 = u8(d, 5);
  return {
    t,
    form,
    sticks: [
      { x: axis8(u8(d, 0)), y: axis8(u8(d, 1)) },
      { x: axis8(u8(d, 2)), y: axis8(u8(d, 3)) },
    ],
    triggers: [u8(d, 7) / 255, u8(d, 8) / 255],
    buttons: { ...hat(b0 & 0x0f), x: !!(b0 & 0x10), a: !!(b0 & 0x20), b: !!(b0 & 0x40), y: !!(b0 & 0x80), lb: !!(b1 & 0x01), rb: !!(b1 & 0x02), view: !!(b1 & 0x10), menu: !!(b1 & 0x20), ls: !!(b1 & 0x40), rs: !!(b1 & 0x80) },
  };
}

export function parseDs5(reportId: number, data: Uint8Array, t: number): PadState | null {
  const d = view(data);
  if (reportId === 0x01 && data.length >= 63) return ds5Body(d, 0, t, "DualSense USB report");
  if (reportId === 0x31 && data.length >= 64) return ds5Body(d, 1, t, "DualSense Bluetooth report");
  if (reportId === 0x01 && data.length >= 9) return sonySimple(d, t, "DualSense Bluetooth simple report");
  return null;
}

/** hid-playstation's DualShock 4 common body (USB report 0x01 at 0, Bluetooth 0x11 at 2). */
function ds4Body(d: DataView, at: number, t: number, form: string, usb: boolean): PadState {
  const b0 = u8(d, at + 4);
  const b1 = u8(d, at + 5);
  const b2 = u8(d, at + 6);
  const status = u8(d, at + 29);
  const cap = status & 0x0f;
  const cable = !!(status & 0x10);
  const raw = [u8(d, at), u8(d, at + 1), u8(d, at + 2), u8(d, at + 3)];
  const percent = cable ? (cap < 10 ? cap * 10 + 5 : cap <= 11 ? 100 : null) : cap < 10 ? cap * 10 + 5 : 100;
  return {
    t,
    form,
    sticks: [
      { x: axis8(raw[0]), y: axis8(raw[1]) },
      { x: axis8(raw[2]), y: axis8(raw[3]) },
    ],
    sticksRaw: [
      { x: raw[0], y: raw[1] },
      { x: raw[2], y: raw[3] },
    ],
    stickBits: 8,
    triggers: [u8(d, at + 7) / 255, u8(d, at + 8) / 255],
    triggersRaw: [u8(d, at + 7), u8(d, at + 8)],
    triggerBits: 8,
    buttons: {
      ...hat(b0 & 0x0f),
      x: !!(b0 & 0x10),
      a: !!(b0 & 0x20),
      b: !!(b0 & 0x40),
      y: !!(b0 & 0x80),
      lb: !!(b1 & 0x01),
      rb: !!(b1 & 0x02),
      lt: !!(b1 & 0x04),
      rt: !!(b1 & 0x08),
      view: !!(b1 & 0x10),
      menu: !!(b1 & 0x20),
      ls: !!(b1 & 0x40),
      rs: !!(b1 & 0x80),
      guide: !!(b2 & 0x01),
      touchpad: !!(b2 & 0x02),
    },
    gyro: [s16(d, at + 12) / 16, s16(d, at + 14) / 16, s16(d, at + 16) / 16],
    accel: [s16(d, at + 18) / 8192, s16(d, at + 20) / 8192, s16(d, at + 22) / 8192],
    battery: usb && !cable ? undefined : { percent, charging: cable && cap < 10 },
  };
}

export function parseDs4(reportId: number, data: Uint8Array, t: number): PadState | null {
  const d = view(data);
  if (reportId === 0x01 && data.length >= 32) return ds4Body(d, 0, t, "DualShock 4 USB report", true);
  if (reportId === 0x11 && data.length >= 34) return ds4Body(d, 2, t, "DualShock 4 Bluetooth report", false);
  if (reportId === 0x01 && data.length >= 9) return sonySimple(d, t, "DualShock 4 Bluetooth simple report");
  return null;
}

/** DualSense feature 0x20 (with its id byte first): build date and time, hardware and firmware versions. */
export function ds5Firmware(buf: Uint8Array): { build: string; hardware: string; firmware: string } | null {
  if (buf.length < 48 || buf[0] !== 0x20) return null;
  const text = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to)).replace(/\0+$/, "").trim();
  const d = view(buf);
  return { build: `${text(1, 12)} ${text(12, 20)}`.trim(), hardware: `0x${d.getUint32(24, true).toString(16)}`, firmware: `0x${d.getUint32(28, true).toString(16)}` };
}

/** DualShock 4 feature 0xA3: build date and time, hardware and firmware versions. */
export function ds4Firmware(buf: Uint8Array): { build: string; hardware: string; firmware: string } | null {
  if (buf.length < 43 || buf[0] !== 0xa3) return null;
  const text = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to)).replace(/\0+$/, "").trim();
  const d = view(buf);
  return { build: `${text(1, 17)} ${text(17, 33)}`.trim(), hardware: `0x${d.getUint16(35, true).toString(16)}`, firmware: `0x${d.getUint16(41, true).toString(16)}` };
}

// ---- Nintendo

/** Stick calibration from SPI: centre and the distance to each end, per axis (hid-nintendo's layout). */
export interface SwitchStickCal {
  center: [number, number];
  min: [number, number];
  max: [number, number];
}

/** Factory calibration block 0x603D (18 bytes: left stick, then right; each 9 bytes in two orders). */
export function switchStickCal(bytes: Uint8Array): [SwitchStickCal | null, SwitchStickCal | null] {
  if (bytes.length < 18) return [null, null];
  const triple = (b: Uint8Array, at: number): [number, number, number, number, number, number] => {
    const v = (i: number) => b[at + i];
    // 9 bytes = six 12-bit values.
    return [(v(1) << 8) & 0xf00 | v(0), (v(2) << 4) | (v(1) >> 4), (v(4) << 8) & 0xf00 | v(3), (v(5) << 4) | (v(4) >> 4), (v(7) << 8) & 0xf00 | v(6), (v(8) << 4) | (v(7) >> 4)];
  };
  const blank = (b: Uint8Array, at: number) => b.subarray(at, at + 9).every((x) => x === 0xff);
  const l = triple(bytes, 0);
  const r = triple(bytes, 9);
  // Left: max-above-centre, centre, min-below-centre. Right: centre, min-below-centre, max-above-centre.
  const left: SwitchStickCal | null = blank(bytes, 0) ? null : { max: [l[0], l[1]], center: [l[2], l[3]], min: [l[4], l[5]] };
  const right: SwitchStickCal | null = blank(bytes, 9) ? null : { center: [r[0], r[1]], min: [r[2], r[3]], max: [r[4], r[5]] };
  return [left, right];
}

const NEUTRAL_CAL: SwitchStickCal = { center: [2048, 2048], min: [1400, 1400], max: [1400, 1400] };

function stick12(v: number, c: SwitchStickCal, i: 0 | 1): number {
  const d = v - c.center[i];
  return Math.max(-1, Math.min(1, d >= 0 ? d / Math.max(1, c.max[i]) : d / Math.max(1, c.min[i])));
}

export interface SwitchContext {
  cal?: [SwitchStickCal | null, SwitchStickCal | null];
}

/** Switch full report 0x30 (and the same header of a 0x21 reply), simple report 0x3F. */
export function parseSwitch(reportId: number, data: Uint8Array, t: number, ctx: SwitchContext = {}): PadState | null {
  const d = view(data);
  if ((reportId === 0x30 || reportId === 0x21) && data.length >= 12) {
    const right = data[2];
    const shared = data[3];
    const left = data[4];
    const lx = data[5] | ((data[6] & 0x0f) << 8);
    const ly = (data[6] >> 4) | (data[7] << 4);
    const rx = data[8] | ((data[9] & 0x0f) << 8);
    const ry = (data[9] >> 4) | (data[10] << 4);
    const lc = ctx.cal?.[0] ?? NEUTRAL_CAL;
    const rc = ctx.cal?.[1] ?? NEUTRAL_CAL;
    const level = data[1] >> 5; // 0..4 (empty, critical, low, medium, full)
    const state: PadState = {
      t,
      form: reportId === 0x30 ? "Switch full report" : "Switch reply",
      sticks: [
        { x: stick12(lx, lc, 0), y: -stick12(ly, lc, 1) },
        { x: stick12(rx, rc, 0), y: -stick12(ry, rc, 1) },
      ],
      sticksRaw: [
        { x: lx, y: ly },
        { x: rx, y: ry },
      ],
      stickBits: 12,
      triggers: [left & 0x80 ? 1 : 0, right & 0x80 ? 1 : 0],
      triggersRaw: [left & 0x80 ? 1 : 0, right & 0x80 ? 1 : 0],
      triggerBits: 1,
      buttons: {
        y: !!(right & 0x01),
        x: !!(right & 0x02),
        b: !!(right & 0x04),
        a: !!(right & 0x08),
        sr: !!(right & 0x10) || !!(left & 0x10),
        sl: !!(right & 0x20) || !!(left & 0x20),
        rb: !!(right & 0x40),
        rt: !!(right & 0x80),
        view: !!(shared & 0x01),
        menu: !!(shared & 0x02),
        rs: !!(shared & 0x04),
        ls: !!(shared & 0x08),
        guide: !!(shared & 0x10),
        share: !!(shared & 0x20),
        dDown: !!(left & 0x01),
        dUp: !!(left & 0x02),
        dRight: !!(left & 0x04),
        dLeft: !!(left & 0x08),
        lb: !!(left & 0x40),
        lt: !!(left & 0x80),
      },
      battery: { percent: [0, 15, 40, 70, 100][level] ?? null, charging: !!(data[1] & 0x10) },
    };
    if (reportId === 0x30 && data.length >= 24) {
      // The first of the three IMU samples: accel x, y, z then gyro x, y, z (nominal scales: +-8 g, +-2000 deg/s).
      state.accel = [s16(d, 12) * 0.000244, s16(d, 14) * 0.000244, s16(d, 16) * 0.000244];
      state.gyro = [s16(d, 18) * 0.06103, s16(d, 20) * 0.06103, s16(d, 22) * 0.06103];
    }
    return state;
  }
  if (reportId === 0x3f && data.length >= 11) {
    const b0 = data[0];
    const b1 = data[1];
    const axis16 = (at: number) => Math.max(-1, Math.min(1, (d.getUint16(at, true) - 0x8000) / 0x8000));
    return {
      t,
      form: "Switch simple report",
      sticks: [
        { x: axis16(3), y: axis16(5) },
        { x: axis16(7), y: axis16(9) },
      ],
      triggers: [b0 & 0x40 ? 1 : 0, b0 & 0x80 ? 1 : 0],
      buttons: { ...hat(data[2]), b: !!(b0 & 0x01), a: !!(b0 & 0x02), y: !!(b0 & 0x04), x: !!(b0 & 0x08), lb: !!(b0 & 0x10), rb: !!(b0 & 0x20), view: !!(b1 & 0x01), menu: !!(b1 & 0x02), ls: !!(b1 & 0x04), rs: !!(b1 & 0x08), guide: !!(b1 & 0x10), share: !!(b1 & 0x20) },
    };
  }
  return null;
}

/** A 0x21 reply: which subcommand it answers and its data (from byte 14). */
export function switchReply(data: Uint8Array): { ack: number; sub: number; body: Uint8Array } | null {
  if (data.length < 15) return null;
  return { ack: data[12], sub: data[13], body: data.subarray(14) };
}

/** Device info (subcommand 0x02): firmware version and controller type only. The MAC in the reply is dropped here. */
export function switchDeviceInfo(body: Uint8Array): { firmware: string; type: string } | null {
  if (body.length < 3) return null;
  const types: Record<number, string> = { 1: "Joy-Con (L)", 2: "Joy-Con (R)", 3: "Pro Controller" };
  return { firmware: `${body[0]}.${body[1].toString().padStart(2, "0")}`, type: types[body[2]] ?? `type ${body[2]}` };
}

/** An SPI read reply: the address and bytes read. */
export function switchSpi(body: Uint8Array): { address: number; bytes: Uint8Array } | null {
  if (body.length < 5) return null;
  const address = view(body).getUint32(0, true);
  const length = body[4];
  return body.length >= 5 + length ? { address, bytes: body.slice(5, 5 + length) } : null;
}

/**
 * A Switch reply with any address bytes it carries zeroed: device info (0x21 / sub 0x02, MAC at 18..23 of the
 * report) and the USB status reply (0x81 / 0x01, MAC at 3..8). Used for anything kept (diagnostics, logs).
 */
export function redactSwitch(reportId: number, data: Uint8Array): Uint8Array {
  const out = data.slice();
  if (reportId === 0x21 && out.length >= 24 && out[13] === 0x02) out.fill(0, 18, 24);
  if (reportId === 0x81 && out.length >= 9 && out[0] === 0x01) out.fill(0, 3, 9);
  return out;
}

// ---- GameSir (wave C2)

/** Where the physical-input block of GameSir's state report sits (data without the report id). */
const GS_RAW = 52;

/**
 * GameSir's state report 0x12 on its vendor collection (Cyclone 2, G7 Pro 8K, Tarantula Pro 8K). Bytes 52-61 repeat
 * the processed block with the physical input: sticks, hat, buttons, analog triggers; bytes 34 and 35 are charging
 * and battery (gamesir-cyclone2-linux protocol.py, MIT). A pad that is asleep, or a dongle with nothing paired,
 * streams zeros: no state then.
 */
export function parseGamesirState(reportId: number, data: Uint8Array, t: number): PadState | null {
  if (reportId !== 0x12 || data.length < GS_RAW + 10) return null;
  const r = data.subarray(GS_RAW, GS_RAW + 10);
  if (r[1] === 0 && r[2] === 0 && r[3] === 0 && r[4] === 0 && data[35] === 0) return null;
  const bit = (byte: number, n: number) => !!((r[byte] >> n) & 1);
  return {
    t,
    form: "GameSir 0x12",
    sticks: [
      { x: axis8(r[1]), y: axis8(r[2]) },
      { x: axis8(r[3]), y: axis8(r[4]) },
    ],
    sticksRaw: [
      { x: r[1], y: r[2] },
      { x: r[3], y: r[4] },
    ],
    stickBits: 8,
    triggers: [r[8] / 255, r[9] / 255],
    triggersRaw: [r[8], r[9]],
    triggerBits: 8,
    buttons: {
      ...hat(r[5] & 0x0f),
      x: bit(5, 4),
      a: bit(5, 5),
      b: bit(5, 6),
      y: bit(5, 7),
      lb: bit(6, 0),
      rb: bit(6, 1),
      lt: bit(6, 2),
      rt: bit(6, 3),
      view: bit(6, 4),
      menu: bit(6, 5),
      ls: bit(6, 6),
      rs: bit(6, 7),
      guide: bit(7, 0),
      share: bit(7, 1),
      p1: bit(7, 3),
      p2: bit(7, 4),
      fnL: bit(7, 5),
    },
    battery: data[35] ? { percent: Math.min(100, data[35]), charging: data[34] !== 0 } : undefined,
  };
}

// ---- XInput and the Gamepad API

export interface XInputReading {
  t: number;
  n: number;
  b: number;
  lt: number;
  rt: number;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
}

const XB = { up: 0x0001, down: 0x0002, left: 0x0004, right: 0x0008, start: 0x0010, back: 0x0020, ls: 0x0040, rs: 0x0080, lb: 0x0100, rb: 0x0200, guide: 0x0400, a: 0x1000, b: 0x2000, x: 0x4000, y: 0x8000 } as const;
const axis16s = (v: number) => Math.max(-1, Math.min(1, v / (v < 0 ? 32768 : 32767)));

/** One XInput reading (the bridge's microsecond clock in `t`). */
export function parseXInput(r: XInputReading): PadState {
  return {
    t: r.t / 1000,
    form: "XInput state",
    sticks: [
      { x: axis16s(r.lx), y: -axis16s(r.ly) },
      { x: axis16s(r.rx), y: -axis16s(r.ry) },
    ],
    sticksRaw: [
      { x: r.lx, y: r.ly },
      { x: r.rx, y: r.ry },
    ],
    stickBits: 16,
    triggers: [r.lt / 255, r.rt / 255],
    triggersRaw: [r.lt, r.rt],
    triggerBits: 8,
    buttons: {
      dUp: !!(r.b & XB.up),
      dDown: !!(r.b & XB.down),
      dLeft: !!(r.b & XB.left),
      dRight: !!(r.b & XB.right),
      menu: !!(r.b & XB.start),
      view: !!(r.b & XB.back),
      ls: !!(r.b & XB.ls),
      rs: !!(r.b & XB.rs),
      lb: !!(r.b & XB.lb),
      rb: !!(r.b & XB.rb),
      guide: !!(r.b & XB.guide),
      a: !!(r.b & XB.a),
      b: !!(r.b & XB.b),
      x: !!(r.b & XB.x),
      y: !!(r.b & XB.y),
      lt: r.lt > 30,
      rt: r.rt > 30,
    },
  };
}

/** The Gamepad API's standard mapping, button by index. */
const STANDARD: readonly PadButton[] = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "view", "menu", "ls", "rs", "dUp", "dDown", "dLeft", "dRight", "guide", "share"];

/** A browser Gamepad snapshot (standard mapping where the browser gives one). */
export function parseGamepad(g: Pick<Gamepad, "axes" | "buttons" | "timestamp" | "mapping">): PadState {
  const ax = (i: number) => Math.max(-1, Math.min(1, g.axes[i] ?? 0));
  const buttons: PadState["buttons"] = {};
  g.buttons.forEach((b, i) => {
    const id = STANDARD[i];
    if (id) buttons[id] = b.pressed;
  });
  return {
    t: g.timestamp,
    form: g.mapping === "standard" ? "Gamepad API (standard mapping)" : "Gamepad API",
    sticks: [
      { x: ax(0), y: ax(1) },
      { x: ax(2), y: ax(3) },
    ],
    triggers: [g.buttons[6]?.value ?? 0, g.buttons[7]?.value ?? 0],
    buttons,
  };
}
