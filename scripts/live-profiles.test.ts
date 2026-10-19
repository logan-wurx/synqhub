// Game profiles for every device (src/lib/profiles/runner.ts): what goes on and comes back off, in what order, on fake
// devices and a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_PREFIX, MAX_TRIES, ProfileRunner, liveProfiles, type HeldMap, type RunnerDeps } from "../src/lib/profiles/runner.ts";
import type { GamesFile } from "../src/lib/helper.ts";
import type { Feel, LiveDevice } from "../src/lib/profiles/live.ts";

const mouse = (dpi: number): Feel => ({ stages: [dpi], active: 0, pollingHz: 1000, lod: null, debounceMs: null, angleSnapping: null, motionSync: null, ripple: null });
const EVERYDAY = mouse(800);
const VALORANT = mouse(400);
const CS2 = mouse(1600);

function game(id: string, feel: Feel | null, auto = true, family = "logitech") {
  return {
    id,
    name: id.toUpperCase(),
    exes: [`${id}.exe`],
    builtin: false,
    auto,
    profiles: feel ? { [`${LIVE_PREFIX}${family}`]: { name: "PRO X 2 DEX", vendorId: 0x046d, productId: 0xc54d, steps: [], restore: [], settings: { kind: "feel", family, feel }, saved: 1 } } : {},
  };
}

interface Rig {
  deps: RunnerDeps;
  log: string[];
  held: HeldMap;
  setRunning(ids: string[]): void;
  setConnected(f: string[]): void;
  setOk(ok: boolean): void;
  setOn(on: boolean | null): void;
  setMine(mine: boolean): void;
  notes: string[];
  feelNow(): Feel;
}

function rig(file: GamesFile, startHeld: HeldMap = {}): Rig {
  let running: string[] = [];
  let connected = ["logitech"];
  let ok = true;
  let on: boolean | null = true;
  let mine = true;
  let state: Feel = EVERYDAY;
  let clock = 1000;
  const log: string[] = [];
  const notes: string[] = [];
  const held: HeldMap = structuredClone(startHeld);
  const dpi = (f: Feel) => ("stages" in f ? f.stages[0] : 0);
  const device: LiveDevice = {
    family: "logitech",
    kind: "mouse",
    now: () => state,
    view: () => null,
    apply: async (f) => {
      log.push(`apply ${dpi(f)}`);
      if (ok) state = f;
      return { ok, done: ok ? 1 : 0, total: 1, error: ok ? null : "it didn't read back", view: null };
    },
    release: async () => undefined,
  };
  const deps: RunnerDeps = {
    mine: async () => mine,
    enabled: async () => on,
    running: async () => running,
    games: async () => file,
    loadHeld: async () => structuredClone(held),
    saveHeld: async (h) => {
      log.push(`held ${Object.entries(h).map(([k, v]) => `${k}:${v.game}:${v.ok}`).join(",") || "none"}`);
      for (const k of Object.keys(held)) delete held[k];
      Object.assign(held, structuredClone(h));
    },
    connected: () => connected,
    open: async (family) => (family === "logitech" ? device : null),
    notify: (t, x) => notes.push(`${t}: ${x}`),
    now: () => (clock += 1000),
  };
  return {
    deps,
    log,
    held,
    notes,
    setRunning: (ids) => (running = ids),
    setConnected: (f) => (connected = f),
    setOk: (v) => (ok = v),
    setOn: (v) => (on = v),
    setMine: (v) => (mine = v),
    feelNow: () => state,
  };
}

test("a game starting notes the everyday feel before anything is written, then puts its own on", async () => {
  const r = rig({ version: 1, games: [game("valorant", VALORANT)] });
  const run = new ProfileRunner(r.deps);
  await run.tick();
  assert.deepEqual(r.log, [], "nothing runs: nothing to do");
  r.setRunning(["valorant"]);
  await run.tick();
  assert.deepEqual(r.log, ["held logitech:valorant:false", "apply 400", "held logitech:valorant:true"]);
  assert.deepEqual(r.held.logitech.everyday, EVERYDAY);
  await run.tick();
  assert.equal(r.log.length, 3, "holding it already: nothing sent again");
});

test("the game ending puts the everyday feel back", async () => {
  const r = rig({ version: 1, games: [game("valorant", VALORANT)] });
  const run = new ProfileRunner(r.deps);
  r.setRunning(["valorant"]);
  await run.tick();
  r.setRunning([]);
  await run.tick();
  assert.deepEqual(r.log.slice(3), ["apply 800", "held none"]);
  assert.deepEqual(r.feelNow(), EVERYDAY);
});

test("two games at once follow the newest; the older one comes back when the newest closes", async () => {
  const r = rig({ version: 1, games: [game("valorant", VALORANT), game("cs2", CS2)] });
  const run = new ProfileRunner(r.deps);
  r.setRunning(["valorant"]);
  await run.tick();
  r.setRunning(["valorant", "cs2"]);
  await run.tick();
  assert.equal(r.log.at(-2), "apply 1600");
  r.setRunning(["valorant"]);
  await run.tick();
  assert.equal(r.log.at(-2), "apply 400");
  assert.deepEqual(r.held.logitech.everyday, EVERYDAY, "the everyday feel is still the one from before the first game");
});

test("a profile without Apply automatically is left alone", async () => {
  const r = rig({ version: 1, games: [game("valorant", VALORANT, false)] });
  const run = new ProfileRunner(r.deps);
  r.setRunning(["valorant"]);
  await run.tick();
  assert.deepEqual(r.log, []);
});

test("a device plugged in mid-game gets its profile when it appears", async () => {
  const r = rig({ version: 1, games: [game("valorant", VALORANT)] });
  const run = new ProfileRunner(r.deps);
  r.setConnected([]);
  r.setRunning(["valorant"]);
  await run.tick();
  assert.deepEqual(r.log, []);
  r.setConnected(["logitech"]);
  await run.tick();
  assert.equal(r.log.at(-2), "apply 400");
});

test("a change that fails is tried a few times, said once, then left until what is wanted changes", async () => {
  const r = rig({ version: 1, games: [game("valorant", VALORANT)] });
  const run = new ProfileRunner(r.deps);
  r.setOk(false);
  r.setRunning(["valorant"]);
  for (let i = 0; i < MAX_TRIES + 2; i++) await run.tick();
  assert.equal(r.log.filter((l) => l === "apply 400").length, MAX_TRIES);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /PRO X 2 DEX: it didn't read back\./);
  // The game closing is a new change: the everyday feel goes back.
  r.setOk(true);
  r.setRunning([]);
  await run.tick();
  assert.equal(r.log.at(-2), "apply 800");
  assert.deepEqual(r.held, {});
});

test("what a crash left on a device goes back on the next start", async () => {
  const r = rig({ version: 1, games: [game("valorant", VALORANT)] }, { logitech: { game: "valorant", saved: 1, name: "PRO X 2 DEX", everyday: EVERYDAY, ok: true, at: 1 } });
  const run = new ProfileRunner(r.deps);
  await run.tick();
  assert.deepEqual(r.log, ["apply 800", "held none"]);
});

test("turning game profiles off puts the everyday feel back and starts nothing", async () => {
  const r = rig({ version: 1, games: [game("valorant", VALORANT)] });
  const run = new ProfileRunner(r.deps);
  r.setRunning(["valorant"]);
  await run.tick();
  r.setOn(false);
  await run.tick();
  assert.equal(r.log.at(-2), "apply 800");
  await run.tick();
  assert.equal(r.log.at(-1), "held none");
});

test("only live profiles are the runner's: an encoded (ATK, X68) profile is SYNQ Helper's", () => {
  const file: GamesFile = { version: 1, games: [{ ...game("valorant", null), profiles: { "1:2:3:4": { name: "X1", vendorId: 1, productId: 2, steps: [{ reportId: 8, data: [1] }] as never, restore: [], settings: null, saved: 1 } } }] };
  assert.equal(liveProfiles(file).size, 0);
  assert.equal(liveProfiles({ version: 1, games: [game("valorant", VALORANT)] }).get("logitech")?.length, 1);
});

test("while it isn't known yet whether game profiles are on, nothing changes either way", async () => {
  const r = rig({ version: 1, games: [game("valorant", VALORANT)] }, { logitech: { game: "valorant", saved: 1, name: "PRO X 2 DEX", everyday: EVERYDAY, ok: true, at: 1 } });
  const run = new ProfileRunner(r.deps);
  r.setOn(null);
  assert.equal(await run.tick(), false, "not settled: look again");
  assert.deepEqual(r.log, [], "no restore while SYNQ Helper's switches are still loading");
});

test("another SYNQ putting profiles on (an open window, the website, the start with no window): this one leaves them", async () => {
  const r = rig({ version: 1, games: [game("valorant", VALORANT)] });
  const run = new ProfileRunner(r.deps);
  r.setMine(false);
  r.setRunning(["valorant"]);
  assert.equal(await run.tick(), true);
  assert.deepEqual(r.log, []);
  r.setMine(true);
  await run.tick();
  assert.equal(r.log.at(-2), "apply 400");
});

test("a look says when there is nothing left to try", async () => {
  const r = rig({ version: 1, games: [game("valorant", VALORANT)] });
  const run = new ProfileRunner(r.deps);
  r.setRunning(["valorant"]);
  assert.equal(await run.tick(), true, "applied");
  r.setOk(false);
  r.setRunning([]);
  assert.equal(await run.tick(), false, "the restore failed once: try again");
  assert.equal(await run.tick(), false);
  assert.equal(await run.tick(), true, "given up after MAX_TRIES, and said so");
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /^Everyday settings not put back/);
});
