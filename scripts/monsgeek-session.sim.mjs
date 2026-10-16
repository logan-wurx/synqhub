// Headless end-to-end check of src/lib/brands/monsgeek/session.ts against simulated keyboards that answer
// the way the firmware does per FCC's MockRyTransport (GPL-3.0), sharkfin's PROTOCOL.md and the vendor
// app's byte layouts. No hardware, no window, no Tauri: a fake HidLike in memory.
// Run: node scripts/monsgeek-session.sim.mjs
import assert from "node:assert/strict";
import * as P from "../src/lib/brands/monsgeek/protocol.ts";
import { classifyFrame } from "../src/lib/brands/monsgeek/guard.ts";
import { keyPositions, modelByDevId } from "../src/lib/brands/monsgeek/devices.ts";
import { MonsGeekSession, OFFICIAL_PACING, WriteRefusedError } from "../src/lib/brands/monsgeek/session.ts";
import { BlockedFrameError } from "../src/lib/brands/local-kb.ts";

const FAST = { sendGapMs: 0, readGapMs: 0, afterWriteMs: 0, afterCommitMs: 0, identifyRetryMs: 0 };
const noSleep = async () => {};
let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

// ---------------------------------------------------------------------------------------------
// Simulated firmware
// ---------------------------------------------------------------------------------------------

/**
 * gen2 (RY5088) board. Answers GETs with an echo, paged reads with raw pages, stages per-key table
 * writes until a commit frame (sharkfin: "Packets without last sit in RAM unapplied"), checks every
 * checksum, and fails the test if a blocked frame ever arrives.
 */
function gen2Board({ devId = 2307, pid = 0x5030, firmware = 0x0410, precisionCode = 0, featureList = true, boot = false, actuation = 200, profiles = 4 } = {}) {
  const u16 = (v) => {
    const t = new Uint8Array(256);
    for (let p = 0; p < 128; p++) t.set([v & 0xff, v >> 8], p * 2);
    return t;
  };
  const profile = () => ({
    keymap: [0, 1, 2, 3].map(() => new Uint8Array(512)),
    tables: new Map([
      [0, u16(actuation)],
      [1, u16(actuation)],
      [2, u16(30)],
      [3, u16(30)],
      [4, u16(100)],
      [6, u16(30)],
      [5, new Uint8Array(128).fill(20)],
      [7, new Uint8Array(128)],
      [9, new Uint8Array(128).fill(0xff)],
      [10, new Uint8Array(512)],
    ]),
  });
  const s = {
    devId,
    firmware,
    profile: 0,
    profiles: Array.from({ length: profiles }, profile),
    polling: 3,
    debounce: 2,
    kb: [0, 0, 0, 0, 0], // os, fn, anti, stab, wasd
    led: [1, 2, 4, 0x08, 0x00, 0xe5, 0xff],
    live: u16(0),
  };
  // Factory keymap: a key on every position of the model's key mask (letters as filler).
  const model = modelByDevId(devId);
  const keys = keyPositions(model) ?? Array.from({ length: 70 }, (_, p) => p);
  for (const pr of s.profiles) for (const p of keys) pr.keymap[0].set([0, 0, 4 + (p % 40), 0], p * 4);
  s.profiles[1].keymap[0].set([0, 0, 0x29, 0], keys[0] * 4); // profile 1 differs at the first key
  s.live.set([0x2a, 0x01], keys[3] * 2); // one key pressed 2.98 mm

  const staged = [];
  const received = [];
  const quirks = { dropNextCommit: false, silentNext: 0 };
  let answer = new Uint8Array(64);

  function handle(d) {
    const out = new Uint8Array(64);
    const echo = (...bytes) => {
      out.set([d[0], ...bytes]);
      return out;
    };
    const page = (buf, n) => {
      out.set(buf.subarray(n * 64, n * 64 + 64));
      return out;
    };
    const pr = s.profiles[s.profile];
    switch (d[0]) {
      case 0x8f:
        return echo(devId & 0xff, (devId >> 8) & 0xff, (devId >> 16) & 0xff, devId >>> 24, 0, 0, firmware & 0xff, firmware >> 8, boot ? 1 : 0);
      case 0x80:
        return echo(0, 0); // gen2 answers zeros over the cable [SF]
      case 0xe6:
        return featureList ? echo(0xaa, precisionCode) : echo(); // without a feature list the request is echoed [SF]
      case 0x84:
        return echo(s.profile);
      case 0x04:
        if (d[1] < s.profiles.length) s.profile = d[1];
        return out;
      case 0x83:
        return echo(0, s.polling);
      case 0x03:
        s.polling = d[2];
        return out;
      case 0x86:
        return echo(s.debounce);
      case 0x06:
        s.debounce = d[1];
        return out;
      case 0x89:
        return echo(...s.kb);
      case 0x09:
        s.kb = [s.kb[0], d[2], d[3], d[4], d[5]]; // OS byte re-derived by the firmware [EZ]
        return out;
      case 0x87:
        return echo(...s.led);
      case 0x07:
        s.led = Array.from(d.subarray(1, 8));
        return out;
      case 0x8a:
        return page(s.profiles[d[1]].keymap[d[4]], d[3]);
      case 0x0a: {
        const km = s.profiles[d[1]].keymap[d[6]];
        if (d[2] === 0xff) km.set(d.subarray(8, 8 + d[4]), d[3] * 56);
        else km.set(d.subarray(8, 12), d[2] * 4);
        return out;
      }
      case 0xe5: {
        if (d[1] === 254) return page(s.live, d[3]);
        return page(pr.tables.get(d[1]) ?? new Uint8Array(512), d[3]);
      }
      case 0x65: {
        staged.push(d.slice());
        if (d[4] === 1) {
          // commit: apply everything staged (gen2 apply clamps: travel < 10 -> 15, RT 0 -> 1) [SF]
          const drop = quirks.dropNextCommit;
          quirks.dropNextCommit = false;
          for (const f of staged.splice(0)) {
            if (drop) continue;
            const [, sub, , pos] = f;
            if (sub === 8) {
              const t = pr.tables.get(10);
              for (let g = 0; g < 4; g++) t[g * 128 + pos] = f[8 + g];
              continue;
            }
            const t = pr.tables.get(sub);
            if (P.U16_TABLES.includes(sub)) {
              let v = f[8] | (f[9] << 8);
              if ((sub === 0 || sub === 1 || sub === 4) && v < 10) v = 15;
              if ((sub === 2 || sub === 3) && v === 0) v = 1;
              t.set([v & 0xff, v >> 8], pos * 2);
            } else t[pos] = f[8];
          }
        }
        return out;
      }
      default:
        throw new Error(`sim: unexpected command 0x${d[0].toString(16)}`);
    }
  }

  const listeners = [];
  const hid = {
    vendorId: 0x3151,
    productId: pid,
    productName: "Sim RY5088",
    collections: [{ usagePage: 0xffff, usage: 2 }],
    async sendReport() {
      throw new Error("sim: an output report was sent on a feature-only channel");
    },
    async sendFeatureReport(reportId, data) {
      assert.equal(reportId, 0, "report id 0");
      assert.equal(data.length, 64, "64 data bytes");
      const d = Uint8Array.from(data);
      if (P.blockedOpcode(d[0])) throw new Error(`BLOCKED FRAME REACHED THE DEVICE: ${P.hexBytes(d, 8)}`);
      const v = classifyFrame(d, "any");
      if (v.verdict === "blocked") throw new Error(`frame outside the allowlist reached the device: ${P.hexBytes(d, 12)} (${v.reason})`);
      if (!P.checksumOk(d)) throw new Error(`bad checksum on 0x${d[0].toString(16)}`);
      received.push(d);
      answer = handle(d);
    },
    async receiveFeatureReport(reportId) {
      assert.equal(reportId, 0);
      if (quirks.silentNext > 0) {
        quirks.silentNext--;
        return new DataView(new Uint8Array(64).buffer); // a stale/empty answer
      }
      // Chrome on some platforms prepends the report id; exercise that path half the time.
      const withId = received.length % 2 === 0;
      const buf = withId ? Uint8Array.from([0, ...answer]) : answer.slice();
      return new DataView(buf.buffer);
    },
    addEventListener(type, l) {
      listeners.push(l);
      throw new Error("sim: a feature-only session subscribed to input reports");
    },
    removeEventListener() {},
  };
  return { hid, s, received, quirks, keys };
}

/** yc500 (YC3121) board: answers the yc500 GETs only; any gen2 write opcode fails the test. */
function yc500Board({ devId = 1674, revision = 0x0200 } = {}) {
  const received = [];
  let answer = new Uint8Array(64);
  const cols = new Map([
    [0, 18],
    [1, 28],
    [2, 2],
    [3, 2],
    [4, 2],
    [5, 30],
    [6, 33],
    [7, 0],
    [9, 255],
  ]);
  const hid = {
    vendorId: 0x3151,
    productId: 0x4035,
    productName: "Sim YC3121",
    async sendReport() {
      throw new Error("output report");
    },
    async sendFeatureReport(reportId, data) {
      const d = Uint8Array.from(data);
      if (classifyFrame(d, "yc500").verdict !== "read") throw new Error(`non-read frame reached a yc500 board: ${P.hexBytes(d, 8)}`);
      received.push(d);
      const out = new Uint8Array(64);
      switch (d[0]) {
        case 0x8f:
          out.set([0x8f, devId & 0xff, devId >> 8, 0, 0, 0, 0, 0, 0, 0]);
          break;
        case 0x80:
          out.set([0x80, revision & 0xff, revision >> 8]);
          break;
        case 0x85:
          out.set([0x85, 1]);
          break;
        case 0x91:
          out.set([0x91, 0, 5]);
          break;
        case 0x86:
          out.set([0x86, 0, 8 | 1, 0, 0]);
          break;
        case 0x87:
          out.set([0x87, 4, 3, 4, 0x07, 1, 2, 3]);
          break;
        case 0x89:
          for (let i = 0; i < 16; i++) out.set([0, 0, 4 + i, 0], i * 4);
          break;
        case 0xe5: {
          const v = cols.get(d[1]) ?? 0;
          out.fill(v);
          break;
        }
        default:
          throw new Error(`yc500 sim: unexpected 0x${d[0].toString(16)}`);
      }
      answer = out;
    },
    async receiveFeatureReport() {
      return new DataView(answer.slice().buffer);
    },
    addEventListener() {
      throw new Error("input subscription");
    },
    removeEventListener() {},
  };
  return { hid, received };
}

const refused = async (p, re) => {
  await assert.rejects(p, (e) => e instanceof WriteRefusedError && (!re || re.test(e.message)));
  checks++;
};

// ---------------------------------------------------------------------------------------------
// 1. gen2: connect and read
// ---------------------------------------------------------------------------------------------
let allow = false;
const board = gen2Board();
const log = [];
const s = await MonsGeekSession.connect({ hid: board.hid, allowWrites: () => allow, pacing: FAST, sleep: noSleep, log: (dir, _id, data, note) => log.push([dir, data[0], note]) });
ok(s.identity.devId === 2307 && s.model.name === "FUN60 Ultra", "identified FUN60 Ultra by dev id");
ok(s.family === "gen2" && s.tier === "experimental" && s.scope === "gen2", "gen2 / experimental");
ok(s.unitMm === 0.01 && s.unitSource === "featureList", `unit from the feature list (${s.unitMm})`);
ok(s.unitsOk, `units check: ${s.unitsWhy}`);
ok(s.state.profile.value === 0 && s.state.pollingHz.value === 1000 && s.state.debounceMs.value === 2, "profile / polling / debounce read");
ok(s.state.lighting.value.mode === 1 && s.state.lighting.value.colour === "fixed" && s.state.lighting.value.speed === 2, "lighting decoded");
ok(s.keySettings(board.keys[0]).actuationMm === 2 && s.keySettings(board.keys[0]).kind === "normal", "per-key settings in mm");
ok(s.caps.polling?.includes(8000) && s.caps.analog.actuation.step === 0.01, "caps: 8 kHz polling, 0.01 mm steps");
ok(OFFICIAL_PACING.sendGapMs === 10 && OFFICIAL_PACING.afterWriteMs === 100 && OFFICIAL_PACING.afterCommitMs === 300, "official pacing constants");
const readsOnly = board.received.length;
ok(board.received.every((f) => classifyFrame(f, "any").verdict === "read"), "connect sent reads only");

// ---------------------------------------------------------------------------------------------
// 2. Writes are refused until allowWrites() says yes
// ---------------------------------------------------------------------------------------------
const [k0, k1, k2, k3, k4, k5] = board.keys;
await refused(s.setActuation([k0], 1.5), /allowWrites/);
await refused(s.setPolling(8000), /allowWrites/);
ok(board.received.length === readsOnly, "nothing reached the board while writes were off");
allow = true;

// ---------------------------------------------------------------------------------------------
// 3. Writes with read-back
// ---------------------------------------------------------------------------------------------
let r = await s.setActuation([k0, k1, k2], 1.5);
ok(r.status === "confirmed" && board.s.profiles[0].tables.get(0)[k0 * 2] === 150, `actuation 1.5 mm -> 150 counts (${r.status})`);
ok(s.keySettings(k1).actuationMm === 1.5, "cache updated from the read-back");
const commits = board.received.filter((f) => f[0] === 0x65);
ok(commits.slice(-3).map((f) => f[4]).join() === "0,0,1", "commit flag on the last frame only");

r = await s.setRelease([k0], 1.2);
ok(r.status === "confirmed" && s.keySettings(k0).releaseMm === 1.2, "release point");

r = await s.setRapidTrigger([k0, k1], { enabled: true, pressMm: 0.3, releaseMm: 0.4 });
ok(r.status === "confirmed" && s.keySettings(k0).rapidTrigger && s.keySettings(k0).rtPressMm === 0.3 && s.keySettings(k1).rtReleaseMm === 0.4, "rapid trigger on, 0.3 / 0.4 mm");

r = await s.setSnapTap(k2, k3);
ok(r.status === "confirmed" && s.keySettings(k2).kind === "snap" && s.keySettings(k2).snapPartner === k3 && s.keySettings(k3).snapPartner === k2, "snap tap pair");
r = await s.clearSnapTap(k2);
ok(r.status === "confirmed" && s.keySettings(k2).kind === "normal" && s.keySettings(k3).kind === "normal" && s.keySettings(k3).snapPartner === null, "snap tap cleared on both keys");

r = await s.setPolling(8000);
ok(r.status === "confirmed" && board.s.polling === 0 && s.state.pollingHz.value === 8000, "polling 8000 Hz");

r = await s.remapKey(k4, P.ENTRY.key(0x39));
ok(r.status === "confirmed" && P.sameEntry(board.s.profiles[0].keymap[0].subarray(k4 * 4, k4 * 4 + 4), [0, 0, 0x39, 0]), "single-key remap");

r = await s.setKeyMode(k5, { kind: "modTap", hold: P.ENTRY.key(0xe0), tap: P.ENTRY.key(0x29), holdMs: 200 });
ok(r.status === "confirmed" && s.keySettings(k5).kind === "modTap" && s.keySettings(k5).modTapMs === 200, "mod-tap");
ok(P.sameEntry(board.s.profiles[0].keymap[1].subarray(k5 * 4, k5 * 4 + 4), [0, 0, 0x29, 0]), "mod-tap: tap key on sub-layer 1");

r = await s.setKeyMode(k5, { kind: "dks", firstMm: 0.8, keys: [P.ENTRY.key(4), P.ENTRY.key(5), P.ENTRY.none(), P.ENTRY.key(7)], rows: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0], [3, 2, 0, 0]] });
ok(r.status === "confirmed" && s.keySettings(k5).kind === "dks" && s.keySettings(k5).dksPointMm === 0.8, `DKS (${r.status})`);
ok(s.keySettings(k5).dksRows.join() === [1, 4, 0, 0b1011].join(), "DKS rows read back through table 10");

r = await s.setKeyMode(k5, { kind: "normal", key: P.ENTRY.key(0x2c) });
ok(r.status === "confirmed" && s.keySettings(k5).kind === "normal", "back to normal");
ok([1, 2, 3].every((l) => P.sameEntry(board.s.profiles[0].keymap[l].subarray(k5 * 4, k5 * 4 + 4), [0, 0, 0, 0])), "leaving DKS clears sub-layers 1..3");

r = await s.setLighting({ mode: 4, speed: 4, variant: 2, colour: "rainbow" });
ok(r.status === "confirmed" && board.s.led[0] === 4 && board.s.led[1] === 0 && board.s.led[3] === 0x27, `lighting wave, fastest, direction 2, rainbow (${P.hexBytes(board.s.led)})`);
r = await s.setLighting({ mode: 1, colour: "fixed", rgb: [255, 255, 255] });
ok(r.status === "confirmed" && board.s.led.slice(4, 7).join() === "250,250,250" && s.state.lighting.value.rgb.join() === "255,255,255", "white sent as FA FA FA");

r = await s.setOptions({ wasdSwap: true, rtStabilityMs: 50 });
ok(r.status === "confirmed" && board.s.kb[4] === 1 && board.s.kb[3] === 2, "options: WASD swap, RT stability 50 ms");

const layer = s.state.keymap[0].value.slice();
layer.set(P.ENTRY.consumer(0xe9), k1 * 4);
r = await s.writeSublayer(0, layer);
ok(r.status === "confirmed" && board.received.filter((f) => f[0] === 0x0a && f[2] === 0xff).length === 10, "sub-layer write: 10 pages, read back");

const live = await s.readLiveTravel();
ok(Math.abs(live.get(k3) - 2.98) < 1e-9 && live.get(k0) === 0, "live travel");

// ---------------------------------------------------------------------------------------------
// 4. Mismatch and unconfirmed handling
// ---------------------------------------------------------------------------------------------
board.quirks.dropNextCommit = true;
r = await s.setActuation([k0], 2.5);
ok(r.status === "mismatch" && r.wrote[0].value === 250 && r.read[0].value === 150, "a write the board didn't apply comes back as a mismatch");
ok(s.keySettings(k0).actuationMm === 1.5, "cache holds what the board has, not what was sent");
board.quirks.silentNext = 99;
r = await s.setPolling(1000);
ok(r.status === "unconfirmed", `no read-back -> unconfirmed (${r.status})`);
board.quirks.silentNext = 0;

// Range and model checks never reach the board.
const before = board.received.length;
await refused(s.setActuation([k0], 3.9), /0\.1\.\.3\.3/);
await refused(s.setActuation([127], 1.0), /no key/);
await refused(s.setDebounce(4), /doesn't offer/);
await refused(s.setLighting({ mode: 21 }), /isn't one SYNQ writes/);
await refused(s.setSnapTap(k0, k0), /two different/);
ok(board.received.length === before, "refused writes sent nothing");

// ---------------------------------------------------------------------------------------------
// 5. A blocked frame never reaches the device
// ---------------------------------------------------------------------------------------------
const reset = new Uint8Array(64);
reset[0] = 0x01;
reset[7] = P.checksum(reset, 7);
await assert.rejects(s.channel.feature(reset), BlockedFrameError);
const boot = new Uint8Array(64);
boot.set([0x7f, 0x55, 0xaa, 0x55, 0xaa]);
boot[7] = P.checksum(boot, 7);
await assert.rejects(s.channel.feature(boot), BlockedFrameError);
await assert.rejects(s.channel.output(P.encodeIdentify()), /feature reports only/);
assert.throws(() => s.channel.onInput(() => {}), /never read input/);
assert.throws(() => P.buildFrame(0xac), /Refusing/);
ok(!board.received.some((f) => P.blockedOpcode(f[0])), "no blocked opcode ever reached the board");
ok(log.some(([dir, op]) => dir === "blocked" && op === 0x01), "the blocked attempt was logged");

// ---------------------------------------------------------------------------------------------
// 6. Profile switch re-reads everything
// ---------------------------------------------------------------------------------------------
r = await s.setProfile(1);
ok(r.status === "confirmed" && s.state.profile.value === 1 && P.entryAt(s.state.keymap[0].value, k0)[2] === 0x29, "profile 1 active, its keymap re-read");
ok(s.keySettings(k0).actuationMm === 2, "profile 1's own tables");

// ---------------------------------------------------------------------------------------------
// 7. Units that don't make sense -> travel writes stay off (FCC rule)
// ---------------------------------------------------------------------------------------------
const odd = gen2Board({ firmware: 0x0310, featureList: false, actuation: 600 }); // 600 counts at 0.01 mm = 6 mm
const s2 = await MonsGeekSession.connect({ hid: odd.hid, allowWrites: () => true, pacing: FAST, sleep: noSleep });
ok(s2.unitMm === 0.01 && s2.unitSource === "firmware" && !s2.unitsOk, `firmware fallback 0.01 mm; units refused (${s2.unitsWhy})`);
await refused(s2.setActuation([odd.keys[0]], 1.0), /doesn't fit/);
await refused(s2.setKeyMode(odd.keys[0], { kind: "dks", firstMm: 1, keys: [P.ENTRY.none(), P.ENTRY.none(), P.ENTRY.none(), P.ENTRY.none()], rows: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] }), /doesn't fit/);
r = await s2.remapKey(odd.keys[1], P.ENTRY.key(0x05));
ok(r.status === "confirmed", "non-travel writes still work");
ok(!s2.pollingAllowed, "polling needs firmware >= 0x400 (0x310 here)");
await refused(s2.setPolling(1000), /firmware/);

// ---------------------------------------------------------------------------------------------
// 8. Unknown dev id, bootloader, yc500
// ---------------------------------------------------------------------------------------------
const unk = gen2Board({ devId: 9999 });
const s3 = await MonsGeekSession.connect({ hid: unk.hid, allowWrites: () => true, pacing: FAST, sleep: noSleep });
ok(s3.tier === "readOnly" && s3.familyGuessed && s3.state.keymap[0].value, "unknown dev id: read-only, still read");
await refused(s3.setActuation([0], 1.0), /read-only/);
await refused(s3.remapKey(0, P.ENTRY.key(4)), /read-only/);
ok(unk.received.every((f) => classifyFrame(f, "any").verdict === "read"), "unknown board got reads only");

const bl = gen2Board({ boot: true });
const s4 = await MonsGeekSession.connect({ hid: bl.hid, allowWrites: () => true, pacing: FAST, sleep: noSleep });
ok(s4.tier === "detectOnly" && bl.received.length === 1 && bl.received[0][0] === 0x8f, "bootloader: identify only, nothing else sent");

const yc = yc500Board();
const s5 = await MonsGeekSession.connect({ hid: yc.hid, allowWrites: () => true, pacing: FAST, sleep: noSleep });
ok(s5.family === "yc500" && s5.tier === "readOnly" && s5.scope === "yc500" && s5.model.name === "MG75S HE", "MG75S HE: yc500, read-only");
ok(s5.state.debounceMs.value === 5 && s5.state.ycOptions.value.wasdSwap && s5.state.profile.value === 1, "yc500 reads (debounce at byte 2, option bits)");
ok(s5.keySettings(3).actuationMm === 1.9 && s5.keySettings(3).deadzoneMm === 0.6, "yc500 columns in tenths offset by one");
ok(yc.received.some((f) => f[0] === 0x89 && f[1] === 4), "yc500 keymap read at profile * 4 + sub-layer");
await refused(s5.setActuation([3], 1.0), /reads it only|read-only|Only RY5088/);
await refused(s5.setLighting({ mode: 2 }));
await assert.rejects(s5.channel.feature(P.encodeOptionsWrite({ fnIndex: 0, antiMistouch: false, rtStabilityMs: 0, wasdSwap: true })), BlockedFrameError);
ok(yc.received.every((f) => classifyFrame(f, "yc500").verdict === "read"), "the yc500 board only ever saw yc500 reads");

console.log(`monsgeek session sim: ${checks} checks passed (gen2 ${board.received.length} frames, yc500 ${yc.received.length} frames).`);
