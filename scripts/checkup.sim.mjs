// Gear Doctor end to end against simulated gear (no hardware, no window, no Tauri): what a checkup records turns into
// a finding with a "Fix it", the fix is resolved against what the device offers and runs through the device's real
// session (the same calls its panel makes: backup before the first write, every change read back), and Undo puts back
// what was there.
//   1. ATK X1 V2 Air+ (src/lib/atk-sim.ts): a bouncing left button -> debounce raised, then undone.
//   2. Keychron Q1 HE (src/lib/kb/via/keychron/sim.ts): rapid trigger too fine to hold W still -> coarser RT, then undone.
// Run: node scripts/checkup.sim.mjs
import assert from "node:assert/strict";
import { connectAtkDevice } from "../src/lib/atk-session.ts";
import { simulateAtk } from "../src/lib/atk-sim.ts";
import { atkMouse, genericKeyboard } from "../src/lib/feel/devices.ts";
import { driveAtk, driveGenericKeyboard } from "../src/lib/feel/drive.ts";
import { mapMouse } from "../src/lib/feel/mouse.ts";
import { mapKeyboard } from "../src/lib/feel/keyboard.ts";
import { keyboardReport, mouseReport } from "../src/lib/checkup/report.ts";
import { isResolved, resolveKeyboardFix, resolveMouseFix } from "../src/lib/checkup/fix.ts";
import { KEYS } from "../src/lib/checkup/thresholds.ts";
import { viaDriver } from "../src/lib/kb/via/driver.ts";
import { SimKeychronHe } from "../src/lib/kb/via/keychron/sim.ts";
import { keychronModel } from "../src/lib/kb/via/keychron/devices.ts";
import { KbSession, memoryKbStore } from "../src/lib/kb/session.ts";

/** 30 clean clicks at a steady pace, with the switch bouncing back `gap` ms after three of the releases. */
function bouncyClicks(gap) {
  const out = [];
  for (let i = 0; i < 30; i++) {
    const t = i * 230;
    out.push({ t, button: 0, down: true }, { t: t + 70, button: 0, down: false });
    if (i === 4 || i === 11 || i === 19) out.push({ t: t + 70 + gap, button: 0, down: true }, { t: t + 74 + gap, button: 0, down: false });
  }
  return out;
}

// 1. The mouse.
{
  const sim = simulateAtk({ mouseOn: true });
  const events = [];
  const send = sim.device.sendReport.bind(sim.device);
  sim.device.sendReport = async (id, data) => {
    const f = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
    if (f[0] === 0x07) events.push("write");
    return send(id, data);
  };
  const session = await connectAtkDevice(
    sim.device,
    async (prefix, json) => {
      events.push(`backup:${prefix}`);
      assert.ok(JSON.parse(json), "the backup is the mouse's settings as JSON");
      return `(memory) ${prefix}.json`;
    },
    { wait: async () => undefined },
  );
  const before = atkMouse(session.view);
  assert.ok(before.target.debounce, "the X1 has a debounce setting");

  // The checkup: three bounces 6 ms after letting go.
  const report = mouseReport(
    { id: "mouse:atk", name: "X1 V2 Air+", blocked: null, wireless: true, device: before },
    { source: "raw", clicks: bouncyClicks(6), motion: [], rest: [] },
  );
  const finding = report.findings.find((f) => f.id === "clicks.bounce");
  assert.ok(finding?.fix, "a bouncing button gets a Fix it");
  assert.equal(report.level, "bad");

  // Fix it: resolved against the X1's own debounce list, then through its session.
  const r = resolveMouseFix(finding.fix.intent, before);
  assert.ok(isResolved(r), r.reason);
  const want = r.steps[0].ms;
  assert.ok(want >= 8 && before.target.debounce.options.includes(want), `debounce ${want}`);
  const out = await driveAtk(session, r.steps);
  assert.ok(out.ok, out.error);
  assert.equal(session.view.debounceMs, want, "read back");
  assert.ok(events.indexOf(events.find((e) => e.startsWith("backup:"))) < events.indexOf("write"), "backup before the first write");
  const fresh = await session.refresh();
  assert.equal(fresh.debounceMs, want, "the mouse holds it");

  // Undo: the old settings mapped back onto the mouse.
  const undo = mapMouse(before.now, atkMouse(session.view));
  assert.deepEqual(undo.steps, [{ kind: "debounce", ms: before.now.debounceMs }], "only the debounce goes back");
  const back = await driveAtk(session, undo.steps);
  assert.ok(back.ok, back.error);
  assert.equal((await session.refresh()).debounceMs, before.now.debounceMs);
  await session.close();
  console.log(`ok  X1: bounce -> debounce ${before.now.debounceMs} -> ${want} ms (backed up, read back), undone`);
}

// 2. The keyboard.
{
  const q1 = keychronModel(0x3434, 0x0b10);
  const board = new SimKeychronHe({ model: q1 });
  const store = memoryKbStore();
  const backend = await viaDriver.open(board, { store, live: false, devices: async () => [], definitions: { get: async () => null, problem: () => null } });
  const s = new KbSession(backend, store, board);
  s.setAllowChanges(true);
  // The person runs rapid trigger at 0.1 mm on every key.
  let r = await s.apply({ kind: "analog", target: "global", values: { rapidTrigger: true, rtPressMm: 0.1, rtReleaseMm: 0.1 } });
  assert.equal(r.verdict, "confirmed", r.detail);
  const backupsBefore = store.backups.length;
  const before = genericKeyboard(s.view);
  assert.equal(before.now.rapidTrigger, true);

  // The checkup: every key once, then W lets go twice while held.
  const keys = KEYS.codes.flatMap((code, i) => [
    { t: i * 400, code, down: true, repeat: false },
    { t: i * 400 + 80, code, down: false, repeat: false },
  ]);
  const hold = [
    { t: 0, code: "KeyW", down: true, repeat: false },
    { t: 700, code: "KeyW", down: false, repeat: false },
    { t: 709, code: "KeyW", down: true, repeat: false },
    { t: 1500, code: "KeyW", down: false, repeat: false },
    { t: 1511, code: "KeyW", down: true, repeat: false },
    { t: 2300, code: "KeyW", down: false, repeat: false },
  ];
  const report = keyboardReport({ id: "kb:via", name: "Q1 HE", blocked: null, device: before }, { keys, keysEnd: 4000, asked: KEYS.codes, hold, holdEnd: 2800, rest: [] });
  const finding = report.findings.find((f) => f.id === "hold.flicker");
  assert.ok(finding?.fix, "flicker on a magnetic board with rapid trigger gets a Fix it");
  assert.match(finding.advice, /finer than a finger can hold still/);

  const fix = resolveKeyboardFix(finding.fix.intent, before);
  assert.ok(isResolved(fix), fix.reason);
  assert.equal(fix.steps[0].pressMm, 0.2, "0.1 mm doubled, on the board's 0.1 mm grid");
  const out = await driveGenericKeyboard(s, s.view, fix.steps);
  assert.ok(out.ok, out.error);
  assert.equal(s.view.analog.global.rtPressMm, 0.2, "read back");
  assert.ok(store.backups.length >= backupsBefore, "the session's backup was taken before its first change");
  assert.ok(store.backups.length >= 1);

  // Undo.
  const undo = mapKeyboard(before.now, genericKeyboard(s.view));
  const back = await driveGenericKeyboard(s, s.view, undo.steps);
  assert.ok(back.ok, back.error);
  assert.equal(s.view.analog.global.rtPressMm, 0.1, "put back");
  assert.deepEqual(board.forbidden, [], "nothing outside the allowlist reached the board");
  console.log("ok  Q1 HE: rapid-trigger flicker -> 0.1 -> 0.2 mm (backed up, read back), undone");
}
