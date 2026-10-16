// Headless end-to-end check of src/lib/brands/fw19f5 (session + the generic Keyboard driver + KbSession)
// against simulated boards that answer the way FCC's documentation and svumo's capture describe: 64-byte
// reports, [0x55, cmd, 0, checksum, len, offset, flag, data] in, [0xAA, ...] out, memory areas behind them.
// No hardware, no window: the fakes implement the HIDDevice shape the drivers use.
// Run: node scripts/fw19f5-session.sim.mjs
import assert from "node:assert/strict";
import * as F from "../src/lib/brands/fw19f5/index.ts";
import { fw19f5KbDriver } from "../src/lib/brands/fw19f5/kb-driver.ts";
import { SimFw19f5Board } from "../src/lib/brands/fw19f5/sim.ts";
import { KbSession, memoryKbStore } from "../src/lib/kb/session.ts";
import { genericKeyboard } from "../src/lib/feel/devices.ts";
import { driversFor, CORE_DRIVERS } from "../src/lib/kb/registry.ts";

const hex = (f, n = 12) => Array.from(f.subarray(0, n), (b) => b.toString(16).padStart(2, "0")).join(" ");

/** The simulated board of src/lib/brands/fw19f5/sim.ts, with this script's habit of passing the catalogue row as `units`. */
class FakeBoard extends SimFw19f5Board {
  constructor({ units, ...o }) {
    super({ ...o, step: units?.step, oddKeys: true });
  }
}

async function session(board, { allow = false } = {}) {
  const store = memoryKbStore();
  const backend = await fw19f5KbDriver.open(board, { store, live: false, devices: async () => [] });
  const s = new KbSession(backend, store, board);
  if (allow) s.setAllowChanges(true);
  return { s, backend, store };
}

// ---------------------------------------------------------------------------------------------
// MCHOSE Ace 60 Pro (41E4:2103): reads, the lock, a confirmed write, nothing else moves
// ---------------------------------------------------------------------------------------------
{
  const model = F.fwModel(0x41e4, 0x2103);
  const slots = F.layoutOf(model.board).map((k) => k[0]);
  const board = new FakeBoard({ vendorId: 0x41e4, productId: 0x2103, productName: "MCHOSE Ace 60 Pro", units: model.board, layoutSlots: slots, profile: 1 });
  const { s, backend, store } = await session(board);
  const v = s.view;
  assert.equal(v.info.brand, "MCHOSE");
  assert.equal(v.info.model, "Ace 60 Pro");
  assert.deepEqual(v.info.firmware, ["Firmware 1.20"]);
  assert.equal(v.tier, "read-only");
  assert.equal(v.analog.keys.length, 61);
  assert.equal(v.analog.layout.source, "driver");
  assert.equal(v.analog.layout.keys.find((k) => k.label === "Esc")?.index, slots[0]);
  assert.equal(v.analog.perKey[slots[0]].actuationMm, 1.5);
  assert.equal(v.analog.perKey[slots[0]].rtPressMm, 0.29);
  assert.equal(v.analog.perKey[slots[3]].rapidTrigger, false, "the advanced-mode key is not rapid trigger");
  assert.equal(v.analog.perKey[slots[4]].rapidTrigger, true);
  assert.equal(v.analog.perKey[slots[4]].rtPressMm, 0.055, "precision code 1 is 0.005 mm");
  assert.equal(v.analog.unitSource, "manifest");
  assert.deepEqual(v.profiles, { active: 1, count: 4, names: [], writable: false, note: "Switching profiles isn't offered for these boards yet." });
  assert.equal(v.writable.analog, false, "behind Allow changes");
  assert.ok(v.lighting && v.options.length === 6);
  // Only the active profile (1) was ever read, and only the listed areas.
  const reads = board.sent.map((f) => F.parseRequest(f));
  assert.ok(reads.every((r) => [3, 4, 5, 160].includes(r.cmd)));
  assert.ok(reads.filter((r) => r.cmd === 160).every((r) => Math.floor(r.offset / 1024) === 1));
  // A change before allowing is refused and sends nothing.
  const before = board.sent.length;
  await assert.rejects(() => s.apply({ kind: "analog", target: "global", values: { actuationMm: 2 } }), /Read-only until you allow/);
  assert.equal(board.sent.length, before);

  s.setAllowChanges(true);
  const dks = slots[3];
  const fine = slots[4];
  const rec = (p, slot) => board.area[160].subarray(1024 * p + slot * 8, 1024 * p + slot * 8 + 8);

  // A global change: every key moves, the advanced-mode key keeps its mode, nothing else in any record moves.
  const snap = Uint8Array.from(board.area[160]);
  const r1 = await s.apply({ kind: "analog", target: "global", values: { actuationMm: 2.2, rapidTrigger: true, rtPressMm: 0.3, rtReleaseMm: 0.2 } });
  assert.equal(r1.verdict, "confirmed", r1.detail);
  assert.equal(r1.persistence, "saved");
  assert.equal(hex(rec(1, slots[0]), 8), "a0 11 db 00 1d 00 13 00", "2.20 mm = raw 220, RT on, priority nibble kept, 0.30 / 0.20");
  assert.equal(rec(1, dks)[1], 0x03, "dynamic-keystroke key keeps its mode");
  assert.equal(rec(1, dks)[2], 0xdb, "...but its actuation changed");
  assert.equal(rec(1, fine)[3] & 0x1e, (1 << 3) | (2 << 1), "precision codes kept");
  assert.equal(rec(1, fine)[5] & 0xfe, 5 << 1, "press dead zone kept");
  assert.equal(rec(1, fine)[7] & 0xfe, 9 << 1, "release dead zone kept");
  for (const p of [0, 2, 3]) assert.deepEqual(board.area[160].subarray(1024 * p, 1024 * p + 1024), snap.subarray(1024 * p, 1024 * p + 1024), `profile ${p} untouched`);
  assert.ok(board.writes.every((w) => w.flag === 0 && w.cmd === 161), "MCHOSE never flags a chunk");
  assert.ok(board.writes.every((w) => w.len % 8 === 0 && w.len <= 56 && w.offset >= 1024 && w.offset < 2048));
  assert.deepEqual(board.violations, []);
  assert.equal(r1.view.analog.perKey[slots[0]].actuationMm, 2.2);
  assert.equal(r1.view.analog.perKey[dks].rapidTrigger, false);
  assert.equal(store.backups.length, 1, "one backup, before the first write");

  // One key, one field. A value the key can't hold is refused before anything is sent.
  const sentBefore = board.sent.length;
  await assert.rejects(() => s.apply({ kind: "analog", target: [fine], values: { rtPressMm: 3 } }), /isn't a value|can't hold/);
  await assert.rejects(() => s.apply({ kind: "analog", target: [slots[0]], values: { actuationMm: 9 } }), /Actuation must be/);
  await assert.rejects(() => s.apply({ kind: "analog", target: [dks], values: { rapidTrigger: true } }), /advanced mode/);
  await assert.rejects(() => s.apply({ kind: "analog", target: [9999], values: { actuationMm: 1 } }), /isn't a key/);
  assert.equal(board.sent.length, sentBefore, "refusals send nothing");
  const r2 = await s.apply({ kind: "analog", target: [slots[10]], values: { actuationMm: 0.8 } });
  assert.equal(r2.verdict, "confirmed");
  assert.equal(rec(1, slots[10])[2], 79);
  assert.equal(board.writes.filter((w) => w.cmd === 161).at(-1).len, 8, "one record");

  // Function block: lock, debounce, sleep, lighting. Undocumented bytes survive.
  const r3 = await s.apply({ kind: "option", id: "altTabLock", value: 1 });
  assert.equal(r3.verdict, "confirmed", r3.detail);
  const fb = board.area[5].subarray(64, 128);
  assert.equal(fb[6], 0x03, "Win lock was on; Alt+Tab lock added");
  assert.equal(fb[40], 0x7e, "an undocumented byte survives");
  assert.equal(fb[1], 0x02);
  assert.equal(fb[4], 0x35);
  const r4 = await s.apply({ kind: "option", id: "debounce", value: 5 });
  assert.equal(r4.verdict, "confirmed");
  assert.equal(board.area[5][64 + 7], 0xa0 | 0x04, "debounce 5 in the top bits, the other flag bits kept");
  const r5 = await s.apply({ kind: "option", id: "sleep", value: 300 });
  assert.equal(r5.verdict, "confirmed");
  assert.equal(board.area[5][64 + 35], 10);
  const r6 = await s.apply({ kind: "lighting", id: "color", value: [0, 255] });
  assert.equal(r6.verdict, "confirmed");
  assert.deepEqual(Array.from(board.area[5].subarray(64 + 14, 64 + 17)), [255, 0, 0]);
  const r7 = await s.apply({ kind: "lighting", id: "effect", value: 9 });
  assert.equal(r7.verdict, "confirmed");
  assert.equal(board.area[5][64 + 8], 9);
  await assert.rejects(() => s.apply({ kind: "lighting", id: "effect", value: 99 }), /doesn't offer that effect/);
  const r8 = await s.apply({ kind: "lighting", id: "speed", value: 4 });
  assert.equal(r8.verdict, "confirmed");
  assert.equal(board.area[5][64 + 10], 0);
  const untouched = [0, 2, 3].every((p) => board.area[5][64 * p + 6] === 0x01 && board.area[5][64 * p + 7] === 0x44 && board.area[5][64 * p + 8] === 3 && board.area[5][64 * p + 35] === 4);
  assert.ok(untouched, "the other profiles' function blocks are untouched");
  assert.deepEqual(board.violations, []);
  assert.ok(board.writes.filter((w) => w.cmd === 6).every((w) => w.len === 56 && (w.offset === 64 || w.offset === 72) && w.flag === 0));
  // Everything the board ever received was an info / base / function / trigger area.
  assert.ok(board.sent.every((f) => [3, 4, 5, 6, 160, 161].includes(f[1])));
  assert.ok(backend.blocked.length >= 6);
  await s.close();
}

// ---------------------------------------------------------------------------------------------
// "Keep your feel": the generic path understands this driver's view
// ---------------------------------------------------------------------------------------------
{
  const model = F.fwModel(0x3837, 0x3028);
  const slots = F.layoutOf(model.board).map((k) => k[0]);
  const board = new FakeBoard({ vendorId: 0x3837, productId: 0x3028, productName: "MCHOSE Ace 68 Turbo", units: model.board, layoutSlots: slots });
  const { s } = await session(board, { allow: true });
  const dev = genericKeyboard(s.view);
  assert.deepEqual(dev.target.actuation, { min: 0.1, max: 3.3, step: 0.01 });
  assert.equal(dev.target.rapidTrigger, true);
  assert.deepEqual(dev.target.rtSensitivity, { min: 0.02, max: 3.4, step: 0.01, independent: true });
  assert.equal(dev.now.actuationMm, 1.5);
  assert.equal(dev.now.rtPressMm, 0.29);
  await s.close();
}

// ---------------------------------------------------------------------------------------------
// The Ace 60 (41E4:2101): 50 units per mm
// ---------------------------------------------------------------------------------------------
{
  const model = F.fwModel(0x41e4, 0x2101);
  assert.equal(model.board.step, 50);
  const slots = F.layoutOf(model.board).map((k) => k[0]);
  const board = new FakeBoard({ vendorId: 0x41e4, productId: 0x2101, productName: "Ace 60", units: model.board, layoutSlots: slots });
  const { s } = await session(board, { allow: true });
  assert.equal(s.view.analog.fields.actuationMm.step, 0.02);
  assert.equal(s.view.analog.perKey[slots[0]].actuationMm, 1.5);
  const r = await s.apply({ kind: "analog", target: [slots[1]], values: { actuationMm: 2 } });
  assert.equal(r.verdict, "confirmed");
  assert.equal(board.area[160][slots[1] * 8 + 2], 99, "2 mm at 50 per mm is raw 100, stored 99");
  await s.close();
}

// ---------------------------------------------------------------------------------------------
// A unit that doesn't fit: nothing is writable
// ---------------------------------------------------------------------------------------------
{
  const model = F.fwModel(0x41e4, 0x2103);
  const slots = F.layoutOf(model.board).map((k) => k[0]);
  const board = new FakeBoard({ vendorId: 0x41e4, productId: 0x2103, productName: "Ace 60 Pro", units: model.board, layoutSlots: slots });
  board.area[160].set([0xa0, 0x00, 0xb0, 0x01, 28, 0, 28, 0], slots[7] * 8); // one key reads as 4.33 mm, past the 3.4 mm travel
  const { s } = await session(board, { allow: true });
  assert.equal(s.view.writable.analog, true, "the switch is on");
  assert.deepEqual(s.view.analog.writable, [], "...but the unit check failed, so no field is writable");
  assert.match(s.view.analog.note, /impossible travel/);
  await assert.rejects(() => s.apply({ kind: "analog", target: "global", values: { actuationMm: 1 } }), /impossible travel/);
  assert.ok(board.sent.every((f) => [3, 4, 5, 160].includes(f[1])), "nothing but reads");
  await s.close();
}

// ---------------------------------------------------------------------------------------------
// NuPhy: the firmware version and nothing else
// ---------------------------------------------------------------------------------------------
{
  const board = new FakeBoard({ vendorId: 0x19f5, productId: 0x6120, productName: "NuPhy Air75 HE" });
  const { s } = await session(board, { allow: true });
  const v = s.view;
  assert.equal(v.info.brand, "NuPhy");
  assert.equal(v.info.model, "Air75 HE");
  assert.deepEqual(v.info.firmware, ["Firmware 1.20"]);
  assert.equal(v.analog, undefined);
  assert.equal(v.lighting, undefined);
  assert.ok(v.notes.some((n) => /XOR/.test(n)));
  assert.deepEqual(board.sent.map((f) => f[1]), [3, 4], "info and base only");
  await assert.rejects(() => s.apply({ kind: "analog", target: "global", values: { actuationMm: 1 } }));
  await assert.rejects(() => s.apply({ kind: "option", id: "winLock", value: 1 }));
  assert.deepEqual(board.sent.map((f) => f[1]), [3, 4], "still nothing else");
  await s.close();
}

// ---------------------------------------------------------------------------------------------
// NuPhy firmware that masks its traffic: no answer, so it is only listed
// ---------------------------------------------------------------------------------------------
{
  const board = new FakeBoard({ vendorId: 0x19f5, productId: 0x6130, productName: "NuPhy BH65 HE", answer: false });
  const backend = await fw19f5KbDriver.open(board, { store: memoryKbStore(), live: false, devices: async () => [] });
  assert.equal(backend.state.info.model, "BH65 HE");
  assert.deepEqual(backend.state.info.firmware, []);
  assert.ok(backend.state.notes.some((n) => /masks its traffic/.test(n)));
  assert.equal(board.sent.length, 3, "three tries of the info read, then it gives up");
  assert.ok(board.sent.every((f) => f[1] === 3));
  await backend.close();
  const before = board.sent.length;
  assert.equal(await fw19f5KbDriver.ping(board), false);
  assert.ok(board.sent.length > before && board.sent.every((f) => f[1] === 3));
}

// ---------------------------------------------------------------------------------------------
// Royal Kludge Gcome: read-only too
// ---------------------------------------------------------------------------------------------
{
  const board = new FakeBoard({ vendorId: 0x19f5, productId: 0xa01c, productName: "RK K99" });
  const { s } = await session(board, { allow: true });
  assert.equal(s.view.info.brand, "Royal Kludge");
  assert.equal(s.view.analog, undefined);
  assert.deepEqual(board.sent.map((f) => f[1]), [3, 4]);
  await s.close();
}

// ---------------------------------------------------------------------------------------------
// DrunkDeer on 0x19F5: the captured relabel writes with the last chunk flagged; the others are read-only
// ---------------------------------------------------------------------------------------------
{
  const slots = Array.from({ length: 126 }, (_, i) => i);
  const board = new FakeBoard({ vendorId: 0x19f5, productId: 0xfb5c, productName: "DrunkDeer A75 Pro", units: { step: 100 }, layoutSlots: slots, profile: 1 });
  const { s } = await session(board, { allow: true });
  const v = s.view;
  assert.equal(v.info.brand, "DrunkDeer");
  assert.equal(v.analog.layout.source, "matrix");
  assert.equal(v.analog.keys.length, 126);
  assert.equal(v.options, undefined, "no function block for DrunkDeer");
  assert.equal(v.analog.perKey[5].actuationMm, 1.5);
  assert.equal(v.analog.fields.actuationMm.min, 0.2);
  const r = await s.apply({ kind: "analog", target: [4, 5, 40], values: { actuationMm: 1.38 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.area[160][1024 + 5 * 8 + 2], 137, "1.38 mm is stored as 137, as in svumo's capture");
  const w = board.writes.filter((x) => x.cmd === 161);
  assert.equal(w.length, 2, "records 4-5 and record 40 are two runs");
  assert.deepEqual(w.map((x) => x.flag), [0, 1], "the last chunk of the stream is flagged");
  assert.deepEqual(board.violations, []);
  await assert.rejects(() => s.apply({ kind: "option", id: "winLock", value: 1 }));
  await s.close();

  const other = new FakeBoard({ vendorId: 0x19f5, productId: 0xfb3e, productName: "DrunkDeer", units: { step: 100 }, layoutSlots: slots });
  const o = await session(other, { allow: true });
  assert.equal(o.s.view.analog.writable.length, 0);
  await assert.rejects(() => o.s.apply({ kind: "analog", target: [4], values: { actuationMm: 1 } }));
  assert.ok(other.sent.every((f) => [3, 4, 160].includes(f[1])), "reads only");
  await o.s.close();
}

// ---------------------------------------------------------------------------------------------
// A shared id (3837:3033) is read-only and has no layout; an upgrader is never opened
// ---------------------------------------------------------------------------------------------
{
  const slots = Array.from({ length: 80 }, (_, i) => i);
  const board = new FakeBoard({ vendorId: 0x3837, productId: 0x3033, productName: "MCHOSE", units: { step: 100 }, layoutSlots: slots });
  const { s } = await session(board, { allow: true });
  assert.equal(s.view.analog.layout.source, "matrix");
  assert.equal(s.view.analog.writable.length, 0);
  assert.match(s.view.info.model, /G75 V2/);
  assert.ok(s.view.options.every((o) => !o.writable), "the settings are shown, none of them writable");
  assert.equal(s.view.lighting, undefined, "no effect list for a shared id, so no lighting");
  await s.close();

  for (const [v, p] of [[0x19f5, 0xaf12], [0x19f5, 0x6f10], [0x19f5, 0xfe00]]) {
    const up = new FakeBoard({ vendorId: v, productId: p, productName: "Bootloader" });
    await assert.rejects(() => fw19f5KbDriver.open(up, { store: memoryKbStore(), live: false, devices: async () => [] }), /upgrader|not a keyboard id/);
    assert.equal(up.sent.length, 0, "nothing sent to an upgrader");
    assert.equal(fw19f5KbDriver.claims(up), false);
  }
}

// ---------------------------------------------------------------------------------------------
// Claims: one keyboard driver per id, and the typing collections are never claimed
// ---------------------------------------------------------------------------------------------
{
  const dev = (v, p, cols) => ({ vendorId: v, productId: p, productName: "", collections: cols, opened: false });
  const cfg = [{ usagePage: 1, usage: 0 }];
  const typing = [{ usagePage: 1, usage: 6 }, { usagePage: 0x0c, usage: 1 }];
  for (const [v, p] of F.FW_IDS) {
    const ids = (await driversFor(dev(v, p, [...typing, ...cfg]), CORE_DRIVERS)).map((d) => d.id);
    assert.deepEqual(ids, ["fw19f5"], `${v.toString(16)}:${p.toString(16)} is claimed by exactly one driver`);
    assert.deepEqual((await driversFor(dev(v, p, typing), CORE_DRIVERS)).map((d) => d.id), [], "no config collection, no claim");
  }
}

console.log("fw19f5 session sim: ok");
