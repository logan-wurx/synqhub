// Headless end-to-end check of the CORSAIR sessions (src/lib/brands/corsair) against simulated
// devices: a Bragi 1.5 Vanguard Pro 96 (host session, profile files), a Bragi 1.0 Clipper Pro Mini 60,
// Bragi mice (Sabre v3 Pro: direct properties; Nightsword V2: DPI in the profile properties file) and a
// Sabre v2 Pro (EEPROM protocol). No hardware, no window, no Tauri.
//   node scripts/corsair-session.sim.mjs
//
// The simulated firmware enforces what the real one would: v1.5 frames need the session id, file I/O
// needs operating mode 2, and it throws on any firmware / bootloader / reset / pairing / calibration
// command (its own list, independent of guard.ts). Every run must end with the device back in mode 1.
import assert from "node:assert/strict";
import { SimDevice, hex, u16 } from "./brands-sim-device.mjs";
import { CorsairKbBackend } from "../src/lib/brands/corsair/keyboard.ts";
import { CorsairMouseSession } from "../src/lib/brands/corsair/mouse.ts";
import { SabreMouseSession, sabreDpiRow } from "../src/lib/brands/corsair/sabre.ts";
import { corsairModel } from "../src/lib/brands/corsair/devices.ts";
import * as B from "../src/lib/brands/corsair/bragi.ts";
import { KbSession, memoryKbStore } from "../src/lib/kb/session.ts";

const le16 = (v) => [v & 0xff, v >> 8];
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

function profileFile(ids) {
  const name = [...new TextEncoder().encode("Sim")];
  return Uint8Array.from([...le16(0xf11e), ...le32(1700000000), ...[ids.assign, ids.props, 0, 0, 0, 0, 0, 0, 0, ids.press, ids.secPress, 0].flatMap(le16), ...le16(name.length), ...name, 0, ...[ids.reset, ids.secReset, ids.rt, 0].flatMap(le16)]);
}

/** A Bragi device with properties and files. */
function simBragi(pid, { keys = [], props = {}, profileProps = {}, profiles = true } = {}) {
  const model = corsairModel(pid);
  const v15 = model.framing === "v15";
  const st = { mode: 1, session: null, props: new Map(Object.entries({ 0x13: 0x00030102, 0x01: 4, 0x02: 1000, 0x6e: 0, 0x03: 1, ...props }).map(([k, v]) => [Number(k), v])), files: new Map(), open: null, readAt: 0, write: null, fileOps: 0, modeChanges: 0 };
  if (profiles) {
    const ids = { assign: 0x6d61, props: 0x6d62, press: 0x6d63, secPress: 0x6d64, reset: 0x6d65, secReset: 0x6d66, rt: 0x6d67 };
    st.files.set(0x0f, Uint8Array.from([0x13, 0x00, 1, 0, ...le16(0x6d60)]));
    st.files.set(0x6d60, profileFile(ids));
    st.files.set(ids.press, Uint8Array.from([0x30, 0, keys.length, ...keys.flatMap((k) => [k, 1, 20])]));
    st.files.set(ids.reset, Uint8Array.from([0x30, 0, keys.length, ...keys.flatMap((k) => [k, 1, 19])]));
    st.files.set(ids.rt, Uint8Array.from([0x36, 0, keys.length, ...keys.flatMap((k) => [k, 0, 20, 1, 1])]));
    const pp = { 251: 0, 252: 1, 253: 0xffbf00, 254: 4, 255: 7, 74: 1, ...profileProps };
    st.files.set(ids.props, Uint8Array.from([...le16(0xd43d), ...le16(Object.keys(pp).length), ...Object.entries(pp).flatMap(([id, v]) => [...le16(Number(id)), ...le32(v)])]));
  }
  const cmdAt = v15 ? 3 : 1;
  const p = v15 ? 4 : 2;
  const handler = (f) => {
    const isSession = f[3] === 0x1b && f[1] === 0x01 && f[0] <= 7;
    const cmd = isSession ? 0x1b : f[cmdAt];
    if ([0x0a, 0x0b, 0x0c, 0x0f, 0x10, 0x11, 0x16].includes(cmd)) throw new Error(`DANGEROUS COMMAND REACHED THE DEVICE: ${hex(f.subarray(0, 10))}`);
    if (cmd === 0x12 && f.subarray(p).some((x) => x)) throw new Error("PAIRING REACHED THE DEVICE");
    const r = new Uint8Array(64);
    const answer = (status, data = []) => {
      if (v15) r.set([f[0], 0, st.session ?? 0, cmd, status, ...data]);
      else r.set([f[0], cmd, status, ...data]);
      return r;
    };
    if (isSession) {
      assert.ok(v15, "session on a 1.0 device");
      if (f[4] === 1) {
        st.session = 0x5a;
        r.set([f[0], 0, 0, 0x1b, 0, f[5], f[6], f[7], f[8], st.session]);
        return r;
      }
      return answer(0);
    }
    if (v15) {
      if (f[1] !== 1) throw new Error("bad 1.5 header");
      if (st.session === null || f[2] !== st.session) {
        r.set([f[0], 15, f[2], cmd, 0]);
        return r;
      }
    } else if ((f[0] & 0xf8) !== 0x08) throw new Error("bad 1.0 header");
    const needMode2 = () => assert.equal(st.mode, 2, `file op 0x${cmd.toString(16)} outside host-controlled mode`);
    switch (cmd) {
      case 0x02: {
        const prop = u16(f, p);
        if (!st.props.has(prop)) return answer(5);
        return answer(0, le32(st.props.get(prop)));
      }
      case 0x01: {
        const prop = u16(f, p);
        const value = f[p + 2] | (f[p + 3] << 8) | (f[p + 4] << 16) | (f[p + 5] << 24);
        if (prop === 0x03) {
          assert.ok(value === 1 || value === 2, `mode ${value}`);
          st.mode = value;
          st.modeChanges++;
        }
        st.props.set(prop, value >>> 0);
        return answer(0);
      }
      case 0x12:
        return answer(0);
      case 0x0d: {
        needMode2();
        const id = u16(f, p + 1);
        if (!st.files.has(id)) return answer(1);
        st.open = id;
        st.readAt = 0;
        st.fileOps++;
        return answer(0);
      }
      case 0x09:
        needMode2();
        return answer(0, [0, 0, ...le32(st.files.get(st.open).length)]);
      case 0x08: {
        needMode2();
        const file = st.files.get(st.open);
        const n = 64 - (v15 ? 5 : 3);
        const chunk = file.subarray(st.readAt, st.readAt + n);
        st.readAt += chunk.length;
        return answer(0, [...chunk]);
      }
      case 0x06: {
        needMode2();
        const total = f[p + 1] | (f[p + 2] << 8) | (f[p + 3] << 16) | (f[p + 4] << 24);
        st.write = { total, bytes: [...f.subarray(p + 5)].slice(0, total) };
        return answer(0);
      }
      case 0x07: {
        needMode2();
        const left = st.write.total - st.write.bytes.length;
        st.write.bytes.push(...[...f.subarray(p + 1)].slice(0, left));
        return answer(0);
      }
      case 0x05: {
        if (st.write) {
          assert.equal(st.write.bytes.length, st.write.total, "short file write");
          assert.ok(st.open >= 28000, `write landed in file ${st.open}`);
          st.files.set(st.open, Uint8Array.from(st.write.bytes));
          st.write = null;
        }
        st.open = null;
        return answer(0);
      }
      default:
        throw new Error(`unexpected command 0x${cmd.toString(16)}`);
    }
  };
  const dev = new SimDevice({ vendorId: 0x1b1c, productId: pid, productName: model.name, collections: [{ usagePage: 0xff42, usage: 1 }, { usagePage: 0xff42, usage: 2 }], handler });
  return { dev, st, model };
}

const KEYS = [...Array.from({ length: 26 }, (_, i) => 4 + i), ...Array.from({ length: 10 }, (_, i) => 30 + i), 105, 106, 107];

async function keyboardRun(pid) {
  const { dev, st, model } = simBragi(pid, { keys: KEYS });
  const backend = new CorsairKbBackend(dev, model, { nonce: () => [1, 2, 3, 4] });
  await backend.load();
  assert.equal(st.mode, 1, "back to mode 1 after the first read");
  assert.equal(backend.state.analog.keys.length, KEYS.length);
  assert.equal(backend.state.analog.perKey[4].actuationMm, 2);
  const session = new KbSession(backend, memoryKbStore(), { vendorId: 0x1b1c, productId: pid, productName: model.name });
  session.setAllowChanges(true);
  const go = async (change, verdict = "confirmed") => {
    const r = await session.apply(change);
    assert.equal(r.verdict, verdict, `${model.name}: ${JSON.stringify(change)} -> ${r.verdict} (${r.detail})`);
    assert.equal(st.mode, 1, "always back in mode 1");
  };
  await go({ kind: "analog", target: "global", values: { actuationMm: 1.5 } });
  const press = B.decodeDistanceFile(st.files.get(0x6d63));
  assert.ok(press.entries.every((e) => e.distance === 15 && e.flags === 1));
  assert.ok(B.decodeDistanceFile(st.files.get(0x6d65)).entries.every((e) => e.distance === 14), "reset follows press - 0.1 mm");
  await go({ kind: "analog", target: [26, 4], values: { rapidTrigger: true, rtPressMm: 0.1, rtReleaseMm: 0.3 } });
  const w = B.decodeRapidTriggerFile(st.files.get(0x6d67)).entries.find((e) => e.key === 26);
  assert.deepEqual(w, { key: 26, flags: 1, deadzone: 15, press: 1, release: 3 });
  await go({ kind: "analog", target: [7], values: { actuationMm: 0.8, releaseMm: 0.5 } });
  await assert.rejects(session.apply({ kind: "analog", target: [7], values: { actuationMm: 0.8, releaseMm: 0.9 } }), /above the actuation/);
  await go({ kind: "option", id: "flashTap", value: 2 });
  const props = B.decodePropertiesFile(st.files.get(0x6d62));
  assert.deepEqual([B.propU32(props, 251), B.propU32(props, 252), B.propU32(props, 74)], [1, 1, 1], "FlashTap on, last-input mode, other properties kept");
  await go({ kind: "polling", hz: 8000 });
  assert.equal(st.props.get(0x01), 7);
  await go({ kind: "lighting", id: "brightness", value: 40 });
  assert.equal(st.props.get(0x02), 400);
  await go({ kind: "profile", index: 1 });
  await assert.rejects(session.apply({ kind: "analog", target: "global", values: { actuationMm: 4.5 } }), /between/);
  await assert.rejects(session.apply({ kind: "keycode", layer: 0, key: 4, code: 5 }), /aren.t supported/);
  for (const id of [3, 5, 6, 18, 53, 75, 31000]) assert.ok(!st.files.has(id) || id === 31000, "sim has no such file");
  await session.close();
  return `${model.name} (Bragi ${model.framing === "v15" ? `1.5, session 0x${(st.session ?? 0).toString(16)}` : "1.0"}): ${dev.received.length} frames, ${st.fileOps} file opens, ${st.modeChanges} mode changes`;
}

async function bragiMouseRun(pid, profiles) {
  const props = { 0x06: 3, 0x07: 0, 0x0a: 6, 0x38: 6, 0x0f: 870, 0x113: 0, 0x1e: 0, ...(profiles ? {} : { 0x18: 400, 0x19: 800, 0x1a: 1600, 0x1b: 3200, 0x1c: 6400 }) };
  const { dev, st, model } = simBragi(pid, { props, profiles, profileProps: profiles ? { 24: 400, 25: 800, 26: 1600, 27: 3200, 28: 6400 } : {} });
  const m = new CorsairMouseSession(dev, model, { nonce: () => [9, 8, 7, 6] });
  const s = await m.read();
  assert.deepEqual(s.dpi, [400, 800, 1600, 3200, 6400]);
  assert.equal(s.battery.percent, 87);
  const go = async (c) => {
    const r = await m.apply(c);
    assert.equal(r.verdict, "confirmed", `${model.name} ${JSON.stringify(c)} got ${JSON.stringify(r.got)}`);
    assert.equal(st.mode, 1);
  };
  await go({ kind: "dpi", stage: 1, dpi: 1000 });
  await go({ kind: "polling", hz: 1000 });
  await go({ kind: "liftOff", value: 2 });
  await go({ kind: "angleSnap", on: true });
  await go({ kind: "debounce", ms: 9 });
  await go({ kind: "motionSync", on: true });
  if (!profiles) await go({ kind: "activeStage", stage: 3 });
  await assert.rejects(m.apply({ kind: "liftOff", value: 6 }), /1 \(lowest\)/);
  await m.close();
  return `${model.name} (${profiles ? "profile file" : "direct properties"}): ${dev.received.length} frames`;
}

async function sabreRun() {
  const ee = new Uint8Array(0x300);
  const put = (a, v) => ee.set([v, (0x55 - v) & 0xff], a);
  put(0x00, 1);
  put(0x04, 0);
  put(0x0a, 3);
  put(0xab, 0);
  put(0xaf, 0);
  [400, 800, 1600, 3200, 6400].forEach((d, i) => ee.set(sabreDpiRow(d), 0x0c + 4 * i));
  const handler = (f) => {
    const sum = (0x08 + f.reduce((s, b) => s + b, 0)) & 0xff;
    assert.equal(sum, 0x55, "checksum");
    if ([0x01, 0x02, 0x09].includes(f[0])) throw new Error(`DANGEROUS SABRE COMMAND ${f[0]}`);
    const r = new Uint8Array(16);
    r.set(f.subarray(0, 5));
    const a = (f[2] << 8) | f[3];
    if (f[0] === 0x08) r.set(ee.subarray(a, a + f[4]), 5);
    else if (f[0] === 0x07) {
      assert.ok(!(a >= 0xdb && a <= 0xdf), "calibration rows");
      ee.set(f.subarray(5, 5 + f[4]), a);
    } else if (f[0] === 0x04) r.set([66, 0], 5);
    else if (f[0] === 0x12) r.set([1, 5], 5);
    return r;
  };
  const dev = new SimDevice({ vendorId: 0x1b1c, productId: 0x2b2a, handler, inputReportId: 8, collections: [{ usagePage: 0xff02, usage: 2 }] });
  const m = new SabreMouseSession(dev);
  const s = await m.read();
  assert.deepEqual(s.dpi, [400, 800, 1600, 3200, 6400]);
  assert.equal(s.pollingHz, 1000);
  for (const c of [{ kind: "polling", hz: 8000 }, { kind: "liftOff", value: 4 }, { kind: "motionSync", on: true }, { kind: "angleSnap", on: true }, { kind: "activeStage", stage: 2 }, { kind: "dpi", stage: 4, dpi: 26000 }]) {
    const r = await m.apply(c);
    assert.equal(r.verdict, "confirmed", JSON.stringify(c));
  }
  await assert.rejects(m.apply({ kind: "debounce", ms: 8 }), /isn't supported/);
  await m.close();
  return `SABRE v2 PRO receiver (EEPROM): ${dev.received.length} frames`;
}

const lines = [];
for (const pid of [0x2b0e, 0x2b31, 0x2b30]) lines.push(await keyboardRun(pid));
lines.push(await bragiMouseRun(0x2b43, false));
lines.push(await bragiMouseRun(0x2b1c, true));
lines.push(await sabreRun());
console.log(lines.join("\n"));
console.log("ok: CORSAIR sessions");
