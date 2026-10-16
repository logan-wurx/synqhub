// The curated list of pros (src/lib/pros/pros.json): values written by hand from public pages, each with its source
// and the date it was checked.
import list from "./pros.json";
import type { Pro } from "./loadout";

export const PROS: readonly Pro[] = list as Pro[];

export const proById = (id: string): Pro | null => PROS.find((p) => p.id === id) ?? null;
