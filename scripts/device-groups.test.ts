// The Devices home's groups (src/lib/device-groups.ts): which group each kind is in and the order they come in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { byGroup, groupOf, groupsIn } from "../src/lib/device-groups.ts";

const cards = (...kinds: string[]) => kinds.map((kind, i) => ({ kind, id: `${kind}-${i}` }));

test("groups: the order on the home, sound right after the keyboards, a headset counted as sound", () => {
  const home = cards("light", "controller", "sound", "keyboard", "mouse", "headset", "mouse");
  assert.deepEqual(byGroup(home).map((e) => e.id), ["mouse-4", "mouse-6", "keyboard-3", "sound-2", "headset-5", "controller-1", "light-0"]);
  assert.deepEqual(groupsIn(home).map((g) => `${g.label} ${g.n}`), ["Mice 2", "Keyboards 1", "Sound 2", "Controllers 1", "Lights 1"]);
  // A kind added later without a group of its own still gets one, named after it, after the known ones.
  assert.deepEqual(groupOf("speaker"), { id: "speaker", label: "Speakers" });
  assert.deepEqual(byGroup(cards("speaker", "mouse")).map((e) => e.kind), ["mouse", "speaker"]);
});
