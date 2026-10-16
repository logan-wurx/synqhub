// Checks src/lib/kb/fcc/sonix-protocol.ts (+ sonix-devices.ts) against Fighting Control Center.
// Run (no device, no window): node --test scripts/fcc-sonix-codec.test.ts
//
// Evidence, as in scripts/x68he-codec.test.ts:
//  1. Golden frames written out by hand from FCC docs/PROTOCOL.md and app/src/hid/protocol.ts.
//  2. "Mirror" builders: line-by-line transcriptions of FCC's own encoders (app/src/hid/protocol.ts
//     buildPacket, app/src/hid/codec.ts encodeBinding / withRT / encodeLed / withDks / encodeMacros /
//     encodeSettings), compared with SYNQ's over many random inputs. FCC is GPL-3.0-or-later; the
//     transcriptions keep its logic for comparison only.
//  3. A real read of FCC's own Fighting68 (fw 1.25), from FCC's backups/ folder, through the decoders.
//  4. The allowlist: every encoder output passes; every blocked command and malformed frame fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../src/lib/kb/fcc/sonix-protocol.ts";
import { SONIX_CATALOG, SONIX_USB_IDS, SONIX_WIRED, detectSonix, layoutKeys, modelOf, sonixCoverage } from "../src/lib/kb/fcc/sonix-devices.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
let seed = 4242;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const h = (f: Uint8Array) => P.hex(f);
const fromHex = (s: string) => {
  const f = new Uint8Array(64);
  s.trim().split(/\s+/).forEach((b, i) => (f[i] = parseInt(b, 16)));
  return f;
};

// ---------------------------------------------------------------------------------------------
// The real Fighting68 read (sparse fixture)
// ---------------------------------------------------------------------------------------------

const fixture = JSON.parse(fs.readFileSync(path.join(here, "fcc-fighting68-fw125.fixture.json"), "utf8")) as { regions: Record<P.RegionName, [number, [number, number][]]> };
const baseline = Object.fromEntries(
  Object.entries(fixture.regions).map(([k, [n, nz]]) => {
    const b = new Uint8Array(n);
    for (const [i, v] of nz) b[i] = v;
    return [k, b];
  }),
) as Record<P.RegionName, Uint8Array>;

// ---------------------------------------------------------------------------------------------
// Mirrors of FCC's encoders
// ---------------------------------------------------------------------------------------------

/** protocol.ts buildPacket */
function mirrorBuildPacket(cmd: number, offset: number, payload: ArrayLike<number>) {
  const p = new Uint8Array(64);
  p[0] = 0xaa;
  p[1] = cmd;
  p[2] = payload.length;
  p[3] = offset & 0xff;
  p[4] = (offset >> 8) & 0xff;
  p.set(Array.from(payload, (v) => v & 0xff), 8);
  return p;
}

/** device.ts readRegion / writeRegion frame sequences */
function mirrorReadFrames(read: number, size: number) {
  const out: Uint8Array[] = [];
  for (let off = 0; off < size; off += 56) out.push(mirrorBuildPacket(read, off, new Uint8Array(Math.min(56, size - off))));
  return out;
}
function mirrorWriteFrames(write: number, name: string, size: number, data: Uint8Array) {
  const out: Uint8Array[] = [];
  const len = name === "settings" ? 16 : size;
  for (let off = 0; off < len; off += 56) out.push(mirrorBuildPacket(write, off, data.slice(off, Math.min(off + 56, len))));
  return out;
}

const fclamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

/** codec.ts encodeBinding */
function mirrorEncodeBinding(b: P.Binding): number[] {
  switch (b.type) {
    case "default": return [0, 0, 0, 0];
    case "key": return [2, b.mods & 0xff, b.code & 0xff, 0];
    case "media": return [3, b.usage & 0xff, (b.usage >> 8) & 0xff, 0];
    case "mouse": return [1, 1, b.button & 0xff, 0];
    case "wheel": return [1, 3, b.dir, 0];
    case "macro": return [6, b.index & 0xff, b.mode, b.mode === 1 ? fclamp(b.repeat, 1, 255) : 0];
    case "dks": return [8, b.slot & 0xff, 0, 0];
    case "modtap": return [9, b.hold & 0xff, b.tap & 0xff, fclamp(b.ms / 10, 1, 255)];
    case "toggle": return [10, b.code & 0xff, 0, 0];
    case "socd": return [11, b.mode & 0xff, b.key1 & 0xff, b.key2 & 0xff];
    case "rs": return [12, 0, b.key1 & 0xff, b.key2 & 0xff];
    case "unknown": return b.bytes;
  }
}

/** codec.ts withRT with RT_LIMITS = the board's limits */
function mirrorWithRT(rt: Uint8Array, ids: number[], patch: Partial<P.KeyRT>, L: { actuationDefault: number; actuationMin: number; actuationMax: number; sensMin: number; sensMax: number }) {
  const out = rt.slice();
  const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
  const setU16 = (b: Uint8Array, o: number, v: number) => ((b[o] = v & 0xff), (b[o + 1] = (v >> 8) & 0xff));
  for (const id of ids) {
    const o = id * 8;
    const cur = { switchType: out[o], flags: out[o + 1], actuation: u16(out, o + 2), press: u16(out, o + 4), release: u16(out, o + 6) };
    const k = { ...cur, ...patch };
    out[o] = k.switchType & 0xff;
    out[o + 1] = k.flags & 0x07;
    setU16(out, o + 2, fclamp(k.actuation || L.actuationDefault, L.actuationMin, L.actuationMax));
    setU16(out, o + 4, k.press === 0 ? 0 : fclamp(k.press, L.sensMin, L.sensMax));
    setU16(out, o + 6, k.release === 0 ? 0 : fclamp(k.release, L.sensMin, L.sensMax));
  }
  return out;
}

/** codec.ts encodeLed */
function mirrorEncodeLed(prev: Uint8Array, l: P.Led) {
  const out = prev.slice();
  out[0] = l.effect & 0xff;
  out[1] = fclamp(l.r, 0, 255);
  out[2] = fclamp(l.g, 0, 255);
  out[3] = fclamp(l.b, 0, 255);
  out[4] = 255;
  out[8] = l.rainbow ? 1 : 0;
  out[9] = fclamp(l.brightness, 1, 5);
  out[10] = fclamp(l.speed, 1, 5);
  out[11] = l.direction ? 1 : 0;
  out[14] = 0xaa;
  out[15] = 0x55;
  return out;
}

/** codec.ts withDks (DKS_POINT_MAX = travel / 10) */
function mirrorWithDks(dks: Uint8Array, slot: number, s: P.DksSlot | null, pointMax: number) {
  const out = dks.slice();
  const o = slot * 16;
  out.fill(0, o, o + 16);
  if (!s) return out;
  s.points.forEach((p, i) => (out[o + i] = fclamp(p, 1, pointMax)));
  s.keys.forEach((k, i) => (out[o + 5 + i * 2] = k & 0xff));
  s.actions.forEach((row, m) =>
    row.forEach((a, j) => {
      if (!s.keys[m]) return;
      if (a === "hold" && j < 3) out[o + 12 + j] |= 1 << (m + 4);
      else if (a !== "none") out[o + 12 + j] |= 1 << m;
    }),
  );
  return out;
}

/** codec.ts encodeMacros */
function mirrorEncodeMacros(macros: P.MacroEvent[][]) {
  const out = new Uint8Array(4008);
  const setU16 = (b: Uint8Array, o: number, v: number) => ((b[o] = v & 0xff), (b[o + 1] = (v >> 8) & 0xff));
  let addr = 400;
  macros.forEach((events, i) => {
    out.set([addr & 0xff, (addr >> 8) & 0xff, (addr >> 16) & 0xff, (addr >> 24) & 0xff], i * 4);
    setU16(out, addr, events.length * 2);
    events.forEach((e, r) => {
      const o = addr + 4 + r * 4;
      setU16(out, o, fclamp(e.delay, 0, 65535));
      out[o + 2] = e.code & 0xff;
      out[o + 3] = (e.down ? 0x80 : 0) | (e.mouse ? 0x10 : 0x30);
    });
    addr += 4 + events.length * 4;
  });
  return out;
}

/** codec.ts encodeSettings (polling as a code) */
function mirrorEncodeSettings(prev: Uint8Array, v: { sleepMinutes: number; polling: number; stability: boolean; adaptiveCalibration: boolean; allKeyWake: boolean }) {
  const out = prev.slice();
  out[3] = fclamp(v.sleepMinutes, 0, 30);
  if ([3, 5, 6].includes(v.polling)) out[5] = v.polling;
  out[11] = v.stability ? 1 : 0;
  out[14] = v.adaptiveCalibration ? 1 : 0;
  out[15] = v.allKeyWake ? 1 : 0;
  return out;
}

// Random inputs inside the ranges FCC's UI produces.
const hidKey = () => 4 + rnd(0x64 - 4);
function randomBinding(): P.Binding {
  switch (rnd(11)) {
    case 0: return { type: "default" };
    case 1: return { type: "key", mods: rnd(256), code: hidKey() };
    case 2: return { type: "media", usage: [0xe2, 0xe9, 0xea, 0xcd, 0xb5, 0xb6, 0x192, 0x223][rnd(8)] };
    case 3: return { type: "mouse", button: P.MOUSE_BUTTONS[rnd(5)] };
    case 4: return { type: "wheel", dir: rnd(2) ? 1 : 255 };
    case 5: { const mode = rnd(3) as 0 | 1 | 2; return { type: "macro", index: rnd(100), mode, repeat: mode === 1 ? 1 + rnd(255) : 0 }; }
    case 6: return { type: "dks", slot: 1 + rnd(63) };
    case 7: return { type: "modtap", hold: 0xe0 + rnd(8), tap: hidKey(), ms: 10 * (1 + rnd(100)) };
    case 8: return { type: "toggle", code: hidKey() };
    case 9: return { type: "socd", mode: P.SOCD_MODES[rnd(4)], key1: hidKey(), key2: hidKey() };
    default: return { type: "rs", key1: hidKey(), key2: hidKey() };
  }
}
function randomDks(): P.DksSlot {
  const keys: P.DksSlot["keys"] = [rnd(3) ? hidKey() : 0, rnd(2) ? 0xe0 + rnd(8) : 0, rnd(2) ? hidKey() : 0, 0];
  const acts: P.DksAction[] = ["none", "tap", "hold"];
  return { points: [1 + rnd(33), 1 + rnd(33), 1 + rnd(33), 1 + rnd(33)], keys, actions: [0, 1, 2, 3].map(() => [0, 1, 2, 3].map(() => acts[rnd(3)])) };
}
function randomMacros(): P.MacroEvent[][] {
  return Array.from({ length: rnd(6) }, () => Array.from({ length: 1 + rnd(12) }, () => ({ code: rnd(2) ? hidKey() : [1, 2, 4][rnd(3)], down: !!rnd(2), mouse: !rnd(4), delay: rnd(2000) })));
}
const fighting68 = modelOf(SONIX_CATALOG.find((d) => d.id === "fighting68")!);

// ---------------------------------------------------------------------------------------------
// 1. Golden frames
// ---------------------------------------------------------------------------------------------

test("golden frames from FCC docs/PROTOCOL.md", () => {
  // [0xAA, cmd, len, offset lo, offset hi, 0, 0, 0, payload]
  assert.equal(h(P.encodeRegionRead("info")[0]), "aa 10 18");
  assert.equal(P.encodeRegionRead("info").length, 1);
  const keys = P.encodeRegionRead("keys");
  assert.equal(keys.length, 10);
  assert.equal(h(keys[0]), "aa 12 38");
  assert.equal(h(keys[9]), "aa 12 08 f8 01"); // 9 * 56 = 504 = 0x1F8, last 8 bytes
  assert.equal(P.encodeRegionRead("macros").length, 72); // 4008 = 71 * 56 + 32
  assert.equal(h(P.encodeRegionRead("macros")[71]), "aa 15 20 88 0f"); // 71 * 56 = 3976 = 0x0F88, last 32 bytes
  assert.equal(h(P.encodeCommit()), "aa 00 04");
  assert.equal(h(P.encodeRegionWrite("settings", new Uint8Array(32))[0]), "aa 21 10");
  assert.equal(P.encodeRegionWrite("settings", new Uint8Array(32)).length, 1);
  assert.equal(P.encodeRegionWrite("rt", new Uint8Array(1024)).length, 19); // 18 * 56 + 16
  const led = P.encodeRegionWrite("led", P.encodeLed(baseline.led, { ...P.decodeLed(baseline.led), effect: 0x0b, r: 0x12, g: 0x34, b: 0x56, direction: 1 }))[0];
  assert.equal(h(led), "aa 23 10 00 00 00 00 00 0b 12 34 56 ff 00 00 00 01 05 03 01 00 00 aa 55");
});

test("macro region's last chunk", () => {
  // 4008 bytes: 71 chunks of 56 (3976 = 0x0F88) then 32 bytes.
  const last = P.encodeRegionRead("macros")[71];
  assert.equal(last[2], 32);
  assert.equal(last[3] | (last[4] << 8), 3976);
});

// ---------------------------------------------------------------------------------------------
// 2. Mirrors
// ---------------------------------------------------------------------------------------------

test("region read / write frames match FCC device.ts", () => {
  for (const [name, def] of Object.entries(P.REGIONS) as [P.RegionName, P.RegionDef][]) {
    assert.deepEqual(P.encodeRegionRead(name).map(h), mirrorReadFrames(def.read, def.size).map(h), name);
    if (def.write === null) continue;
    for (let n = 0; n < 5; n++) {
      const data = new Uint8Array(def.size).map(() => rnd(256));
      assert.deepEqual(P.encodeRegionWrite(name, data).map(h), mirrorWriteFrames(def.write, name, def.size, data).map(h), name);
    }
  }
});

test("bindings match FCC encodeBinding and decode back", () => {
  for (let n = 0; n < 3000; n++) {
    const b = randomBinding();
    const bytes = P.encodeBinding(b);
    assert.deepEqual(bytes, mirrorEncodeBinding(b), JSON.stringify(b));
    assert.equal(P.bindingProblem(...bytes), null, JSON.stringify(b));
    const keys = P.withBinding(new Uint8Array(512), [n % 128], b);
    const back = P.decodeBinding(keys, n % 128);
    assert.deepEqual(P.encodeBinding(back), bytes);
  }
});

test("rapid trigger matches FCC withRT", () => {
  for (const entry of SONIX_WIRED.slice(0, 40)) {
    const m = modelOf(entry);
    const L = { ...m.rt, actuationDefault: m.limits.actuationDefault };
    let mine = baseline.rt.slice();
    let theirs = baseline.rt.slice();
    for (let n = 0; n < 30; n++) {
      const ids = Array.from({ length: 1 + rnd(8) }, () => m.keys[rnd(m.keys.length)].index);
      const patch: P.RtPatch = {};
      if (rnd(2)) patch.actuation = rnd(450);
      if (rnd(2)) patch.press = rnd(3) ? rnd(450) : 0;
      if (rnd(2)) patch.release = rnd(3) ? rnd(450) : 0;
      if (rnd(2)) patch.flags = rnd(8);
      mine = P.withRT(mine, ids, patch, m.rt, m.limits.actuationDefault);
      theirs = mirrorWithRT(theirs, ids, patch, L);
      assert.equal(h(mine), h(theirs), entry.id);
    }
  }
});

test("lighting, DKS, macros and settings match FCC", () => {
  for (let n = 0; n < 300; n++) {
    const l: P.Led = { effect: P.EFFECTS[rnd(P.EFFECTS.length)].id, r: rnd(256), g: rnd(256), b: rnd(256), rainbow: !!rnd(2), brightness: 1 + rnd(5), speed: 1 + rnd(5), direction: rnd(2) as 0 | 1 };
    assert.equal(h(P.encodeLed(baseline.led, l)), h(mirrorEncodeLed(baseline.led, l)));
    const slot = 1 + rnd(63);
    const s = rnd(5) ? randomDks() : null;
    assert.equal(h(P.withDks(baseline.dks, slot, s, 33)), h(mirrorWithDks(baseline.dks, slot, s, 33)));
    if (s) assert.deepEqual(P.decodeDks(P.withDks(new Uint8Array(1024), slot, s, 33), slot).keys, s.keys);
    const macros = randomMacros();
    const enc = P.encodeMacros(macros);
    assert.equal(h(enc), h(mirrorEncodeMacros(macros)));
    assert.deepEqual(P.decodeMacros(enc), macros.map((m) => m.map((e) => ({ ...e, delay: Math.round(e.delay) }))));
    const v = { sleepMinutes: rnd(31), polling: [3, 5, 6][rnd(3)], stability: !!rnd(2), adaptiveCalibration: false, allKeyWake: !!rnd(2) };
    const mine = P.encodeSettings(baseline.settings, { sleepMinutes: v.sleepMinutes, pollHz: P.POLL_CODE_TO_HZ[v.polling], stability: v.stability, allKeyWake: v.allKeyWake });
    assert.equal(h(mine), h(mirrorEncodeSettings(baseline.settings, v)));
  }
});

// ---------------------------------------------------------------------------------------------
// 3. The real Fighting68 read
// ---------------------------------------------------------------------------------------------

test("decoders on FCC's Fighting68 (fw 1.25) read", () => {
  const info = P.decodeInfo(baseline.info);
  assert.equal(info.firmware, "1.25");
  assert.equal(info.vendorId, 0x0c45);
  assert.equal(info.productId, 0x8030);
  assert.equal(info.macroCapacity, 0x1200);
  const s = P.decodeSettings(baseline.settings);
  assert.equal(s.pollHz, null); // never set: firmware default
  assert.equal(s.sleepMinutes, 0);
  const led = P.decodeLed(baseline.led);
  assert.deepEqual(led, { effect: 1, r: 255, g: 255, b: 255, rainbow: true, brightness: 5, speed: 3, direction: 0 });
  // A (index 49) remapped to A: [2, 0, 0x04, 0]
  assert.deepEqual(P.decodeBinding(baseline.keys, 49), { type: "key", mods: 0, code: 0x04 });
  assert.equal(P.decodeBinding(baseline.keys, 50).type, "default");
  // Esc: actuation 1.20 mm, RT off. Q (33): 1.20 mm, RT 0.16 / 0.16 mm. A (49) and D (51): 0.80 mm, RT 0.16 mm.
  assert.deepEqual(P.decodeRT(baseline.rt, 0), { switchType: 0, flags: 0, actuation: 120, press: 0, release: 0 });
  assert.deepEqual(P.decodeRT(baseline.rt, 33), { switchType: 0, flags: 0, actuation: 120, press: 16, release: 16 });
  assert.ok(P.rtEnabled(P.decodeRT(baseline.rt, 33)));
  assert.deepEqual(P.decodeRT(baseline.rt, 49), { switchType: 0, flags: 0, actuation: 80, press: 16, release: 16 });
  assert.equal(P.decodeRT(baseline.rt, 51).actuation, 80);
  assert.equal(P.rtEnabled(P.decodeRT(baseline.rt, 34)), false);
  assert.deepEqual(P.decodeColor(baseline.colors, 5), [0, 0, 0]);
  assert.equal(baseline.colors[5 * 4], 5); // index byte
  assert.deepEqual(P.decodeMacros(baseline.macros), []);
  assert.equal(P.freeDksSlot(baseline.dks), 1);
  // Every key on FCC's Fighting68 layout has an RT entry; keys off the layout are all zero.
  const onLayout = new Set(fighting68.keys.map((k) => k.index));
  for (let i = 0; i < 128; i++) if (!onLayout.has(i)) assert.deepEqual(P.decodeRT(baseline.rt, i), { switchType: 0, flags: 0, actuation: 0, press: 0, release: 0 }, `index ${i}`);
});

test("writing the Fighting68 read back unchanged passes the allowlist", () => {
  for (const name of P.PROFILE_REGIONS) {
    if (name === "led") continue;
    for (const f of P.encodeRegionWrite(name, baseline[name])) assert.ok(P.checkFrame(f).ok, `${name}: ${P.checkFrame(f).reason}`);
  }
  for (const f of P.encodeRegionWrite("settings", baseline.settings)) assert.ok(P.checkFrame(f).ok);
  // The board reads lighting bytes 4, 14 and 15 back as 0, but the official driver (and FCC) always
  // writes 255 / 0xAA / 0x55 there: SYNQ writes lighting through encodeLed, never the raw read...
  assert.equal(P.checkFrame(P.encodeRegionWrite("led", baseline.led)[0]).ok, false);
  const led = P.encodeLed(baseline.led, P.decodeLed(baseline.led));
  assert.ok(P.checkFrame(P.encodeRegionWrite("led", led)[0]).ok);
  // ...and doesn't expect those three bytes to read back.
  assert.deepEqual(P.READBACK_IGNORE.led, [4, 14, 15]);
  assert.equal(P.readBackMismatch("led", led, baseline.led), -1);
  assert.equal(P.readBackMismatch("led", led, P.encodeLed(baseline.led, { ...P.decodeLed(baseline.led), brightness: 2 })), 9);
});

// ---------------------------------------------------------------------------------------------
// 4. Allowlist
// ---------------------------------------------------------------------------------------------

/** Every frame SYNQ's encoders can produce, over many inputs. */
function allEncoderFrames(): Uint8Array[] {
  const frames: Uint8Array[] = [P.encodeCommit()];
  for (const name of P.READ_ORDER) frames.push(...P.encodeRegionRead(name));
  for (let n = 0; n < 40; n++) {
    const m = modelOf(SONIX_WIRED[rnd(SONIX_WIRED.length)]);
    const idx = () => m.keys[rnd(m.keys.length)].index;
    let keys = baseline.keys;
    for (let k = 0; k < 6; k++) keys = P.withBinding(keys, [idx()], randomBinding());
    frames.push(...P.encodeRegionWrite("keys", keys));
    frames.push(...P.encodeRegionWrite("rt", P.withRT(baseline.rt, [idx(), idx()], { actuation: rnd(500), press: rnd(500), release: rnd(500), flags: rnd(8) }, m.rt, m.limits.actuationDefault)));
    frames.push(...P.encodeRegionWrite("dks", P.withDks(baseline.dks, 1 + rnd(63), randomDks(), m.rt.travel / 10)));
    frames.push(...P.encodeRegionWrite("macros", P.encodeMacros(randomMacros())));
    frames.push(...P.encodeRegionWrite("led", P.encodeLed(baseline.led, { effect: P.EFFECTS[rnd(P.EFFECTS.length)].id, r: rnd(256), g: rnd(256), b: rnd(256), rainbow: !!rnd(2), brightness: rnd(9), speed: rnd(9), direction: rnd(2) as 0 | 1 })));
    frames.push(...P.encodeRegionWrite("colors", P.withColors(baseline.colors, new Map([[rnd(126), [rnd(256), rnd(256), rnd(256)] as const]]))));
    frames.push(...P.encodeRegionWrite("settings", P.encodeSettings(baseline.settings, { sleepMinutes: rnd(31), pollHz: P.POLL_HZ[rnd(3)], stability: !!rnd(2), allKeyWake: !!rnd(2) })));
  }
  return frames;
}

test("every encoder frame is allowlisted", () => {
  for (const f of allEncoderFrames()) {
    const c = P.checkFrame(f);
    assert.ok(c.ok, `${h(f)}: ${c.reason}`);
    assert.ok(!P.FORBIDDEN_COMMANDS.has(f[1]));
  }
});

test("blocked commands are refused in every form", () => {
  const forms = (cmd: number) => [
    fromHex(`aa ${cmd.toString(16)}`),
    fromHex(`aa ${cmd.toString(16)} ff`),
    fromHex(`aa ${cmd.toString(16)} 05`),
    fromHex(`aa ${cmd.toString(16)} 04`),
    P.bulkFrame(cmd, 0, [0xff]),
    P.bulkFrame(cmd, 0, new Uint8Array(56)),
  ];
  for (const cmd of [0x0f, 0x26, 0x62, 0x64, 0x65, 0x66, 0x67, 0xfb, 0xfc]) {
    for (const f of forms(cmd)) assert.equal(P.checkFrame(f).ok, false, `0x${cmd.toString(16)} ${h(f)}`);
  }
  // Factory reset exactly as FCC sends it (store.ts factoryReset: command(0x0F, [0xFF])).
  assert.match(P.checkFrame(fromHex("aa 0f ff")).reason!, /factory reset/);
  // Calibration start / save exactly as FCC's live-travel panel sends them.
  assert.equal(P.checkFrame(fromHex("aa 64")).ok, false);
  assert.equal(P.checkFrame(fromHex("aa 65")).ok, false);
});

test("every command byte outside the allowlist is refused", () => {
  const allowed = new Set([0x00, ...Object.values(P.REGIONS).flatMap((d) => (d.write === null ? [d.read] : [d.read, d.write]))]);
  for (let cmd = 0; cmd < 256; cmd++) {
    if (allowed.has(cmd)) continue;
    for (const f of [P.bulkFrame(cmd, 0, new Uint8Array(4)), P.bulkFrame(cmd, 0, new Uint8Array(16)), P.bulkFrame(cmd, 0, new Uint8Array(56)), fromHex(`aa ${cmd.toString(16)} 01`)])
      assert.equal(P.checkFrame(f).ok, false, h(f));
  }
});

test("malformed frames are refused", () => {
  const good = P.encodeRegionRead("keys")[1];
  assert.ok(P.checkFrame(good).ok);
  const bad = (mut: (f: Uint8Array) => void) => {
    const f = good.slice();
    mut(f);
    return P.checkFrame(f).ok;
  };
  assert.equal(P.checkFrame(new Uint8Array(63)).ok, false);
  assert.equal(P.checkFrame(new Uint8Array(65)).ok, false);
  assert.equal(bad((f) => (f[0] = 0x55)), false);
  assert.equal(bad((f) => (f[3] += 1)), false); // misaligned offset
  assert.equal(bad((f) => (f[2] = 55)), false); // wrong length
  assert.equal(bad((f) => (f[5] = 1)), false);
  assert.equal(bad((f) => (f[8] = 1)), false); // read with payload
  assert.equal(bad((f) => (f[63] = 1)), false);
  assert.equal(P.checkFrame(P.bulkFrame(0x12, 560, new Uint8Array(8))).ok, false); // past the region
  assert.equal(P.checkFrame(fromHex("aa 00 04 00 00 00 00 00 01")).ok, false); // commit with data
});

test("write contents outside the known shapes are refused", () => {
  const write = (name: P.RegionName, data: Uint8Array, chunk = 0) => P.checkFrame(P.encodeRegionWrite(name, data)[chunk]);
  const set = (mut: (s: Uint8Array) => void) => {
    const s = baseline.settings.slice();
    mut(s);
    return write("settings", s).ok;
  };
  assert.equal(set(() => {}), true);
  for (const i of P.SETTINGS_UNKNOWN_BYTES) assert.equal(set((s) => (s[i] = 1)), false, `settings byte ${i}`);
  assert.equal(set((s) => (s[P.SET.polling] = 4)), false);
  assert.equal(set((s) => (s[P.SET.sleep] = 31)), false);
  assert.equal(set((s) => (s[P.SET.adaptiveCalibration] = 2)), false);
  assert.equal(set((s) => (s[P.SET.topDeadZone] = 30)), true); // preserved dead zone bytes pass the frame check...
  assert.match(P.settingsChangeProblem(baseline.settings, P.encodeSettings(baseline.settings, { pollHz: 8000 })) ?? "ok", /^ok$/);
  const dz = baseline.settings.slice();
  dz[P.SET.topDeadZone] = 30;
  assert.notEqual(P.settingsChangeProblem(baseline.settings, dz), null); // ...but the session never changes them
  const ac = baseline.settings.slice();
  ac[P.SET.adaptiveCalibration] = 1;
  assert.notEqual(P.settingsChangeProblem(baseline.settings, ac), null);

  const keys = baseline.keys.slice();
  keys.set([7, 1, 2, 3], 4 * 3); // unknown binding type 7
  assert.equal(write("keys", keys).ok, false);
  keys.set([8, 0, 0, 0], 4 * 3); // DKS slot 0
  assert.equal(write("keys", keys).ok, false);
  keys.set([11, 9, 4, 7], 4 * 3); // SOCD mode 9
  assert.equal(write("keys", keys).ok, false);

  const led = P.encodeLed(baseline.led, P.decodeLed(baseline.led));
  assert.ok(write("led", led).ok);
  for (const [i, v] of [[0, 0x14], [4, 0], [5, 1], [9, 6], [14, 0]] as const) {
    const l = led.slice();
    l[i] = v;
    assert.equal(write("led", l).ok, false, `led byte ${i}`);
  }

  const rt = baseline.rt.slice();
  rt[1] = 8; // flags
  assert.equal(write("rt", rt).ok, false);
  const rt2 = baseline.rt.slice();
  rt2[2] = 0x91; // 401 = 4.01 mm
  rt2[3] = 0x01;
  assert.equal(write("rt", rt2).ok, false);

  const dks = new Uint8Array(1024);
  dks[16 + 4] = 1; // reserved byte
  assert.equal(write("dks", dks).ok, false);
  const dks2 = new Uint8Array(1024);
  dks2[16] = 41; // 4.1 mm point
  assert.equal(write("dks", dks2).ok, false);

  const colors = baseline.colors.slice();
  colors[126 * 4 + 1] = 5; // slot 126 doesn't exist
  assert.equal(write("colors", colors, 9).ok, false);
  const macros = new Uint8Array(4008);
  macros[0] = 100; // address inside the index table
  assert.equal(write("macros", macros).ok, false);
});

test("codec refuses values the allowlist would refuse", () => {
  assert.throws(() => P.encodeBinding({ type: "socd", mode: 9, key1: 4, key2: 7 }));
  assert.throws(() => P.encodeBinding({ type: "dks", slot: 0 }));
  assert.throws(() => P.encodeBinding({ type: "key", mods: 0, code: 0x100 }));
  assert.throws(() => P.encodeSettings(baseline.settings, { pollHz: 2000 }));
  assert.throws(() => P.encodeSettings(baseline.settings, { sleepMinutes: 31 }));
  assert.throws(() => P.encodeLed(baseline.led, { ...P.decodeLed(baseline.led), effect: 0x40 }));
  assert.throws(() => P.encodeRegionWrite("fn", new Uint8Array(512)));
  assert.throws(() => P.encodeRegionWrite("info", new Uint8Array(24)));
  assert.throws(() => P.withDks(baseline.dks, 0, randomDks()));
});

// ---------------------------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------------------------

test("device table and detection follow FCC registry", () => {
  const c = sonixCoverage();
  assert.equal(c.catalogEntries, 148);
  assert.equal(c.wiredBoards, 136);
  assert.equal(c.verified, 1);
  assert.equal(c.untested, 135);
  assert.equal(c.usbIds, SONIX_USB_IDS.length);
  // Fighting68: shares 0c45:8030 with 7 other boards; the product name decides.
  const f = detectSonix(0x0c45, 0x8030, "Fighting68");
  assert.equal(f.model?.id, "fighting68");
  assert.ok(f.certain && f.verified);
  assert.equal(f.candidates.length, 8);
  const unknownName = detectSonix(0x0c45, 0x8030, "Some Keyboard");
  assert.equal(unknownName.certain, false);
  assert.equal(unknownName.verified, false);
  // One board on its id: certain without a name.
  const single = SONIX_WIRED.find((d) => SONIX_WIRED.filter((x) => x.vendorId === d.vendorId && x.productId === d.productId).length === 1)!;
  assert.ok(detectSonix(single.vendorId, single.productId, "").certain);
  // Not listed: dongles, unknowns, other Sonix gear (webcams).
  assert.equal(detectSonix(0x0c45, 0xfefe, "2.4G Dongle").model, null);
  assert.equal(detectSonix(0x0c45, 0x6366, "USB Camera").model, null);
  // Firmware-reported ids must match the USB ids.
  assert.equal(detectSonix(0x0c45, 0x8030, "Fighting68", { vendorId: 0x0c45, productId: 0x8031 }).model, null);
  // Every listed layout resolves, and its key indices fit the 128-entry regions.
  for (const d of SONIX_WIRED) {
    const keys = layoutKeys(d.layout);
    assert.ok(keys.length > 30, d.id);
    assert.ok(keys.every((k) => k.index >= 0 && k.index < 128), d.id);
    assert.equal(new Set(keys.map((k) => k.index)).size, keys.length, d.id);
  }
  assert.equal(fighting68.keys.length, 68);
});
