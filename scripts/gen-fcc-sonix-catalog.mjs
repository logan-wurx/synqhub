// Writes src/lib/kb/fcc/sonix-catalog.generated.ts from a checkout of Fighting Control Center (FCC,
// https://github.com/shybruh/FightingControlCenter-FCC, GPL-3.0-or-later). Only FCC's JSON data is read
// (app/src/devices/catalog.json, verified.json); no FCC code is imported or run.
//
// Run: node scripts/gen-fcc-sonix-catalog.mjs <path to the FCC checkout>
//
// FCC's catalog.json is "vter.driveall.cn official driver, extracted 2026-10-09": every Sonix-based HE
// board the official VTER / driveall web driver knows. Layout rows are [key index, label, shifted label,
// KeyboardEvent.code, HID usage, x, y, w, h]; FCC trusts the browser code over the HID column because
// the official data has a few wrong HID values (FCC app/src/devices/registry.ts `layoutFor`). This
// generator does the same, with the standard code -> usage table below.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fcc = process.argv[2];
if (!fcc) throw new Error("usage: node scripts/gen-fcc-sonix-catalog.mjs <FCC checkout>");
const devicesDir = path.join(fcc, "app/src/devices");
const catalog = JSON.parse(fs.readFileSync(path.join(devicesDir, "catalog.json"), "utf8"));
const verified = JSON.parse(fs.readFileSync(path.join(devicesDir, "verified.json"), "utf8")).verified;

function commitOf(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, ".git/HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = head.slice(5);
    const loose = path.join(dir, ".git", ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, "utf8").trim();
    const packed = fs.readFileSync(path.join(dir, ".git/packed-refs"), "utf8");
    return packed.split("\n").find((l) => l.endsWith(" " + ref))?.split(" ")[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

// KeyboardEvent.code -> HID keyboard usage (USB HID Usage Tables, page 0x07).
const CODE_TO_HID = {
  Escape: 0x29, Tab: 0x2b, CapsLock: 0x39, Enter: 0x28, Backspace: 0x2a, Space: 0x2c,
  Insert: 0x49, Delete: 0x4c, Home: 0x4a, End: 0x4d, PageUp: 0x4b, PageDown: 0x4e,
  ArrowUp: 0x52, ArrowDown: 0x51, ArrowLeft: 0x50, ArrowRight: 0x4f,
  PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, ContextMenu: 0x65,
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31,
  Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38, IntlBackslash: 0x64,
  NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56, NumpadAdd: 0x57,
  NumpadEnter: 0x58, NumpadDecimal: 0x63, Numpad0: 0x62,
  ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
  ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7,
};
for (let i = 0; i < 26; i++) CODE_TO_HID[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i;
for (let i = 1; i <= 9; i++) CODE_TO_HID[`Digit${i}`] = 0x1d + i;
CODE_TO_HID.Digit0 = 0x27;
for (let i = 1; i <= 9; i++) CODE_TO_HID[`Numpad${i}`] = 0x58 + i;
for (let i = 1; i <= 24; i++) CODE_TO_HID[`F${i}`] = i <= 12 ? 0x39 + i : 0x5b + i;
// The official data spells this one "Numpadsubtract"; its HID column (86 = 0x56) is right anyway.

/**
 * FCC's own hand-tuned Fighting68 layout (app/src/data/layout.ts `ROWS`, "verified on hardware"):
 * rows of [key index, HID usage, width]. x is the running sum of widths, as FCC computes it.
 */
const FIGHTING68_ROWS = [
  [[0, 0x29], [17, 0x1e], [18, 0x1f], [19, 0x20], [20, 0x21], [21, 0x22], [22, 0x23], [23, 0x24], [24, 0x25], [25, 0x26], [26, 0x27], [27, 0x2d], [28, 0x2e], [92, 0x2a, 2], [103, 0x49]],
  [[32, 0x2b, 1.5], [33, 0x14], [34, 0x1a], [35, 0x08], [36, 0x15], [37, 0x17], [38, 0x1c], [39, 0x18], [40, 0x0c], [41, 0x12], [42, 0x13], [43, 0x2f], [44, 0x30], [60, 0x31, 1.5], [106, 0x4c]],
  [[48, 0x39, 1.75], [49, 0x04], [50, 0x16], [51, 0x07], [52, 0x09], [53, 0x0a], [54, 0x0b], [55, 0x0d], [56, 0x0e], [57, 0x0f], [58, 0x33], [59, 0x34], [76, 0x28, 2.25], [105, 0x4b]],
  [[64, 0xe1, 2.25], [65, 0x1d], [66, 0x1b], [67, 0x06], [68, 0x19], [69, 0x05], [70, 0x11], [71, 0x10], [72, 0x36], [73, 0x37], [74, 0x38], [75, 0xe5, 1.75], [90, 0x52], [108, 0x4e]],
  [[80, 0xe0, 1.25], [81, 0xe3, 1.25], [82, 0xe2, 1.25], [83, 0x2c, 6.25], [84, 0xe6], [85, 0x00], [87, 0xe4], [88, 0x50], [89, 0x51], [91, 0x4f]],
];
const fighting68 = FIGHTING68_ROWS.flatMap((row, y) => {
  let x = 0;
  return row.map(([id, hid, w = 1]) => {
    const k = [id, hid, x, y, w, 1];
    x += w;
    return k;
  });
});

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round = (v) => Math.round(num(v) * 1000) / 1000;
const layouts = { "fighting68-fcc": fighting68 };
for (const [name, keys] of Object.entries(catalog.layouts)) {
  layouts[name] = keys.map(([id, , , code, hid, x, y, w, h]) => [id, CODE_TO_HID[code] ?? Math.max(0, num(hid)), round(x), round(y), round(w), round(h || 1)]);
}

const devices = catalog.devices.map((d) => ({
  id: d.id,
  name: d.name,
  vendorId: d.vendorId,
  productId: d.productId,
  layout: d.layout,
  transport: d.transport,
  status: verified.includes(d.id) ? "verified" : d.status,
  limits: d.limits,
}));
for (const d of devices) if (!layouts[d.layout]) throw new Error(`${d.id}: layout ${d.layout} missing`);

const hex4 = (n) => "0x" + n.toString(16).padStart(4, "0");
const lim = (l) => `{ travel: ${l.travel}, actuationDefault: ${l.actuationDefault}, sensMin: ${l.sensMin}, sensMax: ${l.sensMax}, sensDefault: ${l.sensDefault} }`;
const out = [
  "// GENERATED by scripts/gen-fcc-sonix-catalog.mjs. Do not edit by hand.",
  "//",
  "// Data from Fighting Control Center (FCC), https://github.com/shybruh/FightingControlCenter-FCC,",
  `// commit ${commitOf(fcc)}, files app/src/devices/catalog.json + verified.json + app/src/data/layout.ts.`,
  "// FCC is licensed under the GNU GPL v3.0 or later; this derived table is distributed under the same",
  "// terms as part of SYNQ (AGPL-3.0, which is GPL-3-compatible). FCC's catalog was extracted from the",
  `// official VTER / driveall web driver ("${catalog.source}").`,
  "//",
  "// Units: travel, actuation and rapid-trigger sensitivity in 0.01 mm. Layout rows are",
  "// [key index, HID usage (0 = Fn / none), x, y, w, h] in key units; the key index addresses every",
  "// per-key region of the Sonix protocol (key map, RT, colours).",
  "",
  "export interface SonixLimits {",
  "  travel: number;",
  "  actuationDefault: number;",
  "  sensMin: number;",
  "  sensMax: number;",
  "  sensDefault: number;",
  "}",
  "",
  "export interface SonixCatalogEntry {",
  "  /** FCC's model id. */",
  "  id: string;",
  "  /** Name as the official driver lists it (usually the USB product string). */",
  "  name: string;",
  "  vendorId: number;",
  "  productId: number;",
  "  /** Key into SONIX_LAYOUTS. */",
  "  layout: string;",
  "  /** \"wired\" boards speak the protocol on usage page 0xFF68 / usage 0x61; dongles and unknowns are not supported. */",
  "  transport: \"wired\" | \"dongle\" | \"unknown\";",
  "  /** \"verified\": confirmed end to end by FCC on hardware. \"untested\": same firmware family, never confirmed. */",
  "  status: \"verified\" | \"untested\" | \"unsupported\";",
  "  limits: SonixLimits;",
  "}",
  "",
  `export const SONIX_CATALOG_SOURCE = { repo: "https://github.com/shybruh/FightingControlCenter-FCC", commit: "${commitOf(fcc)}", extracted: "${catalog.source}" } as const;`,
  "",
  "export const SONIX_CATALOG: readonly SonixCatalogEntry[] = [",
  ...devices.map(
    (d) =>
      `  { id: ${JSON.stringify(d.id)}, name: ${JSON.stringify(d.name)}, vendorId: ${hex4(d.vendorId)}, productId: ${hex4(d.productId)}, layout: ${JSON.stringify(d.layout)}, transport: ${JSON.stringify(d.transport)}, status: ${JSON.stringify(d.status)}, limits: ${lim(d.limits)} },`,
  ),
  "];",
  "",
  "/** [key index, HID usage, x, y, w, h] per key. */",
  "export type SonixLayoutKey = readonly [number, number, number, number, number, number];",
  "",
  "export const SONIX_LAYOUTS: Readonly<Record<string, readonly SonixLayoutKey[]>> = {",
  ...Object.entries(layouts).map(([name, keys]) => `  ${JSON.stringify(name)}: [${keys.map((k) => `[${k.join(",")}]`).join(",")}],`),
  "};",
  "",
];
const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/kb/fcc/sonix-catalog.generated.ts");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out.join("\n"));
console.log(`${devices.length} boards, ${Object.keys(layouts).length} layouts -> ${dest}`);
