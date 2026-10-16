// The Advanced section's gate, tokens and lockouts, without a device or a window:
//   node --test scripts/advanced-core.test.ts
//
//  - a token only comes from a confirmed gate; a lookalike passed to a guard counts for nothing;
//  - a grant needs the tick, a reset also needs the word RESET, and each token expires on its own;
//  - the desktop bridge is asked for the same grant, and told when it ends;
//  - left click can't be remapped away; a keyboard keeps a way back;
//  - the firmware links are the brand's own and nothing claims a newer version it can't know.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADVANCED_SCOPES, AdvancedGate, AdvancedToken, NO_GRANTS, RESET_WORD, SCOPE_TTL_MS, confirmationProblem, granted, nativeOf, type AdvancedScope, type KeycodeScheme } from "../src/lib/advanced/core.ts";
import { LEFT_CLICK_LOCK, keymapProblem, layerMove, mouseButtonsProblem, mouseChangeProblem } from "../src/lib/advanced/lockout.ts";
import { firmwareInfo, splitVersion, updaterFor } from "../src/lib/advanced/firmware.ts";
import { layerKeycodes, macroKeycode } from "../src/lib/kb/via/keycode-safety.ts";

const ok = { acknowledged: true };

test("a token can only be made by a confirmed gate", async () => {
  assert.throws(() => new AdvancedToken(Symbol("forged"), "reset", "dev", Date.now() + 1000), /only come from/);
  assert.throws(() => new (AdvancedToken as unknown as new () => AdvancedToken)(), /only come from/);
  const gate = new AdvancedGate("dev");
  await assert.rejects(gate.grant("pair", undefined as never), /confirmation/);
  await assert.rejects(gate.grant("pair", { acknowledged: false }), /confirmation/);
  await assert.rejects(gate.grant("pair", { acknowledged: "yes" } as never), /confirmation/);
  assert.deepEqual(gate.live, []);
  await assert.rejects(gate.grant("firmware" as AdvancedScope, ok), /no advanced action called/);
  const token = await gate.grant("pair", ok);
  assert.ok(token instanceof AdvancedToken);
  assert.deepEqual(gate.live, ["pair"]);
});

test("a reset needs the word RESET, typed exactly", async () => {
  const gate = new AdvancedGate("dev");
  assert.equal(RESET_WORD, "RESET");
  for (const typed of [undefined, "", "reset", "Reset", "RESET ", " RESET", "RESE", "RESETT"]) {
    await assert.rejects(gate.grant("reset", { acknowledged: true, typed }), /RESET/, JSON.stringify(typed));
  }
  await assert.rejects(gate.grant("reset", { acknowledged: false, typed: "RESET" }), /confirmation/);
  assert.equal(confirmationProblem("reset", { acknowledged: true, typed: "RESET" }), null);
  for (const scope of ADVANCED_SCOPES.filter((s) => s !== "reset")) assert.equal(confirmationProblem(scope, ok), null, scope);
  await gate.grant("reset", { acknowledged: true, typed: "RESET" });
  assert.ok(gate.has("reset"));
});

test("tokens are per scope and per gate, expire on their own, and can be revoked", async () => {
  let now = 1_000_000;
  const gate = new AdvancedGate("dev", undefined, () => now);
  await gate.grant("pair", ok);
  assert.ok(gate.has("pair"));
  for (const s of ADVANCED_SCOPES.filter((x) => x !== "pair")) assert.ok(!gate.has(s), `${s} rides along`);
  now += SCOPE_TTL_MS.pair - 1;
  assert.ok(gate.has("pair"));
  now += 1;
  assert.ok(!gate.has("pair"), "expired exactly at the TTL");
  await gate.grant("remap", ok, { scheme: "current" });
  assert.equal(gate.scheme, "current");
  await gate.revoke("remap");
  assert.ok(!gate.has("remap"));
  assert.equal(gate.scheme, undefined);
  // another gate has none of this one's tokens
  const other = new AdvancedGate("other", undefined, () => now);
  await gate.grant("macros", ok);
  assert.ok(!other.has("macros"));
  for (const s of ADVANCED_SCOPES) assert.ok(SCOPE_TTL_MS[s] > 0 && SCOPE_TTL_MS[s] <= 15 * 60_000, s);
});

test("a guard counts only a real gate: stubs and lookalikes grant nothing", async () => {
  const stub = { has: () => true, scheme: "current" as KeycodeScheme };
  for (const s of ADVANCED_SCOPES) {
    assert.ok(!granted(stub, s), `a stub must not grant ${s}`);
    assert.ok(!granted(undefined, s));
    assert.ok(!granted(NO_GRANTS, s));
  }
  const gate = new AdvancedGate("dev");
  assert.ok(!granted(gate, "pair"), "a real gate with no token grants nothing");
  await gate.grant("pair", ok);
  assert.ok(granted(gate, "pair"));
  assert.ok(!granted(gate, "reset"));
});

test("the desktop bridge is asked for the same grant, and told when it ends", async () => {
  const calls: string[] = [];
  const device = {
    async advancedGrant(scope: AdvancedScope, ack: { acknowledged: boolean; typed?: string }, scheme?: string) {
      calls.push(`grant ${scope} ${ack.acknowledged} ${ack.typed ?? "-"} ${scheme ?? "-"}`);
      return 1000;
    },
    async advancedRevoke(scope: AdvancedScope) {
      calls.push(`revoke ${scope}`);
    },
  };
  assert.equal(nativeOf({}), undefined);
  assert.equal(nativeOf(null), undefined);
  const gate = new AdvancedGate("dev", nativeOf(device));
  await assert.rejects(gate.grant("reset", ok), /RESET/);
  assert.deepEqual(calls, [], "an unconfirmed grant never reaches the bridge");
  await gate.grant("reset", { acknowledged: true, typed: "RESET" });
  await gate.grant("remap", ok, { scheme: "legacy" });
  await gate.revokeAll();
  assert.deepEqual(calls, ["grant reset true RESET -", "grant remap true - legacy", "revoke reset", "revoke remap"]);
  // the bridge refusing means no token
  const refusing = new AdvancedGate("dev", { advancedGrant: async () => Promise.reject(new Error("This device has no advanced actions in SYNQ.")) });
  await assert.rejects(refusing.grant("pair", ok), /no advanced actions/);
  assert.deepEqual(refusing.live, []);
});

// ---------------------------------------------------------------------------------------------
// Lockouts
// ---------------------------------------------------------------------------------------------

test("the left button always stays left click", () => {
  assert.equal(mouseChangeProblem({ slot: "left", toLeftClick: false }, "left"), LEFT_CLICK_LOCK);
  assert.equal(mouseChangeProblem({ slot: "left", toLeftClick: true }, "left"), null);
  assert.equal(mouseChangeProblem({ slot: "right", toLeftClick: false }, "left"), null);
  assert.equal(mouseChangeProblem({ slot: "right", toLeftClick: true }, "left"), null);
  const slots = [
    { id: "left", leftClick: true },
    { id: "right", leftClick: false },
  ];
  assert.equal(mouseButtonsProblem(slots, "left"), null);
  assert.equal(mouseButtonsProblem([{ id: "left", leftClick: false }, { id: "right", leftClick: true }], "left"), LEFT_CLICK_LOCK, "left click on another button isn't enough");
  assert.equal(mouseButtonsProblem([{ id: "right", leftClick: true }], "left"), LEFT_CLICK_LOCK, "no left button at all");
});

function keymap(layers: Record<number, number>[], scheme: KeycodeScheme = "current") {
  const keys = Object.keys(layers[0]).map(Number);
  return keymapProblem(layers, keys, scheme);
}
const typing = () => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, 0x04 + i])) as Record<number, number>;

test("a keyboard keeps enough typing keys on layer 0", () => {
  assert.equal(keymap([typing()]), null);
  const stripped = typing();
  for (let i = 0; i < 5; i++) stripped[i] = 0x00; // 5 keys off: 7 left
  assert.match(keymap([stripped])!, /at least 8 typing keys/);
  const four = { 0: 0x04, 1: 0x05, 2: 0x06, 3: 0x07 };
  assert.equal(keymap([four]), null, "a 4-key pad needs its 4");
  assert.match(keymap([{ ...four, 3: 0x00 }])!, /at least 4 typing keys/);
  // modifiers and media are not typing keys
  const mods = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, 0xe0 + (i % 8)]));
  assert.ok(keymap([mods]));
});

test("a layer you can enter for good must have a key that leads back", () => {
  for (const scheme of ["current", "legacy"] as const) {
    const k = (n: number) => layerKeycodes(n, scheme);
    const base = typing();
    // TO(1) on layer 0 with nothing on layer 1 to return
    const trapped = [{ ...base, 11: k(1).to }, { ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, 0x00])) }];
    assert.match(keymap(trapped, scheme)!, /Layer 1 would have no key that goes back/, scheme);
    // a TO(0) key on layer 1 fixes it
    const back = [{ ...base, 11: k(1).to }, { ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, 0x00])), 5: k(0).to }];
    assert.equal(keymap(back, scheme), null, scheme);
    // DF(1) is just as permanent
    assert.match(keymap([{ ...base, 3: k(1).df }, { 0: 0 } as never].map((l, i) => (i ? Object.fromEntries(Array.from({ length: 12 }, (_, j) => [j, 0])) : l)), scheme)!, /no key that goes back/);
    // a toggle with a transparent key in the same place on its layer is its own way back
    const toggle = [{ ...base, 11: k(1).tg }, { ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, 0x00])), 11: 0x0001 }];
    assert.equal(keymap(toggle, scheme), null, scheme);
    // momentary layers release on their own
    const momentary = [{ ...base, 11: k(1).mo }, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, 0x00]))];
    assert.equal(keymap(momentary, scheme), null, scheme);
  }
});

test("layer moves and macro keys decode in both encodings", () => {
  assert.deepEqual(layerMove(layerKeycodes(3, "current").mo, "current"), { kind: "mo", layer: 3 });
  assert.deepEqual(layerMove(layerKeycodes(2, "legacy").tg, "legacy"), { kind: "tg", layer: 2 });
  assert.equal(layerMove(0x0004, "current"), null);
  assert.equal(macroKeycode(3, "current"), 0x7703);
  assert.equal(macroKeycode(3, "legacy"), 0x5f15);
});

// ---------------------------------------------------------------------------------------------
// Firmware information
// ---------------------------------------------------------------------------------------------

test("firmware: the maker's updater, and never an invented newer version", () => {
  assert.equal(updaterFor("ATK")?.url, "https://hub.atk.pro");
  assert.equal(updaterFor("Razer")?.name, "Razer Synapse");
  assert.equal(updaterFor("Corsair iCUE")?.name, "Corsair firmware updater");
  assert.equal(updaterFor("Some Brand Nobody Documented"), null);
  for (const brand of ["ATK", "Logitech", "Razer", "Corsair", "ASUS", "SteelSeries", "Wooting", "Keychron", "MonsGeek", "VIA", "Vial", "Pulsar", "Lamzu"]) {
    const u = updaterFor(brand);
    assert.ok(u && /^https:\/\//.test(u.url), brand);
  }
  const info = firmwareInfo("ATK", [
    { part: "Mouse", version: "5.20" },
    { part: "Receiver", version: "" },
  ]);
  assert.deepEqual(info.versions, [{ part: "Mouse", version: "5.20" }]);
  assert.equal(info.latest, null, "no driver reads an official 'latest', so none is claimed");
  assert.deepEqual(splitVersion("Mouse 1.2.6"), { part: "Mouse", version: "1.2.6" });
  assert.deepEqual(splitVersion("Firmware 5"), { part: "Firmware", version: "5" });
  assert.deepEqual(splitVersion("weird"), { part: "Firmware", version: "weird" });
});
