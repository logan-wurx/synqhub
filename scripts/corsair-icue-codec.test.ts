// Checks the Corsair iCUE (BRAGI) encoders and the safety guard.
// Run (no device, no window): node --test scripts/corsair-icue-codec.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as P from "../src/lib/brands/corsair-icue/protocol.ts";
import { CorsairIcueGuard } from "../src/lib/brands/corsair-icue/guard.ts";
import { CORSAIR_ICUE_DEVICES, corsairIcueDevice } from "../src/lib/brands/corsair-icue/devices.ts";

const guard = new CorsairIcueGuard();
const classify = (f: P.BragiFrame) => guard.classify({ type: "output", reportId: f.reportId, data: f.data });

// ---------------------------------------------------------------------------------------------
// Encoders (golden, from OpenRGB CorsairPeripheralV2Controller)
// ---------------------------------------------------------------------------------------------

test("every frame is 64 data bytes on report id 0 with a wired/wireless write id", () => {
  for (const f of [P.getFirmware(), P.getPid(), P.setRenderMode(P.MODE.direct), P.startLightingTx(P.ADDR.lightCtrl2), P.ledBlockFirst(10, [1])]) {
    assert.equal(f.reportId, 0);
    assert.equal(f.data.length, 64);
    assert.ok(f.data[0] === 0x08 || f.data[0] === 0x09);
  }
  assert.equal(P.getFirmware("wireless").data[0], 0x09);
});

test("reads carry CMD_GET and the right address", () => {
  assert.deepEqual([...P.getFirmware().data.subarray(0, 3)], [0x08, 0x02, 0x11]);
  assert.deepEqual([...P.getPid().data.subarray(0, 3)], [0x08, 0x02, 0x12]);
  assert.deepEqual([...P.getLayout().data.subarray(0, 3)], [0x08, 0x02, 0x41]);
});

test("setRenderMode / lighting transaction match the OpenRGB layout", () => {
  assert.deepEqual([...P.setRenderMode(P.MODE.direct).data.subarray(0, 5)], [0x08, 0x01, 0x03, 0x00, 0x12]);
  assert.deepEqual([...P.startLightingTx(P.ADDR.lightCtrl2).data.subarray(0, 4)], [0x08, 0x0d, 0x00, 0x22]);
  assert.deepEqual([...P.stopLightingTx(P.ADDR.lightCtrl2).data.subarray(0, 4)], [0x08, 0x05, 0x01, 0x22]);
  const blk = P.ledBlockFirst(300, [0xaa, 0xbb]);
  assert.deepEqual([...blk.data.subarray(0, 5)], [0x08, 0x06, 0x00, 300 & 0xff, 300 >> 8]);
  assert.deepEqual([...blk.data.subarray(7, 9)], [0xaa, 0xbb]);
});

// ---------------------------------------------------------------------------------------------
// Guard: allowed
// ---------------------------------------------------------------------------------------------

test("identity/layout reads, render mode, and the lighting transaction are allowed", () => {
  assert.equal(classify(P.getFirmware()).verdict, "read");
  assert.equal(classify(P.getPid()).verdict, "read");
  assert.equal(classify(P.getLayout()).verdict, "read");
  assert.equal(classify(P.lightingProbe(P.ADDR.lightCtrl2)).verdict, "read");
  assert.equal(classify(P.setRenderMode(P.MODE.direct)).verdict, "write");
  assert.equal(classify(P.startLightingTx(P.ADDR.lightCtrl1)).verdict, "write");
  assert.equal(classify(P.startLightingTx(P.ADDR.lightCtrl2)).verdict, "write");
  assert.equal(classify(P.stopLightingTx(P.ADDR.lightCtrl2)).verdict, "write");
  assert.equal(classify(P.ledBlockFirst(300, [1, 2, 3])).verdict, "write");
  assert.equal(classify(P.ledBlockNext([4, 5])).verdict, "write");
});

// ---------------------------------------------------------------------------------------------
// Guard: blocked (firmware / reset / pairing / actuation / device-mode / unknown)
// ---------------------------------------------------------------------------------------------

const mk = (bytes: number[]): P.BragiFrame => {
  const d = new Uint8Array(64);
  d.set(bytes);
  return { reportId: 0, data: d };
};

test("every command byte that isn't on the list is refused", () => {
  for (let cmd = 0; cmd <= 0x1f; cmd++) {
    if ([P.CMD.get, P.CMD.set, P.CMD.startTx, P.CMD.stopTx, P.CMD.blockW1, P.CMD.blockWn].includes(cmd)) continue;
    assert.equal(classify(mk([0x08, cmd, 0x11])).verdict, "blocked", `cmd 0x${cmd.toString(16)}`);
  }
});

test("GET of an unlisted address and SET of a non-render-mode address are refused (profile/actuation writes)", () => {
  for (const addr of [0x00, 0x05, 0x13, 0x30, 0x40, 0x60, 0x80]) assert.equal(classify(mk([0x08, P.CMD.get, addr])).verdict, "blocked", `GET 0x${addr.toString(16)}`);
  for (const addr of [0x00, 0x11, 0x12, 0x22, 0x40]) assert.equal(classify(mk([0x08, P.CMD.set, addr, 1])).verdict, "blocked", `SET 0x${addr.toString(16)}`);
});

test("a transaction opened on a non-lighting endpoint is refused (firmware/other endpoints)", () => {
  assert.equal(classify(mk([0x08, P.CMD.startTx, 0x01, 0x22])).verdict, "blocked"); // opt1 != 0
  assert.equal(classify(mk([0x08, P.CMD.startTx, 0x00, 0x05])).verdict, "blocked"); // ctrl not 0x01/0x22
  assert.equal(classify(mk([0x08, P.CMD.startTx, 0x02, 0x01])).verdict, "blocked");
});

test("bad write id, report id and length are refused", () => {
  assert.equal(classify(mk([0x07, P.CMD.get, 0x11])).verdict, "blocked");
  assert.equal(classify(mk([0x00, P.CMD.get, 0x11])).verdict, "blocked");
  assert.equal(guard.classify({ type: "output", reportId: 1, data: new Uint8Array(64) }).verdict, "blocked");
  assert.equal(guard.classify({ type: "output", reportId: 0, data: new Uint8Array(32) }).verdict, "blocked");
  assert.equal(guard.classify({ type: "feature", reportId: 0, data: new Uint8Array(64) }).verdict, "blocked");
});

test("no encoder can emit a blocked frame for any in-range input", () => {
  for (const t of ["wired", "wireless"] as const) {
    for (const f of [P.getFirmware(t), P.getPid(t), P.getLayout(t), P.lightingProbe(P.ADDR.lightCtrl1, t), P.lightingProbe(P.ADDR.lightCtrl2, t), P.setRenderMode(P.MODE.direct, t), P.setRenderMode(P.MODE.hwStatic, t), P.startLightingTx(P.ADDR.lightCtrl1, t), P.startLightingTx(P.ADDR.lightCtrl2, t), P.stopLightingTx(P.ADDR.lightCtrl2, t)]) {
      assert.notEqual(classify(f).verdict, "blocked");
    }
  }
  for (let size = 0; size <= 0xffff; size += 1013) assert.notEqual(classify(P.ledBlockFirst(size, [1, 2])).verdict, "blocked");
});

// ---------------------------------------------------------------------------------------------
// Fixture + device table
// ---------------------------------------------------------------------------------------------

test("corsair-icue-frames.txt matches the guard for every line", () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/brands/corsair-icue/corsair-icue-frames.txt");
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  assert.ok(lines.length > 100);
  for (const line of lines) {
    const [verdict, hexStr] = line.split(" ");
    const bytes = new Uint8Array(hexStr.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
    const data = new Uint8Array(64);
    data.set(bytes.subarray(1, 65));
    const got = guard.classify({ type: "output", reportId: bytes[0], data });
    assert.equal(got.verdict !== "blocked", verdict === "1", `line "${line}" -> ${got.verdict}`);
  }
});

test("K70 MAX is in the table as an analog keyboard with PID 0x1BC0", () => {
  const k70 = corsairIcueDevice(0x1b1c, 0x1bc0);
  assert.ok(k70);
  assert.equal(k70.kind, "keyboard");
  assert.equal(k70.tier, "readOnly");
  assert.ok(CORSAIR_ICUE_DEVICES.length >= 15);
});
