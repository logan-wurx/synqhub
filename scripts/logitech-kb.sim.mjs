// Headless end-to-end check of the Logitech keyboard backend against a simulated PRO X TKL RAPID that
// answers HID++ 2.0 the way G HUB expects (no hardware, no window, no Tauri). Node 24 imports the .ts
// modules directly. Run: node scripts/logitech-kb.sim.mjs
import assert from "node:assert/strict";
import { logitechKbDriver } from "../src/lib/brands/logitech-kb/backend.ts";
import * as P from "../src/lib/brands/logitech-kb/protocol.ts";

const SW = 0x0b;
// Feature map the simulated keyboard reports: id -> index.
const FEATURES = new Map([
  [P.FEATURE.featureSet, 0x01],
  [P.FEATURE.firmwareInfo, 0x02],
  [P.FEATURE.deviceName, 0x03],
  [P.FEATURE.reportRateExt, 0x05],
  [P.FEATURE.brightness, 0x06],
  [P.FEATURE.rgbEffects, 0x07],
  [P.FEATURE.perKeyLightingV2, 0x08],
  [P.FEATURE.onboardProfiles, 0x09],
  [P.FEATURE.analogKeys, 0x0a],
  // dangerous ones the device also exposes; the backend must never address them:
  [0x00d0, 0x0b],
  [0x1802, 0x0c],
  [0x1e00, 0x0d],
  [0x8101, 0x0f],
]);
const indexToId = new Map([...FEATURES].map(([id, i]) => [i, id]));

class SimKeyboard {
  constructor() {
    this.vendorId = 0x046d;
    this.productId = 0xc351; // PRO X 60 PID so the table claims it; analog features still exercised
    this.productName = "Logitech G PRO X TKL RAPID";
    this.collections = [{ usagePage: 0xff00, usage: 0x0001 }, { usagePage: 0xff00, usage: 0x0002 }];
    this.opened = false;
    this._listeners = new Set();
    this._state = { rateCode: 3, brightnessMax: 0x02ff, brightness: 0x0180, rapid: 0, keyPriority: 0 };
    this.sent = [];
    this.blockedReached = false;
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
  _emit(reportId, bytes) {
    const buf = new Uint8Array(bytes);
    const ev = { reportId, data: new DataView(buf.buffer) };
    for (const l of this._listeners) l(ev);
  }
  async sendReport(reportId, data) {
    this.sent.push([reportId, [...data]]);
    const d = data; // data has no report id
    const device = d[0];
    const featureIndex = d[1];
    const fn = (d[2] >> 4) & 0x0f;
    const reply = (bytes) => {
      const out = new Uint8Array(reportId === 0x11 ? 19 : 6);
      out[0] = device;
      out[1] = featureIndex;
      out[2] = d[2];
      for (let i = 0; i < bytes.length; i++) out[3 + i] = bytes[i] & 0xff;
      queueMicrotask(() => this._emit(reportId, out));
    };
    if (featureIndex === 0x00) {
      if (fn === 0x00) {
        // GetFeature(id): id in bytes 3..4
        const id = (d[3] << 8) | d[4];
        const idx = FEATURES.get(id) ?? 0x00;
        reply([idx, 0x00, 0x00]);
      } else if (fn === 0x01) {
        reply([0x04, 0x02, d[5]]); // protocol 4.2, echo marker
      }
      return;
    }
    const id = indexToId.get(featureIndex);
    // The backend must never address a dangerous feature.
    if (id === 0x00d0 || id === 0x1802 || id === 0x1e00 || id === 0x8101) {
      this.blockedReached = true;
      return;
    }
    if (id === P.FEATURE.firmwareInfo) {
      if (fn === 0) reply([0x03]); // entity count = 3 (at reply byte 0)
      else reply([0x00, 0x55, 0x55, 0x30, 0x12, 0x01, 0x03]); // entity "UU0" v18.1.3
    } else if (id === P.FEATURE.reportRateExt) {
      if (fn === 1) reply([0x00, 0x7f]); // list: bits 0..6 (125..8000)
      else if (fn === 2) reply([this._state.rateCode]);
      else if (fn === 3) {
        this._state.rateCode = d[3];
        reply([d[3]]);
      }
    } else if (id === P.FEATURE.brightness) {
      if (fn === 0) reply([(this._state.brightnessMax >> 8) & 0xff, this._state.brightnessMax & 0xff, 0x01, 0x04]);
      else if (fn === 1) reply([(this._state.brightness >> 8) & 0xff, this._state.brightness & 0xff]);
      else if (fn === 2) {
        this._state.brightness = (d[3] << 8) | d[4];
        reply([d[3], d[4]]);
      }
    } else if (id === P.FEATURE.analogKeys) {
      if (fn === 3) reply([this._state.rapid]);
      else if (fn === 4) {
        this._state.rapid = d[3] & 0x01;
        reply([this._state.rapid]);
      } else if (fn === 5) reply([this._state.keyPriority]);
      else if (fn === 6) {
        this._state.keyPriority = d[3] & 0x01;
        reply([this._state.keyPriority]);
      } else reply([0]);
    } else {
      reply([0]); // onboard/lighting info — harmless
    }
  }
}

const store = { async saveBackup() { return "mem"; }, async log() {} };
const ctx = { store, live: true, async devices() { return []; } };

const dev = new SimKeyboard();
assert.equal(logitechKbDriver.claims(dev), true, "driver should claim the keyboard");
assert.equal(await logitechKbDriver.ping(dev), true, "ping should succeed");

const backend = await logitechKbDriver.open(dev, ctx);
const state = backend.state;
assert.ok(state.info.firmware.length >= 1, "firmware should be read");
assert.ok(state.polling && state.polling.hz === 1000, `report rate should read 1000 Hz, got ${state.polling && state.polling.hz}`);
assert.ok(state.options && state.options[0].id === "brightness", "brightness option present");
assert.ok(state.analog && state.analog.global.rapidTrigger === false, "rapid trigger reads off");
console.log("load: fw", state.info.firmware, "| polling", state.polling.hz, "Hz options", state.polling.options, "| brightness", state.options[0].value + "%", "| rapid", state.analog.global.rapidTrigger);

// Change report rate to 4000 Hz and read back.
const ratePlan = backend.plan({ kind: "polling", hz: 4000 });
await ratePlan.send();
assert.equal(await ratePlan.readBack(), 4000, "report rate should read back 4000 Hz");

// Enable rapid trigger and read back.
const rtPlan = backend.plan({ kind: "analog", target: "global", values: { rapidTrigger: true } });
await rtPlan.send();
assert.deepEqual(await rtPlan.readBack(), { rapidTrigger: true }, "rapid trigger should read back on");

// Brightness to 50%.
const brPlan = backend.plan({ kind: "option", id: "brightness", value: 50 });
await brPlan.send();
const br = await brPlan.readBack();
assert.ok(Math.abs(br - 50) <= 1, `brightness should read back ~50%, got ${br}`);

// A blocked change must be refused by plan() (profile-memory / macro feature).
assert.throws(() => backend.plan({ kind: "option", id: "disable-keys", value: 1 }), "unknown option refused");

// Prove no frame addressed a dangerous feature index.
assert.equal(dev.blockedReached, false, "no dangerous feature was ever addressed");
const dangerousIdx = new Set([0x0b, 0x0c, 0x0d, 0x0f]);
for (const [, data] of dev.sent) assert.equal(dangerousIdx.has(data[1]) && data[1] !== 0x00, false, `frame addressed dangerous index ${data[1]}`);

await backend.close();
console.log("writes: rate->4000 Hz OK, rapid->on OK, brightness->" + br + "% OK; dangerous features never addressed; blocked option refused.");
console.log("logitech-kb.sim.mjs: all assertions passed.");
