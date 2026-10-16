// Writes src/lib/brands/rk-beiying/catalog.generated.ts: the Royal Kludge "BeiYing" (SinoWealth, VID 0x258A)
// boards the legacy RK software channel drives, with their key slots, default firmware codes, layouts and
// lighting modes.
//
// Run: node scripts/gen-rk-beiying-catalog.mjs <KludgeKnight checkout> <Rangoli checkout> [FCC checkout]
//
// Sources, all GPL-3.0(-or-later), all read as data (nothing is imported or run):
//   vinc3m1/kludgeknight  public/rk/Cfg.ini (UTF-16: PID -> name list of RK's Windows software) and
//                         public/rk/Dev/<PID>/KB.ini (RK's per-board layout and lighting facts, which
//                         KludgeKnight copied from RK's software), src/types/keycode.ts (the Windows virtual-key
//                         code -> firmware code table, ported below as VK_TO_FW), the per-board led.xml mode names.
//   rnayabed/rangoli      keyboards-list.md (which boards its author or users confirmed), src/modemodel.h
//                         (the lighting mode names of the older RGB boards, ported below as RGB_OLD_MODES).
//   shybruh/FightingControlCenter-FCC  app/src/devices/rk-catalog.json: the four M75 boards it wires up.
// Only facts are extracted (key positions and slots, default key codes, lighting-mode capability flags,
// names); RK's files themselves are not shipped.
//
// What is left out, and why:
//   - Rangoli's "not supported" boards (0102, 00A9);
//   - the 18 boards whose KB.ini describes a screen (ShowScreen / DataUnitSize 512): they use a newer data format;
//   - the six boards with no lighting table at all (01CB, 01F4, 0207, 020C, 0210, 0216): not this generation.
// A board whose key list holds a default SYNQ can't state with confidence (an unknown virtual key, RK's
// special type-9 rows, "Sleep?" / "Unknown" entries) is kept but marked keymap: false, because SYNQ rewrites
// the whole key map and a wrong default would replace a working key with nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [kk, rangoli, fcc] = process.argv.slice(2);
if (!kk || !rangoli) throw new Error("usage: node scripts/gen-rk-beiying-catalog.mjs <KludgeKnight checkout> <Rangoli checkout> [FCC checkout]");

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

// Windows virtual-key code (KB.ini) -> RK firmware code. Ported from KludgeKnight src/types/keycode.ts KEY_MAP (GPL-3.0).
// 0xD8 ("Sleep?") and 0xDA ("Unknown") are deliberately not here: nobody knows what they are.
const VK_TO_FW = {
  0x08: 0x2a00, 0x09: 0x2b00, 0x0d: 0x2800, 0x13: 0x4800, 0x14: 0x3900, 0x1b: 0x2900, 0x20: 0x2c00, 0xe0: 0x2c00,
  0x21: 0x4b00, 0x22: 0x4e00, 0x23: 0x4d00, 0x24: 0x4a00, 0x25: 0x5000, 0x26: 0x5200, 0x27: 0x4f00, 0x28: 0x5100,
  0x2c: 0x4600, 0x2d: 0x4900, 0x2e: 0x4c00,
  0xba: 0x3300, 0xbb: 0x2e00, 0xbc: 0x3600, 0xbd: 0x2d00, 0xbe: 0x3700, 0xbf: 0x3800, 0xc0: 0x3500,
  0xdb: 0x2f00, 0xdc: 0x3100, 0xdd: 0x3000, 0xde: 0x3400, 0xe2: 0x6400,
  0x91: 0x4700, 0xa0: 0x020000, 0xa1: 0x200000, 0xa2: 0x010000, 0xa3: 0x100000, 0xa4: 0x040000, 0xa5: 0x400000,
  0x5b: 0x080000, 0x5c: 0x800000, 0x5d: 0x6500,
  0x60: 0x6200, 0x61: 0x5900, 0x62: 0x5a00, 0x63: 0x5b00, 0x64: 0x5c00, 0x65: 0x5d00, 0x66: 0x5e00, 0x67: 0x5f00, 0x68: 0x6000, 0x69: 0x6100,
  0x6a: 0x5500, 0x6b: 0x5700, 0x6d: 0x5600, 0x6e: 0x6300, 0x6f: 0x5400, 0x90: 0x5300,
  0xfa: 0xb000, 0xfd: 0x5800,
  0xd9: 0x010400, 0xb9: 0x010600, 0xb8: 0x011b00, 0xc1: 0x011d00, 0xc6: 0x011900, 0xc7: 0x011600,
  0x89: 0x010000cd, 0x8a: 0x010000b7, 0x8b: 0x010000b6, 0x8c: 0x010000b5, 0x8d: 0x010000e9, 0x8e: 0x010000ea, 0x8f: 0x010000e2,
  0x99: 0x01000192,
  0xad: 0x010000e2, 0xae: 0x010000ea, 0xaf: 0x010000e9, 0xb0: 0x010000b5, 0xb1: 0x010000b6, 0xb2: 0x010000b7, 0xb3: 0x010000cd,
};
for (let i = 0; i < 26; i++) VK_TO_FW[0x41 + i] = [0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d][i] << 8;
for (let i = 1; i <= 9; i++) VK_TO_FW[0x30 + i] = (0x1d + i) << 8;
VK_TO_FW[0x30] = 0x2700;
for (let i = 0; i < 12; i++) VK_TO_FW[0x70 + i] = (0x3a + i) << 8;

// Lighting mode names of the older RGB boards (21 modes), by mode number. Ported from Rangoli src/modemodel.h RGBModes (GPL-3.0).
const RGB_OLD_MODES = ["Neon stream", "Ripples shining", "Rotating windmill", "Sine wave", "Rainbow roulette", "Stars twinkle", "Layer upon layer", "Rich and honored", "Marquee effect", "Rotating storm", "Serpentine horse race", "Retro snake", "Diagonal transformation", "Custom", "Ambilight", "Streamer", "Steady", "Breathing", "Neon", "Shadow disappear", "Flash away"];

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

const devDir = path.join(kk, "public/rk/Dev");
const decode16 = (file) => new TextDecoder("utf-16le").decode(fs.readFileSync(file)).replace(/^﻿/, "").replace(/\r/g, "");

// PID -> name, from Cfg.ini ("DevNameN=014E,RK-F68")
const cfg = decode16(path.join(kk, "public/rk/Cfg.ini"));
const names = new Map([...cfg.matchAll(/^DevName\d*=([0-9A-Fa-f]{4}),(.+)$/gm)].map((m) => [parseInt(m[1], 16), m[2].trim()]));

// Rangoli's confirmation list
const rangoliList = new Map();
for (const line of fs.readFileSync(path.join(rangoli, "keyboards-list.md"), "utf8").split("\n")) {
  const m = line.match(/^\|\s*(.+?)\s*\|\s*([0-9a-fA-F]{4})\s*\|\s*(\S+)\s*\|/);
  if (!m) continue;
  const status = m[3].includes("🚀") ? "confirmed" : m[3].includes("✔") ? "listed" : m[3].includes("❗") ? "partial" : m[3].includes("❌") ? "unsupported" : null;
  if (status) rangoliList.set(parseInt(m[2], 16), { name: m[1], status });
}
const fccPids = new Set();
if (fcc) {
  const rk = JSON.parse(fs.readFileSync(path.join(fcc, "app/src/devices/rk-catalog.json"), "utf8"));
  for (const d of rk.devices) fccPids.add(d.productId);
}

function parseIni(file) {
  const text = fs.readFileSync(file, "latin1").replace(/\r/g, "");
  const sections = {};
  let cur = null;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith(";")) continue;
    const h = s.match(/^\[(.+)\]$/);
    if (h) {
      cur = sections[h[1]] = {};
      continue;
    }
    const kv = s.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (kv && cur) cur[kv[1].trim()] = kv[2].trim();
  }
  return sections;
}

// ---------------------------------------------------------------------------------------------
// One board
// ---------------------------------------------------------------------------------------------

const q = (v) => Math.round(v * 4) / 4;

function layoutOf(keys) {
  const vis = keys.filter((k) => k.x2 > k.x1 && k.y2 > k.y1);
  if (!vis.length) return [];
  const widths = vis.map((k) => k.x2 - k.x1).sort((a, b) => a - b);
  const unitW = widths[Math.floor(widths.length / 2)];
  const steps = [];
  for (const a of vis) for (const b of vis) if (b.x1 > a.x1 && Math.abs(b.y1 - a.y1) < 5 && b.x1 - a.x1 < unitW * 2.2) steps.push(b.x1 - a.x1);
  steps.sort((a, b) => a - b);
  const pitch = steps.length ? steps[Math.floor(steps.length / 4)] : unitW;
  const tops = [...new Set(vis.map((k) => k.y1))].sort((a, b) => a - b);
  const rows = [];
  for (const t of tops) if (!rows.length || t - rows[rows.length - 1] > unitW * 0.6) rows.push(t);
  const rowOf = (y) => rows.reduce((best, r, i) => (Math.abs(r - y) < Math.abs(rows[best] - y) ? i : best), 0);
  const rowPitch = rows.length > 1 ? (rows[rows.length - 1] - rows[0]) / (rows.length - 1) : unitW;
  const x0 = Math.min(...vis.map((k) => k.x1));
  return vis.map((k) => [k.slot, k.fw ?? 0, q((k.x1 - x0) / pitch), rowOf(k.y1), q((k.x2 - k.x1 + (pitch - unitW)) / pitch), Math.max(1, Math.min(3, Math.round((k.y2 - k.y1) / (rowPitch * 0.92))))]);
}

const boards = [];
const skipped = { unsupported: [], screen: [], noLighting: [], noKeys: [] };
for (const dir of fs.readdirSync(devDir).filter((d) => /^[0-9A-Fa-f]{4}$/.test(d)).sort()) {
  const pid = parseInt(dir, 16);
  const ini = parseIni(path.join(devDir, dir, "KB.ini"));
  const opt = ini.OPT ?? {};
  if (rangoliList.get(pid)?.status === "unsupported") {
    skipped.unsupported.push(dir);
    continue;
  }
  if (opt.ShowScreen === "1" || opt.DataUnitSize) {
    skipped.screen.push(dir);
    continue;
  }
  const ledNums = Object.keys(opt).filter((k) => /^LedOpt\d+$/.test(k)).map((k) => +k.slice(6)).sort((a, b) => a - b);
  if (opt.RGBKb === undefined || !ledNums.length) {
    skipped.noLighting.push(dir);
    continue;
  }
  // Keys
  const keys = [];
  let complete = true;
  const problems = [];
  for (const [k, v] of Object.entries(ini.KEY ?? {})) {
    if (!/^K\d+$/.test(k)) continue;
    const p = v.split(",").map((x) => x.trim());
    // A row has 8 fields; some boards add more slot numbers after the first (other layers). The first is the base layer's.
    if (p.length < 8) {
      complete = false;
      problems.push(`${k}: ${p.length} fields`);
      continue;
    }
    const row = { x1: +p[0], y1: +p[1], x2: +p[2], y2: +p[3], type: parseInt(p[4], 16), vk: parseInt(p[5], 16), slot: +p[7] };
    row.fw = row.type === 0x02 ? VK_TO_FW[row.vk] : undefined;
    if (row.fw === undefined) {
      complete = false;
      problems.push(`${k}: type ${p[4]} vk ${p[5]}`);
    }
    if (!Number.isInteger(row.slot) || row.slot < 0 || row.slot >= 139) {
      complete = false;
      problems.push(`${k}: slot ${p[7]}`);
    }
    keys.push(row);
  }
  if (!keys.length) {
    skipped.noKeys.push(dir);
    continue;
  }
  if (new Set(keys.map((k) => k.slot)).size !== keys.length) {
    complete = false;
    problems.push("a slot is named twice");
  }
  const layout = layoutOf(keys);
  const fw1 = opt.Fw === "1" || opt.Fw === "2";
  const hasLedXml = fs.existsSync(path.join(devDir, dir, "en", "led.xml"));
  const gen = hasLedXml ? "own" : opt.RGBKb === "1" && !fw1 && ledNums.length === 21 ? "rgb-old" : "standard";
  let modeNames = null;
  if (gen === "own") {
    const xml = decode16(path.join(devDir, dir, "en", "led.xml"));
    modeNames = Object.fromEntries([...xml.matchAll(/<tc_led(\d+)>([^<]*)</g)].map((m) => [+m[1], m[2].replace(/_/g, " ").trim()]));
  }
  const modes = ledNums.map((n) => {
    const f = opt[`LedOpt${n}`].split(",").map((x) => +x.trim());
    // [animation, speed, brightness, direction, random, color] -> bit flags
    const flags = (f[1] ? 1 : 0) | (f[2] ? 2 : 0) | ((f[3] & 3) << 2) | (f[4] ? 16 : 0) | (f[5] ? 32 : 0);
    return [n, flags];
  });
  const known = rangoliList.get(pid);
  const status = known?.status === "confirmed" ? "confirmed" : known?.status === "listed" ? "listed" : known?.status === "partial" ? "partial" : fccPids.has(pid) ? "listed" : "rk-only";
  // Rangoli's notes: 0057 has no working key map; 0065 has red and green swapped.
  const quirks = [];
  if (pid === 0x57) {
    complete = false;
    problems.push("Rangoli issue 16: the key map does not work on this board");
  }
  if (pid === 0x65) quirks.push("swap-red-green");
  boards.push({
    pid,
    name: names.get(pid) ?? known?.name ?? `RK keyboard ${dir}`,
    rangoliName: known?.name,
    rgb: opt.RGBKb === "1",
    gen,
    modeNames,
    modes,
    defMode: +opt.DefLedIndex || null,
    defBri: opt.DefBri !== undefined ? +opt.DefBri : null,
    layers: +opt.LayerNum || 1,
    status,
    quirks,
    keymap: complete && layout.length > 0,
    problems,
    layout,
    keyCount: keys.length,
    slots: Math.max(...keys.map((k) => k.slot)) + 1,
  });
}

// Share layouts between boards that have the same one.
const layoutIds = new Map();
const layouts = [];
for (const b of boards) {
  const sig = JSON.stringify(b.layout);
  if (!layoutIds.has(sig)) {
    layoutIds.set(sig, `r${layouts.length}`);
    layouts.push({ id: `r${layouts.length}`, rows: b.layout, first: b.pid });
  }
  b.layoutId = layoutIds.get(sig);
}

const hex4 = (n) => "0x" + n.toString(16).padStart(4, "0");
const kkCommit = commitOf(kk);
const rgCommit = commitOf(rangoli);
const fccCommit = fcc ? commitOf(fcc) : "none";
const own = {};
for (const b of boards) if (b.modeNames) own[b.pid] = b.modeNames;

const out = [
  "// GENERATED by scripts/gen-rk-beiying-catalog.mjs. Do not edit by hand.",
  "//",
  "// Royal Kludge \"BeiYing\" (SinoWealth, VID 0x258A) boards the legacy RK software channel drives.",
  "// Facts (names, key slots and default codes, layouts, lighting-mode flags) read from:",
  `//   vinc3m1/kludgeknight ${kkCommit}  public/rk/Cfg.ini, public/rk/Dev/<PID>/KB.ini and led.xml (RK's own software data,`,
  "//     facts only), src/types/keycode.ts (virtual-key -> firmware-code table)       GPL-3.0",
  `//   rnayabed/rangoli ${rgCommit}  keyboards-list.md (which boards were confirmed), src/modemodel.h (mode names)   GPL-3.0`,
  `//   shybruh/FightingControlCenter-FCC ${fccCommit}  app/src/devices/rk-catalog.json (the M75 family)   GPL-3.0-or-later`,
  "// This derived table is distributed under the same terms as part of SYNQ (AGPL-3.0, GPL-3-compatible).",
  "//",
  `// ${boards.length} boards kept. Left out: ${skipped.unsupported.length} Rangoli-unsupported (${skipped.unsupported.join(", ") || "none"}), ${skipped.screen.length} with a screen (newer data format),`,
  `// ${skipped.noLighting.length} with no lighting table (${skipped.noLighting.join(", ") || "none"}), ${skipped.noKeys.length} with no key list.`,
  "//",
  "// Layout rows: [key slot, default firmware code, x, y, w, h] in key units. The firmware code is big-endian 32 bits:",
  "// HID usage << 8 (+ modifier mask << 16), 0xB000 Fn, 0x01000000 | usage consumer. Mode flags: 1 speed, 2 brightness,",
  "// 4 x direction (0 none, 1 left / right, 2 up / down), 16 random colours, 32 colour picker.",
  "",
  "export type RkGen = \"rgb-old\" | \"standard\" | \"own\";",
  "export type RkStatus = \"confirmed\" | \"listed\" | \"partial\" | \"rk-only\";",
  "",
  "export interface RkBoard {",
  "  pid: number;",
  "  /** The name RK's software lists. */",
  "  name: string;",
  "  rgb: boolean;",
  "  /** Which lighting mode names apply: the older RGB table, the standard one, or the board's own (RK_OWN_MODES). */",
  "  gen: RkGen;",
  "  /** [mode number, capability flags] in RK's order. */",
  "  modes: readonly (readonly [number, number])[];",
  "  defMode: number | null;",
  "  defBri: number | null;",
  "  layers: number;",
  "  /** Who has confirmed the board: Rangoli's author or users (confirmed), Rangoli / FCC list it (listed), Rangoli says partly (partial), only RK's own software (rk-only). */",
  "  status: RkStatus;",
  "  quirks: readonly string[];",
  "  /** Every key's default code is known, so the key map can be rewritten safely. */",
  "  keymap: boolean;",
  "  /** Key slots in the base layer's map (highest slot + 1). */",
  "  slots: number;",
  "  /** Key into RK_LAYOUTS. */",
  "  layout: string;",
  "}",
  "",
  `export const RK_CATALOG_SOURCE = { kludgeknight: "${kkCommit}", rangoli: "${rgCommit}", fcc: "${fccCommit}" } as const;`,
  "",
  "export const RK_BOARDS: readonly RkBoard[] = [",
  ...boards.map(
    (b) =>
      `  { pid: ${hex4(b.pid)}, name: ${JSON.stringify(b.name)}, rgb: ${b.rgb}, gen: ${JSON.stringify(b.gen)}, modes: [${b.modes.map(([n, f]) => `[${n},${f}]`).join(",")}], defMode: ${b.defMode}, defBri: ${b.defBri}, layers: ${b.layers}, status: ${JSON.stringify(b.status)}, quirks: ${JSON.stringify(b.quirks)}, keymap: ${b.keymap}, slots: ${b.slots}, layout: ${JSON.stringify(b.layoutId)} },`,
  ),
  "];",
  "",
  "/** Mode names of the boards that ship their own table (RK's per-board led.xml), by mode number. */",
  `export const RK_OWN_MODES: Readonly<Record<number, Readonly<Record<number, string>>>> = ${JSON.stringify(own)};`,
  "",
  "/** The older RGB boards' mode names by mode number - 1 (Rangoli's RGBModes). */",
  `export const RK_RGB_OLD_MODES: readonly string[] = ${JSON.stringify(RGB_OLD_MODES)};`,
  "",
  "export type RkLayoutKey = readonly [number, number, number, number, number, number];",
  "export const RK_LAYOUTS: Readonly<Record<string, readonly RkLayoutKey[]>> = {",
  ...layouts.map((l) => `  ${l.id}: [${l.rows.map((k) => `[${k.join(",")}]`).join(",")}], // ${hex4(l.first)}`),
  "};",
  "",
];
const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/brands/rk-beiying/catalog.generated.ts");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out.join("\n"));
const by = (f) => boards.filter(f).length;
console.log(`${boards.length} boards (${by((b) => b.keymap)} with a key map, ${by((b) => !b.keymap)} lighting only), ${layouts.length} layouts, ${out.join("\n").length} bytes -> ${dest}`);
console.log("status:", JSON.stringify(boards.reduce((a, b) => ((a[b.status] = (a[b.status] || 0) + 1), a), {})), "gen:", JSON.stringify(boards.reduce((a, b) => ((a[b.gen] = (a[b.gen] || 0) + 1), a), {})));
console.log("skipped:", JSON.stringify(skipped));
const bad = boards.filter((b) => !b.keymap);
console.log("lighting-only:", bad.slice(0, 40).map((b) => `${b.pid.toString(16)}(${b.problems[0] ?? "?"})`).join("; "));
