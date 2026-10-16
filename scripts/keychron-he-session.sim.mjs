// Headless end-to-end check of the Keychron Hall-effect layer of the VIA backend (src/lib/kb/via/keychron/capability.ts
// inside ViaBackend, the second guard tier in ViaTransport, KbSession) against a simulated keyboard that answers the way
// keychron_raw_hid.c and analog_matrix.c do. No hardware, no window: the fake implements the HIDDevice shape the drivers use.
// Run: node scripts/keychron-he-session.sim.mjs
import assert from "node:assert/strict";
import { viaDriver } from "../src/lib/kb/via/driver.ts";
import { SimKeychronHe } from "../src/lib/kb/via/keychron/sim.ts";
import { KC_MODELS, keychronModel } from "../src/lib/kb/via/keychron/devices.ts";
import { AKM } from "../src/lib/kb/via/keychron/protocol.ts";
import { KbSession, memoryKbStore } from "../src/lib/kb/session.ts";
import { genericKeyboard } from "../src/lib/feel/devices.ts";
import { driversFor, CORE_DRIVERS } from "../src/lib/kb/registry.ts";
import { SimViaKeyboard } from "../src/lib/kb/via/sim.ts";

const q1 = keychronModel(0x3434, 0x0b10);
const idx = (row, col) => row * q1.cols + col;

async function session(board, { allow = false } = {}) {
  const store = memoryKbStore();
  const ctx = { store, live: false, devices: async () => [], definitions: { get: async () => null, problem: () => null } };
  const backend = await viaDriver.open(board, ctx);
  const s = new KbSession(backend, store, board);
  if (allow) s.setAllowChanges(true);
  return { s, backend, store };
}

// ---------------------------------------------------------------------------------------------
// A Keychron Q1 HE (ANSI): reads, the lock, confirmed writes saved to EEPROM, nothing else moves
// ---------------------------------------------------------------------------------------------
{
  const board = new SimKeychronHe({ model: q1, advancedKey: idx(1, 3) });
  // Profile 0: key (0,1) has its own actuation, key (0,2) is in rapid trigger, the rest follow the profile.
  board.setKeyConfig(idx(0, 1), { mode: AKM.global, act: 12, sens: 0, rls: 0, adv: 0, advData: 0 });
  board.setKeyConfig(idx(0, 2), { mode: AKM.rapid, act: 8, sens: 2, rls: 5, adv: 0, advData: 0 });
  const { s, backend, store } = await session(board);
  const v = s.view;
  assert.equal(v.info.brand, "Keychron");
  assert.equal(v.info.model, "Q1 HE (ANSI)");
  assert.equal(v.info.driver, "via");
  assert.ok(v.info.protocol.includes("Keychron analog v4"));
  assert.ok(v.info.firmware.some((f) => f.includes("Keychron firmware v1.2.3")));
  assert.equal(v.tier, "read-only");
  assert.equal(v.writable.analog, false, "behind Allow changes");
  assert.equal(v.analog.scope, "both");
  assert.equal(v.analog.layout.source, "driver", "the layout is the firmware's own: usevia.app has no Q1 HE");
  assert.equal(v.analog.layout.keys.length, 82);
  assert.equal(v.analog.keys.length, 82);
  assert.equal(v.analog.unitSource, "manifest");
  assert.deepEqual([v.analog.fields.actuationMm.min, v.analog.fields.actuationMm.max, v.analog.fields.actuationMm.step], [0.1, 3.9, 0.1]);
  assert.deepEqual(v.analog.global, { actuationMm: 2, rapidTrigger: false, rtPressMm: 0.4, rtReleaseMm: 0.4 });
  assert.equal(v.analog.perKey[idx(0, 0)].actuationMm, 2, "a key that follows the profile");
  assert.equal(v.analog.perKey[idx(0, 1)].actuationMm, 1.2);
  assert.equal(v.analog.perKey[idx(0, 2)].rapidTrigger, true);
  assert.equal(v.analog.perKey[idx(0, 2)].rtPressMm, 0.2);
  assert.equal(v.analog.perKey[idx(0, 2)].rtReleaseMm, 0.5);
  assert.ok(v.analog.note.includes("Profile 1 of 3 (Profile 1)"));
  assert.ok(v.blocked.some((b) => /wireless firmware update/.test(b.what)), "Keychron's blocks are listed beside VIA's");
  assert.ok(v.blocked.some((b) => /Bootloader jump/.test(b.what)));
  // Reads only so far: VIA basics and the Keychron queries, no write, no other profile.
  const first = (f) => [f[0], f[1]];
  assert.ok(board.received.some((f) => f[0] === 0xa2));
  assert.deepEqual(board.sets, []);
  assert.equal(board.saves, 0);
  assert.ok(board.received.filter((f) => f[0] === 0xa9 && f[1] === 0x12).every((f) => f[2] === 0), "only the active profile is read");
  assert.deepEqual(board.forbidden, []);
  // A change before allowing is refused and sends nothing.
  const before = board.received.length;
  await assert.rejects(() => s.apply({ kind: "analog", target: "global", values: { actuationMm: 1.5 } }), /Read-only until you allow/);
  assert.equal(board.received.length, before);

  s.setAllowChanges(true);
  // The profile's own defaults: actuation 1.5 mm. Saved to EEPROM; keys that follow it follow.
  let r = await s.apply({ kind: "analog", target: "global", values: { actuationMm: 1.5 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(r.persistence, "saved");
  assert.deepEqual(board.sets.at(-1), [0, 1, 15, 4, 0, 1], "profile 0, regular, 1.5 mm, release kept at 'follow press', entire");
  assert.equal(board.saves, 1);
  assert.equal(board.globalConfig().act, 15);
  assert.equal(board.keyConfig(idx(0, 0)).act, 0, "a key that follows the profile still follows it");
  assert.equal(s.view.analog.perKey[idx(0, 0)].actuationMm, 1.5);
  assert.equal(s.view.analog.perKey[idx(0, 1)].actuationMm, 1.2, "a key with its own value keeps it");
  // A press-only change on the defaults keeps the release distance where it was (it followed the press distance, 0.4).
  r = await s.apply({ kind: "analog", target: "global", values: { rtPressMm: 0.3 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.deepEqual(board.sets.at(-1), [0, 1, 15, 3, 4, 1], "release pinned at 4 (0.4 mm)");
  assert.equal(s.view.analog.global.rtReleaseMm, 0.4);
  // Two keys get rapid trigger together: one message, a mask with both bits, then a save. Values keep a key's other fields.
  const a = idx(2, 4);
  const b = idx(3, 5);
  const setsBefore = board.sets.length;
  r = await s.apply({ kind: "analog", target: [a, b], values: { rapidTrigger: true, rtPressMm: 0.1, rtReleaseMm: 0.2 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.sets.length, setsBefore + 1, "identical results share one message");
  assert.deepEqual(board.sets.at(-1), [0, 2, 0, 1, 2, 0]);
  assert.equal(board.keyConfig(a).mode, AKM.rapid);
  assert.equal(board.keyConfig(a).act, 0, "actuation kept as 'follow the profile'");
  assert.equal(board.keyConfig(b).sens, 1);
  assert.deepEqual(board.eeprom[0], board.ram[0], "the EEPROM copy is what the keyboard holds");
  // Different keys with different results: one message per result.
  const own = idx(0, 1);
  r = await s.apply({ kind: "analog", target: [own, a], values: { actuationMm: 0.9 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.keyConfig(own).act, 9);
  assert.equal(board.keyConfig(a).act, 9);
  assert.equal(board.keyConfig(a).mode, AKM.rapid, "rapid trigger kept");
  assert.equal(board.keyConfig(own).mode, AKM.global, "a key that follows the profile's mode keeps doing so");
  // Rapid trigger off on a key sets regular explicitly.
  r = await s.apply({ kind: "analog", target: [a], values: { rapidTrigger: false } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.keyConfig(a).mode, AKM.regular);
  // The profile itself to rapid trigger: keys that follow the mode follow.
  r = await s.apply({ kind: "analog", target: "global", values: { rapidTrigger: true } });
  assert.equal(r.verdict, "confirmed", r.detail);
  assert.equal(board.globalConfig().mode, AKM.rapid);
  assert.equal(s.view.analog.perKey[idx(0, 0)].rapidTrigger, true);
  assert.equal(s.view.analog.perKey[a].rapidTrigger, false, "a key set to regular stays regular");
  // The dynamic-keystroke key is untouched by a whole-keyboard change and refused on its own.
  const dks = idx(1, 3);
  assert.equal(board.keyConfig(dks).adv, 2);
  await assert.rejects(() => s.apply({ kind: "analog", target: [dks], values: { actuationMm: 1 } }), /advanced mode/);
  assert.equal(board.keyConfig(dks).adv, 2);
  // Out-of-range and unusable requests are refused before anything is sent.
  const sent = board.received.length;
  await assert.rejects(() => s.apply({ kind: "analog", target: [a], values: { actuationMm: 4 } }), /Actuation must be 0.1 to 3.9 mm/);
  await assert.rejects(() => s.apply({ kind: "analog", target: [a], values: { actuationMm: 0 } }), /Actuation must be/);
  await assert.rejects(() => s.apply({ kind: "analog", target: [999], values: { actuationMm: 1 } }), /isn't a key/);
  await assert.rejects(() => s.apply({ kind: "analog", target: [a], values: { deadTopMm: 0.2 } }), /no such setting/);
  assert.equal(board.received.length, sent, "nothing went out");
  // Nothing forbidden ever arrived; every Keychron write was a set or a save of the active profile.
  assert.deepEqual(board.forbidden, []);
  for (const f of board.received) if (f[0] === 0xa9 && (f[1] === 0x14 || f[1] === 0x1f)) assert.equal(f[2], 0, "the active profile");
  // The backup holds what was read before the first change.
  assert.equal(store.backups.length, 1);
  assert.ok(store.backups[0].json.includes("analogVersion"));
  assert.ok(store.lines.some((l) => l.includes("confirmed")));
  // Feel sees the analog section of this keyboard like any other.
  const feel = genericKeyboard(s.view);
  assert.ok(feel.target.actuation && feel.target.rapidTrigger && feel.target.rtSensitivity);
  await backend.close();
}

// ---------------------------------------------------------------------------------------------
// Variants: other families, an older analog protocol, a board without the analog bit, a plain Keychron
// ---------------------------------------------------------------------------------------------
{
  // Lemokey P1 HE (ISO) is its own model.
  const p1 = keychronModel(0x362d, 0x0611);
  const { s, backend } = await session(new SimKeychronHe({ model: p1 }));
  assert.equal(s.view.info.brand, "Lemokey");
  assert.equal(s.view.info.model, "P1 HE (ISO)");
  assert.equal(s.view.analog.layout.keys.length, 83);
  await backend.close();

  // An analog protocol this code doesn't know: shown as VIA, no analog section, no write.
  const old = new SimKeychronHe({ model: q1, analogVersion: 3 });
  const o = await session(old, { allow: true });
  assert.equal(o.s.view.analog, undefined);
  assert.ok(o.s.view.notes.some((n) => /version 3/.test(n)));
  assert.deepEqual(old.sets, []);
  await o.backend.close();

  // No analog bit in the feature mask.
  const plainFw = new SimKeychronHe({ model: q1, analog: false });
  const p = await session(plainFw, { allow: true });
  assert.equal(p.s.view.analog, undefined);
  assert.equal(plainFw.received.filter((f) => f[0] === 0xa9).length, 0, "no 0xA9 command to a board without the bit");
  await p.backend.close();

  // A profile that doesn't fit the matrix SYNQ knows: nothing is written.
  const wrong = new SimKeychronHe({ model: { ...q1, rows: 6, cols: 16 } });
  Object.defineProperty(wrong, "model", { value: q1 });
  const w = await session(wrong, { allow: true });
  assert.equal(w.s.view.analog, undefined, "a 6 x 16 profile on a 6 x 15 board");
  assert.ok(w.s.view.notes.some((n) => /doesn't match/.test(n)));
  assert.deepEqual(wrong.sets, []);
  await w.backend.close();

  // A Keychron board that is not in the Hall-effect table (a V1) is plain VIA: no Keychron command at all.
  const plainVia = new SimViaKeyboard({ vendorId: 0x3434, productId: 0x0281, productName: "Keychron V1" });
  const v1 = await session(plainVia);
  assert.equal(v1.s.view.analog, undefined);
  assert.equal(v1.s.view.info.brand, "VIA");
  assert.ok(plainVia.received.every((f) => f[0] < 0xa0 || f[0] === 0xfe), "VIA commands only (0xFE is Vial's prefix, asked once)");
  await v1.backend.close();
}

// ---------------------------------------------------------------------------------------------
// Registry: VIA claims every Hall-effect id on its raw-HID collection
// ---------------------------------------------------------------------------------------------
{
  const dev = (vendorId, productId) => ({ vendorId, productId, productName: "", collections: [{ usagePage: 1, usage: 6 }, { usagePage: 0xff60, usage: 0x61 }], opened: false });
  for (const m of KC_MODELS) {
    const ids = (await driversFor(dev(m.vendorId, m.productId), CORE_DRIVERS)).map((d) => d.id);
    assert.equal(ids[0], "via", `${m.name} ${m.variant}: ${ids}`);
  }
}

console.log("keychron he session sim: ok");
