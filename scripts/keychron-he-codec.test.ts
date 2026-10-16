// Checks src/lib/kb/via/keychron (the 0xA0..0xA9 framing, the packed profile layout, the model catalogue, the second
// guard tier and its frame fixture). No device, no window.
// Run: node --test scripts/keychron-he-codec.test.ts
//
// Evidence used:
//  1. Byte layouts derived by hand from Keychron's published firmware (GPL-2.0-or-later, branch 2025q3, commit
//     c5d998442710b38650903937249144a0cd728ebe): analog_matrix_type.h (analog_key_config_t is a packed bit-field struct,
//     LSB first: mode:2, act_pt:6, rpd_trig_sen:6, rpd_trig_sen_deact:6, adv_mode:4, then a data byte), analog_matrix.c
//     (`analog_matrix_rx`: reply layouts), profile.c (`profile_set_traval`: what a set checks), analog_matrix_eeconfig.h
//     (PROFILE_SIZE).
//  2. The catalogue against AnalogSense's own board list (src/lib/kb/analogsense/devices.ts), which was read from other sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../src/lib/kb/via/keychron/protocol.ts";
import { KEYCHRON_BLOCKED, checkKeychronFrame, keychronGuardFor, type KeychronContext } from "../src/lib/kb/via/keychron/guard.ts";
import { KC_LAYOUTS, KC_MODELS, KEYCHRON_HE_IDS, keychronDefinition, keychronModel } from "../src/lib/kb/via/keychron/devices.ts";
import { MODELS as ANALOGSENSE } from "../src/lib/kb/analogsense/devices.ts";
import { checkViaFrame } from "../src/lib/kb/via/guard.ts";
import { isBootloader } from "../src/lib/bootloader-ids.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hx = (f: Uint8Array, n = f.length) => Array.from(f.subarray(0, n), (b) => b.toString(16).padStart(2, "0")).join(" ");
const frame = (...b: number[]) => {
  const f = new Uint8Array(32);
  f.set(b);
  return f;
};

test("a key configuration is 24 bits LSB first: mode:2 act:6 | sens:6 rls:6 adv:4 | data (the packed struct in analog_matrix_type.h)", () => {
  // mode 2 (rapid), act 15 (1.5 mm), sens 3, rls 3: 2 + 15<<2 + 3<<8 + 3<<14 = 0x00C33E.
  assert.deepEqual(P.encodeKeyConfig({ mode: 2, act: 15, sens: 3, rls: 3, adv: 0, advData: 0 }), [0x3e, 0xc3, 0x00, 0x00]);
  // mode 1, act 20, no sensitivities, adv 2 (bits 20..23), data 5: 1 + 20<<2 + 2<<20 = 0x200051.
  assert.deepEqual(P.encodeKeyConfig({ mode: 1, act: 20, sens: 0, rls: 0, adv: 2, advData: 5 }), [0x51, 0x00, 0x20, 0x05]);
  const c = P.decodeKeyConfig([0x3e, 0xc3, 0x00, 0x00]);
  assert.deepEqual(c, { mode: 2, act: 15, sens: 3, rls: 3, adv: 0, advData: 0 });
  for (let n = 0; n < 500; n++) {
    const k = { mode: (n % 3) as P.KeyMode, act: (n * 7) % 64, sens: (n * 13) % 64, rls: (n * 29) % 64, adv: (n * 3) % 16, advData: (n * 11) % 256 };
    assert.deepEqual(P.decodeKeyConfig(P.encodeKeyConfig(k)), k);
  }
});

test("a profile is 2 + 4 * (keys + 1) + 30 + 19 * OKMC + 3 * SOCD bytes; the size the keyboard reports gives the key count back", () => {
  // Q1 HE: 6 x 15 = 90 keys, OKMC 20, SOCD 20: 2 + 4 * 91 + 30 + 380 + 60 = 836.
  const info: P.ProfilesInfo = { current: 1, count: 3, size: 836, okmcCount: 20, socdCount: 20 };
  assert.equal(P.keysInProfile(info), 90);
  const l = P.profileLayout(info)!;
  assert.equal(l.keys, 90);
  assert.equal(l.keyAt(0, 0, 15), 4);
  assert.equal(l.keyAt(5, 14, 15), 4 + 4 * 89);
  assert.equal(l.nameAt, 4 + 4 * 90 + 380 + 60);
  assert.equal(l.nameAt + 30 + 2, 836);
  assert.equal(P.keysInProfile({ ...info, size: 837 }), null);
  const decoded = P.decodeProfilesInfo(Uint8Array.from([0xa9, 0x10, 1, 3, 0x44, 0x03, 20, 20]));
  assert.deepEqual(decoded, info);
});

test("frames: reads name profile, offset and size; a travel set carries mode, actuation, sensitivities, the 'entire' flag and 3-byte row masks", () => {
  assert.equal(hx(P.profileRawFrame(1, 0x0170, 26), 8), "a9 12 01 70 01 1a 00 00");
  assert.equal(hx(P.saveProfileFrame(2), 4), "a9 1f 02 00");
  assert.equal(P.protocolVersionFrame()[0], 0xa0);
  assert.equal(hx(P.profilesInfoFrame(), 3), "a9 10 00");
  const global = P.travelFrame({ profile: 1, mode: 2, act: 15, sens: 3, rls: 3 }, "entire");
  assert.equal(hx(global, 10), "a9 14 01 02 0f 03 03 01 00 00");
  const keys = P.travelFrame({ profile: 0, mode: 1, act: 20, sens: 4, rls: 4 }, [P.maskFor([0, 3]), 0, P.maskFor([14])]);
  assert.equal(hx(keys, 17), "a9 14 00 01 14 04 04 00 09 00 00 00 00 00 00 40 00");
  assert.equal(keys.length, 32);
  assert.throws(() => P.travelFrame({ profile: 0, mode: 3 as P.KeyMode, act: 1, sens: 1, rls: 1 }, [1]));
  assert.throws(() => P.travelFrame({ profile: 0, mode: 1, act: 40, sens: 1, rls: 1 }, [1]));
  assert.throws(() => P.profileRawFrame(0, 0, 27));
  assert.throws(() => P.profileRawFrame(8, 0, 1));
  assert.equal(P.unitsOf(1.5), 15);
  assert.equal(P.mmOf(15), 1.5);
  assert.equal(P.mmOf(3), 0.3);
});

test("replies: a raw read answers only its own request; a set / save took effect when byte 2 is 0", () => {
  const req = P.profileRawFrame(1, 4, 4);
  const good = new Uint8Array(32);
  good.set([0xa9, 0x12, 1, 4, 0, 4, 9, 8, 7, 6]);
  assert.deepEqual(Array.from(P.decodeProfileRaw(req, good)!), [9, 8, 7, 6]);
  const other = new Uint8Array(good);
  other[2] = 2;
  assert.equal(P.decodeProfileRaw(req, other), null);
  assert.ok(P.answers(req, good));
  assert.ok(!P.answers(req, Uint8Array.from([0xa9, 0x10, 0])));
  assert.ok(P.answers(req, Uint8Array.from([0xff])), "unhandled ends the wait");
  assert.ok(P.tookEffect(Uint8Array.from([0xa9, 0x14, 0])));
  assert.ok(!P.tookEffect(Uint8Array.from([0xa9, 0x14, 1])));
  assert.equal(P.decodeFirmware(Uint8Array.from([0xa1, ...new TextEncoder().encode("v1.3.1 2025 Mar"), 0, 0])), "v1.3.1 2025 Mar");
  assert.deepEqual(P.decodeFeatures(Uint8Array.from([0xa2, 0, 0x09, 0x03])), { analogMatrix: true, mask: 0x0309 });
  assert.equal(P.decodeFeatures(Uint8Array.from([0xa2, 0, 0x01, 0x03])).analogMatrix, false);
});

test("the catalogue: 35 boards, unique wired ids, matrix and layouts agree, and AnalogSense's own Keychron list is inside it", () => {
  assert.equal(KC_MODELS.length, 35);
  const ids = KEYCHRON_HE_IDS.map(([v, p]) => `${v}:${p}`);
  assert.equal(new Set(ids).size, 35);
  assert.deepEqual([...new Set(KC_MODELS.map((m) => m.brand))].sort(), ["Keychron", "Lemokey"]);
  for (const m of KC_MODELS) {
    assert.equal(m.vendorId, m.brand === "Keychron" ? 0x3434 : 0x362d);
    assert.ok(m.rows >= 5 && m.rows <= 6 && m.cols >= 5 && m.cols <= 21, m.name);
    const l = KC_LAYOUTS[m.layout];
    assert.ok(l.length >= 27, `${m.name} ${m.variant}`);
    assert.ok(l.every(([r, c]) => r < m.rows && c < m.cols), `${m.name} stays in its matrix`);
    assert.equal(new Set(l.map(([r, c]) => r * m.cols + c)).size, l.length, `${m.name} has one key per matrix position`);
    assert.equal(isBootloader(m.vendorId, m.productId, null), false);
    const def = keychronDefinition(m);
    assert.equal(def.keys.length, l.length);
    assert.ok(def.rows * def.cols * 4 + 4 < 1400, "a profile of this board stays well inside the raw-read offset limit");
  }
  assert.equal(keychronModel(0x3434, 0x0b10)?.name, "Q1 HE");
  assert.equal(keychronModel(0x3434, 0x0b10)?.variant, "ANSI");
  assert.equal(KC_LAYOUTS[keychronModel(0x3434, 0x0b10)!.layout].length, 82);
  assert.equal(keychronModel(0x362d, 0x0610)?.name, "P1 HE");
  assert.equal(keychronModel(0x3434, 0x0281), null, "a non-HE Keychron board");
  // AnalogSense lists ten Keychron / Lemokey HE ids from other sources: all of them are here.
  const as = ANALOGSENSE.filter((m) => m.family === "keychron" && m.productId !== null);
  assert.ok(as.length >= 8);
  for (const m of as) assert.ok(keychronModel(m.vendorId, m.productId!), `${m.name} ${m.vendorId.toString(16)}:${m.productId!.toString(16)}`);
});

test("the guard's second tier: the reads, in-range travel sets and a save pass; calibration, reset, firmware and VIA's own blocks do not", () => {
  const ok = (f: Uint8Array) => checkKeychronFrame(f).ok;
  for (const f of [P.protocolVersionFrame(), P.firmwareVersionFrame(), P.supportFeatureFrame(), P.miscVersionFrame(), P.analogVersionFrame(), P.profilesInfoFrame(), P.profileRawFrame(0, 0, 26), P.saveProfileFrame(0)]) assert.ok(ok(f), hx(f, 6));
  assert.ok(ok(P.travelFrame({ profile: 0, mode: 2, act: 39, sens: 39, rls: 0 }, "entire")));
  assert.ok(ok(P.travelFrame({ profile: 2, mode: 0, act: 0, sens: 0, rls: 0 }, [1])), "a key may follow the profile (all zero)");
  for (const never of [frame(0xaa), frame(0xab), frame(0xaa, 1, 2), frame(0xa7, 0x11), frame(0xa7, 0x02), frame(0xa9, 0x1e, 0), frame(0xa9, 0x40, 1), frame(0xa9, 0x41), frame(0xa9, 0x15, 0), frame(0xa9, 0x16, 0), frame(0xa9, 0x11, 1), frame(0xa9, 0x13, 0, 1, 65), frame(0xa8, 1), frame(0xa3)]) assert.ok(!ok(never), hx(never, 4));
  for (const via of [frame(0x0b), frame(0x0a), frame(0x13), frame(0x02, 0x03), frame(0x03, 1, 2), frame(0x15)]) assert.ok(!ok(via), `VIA ${hx(via, 3)} is not this tier's`);
  assert.ok(!ok(P.travelFrame({ profile: 0, mode: 1, act: 20, sens: 4, rls: 4 }, [0, 0, 0])), "no key named");
  assert.ok(!ok(frame(0xa9, 0x14, 0, 0, 20, 4, 4, 1)), "a global write names a mode");
  assert.ok(!ok(frame(0xa9, 0x14, 0, 1, 40, 4, 4, 1)), "4.0 mm");
  assert.ok(!ok(frame(0xa9, 0x14, 8, 1, 20, 4, 4, 1)), "profile 8");
  assert.ok(!ok(frame(0xa9, 0x12, 0, 0, 0x10, 26)), "an offset past the profile");
  assert.ok(!ok(new Uint8Array(31)) && !ok(new Uint8Array(33)));
  // VIA's own guard still refuses every one of those; this tier is the only way they get through.
  assert.equal(checkViaFrame(P.travelFrame({ profile: 0, mode: 2, act: 15, sens: 3, rls: 3 }, "entire")).ok, false);
  assert.ok(KEYCHRON_BLOCKED.length >= 5);
});

test("a session's tier narrows to the active profile, the matrix and the write switch", () => {
  const ctx: KeychronContext = { profile: null, rows: 6, cols: 15, writes: false };
  const g = keychronGuardFor(() => ctx);
  const verdict = (f: Uint8Array) => g(f)!.ok;
  assert.equal(g(new Uint8Array(32).fill(0x00)), null, "a VIA frame is not this tier's to judge");
  assert.ok(verdict(P.protocolVersionFrame()) && verdict(P.profilesInfoFrame()) && verdict(P.analogVersionFrame()));
  assert.ok(!verdict(P.profileRawFrame(1, 0, 26)), "no profile reads before the active profile is known");
  ctx.profile = 1;
  assert.ok(verdict(P.profileRawFrame(1, 0, 26)));
  assert.ok(!verdict(P.profileRawFrame(0, 0, 26)), "another profile");
  const set = P.travelFrame({ profile: 1, mode: 2, act: 15, sens: 3, rls: 3 }, [P.maskFor([0, 14])]);
  assert.ok(!verdict(set), "writes are off");
  ctx.writes = true;
  assert.ok(verdict(set));
  assert.ok(!verdict(P.travelFrame({ profile: 0, mode: 2, act: 15, sens: 3, rls: 3 }, [1])), "not the active profile");
  assert.ok(!verdict(P.travelFrame({ profile: 1, mode: 2, act: 15, sens: 3, rls: 3 }, [P.maskFor([15])])), "column 15 isn't in a 15-column matrix");
  assert.ok(!verdict(P.travelFrame({ profile: 1, mode: 2, act: 15, sens: 3, rls: 3 }, [0, 0, 0, 0, 0, 0, 1])), "row 6 isn't in a 6-row matrix");
  assert.ok(verdict(P.travelFrame({ profile: 1, mode: 2, act: 15, sens: 3, rls: 3 }, "entire")));
  assert.ok(verdict(P.saveProfileFrame(1)) && !verdict(P.saveProfileFrame(2)));
});

test("the frame fixture agrees with the guard line for line", () => {
  const lines = readFileSync(join(root, "src/lib/kb/via/keychron/keychron-he-frames.txt"), "utf8").split("\n").filter((l) => l.trim());
  assert.ok(lines.length >= 6000);
  let allowed = 0;
  for (const line of lines) {
    const [v, hex = ""] = line.split(" ");
    const f = new Uint8Array(32);
    f.set(Array.from({ length: Math.ceil(hex.length / 2) }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)));
    const ok = checkKeychronFrame(f).ok;
    assert.equal(ok, v === "1", hex);
    if (ok) allowed++;
  }
  assert.ok(allowed > 200 && allowed < lines.length / 4, String(allowed));
});
