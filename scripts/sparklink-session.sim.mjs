// Headless end-to-end check of src/lib/brands/sparklink (session + the generic Keyboard driver + KbSession)
// against simulated boards that answer the way the SparkLink SDK and the AureTrix driver use the protocol:
// 64-byte reports, [0x5C, len, class, checksum, data] in, [0x5C, len, class | 0x80, checksum, data] out.
// No hardware, no window: the fakes implement the HIDDevice shape the drivers use.
// Run: node scripts/sparklink-session.sim.mjs
import assert from "node:assert/strict";
import * as S from "../src/lib/brands/sparklink/index.ts";
import { sparklinkKbDriver } from "../src/lib/brands/sparklink/kb-driver.ts";
import { SimSparkLinkBoard } from "../src/lib/brands/sparklink/sim.ts";
import { KbSession, memoryKbStore } from "../src/lib/kb/session.ts";
import { genericKeyboard } from "../src/lib/feel/devices.ts";
import { driversFor, CORE_DRIVERS } from "../src/lib/kb/registry.ts";

/** A small 60%-like matrix: [HID value, row, col]. Esc 1 2 3 4 5 on row 1, Tab Q W E R T on row 2, Fn on row 5. */
const KEYS = [
  [41, 1, 0], [30, 1, 1], [31, 1, 2], [32, 1, 3], [33, 1, 4], [34, 1, 5],
  [43, 2, 0], [20, 2, 1], [26, 2, 2], [8, 2, 3], [21, 2, 4], [23, 2, 5],
  [57, 3, 0], [4, 3, 1], [22, 3, 2], [7, 3, 3], [9, 3, 4], [10, 3, 5],
  [225, 4, 0], [29, 4, 2], [27, 4, 3], [6, 4, 4], [25, 4, 5],
  [224, 5, 0], [227, 5, 1], [226, 5, 2], [44, 5, 6], [1, 5, 12],
].map(([key, row, col]) => ({ key, row, col }));
const W = KEYS.find((k) => k.key === 26);
const A = KEYS.find((k) => k.key === 4);
const D = KEYS.find((k) => k.key === 7);

async function session(board, { allow = false } = {}) {
  const store = memoryKbStore();
  const backend = await sparklinkKbDriver.open(board, { store, live: false, devices: async () => [] });
  const s = new KbSession(backend, store, board);
  if (allow) s.setAllowChanges(true);
  return { s, backend, store };
}
const writesOf = (board, cls) => board.writes.filter((w) => w[0] === cls);

// ---------------------------------------------------------------------------------------------
// RK M75HE (1CA2:1619): reads, the lock, confirmed writes, nothing else moves
// ---------------------------------------------------------------------------------------------
{
  const board = new SimSparkLinkBoard({ vendorId: 0x1ca2, productId: 0x1619, productName: "RK M75HE", keys: KEYS, advancedKey: D.key, name: "RK M75HE", winMode: true });
  const { s, backend, store } = await session(board);
  const v = s.view;
  assert.equal(v.info.brand, "Royal Kludge");
  assert.equal(v.info.model, "RK M75HE");
  assert.equal(v.info.driver, "sparklink");
  assert.ok(v.info.firmware[0].startsWith("Firmware APP_1.2.34"));
  assert.equal(v.info.serial, "SIMSN00000000001");
  assert.equal(v.tier, "read-only");
  assert.equal(v.writable.analog, false, "behind Allow changes");
  assert.equal(v.analog.scope, "both");
  assert.equal(v.analog.keys.length, KEYS.length);
  assert.equal(v.analog.layout.source, "matrix");
  assert.equal(v.analog.layout.keys.find((k) => k.label === "A")?.row, A.row);
  assert.equal(v.analog.layout.keys.find((k) => k.label === "Fn")?.col, 12);
  assert.equal(v.analog.unitSource, "device-query");
  assert.deepEqual([v.analog.fields.actuationMm.min, v.analog.fields.actuationMm.max, v.analog.fields.actuationMm.step], [0.1, 3.5, 0.01]);
  assert.equal(v.analog.global.actuationMm, 2, "the global travel");
  assert.equal(v.analog.global.deadTopMm, 0.2, "global dead zones come from the keys in global mode (the global message reports none)");
  assert.equal(v.analog.perKey[W.row * 21 + W.col].actuationMm, 2, "a global-mode key shows the default travel");
  assert.equal(v.analog.perKey[W.row * 21 + W.col].rapidTrigger, false);
  assert.deepEqual(v.options.map((o) => [o.id, o.value, o.writable]), [["systemMode", 0, true]]);
  assert.equal(v.polling.hz, 1000);
  assert.equal(v.profiles.active, 0);
  assert.ok(!v.writable.options);
  // Only reads went out, none to a key the board didn't report.
  const reads = board.sent.map((f) => S.parseRequest(f));
  assert.ok(reads.every((r) => [0, 1, 35, 41, 43].includes(r.cmd)));
  assert.ok(reads.filter((r) => r.cmd === 35).every((r) => r.data[0] === 0), "key reads only");
  assert.equal(board.writes.length, 0);
  // A change before allowing is refused and sends nothing.
  const before = board.sent.length;
  await assert.rejects(() => s.apply({ kind: "analog", target: "global", values: { actuationMm: 1.5 } }), /Read-only until you allow/);
  assert.equal(board.sent.length, before);

  s.setAllowChanges(true);
  // The default travel.
  let r = await s.apply({ kind: "analog", target: "global", values: { actuationMm: 1.5 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.globalUm, 1500);
  assert.equal(s.view.analog.global.actuationMm, 1.5);
  assert.equal(s.view.analog.perKey[W.row * 21 + W.col].actuationMm, 1.5, "a key in global mode follows");
  assert.equal(r.persistence, "unknown");
  // A key given its own actuation switches to single mode, keeps what it had when it only changes one thing.
  const wi = W.row * 21 + W.col;
  r = await s.apply({ kind: "analog", target: [wi], values: { actuationMm: 0.8 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.mem.get(W.key).mode, S.modeValue("single"));
  assert.equal(board.mem.get(W.key).db0, 800);
  assert.deepEqual(writesOf(board, 35).filter((w) => w[1] === W.key).map((w) => w[2]), [S.LAYOUT.db0, S.LAYOUT.mode], "travel first, the mode that turns it on last");
  assert.equal(s.view.analog.perKey[wi].actuationMm, 0.8);
  // Rapid trigger on that key and on a second one; values snap to the 0.01 mm step.
  const ai = A.row * 21 + A.col;
  r = await s.apply({ kind: "analog", target: [wi, ai], values: { rapidTrigger: true, rtPressMm: 0.15, rtReleaseMm: 0.2 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.mem.get(W.key).mode, S.modeValue("rt"));
  assert.equal(board.mem.get(W.key).rtp, 150);
  assert.equal(board.mem.get(A.key).rtr, 200);
  assert.equal(board.mem.get(A.key).db0, 1500, "a key joining rapid trigger from global mode keeps the travel it effectively had");
  assert.equal(s.view.analog.perKey[ai].rapidTrigger, true);
  assert.equal(s.view.analog.perKey[ai].rtPressMm, 0.15);
  // Rapid trigger off again: single mode, the travel stays.
  r = await s.apply({ kind: "analog", target: [wi], values: { rapidTrigger: false } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.mem.get(W.key).mode, S.modeValue("single"));
  assert.equal(board.mem.get(W.key).db0, 800);
  // Dead zones of one key.
  r = await s.apply({ kind: "analog", target: [wi], values: { deadTopMm: 0.3, deadBottomMm: 0.1 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.mem.get(W.key).dp, 300);
  assert.equal(board.mem.get(W.key).dr, 100);
  // The whole keyboard's dead zones go to the keys still in global mode, not the ones with their own mode.
  r = await s.apply({ kind: "analog", target: "global", values: { deadTopMm: 0.25 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.mem.get(41).dp, 250, "a global-mode key");
  assert.equal(board.mem.get(W.key).dp, 300, "a key with its own mode keeps its dead zone");
  // The advanced-keystroke key keeps its mode through a whole-keyboard rapid trigger, and is skipped everywhere.
  r = await s.apply({ kind: "analog", target: "global", values: { rapidTrigger: true, rtPressMm: 0.3, rtReleaseMm: 0.3 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.mem.get(D.key).mode, S.modeValue("single", 3), "dynamic keystroke untouched");
  assert.equal(board.mem.get(41).mode, S.modeValue("rt"));
  await assert.rejects(() => s.apply({ kind: "analog", target: [D.row * 21 + D.col], values: { actuationMm: 1 } }), /advanced mode/);
  // Out-of-range and unusable requests are refused before anything is sent.
  const sent = board.sent.length;
  await assert.rejects(() => s.apply({ kind: "analog", target: [wi], values: { actuationMm: 9 } }), /Actuation must be/);
  await assert.rejects(() => s.apply({ kind: "analog", target: [wi], values: { actuationMm: 0.05 } }), /Actuation must be/);
  await assert.rejects(() => s.apply({ kind: "analog", target: [9999], values: { actuationMm: 1 } }), /isn't a key/);
  await assert.rejects(() => s.apply({ kind: "analog", target: "global", values: { actuationMm: 1, rapidTrigger: true, rtPressMm: 0.3, rtReleaseMm: 0.3 } }), /separately/);
  assert.equal(board.sent.length, sent, "nothing went out");
  // The Windows / Mac switch exists on this board, behind Allow changes, and is unconfirmed-tier (not Kochi).
  r = await s.apply({ kind: "option", id: "systemMode", value: 1 });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.winMode, false);
  assert.equal(s.view.groupTier.options, "read-only");
  // Every write went to a layout SYNQ writes, nothing else, and no rule was broken.
  for (const w of board.writes.filter((x) => x[0] === 35)) assert.ok(S.WRITE_LAYOUTS.includes(w[2]), `layout ${w[2]}`);
  assert.deepEqual(board.violations, []);
  // The backup holds what was read before the first change; the log has every change.
  assert.equal(store.backups.length, 1);
  assert.ok(store.backups[0].json.includes("SIMSN00000000001"));
  assert.ok(store.lines.some((l) => l.includes("confirmed")));
  // Feel: the generic keyboard reads the same state.
  const feel = genericKeyboard(s.view);
  assert.ok(feel.target.actuation && feel.target.rapidTrigger && feel.target.rtSensitivity);
  assert.equal(feel.now.rapidTrigger, true);
  await backend.close();
}

// ---------------------------------------------------------------------------------------------
// A mechanical board on the same firmware: no travel range, no analog section, nothing to write
// ---------------------------------------------------------------------------------------------
{
  const board = new SimSparkLinkBoard({ vendorId: 0x1ca2, productId: 0x1604, productName: "RK-C98", keys: KEYS, hallEffect: false, winMode: null });
  const { s, backend } = await session(board, { allow: true });
  const v = s.view;
  assert.equal(v.info.brand, "Royal Kludge");
  assert.equal(v.analog, undefined);
  assert.ok(v.notes.some((n) => /travel range/.test(n)));
  assert.equal(v.options, undefined);
  await assert.rejects(() => s.apply({ kind: "analog", target: "global", values: { actuationMm: 1 } }), /can't be changed|didn't report|key travel/i);
  assert.equal(board.writes.length, 0);
  await backend.close();
}

// ---------------------------------------------------------------------------------------------
// Kochi Hummingbird 68 (1CA2:0901): its name checks out, the mode switch is driver-tested
// ---------------------------------------------------------------------------------------------
{
  const board = new SimSparkLinkBoard({ vendorId: 0x1ca2, productId: 0x0901, productName: "HB68", keys: KEYS, hallEffect: false, name: "KOCHI68", winMode: true });
  const { s, backend } = await session(board);
  const v = s.view;
  assert.equal(v.info.brand, "Kochi");
  assert.equal(v.info.model, "Hummingbird 68");
  assert.equal(v.groupTier.options, "driver-tested");
  assert.equal(v.groupTier.analog, "read-only");
  assert.equal(v.writable.options, true);
  const r = await s.apply({ kind: "option", id: "systemMode", value: 1 });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.winMode, false);
  assert.deepEqual(board.violations, []);
  await backend.close();
  // A Kochi id whose board names itself otherwise gets no tested tier.
  const odd = new SimSparkLinkBoard({ vendorId: 0x1ca2, productId: 0x0901, productName: "HB68", keys: KEYS, hallEffect: false, name: "SOMETHING", winMode: true });
  const o = await session(odd);
  assert.equal(o.s.view.groupTier.options, "read-only");
  await o.backend.close();
}

// ---------------------------------------------------------------------------------------------
// A board in its bootloader, a board that doesn't answer, an id nobody owns
// ---------------------------------------------------------------------------------------------
{
  const boot = new SimSparkLinkBoard({ vendorId: 0x1ca2, productId: 0x1605, productName: "RK C68", keys: KEYS, bootloader: true });
  await assert.rejects(() => sparklinkKbDriver.open(boot, { store: memoryKbStore(), live: false, devices: async () => [] }), /boot/i);
  assert.equal(boot.sent.length, 1, "only the board-info read went out");
  assert.equal(await sparklinkKbDriver.ping(boot), false);

  const mute = new SimSparkLinkBoard({ vendorId: 0x1ca5, productId: 0x0401, productName: "AULA", keys: KEYS, answer: false });
  const backend = await sparklinkKbDriver.open(mute, { store: memoryKbStore(), live: false, devices: async () => [] });
  assert.equal(backend.state.analog, undefined);
  assert.ok(backend.state.notes.some((n) => /didn't answer/.test(n)));
  assert.ok(mute.sent.length >= 1 && mute.sent.every((f) => S.parseRequest(f).cmd === S.CMD.sync), "only the board-info read, retried");
  await backend.close();

  const stranger = new SimSparkLinkBoard({ vendorId: 0x1ca6, productId: 0x3001, productName: "Wuque", keys: KEYS });
  assert.equal(sparklinkKbDriver.claims(stranger), false);
  await assert.rejects(() => S.SparkLinkSession.connect(stranger), /not a SparkLink keyboard id/);
  // The right ids on the wrong collection.
  const wrong = new SimSparkLinkBoard({ vendorId: 0x1ca2, productId: 0x1604, productName: "RK", keys: KEYS });
  wrong.collections.splice(0, 2, { usagePage: 1, usage: 6 });
  assert.equal(sparklinkKbDriver.claims(wrong), false);
  assert.equal(wrong.sent.length, 0);
}

// ---------------------------------------------------------------------------------------------
// Registry: one driver claims each id (Kochi included, OpenMouse's keyboard driver yields)
// ---------------------------------------------------------------------------------------------
{
  const dev = (vendorId, productId) => ({ vendorId, productId, productName: "", collections: [{ usagePage: 1, usage: 6 }, { usagePage: 0xffa0, usage: 1 }], opened: false });
  for (const [v, p] of S.SPARKLINK_IDS) {
    const ids = (await driversFor(dev(v, p), CORE_DRIVERS)).map((d) => d.id);
    assert.deepEqual(ids, ["sparklink"], `${v.toString(16)}:${p.toString(16)} -> ${ids}`);
  }
}

console.log("sparklink session sim: ok");
