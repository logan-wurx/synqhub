// CORSAIR Bragi + Sabre v2 codecs and allowlists (src/lib/brands/corsair), no device, no window:
//   node --test scripts/corsair-codec.test.ts
//
//  - the Web Hub device table and families;
//  - golden frames: the worked examples composed from Web Hub / FW Updater code (docs/devices/corsair-bragi.md);
//  - file formats round-trip;
//  - the allowlist: every frame SYNQ builds is allowed; firmware, bootloader, pairing, reset and
//    calibration commands are refused; data can only be written into an open profile sub-file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WEBHUB_DEVICES } from "../src/lib/brands/corsair/devices.generated.ts";
import { CORSAIR_MODELS, corsairModel, corsairPids } from "../src/lib/brands/corsair/devices.ts";
import * as B from "../src/lib/brands/corsair/bragi.ts";
import { BragiGuardState, classifyBragiFrame, fileWritable, SET_ALLOWED } from "../src/lib/brands/corsair/guard.ts";
import { classifySabreFrame, pairOf, sabreCommand, sabreDpiFromRow, sabreDpiRow, sabreRead, sabreWrite, SABRE_ADDR } from "../src/lib/brands/corsair/sabre.ts";
import { hex } from "../src/lib/brands/types.ts";

const strip = (f: Uint8Array) => {
  let end = f.length;
  while (end > 0 && f[end - 1] === 0) end--;
  return hex(f.subarray(0, end));
};
let seed = 99;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed >>> 8) % n;
};
const v15 = (session = 0x2a): B.FrameOpts => ({ framing: "v15", session });
const v1: B.FrameOpts = { framing: "v1" };

test("device table: 33 Web Hub devices, families and framing", () => {
  assert.equal(WEBHUB_DEVICES.length, 33);
  assert.deepEqual(corsairPids("kb-he").sort(), [0x2b0e, 0x2b1a, 0x2b30, 0x2b31, 0x2b54, 0x2b5b].sort());
  assert.deepEqual(corsairPids("mouse-sabre").sort(), [0x2b25, 0x2b28, 0x2b29, 0x2b2a, 0x2b34, 0x2b35].sort());
  assert.equal(corsairModel(0x2b0e)!.framing, "v15");
  assert.equal(corsairModel(0x2b31)!.framing, "v1", "Web Hub drives the Clipper Pro Mini 60 with 1.0 framing");
  assert.equal(corsairModel(0x2b30)!.framing, "v15");
  assert.equal(corsairModel(0x2b2e)!.framing, "v1");
  assert.equal(corsairModel(0x2b28)!.framing, null);
  assert.deepEqual(corsairModel(0x2b0e)!.actuationMm, [0.1, 4]);
  assert.deepEqual(corsairModel(0x2b31)!.actuationMm, [0.2, 3.8]);
  assert.deepEqual(corsairModel(0x2b30)!.actuationMm, [0.1, 3.5]);
  assert.equal(corsairModel(0x1b2d), null, "older iCUE-only gear is never touched");
  assert.equal(CORSAIR_MODELS.size, 33);
});

test("frames match the worked examples (Vanguard Pro 96 v1.5, Clipper v1.0)", () => {
  assert.equal(strip(B.encodeSet(v15(0x2a), B.PROP.operatingMode, 2)), "00 01 2a 01 03 00 02");
  assert.equal(strip(B.encodeGet(v15(0x2a), B.PROP.activeProfile)), "00 01 2a 02 6e");
  assert.equal(strip(B.encodeOpenFile(v15(0x2a), B.FILE.profilesList)), "00 01 2a 0d 00 0f");
  assert.equal(strip(B.encodeDescribeBuffer(v15(0x2a))), "00 01 2a 09");
  assert.equal(strip(B.encodeReadBuffer(v15(0x2a))), "00 01 2a 08");
  assert.equal(strip(B.encodeUnbindBuffer(v15(0x2a))), "00 01 2a 05 01");
  assert.equal(strip(B.encodeSessionStart([1, 2, 3, 4])), "00 01 00 1b 01 01 02 03 04");
  assert.equal(strip(B.encodeSessionStop(0x2a)), "00 01 2a 1b 02 00 00 00 00 2a");
  assert.equal(strip(B.encodeSet(v1, B.PROP.operatingMode, 2)), "08 01 03 00 02");
  assert.equal(strip(B.encodeSet({ framing: "v1", addr: 1 }, B.PROP.pollingRate, 4)), "09 01 01 00 04");
  assert.equal(strip(B.encodeGet(v15(1), B.PROP.bragiVersion)), "00 01 01 02 05 01");
  // A 345-byte file (114 keys): first frame carries 55 bytes on v1.5 / 57 on v1.0, then 59 / 61.
  const data = Uint8Array.from({ length: 345 }, (_, i) => (i % 250) + 1);
  const w15 = B.encodeWriteFile(v15(0x2a), data);
  assert.equal(hex(w15[0].subarray(0, 9)), "00 01 2a 06 00 59 01 00 00");
  assert.deepEqual(Array.from(w15[0].subarray(9, 64)), Array.from(data.subarray(0, 55)));
  assert.equal(hex(w15[1].subarray(0, 5)), "00 01 2a 07 00");
  assert.equal(w15.length, 1 + Math.ceil((345 - 55) / 59));
  const w1 = B.encodeWriteFile(v1, data);
  assert.equal(hex(w1[0].subarray(0, 7)), "08 06 00 59 01 00 00");
  assert.equal(w1.length, 1 + Math.ceil((345 - 57) / 61));
  // Reassembling the chunks gives the file back.
  const back = [...w15[0].subarray(9), ...w15.slice(1).flatMap((f) => [...f.subarray(5)])].slice(0, 345);
  assert.deepEqual(back, Array.from(data));
});

test("replies, sessions and file formats", () => {
  const r = new Uint8Array(64);
  r.set([0x00, 0x00, 0x2a, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00]);
  const rep = B.decodeReply("v15", r);
  assert.deepEqual([rep.cmd, rep.status, B.u32le(rep.data)], [0x02, 0, 4]);
  assert.ok(B.isReplyTo("v15", B.encodeGet(v15(), 1), r));
  const s = new Uint8Array(64);
  s.set([0x00, 0x00, 0x00, 0x1b, 0x00, 1, 2, 3, 4, 0x2a]);
  assert.equal(B.decodeSessionReply(s, [1, 2, 3, 4]), 0x2a);
  assert.throws(() => B.decodeSessionReply(s, [9, 9, 9, 9]), /nonce/);
  const expired = new Uint8Array(64);
  expired.set([0x00, 15, 0x00, 0x02]);
  assert.ok(B.needsSession("v15", expired));
  // Primary actuation file for keys A..C at 1.5 mm, header 0x0030 (Web Hub default RL 48).
  const press: B.DistanceFile = { header: 0x30, entries: [4, 5, 6].map((key) => ({ key, flags: 1, distance: 15 })) };
  assert.equal(hex(B.encodeDistanceFile(press)), "30 00 03 04 01 0f 05 01 0f 06 01 0f");
  assert.deepEqual(B.decodeDistanceFile(B.encodeDistanceFile(press)), press);
  // Rapid trigger entry for W (26): on, start 1.5 mm, press 0.1, release 0.1 -> 1A 01 0F 01 01.
  const rt: B.RapidTriggerFile = { header: 0x36, entries: [{ key: 26, flags: 1, deadzone: 15, press: 1, release: 1 }] };
  assert.equal(hex(B.encodeRapidTriggerFile(rt)), "36 00 01 1a 01 0f 01 01");
  assert.deepEqual(B.decodeRapidTriggerFile(B.encodeRapidTriggerFile(rt)), rt);
  const props: B.PropertiesFile = { magic: B.PROPERTIES_MAGIC, values: new Map([[251, new Uint8Array([1, 0, 0, 0])], [252, new Uint8Array([1, 0, 0, 0])]]) };
  const enc = B.encodePropertiesFile(B.withPropU32(props, B.PROP.flashTapMode, 2));
  assert.equal(hex(enc), "3d d4 02 00 fb 00 01 00 00 00 fc 00 02 00 00 00");
  assert.equal(B.propU32(B.decodePropertiesFile(enc), 252), 2);
  assert.deepEqual(B.decodeProfilesList(Uint8Array.from([0x13, 0x00, 0x02, 0x00, 0x60, 0x6d, 0x61, 0x6d])), [0x6d60, 0x6d61]);
  // Profile file: magic, cookie, 12 ids, nameLength, name + NUL, 4 more ids.
  const name = "Default";
  const pf = new Uint8Array(32 + name.length + 1 + 8);
  const dv = new DataView(pf.buffer);
  dv.setUint16(0, 0xf11e, true);
  dv.setUint32(2, 1700000000, true);
  [0x6d70, 0x6d71, 0x6d72, 0x6d73, 0x6d74, 0x6d75, 0x6d76, 0x6d77, 0x6d78, 0x6d79, 0x6d7a, 0x6d7b].forEach((id, i) => dv.setUint16(6 + 2 * i, id, true));
  dv.setUint16(30, name.length, true);
  pf.set(new TextEncoder().encode(name), 32);
  const after = 33 + name.length;
  [0x6d7c, 0x6d7d, 0x6d7e, 0x6d7f].forEach((id, i) => dv.setUint16(after + 2 * i, id, true));
  const p = B.decodeProfileFile(pf);
  assert.deepEqual([p.properties, p.primaryActuation, p.name, p.primaryReset, p.rapidTrigger], [0x6d71, 0x6d79, "Default", 0x6d7c, 0x6d7e]);
});

// ---------------------------------------------------------------------------------------------
test("allowlist: every frame SYNQ builds is allowed", () => {
  for (const framing of ["v1", "v15"] as const) {
    const o: B.FrameOpts = { framing, session: 7 };
    for (const family of ["kb-he", "mouse-bragi"] as const) {
      const g = new BragiGuardState(framing, family);
      g.session = 7;
      const ok = (f: Uint8Array) => {
        const v = g.classify(f);
        assert.notEqual(v.verdict, "blocked", `${framing}/${family} ${strip(f)}: ${v.what} ${v.reason ?? ""}`);
        g.observe(f);
      };
      for (const [prop, rule] of SET_ALLOWED) if (rule.families.includes(family)) for (const value of [rule.min, rule.max]) ok(B.encodeSet(o, prop, value));
      for (const prop of [0x01, 0x02, 0x03, 0x0f, 0x13, 0x36, 0x6e, 0x105]) ok(B.encodeGet(o, prop));
      ok(B.encodePing(o));
      if (framing === "v15") ok(B.encodeSessionStart([1, 2, 3, 4]));
      // Read the profiles list, then write a profile sub-file.
      ok(B.encodeOpenFile(o, B.FILE.profilesList));
      ok(B.encodeDescribeBuffer(o));
      ok(B.encodeReadBuffer(o));
      ok(B.encodeUnbindBuffer(o));
      const file = 28000 + rnd(2000);
      ok(B.encodeOpenFile(o, file));
      for (const f of B.encodeWriteFile(o, Uint8Array.from({ length: 300 }, () => rnd(256)))) ok(f);
      ok(B.encodeUnbindBuffer(o));
      if (framing === "v15") ok(B.encodeSessionStop(7));
    }
  }
});

test("allowlist: firmware, bootloader, reset, pairing and calibration are refused", () => {
  for (const framing of ["v1", "v15"] as const) {
    const o: B.FrameOpts = { framing, session: 7 };
    const ctx = { framing, family: "kb-he" as const, openFile: null, session: 7 };
    const why = (f: Uint8Array, c: Partial<typeof ctx> | { openFile: number } = {}) => classifyBragiFrame({ ...ctx, ...c }, f).why;
    assert.equal(why(B.encodeSet(o, B.PROP.operatingMode, B.MODE.bootloader)), "bootloader");
    assert.equal(why(B.encodeSet(o, B.PROP.operatingMode, B.MODE.mcuBootloader)), "bootloader");
    for (const m of [4, 6, 7]) assert.equal(why(B.encodeSet(o, B.PROP.operatingMode, m)), "identity");
    for (const file of [B.FILE.firmware, B.FILE.secondaryFirmware, B.FILE.screenFirmware, B.FILE.dialFirmware]) assert.equal(why(B.encodeOpenFile(o, file)), "firmware");
    for (const file of [B.FILE.pairingId, B.FILE.encryptionKey, B.FILE.bluetoothAddress, B.FILE.pairingIdV2]) assert.equal(why(B.encodeOpenFile(o, file)), "pairing");
    assert.equal(why(B.encodeOpenFile(o, B.FILE.switchSettings)), "calibration");
    assert.equal(classifyBragiFrame(ctx, B.encodeOpenFile(o, 31000)).verdict, "blocked", "Web Hub identity file");
    assert.equal(why(B.frame(o, B.CMD.applyFirmware, [1, 3, 0, 0])), "firmware");
    assert.equal(why(B.frame(o, B.CMD.applyFirmwareExtended, [0, 1, 3, 0])), "firmware");
    assert.equal(why(B.frame(o, B.CMD.factoryReset, [0])), "factory-reset");
    assert.equal(why(B.frame(o, B.CMD.factoryReset)), "factory-reset");
    assert.equal(why(B.frame(o, B.CMD.pairing, [1])), "pairing");
    assert.equal(why(B.frame(o, B.CMD.ping, [1, 0, 0])), "pairing", "Web Hub pairing = 0x12 with payload");
    assert.equal(why(B.frame(o, B.CMD.calibration, [1, 8])), "calibration", "magnetic-switch calibration");
    assert.equal(why(B.frame(o, B.CMD.createFile, [0x60, 0x6d])), "profile-wipe");
    assert.equal(why(B.frame(o, B.CMD.deleteFile, [0x60, 0x6d])), "profile-wipe");
    // Writes need an open, writable file.
    const data = B.encodeWriteFile(o, new Uint8Array(10))[0];
    assert.equal(why(data), "firmware", "no open file");
    assert.equal(why(data, { openFile: B.FILE.firmware }), "firmware");
    assert.equal(why(data, { openFile: 31000 }), "firmware", "identity file");
    assert.equal(classifyBragiFrame({ ...ctx, openFile: 0x6d79 }, data).verdict, "write");
    // Unlisted SETs / GETs and wrong families.
    assert.equal(classifyBragiFrame(ctx, B.encodeSet(o, 0x3b, 1)).verdict, "blocked", "surface preset mode");
    assert.equal(classifyBragiFrame(ctx, B.encodeSet(o, B.PROP.dpiStage1, 800)).verdict, "blocked", "mouse property on a keyboard");
    assert.equal(classifyBragiFrame({ ...ctx, family: "mouse-bragi" }, B.encodeSet(o, B.PROP.brightness, 500)).verdict, "blocked");
    assert.equal(classifyBragiFrame(ctx, B.encodeSet(o, B.PROP.pollingRate, 8)).verdict, "blocked", "polling code out of range");
    assert.equal(classifyBragiFrame(ctx, B.encodeGet(o, 0x3e)).verdict, "blocked", "unlisted GET");
    assert.equal(classifyBragiFrame({ ...ctx, family: "mouse-sabre" }, B.encodePing(o)).verdict, "blocked");
  }
  // Sessions: only ours can be stopped; v1 devices take none.
  const c15 = { framing: "v15" as const, family: "kb-he" as const, openFile: null, session: 7 };
  assert.equal(classifyBragiFrame(c15, B.encodeSessionStop(9)).verdict, "blocked");
  assert.equal(classifyBragiFrame({ ...c15, framing: "v1" }, B.encodeSessionStart([1, 2, 3, 4])).verdict, "blocked");
  assert.ok(!fileWritable(B.FILE.profilesList));
});

test("allowlist: random frames never reach a firmware / reset / pairing / calibration command", () => {
  const dangerous = new Set<number>([B.CMD.calibration, B.CMD.createFile, B.CMD.deleteFile, B.CMD.factoryReset, B.CMD.applyFirmware, B.CMD.applyFirmwareExtended, B.CMD.pairing]);
  let allowed = 0;
  for (let n = 0; n < 30000; n++) {
    const framing = rnd(2) ? "v1" : "v15";
    const f = new Uint8Array(64);
    if (framing === "v1") f.set([0x08 | rnd(2), rnd(3) ? [0x01, 0x02, 0x0d, 0x06, 0x0f, 0x10, 0x12][rnd(7)] : rnd(256)]);
    else f.set([rnd(2), 1, rnd(3), rnd(3) ? [0x01, 0x02, 0x0d, 0x06, 0x0f, 0x10, 0x12, 0x1b][rnd(8)] : rnd(256)]);
    const p = framing === "v1" ? 2 : 4;
    const fill = rnd(8);
    for (let i = p; i < p + fill; i++) f[i] = rnd(2) ? rnd(8) : rnd(256);
    const openFile = rnd(3) ? null : [3, 5, 6, 0x0f, 28100, 31000][rnd(6)];
    const v = classifyBragiFrame({ framing, family: rnd(2) ? "kb-he" : "mouse-bragi", openFile }, f);
    if (v.verdict === "blocked") continue;
    allowed++;
    const cmd = f[framing === "v1" ? 1 : 3];
    assert.ok(!dangerous.has(cmd), `${strip(f)} allowed`);
    if (cmd === B.CMD.set && (f[p] | (f[p + 1] << 8)) === B.PROP.operatingMode) assert.ok(f[p + 2] === 1 || f[p + 2] === 2);
    if (cmd === B.CMD.writeBegin || cmd === B.CMD.write) assert.ok(fileWritable(openFile));
    if (cmd === B.CMD.ping) assert.ok(f.subarray(p).every((x) => x === 0));
  }
  assert.ok(allowed > 50, `${allowed}`);
});

// ---------------------------------------------------------------------------------------------
test("Sabre v2 Pro EEPROM frames, DPI codes and allowlist", () => {
  const read = sabreRead(SABRE_ADDR.polling, 2);
  assert.equal(strip(read.subarray(0, 15)), "08 00 00 00 02");
  assert.equal((0x08 + read.reduce((s, b) => s + b, 0)) & 0xff, 0x55, "report id + frame sum to 0x55");
  assert.equal(classifySabreFrame(read).verdict, "read");
  assert.equal(classifySabreFrame(sabreWrite(SABRE_ADDR.polling, pairOf(64))).verdict, "write");
  assert.equal(classifySabreFrame(sabreWrite(SABRE_ADDR.polling, pairOf(2))).verdict, "blocked", "polling code not offered");
  assert.equal(classifySabreFrame(sabreWrite(SABRE_ADDR.polling, [64, 0])).verdict, "blocked", "bad value/check pair");
  assert.equal(classifySabreFrame(sabreWrite(SABRE_ADDR.lod, pairOf(3))).verdict, "write");
  assert.equal(classifySabreFrame(sabreWrite(0xdf, pairOf(1))).why, "calibration");
  assert.equal(classifySabreFrame(sabreWrite(0xdb, [1, 2, 3])).why, "calibration");
  assert.equal(classifySabreFrame(sabreCommand(0x09)).why, "factory-reset");
  assert.equal(classifySabreFrame(sabreCommand(0x01)).why, "firmware");
  assert.equal(classifySabreFrame(sabreWrite(0x60, [1, 2, 3, 4])).verdict, "blocked", "button rows are not writable");
  const bad = sabreRead(0, 2);
  bad[15] ^= 1;
  assert.equal(classifySabreFrame(bad).verdict, "blocked");
  for (const dpi of [100, 400, 800, 12800, 12850, 25600, 25650, 33000]) {
    const row = sabreDpiRow(dpi);
    assert.equal(sabreDpiFromRow(row), dpi, `dpi ${dpi} -> ${hex(row)}`);
    assert.equal(classifySabreFrame(sabreWrite(SABRE_ADDR.dpiStage0 + 4, row)).verdict, "write");
  }
  assert.deepEqual(sabreDpiRow(800), [15, 15, 0, (0x55 - 30) & 0xff]);
  assert.equal(sabreDpiRow(12850)[2], 0x44);
  assert.equal(sabreDpiRow(25650)[2], 0x88);
});

test("corsair-frames.txt (the bridge fixture) agrees with the guards", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const lines = fs.readFileSync(path.join(root, "src/lib/brands/corsair/corsair-frames.txt"), "utf8").split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 3000);
  for (const line of lines) {
    const [verdict, pidHex, open, h] = line.split(" ");
    const m = CORSAIR_MODELS.get(parseInt(pidHex, 16))!;
    const f = new Uint8Array(m.family === "mouse-sabre" ? 16 : 64);
    for (let i = 0; i * 2 < h.length; i++) f[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    const v = m.family === "mouse-sabre" ? classifySabreFrame(f) : classifyBragiFrame({ framing: m.framing!, family: m.family, openFile: open === "-" ? null : Number(open) }, f);
    assert.equal(v.verdict === "blocked" ? "0" : "1", verdict, `stale fixture line: ${line} (run node scripts/brands-allowlist-fixture.ts)`);
  }
});
