// The Wi-Fi lights of wave L3, one entry per brand: how SYNQ pairs with it, the messages for power, brightness,
// colour and white and for reading the light back, and how to read the answers. Every message passes guard.ts here
// and the bridge's guard.rs before it leaves the PC; the bridge fills in a pairing key (`{token}`) itself, so keys
// never reach the page. Sources: Philips Hue's v1 API, Nanoleaf's OpenAPI, Elgato's local API, Twinkly's xled API,
// WiZ's UDP JSON (as pywizlight documents it), Yeelight's inter-operation spec, LIFX's LAN protocol. All UNVERIFIED on
// real lights until an owner reports (docs/devices/LIGHTING.md §L3).
import type { Rgb } from "../govee/frames.ts";
import { NET_MAKERS } from "../models.ts";
import type { Brand, Json, NetMessage } from "./guard.ts";

export interface NetDevice {
  brand: Brand;
  /** Stable: the bridge's id, the light's MAC or serial. */
  id: string;
  name: string;
  model: string;
  /** The IP address discovery found (the bridge sends only to addresses it found). */
  host: string;
  /** Paired (it has a key, or needs none). */
  paired: boolean;
  /** A Hue light's number on its bridge. */
  sub?: string;
  /** A LIFX light's address (12 hex digits). */
  mac?: string;
}

export interface NetState {
  power: boolean | null;
  brightness: number | null;
  colour: Rgb | null;
  kelvin: number | null;
}

export interface NetBrand {
  brand: Brand;
  maker: string;
  /** How a light is paired: no key, a button on the device, a key the bridge fetches itself, or a setting in the maker's app. */
  pairing: "none" | "button" | "auto" | "app";
  /** What the person does to pair or to allow local control (shown on the card). */
  pairingSteps?: string;
  /** First-time Wi-Fi setup: SYNQ never provisions Wi-Fi; this says where it's done. */
  setup: string;
  kelvin: readonly [number, number] | null;
  colour: boolean;
  power(d: NetDevice, on: boolean): NetMessage[];
  brightness(d: NetDevice, percent: number, now: NetState): NetMessage[];
  colourTo(d: NetDevice, rgb: Rgb, now: NetState): NetMessage[];
  white(d: NetDevice, kelvin: number, now: NetState): NetMessage[];
  query(d: NetDevice): NetMessage[];
  /** The light's state from the answers to `query` (in the same order). */
  read(d: NetDevice, answers: readonly (Json | Uint8Array | null)[]): Partial<NetState>;
}

// ---- colour helpers

/** Hue (0-360), saturation and value (0-1) of a colour. */
export function hsv([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max === 0 ? 0 : d / max, max / 255];
}

export function rgbOfHsv(h: number, s: number, v = 1): Rgb {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
const isObj = (v: unknown): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
const num = (v: Json | undefined) => (typeof v === "number" ? v : null);
const http = (method: "GET" | "PUT" | "POST", path: string, body?: Json): NetMessage => (body === undefined ? { kind: "http", method, path } : { kind: "http", method, path, body });

// ---- Philips Hue (a bridge on the network; each light is a device behind it)

const hueState = (d: NetDevice, body: Json) => http("PUT", `/api/{token}/lights/${d.sub}/state`, body);
export const HUE: NetBrand = {
  brand: "hue",
  maker: NET_MAKERS.hue,
  pairing: "button",
  pairingSteps: "Within 30 seconds, press the round link button on top of the Hue Bridge.",
  setup: "The bridge joins your network by cable; add lights to it once with the Hue app.",
  kelvin: [2000, 6500],
  colour: true,
  power: (d, on) => [hueState(d, { on })],
  brightness: (d, p) => [hueState(d, { on: true, bri: clamp((p / 100) * 254, 1, 254) })],
  colourTo: (d, rgb) => {
    const [h, s] = hsv(rgb);
    return [hueState(d, { on: true, hue: clamp((h / 360) * 65535, 0, 65535), sat: clamp(s * 254, 0, 254) })];
  },
  white: (d, k) => [hueState(d, { on: true, ct: clamp(1e6 / k, 153, 500) })],
  query: () => [http("GET", "/api/{token}/lights")],
  read: (d, [lights]) => {
    const l = isObj(lights) ? lights[d.sub ?? ""] : null;
    const st = isObj(l) && isObj(l.state) ? l.state : null;
    if (!st) return {};
    const bri = num(st.bri);
    const out: Partial<NetState> = { power: st.on === true, brightness: bri === null ? null : Math.max(1, Math.round((bri / 254) * 100)) };
    if (st.colormode === "ct" && num(st.ct)) out.kelvin = Math.round(1e6 / num(st.ct)!);
    else if (num(st.hue) !== null && num(st.sat) !== null) out.colour = rgbOfHsv((num(st.hue)! / 65535) * 360, num(st.sat)! / 254);
    return out;
  },
};

// ---- Nanoleaf (panels and lines; OpenAPI on port 16021)

const nanoleafState = (body: Json) => http("PUT", "/api/v1/{token}/state", body);
export const NANOLEAF: NetBrand = {
  brand: "nanoleaf",
  maker: NET_MAKERS.nanoleaf,
  pairing: "button",
  pairingSteps: "Within 30 seconds, hold the controller's power button for 5 to 7 seconds, until its lights flash.",
  setup: "Join it to your Wi-Fi once with the Nanoleaf app.",
  kelvin: [1200, 6500],
  colour: true,
  power: (_d, on) => [nanoleafState({ on: { value: on } })],
  brightness: (_d, p) => [nanoleafState({ brightness: { value: clamp(p, 0, 100) } })],
  colourTo: (_d, rgb) => {
    const [h, s] = hsv(rgb);
    return [nanoleafState({ hue: { value: clamp(h, 0, 360) }, sat: { value: clamp(s * 100, 0, 100) } })];
  },
  white: (_d, k) => [nanoleafState({ ct: { value: clamp(k, 1200, 6500) } })],
  query: () => [http("GET", "/api/v1/{token}/")],
  read: (_d, [info]) => {
    const st = isObj(info) && isObj(info.state) ? info.state : null;
    if (!st) return {};
    const val = (k: string) => (isObj(st[k]) ? (st[k] as Record<string, Json>).value : undefined);
    const out: Partial<NetState> = { power: val("on") === true, brightness: num(val("brightness")) };
    if (st.colorMode === "ct" && num(val("ct"))) out.kelvin = num(val("ct"));
    else if (num(val("hue")) !== null && num(val("sat")) !== null) out.colour = rgbOfHsv(num(val("hue"))!, num(val("sat"))! / 100);
    return out;
  },
};

// ---- Elgato Key Light / Light Strip (port 9123)

const elgato = (light: Record<string, Json>) => http("PUT", "/elgato/lights", { numberOfLights: 1, lights: [light] });
export const ELGATO: NetBrand = {
  brand: "elgato",
  maker: NET_MAKERS.elgato,
  pairing: "none",
  setup: "Join it to your Wi-Fi once with Elgato Control Center.",
  kelvin: [2900, 7000],
  colour: true,
  power: (_d, on) => [elgato({ on: on ? 1 : 0 })],
  brightness: (_d, p) => [elgato({ on: 1, brightness: clamp(p, 0, 100) })],
  // The Key Light has no colour; the Light Strip takes hue and saturation.
  colourTo: (d, rgb) => {
    if (!/strip/i.test(d.model)) return [];
    const [h, s] = hsv(rgb);
    return [elgato({ on: 1, hue: clamp(h, 0, 360), saturation: clamp(s * 100, 0, 100) })];
  },
  white: (_d, k) => [elgato({ on: 1, temperature: clamp(1e6 / k, 143, 344) })],
  query: () => [http("GET", "/elgato/lights")],
  read: (_d, [res]) => {
    const l = isObj(res) && Array.isArray(res.lights) && isObj(res.lights[0]) ? (res.lights[0] as Record<string, Json>) : null;
    if (!l) return {};
    const out: Partial<NetState> = { power: l.on === 1, brightness: num(l.brightness) };
    if (num(l.temperature)) out.kelvin = Math.round(1e6 / num(l.temperature)!);
    if (num(l.hue) !== null && num(l.saturation) !== null) out.colour = rgbOfHsv(num(l.hue)!, num(l.saturation)! / 100);
    return out;
  },
};

// ---- Twinkly (string lights; the bridge logs in with the light's own challenge, no key to fetch)

export const TWINKLY: NetBrand = {
  brand: "twinkly",
  maker: NET_MAKERS.twinkly,
  pairing: "auto",
  setup: "Join it to your Wi-Fi once with the Twinkly app.",
  kelvin: null,
  colour: true,
  power: (_d, on) => [http("POST", "/xled/v1/led/mode", { mode: on ? "movie" : "off" })],
  brightness: (_d, p) => [http("POST", "/xled/v1/led/out/brightness", { mode: "enabled", type: "A", value: clamp(p, 0, 100) })],
  colourTo: (_d, [red, green, blue]) => [http("POST", "/xled/v1/led/color", { red, green, blue }), http("POST", "/xled/v1/led/mode", { mode: "color" })],
  white: () => [],
  query: () => [http("GET", "/xled/v1/led/mode"), http("GET", "/xled/v1/led/out/brightness")],
  read: (_d, [mode, bright]) => ({
    power: isObj(mode) && typeof mode.mode === "string" ? mode.mode !== "off" : null,
    brightness: isObj(bright) ? num(bright.value) : null,
  }),
};

// ---- WiZ (bulbs; JSON over UDP 38899)

let wizId = 0;
const pilot = (params: Record<string, Json>): NetMessage => ({ kind: "json", body: { id: (wizId = (wizId + 1) % 65536), method: "setPilot", params } });
export const WIZ: NetBrand = {
  brand: "wiz",
  maker: NET_MAKERS.wiz,
  pairing: "none",
  setup: "Join it to your Wi-Fi once with the WiZ app.",
  kelvin: [2200, 6500],
  colour: true,
  power: (_d, state) => [pilot({ state })],
  brightness: (_d, p) => [pilot({ state: true, dimming: clamp(p, 10, 100) })],
  colourTo: (_d, [r, g, b]) => [pilot({ state: true, r, g, b })],
  white: (_d, k) => [pilot({ state: true, temp: clamp(k, 2200, 6500) })],
  query: () => [{ kind: "json", body: { id: 0, method: "getPilot", params: {} } }],
  read: (_d, [res]) => {
    const r = isObj(res) && isObj(res.result) ? res.result : null;
    if (!r) return {};
    const out: Partial<NetState> = { power: r.state === true, brightness: num(r.dimming) };
    if (num(r.temp)) out.kelvin = num(r.temp);
    else if (num(r.r) !== null) out.colour = [num(r.r)!, num(r.g) ?? 0, num(r.b) ?? 0];
    return out;
  },
};

// ---- Yeelight (bulbs and strips; JSON lines over TCP 55443, once LAN Control is on)

let yeeId = 0;
const yee = (method: string, params: Json[]): NetMessage => ({ kind: "json", body: { id: (yeeId = (yeeId % 65535) + 1), method, params } });
export const YEELIGHT: NetBrand = {
  brand: "yeelight",
  maker: NET_MAKERS.yeelight,
  pairing: "app",
  pairingSteps: "Switch on LAN Control for the light in Yeelight's own app (the light's settings, LAN Control).",
  setup: "Join it to your Wi-Fi once with the Yeelight app.",
  kelvin: [1700, 6500],
  colour: true,
  power: (_d, on) => [yee("set_power", [on ? "on" : "off", "smooth", 300])],
  brightness: (_d, p) => [yee("set_bright", [clamp(p, 1, 100), "smooth", 300])],
  colourTo: (_d, [r, g, b]) => [yee("set_rgb", [(r << 16) | (g << 8) | b, "smooth", 300])],
  white: (_d, k) => [yee("set_ct_abx", [clamp(k, 1700, 6500), "smooth", 300])],
  query: () => [yee("get_prop", ["power", "bright", "ct", "rgb", "color_mode"])],
  read: (_d, [res]) => {
    const r = isObj(res) && Array.isArray(res.result) ? res.result : null;
    if (!r) return {};
    const [, bright, ct, rgb, mode] = r.map((x) => Number(x));
    const out: Partial<NetState> = { power: r[0] === "on", brightness: Number.isFinite(bright) ? bright : null };
    if (mode === 2 && ct) out.kelvin = ct;
    else if (Number.isFinite(rgb)) out.colour = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
    return out;
  },
};

// ---- LIFX (bulbs and strips; the LAN protocol over UDP 56700)

const SOURCE = 0x4f4e4231; // "ONB1": SYNQ's own id in the frames, so replies can be told apart.
let lifxSeq = 0;
/** A LIFX frame to one light (by its MAC), with its payload; `answer` asks the light to reply. */
export function lifxFrame(mac: string, type: number, payload: readonly number[], answer = false): Uint8Array {
  const size = 36 + payload.length;
  const f = new Uint8Array(size);
  const dv = new DataView(f.buffer);
  dv.setUint16(0, size, true);
  dv.setUint16(2, 0x1400, true);
  dv.setUint32(4, SOURCE, true);
  for (let i = 0; i < 6; i++) f[8 + i] = parseInt(mac.slice(i * 2, i * 2 + 2), 16);
  f[22] = answer ? 0x01 : 0x00;
  f[23] = lifxSeq = (lifxSeq + 1) % 256;
  dv.setUint16(32, type, true);
  f.set(payload, 36);
  return f;
}
const le = (v: number, width: number) => Array.from({ length: width }, (_, i) => (v >>> (8 * i)) & 0xff);
const setColour = (d: NetDevice, h: number, s: number, b: number, k: number): NetMessage => ({ kind: "lifx", bytes: lifxFrame(d.mac ?? "", 102, [0, ...le(h, 2), ...le(s, 2), ...le(b, 2), ...le(k, 2), ...le(0, 4)]) });
const bri16 = (now: NetState) => clamp(((now.brightness ?? 100) / 100) * 65535, 0, 65535);
export const LIFX: NetBrand = {
  brand: "lifx",
  maker: NET_MAKERS.lifx,
  pairing: "none",
  setup: "Join it to your Wi-Fi once with the LIFX app.",
  kelvin: [1500, 9000],
  colour: true,
  power: (d, on) => [{ kind: "lifx", bytes: lifxFrame(d.mac ?? "", 117, [...le(on ? 65535 : 0, 2), ...le(0, 4)]) }],
  brightness: (d, p, now) => {
    const [h, s] = now.colour && !now.kelvin ? hsv(now.colour) : [0, 0];
    return [setColour(d, clamp((h / 360) * 65535, 0, 65535), clamp(s * 65535, 0, 65535), clamp((p / 100) * 65535, 0, 65535), clamp(now.kelvin ?? 3500, 1500, 9000))];
  },
  colourTo: (d, rgb, now) => {
    const [h, s] = hsv(rgb);
    return [setColour(d, clamp((h / 360) * 65535, 0, 65535), clamp(s * 65535, 0, 65535), bri16(now), 3500)];
  },
  white: (d, k, now) => [setColour(d, 0, 0, bri16(now), clamp(k, 1500, 9000))],
  query: (d) => [{ kind: "lifx", bytes: lifxFrame(d.mac ?? "", 101, [], true) }],
  read: (_d, [res]) => {
    if (!(res instanceof Uint8Array) || res.length < 36 + 12 || (res[32] | (res[33] << 8)) !== 107) return {};
    const dv = new DataView(res.buffer, res.byteOffset);
    const [h, s, b, k] = [0, 2, 4, 6].map((o) => dv.getUint16(36 + o, true));
    const out: Partial<NetState> = { power: dv.getUint16(36 + 10, true) > 0, brightness: Math.max(1, Math.round((b / 65535) * 100)) };
    if (s < 0x0400) out.kelvin = k;
    else out.colour = rgbOfHsv((h / 65535) * 360, s / 65535);
    return out;
  },
};

export const NET_BRANDS: Readonly<Record<Brand, NetBrand>> = { hue: HUE, nanoleaf: NANOLEAF, elgato: ELGATO, twinkly: TWINKLY, wiz: WIZ, yeelight: YEELIGHT, lifx: LIFX };
