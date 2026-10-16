// The room light follows the colours last set on your lights (src/lib/lighting/glow.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SUNSET, glowColours, roomAccent } from "../src/lib/lighting/glow.ts";

test("no light set yet: the sunset", () => {
  assert.deepEqual(glowColours([]), [...SUNSET]);
});

test("the newest colours lead, the sunset fills in", () => {
  assert.deepEqual(glowColours(["#00c8ff"]), ["#00c8ff", SUNSET[0], SUNSET[1]]);
  assert.deepEqual(glowColours(["#00c8ff", "#33ff66", "#ff00aa", "#ffffff"]), ["#00c8ff", "#33ff66", "#ff00aa"]);
});

test("a light set nearly off doesn't glow, and a colour counts once", () => {
  assert.deepEqual(glowColours(["#101010", "#00C8FF", "#00c8ff"]), ["#00c8ff", SUNSET[0], SUNSET[1]]);
});

test("the room accent: a bright colour stays, dark text on it", () => {
  assert.deepEqual(roomAccent("#FF5E3A"), { accent: "#ff5e3a", fg: "#08080a" });
});

test("the room accent: a deep blue is lifted until it reads on the near-black app", () => {
  const { accent, fg } = roomAccent("#0000ff");
  assert.notEqual(accent, "#0000ff");
  const n = parseInt(accent.slice(1), 16);
  assert.ok((n & 255) === 255 && ((n >> 16) & 255) > 0, accent);
  assert.equal(fg, "#08080a");
});
