// Reaching the Wi-Fi lights of wave L3: finding them (the bridge's discovery, src-tauri/src/lighting/net, run only when
// the person asks), pairing, and one message at a time to a light (checked by the guard here, then by the bridge's,
// which also fills in the pairing key). A paired Hue bridge is asked for its lights, and each becomes a light of its
// own. The browser preview and the end-to-end build get the simulated lights (sim.ts, loaded when asked for); the
// website reaches the real ones through SYNQ Helper (src/lib/web/tauri-core.ts sends these commands to it).
import { invoke } from "@tauri-apps/api/core";
import { inTauri, isWeb } from "../../backend";

/** The real lights (the desktop app's bridge, or SYNQ Helper's on the website), not the simulated ones. */
const real = inTauri || isWeb;
import type { NetDevice } from "./brands.ts";
import { checkNet, type Brand, type Json, type NetMessage } from "./guard.ts";

/** A light as discovery lists it (a Hue bridge until it is paired, then its lights). */
export interface NetFound {
  brand: Brand;
  id: string;
  name: string;
  model: string;
  host: string;
  port: number;
  mac?: string | null;
  paired: boolean;
}

export type Reply = { kind: "json"; body: Json } | { kind: "bytes"; bytes: number[] } | { kind: "none" };

const sim = () => import("./sim.ts");

/** One message to a light: the guard here, then the bridge's; the light's answer. */
export async function netSend(brand: Brand, id: string, m: NetMessage): Promise<Reply> {
  const v = checkNet(brand, m);
  if (!v.ok) throw new Error(v.why);
  if (!real) return (await sim()).simSend(brand, id, m);
  const message = m.kind === "lifx" ? { kind: "lifx", bytes: Array.from(m.bytes) } : m;
  return invoke<Reply>("net_light_send", { brand, id, message });
}

export async function pairNetLight(brand: Brand, id: string): Promise<void> {
  if (!real) return (await sim()).simPair(brand, id);
  return invoke("net_light_pair", { brand, id });
}

/** Forgets a light's pairing key (the light keeps SYNQ in its own list until it is removed there). */
export async function forgetNetLight(brand: Brand, id: string): Promise<void> {
  if (!real) return (await sim()).simForget(brand, id);
  return invoke("net_light_forget", { brand, id });
}

/** A found light as the page lists it; a paired Hue bridge opened up into its lights (asked of the bridge). */
export function openUp(f: Omit<NetFound, "port">): Promise<NetDevice[]> {
  const base: NetDevice = { brand: f.brand, id: f.id, name: f.name, model: f.model, host: f.host, paired: f.paired, mac: f.mac ?? undefined };
  if (f.brand !== "hue" || !f.paired) return Promise.resolve([base]);
  // A paired Hue bridge: each of its lights is a light of its own.
  return netSend("hue", f.id, { kind: "http", method: "GET", path: "/api/{token}/lights" }).then(
    (r) => {
      const lights = r.kind === "json" && r.body && typeof r.body === "object" && !Array.isArray(r.body) ? r.body : {};
      const out = Object.entries(lights).map(([n, l]) => {
        const light = (l ?? {}) as Record<string, Json>;
        return { ...base, sub: n, name: String(light.name ?? `Hue light ${n}`), model: String(light.productname ?? light.modelid ?? "Hue light") };
      });
      return out.length ? out : [base];
    },
    () => [base],
  );
}

/** Finds the Wi-Fi lights on the network (about 1.5 s of asking), Hue bridges opened up into their lights. */
export async function findNetLights(): Promise<NetDevice[]> {
  const found = real ? await invoke<NetFound[]>("net_lights_find") : await (await sim()).simList();
  return (await Promise.all(found.map(openUp))).flat();
}
