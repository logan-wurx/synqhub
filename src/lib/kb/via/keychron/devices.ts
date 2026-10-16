// The Keychron / Lemokey Hall-effect keyboards SYNQ's VIA driver gives analog settings: the ids, matrix sizes and key
// positions of the firmware's own keyboard definitions (catalog.generated.ts, GPL-2.0-or-later), and a VIA-style
// definition built from them for boards usevia.app has no layout for (the HE boards are not in VIA's keyboard list).
//
// Nothing here talks to a device. Erasable TypeScript only (node runs scripts/ directly).
import type { ParsedDefinition } from "../layout.ts";
import { KC_LAYOUTS, KC_MODELS, type KcModel } from "./catalog.generated.ts";

export { KC_LAYOUTS, KC_MODELS, type KcModel };

const key = (v: number, p: number) => v * 0x10000 + p;
const byKey = new Map<number, KcModel>(KC_MODELS.map((m) => [key(m.vendorId, m.productId), m]));
if (byKey.size !== KC_MODELS.length) throw new Error("keychron devices: duplicate USB id");

/** The Hall-effect model for a USB id, or null. No I/O. */
export const keychronModel = (vendorId: number, productId: number): KcModel | null => byKey.get(key(vendorId, productId)) ?? null;

/** Every [vendor id, product id] the Keychron HE layer applies to. */
export const KEYCHRON_HE_IDS: readonly (readonly [number, number])[] = KC_MODELS.map((m) => [m.vendorId, m.productId] as const);

/** "Q1 HE (ANSI)". */
export const modelName = (m: KcModel): string => (m.variant ? `${m.name} (${m.variant})` : m.name);

/** The firmware's layout for a model as a VIA-style definition (no layout options, no lighting menus). */
export function keychronDefinition(m: KcModel): ParsedDefinition {
  return {
    name: `${m.brand} ${modelName(m)}`,
    rows: m.rows,
    cols: m.cols,
    labels: [],
    keys: KC_LAYOUTS[m.layout].map(([row, col, x, y, w, h]) => ({ row, col, x, y, w, h })),
    optionKeys: {},
    menus: [],
    lighting: null,
  };
}
