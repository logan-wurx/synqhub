// Pro loadouts (src/lib/pros): the curated list holds together, a pro's setup lands on the person's own mouse with
// the Keep your feel math (nearest legal DPI and polling, the other DPI steps untouched), the in-game sens keeps the
// pro's eDPI at the DPI the mouse really runs, and applying it to a simulated X1 goes through the real session and
// undoes cleanly.
//   node --test scripts/pros.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkPros, planProKeyboard, planProMouse, proEdpi, proMouseFeel, searchPros, sensAt, type Pro } from "../src/lib/pros/loadout.ts";
import { mapMouse } from "../src/lib/feel/mouse.ts";
import { atkMouse } from "../src/lib/feel/devices.ts";
import { driveAtk } from "../src/lib/feel/drive.ts";
import { connectAtkDevice } from "../src/lib/atk-session.ts";
import { simulateAtk } from "../src/lib/atk-sim.ts";
import type { KeyboardDevice, MouseDevice } from "../src/lib/feel/types.ts";

const PROS: Pro[] = JSON.parse(readFileSync(new URL("../src/lib/pros/pros.json", import.meta.url), "utf8"));
const pro = (id: string) => PROS.find((p) => p.id === id)!;

function mouse(over: Partial<MouseDevice["target"]> = {}, now: Partial<NonNullable<MouseDevice["now"]>> = {}): MouseDevice {
  return {
    target: { dpi: { min: 100, max: 26000, step: 50 }, stages: { max: 5, fixedCount: null }, polling: { options: [125, 250, 500, 1000, 2000, 4000, 8000] }, lod: null, debounce: null, toggles: { angleSnapping: false, motionSync: false, ripple: false }, ...over },
    now: { stages: [400, 800, 1600], active: 1, pollingHz: 1000, lod: null, debounceMs: null, angleSnapping: null, motionSync: null, ripple: null, ...now },
  };
}

test("the list holds together: about 40 pros, both games, each with a source and a date", () => {
  assert.deepEqual(checkPros(PROS), []);
  assert.ok(PROS.length >= 38 && PROS.length <= 45, `${PROS.length} pros`);
  for (const id of ["zywoo", "s1mple", "donk", "m0nesy", "niko", "tenz", "aspas", "demon1"]) assert.ok(pro(id), id);
  assert.ok(PROS.filter((p) => p.game === "valorant").length >= 15);
  assert.ok(PROS.every((p) => p.source.startsWith("https://prosettings.net/players/")));
  assert.equal(proEdpi(pro("zywoo")), 760);
  assert.deepEqual(checkPros([...PROS.slice(0, 1), { ...PROS[0], pollingHz: 1500, source: "x" }]).sort(), ["zywoo: duplicate id", "zywoo: polling 1500", "zywoo: source"]);
});

test("search finds by handle, team, mouse or game", () => {
  assert.deepEqual(searchPros(PROS, "zyw").map((p) => p.id), ["zywoo"]);
  assert.ok(searchPros(PROS, "vitality").some((p) => p.id === "ropz"));
  assert.ok(searchPros(PROS, "valorant").every((p) => p.game === "valorant"));
  assert.equal(searchPros(PROS, "  ").length, PROS.length);
});

test("the pro's DPI goes on the step you play on; your other steps stay", () => {
  const f = proMouseFeel(pro("zywoo"), mouse().now);
  assert.deepEqual(f.stages, [400, 400, 1600]);
  assert.equal(f.active, 1);
  assert.equal(f.lod, null, "lift-off and the rest are left alone");
  assert.deepEqual(proMouseFeel(pro("zywoo"), null).stages, [400]);
});

test("ZywOo on a mouse that offers his DPI: exact, same sens, his eDPI", () => {
  const m = planProMouse(pro("zywoo"), mouse());
  assert.equal(m.dpi, 400);
  assert.equal(m.sens, 1.9);
  assert.equal(m.edpi, 760);
  assert.deepEqual(m.plan.steps, [{ kind: "stages", values: [400, 400, 1600], active: 1 }], "1 kHz is already set");
});

test("a mouse without the pro's DPI gets the nearest, and the sens that keeps the pro's eDPI", () => {
  // Only fixed steps of 450 and 900: ZywOo's 400 becomes 450.
  const m = planProMouse(pro("zywoo"), mouse({ dpi: { min: 450, max: 900, step: 450, options: [450, 900] } }, { stages: [900], active: 0 }));
  assert.equal(m.dpi, 450);
  assert.equal(m.sens, 1.689);
  assert.ok(Math.abs(m.edpi! - 760) < 0.5, `eDPI ${m.edpi}`);
  assert.equal(sensAt(pro("zywoo"), 450), 1.689);
  // A Valorant pro: the Valorant line.
  const t = planProMouse(pro("tenz"), mouse({}, { stages: [800], active: 0 }));
  assert.equal(t.dpi, 1600);
  assert.equal(t.sens, 0.14);
});

test("polling the mouse can't reach becomes the nearest it offers", () => {
  const m = planProMouse(pro("broky"), mouse({ polling: { options: [125, 250, 500, 1000, 2000, 4000] } }));
  const row = m.plan.rows.find((r) => r.id === "polling")!;
  assert.equal(row.to, "4 kHz");
  assert.equal(row.status, "adjusted");
  assert.ok(m.plan.steps.some((s) => s.kind === "polling" && s.hz === 4000));
});

test("no published keyboard values: nothing to change on the keyboard", () => {
  const kb: KeyboardDevice = { target: { actuation: { min: 0.1, max: 4, step: 0.1 }, rapidTrigger: true, rtSensitivity: { min: 0.1, max: 2, step: 0.1, independent: false }, socd: null }, now: null };
  assert.equal(planProKeyboard(pro("zywoo"), kb), null);
  const withRt = planProKeyboard({ ...pro("zywoo"), actuationMm: 1.2, rtMm: 0.15 }, kb)!;
  assert.deepEqual(withRt.steps, [{ kind: "actuation", mm: 1.2 }, { kind: "rtSensitivity", pressMm: 0.2, releaseMm: 0.2 }, { kind: "rapidTrigger", on: true }]);
});

test("applying a pro to a simulated X1 goes through its session, and Undo puts it back", async () => {
  const sim = simulateAtk({ mouseOn: true });
  const backups: string[] = [];
  const session = await connectAtkDevice(
    sim.device,
    async (prefix) => {
      backups.push(prefix);
      return `(memory) ${prefix}.json`;
    },
    { wait: async () => undefined },
  );
  const before = atkMouse(session.view);
  const m = planProMouse(pro("donk"), before);
  const out = await driveAtk(session, m.plan.steps);
  assert.ok(out.ok, out.error);
  assert.ok(backups.length >= 1, "backed up before the first write");
  const after = await session.refresh();
  assert.equal(after.stages[after.activeStage], 800);
  assert.equal(after.pollingHz, 1000);
  assert.equal(m.sens, 1.25);
  const undo = mapMouse(before.now!, atkMouse(session.view));
  const back = await driveAtk(session, undo.steps);
  assert.ok(back.ok, back.error);
  const restored = await session.refresh();
  assert.deepEqual(restored.stages, before.now!.stages);
  assert.equal(restored.activeStage, before.now!.active);
  assert.equal(restored.pollingHz, before.now!.pollingHz);
  await session.close();
});
