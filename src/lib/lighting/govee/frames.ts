// Govee's BLE light protocol, the plaintext layer: 20-byte frames (header, command, payload, XOR checksum) for every
// model SYNQ drives, built and judged against that model's spec (src/lib/lighting/govee/spec.ts): the colour
// dialect it takes, its segments, white range and brightness scale, its scene catalogue, music modes and DIY. Also the
// replies and events lamps send, and the multi-packet uploads. The transport (encryption v1 / v2, the GATT link) is
// the bridge's: src-tauri/src/lighting. Sources (MIT): Fredde87/ha-govee-led-ble PROTOCOL.md / COMMANDS.md and its
// encoders, and Beshelmek/govee_ble_lights (scene catalogues). docs/devices/LIGHTING.md has the evidence per frame.
//
// src-tauri/src/lighting/govee/guard.rs mirrors `checkLightFrame` and `checkLightUpload` exactly; frames.txt
// (scripts/govee-fixtures.ts) holds the two to the same verdicts. Pure functions: no DOM, no device access.
import { DIY_CODES, diyPairAllowed } from "./diy.ts";
import { KELVIN_STEP, kelvinRgb } from "./kelvin.ts";
import { sceneData } from "./scenes.generated.ts";
import { DIALECT, limitOf, type GoveeSpec } from "./spec.ts";

export { KELVIN_STEP, kelvinRgb };
export type Rgb = readonly [number, number, number];

export const FRAME_LEN = 20;
export const HEAD = { set: 0x33, query: 0xaa, event: 0xee, upload: 0xa3 } as const;
export const CMD = { power: 0x01, brightness: 0x04, mode: 0x05, version: 0x06, gradual: 0xa3, segments: 0xa5, icCount: 0x40 } as const;
/** The non-colour modes; colour takes the model's dialect (DIALECT). */
export const MODE = { scene: 0x04, music: 0x13, diy: 0x0a } as const;
/** Multi-packet upload types (the header byte of the A3 payload). */
export const UPLOAD = { scene: 0x02, diy: 0x04 } as const;
export type UploadKind = keyof typeof UPLOAD;

export const xorOf = (b: ArrayLike<number>, n = b.length) => {
  let x = 0;
  for (let i = 0; i < n; i++) x ^= b[i];
  return x;
};

/** A 20-byte frame: the bytes, zero padding, the XOR checksum. */
export function frame(bytes: readonly number[]): Uint8Array {
  if (bytes.length > FRAME_LEN - 1) throw new RangeError("a frame holds 19 bytes and its checksum");
  const f = new Uint8Array(FRAME_LEN);
  f.set(bytes.map((b) => b & 0xff));
  f[FRAME_LEN - 1] = xorOf(f, FRAME_LEN - 1);
  return f;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
const lo = (v: number) => v & 0xff;
const hi = (v: number) => (v >> 8) & 0xff;

// ---- colour helpers

/** Every segment the model's masks may name in a dialect (little-endian on the wire); 0x15 by default. */
export const allSegments = (s: GoveeSpec, dialect: number = DIALECT.typed) => (1 << limitOf(s, dialect)) - 1;

/** Colours spread across `n` segments between two or more stops (straight lines in RGB, like the app's gradient). */
export function gradient(stops: readonly Rgb[], n: number): Rgb[] {
  if (stops.length === 0) return Array.from({ length: n }, () => [0, 0, 0] as const);
  if (stops.length === 1 || n === 1) return Array.from({ length: n }, () => stops[0]);
  return Array.from({ length: n }, (_, i) => {
    const pos = (i / (n - 1)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(pos));
    const f = pos - k;
    const [a, b] = [stops[k], stops[k + 1]];
    return [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * f)) as unknown as Rgb;
  });
}

/** A colour temperature in the model's range, on the 100 K grid. */
export const kelvinFor = (s: GoveeSpec, kelvin: number) => (s.kelvin ? clamp(Math.round(kelvin / KELVIN_STEP) * KELVIN_STEP, s.kelvin[0], s.kelvin[1]) : 0);

// ---- the frames SYNQ sends

export const powerFrame = (on: boolean) => frame([HEAD.set, CMD.power, on ? 1 : 0]);
/** Brightness on the lamp's own scale (1-100, or 1-254 on the app's other scale). */
export const brightnessFrame = (value: number, max = 100) => frame([HEAD.set, CMD.brightness, clamp(value, 1, max)]);

/** One colour, for the whole light or the segments in `mask`, in the dialect the lamp takes. */
export function colourFrame(s: GoveeSpec, dialect: number, rgb: Rgb, mask = allSegments(s, dialect)): Uint8Array {
  if (dialect === DIALECT.typed) return frame([HEAD.set, CMD.mode, DIALECT.typed, 0x01, ...rgb, 0, 0, 0, 0, 0, lo(mask), hi(mask)]);
  if (dialect === DIALECT.ic) return frame([HEAD.set, CMD.mode, DIALECT.ic, ...rgb, lo(mask), hi(mask)]);
  if (dialect === DIALECT.cct) return frame([HEAD.set, CMD.mode, DIALECT.cct, ...rgb, 0, 0, 0, 0, 0]);
  return frame([HEAD.set, CMD.mode, DIALECT.rgb, ...rgb]);
}

/**
 * White at a colour temperature. 0x15 and 0x0d carry the temperature and its RGB rendering; 0x0b and 0x02 have no
 * temperature field, so they get the rendering as a colour.
 */
export function whiteFrame(s: GoveeSpec, dialect: number, kelvin: number): Uint8Array {
  const k = kelvinFor(s, kelvin);
  const rgb = kelvinRgb(k);
  if (dialect === DIALECT.typed) return frame([HEAD.set, CMD.mode, DIALECT.typed, 0x01, 0, 0, 0, hi(k), lo(k), ...rgb, lo(allSegments(s)), hi(allSegments(s))]);
  if (dialect === DIALECT.cct) return frame([HEAD.set, CMD.mode, DIALECT.cct, 0, 0, 0, hi(k), lo(k), ...rgb]);
  return colourFrame(s, dialect, rgb);
}

/** Brightness of a set of segments, 0-100 (dialect 0x15, type 2). */
export const segmentBrightnessFrame = (percent: number, mask: number) => frame([HEAD.set, CMD.mode, DIALECT.typed, 0x02, clamp(percent, 0, 100), lo(mask), hi(mask)]);
/** Four segments' colours at once, page 1-4 (dialect 0x15, type 4). The app sends gradual change off first. */
export const segmentPageFrame = (page: number, colours: readonly Rgb[]) =>
  frame([HEAD.set, CMD.mode, DIALECT.typed, 0x04, page, ...[0, 1, 2, 3].flatMap((i) => colours[i] ?? [0, 0, 0])]);
export const gradualFrame = (on: boolean) => frame([HEAD.set, CMD.gradual, on ? 1 : 0]);

/**
 * Every segment's colour. 0x15: gradual change off, then the pages (4 segments each). 0x0b: one frame per colour, with
 * the mask of the segments that have it.
 */
export function segmentFrames(s: GoveeSpec, dialect: number, colours: readonly Rgb[]): Uint8Array[] {
  const n = Math.min(colours.length, limitOf(s, dialect));
  if (dialect === DIALECT.ic) {
    const masks = new Map<string, { rgb: Rgb; mask: number }>();
    colours.slice(0, n).forEach((c, i) => {
      const k = c.join();
      const m = masks.get(k) ?? masks.set(k, { rgb: c, mask: 0 }).get(k)!;
      m.mask |= 1 << i;
    });
    return [...masks.values()].map((m) => colourFrame(s, dialect, m.rgb, m.mask));
  }
  const out = [gradualFrame(false)];
  for (let p = 0; p * 4 < n; p++) out.push(segmentPageFrame(p + 1, colours.slice(p * 4, Math.min(n, p * 4 + 4))));
  return out;
}

export const sceneFrame = (code: number) => frame([HEAD.set, CMD.mode, MODE.scene, lo(code), hi(code)]);
/** The lamp's own music mode: effect, mic sensitivity 0-99, style, and an optional fixed colour. */
export const musicFrame = (mode: number, sensitivity: number, style: number, colour: Rgb | null) =>
  frame([HEAD.set, CMD.mode, MODE.music, mode, clamp(sensitivity, 0, 99), style, colour ? 1 : 0, ...(colour ?? [])]);
export const diyFrame = (code: number) => frame([HEAD.set, CMD.mode, MODE.diy, lo(code), hi(code)]);
export const queryFrame = (cmd: number, arg?: number) => frame(arg === undefined ? [HEAD.query, cmd] : [HEAD.query, cmd, arg]);

// ---- multi-packet uploads (A3)

/** The A3 frames of one upload: [A3][index][17 bytes], the payload `01 <frame count> <type> <body…>`, last index FF. */
export function a3Frames(type: number, body: Uint8Array): Uint8Array[] {
  const data = Uint8Array.from([type, ...body]);
  const chunks = Math.ceil((data.length + 2) / 17);
  const terminator = chunks === 1;
  const payload = Uint8Array.from([0x01, chunks + (terminator ? 1 : 0), ...data]);
  const out: Uint8Array[] = [];
  for (let i = 0; i < chunks; i++) {
    const index = terminator || i !== chunks - 1 ? i : 0xff;
    out.push(frame([HEAD.upload, index, ...payload.subarray(i * 17, i * 17 + 17)]));
  }
  if (terminator) out.push(frame([HEAD.upload, 0xff]));
  return out;
}

// ---- the guard

export type Verdict = { ok: true; what: string } | { ok: false; why: string };
const no = (why: string): Verdict => ({ ok: false, why: `Govee: ${why}.` });
const yes = (what: string): Verdict => ({ ok: true, what });

/** A white in the model's range, on the 100 K grid, carrying its own RGB rendering. */
function whiteOk(s: GoveeSpec, k: number, rendering: ArrayLike<number>): boolean {
  if (!s.kelvin || k < s.kelvin[0] || k > s.kelvin[1] || k % KELVIN_STEP !== 0) return false;
  const want = kelvinRgb(k);
  return want.every((b, i) => b === rendering[i]);
}

/** Whether a single frame may go to a lamp of this model. Uploads go through `checkLightUpload` (the bridge frames them). */
export function checkLightFrame(s: GoveeSpec, f: Uint8Array): Verdict {
  if (f.length !== FRAME_LEN) return no("frames are 20 bytes");
  if (xorOf(f, FRAME_LEN - 1) !== f[FRAME_LEN - 1]) return no("bad checksum");
  const zeroFrom = (i: number) => f.subarray(i, FRAME_LEN - 1).every((b) => b === 0);
  const mask = (at: number) => f[at] | (f[at + 1] << 8);
  const maskOk = (m: number, dialect: number) => m !== 0 && (m & ~allSegments(s, dialect)) === 0;
  const typed = s.dialects.includes(DIALECT.typed);
  const pages = Math.ceil(limitOf(s, DIALECT.typed) / 4);
  const [head, cmd] = [f[0], f[1]];
  if (head === HEAD.query) {
    if ((cmd === CMD.power || cmd === CMD.brightness || cmd === CMD.version || cmd === CMD.icCount) && zeroFrom(2)) return yes("query");
    if (cmd === CMD.mode && f[2] <= 1 && zeroFrom(3)) return yes("mode query");
    if (cmd === CMD.segments && typed && f[2] >= 1 && f[2] <= pages && zeroFrom(3)) return yes("segment colour query");
    return no(`query 0x${cmd.toString(16)} isn't asked${cmd === 0xb1 ? " (it carries the device's key)" : ""}`);
  }
  if (head !== HEAD.set) {
    const why =
      head === HEAD.upload
        ? "multi-packet frames are built by the bridge from a checked upload, never sent loose"
        : head === 0xe7
          ? "the handshake is the bridge's own"
          : head === HEAD.event
            ? "0xEE is OTA preparation in this direction"
            : `header 0x${head.toString(16)} is never sent`;
    return no(why);
  }
  switch (cmd) {
    case CMD.power:
      return f[2] <= 1 && zeroFrom(3) ? yes("power") : no("power is 0 or 1");
    case CMD.brightness:
      return f[2] >= 1 && f[2] <= s.brightnessMax && zeroFrom(3) ? yes("brightness") : no(`brightness is 1-${s.brightnessMax}`);
    case CMD.gradual:
      return typed && f[2] <= 1 && zeroFrom(3) ? yes("gradual change") : no("gradual change is 0 or 1, on a 0x15 light");
    case CMD.mode:
      break;
    default:
      return no(`command 0x${cmd.toString(16)} is never sent (firmware, reset, network and name commands are refused)`);
  }
  const sub = f[2];
  if (sub === DIALECT.typed || sub === DIALECT.ic || sub === DIALECT.cct || sub === DIALECT.rgb) {
    if (!s.dialects.includes(sub)) return no(`the ${s.sku} doesn't take colour dialect 0x${sub.toString(16)}`);
    if (sub === DIALECT.rgb) return zeroFrom(6) ? yes("colour") : no("a plain colour is three bytes");
    if (sub === DIALECT.ic) return maskOk(mask(6), sub) && zeroFrom(8) ? yes("colour") : no("a colour for a set of the light's segments");
    if (sub === DIALECT.cct) {
      const k = (f[6] << 8) | f[7];
      if (!zeroFrom(11)) return no("colour and temperature are 8 bytes");
      if (k === 0) return f[8] === 0 && f[9] === 0 && f[10] === 0 ? yes("colour") : no("a colour carries no temperature rendering");
      return f[3] === 0 && f[4] === 0 && f[5] === 0 && whiteOk(s, k, f.subarray(8, 11)) ? yes("white") : no("white in the light's range, with its own RGB rendering");
    }
    const type = f[3];
    if (type === 0x01) {
      const k = (f[7] << 8) | f[8];
      if (!maskOk(mask(12), sub) || !zeroFrom(14)) return no(`a colour for a set of the light's ${limitOf(s, sub)} segments`);
      if (k === 0) return f[9] === 0 && f[10] === 0 && f[11] === 0 ? yes("colour") : no("a colour carries no temperature rendering");
      return f[4] === 0 && f[5] === 0 && f[6] === 0 && whiteOk(s, k, f.subarray(9, 12)) ? yes("white") : no(`white is the light's range in steps of ${KELVIN_STEP} K, with its own RGB rendering`);
    }
    if (type === 0x02) return f[4] <= 100 && maskOk(mask(5), sub) && zeroFrom(7) ? yes("segment brightness") : no("segment brightness is 0-100 on the light's segments");
    if (type === 0x04) {
      const page = f[4];
      if (page < 1 || page > pages || !zeroFrom(17)) return no(`segment pages 1-${pages}`);
      const used = Math.min(4, limitOf(s, DIALECT.typed) - (page - 1) * 4);
      return f.subarray(5 + used * 3, 17).every((b) => b === 0) ? yes("segment page") : no("a page past the last segment carries no colour");
    }
    return no(`colour type ${type} isn't sent`);
  }
  if (sub === MODE.scene) {
    const code = f[3] | (f[4] << 8);
    return sceneData(s.sku, code) !== undefined && zeroFrom(5) ? yes("scene") : no(`scene ${code} isn't in the ${s.sku}'s catalogue`);
  }
  if (sub === MODE.music) {
    const [mode, sens, style, count] = [f[3], f[4], f[5], f[6]];
    if (!s.music.some((m) => m.id === mode) || sens > 99 || style > 1 || count > 1) return no("a music mode of the light's own, sensitivity 0-99");
    return zeroFrom(count ? 10 : 7) ? yes("music") : no("music carries one colour at most");
  }
  if (sub === MODE.diy) {
    const code = f[3] | (f[4] << 8);
    return s.diy && DIY_CODES.includes(code) && zeroFrom(5) ? yes("DIY") : no(`DIY slot ${code} isn't used on the ${s.sku}`);
  }
  return no(`mode 0x${sub.toString(16)} isn't sent (video, DreamView and the rest stay off)`);
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Whether an upload body may go to a lamp of this model: one of its catalogue scenes byte for byte, or a DIY effect. */
export function checkLightUpload(s: GoveeSpec, kind: UploadKind, body: Uint8Array, sceneCode?: number): Verdict {
  if (kind === "scene") {
    const want = sceneCode === undefined ? undefined : sceneData(s.sku, sceneCode);
    return want && same(want, body) ? yes("scene data") : no(`scene data must be the ${s.sku} catalogue's own for that scene, byte for byte`);
  }
  if (kind !== "diy") return no("only scene and DIY uploads are sent");
  if (!s.diy) return no(`the ${s.sku} isn't sent DIY effects`);
  // [family][variant][speed][3 * colours][colours…] and, for a combo (family 0xFF), [2 * pairs][(family, variant)…].
  const [family, variant, speed, len] = body;
  if (body.length < 4 || speed > 100 || len % 3 !== 0 || len < 3 || len > 24 || body.length < 4 + len) return no("a DIY effect: speed 0-100, 1-8 colours");
  if (family !== 0xff) return diyPairAllowed(family, variant) && body.length === 4 + len ? yes("DIY effect") : no("a DIY style the light has");
  const n = body[4 + len];
  if (variant !== 0 || n % 2 !== 0 || n < 2 || n > 8 || body.length !== 5 + len + n) return no("a combo of 1-4 DIY styles");
  for (let i = 0; i < n; i += 2) if (!diyPairAllowed(body[5 + len + i], body[6 + len + i])) return no("a combo of DIY styles the light has");
  return yes("DIY combo");
}

// ---- replies and events (the lamp to SYNQ)

export type LampReport =
  | { kind: "power"; on: boolean }
  | { kind: "brightness"; value: number }
  | { kind: "mode"; mode: number; data: Uint8Array }
  | { kind: "version"; text: string }
  | { kind: "segments"; page: number; segments: { brightness: number; rgb: Rgb }[] }
  | { kind: "ics"; ics: number; segments: number }
  | { kind: "ack"; cmd: number }
  | { kind: "upload"; type: number; ok: boolean }
  | { kind: "other" };

export function parseReport(f: Uint8Array): LampReport | null {
  if (f.length !== FRAME_LEN || xorOf(f, FRAME_LEN - 1) !== f[FRAME_LEN - 1]) return null;
  const [head, cmd] = [f[0], f[1]];
  if (head === HEAD.event && cmd === 0x30 && f[2] === 0x01) return { kind: "power", on: f[3] === 1 };
  if (head === HEAD.upload) return { kind: "upload", type: cmd, ok: f[2] === 0 };
  if (head === HEAD.set) return { kind: "ack", cmd };
  if (head !== HEAD.query) return { kind: "other" };
  switch (cmd) {
    case CMD.power:
      return { kind: "power", on: f[2] === 1 };
    case CMD.brightness:
      return { kind: "brightness", value: f[2] };
    case CMD.mode:
      return { kind: "mode", mode: f[2], data: f.slice(3, FRAME_LEN - 1) };
    case CMD.version:
      return { kind: "version", text: String.fromCharCode(...f.subarray(2, FRAME_LEN - 1).filter((b) => b >= 0x20 && b < 0x7f)) };
    case CMD.segments:
      return { kind: "segments", page: f[2], segments: [0, 1, 2, 3].map((i) => ({ brightness: f[3 + i * 4], rgb: [f[4 + i * 4], f[5 + i * 4], f[6 + i * 4]] as const })) };
    case CMD.icCount:
      return { kind: "ics", ics: (f[2] << 8) | f[3], segments: f[4] };
    default:
      return { kind: "other" };
  }
}
