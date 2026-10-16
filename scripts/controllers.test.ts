// Controllers, wave C0 / C1: the generated id tables and the frame fixtures are current, the website's rules give
// the same answers as the bridge's (src-tauri/src/pads.rs), and the refusals the brief names are refused.
// Nothing here talks to a device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RS_OUT, TS_OUT, generated } from "./gen-controller-ids.ts";
import { PAD_FRAMES, allowedFrames, padFixtureText } from "./pad-fixtures.ts";
import { PAD_BOOT_IDS, PAD_MODELS, PAD_SHIM_IDS } from "../src/lib/controllers/models.ts";
import { PAD_BOOT, PAD_ROWS } from "../src/lib/controllers/ids.generated.ts";
import { hidPad, isPad, padAccess, padBoot, padGuardOf } from "../src/lib/controllers/pads.ts";
import { checkPadFeatureGet, checkPadFeatureSet, checkPadOutput } from "../src/lib/controllers/guard.ts";
import { SWITCH_RUMBLE, ds5Output, switchOutput } from "../src/lib/controllers/frames.ts";
import { isBootloader } from "../src/lib/bootloader-ids.ts";
import * as policy from "../src/lib/web/policy.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** A checked-in text file, line ends as Git left them on this machine. */
const text = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

test("the controller id tables are what the generator writes (SDL, xpad, models.ts)", () => {
  const g = generated();
  assert.equal(text(TS_OUT), g.ts, "run node scripts/gen-controller-ids.ts");
  assert.equal(text(RS_OUT), g.rs, "run node scripts/gen-controller-ids.ts");
  assert.ok(g.rows.length > 700, `${g.rows.length} ids`);
});

test("the pad frame fixture is what guard.ts judges today", () => {
  assert.equal(text(PAD_FRAMES), padFixtureText(), "run node scripts/pad-fixtures.ts");
});

test("every model's identities are in the table, unique, and never a boot or shim id", () => {
  const ids = new Set<string>();
  const models = new Set<string>();
  for (const m of PAD_MODELS) {
    assert.ok(!models.has(m.id), `model ${m.id} twice`);
    models.add(m.id);
    for (const i of m.ids) {
      const k = `${i.vid}:${i.pid}`;
      assert.ok(!ids.has(k), `${m.id}: ${k} belongs to two models`);
      ids.add(k);
      assert.ok(isPad(i.vid, i.pid), `${m.id}: ${k} missing from ids.generated.ts`);
      assert.ok(!padBoot(i.vid, i.pid) && !PAD_SHIM_IDS.some(([v, p]) => v === i.vid && p === i.pid), `${m.id}: ${k}`);
    }
    if (m.guard !== "input") assert.ok(m.ids.some((i) => i.transport === "hid"), `${m.id}: a ${m.guard} guard needs a HID identity`);
  }
  for (const [v, p] of PAD_SHIM_IDS) assert.ok(!isPad(v, p), "Windows' XInput shims aren't pads");
  assert.deepEqual(
    PAD_BOOT.map(([v, p]) => `${v}:${p}`),
    [...PAD_BOOT_IDS].sort((a, b) => a.vid - b.vid || a.pid - b.pid).map((b) => `${b.vid}:${b.pid}`),
  );
});

test("the website's pad rules are the bridge's: guards, collections, boot ids (pads.rs)", () => {
  const rs = text(join(root, "src-tauri/src/controller_ids.rs"));
  const list = (name: string) => [...rs.slice(rs.indexOf(`pub const ${name}`)).split("\n")[0].matchAll(/\(0x([0-9a-f]{4}), 0x([0-9a-f]{4})\)/g)].map((m) => `${parseInt(m[1], 16)}:${parseInt(m[2], 16)}`);
  for (const [name, guard] of [["PAD_DS5", "ds5"], ["PAD_EDGE", "edge"], ["PAD_DS4", "ds4"], ["PAD_SWITCH", "switch"], ["PAD_SCUF", "scuf"], ["PAD_8BITDO", "8bitdo"], ["PAD_FLYDIGI", "flydigi"]] as const) {
    const ts = PAD_ROWS.filter(([v, p]) => padGuardOf(v, p) === guard).map(([v, p]) => `${v}:${p}`);
    assert.deepEqual(ts, list(name), name);
  }
  // GameSir: (vid, pid, map index) in Rust, per configurable id only.
  const order = ["gamesir-cyclone2", "gamesir-g7pro8k", "gamesir-tarantula"];
  const gamesirRs = [...rs.slice(rs.indexOf("pub const PAD_GAMESIR")).split("\n")[0].matchAll(/\(0x([0-9a-f]{4}), 0x([0-9a-f]{4}), (\d)\)/g)].map((m) => `${parseInt(m[1], 16)}:${parseInt(m[2], 16)}:${order[Number(m[3])]}`);
  const gamesirTs = PAD_ROWS.filter(([v, p]) => padGuardOf(v, p)?.startsWith("gamesir-")).map(([v, p]) => `${v}:${p}:${padGuardOf(v, p)}`);
  assert.deepEqual(gamesirTs, gamesirRs, "PAD_GAMESIR");
  assert.ok(gamesirTs.length >= 13 && !gamesirTs.some((x) => /^13623:(1397|4156|4280):/.test(x)), "never 0575, 103C or 10B8");
  // Every pad: its gamepad collection only, never a typing or pointing one; XInput pads never as HID.
  for (const [v, p, , t] of PAD_ROWS) {
    for (const [page, usage] of [
      [0x0001, 0x0002],
      [0x0001, 0x0006],
      [0x0007, 0x0000],
      [0x000c, 0x0001],
      [0x0001, 0x0000],
    ])
      assert.equal(policy.collectionAccess(v, p, page, usage), null, `${v.toString(16)}:${p.toString(16)} ${page}:${usage}`);
    const gamepad = policy.collectionAccess(v, p, 0x0001, 0x0005);
    const g = padGuardOf(v, p);
    if (t === "hid") assert.equal(gamepad, g === "input" || g === "scuf" || g === "flydigi" || g?.startsWith("gamesir-") ? "input" : "full");
    else assert.equal(gamepad, null, `${v.toString(16)}:${p.toString(16)} (${t}) is read through XInput`);
    assert.equal(policy.collectionAccess(v, p, 0xffa0, 0x0001), g === "flydigi" ? "full" : null, `${v.toString(16)}:${p.toString(16)} 0xFFA0`);
    // GameSir's settings channel opens in full on its configurable ids only.
    assert.equal(policy.collectionAccess(v, p, 0xfff0, 0x0001), g?.startsWith("gamesir-") ? "full" : null, `${v.toString(16)}:${p.toString(16)} 0xFFF0`);
    // The SCUF Envision's BRAGI request collection: full on its ids only; its notifications never.
    assert.equal(policy.collectionAccess(v, p, 0xff42, 0x0001), g === "scuf" ? "full" : null, `${v.toString(16)}:${p.toString(16)} 0xFF42`);
    assert.equal(policy.collectionAccess(v, p, 0xff42, 0x0002), null);
  }
  assert.equal(policy.collectionAccess(0x3537, 0x1010, 0x0001, 0x0005), null, "the G7 SE (GIP) is never opened as HID");
  assert.equal(policy.allowed(0x3537, 0x1010), false);
  assert.equal(padAccess(0x28de, 0x1102, 0xff00, 0x0001), "input", "Valve's vendor input collection");
  for (const [v, p] of PAD_BOOT) {
    assert.ok(isBootloader(v, p) && !policy.allowed(v, p) && !hidPad(v, p), `boot ${v.toString(16)}:${p.toString(16)}`);
    assert.equal(policy.classifyDevice(v, p, [{ usagePage: 1, usage: 5 }], null)?.bootloader, true);
  }
});

test("the refusals the brief names: Switch subcommands, 0x80 0x06, input modes, Sony pairing reads, every feature write", () => {
  const sub = (link: "usb" | "bt", id: number, args: number[] = []) => {
    const f = switchOutput(link, { kind: "deviceInfo" }, 1);
    f.data[9] = id;
    f.data.set(args, 10);
    return f;
  };
  for (const link of ["usb", "bt"] as const) {
    for (const id of [0x11, 0x12, 0x07, 0x08, 0x06, 0x01, ...Array.from({ length: 12 }, (_, i) => 0x20 + i)]) {
      const f = sub(link, id, [0x00, 0x60, 0, 0, 0x10]);
      assert.equal(checkPadOutput("switch", f.reportId, f.data).ok, false, `subcommand ${id.toString(16)}`);
    }
    for (let arg = 0; arg < 256; arg++) {
      const f = sub(link, 0x03, [arg]);
      assert.equal(checkPadOutput("switch", f.reportId, f.data).ok, arg === 0x30 || arg === 0x3f, `input mode ${arg.toString(16)}`);
    }
    const usb = switchOutput(link, { kind: "usb", command: 0x01 }, 0);
    for (let cmd = 0; cmd < 256; cmd++) {
      usb.data[0] = cmd;
      assert.equal(checkPadOutput("switch", usb.reportId, usb.data).ok, cmd >= 1 && cmd <= 5, `0x80 ${cmd.toString(16)}`);
    }
    // Rumble: exactly the two frames.
    const r = switchOutput(link, { kind: "rumble", pulse: true }, 0);
    assert.deepEqual([...r.data.subarray(1, 9)], [...SWITCH_RUMBLE.pulse]);
    r.data[1] = 0x75;
    assert.equal(checkPadOutput("switch", r.reportId, r.data).ok, false);
  }
  for (const g of ["ds5", "ds4", "switch", "input"] as const) for (let id = 0; id < 256; id++) assert.equal(checkPadFeatureSet(g, id).ok, false);
  assert.equal(checkPadFeatureGet("ds5", 0x09).ok, false);
  assert.equal(checkPadFeatureGet("ds4", 0x12).ok, false);
  assert.ok(checkPadFeatureGet("ds5", 0x05).ok && checkPadFeatureGet("ds5", 0x20).ok);
  assert.ok(checkPadFeatureGet("ds4", 0x02).ok && checkPadFeatureGet("ds4", 0x05).ok && checkPadFeatureGet("ds4", 0xa3).ok);
  // A read-only pad: nothing.
  const any = ds5Output("usb", { kind: "rumble", left: 1, right: 1 });
  assert.equal(checkPadOutput("input", any.reportId, any.data).ok, false);
});

test("every frame the C1 drivers build passes the guard, on USB and Bluetooth", () => {
  const frames = allowedFrames();
  assert.ok(frames.length > 80);
  for (const f of frames) assert.ok(checkPadOutput(f.guard, f.reportId, f.data).ok, `${f.guard} ${f.reportId.toString(16)}`);
});
