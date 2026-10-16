// VIA / Vial Advanced actions (keys beyond the basic ones, macros, keymap + macro reset) against a
// simulated keyboard (src/lib/kb/via/sim.ts), through the real backend, transport and guard:
//   node --test scripts/advanced-via.test.ts
//
//  (a) the extra commands are refused without the confirmation token, and a token opens only its own;
//  (b) the bootloader jump, EEPROM reset, bulk keymap write and every boot / reboot / EEPROM-clear keycode
//      stay unreachable with every token held, in both keycode encodings;
//  (c) a backup is saved before the first changing frame of every flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvancedGate, type AdvancedScope, type KeycodeScheme } from "../src/lib/advanced/core.ts";
import { checkViaFrame } from "../src/lib/kb/via/guard.ts";
import { ADVANCED_KEYCODES, NEVER_KEYCODES, advancedKeycodeOk, layerKeycodes, macroKeycode } from "../src/lib/kb/via/keycode-safety.ts";
import { macroToText, splitMacros, textToMacro } from "../src/lib/kb/via/macro-codec.ts";
import { KbSession, memoryKbStore } from "../src/lib/kb/session.ts";
import { SAMPLE_COLS, SimViaKeyboard } from "../src/lib/kb/via/sim.ts";
import { ViaBackend } from "../src/lib/kb/via/backend.ts";
import { sampleCompiledDefinition } from "../src/lib/kb/via/sim.ts";

const ok = { acknowledged: true };
const RESET = { acknowledged: true, typed: "RESET" };
const frame = (...bytes: number[]) => {
  const f = new Uint8Array(32);
  f.set(bytes);
  return f;
};
async function gateWith(scopes: AdvancedScope[], scheme?: KeycodeScheme) {
  const g = new AdvancedGate("t");
  for (const s of scopes) await g.grant(s, RESET, { scheme });
  return g;
}
const SCOPES: AdvancedScope[] = ["pair", "remap", "macros", "calibrate", "reset"];

// ---------------------------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------------------------

test("(a) extra VIA commands are refused without their token, and each token opens only its own", async () => {
  const cases: [string, Uint8Array, AdvancedScope][] = [
    ["MO(1)", frame(0x05, 0, 1, 1, 0x52, 0x21), "remap"],
    ["a macro key", frame(0x05, 0, 1, 1, 0x77, 0x02), "remap"],
    ["a mod-tap", frame(0x05, 0, 1, 1, 0x22, 0x04), "remap"],
    ["keymap reset", frame(0x06), "reset"],
    ["macro reset", frame(0x10), "reset"],
    ["macro write", frame(0x0f, 0, 0, 3, 0x41, 0x42, 0x43), "macros"],
  ];
  for (const [what, f, scope] of cases) {
    assert.equal(checkViaFrame(f).ok, false, `${what} without a gate`);
    assert.equal(checkViaFrame(f, await gateWith([])).ok, false, `${what} with an empty gate`);
    assert.equal(checkViaFrame(f, { has: () => true, scheme: "current" }).ok, false, `${what} with a lookalike`);
    assert.equal(checkViaFrame(f, await gateWith([scope], "current")).ok, true, `${what} with ${scope}`);
    for (const other of SCOPES.filter((s) => s !== scope)) assert.equal(checkViaFrame(f, await gateWith([other], "current")).ok, false, `${what} must not open with only ${other}`);
  }
  assert.equal(checkViaFrame(frame(0x05, 0, 1, 1, 0x52, 0x21), await gateWith(["remap"])).ok, false, "a remap token without a keycode scheme writes basic keys only");
});

test("(b) bootloader, EEPROM reset, bulk write and boot keys stay unreachable with every token", async () => {
  for (const scheme of ["current", "legacy"] as const) {
    const all = await gateWith(SCOPES, scheme);
    const never: [string, Uint8Array][] = [
      ["bootloader jump", frame(0x0b)],
      ["EEPROM reset", frame(0x0a)],
      ["bulk keymap write", frame(0x13, 0, 0, 4, 1, 2, 3, 4)],
      ["setting keyboard values", frame(0x03, 1, 0, 0, 0, 1)],
      ["encoder write", frame(0x15, 0, 0, 0, 0, 4)],
      ["switch-matrix read", frame(0x02, 0x03)],
      ["Vial unlock", frame(0xfe, 0x06)],
      ["Vial lock", frame(0xfe, 0x08)],
      ["Vial settings write", frame(0xfe, 0x0b)],
      ["Vial settings reset", frame(0xfe, 0x0c)],
      ["Vial dynamic entry", frame(0xfe, 0x0d)],
    ];
    for (const [what, f] of never) assert.equal(checkViaFrame(f, all).ok, false, `${what} (${scheme})`);
    for (const code of [0x7c00, 0x7c01, 0x7c02, 0x7c03, 0x7c04, 0x7c10, 0x7c73, 0x5c00, 0x5c01, 0x5c02, 0x5c03, 0x5c10, 0x5c2f, 0x7e00, 0x7e40, 0x7fff, 0x8000, 0xffff]) {
      assert.equal(checkViaFrame(frame(0x05, 0, 1, 1, code >> 8, code & 0xff), all).ok, false, `keycode 0x${code.toString(16)} (${scheme})`);
      assert.equal(advancedKeycodeOk(code, scheme), false);
    }
    for (let c = 0; c < 256; c++) {
      const v = checkViaFrame(frame(c, 0, 0, 0, 0, 0), all);
      if (v.ok) assert.ok(/^(get|vial|set|save|dynamic keymap reset|macro reset)/.test(v.what), `0x${c.toString(16)} -> ${v.what}`);
    }
  }
});

test("the keycode allowlist: every allowed range is safe, no never-range overlaps one, in both encodings", () => {
  for (const scheme of ["current", "legacy"] as const) {
    for (const [a, b, what] of ADVANCED_KEYCODES[scheme]) {
      for (const [na, nb] of NEVER_KEYCODES) assert.ok(b < na || a > nb, `${scheme}: ${what} 0x${a.toString(16)}-0x${b.toString(16)} touches a never-range`);
      for (const c of [a, a + 1, b - 1, b]) assert.ok(advancedKeycodeOk(c, scheme), `${scheme} 0x${c.toString(16)}`);
    }
    // basic keys always, and edges just outside the lists are not
    assert.ok(advancedKeycodeOk(0x00ff, scheme));
    assert.ok(!advancedKeycodeOk(0x10000, scheme));
    assert.ok(!advancedKeycodeOk(-1, scheme));
    assert.ok(!advancedKeycodeOk(1.5, scheme));
    for (const c of [0x5700, 0x5600, 0x7000, 0x7100, 0x7480, 0x7800, 0x7a00]) assert.ok(!advancedKeycodeOk(c, scheme) || scheme === "legacy", `0x${c.toString(16)} (${scheme})`);
  }
  // layer and macro keys are in their own encoding
  for (const scheme of ["current", "legacy"] as const) {
    const k = layerKeycodes(3, scheme);
    for (const code of [k.to, k.mo, k.df, k.tg, k.osl, k.tt, macroKeycode(5, scheme)]) assert.ok(advancedKeycodeOk(code, scheme), `${scheme} 0x${code.toString(16)}`);
  }
  assert.ok(!advancedKeycodeOk(0x5c00, "legacy") && !advancedKeycodeOk(0x7c00, "legacy"), "legacy RESET and the current QK_BOOT are both refused in the legacy table");
  assert.ok(!advancedKeycodeOk(0x5c00, "current") && !advancedKeycodeOk(0x7c00, "current"));
});

// ---------------------------------------------------------------------------------------------
// Macro text
// ---------------------------------------------------------------------------------------------

test("macros: text, key taps and waits round-trip, and anything else is left alone", () => {
  const e = textToMacro("hello {Enter}{down Shift}a{up Shift}{wait 250}{F5}{lbrace}x{rbrace}");
  assert.ok(e.ok);
  assert.equal(macroToText(e.ok ? e.bytes : []), "hello {Enter}{down Shift}A{up Shift}".replace("A", "a") + "{wait 250}{F5}{lbrace}x{rbrace}");
  assert.deepEqual(textToMacro("gg").ok && textToMacro("gg").bytes, [0x67, 0x67]);
  assert.deepEqual(textToMacro("{tap A}").ok && textToMacro("{tap A}").bytes, [1, 1, 0x04]);
  assert.deepEqual(textToMacro("{wait 5}").ok && textToMacro("{wait 5}").bytes, [1, 4, 0x35, 0x7c]);
  for (const bad of ["{nope}", "{wait 0}", "{wait 100000}", "{unclosed", "}", "tab\there", "naïve"]) assert.equal(textToMacro(bad).ok, false, bad);
  // actions this codec doesn't write: shown as unshowable, never edited
  assert.equal(macroToText([1, 5, 0x00, 0x7c]), null, "a 16-bit key action");
  assert.equal(macroToText([1, 1]), null);
  assert.equal(macroToText([0x03]), null);
  assert.deepEqual(splitMacros([0x41, 0, 0x42, 0x43, 0, 0, 0], 4), [[0x41], [0x42, 0x43], [], []]);
});

// ---------------------------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------------------------

async function rig(opts: { vial?: boolean; protocol?: number; macroBytes?: number } = {}) {
  const sim = new SimViaKeyboard({ vendorId: 0x4f42, productId: 0x5641, productName: "Sample", delayMs: 0, macroBytes: opts.macroBytes ?? 128, macroCount: 4, ...opts });
  const store = memoryKbStore();
  const events: string[] = [];
  const save = store.saveBackup.bind(store);
  store.saveBackup = async (prefix, json) => (events.push(`backup:${prefix}`), save(prefix, json));
  const orig = sim.sendReport.bind(sim);
  sim.sendReport = async (id: number, data: BufferSource) => {
    const f = new Uint8Array(data as ArrayBuffer);
    if (f[0] === 0x06) events.push("frame:keymap-reset");
    if (f[0] === 0x10) events.push("frame:macro-reset");
    if (f[0] === 0x0f) events.push("frame:macro-write");
    if (f[0] === 0x05 && ((f[4] << 8) | f[5]) > 0xff) events.push("frame:key-advanced");
    return orig(id, data);
  };
  const definitions = { get: async (version: string) => (version === "v3" || opts.protocol === 11 ? { json: sampleCompiledDefinition(0x4f42, 0x5641), origin: "cache" as const } : null) };
  const backend = await ViaBackend.open(sim as unknown as HIDDevice, { store, definitions: definitions as never });
  const session = new KbSession(backend, store, sim);
  session.setAllowChanges(true);
  return { sim, store, events, backend, session };
}

test("the card lists what a VIA board can do, with sources, and why the rest is hidden", async () => {
  const { session } = await rig();
  const a = session.advanced;
  for (const s of ["remap", "macros", "reset"] as const) {
    assert.ok(a.features[s].available, s);
    assert.match(a.features[s].source, /VIA protocol/);
  }
  for (const s of ["pair", "calibrate"] as const) {
    assert.ok(!a.features[s].available && a.features[s].why, s);
  }
  assert.ok(a.keymap && a.macros && a.reset);
  assert.equal(a.pair, undefined);
  assert.equal(a.calibrate, undefined);
  assert.equal(a.firmware.updater?.url, "https://qmk.fm/toolbox");
  assert.equal(a.firmware.latest, null);
});

test("Advanced stays shut while the keyboard is read-only, and opens with Allow changes", async () => {
  const { session, sim } = await rig();
  session.setAllowChanges(false);
  const a = session.advanced;
  await assert.rejects(a.keymap!.begin(ok), /Read-only until you allow changes/);
  await assert.rejects(a.macros!.begin(ok), /Read-only/);
  await assert.rejects(a.reset!.reset(RESET), /Read-only/);
  assert.equal(sim.advancedFrames.length + sim.forbidden.length, 0);
  session.setAllowChanges(true);
  await a.keymap!.begin(ok);
  await a.keymap!.end();
});

test("(c) keys: read, back up, then take the token; every write is read back; Undo all puts the keys back", async () => {
  const { session, sim, events } = await rig();
  const k = session.advanced.keymap!;
  await assert.rejects(k.begin({ acknowledged: false }), /confirmation/);
  assert.equal(sim.received.length > 0 && events.length, 0, "an unconfirmed start saves and sends nothing");
  const before = sim.keymap.map((l) => [...l]);
  sim.allowAdvanced = true;
  const state = await k.begin(ok);
  assert.match(events[0], /^backup:kb-via-.*-keys$/, "the backup comes first");
  assert.equal(sim.advancedFrames.length, 0, "nothing changed yet");
  assert.match(state.backupPath ?? "", /kb-via-.*-keys/);
  assert.ok(state.choices.some((c) => c.group === "Layers" && /Hold layer 1/.test(c.label)));
  assert.ok(state.choices.some((c) => c.group === "Macros" && c.label === "Macro 0"));
  assert.ok(!state.choices.some((c) => c.code === 0x7c00 || c.code === 0x7c03), "no boot or EEPROM-clear key is ever offered");

  const caps = 2 * SAMPLE_COLS; // Caps Lock on layer 0
  const mo1 = layerKeycodes(1, "current").mo;
  const s1 = await k.set(0, caps, mo1);
  assert.equal(s1.codes[0][caps], mo1);
  assert.deepEqual(s1.changed[0], [caps]);
  assert.equal(sim.keymap[0][caps], mo1);
  assert.ok(events.findIndex((e) => /^backup:/.test(e)) < events.indexOf("frame:key-advanced"));
  // a macro key, and a plain key
  const m0 = macroKeycode(0, "current");
  await k.set(0, caps + 1, m0);
  await k.set(0, caps + 2, 0x04);
  assert.deepEqual(sim.keymap[0].slice(caps, caps + 3), [mo1, m0, 0x04]);

  // refusals: the sim never sees them
  const sent = sim.received.length;
  await assert.rejects(k.set(0, caps, 0x7c00), /never puts it on a key|never writes|bootloader/i);
  await assert.rejects(k.set(0, caps, 0x7c03), /EEPROM|never/i);
  await assert.rejects(k.set(0, caps, 0x5c00), /never/i);
  await assert.rejects(k.set(0, caps, 0x7e00), /never|custom|keyboard-specific/i);
  await assert.rejects(k.set(0, caps, 0x5700), /doesn't put that kind/);
  await assert.rejects(k.set(0, caps, macroKeycode(9, "current")), /has 4 macros/);
  await assert.rejects(k.set(9, caps, 0x04), /layers 0 to 3/);
  await assert.rejects(k.set(0, 9999, 0x04), /isn't on this keyboard/);
  // the Fn layer's boot key is left alone: it couldn't be put back
  await assert.rejects(k.set(1, 14, 0x04), /holds a special key/);
  assert.equal(sim.received.length, sent, "none of those reached the keyboard");

  const undone = await k.undoAll();
  assert.deepEqual(sim.keymap, before);
  assert.ok(undone.changed.every((c) => c.length === 0));
  await k.end();
  assert.deepEqual(session.advanced.gate.live, []);
  await assert.rejects(k.set(0, caps, 0x04), /Start key changes first/);
  assert.equal(sim.forbidden.length, 0, "nothing forbidden ever arrived");
  assert.ok(sim.advancedFrames.every((f) => f[0] === 0x05), "only key writes");
});

test("keys: a keyboard keeps a way back (typing keys on layer 0, a return from every layer you can enter)", async () => {
  const { session, sim } = await rig();
  sim.allowAdvanced = true;
  const k = session.advanced.keymap!;
  await k.begin(ok);
  // strip layer 0 of typing keys until the rule says stop
  let refused = "";
  const typingKeys = sim.keymap[0].map((c, i) => [c, i]).filter(([c]) => c >= 0x04 && c <= 0x2c).map(([, i]) => i);
  for (const i of typingKeys) {
    try {
      await k.set(0, i, 0x00);
    } catch (e) {
      refused = String(e);
      break;
    }
  }
  assert.match(refused, /at least 8 typing keys/);
  const typable = sim.keymap[0].filter((c) => c >= 0x04 && c <= 0x2c).length;
  assert.ok(typable >= 8, `${typable} typing keys remain`);

  // TO(2) leads to a layer with nothing to return
  const key = 4 * SAMPLE_COLS + 12;
  const to2 = layerKeycodes(2, "current").to;
  await assert.rejects(k.set(0, key, to2), /Layer 2 would have no key that goes back/);
  await k.set(2, 3, layerKeycodes(0, "current").to); // a "go to layer 0" key on layer 2
  await k.set(0, key, to2); // now fine
  assert.equal(sim.keymap[0][key], to2);
  assert.equal(k.problem(0, key, 0x05), null);
  await k.undoAll();
  await k.end();
  assert.equal(sim.forbidden.length, 0);
});

test("(c) macros: backup first, other macros kept byte for byte, size limit, Undo all", async () => {
  const { session, sim, events } = await rig({ macroBytes: 40 });
  const mac = session.advanced.macros!;
  const original = [...sim.macros.buffer];
  sim.allowAdvanced = true;
  await assert.rejects(mac.begin({ acknowledged: false }), /confirmation/);
  const s = await mac.begin(ok);
  assert.match(events[0], /^backup:kb-via-.*-macros$/);
  assert.equal(sim.advancedFrames.length, 0);
  assert.deepEqual(s.slots.map((x) => [x.index, x.text, x.editable]), [[0, "gg wp", true], [1, "{A}{B}", true], [2, "", true], [3, "", true]]);
  assert.equal(s.capacity, 40);
  assert.equal(mac.check("hi{Enter}").error, null);
  assert.equal(mac.check("hi{Enter}").bytes, 5);
  assert.match(mac.check("{what}").error ?? "", /isn't a key name/);

  const saved = await mac.save(2, "hello{Enter}{wait 100}");
  assert.equal(saved.slots[2].text, "hello{Enter}{wait 100}");
  assert.equal(saved.slots[0].text, "gg wp");
  assert.equal(saved.slots[1].text, "{A}{B}");
  // the first two macros are exactly the bytes they were
  assert.deepEqual(sim.macros.buffer.slice(0, 13), original.slice(0, 13));
  assert.ok(events.findIndex((e) => /^backup:/.test(e)) < events.indexOf("frame:macro-write"));
  // too long
  await assert.rejects(mac.save(3, "x".repeat(60)), /doesn't fit/);
  await assert.rejects(mac.save(7, "x"), /macros 0 to 3/);
  await assert.rejects(mac.save(3, "{lol}"), /isn't a key name/);
  // Undo all
  await mac.undoAll();
  assert.deepEqual(sim.macros.buffer.slice(0, original.length), original);
  assert.ok(sim.macros.buffer.slice(original.length).every((b) => b === 0));
  await mac.end();
  assert.deepEqual(session.advanced.gate.live, []);
  assert.equal(sim.forbidden.length, 0);
  assert.ok(sim.advancedFrames.every((f) => f[0] === 0x0f), "only macro writes");
});

test("macros: one holding actions SYNQ can't show is never touched", async () => {
  const { session, sim } = await rig();
  sim.macros.buffer = [0x61, 0, 0x01, 0x05, 0x7c, 0x00, 0x00, 0, 0, 0]; // macro 1 has an action kind 5
  sim.allowAdvanced = true;
  const mac = session.advanced.macros!;
  const s = await mac.begin(ok);
  assert.equal(s.slots[1].editable, false);
  await assert.rejects(mac.save(1, "hi"), /can't show/);
  await mac.save(0, "yo");
  assert.deepEqual(sim.macros.buffer.slice(0, 8), [0x79, 0x6f, 0, 0x01, 0x05, 0x7c, 0, 0], "the odd macro moved only by its neighbour's length");
  await mac.end();
});

test("(c) a factory reset: RESET typed, the full backup first, then the keymap + macro reset, then 'Restore my settings'", async () => {
  const { session, sim, events, store } = await rig();
  sim.allowAdvanced = true;
  // make the keyboard differ from its factory state
  const k = session.advanced.keymap!;
  await k.begin(ok);
  await k.set(0, 2 * SAMPLE_COLS, layerKeycodes(1, "current").mo);
  await k.set(0, 2 * SAMPLE_COLS + 1, 0x14);
  await k.end();
  const mac = session.advanced.macros!;
  await mac.begin(ok);
  await mac.save(2, "mine{Enter}");
  await mac.end();
  const changedKeys = sim.keymap.map((l) => [...l]);
  const changedMacros = [...sim.macros.buffer];
  events.length = 0;

  const reset = session.advanced.reset!;
  const sentBefore = sim.received.length;
  await assert.rejects(reset.reset({ acknowledged: true }), /RESET/);
  await assert.rejects(reset.reset({ acknowledged: true, typed: "Reset" }), /RESET/);
  assert.equal(sim.received.length, sentBefore, "no frame for an unconfirmed reset");
  assert.equal(events.length, 0, "and no backup either");

  const { backupPath } = await reset.reset(RESET);
  assert.match(backupPath, /before-reset/);
  const backupAt = events.findIndex((e) => /^backup:kb-via-.*-before-reset$/.test(e));
  assert.ok(backupAt >= 0 && backupAt < events.indexOf("frame:keymap-reset"), events.join());
  assert.ok(events.indexOf("frame:keymap-reset") < events.indexOf("frame:macro-reset"));
  const saved = JSON.parse(store.backups.at(-1)!.json);
  assert.equal(saved.keymap[0][2 * SAMPLE_COLS], layerKeycodes(1, "current").mo, "the backup holds the keys as they were");
  assert.deepEqual(saved.macroBuffer.slice(0, 5), [0x67, 0x67, 0x20, 0x77, 0x70]);
  assert.deepEqual(session.advanced.gate.live, []);
  assert.notDeepEqual(sim.keymap, changedKeys);
  assert.ok(sim.macros.buffer.every((b) => b === 0), "the macros are gone");
  assert.ok(reset.canRestore());

  await reset.restore(ok);
  assert.deepEqual(sim.keymap, changedKeys);
  assert.deepEqual(sim.macros.buffer.slice(0, changedMacros.length), changedMacros);
  assert.deepEqual(session.advanced.gate.live, []);
  assert.equal(sim.forbidden.length, 0, "no EEPROM reset, no bootloader, nothing else forbidden");
});

test("(c) a reset never runs if its backup couldn't be saved", async () => {
  const { session, sim, store } = await rig();
  sim.allowAdvanced = true;
  store.saveBackup = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(session.advanced.reset!.reset(RESET), /disk full/);
  assert.equal(sim.advancedFrames.length, 0);
  assert.equal(sim.forbidden.length, 0);
  assert.deepEqual(session.advanced.gate.live, []);
  await assert.rejects(session.advanced.keymap!.begin(ok), /disk full/);
  await assert.rejects(session.advanced.macros!.begin(ok), /disk full/);
  assert.deepEqual(session.advanced.gate.live, [], "no token is taken if the backup fails");
});

test("a Vial board and an older VIA board take the same flows in their own keycode encoding", async () => {
  for (const o of [{ vial: true }, { protocol: 11 }]) {
    const { session, sim, backend } = await rig(o);
    sim.allowAdvanced = true;
    const scheme = (backend.state.keymap?.note ?? "").includes("pre-0.19") ? "legacy" : "current";
    const k = session.advanced.keymap!;
    await k.begin(ok);
    const mo1 = layerKeycodes(1, scheme).mo;
    await k.set(0, 2 * SAMPLE_COLS, mo1);
    assert.equal(sim.keymap[0][2 * SAMPLE_COLS], mo1);
    await assert.rejects(k.set(0, 2 * SAMPLE_COLS, scheme === "current" ? 0x7c00 : 0x5c00), /never/i);
    await k.undoAll();
    await k.end();
    assert.equal(sim.forbidden.length, 0);
  }
});
