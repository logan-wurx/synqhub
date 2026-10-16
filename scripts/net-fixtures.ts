// Writes src-tauri/src/lighting/net/messages.txt: messages to the Wi-Fi lights of wave L3 with the app guard's verdict
// (src/lib/lighting/net/guard.ts), so the bridge's copy (net/guard.rs, test `net_guard_matches_the_frontend`) is held
// to the same answers. Lines: `<brand> <1|0> <message JSON>`. The allowed lines are every message the page builds;
// the refused ones are the endpoints the brief names (firmware, network, names, resets, keys), other brands'
// messages, and each allowed message with one field pushed out of range, one key too many, or its path changed.
//
//   node scripts/net-fixtures.ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NET_BRANDS, lifxFrame, type NetDevice, type NetState } from "../src/lib/lighting/net/brands.ts";
import { checkNet, type Brand, type Json, type NetMessage } from "../src/lib/lighting/net/guard.ts";

export const NET_MESSAGES = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/src/lighting/net/messages.txt");

const devices: Record<Brand, NetDevice> = {
  hue: { brand: "hue", id: "001788fffe1a2b3c", name: "Hue Bridge", model: "BSB002", host: "192.168.1.20", paired: true, sub: "3" },
  nanoleaf: { brand: "nanoleaf", id: "nl-1", name: "Shapes", model: "NL42", host: "192.168.1.21", paired: true },
  elgato: { brand: "elgato", id: "el-1", name: "Light Strip", model: "Elgato Light Strip", host: "192.168.1.22", paired: true },
  twinkly: { brand: "twinkly", id: "tw-1", name: "Twinkly", model: "Twinkly", host: "192.168.1.23", paired: true },
  wiz: { brand: "wiz", id: "a8bb50d1e2f3", name: "WiZ", model: "WiZ light", host: "192.168.1.24", paired: true },
  yeelight: { brand: "yeelight", id: "0x15243f", name: "Yeelight", model: "color", host: "192.168.1.25", paired: true },
  lifx: { brand: "lifx", id: "d073d5010203", name: "LIFX", model: "LIFX light", host: "192.168.1.26", paired: true, mac: "d073d5010203" },
};

const NOW: NetState = { power: true, brightness: 60, colour: [255, 120, 0], kelvin: null };
const COLOURS = [[255, 0, 0], [0, 0, 255], [255, 255, 255], [10, 20, 30]] as const;

function allowed(brand: Brand): NetMessage[] {
  const b = NET_BRANDS[brand];
  const d = devices[brand];
  const out: NetMessage[] = [...b.power(d, true), ...b.power(d, false), ...b.query(d)];
  for (const p of [1, 50, 100]) out.push(...b.brightness(d, p, NOW));
  for (const c of COLOURS) out.push(...b.colourTo(d, c, NOW));
  if (b.kelvin) for (const k of [b.kelvin[0], 4000, b.kelvin[1]]) out.push(...b.white(d, k, NOW));
  // The bridge's own pairing messages (src-tauri/src/lighting/net/mod.rs `pair`).
  if (brand === "hue") out.push({ kind: "http", method: "POST", path: "/api", body: { devicetype: "onboard#DESKTOP-PC", generateclientkey: true } });
  // Hue Entertainment (wave L5): the bridge's groups, SYNQ's own area made and removed, a stream started and stopped.
  if (brand === "hue")
    out.push(
      { kind: "http", method: "GET", path: "/api/{token}/groups" },
      { kind: "http", method: "POST", path: "/api/{token}/groups", body: { name: "SYNQ", type: "Entertainment", class: "TV", lights: ["3", "4"] } },
      { kind: "http", method: "DELETE", path: "/api/{token}/groups/7" },
      { kind: "http", method: "PUT", path: "/api/{token}/groups/7", body: { stream: { active: true } } },
      { kind: "http", method: "PUT", path: "/api/{token}/groups/7", body: { stream: { active: false } } },
    );
  if (brand === "nanoleaf") out.push({ kind: "http", method: "POST", path: "/api/v1/new" });
  // Scenes the light already has, recalled (src/lib/lighting/net/scenes.ts): Hue's list, one scene's colours, a recall
  // through all lights and through a group; Nanoleaf selects an effect by name.
  if (brand === "hue")
    out.push(
      { kind: "http", method: "GET", path: "/api/{token}/scenes" },
      { kind: "http", method: "GET", path: "/api/{token}/scenes/sc-relax-01" },
      { kind: "http", method: "PUT", path: "/api/{token}/groups/0/action", body: { scene: "sc-relax-01" } },
      { kind: "http", method: "PUT", path: "/api/{token}/groups/1/action", body: { scene: "AbC-12" } },
    );
  if (brand === "nanoleaf") out.push({ kind: "http", method: "PUT", path: "/api/v1/{token}/effects", body: { select: "Northern Lights" } });
  return out;
}

const serialise = (m: NetMessage): string => JSON.stringify(m.kind === "lifx" ? { kind: "lifx", bytes: Array.from(m.bytes) } : m);

/** The brief's refusals and the endpoints nothing should reach, per brand. */
function refused(brand: Brand): NetMessage[] {
  const http = (method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: Json): NetMessage => (body === undefined ? { kind: "http", method, path } : { kind: "http", method, path, body });
  const json = (body: Json): NetMessage => ({ kind: "json", body });
  switch (brand) {
    case "hue":
      return [
        http("PUT", "/api/{token}/config", { swupdate2: { install: true } }),
        http("POST", "/api/{token}/lights"),
        http("PUT", "/api/{token}/lights/3", { name: "x" }),
        http("PUT", "/api/{token}/lights/3/state", { on: true, alert: "lselect" }),
        http("PUT", "/api/{token}/lights/3/state", {}),
        http("PUT", "/api/{token}/groups/0/action", { on: false }),
        http("POST", "/api", { devicetype: "someone-else#pc" }),
        http("POST", "/api/{token}/schedules", { name: "x" }),
        http("GET", "/api/{token}/config/whitelist"),
        http("PUT", "/api/{token}/lights/3/state", { on: true, bri: 255 }),
        // Entertainment: only an area named SYNQ, only a stream switch on a group, no other deletes.
        http("POST", "/api/{token}/groups", { name: "Living room", type: "Entertainment", class: "TV", lights: ["3"] }),
        http("POST", "/api/{token}/groups", { name: "SYNQ", type: "Room", class: "TV", lights: ["3"] }),
        http("POST", "/api/{token}/groups", { name: "SYNQ", type: "Entertainment", class: "TV" }),
        http("PUT", "/api/{token}/groups/7", { name: "x" }),
        http("PUT", "/api/{token}/groups/7", { stream: { active: true }, lights: ["1"] }),
        http("DELETE", "/api/{token}/lights/3"),
        http("DELETE", "/api/{token}/config/whitelist/abc"),
        http("DELETE", "/api/{token}/groups"),
        // Scenes: recalled only, never made, changed or deleted.
        http("POST", "/api/{token}/scenes", { name: "x", lights: ["3"] }),
        http("PUT", "/api/{token}/scenes/sc-relax-01", { name: "x" }),
        http("PUT", "/api/{token}/scenes/sc-relax-01/lightstates/3", { on: true }),
        http("DELETE", "/api/{token}/scenes/sc-relax-01"),
        http("PUT", "/api/{token}/groups/0/action", { scene: "sc-relax-01", on: true }),
        http("PUT", "/api/{token}/groups/0/action", { scene: "x/../config" }),
      ];
    case "nanoleaf":
      return [
        http("PUT", "/api/v1/{token}/panelLayout/globalOrientation", { globalOrientation: { value: 10 } }),
        http("PUT", "/api/v1/{token}/identify"),
        http("PUT", "/api/v1/{token}/effects", { write: { command: "delete", animName: "x" } }),
        http("PUT", "/api/v1/{token}/effects", { write: { command: "add", animName: "x" } }),
        http("PUT", "/api/v1/{token}/effects", { select: "x", write: { command: "request" } }),
        http("PUT", "/api/v1/{token}/state", { brightness: { value: 101 } }),
        http("PUT", "/api/v1/{token}/state", { on: true }),
        http("POST", "/api/v1/new", { token: "x" }),
      ];
    case "elgato":
      return [
        http("PUT", "/elgato/accessory-info", { displayName: "x" }),
        http("PUT", "/elgato/lights/settings", { powerOnBehavior: 1 }),
        http("POST", "/elgato/identify"),
        http("PUT", "/elgato/lights", { numberOfLights: 2, lights: [{ on: 1 }, { on: 1 }] }),
        http("PUT", "/elgato/lights", { numberOfLights: 1, lights: [{ on: 1, temperature: 100 }] }),
      ];
    case "twinkly":
      return [
        http("POST", "/xled/v1/network/status", { mode: 1, station: { ssid: "x" } }),
        http("POST", "/xled/v1/fw/0/update"),
        http("POST", "/xled/v1/led/reset"),
        http("POST", "/xled/v1/device_name", { name: "x" }),
        http("POST", "/xled/v1/login", { challenge: "AAAA" }),
        http("POST", "/xled/v1/led/mode", { mode: "rt" }),
        http("POST", "/xled/v1/led/out/brightness", { mode: "enabled", type: "R", value: 50 }),
      ];
    case "wiz":
      return [
        json({ method: "setWifiConfig", params: { ssid: "x", pass: "y" } }),
        json({ method: "setSystemConfig", params: { name: "x" } }),
        json({ method: "reboot", params: {} }),
        json({ method: "reset", params: {} }),
        json({ method: "setPilot", params: { state: true, dimming: 5 } }),
        json({ method: "setPilot", params: { state: true, extra: 1 } }),
        json({ method: "getPilot", params: { x: 1 } }),
      ];
    case "yeelight":
      return [
        json({ id: 1, method: "set_name", params: ["x"] }),
        json({ id: 1, method: "set_default", params: [] }),
        json({ id: 1, method: "cron_add", params: [0, 15] }),
        json({ id: 1, method: "set_music", params: [1, "192.168.1.2", 54321] }),
        json({ id: 1, method: "set_power", params: ["on", "smooth"] }),
        json({ id: 1, method: "set_bright", params: [101, "smooth", 300] }),
      ];
    case "lifx": {
      const d = devices.lifx;
      const label = lifxFrame(d.mac!, 24, Array.from({ length: 32 }, () => 0x41));
      const reboot = lifxFrame(d.mac!, 38, []);
      const broadcastSet = lifxFrame("000000000000", 117, [0xff, 0xff, 0, 0, 0, 0]);
      const wrongSize = lifxFrame(d.mac!, 117, [0xff, 0xff, 0, 0, 0]);
      const kelvin = lifxFrame(d.mac!, 102, [0, 0, 0, 0, 0, 0xff, 0xff, 0x10, 0x27, 0, 0, 0, 0]);
      return [label, reboot, broadcastSet, wrongSize, kelvin].map((bytes) => ({ kind: "lifx", bytes }) as NetMessage);
    }
  }
}

/** Each allowed message changed once: a number pushed past its range, a key added, the path or method changed, a LIFX byte flipped. */
function mutations(m: NetMessage): NetMessage[] {
  if (m.kind === "lifx") return [6, 16, 22, 33, 36, m.bytes.length - 1].filter((i) => i < m.bytes.length).map((i) => ({ kind: "lifx", bytes: m.bytes.map((b, j) => (j === i ? b ^ 0x80 : b)) }) as NetMessage);
  const out: NetMessage[] = [];
  const bump = (v: Json): Json[] => {
    if (typeof v === "number") return [v + 100000, -1];
    if (Array.isArray(v)) return v.flatMap((x, i) => bump(x).map((y) => v.map((z, j) => (i === j ? y : z))));
    if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => bump(x).map((y) => ({ ...v, [k]: y })));
    return [];
  };
  if (m.kind === "http") {
    out.push({ ...m, path: m.path + "/x" }, { ...m, method: m.method === "GET" ? "POST" : "GET" });
    if (m.body && typeof m.body === "object" && !Array.isArray(m.body)) out.push({ ...m, body: { ...m.body, firmware: 1 } });
    for (const b of bump(m.body ?? null).slice(0, 4)) out.push({ ...m, body: b });
  } else {
    const body = m.body as Record<string, Json>;
    out.push({ kind: "json", body: { ...body, method: "setSystemConfig" } });
    for (const b of bump(body.params ?? null).slice(0, 4)) out.push({ kind: "json", body: { ...body, params: b } });
  }
  return out;
}

export function netFixtureText(): string {
  const lines: string[] = [];
  const brands = Object.keys(NET_BRANDS) as Brand[];
  for (const brand of brands) {
    const ok = allowed(brand);
    const others = brands.filter((b) => b !== brand).flatMap((b) => allowed(b).slice(0, 2));
    for (const m of [...ok, ...refused(brand), ...ok.flatMap(mutations), ...others]) lines.push(`${brand} ${checkNet(brand, m).ok ? 1 : 0} ${serialise(m)}`);
  }
  return [...new Set(lines)].join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(NET_MESSAGES, netFixtureText());
  console.log(`wrote ${NET_MESSAGES}`);
}
