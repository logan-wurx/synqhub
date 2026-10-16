// Where a VIA board's layout comes from. VIA keyboards don't carry their own layout: VIA keeps a
// definition per vendor/product id in github.com/the-via/keyboards (GPL-3.0), built and served by
// the official app at https://usevia.app/definitions/<v2|v3>/<vendorProductId>.json. SYNQ fetches
// one only when such a keyboard is first connected, keeps it (the host's cache: app data on the
// desktop, browser storage on a website) and uses the copy from then on, so the network is used once
// per board. Vial boards carry their definition and never need this. The fetched JSON is data only.
import type { DefinitionSource } from "../types.ts";

export const VIA_DEFINITIONS_URL = "https://usevia.app/definitions";
const FETCH_MS = 8000;

/** Where the host keeps fetched definitions. */
export interface DefinitionCache {
  load(key: string): Promise<string | null>;
  save(key: string, json: string): Promise<void>;
}

/** The id VIA files definitions under: (vendor id << 16) | product id, as a decimal number. */
export const vendorProductId = (vendorId: number, productId: number) => vendorId * 0x10000 + productId;

/** The smallest shape check: a matrix and a key list. */
function looksLikeDefinition(json: unknown): boolean {
  const j = json as { matrix?: { rows?: unknown; cols?: unknown }; layouts?: { keys?: unknown } };
  return typeof j?.matrix?.rows === "number" && typeof j?.matrix?.cols === "number" && Array.isArray(j?.layouts?.keys);
}

/**
 * VIA definitions from `cache`, else from usevia.app (then cached). A board VIA has no definition
 * for is remembered for this session, so it isn't asked for again on every reconnect.
 */
export function viaDefinitions(cache: DefinitionCache, fetcher: typeof fetch = (...a) => fetch(...a)): DefinitionSource {
  const missing = new Set<string>();
  return {
    async get(version, vendorId, productId) {
      const key = `${version}-${vendorProductId(vendorId, productId)}`;
      const cached = await cache.load(key).catch(() => null);
      if (cached) {
        try {
          const json = JSON.parse(cached);
          if (looksLikeDefinition(json)) return { json, origin: "cache" };
        } catch {
          /* a broken copy: fetch it again */
        }
      }
      if (missing.has(key)) return null;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), FETCH_MS);
      try {
        const res = await fetcher(`${VIA_DEFINITIONS_URL}/${version}/${vendorProductId(vendorId, productId)}.json`, { signal: ctl.signal, credentials: "omit", cache: "no-cache" });
        if (res.status === 404) {
          missing.add(key);
          return null;
        }
        if (!res.ok) throw new Error(`usevia.app answered ${res.status}`);
        const text = await res.text();
        const json = JSON.parse(text);
        if (!looksLikeDefinition(json)) {
          missing.add(key);
          return null;
        }
        await cache.save(key, text).catch(() => undefined);
        return { json, origin: "network" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** A cache in memory, for the preview and the tests. */
export function memoryDefinitionCache(seed: Record<string, string> = {}): DefinitionCache & { saved: Map<string, string> } {
  const saved = new Map(Object.entries(seed));
  return {
    saved,
    async load(key) {
      return saved.get(key) ?? null;
    },
    async save(key, json) {
      saved.set(key, json);
    },
  };
}
