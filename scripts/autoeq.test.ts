// AutoEq presets (src/lib/audio/autoeq.ts): reading the results index, finding a model by name however it is typed,
// the preset address, and a ParametricEQ.txt turned into SYNQ's EQ inside the engine's limits. Fixtures are made
// up in AutoEq's formats; no measurement data is copied here.
//   node --test scripts/autoeq.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formOf, importParametricEq, parseIndex, presetName, presetUrl, searchAutoEq, type EqLimits } from "../src/lib/audio/autoeq.ts";

const INDEX = `# Recommended Results
This is a list of recommended results.

- [7Hz Salnotes Zero 2](./ToneDeafMonk/in-ear/7Hz%20Salnotes%20Zero%202)
- [7Hz x Crinacle Zero 2](./crinacle/711%20in-ear/7Hz%20x%20Crinacle%20Zero%202)
- [Sennheiser HD 800](./oratory1990/over-ear/Sennheiser%20HD%20800)
- [Sennheiser HD 800 S](./oratory1990/over-ear/Sennheiser%20HD%20800%20S)
- [Apple AirPods (2nd generation)](./Rtings/earbud/Apple%20AirPods%20(2nd%20generation))
- [SteelSeries Arctis Nova Pro Wireless](./Rtings/over-ear/SteelSeries%20Arctis%20Nova%20Pro%20Wireless)
- [broken](./nowhere)
`;

const LIMITS: EqLimits = { maxBoostDb: 6, maxCutDb: -24, preampRangeDb: [-30, 6], freqRangeHz: [10, 22000], qRange: [0.1, 20], maxFilters: 20 };

test("the index: names, sources, rigs, paths; lines that aren't results are skipped", () => {
  const list = parseIndex(INDEX);
  assert.equal(list.length, 6);
  assert.deepEqual(list[1], { name: "7Hz x Crinacle Zero 2", source: "crinacle", rig: "711 in-ear", path: "crinacle/711 in-ear/7Hz x Crinacle Zero 2" });
  assert.deepEqual(list.map(formOf), ["IEM", "IEM", "Headphones", "Headphones", "Earbuds", "Headphones"]);
});

test("search: every word typed, punctuation ignored, exact words first", () => {
  const list = parseIndex(INDEX);
  assert.deepEqual(searchAutoEq(list, "Zero:2").map((e) => e.name), ["7Hz Salnotes Zero 2", "7Hz x Crinacle Zero 2"]);
  assert.equal(searchAutoEq(list, "hd 800 s")[0].name, "Sennheiser HD 800 S");
  assert.equal(searchAutoEq(list, "hd800")[0].name, "Sennheiser HD 800");
  assert.equal(searchAutoEq(list, "nova pro").length, 1);
  assert.deepEqual(searchAutoEq(list, "   "), []);
  assert.equal(searchAutoEq(list, "zero", 1).length, 1);
});

test("the preset's address is the model's folder plus its ParametricEQ.txt, encoded", () => {
  const e = parseIndex(INDEX)[4];
  assert.equal(presetUrl(e), "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/Rtings/earbud/Apple%20AirPods%20(2nd%20generation)/Apple%20AirPods%20(2nd%20generation)%20ParametricEQ.txt");
  assert.equal(presetName(e), "AutoEq · Apple AirPods (2nd generation)");
});

test("a ParametricEQ.txt becomes SYNQ's EQ", () => {
  const r = importParametricEq("Preamp: -4.2 dB\nFilter 1: ON LSC Fc 105 Hz Gain 3.5 dB Q 0.70\nFilter 2: ON PK Fc 2000 Hz Gain -2.0 dB Q 1.41\nFilter 3: ON HSC Fc 10000 Hz Gain 1.5 dB Q 0.70\n", LIMITS);
  assert.ok("state" in r);
  assert.equal(r.state.preamp, -4.2);
  assert.deepEqual(r.state.filters[0], { enabled: true, kind: "LSC", freq: 105, gain: 3.5, q: 0.7 });
  assert.equal(r.state.filters.length, 3);
  assert.deepEqual(r.adjusted, []);
});

test("values past the engine's limits are brought inside and said; nothing usable is an error", () => {
  const r = importParametricEq("Preamp: -9 dB\nFilter 1: ON PK Fc 40 Hz Gain 8.5 dB Q 0.5\nFilter 2: ON PK Fc 30000 Hz Gain -30 dB Q 40\nFilter 3: ON XYZ Fc 100 Hz Gain 1 dB Q 1\n", LIMITS);
  assert.ok("state" in r);
  assert.equal(r.state.filters[0].gain, 6);
  assert.deepEqual(r.state.filters[1], { enabled: true, kind: "PK", freq: 22000, gain: -24, q: 20 });
  assert.equal(r.adjusted.length, 3);
  assert.match(r.adjusted[0], /\+8.5 dB kept at \+6 dB/);
  const many = Array.from({ length: 22 }, (_, i) => `Filter ${i + 1}: ON PK Fc ${100 + i * 100} Hz Gain -1 dB Q 1`).join("\n");
  const m = importParametricEq(many, LIMITS);
  assert.ok("state" in m && m.state.filters.length === 20 && /2 filters past the 20/.test(m.adjusted[0]));
  assert.deepEqual(importParametricEq("Preamp: -3 dB\n", LIMITS), { error: "That file has no EQ filters in it." });
});
