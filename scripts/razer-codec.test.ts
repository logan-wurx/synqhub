// Razer codec + allowlist tests. Pure: no device, no window.
// Run: node --test scripts/razer-codec.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildRazerV4Report } from "@openmouse/protocol/razer-v4";
import * as P from "../src/lib/brands/razer/protocol.ts";
import { RAZER_BLOCKED, RAZER_BRIDGE, classifyRazerFrame, isRazerBlocked, razerCommandFor, razerGuard } from "../src/lib/brands/razer/guard.ts";
import { RAZER_FEATURE_ONLY_PIDS, RAZER_KEYBOARDS, RAZER_KEY_IDS, RAZER_MICE, RAZER_VALID_KEY_IDS } from "../src/lib/brands/razer/devices.ts";

let seed = 4242;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const KEYS = [...RAZER_VALID_KEY_IDS];
const pick = <T>(a: readonly T[]) => a[rnd(a.length)];
const allowed = (f: Uint8Array) => classifyRazerFrame(f).verdict !== "blocked";

test("frame layout and checksum match openrazer / OpenMouse", () => {
  // OpenMouse's buildRazerV4Report always uses transaction id 0x1F; same command must give the same bytes.
  const ours = P.frame(P.encFirmware(), 0x1f);
  const om = buildRazerV4Report(0x00, 0x81, 2);
  assert.deepEqual(Array.from(ours), Array.from(om));
  const f = P.frame(P.encFirmware(), 0);
  assert.equal(f.length, 90);
  assert.deepEqual(Array.from(f.subarray(0, 8)), [0, 0, 0, 0, 0, 2, 0x00, 0x81]);
  assert.equal(f[88], 2 ^ 0x81);
  assert.equal(f[89], 0);
});

test("units: 1638 raw per 0.1 mm, release = actuation - 0.1 mm (floor 256)", () => {
  assert.equal(P.mmToRaw(1.2), 19656);
  assert.equal(P.mmToRaw(4.0), 65520);
  assert.equal(P.mmToRaw(0.1), 1638);
  assert.equal(P.rawToMm(19656), 1.2);
  assert.equal(P.releaseFor(19656), 18018);
  assert.equal(P.releaseFor(1638), 256);
});

test("actuation write bytes (Synapse setMultiAnalogKeyActuationPoint layout)", () => {
  const r = P.encActuationSet(2, [{ keyId: RAZER_KEY_IDS.W, actuationRaw: 19656, releaseRaw: 18018 }]);
  assert.equal(r.dataSize, 7);
  assert.deepEqual(Array.from(r.args), [0, 2, 18, 0x46, 0x62, 0x4c, 0xc8]);
  const f = P.frame(r, 3);
  assert.deepEqual(Array.from(f.subarray(5, 15)), [7, 0x02, 0x19, 0, 2, 18, 0x46, 0x62, 0x4c, 0xc8]);
  // all keys
  const all = P.encActuationSet(1, [{ keyId: 255, actuationRaw: 65520, releaseRaw: 63882 }]);
  assert.deepEqual(Array.from(all.args), [0, 1, 255, 0xf9, 0x8a, 0xff, 0xf0]);
  assert.throws(() => P.encActuationSet(1, [{ keyId: 255, actuationRaw: 1638, releaseRaw: 256 }, { keyId: 18, actuationRaw: 1638, releaseRaw: 256 }]));
  assert.throws(() => P.encActuationSet(1, [{ keyId: 18, actuationRaw: 1000, releaseRaw: 256 }]));
  assert.throws(() => P.encActuationSet(1, [{ keyId: 18, actuationRaw: 45864 + 1638, releaseRaw: 256 }], 45864), /outside/);
  assert.throws(() => P.encActuationSet(1, [{ keyId: 63, actuationRaw: 1638, releaseRaw: 256 }]), /not a Razer key/);
});

test("actuation / rapid-trigger reads and decoders", () => {
  const g = P.encActuationGet(2, [18, 31, 32]);
  assert.equal(g.dataSize, 17);
  assert.deepEqual(Array.from(g.args), [0, 2, 18, 0, 0, 0, 0, 31, 0, 0, 0, 0, 32, 0, 0, 0, 0]);
  const reply: P.Reply = { status: 2, tx: 0, dataSize: 12, cls: 2, id: 0x99, data: new Uint8Array([0, 2, 18, 0x46, 0x62, 0x4c, 0xc8, 31, 0x00, 0xff, 0x06, 0x66]), crcOk: true };
  assert.deepEqual(P.decActuation(reply), [
    { keyId: 18, releaseRaw: 18018, actuationRaw: 19656 },
    { keyId: 31, releaseRaw: 255, actuationRaw: 1638 },
  ]);
  const rt = P.encRapidTriggerSet(2, [{ keyId: 18, enabled: true, pressRaw: 4914, releaseRaw: 6552 }]);
  assert.deepEqual(Array.from(rt.args), [0, 2, 18, 1, 0x19, 0x98, 0x13, 0x32]);
  const back: P.Reply = { status: 2, tx: 0, dataSize: 8, cls: 2, id: 0x9a, data: rt.args, crcOk: true };
  assert.deepEqual(P.decRapidTrigger(back), [{ keyId: 18, enabled: true, releaseRaw: 6552, pressRaw: 4914 }]);
  assert.equal(P.encRapidTriggerGet(1, Array.from({ length: 13 }, (_, i) => KEYS[i])).dataSize, 80);
  assert.throws(() => P.encRapidTriggerGet(1, Array.from({ length: 14 }, (_, i) => KEYS[i])));
});

test("polling, profiles, brightness, dead zone, snap tap, DKP", () => {
  assert.deepEqual(Array.from(P.encPollingSet(2, 8000).args), [2, 0x01]);
  assert.deepEqual(Array.from(P.encPollingSet(2, 125).args), [2, 0x40]);
  assert.equal(P.decPolling(new Uint8Array([2, 0x04])), 2000);
  assert.throws(() => P.encPollingSet(2, 333));
  assert.deepEqual(P.decProfileList(new Uint8Array([3, 2, 3, 4, 0, 0])), [2, 3, 4]);
  assert.deepEqual(Array.from(P.encBrightnessSet(2, 100).args), [2, 0, 255]);
  assert.deepEqual(Array.from(P.encBrightnessSet(2, 50).args), [2, 0, 127]);
  assert.equal(P.decBrightness(new Uint8Array([2, 0, 255])), 100);
  assert.deepEqual(Array.from(P.encBottomDeadZoneSet(2, 5).args), [2, 5]);
  const st = P.encSnapTapSet(2, { enabled: true, pairs: [{ a: 31, b: 33, mode: P.SNAP_TAP_MODE.last }, { a: 18, b: 32, mode: P.SNAP_TAP_MODE.neutral }] });
  assert.equal(st.dataSize, 15);
  assert.deepEqual(Array.from(st.args), [2, 2, 1, 31, 33, 0, 18, 32, 3, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(P.decSnapTap(st.args), { enabled: true, pairs: [{ a: 31, b: 33, mode: 0 }, { a: 18, b: 32, mode: 3 }] });
  assert.throws(() => P.encSnapTapSet(2, { enabled: true, pairs: [{ a: 31, b: 31, mode: 0 }] }));
  const dk = P.encDualPrioritySet(2, { enabled: true, keys: [31, 33] });
  assert.deepEqual(Array.from(dk.args), [2, 2, 1, 31, 33, 0, 0]);
  assert.deepEqual(P.decDualPriority(dk.args), { enabled: true, keys: [31, 33] });
});

test("mouse: DPI stages, battery, lift", () => {
  const d = P.encDpiStagesSet(1, { active: 2, stages: [{ id: 1, x: 800, y: 800 }, { id: 2, x: 1600, y: 1600 }] });
  assert.equal(d.dataSize, 17);
  assert.deepEqual(Array.from(d.args), [1, 2, 2, 1, 0x03, 0x20, 0x03, 0x20, 0, 0, 2, 0x06, 0x40, 0x06, 0x40, 0, 0]);
  const rep: P.Reply = { status: 2, tx: 0, dataSize: 17, cls: 4, id: 0x86, data: d.args, crcOk: true };
  assert.deepEqual(P.decDpiStages(rep), { active: 2, stages: [{ id: 1, x: 800, y: 800 }, { id: 2, x: 1600, y: 1600 }] });
  assert.throws(() => P.encDpiStagesSet(1, { active: 3, stages: [{ id: 1, x: 800, y: 800 }] }));
  assert.equal(P.decBattery(new Uint8Array([0, 255])), 100);
  assert.deepEqual(Array.from(P.encLiftSet(2).args), [0, 4, 1, 1]);
  assert.deepEqual(P.decLift(new Uint8Array([0, 4, 1, 1])), { mode: 1, level: 2, asymmetric: false });
  assert.deepEqual(Array.from(P.encProximityOn().args), [0, 4, 1]);
});

test("reply parsing: 91-byte form, crc, status", () => {
  const f = P.frame(P.encPollingGet(1), 7);
  f[0] = P.STATUS.ok;
  f[9] = 0x08;
  f[88] = P.crc(f);
  const r = P.parseReply(new Uint8Array([0, ...f]));
  assert.equal(r.status, 2);
  assert.equal(r.tx, 7);
  assert.equal(r.crcOk, true);
  assert.equal(P.decPolling(r.data), 1000);
  assert.throws(() => P.parseReply(new Uint8Array(64)));
});

// ------------------------------------------------------------------------------------------------
// Allowlist
// ------------------------------------------------------------------------------------------------

/** Every encoder, many valid inputs. */
export function allEncoderFrames(): Uint8Array[] {
  const out: Uint8Array[] = [];
  const tx = () => (rnd(10) === 0 ? 0xff : rnd(32));
  const add = (r: P.Request) => out.push(P.frame(r, tx()));
  for (const r of [P.encFirmware(), P.encSerial(), P.encProfileCount(), P.encProfileList(), P.encActiveProfileGet(), P.encBattery(), P.encCharging(), P.encLiftGet(), P.encProximityOn()]) add(r);
  for (let p = 0; p <= P.MAX_PROFILE_ID; p++) {
    add(P.encPollingGet(p));
    add(P.encBottomDeadZoneGet(p));
    add(P.encSnapTapGet(p));
    add(P.encSingleSnapTapGet(p));
    add(P.encDualPriorityGet(p));
    add(P.encBrightnessGet(p));
    add(P.encDpiStagesGet(p));
    for (const hz of [125, 250, 500, 1000, 2000, 4000, 8000]) add(P.encPollingSet(p, hz));
    if (p >= 1) add(P.encActiveProfileSet(p));
  }
  for (let lvl = 1; lvl <= 10; lvl++) add(P.encLiftSet(lvl));
  for (let n = 0; n < 400; n++) {
    const p = rnd(P.MAX_PROFILE_ID + 1);
    const nk = 1 + rnd(15);
    const keys = [...new Set(Array.from({ length: nk }, () => pick(KEYS)))];
    add(P.encActuationGet(p, keys));
    const act = P.mmToRaw((1 + rnd(40)) / 10);
    add(P.encActuationSet(p, keys.map((keyId) => ({ keyId, actuationRaw: act, releaseRaw: P.releaseFor(act) }))));
    if (rnd(4) === 0) add(P.encActuationSet(p, [{ keyId: 255, actuationRaw: act, releaseRaw: P.releaseFor(act) }]));
    const rk = keys.slice(0, 13);
    add(P.encRapidTriggerGet(p, rk));
    add(P.encRapidTriggerSet(p, rk.map((keyId) => ({ keyId, enabled: !!rnd(2), pressRaw: P.mmToRaw((1 + rnd(20)) / 10), releaseRaw: P.mmToRaw((1 + rnd(20)) / 10) }))));
    add(P.encBottomDeadZoneSet(p, 1 + rnd(20)));
    const pairs = Array.from({ length: rnd(5) }, () => {
      const a = pick(KEYS);
      let b = pick(KEYS);
      while (b === a) b = pick(KEYS);
      return { a, b, mode: rnd(5) };
    });
    add(P.encSnapTapSet(p, { enabled: !!rnd(2), pairs }));
    add(P.encSingleSnapTapSet(p, { enabled: !!rnd(2), keys: Array.from({ length: rnd(5) }, () => ({ keyId: pick(KEYS), keyCode: rnd(256) })) }));
    add(P.encDualPrioritySet(p, { enabled: !!rnd(2), keys: [...new Set(Array.from({ length: rnd(5) }, () => pick(KEYS)))].slice(0, 4) }));
    add(P.encBrightnessSet(p, rnd(101)));
    const ns = 1 + rnd(5);
    add(P.encDpiStagesSet(p, { active: 1 + rnd(ns), stages: Array.from({ length: ns }, (_, i) => ({ id: i + 1, x: 100 + rnd(32900), y: 100 + rnd(32900) })) }));
  }
  return out;
}

test("every allowed command, built by the encoders, passes the guard", () => {
  const frames = allEncoderFrames();
  assert.ok(frames.length > 3000);
  for (const f of frames) {
    const v = razerGuard.classify({ type: "feature", reportId: 0, data: f });
    assert.notEqual(v.verdict, "blocked", `${Array.from(f.subarray(0, 16), (x) => x.toString(16)).join(" ")}: ${v.verdict === "blocked" ? v.reason : ""}`);
    assert.equal(v.verdict, P.CMD[razerCommandFor(f[6], f[7])!].kind);
  }
  // every command in the table is reachable
  const seen = new Set(frames.map((f) => razerCommandFor(f[6], f[7])));
  for (const name of Object.keys(P.CMD)) assert.ok(seen.has(name as P.CmdName), `${name} never built`);
});

test("no command SYNQ can build is on the blocked list (blocked ones are unreachable)", () => {
  for (const [name, c] of Object.entries(P.CMD)) assert.equal(isRazerBlocked(c.cls, c.id), false, `${name} is blocked`);
  // the framer only takes names from CMD
  assert.throws(() => P.frame({ cmd: "deviceMode" as P.CmdName, args: new Uint8Array(2), dataSize: 2 }, 0));
  // and nothing the encoders produce carries a blocked class/id
  for (const f of allEncoderFrames()) assert.equal(isRazerBlocked(f[6], f[7]), false);
});

function rawFrame(cls: number, id: number, args: number[] = [], size = args.length, tx = 0): Uint8Array {
  const f = new Uint8Array(90);
  f[1] = tx;
  f[5] = size;
  f[6] = cls;
  f[7] = id;
  f.set(args, 8);
  f[88] = P.crc(f);
  return f;
}

test("every blocked command is refused, with its reason", () => {
  for (const b of RAZER_BLOCKED) {
    const ids = b.id === "*" ? Array.from({ length: 256 }, (_, i) => i) : [b.id];
    for (const id of ids) {
      for (const args of [[], [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [9, 0]]) {
        const v = classifyRazerFrame(rawFrame(b.cls, id, args, Math.max(args.length, 2)));
        assert.equal(v.verdict, "blocked");
        if (v.verdict === "blocked") assert.equal(v.why, b.why);
      }
    }
  }
  // device mode, bootloader mode 1 and test mode 2 specifically
  for (const mode of [0, 1, 2, 3, 4, 8, 9]) assert.equal(allowed(rawFrame(0x00, 0x04, [mode, 0])), false);
  assert.equal(allowed(rawFrame(0x00, 0x84, [])), false);
});

test("shape checks: report type, id, length, status, padding, crc, tx", () => {
  const good = P.frame(P.encPollingGet(1), 5);
  assert.equal(allowed(good), true);
  assert.equal(razerGuard.classify({ type: "output", reportId: 0, data: good }).verdict, "blocked");
  assert.equal(razerGuard.classify({ type: "feature", reportId: 1, data: good }).verdict, "blocked");
  assert.equal(allowed(good.subarray(0, 64)), false);
  const mut = (i: number, v: number) => {
    const f = new Uint8Array(good);
    f[i] = v;
    if (i !== 88) f[88] = P.crc(f);
    return f;
  };
  assert.equal(allowed(mut(0, 2)), false, "status");
  assert.equal(allowed(mut(2, 1)), false, "remaining packets");
  assert.equal(allowed(mut(4, 1)), false, "protocol type");
  assert.equal(allowed(mut(40, 1)), false, "padding");
  assert.equal(allowed(mut(88, good[88] ^ 1)), false, "crc");
  assert.equal(allowed(mut(89, 1)), false, "reserved");
  assert.equal(allowed(mut(1, 0x40)), false, "tx");
  assert.equal(allowed(mut(5, 81)), false, "size");
  assert.equal(allowed(mut(9, 0x40)), false, "polling read with a value");
});

test("argument checks refuse out-of-range writes", () => {
  const act = (key: number, rel: number, a: number) => rawFrame(0x02, 0x19, [0, 1, key, rel >> 8, rel & 255, a >> 8, a & 255]);
  assert.equal(allowed(act(18, 18018, 19656)), true);
  assert.equal(allowed(act(18, 18018, 1000)), false);
  assert.equal(allowed(act(18, 100, 19656)), false);
  assert.equal(allowed(act(18, 20000, 19656)), false);
  assert.equal(allowed(act(63, 18018, 19656)), false);
  assert.equal(allowed(rawFrame(0x00, 0x40, [1, 0x03])), false, "polling code 3");
  assert.equal(allowed(rawFrame(0x05, 0x04, [0])), false, "profile 0");
  assert.equal(allowed(rawFrame(0x05, 0x04, [9])), false, "profile 9");
  assert.equal(allowed(rawFrame(0x0b, 0x0b, [0, 4, 4, 0])), false, "asymmetric lift mode");
  assert.equal(allowed(rawFrame(0x0b, 0x0b, [0, 5, 1, 0])), false, "other sensor");
  assert.equal(allowed(rawFrame(0x0b, 0x03, [0, 4, 0])), false, "proximity off");
  assert.equal(allowed(rawFrame(0x02, 0x28, [1, 0])), false, "dead zone 0");
  assert.equal(allowed(rawFrame(0x04, 0x06, [1, 1, 1, 1, 0xff, 0xff, 0x03, 0x20, 0, 0])), false, "65535 dpi");
});

test("fuzz: random and mutated frames never pass with an unknown or blocked command", () => {
  const valid = allEncoderFrames();
  let passed = 0;
  for (let n = 0; n < 60000; n++) {
    let f: Uint8Array;
    if (n % 3 === 0) {
      f = new Uint8Array(90);
      f[1] = rnd(32);
      f[5] = rnd(81);
      f[6] = rnd(256);
      f[7] = rnd(256);
      for (let i = 0; i < f[5]; i++) f[8 + i] = rnd(4) ? 0 : rnd(256);
      f[88] = P.crc(f);
    } else {
      f = new Uint8Array(pick(valid));
      const flips = 1 + rnd(3);
      for (let k = 0; k < flips; k++) f[rnd(n % 2 ? 12 : 90)] = rnd(256);
      if (rnd(2)) f[88] = P.crc(f);
    }
    const v = classifyRazerFrame(f);
    if (v.verdict === "blocked") continue;
    passed++;
    const name = razerCommandFor(f[6], f[7]);
    assert.ok(name, "passed without a known command");
    assert.equal(isRazerBlocked(f[6], f[7]), false);
    assert.equal(f[88], P.crc(f));
    assert.ok(f[0] === 0 && f[2] === 0 && f[3] === 0 && f[4] === 0 && f[89] === 0);
  }
  assert.ok(passed > 0);
});

test("device tables and bridge allowances agree", () => {
  const bridged = RAZER_BRIDGE.flatMap((b) => b.productIds).sort((a, b) => a - b);
  assert.deepEqual(bridged, [...RAZER_FEATURE_ONLY_PIDS]);
  for (const b of RAZER_BRIDGE) {
    assert.equal(b.vendorId, 0x1532);
    assert.equal(b.usagePage, 0x000c);
    assert.equal(b.usage, 0x0001);
    assert.equal(b.access, "featureOnly");
    assert.deepEqual(b.reportIds, [0]);
    assert.equal(b.length, 90);
  }
  // no PID twice, none that OpenMouse already drives
  const pids = [...RAZER_KEYBOARDS.map((m) => m.pid), ...RAZER_MICE.map((m) => m.pid)];
  assert.equal(new Set(pids).size, pids.length);
  for (const om of [0x00be, 0x00bf, 0x00e5, 0x00e6, 0x00ef, 0x00f0]) assert.ok(!pids.includes(om));
  for (const m of RAZER_KEYBOARDS) assert.ok(m.actuation.maxRaw <= P.ACTUATION_MAX_RAW && m.actuation.minRaw === 1638);
});
