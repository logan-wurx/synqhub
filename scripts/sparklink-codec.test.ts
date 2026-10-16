// Checks src/lib/brands/sparklink (framing, replies, the model table, the allowlist and its frame fixture).
// No device, no window.
// Run: node --test scripts/sparklink-codec.test.ts
//
// Evidence used:
//  1. Golden frames from the sources' documented bytes: the SDK's checksum rule (protocol-keyboard `Qe`:
//     53 + 92 + length + class + the last data byte) and @openmouse/keyboard-protocol's Kochi codec, which ran the
//     name and mode orders on a Kochi Hummingbird 68.
//  2. The SDK's reply decoders (getCmdSync, getCmd, getDefKey, getFnLayoutKeyRecdata, getGlobalTouchTravel) fed
//     replies built the way the SDK reads them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "../src/lib/brands/sparklink/index.ts";
import { FW_IDS } from "../src/lib/brands/fw19f5/devices.ts";
import { RK_IDS } from "../src/lib/brands/rk-beiying/devices.ts";
import { isBootloader } from "../src/lib/bootloader-ids.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hx = (f: Uint8Array, n = f.length) => Array.from(f.subarray(0, n), (b) => b.toString(16).padStart(2, "0")).join(" ");
const out = (data: Uint8Array) => ({ type: "output" as const, reportId: 0, data });

test("an order frame is [5C, 3, 0, checksum, type, FF, FF], checksum = 0x35 + 0x5C + len + class + the last data byte", () => {
  // OpenMouse's Kochi codec (hardware) builds the name order exactly so: 0x35 + 0x5c + 3 + 0 + 0xff = 0x193 -> 0x93.
  assert.equal(hx(S.orderFrame(0x26), 8), "5c 03 00 93 26 ff ff 00");
  assert.equal(hx(S.orderFrame(0x21), 7), "5c 03 00 93 21 ff ff");
  // The SDK's sync message: [1, 2, 3, 4, FF, FF] in class 1: 53 + 92 + 6 + 1 + 255 = 407 -> 0x97.
  assert.equal(hx(S.syncFrame(), 10), "5c 06 01 97 01 02 03 04 ff ff");
  assert.equal(S.syncFrame().length, 64);
  assert.equal(S.orderFrame(0x26)[3], (0x35 + 0x5c + 3 + 0 + 0xff) & 0xff);
});

test("key frames: reads name the layouts, a write carries one 4-byte group; values go little-endian", () => {
  const r = S.keyReadFrame(0x04, [S.LAYOUT.mode, S.LAYOUT.db0]);
  // The last data byte (the final group's value high byte) counts in the checksum.
  assert.equal(hx(r, 13), "5c 09 23 " + (((0x35 + 0x5c + 9 + 0x23 + 0) & 0xff).toString(16).padStart(2, "0")) + " 00 04 08 00 00 04 04 00 00");
  const w = S.keyWriteFrame(0x04, S.LAYOUT.db0, 1500);
  assert.equal(hx(w, 9), "5c 05 23 " + (((0x35 + 0x5c + 5 + 0x23 + 5) & 0xff).toString(16).padStart(2, "0")) + " 01 04 04 dc 05");
  assert.deepEqual(S.parseRequest(w)?.data, Uint8Array.from([1, 4, 4, 0xdc, 5]));
  assert.throws(() => S.keyReadFrame(0, [4]));
  assert.throws(() => S.keyReadFrame(4, []));
  assert.throws(() => S.keyWriteFrame(4, 4, 0x10000));
  assert.throws(() => S.keyReadFrame(4, new Array(15).fill(4)));
  const g = S.dbWriteFrame({ travel: 2000, pressDead: 200, releaseDead: 300 });
  assert.equal(S.parseRequest(g)?.len, 15);
  assert.deepEqual(Array.from(S.parseRequest(g)!.data), [1, 0, 0, 0xd0, 0x07, 0xc8, 0x00, 0x2c, 0x01, 0, 0, 0, 0, 0, 0]);
  assert.equal(S.parseRequest(S.dbReadFrame())?.data[0], 0);
  assert.equal(hx(S.defKeyFrame(2, 3), 7), "5c 03 2b " + (((0x35 + 0x5c + 3 + 0x2b + 3) & 0xff).toString(16).padStart(2, "0")) + " 00 02 03");
});

function reply(cmd: number, data: number[]): Uint8Array {
  const f = new Uint8Array(64);
  f[0] = 0x5c;
  f[1] = data.length;
  f[2] = cmd | 0x80;
  f.set(data, 4);
  f[3] = S.checksum(f);
  return f;
}

test("replies: header, checksum, failure class; a reply answers its request by order type, key and layout", () => {
  const q = S.orderFrame(0x26);
  const a = reply(0, [0, 0x26, 0x4b, 0x4f, 0x43, 0x48, 0x49]);
  assert.ok(S.answers(q, a));
  assert.ok(!S.answers(q, reply(0, [0, 0x25, 1])), "another order's reply");
  assert.ok(!S.answers(q, reply(35, [0, 0x26])), "another class");
  const bad = new Uint8Array(a);
  bad[3] ^= 1;
  assert.equal(S.parseReply(bad), null);
  assert.equal(S.parseReply(a)?.cmd, 0);
  const refused = new Uint8Array(64);
  refused.set([0x5c, 1, 0xff, 0, 0]);
  refused[3] = S.checksum(refused);
  assert.equal(S.parseReply(refused)?.failed, true);
  assert.ok(S.answers(q, refused), "a refusal ends the wait");
  const k = S.keyReadFrame(4, [S.LAYOUT.mode]);
  assert.ok(S.answers(k, reply(35, [0, 4, 8, 0x10, 0])));
  assert.ok(S.answers(k, reply(35, [0, 4, 0xff, 0xff, 0xff])), "a layout the key lacks echoes 0xFF");
  assert.ok(!S.answers(k, reply(35, [0, 5, 8, 0x10, 0])), "another key");
});

test("decoders read the replies the way the SDK does", () => {
  const sync = new Array(56).fill(0);
  sync.splice(1, 4, 0x01, 0x00, 0x30, 0x00); // board id 0x00300001
  sync[5] = 123; // V1.2.3
  const put = (at: number, s: string) => [...s].forEach((c, i) => (sync[at + i] = c.charCodeAt(0)));
  put(9, "SN0000000000001");
  put(26, "APP_1.2.34");
  put(43, "Oct 14 2026");
  const info = S.decodeSync(Uint8Array.from(sync));
  assert.equal(info.boardId, 0x00300001);
  assert.equal(info.versionString, "V1.2.3");
  assert.equal(info.serial, "SN0000000000001");
  assert.equal(info.appVersion, "APP_1.2.34");
  assert.equal(info.buildDate, "Oct 14 2026");
  assert.equal(info.bootloader, false);
  put(26, "Boot_1.0.0.0");
  assert.equal(S.decodeSync(Uint8Array.from(sync)).bootloader, true, "a sync reply starting with Boot is the bootloader");

  assert.equal(S.decodeProtocolVersion(Uint8Array.from([0, 1, 0x12, 0x01])), "1.1.2");
  const name = [0, 0x26, ...[..."KOCHI68"].map((c) => c.charCodeAt(0)), 0, 0];
  assert.equal(S.decodeName(Uint8Array.from(name)), "KOCHI68");
  assert.deepEqual(S.decodePrecision(Uint8Array.from([0, 0x25, 10, 100, 0, 0xac, 0x0d])), { stepMm: 0.01, minMm: 0.1, maxMm: 3.5 });
  assert.equal(S.decodeModeQuery(Uint8Array.from([0, 0x21, 1, 255])), true);
  assert.equal(S.decodeModeQuery(Uint8Array.from([0, 0x21, 0, 255])), false);
  assert.equal(S.decodeModeQuery(Uint8Array.from([0, 0x21, 255, 255])), null);
  assert.equal(S.decodeRate(Uint8Array.from([0, 0x50, 3])), 1000);
  assert.equal(S.decodeRate(Uint8Array.from([0, 0x50, 9])), null);

  const d = Uint8Array.from([0, 4, 4, 0xdc, 5, 4, 8, 0x20, 0, 4, 20, 0xff, 0xff, 0, 21, 0xff, 0, 7, 8, 0xff, 0xff, 9, 0xff, 0xff, 0xff]);
  assert.deepEqual(S.decodeKeyEntries(d), [
    { key: 4, layout: 4, value: 1500 },
    { key: 4, layout: 8, value: 0x20 },
  ], "groups with value 0xFFFF or layout 0xFF are 'not available', key 0 is skipped");
  assert.deepEqual(S.decodeMode(S.modeValue("rt")), { touch: "rt", adv: 0 });
  assert.deepEqual(S.decodeMode(S.modeValue("single", 3)), { touch: "single", adv: 3 });
  assert.deepEqual(S.decodeMode(0), { touch: "global", adv: 0 });
  assert.deepEqual(S.decodeDb(Uint8Array.from([0, 0, 0, 0xd0, 0x07, 0xc8, 0, 0x2c, 0x01])), { travel: 2000, pressDead: 200, releaseDead: 300 });

  const rows = new Array(46).fill(0);
  rows[1] = 1;
  rows[23] = 2;
  rows[2 + 0] = 41;
  rows[2 + 13] = 42;
  rows[24 + 0] = 43;
  assert.deepEqual(S.decodeDefKeys(Uint8Array.from(rows)), [
    { row: 1, col: 0, value: 41 },
    { row: 1, col: 13, value: 42 },
    { row: 2, col: 0, value: 43 },
  ]);
});

test("the allowlist: the reads, the Windows / Mac switch and in-range key and travel writes pass; everything else is refused", () => {
  const verdict = (f: Uint8Array) => S.classifyFrame(f).verdict;
  for (const t of S.READ_ORDERS) assert.equal(verdict(S.orderFrame(t)), "read", `order ${t}`);
  assert.equal(verdict(S.orderFrame(S.ORDER.setWin)), "write");
  assert.equal(verdict(S.orderFrame(S.ORDER.setMac)), "write");
  assert.equal(verdict(S.syncFrame()), "read");
  assert.equal(verdict(S.defKeyFrame(0, 1)), "read");
  assert.equal(verdict(S.dbReadFrame()), "read");
  assert.equal(verdict(S.keyReadFrame(4, S.READ_LAYOUTS)), "read");
  assert.equal(verdict(S.keyWriteFrame(4, S.LAYOUT.db0, 1500)), "write");
  assert.equal(verdict(S.keyWriteFrame(4, S.LAYOUT.mode, S.modeValue("rt"))), "write");
  assert.equal(verdict(S.keyWriteFrame(4, S.LAYOUT.dp, 0)), "write", "a zero dead zone");
  assert.equal(verdict(S.dbWriteFrame({ travel: 2000, pressDead: 0, releaseDead: 0 })), "write");
  // Never.
  const blocked = (f: Uint8Array, why?: string) => {
    const v = S.classifyFrame(f);
    assert.equal(v.verdict, "blocked");
    if (why && v.verdict === "blocked") assert.equal(v.why, why);
  };
  blocked(S.orderFrame(S.ORDER.factoryReset), "factory-reset");
  blocked(S.orderFrame(S.ORDER.calibrationStart), "calibration");
  blocked(S.orderFrame(S.ORDER.calibrationClose), "calibration");
  blocked(S.orderFrame(S.ORDER.clearCalibration), "calibration");
  blocked(S.orderFrame(S.ORDER.eraseMacroStorage), "profile-wipe");
  blocked(S.orderFrame(S.ORDER.savingParameter));
  blocked(S.orderFrame(S.ORDER.topDeadSwitch));
  for (const cmd of [8, 9, 10, 11, 12, 13, 14]) blocked(S.frame(cmd, [1, 2, 3, 4]), "firmware");
  blocked(S.frame(48, [1, 2, 3, 4]), "firmware");
  blocked(S.frame(49, [1, 2, 3, 4]), "firmware");
  for (const cmd of [18, 32, 33, 36, 37, 38, 39, 40, 44, 45, 24, 25, 42]) blocked(S.frame(cmd, [0, 1, 2]));
  blocked(S.keyWriteFrame(4, S.LAYOUT.axis, 1), "calibration");
  blocked(S.keyWriteFrame(4, S.LAYOUT.fn0, 0x2a), undefined);
  blocked(S.keyWriteFrame(4, S.LAYOUT.db1, 100));
  blocked(S.keyWriteFrame(4, S.LAYOUT.db0, 4001));
  blocked(S.keyWriteFrame(4, S.LAYOUT.db0, 0), undefined);
  blocked(S.keyWriteFrame(4, S.LAYOUT.mode, S.modeValue("single", 3)));
  blocked(S.keyWriteFrame(4, S.LAYOUT.mode, 0x30));
  blocked(S.keyReadFrame(4, [S.LAYOUT.axis]));
  blocked(S.keyReadFrame(4, [S.LAYOUT.fn0]));
  blocked(S.dbWriteFrame({ travel: 0, pressDead: 0, releaseDead: 0 }));
  blocked(S.dbWriteFrame({ travel: 4001, pressDead: 0, releaseDead: 0 }));
  // Shape: length, header, checksum, padding, report.
  blocked(S.orderFrame(0x26).subarray(0, 63));
  const sum = new Uint8Array(S.orderFrame(0x26));
  sum[3] ^= 1;
  blocked(sum);
  const pad = new Uint8Array(S.orderFrame(0x26));
  pad[40] = 1;
  blocked(pad);
  assert.equal(S.SPARKLINK_GUARD.classify({ type: "feature", reportId: 0, data: S.orderFrame(0x26) }).verdict, "blocked");
  assert.equal(S.SPARKLINK_GUARD.classify({ type: "output", reportId: 4, data: S.orderFrame(0x26) }).verdict, "blocked");
});

test("a session's guard narrows to the keys the board reported and to reads when writes are off", () => {
  let ctx: S.GuardContext = { keys: null, writes: false };
  const g = S.guardFor(() => ctx);
  const c = (f: Uint8Array) => g.classify(out(f)).verdict;
  assert.equal(c(S.syncFrame()), "read");
  assert.equal(c(S.orderFrame(0x26)), "read");
  assert.equal(c(S.defKeyFrame(0, 1)), "read");
  assert.equal(c(S.keyReadFrame(4, [S.LAYOUT.mode])), "blocked", "no key reads before the key table");
  assert.equal(c(S.dbReadFrame()), "blocked");
  ctx = { keys: new Set([4, 5]), writes: false };
  assert.equal(c(S.keyReadFrame(4, [S.LAYOUT.mode])), "read");
  assert.equal(c(S.keyReadFrame(6, [S.LAYOUT.mode])), "blocked", "a key the board didn't report");
  assert.equal(c(S.keyWriteFrame(4, S.LAYOUT.db0, 1500)), "blocked", "writes are off");
  assert.equal(c(S.orderFrame(S.ORDER.setMac)), "blocked");
  ctx = { keys: new Set([4, 5]), writes: true };
  assert.equal(c(S.keyWriteFrame(4, S.LAYOUT.db0, 1500)), "write");
  assert.equal(c(S.keyWriteFrame(6, S.LAYOUT.db0, 1500)), "blocked");
  assert.equal(c(S.dbWriteFrame({ travel: 1500, pressDead: 0, releaseDead: 0 })), "write");
});

test("the model table: unique ids on the SparkLink vendor ids, Kochi included, no id another driver owns, no bootloader id", () => {
  const ids = S.SPARKLINK_IDS.map(([v, p]) => `${v}:${p}`);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 56);
  assert.deepEqual([...new Set(S.SPARKLINK_IDS.map(([v]) => v))].sort(), [...S.SPARKLINK_VIDS].sort());
  assert.ok(S.sparklinkModel(0x1ca2, 0x0901), "Kochi Hummingbird 68");
  assert.equal(S.sparklinkModel(0x1ca2, 0x0901)?.brand, "Kochi");
  assert.equal(S.sparklinkModel(0x1ca2, 0x1619)?.name, "M75HE (UK)");
  assert.equal(S.sparklinkModel(0x1ca2, 0x1619)?.he, true);
  assert.equal(S.sparklinkModel(0x1ca5, 0x0401)?.brand, "AULA");
  assert.equal(S.sparklinkModel(0x1ca6, 0x3001), null, "the neighbouring 1CA6 / 0xFFB0 family is not this one");
  assert.ok(S.SPARKLINK_MODELS.every((m) => m.tier === "experimental"), "every id starts experimental");
  assert.ok(S.SPARKLINK_MODELS.every((m) => m.channel.usagePage === 0xffa0 && m.channel.usage === 1 && m.channel.length === 64));
  const other = new Set<string>([...FW_IDS, ...RK_IDS].map(([v, p]) => `${v}:${p}`));
  for (const id of ids) assert.ok(!other.has(id), `${id} is another brand driver's`);
  for (const [v, p] of S.SPARKLINK_IDS) assert.equal(isBootloader(v, p, null), false, `${v.toString(16)}:${p.toString(16)}`);
  assert.ok(S.isKochi(0x1ca2, 0x0901) && !S.isKochi(0x1ca2, 0x0902));
});

test("the frame fixture agrees with the guard line for line", () => {
  const lines = readFileSync(join(root, "src/lib/brands/sparklink/sparklink-frames.txt"), "utf8").split("\n").filter((l) => l.trim());
  assert.ok(lines.length >= 9000);
  let allowed = 0;
  for (const line of lines) {
    const [v, hex = ""] = line.split(" ");
    const f = new Uint8Array(64);
    f.set(Array.from({ length: Math.ceil(hex.length / 2) }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)));
    const ok = S.SPARKLINK_GUARD.classify(out(f)).verdict !== "blocked";
    assert.equal(ok, v === "1", hex);
    if (ok) allowed++;
  }
  assert.ok(allowed > 200 && allowed < lines.length / 2, String(allowed));
});
