// Which product picture belongs to a detected device. Pure: it looks at the USB id and the name the device
// reports, never at the device itself. The pictures are in src/assets/devices (see SOURCES.json) and are
// loaded one at a time by loadDeviceImage (device-images.generated.ts).
import { DEVICE_IMAGE_BY_ID, DEVICE_IMAGE_MODELS } from "./device-images.generated.ts";

export interface DeviceImageQuery {
  kind?: "mouse" | "keyboard" | "gamepad" | "light" | "audio" | "sound" | "headset" | "headphones" | "monitor" | "webcam";
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

type PictureKind = "mouse" | "keyboard" | "gamepad" | "light" | "headset" | "headphones" | "monitor" | "webcam";

interface Alias {
  key: string;
  kind: PictureKind;
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
  // Monitors carry their EDID maker code as the brand when the app has no name for it ("GBT M27Q", "AORUS FO27Q3").
  gigabyte: ["gbt", "aorus"],
  acer: ["acr", "predator", "nitro"],
  hp: ["hpn", "hwp", "omen"],
  lenovo: ["len", "legion"],
  philips: ["phl"],
  viewsonic: ["vsc"],
};

/** Platform words other makers put in their pads' names too ("PowerA Xbox Series X Controller"): they stand for the
 * platform's maker only when the device names no other brand. */
const PLATFORM_WORDS = new Set(["xbox", "playstation", "dualsense", "dualshock", "steam"]);

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
  // A sound output is named by the person (or an AutoEq model they picked): its picture is the headphones'.
  if (q.kind === "sound" || q.kind === "audio" || q.kind === "headphones") return headphonePhotoKeyFor(q.name);
  const wanted = q.kind === "mouse" || q.kind === "keyboard" || q.kind === "gamepad" || q.kind === "light" || q.kind === "headset" || q.kind === "monitor" || q.kind === "webcam" ? q.kind : null;
  const id = usbKey(q.vid, q.pid);
  const byId = id ? DEVICE_IMAGE_BY_ID[id] : undefined;
  if (byId) {
    const row = DEVICE_IMAGE_MODELS.find((m) => m[0] === byId);
    if (row && (!wanted || row[2] === wanted)) return byId;
  }
  return q.name ? byName(q, wanted, id) : null;
}

function byName(q: DeviceImageQuery, wanted: Exclude<PictureKind, "headphones"> | null, id: string | null): string | null {
  const own = new Set(normName(`${q.name ?? ""} ${q.brand ?? ""}`).split(" "));
  const brand = new Set(normName(q.brand ?? "").split(" ").filter(Boolean));
  const vid = id ? id.slice(0, 4) : null;
  // Of the pictures that fit, the one leaving the fewest words of the device's name unexplained (its brand's words
  // aside): an edition word decides ("ROG Falchion Ace HFX ZywOo" is the ZywOo edition, not the plain Falchion, though
  // both pictures' names are four words). Then the longer name.
  const named = normName(q.name ?? "").split(" ").filter(Boolean);
  let best: { key: string; extra: number; length: number } | null = null;
  for (const a of aliases()) {
    // Headphones are found only by headphonePhotoKeyFor (a person's name for them, not a USB device's).
    if (wanted ? a.kind !== wanted : a.kind === "headphones") continue;
    if (!a.tokens.every((t) => own.has(t))) continue;
    const said = a.vendor.filter((t) => own.has(t));
    if (!said.length && !(vid && a.vendorId.has(vid))) continue;
    // Only a platform word ("Xbox") and a brand that is someone else's (PowerA, Mad Catz): another maker's pad.
    if (said.length && said.every((t) => PLATFORM_WORDS.has(t)) && brand.size && !a.vendor.some((t) => brand.has(t))) continue;
    // A variant word the picture's name doesn't have: another model, one we have no picture of.
    const mine = new Set([...a.tokens, ...a.vendor]);
    if ([...own].some((t) => !mine.has(t) && isVariant(t))) continue;
    const extra = named.filter((t) => !mine.has(t) && !brand.has(t)).length;
    if (!best || extra < best.extra || (extra === best.extra && a.tokens.length > best.length)) best = { key: a.key, extra, length: a.tokens.length };
  }
  return best?.key ?? null;
}

/** Words split where letters meet digits ("hd600" and "HD 600" both read "hd 600"; "WH-1000XM4" reads "wh 1000 xm 4"). */
const spaced = (s: string) => normName(s).replace(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/g, " ");

let PHONES: { aliases: Alias[]; makers: Set<string> } | null = null;
/** Headphone and headset pictures (a gaming headset is headphones too), and every maker word among them. */
function phoneAliases(): { aliases: Alias[]; makers: Set<string> } {
  if (PHONES) return PHONES;
  const out: Alias[] = [];
  const makers = new Set<string>();
  for (const [key, vendor, kind, , names] of DEVICE_IMAGE_MODELS) {
    if (kind !== "headphones" && kind !== "headset") continue;
    const words = [...vendor.split("-"), ...(VENDOR_WORDS[vendor] ?? [])].flatMap((w) => spaced(w).split(" "));
    for (const w of words) if (w.length > 2 && !GENERIC_MAKER_WORDS.has(w)) makers.add(w);
    for (const n of names) out.push({ key, kind, tokens: spaced(n).split(" "), vendor: words, vendorId: new Set() });
  }
  return (PHONES = { aliases: out.sort((a, b) => b.tokens.length - a.tokens.length), makers });
}

/** Parts of makers' names that say nothing about the maker ("Campfire Audio", "Tin HiFi", "Kiwi Ears"). */
const GENERIC_MAKER_WORDS = new Set(["audio", "hifi", "ears", "beach", "gaming"]);

/**
 * The picture of the headphones or IEMs a person named: the name they gave a sound output ("Zero:2") or the AutoEq
 * model they picked ("7Hz Salnotes Zero 2", "Sennheiser HD 600", "Beyerdynamic DT 770 PRO 80 Ohm"). Every word of
 * one of a picture's names must be in it, and no variant word the picture's name lacks ("Aria 2" is not the "Aria").
 * The maker may be left out only for a name of two words or more ("Zero 2", "HD 600"), and only when the name names
 * no other maker; a one-word name ("Aria") needs the maker too. Words in brackets may match ("AirPods (3rd generation)")
 * but never rule a picture out, since AutoEq puts a sample, a year or the tips there; the impedance is ignored.
 */
export function headphonePhotoKeyFor(name: string | null | undefined): string | null {
  if (!name) return null;
  const bracketed = /\([^)]*\)|\[[^\]]*\]/g;
  const words = (s: string) => spaced(s.replace(/\b\d+\s*ohms?\b/gi, " ")).split(" ").filter(Boolean);
  const outer = words(name.replace(bracketed, " "));
  const own = new Set([...outer, ...words((name.match(bracketed) ?? []).join(" "))]);
  if (!own.size) return null;
  const { aliases: list, makers } = phoneAliases();
  for (const a of list) {
    if (!a.tokens.every((t) => own.has(t))) continue;
    const branded = a.vendor.some((t) => own.has(t)) || a.tokens.some((t) => a.vendor.includes(t));
    if (!branded && (a.tokens.length < 2 || outer.some((t) => makers.has(t) && !a.vendor.includes(t)))) continue;
    const mine = new Set([...a.tokens, ...a.vendor]);
    if (outer.some((t) => !mine.has(t) && isVariant(t))) continue;
    return a.key;
  }
  return null;
}

export interface HeadphoneModel {
  /** The photo's key, what a sound output's `picture` holds. */
  key: string;
  name: string;
  kind: "headphones" | "headset";
}

let MODELS: HeadphoneModel[] | null = null;
/** Every headphone, IEM and headset the picture library has, by name: what a person picks for a sound output. */
export function headphoneModels(): readonly HeadphoneModel[] {
  MODELS ??= DEVICE_IMAGE_MODELS.filter((r) => r[2] === "headphones" || r[2] === "headset")
    .map(([key, , kind, name]) => ({ key, name, kind: kind as HeadphoneModel["kind"] }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return MODELS;
}

/** The model a picked key names, if the library has it. */
export const headphoneModel = (key: string | null | undefined): HeadphoneModel | null => (key ? (headphoneModels().find((m) => m.key === key) ?? null) : null);