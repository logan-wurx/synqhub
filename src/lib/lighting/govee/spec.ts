// One Govee model as the frames, the guard and the lamp page use it: the generated model table
// (scripts/lighting/govee/models.json) plus what follows from it, such as how many segments a mask may name. Pure.
import { GOVEE_MODELS, type GoveeModel } from "./models.generated.ts";

/** The colour sub-modes ("dialects") Govee lights take colour in (COMMANDS.md §2.3). */
export const DIALECT = { rgb: 0x02, ic: 0x0b, cct: 0x0d, typed: 0x15 } as const;
export const COLOUR_DIALECTS: readonly number[] = Object.values(DIALECT);

export interface GoveeSpec extends GoveeModel {
  /** How many segments a mask or a page may name: the model's count, or the dialect's most when it isn't known. */
  maxSegments: number;
}

const DIALECT_MOST: Record<number, number> = { [DIALECT.typed]: 16, [DIALECT.ic]: 15 };

const specs = new Map<string, GoveeSpec>();
/** The model's spec, or null for a Govee device SYNQ doesn't drive. */
export function specOf(sku: string): GoveeSpec | null {
  const m = GOVEE_MODELS[sku];
  if (!m) return null;
  let s = specs.get(sku);
  if (!s) specs.set(sku, (s = { ...m, maxSegments: m.segments || Math.max(0, ...m.dialects.map((d) => DIALECT_MOST[d] ?? 0)) }));
  return s;
}

/** Segments a mask may name in this dialect: the model's count, or the dialect's most (16 for 0x15, 15 for 0x0b). */
export const limitOf = (s: GoveeSpec, dialect: number) => s.segments || (DIALECT_MOST[dialect] ?? 0);

/** Whether the model can be painted segment by segment in this dialect (0x15 pages, or 0x0b masks). */
export const paintable = (s: GoveeSpec, dialect: number) => s.maxSegments > 0 && (dialect === DIALECT.typed || dialect === DIALECT.ic);
