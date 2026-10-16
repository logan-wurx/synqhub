// The browser preview's and the end-to-end build's Wi-Fi lights: one of each brand, answering the messages the page
// builds the way the real ones do (brands.ts reads the answers back). The Hue bridge starts unpaired, so pairing can be
// tried; its two lights appear once it is. Nothing here touches a network.
import { hsv, lifxFrame, rgbOfHsv } from "./brands.ts";
import type { Brand, Json, NetMessage } from "./guard.ts";
import type { NetFound, Reply } from "./link.ts";

interface SimState {
  on: boolean;
  /** 0-100. */
  bri: number;
  /** Hue 0-360 and saturation 0-1, or a white in Kelvin. */
  h: number;
  s: number;
  k: number | null;
}

const LIGHTS: NetFound[] = [
  { brand: "hue", id: "001788fffe5e1a2b", name: "Hue Bridge", model: "BSB002", host: "192.168.1.40", port: 80, paired: false },
  { brand: "nanoleaf", id: "nl-5a6b7c", name: "Shapes", model: "NL42", host: "192.168.1.41", port: 16021, paired: true },
  { brand: "elgato", id: "elgato-3c6a", name: "Key Light", model: "Elgato Key Light", host: "192.168.1.42", port: 9123, paired: true },
  { brand: "twinkly", id: "twinkly-8d1e", name: "Twinkly Strings", model: "Twinkly", host: "192.168.1.43", port: 80, paired: true },
  { brand: "wiz", id: "a8bb50d1e2f3", name: "WiZ Bulb", model: "WiZ light", host: "192.168.1.44", port: 38899, mac: "a8bb50d1e2f3", paired: true },
  { brand: "yeelight", id: "0x15243f", name: "Yeelight Strip", model: "stripe", host: "192.168.1.45", port: 55443, paired: true },
  { brand: "lifx", id: "d073d5a1b2c3", name: "LIFX Bulb", model: "LIFX Color", host: "192.168.1.46", port: 56700, mac: "d073d5a1b2c3", paired: true },
];
const HUE_LIGHTS: Record<string, { name: string; productname: string }> = {
  "1": { name: "Desk lamp", productname: "Hue color lamp" },
  "2": { name: "Hue Play", productname: "Hue play" },
};

const states = new Map<string, SimState>();
const state = (key: string): SimState => {
  let s = states.get(key);
  if (!s) states.set(key, (s = { on: true, bri: 70, h: 30, s: 0.6, k: null }));
  return s;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const obj = (v: Json | undefined): Record<string, Json> => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const n = (v: Json | undefined, fallback: number) => (typeof v === "number" ? v : fallback);
const json = (body: Json): Reply => ({ kind: "json", body });

export async function simList(): Promise<NetFound[]> {
  await wait(300);
  return LIGHTS.map((l) => ({ ...l }));
}

/** When the simulated button was "pressed": pairing succeeds from the second ask on, as if the person pressed it after Pair. */
const asked = new Map<string, number>();
export async function simPair(brand: Brand, id: string): Promise<void> {
  await wait(300);
  const l = LIGHTS.find((x) => x.brand === brand && x.id === id);
  if (!l) throw new Error("SYNQ hasn't found that light on the network.");
  const first = asked.get(id) ?? Date.now();
  asked.set(id, first);
  if (Date.now() - first < 1500) throw new Error("The bridge said no: press its link button, then Pair within 30 seconds.");
  l.paired = true;
}

export async function simForget(brand: Brand, id: string): Promise<void> {
  const l = LIGHTS.find((x) => x.brand === brand && x.id === id);
  if (l && (brand === "hue" || brand === "nanoleaf")) l.paired = false;
  asked.delete(id);
}

/** The bridge's scenes: two of both lights, one of the desk lamp alone, and one the Hue app keeps for itself. */
const HUE_SCENES: Record<string, { name: string; type: string; group?: string; lights: string[]; recycle: boolean; xy: [number, number][] }> = {
  "sc-relax-01": { name: "Relax", type: "GroupScene", group: "1", lights: ["1", "2"], recycle: false, xy: [[0.5019, 0.4152], [0.4573, 0.41]] },
  "sc-tropic-02": { name: "Tropical twilight", type: "LightScene", lights: ["1", "2"], recycle: false, xy: [[0.2316, 0.1251], [0.5596, 0.3349]] },
  "sc-read-03": { name: "Read", type: "LightScene", lights: ["1"], recycle: false, xy: [[0.4449, 0.4066]] },
  "sc-app-04": { name: "Hue app's own", type: "LightScene", lights: ["1"], recycle: true, xy: [[0.3, 0.3]] },
};

function hue(id: string, m: Extract<NetMessage, { kind: "http" }>): Reply {
  if (m.method === "GET" && m.path.endsWith("/scenes")) return json(Object.fromEntries(Object.entries(HUE_SCENES).map(([k, s]) => [k, { name: s.name, type: s.type, ...(s.group ? { group: s.group } : {}), lights: s.lights, recycle: s.recycle }])));
  if (m.method === "GET" && m.path.includes("/scenes/")) {
    const s = HUE_SCENES[m.path.split("/").pop() ?? ""];
    return s ? json({ name: s.name, lights: s.lights, lightstates: Object.fromEntries(s.lights.map((l, i) => [l, { on: true, bri: 200, xy: s.xy[i] ?? s.xy[0] }])) }) : json([{ error: { type: 3, description: "resource not available" } }]);
  }
  if (m.method === "PUT" && m.path.endsWith("/action")) {
    // A scene recalled: its lights take its first colour (the pretend bridge keeps one colour per light).
    const scene = HUE_SCENES[String(obj(m.body).scene)];
    for (const l of scene?.lights ?? []) Object.assign(state(`hue:${id}:${l}`), { on: true, h: 30, s: 0.7, k: null });
    return json([{ success: {} }]);
  }
  if (m.method === "GET") {
    const lights: Record<string, Json> = {};
    for (const [n_, info] of Object.entries(HUE_LIGHTS)) {
      const s = state(`hue:${id}:${n_}`);
      lights[n_] = { ...info, state: s.k ? { on: s.on, bri: Math.round(s.bri * 2.54), ct: Math.round(1e6 / s.k), colormode: "ct" } : { on: s.on, bri: Math.round(s.bri * 2.54), hue: Math.round((s.h / 360) * 65535), sat: Math.round(s.s * 254), colormode: "hs" } };
    }
    return json(lights);
  }
  const s = state(`hue:${id}:${m.path.split("/")[4]}`);
  const b = obj(m.body);
  if (typeof b.on === "boolean") s.on = b.on;
  if (typeof b.bri === "number") s.bri = Math.max(1, Math.round(b.bri / 2.54));
  if (typeof b.hue === "number") [s.h, s.s, s.k] = [(b.hue / 65535) * 360, n(b.sat, 254) / 254, null];
  if (typeof b.ct === "number") s.k = Math.round(1e6 / b.ct);
  return json([{ success: {} }]);
}

let nanoleafEffect = "Forest";

function nanoleaf(id: string, m: Extract<NetMessage, { kind: "http" }>): Reply {
  const s = state(`nanoleaf:${id}`);
  if (m.method === "GET") return json({ name: "Shapes", state: { on: { value: s.on }, brightness: { value: s.bri }, hue: { value: Math.round(s.h) }, sat: { value: Math.round(s.s * 100) }, ct: { value: s.k ?? 4000 }, colorMode: s.k ? "ct" : "hs" }, effects: { select: nanoleafEffect, effectsList: ["Northern Lights", "Forest", "Fireplace", "Nemo"] } });
  const b = obj(m.body);
  if (typeof b.select === "string") nanoleafEffect = b.select;
  const v = (k: string) => obj(b[k]).value;
  if (typeof v("on") === "boolean") s.on = v("on") as boolean;
  if (typeof v("brightness") === "number") s.bri = v("brightness") as number;
  if (typeof v("hue") === "number") [s.h, s.s, s.k] = [v("hue") as number, n(v("sat"), 100) / 100, null];
  if (typeof v("ct") === "number") s.k = v("ct") as number;
  return { kind: "none" };
}

function elgato(id: string, m: Extract<NetMessage, { kind: "http" }>): Reply {
  const s = state(`elgato:${id}`);
  if (m.method === "PUT") {
    const l = obj((obj(m.body).lights as Json[] | undefined)?.[0]);
    if (typeof l.on === "number") s.on = l.on === 1;
    if (typeof l.brightness === "number") s.bri = l.brightness;
    if (typeof l.temperature === "number") s.k = Math.round(1e6 / l.temperature);
  }
  return json({ numberOfLights: 1, lights: [{ on: s.on ? 1 : 0, brightness: s.bri, temperature: Math.round(1e6 / (s.k ?? 4000)) }] });
}

function twinkly(id: string, m: Extract<NetMessage, { kind: "http" }>): Reply {
  const s = state(`twinkly:${id}`);
  const b = obj(m.body);
  if (m.path.endsWith("/led/mode")) {
    if (m.method === "POST") s.on = b.mode !== "off";
    return json({ mode: s.on ? "movie" : "off", code: 1000 });
  }
  if (m.path.endsWith("/out/brightness")) {
    if (m.method === "POST") s.bri = n(b.value, s.bri);
    return json({ mode: "enabled", value: s.bri, code: 1000 });
  }
  if (m.path.endsWith("/led/color")) [s.h, s.s, s.k] = [...hsv([n(b.red, 0), n(b.green, 0), n(b.blue, 0)]).slice(0, 2), null] as [number, number, null];
  return json({ code: 1000 });
}

function wiz(id: string, body: Record<string, Json>): Reply {
  const s = state(`wiz:${id}`);
  const p = obj(body.params);
  if (body.method === "getPilot") {
    const [r, g, b] = rgbOfHsv(s.h, s.s);
    return json({ method: "getPilot", id: body.id ?? 0, result: s.k ? { state: s.on, dimming: s.bri, temp: s.k } : { state: s.on, dimming: s.bri, r, g, b } });
  }
  if (typeof p.state === "boolean") s.on = p.state;
  if (typeof p.dimming === "number") s.bri = p.dimming;
  if (typeof p.temp === "number") s.k = p.temp;
  if (typeof p.r === "number") [s.h, s.s, s.k] = [...hsv([p.r, n(p.g, 0), n(p.b, 0)]).slice(0, 2), null] as [number, number, null];
  return json({ method: "setPilot", id: body.id ?? 0, result: { success: true } });
}

function yeelight(id: string, body: Record<string, Json>): Reply {
  const s = state(`yeelight:${id}`);
  const p = Array.isArray(body.params) ? body.params : [];
  if (body.method === "get_prop") {
    const [r, g, b] = rgbOfHsv(s.h, s.s);
    return json({ id: body.id ?? 0, result: [s.on ? "on" : "off", String(s.bri), String(s.k ?? 4000), String((r << 16) | (g << 8) | b), s.k ? "2" : "1"] });
  }
  if (body.method === "set_power") s.on = p[0] === "on";
  if (body.method === "set_bright") s.bri = n(p[0], s.bri);
  if (body.method === "set_ct_abx") s.k = n(p[0], 4000);
  if (body.method === "set_rgb") {
    const v = n(p[0], 0);
    [s.h, s.s, s.k] = [...hsv([(v >> 16) & 255, (v >> 8) & 255, v & 255]).slice(0, 2), null] as [number, number, null];
  }
  return json({ id: body.id ?? 0, result: ["ok"] });
}

function lifx(id: string, mac: string, bytes: Uint8Array): Reply {
  const s = state(`lifx:${id}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  const type = dv.getUint16(32, true);
  if (type === 117) s.on = dv.getUint16(36, true) > 0;
  if (type === 102) {
    const [h, sat, b, k] = [37, 39, 41, 43].map((o) => dv.getUint16(o, true));
    s.bri = Math.max(1, Math.round((b / 65535) * 100));
    if (sat < 0x0400) s.k = k;
    else [s.h, s.s, s.k] = [(h / 65535) * 360, sat / 65535, null];
  }
  if (type !== 101) return { kind: "none" };
  // LightState (107): HSBK, 2 reserved, power, a 32-byte label, 8 reserved.
  const le = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  const hsbk = s.k ? [0, 0, Math.round((s.bri / 100) * 65535), s.k] : [Math.round((s.h / 360) * 65535), Math.round(s.s * 65535), Math.round((s.bri / 100) * 65535), 3500];
  const reply = lifxFrame(mac, 107, [...hsbk.flatMap(le), 0, 0, ...le(s.on ? 65535 : 0), ...Array.from({ length: 40 }, () => 0)]);
  reply[23] = bytes[23];
  return { kind: "bytes", bytes: Array.from(reply) };
}

export async function simSend(brand: Brand, id: string, m: NetMessage): Promise<Reply> {
  await wait(25);
  const l = LIGHTS.find((x) => x.brand === brand && x.id === id);
  if (!l) throw new Error("SYNQ hasn't found that light on the network.");
  if (!l.paired) throw new Error("Pair with the light first.");
  if (m.kind === "lifx") return lifx(id, l.mac ?? "", m.bytes);
  if (m.kind === "json") return brand === "wiz" ? wiz(id, obj(m.body)) : yeelight(id, obj(m.body));
  switch (brand) {
    case "hue":
      return hue(id, m);
    case "nanoleaf":
      return nanoleaf(id, m);
    case "elgato":
      return elgato(id, m);
    default:
      return twinkly(id, m);
  }
}
