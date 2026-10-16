// Headless end-to-end check of src/lib/brands/rk-beiying (session + the generic Keyboard driver + KbSession)
// against a simulated Royal Kludge BeiYing keyboard: it takes HID feature reports with id 0x0A and 64 bytes on its
// System Control collection and never answers. No hardware, no window.
// Run: node scripts/rk-beiying-session.sim.mjs
import assert from "node:assert/strict";
import * as R from "../src/lib/brands/rk-beiying/index.ts";
import { createRkKbDriver } from "../src/lib/brands/rk-beiying/kb-driver.ts";
import { SimRkBoard } from "../src/lib/brands/rk-beiying/sim.ts";
import { KbSession, memoryKbStore } from "../src/lib/kb/session.ts";
import { driversFor, CORE_DRIVERS } from "../src/lib/kb/registry.ts";

const hex = (f, n = 14) => Array.from(f.subarray(0, n), (b) => b.toString(16).padStart(2, "0")).join(" ");

const FakeRk = SimRkBoard;

const store = () => memoryKbStore();

async function open(board, shadow) {
  const driver = createRkKbDriver({ store: shadow });
  const kb = store();
  const backend = await driver.open(board, { store: kb, live: false, devices: async () => [] });
  return { driver, backend, s: new KbSession(backend, kb, board), kb };
}

// ---------------------------------------------------------------------------------------------
// RK-M75 (258A:0147): nothing is sent on connect; locked until allowed; one report per lighting change
// ---------------------------------------------------------------------------------------------
{
  const shadow = R.memoryShadowStore();
  const board = new FakeRk(0x0147, "RK-M75");
  const { s, backend } = await open(board, shadow);
  assert.equal(board.reports.length, 0, "connecting sends nothing");
  const v = s.view;
  assert.equal(v.info.brand, "Royal Kludge");
  assert.match(v.info.model, /M75/);
  assert.deepEqual(v.info.firmware, []);
  assert.equal(v.tier, "read-only");
  assert.equal(v.keymap.keySpace, "vendor");
  assert.equal(v.keymap.layers, 1);
  assert.equal(v.keymap.layout.keys.length, 81);
  assert.equal(v.keymap.codes[0][0], 0x2900, "slot 0 is Esc by default");
  assert.equal(v.keymap.label(0x2900), "Esc");
  assert.equal(v.keymap.label(R.consumerCode(0xcd)), "Play / pause");
  assert.equal(v.keymap.label(R.keyCode(0x1b, 1)), "Ctrl+X");
  assert.equal(v.keymap.label(R.FN), "Fn");
  assert.equal(v.keymap.source, "cache");
  assert.ok(v.notes.some((n) => /can't report its settings/.test(n)));
  assert.ok(v.notes.some((n) => /Rangoli|FCC/.test(n)));
  assert.equal(v.writable.keymap, false);
  assert.equal(v.lighting.source, "cache");
  const modeSetting = v.lighting.groups[0].settings.find((x) => x.id === "effect");
  assert.ok(!modeSetting.choice.options.some((o) => o.label === "Customize"), "the per-key mode isn't offered");
  assert.equal(modeSetting.value, 10, "the board's default mode");
  // A change before allowing is refused and sends nothing.
  await assert.rejects(() => s.apply({ kind: "lighting", id: "brightness", value: 2 }), /Read-only until you allow/);
  assert.equal(board.reports.length, 0);

  s.setAllowChanges(true);
  // Lighting: one report, unconfirmed.
  const r1 = await s.apply({ kind: "lighting", id: "brightness", value: 2 });
  assert.equal(r1.verdict, "unconfirmed");
  assert.match(r1.detail, /Unconfirmed: the keyboard can't report this back/);
  assert.equal(board.reports.length, 1);
  assert.equal(hex(board.reports[0]), "01 01 02 29 0a 00 03 02 ff ff ff 00 05 00", "mode 10, speed 3, brightness 2, white, not random, sleep never");
  const r2 = await s.apply({ kind: "lighting", id: "color", value: [0, 255] });
  assert.equal(r2.verdict, "unconfirmed");
  assert.equal(hex(board.reports.at(-1), 11), "01 01 02 29 0a 00 03 02 ff 00 00", "red");
  const r3 = await s.apply({ kind: "lighting", id: "rainbow", value: 1 });
  assert.equal(hex(board.reports.at(-1), 13), "01 01 02 29 0a 00 03 02 00 00 00 01 05", "random colours: the colour bytes are zero");
  void r3;
  const r4 = await s.apply({ kind: "lighting", id: "effect", value: 3 });
  assert.equal(r4.view.lighting.groups[0].settings.find((x) => x.id === "effect").value, 3);
  assert.equal(board.reports.at(-1)[4], 3);
  const r5 = await s.apply({ kind: "option", id: "sleep", value: 2 });
  assert.equal(board.reports.at(-1)[12], 2);
  void r5;
  // A mode the board doesn't offer, a per-key mode, and a bad value never leave.
  const n = board.reports.length;
  await assert.rejects(() => s.apply({ kind: "lighting", id: "effect", value: 2 }), /doesn't offer that mode/);
  await assert.rejects(() => s.apply({ kind: "lighting", id: "effect", value: 99 }), /doesn't offer that mode/);
  await assert.rejects(() => s.apply({ kind: "lighting", id: "speed", value: 9 }), /Speed must be/);
  await assert.rejects(() => s.apply({ kind: "polling", hz: 1000 }), /can't change that/);
  assert.equal(board.reports.length, n);
  assert.deepEqual(board.violations, []);

  // Keys: nine reports, the default map plus the one change.
  assert.equal(s.view.writable.keymap, true);
  const before = board.reports.length;
  const r6 = await s.apply({ kind: "keycode", layer: 0, key: 0, code: R.keyCode(0x04) });
  assert.equal(r6.verdict, "unconfirmed");
  assert.equal(r6.persistence, "saved");
  assert.equal(board.reports.length, before + 9);
  const map = board.lastMap();
  const model = R.rkModel(0x258a, 0x0147);
  const defaults = R.defaultCodes(model.board);
  assert.equal(map.get(0), 0x0400, "Esc is now A");
  for (const [slot, code] of defaults) if (slot !== 0) assert.equal(map.get(slot), code, `slot ${slot} keeps its default`);
  assert.equal(map.size, defaults.size, "no slot invented");
  assert.equal(r6.view.keymap.codes[0][0], 0x0400);
  assert.equal(r6.view.keymap.layout.keys.find((k) => k.index === 0).label, "A");
  // A second change keeps the first (the shadow); a "default" puts one back.
  await s.apply({ kind: "keycode", layer: 0, key: 5, code: R.consumerCode(0xe2) });
  assert.equal(board.lastMap().get(0), 0x0400);
  assert.equal(board.lastMap().get(5), R.consumerCode(0xe2));
  await s.apply({ kind: "keycode", layer: 0, key: 0, code: 0 });
  assert.equal(board.lastMap().get(0), 0x2900, "code 0 puts the default back");
  assert.equal(board.lastMap().get(5), R.consumerCode(0xe2));
  // Bad keys and codes are refused before anything is sent.
  const k = board.reports.length;
  await assert.rejects(() => s.apply({ kind: "keycode", layer: 1, key: 0, code: 0x0400 }), /Only the base layer/);
  await assert.rejects(() => s.apply({ kind: "keycode", layer: 0, key: 138, code: 0x0400 }), /isn't a key/);
  await assert.rejects(() => s.apply({ kind: "keycode", layer: 0, key: 0, code: 0x12345678 }), /isn't a key code/);
  assert.equal(board.reports.length, k);
  assert.deepEqual(board.violations, []);
  assert.ok(board.reports.every((f) => [1, 9].includes(f[0])), "only lighting and key-map reports");

  // The shadow survives the session: what SYNQ last sent is shown again next time.
  await s.close();
  const again = await open(new FakeRk(0x0147, "RK-M75"), shadow);
  assert.equal(again.s.view.keymap.codes[0][5], R.consumerCode(0xe2));
  assert.equal(again.s.view.lighting.groups[0].settings.find((x) => x.id === "effect").value, 3);
  assert.equal(again.backend.state.info.extra.find((e) => e[0] === "Settings")[1], "As last sent from this PC");
  assert.equal(backend.state.info.model.length > 0, true);
  await again.s.close();
}

// ---------------------------------------------------------------------------------------------
// Boards whose map isn't offered, and the swapped-colour board
// ---------------------------------------------------------------------------------------------
{
  const shadow = R.memoryShadowStore();
  // 0057: Rangoli says the key map doesn't work.
  const b57 = new FakeRk(0x0057);
  const a = await open(b57, shadow);
  a.s.setAllowChanges(true);
  assert.equal(a.s.view.keymap, undefined);
  assert.ok(a.s.view.notes.some((n) => /key map isn't offered/.test(n)));
  await assert.rejects(() => a.s.apply({ kind: "keycode", layer: 0, key: 0, code: 0x0400 }), /isn't offered|can't change/);
  assert.equal(b57.reports.length, 0);
  const lit = await a.s.apply({ kind: "lighting", id: "brightness", value: 3 });
  assert.equal(lit.verdict, "unconfirmed", "lighting still works");
  await a.s.close();

  // 0065: red and green are swapped on the wire.
  const b65 = new FakeRk(0x0065);
  const b = await open(b65, R.memoryShadowStore());
  b.s.setAllowChanges(true);
  const mode = b.s.view.lighting.groups[0].settings.find((x) => x.id === "effect").choice.options[0].value;
  await b.s.apply({ kind: "lighting", id: "effect", value: mode });
  await b.s.apply({ kind: "lighting", id: "color", value: [0, 255] });
  const last = b65.reports.at(-1);
  assert.deepEqual([last[8], last[9], last[10]], [0, 255, 0], "pure red goes out as red and green swapped");
  await b.s.close();
}

// ---------------------------------------------------------------------------------------------
// A board with its own mode names and no colour (RK-F68, 258A:014E)
// ---------------------------------------------------------------------------------------------
{
  const board = new FakeRk(0x014e, "RK-F68");
  const { s } = await open(board, R.memoryShadowStore());
  const settings = s.view.lighting.groups[0].settings;
  assert.deepEqual(settings.find((x) => x.id === "effect").choice.options.map((o) => o.label), ["Steady", "Breathing", "OFF"]);
  assert.equal(settings.find((x) => x.id === "color"), undefined, "a single-colour board has no colour");
  assert.equal(settings.find((x) => x.id === "rainbow"), undefined);
  await s.close();
}

// ---------------------------------------------------------------------------------------------
// Claims: one driver per id, only on System Control; a bootloader or another vendor's board never
// ---------------------------------------------------------------------------------------------
{
  const dev = (v, p, cols) => ({ vendorId: v, productId: p, productName: "", collections: cols, opened: false });
  const sc = { usagePage: 1, usage: 0x80 };
  const typing = [{ usagePage: 1, usage: 6 }, { usagePage: 0x0c, usage: 1 }];
  for (const [v, p] of R.RK_IDS) assert.deepEqual((await driversFor(dev(v, p, [...typing, sc]), CORE_DRIVERS)).map((d) => d.id), ["rk-beiying"], `${p.toString(16)}`);
  assert.deepEqual((await driversFor(dev(0x258a, R.RK_IDS[0][1], typing), CORE_DRIVERS)).map((d) => d.id), []);
  const refusing = createRkKbDriver({ store: R.memoryShadowStore() });
  const odd = new FakeRk(0x0102);
  await assert.rejects(() => refusing.open(odd, { store: memoryKbStore(), live: false, devices: async () => [] }), /not a Royal Kludge BeiYing keyboard/);
  assert.equal(odd.reports.length, 0);
  const noSc = new FakeRk(0x0147);
  noSc.collections = [{ usagePage: 1, usage: 6 }];
  assert.equal(refusing.claims(noSc), false);
  assert.equal(await refusing.ping(new FakeRk(0x0147)), true);
}

console.log("rk-beiying session sim: ok");
