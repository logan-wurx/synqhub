// Headless end-to-end check of the Razer sessions (src/lib/brands/razer/session.ts) and the Wave 1
// adapter (kb-driver.ts) against simulated devices that answer the way Synapse Web's code expects
// (90-byte feature reports, echoed transaction id, busy status, per-profile settings). No hardware, no
// window, no Tauri. Node 24 loads the TypeScript sources directly.
// Run: node scripts/razer-session.sim.mjs
import assert from "node:assert/strict";
import * as P from "../src/lib/brands/razer/protocol.ts";
import { classifyRazerFrame, isRazerBlocked } from "../src/lib/brands/razer/guard.ts";
import { RAZER_KEY_IDS as K, RAZER_VALID_KEY_IDS, findRazerKeyboard, findRazerMouse } from "../src/lib/brands/razer/devices.ts";
import { RazerKeyboardSession, RazerMouseSession, RazerCommandError } from "../src/lib/brands/razer/session.ts";
import { RazerKbBackend, claimsRazerKeyboard } from "../src/lib/brands/razer/kb-driver.ts";
import { BlockedFrameError } from "../src/lib/brands/local-kb.ts";

const noSleep = () => Promise.resolve();
const NUMPAD = new Set([90, 91, 92, 93, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108]);
const ISO = new Set([K.NON_US_POUND, K.NON_US_BACKSLASH, K.YEN, K.RO]);

class FakeRazer {
  constructor(pid, { analogKeys, busyFirst = 0, unsupported = [], clamp = null, txGlitch = 0 } = {}) {
    this.vendorId = 0x1532;
    this.productId = pid;
    this.productName = "Razer test device";
    this.collections = [{ usagePage: 0x0c, usage: 0x01 }];
    this.opened = true;
    this.frames = [];
    this.illegal = [];
    this.busyFirst = busyFirst;
    this.unsupported = new Set(unsupported.map(([c, i]) => (c << 8) | i));
    this.clamp = clamp; // { key, minRaw }
    this.txGlitch = txGlitch; // wrong tx on the first N replies
    this.analog = new Set(analogKeys);
    this.ids = [2, 3, 4, 5, 6];
    this.active = 2;
    this.prof = new Map(this.ids.map((id) => [id, this.#freshProfile()]));
    this.dpi = { active: 2, stages: [{ id: 1, x: 400, y: 400 }, { id: 2, x: 800, y: 800 }, { id: 3, x: 1600, y: 1600 }] };
    this.mousePoll = 0x08;
    this.lift = { mode: 1, height: 1 };
    this.proximityOn = false;
  }
  #freshProfile() {
    return {
      act: new Map([...this.analog].map((k) => [k, { act: 19656, rel: 18018 }])),
      rt: new Map([...this.analog].map((k) => [k, { en: 0, up: 1638, down: 1638 }])),
      dz: 5,
      snap: { en: 0, pairs: [] },
      single: { en: 0, keys: [{ keyId: K.A, keyCode: 4 }] },
      dkp: { en: 0, keys: [] },
      poll: 0x08,
      bright: 255,
    };
  }
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  sendReport() {
    this.illegal.push("sendReport");
    throw new Error("output report on a feature-only collection");
  }
  addEventListener() {
    this.illegal.push("addEventListener");
  }
  removeEventListener() {}
  async sendFeatureReport(reportId, data) {
    const f = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length).slice();
    assert.equal(reportId, 0);
    assert.equal(f.length, 90);
    assert.equal(f[88], P.crc(f), "request checksum");
    assert.notEqual(classifyRazerFrame(f).verdict, "blocked", "a blocked frame reached the device");
    this.frames.push(f);
    this.pending = { reply: this.#answer(f), busy: this.busyFirst };
  }
  async receiveFeatureReport(reportId) {
    assert.equal(reportId, 0);
    const p = this.pending;
    let out;
    if (p.busy > 0) {
      p.busy--;
      out = new Uint8Array(p.reply);
      out[0] = P.STATUS.busy;
    } else out = new Uint8Array(p.reply);
    if (this.txGlitch > 0) {
      this.txGlitch--;
      out[1] = (out[1] + 7) & 0x1f;
    }
    out[88] = P.crc(out);
    // Chrome sometimes hands back the report id as byte 0
    const withId = this.frames.length % 2 === 0;
    const bytes = withId ? new Uint8Array([0, ...out]) : out;
    return new DataView(bytes.buffer);
  }
  #answer(f) {
    const cls = f[6], id = f[7], n = f[5];
    const a = f.subarray(8, 8 + n);
    const r = new Uint8Array(f);
    r[0] = P.STATUS.ok;
    const reply = (data, size = data.length) => {
      r.fill(0, 8, 88);
      r.set(data, 8);
      r[5] = size;
      return r;
    };
    if (this.unsupported.has((cls << 8) | id)) {
      r[0] = P.STATUS.unsupported;
      return r;
    }
    const pr = this.prof.get(a[0]) ?? this.prof.get(a[1]);
    const key = `${cls.toString(16)}/${id.toString(16)}`;
    switch (key) {
      case "0/81": return reply([1, 4]);
      case "0/82": return reply([..."PM2412H12345678"].map((c) => c.charCodeAt(0)), 22);
      case "5/80": return reply([this.ids.length]);
      case "5/81": return reply([this.ids.length, ...this.ids], 80);
      case "5/84": return reply([this.active]);
      case "5/4": if (this.ids.includes(a[0])) this.active = a[0]; return reply([this.active]);
      case "2/99": {
        const p = this.prof.get(a[1]);
        const out = [a[0], a[1]];
        for (let i = 2; i < n; i += 5) {
          const k = a[i], v = p.act.get(k);
          out.push(k, (v?.rel ?? 0) >> 8, (v?.rel ?? 0) & 255, (v?.act ?? 0) >> 8, (v?.act ?? 0) & 255);
        }
        return reply(out, n);
      }
      case "2/19": {
        const p = this.prof.get(a[1]);
        for (let i = 2; i < n; i += 5) {
          const k = a[i], rel = (a[i + 1] << 8) | a[i + 2];
          let act = (a[i + 3] << 8) | a[i + 4];
          const targets = k === 255 ? [...this.analog] : [k];
          for (const t of targets) {
            if (!this.analog.has(t)) continue;
            const v = this.clamp && this.clamp.key === t ? Math.max(act, this.clamp.minRaw) : act;
            p.act.set(t, { act: v, rel });
          }
        }
        return reply(a, n);
      }
      case "2/9a": {
        const p = this.prof.get(a[1]);
        const out = [a[0], a[1]];
        for (let i = 2; i < n; i += 6) {
          const k = a[i], v = p.rt.get(k) ?? { en: 0, up: 0, down: 0 };
          out.push(k, v.en, v.up >> 8, v.up & 255, v.down >> 8, v.down & 255);
        }
        return reply(out, n);
      }
      case "2/1a": {
        const p = this.prof.get(a[1]);
        for (let i = 2; i < n; i += 6) {
          const k = a[i];
          const v = { en: a[i + 1], up: (a[i + 2] << 8) | a[i + 3], down: (a[i + 4] << 8) | a[i + 5] };
          for (const t of k === 255 ? [...this.analog] : [k]) if (this.analog.has(t)) p.rt.set(t, v);
        }
        return reply(a, n);
      }
      case "2/a8": return reply([a[0], pr.dz]);
      case "2/28": pr.dz = a[1]; return reply([a[0], pr.dz]);
      case "2/a7": return reply([a[0], pr.snap.pairs.length, pr.snap.en, ...pr.snap.pairs.flat()], 15);
      case "2/27": pr.snap = { en: a[2], pairs: Array.from({ length: a[1] }, (_, i) => [a[3 + 3 * i], a[4 + 3 * i], a[5 + 3 * i]]) }; return reply(a, 15);
      case "2/ac": return reply([a[0], pr.single.keys.length, pr.single.en, ...pr.single.keys.flatMap((k) => [k.keyId, k.keyCode])], 11);
      case "2/2c": pr.single = { en: a[2], keys: Array.from({ length: a[1] }, (_, i) => ({ keyId: a[3 + 2 * i], keyCode: a[4 + 2 * i] })) }; return reply(a, 11);
      case "2/b1": return reply([a[0], pr.dkp.keys.length, pr.dkp.en, ...pr.dkp.keys], 7);
      case "2/31": pr.dkp = { en: a[2], keys: Array.from(a.subarray(3, 3 + a[1])) }; return reply(a, 7);
      case "0/c0": return reply([a[0], this.analog.size ? pr.poll : this.mousePoll]);
      case "0/40": if (this.analog.size) pr.poll = a[1]; else this.mousePoll = a[1]; return reply(a);
      case "f/84": return reply([a[0], a[1], pr.bright]);
      case "f/4": pr.bright = a[2]; return reply(a);
      case "4/86": return reply([a[0], this.dpi.active, this.dpi.stages.length, ...this.dpi.stages.flatMap((s) => [s.id, s.x >> 8, s.x & 255, s.y >> 8, s.y & 255, 0, 0])], 3 + 7 * this.dpi.stages.length);
      case "4/6": this.dpi = { active: a[1], stages: Array.from({ length: a[2] }, (_, i) => ({ id: a[3 + 7 * i], x: (a[4 + 7 * i] << 8) | a[5 + 7 * i], y: (a[6 + 7 * i] << 8) | a[7 + 7 * i] })) }; return reply(a, n);
      case "7/80": return reply([0, 204]);
      case "7/84": return reply([0, 1]);
      case "b/8b": return reply([0, 4, this.lift.mode, this.lift.height], 4);
      case "b/b": if (!this.proximityOn) throw new Error("lift set before proximity on"); this.lift = { mode: a[2], height: a[3] }; return reply(a, 4);
      case "b/3": this.proximityOn = a[2] === 1; return reply(a, 3);
      default:
        r[0] = P.STATUS.unsupported;
        return r;
    }
  }
}

const tklKeys = [...RAZER_VALID_KEY_IDS].filter((k) => !NUMPAD.has(k) && !ISO.has(k) && k !== K.RGUI);
let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};
const eq = (a, b, msg) => {
  assert.deepEqual(a, b, msg);
  checks++;
};

// ------------------------------------------------------------------------------------------------
// Keyboard: Huntsman V3 HE Magnetic TKL 8KHz (0x02EA)
// ------------------------------------------------------------------------------------------------
{
  const dev = new FakeRazer(0x02ea, { analogKeys: tklKeys, busyFirst: 1 });
  let allow = false;
  const s = new RazerKeyboardSession(dev, findRazerKeyboard(0x02ea), { allowWrites: () => allow, sleep: noSleep });
  const st = await s.connect();
  eq(st.firmware, "1.4", "firmware");
  eq(st.serial, "PM2412H12345678", "serial");
  eq(st.profileIds, [2, 3, 4, 5, 6], "profiles");
  eq(st.profile, 2, "edits the active profile");
  eq(st.keys, [...tklKeys].sort((a, b) => a - b), "analog keys found (non-analog ones dropped)");
  eq(st.actuation.get(K.W).actuationRaw, 19656, "W actuation");
  eq(st.pollingHz, 1000, "polling");
  eq(st.bottomDeadZone, 5, "dead zone");
  eq(st.brightness, 100, "brightness");
  eq(st.problems, [], "no read problems");

  // writes are refused while Allow changes is off, and nothing is sent
  const before = dev.frames.length;
  await assert.rejects(() => s.setActuation([K.W], 1.0), /Allow changes/);
  eq(dev.frames.length, before, "refused write sent nothing");
  allow = true;

  eq(await s.setActuation("all", 1.5), { status: "confirmed", value: 1.5 }, "actuation all keys");
  ok([...dev.prof.get(2).act.values()].every((v) => v.act === 24570 && v.rel === 22932), "device holds 1.5 mm / release 1.4 mm on every key");
  const allFrame = dev.frames.find((f) => f[6] === 0x02 && f[7] === 0x19);
  eq(Array.from(allFrame.subarray(5, 15)), [7, 2, 0x19, 0, 2, 255, 0x59, 0x94, 0x5f, 0xfa], "all-keys write uses key id 255 in one packet");

  eq(await s.setActuation([K.W, K.A, K.S, K.D], 0.4), { status: "confirmed", value: 0.4 }, "actuation WASD");
  const many = tklKeys.slice(0, 20);
  eq((await s.setActuation(many, 2.0)).status, "confirmed", "actuation over two packets");
  eq((await s.setRapidTrigger([K.W, K.A], { enabled: true, pressMm: 0.2, releaseMm: 0.3 })).status, "confirmed", "rapid trigger");
  eq(dev.prof.get(2).rt.get(K.W), { en: 1, up: 4914, down: 3276 }, "RT press = down, release = up");
  eq((await s.setRapidTrigger("all", { enabled: false, pressMm: 0.1 })).status, "confirmed", "RT off everywhere");

  eq((await s.setSnapTap({ enabled: true, pairs: [{ a: K.A, b: K.D, mode: P.SNAP_TAP_MODE.last }] })).status, "confirmed", "snap tap");
  eq(dev.prof.get(2).snap, { en: 1, pairs: [[K.A, K.D, 0]] }, "snap tap stored");
  eq((await s.setSingleSnapTapEnabled(true)).status, "confirmed", "single-key snap tap");
  eq(dev.prof.get(2).single.keys, [{ keyId: K.A, keyCode: 4 }], "single-key snap tap keeps the keys it read");
  eq((await s.setDualPriority({ enabled: true, keys: [K.A, K.D] })).status, "confirmed", "dual priority");
  eq((await s.setPolling(8000)).status, "confirmed", "8K polling");
  await assert.rejects(() => s.setPolling(333));
  eq(await s.setBrightness(50), { status: "confirmed", value: 50 }, "brightness");
  eq(await s.setBottomDeadZone("stable"), { status: "confirmed", value: 8 }, "dead zone stable");

  // profile switch re-reads everything from the new profile
  eq((await s.setActiveProfile(3)).status, "confirmed", "profile switch");
  eq(s.state.profile, 3, "now editing profile 3");
  eq(s.state.actuation.get(K.W).actuationRaw, 19656, "profile 3 has its own (default) values");
  await assert.rejects(() => s.setActiveProfile(7), /isn't on the keyboard/);

  // a key the board refuses to set below 0.5 mm reads back different
  dev.clamp = { key: K.Q, minRaw: 8190 };
  eq(await s.setActuation([K.Q], 0.3), { status: "mismatch", wrote: 0.3, read: 0.5 }, "mismatch reported");

  // bad input never becomes a frame
  await assert.rejects(() => s.setActuation([K.W], 4.5), /Actuation must be/);
  await assert.rejects(() => s.setActuation([K.KP_1], 1.0), /not an analog key/);

  // a blocked command can't leave, even when handed to the channel directly
  const n0 = dev.frames.length;
  const devMode = new Uint8Array(90);
  devMode[5] = 2;
  devMode[6] = 0x00;
  devMode[7] = 0x04;
  devMode[8] = 0x01; // bootloader mode
  devMode[88] = P.crc(devMode);
  await assert.rejects(() => s.link.channel.feature(devMode), BlockedFrameError);
  const calib = new Uint8Array(90);
  calib[5] = 1;
  calib[6] = 0xfe;
  calib[7] = 0x20;
  calib[88] = P.crc(calib);
  await assert.rejects(() => s.link.channel.feature(calib), BlockedFrameError);
  eq(dev.frames.length, n0, "blocked frames never reached the device");

  // transaction ids: Synapse's rolling 0..30
  const txs = dev.frames.map((f) => f[1]);
  ok(txs.every((t) => t <= 30), "tx within 0..30");
  ok(txs.indexOf(30) >= 0 && txs[txs.indexOf(30) + 1] === 0, "tx wraps 30 -> 0");
  ok(dev.frames.every((f) => !isRazerBlocked(f[6], f[7])), "no blocked class/id sent");
  eq(dev.illegal, [], "feature-only: no output reports, no input listener");
}

// busy replies, a wrong transaction id (resend), and an unsupported command
{
  const dev = new FakeRazer(0x02d0, { analogKeys: tklKeys, busyFirst: 3, txGlitch: 1, unsupported: [[0x02, 0xa7], [0x02, 0x2c]] });
  const s = new RazerKeyboardSession(dev, findRazerKeyboard(0x02d0), { allowWrites: () => true, sleep: noSleep });
  const st = await s.connect();
  eq(st.firmware, "1.4", "survives busy + one tx mismatch");
  eq(st.snapTap, null, "unsupported snap tap read -> null");
  ok(st.problems.some((p) => /not supported/.test(p)), "problem recorded");
  const resent = dev.frames.filter((f) => f[6] === 0x00 && f[7] === 0x81).length;
  eq(resent, 2, "firmware request re-sent after the tx mismatch");
  // the write is answered but the read-back isn't: "unconfirmed", not "confirmed"
  eq((await s.setSnapTap({ enabled: true, pairs: [] })).status, "unconfirmed", "write without read-back is unconfirmed");
  // a write the board refuses (status 5) throws
  await assert.rejects(() => s.setSingleSnapTapEnabled(true), RazerCommandError);
}

// read-only model (desktop-Synapse V3 Pro): reads work, writes refused before any I/O
{
  const dev = new FakeRazer(0x02a6, { analogKeys: tklKeys });
  const s = new RazerKeyboardSession(dev, findRazerKeyboard(0x02a6), { allowWrites: () => true, sleep: noSleep });
  await s.connect();
  const n = dev.frames.length;
  await assert.rejects(() => s.setActuation("all", 1.0), /read-only/);
  eq(dev.frames.length, n, "read-only model sent nothing");
}

// Huntsman V3 Pro Mini (no polling / dead zone / snap tap features): those reads are skipped
{
  const dev = new FakeRazer(0x02b0, { analogKeys: tklKeys.filter((k) => k < 75) });
  const s = new RazerKeyboardSession(dev, findRazerKeyboard(0x02b0), { allowWrites: () => true, sleep: noSleep });
  const st = await s.connect();
  ok(!dev.frames.some((f) => f[6] === 0x00 && f[7] === 0xc0), "no polling read on a board without it");
  eq(st.pollingHz, null, "polling null");
  await assert.rejects(() => s.setPolling(1000), /no polling/);
}

// ------------------------------------------------------------------------------------------------
// Mouse: Viper V4 HyperSpeed (0xB005)
// ------------------------------------------------------------------------------------------------
{
  const dev = new FakeRazer(0xb005, { analogKeys: [] });
  const m = new RazerMouseSession(dev, findRazerMouse(0xb005), { allowWrites: () => true, sleep: noSleep });
  const st = await m.connect();
  eq(st.dpi, { active: 2, stages: [{ id: 1, x: 400, y: 400 }, { id: 2, x: 800, y: 800 }, { id: 3, x: 1600, y: 1600 }] }, "DPI stages");
  eq(st.pollingHz, 1000, "mouse polling");
  eq(st.battery, 80, "battery 204/255");
  eq(st.charging, true, "charging");
  eq(st.lift, { mode: 1, level: 2, asymmetric: false }, "lift level");
  eq((await m.setDpiStages([{ x: 800 }, { x: 1600 }, { x: 3200 }, { x: 6400, y: 3200 }], 3)).status, "confirmed", "DPI write");
  eq(dev.dpi.stages.map((s) => s.id), [1, 2, 3, 4], "stage ids kept, new one numbered next");
  await assert.rejects(() => m.setDpiStages([{ x: 40000 }], 1), /DPI must be/);
  eq((await m.setPolling(4000)).status, "confirmed", "mouse 4K polling");
  eq((await m.setLiftLevel(3)).status, "confirmed", "lift level 3");
  const lastTwo = dev.frames.slice(-3, -1).map((f) => `${f[6]}/${f[7]}`);
  eq(lastTwo, ["11/3", "11/11"], "proximity on, then lift setting (Synapse order)");
  await assert.rejects(() => m.setLiftLevel(7));
  eq(dev.illegal, [], "mouse: feature reports only");
}

// ------------------------------------------------------------------------------------------------
// Wave 1 adapter
// ------------------------------------------------------------------------------------------------
{
  ok(claimsRazerKeyboard({ vendorId: 0x1532, productId: 0x02ea, collections: [{ usagePage: 0x0c }] }), "claims the consumer collection");
  ok(!claimsRazerKeyboard({ vendorId: 0x1532, productId: 0x02ea, collections: [{ usagePage: 0x01 }] }), "never the keyboard/pointer collection");
  ok(!claimsRazerKeyboard({ vendorId: 0x1532, productId: 0x00c1, collections: [{ usagePage: 0x0c }] }), "not an OpenMouse mouse");
  const dev = new FakeRazer(0x02ea, { analogKeys: tklKeys });
  const b = new RazerKbBackend(dev);
  const st = await b.load();
  eq(st.analog.keys.length, tklKeys.length, "adapter analog keys");
  eq(st.analog.perKey[K.W].actuationMm, 1.2, "adapter per-key mm");
  eq(st.polling.hz, 1000, "adapter polling");
  ok(st.keymap.layout.keys.length > 80, "TKL geometry");
  const plan = b.plan({ kind: "analog", target: [K.W, K.A], values: { actuationMm: 0.8, rapidTrigger: true, rtPressMm: 0.2 } });
  await plan.send();
  eq(await plan.readBack(), plan.expected, "adapter read-back equals expected");
  const pp = b.plan({ kind: "polling", hz: 2000 });
  await pp.send();
  eq(await pp.readBack(), 2000, "adapter polling read-back");
  const op = b.plan({ kind: "option", id: "bottomDeadZone", value: 0 });
  await op.send();
  eq(await op.readBack(), 0, "adapter dead-zone read-back");
  assert.throws(() => b.plan({ kind: "keycode", layer: 0, key: K.W, code: 4 }), /isn't implemented/);
  ok(b.blocked.length > 10, "blocked list exposed");
  const ro = new RazerKbBackend(new FakeRazer(0x02a7, { analogKeys: tklKeys }));
  assert.throws(() => ro.plan({ kind: "polling", hz: 1000 }), /only reads/);
}

console.log(`razer-session.sim: ${checks} checks passed`);
