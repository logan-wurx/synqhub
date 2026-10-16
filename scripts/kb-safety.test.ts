// Checks the generic keyboard path and the device-safety rules without a device or a window:
//   node --test scripts/kb-safety.test.ts
//
//  - firmware-update (bootloader) ids: one table in TS and Rust; never claimed, opened or pinged;
//  - mice claimed by vendor id alone are shown only after a read-only identify;
//  - VIA / Vial against a simulated QMK keyboard: protocol, layout (usevia.app definition, cached;
//    Vial from the keyboard, xz), keymap, lighting, macros; writes are backed up, read back, saved;
//  - the blocked VIA / Vial commands never leave SYNQ, and the guard matches the Rust bridge's;
//  - @openmouse/keyboard-protocol: only allowlisted methods are reachable; the dangerous ones of
//    every real driver are refused; Wuque writes echo what they don't change and never calibrate;
//  - tiers: read-only groups refuse writes until changes are allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVICE_DRIVERS as KB_DRIVERS } from "@openmouse/keyboard-protocol/drivers";
import { BOOTLOADER_IDS, BOOTLOADER_RANGES, isBootloader } from "../src/lib/bootloader-ids.ts";
import { findDriver } from "../src/lib/openmouse/registry.ts";
import { claimMice, confirmMice, connectGeneric, pingGeneric, type GenericHost } from "../src/lib/openmouse/host.ts";
import { memoryStore } from "../src/lib/openmouse/store.ts";
import { checkViaFrame, MAX_WRITABLE_KEYCODE } from "../src/lib/kb/via/guard.ts";
import { SimViaKeyboard, sampleCompiledDefinition, sampleVialJson } from "../src/lib/kb/via/sim.ts";
import { VIAL_SAMPLE_XZ_HEX } from "../src/lib/kb/via/sim-vial.generated.ts";
import { xzDecompress } from "../src/lib/kb/via/xz.ts";
import { ViaTransport, hidChannel } from "../src/lib/kb/via/transport.ts";
import { ViaBackend } from "../src/lib/kb/via/backend.ts";
import { viaDriver } from "../src/lib/kb/via/driver.ts";
import { memoryDefinitionCache, vendorProductId, viaDefinitions } from "../src/lib/kb/via/definitions.ts";
import { optionBits, unpackOptions } from "../src/lib/kb/via/layout.ts";
import { KbSession, memoryKbStore } from "../src/lib/kb/session.ts";
import { claimKeyboard, connectKeyboard, pingKeyboard, type KbHost } from "../src/lib/kb/host.ts";
import { CORE_DRIVERS, driversFor } from "../src/lib/kb/registry.ts";
import { KB_READ_METHODS, KB_SETTING_METHODS, isKbAllowed, isKbBlocked } from "../src/lib/kb/openmouse/policy.ts";
import { OmkbBackend } from "../src/lib/kb/openmouse/backend.ts";
import { KB_DRIVER_INDEX } from "../src/lib/kb/openmouse/driver-index.generated.ts";
import { viaFixtureText } from "./via-guard-fixture.ts";
import { brandIdsText, steelseriesScopeText } from "./gen-brand-bridge.ts";
import { ASUS_BOOTLOADER_PIDS } from "../src/lib/brands/asus/devices.ts";
import { BOOTLOADER_PIDS as SS_BOOTLOADER_PIDS } from "../src/lib/brands/steelseries/devices.ts";
import { FW_IDS, FW_UPGRADER_ROWS } from "../src/lib/brands/fw19f5/devices.ts";
import { RK_IDS } from "../src/lib/brands/rk-beiying/devices.ts";
import { SPARKLINK_IDS } from "../src/lib/brands/sparklink/devices.ts";
import { KEYCHRON_HE_IDS } from "../src/lib/kb/via/keychron/devices.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hexBytes = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const frame = (...b: number[]) => {
  const f = new Uint8Array(32);
  f.set(b);
  return f;
};

// ---------------------------------------------------------------------------------------------
// Firmware-update mode
// ---------------------------------------------------------------------------------------------

test("the bootloader table is the same in TS and in the Rust bridge", () => {
  const rs = readFileSync(join(root, "src-tauri/src/hid.rs"), "utf8");
  const block = rs.slice(rs.indexOf("pub const BOOTLOADER_IDS"), rs.indexOf("];", rs.indexOf("pub const BOOTLOADER_IDS")));
  const rust = [...block.matchAll(/\(0x([0-9a-f]{4}), 0x([0-9a-f]{4})\)/g)].map((m) => `${m[1]}:${m[2]}`).sort();
  const ts = BOOTLOADER_IDS.map((b) => `${b.vid.toString(16).padStart(4, "0")}:${b.pid.toString(16).padStart(4, "0")}`).sort();
  assert.deepEqual(rust, ts);
  assert.equal(new Set(ts).size, ts.length, "no duplicates");
  const rblock = rs.slice(rs.indexOf("pub const BOOTLOADER_RANGES"), rs.indexOf("];", rs.indexOf("pub const BOOTLOADER_RANGES")));
  const rranges = [...rblock.matchAll(/\(0x([0-9a-f]{4}), 0x([0-9a-f]{4}), 0x([0-9a-f]{4})\)/g)].map((m) => `${m[1]}:${m[2]}-${m[3]}`).sort();
  const tranges = BOOTLOADER_RANGES.map((r) => `${r.vid.toString(16).padStart(4, "0")}:${r.from.toString(16).padStart(4, "0")}-${r.to.toString(16).padStart(4, "0")}`).sort();
  assert.deepEqual(rranges, tranges);
  for (const [v, p] of [[0x19f5, 0xaf00], [0x19f5, 0xaf3c], [0x03eb, 0x2ff4], [0x0483, 0xdf11]]) assert.ok(isBootloader(v, p), `${v.toString(16)}:${p.toString(16)}`);
  for (const [v, p] of [[0x19f5, 0x3245], [0x03eb, 0x2fef], [0x03eb, 0x2ffa]]) assert.ok(!isBootloader(v, p), `${v.toString(16)}:${p.toString(16)}`);
  // The brand drivers' own update-mode ids (ASUS Gear Link, SteelSeries PID + 1).
  for (const pid of ASUS_BOOTLOADER_PIDS) assert.ok(isBootloader(0x0b05, pid), `0b05:${pid.toString(16)}`);
  for (const pid of SS_BOOTLOADER_PIDS) assert.ok(isBootloader(0x1038, pid), `1038:${pid.toString(16)}`);
  // The 0x19F5 family's upgraders: the bootloader table's 0x19F5 rows are exactly the driver's explicit ones (AFxx rides the range).
  const fwRows = FW_UPGRADER_ROWS.map((u) => u.productId).sort((a, b) => a - b);
  assert.deepEqual(BOOTLOADER_IDS.filter((b) => b.vid === 0x19f5).map((b) => b.pid).sort((a, b) => a - b), fwRows);
  for (const [v, p] of FW_IDS) assert.ok(!isBootloader(v, p), `a claimed 0x19F5-family board is not a bootloader: ${v.toString(16)}:${p.toString(16)}`);
  // Every id the coordinator's research named.
  for (const id of ["3367:1977", "373e:b01c", "373e:b01d", "373e:b01e", "37b0:0002", "37b0:0004", "37b0:0006", "37b0:0008", "37b0:000a", "37b0:0012", "37b0:0018", "37b0:0033", "37b0:0041", "361d:0111", "361d:0201", "1fc9:0021", "1fc9:0022", "2e3c:af01", "0b05:1aaf", "0b05:1c11", "046d:ab24"])
    assert.ok(ts.includes(id), id);
  // By product string, whole words only (as hid.rs `bootloader_name`).
  for (const n of ["Bootloader", "STM32 DFU", "Boot Device", "OP1 8K BOOTLOADER"]) assert.ok(isBootloader(0x1234, 0x5678, n), n);
  for (const n of ["Reboot Pro", "DFUSE Mouse", "Bootstrap 65", "Pulsar 8K Dongle"]) assert.ok(!isBootloader(0x1234, 0x5678, n), n);
});

const fakeDevice = (vendorId: number, productId: number, productName: string, usagePage = 0xff00) =>
  ({ vendorId, productId, productName, opened: false, collections: [{ usagePage, usage: 1, type: 1, children: [], inputReports: [], outputReports: [], featureReports: [] }] }) as unknown as HIDDevice;

function mouseHost(devices: HIDDevice[], answers: (d: HIDDevice) => boolean, calls: string[]): GenericHost {
  return {
    live: false,
    store: memoryStore(),
    async devices() {
      return devices;
    },
    async match(device) {
      return {
        brand: "Test",
        cls: "TestHidClient",
        anyPid: device.vendorId === 0x3710,
        create: () => ({
          open: async () => calls.push(`open ${device.productId.toString(16)}`),
          close: async () => calls.push(`close ${device.productId.toString(16)}`),
          readStatus: async () => {
            calls.push(`readStatus ${device.productId.toString(16)}`);
            if (!answers(device)) throw new Error("timeout");
            return { brand: "Test", name: "Mouse", dpi: 800 };
          },
        }),
      };
    },
  };
}

test("a device in firmware-update mode is never claimed, opened or asked anything", async () => {
  const calls: string[] = [];
  const egg = fakeDevice(0x3367, 0x1977, "Bootloader");
  const named = fakeDevice(0x3367, 0x1978, "Bootloader");
  const host = mouseHost([egg, named], () => true, calls);
  assert.equal((await claimMice(host, ["3367:1977", "3367:1978"])).size, 0);
  assert.equal(await connectGeneric(host, "3367:1977"), null);
  assert.equal(await pingGeneric(host, "3367:1978"), false);
  assert.deepEqual(calls, []);
  // Keyboards: a VIA bootloader by name, and a known HID bootloader id.
  const kbHost: KbHost = { live: false, store: memoryKbStore(), drivers: CORE_DRIVERS, devices: async () => [new SimViaKeyboard({ vendorId: 0x16c0, productId: 0x0478, productName: "Teensy" }) as unknown as HIDDevice, new SimViaKeyboard({ vendorId: 0x4f42, productId: 0x0001, productName: "STM32 BOOTLOADER" }) as unknown as HIDDevice] };
  assert.equal(await claimKeyboard(kbHost, "16c0:0478"), null);
  assert.equal(await claimKeyboard(kbHost, "4f42:0001"), null);
  assert.equal(await pingKeyboard(kbHost, "4f42:0001"), false);
});

test("a mouse claimed by vendor id alone is shown only after a read-only identify", async () => {
  const calls: string[] = [];
  // 0x3710 (Pulsar): its drivers claim any product id. 0x5406 answers, 0x9999 doesn't; 0x1532 is pinned.
  const devices = [fakeDevice(0x3710, 0x5406, "Pulsar X2"), fakeDevice(0x3710, 0x9999, "Not a Pulsar"), fakeDevice(0x1532, 0x00c1, "Razer")];
  const host = mouseHost(devices, (d) => d.productId !== 0x9999, calls);
  const claimed = await claimMice(host, ["3710:5406", "3710:9999", "1532:00c1"]);
  assert.equal(claimed.get("3710:5406")?.identify, true);
  assert.equal(claimed.get("1532:00c1")?.identify, false, "a vendor whose driver checks product ids needs no identify");
  const cache = new Map();
  let t = 0;
  const shown = await confirmMice(host, ["3710:5406", "3710:9999", "1532:00c1"], cache, () => t);
  assert.deepEqual([...shown.keys()].sort(), ["1532:00c1", "3710:5406"]);
  // The identify only read, and closed what it opened; the pinned Razer wasn't asked.
  assert.ok(calls.every((c) => /^(open|readStatus|close) (5406|9999)$/.test(c)), calls.join());
  // Answers are kept: no new traffic for the one that answered, the silent one retried only after 30 s.
  calls.length = 0;
  t = 10_000;
  await confirmMice(host, ["3710:5406", "3710:9999", "1532:00c1"], cache, () => t);
  assert.deepEqual(calls, []);
  t = 40_000;
  await confirmMice(host, ["3710:5406", "3710:9999", "1532:00c1"], cache, () => t);
  assert.deepEqual(calls.filter((c) => c.startsWith("readStatus")), ["readStatus 9999"]);
  // Unplugged and plugged back in: asked afresh.
  await confirmMice(host, ["1532:00c1"], cache, () => t);
  assert.equal(cache.size, 0);
});

test("Cooler Master: only the MM711 (0x0101) is ever a mouse; a Cooler Master keyboard isn't", async () => {
  const mm711 = fakeDevice(0x2516, 0x0101, "MM711");
  const keyboard = fakeDevice(0x2516, 0x0151, "CK550");
  assert.equal((await findDriver(mm711))?.cls, "CoolerMasterHidClient");
  assert.equal(await findDriver(keyboard), null);
  const rs = readFileSync(join(root, "src-tauri/src/openmouse_ids.rs"), "utf8");
  const rows = rs.split(/\r?\n/).filter((l) => l.trim().startsWith("(0x2516"));
  assert.deepEqual(rows.map((r) => r.trim()), ["(0x2516, Some(0x0101), Some(0xff00), Some(0x0001)),"], "the bridge's table is pinned too");
});

// ---------------------------------------------------------------------------------------------
// VIA / Vial
// ---------------------------------------------------------------------------------------------

test("the VIA guard refuses every destructive command, and matches the Rust bridge's fixture", () => {
  for (const f of [frame(0x0b), frame(0x0a), frame(0x06), frame(0x13, 0, 0, 28), frame(0x0f), frame(0x10), frame(0x02, 0x03), frame(0x03, 0x02), frame(0x15), frame(0x05, 0, 0, 0, 0x7c, 0x00), frame(0x05, 0, 0, 0, 0x7c, 0x03), frame(0x05, 0, 0, 0, 0x5c, 0x00), frame(0xfe, 0x06), frame(0xfe, 0x07), frame(0xfe, 0x08), frame(0xfe, 0x0b), frame(0xfe, 0x0c), frame(0xfe, 0x0d), frame(0x07, 0, 1, 1), frame(0xff)])
    assert.equal(checkViaFrame(f).ok, false, Array.from(f.subarray(0, 6)).join(","));
  for (const f of [frame(0x01), frame(0x02, 0x02), frame(0x11), frame(0x12, 0, 0, 28), frame(0x05, 0, 0, 0, 0, 4), frame(0x07, 3, 1, 9), frame(0x07, 0x80, 9), frame(0x09, 3), frame(0xfe, 0x00), frame(0xfe, 0x02, 1, 0)])
    assert.equal(checkViaFrame(f).ok, true, Array.from(f.subarray(0, 6)).join(","));
  assert.equal(MAX_WRITABLE_KEYCODE, 0xff);
  assert.equal(readFileSync(join(root, "src-tauri/src/via-frames.txt"), "utf8"), viaFixtureText(), "run node scripts/via-guard-fixture.ts");
});

test("blocked VIA / Vial commands never reach the keyboard, even when asked for directly", async () => {
  for (const vial of [false, true]) {
    const sim = new SimViaKeyboard({ vendorId: 0x4f42, productId: 0x5641, productName: "Sample", vial });
    const t = new ViaTransport(hidChannel(sim as unknown as HIDDevice));
    await t.open();
    for (const bytes of [[0x0b], [0x0a], [0x06], [0x13, 0, 0, 28], [0x0f, 0, 0, 4], [0x10], [0x02, 0x03], [0x03, 0x02, 0, 0, 0, 1], [0x15], [0x05, 0, 0, 0, 0x7c, 0x00], [0xfe, 0x06], [0xfe, 0x07], [0xfe, 0x08], [0xfe, 0x0b], [0xfe, 0x0c], [0xfe, 0x0d, 2]])
      await assert.rejects(t.request(bytes), /Blocked/);
    assert.equal(sim.received.length, 0, "nothing was sent");
    assert.equal(sim.forbidden.length, 0);
    await t.close();
  }
});

function viaHost(sims: SimViaKeyboard[], fetches: string[]): KbHost {
  return {
    live: false,
    store: memoryKbStore(),
    drivers: CORE_DRIVERS,
    devices: async () => sims as unknown as HIDDevice[],
    definitions: viaDefinitions(memoryDefinitionCache(), async (url) => {
      fetches.push(String(url));
      const id = Number(/\/(\d+)\.json$/.exec(String(url))?.[1]);
      if (id !== vendorProductId(0x4f42, 0x5641)) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(sampleCompiledDefinition(0x4f42, 0x5641)), { status: 200 });
    }),
  };
}

test("a VIA board: definition fetched once from usevia.app and cached, keymap, lighting and macros read", async () => {
  const fetches: string[] = [];
  const sim = new SimViaKeyboard({ vendorId: 0x4f42, productId: 0x5641, productName: "Sample", layoutOptions: 1 });
  const host = viaHost([sim], fetches);
  const s = await connectKeyboard(host, "4f42:5641");
  assert.ok(s);
  const v = s.view;
  assert.equal(v.driver, "via");
  assert.equal(v.info.protocol, "VIA protocol 12");
  assert.equal(v.tier, "read-only");
  assert.deepEqual(fetches, ["https://usevia.app/definitions/v3/1329747521.json"]);
  assert.equal(v.keymap?.layers, 4);
  assert.equal(v.keymap?.layout.source, "via-definition");
  // Split backspace (option 0 = choice 1) moved into place.
  const bs = v.keymap!.layout.keys.filter((k) => k.y === 0 && k.x >= 13 && k.x < 15);
  assert.deepEqual(bs.map((k) => [k.x, k.w]), [[13, 1], [14, 1]]);
  assert.equal(v.keymap!.label!(v.keymap!.codes[0]![0]), "Esc");
  assert.equal(v.keymap!.label!(v.keymap!.codes[1]![14]), "Boot", "QK_BOOT is shown");
  assert.deepEqual(v.lighting?.groups.map((g) => g.id), ["rgb_matrix"]);
  assert.deepEqual(v.lighting?.groups[0].settings.map((x) => x.value), [200, 6, 127, [21, 255]]);
  assert.equal(v.macros?.count, 4);
  assert.match(v.macros!.summaries[0], /gg wp/);
  await s.close();
  // A second connect uses the cached copy: no network.
  const again = await connectKeyboard(host, "4f42:5641");
  assert.equal(fetches.length, 1);
  await again?.close();
  // A board VIA has no definition for: asked once, then remembered for the session; still shown.
  const other = new SimViaKeyboard({ vendorId: 0x4f42, productId: 0x0002, productName: "Unknown board" });
  const host2 = viaHost([other], fetches);
  const s2 = await connectKeyboard(host2, "4f42:0002");
  assert.equal(s2?.view.keymap, undefined);
  assert.match(s2!.view.notes.join(" "), /VIA has no layout/);
  await s2?.close();
  await (await connectKeyboard(host2, "4f42:0002"))?.close();
  assert.equal(fetches.filter((u) => u.includes(String(vendorProductId(0x4f42, 0x0002)))).length, 2, "v3 then v2, once each");
  assert.equal(sim.forbidden.length + other.forbidden.length, 0);
});

test("VIA writes: locked until allowed, backup first, basic keycodes only, read back and saved", async () => {
  const sim = new SimViaKeyboard({ vendorId: 0x4f42, productId: 0x5641, productName: "Sample" });
  const store = memoryKbStore();
  const host = { ...viaHost([sim], []), store };
  const s = (await connectKeyboard(host, "4f42:5641"))!;
  await assert.rejects(s.apply({ kind: "keycode", layer: 0, key: 0, code: 0x04 }), /Read-only/);
  assert.equal(store.backups.length, 0);
  s.setAllowChanges(true);
  // Refused before anything is sent or backed up.
  for (const code of [0x7c00, 0x7c03, 0x5c00, 0x5221, 0x0104, 0x02]) await assert.rejects(s.apply({ kind: "keycode", layer: 0, key: 0, code }), /basic keys/);
  await assert.rejects(s.apply({ kind: "keycode", layer: 9, key: 0, code: 0x04 }), /layers/);
  await assert.rejects(s.apply({ kind: "keycode", layer: 0, key: 999, code: 0x04 }), /layout/);
  await assert.rejects(s.apply({ kind: "polling", hz: 1000 }), /setting/);
  assert.equal(store.backups.length, 0);
  const before = sim.eepromWrites;
  const r = await s.apply({ kind: "keycode", layer: 0, key: 0, code: 0x04 });
  assert.equal(r.verdict, "confirmed");
  assert.equal(r.persistence, "saved");
  assert.equal(sim.keymap[0][0], 0x04);
  assert.equal(r.view.keymap!.codes[0]![0], 0x04);
  assert.equal(store.backups.length, 1);
  const backup = JSON.parse(store.backups[0].json);
  assert.equal(backup.raw.keymap[0][0], 0x29, "the backup holds the keymap before the change");
  const l = await s.apply({ kind: "lighting", id: "rgb_matrix.brightness", value: 90 });
  assert.equal(l.verdict, "confirmed");
  const c = await s.apply({ kind: "lighting", id: "rgb_matrix.color", value: [10, 200] });
  assert.equal(c.verdict, "confirmed");
  assert.deepEqual(sim.lighting.get("3:4"), [10, 200]);
  await assert.rejects(s.apply({ kind: "lighting", id: "rgb_matrix.effect", value: 999 }), /takes 0 to/);
  assert.ok(sim.eepromWrites >= before + 3, "keycode written and lighting saved");
  assert.equal(store.backups.length, 1, "one backup per session");
  assert.ok(store.lines.some((x) => x.includes("-> confirmed")));
  assert.equal(sim.forbidden.length, 0);
  await s.close();
});

test("a Vial board: definition read from the keyboard (xz), legacy lighting ids, nothing forbidden sent", async () => {
  assert.equal(new TextDecoder().decode(xzDecompress(hexBytes(VIAL_SAMPLE_XZ_HEX))), sampleVialJson(), "sim-vial.generated.ts is in step with the sample board");
  const broken = hexBytes(VIAL_SAMPLE_XZ_HEX);
  broken[broken.length - 30] ^= 0xff;
  assert.throws(() => xzDecompress(broken));
  const fetches: string[] = [];
  const sim = new SimViaKeyboard({ vendorId: 0x4f42, productId: 0x5667, productName: "Sample Vial", vial: true });
  const s = (await connectKeyboard(viaHost([sim], fetches), "4f42:5667"))!;
  const v = s.view;
  assert.equal(v.driver, "vial");
  assert.equal(v.info.protocol, "Vial 6 · VIA 9");
  assert.deepEqual(fetches, [], "a Vial board never needs the network");
  assert.equal(v.keymap?.layout.source, "vial-firmware");
  assert.equal(v.keymap?.layout.keys.length, 68);
  assert.deepEqual(v.lighting?.groups.map((g) => g.id), ["rgblight"]);
  s.setAllowChanges(true);
  assert.equal((await s.apply({ kind: "lighting", id: "rgblight.effect", value: 3 })).verdict, "confirmed");
  assert.deepEqual(sim.lighting.get("L:129")?.[0], 3);
  assert.ok(sim.received.every((f) => f[0] !== 0xfe || [0x00, 0x01, 0x02, 0x05].includes(f[1])), "only Vial's reads");
  assert.equal(sim.forbidden.length, 0);
  await s.close();
});

test("layout options unpack the way VIA packs them", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 8].map(optionBits), [1, 1, 2, 2, 3, 3]);
  const labels = [{ name: "Split BS", choices: ["Off", "On"] }, { name: "Bottom", choices: ["6.25U", "7U", "WKL"] }, { name: "ISO", choices: ["Off", "On"] }];
  // Last option in the lowest bits: ISO = bit 0, Bottom = bits 1-2, Split = bit 3.
  assert.deepEqual(unpackOptions(labels, 0b1101), [1, 2, 1]);
  assert.deepEqual(unpackOptions(labels, 0), [0, 0, 0]);
});

test("ViaBackend reads only; the driver claims raw-HID boards of any vendor, never typing collections", async () => {
  const sim = new SimViaKeyboard({ vendorId: 0x1234, productId: 0x0001, productName: "Any vendor" });
  assert.equal(await viaDriver.claims(sim as unknown as HIDDevice), true);
  const typing = fakeDevice(0x1234, 0x0002, "Keyboard", 0x0001);
  assert.equal(await viaDriver.claims(typing), false);
  assert.equal((await driversFor(typing, CORE_DRIVERS)).length, 0);
  const b = await ViaBackend.open(sim as unknown as HIDDevice, {});
  const writes = sim.received.filter((f) => checkViaFrame(f).ok && (checkViaFrame(f) as { write: boolean }).write);
  assert.deepEqual(writes, [], "a full read sends no write");
  await b.close();
  assert.equal(await viaDriver.ping(sim as unknown as HIDDevice), true);
});

// ---------------------------------------------------------------------------------------------
// @openmouse/keyboard-protocol
// ---------------------------------------------------------------------------------------------

const KB_DANGEROUS = ["saveProfile", "saveScope", "resetRgb", "writeKeyCode", "writeHigherKey", "writeMacro", "writeMacroMode", "writeLightingBase", "writeLightingCustom", "writeLightingDirectDrive", "setSingleKeyColor", "setRgbBuffer", "startAnalog", "readAnalogSnapshot", "readAxisCalibrate", "readAxisAdc", "readAxisKeyStatus", "writeConfigSwitch", "writeSystemSetting", "writeBlackout", "writeKeyboardColor", "sendCommand", "probeCommand", "collectCommand", "sendRawWrite"];

test("keyboard methods: allowlisted ones aren't blocked, every dangerous method of every real driver is", async () => {
  for (const m of [...KB_READ_METHODS, ...KB_SETTING_METHODS]) assert.equal(isKbBlocked(m), false, m);
  for (const m of KB_DANGEROUS) assert.equal(isKbAllowed(m), false, m);
  const seen = new Set<string>();
  for (const entry of KB_DRIVER_INDEX) {
    const impl = await entry.load();
    const client = impl.create({ vendorId: entry.vids[0], productId: 1, productName: "", opened: false, collections: [] } as unknown as HIDDevice) as object;
    for (let p = Object.getPrototypeOf(client); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const name of Object.getOwnPropertyNames(p)) seen.add(name);
  }
  const allowed = [...seen].filter((m) => isKbAllowed(m));
  assert.deepEqual(allowed.sort(), [...new Set([...KB_READ_METHODS, ...KB_SETTING_METHODS])].filter((m) => seen.has(m)).sort());
  for (const m of seen) if (/save|reset|firmware|bootloader|calibrat|macro|keycode|keyCode|lighting|rgb|analog(?!Profile)|axis|usbMode|configSwitch|systemSetting/i.test(m)) assert.equal(isKbAllowed(m), false, m);
  // The generated index lists the package's drivers in order.
  assert.deepEqual(KB_DRIVER_INDEX.map((e) => e.brand), KB_DRIVERS.map((d) => d.brand));
});

function fakeWuque(calls: string[]) {
  let rate = "r1khz";
  const perf = new Map<string, Record<string, number>>();
  const block = (row: number, col: number) => perf.get(`${row},${col}`) ?? { mode: 2, normalPressMm: 1.2, normalReleaseMm: 1.1, rtFirstTouchMm: 0.3, rtPressMm: 0.15, rtReleaseMm: 0.2, pressDeadStrokeMm: 0.1, releaseDeadStrokeMm: 0.05, axis: 7, calibrate: 1, axisV2Id: 3, axisRangeMax: 400, axisCoefficient: 12 };
  const rec = (name: string) => (...a: unknown[]) => {
    calls.push(name);
    return a;
  };
  const client: Record<string, unknown> = {
    open: async () => calls.push("open"),
    close: async () => calls.push("close"),
    readStatus: async () => (calls.push("readStatus"), { brand: "Wuque Studio", name: "BABAO60 HE", connectionType: "Wired", connectionDetail: "USB", firmware: ["Firmware: 1.2.1.0"], firmwareVersion: "1.2.1.0", layout: null, serial: "X", activeProfile: 0, profileCount: 4, profileNames: [], wuque: { device: { protocol: { mainVersion: 1 } }, global: {} } }),
    readKeyLayout: async (layer: number) => (calls.push("readKeyLayout"), { layer, rows: [[0x29, 0x1e, 0x1f], [0x2b, 0x14]] }),
    readPerformance: async (row: number, col: number) => (calls.push("readPerformance"), { ...block(row, col) }),
    writePerformance: async (s: Record<string, number>) => {
      calls.push(`writePerformance ${JSON.stringify(s)}`);
      const { row, col, ...rest } = s;
      perf.set(`${row},${col}`, rest);
      return rest;
    },
    readReportRates: async () => (calls.push("readReportRates"), ["r8khz", "r1khz", "r125hz"]),
    readReportRate: async () => (calls.push("readReportRate"), rate),
    writeReportRate: async (r: string) => (calls.push(`writeReportRate ${r}`), (rate = r), true),
    readRtPrecision: async () => (calls.push("readRtPrecision"), { min: 0.01 }),
  };
  for (const m of KB_DANGEROUS) client[m] = rec(`DANGER ${m}`);
  return client;
}

test("Wuque: tested groups write without 'Allow changes', echo what they don't change, never calibrate; nothing else is reachable", async () => {
  const calls: string[] = [];
  const store = memoryKbStore();
  const device = { vendorId: 0x1ca6, productId: 0x1b10, productName: "BABAO60 HE" };
  const backend = await OmkbBackend.open(device, { brand: "Wuque Studio", cls: "WuqueHidClient", create: () => fakeWuque(calls) });
  const s = new KbSession(backend, store, device);
  const v = s.view;
  assert.equal(v.groupTier.analog, "driver-tested");
  assert.equal(v.groupTier.polling, "driver-tested");
  assert.equal(v.groupTier.keymap, "read-only");
  assert.equal(v.writable.analog, true);
  assert.equal(v.keymap?.writable, false);
  assert.deepEqual(v.analog?.keys, [0, 1, 2, 21, 22]);
  await assert.rejects(s.apply({ kind: "analog", target: [0], values: { actuationMm: 9 } }), /takes/);
  await assert.rejects(s.apply({ kind: "analog", target: [99], values: { actuationMm: 1 } }), /analog key/);
  const r = await s.apply({ kind: "analog", target: [0, 22], values: { actuationMm: 0.8, rtPressMm: 0.1 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(r.persistence, "volatile");
  const writes = calls.filter((c) => c.startsWith("writePerformance")).map((c) => JSON.parse(c.slice(17)));
  assert.equal(writes.length, 2);
  for (const w of writes) {
    assert.equal(w.normalPressMm, 0.8);
    assert.equal(w.rtPressMm, 0.1);
    assert.equal(w.normalReleaseMm, 1.1, "unchanged fields echoed");
    assert.equal(w.axis, 7, "the switch's axis id is kept");
    assert.equal(w.axisV2Id, 3);
    assert.equal(w.calibrate, 0, "never a calibration write");
  }
  assert.deepEqual([writes[1].row, writes[1].col], [1, 1]);
  assert.equal((await s.apply({ kind: "polling", hz: 8000 })).verdict, "confirmed");
  await assert.rejects(s.apply({ kind: "polling", hz: 4000 }), /doesn't offer/);
  await assert.rejects(s.apply({ kind: "keycode", layer: 0, key: 0, code: 4 }), /Read-only/);
  s.setAllowChanges(true);
  await assert.rejects(s.apply({ kind: "keycode", layer: 0, key: 0, code: 4 }), /can't change/);
  assert.equal(store.backups.length, 1);
  assert.deepEqual(calls.filter((c) => c.startsWith("DANGER")), []);
  await s.close();
});

test("Wooting and Kochi: only the profile switch and the Windows/Mac switch can be sent", async () => {
  const calls: string[] = [];
  const wooting: Record<string, unknown> = {
    open: async () => calls.push("open"),
    close: async () => calls.push("close"),
    readStatus: async () => ({ brand: "Wooting", name: "Wooting 60HE+", connectionType: "Wired", connectionDetail: "USB", firmware: [], firmwareVersion: null, layout: null, serial: null, activeProfile: 0, profileCount: 2, profileNames: [], analogProfile: { actuationMm: 1.5 }, analogSnapshot: { available: true, keys: [{ usage: 4, value: 200, mm: 3.1 }] } }),
    switchProfile: async (n: number) => (calls.push(`switchProfile ${n}`), n),
  };
  for (const m of KB_DANGEROUS) wooting[m] = () => calls.push(`DANGER ${m}`);
  const dev = { vendorId: 0x31e3, productId: 0x1322, productName: "Wooting 60HE+" };
  const b = await OmkbBackend.open(dev, { brand: "Wooting", cls: "WootingHidClient", create: () => wooting });
  const s = new KbSession(b, memoryKbStore(), dev);
  assert.equal(s.view.analog?.global?.actuationMm, 1.5);
  assert.deepEqual(s.view.analog?.writable, []);
  assert.ok(!JSON.stringify(b.snapshot()).includes("analogSnapshot"), "the key-depth snapshot is never kept");
  await assert.rejects(s.apply({ kind: "profile", index: 1 }), /Read-only/);
  s.setAllowChanges(true);
  await assert.rejects(s.apply({ kind: "analog", target: "global", values: { actuationMm: 1 } }), /can't change/);
  await assert.rejects(s.apply({ kind: "profile", index: 5 }), /profiles 1 to 2/);
  await s.apply({ kind: "profile", index: 1 });
  assert.deepEqual(calls.filter((c) => /switch|DANGER/.test(c)), ["switchProfile 1"]);

  let mode = "win";
  const kochi = { open: async () => {}, close: async () => {}, readStatus: async () => ({ brand: "Kochi", name: "Hummingbird 68", connectionType: "Wired", connectionDetail: "USB", firmware: [], firmwareVersion: null, layout: null, serial: null, activeProfile: null, profileCount: null, profileNames: [], kochi: { systemMode: mode } }), readSystemMode: async () => mode, setSystemMode: async (m: string) => (mode = m) };
  const kd = { vendorId: 0x1ca2, productId: 0x0901, productName: "HB68" };
  const ks = new KbSession(await OmkbBackend.open(kd, { brand: "Kochi", cls: "KochiHidClient", create: () => kochi }), memoryKbStore(), kd);
  assert.equal(ks.view.groupTier.options, "driver-tested");
  const r = await ks.apply({ kind: "option", id: "systemMode", value: 1 });
  assert.equal(r.verdict, "confirmed");
  assert.equal(mode, "mac");
});

test("every registered keyboard driver loads, and its loader's vendor ids match the driver's own", async () => {
  const ids = new Set<string>();
  for (const l of CORE_DRIVERS) {
    const d = await l.load();
    assert.equal(d.id, l.id);
    assert.equal(d.priority, l.priority, l.id);
    assert.deepEqual(d.vids === null ? null : [...d.vids].sort((a, b) => a - b), l.vids === null ? null : [...l.vids].sort((a, b) => a - b), l.id);
    ids.add(d.id);
  }
  assert.deepEqual([...ids].sort(), ["analogsense", "asus-gearlink", "corsair-bragi", "drunkdeer", "fcc", "fw19f5", "logitech-kb", "monsgeek", "omkb", "razer-he", "rk-beiying", "sparklink", "steelseries", "via"]);
});

test("one keyboard driver per brand id, and never the Falchion ZywOo", async () => {
  const dev = (vendorId: number, productId: number, collections: { usagePage: number; usage: number }[]) => ({ vendorId, productId, productName: "", collections, opened: false }) as unknown as HIDDevice;
  const top = async (d: HIDDevice) => (await driversFor(d, CORE_DRIVERS)).map((x) => x.id);
  assert.deepEqual(await top(dev(0x0b05, 0x1d1d, [{ usagePage: 0xff00, usage: 1 }])), [], "0B05:1D1D keeps its own panel");
  assert.equal((await top(dev(0x0b05, 0x1b7e, [{ usagePage: 0xff00, usage: 1 }])))[0], "asus-gearlink", "plain Falchion HFX");
  assert.equal((await top(dev(0x1b1c, 0x2b0e, [{ usagePage: 0xff42, usage: 1 }])))[0], "corsair-bragi");
  assert.deepEqual(await top(dev(0x1b1c, 0x1bc0, [{ usagePage: 0xff42, usage: 1 }])), [], "K70 MAX (iCUE): no keyboard driver claims it yet");
  assert.equal((await top(dev(0x046d, 0xc339, [{ usagePage: 0xff00, usage: 2 }, { usagePage: 0xff43, usage: 0x0202 }])))[0], "logitech-kb");
  assert.deepEqual(await top(dev(0x046d, 0xc0a0, [{ usagePage: 0xff00, usage: 2 }])), [], "the DEX is a mouse");
  assert.equal((await top(dev(0x1038, 0x1642, [{ usagePage: 0xffc0, usage: 1 }])))[0], "steelseries");
  assert.deepEqual(await top(dev(0x1038, 0x1643, [{ usagePage: 0xffc0, usage: 1 }])), [], "an Apex in update mode");
  // The 0x19F5 family: one driver per id (AnalogSense yields), only on its Generic Desktop usage-0 collection, never an upgrader.
  const cfg = { usagePage: 1, usage: 0 };
  for (const [v, p] of FW_IDS) assert.deepEqual(await top(dev(v, p, [{ usagePage: 1, usage: 6 }, cfg])), ["fw19f5"], `${v.toString(16)}:${p.toString(16)}`);
  assert.deepEqual(await top(dev(0x19f5, 0x6120, [{ usagePage: 1, usage: 6 }])), [], "a NuPhy without its config collection");
  for (const p of [0x6f10, 0xaf12, 0xaf3c, 0x8a11, 0xfe00]) assert.deepEqual(await top(dev(0x19f5, p, [cfg, { usagePage: 0xff00, usage: 1 }])), [], `19f5:${p.toString(16)} is an upgrader`);
  assert.deepEqual(await top(dev(0x41e4, 0x9999, [cfg])), [], "an unlisted 41E4 id");
  // Royal Kludge BeiYing: System Control 0001:0080 only; another SinoWealth board, or the typing collections alone, is nobody's.
  const sc = { usagePage: 1, usage: 0x80 };
  for (const [v, p] of RK_IDS) assert.deepEqual(await top(dev(v, p, [{ usagePage: 1, usage: 6 }, sc])), ["rk-beiying"], `${v.toString(16)}:${p.toString(16)}`);
  assert.deepEqual(await top(dev(0x258a, RK_IDS[0][1], [{ usagePage: 1, usage: 6 }])), [], "no System Control collection, no claim");
  assert.deepEqual(await top(dev(0x258a, 0x010c, [{ usagePage: 1, usage: 6 }, sc])), [], "AULA's F75 shares the vendor id, not the protocol");
  assert.deepEqual(await top(dev(0x258a, 0x0102, [sc])), [], "Rangoli's unsupported board");
  // SparkLink: the vendor collection 0xFFA0:0x0001 only; Kochi's Hummingbird 68 is its too (OpenMouse's keyboard driver yields).
  const sl = { usagePage: 0xffa0, usage: 1 };
  for (const [v, p] of SPARKLINK_IDS) assert.deepEqual(await top(dev(v, p, [{ usagePage: 1, usage: 6 }, sl])), ["sparklink"], `${v.toString(16)}:${p.toString(16)}`);
  assert.deepEqual(await top(dev(0x1ca2, 0x1619, [{ usagePage: 1, usage: 6 }])), [], "no vendor collection, no claim");
  assert.deepEqual(await top(dev(0x1ca2, 0x1619, [{ usagePage: 0xffb0, usage: 1 }])), [], "the 0xFFB0 page is the other family");
  assert.deepEqual(await top(dev(0x1ca6, 0x3001, [sl])), [], "an id nobody listed");
  // Keychron / Lemokey Hall-effect boards: VIA's raw-HID driver is the one (its Keychron layer adds the analog settings); AnalogSense yields.
  const raw = { usagePage: 0xff60, usage: 0x61 };
  for (const [v, p] of KEYCHRON_HE_IDS) assert.deepEqual(await top(dev(v, p, [{ usagePage: 1, usage: 6 }, raw])), ["via"], `${v.toString(16)}:${p.toString(16)}`);
  assert.deepEqual(await top(dev(0x3434, 0x0b10, [{ usagePage: 1, usage: 6 }])), [], "no raw-HID collection, no claim");
});

test("the bridge's brand tables are generated from the drivers' own (gen-brand-bridge.ts)", () => {
  const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
  assert.equal(read("src-tauri/src/brand_ids.rs"), brandIdsText(), "run node scripts/gen-brand-bridge.ts");
  assert.equal(read("src-tauri/src/steelseries-scope.json"), steelseriesScopeText(), "run node scripts/gen-brand-bridge.ts");
});

