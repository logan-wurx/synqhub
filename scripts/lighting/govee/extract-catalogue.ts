// Makes scripts/lighting/govee/catalogue.json, the scene catalogues SYNQ ships for every Govee model, from
// Beshelmek/govee_ble_lights' per-model JSON files (MIT; Govee's own published scene library per SKU). Only what the
// lamps need is kept: each scene's code, name, group and parameter data (deduplicated across models: 1,500-odd blobs,
// about 200 KB). The 50 MB of source JSON (icons, translations) stays out of the repository.
//
//   node scripts/lighting/govee/extract-catalogue.ts <folder with the <SKU>.json files>
//
// Then `node scripts/gen-govee-scenes.ts` writes the tables the app and the bridge use. Nothing here talks to a lamp.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE = "Beshelmek/govee_ble_lights@fc13097ef54c7b4a77f044659c138965e8b2d91a custom_components/govee-ble-lights/jsons (MIT)";

interface Effect {
  sceneCode: number;
  scenceParam: string;
  specialEffect?: { supportSku?: string[]; scenceParam?: string }[];
}
interface Source {
  data: { categories: { categoryName: string; scenes: { sceneName: string; lightEffects: Effect[] }[] }[] };
}

/** One model's scenes: [code, name, group, blob index or -1 (built into the lamp)]. */
export type SceneRow = [number, string, string, number];
export interface Catalogue {
  source: string;
  blobs: string[];
  skus: Record<string, SceneRow[]>;
}

export function extract(folder: string): Catalogue {
  const blobs: string[] = [];
  const index = new Map<string, number>();
  const skus: Record<string, SceneRow[]> = {};
  for (const file of readdirSync(folder).filter((f) => /^H[0-9A-F]{4}\.json$/i.test(f)).sort()) {
    const sku = file.slice(0, 5).toUpperCase();
    const json = JSON.parse(readFileSync(join(folder, file), "utf8").replace(/^﻿/, "")) as Source;
    const rows: SceneRow[] = [];
    const seen = new Set<number>();
    for (const c of json.data.categories) {
      for (const s of c.scenes) {
        const e = s.lightEffects[0];
        if (!e || seen.has(e.sceneCode)) continue;
        seen.add(e.sceneCode);
        // A per-model variant of the data, when the catalogue has one for this SKU.
        const param = e.specialEffect?.find((x) => x.supportSku?.includes(sku))?.scenceParam || e.scenceParam;
        let at = -1;
        if (param) {
          const hex = Buffer.from(param, "base64").toString("hex");
          at = index.get(hex) ?? blobs.push(hex) - 1;
          index.set(hex, at);
        }
        rows.push([e.sceneCode, s.sceneName.trim(), c.categoryName.trim(), at]);
      }
    }
    skus[sku] = rows;
  }
  return { source: SOURCE, blobs, skus };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const folder = process.argv[2];
  if (!folder) throw new Error("usage: node scripts/lighting/govee/extract-catalogue.ts <folder>");
  const c = extract(folder);
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "catalogue.json"), `${JSON.stringify(c)}\n`);
  console.log(`${Object.keys(c.skus).length} models, ${Object.values(c.skus).reduce((n, r) => n + r.length, 0)} scenes, ${c.blobs.length} blobs`);
}
