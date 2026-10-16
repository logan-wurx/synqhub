// Scenes a Wi-Fi light already has, recalled by SYNQ (never created, edited or deleted): a Hue light's scenes from
// its bridge (`GET /scenes`, recalled through a group's action), and a Nanoleaf controller's effects (the list in its
// state, selected by name). Hue scenes carry their lights' colours (`GET /scenes/<id>`), shown as swatches; Nanoleaf's
// list carries names only. Every message passes the network guard (allowlist.json) like any other.
import { kelvinRgb, type Rgb } from "../govee/frames.ts";
import { rgbOfHsv, type NetDevice } from "./brands.ts";
import type { Brand, Json, NetMessage } from "./guard.ts";
import type { Reply } from "./link.ts";

export interface NetScene {
  /** Hue: the scene's id; Nanoleaf: the effect's name. */
  id: string;
  name: string;
  /** Hue: the group the scene is recalled through ("0": all lights, for a scene of lights). */
  group: string;
}

type Send = (brand: Brand, id: string, m: NetMessage) => Promise<Reply>;

const obj = (v: Json | undefined): Record<string, Json> => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const http = (method: "GET" | "PUT", path: string, body?: Json): NetMessage => (body === undefined ? { kind: "http", method, path } : { kind: "http", method, path, body });

/** Whether the light has scenes SYNQ can recall: a Hue light (behind its bridge) or a Nanoleaf controller. */
export const hasScenes = (d: NetDevice) => (d.brand === "hue" && !!d.sub) || d.brand === "nanoleaf";

/** The scenes that include this light (Hue) or the controller's effects (Nanoleaf), by name. */
export async function listScenes(d: NetDevice, send: Send): Promise<NetScene[]> {
  if (d.brand === "hue") {
    const r = await send("hue", d.id, http("GET", "/api/{token}/scenes"));
    const all = r.kind === "json" ? obj(r.body) : {};
    return Object.entries(all)
      .map(([id, v]) => ({ id, s: obj(v) }))
      // A scene the Hue app keeps for itself (recycle) is left out, and so is one without this light.
      .filter(({ s }) => s.recycle !== true && Array.isArray(s.lights) && s.lights.includes(d.sub ?? ""))
      .map(({ id, s }) => ({ id, name: typeof s.name === "string" ? s.name : "Scene", group: s.type === "GroupScene" && typeof s.group === "string" ? s.group : "0" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const r = await send("nanoleaf", d.id, http("GET", "/api/v1/{token}/"));
  const list = r.kind === "json" ? obj(obj(r.body).effects).effectsList : undefined;
  return (Array.isArray(list) ? list : []).filter((n): n is string => typeof n === "string").map((n) => ({ id: n, name: n, group: "" }));
}

/** The effect a Nanoleaf controller shows now (its state's `effects.select`); Hue doesn't say. */
export async function currentScene(d: NetDevice, send: Send): Promise<string | null> {
  if (d.brand !== "nanoleaf") return null;
  const r = await send("nanoleaf", d.id, http("GET", "/api/v1/{token}/"));
  const sel = r.kind === "json" ? obj(obj(r.body).effects).select : undefined;
  return typeof sel === "string" ? sel : null;
}

/** A colour from Hue's CIE xy (at full brightness, for a swatch). */
export function xyRgb([x, y]: readonly [number, number]): Rgb {
  if (y <= 0) return [255, 255, 255];
  const z = 1 - x - y;
  const [X, Y, Z] = [x / y, 1, z / y];
  const lin = [X * 1.656492 - Y * 0.354851 - Z * 0.255038, -X * 0.707196 + Y * 1.655397 + Z * 0.036152, X * 0.051713 - Y * 0.121364 + Z * 1.01153].map((v) => Math.max(0, v));
  const max = Math.max(...lin, 1e-6);
  return lin.map((v) => {
    const c = v / max;
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  }) as unknown as Rgb;
}

/** A Hue scene's colours, from its lights' states (up to five, each once). */
export async function sceneColours(d: NetDevice, s: NetScene, send: Send): Promise<Rgb[]> {
  if (d.brand !== "hue") return [];
  const r = await send("hue", d.id, http("GET", `/api/{token}/scenes/${s.id}`));
  const states = r.kind === "json" ? obj(obj(r.body).lightstates) : {};
  const out: Rgb[] = [];
  for (const v of Object.values(states)) {
    const st = obj(v);
    if (st.on === false) continue;
    const xy = Array.isArray(st.xy) && typeof st.xy[0] === "number" && typeof st.xy[1] === "number" ? xyRgb([st.xy[0], st.xy[1]]) : null;
    const c = xy ?? (typeof st.ct === "number" ? kelvinRgb(1e6 / st.ct) : typeof st.hue === "number" ? rgbOfHsv((st.hue / 65535) * 360, (typeof st.sat === "number" ? st.sat : 254) / 254) : null);
    if (c && !out.some((o) => o.join() === c.join())) out.push(c);
  }
  return out.slice(0, 5);
}

/** The message that recalls a scene: Hue through its group's action, Nanoleaf by selecting the effect. */
export function recallMessage(d: NetDevice, s: NetScene): NetMessage {
  return d.brand === "hue" ? http("PUT", `/api/{token}/groups/${s.group}/action`, { scene: s.id }) : http("PUT", "/api/v1/{token}/effects", { select: s.name });
}
