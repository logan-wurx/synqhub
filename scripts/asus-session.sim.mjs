// Headless end-to-end check of the ASUS Gear Link sessions (src/lib/brands/asus) against simulated
// keyboards and mice that answer the way Gear Link's SDK expects. No hardware, no window, no Tauri.
//   node scripts/asus-session.sim.mjs
//
// The simulated firmware has its own list of dangerous first bytes (independent of guard.ts) and
// throws if one ever arrives, so a guard regression fails the run.
import assert from "node:assert/strict";
import { SimDevice, hex, u16 } from "./brands-sim-device.mjs";
import { AsusKbBackend } from "../src/lib/brands/asus/keyboard.ts";
import { AsusMouseSession } from "../src/lib/brands/asus/mouse.ts";
import { asusModel } from "../src/lib/brands/asus/devices.ts";
import { classifyAsusFrame } from "../src/lib/brands/asus/guard.ts";
import { FW_KEY } from "../src/lib/keyboard-protocol.ts";
import { KbSession, memoryKbStore } from "../src/lib/kb/session.ts";

function dangerous(f) {
  const [c, s] = f;
  if ([0x7b, 0x7f, 0x43, 0x10, 0x11, 0x1f, 0x20, 0x21, 0x22, 0x82, 0x8e, 0x8f, 0xba, 0xb0, 0xa2, 0x74, 0x80, 0x52].includes(c)) return true;
  if (c === 0x50 && [0x40, 0x60, 0x61].includes(s)) return true;
  if (c === 0x51 && [0x52, 0x56, 0x27, 0x35, 0x41, 0x42, 0x30].includes(s)) return true;
  return String.fromCharCode(...f).includes("ASUSHIDFWU");
}

// ---------------------------------------------------------------------------------------------
// Simulated Gear Link keyboard
// ---------------------------------------------------------------------------------------------
function simKeyboard(pid, reportId = 0) {
  const model = asusModel(pid);
  const cls = { m605: "hfx", m606: "hfx", m901: "he-v1", m703: "he-v1", m705: "he-v1" }[model.productNumber] ?? "he-v2";
  const unit = model.analog.unitMm === 0.01 ? 100 : 10;
  const st = {
    act: 1 * unit,
    dz: [0.2 * unit, 0.2 * unit], // bottom, top
    keys: new Map(),
    trig: new Map(),
    rtMode: 1,
    speedTap: 0,
    pairs: [[FW_KEY.KeyA, FW_KEY.KeyD]],
    poll: 0,
    profile: 1,
    writes: 0,
  };
  const key = (k) => st.keys.get(k) ?? (st.keys.set(k, { act: st.act, dz: [...st.dz], rt: { mm: 0, cont: 0, en: 0, s1: 0.2 * unit, s2: 0.2 * unit } }), st.keys.get(k));
  const reply = (f, ...bytes) => {
    const r = new Uint8Array(64);
    r.set(f.subarray(0, 6));
    bytes.forEach(([i, v]) => (r[i] = v));
    return r;
  };
  const w16 = (i, v) => [[i, v & 0xff], [i + 1, v >> 8]];
  const handler = (f) => {
    if (dangerous(f)) throw new Error(`DANGEROUS FRAME REACHED THE KEYBOARD: ${hex(f.subarray(0, 12))}`);
    assert.notEqual(classifyAsusFrame(pid, f).verdict, "blocked", `guard let ${hex(f.subarray(0, 12))} through`);
    const [c, s] = f;
    if (c === 0x12 && s === 0x00) return reply(f, [4, 0x36], [5, 0x00], [6, 0x01], [8, 6], [9, 1], [10, st.profile], [11, 1]);
    if (c === 0x12 && s === 0x15) return reply(f, [4, st.poll]);
    if (c === 0x25 && s === 0x00) return reply(f, [4, st.rtMode]);
    if (c === 0x25 && s === 0x01) return reply(f, [4, st.speedTap]);
    if (c === 0x25 && s === 0x08) {
      const r = reply(f);
      if (f[2] === 0) st.pairs.slice(0, 3).forEach(([a, b], i) => r.set([a & 0xff, a >> 8, b & 0xff, b >> 8], 4 + 4 * i));
      return r;
    }
    if (c === 0x25) {
      if (cls === "hfx") return reply(f, [0, 0xff], [1, 0xaa]);
      const k = u16(f, 4);
      const v2 = s >= 0xa0;
      const base = v2 ? 6 : 4;
      switch (s & 0x1f) {
        case 0x05:
          return reply(f, ...w16(base, st.act));
        case 0x04:
          return reply(f, ...w16(base, key(k).act));
        case 0x0a:
          return reply(f, [base, st.dz[0]], [base + 1, st.dz[1]]);
        case 0x09:
          return reply(f, [base, key(k).dz[0]], [base + 1, key(k).dz[1]]);
        case 0x06: {
          const rt = key(k).rt;
          const r = reply(f, ...w16(2, rt.mm), ...w16(base, rt.s1), ...w16(base + 2, rt.s2));
          if (v2) r[10] = rt.cont;
          r[v2 ? 11 : 9] = rt.en;
          return r;
        }
        case 0x02: {
          const t = st.trig.get(k) ?? k;
          return reply(f, ...w16(2, 0), ...w16(v2 ? 6 : 4, t));
        }
      }
      return reply(f, [0, 0xff], [1, 0xaa]);
    }
    if (c === 0x50 && s === 0x55) {
      st.writes++;
      return f;
    }
    if (c === 0x51) {
      switch (s) {
        case 0x00:
          st.profile = f[4];
          break;
        case 0x50:
          st.act = u16(f, 4);
          break;
        case 0x4f:
          key(u16(f, 4)).act = u16(f, 6);
          break;
        case 0x58:
          st.dz = [f[4], f[5]];
          break;
        case 0x59:
          key(u16(f, 4)).dz = [f[6], f[7]];
          break;
        case 0x54: {
          const rt = key(u16(f, 4)).rt;
          if (cls === "hfx") {
            rt.en = f[8];
            rt.cont = f[7];
            if (f[2] === 0) rt.s1 = rt.s2 = f[6];
            else if (f[2] === 1) rt.s1 = f[6];
            else rt.s2 = f[6];
            rt.mm = f[2] === 0 ? 0 : 1;
          } else {
            rt.mm = f[2];
            rt.cont = f[6];
            rt.en = f[7];
            rt.s1 = u16(f, 8);
            rt.s2 = f[2] === 1 ? u16(f, 10) : rt.s1;
          }
          break;
        }
        case 0x5c:
          st.rtMode = f[4];
          break;
        case 0x57:
          st.speedTap = f[4];
          break;
        case 0x21:
          st.trig.set(u16(f, 2), u16(f, 4));
          break;
        case 0x31:
          st.poll = f[4];
          break;
      }
      return f;
    }
    return f;
  };
  const dev = new SimDevice({ vendorId: 0x0b05, productId: pid, productName: model.name, inputReportId: reportId, collections: [{ usagePage: 0xff00, usage: 1, outputReports: [{ reportId }] }, { usagePage: 0xffc0, usage: 1 }], handler });
  return { dev, st, model, cls, unit };
}

async function keyboardRun(pid, reportId = 0) {
  const { dev, st, model, cls, unit } = simKeyboard(pid, reportId);
  const backend = new AsusKbBackend(dev, model);
  await backend.load();
  const session = new KbSession(backend, memoryKbStore(), { vendorId: 0x0b05, productId: pid, productName: model.name });
  await assert.rejects(session.apply({ kind: "analog", target: "global", values: { actuationMm: 1.5 } }), /allow changes/i, "read-only until allowed");
  session.setAllowChanges(true);
  const readable = cls !== "hfx";
  const W = FW_KEY.KeyW;
  const A = FW_KEY.KeyA;
  const results = [];
  const expect = async (change, verdict) => {
    const r = await session.apply(change);
    results.push([change.kind, r.verdict]);
    assert.equal(r.verdict, verdict, `${model.name}: ${JSON.stringify(change)} -> ${r.verdict} (${r.detail})`);
    return r;
  };
  const v = readable ? "confirmed" : "unconfirmed";
  await expect({ kind: "analog", target: "global", values: { actuationMm: 1.25 } }, v);
  assert.equal(st.act, Math.round(1.25 * unit));
  await expect({ kind: "analog", target: [W, A], values: { actuationMm: 0.4, deadTopMm: 0.3, deadBottomMm: 0.2 } }, v);
  assert.equal(st.keys.get(W).act, Math.round(0.4 * unit));
  assert.deepEqual(st.keys.get(A).dz, [Math.round(0.2 * unit), Math.round(0.3 * unit)]);
  await expect({ kind: "analog", target: [W], values: { rapidTrigger: true, rtPressMm: cls === "hfx" ? 0.1 : 0.15, rtReleaseMm: 0.3 } }, v);
  assert.equal(st.keys.get(W).rt.en, 1);
  await expect({ kind: "keycode", layer: 0, key: FW_KEY.Insert, code: FW_KEY.ScrollLock }, v);
  assert.equal(st.trig.get(FW_KEY.Insert), FW_KEY.ScrollLock);
  await expect({ kind: "keycode", layer: 1, key: FW_KEY.Escape, code: FW_KEY.Delete }, v);
  assert.equal(st.trig.get(0x9f00 + FW_KEY.Escape), FW_KEY.Delete);
  await expect({ kind: "option", id: "speedTap", value: 1 }, v);
  assert.equal(st.speedTap, 1);
  if (backend.traits.rtEnableCommand) {
    await expect({ kind: "option", id: "rapidTriggerMode", value: 0 }, "confirmed");
    assert.equal(st.rtMode, 0);
  }
  if (backend.traits.polling51) {
    await expect({ kind: "polling", hz: 8000 }, v);
    assert.equal(st.poll, 3);
  } else assert.throws(() => backend.plan({ kind: "polling", hz: 8000 }), /aren.t supported/);
  await expect({ kind: "profile", index: 2 }, "confirmed");
  assert.equal(st.profile, 2);
  await expect({ kind: "lighting", id: "brightness", value: 50 }, "unconfirmed");
  // Out of range values never reach the device.
  const before = dev.received.length;
  await assert.rejects(session.apply({ kind: "analog", target: "global", values: { actuationMm: 9 } }), /between/);
  await assert.rejects(session.apply({ kind: "analog", target: [FW_KEY.FN], values: { actuationMm: 1 } }), /not an analog key/);
  assert.equal(dev.received.length, before);
  // Every write batch ended with a save.
  assert.ok(st.writes >= 8, `${st.writes} saves`);
  for (const { f, reportId: id } of dev.received) {
    assert.notEqual(classifyAsusFrame(pid, f).verdict, "blocked");
    assert.equal(id, reportId, "control report id from the descriptor");
  }
  await session.close();
  return `${model.name} (${cls}): ${dev.received.length} frames, ${results.length} changes, ${st.writes} saves`;
}

// ---------------------------------------------------------------------------------------------
// Simulated Gear Link mouse
// ---------------------------------------------------------------------------------------------
async function mouseRun(pid) {
  const model = asusModel(pid);
  const st = { raw: [799, 1599, 3199, 63], poll: 3, deb: 2, snap: 0, ms: 0, stage: 1, profile: 0, lod: 1 };
  const handler = (f) => {
    if (dangerous(f)) throw new Error(`DANGEROUS FRAME REACHED THE MOUSE: ${hex(f.subarray(0, 12))}`);
    const r = new Uint8Array(64);
    r.set(f.subarray(0, 4));
    const [c, s, a] = f;
    if (c === 0x12 && s === 0x00) r.set([0x10, 0x00, 0x01, 0x00, 5, 1, st.profile, st.stage], 4);
    else if (c === 0x12 && s === 0x04 && a === 0) {
      st.raw.forEach((v, i) => r.set([v & 0xff, v >> 8], 4 + 2 * i));
      r.set([st.poll, 0, st.deb, 0, st.snap], 12);
    } else if (c === 0x12 && s === 0x04 && a === 4) r[4] = st.ms;
    else if (c === 0x12 && s === 0x06) r.set([0, st.lod], 4);
    else if (c === 0x12 && s === 0x07) r.set([77, 0, 0, 0, 0, 1], 4);
    else if (c === 0x51 && s === 0x31) {
      if (a <= 3) st.raw[a] = u16(f, 4);
      else if (a === 4) st.poll = f[4];
      else if (a === 5) st.deb = f[4];
      else if (a === 6) st.snap = f[4];
      else if (a === 9) st.stage = f[4];
      else if (a === 18) st.ms = f[4];
      return f;
    } else if (c === 0x50 && s === 0x02) {
      st.profile = f[2];
      return f;
    } else if (c === 0x50 && s === 0x03) return f;
    else throw new Error(`unexpected ${hex(f.subarray(0, 8))}`);
    return r;
  };
  const dev = new SimDevice({ vendorId: 0x0b05, productId: pid, handler, collections: [{ usagePage: 0xff01, usage: 1 }] });
  let allow = false;
  const m = new AsusMouseSession(dev, model, { allowWrites: () => allow });
  const s = await m.read();
  assert.equal(s.dpi.length, 4);
  await assert.rejects(m.apply({ kind: "polling", hz: 1000 }), /switched off/);
  allow = true;
  const t = m.traits;
  const out = [];
  const go = async (c) => {
    const r = await m.apply(c);
    assert.equal(r.verdict, "confirmed", `${model.name} ${JSON.stringify(c)}: got ${JSON.stringify(r.got)}`);
    out.push(c.kind);
  };
  await go({ kind: "dpi", stage: 0, dpi: t.dpiBase === 1 ? 1601 : 1650 });
  await go({ kind: "polling", hz: 500 });
  if (t.debounce) await go({ kind: "debounce", ms: 16 });
  if (t.angleSnap) await go({ kind: "angleSnap", on: true });
  if (t.motionSync) await go({ kind: "motionSync", on: true });
  await go({ kind: "activeStage", stage: 2 });
  await go({ kind: "profile", index: 3 });
  await assert.rejects(m.apply({ kind: "liftOff", value: 2 }), /read-only/);
  assert.ok(!dev.received.some(({ f }) => f[0] === 0x51 && f[1] === 0x35), "51 35 never sent");
  assert.ok(dev.received.some(({ f }) => f[0] === 0x50 && f[1] === 0x03), "saved with 50 03");
  await m.close();
  return `${model.name} (base ${t.dpiBase}): ${dev.received.length} frames, ${out.length} changes confirmed`;
}

const lines = [];
for (const pid of [0x1c10, 0x1c7d, 0x1d68, 0x1df5, 0x1b7e]) lines.push(await keyboardRun(pid));
lines.push(await keyboardRun(0x1d6a, 2) + " (2.4 GHz dongle, report 2)");
assert.throws(() => new AsusKbBackend(simKeyboard(0x1c10, 1).dev, asusModel(0x1c10)), /unexpected report id/);
for (const pid of [0x1c69, 0x1db0, 0x1b16]) lines.push(await mouseRun(pid));
console.log(lines.join("\n"));
console.log("ok: ASUS sessions");
