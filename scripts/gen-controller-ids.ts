// Writes the controller id tables, from facts only:
//
//   scripts/controllers/sdl/usb_ids.h, controller_list.h   SDL (zlib; vendored with their notice)
//   scripts/controllers/xpad-ids.json                       Linux xpad.c's device table (GPL-2.0+; ids used as facts)
//   src/lib/controllers/models.ts                           SYNQ's models, identities and boot/recovery ids
//
// into
//
//   src/lib/controllers/ids.generated.ts   every id with its controller type, transport and name (TypeScript)
//   src-tauri/src/controller_ids.rs        the same ids and the guard families for the Rust bridge
//
// scripts/controllers.test.ts regenerates both and compares, so the tables can't drift. Run after changing any input:
//
//   node scripts/gen-controller-ids.ts
//   node scripts/gen-controller-ids.ts --xpad path/to/xpad.c --linux <commit>   (refreshes xpad-ids.json first)
//
// Nothing here talks to a device.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { G7_8K_LIGHT_MODES, GAMESIR_CURVES, GAMESIR_MAPS, GAMESIR_TARGETS, gamesirFields, type FieldKind, type GamesirModel } from "../src/lib/controllers/gamesir.ts";
import { PAD_BOOT_IDS, PAD_MODELS, PAD_NOT_PAD_VENDORS, PAD_NOT_PADS, PAD_SHIM_IDS } from "../src/lib/controllers/models.ts";
import type { PadKind, PadRow, PadTransport } from "../src/lib/controllers/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SDL_DIR = join(root, "scripts/controllers/sdl");
const XPAD_JSON = join(root, "scripts/controllers/xpad-ids.json");
export const TS_OUT = join(root, "src/lib/controllers/ids.generated.ts");
export const RS_OUT = join(root, "src-tauri/src/controller_ids.rs");

/** SDL commit the vendored headers come from (scripts/controllers/sdl/SOURCE). */
const sdlCommit = () => readFileSync(join(SDL_DIR, "SOURCE"), "utf8").trim();

export const KINDS: readonly PadKind[] = [
  "xbox360",
  "xboxone",
  "xboxelite",
  "ps3",
  "ps4",
  "ps5",
  "ps5edge",
  "switchpro",
  "switchinput",
  "joycon",
  "switch2",
  "steam",
  "steamdeck",
  "steamtriton",
  "horisteam",
  "8bitdo",
  "gamesir",
  "flydigi",
  "generic",
];
export const TRANSPORTS: readonly PadTransport[] = ["hid", "xusb", "gip", "usb"];

/** SDL controller type -> SYNQ kind, or null to leave the id out. */
const SDL_TYPES: Record<string, PadKind | null> = {
  XBox360Controller: "xbox360",
  XBoxOneController: "xboxone",
  XBoxEliteController: "xboxelite",
  PS3Controller: "ps3",
  PS4Controller: "ps4",
  PS5Controller: "ps5",
  PS5EdgeController: "ps5edge",
  XInputPS4Controller: "xbox360",
  XInputSwitchController: "xbox360",
  SwitchProController: "switchpro",
  SwitchInputOnlyController: "switchinput",
  SwitchJoyConLeft: "joycon",
  SwitchJoyConRight: "joycon",
  SwitchJoyConPair: "joycon",
  Switch2ProController: "switch2",
  Switch2InputOnlyController: "switch2",
  SteamController: "steam",
  SteamControllerV2: "steam",
  SteamControllerNeptune: "steamdeck",
  SteamControllerTriton: "steamtriton",
  HoriSteamController: "horisteam",
  "8BitDoController": "8bitdo",
  MobileTouch: null,
  UnknownNonSteamController: null,
};

const TRANSPORT_OF: Record<PadKind, PadTransport> = {
  xbox360: "xusb",
  xboxone: "gip",
  xboxelite: "gip",
  ps3: "hid",
  ps4: "hid",
  ps5: "hid",
  ps5edge: "hid",
  switchpro: "hid",
  switchinput: "hid",
  joycon: "hid",
  switch2: "usb",
  steam: "hid",
  steamdeck: "hid",
  steamtriton: "hid",
  horisteam: "hid",
  "8bitdo": "hid",
  gamesir: "hid",
  flydigi: "hid",
  generic: "hid",
};

const VENDOR_KIND: Record<number, PadKind> = { 0x2dc8: "8bitdo", 0x3537: "gamesir", 0x04b4: "flydigi", 0x37d7: "flydigi" };

const key = (v: number, p: number) => v * 0x10000 + p;
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
/** An SDL comment as a name: no notes to SDL's developers, links or question marks. */
const nameOf = (comment: string) =>
  clean(
    comment
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\s*-?\s*XXX:.*$/i, "")
      .replace(/\(?(with [^)]*\?\?)\)?/g, "")
      .replace(/\?+/g, "")
      .replace(/^(actually )?ps2(?![0-9a-z]).*$/i, "PS2 controller adapter")
      .replace(/\s*-\s*$/, ""),
  );

interface UsbProduct {
  vid: number;
  pid: number;
  define: string;
}

/** usb_ids.h: vendors by name, then every USB_PRODUCT_* define with the vendor its name starts with. */
export function parseUsbIds(text: string): { vendors: Map<string, number>; products: UsbProduct[] } {
  const vendors = new Map<string, number>();
  for (const m of text.matchAll(/#define\s+USB_VENDOR_(\w+)\s+(0x[0-9a-fA-F]+)/g)) vendors.set(m[1], parseInt(m[2], 16));
  const names = [...vendors.keys()].sort((a, b) => b.length - a.length);
  const products: UsbProduct[] = [];
  for (const m of text.matchAll(/#define\s+USB_PRODUCT_(\w+)\s+(0[xX][0-9a-fA-F]+)/g)) {
    const define = m[1];
    // The vendor whose name the define starts with; the Xbox and BDA products are Microsoft's / PowerA's.
    let vendor = names.find((n) => define.startsWith(`${n}_`));
    if (!vendor && /^XBOX/.test(define)) vendor = "MICROSOFT";
    if (!vendor && /^BDA_/.test(define)) vendor = "POWERA";
    if (!vendor && /^STEALTH_ULTRA/.test(define)) vendor = "TURTLE_BEACH";
    if (!vendor && /^(HANDHELDLEGEND|BONZIRICHANNEL|VOIDGAMING)_/.test(define)) vendor = "RASPBERRYPI";
    if (!vendor && /^EVORETRO_/.test(define)) continue;
    if (!vendor || !vendors.has(vendor)) continue;
    products.push({ vid: vendors.get(vendor)!, pid: parseInt(m[2], 16), define });
  }
  return { vendors, products };
}

interface SdlEntry {
  vid: number;
  pid: number;
  type: string;
  name: string;
}

/** controller_list.h: every live `{ MAKE_CONTROLLER_ID( v, p ), k_eControllerType_X, name }, // comment` line. */
export function parseControllerList(text: string): SdlEntry[] {
  const out: SdlEntry[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*\/\//.test(line)) continue;
    const m = line.match(/\{\s*MAKE_CONTROLLER_ID\(\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*\)\s*,\s*k_eControllerType_(\w+)\s*,\s*(NULL|"[^"]*")\s*\}\s*,?\s*(?:\/\/\s*(.*))?$/);
    if (!m) continue;
    const named = m[4] !== "NULL" ? m[4].slice(1, -1) : "";
    const comment = clean(m[5] ?? "");
    const name = named || (/^(from sdl|unknown controller|added .*|\?+|.*unknown controller)$/i.test(comment) ? "" : nameOf(comment));
    out.push({ vid: parseInt(m[1], 16), pid: parseInt(m[2], 16), type: m[3], name: clean(name) });
  }
  return out;
}

export interface XpadFacts {
  source: string;
  commit: string;
  rows: [number, number, string, string][];
}

/** xpad.c's `xpad_device[]`: `{ 0x045e, 0x0b12, "name", mapping, XTYPE_X },`. */
export function parseXpad(text: string, commit: string): XpadFacts {
  const start = text.indexOf("xpad_device[] = {");
  const end = text.indexOf("};", start);
  const rows: [number, number, string, string][] = [];
  for (const m of text.slice(start, end).matchAll(/\{\s*(0x[0-9a-fA-F]{4})\s*,\s*(0x[0-9a-fA-F]{4})\s*,\s*"([^"]*)"\s*,[^,]*,\s*(XTYPE_\w+)\s*\}/g)) {
    rows.push([parseInt(m[1], 16), parseInt(m[2], 16), clean(m[3]), m[4]]);
  }
  return { source: "torvalds/linux drivers/input/joystick/xpad.c (xpad_device[]; GPL-2.0-or-later, ids and names used as facts)", commit, rows };
}

const titled = (define: string) =>
  define
    .split("_")
    .map((w) => (/^(XB1|PS\d|DS\d|USB|BT|BLE|PC|8K|HD|NSO|GC|N64|SNES|XUSB|RB\d|GH|MPA|UWB|ONE)$/i.test(w) ? w.toUpperCase() : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(" ");

/** Every id with its kind, transport and a name, from SDL, xpad and the models (in that order of trust for the kind). */
export function buildRows(usbIds: string, list: string, xpad: XpadFacts): PadRow[] {
  const rows = new Map<number, { vid: number; pid: number; kind: PadKind; transport: PadTransport; name: string }>();
  const { products } = parseUsbIds(usbIds);
  const btIds = new Set(products.filter((p) => /BLUETOOTH|_BLE\b|_BLE_|_BT\b/.test(p.define)).map((p) => key(p.vid, p.pid)));
  const usbName = new Map(products.map((p) => [key(p.vid, p.pid), titled(p.define)]));
  const put = (vid: number, pid: number, kind: PadKind, name: string) => {
    let transport = TRANSPORT_OF[kind];
    if (btIds.has(key(vid, pid)) && transport !== "usb") transport = "hid";
    rows.set(key(vid, pid), { vid, pid, kind, transport, name });
  };

  for (const e of parseControllerList(list)) {
    const kind = SDL_TYPES[e.type];
    if (kind === undefined) throw new Error(`controller_list.h has a type this script doesn't know: ${e.type}`);
    if (kind === null) continue;
    put(e.vid, e.pid, kind, e.name || usbName.get(key(e.vid, e.pid)) || "");
  }
  for (const [vid, pid, name, xtype] of xpad.rows) {
    if (xtype === "XTYPE_XBOX") continue; // original Xbox pads: no Windows driver, no hidraw node
    const kind: PadKind = xtype === "XTYPE_XBOXONE" ? "xboxone" : "xbox360";
    const have = rows.get(key(vid, pid));
    if (!have) put(vid, pid, kind, name);
    else if (!have.name) have.name = name;
  }
  for (const p of products) {
    if (rows.has(key(p.vid, p.pid))) continue;
    const d = p.define;
    let kind: PadKind = VENDOR_KIND[p.vid] ?? "generic";
    if (/XBOX360|XB360/.test(d)) kind = "xbox360";
    else if (/XB1|XBOX_ONE|XBOX_SERIES|XBOXGIP/.test(d)) kind = /ELITE/.test(d) ? "xboxelite" : "xboxone";
    else if (/SWITCH2/.test(d)) kind = "switch2";
    else if (/NINTENDO_SWITCH_JOYCON/.test(d)) kind = "joycon";
    else if (/NINTENDO_SWITCH_PRO/.test(d)) kind = "switchpro";
    else if (/SONY_DS5_EDGE/.test(d)) kind = "ps5edge";
    else if (/SONY_DS5/.test(d)) kind = "ps5";
    else if (/SONY_DS4|_PS4/.test(d)) kind = "ps4";
    else if (/SONY_DS3|_PS3|SHANWAN_DS3/.test(d)) kind = "ps3";
    else if (/VALVE_STEAM/.test(d)) kind = "steam";
    else if (/GAMECUBE_ADAPTER/.test(d) && p.vid === 0x057e) kind = "switch2"; // needs a WinUSB driver: detect only
    put(p.vid, p.pid, kind, titled(d));
  }
  // SYNQ's own models: their identities win (kind from the model, transport and name as recorded).
  const XBOX_KINDS: readonly PadKind[] = ["xbox360", "xboxone", "xboxelite"];
  const modelKind = (m: (typeof PAD_MODELS)[number], transport: PadTransport, vid: number, prior: PadKind | undefined): PadKind => {
    if (m.id === "sony-dualsense-edge") return "ps5edge";
    if (m.guard === "ds5") return "ps5";
    if (m.guard === "ds4") return "ps4";
    if (m.id.startsWith("nintendo-joycon2") || m.id === "nintendo-switch2-pro" || m.id === "nintendo-gamecube-switch2") return "switch2";
    if (m.id === "nintendo-joycon-grip") return "switchinput";
    if (m.id.startsWith("nintendo-joycon")) return "joycon";
    if (m.guard === "switch") return "switchpro";
    if (m.id === "valve-steam-deck") return "steamdeck";
    if (m.id === "valve-steam-controller-2026") return "steamtriton";
    if (m.id.startsWith("valve-")) return "steam";
    if (m.id === "hori-horipad-steam") return "horisteam";
    // Microsoft's pads keep their Xbox type on Bluetooth too (HID there, XInput over USB).
    if (m.brand === "Microsoft") return m.id.includes("elite") ? "xboxelite" : transport === "xusb" ? "xbox360" : "xboxone";
    if (transport === "gip") return "xboxone";
    if (transport === "xusb") return "xbox360";
    if (prior && !XBOX_KINDS.includes(prior)) return prior;
    return VENDOR_KIND[vid] ?? "generic";
  };
  for (const m of PAD_MODELS) {
    for (const i of m.ids) {
      const prior = rows.get(key(i.vid, i.pid));
      rows.set(key(i.vid, i.pid), { vid: i.vid, pid: i.pid, kind: modelKind(m, i.transport, i.vid, prior?.kind), transport: i.transport, name: m.name });
    }
  }
  // Never a pad: Windows' XInput shims, boot / recovery identities, a keyboard's gamepad mode.
  const never = new Set([...PAD_SHIM_IDS, ...PAD_NOT_PADS].map(([v, p]) => key(v, p)));
  for (const b of PAD_BOOT_IDS) never.add(key(b.vid, b.pid));
  return [...rows.values()]
    .filter((r) => r.vid !== 0 && !PAD_NOT_PAD_VENDORS.includes(r.vid) && !never.has(key(r.vid, r.pid)))
    .sort((a, b) => a.vid - b.vid || a.pid - b.pid)
    .map((r) => [r.vid, r.pid, r.kind, r.transport, r.name || "Game controller"] as const);
}

const h4 = (n: number) => `0x${n.toString(16).padStart(4, "0")}`;

/** The pids of the models whose guard is `guard`, as (vid, pid) pairs. */
const guardIds = (guard: string) =>
  PAD_MODELS.filter((m) => m.guard === guard)
    .flatMap((m) => m.ids.filter((i) => i.transport === "hid" && !i.readOnly).map((i) => [i.vid, i.pid] as const))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

export function tsText(rows: readonly PadRow[], xpad: XpadFacts): string {
  const boot = [...PAD_BOOT_IDS].sort((a, b) => a.vid - b.vid || a.pid - b.pid);
  return `// GENERATED by scripts/gen-controller-ids.ts. Do not edit.
//
// Every game-controller id SYNQ knows, with its controller type, how it reaches Windows and a name. Sources:
// SDL ${sdlCommit()} src/joystick/usb_ids.h + controller_list.h (zlib), Linux xpad.c ${xpad.commit.slice(0, 12)}
// (ids and names as facts), and src/lib/controllers/models.ts (SYNQ's models win). ${rows.length} ids.
import type { PadRow } from "./types.ts";

export const PAD_ROWS: readonly PadRow[] = [
${rows.map(([v, p, k, t, n]) => `  [${h4(v)}, ${h4(p)}, "${k}", "${t}", ${JSON.stringify(n)}],`).join("\n")}
];

/** Bootloader and recovery identities (models.ts PAD_BOOT_IDS): never listed, never opened. */
export const PAD_BOOT: readonly (readonly [number, number])[] = [${boot.map((b) => `[${h4(b.vid)}, ${h4(b.pid)}]`).join(", ")}];
`;
}

/** GameSir models in the order GAMESIR_MAPS uses in Rust, and the field kinds by index. */
const GAMESIR_ORDER: readonly GamesirModel[] = ["cyclone2", "g7pro8k", "tarantula"];
const FIELD_KINDS: readonly FieldKind[] = ["percent", "permille16", "traj", "poll", "remap", "curve", "lightSlot", "lightMode"];
const h2 = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;

/** The GameSir register maps and value lists src-tauri/src/pads.rs checks writes against (gamesir.ts, generated). */
function gamesirRs(): string {
  const ids = GAMESIR_ORDER.flatMap((m, i) => guardIds(`gamesir-${m}`).map(([v, p]) => [v, p, i] as const)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const maps = GAMESIR_ORDER.map((model) => {
    const m = GAMESIR_MAPS[model];
    const fields = gamesirFields(model).map((f) => `(${f.bank === "profile" ? 0 : 1}, ${h4(f.at)}, ${f.len}, ${FIELD_KINDS.indexOf(f.kind)}, ${JSON.stringify(f.name)})`);
    return `    GamesirMap {
        name: ${JSON.stringify(m.name)},
        profile_size: ${h4(m.profileSize)},
        light_size: ${h4(m.lightSize)},
        poll_rates: ${m.pollRates.length},
        vibration: ${m.vibration},
        fields: &[
${fields.map((f) => `            ${f},`).join("\n")}
        ],
    },`;
  });
  return `
/// A GameSir model's register map (src/lib/controllers/gamesir.ts GAMESIR_MAPS): what src/pads.rs lets a write touch.
pub struct GamesirMap {
    pub name: &'static str,
    /// Bytes of a profile bank (1 to 4) and of the lighting bank 0x20 that may be read (0: never).
    pub profile_size: u16,
    pub light_size: u16,
    /// Report-rate codes 0 to poll_rates - 1.
    pub poll_rates: u8,
    /// Whether the rumble test may run.
    pub vibration: bool,
    /// (bank: 0 profile / 1 lighting, address, length, kind (GAMESIR_FIELD_KINDS), name).
    pub fields: &'static [(u8, u16, u8, u8, &'static str)],
}

/// What a field holds, by the index GamesirMap.fields uses.
pub const GAMESIR_FIELD_KINDS: [&str; ${FIELD_KINDS.length}] = [${FIELD_KINDS.map((k) => JSON.stringify(k)).join(", ")}];
/// Cyclone 2, G7 Pro 8K PC, Tarantula Pro 8K.
pub const GAMESIR_MAPS: [GamesirMap; ${GAMESIR_ORDER.length}] = [
${maps.join("\n")}
];
/// (vendor id, product id, GAMESIR_MAPS index): the GameSir ids whose settings SYNQ writes (per PID only).
pub const PAD_GAMESIR: [(u16, u16, u8); ${ids.length}] = [${ids.map(([v, p, i]) => `(${h4(v)}, ${h4(p)}, ${i})`).join(", ")}];
/// Remap targets: gamepad buttons only (never keyboard, mouse, macro or turbo codes).
pub const GAMESIR_TARGETS: [u8; ${GAMESIR_TARGETS.length}] = [${GAMESIR_TARGETS.map((t) => h2(t.code)).join(", ")}];
/// The Cyclone's curve presets, written whole.
pub const GAMESIR_CURVES: [[u8; 10]; ${GAMESIR_CURVES.length}] = [${GAMESIR_CURVES.map((c) => `[${c.block.map(h2).join(", ")}]`).join(", ")}];
/// The G7 Pro 8K's lighting modes.
pub const GAMESIR_LIGHT_MODES: [u8; ${G7_8K_LIGHT_MODES.length}] = [${G7_8K_LIGHT_MODES.map((l) => h2(l.code)).join(", ")}];
`;
}

export function rsText(rows: readonly PadRow[], xpad: XpadFacts): string {
  const boot = [...PAD_BOOT_IDS].sort((a, b) => a.vid - b.vid || a.pid - b.pid);
  const pairs = (list: readonly (readonly [number, number])[]) => list.map(([v, p]) => `(${h4(v)}, ${h4(p)})`).join(", ");
  const ds5 = guardIds("ds5");
  const edge = guardIds("edge");
  const ds4 = guardIds("ds4");
  const sw = guardIds("switch");
  const scuf = guardIds("scuf");
  const ebd = guardIds("8bitdo");
  const fd = guardIds("flydigi");
  return `//! GENERATED by scripts/gen-controller-ids.ts from SDL ${sdlCommit()} usb_ids.h + controller_list.h (zlib),
//! Linux xpad.c ${xpad.commit.slice(0, 12)} (ids as facts) and src/lib/controllers/models.ts. Do not edit.
//!
//! Every game-controller id the bridge knows (src/pads.rs decides what it may do with one).

/// Controller types, by the index PADS uses.
pub const KINDS: [&str; ${KINDS.length}] = [${KINDS.map((k) => JSON.stringify(k)).join(", ")}];
/// Transports, by the index PADS uses: a HID pad, an XInput pad (Xbox 360 class or Xbox One class), a USB device that needs a driver.
pub const TRANSPORTS: [&str; ${TRANSPORTS.length}] = [${TRANSPORTS.map((t) => JSON.stringify(t)).join(", ")}];
pub const HID: u8 = 0;

/// (vendor id, product id, kind, transport), sorted by vendor and product id.
pub const PADS: [(u16, u16, u8, u8); ${rows.length}] = [
${rows.map(([v, p, k, t]) => `    (${h4(v)}, ${h4(p)}, ${KINDS.indexOf(k)}, ${TRANSPORTS.indexOf(t)}),`).join("\n")}
];

/// Bootloader and recovery identities of controllers: never listed, never opened.
pub const PAD_BOOT: [(u16, u16); ${boot.length}] = [${pairs(boot.map((b) => [b.vid, b.pid] as const))}];
/// Sony DualSense: the ds5 guard (volatile outputs, firmware and calibration reads).
pub const PAD_DS5: [(u16, u16); ${ds5.length}] = [${pairs(ds5)}];
/// Sony DualSense Edge: the edge guard (the DualSense's, plus its profile reads and custom-slot writes).
pub const PAD_EDGE: [(u16, u16); ${edge.length}] = [${pairs(edge)}];
/// Sony DualShock 4: the ds4 guard.
pub const PAD_DS4: [(u16, u16); ${ds4.length}] = [${pairs(ds4)}];
/// Nintendo Switch Pro / Joy-Con: the switch guard (allowlisted subcommands, two rumble frames).
pub const PAD_SWITCH: [(u16, u16); ${sw.length}] = [${pairs(sw)}];
/// SCUF Envision Pro / Pro V2 (receivers and pads): the scuf guard (BRAGI 1.0 GETs of identity, firmware, battery and
/// the connected-pad bitmap; nothing else).
pub const PAD_SCUF: [(u16, u16); ${scuf.length}] = [${pairs(scuf)}];
/// 8BitDo Ultimate in HID (2.4G adapter, PC, config mode): the 8bitdo guard (config chunk reads / writes, save, the
/// vibration test; never calibration, reset or boot commands).
pub const PAD_8BITDO: [(u16, u16); ${ebd.length}] = [${pairs(ebd)}];
/// Flydigi in D-input mode (04B4:2412): the flydigi guard (device info, config reads, the config write checked
/// field by field, save to flash, the motor test; never the XInput switch, update mode, LED or screen writes).
pub const PAD_FLYDIGI: [(u16, u16); ${fd.length}] = [${pairs(fd)}];
${gamesirRs()}`;
}

/** A vendored header as LF text, however Git checked it out (core.autocrlf on Windows turns it into CRLF, and the patterns expect LF). */
const lf = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function inputs(): { usbIds: string; list: string; xpad: XpadFacts } {
  return {
    usbIds: lf(join(SDL_DIR, "usb_ids.h")),
    list: lf(join(SDL_DIR, "controller_list.h")),
    xpad: JSON.parse(readFileSync(XPAD_JSON, "utf8")) as XpadFacts,
  };
}

/** Both generated files as they should be now. */
export function generated(): { ts: string; rs: string; rows: readonly PadRow[] } {
  const { usbIds, list, xpad } = inputs();
  const rows = buildRows(usbIds, list, xpad);
  return { ts: tsText(rows, xpad), rs: rsText(rows, xpad), rows };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const xi = args.indexOf("--xpad");
  if (xi >= 0) {
    const commit = args[args.indexOf("--linux") + 1] ?? "unknown";
    const facts = parseXpad(readFileSync(args[xi + 1], "utf8"), commit);
    writeFileSync(XPAD_JSON, JSON.stringify(facts, null, 1) + "\n");
    console.log(`wrote ${XPAD_JSON} (${facts.rows.length} ids)`);
  }
  const g = generated();
  writeFileSync(TS_OUT, g.ts);
  writeFileSync(RS_OUT, g.rs);
  console.log(`wrote ${TS_OUT} and ${RS_OUT} (${g.rows.length} ids)`);
}
