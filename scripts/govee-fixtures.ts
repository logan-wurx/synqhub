// Writes src-tauri/src/lighting/govee/frames.txt: the frames and uploads the Govee guard (src/lib/lighting/govee/frames.ts)
// has a verdict on, for a spread of models, so the bridge's copy (guard.rs, test `light_guard_matches_the_frontend`)
// is held to the same answers, and to the same A3 framing. Lines:
//
//   frame <sku> <1|0> <hex>                                   a single 20-byte frame
//   scene <sku> <code> <1|0> <body hex> [<frame hex>…]        a scene's upload and, when allowed, its A3 frames
//   diy <sku> <1|0> <body hex> [<frame hex>…]                 a DIY upload and, when allowed, its A3 frames
//
// The allowed lines are every kind of frame the lighting page builds for each model; the refused ones are the
// commands the brief names (firmware, reset, network, name, `aa b1`, loose multi-packet frames, the handshake), other
// models' frames (a dialect, a scene, a mask the model hasn't) and one-byte changes of the allowed frames with their
// checksum recomputed, so the content rules are what decides. Run after changing either side:
//
//   node scripts/govee-fixtures.ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIY_CODES, DIY_STYLES } from "../src/lib/lighting/govee/diy.ts";
import {
  CMD,
  KELVIN_STEP,
  a3Frames,
  allSegments,
  brightnessFrame,
  checkLightFrame,
  checkLightUpload,
  colourFrame,
  diyFrame,
  frame,
  gradualFrame,
  musicFrame,
  powerFrame,
  queryFrame,
  sceneFrame,
  segmentBrightnessFrame,
  segmentFrames,
  segmentPageFrame,
  whiteFrame,
  xorOf,
  type Rgb,
  type UploadKind,
} from "../src/lib/lighting/govee/frames.ts";
import { sceneBlob, scenesFor } from "../src/lib/lighting/govee/scenes.generated.ts";
import { COLOUR_DIALECTS, DIALECT, limitOf, specOf, type GoveeSpec } from "../src/lib/lighting/govee/spec.ts";

export const GOVEE_FRAMES = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/src/lighting/govee/frames.txt");

/**
 * The models the fixture covers: the proven H6076 in full; the reference's measured H66A0 (0x15 only) and H1A42 (five
 * segments, its own music ids); a 0x15 model with a 15-segment mask (H6199); and two unverified defaults that take
 * the four dialects (H6046 indoors, H7020 outdoors, with large catalogues).
 */
export const FIXTURE_MODELS = ["H6076", "H66A0", "H1A42", "H6199", "H6046", "H7020"];

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const COLOURS: Rgb[] = [
  [255, 0, 0],
  [0, 0, 255],
  [255, 174, 84],
  [1, 2, 3],
  [255, 255, 255],
];
const spec = (sku: string) => specOf(sku)!;

const masksOf = (s: GoveeSpec, d: number) => {
  const all = allSegments(s, d);
  return [...new Set([all, 0x0001, (all + 1) >> 1, 0x1555 & all, 0x2aaa & all, 0x00f0 & all])].filter((m) => m);
};

/** Every kind of frame the page builds for this model. */
export function allowedFrames(s: GoveeSpec): Uint8Array[] {
  const out: Uint8Array[] = [powerFrame(true), powerFrame(false), brightnessFrame(1, s.brightnessMax), brightnessFrame(35, s.brightnessMax), brightnessFrame(s.brightnessMax, s.brightnessMax)];
  for (const d of s.dialects) {
    for (const c of COLOURS) {
      if (d === DIALECT.typed || d === DIALECT.ic) for (const m of masksOf(s, d)) out.push(colourFrame(s, d, c, m));
      else out.push(colourFrame(s, d, c));
    }
    if (s.kelvin) for (let k = s.kelvin[0]; k <= s.kelvin[1]; k += KELVIN_STEP * (s.sku === "H6076" ? 1 : 6)) out.push(whiteFrame(s, d, k));
    if (d === DIALECT.typed || d === DIALECT.ic) out.push(...segmentFrames(s, d, Array.from({ length: limitOf(s, d) }, (_, i) => COLOURS[i % COLOURS.length])));
  }
  if (s.dialects.includes(DIALECT.typed)) {
    out.push(gradualFrame(false), gradualFrame(true));
    for (const m of masksOf(s, DIALECT.typed)) out.push(segmentBrightnessFrame(0, m), segmentBrightnessFrame(55, m), segmentBrightnessFrame(100, m));
    for (let p = 1; p <= Math.ceil(limitOf(s, DIALECT.typed) / 4); p++) out.push(queryFrame(CMD.segments, p));
  }
  for (const sc of scenesFor(s.sku)) out.push(sceneFrame(sc.code));
  for (const m of s.music) for (const sens of [0, 50, 99]) for (const style of [0, 1]) for (const c of [null, [255, 0, 0] as Rgb]) out.push(musicFrame(m.id, sens, style, c));
  if (s.diy) for (const code of DIY_CODES) out.push(diyFrame(code));
  out.push(...[CMD.power, CMD.brightness, CMD.version, CMD.icCount].map((c) => queryFrame(c)), queryFrame(CMD.mode), queryFrame(CMD.mode, 1));
  return out;
}

function refusedFrames(s: GoveeSpec): Uint8Array[] {
  const pages = Math.ceil(limitOf(s, DIALECT.typed) / 4);
  const other = COLOUR_DIALECTS.filter((d) => !s.dialects.includes(d));
  return [
    // The handshake, OTA preparation, a loose upload frame, the key query.
    frame([0xe7, 0x01]),
    frame([0xe7, 0x02]),
    frame([0xe7, 0x11, 0x01]),
    frame([0xee, 0x30, 0x01]),
    frame([0xa3, 0x00, 0x01, 0x03, 0x02]),
    frame([0xa3, 0xff]),
    frame([0xaa, 0xb1]),
    frame([0x33, 0xb1, 0x01]),
    // Commands that aren't sent: time, Wi-Fi, name, reset-like and OTA-like ids, timers, the newer mode registers.
    ...[0x00, 0x02, 0x03, 0x09, 0x0a, 0x0b, 0x0f, 0x10, 0x11, 0x12, 0x14, 0x20, 0x21, 0x23, 0x40, 0x60, 0xa5, 0xa9, 0xab, 0xae, 0xef, 0xff].map((c) => frame([0x33, c, 0x01])),
    // Modes that aren't sent: video, DreamView, newer music; the colour dialects this model doesn't take.
    ...[0x00, 0x16, 0x60, 0xff].map((m) => frame([0x33, 0x05, m, 0x01, 0xff])),
    ...other.map((d) => colourFrame(s, d, [255, 0, 0], 1)),
    // Out of range: power 2, brightness 0 and over the scale, gradual 2, masks of no segment or past the last.
    frame([0x33, 0x01, 0x02]),
    frame([0x33, 0x04, 0x00]),
    frame([0x33, 0x04, s.brightnessMax + 1]),
    frame([0x33, 0xa3, 0x02]),
    frame([0x33, 0x05, DIALECT.typed, 0x01, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    frame([0x33, 0x05, DIALECT.typed, 0x01, 255, 0, 0, 0, 0, 0, 0, 0, 0, ...(limitOf(s, DIALECT.typed) < 16 ? [0, (1 << (limitOf(s, DIALECT.typed) - 8)) & 0xff] : [0, 0])]),
    frame([0x33, 0x05, DIALECT.ic, 255, 0, 0, 0, 0x80]),
    frame([0x33, 0x05, DIALECT.ic, 255, 0, 0, 0, 0]),
    frame([0x33, 0x05, DIALECT.typed, 0x04, pages + 1, 0xff]),
    frame([0x33, 0x05, DIALECT.typed, 0x03, 0x10, 0x20]),
    frame([0x33, 0x05, DIALECT.typed, 0x02, 0x65, 0xff, 0x3f]),
    // White off the steps or the range, or with another RGB rendering; a colour with a rendering.
    frame([0x33, 0x05, DIALECT.typed, 0x01, 0, 0, 0, 0x0a, 0x8c, 0xff, 0xae, 0x54, 0xff, 0x3f]),
    frame([0x33, 0x05, DIALECT.typed, 0x01, 0, 0, 0, 0x0a, 0x8d, 255, 166, 87, 0xff, 0x3f]),
    frame([0x33, 0x05, DIALECT.typed, 0x01, 0, 0, 0, 0x07, 0xd0, 255, 137, 18, 0xff, 0x3f]),
    frame([0x33, 0x05, DIALECT.typed, 0x01, 0xff, 0, 0, 0x0a, 0x8c, 255, 166, 87, 0xff, 0x3f]),
    frame([0x33, 0x05, DIALECT.cct, 0, 0, 0, 0x0a, 0x8c, 0xff, 0xae, 0x54]),
    frame([0x33, 0x05, DIALECT.cct, 0xff, 0, 0, 0, 0, 1, 2, 3]),
    frame([0x33, 0x05, DIALECT.rgb, 0xff, 0, 0, 1]),
    // Scenes outside this model's catalogue (another model's, or none), music outside its modes, DIY where it has none.
    sceneFrame(0),
    sceneFrame(1),
    sceneFrame(14533),
    ...scenesFor(s.sku === "H6076" ? "H7020" : "H6076").slice(0, 3).map((x) => sceneFrame(x.code)).filter((f) => !scenesFor(s.sku).some((x) => sceneFrame(x.code).every((b, i) => b === f[i]))),
    frame([0x33, 0x05, 0x04, 0x5f, 0x08, 0x02]),
    musicFrame(0x30, 50, 0, null),
    frame([0x33, 0x05, 0x13, 0x05, 0x64]),
    frame([0x33, 0x05, 0x13, 0x05, 0x10, 0x02]),
    frame([0x33, 0x05, 0x13, 0x05, 0x10, 0x00, 0x02, 1, 2, 3]),
    frame([0x33, 0x05, 0x13, 0x05, 0x10, 0x00, 0x00, 1]),
    diyFrame(0),
    diyFrame(25),
    diyFrame(24),
    frame([0x33, 0x05, 0x0a, 0x18, 0x00, 0x04]),
    // Queries that aren't asked, or asked with an argument they don't take.
    queryFrame(0x07, 3),
    queryFrame(0x23, 0xff),
    queryFrame(0xa9, 0x11),
    queryFrame(0x01, 1),
    queryFrame(CMD.segments, 0),
    queryFrame(CMD.segments, pages + 1),
    queryFrame(CMD.mode, 2),
    // Wrong length, bad checksum.
    powerFrame(true).subarray(0, 19),
    Uint8Array.from([...powerFrame(true).subarray(0, 19), 0x00]),
  ];
}

/** Each frame with one byte changed and its checksum recomputed (the first 15 bytes take two values). */
function mutations(frames: readonly Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const f of frames) {
    for (let i = 0; i < 19; i++) {
      for (const v of i < 15 ? [0x01, 0xff] : [0xff]) {
        if (f[i] === v) continue;
        const m = f.slice();
        m[i] = v;
        m[19] = xorOf(m, 19);
        out.push(m);
      }
    }
  }
  return out;
}

const body = (...b: number[]) => Uint8Array.from(b);
const palette = (n: number) => COLOURS.slice(0, n).flatMap((c) => [...c]);

interface Upload {
  kind: UploadKind;
  body: Uint8Array;
  code?: number;
}

function uploads(s: GoveeSpec): Upload[] {
  const scenes = scenesFor(s.sku).filter((x) => x.blob);
  // The model's every scene with its own data (the H6076 in full, the others a spread); then refusals: data changed by
  // one byte, cut short, padded, sent with another scene's code, and another model's data.
  const out: Upload[] = (s.sku === "H6076" ? scenes : scenes.filter((_, i) => i % 9 === 0)).map((x) => ({ kind: "scene", body: sceneBlob(x)!, code: x.code }));
  for (const x of scenes.slice(0, 4)) {
    const b = sceneBlob(x)!;
    const changed = b.slice();
    changed[Math.floor(b.length / 2)] ^= 0x01;
    out.push({ kind: "scene", body: changed, code: x.code }, { kind: "scene", body: b.slice(0, b.length - 1), code: x.code }, { kind: "scene", body: Uint8Array.from([...b, 0]), code: x.code });
  }
  if (scenes.length > 1 && sceneBlob(scenes[0])!.join() !== sceneBlob(scenes[1])!.join()) out.push({ kind: "scene", body: sceneBlob(scenes[0])!, code: scenes[1].code });
  const builtIn = scenesFor(s.sku).find((x) => !x.blob);
  if (builtIn && scenes[0]) out.push({ kind: "scene", body: sceneBlob(scenes[0])!, code: builtIn.code });
  const foreign = scenesFor(s.sku === "H7020" ? "H6076" : "H7020").find((x) => x.blob && !scenesFor(s.sku).some((y) => y.code === x.code));
  if (foreign) out.push({ kind: "scene", body: sceneBlob(foreign)!, code: foreign.code });
  // DIY: every style and variant with one to three colours, speeds 0 / 100; combos of two and four styles.
  for (const st of DIY_STYLES) for (const v of st.variants) for (const n of [1, 3]) out.push({ kind: "diy", body: body(st.family, v.variant, n === 1 ? 0 : 100, n * 3, ...palette(n)) });
  out.push({ kind: "diy", body: body(0xff, 0, 50, 6, ...palette(2), 4, 0, 1, 3, 4) });
  out.push({ kind: "diy", body: body(0xff, 0, 70, 9, ...palette(3), 8, 0, 0, 1, 2, 2, 1, 8, 9) });
  // Refused: speed 101, no colours, nine colours, a style or variant there isn't, a combo of none or of five, a combo
  // with a bad pair or a variant byte, trailing bytes, too short.
  out.push(
    { kind: "diy", body: body(0, 0, 101, 3, 1, 2, 3) },
    { kind: "diy", body: body(0, 0, 50, 0) },
    { kind: "diy", body: body(0, 0, 50, 27, ...Array.from({ length: 27 }, () => 7)) },
    { kind: "diy", body: body(5, 0, 50, 3, 1, 2, 3) },
    { kind: "diy", body: body(0, 9, 50, 3, 1, 2, 3) },
    { kind: "diy", body: body(0xff, 0, 50, 3, 1, 2, 3, 0) },
    { kind: "diy", body: body(0xff, 0, 50, 3, 1, 2, 3, 10, 0, 0, 1, 0, 2, 0, 3, 3, 8, 9) },
    { kind: "diy", body: body(0xff, 0, 50, 3, 1, 2, 3, 2, 5, 0) },
    { kind: "diy", body: body(0xff, 1, 50, 3, 1, 2, 3, 2, 0, 0) },
    { kind: "diy", body: body(0, 0, 50, 3, 1, 2, 3, 0) },
    { kind: "diy", body: body(0, 0, 50) },
  );
  return out;
}

export function goveeFixtureText(): string {
  const lines: string[] = [];
  for (const sku of FIXTURE_MODELS) {
    const s = spec(sku);
    const allowed = allowedFrames(s);
    const sample = sku === "H6076" ? allowed.filter((_, i) => i % 3 === 0) : allowed.filter((_, i) => i % 17 === 0);
    for (const f of [...allowed, ...refusedFrames(s), ...mutations(sample)]) lines.push(`frame ${sku} ${checkLightFrame(s, f).ok ? 1 : 0} ${hex(f)}`);
    for (const u of uploads(s)) {
      const ok = checkLightUpload(s, u.kind, u.body, u.code).ok;
      const frames = ok ? a3Frames(u.kind === "scene" ? 0x02 : 0x04, u.body).map(hex) : [];
      lines.push((u.kind === "scene" ? ["scene", sku, String(u.code), ok ? "1" : "0", hex(u.body), ...frames] : ["diy", sku, ok ? "1" : "0", hex(u.body), ...frames]).join(" "));
    }
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(GOVEE_FRAMES, goveeFixtureText());
  console.log(`wrote ${GOVEE_FRAMES}`);
}
