// Headless check of the Corsair iCUE (BRAGI) protocol + guard against a simulated K70 MAX (no hardware,
// no window, no iCUE, no Corsair service). Drives identity reads and a guarded lighting transaction
// through a GuardedChannel, and proves a firmware/reset/actuation frame never reaches the device.
// Run: node scripts/corsair-icue.sim.mjs
import assert from "node:assert/strict";
import { GuardedChannel } from "../src/lib/brands/local-kb.ts";
import { CorsairIcueGuard } from "../src/lib/brands/corsair-icue/guard.ts";
import { BRAGI_CHANNEL, corsairIcueDevice } from "../src/lib/brands/corsair-icue/devices.ts";
import * as P from "../src/lib/brands/corsair-icue/protocol.ts";

class SimK70Max {
  constructor() {
    this.vendorId = 0x1b1c;
    this.productId = 0x1bc0;
    this.productName = "Corsair K70 MAX";
    this.collections = [{ usagePage: 0xff42, usage: 0x01 }];
    this.opened = false;
    this.sent = [];
    this.firmwareReset = false;
    this._listeners = new Set();
  }
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  addEventListener(_t, l) {
    this._listeners.add(l);
  }
  removeEventListener(_t, l) {
    this._listeners.delete(l);
  }
  async sendReport(reportId, data) {
    this.sent.push([reportId, [...data.subarray(0, 8)]]);
    // If any firmware/reset command ever arrived, flag it (should never happen).
    if (data[1] !== P.CMD.get && data[1] !== P.CMD.set && data[1] !== P.CMD.startTx && data[1] !== P.CMD.stopTx && data[1] !== P.CMD.blockW1 && data[1] !== P.CMD.blockWn) this.firmwareReset = true;
    // Answer reads with a plausible payload.
    const out = new Uint8Array(64);
    out[0] = data[0];
    if (data[1] === P.CMD.get && data[2] === P.ADDR.firmwareVid) {
      out[3] = 1; out[4] = 16; out[5] = 93; // firmware 1.16.93-ish
    } else if (data[1] === P.CMD.get && data[2] === P.ADDR.pid) {
      out[3] = 0xc0; out[4] = 0x1b; // pid 0x1BC0 little-endian
    }
    queueMicrotask(() => {
      const buf = out.buffer;
      for (const l of this._listeners) l({ reportId: 0, data: new DataView(buf) });
    });
  }
  async sendFeatureReport() {
    throw new Error("K70 MAX BRAGI uses output reports, not feature reports");
  }
  async receiveFeatureReport() {
    throw new Error("no feature reports");
  }
}

const dev = new SimK70Max();
assert.ok(corsairIcueDevice(dev.vendorId, dev.productId), "K70 MAX should be in the device table");

const ch = new GuardedChannel(dev, new CorsairIcueGuard(), BRAGI_CHANNEL);
await dev.open();

// Identity reads are allowed and reach the device.
await ch.output(P.getFirmware().data);
await ch.output(P.getPid().data);
// A full lighting transaction: open, data blocks, close — all allowed.
await ch.output(P.startLightingTx(P.ADDR.lightCtrl2).data);
await ch.output(P.ledBlockFirst(6, [0xff, 0x00, 0x00, 0x00, 0xff, 0x00]).data);
await ch.output(P.stopLightingTx(P.ADDR.lightCtrl2).data);
const okCount = dev.sent.length;
assert.equal(okCount, 5, `5 safe frames should have reached the device, got ${okCount}`);

// Dangerous frames must throw in the guard and never reach the device.
const dangerous = [
  ["firmware update (SetFirmwareUpdatingState)", new Uint8Array([0x08, 0x0f, 0x00, 0x01])],
  ["device reset", new Uint8Array([0x08, 0x12 /* not get: this is a raw unknown cmd */, 0x00])],
  ["pairing", new Uint8Array([0x08, 0x20, 0x00])],
  ["actuation write (SET unlisted addr)", new Uint8Array([0x08, P.CMD.set, 0x40, 0x14])],
  ["transaction on firmware endpoint", new Uint8Array([0x08, P.CMD.startTx, 0x01, 0x00])],
];
let refused = 0;
for (const [name, bytes] of dangerous) {
  const frame = new Uint8Array(64);
  frame.set(bytes);
  try {
    await ch.output(frame);
    assert.fail(`${name} should have been refused`);
  } catch (e) {
    assert.match(String(e), /refused|BRAGI|not on|blocked|unlisted|firmware|endpoint/i, `${name}: ${e}`);
    refused++;
  }
}
assert.equal(refused, dangerous.length, "all dangerous frames refused");
assert.equal(dev.sent.length, okCount, "no dangerous frame reached the device");
assert.equal(dev.firmwareReset, false, "no firmware/reset command ever reached the device");

await dev.close();
console.log(`corsair-icue.sim.mjs: ${okCount} safe frames delivered (identity + lighting transaction), ${refused} dangerous frames refused, device never saw a firmware/reset/actuation command.`);
console.log("all assertions passed.");
