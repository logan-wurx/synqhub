// Keyboard drivers that live in their own folder and register themselves: any
// src/lib/kb/<name>/entry.ts exporting `entry: KbDriverLoader` (see registry.ts). Only the small entry
// module is bundled up front; its driver loads when a device it may claim is present. Vite-only
// (import.meta.glob), so the hosts import this and the node tests don't.
import type { KbDriverLoader } from "./registry.ts";

const found = import.meta.glob<{ entry?: KbDriverLoader }>("./*/entry.ts", { eager: true });

export const PLUGIN_DRIVERS: readonly KbDriverLoader[] = Object.values(found)
  .map((m) => m.entry)
  .filter((e): e is KbDriverLoader => !!e && typeof e.load === "function" && typeof e.id === "string");
