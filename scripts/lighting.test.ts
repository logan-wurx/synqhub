// Govee lights: the frames, the per-model guard, the fixtures and the lamp controller against the simulated lights (no
// Bluetooth, no Tauri). The bridge's half of the guard is held to the same fixture by
// src-tauri/src/lighting/govee/guard.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CMD,
  a3Frames,
  allSegments,
  checkLightFrame,
  checkLightUpload,
  colourFrame,
  frame,
  gradient,
  kelvinRgb,
  musicFrame,
  parseReport,
  powerFrame,
  queryFrame,
  segmentFrames,
  whiteFrame,
  type UploadKind,
} from "../src/lib/lighting/govee/frames.ts";
import { sceneBlob, sceneData, scenesFor } from "../src/lib/lighting/govee/scenes.generated.ts";
import { DIY_STYLES } from "../src/lib/lighting/govee/diy.ts";
import { DIALECT, specOf, type GoveeSpec } from "../src/lib/lighting/govee/spec.ts";
import { GOVEE_MODELS } from "../src/lib/lighting/govee/models.generated.ts";
import { SimGoveeLamp, changedPages, simLamp, simSyncStart, simSyncStop } from "../src/lib/lighting/govee/sim.ts";
import { LIGHT_MODELS, SIM_LAMPS, groupNoun, lampTitle, nounOf } from "../src/lib/lighting/models.ts";
import { CONFIRM_MS, LampController, LampGroup, diyBody } from "../src/lib/lighting/lamp.ts";
import { photoKeyFor } from "../src/lib/device-images.ts";
import { shapeClass } from "../src/lib/device-shape.ts";
import type { LampLink } from "../src/lib/lighting/link.ts";
import { GOVEE_FRAMES, goveeFixtureText } from "./govee-fixtures.ts";
import { BIN_OUT, MODELS_OUT, RS_OUT, TS_OUT, generated } from "./gen-govee-scenes.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits until `cond()` holds, up to `ms`: the controller and the simulated lamp run on timers, which a busy machine
 * fires late. The checks stay as strict; only the wait is generous. */
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  return cond();
}
const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const text = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const H6076 = specOf("H6076")!;

test("the generated tables and the frame fixture are what the scripts write", () => {
  const g = generated();
  assert.equal(text(MODELS_OUT), g.models, "run node scripts/gen-govee-scenes.ts");
  assert.equal(text(TS_OUT), g.ts, "run node scripts/gen-govee-scenes.ts");
  assert.equal(text(RS_OUT), g.rs, "run node scripts/gen-govee-scenes.ts");
  assert.deepEqual(new Uint8Array(readFileSync(BIN_OUT)), g.bin, "run node scripts/gen-govee-scenes.ts");
  assert.equal(text(GOVEE_FRAMES), goveeFixtureText(), "run node scripts/govee-fixtures.ts");
  // The developer's lamp keeps its catalogue: 58 scenes, 49 with data.
  assert.equal(scenesFor("H6076").length, 58);
  assert.equal(scenesFor("H6076").filter((s) => s.blob).length, 49);
  assert.ok(Object.keys(GOVEE_MODELS).length >= 80, "every model with a catalogue, and the reference's measured ones");
});

test("the frames the reference captured, byte for byte", () => {
  // COMMANDS.md §2.3.4: blue on all 14 segments, and the app's own 2700 K frame (its RGB rendering differs from ours,
  // which the guard therefore refuses: SYNQ sends its own rendering).
  assert.equal(hex(colourFrame(H6076, DIALECT.typed, [0, 0, 255])).slice(0, 28), "330515010000ff0000000000ff3f");
  assert.equal(hex(whiteFrame(H6076, DIALECT.typed, 2700)).slice(0, 28), "33051501000000" + "0a8c" + hex(kelvinRgb(2700)) + "ff3f");
  assert.equal(checkLightFrame(H6076, Uint8Array.from([0x33, 0x05, 0x15, 0x01, 0, 0, 0, 0x0a, 0x8c, 0xff, 0xae, 0x54, 0xff, 0x3f, 0, 0, 0, 0, 0, 0x5a])).ok, false);
  // The other dialects (COMMANDS.md §2.3.1-3), as Beshelmek/govee_ble_lights sends 0x02.
  const bars = specOf("H6046")!;
  assert.equal(hex(colourFrame(bars, DIALECT.rgb, [1, 2, 3])).slice(0, 12), "330502010203");
  assert.equal(hex(colourFrame(bars, DIALECT.ic, [1, 2, 3])).slice(0, 16), "33050b010203ff7f", "0x0b masks name 15 segments at most");
  assert.equal(hex(colourFrame(bars, DIALECT.cct, [1, 2, 3])).slice(0, 22), "33050d0102030000000000");
  // A3 framing: the first frame carries 01 <count> <type>, then 14 bytes; the last frame's index is FF.
  const frames = a3Frames(0x02, sceneBlob(scenesFor("H6076")[0])!);
  assert.deepEqual([frames[0][0], frames[0][1], frames[0][2], frames[0][3], frames[0][4]], [0xa3, 0x00, 0x01, frames.length, 0x02]);
  assert.equal(frames.at(-1)![1], 0xff);
  // Reports: the power event and the queries the developer's lamp answered.
  assert.deepEqual(parseReport(frame([0xee, 0x30, 0x01, 0x00])), { kind: "power", on: false });
  assert.deepEqual(parseReport(frame([0xaa, 0x04, 0x23])), { kind: "brightness", value: 35 });
  assert.equal(allSegments(H6076), 0x3fff);
});

test("the guard refuses what the brief names, and holds each model to its own table", () => {
  const raw = (...b: number[]) => {
    const f = new Uint8Array(20);
    f.set(b);
    f[19] = f.slice(0, 19).reduce((x, y) => x ^ y, 0);
    return f;
  };
  for (const s of Object.values(GOVEE_MODELS).map((m) => specOf(m.sku)!))
    for (const f of [raw(0xe7, 0x01), raw(0xee, 0x30, 0x01), raw(0xa3, 0x00, 0x01), raw(0xaa, 0xb1), raw(0x33, 0x0f), raw(0x33, 0x05, 0x00), raw(0x33, 0x05, 0x16)]) assert.equal(checkLightFrame(s, f).ok, false, `${s.sku} ${hex(f)}`);
  // The H6076 takes only its proven dialect; an unverified model takes the four documented ones.
  assert.equal(checkLightFrame(H6076, colourFrame(specOf("H6046")!, DIALECT.rgb, [255, 0, 0])).ok, false);
  assert.equal(checkLightFrame(specOf("H6046")!, colourFrame(specOf("H6046")!, DIALECT.rgb, [255, 0, 0])).ok, true);
  // Scene data goes only with its own scene, on its own model.
  const scene = scenesFor("H6076").find((s) => s.blob)!;
  const blob = sceneBlob(scene)!;
  assert.equal(checkLightUpload(H6076, "scene", blob, scene.code).ok, true);
  assert.equal(checkLightUpload(H6076, "scene", blob).ok, false, "a scene upload names its scene");
  assert.equal(checkLightUpload(specOf("H7020")!, "scene", blob, scene.code).ok, false, "another model's scene");
  const changed = blob.slice();
  changed[10] ^= 1;
  assert.equal(checkLightUpload(H6076, "scene", changed, scene.code).ok, false, "byte for byte");
  assert.equal(checkLightUpload(H6076, "diy", diyBody({ id: "x", name: "x", family: 0, variant: 0, speed: 50, colours: [[255, 0, 0]] })).ok, true);
  assert.equal(checkLightUpload(specOf("H6046")!, "diy", diyBody({ id: "x", name: "x", family: 0, variant: 0, speed: 50, colours: [[255, 0, 0]] })).ok, false, "DIY only where the table has it");
  assert.equal(checkLightUpload(H6076, "diy", Uint8Array.from([7, 0, 50, 3, 1, 2, 3])).ok, false);
  // Every scene of every model: its code is allowed, its data matches the catalogue.
  for (const m of Object.values(GOVEE_MODELS)) {
    const s = specOf(m.sku)!;
    for (const sc of scenesFor(m.sku)) {
      assert.equal(checkLightFrame(s, frame([0x33, 0x05, 0x04, sc.code & 0xff, sc.code >> 8])).ok, true, `${m.sku} ${sc.code}`);
      if (sc.blob) assert.equal(checkLightUpload(s, "scene", sceneData(m.sku, sc.code)!, sc.code).ok, true);
    }
  }
});

function simLink(sim: SimGoveeLamp): LampLink & { sent: Uint8Array[][]; uploads: { kind: UploadKind; body: Uint8Array }[] } {
  const sent: Uint8Array[][] = [];
  const uploads: { kind: UploadKind; body: Uint8Array }[] = [];
  return {
    id: sim.spec.id,
    scheme: "encryption v1",
    sent,
    uploads,
    send: async (frames) => {
      sent.push([...frames]);
      for (const f of frames) sim.send(f);
    },
    upload: async (kind, body, code) => {
      uploads.push({ kind, body });
      return sim.upload(kind, body, code);
    },
    onReport: (cb) => sim.onReport(cb),
    onLost: () => () => {},
    sync: null,
    startSync: async (edge, vivid) => ({ edge, vivid }),
    stopSync: async () => {},
    onSync: () => () => {},
    onSyncStopped: () => () => {},
    close: async () => {},
  };
}

const controller = (sim: SimGoveeLamp) => new LampController(simLink(sim), sim.model as GoveeSpec);

test("a lamp through the controller: state confirmed by its reports, writes coalesced, scenes uploaded then applied", async () => {
  const sim = new SimGoveeLamp(SIM_LAMPS[0]);
  const link = simLink(sim);
  const lamp = new LampController(link, H6076);
  lamp.refresh();
  await until(() => lamp.view.firmware !== null && lamp.view.brightness !== null);
  assert.equal(lamp.view.firmware, "1.04.05");
  assert.equal(lamp.view.brightness, 35);
  // A dragged slider: twenty changes inside a few writes, the last value wins.
  for (let p = 1; p <= 20; p++) lamp.setBrightness(p * 5);
  await until(() => sim.brightness === 100);
  assert.ok(link.sent.length <= 4, `${link.sent.length} writes`);
  assert.equal(sim.brightness, 100);
  // Power: the lamp's own event confirms it.
  lamp.setPower(false);
  await until(() => !sim.power && lamp.view.power === false);
  assert.equal(sim.power, false);
  assert.equal(lamp.view.power, false);
  // A gradient across the 14 segments on a lamp that is off: it is turned on first, then gradual change off and
  // four pages.
  link.sent.length = 0;
  const stops = [
    [255, 0, 0],
    [0, 0, 255],
  ] as const;
  lamp.setGradient(stops);
  await until(() => link.sent.length >= 2 && !sim.gradual);
  assert.deepEqual(link.sent[0], [powerFrame(true)]);
  assert.equal(link.sent[1].length, 5);
  assert.equal(sim.power, true);
  assert.deepEqual(sim.segments, gradient(stops, 14));
  // A scene with data: the upload goes first, then the scene frame; a built-in one is the frame alone.
  const withData = scenesFor("H6076").find((s) => s.blob)!;
  await lamp.applyScene(withData);
  assert.equal(link.uploads.length, 1);
  assert.equal(sim.scene, withData.code);
  const builtIn = scenesFor("H6076").find((s) => !s.blob)!;
  await lamp.applyScene(builtIn);
  assert.equal(link.uploads.length, 1);
  assert.equal(sim.scene, builtIn.code);
  // DIY: the effect is uploaded, then applied from its slot.
  await lamp.applyDiy({ id: "d", name: "Party", family: 3, variant: 4, speed: 70, colours: [[255, 0, 0], [0, 255, 0]] });
  assert.equal(link.uploads.at(-1)!.kind, "diy");
  // Every frame the controller wrote passed the guard (the sim refuses anything else).
  assert.ok(link.sent.flat().every((f) => checkLightFrame(H6076, f).ok));
  assert.equal(segmentFrames(H6076, DIALECT.typed, gradient([[1, 2, 3]], 14)).length, 5);
  await lamp.close();
});

test("a light the table knows little about: its own colour mode and segment count are used once it says them", async () => {
  // The light bars report dialect 0x0b and 10 segments (the table's guess is 0x02 and one colour).
  const spec = SIM_LAMPS.find((s) => s.name.includes("H6046"))!;
  const sim = new SimGoveeLamp(spec);
  const lamp = controller(sim);
  assert.equal(lamp.dialect, DIALECT.rgb);
  assert.equal(lamp.segments, 1);
  lamp.refresh();
  await until(() => lamp.dialect === DIALECT.ic && lamp.segments === 10);
  assert.equal(lamp.view.segments.length, 10);
  lamp.paint(Array.from({ length: 10 }, (_, i) => (i < 5 ? [255, 0, 0] : [0, 0, 255])));
  await until(() => sim.segments[9].join() === "0,0,255");
  assert.deepEqual(sim.segments.map((c) => c.join()), [...Array(5).fill("255,0,0"), ...Array(5).fill("0,0,255")]);
  // A colour for the whole light names all ten segments; a brightness above 100 moves to the 254 scale.
  lamp.setColour([0, 255, 0]);
  await until(() => sim.segments.every((c) => c.join() === "0,255,0"));
  sim.brightness = 200;
  lamp.refresh();
  await until(() => lamp.view.brightness === 79);
  lamp.setBrightness(50);
  await until(() => sim.brightness === 127);
  assert.equal(sim.brightness, 127);
  await lamp.close();
});

test("after a burst of changes the lamp is asked what it shows, and its answer wins", async () => {
  const sim = new SimGoveeLamp(SIM_LAMPS[0]);
  const link = simLink(sim);
  const lamp = new LampController(link, H6076);
  lamp.setBrightness(80);
  await until(() => sim.brightness === 80);
  // The lamp ends up somewhere else (its own limit, another app): the check after the burst shows the truth.
  sim.brightness = 42;
  await until(() => lamp.view.brightness === 42, CONFIRM_MS + 5000);
  assert.ok(link.sent.flat().some((f) => f.join() === queryFrame(CMD.brightness).join()), "the brightness was asked for");
  assert.equal(lamp.view.brightness, 42);
  await lamp.close();
});

test("All lamps sends every change to each lamp, and a lamp of another model takes what it can", async () => {
  const a = new SimGoveeLamp(SIM_LAMPS[0]);
  const b = new SimGoveeLamp({ ...SIM_LAMPS[1], reachable: true });
  const tv = new SimGoveeLamp(SIM_LAMPS.find((s) => s.name.includes("H6199"))!);
  const group = new LampGroup([controller(a), controller(b), controller(tv)]);
  group.setColour([0, 255, 0]);
  group.setBrightness(64);
  await until(() => [a, b, tv].every((sim) => sim.brightness === 64 && sim.segments.every((c) => c.join() === "0,255,0")));
  for (const sim of [a, b, tv]) {
    assert.ok(sim.segments.every((c) => c.join() === "0,255,0"));
    assert.equal(sim.brightness, 64);
  }
  assert.equal(group.getView().brightness, 64);
  // An H6076 scene: both floor lamps run it; the TV backlight's catalogue doesn't have it, so it is left alone.
  const scene = scenesFor("H6076").find((s) => s.blob && !scenesFor("H6199").some((x) => x.code === s.code))!;
  await group.applyScene(scene);
  assert.equal(a.scene, scene.code);
  assert.equal(b.scene, scene.code);
  assert.equal(tv.scene, null);
  await group.close();
});

test("lamps are named and pictured by their model", () => {
  assert.equal(lampTitle({ name: "Govee_H6076_7A21", sku: "H6076" }), "Floor Lamp 7A21");
  assert.equal(lampTitle({ name: "ihoment_H6076_ab12", sku: "H6076" }), "Floor Lamp AB12");
  assert.equal(lampTitle({ name: "Govee_H6199_7A1C", sku: "H6199" }), "DreamView T1 TV Backlight 7A1C");
  assert.equal(lampTitle({ name: "Govee_H6102_0001", sku: "H6102" }), "H6102 0001", "a model without a name in the table goes by its SKU");
  assert.equal(photoKeyFor({ kind: "light", name: "Govee H6076", brand: "Govee" }), "govee-h6076");
  // The photo pass: Govee's own product pictures (today's store or its archived pages), one per model, shared by the
  // other lengths of the same light; a model left without a picture is drawn by its form.
  const pic = (sku: string) => photoKeyFor({ kind: "light", name: `Govee ${sku}`, brand: "Govee" });
  for (const sku of ["H6199", "H6046", "H6047", "H6056", "H6072", "H6079", "H6061", "H6066", "H6062", "H619A", "H61A0", "H66A0", "H605B"]) assert.equal(pic(sku), `govee-${sku.toLowerCase()}`, sku);
  for (const [sku, key] of [["H619C", "govee-h619a"], ["H619E", "govee-h619a"], ["H61A2", "govee-h61a0"], ["H66A1", "govee-h66a0"], ["H6176", "govee-h6173"], ["H61C5", "govee-h61c3"]]) assert.equal(pic(sku), key, sku);
  for (const sku of ["H6067", "H605C", "H6088"]) assert.equal(pic(sku), null, `${sku} stays drawn (no clean picture: drawn beats cluttered)`);
  const drawn = (sku: string) => shapeClass({ kind: "light", name: `Govee ${sku}`, form: LIGHT_MODELS[sku]?.kind });
  assert.deepEqual(["H6199", "H6046", "H6067", "H6076", "H61A8", "H6006"].map(drawn), ["light-tv", "light-bars", "light-panels", "light-lamp", "light", "light-bulb"]);
});

test("a group is All lamps only when every member is a lamp (src/lib/device-model.ts names the card by groupNoun)", () => {
  const lamps = (...skus: string[]) => skus.map((sku) => ({ sku }));
  assert.equal(groupNoun(lamps("H6076", "H6072")), "lamp");
  assert.equal(groupNoun(lamps("H6076", "H6199", "H6046")), "light");
  assert.equal(groupNoun(lamps()), "light");
  assert.equal(nounOf("H6046"), "light");
  assert.equal(nounOf("H6079"), "lamp");
});

test("everything the Effects and Music tabs can make passes the guard", () => {
  for (const style of DIY_STYLES)
    for (const v of style.variants)
      for (const n of [1, 3, 8]) {
        const colours = Array.from({ length: n }, (_, i) => [i * 30, 255 - i * 30, 128] as const);
        for (const speed of [0, 50, 100]) {
          const body = diyBody({ id: "t", name: "t", family: style.family, variant: v.variant, speed, colours });
          assert.ok(checkLightUpload(H6076, "diy", body).ok, `${style.name} ${v.name} x${n} @${speed}`);
        }
      }
  const mix = DIY_STYLES.filter((s) => s.combo).slice(0, 4).map((s) => ({ family: s.family, variant: s.variants[0].variant }));
  for (let k = 2; k <= 4; k++) assert.ok(checkLightUpload(H6076, "diy", diyBody({ id: "m", name: "m", family: 0, variant: 0, speed: 60, colours: [[255, 0, 0]], combo: mix.slice(0, k) })).ok, `a mix of ${k}`);
  for (const s of [H6076, specOf("H1A42")!])
    for (const mode of s.music)
      for (const style of [0, 1])
        for (const colour of [null, [255, 42, 212] as const]) for (const sens of [0, 70, 99]) assert.ok(checkLightFrame(s, musicFrame(mode.id, sens, style, colour)).ok, `${s.sku} ${mode.name} ${style} ${sens}`);
  assert.equal(checkLightFrame(H6076, musicFrame(0x07, 50, 0, null)).ok, false, "a music mode the lamp doesn't have");
  assert.equal(checkLightFrame(H6076, musicFrame(0x84, 50, 0, null)).ok, false, "the H1A42's Splash isn't the H6076's");
});

test("screen sync sends only the pages that moved, and every frame passes the guard (the bridge's stream.rs rule)", async () => {
  const a = Array.from({ length: 14 }, () => [10, 20, 30] as const);
  assert.deepEqual(changedPages([], a), [1, 2, 3, 4]);
  assert.deepEqual(changedPages(a, a), []);
  const b = a.map((c, i) => (i === 5 ? ([10, 20, 39] as const) : i === 13 ? ([200, 0, 0] as const) : c));
  assert.deepEqual(changedPages(a, b), [2, 4]);
  assert.deepEqual(changedPages(a, a.map((c, i) => (i === 5 ? ([10, 20, 38] as const) : c))), [], "a wobble within the threshold");
  // The preview's pretend screen, through the simulated lamp (which refuses anything the guard refuses).
  const sim = simLamp(SIM_LAMPS[0]);
  const before = sim.accepted.length;
  const heard: number[] = [];
  simSyncStart(SIM_LAMPS[0], "left", () => heard.push(Date.now()));
  await until(() => heard.length >= 3);
  assert.ok(simSyncStop(SIM_LAMPS[0].id));
  const frames = sim.accepted.slice(before);
  assert.equal(frames[0][1], 0xa3, "gradual change off first");
  assert.ok(frames.slice(1).every((f) => f[1] === 0x05 && f[2] === 0x15 && f[3] === 0x04), "then only segment pages");
  assert.equal(simSyncStop(SIM_LAMPS[0].id), false, "stopped once");
});
