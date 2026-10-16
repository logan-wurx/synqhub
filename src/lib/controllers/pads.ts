// Which collections of a controller SYNQ opens, mirrored 1:1 from the bridge (src-tauri/src/pads.rs): the website's
// guard (src/lib/web/policy.ts, guard.ts) decides with these, the desktop's with the Rust copy, and
// scripts/controllers.test.ts holds the two to the same answers.
//
// - Only ids in the controller table (ids.generated.ts) count, and only their HID personalities: an XInput pad is read
//   through XInput (desktop) or the Gamepad API (browser), never as HID.
// - A pad's Gamepad (0x01:0x05) or Joystick (0x01:0x04) collection opens, and Valve's vendor input collection
//   (0xFF00:0x0001) on Valve's pads; nothing else does (never Mouse 0x02, Keyboard 0x06, page 0x07, Consumer).
// - Read only, except Sony's and Nintendo's pads, which take the exact frames guard.ts allows.
//
// Pure functions: no DOM, no React, no device access.
import { PAD_BOOT, PAD_ROWS } from "./ids.generated.ts";
import { PAD_MODELS } from "./models.ts";
import type { PadGuard, PadKind, PadRow } from "./types.ts";

const key = (v: number, p: number) => v * 0x10000 + p;
const ROWS = new Map<number, PadRow>(PAD_ROWS.map((r) => [key(r[0], r[1]), r]));
const BOOT = new Set(PAD_BOOT.map(([v, p]) => key(v, p)));
const GUARDS = new Map<number, PadGuard>();
for (const m of PAD_MODELS) if (m.guard !== "input") for (const i of m.ids) if (i.transport === "hid" && !i.readOnly) GUARDS.set(key(i.vid, i.pid), m.guard);

export const GAMEPAD_COLLECTIONS: readonly (readonly [number, number])[] = [
  [0x0001, 0x0005],
  [0x0001, 0x0004],
];
export const VALVE_INPUT = [0xff00, 0x0001] as const;
/** GameSir's vendor collection: the configuration channel and the live state report (any usage on this page). */
export const GAMESIR_PAGE = 0xfff0;
/** Flydigi's vendor collection (D-input mode): its config channel, output report 5, input report 4 (any usage). */
export const FLYDIGI_PAGE = 0xffa0;
/** Corsair's BRAGI request collection on the SCUF Envision (reads only). */
export const BRAGI_REQUEST = [0xff42, 0x0001] as const;
const VALVE_KINDS: readonly PadKind[] = ["steam", "steamdeck", "steamtriton", "horisteam"];

/** The table row of an id, or null. */
export const padRow = (v: number, p: number): PadRow | null => ROWS.get(key(v, p)) ?? null;
/** A game controller SYNQ knows (any transport). */
export const isPad = (v: number, p: number): boolean => ROWS.has(key(v, p));
/** A controller's bootloader or recovery identity: never listed, never opened. */
export const padBoot = (v: number, p: number): boolean => BOOT.has(key(v, p));
/** A pad that may be opened as HID. */
export const hidPad = (v: number, p: number): boolean => !padBoot(v, p) && padRow(v, p)?.[3] === "hid";

/** What may be sent to this HID pad (null: not a HID pad). */
export function padGuardOf(v: number, p: number): PadGuard | null {
  if (!hidPad(v, p)) return null;
  return GUARDS.get(key(v, p)) ?? "input";
}

/** The collections the tester reads. */
export function padCollection(v: number, p: number, page: number, usage: number): boolean {
  if (!hidPad(v, p)) return false;
  if (GAMEPAD_COLLECTIONS.some(([cp, cu]) => cp === page && cu === usage)) return true;
  if (page === GAMESIR_PAGE && padGuardOf(v, p)?.startsWith("gamesir-")) return true;
  if (page === BRAGI_REQUEST[0] && usage === BRAGI_REQUEST[1] && padGuardOf(v, p) === "scuf") return true;
  if (page === FLYDIGI_PAGE && padGuardOf(v, p) === "flydigi") return true;
  return VALVE_KINDS.includes(padRow(v, p)![2]) && page === VALVE_INPUT[0] && usage === VALVE_INPUT[1];
}

/** How a collection of a pad may be used ("full" only for Sony's and Nintendo's gamepad collection), or null. */
export function padAccess(v: number, p: number, page: number, usage: number): "full" | "input" | null {
  if (!padCollection(v, p, page, usage)) return null;
  const g = padGuardOf(v, p);
  if (g?.startsWith("gamesir-")) return page === GAMESIR_PAGE ? "full" : "input";
  if (g === "scuf") return page === BRAGI_REQUEST[0] ? "full" : "input";
  if (g === "flydigi") return page === FLYDIGI_PAGE ? "full" : "input";
  return g && g !== "input" && page === 0x0001 ? "full" : "input";
}
