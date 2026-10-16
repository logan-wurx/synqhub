// The guard for the Wi-Fi lights of wave L3: whether a message may go to a light of a brand, judged against
// allowlist.json (one table, read the same way by the bridge's src-tauri/src/lighting/net/guard.rs, which has the last
// word; the fixture messages.txt holds the two to the same verdicts). Pure: no network, no DOM.
import RULES from "./allowlist.json" with { type: "json" };

export type Brand = "hue" | "nanoleaf" | "elgato" | "twinkly" | "wiz" | "yeelight" | "lifx";
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** One message to a light: an HTTP request (the bridge fills in `{token}`), a JSON message (WiZ over UDP, Yeelight over
 * TCP) or a LIFX binary frame. */
export type NetMessage =
  | { kind: "http"; method: "GET" | "PUT" | "POST" | "DELETE"; path: string; body?: Json }
  | { kind: "json"; body: Json }
  | { kind: "lifx"; bytes: Uint8Array };

export type Verdict = { ok: true; what: string } | { ok: false; why: string };
const no = (brand: string, why: string): Verdict => ({ ok: false, why: `${brand}: ${why}.` });

type Shape = string | Shape[] | number | { [k: string]: Shape };
interface Rule {
  method?: string;
  path?: string;
  body?: Shape;
  required?: string[];
}

const isObject = (v: unknown): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a value has the shape (allowlist.json's "about" lists the forms). */
export function fits(shape: Shape, v: Json | undefined): boolean {
  if (shape === "bool") return typeof v === "boolean";
  if (typeof shape === "string") return typeof v === "string" && new RegExp(shape, "u").test(v);
  if (Array.isArray(shape)) {
    const [head, ...rest] = shape;
    if (typeof head === "number") return typeof v === "number" && Number.isInteger(v) && v >= head && v <= (rest[0] as number);
    if (head === "float") return typeof v === "number" && Number.isFinite(v) && v >= (rest[0] as number) && v <= (rest[1] as number);
    if (head === "pair") return Array.isArray(v) && v.length === 2 && v.every((x) => fits(["float", rest[0], rest[1]], x));
    if (head === "enum") return (typeof v === "string" || typeof v === "number") && rest.includes(v);
    if (head === "tuple") return Array.isArray(v) && v.length === rest.length && rest.every((s, i) => fits(s, v[i]));
    if (head === "list") return Array.isArray(v) && v.length >= 1 && v.length <= (rest[1] as number) && v.every((x) => fits(rest[0], x));
    return false;
  }
  if (isObject(shape)) {
    if (!isObject(v)) return false;
    const keys = Object.keys(v);
    // An empty shape takes only an empty object; any other takes one or more of its own keys, nothing else.
    if (Object.keys(shape).length === 0) return keys.length === 0;
    return keys.length > 0 && keys.every((k) => k in shape && fits(shape[k], v[k]));
  }
  return false;
}

function bodyOk(rule: Rule, body: Json | undefined): boolean {
  if (rule.body === undefined) return body === undefined || body === null;
  if (!fits(rule.body, body)) return false;
  return (rule.required ?? []).every((k) => isObject(body) && k in body);
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const uint = (b: Uint8Array, at: number, width: number) => {
  let v = 0;
  for (let i = width - 1; i >= 0; i--) v = v * 256 + b[at + i];
  return v;
};

/** A LIFX frame: a unicast, addressable protocol-1024 header (GetService alone may be tagged), then a payload of the type's layout. */
export function checkLifx(bytes: Uint8Array): Verdict {
  if (bytes.length < 36 || u16(bytes, 0) !== bytes.length) return no("lifx", "a frame's size is its length, from 36 bytes");
  const proto = u16(bytes, 2);
  const type = u16(bytes, 32);
  const tagged = (proto & 0x2000) !== 0;
  if ((proto & 0x0fff) !== 1024 || (proto & 0x1000) === 0 || (proto & 0xc000) !== 0) return no("lifx", "protocol 1024, addressable");
  const target = bytes.subarray(8, 16);
  if (tagged ? type !== 2 || target.some((b) => b !== 0) : target.every((b) => b === 0) || target[6] !== 0 || target[7] !== 0) return no("lifx", "a light's own address (only GetService is broadcast)");
  if (bytes.subarray(16, 22).some((b) => b !== 0) || (bytes[22] & ~0x03) !== 0 || bytes.subarray(24, 32).some((b) => b !== 0) || u16(bytes, 34) !== 0) return no("lifx", "reserved bytes are zero");
  const layout = (RULES.lifx as unknown as Record<string, number[][]>)[String(type)];
  if (!Array.isArray(layout)) return no("lifx", `message type ${type} isn't sent`);
  const size = layout.reduce((n, [w]) => n + w, 0);
  if (bytes.length !== 36 + size) return no("lifx", `type ${type} carries ${size} bytes`);
  let at = 36;
  for (const [w, min, max] of layout) {
    const v = uint(bytes, at, w);
    if (v < min || v > max) return no("lifx", `type ${type}: a field out of range`);
    at += w;
  }
  return { ok: true, what: `lifx ${type}` };
}

/** Whether a message may go to a light of this brand. */
export function checkNet(brand: Brand, m: NetMessage): Verdict {
  if (brand === "lifx") return m.kind === "lifx" ? checkLifx(m.bytes) : no(brand, "LIFX lights take LIFX frames");
  const http = (RULES.http as Record<string, Rule[]>)[brand];
  const json = (RULES.json as Record<string, Rule[]>)[brand];
  if (http) {
    if (m.kind !== "http") return no(brand, "an HTTP request");
    const rule = http.find((r) => r.method === m.method && new RegExp(r.path!, "u").test(m.path));
    if (!rule) return no(brand, `${m.method} ${m.path} isn't sent (firmware, network, names, resets and keys are refused)`);
    return bodyOk(rule, m.body) ? { ok: true, what: `${brand} ${m.method} ${m.path}` } : no(brand, `that body isn't one ${m.method} ${m.path} takes`);
  }
  if (json) {
    if (m.kind !== "json") return no(brand, "a JSON message");
    const rule = json.find((r) => bodyOk(r, m.body));
    return rule ? { ok: true, what: `${brand} ${isObject(m.body) ? String(m.body.method) : ""}` } : no(brand, "that message isn't sent (settings, Wi-Fi, names, resets and updates are refused)");
  }
  return no(brand, "not a brand SYNQ drives");
}
