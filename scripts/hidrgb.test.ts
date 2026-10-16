// Wave L4, the pure parts: USB RGB hubs (src/lib/lighting/hidrgb: the table, the reports SYNQ builds, the guard and
// its case file, sessions against simulated hubs) and Windows Dynamic Lighting's effects (src/lib/lighting/lamparray.ts).
//   node --test scripts/hidrgb.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkHubFrame } from "../src/lib/lighting/hidrgb/guard.ts";
import { MODELS, colourFrames, findHub, findIdentifyOnly, identifyFrames, maxLeds, reportedLeds, type Family } from "../src/lib/lighting/hidrgb/protocol.ts";
import { HubSession } from "../src/lib/lighting/hidrgb/session.ts";
import { simulateHub } from "../src/lib/lighting/hidrgb/sim.ts";
import { colorsAt, sameDevice, simLampArray } from "../src/lib/lighting/lamparray.ts";
import { caseLines } from "./hidrgb-fixture.ts";

const FAMILIES: Family[] = ["nzxt-hue2", "corsair-node", "lianli-sl"];
const first = (f: Family) => MODELS.find((m) => m.family === f)!;

test("the table: 19 hubs in three families; the Nautilus LCD Cap is only named; nothing ASUS or motherboard", () => {
  assert.equal(MODELS.length, 19);
  assert.deepEqual([...new Set(MODELS.map((m) => m.family))].sort(), [...FAMILIES].sort());
  assert.equal(findHub("1E71", "2011")?.channels, 6);
  assert.equal(findHub(0x1b1c, 0x0c57), null, "the Nautilus cap is never driven");
  assert.equal(findIdentifyOnly(0x1b1c, 0x0c57)?.name, "Corsair Nautilus LCD Cap");
  assert.ok(MODELS.every((m) => m.vid !== "0b05" && !/motherboard/i.test(m.name)));
  assert.equal(findHub("1e71", "2005"), null, "NZXT's motherboard device is left out");
});

test("rgb-frames.txt is still what the guard says (regenerate with node scripts/hidrgb-fixture.ts)", () => {
  const file = readFileSync(new URL("../src/lib/lighting/hidrgb/rgb-frames.txt", import.meta.url), "utf8").trim().split(/\r?\n/);
  assert.deepEqual(file, caseLines());
  assert.ok(file.filter((l) => l.startsWith("1")).length > 500);
});

test("every report SYNQ builds passes; out-of-range channels and LED counts build nothing", () => {
  for (const m of MODELS) {
    for (const f of identifyFrames(m)) assert.equal(checkHubFrame(m, f).ok, true, `${m.pid} identify`);
    for (let ch = 0; ch < m.channels; ch++) {
      const leds = m.family === "lianli-sl" ? 64 : maxLeds(m);
      for (const f of colourFrames(m, ch, [10, 20, 30], leds)!) assert.equal(checkHubFrame(m, f).ok, true, `${m.pid} ch${ch}`);
    }
    assert.equal(colourFrames(m, m.channels, [1, 2, 3], 16), null);
    assert.equal(colourFrames(m, 0, [1, 2, 3], maxLeds(m) + 1), null);
  }
  const nzxt = first("nzxt-hue2");
  const frames = colourFrames(nzxt, 1, [255, 10, 0], 21)!;
  assert.equal(frames.length, 3, "20 LEDs, 1 LED, apply");
  assert.deepEqual(Array.from(frames[0].data.slice(0, 6)), [0x10, 2, 0, 10, 255, 0], "green, red, blue");
  assert.equal(colourFrames(first("lianli-sl"), 0, [1, 2, 3], 20), null, "Lian Li takes whole fans");
});

test("the guard refuses what SYNQ never sends", () => {
  const corsair = first("corsair-node");
  const f = (reportId: number, bytes: number[], len = 64) => {
    const data = new Uint8Array(len);
    data.set(bytes);
    return { reportId, data };
  };
  assert.equal(checkHubFrame(corsair, f(0, [0x38, 0, 0x02])).ok, false, "software mode");
  assert.equal(checkHubFrame(corsair, f(0, [0x32, 0, 0, 10, 0])).ok, false, "direct");
  assert.equal(checkHubFrame(corsair, f(0, [0x35, 0, 0, 10, 0x00])).ok, false, "rainbow");
  const nzxt = first("nzxt-hue2");
  assert.equal(checkHubFrame(nzxt, f(0x62, [0x01, 1, 50], 63)).ok, false, "fan speed");
  assert.equal(checkHubFrame(nzxt, f(0x22, [0x10, 1 << 6, 0], 63)).ok, false, "channel 7 on a 6-channel hub");
});

for (const family of FAMILIES) {
  test(`session (${family}): identifies, refuses until allowed, sends one colour, never a refused report`, async () => {
    const m = family === "nzxt-hue2" ? findHub("1e71", "2011")! : first(family);
    const sim = simulateHub(m);
    const backups: string[] = [];
    const s = new HubSession(sim, m, { saveBackup: async (prefix, json) => (backups.push(json), `${prefix}.json`) });
    const facts = await s.identify();
    if (family === "nzxt-hue2") {
      assert.equal(facts.firmware, "1.13.0");
      assert.equal(reportedLeds(facts, 0), 36, "two F120 RGB fans");
      assert.equal(reportedLeds(facts, 1), 10, "a HUE 2 strip");
    }
    if (family === "corsair-node") assert.equal(facts.firmware, "0.10.4");
    const before = sim.sent.length;
    await assert.rejects(() => s.setChannel(0, [255, 0, 128], 16), /until you allow/);
    assert.equal(sim.sent.length, before);
    s.setAllowChanges(true);
    await s.setChannel(0, [255, 0, 128], 16);
    assert.deepEqual(sim.lit.get(0), [255, 0, 128]);
    assert.equal(backups.length, 1, "what the hub reported is kept before the first change");
    assert.ok(JSON.parse(backups[0]).note.includes("can't report"));
    assert.equal(s.previous(0), null, "nothing sent before: nothing to put back");
    await s.setChannel(0, [0, 255, 0], 16);
    assert.equal(await s.putBack(0), true);
    assert.deepEqual(sim.lit.get(0), [255, 0, 128], "Put back sends the colour before the latest");
    assert.equal(backups.length, 1);
    await assert.rejects(() => s.setChannel(m.channels, [1, 2, 3], 16), /isn't one this hub has/);
    assert.deepEqual(sim.forbidden, []);
  });
}

test("Dynamic Lighting effects: one colour, a breath that never goes dark, a rainbow and a wave across the lamps", () => {
  const info = simLampArray();
  assert.equal(info.lamps.length, 96);
  assert.ok(colorsAt(info, "solid", [10, 20, 30], 5).every((c) => c[0] === 10 && c[2] === 30));
  const dim = colorsAt(info, "breathe", [200, 200, 200], 0)[0];
  assert.ok(dim[0] > 20 && dim[0] < 40, `darkest ${dim[0]}`);
  const rainbow = colorsAt(info, "rainbow", [0, 0, 0], 0);
  assert.notDeepEqual(rainbow[0], rainbow[15], "left and right differ");
  const wave = colorsAt(info, "wave", [255, 0, 0], 0.7);
  assert.ok(wave.every((c) => c[1] === 0 && c[0] >= 30 && c[0] <= 255));
  assert.equal(sameDevice({ vid: "0000", pid: "0000" }, { vid: "0000", pid: "0000" }), false, "no ids: no match");
  assert.equal(sameDevice({ vid: "046d", pid: "c0a0" }, { vid: "046D", pid: "C0A0" }), true);
});
