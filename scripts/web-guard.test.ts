// The website has no Rust bridge, so the TypeScript guard in front of the real WebHID device
// (src/lib/web/guard.ts, src/lib/web/proxy.ts) is its last line of defence. This proves it refuses what
// the Rust bridge refuses, by running the very frame fixtures the Rust tests use through a guarded
// proxy over a simulated device, and expecting the same verdicts:
//   node --test scripts/web-guard.test.ts
//
//  - the id tables and the brand channel table are the Rust ones (generated from, and compared with, them);
//  - VIA / Vial, ATK X1, X68 HE, Sonix, MonsGeek, DrunkDeer, Bytech, Razer, ASUS, Corsair (Bragi and
//    Sabre), iCUE, Logitech G and SteelSeries frames: same accept / refuse as brands.rs and hid.rs;
//  - no Advanced scope is ever granted on the website: a frame that needs a token is refused;
//  - firmware-update (bootloader) ids and product strings: nothing is sent, nothing is opened;
//  - collections the desktop never lists stay hidden; the unrouted paths the desktop refuses are refused;
//  - availability rules, the browser store (backup, download, restore) and the chooser filters;
//  - nothing under src/ sends to the real device except the proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { GuardRefusal, analogRawReadAllowed, type CollectionShape } from "../src/lib/web/guard.ts";
import { GuardedHidDevice, type RawHidDevice, type RawInputEvent } from "../src/lib/web/proxy.ts";
import * as policy from "../src/lib/web/policy.ts";
import * as ids from "../src/lib/web/ids.generated.ts";
import { availability, openFailureHint, supportsExclusionFilters } from "../src/lib/web/availability.ts";
import { helperOffered, parsePlatform, type Platform } from "../src/lib/web/platform.ts";
import { BUNDLE_FORMAT, MAX_RESTORE_BYTES, createWebStore, memoryKv } from "../src/lib/web/store.ts";
import { webIdsText } from "./gen-web-ids.ts";
import { BOOTLOADER_IDS } from "../src/lib/bootloader-ids.ts";
import { PAD_BOOT, PAD_ROWS } from "../src/lib/controllers/ids.generated.ts";
import { EXAMPLE_FEATURE_MAP } from "../src/lib/brands/logitech-kb/guard.ts";
import { viaFetcher } from "../src/lib/web/via-fetch.ts";
import { checkKeychronFrame } from "../src/lib/kb/via/keychron/guard.ts";
import { checkViaFrame } from "../src/lib/kb/via/guard.ts";
import { ASUS_FAMILY } from "../src/lib/web/ids.generated.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = (p: string) => readFileSync(join(root, p), "utf8");
const lines = (p: string) => text(p).split("\n").filter((l) => l.trim() !== "");

// ---------------------------------------------------------------------------------------------
// A simulated WebHID device and helpers
// ---------------------------------------------------------------------------------------------

type Sent = { kind: "output" | "feature"; reportId: number; data: number[] };

class SimRaw implements RawHidDevice {
  opened = false;
  sent: Sent[] = [];
  #listeners = new Set<(e: RawInputEvent) => void>();
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: readonly CollectionShape[];
  constructor(vendorId: number, productId: number, productName: string, collections: readonly CollectionShape[]) {
    this.vendorId = vendorId;
    this.productId = productId;
    this.productName = productName;
    this.collections = collections;
  }
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async sendReport(reportId: number, data: BufferSource) {
    this.sent.push({ kind: "output", reportId, data: [...new Uint8Array(data as ArrayBuffer)] });
  }
  async sendFeatureReport(reportId: number, data: BufferSource) {
    this.sent.push({ kind: "feature", reportId, data: [...new Uint8Array(data as ArrayBuffer)] });
  }
  async receiveFeatureReport() {
    return new DataView(new ArrayBuffer(8));
  }
  addEventListener(_t: "inputreport", l: (e: RawInputEvent) => void) {
    this.#listeners.add(l);
  }
  removeEventListener(_t: "inputreport", l: (e: RawInputEvent) => void) {
    this.#listeners.delete(l);
  }
  /** The device answers: an input report arrives. */
  emit(reportId: number, bytes: number[]) {
    const data = new DataView(Uint8Array.from(bytes).buffer);
    for (const l of [...this.#listeners]) l({ reportId, data });
  }
}

const col = (usagePage: number, usage: number, outputIds: number[] = [0], size = 8, count = 63): CollectionShape => ({
  usagePage,
  usage,
  outputReports: outputIds.map((reportId) => ({ reportId, items: [{ reportSize: size, reportCount: count }] })),
});
/** The typing / pointing / consumer collections a keyboard also has (the browser strips most of their reports). */
const TYPING = [col(0x0001, 0x0006, []), col(0x0001, 0x0002, []), col(0x000c, 0x0001, []), col(0x0007, 0x0000, [])];

async function wrap(vid: number, pid: number, name: string, cols: CollectionShape[]) {
  const raw = new SimRaw(vid, pid, name, cols);
  const dev = await GuardedHidDevice.wrap(raw);
  return { raw, dev };
}

/** True when the proxy let the call through (and the device got exactly those bytes), false when the guard refused it. */
async function went(raw: SimRaw, call: () => Promise<unknown>): Promise<boolean> {
  const before = raw.sent.length;
  try {
    await call();
  } catch (e) {
    assert.ok(e instanceof GuardRefusal, `a refusal is a GuardRefusal, got ${String(e)}`);
    assert.equal(raw.sent.length, before, "a refused report never reaches the device");
    return false;
  }
  assert.equal(raw.sent.length, before + 1, "an allowed report reaches the device once");
  return true;
}


/** Counts of the verdicts a fixture test judged, so a fixture can't pass by being all one kind (as brands.rs `tally`). */
const seen = { ok: 0, no: 0 };
async function judged(raw: SimRaw, call: () => Promise<unknown>, want: boolean, msg: string): Promise<boolean> {
  const ok = await went(raw, call);
  assert.equal(ok, want, msg);
  if (ok) seen.ok++;
  else seen.no++;
  return ok;
}
/** The fixture had both allowed and refused frames, at least `min` of them. */
function mixed(name: string, min: number): void {
  const { ok, no } = seen;
  seen.ok = seen.no = 0;
  assert.ok(ok + no >= min && ok > 0 && no > 0, `${name}: ${ok + no} frames (${ok} allowed, ${no} refused)`);
}

const unhex = (hex: string): number[] => {
  const h = hex.length % 2 ? hex + "0" : hex;
  return Array.from({ length: h.length / 2 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));
};
const padTo = (bytes: number[], len: number): Uint8Array => {
  const out = new Uint8Array(len);
  out.set(bytes.slice(0, len));
  return out;
};
/** `-` (no grant) or scopes joined by `+`. */
const noGrant = (spec: string) => spec === "-";

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

test("the id tables are generated from the Rust bridge's own tables", () => {
  assert.equal(readFileSync(join(root, "src/lib/web/ids.generated.ts"), "utf8"), webIdsText(), "run: node scripts/gen-web-ids.ts");
});

test("the brand channel table is brands.rs CHANNELS, row for row", () => {
  const rs = text("src-tauri/src/brands.rs");
  const body = rs.slice(rs.indexOf("pub const CHANNELS"), rs.indexOf("/// An id OpenMouse's own table names"));
  const rows = [...body.matchAll(/Channel \{ brand: "([^"]+)", kind: "(\w+)", ids: (\w+), collections: &\[([^\]]*)\], takes: (\w+(?:::\w+)?), report_ids: &\[([^\]]*)\], feature_size: (\d+), guard: ([\w:()]+)/g)];
  assert.equal(rows.length, policy.CHANNELS.length, "same number of channels");
  const takes: Record<string, policy.Takes> = { OUT: "output", FEAT: "feature", "Takes::Both": "both" };
  const guard: Record<string, policy.GuardKind> = {
    "Guard::Advanced(sonix_with)": "sonix",
    "Guard::Simple(monsgeek)": "monsgeek",
    "Guard::Simple(drunkdeer)": "drunkdeer",
    "Guard::Fw19f5(FwFamily::Mchose)": "fw19f5-mchose",
    "Guard::Fw19f5(FwFamily::DrunkDeer)": "fw19f5-drunkdeer",
    "Guard::Fw19f5(FwFamily::ReadOnly)": "fw19f5-readonly",
    "Guard::Simple(rk_beiying)": "rk-beiying",
    "Guard::Simple(sparklink)": "sparklink",
    "Guard::Simple(bytech)": "bytech",
    "Guard::Simple(razer)": "razer",
    "Guard::Asus": "asus",
    "Guard::Bragi": "bragi",
    "Guard::Sabre": "sabre",
    "Guard::Icue": "icue",
    "Guard::LogitechKb": "logitech-kb",
    "Guard::SteelSeries": "steelseries",
    "Guard::Headset(0x1038)": "headset",
    "Guard::Headset(0x046d)": "headset",
    "Guard::Headset(0x03f0)": "headset",
  };
  rows.forEach((m, i) => {
    const c = policy.CHANNELS[i];
    const cols = [...m[4].matchAll(/\((0x[0-9a-f]+), (None|Some\((0x[0-9a-f]+)\))\)/g)].map((x) => [parseInt(x[1], 16), x[3] ? parseInt(x[3], 16) : null]);
    assert.deepEqual(
      { brand: c.brand, kind: c.kind, collections: c.collections, takes: c.takes, reportIds: c.reportIds, featureSize: c.featureSize, guard: c.guard },
      { brand: m[1], kind: m[2], collections: cols, takes: takes[m[5]], reportIds: m[6].split(",").filter((s) => s.trim()).map((s) => parseInt(s.trim(), 0)), featureSize: Number(m[7]), guard: guard[m[8]] },
      `channel ${i} (${m[1]})`,
    );
  });
});

test("no id belongs to two channels; bootloaders, the Falchion and OpenMouse's pinned ids belong to none", () => {
  const all: [number, number][] = [
    ...ids.SONIX, ...ids.MONSGEEK, ...ids.DRUNKDEER, ...ids.DRUNKDEER_X60, ...ids.BYTECH,
    ...ids.FW19F5_MCHOSE, ...ids.FW19F5_DRUNKDEER, ...ids.FW19F5_NUPHY, ...ids.FW19F5_RK_GCOME, ...ids.RK_BEIYING, ...ids.SPARKLINK,
    ...ids.RAZER_KEYBOARDS.map((p): [number, number] => [0x1532, p]),
    ...ids.RAZER_BRAND_MICE.map((p): [number, number] => [0x1532, p]),
    ...Object.keys(ids.ASUS_FAMILY).map((p): [number, number] => [0x0b05, Number(p)]),
    ...ids.ASUS_BOOTLOADER.map((p): [number, number] => [0x0b05, p]),
    ...[...ids.CORSAIR_BRAGI_KEYBOARDS, ...ids.CORSAIR_BRAGI_MICE, ...ids.CORSAIR_SABRE, ...ids.ICUE_KEYBOARDS, ...ids.ICUE_MICE].map((p): [number, number] => [0x1b1c, p]),
    ...ids.LOGITECH_KEYBOARDS.map((p): [number, number] => [0x046d, p]),
    ...[...ids.STEELSERIES, ...ids.STEELSERIES_BOOTLOADER].map((p): [number, number] => [0x1038, p]),
  ];
  for (const [v, p] of all) assert.ok(policy.CHANNELS.filter((c) => c.ids(v, p)).length <= 1, `${v.toString(16)}:${p.toString(16)}`);
  for (const p of ids.ASUS_BOOTLOADER) assert.equal(policy.brandDevice(0x0b05, p), null, `ASUS bootloader ${p.toString(16)}`);
  for (const p of ids.STEELSERIES_BOOTLOADER) assert.equal(policy.brandDevice(0x1038, p), null, `SteelSeries bootloader ${p.toString(16)}`);
  assert.equal(policy.brandDevice(0x0b05, 0x1d1d), null, "the Falchion ZywOo keeps its own panel");
  assert.equal(policy.brandDevice(0x0b05, 0x1b7e)?.brand, "ASUS");
  assert.equal(policy.brandDevice(0x1b1c, 0x1bc0)?.brand, "Corsair iCUE");
  for (const [v, p] of ids.OPENMOUSE_FILTERS) if (p !== null) assert.equal(policy.brandDevice(v, p), null, `OpenMouse pins ${v.toString(16)}:${p.toString(16)}`);
  assert.equal(policy.brandDevice(0x05ac, 0x024f), null, "Apple's id is left out");
  assert.equal(policy.brandDevice(0x0c45, 0x636b), null, "a Sonix webcam id isn't a keyboard");
  assert.ok(policy.x60Name("DrunkDeer X60") && policy.x60Name("X60 HE") && !policy.x60Name("Gaming Keyboard"));
});

// ---------------------------------------------------------------------------------------------
// Which collections and devices (hid.rs tests, ported)
// ---------------------------------------------------------------------------------------------

test("typing, pointing and consumer collections stay closed on every keyboard SYNQ reaches", () => {
  const typing: [number, number][] = [[0x0001, 0x0006], [0x0001, 0x0002], [0x0001, 0x0080], [0x0001, 0x0001], [0x0007, 0x0000], [0x0007, 0x0006], [0x000c, 0x0001], [0x000d, 0x0001]];
  for (const [v, p, page, usage] of ids.KEYBOARD_FILTERS) {
    assert.ok(policy.allowed(v, p));
    assert.equal(policy.collectionAccess(v, p, page, usage), "full");
    assert.ok(policy.usable(v, p, "Keyboard", page, usage));
    for (const [tp, tu] of typing) assert.equal(policy.collectionAccess(v, p, tp, tu), null, `${v.toString(16)}:${p.toString(16)} ${tp.toString(16)}:${tu.toString(16)}`);
  }
  // An unknown vendor's VIA board: only the raw-HID collection.
  assert.equal(policy.collectionAccess(0x4653, 0x0001, 0xff60, 0x61), "full");
  for (const [tp, tu] of typing) assert.equal(policy.collectionAccess(0x4653, 0x0001, tp, tu), null);
  assert.equal(policy.collectionAccess(0x4653, 0x0001, 0xff61, 0x61), null);
});

test("only the X1's and the X68 HE's configuration channels are open; the Falchion keeps its whole panel", () => {
  assert.equal(policy.collectionAccess(0x373b, 0x1278, 0xff02, 0x0002), "full");
  for (const [page, usage] of [[0x0001, 0x0002], [0x0001, 0x0006], [0x000c, 0x0001], [0xff00, 0x0001], [0xff01, 0x0001]]) assert.equal(policy.collectionAccess(0x373b, 0x1278, page, usage), null, `${page}:${usage}`);
  assert.equal(policy.collectionAccess(0x2e3c, 0xc365, 0xff1b, 0x0091), "full");
  for (const [page, usage] of [[0x0001, 0x0006], [0x000c, 0x0001], [0xff60, 0x0061], [0xff00, 0x0001]]) assert.equal(policy.collectionAccess(0x2e3c, 0xc365, page, usage), null, `${page}:${usage}`);
  assert.equal(policy.collectionAccess(0x0b05, 0x1d1d, 0xff00, 0x0001), "full");
  // The other ids illumipc's configurator drives: the gamepad-mode personalities of the same firmware and Redragon's Winbond id.
  for (const [v, p] of [[0x2e3c, 0xc366], [0x2e3c, 0xc367], [0x2e3c, 0xc368], [0x0416, 0x7372]]) {
    assert.equal(policy.allowed(v, p), true, `${v.toString(16)}:${p.toString(16)}`);
    assert.equal(policy.collectionAccess(v, p, 0xff1b, 0x0091), "full");
    for (const [page, usage] of [[0x0001, 0x0006], [0x000c, 0x0001], [0xff60, 0x0061], [0xff00, 0x0001]]) assert.equal(policy.collectionAccess(v, p, page, usage), null, `${v.toString(16)}:${p.toString(16)} ${page}:${usage}`);
  }
  // Another id on the same vendors is nobody's.
  assert.equal(policy.allowed(0x2e3c, 0x7500), false);
  assert.equal(policy.allowed(0x0416, 0x7500), false);
  assert.equal(policy.collectionAccess(0x2e3c, 0x7500, 0xff1b, 0x0091), null, "the config channel opens for the listed ids only");
  assert.equal(policy.collectionAccess(0x0416, 0xb23c, 0xff1b, 0x0091), null);
});

test("Razer mice take their mouse / consumer collection for feature reports only, for the ids OpenMouse's driver uses", () => {
  const pid = ids.RAZER_FEATURE_ONLY_PIDS[0];
  const hit = [[0x0001, 0x0002], [0x000c, 0x0001]].filter(([a, b]) => policy.razerFeatureOnly(0x1532, pid, a, b));
  assert.ok(hit.length >= 1, "at least one of the two collections is named by OpenMouse's filter");
  for (const [a, b] of hit) assert.equal(policy.collectionAccess(0x1532, pid, a, b), "feature");
  assert.equal(policy.razerFeatureOnly(0x1532, pid, 0x0001, 0x0006), false, "never the keyboard collection");
  assert.equal(policy.razerFeatureOnly(0x046d, pid, 0x0001, 0x0002), false, "only Razer's vendor id");
  assert.equal(policy.razerFeatureOnly(0x1532, 0x0001, 0x0001, 0x0002), false, "only the listed ids");
});

test("wooting analog collections are read-only: nothing is ever sent to them", async () => {
  assert.equal(policy.collectionAccess(0x31e3, 0x1322, 0xff53, 0x0001), "input");
  const { raw, dev } = await wrap(0x31e3, 0x1322, "Wooting 60HE+", [col(0xff53, 0x0001, [0]), col(0xff54, 0x0001, [0])]);
  assert.equal(await went(raw, () => dev.sendReportTo(0xff53, 0x0001, 0, new Uint8Array(32))), false);
  assert.equal(await went(raw, () => dev.sendReport(0, new Uint8Array(32))), false, "no writer collection at all");
});

// ---------------------------------------------------------------------------------------------
// The device list (devices.rs tests, ported)
// ---------------------------------------------------------------------------------------------

const cols = (...list: [number, number][]) => list.map(([usagePage, usage]) => ({ usagePage, usage }));

test("keyboards and bootloaders are classified as the desktop list does", () => {
  const typing: [number, number][] = [[0x0001, 0x0006], [0x000c, 0x0001], [0x0001, 0x0002]];
  const c = policy.classifyDevice;
  const via = c(0x4653, 0x0001, cols(typing[0], typing[1], [0xff60, 0x0061]), "Some 65%")!;
  assert.deepEqual([via.kind, via.generic, via.kb, via.qmk, via.bootloader], ["keyboard", true, "qmk", true, false]);
  assert.equal(c(0x4653, 0x0001, cols(...typing), "Some 65%"), null, "without its raw-HID collection it is nothing SYNQ shows");
  const wuque = c(0x1ca6, 0x1b10, cols(typing[0], [0xffb0, 0x0001]), "BABAO60 HE")!;
  assert.deepEqual([wuque.kind, wuque.kb], ["keyboard", "omkb"]);
  const pulsar = c(0x3710, 0x5405, cols([0xff00, 0x0001], [0xff60, 0x0061]), "Pulsar 8K Dongle")!;
  assert.deepEqual([pulsar.kind, pulsar.generic, pulsar.kb, pulsar.qmk], ["mouse", true, undefined, true]);
  const egg = c(0x3367, 0x1977, cols([0xff01, 0x0001]), "Bootloader")!;
  assert.deepEqual([egg.kind, egg.generic, egg.bootloader], ["mouse", false, true]);
  const byName = c(0x3367, 0x1978, cols([0xff01, 0x0001]), "Bootloader")!;
  assert.ok(byName.bootloader && !byName.generic);
  const fm = c(0x361d, 0x0201, cols([0xff00, 0x0001]), null)!;
  assert.deepEqual([fm.kind, fm.bootloader], ["keyboard", true]);
  assert.equal(c(0x1234, 0x5678, cols([0xff00, 0x0001]), "Bootloader"), null, "an unknown device that calls itself a bootloader isn't shown");
  const falchion = c(0x0b05, 0x1d1d, cols([0xff00, 0x0001], typing[0]), null)!;
  assert.deepEqual([falchion.kind, falchion.generic, falchion.name], ["keyboard", false, "ROG Falchion Ace HFX ZywOo"]);
  assert.equal(c(0x0b05, 0x19af, cols([0xff72, 0x00a1], [0xff60, 0x0061]), null), null, "the Aura controller is never listed");
  const x1 = c(0x373b, 0x1278, cols([0xff02, 0x0002]), "Wireless mouse 8k dongle-L")!;
  assert.deepEqual([x1.kind, x1.generic], ["mouse", false]);
  assert.equal(c(0x2e3c, 0xc365, cols([0xff1b, 0x0091]), "X68HE")!.name, "MAGIC-REFINER X68 HE");
});

test("brand keyboards are listed by their channel", () => {
  const typing: [number, number][] = [[0x0001, 0x0006], [0x000c, 0x0001]];
  const c = policy.classifyDevice;
  assert.equal(c(0x41e4, 0x2101, cols(typing[0], [0x0001, 0x0000]), "MCHOSE Ace 60")!.kb, "brand", "the 0x19F5 family is listed by its usage-0 collection");
  assert.equal(c(0x41e4, 0x2101, cols(...typing), null), null, "the typing collections alone are not it");
  assert.equal(c(0x19f5, 0x6120, cols(typing[0], [0x0001, 0x0000]), "NuPhy Air75 HE")!.kb, "brand");
  assert.deepEqual([c(0x19f5, 0x6f10, cols([0xff00, 0x0001]), "NuPhy Air75 HE")!.bootloader, c(0x19f5, 0xaf12, cols([0xff00, 0x0001]), null)!.kind], [true, "keyboard"], "an upgrader is only a note");
  assert.deepEqual([c(0x0c45, 0x8030, cols(typing[0], [0xff68, 0x0061]), "Fighting68 HE")!.generic, c(0x0c45, 0x8030, cols(typing[0], [0xff68, 0x0061]), "Fighting68 HE")!.kb], [true, "brand"]);
  assert.equal(c(0x0c45, 0x8030, cols(...typing), null), null, "no channel, not listed");
  assert.equal(c(0x3151, 0x5030, cols([0xffff, 0x0002], typing[0]), "MonsGeek M1 V5")!.kb, "brand");
  assert.equal(c(0x352d, 0x2383, cols([0xff00, 0x0000]), "DrunkDeer A75")!.kb, "brand");
  assert.equal(c(0x1a81, 0x2094, cols([0xff00, 0x0000]), "Generic Keyboard"), null, "X60 id without its name");
  assert.ok(c(0x1a81, 0x2094, cols([0xff00, 0x0000]), "DrunkDeer X60"));
  assert.equal(c(0x1532, 0x02ea, cols([0x000c, 0x0001]), "Razer Huntsman V3 Pro TKL")!.kb, "brand");
  assert.equal(c(0x1532, 0xb005, cols([0x000c, 0x0001]), null), null, "brand mice are opened, not listed yet");
  assert.equal(c(0x372e, 0x105b, cols([0xff00, 0x0001]), "K709")!.kb, "brand", "not a Bytech mouse candidate");
  assert.equal(c(0x0b05, 0x1b7e, cols(typing[0], [0xff00, 0x0001], [0xff13, 0x0001]), "ROG Falchion Ace HFX")!.kb, "brand");
  assert.equal(c(0x1b1c, 0x2b0e, cols(typing[0], [0xff42, 0x0001], [0xff42, 0x0002]), "K70 PRO TKL")!.kb, "brand");
  assert.equal(c(0x1b1c, 0x2b0e, cols(typing[0], [0xff42, 0x0002]), null), null, "only the key-press collection: not listed");
  assert.equal(c(0x1b1c, 0x1bc0, cols([0xff42, 0x0001]), "K70 MAX"), null, "iCUE: no keyboard driver yet, so not listed");
  assert.equal(c(0x1b1c, 0x2b0c, cols([0xff42, 0x0001]), null), null, "a non-HE Bragi board: no driver claims it");
  assert.ok(c(0x0b05, 0x1c10, cols([0xff00, 0x0001]), null), "an ASUS HE board the driver claims");
  const g515 = c(0x046d, 0xc339, cols(typing[0], [0xff00, 0x0002]), "G515")!;
  assert.deepEqual([g515.kind, g515.kb], ["keyboard", "brand"]);
  const dex = c(0x046d, 0xc0a0, cols([0xff00, 0x0002]), null)!;
  assert.deepEqual([dex.kind, dex.generic], ["mouse", false]);
  assert.equal(c(0x1038, 0x1642, cols(typing[0], [0xffc0, 0x0001]), "Apex Pro")!.kb, "brand");
  const boot = c(0x1038, 0x1643, cols([0xffc0, 0x0001]), null)!;
  assert.deepEqual([boot.bootloader, boot.kind], [true, "keyboard"], "an Apex in update mode is only a note");
});

// ---------------------------------------------------------------------------------------------
// The frame fixtures, through the guarded proxy
// ---------------------------------------------------------------------------------------------

/** A VIA / Vial board from a vendor SYNQ doesn't otherwise know. */
const viaBoard = () => wrap(0x4653, 0x0001, "Some 65%", [...TYPING, col(0xff60, 0x0061, [0], 8, 32)]);

test("VIA / Vial: the default fixture, frame for frame, through sendReportTo", async () => {
  const { raw, dev } = await viaBoard();
  let n = 0;
  for (const line of lines("src-tauri/src/via-frames.txt")) {
    const [verdict, hex] = [line.split(" ")[0], line.split(" ")[1] ?? ""];
    const f = padTo(unhex(hex), 32);
    await judged(raw, () => dev.sendReportTo(0xff60, 0x0061, 0, f), verdict === "1", `frame ${hex}`);
    n++;
  }
  assert.ok(n > 1000, String(n));
  mixed("via", 1000);
  assert.equal(await went(raw, () => dev.sendReportTo(0xff60, 0x0061, 1, padTo([1], 32))), false, "QMK raw HID has no report ids");
  assert.equal(await went(raw, () => dev.sendReport(0, padTo([1], 32))), false, "never through the unrouted path (the bridge refuses it too)");
  assert.equal(await went(raw, () => dev.sendFeatureReport(0, padTo([1], 32))), false, "no feature report to a raw-HID board");
  assert.equal(await went(raw, () => dev.sendReportTo(0x0001, 0x0006, 0, padTo([1], 32))), false, "the keyboard collection is closed");
});

/** Advanced fixtures: with no grant the web matches Rust; with a grant it still never goes further than the fixture. */
async function advancedFixture(file: string, send: (f: Uint8Array) => Promise<boolean>, lenOf: (hex: string) => number, min: number) {
  let none = 0;
  let granted = 0;
  for (const line of lines(file)) {
    const [spec, verdict, hex = ""] = line.split(" ");
    const f = padTo(unhex(hex), lenOf(hex));
    const ok = await send(f);
    if (noGrant(spec)) {
      assert.equal(ok, verdict === "1", `no grant, frame ${hex}`);
      none++;
    } else {
      // The website never grants a scope: a frame the fixture only allows under a grant must be refused.
      if (ok) assert.equal(verdict, "1", `grants ${spec}: the website allowed a frame the bridge blocks even with the grant: ${hex}`);
      granted++;
    }
  }
  assert.ok(none + granted > min, `${none + granted} frames`);
  assert.ok(granted > 100, `${granted} frames with a grant`);
  return { none, granted };
}

test("VIA / Vial with Advanced fixtures: nothing that needs a token is ever sent", async () => {
  const { raw, dev } = await viaBoard();
  await advancedFixture("src-tauri/src/via-frames-advanced.txt", (f) => went(raw, () => dev.sendReportTo(0xff60, 0x0061, 0, f)), (hex) => (hex.length > 64 ? 64 : 32), 5000);
  // The explicit ones: remap above the basic range, macro write, both resets.
  const v = (...b: number[]) => padTo(b, 32);
  for (const f of [v(0x05, 0, 0, 0, 0x52, 0x21), v(0x05, 0, 0, 0, 0x77, 0x00), v(0x06), v(0x0f, 0, 0, 2, 0x41, 0x42), v(0x10), v(0x0b), v(0x0a), v(0x13), v(0x03)])
    assert.equal(await went(raw, () => dev.sendReportTo(0xff60, 0x0061, 0, f)), false, `${f[0].toString(16)}`);
  assert.equal(await went(raw, () => dev.sendReportTo(0xff60, 0x0061, 0, v(0x05, 0, 0, 0, 0x00, 0xff))), true, "basic keys still pass");
});

test("a Keychron / Madlions depth read passes the raw-HID path; a board AnalogSense doesn't list never gets it", async () => {
  let checked = 0;
  for (const line of lines("src/lib/kb/analogsense/analogsense-frames.txt")) {
    const [verdict, family, report, len, hex = ""] = line.split(/\s+/);
    const ident = family === "keychron" ? [0x3434, 0x0b10] : family === "madlions" ? [0x373b, 0x1053] : null;
    if (!ident) continue;
    const { raw, dev } = await wrap(ident[0], ident[1], "Analog board", [...TYPING, col(0xff60, 0x0061, [0], 8, 32)]);
    const frame = padTo(unhex(hex), Number(len));
    const ok = report === "0" && (await went(raw, () => dev.sendReportTo(0xff60, 0x0061, 0, frame)));
    // The raw-HID path takes a depth read, or any frame that is also a checked VIA frame (as the bridge's `via_frame_allowed || analog_raw_read_allowed`).
    const asVia = report === "0" && frame.length === 32 && checkViaFrame(frame).ok;
    // ...or, on a Keychron Hall-effect id (3434:0B10 is one), a frame of the Keychron tier (hid.rs `keychron_he_frame_allowed`).
    const asKeychron = family === "keychron" && report === "0" && frame.length === 32 && checkKeychronFrame(frame).ok;
    assert.equal(ok, verdict === "1" || asVia || asKeychron, `${family} ${report} ${hex}`);
    checked++;
  }
  assert.ok(checked > 100, String(checked));
  const kc = padTo([0xa9, 0x31], 32);
  const other = await wrap(0x3434, 0x0281, "Keychron", [col(0xff60, 0x0061, [0], 8, 32)]);
  assert.equal(await went(other.raw, () => other.dev.sendReportTo(0xff60, 0x0061, 0, kc)), false, "a Keychron board AnalogSense doesn't list");
  const madlions = await wrap(0x373b, 0x1053, "Madlions", [col(0xff60, 0x0061, [0], 8, 32)]);
  assert.equal(await went(madlions.raw, () => madlions.dev.sendReportTo(0xff60, 0x0061, 0, kc)), false, "Madlions doesn't take Keychron's read");
  const calib = padTo([0xa9, 0x40], 32);
  const kb = await wrap(0x3434, 0x0b10, "Keychron Q1 HE", [col(0xff60, 0x0061, [0], 8, 32)]);
  assert.equal(await went(kb.raw, () => kb.dev.sendReportTo(0xff60, 0x0061, 0, calib)), false, "0xA9 0x40 is calibration");
});

test("ATK X1: every report passes the ATK check; pairing, reset and button rows need a token the website never has", async () => {
  const { raw, dev } = await wrap(0x373b, 0x1278, "Wireless mouse 8k dongle-L", [col(0xff02, 0x0002, [8], 8, 15)]);
  await advancedFixture("src-tauri/src/atk-frames.txt", (f) => went(raw, () => dev.sendReport(8, f)), () => 16, 5000);
  // Report id and length are the X1's.
  assert.equal(await went(raw, () => dev.sendReport(9, new Uint8Array(16))), false);
  assert.equal(await went(raw, () => dev.sendReport(8, new Uint8Array(15))), false);
  assert.equal(await went(raw, () => dev.sendFeatureReport(0, new Uint8Array(16))), false, "never a feature report to the X1");
  assert.equal(await went(raw, () => dev.sendReportTo(0xff02, 0x0002, 8, new Uint8Array(16))), false, "an all-zero frame is nobody's command");
  const atk = (cmd: number, body: number[]) => {
    const f = new Uint8Array(16);
    f[0] = cmd;
    f.set(body, 1);
    let sum = 0x08;
    for (let i = 0; i < 15; i++) sum += f[i];
    f[15] = (0x55 - (sum & 0xff)) & 0xff;
    return f;
  };
  for (const [what, f] of [["pair", atk(0x05, [0, 0, 0, 2, 1, 61])], ["pair result", atk(0x06, [])], ["restore factory", atk(0x09, [])], ["button row", atk(0x07, [0, 0, 0x64, 4, 1, 2, 0, 0x52])], ["firmware", atk(0x01, [])], ["bootloader", atk(0x0d, [])], ["bank switch", atk(0x0f, [])]] as const) {
    assert.equal(await went(raw, () => dev.sendReport(8, f)), false, what);
    assert.equal(await went(raw, () => dev.sendReportTo(0xff02, 0x0002, 8, f)), false, `${what} (routed)`);
  }
  assert.equal(await went(raw, () => dev.sendReport(8, atk(0x08, [0, 0, 0, 2]))), true, "an EEPROM read is what the service sends");
});

test("X68 HE: ~4400 frames match the bridge; the unrouted paths are refused; nothing outside FF1B:0091 report 1", async () => {
  const { raw, dev } = await wrap(0x2e3c, 0xc365, "X68HE", [col(0xff1b, 0x0091, [1], 8, 63), ...TYPING]);
  let n = 0;
  for (const line of lines("src-tauri/src/x68-frames.txt")) {
    const [verdict, hex = ""] = line.split(" ");
    const f = padTo(unhex(hex), 63);
    await judged(raw, () => dev.sendReportTo(0xff1b, 0x0091, 1, f), verdict === "1", `frame ${hex}`);
    assert.equal(await went(raw, () => dev.sendReport(1, f)), false, "an unrouted output report is refused for the X68 HE");
    assert.equal(await went(raw, () => dev.sendFeatureReport(1, f)), false, "…and so is a feature report");
    n++;
  }
  assert.ok(n > 3000, String(n));
  mixed("x68", 3000);
  const read = padTo([0x01], 63);
  assert.equal(await went(raw, () => dev.sendReportTo(0xff1b, 0x0091, 2, read)), false, "report 1 only");
  assert.equal(await went(raw, () => dev.sendReportTo(0x0001, 0x0006, 1, read)), false, "the keyboard collection");
  assert.equal(await went(raw, () => dev.sendReportTo(0xff1b, 0x0091, 1, padTo([0x01], 64))), false, "63-byte frames");
  for (const f of [padTo([0x0b], 63), padTo([0x14, 0x02], 63), padTo([0x23], 63), padTo([0x21, 0, 0, 0, 0, 0x07], 63)])
    assert.equal(await went(raw, () => dev.sendReportTo(0xff1b, 0x0091, 1, f)), false, `bootloader / reset / calibration ${f[0].toString(16)}`);
  await assert.rejects(() => dev.receiveFeatureReport(1), GuardRefusal);
});

test("Sonix HE (FCC): ~6700 frames match the bridge; calibration and factory reset need a token", async () => {
  const id = ids.SONIX[0];
  const { raw, dev } = await wrap(id[0], id[1], "Fighting68 HE", [...TYPING, col(0xff68, 0x0061, [0], 8, 64)]);
  let n = 0;
  for (const line of lines("src/lib/kb/fcc/fcc-frames.txt")) {
    const [verdict, hex = ""] = line.split(" ");
    await judged(raw, () => dev.sendReport(0, padTo(unhex(hex), 64)), verdict === "1", `frame ${hex}`);
    n++;
  }
  assert.ok(n > 6000, String(n));
  mixed("sonix", 6000);
  await advancedFixture("src-tauri/src/sonix-frames-advanced.txt", (f) => went(raw, () => dev.sendReport(0, f)), () => 64, 5000);
  const sx = (...b: number[]) => padTo([0xaa, ...b], 64);
  for (const f of [sx(0x64), sx(0x65), sx(0x0f, 0xff)]) assert.equal(await went(raw, () => dev.sendReport(0, f)), false, `${f[1].toString(16)} needs its grant`);
  assert.equal(await went(raw, () => dev.sendReport(1, sx(0x64))), false, "report 0 only");
  assert.equal(await went(raw, () => dev.sendFeatureReport(0, sx(0x64))), false, "output reports only");
});

test("MonsGeek: feature reports on report 0, 64 bytes, the bridge's verdicts; output reports are never sent", async () => {
  const id = ids.MONSGEEK[0];
  const { raw, dev } = await wrap(id[0], id[1], "MonsGeek M1 V5", [...TYPING, col(0xffff, 0x0002, [], 8, 64)]);
  let n = 0;
  for (const line of lines("src/lib/brands/monsgeek/monsgeek-frames.txt")) {
    const [verdict, hex = ""] = line.split(" ");
    const f = padTo(unhex(hex), 64);
    await judged(raw, () => dev.sendFeatureReport(0, f), verdict === "1", `frame ${hex}`);
    assert.equal(await went(raw, () => dev.sendReport(0, f)), false, "output reports are never sent to a feature-only channel");
    n++;
  }
  assert.ok(n > 3000, String(n));
  mixed("monsgeek", 3000);
  await assert.rejects(() => dev.sendFeatureReport(1, new Uint8Array(64)), GuardRefusal, "report 0 only");
});

test("DrunkDeer: report 4, 63 bytes; the X60 needs its name", async () => {
  const id = ids.DRUNKDEER[0];
  const { raw, dev } = await wrap(id[0], id[1], "DrunkDeer A75", [...TYPING, col(0xff00, 0x0000, [4], 8, 63)]);
  let n = 0;
  for (const line of lines("src/lib/brands/drunkdeer/drunkdeer-frames.txt")) {
    const [verdict, hex = ""] = line.split(" ");
    await judged(raw, () => dev.sendReport(4, padTo(unhex(hex), 63)), verdict === "1", `frame ${hex}`);
    n++;
  }
  assert.ok(n > 3000, String(n));
  mixed("drunkdeer", 3000);
  assert.equal(await went(raw, () => dev.sendReport(5, new Uint8Array(63))), false, "report 4 only");
  assert.equal(await went(raw, () => dev.sendFeatureReport(4, new Uint8Array(63))), false, "output reports only");
  const [xv, xp] = ids.DRUNKDEER_X60[0];
  const named = await wrap(xv, xp, "DrunkDeer X60", [col(0xff00, 0x0000, [4], 8, 63)]);
  const unnamed = await wrap(xv, xp, "Gaming Keyboard", [col(0xff00, 0x0000, [4], 8, 63)]);
  const depth = padTo([0xb6, 0x03, 0x01], 63);
  assert.equal(await went(named.raw, () => named.dev.sendReport(4, depth)), true, "the depth request");
  assert.equal(await went(unnamed.raw, () => unnamed.dev.sendReport(4, depth)), false, "the X60 id without its name is nobody's");
});

test("0x19F5 family: Generic Desktop usage 0, report 0, 64 bytes; each family's verdicts are the bridge's; the typing collections stay closed", async () => {
  const families = [
    { name: "MCHOSE", list: ids.FW19F5_MCHOSE, col: 0, productName: "MCHOSE Ace 60" },
    { name: "DrunkDeer", list: ids.FW19F5_DRUNKDEER, col: 1, productName: "DrunkDeer A75 Pro" },
    { name: "NuPhy", list: ids.FW19F5_NUPHY, col: 2, productName: "NuPhy Air75 HE" },
    { name: "Royal Kludge", list: ids.FW19F5_RK_GCOME, col: 2, productName: "RK K99" },
  ] as const;
  const fixture = lines("src/lib/brands/fw19f5/fw19f5-frames.txt");
  assert.ok(fixture.length >= 4000, String(fixture.length));
  for (const fam of families) {
    const [v, p] = fam.list[0];
    assert.equal(policy.brandDevice(v, p)?.brand, fam.name);
    const { raw, dev } = await wrap(v, p, fam.productName, [...TYPING, col(0x0001, 0x0000, [0], 8, 64)]);
    // Only the usage-0 collection is open; the board's keyboard, mouse, consumer and system-control ones are not.
    for (const [page, usage] of [[0x0001, 0x0006], [0x0001, 0x0002], [0x0001, 0x0080], [0x000c, 0x0001], [0x0007, 0x0000], [0xff00, 0x0001]]) assert.equal(policy.collectionAccess(v, p, page, usage), null, `${fam.name} ${page.toString(16)}:${usage.toString(16)}`);
    assert.equal(policy.collectionAccess(v, p, 0x0001, 0x0000), "full");
    assert.deepEqual(dev.collections.map((c) => [c.usagePage, c.usage]), [[0x0001, 0x0000]]);
    for (const line of fixture) {
      const [verdicts, hex = ""] = line.split(" ");
      await judged(raw, () => dev.sendReport(0, padTo(unhex(hex), 64)), verdicts[fam.col] === "1", `${fam.name} frame ${hex}`);
    }
    mixed(`fw19f5 ${fam.name}`, 4000);
    assert.equal(await went(raw, () => dev.sendReport(4, new Uint8Array(64))), false, "report 0 only");
    assert.equal(await went(raw, () => dev.sendFeatureReport(0, new Uint8Array(64))), false, "output reports only");
  }
  // NuPhy and Royal Kludge: the two reads and nothing else, whatever the frame.
  const nuphy = ids.FW19F5_NUPHY[0];
  const { raw, dev } = await wrap(nuphy[0], nuphy[1], "NuPhy Air75 HE", [col(0x0001, 0x0000, [0], 8, 64)]);
  const info = padTo([0x55, 0x03, 0x00, 0x38, 0x38], 64);
  assert.equal(await went(raw, () => dev.sendReport(0, info)), true, "the firmware read");
  const reset = padTo([0x55, 0xee, 0x00, 0x01 + 0xff, 0x01, 0, 0, 0, 0xff], 64);
  assert.equal(await went(raw, () => dev.sendReport(0, reset)), false, "never a reset");
  // An upgrader of the family is nobody's: not even an open.
  for (const pid of [0x6f10, 0xaf0f, 0x8a11, 0xfe00]) {
    const up = await wrap(0x19f5, pid, "Bootloader", [col(0x0001, 0x0000, [0], 8, 64), col(0xff00, 0x0001, [0], 8, 64)]);
    assert.equal(policy.brandDevice(0x19f5, pid), null);
    assert.deepEqual(up.dev.collections, []);
    assert.equal(await went(up.raw, () => up.dev.sendReport(0, info)), false, `19f5:${pid.toString(16)} gets nothing`);
  }
});

test("Royal Kludge BeiYing: feature report 0x0A on System Control, 64 bytes, the bridge's verdicts; nothing else is ever opened or sent", async () => {
  const [v, p] = ids.RK_BEIYING[0];
  assert.equal(policy.brandDevice(v, p)?.guard, "rk-beiying");
  const { raw, dev } = await wrap(v, p, "RK Keyboard", [...TYPING, col(0x0001, 0x0080, [], 8, 64), col(0xff00, 0x0001, [0], 8, 64)]);
  // Only System Control is open, and only for feature reports.
  assert.equal(policy.collectionAccess(v, p, 0x0001, 0x0080), "feature");
  for (const [page, usage] of [[0x0001, 0x0006], [0x0001, 0x0002], [0x0001, 0x0000], [0x000c, 0x0001], [0xff00, 0x0001]]) assert.equal(policy.collectionAccess(v, p, page, usage), null, `${page.toString(16)}:${usage.toString(16)}`);
  assert.deepEqual(dev.collections.map((c) => [c.usagePage, c.usage]), [[0x0001, 0x0080]]);
  let n = 0;
  for (const line of lines("src/lib/brands/rk-beiying/rk-beiying-frames.txt")) {
    const [verdict, hex = ""] = line.split(" ");
    const f = padTo(unhex(hex), 64);
    await judged(raw, () => dev.sendFeatureReport(0x0a, f), verdict === "1", `frame ${hex.slice(0, 40)}`);
    assert.equal(await went(raw, () => dev.sendReport(0, f)), false, "an output report is never sent to a feature-only channel");
    n++;
  }
  assert.ok(n > 4000, String(n));
  mixed("rk-beiying", 4000);
  assert.equal(await went(raw, () => dev.sendFeatureReport(0, new Uint8Array(64))), false, "report 0x0A only");
  assert.equal(await went(raw, () => dev.sendFeatureReport(0x0a, new Uint8Array(63))), false, "64 data bytes only");
  // Other SinoWealth boards on the same vendor id (a mouse, AULA's F75) are nobody's.
  for (const pid of [0x010c, 0x1006, 0x2011]) assert.equal(policy.brandDevice(0x258a, pid), null, `258a:${pid.toString(16)}`);
});

test("Keychron / Lemokey Hall-effect keyboards: VIA's raw-HID path takes the Keychron tier's frames, the bridge's verdicts; another Keychron id never does; VIA's own blocks stay", async () => {
  const fixture = lines("src/lib/kb/via/keychron/keychron-he-frames.txt");
  assert.ok(fixture.length >= 6000, String(fixture.length));
  assert.equal(ids.KEYCHRON_HE.length, 35);
  const [v, p] = [0x3434, 0x0b10];
  assert.ok(policy.keychronHe(v, p) && policy.keychronHe(0x362d, 0x0610) && !policy.keychronHe(0x3434, 0x0281));
  const { raw, dev } = await wrap(v, p, "Keychron Q1 HE", [...TYPING, col(0xff60, 0x0061, [0], 8, 32)]);
  for (const line of fixture) {
    const [verdict, hex = ""] = line.split(" ");
    const f = padTo(unhex(hex), 32);
    // A frame the VIA guard itself takes goes through too (as `via_frame_allowed || ... || keychron_he_frame_allowed`).
    const want = verdict === "1" || checkViaFrame(f).ok || analogRawReadAllowed(v, p, f);
    await judged(raw, () => dev.sendReportTo(0xff60, 0x0061, 0, f), want, `frame ${hex}`);
  }
  mixed("keychron-he", 6000);
  // A Keychron board that isn't Hall-effect gets VIA's own frames and nothing of the tier.
  const plain = await wrap(0x3434, 0x0281, "Keychron V1", [col(0xff60, 0x0061, [0], 8, 32)]);
  const set = padTo([0xa9, 0x14, 0, 2, 15, 3, 3, 0, 1], 32);
  assert.equal(await went(plain.raw, () => plain.dev.sendReportTo(0xff60, 0x0061, 0, set)), false, "a non-HE Keychron board");
  assert.equal(await went(raw, () => dev.sendReportTo(0xff60, 0x0061, 0, set)), true, "a Q1 HE");
  for (const never of [[0x0b], [0x0a], [0xaa], [0xab], [0xa7, 0x11], [0xa9, 0x1e, 0], [0xa9, 0x40, 1], [0x02, 0x03]]) assert.equal(await went(raw, () => dev.sendReportTo(0xff60, 0x0061, 0, padTo(never, 32))), false, `${never}`);
});

test("SparkLink: vendor collection 0xFFA0:0x0001, report 0, 64 bytes, the bridge's verdicts; the typing collections and every other page stay closed", async () => {
  const fixture = lines("src/lib/brands/sparklink/sparklink-frames.txt");
  assert.ok(fixture.length >= 9000, String(fixture.length));
  for (const [v, p] of [ids.SPARKLINK[0], ids.SPARKLINK[ids.SPARKLINK.length - 1]]) {
    assert.equal(policy.brandDevice(v, p)?.guard, "sparklink");
    const { raw, dev } = await wrap(v, p, "RK-C68", [...TYPING, col(0xffa0, 0x0001, [0], 8, 64), col(0xffa0, 0x0002, [0], 8, 64), col(0xff00, 0x0001, [0], 8, 64), col(0xffb0, 0x0001, [0], 8, 64)]);
    assert.equal(policy.collectionAccess(v, p, 0xffa0, 0x0001), "full");
    for (const [page, usage] of [[0x0001, 0x0006], [0x0001, 0x0002], [0x0001, 0x0080], [0x000c, 0x0001], [0xff00, 0x0001], [0xffa0, 0x0002], [0xffb0, 0x0001]]) assert.equal(policy.collectionAccess(v, p, page, usage), null, `${page.toString(16)}:${usage.toString(16)}`);
    assert.deepEqual(dev.collections.map((c) => [c.usagePage, c.usage]), [[0xffa0, 0x0001]]);
    for (const line of fixture) {
      const [verdict, hex = ""] = line.split(" ");
      await judged(raw, () => dev.sendReport(0, padTo(unhex(hex), 64)), verdict === "1", `frame ${hex}`);
    }
    mixed("sparklink", 9000);
    assert.equal(await went(raw, () => dev.sendReport(4, new Uint8Array(64))), false, "report 0 only");
    assert.equal(await went(raw, () => dev.sendFeatureReport(0, new Uint8Array(64))), false, "output reports only");
  }
  // Kochi's Hummingbird 68 is a SparkLink id: the brand channel takes it over from OpenMouse's keyboard filter, the same 64-byte rules apply.
  const kochi = await wrap(0x1ca2, 0x0901, "KOCHI68", [col(0xffa0, 0x0001, [0], 8, 64)]);
  assert.equal(policy.brandDevice(0x1ca2, 0x0901)?.guard, "sparklink");
  const name = padTo([0x5c, 3, 0, 0x35 + 0x5c + 3 + 0 + 0xff, 0x26, 0xff, 0xff], 64);
  assert.equal(await went(kochi.raw, () => kochi.dev.sendReport(0, name)), true, "the name read");
  const reset = padTo([0x5c, 3, 0, 0x35 + 0x5c + 3 + 0 + 0xff, 0x11, 0xff, 0xff], 64);
  assert.equal(await went(kochi.raw, () => kochi.dev.sendReport(0, reset)), false, "never the factory reset");
});

test("Bytech / Redragon and DrunkDeer depth requests pass; anything else is refused", async () => {
  const [bv, bp] = ids.BYTECH[0];
  let n = 0;
  for (const line of lines("src/lib/kb/analogsense/analogsense-frames.txt")) {
    const [verdict, family, report, len, hex = ""] = line.split(/\s+/);
    if (family === "bytech") {
      const { raw, dev } = await wrap(bv, bp, "K709", [col(0xff00, 0x0001, [9], 8, 63)]);
      await judged(raw, () => dev.sendReport(Number(report), padTo(unhex(hex), Number(len))), verdict === "1", `bytech ${hex}`);
      n++;
    } else if (family === "drunkdeer" && verdict === "1") {
      const id = ids.DRUNKDEER[0];
      const { raw, dev } = await wrap(id[0], id[1], "DrunkDeer A75", [col(0xff00, 0x0000, [4], 8, 63)]);
      assert.equal(await went(raw, () => dev.sendReport(Number(report), padTo(unhex(hex), Number(len)))), true, "the depth request must pass");
      n++;
    }
  }
  assert.ok(n >= 5, String(n));
  mixed("bytech / drunkdeer depth", 5);
});

test("Razer analog keyboards: feature report 0, 90 bytes, the bridge's verdicts; never an output report", async () => {
  const { raw, dev } = await wrap(0x1532, 0x02ea, "Razer Huntsman V3 Pro TKL", [...TYPING, col(0x000c, 0x0001, [], 8, 90)]);
  let n = 0;
  for (const line of lines("src/lib/brands/razer/razer-frames.txt")) {
    const [verdict, hex = ""] = line.split(" ");
    const f = padTo(unhex(hex), 90);
    await judged(raw, () => dev.sendFeatureReport(0, f), verdict === "1", `frame ${hex.slice(0, 40)}`);
    n++;
  }
  assert.ok(n > 5000, String(n));
  mixed("razer", 5000);
  assert.equal(await went(raw, () => dev.sendReport(0, new Uint8Array(90))), false, "no output report to a feature-only channel");
  assert.equal(await went(raw, () => dev.sendFeatureReport(1, new Uint8Array(90))), false, "report 0 only");
});

test("OpenMouse's Razer mice: the device-mode command is refused whatever asked for it", async () => {
  const pid = ids.RAZER_FEATURE_ONLY_PIDS.find((p) => policy.razerFeatureOnly(0x1532, p, 0x0001, 0x0002) || policy.razerFeatureOnly(0x1532, p, 0x000c, 0x0001))!;
  const [page, usage] = policy.razerFeatureOnly(0x1532, pid, 0x0001, 0x0002) ? [0x0001, 0x0002] : [0x000c, 0x0001];
  const { raw, dev } = await wrap(0x1532, pid, "Razer mouse", [col(page, usage, [], 8, 90)]);
  const frame = (cls: number, id: number, len = 90) => {
    const f = new Uint8Array(len);
    f[6] = cls;
    f[7] = id;
    return f;
  };
  assert.equal(await went(raw, () => dev.sendFeatureReport(0, frame(0x00, 0x04))), false, "set device mode");
  assert.equal(await went(raw, () => dev.sendFeatureReport(0, frame(0x00, 0x84))), false, "get device mode");
  assert.equal(await went(raw, () => dev.sendFeatureReport(0, frame(0x00, 0x81))), true, "another class 0 command");
  assert.equal(await went(raw, () => dev.sendFeatureReport(0, frame(0x04, 0x04))), true, "the same id in another class");
  assert.equal(await went(raw, () => dev.sendFeatureReport(1, frame(0x00, 0x81))), false, "report 0 only on a feature-only collection");
  assert.equal(await went(raw, () => dev.sendFeatureReport(0, frame(0x00, 0x81, 64))), false, "exactly 90 bytes");
  assert.equal(await went(raw, () => dev.sendReport(0, frame(0x00, 0x81))), false, "no output report is ever written to it");
});

test("ASUS Gear Link: the rule table's verdicts per product id; a bootloader id is nobody's", async () => {
  const stats = { checked: 0, outside: 0 };
  const devices = new Map<number, Awaited<ReturnType<typeof wrap>>>();
  for (const line of lines("src/lib/brands/asus/asus-frames.txt")) {
    const [verdict, pidHex, hex = ""] = line.split(/\s+/);
    const pid = parseInt(pidHex, 16);
    const channel = policy.brandDevice(0x0b05, pid);
    if (!channel) {
      // The Falchion ZywOo (its own panel, no frame table in the bridge either) and ids that are not a Gear Link channel.
      stats.outside++;
      continue;
    }
    const page = channel.kind === "mouse" ? [0xff01, 0x0001] : [0xff00, 0x0001];
    let d = devices.get(pid);
    if (!d) devices.set(pid, (d = await wrap(0x0b05, pid, "ASUS device", [...TYPING, col(page[0], page[1], [0, 2], 8, 63)])));
    await judged(d.raw, () => d.dev.sendReport(0, padTo(unhex(hex), 64)), verdict === "1", `asus ${pidHex} ${hex.slice(0, 30)}`);
    stats.checked++;
  }
  assert.ok(stats.checked > 4000, JSON.stringify(stats));
  mixed("asus", 4000);
  const d = [...devices.values()][0];
  assert.equal(await went(d.raw, () => d.dev.sendReport(1, new Uint8Array(64))), false, "report 0 / 2 only");
  assert.equal(await went(d.raw, () => d.dev.sendFeatureReport(0, new Uint8Array(64))), false, "output reports only");
  for (const pid of ids.ASUS_BOOTLOADER) {
    const b = await wrap(0x0b05, pid, "ASUS", [col(0xff00, 0x0001, [0], 8, 63)]);
    assert.equal(await went(b.raw, () => b.dev.sendReport(0, new Uint8Array(64))), false, `ASUS bootloader ${pid.toString(16)}`);
  }
  assert.ok(Object.keys(ASUS_FAMILY).length > 20);
});

test("Corsair Bragi and Sabre: the fixture, with the open file remembered like the bridge does", async () => {
  const bragi = { kb: ids.CORSAIR_BRAGI_KEYBOARDS, mouse: ids.CORSAIR_BRAGI_MICE };
  const { CORSAIR_MODELS } = await import("../src/lib/brands/corsair/devices.ts");
  const B = await import("../src/lib/brands/corsair/bragi.ts");
  const stats = { bragi: 0, sabre: 0 };
  for (const line of lines("src/lib/brands/corsair/corsair-frames.txt")) {
    const [verdict, pidHex, open, hex = ""] = line.split(/\s+/);
    const pid = parseInt(pidHex, 16);
    if (ids.CORSAIR_SABRE.includes(pid)) {
      const { raw, dev } = await wrap(0x1b1c, pid, "Corsair mouse", [col(0xff02, 0x0002, [8], 8, 16)]);
      await judged(raw, () => dev.sendReport(8, padTo(unhex(hex), 16)), verdict === "1", `sabre ${hex}`);
      stats.sabre++;
      continue;
    }
    assert.ok(bragi.kb.includes(pid) || bragi.mouse.includes(pid), pidHex);
    const { raw, dev } = await wrap(0x1b1c, pid, "Corsair", [col(0xff42, 0x0001, [0], 8, 64)]);
    if (open !== "-") {
      // Reach the state the fixture line is in the way the bridge does: by an allowed open-file frame.
      const m = CORSAIR_MODELS.get(pid)!;
      const o: import("../src/lib/brands/corsair/bragi.ts").FrameOpts = { framing: m.framing!, session: 0x5a, addr: m.family === "receiver" ? 1 : 0 };
      try {
        await dev.sendReport(0, B.encodeOpenFile(o, Number(open)));
      } catch (e) {
        assert.ok(e instanceof GuardRefusal, "an unopenable file leaves nothing open");
      }
    }
    await judged(raw, () => dev.sendReport(0, padTo(unhex(hex), 64)), verdict === "1", `bragi ${pidHex} open=${open} ${hex.slice(0, 30)}`);
    stats.bragi++;
  }
  assert.ok(stats.bragi > 1000 && stats.sabre > 100, JSON.stringify(stats));
  mixed("corsair", 1000);
});

test("Corsair Bragi: a data write needs an open profile file, and identity files are never opened", async () => {
  const B = await import("../src/lib/brands/corsair/bragi.ts");
  const { CORSAIR_MODELS } = await import("../src/lib/brands/corsair/devices.ts");
  const pid = 0x2b0e;
  const m = CORSAIR_MODELS.get(pid)!;
  const o: import("../src/lib/brands/corsair/bragi.ts").FrameOpts = { framing: m.framing!, session: 0x5a, addr: 0 };
  const { raw, dev } = await wrap(0x1b1c, pid, "K70 PRO TKL", [col(0xff42, 0x0001, [0], 8, 64)]);
  const [write] = B.encodeWriteFile(o, new Uint8Array(8));
  assert.equal(await went(raw, () => dev.sendReport(0, write)), false, "no file open");
  assert.equal(await went(raw, () => dev.sendReport(0, B.encodeOpenFile(o, 0x0f))), true, "open the readable file 15");
  assert.equal(await went(raw, () => dev.sendReport(0, write)), false, "file 15 isn't a profile file");
  assert.equal(await went(raw, () => dev.sendReport(0, B.encodeUnbindBuffer(o))), true);
  assert.equal(await went(raw, () => dev.sendReport(0, B.encodeOpenFile(o, 28100))), true, "a profile file");
  assert.equal(await went(raw, () => dev.sendReport(0, write)), true, "profile file open");
  assert.equal(await went(raw, () => dev.sendReport(0, B.encodeUnbindBuffer(o))), true);
  assert.equal(await went(raw, () => dev.sendReport(0, write)), false, "closed again");
  assert.equal(await went(raw, () => dev.sendReport(0, B.encodeOpenFile(o, 31000))), false, "identity files are never opened");
});

test("Corsair iCUE: the fixture, report id included", async () => {
  const pid = ids.ICUE_KEYBOARDS[0];
  const { raw, dev } = await wrap(0x1b1c, pid, "K70", [col(0xff42, 0x0001, [0], 8, 64)]);
  let n = 0;
  for (const line of lines("src/lib/brands/corsair-icue/corsair-icue-frames.txt")) {
    const [verdict, hex] = [line.split(" ")[0], line.split(" ")[1]];
    const bytes = unhex(hex);
    await judged(raw, () => dev.sendReport(bytes[0], padTo(bytes.slice(1), 64)), verdict === "1", `icue ${hex.slice(0, 30)}`);
    n++;
  }
  assert.ok(n >= 100, String(n));
  mixed("icue", 100);
});

test("Logitech G keyboards: HID++ frames, with feature indexes learned from the device's own IRoot replies", async () => {
  const { raw, dev } = await wrap(0x046d, 0xc339, "G515", [...TYPING, col(0xff00, 0x0002, [0x10, 0x11, 0x12], 8, 19)]);
  const send = (reportId: number, data: number[]) => dev.sendReport(reportId, Uint8Array.from(data));
  const lenOf = (id: number) => (id === 0x10 ? 6 : id === 0x11 ? 19 : 63);
  // Teach the guard EXAMPLE_FEATURE_MAP the way a real keyboard would: ask IRoot, hear the index.
  await dev.open();
  for (const [index, feature] of EXAMPLE_FEATURE_MAP) {
    const ask = padTo([0xff, 0x00, 0x0a, feature >> 8, feature & 0xff, 0x00], 6);
    assert.equal(await went(raw, () => dev.sendReport(0x10, ask)), true, `getFeature ${feature.toString(16)}`);
    raw.emit(0x11, [0xff, 0x00, 0x0a, index, 0, 0, ...new Array(13).fill(0)]);
  }
  let n = 0;
  for (const line of lines("src/lib/brands/logitech-kb/logitech-kb-frames.txt")) {
    const [verdict, hex] = [line.split(" ")[0], line.split(" ")[1]];
    const bytes = unhex(hex);
    const len = [0x10, 0x11, 0x12].includes(bytes[0]) ? lenOf(bytes[0]) : bytes.length - 1;
    await judged(raw, () => send(bytes[0], [...padTo(bytes.slice(1), len)]), verdict === "1", `logitech ${hex.slice(0, 30)}`);
    n++;
  }
  assert.ok(n > 300, String(n));
  mixed("logitech", 300);
});

test("Logitech G keyboards: an index is trusted only after the device's reply, and a reply naming DFU keeps it blocked", async () => {
  const { raw, dev } = await wrap(0x046d, 0xc339, "G515", [col(0xff00, 0x0002, [0x10, 0x11, 0x12], 8, 19)]);
  await dev.open();
  const setRate = [0xff, 0x04, 0x2a, 0x01, 0x00, 0x00];
  assert.equal(await went(raw, () => dev.sendReport(0x10, Uint8Array.from(setRate))), false, "index 4 not resolved yet");
  assert.equal(await went(raw, () => dev.sendReport(0x10, Uint8Array.from([0xff, 0x00, 0x0a, 0x80, 0x60, 0x00]))), true, "getFeature(0x8060)");
  raw.emit(0x11, [0xff, 0x00, 0x0a, 0x04, ...new Array(15).fill(0)]);
  assert.equal(await went(raw, () => dev.sendReport(0x10, Uint8Array.from(setRate))), true, "report rate write once resolved");
  assert.equal(await went(raw, () => dev.sendReport(0x10, Uint8Array.from([0xff, 0x00, 0x0b, 0x00, 0xd0, 0x00]))), true, "asking about DFU is a query");
  raw.emit(0x11, [0xff, 0x00, 0x0b, 0x09, ...new Array(15).fill(0)]);
  assert.equal(await went(raw, () => dev.sendReport(0x10, Uint8Array.from([0xff, 0x09, 0x1b, 0, 0, 0]))), false, "DFU stays blocked");
  raw.emit(0x11, [0xff, 0x00, 0x0c, 0x0a, ...new Array(15).fill(0)]);
  assert.equal(await went(raw, () => dev.sendReport(0x10, Uint8Array.from([0xff, 0x0a, 0x2c, 0, 0, 0]))), false, "an unsolicited reply teaches nothing");
});

test("SteelSeries Apex: the union fixture; every model refuses what is blocked, some model takes what is allowed", async () => {
  const devices = await Promise.all(
    ids.STEELSERIES.map((pid) => wrap(0x1038, pid, "Apex", [...TYPING, col(0xffc0, 0x0001, [0], 8, 64)])),
  );
  const shape = (d: number[]): ["output" | "feature", number] => {
    const [op, d1] = [d[0] ?? 0, d[1] ?? 0];
    if (op === 0x38 && (d1 === 0x66 || d1 === 0x67)) return ["output", 64];
    if ([0x31, 0x3a, 0x03, 0x83].includes(op)) return ["feature", 642];
    if ([0x38, 0x40, 0x36, 0xb6].includes(op)) return ["feature", 644];
    if ([0x6f, 0x76, 0x77, 0x61, 0x2f, 0x37, 0x21, 0x54, 0x43, 0x4a, 0x4c, 0x0a].includes(op)) return ["feature", 641];
    return ["output", 64];
  };
  let n = 0;
  for (const line of lines("src/lib/brands/steelseries/steelseries-frames.txt")) {
    const [verdict, hex = ""] = line.split(" ");
    const bytes = unhex(hex);
    assert.equal(bytes[0] ?? 0, 0, "report id byte");
    const d = bytes.slice(1);
    const [kind, len] = shape(d);
    const f = padTo(d, len);
    let anyOk = false;
    for (const { raw, dev } of devices) {
      const ok = await went(raw, () => (kind === "output" ? dev.sendReport(0, f) : dev.sendFeatureReport(0, f)));
      if (verdict !== "1") assert.equal(ok, false, `steelseries must refuse ${hex.slice(0, 40)} on every model`);
      anyOk ||= ok;
    }
    if (verdict === "1") assert.ok(anyOk, `steelseries should accept ${hex.slice(0, 40)} on some model`);
    n++;
  }
  assert.ok(n > 2000, String(n));
  const one = devices[0];
  assert.equal(await went(one.raw, () => one.dev.sendReport(1, new Uint8Array(64))), false, "report 0 only");
});

// ---------------------------------------------------------------------------------------------
// Firmware-update mode, collections, and the paths the bridge refuses
// ---------------------------------------------------------------------------------------------

test("a device in firmware-update mode gets nothing: not a report of any kind, not even an open", async () => {
  for (const b of BOOTLOADER_IDS) {
    const { raw, dev } = await wrap(b.vid, b.pid, "Device", [col(0xff00, 0x0001, [0, 2, 4, 8, 9], 8, 63), col(0xff60, 0x0061, [0], 8, 32)]);
    assert.equal(await went(raw, () => dev.sendReport(0, new Uint8Array(64))), false, `${b.what} output`);
    assert.equal(await went(raw, () => dev.sendFeatureReport(0, new Uint8Array(64))), false, `${b.what} feature`);
    assert.equal(await went(raw, () => dev.sendReportTo(0xff60, 0x0061, 0, new Uint8Array(32))), false, `${b.what} routed`);
    await assert.rejects(() => dev.open(), GuardRefusal, `${b.what} open`);
    await assert.rejects(() => dev.receiveFeatureReport(0), GuardRefusal, `${b.what} read`);
    assert.equal(dev.guard.usable, false);
    assert.equal(raw.opened, false);
  }
  // A whole range (NuPhy's upgrader ids, Atmel DFU) and a name only a device in update mode reports.
  for (const [v, p] of [[0x19f5, 0xaf10], [0x03eb, 0x2ff4]] as const) {
    const { raw, dev } = await wrap(v, p, "Keyboard", [col(0xff60, 0x0061, [0], 8, 32)]);
    assert.equal(await went(raw, () => dev.sendReportTo(0xff60, 0x0061, 0, padTo([1], 32))), false, `${v.toString(16)}:${p.toString(16)}`);
  }
  for (const name of ["STM32 DFU", "Foo Bootloader", "Boot Device", "Firmware Update Mode"]) {
    const { raw, dev } = await wrap(0x4653, 0x0001, name, [col(0xff60, 0x0061, [0], 8, 32)]);
    assert.equal(await went(raw, () => dev.sendReportTo(0xff60, 0x0061, 0, padTo([1], 32))), false, name);
    assert.equal(dev.guard.usable, false, name);
  }
  const reboot = await wrap(0x4653, 0x0001, "Reboot Keyboard", [col(0xff60, 0x0061, [0], 8, 32)]);
  assert.equal(await went(reboot.raw, () => reboot.dev.sendReportTo(0xff60, 0x0061, 0, padTo([1], 32))), true, "'Reboot' is a name, not an update mode");
});

test("the proxy lists only the collections SYNQ may use, and the unrouted paths the bridge refuses stay refused", async () => {
  const { raw, dev } = await viaBoard();
  assert.deepEqual(dev.collections.map((c) => [c.usagePage, c.usage]), [[0xff60, 0x0061]], "no typing, pointing or consumer collection");
  assert.equal(raw.collections.length, 5, "the real device has them");
  // Logitech's own mouse keeps every collection (the hand-built path), an X68 only its channel.
  const x = await wrap(0x2e3c, 0xc365, "X68HE", [col(0xff1b, 0x0091, [1], 8, 63), ...TYPING]);
  assert.deepEqual(x.dev.collections.map((c) => [c.usagePage, c.usage]), [[0xff1b, 0x0091]]);
  const dex = await wrap(0x046d, 0xc0a0, "PRO X 2 DEX", [col(0xff00, 0x0002, [0x10, 0x11], 8, 19)]);
  assert.equal(dex.dev.collections.length, 1);
  // A brand device: only its channel.
  const sonix = await wrap(ids.SONIX[0][0], ids.SONIX[0][1], "Fighting68 HE", [...TYPING, col(0xff68, 0x0061, [0], 8, 64), col(0xff00, 0x0001, [0], 8, 64)]);
  assert.deepEqual(sonix.dev.collections.map((c) => [c.usagePage, c.usage]), [[0xff68, 0x0061]], "not even a vendor page an OpenMouse filter might name");
});

test("input reports reach the driver through the proxy, with the proxy as event.device", async () => {
  const { raw, dev } = await wrap(0x373b, 0x1278, "Wireless mouse 8k dongle-L", [col(0xff02, 0x0002, [8], 8, 15)]);
  const heard: number[][] = [];
  dev.addEventListener("inputreport", (e) => {
    assert.equal(e.device, dev);
    heard.push([e.reportId, ...new Uint8Array(e.data.buffer)]);
  });
  await dev.open();
  raw.emit(8, [1, 2, 3]);
  assert.deepEqual(heard, [[8, 1, 2, 3]]);
  await dev.close();
  raw.emit(8, [9]);
  assert.equal(heard.length, 1, "closed: no more");
});

test("the bytes that were checked are the bytes that were sent", async () => {
  const { raw, dev } = await viaBoard();
  const f = padTo([0x01], 32);
  const p = dev.sendReportTo(0xff60, 0x0061, 0, f);
  f[0] = 0x0b; // swapped after the check, before the device saw it
  await p;
  assert.equal(raw.sent[0].data[0], 0x01);
});

// ---------------------------------------------------------------------------------------------
// Availability, platform, chooser, store, host
// ---------------------------------------------------------------------------------------------

const UA = {
  win153: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  win152: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  edge153: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0",
  opera: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 OPR/118.0.0.0",
  mac153: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  linux153: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  chromeos: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
  safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
};

test("the platform comes out of the user agent", () => {
  const p = (ua: string): Platform => parsePlatform(ua);
  assert.deepEqual(p(UA.win153), { os: "windows", browser: "chrome", chromium: 153 });
  assert.deepEqual(p(UA.edge153), { os: "windows", browser: "edge", chromium: 153 });
  assert.deepEqual(p(UA.opera), { os: "windows", browser: "opera", chromium: 153 });
  assert.deepEqual(p(UA.mac153), { os: "mac", browser: "chrome", chromium: 153 });
  assert.deepEqual(p(UA.linux153), { os: "linux", browser: "chrome", chromium: 153 });
  assert.deepEqual(p(UA.chromeos), { os: "chromeos", browser: "chrome", chromium: 153 });
  assert.deepEqual(p(UA.firefox), { os: "windows", browser: "firefox", chromium: null });
  assert.deepEqual(p(UA.safari), { os: "mac", browser: "safari", chromium: null });
});

test("a browser without WebHID is offered SYNQ Helper where the helper exists (Windows, Linux)", () => {
  const firefoxLinux = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
  assert.equal(helperOffered(parsePlatform(UA.firefox)), true, "Firefox on Windows");
  assert.equal(helperOffered(parsePlatform(firefoxLinux)), true, "Firefox on Linux");
  assert.equal(helperOffered(parsePlatform(UA.win153)), true, "a Chromium with WebHID switched off (Brave sends Chrome's user agent)");
  assert.equal(helperOffered(parsePlatform(UA.safari)), false, "no Mac helper yet, and Safari refuses ws:// from https");
  assert.equal(helperOffered(parsePlatform(UA.mac153)), false);
  assert.equal(helperOffered(parsePlatform(UA.chromeos)), false);
});

test("availability: Razer needs the desktop app on Windows Chromium 153+ and nowhere else", () => {
  const razer = { vendorId: 0x1532, productId: 0x02ea };
  const other = { vendorId: 0x3434, productId: 0x0b10 };
  for (const ua of [UA.win153, UA.edge153, UA.opera]) {
    const a = availability(razer, parsePlatform(ua));
    assert.equal(a.status, "desktop", ua);
    assert.equal(a.code, "razer-windows-153");
    assert.match(a.message, /desktop app/);
    assert.match(a.title, /Install the helper to use this in the browser/);
    assert.equal(availability(razer, parsePlatform(ua), true).status, "ok", "SYNQ Helper connected: it reaches the channel");
  }
  assert.equal(availability(razer, parsePlatform(UA.win152)).status, "ok", "152 still exposes the channel");
  assert.equal(availability(razer, parsePlatform(UA.mac153)).status, "ok");
  assert.equal(availability(razer, parsePlatform(UA.linux153)).status, "ok");
  assert.equal(availability(razer, parsePlatform(UA.chromeos)).status, "ok");
  assert.equal(availability(other, parsePlatform(UA.win153)).status, "ok", "only Razer");
  // Royal Kludge's BeiYing keyboards sit on System Control, which every browser hides on every platform; the Gcome ones don't.
  const [rkv, rkp] = ids.RK_BEIYING[0];
  for (const ua of [UA.win153, UA.win152, UA.mac153, UA.linux153, UA.chromeos]) {
    const a = availability({ vendorId: rkv, productId: rkp }, parsePlatform(ua));
    assert.deepEqual([a.status, a.code], ["desktop", "rk-system-control"], ua);
    assert.match(a.message, /desktop app/);
    assert.equal(availability({ vendorId: rkv, productId: rkp }, parsePlatform(ua), true).status, "ok", "SYNQ Helper reaches it");
  }
  assert.equal(availability({ vendorId: 0x19f5, productId: ids.FW19F5_RK_GCOME[0][1] }, parsePlatform(UA.win153)).status, "ok", "the Gcome boards use a collection the browser keeps");
  assert.equal(availability({ vendorId: 0x258a, productId: 0x010c }, parsePlatform(UA.win153)).status, "ok", "another SinoWealth board isn't ours to judge");
  assert.equal(availability(razer, { os: "windows", browser: "chrome", chromium: null }).status, "ok", "an unknown version isn't guessed at");
  assert.match(openFailureHint(parsePlatform(UA.linux153)), /udev/);
  assert.match(openFailureHint(parsePlatform(UA.win153)), /Armoury Crate|Synapse/);
  assert.equal(supportsExclusionFilters(parsePlatform(UA.win153)), true);
  assert.equal(supportsExclusionFilters({ os: "windows", browser: "chrome", chromium: 90 }), false);
});

test("the chooser asks for every driver's channel, VIA's raw HID, and excludes firmware-update ids", () => {
  const { filters, exclusionFilters } = policy.chooserFilters();
  const has = (f: HIDDeviceFilter) => filters.some((x) => x.vendorId === f.vendorId && x.productId === f.productId && x.usagePage === f.usagePage && x.usage === f.usage);
  assert.ok(has({ usagePage: 0xff60, usage: 0x61 }), "VIA / Vial");
  assert.ok(has({ vendorId: 0x373b, productId: 0x1278, usagePage: 0xff02, usage: 0x0002 }), "ATK X1");
  assert.ok(has({ vendorId: 0x2e3c, productId: 0xc365, usagePage: 0xff1b, usage: 0x0091 }), "X68 HE");
  assert.ok(has({ vendorId: 0x0b05, productId: 0x1d1d, usagePage: 0xff00, usage: 0x0001 }), "Falchion");
  assert.ok(filters.some((f) => f.vendorId === 0x046d), "Logitech");
  for (const [v, p, page, u] of ids.OPENMOUSE_FILTERS) assert.ok(filters.some((f) => f.vendorId === v && (p === null ? f.productId === undefined : f.productId === p) && f.usagePage === (page ?? undefined) && f.usage === (u ?? undefined)), `OpenMouse ${v.toString(16)}`);
  for (const [v, p] of [...ids.SONIX, ...ids.MONSGEEK, ...ids.DRUNKDEER, ...ids.DRUNKDEER_X60, ...ids.BYTECH]) assert.ok(filters.some((f) => f.vendorId === v && f.productId === p), `brand ${v.toString(16)}:${p.toString(16)}`);
  for (const p of [...ids.CORSAIR_BRAGI_KEYBOARDS, ...ids.CORSAIR_SABRE, ...ids.ICUE_KEYBOARDS]) assert.ok(filters.some((f) => f.vendorId === 0x1b1c && f.productId === p), `corsair ${p.toString(16)}`);
  for (const p of ids.STEELSERIES) assert.ok(filters.some((f) => f.vendorId === 0x1038 && f.productId === p), `steelseries ${p.toString(16)}`);
  for (const p of Object.keys(ids.ASUS_FAMILY).map(Number)) if (policy.brandDevice(0x0b05, p)) assert.ok(filters.some((f) => f.vendorId === 0x0b05 && f.productId === p), `asus ${p.toString(16)}`);
  assert.equal(new Set(filters.map((f) => JSON.stringify(f))).size, filters.length, "no duplicate filter");
  assert.ok(!filters.some((f) => f.vendorId === 0x258a && f.usagePage === 0x0001), "a browser can't see System Control, so the chooser never asks for it");
  // Every bootloader identity is excluded; none is also asked for by id.
  for (const b of BOOTLOADER_IDS) assert.ok(exclusionFilters.some((f) => f.vendorId === b.vid && f.productId === b.pid), `exclude ${b.what}`);
  for (const p of ids.ASUS_BOOTLOADER) assert.ok(exclusionFilters.some((f) => f.vendorId === 0x0b05 && f.productId === p));
  for (const p of ids.STEELSERIES_BOOTLOADER) assert.ok(exclusionFilters.some((f) => f.vendorId === 0x1038 && f.productId === p));
  // Controllers: their gamepad collections are asked for, their boot and recovery ids excluded.
  assert.ok(has({ vendorId: 0x054c, usagePage: 0x0001, usage: 0x0005 }) && has({ vendorId: 0x057e, usagePage: 0x0001, usage: 0x0004 }), "Sony and Nintendo pads");
  for (const [v, p] of PAD_BOOT) assert.ok(exclusionFilters.some((f) => f.vendorId === v && f.productId === p), `exclude pad boot ${v.toString(16)}:${p.toString(16)}`);
  // GameSir's settings channel: per configurable id only (never the id a Cyclone shares with an idle 8K dongle).
  assert.ok(has({ vendorId: 0x3537, productId: 0x1053, usagePage: 0xfff0 }) && has({ vendorId: 0x3537, productId: 0x103d, usagePage: 0xfff0 }), "GameSir");
  assert.ok(!filters.some((f) => f.usagePage === 0xfff0 && (f.productId === undefined || [0x0575, 0x103c, 0x10b8].includes(f.productId))), "no GameSir filter without a configurable id");
  assert.ok(has({ vendorId: 0x2e95, productId: 0x434e, usagePage: 0xff42, usage: 0x0001 }) && has({ vendorId: 0x1b1c, productId: 0x3a08, usagePage: 0xff42, usage: 0x0001 }), "SCUF Envision BRAGI reads");
  assert.ok(has({ vendorId: 0x04b4, productId: 0x2412, usagePage: 0xffa0 }), "Flydigi D-input config channel");
  // No filter names a typing page without a product id (so the chooser can't list a plain keyboard).
  // (The 0x19F5 family's config collection is Generic Desktop with usage 0 and a product id: not a keyboard, mouse or system-control usage.)
  const fwIds = new Set([...ids.FW19F5_MCHOSE, ...ids.FW19F5_DRUNKDEER, ...ids.FW19F5_NUPHY, ...ids.FW19F5_RK_GCOME].map(([v, p]) => `${v}:${p}`));
  for (const f of filters)
    if (f.usagePage !== undefined && [0x0001, 0x0007].includes(f.usagePage)) {
      if (f.vendorId === 0x1532 && f.usage !== 0x0004 && f.usage !== 0x0005) continue;
      // A game controller's gamepad or joystick collection (src/lib/controllers/pads.ts): by vendor, never a typing or pointing usage.
      if (f.usagePage === 0x0001 && (f.usage === 0x0004 || f.usage === 0x0005)) {
        assert.ok(f.vendorId !== undefined && PAD_ROWS.some(([v, p, , t]) => v === f.vendorId && t === "hid" && !PAD_BOOT.some(([bv, bp]) => bv === v && bp === p)), `a gamepad filter for a vendor without HID pads: ${JSON.stringify(f)}`);
        continue;
      }
      assert.ok(f.usagePage === 0x0001 && f.usage === 0x0000 && f.productId !== undefined && fwIds.has(`${f.vendorId}:${f.productId}`), `only Razer's feature-only mouse collection and the 0x19F5 family's usage 0: ${JSON.stringify(f)}`);
    }
  for (const [v, p] of fwIds.size ? [...fwIds].map((x) => x.split(":").map(Number)) : []) assert.ok(has({ vendorId: v, productId: p, usagePage: 0x0001, usage: 0x0000 }), `0x19F5 family ${v.toString(16)}:${p.toString(16)}`);
});

test("the browser store: a backup is saved under a unique name, downloaded as a bundle and restored from a file", async () => {
  let t = Date.UTC(2026, 9, 14, 10, 15, 0);
  const kv = memoryKv();
  const s = createWebStore(kv, true, () => (t += 1000));
  const a = await s.saveBackup("mouse-razer-viper", JSON.stringify({ stages: [400, 800] }));
  const b = await s.saveBackup("mouse-razer-viper", JSON.stringify({ stages: [800] }));
  assert.match(a, /^browser storage: mouse-razer-viper-20261014-1015\d\d\.json$/);
  assert.notEqual(a, b);
  const list = await s.listBackups();
  assert.equal(list.length, 2);
  assert.ok(list[0].savedAt > list[1].savedAt, "newest first");
  assert.equal(JSON.parse((await s.readBackup(list[1].name))!).stages.length, 2);
  await s.saveState("keyboard-ZZ123", JSON.stringify({ version: 1 }));
  await s.log("log-mouse", ["one", "two"]);
  assert.equal(await s.readLog("log-mouse"), "one\ntwo");
  for (let i = 0; i < 5; i++) await s.log("log-mouse", Array.from({ length: 1000 }, (_, k) => `line ${i}-${k}`));
  assert.equal((await s.readLog("log-mouse")).split("\n").length, 2000, "a log is capped");

  const bundle = await s.exportAll();
  assert.equal(bundle.format, BUNDLE_FORMAT);
  assert.equal(bundle.backups.length, 2);
  assert.equal(bundle.states.length, 1);

  // Restore into a fresh browser.
  const other = createWebStore(memoryKv(), true, () => t++);
  assert.deepEqual(await other.restore("all.json", JSON.stringify(bundle)), { backups: 2, states: 1 });
  assert.equal((await other.listBackups()).length, 2);
  assert.equal(await other.loadState("keyboard-ZZ123"), JSON.stringify({ version: 1 }));
  // Restoring the same bundle again never overwrites: the names are made unique.
  await other.restore("all.json", JSON.stringify(bundle));
  assert.equal((await other.listBackups()).length, 4);
  // A single device backup file comes back under its own name.
  assert.deepEqual(await other.restore("My Backup.json", JSON.stringify({ savedAt: "x" })), { backups: 1, states: 0 });
  assert.ok((await other.listBackups()).some((x) => x.prefix === "my-backup"));
  await other.deleteBackup((await other.listBackups())[0].name);
  assert.equal((await other.listBackups()).length, 4);
  await assert.rejects(() => other.restore("x.json", "not json"), /isn't JSON/);
  await assert.rejects(() => other.restore("x.json", JSON.stringify({ format: BUNDLE_FORMAT, version: 9, backups: [], states: [] })), /version/);
  await assert.rejects(() => other.restore("x.json", "x".repeat(MAX_RESTORE_BYTES + 1)), /too big/);
});

test("VIA definitions: a simple GET with no preflight header, and a plain sentence when it can't be reached", async () => {
  const seen: RequestInit[] = [];
  let problem: string | null = "stale";
  const ok = viaFetcher((why) => (problem = why), async (_u, init) => (seen.push(init ?? {}), new Response("{}", { status: 200 })));
  await ok("https://usevia.app/definitions/v3/1.json", { cache: "no-cache", credentials: "omit" });
  assert.equal(seen[0].cache, "default", "no-cache would make the request conditional");
  assert.equal(seen[0].credentials, "omit");
  assert.equal(problem, null);
  const down = viaFetcher((why) => (problem = why), async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(() => down("https://usevia.app/x.json"), TypeError);
  assert.match(problem ?? "", /usevia\.app/);
  assert.match(problem ?? "", /offline|blocked/);
  const gone = viaFetcher((why) => (problem = why), async () => new Response("", { status: 404 }));
  await gone("https://usevia.app/y.json");
  assert.equal(problem, null, "a 404 is 'no definition', not a network problem");
});

// ---------------------------------------------------------------------------------------------
// The sources: no other path to the real device
// ---------------------------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

test("only the proxy sends to the real device; nothing else imports the raw device list or the chooser", () => {
  const files = walk(join(root, "src/lib/web"));
  for (const f of files) {
    const rel = relative(root, f).replace(/\\/g, "/");
    const src = readFileSync(f, "utf8");
    if (rel !== "src/lib/web/proxy.ts") assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /\.raw\.(sendReport|sendFeatureReport|receiveFeatureReport)\b/, `${rel} must not send to the raw device`);
  }
  // Outside src/lib/web only these may touch the raw list / chooser / real navigator.hid.
  const allowed = new Set(["src/lib/tauri-hid.ts"]);
  /** The UI pieces that may use one of the browser-level calls, and only that one. */
  const uiMay: Record<string, RegExp> = {
    "src/components/web/AddDevice.tsx": /\bpickDevices\b/g,
    "src/components/web/WebData.tsx": /\bforgetAllDevices\b/g,
    "src/components/web/WebNotes.tsx": /\bforgetDevice\b/g,
  };
  for (const f of walk(join(root, "src"))) {
    const rel = relative(root, f).replace(/\\/g, "/");
    if (rel.startsWith("src/lib/web/") || allowed.has(rel)) continue;
    let src = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
    if (uiMay[rel]) src = src.replace(uiMay[rel], "");
    assert.doesNotMatch(src, /\brawGranted\b|\bpickDevices\b|\bforgetAllDevices\b|\bforgetDevice\b|\.requestDevice\(\s*\{\s*filters:/, `${rel} reaches around the guard`);
  }
  // The chooser is reached only from the Add device button.
  const users = walk(join(root, "src")).filter((f) => /\bpickDevices\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(users.map((f) => relative(root, f).replace(/\\/g, "/")).sort(), ["src/components/web/AddDevice.tsx", "src/lib/web/hid.ts"].sort());
});

test("USB RGB hubs: the chooser asks for each one, and one is listed only on its vendor collection", () => {
  const { filters } = policy.chooserFilters();
  // NZXT and Corsair by id (their vendor page varies), the Lian Li Uni Hub SL on its own collection.
  assert.ok(filters.some((f) => f.vendorId === 0x1e71 && f.productId === 0x2001 && f.usagePage === undefined), "NZXT HUE 2");
  assert.ok(filters.some((f) => f.vendorId === 0x1b1c && f.productId === 0x0c10), "Corsair Commander Pro");
  assert.ok(filters.some((f) => f.vendorId === 0x0cf2 && f.productId === 0xa100 && f.usagePage === 0xff72 && f.usage === 0xa1), "Lian Li Uni Hub SL");
  assert.ok(!filters.some((f) => f.vendorId === 0x1b1c && f.productId === 0x0c57), "the Nautilus LCD Cap is never asked for (SYNQ sends it nothing)");
  assert.ok(filters.some((f) => f.vendorId === undefined && f.usagePage === 0x59 && f.usage === 0x01), "Dynamic Lighting: any LampArray collection");

  const vendor = [{ usagePage: 0xff00, usage: 0x0001 }];
  assert.equal(policy.classifyDevice(0x1e71, 0x2001, vendor, "NZXT HUE 2")?.kind, "rgbhub");
  assert.equal(policy.classifyDevice(0x1e71, 0x2001, [{ usagePage: 0x000c, usage: 0x0001 }], null), null, "no vendor collection: not listed");
  assert.equal(policy.classifyDevice(0x0cf2, 0xa100, vendor, null), null, "the Uni Hub SL only on its own collection");
  assert.equal(policy.classifyDevice(0x0cf2, 0xa100, [{ usagePage: 0xff72, usage: 0xa1 }], null)?.name, "Lian Li Uni Hub SL");
});

test("the website's hub transport checks every report with the hub guard, as the bridge does", () => {
  const src = readFileSync(join(root, "src/lib/web/hubs.ts"), "utf8");
  const write = src.slice(src.indexOf("export async function hubWrite"), src.indexOf("export async function hubRead"));
  assert.ok(write.indexOf("checkHubFrame") >= 0 && write.indexOf("checkHubFrame") < write.indexOf("sendReport"), "the guard runs before the report is sent");
  assert.ok(!/sendFeatureReport/.test(src), "hubs take output reports only");
});
