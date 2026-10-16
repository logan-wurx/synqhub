// Checks src/lib/brands/drunkdeer (codec, dialects, allowlist). No device, no window.
// Run: node --test scripts/drunkdeer-codec.test.ts
//
// Evidence used:
//  1. Golden frames written by hand from the sources' documented bytes: svumo/DrunkDeer-Control (MIT)
//     docs + Packets.cs, 2xxn/cli-drunkdeer (Apache-2.0) builder.go/consts.go, PashOK7/HallJoy (AGPL-3.0)
//     drunkdeer_protocol.cpp, mojobojo/drunkdeer-daemon README (docs only).
//  2. "Mirror" builders: TypeScript ports of svumo's MIT-licensed C# builders (Packets.cs, Copyright (c) 2026
//     svumo, MIT), compared with SYNQ's encoders over many random inputs. Only one deliberate
//     difference: svumo (and the official JS) truncate mm*scale; SYNQ rounds, so the mirrors round too.
//  The official configurator JS is docs-only and is not transcribed here.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as D from "../src/lib/brands/drunkdeer/index.ts";
import type { GuardContext } from "../src/lib/brands/drunkdeer/guard.ts";

const P = D;
const h = (f: Uint8Array) => P.hex(f);
const trim = (f: Uint8Array) => {
  let e = f.length;
  while (e > 0 && f[e - 1] === 0) e--;
  return P.hex(f.subarray(0, e));
};
let seed = 4242;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const raw = (bytes: number[]) => {
  const f = new Uint8Array(63);
  f.set(bytes);
  return f;
};
const out = (data: Uint8Array) => ({ type: "output" as const, reportId: 4, data });
const allowed = (f: Uint8Array, ctx?: GuardContext) => (ctx ? D.classifyFrame(f, ctx) : D.DRUNKDEER_GUARD.classify(out(f))).verdict !== "blocked";

const model = (code: number) => D.modelForTypeCode(code) as D.DrunkDeerModel;
const ctxFor = (code: number, fw: number, fine = false): GuardContext => {
  const m = model(code);
  const features = D.featuresFor(m, fw, fine);
  return { features, presetCodes: features.lightingPresets.map((p) => p.code), writes: true };
};
const CTX = {
  legacy: ctxFor(750, 9), // A75 Pro below fw 17
  oldHighPrec: ctxFor(750, 23, true), // svumo's verified A75 Pro 0.023
  newHighPrec: ctxFor(756, 85), // A75 Ultra
} as const;

// ---------------------------------------------------------------------------------------------
// svumo mirrors (MIT port of Driver/Packets.cs)
// ---------------------------------------------------------------------------------------------

/** BuildCommonSwitchPacket. */
function mirrorCommon(s: D.CommonSettings): Uint8Array {
  const p = raw([0xb5, 0x00, 0x1e, 0x01, 0x00, 0x00, 0x01]);
  p[7] = s.turbo ? 1 : 0;
  p[8] = s.rapidTrigger ? 1 : 0;
  p[10] = s.lastWin && s.rdt ? 3 : s.lastWin ? 1 : s.rdt ? 2 : 0;
  p[11] = s.rtMatch ? 1 : 0;
  return p;
}
/** BuildPacketKeyPoint (x100) / BuildPacketKeyPointLegacy (x10): 0xB6 type 0 packetNumber, 59/59/8 keys. */
function mirrorKeyPointOld(mm: number[], packetNumber: number, type: number, scale: number): Uint8Array {
  const packet = new Uint8Array(63);
  packet[0] = 0xb6;
  packet[1] = type;
  packet[2] = 0x00;
  packet[3] = packetNumber;
  const offset = packetNumber === 0 ? 0 : packetNumber === 1 ? 59 : 118;
  const maxX = packetNumber === 2 ? 8 : 59;
  for (let x = 0; x < maxX; x++) packet[4 + x] = Math.round(mm[x + offset] * scale);
  return packet;
}
/** BuildPacketKeyPointHighPrec: 0xFD type packetNumber, 30 x 4 + 6 keys, u16 LE at mm x 200. */
function mirrorKeyPointHigh(mm: number[], packetNumber: number, type: number): Uint8Array {
  const packet = new Uint8Array(63);
  packet[0] = 0xfd;
  packet[1] = type;
  packet[2] = packetNumber;
  const offset = packetNumber * 30;
  const maxX = packetNumber < 4 ? 30 : 6;
  let r = 0;
  for (let x = 0; x < maxX; x++) {
    const w = Math.round(mm[x + offset] * 200);
    packet[3 + r] = w & 0xff;
    packet[4 + r] = (w >> 8) & 0xff;
    r += 2;
  }
  return packet;
}
/** BuildCreateLwPairsPacket. */
function mirrorLw(pairs: [number, number][]): Uint8Array {
  const packet = new Uint8Array(63);
  packet[0] = 0xfc;
  packet[1] = 0x01;
  packet[2] = 0x00;
  packet[3] = pairs.length;
  pairs.forEach(([m, t], i) => {
    packet[4 + i * 4] = m;
    packet[5 + i * 4] = t;
  });
  return packet;
}
/** BuildCreateRdtPairsPacket (activeRaw / resetRaw already in x200 units). */
function mirrorRdt(pairs: [number, number][], activeRaw: number, resetRaw: number): Uint8Array {
  const packet = new Uint8Array(63);
  packet[0] = 0xfc;
  packet[1] = 0x03;
  packet[2] = pairs.length;
  pairs.forEach(([p, r], i) => {
    const off = 3 + i * 8;
    packet[off] = p;
    packet[off + 1] = r;
    packet[off + 2] = activeRaw & 0xff;
    packet[off + 3] = (activeRaw >> 8) & 0xff;
    packet[off + 4] = resetRaw & 0xff;
    packet[off + 5] = (resetRaw >> 8) & 0xff;
  });
  return packet;
}
/** BuildLedModePacket: AE 01 00 00 mode speed brightness 00 (colour byte added per 2xxn BuildLEDModeSelect). */
function mirrorLed(mode: number, speed: number, brightness: number, colour: number): Uint8Array {
  return raw([0xae, 0x01, 0x00, 0x00, mode, speed, brightness, colour]);
}

// ---------------------------------------------------------------------------------------------
// Golden frames
// ---------------------------------------------------------------------------------------------

test("golden frames from svumo / 2xxn / HallJoy", () => {
  // svumo IDENTITY_PACKET [0xa0, 0x02, ..61 zeros]; 2xxn BuildIdentity [A0 02]
  assert.equal(trim(P.encodeIdentity()), "a0 02");
  // svumo keyboard-protocol.md §5 header + flags
  assert.equal(trim(P.encodeCommon({ turbo: true, rapidTrigger: true, lastWin: true, rdt: true, rtMatch: true })), "b5 00 1e 01 00 00 01 01 01 00 03 01");
  assert.equal(trim(P.encodeCommon({ turbo: false, rapidTrigger: true, lastWin: false, rdt: true, rtMatch: false })), "b5 00 1e 01 00 00 01 00 01 00 02");
  // 2xxn BuildRapidTriggerTurbo(rt=true, turbo=false): B5 00 1E 01 00 00 01 00 01
  assert.equal(trim(P.encodeCommon({ turbo: false, rapidTrigger: true, lastWin: false, rdt: false, rtMatch: false })), "b5 00 1e 01 00 00 01 00 01");
  // svumo §15: default load = every slot 0xC8 (2.0 mm, x100); 0.20 mm = 0x14
  const ap = P.encodeKeyPoints("actuation", new Array(126).fill(2.0), "oldHighPrec");
  assert.equal(ap.length, 3);
  assert.equal(h(ap[0]), ["b6", "01", "00", "00", ...new Array(59).fill("c8")].join(" "));
  assert.equal(trim(ap[2]), ["b6", "01", "00", "02", ...new Array(8).fill("c8")].join(" "));
  const ap02 = P.encodeKeyPoints("actuation", new Array(126).fill(0.2), "oldHighPrec");
  assert.equal(ap02[1][4], 0x14);
  // 2xxn DEFAULT_ACTUATION 0x14 = 2.0 mm on the x10 (legacy) scale; BuildModifyRow row 1
  const legacy = P.encodeKeyPoints("actuation", new Array(126).fill(2.0), "legacy");
  assert.equal(h(legacy[1]), ["b6", "01", "00", "01", ...new Array(59).fill("14")].join(" "));
  // svumo BuildPacketKeyPointHighPrec: 2.0 mm = 400 = 0x0190 LE
  const hp = P.encodeKeyPoints("upstroke", new Array(126).fill(2.0), "newHighPrec");
  assert.equal(hp.length, 5);
  assert.equal(trim(hp[4]), ["fd", "05", "04", ...new Array(6).fill("90 01")].join(" "));
  // HallJoy BuildTrackingRequest(true) = 04 b6 03 01; svumo tracking start/stop
  assert.equal(trim(P.encodeTracking(true, "oldHighPrec")), "b6 03 01");
  assert.equal(trim(P.encodeTracking(false, "legacy")), "b6 03");
  assert.equal(trim(P.encodeTracking(true, "newHighPrec")), "fd 03 01");
  // svumo outlier toggles §9 and the LW/RDT clear
  assert.equal(trim(P.encodeLwReplace(true)), "fc 0b 01");
  assert.equal(trim(P.encodeAutoMatch(255)), "fd 0c ff");
  assert.equal(trim(P.encodeClearPairs(2)), "fc 0a 02");
  // svumo §8.1 LW pair W(44) <-> A(64) on A75 Pro slots
  assert.equal(trim(P.encodeLwPairs([{ main: 64, trigger: 66 }, { main: 66, trigger: 64 }])), "fc 01 00 02 40 42 00 00 42 40");
  // svumo BuildCreateRdtPairsPacket defaults: active 20 (0.1 mm), reset 400 (2.0 mm)
  assert.equal(trim(P.encodeRdtPairs([{ press: 44, release: 65, activeMm: 0.1, resetMm: 2.0 }])), "fc 03 01 2c 41 14 00 90 01");
  // svumo rgb-protocol.md: A75 Pro Breath = mode 4; speed 5, brightness 9
  assert.equal(trim(P.encodeLighting({ code: 4, speed: 5, brightness: 9, colour: 0 })), "ae 01 00 00 04 05 09");
  // Pulls and the profile query
  assert.equal(trim(P.encodePullKeyPoints("actuation")), "fd 07 01");
  assert.equal(trim(P.encodePullKeyPoints("downstroke")), "fd 07 03");
  assert.equal(trim(P.encodePullKeyPoints("upstroke")), "fd 07 04");
  assert.equal(trim(P.encodePullLw()), "fc 05");
  assert.equal(trim(P.encodePullRdt()), "fc 07");
  assert.equal(trim(P.encodeProfileCountQuery()), "a2");
  for (const f of [P.encodeIdentity(), ...ap, ...hp]) assert.equal(f.length, 63);
});

test("svumo mirrors agree with the encoders over random inputs", () => {
  for (let n = 0; n < 300; n++) {
    const s = { turbo: !!rnd(2), rapidTrigger: !!rnd(2), lastWin: !!rnd(2), rdt: !!rnd(2), rtMatch: !!rnd(2) };
    assert.deepEqual(P.encodeCommon(s), mirrorCommon(s));
  }
  const fields: [D.KeyField, number][] = [["actuation", 1], ["downstroke", 4], ["upstroke", 5]];
  for (let n = 0; n < 60; n++) {
    for (const [field, type] of fields) {
      for (const d of ["legacy", "oldHighPrec", "newHighPrec"] as const) {
        const [lo, hi] = P.WIRE_RANGE[d][field];
        const mm = Array.from({ length: 126 }, () => P.wireToMm(lo + rnd(hi - lo + 1), d));
        const frames = P.encodeKeyPoints(field, mm, d);
        if (d === "newHighPrec") frames.forEach((f, p) => assert.deepEqual(f, mirrorKeyPointHigh(mm, p, type), `${field} ${d} p${p}`));
        else frames.forEach((f, p) => assert.deepEqual(f, mirrorKeyPointOld(mm, p, type, d === "legacy" ? 10 : 100), `${field} ${d} p${p}`));
      }
    }
    const lw = Array.from({ length: rnd(15) }, () => {
      const a = rnd(126);
      return [a, (a + 1 + rnd(125)) % 126] as [number, number];
    });
    assert.deepEqual(P.encodeLwPairs(lw.map(([main, trigger]) => ({ main, trigger }))), mirrorLw(lw));
    const rdt = lw.slice(0, 7);
    const a = 10 + rnd(41), r = 300 + rnd(201);
    assert.deepEqual(P.encodeRdtPairs(rdt.map(([press, release]) => ({ press, release, activeMm: a / 200, resetMm: r / 200 }))), mirrorRdt(rdt, a, r));
    const code = D.ALL_PRESET_CODES[rnd(D.ALL_PRESET_CODES.length)];
    const [sp, br, co] = [rnd(10), rnd(10), rnd(8)];
    assert.deepEqual(P.encodeLighting({ code, speed: sp, brightness: br, colour: co }), mirrorLed(code, sp, br, co));
  }
});

// ---------------------------------------------------------------------------------------------
// Decoders and dialects
// ---------------------------------------------------------------------------------------------

function identityReply(t: [number, number, number], fwLow: number, fwHigh: number, extra: Record<number, number> = {}): Uint8Array {
  const f = raw([0xa0, 0x02, 0x00, 0x00, ...t, fwLow, fwHigh]);
  for (const [k, v] of Object.entries(extra)) f[Number(k)] = v;
  return f;
}

test("identity: offsets, firmware number, every type triple", () => {
  const id = P.decodeIdentity(identityReply([11, 4, 3], 23, 0, { 15: 1, 16: 1, 18: 0, 19: 1, 20: 2, 22: 3, 23: 5, 24: 9, 25: 1, 30: 1, 31: 2, 32: 1 }));
  assert.deepEqual(id.typeBytes, [11, 4, 3]);
  assert.equal(id.firmware, 23);
  assert.equal(id.firmwareText, "0.023");
  assert.equal(id.turbo, true);
  assert.equal(id.rapidTrigger, true);
  assert.equal(id.rdt, false);
  assert.equal(id.lastWin, true);
  assert.equal(id.profileIndex, 2);
  assert.deepEqual(id.colour, { code: 3, speed: 5, brightness: 9 });
  assert.equal(id.fineStep, true);
  assert.equal(id.autoMatch, 2);
  assert.equal(id.lwReplace, true);
  // Firmware number is a decimal concatenation (official), not (hi << 8) | lo (svumo).
  assert.equal(P.decodeIdentity(identityReply([11, 4, 4], 5, 1)).firmware, 15);
  assert.equal(P.decodeIdentity(identityReply([11, 4, 4], 5, 1)).firmwareText, "0.15");
  assert.equal(P.decodeIdentity(identityReply([11, 4, 4], 85, 0, { 34: 0x1a, 35: 2, 36: 3 })).firmwareText, "0.085-1a.2.3");
  // RT-match off reads auto-match as 255 (official WB).
  assert.equal(P.decodeIdentity(identityReply([11, 4, 4], 85, 0, { 30: 0, 31: 2 })).autoMatch, 255);
  // svumo keyboard-protocol.md §3 + mojobojo table
  const table: [number, number, number, number][] = [
    [11, 3, 1, 60], [11, 2, 1, 65], [15, 1, 1, 65], [11, 1, 1, 75], [11, 4, 1, 75], [11, 3, 3, 600], [11, 19, 1, 601], [11, 21, 1, 602],
    [11, 6, 5, 603], [11, 2, 5, 650], [11, 2, 3, 651], [11, 16, 1, 652], [11, 18, 1, 653], [11, 4, 3, 750], [11, 4, 2, 751],
    [11, 4, 5, 754], [11, 4, 7, 755], [11, 4, 4, 756], [11, 5, 4, 757],
  ];
  for (const [a, b, c, code] of table) assert.equal(D.modelForTypeBytes(a, b, c)?.typeCode, code, `${a},${b},${c}`);
  assert.equal(D.modelForTypeBytes(11, 9, 9), null);
  assert.equal(D.tierFor(null, 0), "readOnly");
  assert.throws(() => P.decodeIdentity(raw([0xa0, 0x02, 0x04])));
});

test("dialect rules follow the official dispatch", () => {
  const cases: [number, number, D.Dialect][] = [
    [75, 34, "legacy"], [75, 35, "oldHighPrec"], [750, 16, "legacy"], [750, 17, "oldHighPrec"], [751, 24, "legacy"], [751, 25, "oldHighPrec"],
    [65, 18, "legacy"], [65, 19, "oldHighPrec"], [60, 20, "legacy"], [60, 21, "oldHighPrec"], [754, 12, "legacy"], [754, 13, "oldHighPrec"],
    [755, 5, "legacy"], [755, 6, "oldHighPrec"], [650, 99, "legacy"], [651, 1, "oldHighPrec"], [652, 1, "oldHighPrec"], [653, 1, "oldHighPrec"],
    [600, 1, "oldHighPrec"], [601, 1, "oldHighPrec"], [602, 1, "oldHighPrec"], [603, 1, "newHighPrec"], [756, 1, "newHighPrec"], [757, 99, "newHighPrec"],
  ];
  for (const [code, fw, d] of cases) assert.equal(D.dialectFor(model(code), fw), d, `${code} fw ${fw}`);
  assert.equal(D.dialectFor(null, 50), null);
  assert.equal(D.tierFor(model(750), 23), "community");
  assert.equal(D.tierFor(model(750), 9), "experimental");
  // Features: extras only on newHighPrec with their cutoffs
  const u = D.featuresFor(model(756), 85, false);
  assert.ok(u.pulls && u.autoMatch && u.lwReplace && u.profileCount && u.pairWrites && u.extendedIdentity);
  const u32 = D.featuresFor(model(756), 32, false);
  assert.ok(!u32.pulls && !u32.autoMatch && !u32.lwReplace && !u32.profileCount && u32.pairWrites && !u32.profileIndex);
  const pro = D.featuresFor(model(750), 23, true);
  assert.ok(!pro.pulls && !pro.pairWrites && !pro.autoMatch && !pro.extendedIdentity && pro.rtp);
  assert.equal(pro.units.actuation.step, 0.01);
  assert.equal(D.featuresFor(model(750), 23, false).units.actuation.step, 0.1);
  assert.equal(D.featuresFor(model(60), 16, false).rtp, false);
  assert.equal(D.featuresFor(model(756), 70, false).officialUpdatePrompt, true);
});

test("mm <-> wire scaling per dialect", () => {
  assert.equal(P.mmToWire(1.0, "legacy"), 10);
  assert.equal(P.mmToWire(1.0, "oldHighPrec"), 100);
  assert.equal(P.mmToWire(1.0, "newHighPrec"), 200);
  assert.equal(P.mmToWire(0.29, "oldHighPrec"), 29, "rounds where the official JS would truncate 28.999.. to 28");
  assert.equal(P.wireToMm(660, "newHighPrec"), 3.3);
  assert.deepEqual(Array.from(P.encodeKeyPoints("actuation", new Array(126).fill(3.3), "newHighPrec")[0].subarray(3, 5)), [0x94, 0x02]);
  assert.equal(P.encodeKeyPoints("actuation", new Array(126).fill(3.3), "legacy")[0][4], 33);
  assert.throws(() => P.encodeKeyPoints("actuation", new Array(126).fill(2.01), "oldHighPrec"), /outside/);
  assert.throws(() => P.encodeKeyPoints("actuation", new Array(126).fill(0.1), "newHighPrec"), /outside/);
  assert.throws(() => P.encodeKeyPoints("downstroke", new Array(125).fill(0), "legacy"), /126/);
  // Round trip: encode, decode the frames back, equal to the quantised input.
  for (const d of ["legacy", "oldHighPrec", "newHighPrec"] as const) {
    const unit = P.UNIT_MM[d];
    const mm = Array.from({ length: 126 }, () => 0.2 + Math.round(rnd(Math.floor(1.8 / unit))) * unit);
    const frames = P.encodeKeyPoints("actuation", mm, d);
    const back: number[] = [];
    for (const f of frames) {
      if (d === "newHighPrec") for (let i = 0; i < (f[2] < 4 ? 30 : 6); i++) back.push(P.wireToMm(f[3 + i * 2] | (f[4 + i * 2] << 8), d));
      else for (let i = 0; i < (f[3] < 2 ? 59 : 8); i++) back.push(P.wireToMm(f[4 + i], d));
    }
    assert.deepEqual(back, mm.map((v) => P.wireToMm(P.mmToWire(v, d), d)), d);
  }
});

test("depth, pull and pair decoders", () => {
  const b7 = raw([0xb7, 0, 0, 1, ...Array.from({ length: 59 }, (_, i) => (i === 3 ? 150 : i === 4 ? 1 : 0))]);
  const c = P.decodeDepth(b7, "oldHighPrec") as P.DepthChunk;
  assert.equal(c.first, 59);
  assert.equal(c.mm[3], 1.5);
  assert.equal(c.mm[4], 0, "below the noise floor");
  assert.equal(c.last, false);
  assert.equal((P.decodeDepth(raw([0xb7, 0, 0, 1, 0, 0, 0, 25]), "legacy") as P.DepthChunk).mm[3], 2.5);
  assert.equal((P.decodeDepth(raw([0xb7, 0, 0, 2]), "legacy") as P.DepthChunk).mm.length, 8);
  const fd = raw([0xfd, 0x06, 4, 0x90, 0x01, 39, 0]);
  const c2 = P.decodeDepth(fd, "newHighPrec") as P.DepthChunk;
  assert.deepEqual([c2.first, c2.mm.length, c2.mm[0], c2.mm[1], c2.last], [120, 6, 2.0, 0, true]);
  assert.equal(P.decodeDepth(fd, "oldHighPrec"), null);
  const pull = raw([0xfd, 0x0a, 1, 0x28, 0x00, 0x90, 0x01]);
  const pr = P.decodePullReply(pull) as { field: string; mm: number[] };
  assert.equal(pr.field, "downstroke");
  assert.deepEqual(pr.mm.slice(0, 2), [0.2, 2.0]);
  assert.equal(pr.mm.length, 30);
  assert.deepEqual(P.decodeLwPull(raw([0xfc, 0x06, 2, 0, 0, 64, 66, 0, 0, 66, 64, 0])), [{ main: 64, trigger: 66 }, { main: 66, trigger: 64 }]);
  assert.deepEqual(P.decodeRdtPull(raw([0xfc, 0x08, 0, 1, 0, 44, 65, 20, 0, 0x90, 0x01, 0])), [{ press: 44, release: 65, activeMm: 0.1, resetMm: 2.0 }]);
  assert.equal(P.decodeProfileCount(raw([0xa2, 3])), 3);
  assert.deepEqual(P.decodeCommonEcho(P.encodeCommon({ turbo: true, rapidTrigger: false, lastWin: false, rdt: true, rtMatch: false })), { turbo: true, rapidTrigger: false, lastWin: false, rdt: true });
});

test("lighting preset tables (A75 Pro codes match svumo's hardware test)", () => {
  const pro = D.colourPresets(model(750).colourTable);
  const code = (k: string, t = pro) => t.find((p) => p.key === k)?.code;
  assert.equal(code("color1"), 0, "Off");
  assert.equal(code("color9"), 2, "Always on");
  assert.equal(code("color5"), 4, "Breath");
  assert.equal(pro.some((p) => p.key === "color20" || p.key === "color21"), false, "custom entries are not presets");
  const ultra = D.colourPresets("ultra");
  assert.equal(code("color1", ultra), 240);
  assert.equal(code("color5", ultra), 3);
  assert.equal(code("color3", D.colourPresets("g65lite")), 1, "no custom entries: index is the code");
  assert.equal(code("color19", D.colourPresets("standard")), 18);
  assert.deepEqual(D.ALL_PRESET_CODES, [...Array.from({ length: 19 }, (_, i) => i), 240]);
});

// ---------------------------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------------------------

/** Every frame SYNQ's encoders build, over many inputs, tagged with the dialect it belongs to. */
function encoderFrames(): { f: Uint8Array; d: D.Dialect | "any" }[] {
  const res: { f: Uint8Array; d: D.Dialect | "any" }[] = [];
  const add = (f: Uint8Array, d: D.Dialect | "any") => res.push({ f, d });
  add(P.encodeIdentity(), "any");
  for (const d of ["legacy", "oldHighPrec", "newHighPrec"] as const) {
    add(P.encodeTracking(true, d), d);
    add(P.encodeTracking(false, d), d);
    for (let n = 0; n < 25; n++)
      for (const field of P.KEY_FIELDS) {
        const range = D.unitsFor(d, true)[field];
        const mm = Array.from({ length: 126 }, () => Math.round((range.min + (rnd(1000) / 1000) * (range.max - range.min)) * 100) / 100);
        for (const f of P.encodeKeyPoints(field, mm, d)) add(f, d);
      }
  }
  for (let n = 0; n < 32; n++) {
    const s = { turbo: !!(n & 1), rapidTrigger: !!(n & 2), lastWin: !!(n & 4), rdt: !!(n & 8), rtMatch: !!(n & 16) };
    add(P.encodeCommon(s), "any");
  }
  for (const field of P.KEY_FIELDS) add(P.encodePullKeyPoints(field), "newHighPrec");
  add(P.encodePullLw(), "newHighPrec");
  add(P.encodePullRdt(), "newHighPrec");
  add(P.encodeProfileCountQuery(), "newHighPrec");
  for (const m of P.AUTO_MATCH_VALUES) add(P.encodeAutoMatch(m), "newHighPrec");
  add(P.encodeLwReplace(true), "newHighPrec");
  add(P.encodeLwReplace(false), "newHighPrec");
  for (let m = 0; m < 4; m++) add(P.encodeClearPairs(m), "newHighPrec");
  for (let n = 0; n < 200; n++) {
    const k = rnd(6);
    const slots = Array.from({ length: k }, () => {
      const a = rnd(126);
      return [a, (a + 1 + rnd(125)) % 126];
    });
    add(P.encodeLwPairs(slots.map(([main, trigger]) => ({ main, trigger }))), "newHighPrec");
    add(P.encodeRdtPairs(slots.map(([press, release]) => ({ press, release, activeMm: (10 + rnd(41)) / 200, resetMm: (300 + rnd(201)) / 200 }))), "newHighPrec");
    const code = D.ALL_PRESET_CODES[rnd(D.ALL_PRESET_CODES.length)];
    add(P.encodeLighting({ code, speed: rnd(10), brightness: rnd(10), colour: rnd(8) }), "any");
  }
  return res;
}

/** Frames SYNQ must never send (built by hand: buildFrame refuses them). */
function blockedFrames(): Uint8Array[] {
  const fw = [
    raw([0xf9, 0x00, 0x00, 0x00, 0x40, 0x01, 0x00]), // start + u32 length
    raw([0xf9, 0x01, 56, 0x00, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef]), // data chunk
    raw([0xf9, 0x02, 0x00]), // end
    raw([0xf9]),
  ];
  return [
    ...fw,
    raw([0xaa]), // reset keyboard
    raw([0xaa, 0x00, 0x01]), // clear RTP upper
    raw([0xa7, 0x01, 0x00, 0x2b, 0x01]), // RTP authority
    raw([0xa8, 0x01, 0x01, 0x01, 0x01, 0x26, 0x01, ...new Array(30).fill(0), 0x02, 0x04, 0x01, 0x00, 0x6d, 0x03, 0x04]), // authority download
    raw([0xa0, 0x02, 0x04, 0x01, 0x0e, 0x01, 0x00, 0xfc, 0x00, 0x29]), // keymap layer write
    raw([0xab, 0x02]), // delete profile
    raw([0xa2, 0x03]), // set profile count
    raw([0xfb, 0x05, 0x01, 0x07, 0x08]), // switch profile
    raw([0xc1, 0x03, 0x00, 0x01, 0x00, 0xfc, 0x00, 0x04]), // knob remap
    raw([0xc2, 0x20, 0x01, 0x05, 0x09, 0x00]), // LED strip
    raw([0xae, 0x01, 0x00, 0x00, 0x13, 0x06, 0x09, 0xff, 0x80, 0xff, 0x00, 0x00, 0xff]), // custom light stream
    raw([0xae, 0x01, 0x00, 0x00, 0x04, 0x05, 0x0a, 0x00]), // brightness 10
    raw([0xae, 0x01, 0x00, 0x00, 0x04, 0x0c, 0x09, 0x00]), // speed 12
  ];
}

test("every encoder frame passes the static guard and its dialect's session guard", () => {
  const frames = encoderFrames();
  assert.ok(frames.length > 1000);
  for (const { f, d } of frames) {
    const v = D.DRUNKDEER_GUARD.classify(out(f));
    assert.notEqual(v.verdict, "blocked", `${h(f.subarray(0, 8))}: ${v.verdict === "blocked" ? v.reason : ""}`);
    const ctx = d === "any" ? CTX.newHighPrec : CTX[d];
    if (f[0] === P.CMD.led) {
      const c = ctxFor(756, 85);
      if (!c.presetCodes?.includes(f[4])) continue; // preset of another model: checked below per model
    }
    const sv = D.classifyFrame(f, ctx);
    assert.notEqual(sv.verdict, "blocked", `session ${d}: ${h(f.subarray(0, 8))} ${sv.verdict === "blocked" ? sv.reason : ""}`);
  }
  // Lighting: each model's presets pass its own session guard.
  for (const m of D.MODELS) {
    const c = ctxFor(m.typeCode, 99);
    for (const p of c.features?.lightingPresets ?? []) assert.equal(allowed(P.encodeLighting({ code: p.code, speed: 9, brightness: 9, colour: 7 }), c), true, `${m.name} ${p.key}`);
  }
});

test("every blocked command is blocked, with a reason", () => {
  for (const f of blockedFrames()) {
    const v = D.DRUNKDEER_GUARD.classify(out(f));
    assert.equal(v.verdict, "blocked", h(f.subarray(0, 8)));
    for (const ctx of Object.values(CTX)) assert.equal(D.classifyFrame(f, ctx).verdict, "blocked");
  }
  const reasons = blockedFrames().map((f) => D.DRUNKDEER_GUARD.classify(out(f)));
  assert.equal(reasons[0].verdict === "blocked" && reasons[0].why, "firmware");
  assert.equal(reasons[4].verdict === "blocked" && reasons[4].why, "factory-reset");
  // Shape: feature reports, other report ids, other lengths.
  const ok = P.encodeIdentity();
  assert.equal(D.DRUNKDEER_GUARD.classify({ type: "feature", reportId: 4, data: ok }).verdict, "blocked");
  assert.equal(D.DRUNKDEER_GUARD.classify({ type: "output", reportId: 0, data: ok }).verdict, "blocked");
  assert.equal(D.DRUNKDEER_GUARD.classify({ type: "output", reportId: 4, data: ok.subarray(0, 62) }).verdict, "blocked");
  assert.ok(D.BLOCKED.length >= 12);
});

test("blocked opcodes are unreachable from the encoders (buildFrame refuses them)", () => {
  for (const [op] of P.NEVER_OPCODES) {
    assert.throws(() => P.buildFrame([op]), /never sends/);
    for (let n = 0; n < 50; n++) assert.throws(() => P.buildFrame([op, rnd(256), rnd(256), rnd(256)]));
  }
  assert.throws(() => P.buildFrame([0xa0, 0x02, 0x04, 1, 14, 1]), /keymap/);
  assert.throws(() => P.buildFrame([0xa0, 0x01]));
  assert.throws(() => P.buildFrame([0xa2, 0x02]), /profile/);
  assert.throws(() => P.buildFrame([0xae, 0x01, 0x00, 0x00, 0x13, 0x06, 0x09, 0xff]), /custom/);
  assert.throws(() => P.buildFrame([0xb5, 256]), /0\.\.255/);
  assert.throws(() => P.buildFrame([0xb5, 1.5]));
  assert.throws(() => P.buildFrame(new Array(64).fill(0xb5)));
  for (const { f } of encoderFrames()) assert.equal(P.NEVER_OPCODES.has(f[0]), false);
  // Encoder-level range checks (no silent clamping).
  assert.throws(() => P.encodeLighting({ code: 4, speed: 5, brightness: 10, colour: 0 }));
  assert.throws(() => P.encodeLighting({ code: 99, speed: 5, brightness: 9, colour: 0 }));
  assert.throws(() => P.encodeAutoMatch(3));
  assert.throws(() => P.encodeClearPairs(4));
  assert.throws(() => P.encodeLwPairs([{ main: 5, trigger: 5 }]));
  assert.throws(() => P.encodeLwPairs([{ main: 126, trigger: 5 }]));
  assert.throws(() => P.encodeRdtPairs([{ press: 1, release: 2, activeMm: 0.3, resetMm: 2 }]));
  assert.throws(() => P.encodeRdtPairs([{ press: 1, release: 2, activeMm: 0.1, resetMm: 1.4 }]));
});

test("fuzz: random and mutated frames never let a blocked opcode through", () => {
  const valid = encoderFrames().map((x) => x.f);
  const never = new Set([...P.NEVER_OPCODES.keys()]);
  let passed = 0;
  for (let n = 0; n < 40000; n++) {
    let f: Uint8Array;
    if (n % 4 === 0) {
      f = new Uint8Array(63).map(() => (rnd(3) ? 0 : rnd(256)));
      f[0] = rnd(256);
    } else {
      f = new Uint8Array(valid[rnd(valid.length)]);
      const flips = 1 + rnd(3);
      for (let k = 0; k < flips; k++) f[rnd(n % 2 ? 12 : 63)] = rnd(4) ? rnd(256) : 0;
      if (n % 7 === 0) f[0] = [...never][rnd(never.size)];
    }
    const v = D.DRUNKDEER_GUARD.classify(out(f));
    if (v.verdict !== "blocked") passed++;
    if (never.has(f[0]) || (f[0] === 0xa0 && f[2] !== 0) || (f[0] === 0xa2 && f[1] !== 0)) assert.equal(v.verdict, "blocked", h(f.subarray(0, 8)));
    if (f[0] === 0xae && (f[5] > 9 || f[6] > 9)) assert.equal(v.verdict, "blocked");
    // Whatever passes is something an encoder could have built: re-classify under some session context.
    if (v.verdict !== "blocked") assert.ok(f[0] === 0xa0 || f[0] === 0xa2 || f[0] === 0xae || f[0] === 0xb5 || f[0] === 0xb6 || f[0] === 0xfc || f[0] === 0xfd);
  }
  assert.ok(passed > 1000, `some mutated frames stay valid (${passed})`);
});

test("session narrowing: dialect, features, read-only", () => {
  const fdAp = P.encodeKeyPoints("actuation", new Array(126).fill(1), "newHighPrec")[0];
  const b6Ap = P.encodeKeyPoints("actuation", new Array(126).fill(1), "oldHighPrec")[0];
  assert.equal(allowed(fdAp, CTX.oldHighPrec), false, "0xFD per-key on an old-dialect board");
  assert.equal(allowed(b6Ap, CTX.newHighPrec), false, "0xB6 per-key on a newHighPrec board");
  assert.equal(allowed(b6Ap, CTX.legacy), false, "x100 value 100 is out of the legacy range");
  assert.equal(allowed(b6Ap, CTX.oldHighPrec), true);
  for (const f of [P.encodePullLw(), P.encodeClearPairs(1), P.encodeLwPairs([{ main: 1, trigger: 2 }]), P.encodeAutoMatch(1), P.encodeLwReplace(true)])
    assert.equal(allowed(f, CTX.oldHighPrec), false, `${h(f.subarray(0, 3))} on an old board`);
  assert.equal(allowed(P.encodeLwReplace(true), ctxFor(756, 72)), false, "LW replace below fw 73");
  assert.equal(allowed(P.encodeLwPairs(Array.from({ length: 6 }, (_, i) => ({ main: i, trigger: i + 10 }))), CTX.newHighPrec), false, "more than 5 pairs");
  assert.equal(allowed(P.encodeCommon({ turbo: false, rapidTrigger: true, lastWin: true, rdt: false, rtMatch: false }), ctxFor(60, 16)), false, "LW below RTP_version");
  // Before identity: only the identity read.
  const pre: GuardContext = { features: null, writes: false };
  assert.equal(allowed(P.encodeIdentity(), pre), true);
  assert.equal(allowed(P.encodeTracking(true, "oldHighPrec"), pre), false);
  // Read-only tier: reads pass, writes don't.
  const ro: GuardContext = { ...CTX.newHighPrec, writes: false };
  assert.equal(allowed(P.encodePullLw(), ro), true);
  assert.equal(allowed(P.encodeCommon({ turbo: true, rapidTrigger: false, lastWin: false, rdt: false, rtMatch: false }), ro), false);
  // Lighting: a preset of another model is refused.
  assert.equal(allowed(P.encodeLighting({ code: 240, speed: 0, brightness: 0, colour: 0 }), CTX.oldHighPrec), false);
  assert.equal(allowed(P.encodeLighting({ code: 240, speed: 0, brightness: 0, colour: 0 }), CTX.newHighPrec), true);
});

test("device table and bridge allowances", () => {
  for (const pid of D.DRUNKDEER_PIDS) assert.equal(D.deviceEntry(0x352d, pid)?.tier, "experimental");
  assert.equal(D.deviceEntry(0x05ac, 0x024f)?.tier, "detectOnly");
  assert.equal(D.deviceEntry(0x352d, 0x2a08)?.tier, "detectOnly");
  for (const pid of D.OEM_19F5_PIDS) assert.equal(D.deviceEntry(0x19f5, pid)?.tier, "detectOnly");
  assert.ok(D.isOemUpgrader(0x19f5, 0xaf12) && D.isOemUpgrader(0x19f5, 0xaf99) && !D.isOemUpgrader(0x19f5, 0xfb5c));
  const bridged = D.DRUNKDEER_BRIDGE.flatMap((b) => b.productIds.map((p) => [b.vendorId, p] as const));
  assert.equal(bridged.some(([v]) => v === 0x19f5 || v === 0x05ac), false);
  assert.equal(bridged.some(([v, p]) => v === 0x352d && p === 0x2a08), false);
  for (const b of D.DRUNKDEER_BRIDGE) assert.deepEqual([b.usagePage, b.usage, b.access, [...b.reportIds], b.length], [0xff00, 0x00, "full", [4], 63]);
  for (const m of D.MODELS) for (const [v, p] of m.usb) assert.ok(bridged.some(([bv, bp]) => bv === v && bp === p), `${m.name} reachable`);
  assert.equal(D.slotOf(2, 2), 44, "A75 Pro W");
  assert.equal(D.slotOf(3, 1), 64, "A75 Pro A");
});
