// A lamp's weak-signal state (src/lib/lighting/signal.ts): steady for a lamp hovering near the line, still following a
// real change. A lamp at the edge of reach sits around -87 to -94 dBm and used to flip on every scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "../src/lib/lighting/signal.ts";
import type { LampInfo } from "../src/lib/lighting/models.ts";

const lamp = (rssi: number): LampInfo => ({ id: "a4c138127a21", name: "Govee_H6076_7A21", sku: "H6076", rssi, heardMs: 500 });

function run(readings: number[]) {
  const history = new Map<string, number[]>();
  const states = new Map<string, boolean>();
  return readings.map((r) => settle(lamp(r), history, states).weak);
}

test("a lamp wobbling around the line keeps its state", () => {
  // In range at first, then single readings dipping past -92 (each of which used to grey the card out).
  const states = run([-87, -88, -93, -86, -94, -88, -95, -87, -89, -93, -88]);
  assert.ok(states.every((w) => w === false), JSON.stringify(states));
  // Weak at first, with single readings popping above the line: it stays weak.
  assert.ok(run([-95, -94, -90, -96, -91, -94, -95]).every((w) => w === true));
});

test("a real move across the line still changes it", () => {
  const away = run([-86, -87, -86, -96, -97, -95, -96, -97]);
  assert.equal(away[0], false);
  assert.equal(away.at(-1), true, "carried away: weak once most recent readings are well below the line");
  const back = run([-96, -95, -97, -85, -84, -86, -85]);
  assert.equal(back[0], true);
  assert.equal(back.at(-1), false, "brought back: in range once most recent readings are well above it");
});
