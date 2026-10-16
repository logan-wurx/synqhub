// The Devices home's groups and type filter (src/lib/device-groups.ts): when the filter is offered, the order of the
// groups, and that a pick that no longer applies falls back to every card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { byGroup, filterEntries, groupOf, groupsIn } from "../src/lib/device-groups.ts";

const cards = (...kinds: string[]) => kinds.map((kind, i) => ({ kind, id: `${kind}-${i}` }));

test("groups: the order on the home, sound right after the keyboards, a headset counted as sound", () => {
  const home = cards("light", "controller", "sound", "keyboard", "mouse", "headset", "mouse");
  assert.deepEqual(byGroup(home).map((e) => e.id), ["mouse-4", "mouse-6", "keyboard-3", "sound-2", "headset-5", "controller-1", "light-0"]);
  assert.deepEqual(groupsIn(home).map((g) => `${g.label} ${g.n}`), ["Mice 2", "Keyboards 1", "Sound 2", "Controllers 1", "Lights 1"]);
  // A kind added later without a group of its own still gets one, named after it, after the known ones.
  assert.deepEqual(groupOf("speaker"), { id: "speaker", label: "Speakers" });
  assert.deepEqual(byGroup(cards("speaker", "mouse")).map((e) => e.kind), ["mouse", "speaker"]);
});

test("filter: offered only for a long, mixed list", () => {
  // The developer's desk: two mice, two keyboards, the sound, the pad and two lamps (plus All lamps) is long and mixed.
  const desk = cards("mouse", "mouse", "keyboard", "keyboard", "sound", "controller", "light", "light", "light");
  assert.equal(filterEntries(desk, "all").offered, true);
  // A mouse, a keyboard and the sound: no filter, whatever was picked before.
  const small = cards("mouse", "keyboard", "sound");
  assert.deepEqual(filterEntries(small, "lights"), { offered: false, groups: groupsIn(small), value: "all", shown: small });
  // Many cards of only two kinds: no filter either.
  assert.equal(filterEntries(cards("controller", "controller", "controller", "controller", "controller", "controller", "mouse"), "all").offered, false);
});

test("filter: a pick shows its group; a group that went away shows everything", () => {
  const desk = cards("mouse", "mouse", "keyboard", "sound", "controller", "light", "light");
  const lights = filterEntries(desk, "lights");
  assert.equal(lights.value, "lights");
  assert.deepEqual(lights.shown.map((e) => e.kind), ["light", "light"]);
  const gone = filterEntries(desk, "monitors");
  assert.equal(gone.value, "all");
  assert.equal(gone.shown.length, desk.length);
});

test("filter: counts devices, not cards (the All lamps card is shown under Lights but is not a lamp)", () => {
  const desk = [...cards("mouse", "keyboard", "sound", "controller", "light", "light"), { kind: "light", id: "all-lamps" }];
  const f = filterEntries(desk, "lights", (e) => e.id !== "all-lamps");
  assert.equal(f.groups.find((g) => g.id === "lights")?.n, 2);
  assert.equal(f.shown.length, 3, "the All lamps card is still shown");
});
