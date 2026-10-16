// "Keep your feel": the saved feel and its storage (src/lib/feel/profile.ts, store.ts). What's read back is
// checked rather than trusted; the seen list decides when a mouse or keyboard is new; the suggestion comes
// from the device configured most recently. A stand-in storage is used throughout; nothing is written to disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HELPER_COMMANDS } from "../src/lib/web/helper.ts";
import { emptyProfile, isEmptyProfile, keyboardFeelOf, mouseFeelOf, profileOf, sameFeel, sensOf } from "../src/lib/feel/profile.ts";
import { createFeelStore, docOf, emptyDoc, isOffered, pendingOffers, suggestSource, type Persist, type PresentDevice } from "../src/lib/feel/store.ts";
import type { KeyboardFeel, MouseFeel } from "../src/lib/feel/types.ts";

const MOUSE: MouseFeel = { stages: [400, 800, 1600], active: 1, pollingHz: 1000, lod: { kind: "level", level: "Low" }, debounceMs: null, angleSnapping: null, motionSync: null, ripple: null };
const KEYS: KeyboardFeel = { actuationMm: 1.2, rapidTrigger: true, rtPressMm: 0.3, rtReleaseMm: 0.3, socd: null };

function memory(initial: string | null = null) {
  const saves: string[] = [];
  let text = initial;
  let fail: string | null = null;
  const persist: Persist = {
    load: async () => text,
    save: async (json) => {
      if (fail) throw new Error(fail);
      saves.push(json);
      text = json;
    },
  };
  return { persist, saves, text: () => text, failWith: (m: string | null) => (fail = m) };
}

const dev = (id: string, kind: "mouse" | "keyboard" = "mouse", name = id): PresentDevice => ({ id, kind, name });
const from = (deviceId: string, name = deviceId) => ({ deviceId, name });

// ---------------------------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------------------------

test("a mouse feel is read back only if it has usable DPI", () => {
  assert.deepEqual(mouseFeelOf(MOUSE), MOUSE);
  assert.equal(mouseFeelOf(null), null);
  assert.equal(mouseFeelOf({ ...MOUSE, stages: [] }), null);
  assert.equal(mouseFeelOf({ ...MOUSE, stages: [400, "x"] }), null);
  assert.equal(mouseFeelOf({ ...MOUSE, stages: [400, NaN] }), null);
  assert.equal(mouseFeelOf({ ...MOUSE, stages: [10] }), null, "below any real DPI");
  assert.equal(mouseFeelOf({ ...MOUSE, stages: Array(40).fill(800) }), null);
  assert.equal(mouseFeelOf({ stages: "800" }), null);
});

test("the rest of a mouse feel falls back to 'not saved' rather than to a wrong value", () => {
  const f = mouseFeelOf({ ...MOUSE, active: 9, pollingHz: -4, lod: { kind: "mm", mm: "far" }, debounceMs: 1e9, angleSnapping: "yes", motionSync: true })!;
  assert.equal(f.active, 0, "an active step outside the list becomes the first");
  assert.equal(f.pollingHz, null);
  assert.equal(f.lod, null);
  assert.equal(f.debounceMs, null);
  assert.equal(f.angleSnapping, null);
  assert.equal(f.motionSync, true);
  assert.deepEqual(mouseFeelOf({ ...MOUSE, lod: { kind: "mm", mm: 1.2, min: 0.7, max: 1.7 } })!.lod, { kind: "mm", mm: 1.2, min: 0.7, max: 1.7 });
  assert.deepEqual(mouseFeelOf({ ...MOUSE, lod: { kind: "mm", mm: 1.2, min: 2, max: 1 } })!.lod, { kind: "mm", mm: 1.2 }, "a range that runs backwards is dropped");
  assert.equal(mouseFeelOf({ ...MOUSE, lod: { kind: "level", level: "Huge" } })!.lod, null);
});

test("a keyboard feel is read back, and one that holds nothing is not a feel", () => {
  assert.deepEqual(keyboardFeelOf(KEYS), KEYS);
  assert.equal(keyboardFeelOf({}), null);
  assert.equal(keyboardFeelOf({ actuationMm: 0 }), null);
  assert.equal(keyboardFeelOf({ actuationMm: 99 }), null);
  assert.equal(keyboardFeelOf(null), null);
  const f = keyboardFeelOf({ ...KEYS, socd: [{ a: "A", b: "D", mode: "last" }, { a: "A", b: "D", mode: "bogus" }, { a: "", b: "D", mode: "last" }, 7] })!;
  assert.deepEqual(f.socd, [{ a: "A", b: "D", mode: "last" }]);
  assert.equal(keyboardFeelOf({ ...KEYS, socd: "A+D" })!.socd, null);
});

test("sens: positive numbers only", () => {
  assert.deepEqual(sensOf({ cs2: 0.55, valorant: 0.173 }), { cs2: 0.55, valorant: 0.173 });
  assert.deepEqual(sensOf({ cs2: 0, valorant: -1 }), { cs2: null, valorant: null });
  assert.deepEqual(sensOf({ cs2: "1", valorant: 5000 }), { cs2: null, valorant: null });
  assert.deepEqual(sensOf(undefined), { cs2: null, valorant: null });
});

test("a profile round-trips, and a wrong version or shape is dropped", () => {
  const p = emptyProfile(5);
  p.mouse = { feel: MOUSE, from: { deviceId: "mouse:atk", name: "X1 V2 Air+", brand: "ATK", savedAt: 4 } };
  p.keyboard = { feel: KEYS, from: { deviceId: "kb:falchion", name: "Falchion", savedAt: 3 } };
  p.sens = { cs2: 0.55, valorant: null };
  assert.deepEqual(profileOf(JSON.parse(JSON.stringify(p))), p);
  assert.equal(profileOf({ ...p, version: 2 }), null);
  assert.equal(profileOf("x"), null);
  assert.equal(profileOf(null), null);
  // A damaged part is dropped; the other part survives.
  const half = profileOf({ ...p, mouse: { feel: { stages: [] }, from: p.mouse!.from } })!;
  assert.equal(half.mouse, null);
  assert.ok(half.keyboard);
  assert.equal(profileOf({ ...p, mouse: { feel: MOUSE, from: { name: "no id" } } })!.mouse, null, "a feel with no source is not trusted");
});

test("two feels are the same whatever order their keys were written in", () => {
  assert.equal(sameFeel(MOUSE, { ...MOUSE }), true);
  assert.equal(sameFeel({ a: 1, b: { y: 2, x: 1 } }, { b: { x: 1, y: 2 }, a: 1 }), true);
  assert.equal(sameFeel(MOUSE, { ...MOUSE, active: 2 }), false);
  assert.equal(sameFeel(MOUSE, { ...MOUSE, stages: [400, 800] }), false);
  assert.equal(sameFeel({ ...MOUSE, lod: undefined }, { ...MOUSE, lod: undefined }), true);
  // What is saved goes through the reader, and still equals what the device reports.
  assert.equal(sameFeel(mouseFeelOf(MOUSE), MOUSE), true);
  assert.equal(sameFeel(keyboardFeelOf(KEYS), KEYS), true);
});

test("an empty profile is empty", () => {
  assert.equal(isEmptyProfile(null), true);
  assert.equal(isEmptyProfile(emptyProfile()), true);
  const p = emptyProfile();
  p.sens.cs2 = 1;
  assert.equal(isEmptyProfile(p), false);
});

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

test("a stored document: damaged text, wrong versions and odd lists start fresh", () => {
  assert.deepEqual(docOf(null), emptyDoc());
  assert.deepEqual(docOf("not json"), emptyDoc());
  assert.deepEqual(docOf('{"version":2}'), emptyDoc());
  assert.deepEqual(docOf("[]"), emptyDoc());
  const d = docOf(JSON.stringify({ version: 1, profile: null, seen: ["mouse:atk", "mouse:atk", 4, "", "x".repeat(200), "kb:x68"], baselined: true, last: { mouse: { id: "mouse:atk", at: 9 }, keyboard: { id: 3, at: "x" } } }));
  assert.deepEqual(d.seen, ["mouse:atk", "kb:x68"]);
  assert.equal(d.baselined, true);
  assert.deepEqual(d.last, { mouse: { id: "mouse:atk", at: 9 }, keyboard: null });
});

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

test("saving a feel keeps it, marks its device seen and survives a restart", async () => {
  const m = memory();
  const s = createFeelStore(m.persist, () => 1000);
  await s.saveFrom("mouse", MOUSE, from("mouse:atk", "X1 V2 Air+"));
  assert.equal(s.getState().loaded, true);
  assert.deepEqual(s.getState().profile!.mouse, { feel: MOUSE, from: { deviceId: "mouse:atk", name: "X1 V2 Air+", savedAt: 1000 } });
  assert.deepEqual(s.getState().seen, ["mouse:atk"]);
  await s.saveFrom("keyboard", KEYS, from("kb:falchion"));
  await s.setSens({ cs2: 0.55, valorant: null });

  const again = createFeelStore(memory(m.text()).persist);
  await again.ready();
  assert.deepEqual(again.getState().profile, s.getState().profile);
  assert.deepEqual(again.getState().seen, ["mouse:atk", "kb:falchion"]);
  assert.equal(again.getState().profile!.sens.cs2, 0.55);
});

test("saving the mouse part leaves the keyboard part alone, and the other way round", async () => {
  const s = createFeelStore(memory().persist, () => 1);
  await s.saveFrom("keyboard", KEYS, from("kb:falchion"));
  await s.saveFrom("mouse", MOUSE, from("mouse:atk"));
  await s.saveFrom("mouse", { ...MOUSE, pollingHz: 8000 }, from("mouse:logitech"));
  const p = s.getState().profile!;
  assert.equal(p.mouse!.feel.pollingHz, 8000);
  assert.equal(p.mouse!.from.deviceId, "mouse:logitech");
  assert.deepEqual(p.keyboard!.feel, KEYS);
});

test("something that is not a feel is not saved", async () => {
  const m = memory();
  const s = createFeelStore(m.persist);
  await s.saveFrom("mouse", { ...MOUSE, stages: [] }, from("mouse:atk"));
  assert.equal(s.getState().profile, null);
  assert.deepEqual(m.saves, []);
});

test("forgetting one part, or all of it", async () => {
  const s = createFeelStore(memory().persist);
  await s.saveFrom("mouse", MOUSE, from("mouse:atk"));
  await s.saveFrom("keyboard", KEYS, from("kb:falchion"));
  await s.forget("mouse");
  assert.equal(s.getState().profile!.mouse, null);
  assert.ok(s.getState().profile!.keyboard);
  await s.forget();
  assert.equal(isEmptyProfile(s.getState().profile), true);
  await createFeelStore(null).forget("mouse");
});

test("a failed save is reported and the feel stays in memory", async () => {
  const m = memory();
  const s = createFeelStore(m.persist);
  m.failWith("disk full");
  await s.saveFrom("mouse", MOUSE, from("mouse:atk"));
  assert.equal(s.getState().saveError, "disk full");
  assert.ok(s.getState().profile!.mouse);
  m.failWith(null);
  await s.setSens({ cs2: 1, valorant: null });
  assert.equal(s.getState().saveError, null);
  assert.equal(m.saves.length, 1);
});

test("storage that won't load starts empty instead of failing", async () => {
  const s = createFeelStore({ load: () => Promise.reject(new Error("nope")), save: async () => undefined });
  await s.ready();
  assert.equal(s.getState().loaded, true);
  assert.equal(s.getState().profile, null);
});

test("writes go out in the order they were made", async () => {
  const order: number[] = [];
  const slow: Persist = {
    load: async () => null,
    save: async (json) => {
      const n = JSON.parse(json).seen.length as number;
      await new Promise((r) => setTimeout(r, n === 1 ? 20 : 0));
      order.push(n);
    },
  };
  const s = createFeelStore(slow);
  await Promise.all([s.markSeen("a"), s.markSeen("b"), s.markSeen("c")]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("listeners hear about changes and can stop listening", async () => {
  const s = createFeelStore(null);
  let n = 0;
  const off = s.subscribe(() => n++);
  await s.markSeen("a");
  const heard = n;
  assert.ok(heard >= 1);
  off();
  await s.markSeen("b");
  assert.equal(n, heard);
});

// ---------------------------------------------------------------------------------------------
// New devices
// ---------------------------------------------------------------------------------------------

test("the first look takes everything plugged in as seen, with or without a feel", async () => {
  const s = createFeelStore(memory().persist);
  await s.observe([dev("mouse:atk"), dev("kb:falchion", "keyboard")]);
  assert.equal(s.getState().baselined, true);
  assert.deepEqual(s.getState().seen, ["mouse:atk", "kb:falchion"]);
  assert.deepEqual(pendingOffers(s.getState(), [dev("mouse:atk")]), []);
});

test("after that, a new mouse is an offer only when there is a mouse feel to match", async () => {
  const s = createFeelStore(memory().persist);
  await s.observe([dev("mouse:atk")]);
  // No feel yet: a new mouse is settled at once and never offered later.
  await s.observe([dev("mouse:atk"), dev("mouse:om:1532:00c1")]);
  assert.ok(s.getState().seen.includes("mouse:om:1532:00c1"));

  await s.saveFrom("mouse", MOUSE, from("mouse:atk"));
  const viper = dev("mouse:om:1532:00c1");
  const pulsar = dev("mouse:om:3710:5406", "mouse", "Pulsar");
  assert.deepEqual(pendingOffers(s.getState(), [viper, pulsar]).map((d) => d.id), [pulsar.id]);
  await s.observe([dev("mouse:atk"), viper, pulsar]);
  assert.deepEqual(pendingOffers(s.getState(), [dev("mouse:atk"), viper, pulsar]).map((d) => d.id), [pulsar.id], "the Viper was seen before the feel existed; the Pulsar is new");
  assert.equal(isOffered(s.getState(), pulsar), true);
  assert.equal(isOffered(s.getState(), viper), false);
});

test("a new keyboard is offered only when a keyboard feel exists; the mouse feel doesn't count", async () => {
  const s = createFeelStore(memory().persist);
  await s.observe([]);
  await s.saveFrom("mouse", MOUSE, from("mouse:atk"));
  const board = dev("kb:31e3:1322", "keyboard", "Wooting 60HE+");
  await s.observe([board]);
  assert.deepEqual(pendingOffers(s.getState(), [board]), []);
  await s.saveFrom("keyboard", KEYS, from("kb:falchion"));
  const other = dev("kb:babao", "keyboard");
  await s.observe([board, other]);
  assert.deepEqual(pendingOffers(s.getState(), [other]).map((d) => d.id), ["kb:babao"]);
});

test("an offer waits until the person deals with it, also after a restart", async () => {
  const m = memory();
  const s = createFeelStore(m.persist);
  await s.observe([dev("mouse:atk")]);
  await s.saveFrom("mouse", MOUSE, from("mouse:atk"));
  const pulsar = dev("mouse:om:3710:5406");
  await s.observe([dev("mouse:atk"), pulsar]);
  assert.equal(isOffered(s.getState(), pulsar), true);

  const later = createFeelStore(memory(m.text()).persist);
  await later.ready();
  assert.equal(isOffered(later.getState(), pulsar), true, "still new after a restart");
  await later.markSeen(pulsar.id);
  assert.equal(isOffered(later.getState(), pulsar), false);
  const third = createFeelStore(memory(JSON.stringify({ ...JSON.parse(m.text()!), seen: later.getState().seen })).persist);
  await third.ready();
  assert.equal(isOffered(third.getState(), pulsar), false);
});

test("the device the feel came from is never offered itself, and nothing is offered before the seen list exists", async () => {
  const s = createFeelStore(null);
  await s.saveFrom("mouse", MOUSE, from("mouse:atk"));
  assert.equal(isOffered(s.getState(), dev("mouse:atk")), false);
  assert.deepEqual(pendingOffers({ baselined: false, seen: [], profile: s.getState().profile }, [dev("mouse:new")]), []);
  assert.deepEqual(pendingOffers({ baselined: true, seen: [], profile: null }, [dev("mouse:new")]), []);
});

test("a long run of devices keeps the seen list bounded", async () => {
  const s = createFeelStore(null);
  await s.observe([]);
  for (let i = 0; i < 450; i++) await s.markSeen(`mouse:${i}`);
  assert.equal(s.getState().seen.length, 400);
  assert.equal(s.getState().seen.at(-1), "mouse:449");
});

// ---------------------------------------------------------------------------------------------
// Suggestion
// ---------------------------------------------------------------------------------------------

test("the suggestion is the mouse configured most recently, among the ones whose settings are known", async () => {
  let t = 10_000;
  const s = createFeelStore(memory().persist, () => t);
  const atk = dev("mouse:atk");
  const logi = dev("mouse:logitech");
  const board = dev("kb:falchion", "keyboard");
  const everything = () => true;
  assert.equal(suggestSource(s.getState(), "mouse", [atk, logi], everything)!.id, "mouse:atk", "nothing configured yet: the first");
  await s.noteConfigured("mouse", "mouse:logitech");
  assert.equal(suggestSource(s.getState(), "mouse", [atk, logi, board], everything)!.id, "mouse:logitech");
  assert.equal(suggestSource(s.getState(), "mouse", [atk, logi], (id) => id === "mouse:atk")!.id, "mouse:atk", "the latest one hasn't been read this session");
  assert.equal(suggestSource(s.getState(), "keyboard", [atk, logi, board], everything)!.id, "kb:falchion");
  t += 5000;
  await s.noteConfigured("mouse", "mouse:atk");
  assert.equal(suggestSource(s.getState(), "mouse", [atk, logi], everything)!.id, "mouse:atk");
  assert.equal(suggestSource(s.getState(), "mouse", [], everything), null);
  assert.equal(suggestSource(s.getState(), "mouse", [atk], () => false), null);
});

test("a burst of writes to one device is one 'configured'", async () => {
  const m = memory();
  let t = 1000;
  const s = createFeelStore(m.persist, () => t);
  await s.noteConfigured("mouse", "mouse:atk");
  t += 500;
  await s.noteConfigured("mouse", "mouse:atk");
  assert.equal(m.saves.length, 1, "within two seconds: nothing more to keep");
  assert.equal(s.getState().last.mouse!.at, 1000);
  t += 5000;
  await s.noteConfigured("mouse", "mouse:atk");
  assert.equal(m.saves.length, 2);
  assert.equal(s.getState().last.mouse!.at, 6500);
});

// ---------------------------------------------------------------------------------------------
// Where it is kept
// ---------------------------------------------------------------------------------------------

test("the feel has a file on the desktop and a place in the browser's storage, and the helper never gets it", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const rust = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
  const web = readFileSync(join(root, "src/lib/web/tauri-core.ts"), "utf8");
  const persist = readFileSync(join(root, "src/lib/feel/persist.ts"), "utf8");
  for (const cmd of ["feel_load", "feel_save"]) {
    assert.match(rust, new RegExp(`fn ${cmd}\\(`), `${cmd} in Rust`);
    assert.match(rust, new RegExp(`\\n\\s+${cmd},\\r?\\n`), `${cmd} registered`);
    assert.match(web, new RegExp(`${cmd}: async`), `${cmd} in the website's storage`);
    assert.match(persist, new RegExp(`"${cmd}"`), `${cmd} used`);
    assert.ok(!HELPER_COMMANDS.has(cmd), `${cmd} stays on this machine`);
  }
  // One small file in the app data folder, checked as JSON before it is written, size-limited.
  assert.match(rust, /const FEEL_FILE: &str = "feel\.json";/);
  assert.match(rust, /FEEL_MAX_BYTES/);
  assert.match(rust, /serde_json::from_str::<serde_json::Value>\(&json\)\.map_err\(\|e\| format!\("Not a saved feel/);
});
