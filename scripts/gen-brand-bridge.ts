// Writes src-tauri/src/brand_ids.rs: the USB ids of the keyboards whose protocol the bridge checks in
// Rust (src-tauri/src/brands.rs), taken from each driver's own device table so the two can't drift.
// scripts/kb-safety.test.ts regenerates the text and compares. Run after changing a device table:
//
//   node scripts/gen-brand-bridge.ts
//
// Nothing here talks to a device.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SONIX_APPLE_ALIAS, SONIX_USB_IDS } from "../src/lib/kb/fcc/sonix-devices.ts";
import { MONSGEEK_USB } from "../src/lib/brands/monsgeek/devices.ts";
import { DEVICES as DRUNKDEER_DEVICES, X60_VID } from "../src/lib/brands/drunkdeer/devices.ts";
import { fwIdsOf } from "../src/lib/brands/fw19f5/devices.ts";
import { RK_IDS } from "../src/lib/brands/rk-beiying/devices.ts";
import { SPARKLINK_IDS } from "../src/lib/brands/sparklink/devices.ts";
import { KEYCHRON_HE_IDS } from "../src/lib/kb/via/keychron/devices.ts";
import { ILLUMIPC_USB_IDS } from "../src/lib/illumipc/ids.ts";
import { RAZER_FEATURE_ONLY_PIDS, RAZER_KEYBOARDS, RAZER_MICE, RAZER_VALID_KEY_IDS } from "../src/lib/brands/razer/devices.ts";
import { ANALOGSENSE_BRIDGE } from "../src/lib/kb/analogsense/devices.ts";
import { bytechRequest } from "../src/lib/kb/analogsense/protocol.ts";
import { ASUS_BOOTLOADER_PIDS } from "../src/lib/brands/asus/devices.ts";
import { CORSAIR_MODELS } from "../src/lib/brands/corsair/devices.ts";
import { CORSAIR_ICUE_DEVICES, CORSAIR_MICE as ICUE_MICE } from "../src/lib/brands/corsair-icue/devices.ts";
import { LOGITECH_KEYBOARDS } from "../src/lib/brands/logitech-kb/devices.ts";
import { BOOTLOADER_PIDS as SS_BOOTLOADER_PIDS, MODELS as SS_MODELS, STEELSERIES_BRIDGE } from "../src/lib/brands/steelseries/devices.ts";
import { scopeFor } from "../src/lib/brands/steelseries/guard.ts";
import { claimsAsusKeyboard } from "../src/lib/brands/asus/keyboard.ts";
import { claimsCorsairKeyboard } from "../src/lib/brands/corsair/keyboard.ts";

const hex = (n: number) => `0x${n.toString(16).padStart(4, "0")}`;
const pairs = (list: readonly (readonly [number, number])[]) => list.map(([v, p]) => `(${hex(v)}, ${hex(p)})`).join(", ");

export function brandIdsText(): string {
  // Sonix: every wired id FCC lists, except the one on Apple's vendor id (left out for now).
  const sonix = SONIX_USB_IDS.filter((d) => !(d.vendorId === SONIX_APPLE_ALIAS.vendorId && d.productId === SONIX_APPLE_ALIAS.productId)).map((d) => [d.vendorId, d.productId] as const);
  if (sonix.some(([v]) => v !== 0x0c45)) throw new Error("A Sonix id outside 0x0C45");
  const monsgeek = MONSGEEK_USB.flatMap((u) => u.productIds.map((p) => [u.vendorId, p] as const));
  const drunkdeer = DRUNKDEER_DEVICES.filter((d) => d.tier !== "detectOnly" && d.vendorId !== X60_VID).map((d) => [d.vendorId, d.productId] as const);
  const x60 = DRUNKDEER_DEVICES.filter((d) => d.tier !== "detectOnly" && d.vendorId === X60_VID).map((d) => [d.vendorId, d.productId] as const);
  // Wave 4a: the 0x19F5 firmware family, one list per guard (src/lib/brands/fw19f5/devices.ts).
  const fw = (family: Parameters<typeof fwIdsOf>[0]) => fwIdsOf(family).map(([v, p]) => [v, p] as const);
  const razerKb = RAZER_FEATURE_ONLY_PIDS.filter((p) => RAZER_KEYBOARDS.some((m) => m.pid === p));
  const razerMice = RAZER_FEATURE_ONLY_PIDS.filter((p) => RAZER_MICE.some((m) => m.pid === p));
  const bytech = ANALOGSENSE_BRIDGE.filter((b) => b.output?.startsWith("report 9")).flatMap((b) => (b.productIds === "all" ? [] : b.productIds.map((p) => [b.vendorId, p] as const)));
  const req = bytechRequest();
  // Wave 3a / 4.
  const asusBoot = [...ASUS_BOOTLOADER_PIDS].sort((a, b) => a - b);
  const corsair = [...CORSAIR_MODELS.values()];
  const bragiKb = corsair.filter((m) => m.family === "kb" || m.family === "kb-he" || m.family === "receiver").map((m) => m.pid).sort((a, b) => a - b);
  const bragiMice = corsair.filter((m) => m.family === "mouse-bragi").map((m) => m.pid).sort((a, b) => a - b);
  const sabre = corsair.filter((m) => m.family === "mouse-sabre").map((m) => m.pid).sort((a, b) => a - b);
  const bragiV1 = corsair.filter((m) => m.family !== "mouse-sabre" && m.framing === "v1").map((m) => m.pid).sort((a, b) => a - b);
  const corsairFamily = (fam: string) => corsair.filter((m) => m.family === fam).map((m) => m.pid).sort((a, b) => a - b);
  const icueMice = new Set(ICUE_MICE.map((d) => d.productId));
  const icueKb = CORSAIR_ICUE_DEVICES.map((d) => d.productId).filter((p) => !icueMice.has(p)).sort((a, b) => a - b);
  const icueM = [...icueMice].sort((a, b) => a - b);
  const logi = LOGITECH_KEYBOARDS.map((d) => d.productId).sort((a, b) => a - b);
  const ssPids = [...STEELSERIES_BRIDGE.productIds].sort((a, b) => a - b);
  const ssBoot = [...SS_BOOTLOADER_PIDS].sort((a, b) => a - b);
  const ssFamily = (fam: string) => SS_MODELS.filter((m) => m.family === fam && ssPids.includes(m.productId)).map((m) => m.productId).sort((a, b) => a - b);
  const every = Array.from({ length: 0x10000 }, (_, p) => p);
  const listed: [number, number][] = [
    ...every.filter((p) => claimsAsusKeyboard(0x0b05, p)).map((p): [number, number] => [0x0b05, p]),
    ...every.filter((p) => claimsCorsairKeyboard(0x1b1c, p)).map((p): [number, number] => [0x1b1c, p]),
    ...logi.map((p): [number, number] => [0x046d, p]),
    ...ssPids.map((p): [number, number] => [0x1038, p]),
  ];
  const list = (name: string, doc: string, v: number[]) => `/// ${doc}\npub const ${name}: [u16; ${v.length}] = [${v.map(hex).join(", ")}];\n`;
  const keys = [...RAZER_VALID_KEY_IDS].sort((a, b) => a - b);
  return `//! GENERATED by scripts/gen-brand-bridge.ts from the drivers' own device tables. Do not edit.
//!
//! USB ids of the keyboards whose configuration channel the bridge opens and checks in brands.rs.

/// Sonix HE boards (FCC protocol, src/lib/kb/fcc/sonix-devices.ts SONIX_USB_IDS; 05AC:024F left out).
pub const SONIX: [(u16, u16); ${sonix.length}] = [${pairs(sonix)}];
/// MonsGeek / Akko (src/lib/brands/monsgeek/devices.ts MONSGEEK_USB).
pub const MONSGEEK: [(u16, u16); ${monsgeek.length}] = [${pairs(monsgeek)}];
/// DrunkDeer on its own vendor id (src/lib/brands/drunkdeer/devices.ts, not detect-only).
pub const DRUNKDEER: [(u16, u16); ${drunkdeer.length}] = [${pairs(drunkdeer)}];
/// DrunkDeer X60 on a borrowed vendor id: its product string must also say DrunkDeer / X60.
pub const DRUNKDEER_X60: [(u16, u16); ${x60.length}] = [${pairs(x60)}];
/// MCHOSE first-generation keyboards on Generic Desktop 0001:0000 (src/lib/brands/fw19f5/devices.ts, family mchose).
pub const FW19F5_MCHOSE: [(u16, u16); ${fw("mchose").length}] = [${pairs(fw("mchose"))}];
/// DrunkDeer gen-2 boards on 0x19F5 (family drunkdeer; only 19F5:FB5C may be written).
pub const FW19F5_DRUNKDEER: [(u16, u16); ${fw("drunkdeer").length}] = [${pairs(fw("drunkdeer"))}];
/// NuPhy V3 / HE boards (family nuphy): the info and base reads only.
pub const FW19F5_NUPHY: [(u16, u16); ${fw("nuphy").length}] = [${pairs(fw("nuphy"))}];
/// Royal Kludge Gcome boards (family rk-gcome): the info and base reads only.
pub const FW19F5_RK_GCOME: [(u16, u16); ${fw("rk-gcome").length}] = [${pairs(fw("rk-gcome"))}];
/// Royal Kludge BeiYing boards on System Control 0001:0080, feature report 0x0A only (src/lib/brands/rk-beiying/devices.ts).
pub const RK_BEIYING: [(u16, u16); ${RK_IDS.length}] = [${pairs(RK_IDS)}];
/// SparkLink keyboards (Royal Kludge C / M75 HE / X87, AULA HE, Kochi) on the vendor collection 0xFFA0:0x0001 (src/lib/brands/sparklink/devices.ts).
pub const SPARKLINK: [(u16, u16); ${SPARKLINK_IDS.length}] = [${pairs(SPARKLINK_IDS)}];
/// Keychron / Lemokey Hall-effect keyboards whose VIA raw-HID channel also takes Keychron's 0xA0..0xA9 analog commands (src/lib/kb/via/keychron/catalog.generated.ts).
pub const KEYCHRON_HE: [(u16, u16); ${KEYCHRON_HE_IDS.length}] = [${pairs(KEYCHRON_HE_IDS)}];
/// Keyboards illumipc.com's configurator drives, on its collection FF1B:0091 (src/lib/illumipc/ids.ts): the X68 HE / illumipc driver's own checked channel in hid.rs, not a brands.rs channel.
pub const ILLUMIPC: [(u16, u16); ${ILLUMIPC_USB_IDS.length}] = [${pairs(ILLUMIPC_USB_IDS)}];
/// Razer analog keyboards (src/lib/brands/razer/devices.ts RAZER_FEATURE_ONLY_PIDS that are keyboards).
pub const RAZER_KEYBOARDS: [u16; ${razerKb.length}] = [${razerKb.map(hex).join(", ")}];
/// Razer mice the Razer brand driver knows (same channel and guard); opened by the bridge, not listed yet.
pub const RAZER_BRAND_MICE: [u16; ${razerMice.length}] = [${razerMice.map(hex).join(", ")}];
/// Razer key ids a keyboard command may name (src/lib/brands/razer/devices.ts RAZER_VALID_KEY_IDS).
pub const RAZER_VALID_KEYS: [u8; ${keys.length}] = [${keys.join(", ")}];
/// Bytech-based boards whose depth AnalogSense reads with one fixed request (report 9).
pub const BYTECH: [(u16, u16); ${bytech.length}] = [${pairs(bytech)}];
/// That request, all ${req.length} bytes (src/lib/kb/analogsense/protocol.ts bytechRequest).
pub const BYTECH_REQUEST: [u8; ${req.length}] = [${req.join(", ")}];

// ---- Wave 3a: ASUS (rules in src/lib/brands/asus/asus-rules.json) and Corsair
${list("ASUS_BOOTLOADER", "ASUS Gear Link bootloader PIDs (src/lib/brands/asus/devices.ts ASUS_BOOTLOADER_PIDS).", asusBoot)}${list("CORSAIR_BRAGI_KEYBOARDS", "Corsair Bragi keyboards and receivers on FF42:0001 (src/lib/brands/corsair/devices.ts).", bragiKb)}${list("CORSAIR_BRAGI_MICE", "Corsair Bragi mice on FF42:0001 (opened, not listed: no mouse panel yet).", bragiMice)}${list("CORSAIR_SABRE", "Corsair Sabre v2 mice: EEPROM protocol on FF02:0002, report 8, 16 bytes.", sabre)}${list("CORSAIR_BRAGI_V1", "Corsair ids on Bragi 1.0 framing (the rest are 1.5).", bragiV1)}${list("CORSAIR_FAMILY_KB", "Corsair family kb.", corsairFamily("kb"))}${list("CORSAIR_FAMILY_KB_HE", "Corsair family kb-he.", corsairFamily("kb-he"))}${list("CORSAIR_FAMILY_RECEIVER", "Corsair family receiver.", corsairFamily("receiver"))}
// ---- Wave 4: Corsair iCUE BRAGI (lighting only), Logitech G keyboards, SteelSeries
${list("ICUE_KEYBOARDS", "Corsair iCUE keyboards (src/lib/brands/corsair-icue/devices.ts).", icueKb)}${list("ICUE_MICE", "Corsair iCUE mice (opened, not listed).", icueM)}${list("LOGITECH_KEYBOARDS", "Logitech G keyboards over HID++ 2.0 (src/lib/brands/logitech-kb/devices.ts).", logi)}${list("STEELSERIES", "SteelSeries Apex keyboards SYNQ drives (src/lib/brands/steelseries/devices.ts STEELSERIES_BRIDGE).", ssPids)}${list("STEELSERIES_BOOTLOADER", "SteelSeries bootloader PIDs (each model's PID + 1).", ssBoot)}${list("SS_LEGACY", "SteelSeries family legacy.", ssFamily("legacy"))}${list("SS_SINGLE", "SteelSeries family single.", ssFamily("single"))}${list("SS_RX", "SteelSeries family wireless-rx.", ssFamily("wireless-rx"))}${list("SS_USB", "SteelSeries family wireless-usb.", ssFamily("wireless-usb"))}
/// Wave 3a / 4 keyboards a registered keyboard driver claims: only these are shown in the device list
/// (asus/keyboard.ts claimsAsusKeyboard, corsair/keyboard.ts claimsCorsairKeyboard, every Logitech G and
/// driven SteelSeries id). The rest of those brands' tables is opened only for a driver, never listed.
pub const LISTED_KEYBOARDS: [(u16, u16); ${listed.length}] = [${pairs(listed)}];
`;
}

/** The SteelSeries guard's model-derived scope (scopeFor(MODELS)), for brands.rs to interpret. */
export function steelseriesScopeText(): string {
  const s = scopeFor(SS_MODELS);
  const fams = ["legacy", "single", "wireless-rx", "wireless-usb"] as const;
  const out = Object.fromEntries(
    fams.map((f) => [
      f,
      {
        caps: [...(s.caps.get(f) ?? [])].sort(),
        pairs: [...(s.pairs.get(f) ?? [])].map((p) => p.split(",").map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
        keyLists: s.keyLists.get(f) ?? [],
        leds: [...(s.leds.get(f) ?? [])].sort((a, b) => a - b),
      },
    ]),
  );
  return JSON.stringify(out) + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/src/brand_ids.rs");
  writeFileSync(out, brandIdsText());
  const scope = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/src/steelseries-scope.json");
  writeFileSync(scope, steelseriesScopeText());
  console.log(`wrote ${out} and ${scope}`);
}
