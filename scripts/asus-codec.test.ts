// ASUS Gear Link codecs and allowlist (src/lib/brands/asus), no device, no window:
//   node --test scripts/asus-codec.test.ts
//
//  - the device table (generated from the Gear Link manifests) and its exclusions;
//  - golden frames: the worked examples read out of Gear Link's SDK (docs/devices/asus-gearlink.md)
//    and the HFX hardware capture (docs/keyboard/captures.json);
//  - the allowlist: every encoder output, over many inputs, is allowed for its family; every blocked
//    command is built and refused for every family; no encoder can produce a blocked frame.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GEARLINK_DEVICES } from "../src/lib/brands/asus/devices.generated.ts";
import { ASUS_BOOTLOADER_PIDS, ASUS_MODELS, asusGuardFamily, asusKeyboardTraits, asusModel, asusMouseTraits, asusPids } from "../src/lib/brands/asus/devices.ts";
import { ASUS_BLOCKED, ASUS_RULES, asusGuard, classifyAsusFrame } from "../src/lib/brands/asus/guard.ts";
import * as K from "../src/lib/brands/asus/keyboard-codec.ts";
import * as M from "../src/lib/brands/asus/mouse-codec.ts";
import { lintRules, ruleMatches } from "../src/lib/brands/rules.ts";
import { hex } from "../src/lib/brands/types.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strip = (f: Uint8Array) => {
  let end = f.length;
  while (end > 0 && f[end - 1] === 0) end--;
  return hex(f.subarray(0, end));
};
const fromHex = (s: string, n = 64) => {
  const f = new Uint8Array(n);
  s.trim().split(/\s+/).filter(Boolean).forEach((b, i) => (f[i] = parseInt(b, 16)));
  return f;
};
let seed = 4242;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed >>> 8) % n;
};
const pick = <T>(a: readonly T[]) => a[rnd(a.length)];

const AZOTH = asusModel(0x1c10)!;
const TX75 = asusModel(0x1d68)!;
const HFX = asusModel(0x1b7e)!;
const HARPE2 = asusModel(0x1c69)!;
const GLADIUS4 = asusModel(0x1db0)!;
const spec = (m: typeof AZOTH): K.KbUnitSpec => ({ cls: asusKeyboardTraits(m).cls, unitMm: m.analog!.unitMm });

// ---------------------------------------------------------------------------------------------
test("device table: 99 Gear Link manifests, families, bootloaders excluded", () => {
  assert.equal(GEARLINK_DEVICES.length, 99);
  for (const pid of ASUS_BOOTLOADER_PIDS) assert.equal(asusModel(pid), null, `bootloader 0x${pid.toString(16)} must not resolve`);
  for (const pid of [0x1948, 0x194a, 0x1aaf, 0x1acf, 0x1ad1, 0x1c11, 0x1c6a, 0x1c7e, 0x1cad, 0x1d4d, 0x1d69, 0x1d6d]) assert.ok(ASUS_BOOTLOADER_PIDS.has(pid));
  assert.equal(asusModel(0x19af), null, "Aura motherboard controller");
  assert.equal(asusModel(0x1afa), null, "headsets are not driven");
  assert.deepEqual(asusPids("kb-he").sort(), [0x1c10, 0x1c12, 0x1c2f, 0x1c31, 0x1c7d, 0x1d68, 0x1d6a, 0x1df3, 0x1df5].sort());
  assert.deepEqual(asusPids("kb-hfx").sort(), [0x1b7e, 0x1d1d]);
  for (const pid of asusPids("kb-he")) assert.equal(asusModel(pid)!.analog!.unitMm, 0.01);
  assert.equal(HFX.analog!.unitMm, 0.1);
  assert.equal(asusModel(0x1d1d)!.analog!.unitMm, 0.1, "ZywOo falls back to the HFX manifest");
  assert.equal(asusKeyboardTraits(AZOTH).cls, "he-v1");
  assert.equal(asusKeyboardTraits(TX75).cls, "he-v2");
  assert.equal(asusKeyboardTraits(AZOTH).polling51, false, "Azoth 96 HE uses the 80 2x mode system");
  assert.equal(asusMouseTraits(GLADIUS4).dpiBase, 1);
  assert.equal(asusMouseTraits(HARPE2).dpiBase, 50);
  // 99 - 19 hidPattern-3 PIDs - 8 headsets - 4 gamepad PIDs - 1 dock.
  assert.equal(ASUS_MODELS.size, 67);
});

// ---------------------------------------------------------------------------------------------
test("0.01 mm keyboard frames match Gear Link's worked examples", () => {
  const W = K.fwKey("KeyW");
  assert.equal(strip(K.encodeGlobalActuation(spec(AZOTH), 1.0)), "51 50 00 00 64");
  assert.equal(hex(K.encodeGlobalActuation(spec(AZOTH), 1.0).subarray(0, 6)), "51 50 00 00 64 00");
  assert.equal(strip(K.encodeGlobalActuation(spec(TX75), 2.0)), "51 50 00 00 c8");
  assert.equal(strip(K.encodeKeyActuation(spec(AZOTH), W, 0.35)), "51 4f 00 00 12 00 23");
  assert.equal(strip(K.encodeGlobalDeadZones(spec(AZOTH), 0.3, 0.2)), "51 58 00 00 14 1e");
  assert.equal(strip(K.encodeKeyDeadZones(spec(AZOTH), W, 0.3, 0.2)), "51 59 00 00 12 00 14 1e");
  const [comb] = K.encodeRapidTriggerKey(spec(AZOTH), W, { enabled: true, continuous: false, independent: false, sensitivityMm: 0.15, pressMm: 0, releaseMm: 0 });
  assert.equal(strip(comb), "51 54 00 00 12 00 00 01 0f");
  const [ind] = K.encodeRapidTriggerKey(spec(AZOTH), W, { enabled: true, continuous: true, independent: true, sensitivityMm: 0, pressMm: 0.1, releaseMm: 0.25 });
  assert.equal(strip(ind), "51 54 01 00 12 00 01 01 0a 00 19");
  assert.equal(strip(K.encodeRapidTriggerEnable(true)), "51 5c 00 00 01");
  assert.equal(strip(K.encodeRemap(spec(AZOTH), K.fwKey("Insert"), K.fwKey("ScrollLock"), 1.0)), "51 21 4b 00 7d 00 64");
  assert.equal(strip(K.encodeRemap(spec(AZOTH), K.fnKey(K.fwKey("Escape")), K.fwKey("Delete"), 1.0)), "51 21 6e 9f 4c 00 64");
  // The same 1.00 mm on the HFX, and the HFX keeps its captured u8 RT and remap layouts.
  assert.equal(strip(K.encodeGlobalActuation(spec(HFX), 1.0)), "51 50 00 00 0a");
  assert.equal(strip(K.encodeRemap(spec(HFX), K.fwKey("Insert"), K.fwKey("ScrollLock"), 1.0)), "51 21 4b 00 7d 00 0a");
  const hfxRt = K.encodeRapidTriggerKey(spec(HFX), W, { enabled: true, continuous: false, independent: true, sensitivityMm: 0.2, pressMm: 0.1, releaseMm: 0.1 });
  assert.deepEqual(hfxRt.map(strip), ["51 54 01 00 12 00 01 00 01", "51 54 02 00 12 00 01 00 01"]);
});

test("0.01 mm reads: request layouts and reply decoders", () => {
  const W = K.fwKey("KeyW");
  assert.equal(strip(K.encodeReadActuation("v1", null)), "25 05");
  assert.equal(strip(K.encodeReadActuation("v1", W)), "25 04 00 00 12");
  assert.equal(strip(K.encodeReadActuation("v2", W)), "25 a4 00 00 12");
  assert.equal(strip(K.encodeReadDeadZones("v2", null)), "25 aa");
  assert.equal(strip(K.encodeReadRapidTrigger("v1", W)), "25 06 00 00 12");
  assert.equal(strip(K.encodeReadKeyTrigger("v2", W)), "25 a2 00 00 12");
  assert.equal(strip(K.encodeReadSpeedTapPairs(1)), "25 08 01");
  assert.equal(K.decodeActuation("v1", fromHex("25 04 00 00 64 00"), 0.01), 1);
  assert.equal(K.decodeActuation("v2", fromHex("25 a4 00 00 12 00 23 00"), 0.01), 0.35);
  assert.deepEqual(K.decodeDeadZones("v1", fromHex("25 0a 00 00 14 1e"), 0.01), { bottomMm: 0.2, topMm: 0.3 });
  assert.deepEqual(K.decodeDeadZones("v2", fromHex("25 a9 00 00 12 00 14 1e"), 0.01), { bottomMm: 0.2, topMm: 0.3 });
  const rt = K.decodeRapidTrigger("v2", fromHex("25 a6 01 00 12 00 0a 00 19 00 01 01"), 0.01);
  assert.deepEqual([rt.independent, rt.pressMm, rt.releaseMm, rt.continuous, rt.enabled], [true, 0.1, 0.25, true, true]);
  assert.deepEqual(K.decodeKeyTrigger("v1", fromHex("25 02 00 00 7d 00 64 00")), { type: 0, target: 0x7d });
  assert.deepEqual(K.decodeSpeedTapPairs(fromHex("25 08 00 00 1f 00 21 00 ff ff ff ff 00 00 00 00"), 0), [[0x1f, 0x21]]);
});

test("mouse frames match Gear Link's worked examples", () => {
  assert.equal(strip(M.encodeDpiStage(asusMouseTraits(GLADIUS4), 0, 1600)), "51 31 00 00 3f 06");
  assert.equal(strip(M.encodeDpiStage(asusMouseTraits(HARPE2), 0, 1600)), "51 31 00 00 1f");
  assert.equal(strip(M.encodePolling(asusMouseTraits(HARPE2), 8000)), "51 31 04 00 06");
  assert.equal(strip(M.encodePolling(asusMouseTraits(HARPE2), 125)), "51 31 04");
  assert.equal(strip(M.encodeActiveStage(asusMouseTraits(HARPE2), 1)), "51 31 09 00 02");
  assert.equal(strip(M.encodeMotionSync(asusMouseTraits(HARPE2), true)), "51 31 12 00 01");
  assert.equal(strip(M.encodeDebounce(asusMouseTraits(GLADIUS4), 12)), "51 31 05 00 02");
  assert.equal(strip(M.encodeSelectProfile(2)), "50 02 01");
  assert.equal(strip(M.encodeSave()), "50 03");
  assert.throws(() => M.encodeDebounce(asusMouseTraits(HARPE2), 12), /button-response/);
  assert.throws(() => M.encodeDpiStage(asusMouseTraits(HARPE2), 0, 1625), /multiple of 50/);
  // 12 04 00, 4-stage layout: DPI raw x4, polling word, debounce, snapping (OpenMouse offsets).
  const perf = M.decodePerformance(asusMouseTraits(HARPE2), fromHex("12 04 00 00 1f 00 3f 00 7f 00 c7 00 03 00 02 00 01"));
  assert.deepEqual(perf, { dpi: [1600, 3200, 6400, 10000], pollingHz: 1000, debounceMs: 12, angleSnap: true });
  assert.deepEqual(M.decodeBattery(fromHex("12 07 00 00 55 00 00 00 00 01")), { percent: 0x55, charging: true });
});

// ---------------------------------------------------------------------------------------------
test("rule table is well formed", () => {
  assert.deepEqual(lintRules(ASUS_RULES), []);
  assert.ok(ASUS_BLOCKED.length >= 25);
});

/** Valid frames from every encoder, per family, over many inputs. */
function allowedSamples(): { pid: number; f: Uint8Array; family: string }[] {
  const out: { pid: number; f: Uint8Array; family: string }[] = [];
  const kb = [AZOTH, asusModel(0x1c2f)!, asusModel(0x1c7d)!, TX75, asusModel(0x1df3)!, asusModel(0x1df5)!, HFX, asusModel(0x1d1d)!];
  const keys = Object.values(K.FW_KEY).filter((k) => k !== K.FW_KEY.FN);
  for (const m of kb) {
    const s = spec(m);
    const a = m.analog!;
    const t = asusKeyboardTraits(m);
    const fam = asusGuardFamily(m);
    const add = (f: Uint8Array) => out.push({ pid: m.pid, f, family: fam });
    const mmIn = (lo: number, hi: number) => Math.round((lo + (rnd(1000) / 1000) * (hi - lo)) / s.unitMm) * s.unitMm;
    for (let n = 0; n < 40; n++) {
      const k = pick(keys);
      add(K.encodeGlobalActuation(s, mmIn(a.actuation.min, a.actuation.max)));
      add(K.encodeKeyActuation(s, k, mmIn(a.actuation.min, a.actuation.max)));
      add(K.encodeGlobalDeadZones(s, mmIn(0, a.deadZone.max), mmIn(0, a.deadZone.max)));
      add(K.encodeKeyDeadZones(s, k, mmIn(0, a.deadZone.max), mmIn(0, a.deadZone.max)));
      for (const f of K.encodeRapidTriggerKey(s, k, { enabled: !!rnd(2), continuous: !!rnd(2), independent: !!rnd(2), sensitivityMm: mmIn(a.rapidTrigger.min, a.rapidTrigger.max), pressMm: mmIn(a.rapidTrigger.min, a.rapidTrigger.max), releaseMm: mmIn(a.rapidTrigger.min, a.rapidTrigger.max) })) add(f);
      add(K.encodeRemap(s, rnd(2) ? k : K.fnKey(k), pick([0, ...keys, 211, 768]), mmIn(a.actuation.min, a.actuation.max)));
      add(K.encodeSpeedTapPair(k, pick(keys), !!rnd(2)));
      add(K.encodeSimpleLighting({ effect: pick(["static", "breathing", "colorCycle", "reactive", "starryNight", "current", "raindrop"] as const), speed: rnd(256), brightness: rnd(101), singleColor: !!rnd(2), randomColor: !!rnd(2), colors: [{ r: rnd(256), g: rnd(256), b: rnd(256) }] }));
    }
    add(K.encodeSpeedTapEnable(true));
    add(K.encodeSpeedTapEnable(false));
    add(K.encodeSave());
    for (let p = 1; p <= 6; p++) add(K.encodeSelectProfile(p));
    if (t.polling51) for (const hz of K.KB_POLLING_HZ) add(K.encodePollingRate(hz));
    if (t.rtEnableCommand) add(K.encodeRapidTriggerEnable(!!rnd(2)));
    add(K.encodeReadBasic());
    add(K.encodeReadRtMode());
    add(K.encodeReadSpeedTap());
    if (t.cls !== "hfx") {
      const g: K.Getters = t.cls === "he-v1" ? "v1" : "v2";
      if (t.polling51) add(K.encodeReadPollingIndex());
      add(K.encodeReadSpeedTapPairs(0));
      add(K.encodeReadSpeedTapPairs(1));
      add(K.encodeReadActuation(g, null));
      add(K.encodeReadDeadZones(g, null));
      for (const k of keys.slice(0, 20)) for (const f of [K.encodeReadActuation(g, k), K.encodeReadDeadZones(g, k), K.encodeReadRapidTrigger(g, k), K.encodeReadKeyTrigger(g, k), K.encodeReadKeyTrigger(g, K.fnKey(k))]) add(f);
    }
  }
  for (const m of [HARPE2, GLADIUS4, asusModel(0x1b16)!, asusModel(0x1dde)!]) {
    const t = asusMouseTraits(m);
    const add = (f: Uint8Array) => out.push({ pid: m.pid, f, family: "mouse" });
    for (let n = 0; n < 30; n++) {
      const dpi = (Math.floor((100 + rnd(t.maxDpi - 100)) / t.dpiBase) * t.dpiBase) || 100;
      add(M.encodeDpiStage(t, rnd(t.stages), Math.max(100, dpi), rnd(2) ? { r: rnd(256), g: rnd(256), b: rnd(256) } : undefined));
      if (t.splitXY) add(M.encodeDpiStageXY(t, rnd(t.stages), Math.max(100, dpi), Math.max(100, dpi)));
    }
    for (const hz of t.pollingHz) add(M.encodePolling(t, hz));
    if (t.debounce) for (let ms = 4; ms <= 32; ms += 4) add(M.encodeDebounce(t, ms));
    if (t.angleSnap) add(M.encodeAngleSnap(t, true));
    if (t.motionSync) add(M.encodeMotionSync(t, false));
    for (let s = 0; s < t.stages; s++) add(M.encodeActiveStage(t, s));
    for (let p = 1; p <= 5; p++) add(M.encodeSelectProfile(p));
    for (const f of [M.encodeSave(), M.encodeReadInfo(), M.encodeReadPerformance(), M.encodeReadSplitDpi(), M.encodeReadMotionSync(), M.encodeReadLod(), M.encodeReadBattery()]) add(f);
  }
  return out;
}

test("every encoder output is allowed for its family (and never matches a blocked rule)", () => {
  const samples = allowedSamples();
  assert.ok(samples.length > 2000, `${samples.length} samples`);
  const blockedRules = ASUS_RULES.filter((r) => r.verdict === "blocked");
  for (const { pid, f, family } of samples) {
    const v = classifyAsusFrame(pid, f);
    assert.notEqual(v.verdict, "blocked", `${family} 0x${pid.toString(16)} ${strip(f)}: ${v.what} ${v.reason ?? ""}`);
    for (const r of blockedRules) assert.ok(!ruleMatches(r, family, f), `${strip(f)} would hit blocked rule ${r.id}`);
  }
});

test("the HFX capture passes the hfx family (except the reads SYNQ never needs and the profile reset)", () => {
  const capture = JSON.parse(fs.readFileSync(path.join(root, "docs/keyboard/captures.json"), "utf8"));
  const frames = [...new Set<string>(capture.log.filter((e: { kind?: string; hex?: string }) => e.kind === "sendReport" && e.hex).map((e: { hex: string }) => e.hex))];
  const refused = frames.filter((h) => classifyAsusFrame(0x1d1d, fromHex(h)).verdict === "blocked").sort();
  assert.deepEqual(refused, ["22 01", "50 40", "7d 20 01"]);
  assert.equal(classifyAsusFrame(0x1d1d, fromHex("50 40")).why, "profile-wipe");
});

/** One concrete frame per blocked command, and the reason it must be refused with. */
const BLOCKED_SAMPLES: [string, string][] = [
  ["7b aa 41 53 55 53 aa", "bootloader"],
  ["7f 55 aa 55 aa 00 00 82", "bootloader"],
  ["43 55 aa 55 aa", "bootloader"],
  ["10 41 53 55 53 48 49 44 46 57 55", "firmware"],
  ["00 00 41 53 55 53 48 49 44 46 57 55", "firmware"],
  ["11 ff", "firmware"],
  ["1f 01", "firmware"],
  ["1f 51", "firmware"],
  ["20 00 00 00 08", "firmware"],
  ["21 00 10", "firmware"],
  ["22 10 00 00", "firmware"],
  ["82", "firmware"],
  ["8e", "firmware"],
  ["8f", "firmware"],
  ["ba c0 00 00", "firmware"],
  ["ba c2", "firmware"],
  ["c3", "firmware"],
  ["7d 20 01", "firmware"],
  ["b0 00 00 00 72 65 73 65 74", "factory-reset"],
  ["50 40 00 00 01", "profile-wipe"],
  ["50 40 00 00 00", "profile-wipe"],
  ["50 60", "profile-wipe"],
  ["50 61", "profile-wipe"],
  ["52 02", "factory-reset"],
  ["52 03", "factory-reset"],
  ["51 52 01 00 64 00 02", "profile-wipe"],
  ["51 56", "profile-wipe"],
  ["80 26 00 00 12 00", "calibration"],
  ["80 27 01 00 12 00 01 02", "calibration"],
  ["80 00 00 00 01", "identity"],
  ["a2 00 00 00 01", "pairing"],
  ["a2 01 00 00 05 0b 69 1c", "pairing"],
  ["74 00 00 00 01", "identity"],
];

test("every blocked command is refused, for every family, with its reason", () => {
  const pids = [0x1c10, 0x1d68, 0x1b7e, 0x1d1d, 0x1c69, 0x1db0, 0x1ace, 0x1a83];
  for (const [h, why] of BLOCKED_SAMPLES)
    for (const pid of pids) {
      const v = classifyAsusFrame(pid, fromHex(h));
      assert.equal(v.verdict, "blocked", `${h} to 0x${pid.toString(16)}`);
      assert.equal(v.why, why, `${h} to 0x${pid.toString(16)}: ${v.what}`);
    }
  // Family-specific meanings.
  assert.equal(classifyAsusFrame(0x1c10, fromHex("51 42 00 00 01")).why, "demo", "keyboard demo mode");
  assert.equal(classifyAsusFrame(0x1c69, fromHex("51 41 00 00 01")).why, "demo", "mouse demo mode");
  assert.equal(classifyAsusFrame(0x1c69, fromHex("51 35 01 00 00 01 00 00 00 00")).why, "calibration", "mouse LOD / manual calibration");
  assert.equal(classifyAsusFrame(0x1c69, fromHex("51 35 00 00 00 02 00 00 00")).why, "calibration");
  assert.equal(classifyAsusFrame(0x1c10, fromHex("51 27 12 00 02")).why, "calibration", "switch type");
  assert.equal(classifyAsusFrame(0x1c69, fromHex("51 30 00 00 01")).why, "identity", "mouse SW mode");
  // Keyboard frames to a mouse and mouse frames to a keyboard are not listed.
  assert.equal(classifyAsusFrame(0x1c69, K.encodeGlobalActuation(spec(AZOTH), 1)).verdict, "blocked");
  assert.equal(classifyAsusFrame(0x1c10, M.encodePolling(asusMouseTraits(HARPE2), 8000)).verdict, "blocked");
  assert.equal(classifyAsusFrame(0x1c10, K.encodePollingRate(8000)).verdict, "write", "the rule exists, but the backend never sends 51 31 to the Azoth 96 HE");
  // Units: an HFX-sized value is fine on 0.01 boards, a 0.01 value is out of range on the HFX.
  assert.equal(classifyAsusFrame(0x1b7e, fromHex("51 50 00 00 64 00")).verdict, "blocked");
  // Bootloaders, unknown ASUS devices, wrong report type.
  for (const pid of ASUS_BOOTLOADER_PIDS) assert.equal(classifyAsusFrame(pid, K.encodeReadBasic()).why, "bootloader");
  assert.equal(classifyAsusFrame(0x19af, K.encodeReadBasic()).verdict, "blocked");
  assert.equal(asusGuard(0x1c10).classify({ type: "feature", reportId: 0, data: K.encodeReadBasic() }).verdict, "blocked");
  assert.equal(asusGuard(0x1c10).classify({ type: "output", reportId: 0, data: K.encodeReadBasic() }).verdict, "read");
});

test("random frames: anything allowed matches an allowed rule for that family; nothing else gets through", () => {
  const pids = [0x1c10, 0x1d68, 0x1b7e, 0x1c69];
  let allowed = 0;
  for (let n = 0; n < 20000; n++) {
    const f = new Uint8Array(64);
    const first = pick([0x12, 0x25, 0x50, 0x51, 0x71, 0x80, 0xa1, rnd(256)]);
    f[0] = first;
    f[1] = rnd(4) ? pick([0x00, 0x04, 0x05, 0x06, 0x21, 0x2c, 0x31, 0x4f, 0x50, 0x54, 0x55, 0x57, 0x58, 0x59, 0x5c, 0xa4]) : rnd(256);
    const fill = rnd(10);
    for (let i = 2; i < 2 + fill; i++) f[i] = rnd(3) ? rnd(8) : rnd(256);
    for (const pid of pids) {
      const v = classifyAsusFrame(pid, f);
      if (v.verdict === "blocked") continue;
      allowed++;
      const fam = asusGuardFamily(asusModel(pid)!);
      assert.ok(ASUS_RULES.some((r) => r.verdict !== "blocked" && ruleMatches(r, fam, f)));
      assert.ok(!ASUS_RULES.some((r) => r.verdict === "blocked" && ruleMatches(r, fam, f)));
    }
  }
  assert.ok(allowed > 100, `${allowed} random frames were allowed somewhere`);
});

test("asus-frames.txt (the bridge fixture) agrees with the guard", () => {
  const lines = fs.readFileSync(path.join(root, "src/lib/brands/asus/asus-frames.txt"), "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length > 5000);
  for (const line of lines) {
    const [verdict, pid, h] = line.split(" ");
    const f = new Uint8Array(64);
    for (let i = 0; i * 2 < h.length; i++) f[i] = parseInt(h.slice(i * 2, i * 2 + 2).padEnd(2, "0"), 16);
    assert.equal(classifyAsusFrame(parseInt(pid, 16), f).verdict === "blocked" ? "0" : "1", verdict, `stale fixture line: ${line} (run node scripts/brands-allowlist-fixture.ts)`);
  }
  const json = JSON.parse(fs.readFileSync(path.join(root, "src/lib/brands/asus/asus-rules.json"), "utf8"));
  assert.deepEqual(json.rules, JSON.parse(JSON.stringify(ASUS_RULES)), "asus-rules.json is stale");
});
