// The ATK X1 V2 Air+'s Advanced actions against a simulated mouse (src/lib/atk-sim.ts), through the real
// session, wire and guard:
//   node --test scripts/advanced-atk.test.ts
//
//  (a) pairing, button rows and RestoreFactory are refused without the confirmation token, and a token for
//      one action doesn't open another;
//  (b) firmware, bootloader, un-pair and every other write stay unreachable with every token held;
//  (c) a backup is on disk before the first destructive frame of every flow;
//  plus the guided flows themselves: pairing steps and timeout, button changes with Undo all, and a
//  factory reset that can be put back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { weReportChecksum } from "@openmouse/protocol/endgame-gear-we";
import { AdvancedGate, type AdvancedScope } from "../src/lib/advanced/core.ts";
import * as P from "../src/lib/atk-protocol.ts";
import { Wire } from "../src/lib/atk-wire.ts";
import { connectAtkDevice, type AtkSession } from "../src/lib/atk-session.ts";
import { simulateAtk, type AtkSim } from "../src/lib/atk-sim.ts";

const ok = { acknowledged: true };
const RESET = { acknowledged: true, typed: "RESET" };
const hexOf = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

async function gateWith(...scopes: AdvancedScope[]) {
  const g = new AdvancedGate("t");
  for (const s of scopes) await g.grant(s, RESET);
  return g;
}

/** A connected session on a simulated mouse, with an ordered log of backups and destructive frames. */
async function rig(opts: Parameters<typeof simulateAtk>[0] = {}) {
  const sim = simulateAtk(opts);
  const events: string[] = [];
  const backups: { prefix: string; json: string }[] = [];
  const send = sim.device.sendReport.bind(sim.device);
  (sim.device as { sendReport: unknown }).sendReport = async (id: number, data: BufferSource) => {
    const f = new Uint8Array(data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer);
    if (f[0] === 0x05) events.push("frame:pair");
    if (f[0] === 0x09) events.push("frame:reset");
    if (f[0] === 0x07) events.push(`frame:write:${((f[2] << 8) | f[3]).toString(16).padStart(4, "0")}`);
    return send(id, data);
  };
  let failBackup = false;
  const session = await connectAtkDevice(
    sim.device,
    async (prefix, json) => {
      if (failBackup) throw new Error("disk full");
      events.push(`backup:${prefix}`);
      backups.push({ prefix, json });
      return `(memory) ${prefix}-${backups.length}.json`;
    },
    { wait: async () => undefined },
  );
  return { sim, session, events, backups, failBackup: () => (failBackup = true) };
}

const writesTo = (sim: AtkSim, address: number) => sim.log.filter((l) => l === `write 0x${address.toString(16).padStart(4, "0")}`).length;
const frame = (cmd: number, body: number[]) => {
  const f = new Uint8Array(16);
  f[0] = cmd;
  body.forEach((b, i) => (f[1 + i] = b));
  f[15] = weReportChecksum(0x08, Array.from(f.subarray(0, 15)));
  return f;
};

// ---------------------------------------------------------------------------------------------
// (a) refused without the token
// ---------------------------------------------------------------------------------------------

test("(a) pairing, button rows and RestoreFactory need their token", async () => {
  const pair = P.buildPairRequest(1, 61);
  const result = P.buildPairResult();
  const reset = P.buildRestoreFactory();
  const right = P.buildButtonWrite(1, { kind: "dpi", value: 2 });
  const cases: [string, Uint8Array, AdvancedScope][] = [
    ["pair request", pair, "pair"],
    ["pair result", result, "pair"],
    ["restore factory", reset, "reset"],
    ["button row", right, "remap"],
  ];
  for (const [what, f, scope] of cases) {
    assert.match(P.checkFrame(f) ?? "", /forbidden|only written from Advanced/, `${what} without any gate`);
    assert.ok(P.checkFrame(f, await gateWith()), `${what} with an empty gate`);
    assert.equal(P.checkFrame(f, await gateWith(scope)), null, `${what} with ${scope}`);
    for (const other of (["pair", "remap", "macros", "calibrate", "reset"] as AdvancedScope[]).filter((s) => s !== scope)) {
      assert.ok(P.checkFrame(f, await gateWith(other)), `${what} must not open with only ${other}`);
    }
  }
  // a lookalike doesn't count
  assert.ok(P.checkFrame(pair, { has: () => true, scheme: undefined }));
});

test("(a) the wire itself refuses them, so a panel can't skip the guard", async () => {
  const sim = simulateAtk();
  await sim.device.open();
  const wire = new Wire(sim.device);
  for (const f of [P.buildPairRequest(1, 61), P.buildRestoreFactory(), P.buildButtonWrite(2, { kind: "off" })]) {
    await assert.rejects(wire.exchange(f, () => true), /refused to send/);
  }
  assert.equal(sim.sent.length, 0, "nothing reached the receiver");
});

test("(a) the session's Advanced actions refuse to start without a confirmation", async () => {
  const { session, sim } = await rig();
  const adv = session.advanced;
  const before = sim.sent.length;
  await assert.rejects(adv.pair!.run({ acknowledged: false }, () => {}, new AbortController().signal), /confirmation/);
  await assert.rejects(adv.buttons!.begin({ acknowledged: false }), /confirmation/);
  await assert.rejects(adv.reset!.reset({ acknowledged: true }), /RESET/);
  await assert.rejects(adv.reset!.reset({ acknowledged: true, typed: "reset" }), /RESET/);
  assert.equal(sim.sent.length, before, "not a single frame was sent");
  assert.deepEqual(adv.gate.live, []);
});

// ---------------------------------------------------------------------------------------------
// (b) firmware and the rest stay shut
// ---------------------------------------------------------------------------------------------

test("(b) firmware, bootloader, profile switch, un-pair and strange writes stay refused with every token", async () => {
  const all = await gateWith("pair", "remap", "macros", "calibrate", "reset");
  const forbidden = [0x01, 0x02, 0x0a, 0x0b, 0x0c, 0x0d, 0x0f, 0x11, 0x13, 0x5a, 0x5b];
  for (const cmd of forbidden) {
    assert.match(P.checkFrame(frame(cmd, []), all) ?? "", /forbidden/, `command 0x${cmd.toString(16)}`);
    assert.ok(P.checkFrame(frame(cmd, [0, 0, 0, 2, 1, 61]), all), `command 0x${cmd.toString(16)} with arguments`);
  }
  for (const cmd of [0x00, 0x0e, 0x14, 0x20, 0x55, 0x7f, 0xaa, 0xfe, 0xff]) assert.ok(P.checkFrame(frame(cmd, []), all), `unknown command 0x${cmd.toString(16)}`);
  // EEPROM writes outside the rows SYNQ owns
  const write = (address: number, data: number[]) => frame(0x07, [0, address >> 8, address & 0xff, data.length, ...data]);
  for (const address of [0x0001, 0x0058, 0x0078, 0x0100, 0x0300, 0x00bd, 0x1b01, 0x1b30, 0x1e00, 0x7fff]) {
    assert.ok(P.checkFrame(write(address, P.packButton({ kind: "dpi", value: 1 })), all), `address 0x${address.toString(16)}`);
  }
  // button rows only hold the three actions SYNQ writes, and the left button is left click
  for (const row of [[5, 1, 0, 0x4f], [6, 1, 0, 0x4e], [0x0b, 1, 0, 0x49], [1, 3, 0, 0x51], [1, 0, 0, 0x54], [2, 4, 0, 0x4f]]) {
    assert.ok(P.checkFrame(write(P.keyRowAddress(3), row), all), `row ${hexOf(row)}`);
  }
  for (const action of [{ kind: "off" }, { kind: "mouse", value: 2 }, { kind: "dpi", value: 1 }] as P.ButtonAction[]) {
    assert.match(P.checkFrame(P.buildButtonWrite(0, action), all) ?? "", /left button always stays left click/);
    assert.equal(P.checkFrame(P.buildButtonWrite(3, action), all), null);
  }
  assert.equal(P.checkFrame(P.buildButtonWrite(0, { kind: "mouse", value: 1 }), all), null, "left stays left");
  // pairing only names a mouse SYNQ has checked
  assert.ok(P.checkFrame(P.buildPairRequest(1, 8), all));
  assert.equal(P.checkFrame(P.buildPairRequest(1, 61), all), null);
});

test("(b) the default path is as strict as before: reads and the owned rows pass, nothing new does", () => {
  const read = (a: number, n: number) => frame(0x08, [0, a >> 8, a & 0xff, n]);
  assert.equal(P.checkFrame(read(0x0060, 4)), null, "reading a button row is a plain read");
  assert.equal(P.checkFrame(P.buildCommand(P.CMD.getMouseOnline)), null);
  assert.equal(P.checkFrame(P.buildWrite(P.ADDR.liftOff, P.pair(6))), null);
  assert.equal(P.checkFrame(P.buildWrite(P.ADDR.paw3955Dpi, P.packPaw3955Stage(800))), null);
  assert.ok(P.checkFrame(P.buildWrite(P.keyRowAddress(1), P.packButton({ kind: "off" }))), "button rows are not a default write");
  for (const cmd of P.FORBIDDEN_COMMANDS.keys()) assert.ok(P.checkFrame(frame(cmd, [])), `0x${cmd.toString(16)}`);
});

// ---------------------------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------------------------

test("the card lists what the X1 can do, with sources, and why the rest is hidden", async () => {
  const { session } = await rig();
  const f = session.advanced.features;
  for (const s of ["pair", "remap", "reset"] as const) {
    assert.ok(f[s].available, s);
    assert.match(f[s].source, /ATK HUB/);
  }
  for (const s of ["macros", "calibrate"] as const) {
    assert.ok(!f[s].available, s);
    assert.ok(f[s].why, s);
  }
  assert.ok(session.advanced.pair && session.advanced.buttons && session.advanced.reset);
  assert.equal(session.advanced.macros, undefined);
  assert.equal(session.advanced.calibrate, undefined);
  assert.deepEqual(session.advanced.firmware.versions, [
    { part: "Mouse", version: "5.20" },
    { part: "8K receiver", version: "5.01" },
  ]);
  assert.equal(session.advanced.firmware.latest, null);
  assert.equal(session.advanced.firmware.updater?.url, "https://hub.atk.pro");
});

test("pairing: the guide, the request, the poll, and the gate is shut again afterwards", async () => {
  const { session, sim, events } = await rig();
  const adv = session.advanced.pair!;
  assert.ok(adv.steps.length >= 3 && adv.steps.some((s) => /off/i.test(s)) && adv.steps.some((s) => /on/i.test(s)));
  assert.equal(adv.timeoutSeconds, 30);
  const seen: string[] = [];
  let polls = 0;
  const orig = sim.device.sendReport.bind(sim.device);
  (sim.device as { sendReport: unknown }).sendReport = async (id: number, d: BufferSource) => {
    if (new Uint8Array(d as ArrayBuffer)[0] === 0x06 && ++polls === 4) sim.completePairing(); // the mouse is switched on
    return orig(id, d);
  };
  const final = await adv.run(ok, (p) => seen.push(p.phase), new AbortController().signal);
  assert.equal(final.phase, "paired");
  assert.deepEqual(seen.slice(0, 2), ["starting", "waiting"]);
  assert.equal(seen.at(-1), "paired");
  assert.deepEqual(events.filter((e) => e.startsWith("frame:")), ["frame:pair"]);
  assert.deepEqual(sim.log.filter((l) => l.startsWith("pair")), ["pair 1,61"]);
  assert.deepEqual(session.advanced.gate.live, [], "the token is gone");
  // the frame that went out is the one OpenMouse builds
  assert.equal(hexOf(sim.sent.find((f) => f[0] === 0x05)!), hexOf(P.buildPairRequest(1, 61)));
});

test("pairing times out safely, and can be cancelled", async () => {
  const { session, sim } = await rig();
  const timeout = await session.advanced.pair!.run(ok, () => {}, new AbortController().signal);
  assert.equal(timeout.phase, "timeout");
  assert.match(timeout.message, /nothing was changed/i);
  assert.ok(sim.sent.every((f) => [0x03, 0x04, 0x05, 0x06, 0x08, 0x10, 0x12, 0x1d].includes(f[0])), "only pairing frames and reads");
  assert.deepEqual(session.advanced.gate.live, []);
  const ctl = new AbortController();
  const progress: string[] = [];
  const cancelled = await session.advanced.pair!.run(ok, (p) => (progress.push(p.phase), progress.length === 3 && ctl.abort()), ctl.signal);
  assert.equal(cancelled.phase, "cancelled");
  assert.deepEqual(session.advanced.gate.live, []);
});

test("pairing reports a receiver that stops answering", async () => {
  const { session, sim } = await rig();
  const orig = sim.device.sendReport.bind(sim.device);
  (sim.device as { sendReport: unknown }).sendReport = async (id: number, d: BufferSource) => {
    if (new Uint8Array(d as ArrayBuffer)[0] === 0x06) return; // the poll goes unanswered
    return orig(id, d);
  };
  const r = await session.advanced.pair!.run(ok, () => {}, new AbortController().signal);
  assert.equal(r.phase, "failed");
  assert.deepEqual(session.advanced.gate.live, []);
});

test("(c) buttons: read, back up, and only then take the token; the left button is locked", async () => {
  const { session, sim, events, backups } = await rig();
  const b = session.advanced.buttons!;
  const state = await b.begin(ok);
  assert.equal(events[0], "backup:atk-x1-v2-air-buttons", "the backup comes first");
  assert.ok(!events.some((e) => e.startsWith("frame:write")), "nothing written yet");
  assert.match(state.backupPath ?? "", /atk-x1-v2-air-buttons/);
  const saved = JSON.parse(backups[0].json);
  assert.deepEqual(saved.buttons.map((x: { id: string }) => x.id), ["left", "right", "middle", "back", "forward", "bottom"]);
  assert.equal(saved.buttons[1].row, "01 02 00 52", "the right button as it was");
  assert.deepEqual(state.slots.map((s) => [s.id, s.locked]), [["left", true], ["right", false], ["middle", false], ["back", false], ["forward", false], ["bottom", false]]);
  assert.equal(state.slots[0].actionLabel, "Left click");
  assert.deepEqual(session.advanced.gate.live, ["remap"]);

  // change the DPI button to "DPI up" and the back button to "Off"
  let s = await b.set("bottom", "dpi:2");
  assert.equal(s.slots[5].actionLabel, "DPI up");
  assert.ok(s.slots[5].changed);
  s = await b.set("back", "off");
  assert.equal(s.slots[3].actionLabel, "Off");
  assert.equal(writesTo(sim, P.keyRowAddress(5)), 1);
  assert.equal(hexOf([...Array(4)].map((_, i) => sim.eeprom.get(P.keyRowAddress(5) + i) ?? 0)), "02 02 00 51");
  const firstWrite = events.findIndex((e) => e.startsWith("frame:write"));
  assert.ok(events.indexOf("backup:atk-x1-v2-air-buttons") < firstWrite);

  // the left button can't go, here or on the wire
  await assert.rejects(b.set("left", "off"), /left button always stays left click/);
  await assert.rejects(b.set("left", "mouse:2"), /left button always stays left click/);
  const wire = new Wire(sim.device, session.advanced.gate);
  await assert.rejects(wire.exchange(P.buildButtonWrite(0, { kind: "mouse", value: 2 }), () => true), /left button always stays left click/);
  assert.equal(writesTo(sim, P.keyRowAddress(0)), 0, "the left button row was never written");
  // unknown actions and unknown buttons
  await assert.rejects(b.set("right", "macro:1"), /doesn't write that action/);
  await assert.rejects(b.set("thumb", "off"), /isn't a button/);
  // another button may become left click
  s = await b.set("middle", "mouse:1");
  assert.equal(s.slots[2].actionLabel, "Left click");

  // Undo all puts every button back, and ends with the original rows on the mouse
  s = await b.undoAll();
  assert.ok(s.slots.every((x) => !x.changed));
  for (let i = 0; i < 6; i++) assert.equal(hexOf([...Array(4)].map((_, n) => sim.eeprom.get(P.keyRowAddress(i) + n) ?? 0)), hexOf(P.packButton(P.BUTTONS[i].factory)), `button ${i}`);
  await b.end();
  assert.deepEqual(session.advanced.gate.live, [], "the token is given back");
  await assert.rejects(b.set("right", "off"), /Start button changes first/);
});

test("buttons: a button holding a macro is left alone, and a mouse whose left button isn't left click isn't touched", async () => {
  {
    const { session, sim } = await rig();
    [6, 1, 0, 0x4e].forEach((v, i) => sim.eeprom.set(P.keyRowAddress(3) + i, v)); // back button -> macro 1 (set in ATK HUB)
    const s = await session.advanced.buttons!.begin(ok);
    assert.ok(s.slots[3].locked);
    assert.match(s.slots[3].lockedWhy ?? "", /ATK HUB/);
    assert.equal(s.slots[3].action, null);
    await assert.rejects(session.advanced.buttons!.set("back", "off"), /leaves it alone/);
    await session.advanced.buttons!.end();
  }
  {
    const { session, sim, events } = await rig();
    P.packButton({ kind: "mouse", value: 2 }).forEach((v, i) => sim.eeprom.set(P.keyRowAddress(0) + i, v)); // left reads as right click
    await assert.rejects(session.advanced.buttons!.begin(ok), /left button doesn't read as left click/);
    assert.deepEqual(events.filter((e) => e.startsWith("backup")), [], "nothing is saved or granted for a mouse SYNQ won't change");
    assert.deepEqual(session.advanced.gate.live, []);
  }
});

test("(c) a factory reset: typed RESET, the full backup first, then reset, then 'Restore my settings'", async () => {
  const { session, sim, events, backups } = await rig();
  // make the mouse different from factory first
  await session.saveStages([500, 900, 1800], 1);
  await session.setPolling(2000);
  await session.setLiftOff(0.9);
  await session.setDebounce(4);
  await session.advanced.buttons!.begin(ok);
  await session.advanced.buttons!.set("bottom", "dpi:3");
  await session.advanced.buttons!.end();
  const snapshot = new Map(sim.eeprom);
  events.length = 0;

  const reset = session.advanced.reset!;
  assert.ok(reset.wipes.length >= 2);
  assert.ok(!reset.canRestore());
  const { backupPath } = await reset.reset(RESET);
  assert.match(backupPath, /atk-x1-v2-air-before-reset/);
  const backupIndex = events.indexOf("backup:atk-x1-v2-air-before-reset");
  const resetIndex = events.indexOf("frame:reset");
  assert.ok(backupIndex >= 0 && resetIndex > backupIndex, `the backup (${backupIndex}) comes before the reset frame (${resetIndex}): ${events.join(", ")}`);
  const saved = JSON.parse(backups.at(-1)!.json);
  assert.ok(saved.rows.some((r: { address: string; kind: string }) => r.address === "0x0064" && r.kind === "button"));
  assert.equal(saved.rows.filter((r: { kind: string }) => r.kind === "setting").length, 8 + 4, "all 8 DPI rows and the four setting rows");
  assert.deepEqual(session.advanced.gate.live, [], "the reset token is given back");

  // the mouse is back to factory
  for (const [address, v] of sim.defaults()) assert.equal(sim.eeprom.get(address), v, `0x${address.toString(16)}`);
  assert.ok(reset.canRestore());

  // Restore my settings
  await assert.rejects(reset.restore({ acknowledged: false }), /confirmation/);
  await reset.restore(ok);
  for (const [address, v] of snapshot) assert.equal(sim.eeprom.get(address), v, `restored 0x${address.toString(16)}`);
  assert.deepEqual(session.advanced.gate.live, []);
});

test("(c) a reset never runs if its backup couldn't be saved", async () => {
  const { session, sim, failBackup } = await rig();
  failBackup();
  await assert.rejects(session.advanced.reset!.reset(RESET), /disk full/);
  assert.ok(!sim.sent.some((f) => f[0] === 0x09), "no reset frame");
  assert.ok(!sim.log.includes("reset"));
  assert.deepEqual(session.advanced.gate.live, []);
  failBackup();
});

test("a reset from a receiver that restarts before answering still completes", async () => {
  const { session, sim } = await rig({ silentReset: true });
  await session.advanced.reset!.reset(RESET);
  assert.ok(sim.log.includes("reset"));
  for (const [address, v] of sim.defaults()) assert.equal(sim.eeprom.get(address), v);
});

test("a mouse that can't be written yet is read-only in Advanced too", async () => {
  // the cable (373b:12a2) isn't a checked link
  const sim = simulateAtk();
  (sim.device as { productId: number }).productId = 0x12a2;
  const session: AtkSession = await connectAtkDevice(sim.device, async () => "x", { wait: async () => undefined });
  for (const s of ["pair", "remap", "reset"] as const) assert.ok(!session.advanced.features[s].available, s);
  assert.equal(session.advanced.pair, undefined);
  assert.equal(session.advanced.buttons, undefined);
  assert.equal(session.advanced.reset, undefined);
  assert.ok(session.advanced.features.pair.why);
});
