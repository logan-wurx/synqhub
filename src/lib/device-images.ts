// Which product picture belongs to a detected device. Pure: it looks at the USB id and the name the device
// reports, never at the device itself. The pictures are in src/assets/devices (see SOURCES.json) and are
// loaded one at a time by loadDeviceImage (device-images.generated.ts).
import { DEVICE_IMAGE_BY_ID, DEVICE_IMAGE_MODELS } from "./device-images.generated.ts";

export interface DeviceImageQuery {
  kind?: "mouse" | "keyboard" | "gamepad" | "light" | "audio" | "sound" | "headset" | "monitor" | "webcam";
  vid?: string | null;
  pid?: string | null;
  /** What the device calls itself (its HID product string, or the name a panel read from it). */
  name?: string | null;
  /** The maker, when a driver knows it ("Razer"). */
  brand?: string | null;
}

/** Lower-case words joined by single spaces: the form names are compared in (also written by scripts/gen-device-images.mjs). */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(" ");
}

/** "1532:00c1" for ("1532", "00C1") or (0x1532, 0xc1); null when either half is not a number. */
export function usbKey(vid: string | number | null | undefined, pid: string | number | null | undefined): string | null {
  const h = (v: string | number | null | undefined) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : parseInt(String(v).replace(/^0x/i, ""), 16);
    return Number.isFinite(n) && n >= 0 && n <= 0xffff ? n.toString(16).padStart(4, "0") : null;
  };
  const a = h(vid);
  const b = h(pid);
  return a && b ? `${a}:${b}` : null;
}

interface Alias {
  key: string;
  kind: "mouse" | "keyboard" | "gamepad" | "light" | "headset" | "monitor" | "webcam";
  tokens: string[];
  /** The makers' own words ("endgame", "gear"): at least one has to be in the device's name or brand, or its vendor id has to be theirs. */
  vendor: string[];
  vendorId: Set<string>;
}

/** Other words that name a maker whose folder is called something else (VXE is ATK's sibling brand and shares its configurator; Akko boards ride MonsGeek's driver and carry its name; the K-snake X11 is Attack Shark's X11; the Sonix board called Jet75 is Lamzu's; pads say Xbox, PlayStation, Steam or PDP rather than their maker). */
const VENDOR_WORDS: Readonly<Record<string, readonly string[]>> = {
  atk: ["vxe"],
  monsgeek: ["akko"],
  akko: ["monsgeek"],
  "attack-shark": ["snake"],
  lamzu: ["sonix"],
  microsoft: ["xbox"],
  sony: ["playstation", "dualsense", "dualshock"],
  valve: ["steam"],
  victrix: ["pdp"],
};

let ALIASES: Alias[] | null = null;
function aliases(): Alias[] {
  if (ALIASES) return ALIASES;
  const vids = new Map<string, Set<string>>();
  for (const [id, key] of Object.entries(DEVICE_IMAGE_BY_ID)) {
    const row = DEVICE_IMAGE_MODELS.find((m) => m[0] === key);
    if (!row) continue;
    (vids.get(row[1]) ?? vids.set(row[1], new Set()).get(row[1])!).add(id.slice(0, 4));
  }
  const out: Alias[] = [];
  for (const [key, vendor, kind, , names] of DEVICE_IMAGE_MODELS) {
    for (const n of names) out.push({ key, kind, tokens: n.split(" "), vendor: [...vendor.split("-"), ...(VENDOR_WORDS[vendor] ?? [])], vendorId: vids.get(vendor) ?? new Set() });
  }
  // The longest name first, so "m75 wireless" wins over "m75".
  return (ALIASES = out.sort((a, b) => b.tokens.length - a.tokens.length));
}

/** Words that name a different model when a picture's name lacks them ("DeathAdder V3 Pro" is not the "DeathAdder V3"; a "SABRE v3 PRO ERGO" or an "X3 LHD" is another shell; an Insta360 "Link 2C" has no gimbal, unlike the "Link"). */
const VARIANT = new Set(["pro", "max", "mini", "plus", "ultra", "lite", "se", "air", "he", "x", "ii", "iii", "tkl", "ace", "core", "elite", "ultimate", "hero", "ergo", "lhd", "2c", "v1", "v2", "v3", "v4", "v5", "v6"]);
const isVariant = (t: string) => VARIANT.has(t) || /^\d+$/.test(t);

/**
 * The picture key for a device, or null. By USB id first (exact), then by name: every word of one of a
 * picture's names must be in the device's name, the device must not carry a variant word ("Pro", "Max", a
 * number) the picture's name lacks, and the device must be that maker's (its name or brand says so, or its
 * vendor id is one the maker's pictures list), so "R1" never matches another maker's R1.
 */
export function photoKeyFor(q: DeviceImageQuery): string | null {
  const wanted = q.kind === "mouse" || q.kind === "keyboard" || q.kind === "gamepad" || q.kind === "light" || q.kind === "headset" || q.kind === "monitor" || q.kind === "webcam" ? q.kind : null;
  const id = usbKey(q.vid, q.pid);
  const byId = id ? DEVICE_IMAGE_BY_ID[id] : undefined;
  if (byId) {
    const row = DEVICE_IMAGE_MODELS.find((m) => m[0] === byId);
    if (row && (!wanted || row[2] === wanted)) return byId;
  }
  return q.name ? byName(q, wanted, id) : null;
}

function byName(q: DeviceImageQuery, wanted: "mouse" | "keyboard" | "gamepad" | "light" | "headset" | "monitor" | "webcam" | null, id: string | null): string | null {
  const own = new Set(normName(`${q.name ?? ""} ${q.brand ?? ""}`).split(" "));
  const vid = id ? id.slice(0, 4) : null;
  for (const a of aliases()) {
    if (wanted && a.kind !== wanted) continue;
    if (!a.tokens.every((t) => own.has(t))) continue;
    if (!a.vendor.some((t) => own.has(t)) && !(vid && a.vendorId.has(vid))) continue;
    // A variant word the picture's name doesn't have: another model, one we have no picture of.
    const mine = new Set([...a.tokens, ...a.vendor]);
    if ([...own].some((t) => !mine.has(t) && isVariant(t))) continue;
    return a.key;
  }
  return null;
}
