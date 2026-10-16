// Checks src/lib/brands/rk-beiying (the legacy RK protocol's codec, the model table, the allowlist and its frame
// fixture). No device, no window.
// Run: node --test scripts/rk-beiying-codec.test.ts
//
// Evidence used:
//  1. Golden bytes from the sources' documentation: Fighting Control Center (GPL-3.0-or-later) docs/PROTOCOL-RK.md,
//     rnayabed/rangoli (GPL-3.0) src/keyboardconfiguratorcontroller.cpp and src/keycode.h, vinc3m1/kludgeknight
//     (GPL-3.0) docs/lighting-protocol.md.
//  2. A mirror of Rangoli's buffer builders (getStandardLightBuffer, setBufferKey, the nine key-map buffers),
//     compared with SYNQ's encoders over many random inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as R from "../src/lib/brands/rk-beiying/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hx = (f: Uint8Array, n = f.length) => Array.from(f.subarray(0, n), (b) => b.toString(16).padStart(2, "0")).join(" ");
const feature = (data: Uint8Array) => ({ type: "feature" as const, reportId: 0x0a, data });
let seed = 0x0a;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};

// ---------------------------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------------------------

test("the lighting report is [01 01 02 29 mode 00 speed brightness r g b random sleep], after the report id", () => {
  const d = R.encodeLighting({ mode: 10, speed: 3, brightness: 4, rgb: [255, 128, 0], random: false, sleep: 5 });
  assert.equal(d.length, 64);
  assert.equal(hx(d, 14), "01 01 02 29 0a 00 03 04 ff 80 00 00 05 00");
  // Random colours: the colour bytes are zero and the random byte is 1 (FCC, Rangoli).
  const r = R.encodeLighting({ mode: 3, speed: 5, brightness: 0, rgb: [9, 9, 9], random: true, sleep: 1 });
  assert.equal(hx(r, 14), "01 01 02 29 03 00 05 00 00 00 00 01 01 00");
  // Rangoli issue 12: board 0065 shows red and green swapped.
  const sw = R.encodeLighting({ mode: 10, speed: 3, brightness: 4, rgb: [255, 128, 0], random: false, sleep: 5 }, true);
  assert.equal(hx(sw, 11), "01 01 02 29 0a 00 03 04 80 ff 00");
  assert.deepEqual(R.decodeLighting(d), { mode: 10, speed: 3, brightness: 4, rgb: [255, 128, 0], random: false, sleep: 5 });
  assert.throws(() => R.encodeLighting({ mode: 0, speed: 3, brightness: 4, rgb: [0, 0, 0], random: false, sleep: 5 }), RangeError);
  assert.throws(() => R.encodeLighting({ mode: 22, speed: 3, brightness: 4, rgb: [0, 0, 0], random: false, sleep: 5 }), RangeError);
  assert.throws(() => R.encodeLighting({ mode: 1, speed: 6, brightness: 4, rgb: [0, 0, 0], random: false, sleep: 5 }), RangeError);
  assert.throws(() => R.encodeLighting({ mode: 1, speed: 1, brightness: 6, rgb: [0, 0, 0], random: false, sleep: 5 }), RangeError);
  assert.throws(() => R.encodeLighting({ mode: 1, speed: 1, brightness: 1, rgb: [0, 0, 256], random: false, sleep: 5 }), RangeError);
  assert.throws(() => R.encodeLighting({ mode: 1, speed: 1, brightness: 1, rgb: [0, 0, 0], random: false, sleep: 0 }), RangeError);
});

test("the lighting report equals a mirror of Rangoli's getStandardLightBuffer for many inputs", () => {
  const mirror = (mode: number, speed: number, bri: number, rgb: number[], random: boolean, sleep: number) => {
    const buffer = new Uint8Array(65);
    buffer[0] = 0x0a;
    buffer[1] = 0x01;
    buffer[2] = 0x01;
    buffer[3] = 0x02;
    buffer[4] = 0x29;
    buffer[5] = mode;
    buffer[7] = speed;
    buffer[8] = bri;
    if (!random) {
      buffer[9] = rgb[0];
      buffer[10] = rgb[1];
      buffer[11] = rgb[2];
    }
    buffer[12] = random ? 1 : 0;
    buffer[13] = sleep;
    return buffer;
  };
  for (let n = 0; n < 300; n++) {
    const a = [1 + rnd(21), 1 + rnd(5), rnd(6), [rnd(256), rnd(256), rnd(256)], rnd(2) === 1, 1 + rnd(5)] as const;
    const d = R.encodeLighting({ mode: a[0], speed: a[1], brightness: a[2], rgb: a[3] as [number, number, number], random: a[4], sleep: a[5] });
    assert.deepEqual([0x0a, ...d], Array.from(mirror(a[0], a[1], a[2], a[3] as number[], a[4], a[5])));
  }
});

// ---------------------------------------------------------------------------------------------
// The key map
// ---------------------------------------------------------------------------------------------

test("the key map is nine reports: [09 n (01 f8)] + 60 then 62 bytes of 139 big-endian slots", () => {
  assert.deepEqual([R.KEYMAP_BYTES, R.KEY_SLOTS, R.keymapChunk(1), R.keymapChunk(2), R.keymapOffset(2), R.keymapOffset(9)], [556, 139, 60, 62, 60, 494]);
  const frames = R.encodeKeymap(new Map([[0, R.keyCode(0x04)], [14, R.keyCode(0x05)], [15, R.keyCode(0x06)], [138, R.consumerCode(0xcd)]]));
  assert.equal(frames.length, 9);
  assert.equal(hx(frames[0], 12), "09 01 01 f8 00 00 04 00 00 00 00 00", "slot 0 = A (0x0400)");
  assert.equal(hx(frames[0].subarray(4 + 56), 4), "00 00 05 00", "slot 14 = B");
  assert.equal(hx(frames[1], 6), "09 02 00 00 06 00", "slot 15 starts report 2 (60 bytes = 15 slots)");
  assert.equal(frames[8][0], 9);
  assert.equal(hx(frames[8].subarray(60), 4), "01 00 00 cd", "slot 138 = consumer play/pause, the last 4 bytes");
  // A slot that straddles two reports: slot 30 starts at byte 120, two bytes before the end of report 2.
  const s = R.encodeKeymap(new Map([[30, R.keyCode(0x1d, 1)]]));
  assert.deepEqual([...s[1].subarray(62)], [0x00, 0x01], "slot 30's first two bytes end report 2");
  assert.deepEqual([...s[2].subarray(2, 4)], [0x1d, 0x00], "...and its last two start report 3");
  assert.deepEqual([...R.decodeKeymap(s)!], [[30, 0x011d00]]);
});

test("the key map equals a mirror of Rangoli's nine buffers, setBufferKey included, for many maps", () => {
  const setBufferKey = (buffer: Uint8Array, o: number, keyCode: number) => {
    if (keyCode >= 0x01000000) {
      buffer[o] = (keyCode >> 24) & 0xff;
      buffer[o + 1] = (keyCode >> 16) & 0xff;
      buffer[o + 2] = (keyCode >> 8) & 0xff;
      buffer[o + 3] = keyCode & 0xff;
    } else if (keyCode >= 0x010000) {
      buffer[o] = 0;
      buffer[o + 1] = (keyCode >> 16) & 0xff;
      buffer[o + 2] = (keyCode >> 8) & 0xff;
      buffer[o + 3] = keyCode & 0xff;
    } else if (keyCode >= 0x0100) {
      buffer[o] = 0;
      buffer[o + 1] = 0;
      buffer[o + 2] = (keyCode >> 8) & 0xff;
      buffer[o + 3] = keyCode & 0xff;
    } else if (keyCode >= 0x10) {
      buffer[o] = 0;
      buffer[o + 1] = 0;
      buffer[o + 2] = 0;
      buffer[o + 3] = keyCode & 0xff;
    }
  };
  const mirror = (map: Map<number, number>) => {
    const full = new Uint8Array(9 * 65);
    for (const [slot, code] of map) setBufferKey(full, slot * 4, code);
    const out: number[][] = [];
    let idx = 0;
    for (let i = 0; i < 9; i++) {
      const b = new Uint8Array(65);
      b[0] = 0x0a;
      b[1] = 9;
      b[2] = i + 1;
      if (i === 0) {
        b[3] = 0x01;
        b[4] = 0xf8;
      }
      for (let p = i === 0 ? 5 : 3; p < 65; p++) b[p] = full[idx++];
      out.push(Array.from(b));
    }
    return out;
  };
  const codes = [R.keyCode(0x04), R.keyCode(0x1d, 1), R.keyCode(0x2b, 4), R.keyCode(0x65), R.modifierCode(0xe1), R.modifierCode(0xe7), R.FN, R.consumerCode(0xe9), R.consumerCode(0x194)];
  for (let n = 0; n < 200; n++) {
    const map = new Map<number, number>();
    for (let i = 0; i < 1 + rnd(139); i++) map.set(rnd(139), codes[rnd(codes.length)]);
    const ours = R.encodeKeymap(map).map((d) => [0x0a, ...d]);
    assert.deepEqual(ours, mirror(map));
  }
});

test("firmware codes: Rangoli's keycode.h values classify as keys, modifiers, Fn and consumer keys", () => {
  const k = (code: number) => R.classifyCode(code);
  assert.deepEqual(k(0x0400), { kind: "key", hid: 4, mods: 0 }); // Key_A
  assert.deepEqual(k(0x2900), { kind: "key", hid: 0x29, mods: 0 }); // Key_Escape
  assert.deepEqual(k(0x011b00), { kind: "key", hid: 0x1b, mods: 1 }); // Shortcut_Cut
  assert.deepEqual(k(0x080700), { kind: "key", hid: 7, mods: 8 }); // Shortcut_Show_Desktop
  assert.equal(k(0x010000).kind, "modifier"); // Key_Left_Control
  assert.equal(k(0x800000).hid, 0xe7); // Key_Right_Super
  assert.equal(k(0xb000).kind, "fn"); // Key_Fn
  assert.deepEqual(k(0x010000cd), { kind: "consumer", usage: 0xcd }); // Multimedia_Play_Pause
  assert.deepEqual(k(0x01000194), { kind: "consumer", usage: 0x194 }); // Shortcut_Explorer
  assert.equal(k(0).kind, "none");
  for (const bad of [0x12345678, 0x02000100, 0x0400ff, 0x010100, 0xffff]) assert.equal(k(bad).kind, "unknown", bad.toString(16));
  assert.equal(R.keyCode(0x04), 0x0400);
  assert.equal(R.keyCode(0x1b, 1), 0x011b00);
  assert.equal(R.modifierCode(0xe0), 0x010000);
  assert.equal(R.modifierCode(0xe7), 0x800000);
  assert.equal(R.consumerCode(0xe2), 0x010000e2);
  assert.throws(() => R.encodeKeymap(new Map([[139, 0x0400]])), RangeError);
  assert.throws(() => R.encodeKeymap(new Map([[0, 0x12345678]])), RangeError);
});

// ---------------------------------------------------------------------------------------------
// The model table
// ---------------------------------------------------------------------------------------------

test("the table: 168 boards on 0x258A, Rangoli's confirmed ones marked, its unsupported ones left out", () => {
  assert.equal(R.RK_MODELS.length, 168);
  assert.ok(R.RK_MODELS.every((m) => m.vendorId === 0x258a && m.tier === "experimental" && m.kind === "keyboard"));
  assert.deepEqual([...R.RK_MODELS].filter((m) => m.board.status === "confirmed").map((m) => m.productId).sort((a, b) => a - b), [0x69, 0x5a, 0x00a4, 0x00ea].sort((a, b) => a - b));
  for (const pid of [0x0102, 0x00a9, 0x0059]) assert.equal(R.rkModel(0x258a, pid), null, `Rangoli's unsupported ${pid.toString(16)}`);
  // The boards with a screen use a newer data format and aren't claimed.
  for (const pid of [0x0174, 0x01a2, 0x01d6, 0x01f5, 0x0223, 0x0241]) assert.equal(R.rkModel(0x258a, pid), null, `screen board ${pid.toString(16)}`);
  // Another SinoWealth board (AULA F75 = 258A:010C) and the VID alone are nobody's.
  assert.equal(R.rkModel(0x258a, 0x010c), null);
  assert.equal(R.rkModel(0x1234, 0x0147), null);
  // FCC's four M75 boards.
  for (const [pid, keys] of [[0x0147, 81], [0x0163, 81], [0x0175, 82], [0x01ac, 82]] as const) {
    const m = R.rkModel(0x258a, pid)!;
    assert.equal(R.layoutOf(m.board).length, keys, m.model);
    assert.equal(m.board.keymap, true);
    assert.equal(m.board.status, "listed");
  }
  assert.match(R.rkModel(0x258a, 0x0147)!.model, /M75/);
  // Rangoli's notes.
  assert.equal(R.rkModel(0x258a, 0x0057)!.board.keymap, false, "Rangoli issue 16: the key map doesn't work");
  assert.deepEqual(R.rkModel(0x258a, 0x0065)!.board.quirks, ["swap-red-green"]);
  assert.equal(R.rkModel(0x258a, 0x0065)!.board.status, "partial");
  assert.ok(R.RK_MODELS.filter((m) => m.board.keymap).length >= 130);
});

test("every board's layout is sane: unique slots inside the map, a default code that is a real code, a known default for the whole map", () => {
  for (const m of R.RK_MODELS) {
    const rows = R.layoutOf(m.board);
    assert.ok(rows.length >= 60 && rows.length <= 125, `${m.model} ${rows.length} keys`);
    assert.equal(new Set(rows.map((r) => r[0])).size, rows.length, `${m.model}: a slot twice`);
    for (const [slot, fw, x, y, w, h] of rows) {
      assert.ok(slot >= 0 && slot < R.KEY_SLOTS, `${m.model} slot ${slot}`);
      assert.notEqual(R.classifyCode(fw).kind, "unknown", `${m.model} slot ${slot} code ${fw.toString(16)}`);
      assert.ok(x >= 0 && y >= 0 && w > 0 && h >= 1 && h <= 3);
    }
    if (m.board.keymap) assert.equal(R.defaultCodes(m.board).size, rows.length);
    assert.ok(m.board.modes.length >= 3, `${m.model} has lighting modes`);
  }
});

test("lighting modes: the older RGB boards, the standard table and the five boards with their own names", () => {
  const m = (pid: number) => R.rkModel(0x258a, pid)!.board;
  // 0147 (M75, standard table): 1 Steady with no speed control, 2 Customize (per-key, not offered).
  const m75 = R.modesOf(m(0x0147));
  assert.deepEqual([m75[0].n, m75[0].name, m75[0].speed, m75[0].brightness, m75[0].color], [1, "Steady", false, true, true]);
  assert.equal(m75[1].name, "Customize");
  assert.ok(m75[1].custom && !R.offeredModes(m(0x0147)).some((x) => x.custom));
  assert.equal(m(0x0147).defMode, 10);
  assert.equal(R.modeName(m(0x0147), 10), "Flash away");
  // 005A (RK71RGB): the older RGB table: 17 Steady (no speed), 14 Custom.
  assert.equal(m(0x005a).gen, "rgb-old");
  assert.equal(R.modeName(m(0x005a), 17), "Steady");
  assert.equal(R.modeName(m(0x005a), 14), "Custom");
  assert.equal(R.modesOf(m(0x005a)).find((x) => x.n === 17)!.speed, false);
  // 014E (RK-F68) has its own three: Steady, Breathing, OFF, no colour at all.
  assert.deepEqual(R.modesOf(m(0x014e)).map((x) => [x.n, x.name, x.color]), [[1, "Steady", false], [2, "Breathing", false], [3, "OFF", false]]);
  // Every mode number of every board is 1..21 and has a name.
  for (const mm of R.RK_MODELS) for (const x of R.modesOf(mm.board)) assert.ok(x.n >= 1 && x.n <= 21 && x.name && !/^Mode /.test(x.name), `${mm.model} mode ${x.n}`);
});

// ---------------------------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------------------------

const lit = (over: Partial<Parameters<typeof R.encodeLighting>[0]> = {}) => R.encodeLighting({ mode: 10, speed: 3, brightness: 4, rgb: [1, 2, 3], random: false, sleep: 5, ...over });
const ok = (d: Uint8Array, ctx?: R.GuardContext) => R.classifyData(d, ctx).verdict !== "blocked";

test("the guard lets the lighting report and the nine key-map reports through, and nothing else", () => {
  assert.ok(ok(lit()));
  assert.ok(ok(lit({ random: true })));
  for (const f of R.encodeKeymap(new Map([[0, 0x2900], [3, R.consumerCode(0xe2)], [5, R.FN]]))) assert.ok(ok(f));
  assert.ok(ok(R.encodeKeymap(new Map())[0]), "an empty map is the default");
  const bad = (bytes: number[]) => {
    const f = new Uint8Array(64);
    f.set(bytes);
    return f;
  };
  assert.equal(ok(bad([1, 1, 2, 0x29, 3, 0, 3, 5, 255, 255, 255, 1, 5])), false, "random with colours");
  assert.equal(ok(bad([1, 1, 2, 0x29, 0, 0, 3, 5, 0, 0, 0, 0, 5])), false, "mode 0");
  assert.equal(ok(bad([1, 1, 2, 0x29, 22, 0, 3, 5, 0, 0, 0, 0, 5])), false, "mode 22");
  assert.equal(ok(bad([7, 1, 3, 0x7e, 1])), false, "per-key colours");
  assert.equal(R.classifyData(bad([7, 1, 3, 0x7e, 1])).verdict, "blocked");
  assert.equal(ok(bad([9, 1, 1, 0xf7])), false, "key-map header");
  assert.equal(ok(bad([9, 10, 0])), false, "report 10 of 9");
  assert.equal(ok(bad([0x55, 3, 0, 0x38, 0x38])), false, "another family's frame");
  // Key codes: a key's HID byte past 0xE7, a consumer code with a modifier byte, bytes after a key's code.
  const map = R.encodeKeymap(new Map([[0, R.keyCode(0x04)]]));
  const g = (i: number, at: number, v: number) => {
    const c = new Uint8Array(map[i]);
    c[at] = v;
    return c;
  };
  assert.equal(ok(g(0, 4, 2)), false, "first byte 2");
  assert.equal(ok(g(0, 6, 0xe8)), false, "HID byte above 0xE7");
  assert.equal(ok(g(0, 7, 1)), false, "a key's last byte");
  const consumer = R.encodeKeymap(new Map([[0, R.consumerCode(0xcd)]]))[0];
  assert.ok(ok(consumer));
  const c2 = new Uint8Array(consumer);
  c2[5] = 1;
  assert.equal(ok(c2), false, "a consumer code has no modifier byte");
  // Feature reports with id 0x0A only; output reports, other ids and lengths never.
  assert.equal(R.RK_BEIYING_GUARD.classify({ type: "output", reportId: 0x0a, data: lit() }).verdict, "blocked");
  assert.equal(R.RK_BEIYING_GUARD.classify({ type: "feature", reportId: 0, data: lit() }).verdict, "blocked");
  assert.equal(R.RK_BEIYING_GUARD.classify(feature(lit().slice(0, 63))).verdict, "blocked");
  assert.equal(R.RK_BEIYING_GUARD.classify(feature(lit())).verdict, "write");
});

test("a session's guard: read-only tier writes nothing, a mode must be the board's, no key map where it isn't offered", () => {
  const ctx = (over: Partial<R.GuardContext> = {}): R.GuardContext => ({ writes: true, keymap: true, modes: [1, 3, 10], ...over });
  assert.ok(ok(lit(), ctx()));
  assert.equal(ok(lit(), ctx({ writes: false })), false, "read-only");
  assert.equal(ok(lit({ mode: 4 }), ctx()), false, "mode 4 isn't one of this board's");
  assert.ok(ok(lit({ mode: 3 }), ctx()));
  assert.ok(ok(R.encodeKeymap(new Map())[0], ctx()));
  assert.equal(ok(R.encodeKeymap(new Map())[0], ctx({ keymap: false })), false, "key map not offered");
  assert.ok(ok(lit({ mode: 4 }), { writes: true, keymap: false }), "no mode list: any mode");
});

test("the frame fixture is what the guard says today (rust and the website read the same lines)", () => {
  const lines = readFileSync(join(root, "src/lib/brands/rk-beiying/rk-beiying-frames.txt"), "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length >= 4000, `${lines.length} frames`);
  let allowed = 0;
  for (const line of lines) {
    const [v, hex = ""] = line.split(" ");
    const f = new Uint8Array(64);
    f.set((hex.match(/../g) ?? []).map((x) => parseInt(x, 16)));
    assert.equal(v === "1", ok(f), hex);
    if (v === "1") allowed++;
  }
  assert.ok(allowed > 800 && allowed < lines.length * 0.5, String(allowed));
});
