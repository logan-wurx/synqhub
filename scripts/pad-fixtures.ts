// Writes src-tauri/src/pad-frames.txt: every report the controller guard (src/lib/controllers/guard.ts) has a verdict
// on, so the bridge's copy (src-tauri/src/pads.rs, test `pad_guard_matches_the_frontend`) can be held to exactly the
// same answers. Each line is `<guard> <op> <1|0> <hex>`:
//
//   guard  ds5 | edge | ds4 | switch | gamesir-cyclone2 | gamesir-g7pro8k | gamesir-tarantula | scuf | 8bitdo | flydigi | input
//   op     out:<id> (an output report), get:<id> (a feature read), set:<id> (a feature write)
//   1|0    whether guard.ts lets it through
//   hex    `<length>:<data>`: the report's length and its data without the id, trailing zero bytes dropped
//          (`-` for a read)
//
// The allowed lines are every frame frames.ts builds in wave C1; the refused ones are the dangerous commands named in
// the brief and every single-byte change of an allowed frame. scripts/controllers.test.ts regenerates the text and
// compares. Run after changing either side:
//
//   node scripts/pad-fixtures.ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DS4, DS5, DS5_TRIGGER_EFFECTS, SWITCH, SWITCH_SPI_READABLE, SWITCH_USB, ds4Output, ds5Output, switchOutput, type Ds5Effect, type Link, type SwitchCommand } from "../src/lib/controllers/frames.ts";
import { checkPadFeatureGet, checkPadFeatureSet, checkPadOutput } from "../src/lib/controllers/guard.ts";
import { EDGE_PART, EDGE_SLOTS, edgeDeleteFrame, edgePartCrc, edgeWriteFrames, parseEdgeProfile, type EdgeEdit } from "../src/lib/controllers/edge.ts";
import { CMD, GAMESIR_CURVES, GAMESIR_LEN, GAMESIR_MAPS, GAMESIR_OUT, GAMESIR_TARGETS, G7_8K_LIGHT_MODES, LIGHT_BANK, gamesirFields, gamesirQuery, gamesirReads, gamesirRumble, gamesirSwitch, gamesirWrites, type Field, type GamesirModel } from "../src/lib/controllers/gamesir.ts";
import { SCUF_LEN, SCUF_READS, scufGet } from "../src/lib/controllers/scuf.ts";
import { FD_AT, FD_LEN, fdDeviceInfo, fdMotor, fdReadConfig, fdReadRandomId, fdSave, fdWrites, flydigiApply, flydigiSampleConfig, parseFlydigiConfig } from "../src/lib/controllers/flydigi.ts";
import { EBD_AT, EBD_LEN, ebdApply, ebdReads, ebdReportState, ebdSampleConfig, ebdSave, ebdVersion, ebdVibrate, ebdWrites, parseEbdConfig } from "../src/lib/controllers/eightbitdo.ts";
import type { PadGuard } from "../src/lib/controllers/types.ts";

export const PAD_FRAMES = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/src/pad-frames.txt");

const hex = (b: ArrayLike<number>) => {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return `${b.length}:${Array.from({ length: end }, (_, i) => b[i].toString(16).padStart(2, "0")).join("")}`;
};

interface Frame {
  guard: PadGuard;
  reportId: number;
  data: Uint8Array;
}

/** Every frame the C1 drivers may send. */
export function allowedFrames(): Frame[] {
  const out: Frame[] = [];
  const links: Link[] = ["usb", "bt"];
  const ds5: Ds5Effect[] = [
    { kind: "rumble", left: 0, right: 0 },
    { kind: "rumble", left: 255, right: 128 },
    { kind: "lightbar", r: 0, g: 0, b: 0 },
    { kind: "lightbar", r: 139, g: 92, b: 246 },
    { kind: "lightbar", r: 255, g: 255, b: 255 },
    { kind: "playerLeds", pattern: 0x04 },
    { kind: "playerLeds", pattern: 0x1f | 0x20 },
    { kind: "playerLeds", pattern: 0 },
    { kind: "micLed", mode: 0 },
    { kind: "micLed", mode: 1 },
    { kind: "micLed", mode: 2 },
    { kind: "releaseLeds" },
    ...(Object.keys(DS5_TRIGGER_EFFECTS) as (keyof typeof DS5_TRIGGER_EFFECTS)[]).map((effect) => ({ kind: "triggers", effect }) as Ds5Effect),
  ];
  for (const link of links) for (const e of ds5) out.push({ guard: "ds5", ...ds5Output(link, e) });
  // The Edge takes the DualSense's outputs.
  for (const e of ds5.slice(0, 4)) out.push({ guard: "edge", ...ds5Output("usb", e) });
  for (const link of links) {
    for (const e of [
      { kind: "rumble", left: 0, right: 0 },
      { kind: "rumble", left: 200, right: 90 },
      { kind: "lightbar", r: 0, g: 0, b: 64 },
      { kind: "lightbar", r: 139, g: 92, b: 246 },
    ] as const)
      out.push({ guard: "ds4", ...ds4Output(link, e) });
  }
  const sw: SwitchCommand[] = [
    ...Object.values(SWITCH_USB).map((command) => ({ kind: "usb", command }) as SwitchCommand),
    { kind: "rumble", pulse: true },
    { kind: "rumble", pulse: false },
    { kind: "deviceInfo" },
    { kind: "inputMode", mode: 0x30 },
    { kind: "inputMode", mode: 0x3f },
    ...SWITCH_SPI_READABLE.flatMap(([first, last]) => [
      { kind: "spiRead", address: first, length: Math.min(last - first + 1, 0x1d) } as SwitchCommand,
      { kind: "spiRead", address: last, length: 1 } as SwitchCommand,
    ]),
    { kind: "playerLights", pattern: 0x01 },
    { kind: "playerLights", pattern: 0xf0 },
    { kind: "homeLight", intensity: 0 },
    { kind: "homeLight", intensity: 15 },
    { kind: "imu", on: true },
    { kind: "imu", on: false },
    { kind: "vibration", on: true },
    { kind: "vibration", on: false },
  ];
  for (const link of links) sw.forEach((c, i) => out.push({ guard: "switch", ...switchOutput(link, c, i) }));
  return out;
}

/** The dangerous reports the brief names, and other shapes that must be refused. */
function refusedFrames(): Frame[] {
  const out: Frame[] = [];
  const sub = (link: Link, id: number, args: number[] = []): Frame => {
    const f = switchOutput(link, { kind: "deviceInfo" }, 3);
    f.data[9] = id;
    f.data.set(args, 10);
    return { guard: "switch", ...f };
  };
  for (const link of ["usb", "bt"] as const) {
    for (const id of [0x01, 0x06, 0x07, 0x08, 0x11, 0x12, 0x41, 0x42, 0x50, 0x51, 0x52, 0x04, 0x21, 0x22, 0x31, 0x5a, 0xff]) out.push(sub(link, id, [0x00, 0x10, 0x00, 0x00, 0x10]));
    for (let id = 0x20; id <= 0x2b; id++) out.push(sub(link, id));
    for (const arg of [0x00, 0x23, 0x31, 0x3e, 0x40, 0xff]) out.push(sub(link, 0x03, [arg]));
    // SPI reads outside the calibration ranges, straddling one, or too long.
    for (const [address, length] of [
      [0x6000, 0x10],
      [0x6050, 12],
      [0x601f, 2],
      [0x6037, 2],
      [0x8000, 0x10],
      [0x8039, 2],
      [0x603d, 0x1e],
      [0x0000, 1],
      [0xf000, 1],
    ] as const) {
      const f = switchOutput(link, { kind: "spiRead", address, length: 1 }, 1);
      f.data[14] = length;
      out.push({ guard: "switch", ...f });
    }
    for (const cmd of [0x00, 0x06, 0x07, 0x10, 0x80, 0x91, 0xff]) {
      const f = switchOutput(link, { kind: "usb", command: SWITCH_USB.status }, 0);
      f.data[0] = cmd;
      out.push({ guard: "switch", ...f });
    }
    // A subcommand carrying rumble, and a rumble frame other than the two.
    const loud = switchOutput(link, { kind: "playerLights", pattern: 1 }, 2);
    loud.data.set([0x74, 0x88, 0x3d, 0x62, 0x74, 0x88, 0x3d, 0x62], 1);
    out.push({ guard: "switch", ...loud });
    const odd = switchOutput(link, { kind: "rumble", pulse: true }, 2);
    odd.data.set([0xff, 0xff, 0xff, 0xff], 1);
    out.push({ guard: "switch", ...odd });
  }
  // Switch reports of other ids, and a report of the wrong length.
  for (const id of [0x00, 0x02, 0x11, 0x12, 0x30, 0x81, 0xa0]) out.push({ guard: "switch", reportId: id, data: new Uint8Array(SWITCH.USB_LEN) });
  out.push({ guard: "switch", reportId: 0x01, data: new Uint8Array(20) });
  // Sony: two effects at once, audio controls, a bad Bluetooth CRC, other report ids, the DS4 blink.
  const both = ds5Output("usb", { kind: "lightbar", r: 1, g: 2, b: 3 });
  both.data[1] |= 0x10;
  both.data[43] = 4;
  out.push({ guard: "ds5", ...both });
  for (const at of [4, 5, 6, 7, 9, 32, 38, 41, 42]) {
    const f = ds5Output("usb", { kind: "micLed", mode: 1 });
    f.data[at] = 0x40;
    out.push({ guard: "ds5", ...f });
  }
  const badCrc = ds5Output("bt", { kind: "rumble", left: 10, right: 10 });
  badCrc.data[76] ^= 0x01;
  out.push({ guard: "ds5", ...badCrc });
  out.push({ guard: "ds5", reportId: 0x02, data: new Uint8Array(DS5.USB_LEN) });
  for (const id of [0x01, 0x03, 0x05, 0x09, 0x20, 0x32, 0x80, 0x81, 0x82, 0x83]) out.push({ guard: "ds5", reportId: id, data: new Uint8Array(DS5.USB_LEN) });
  const blink = ds4Output("usb", { kind: "lightbar", r: 1, g: 1, b: 1 });
  blink.data[0] |= 0x04;
  blink.data[8] = 10;
  out.push({ guard: "ds4", ...blink });
  for (const id of [0x01, 0x02, 0x11 + 1, 0x13, 0x90, 0xa0]) out.push({ guard: "ds4", reportId: id, data: new Uint8Array(DS4.USB_LEN) });
  // Read-only pads: every output refused.
  for (const id of [0x00, 0x01, 0x02, 0x05, 0x31]) out.push({ guard: "input", reportId: id, data: new Uint8Array(32) });
  return out;
}

/**
 * Every allowed frame with one byte changed: the bridge must judge each the same way. Every byte of the first 16 (ids,
 * flags, subcommands and their arguments) takes two values; after that every third byte and the last four (the
 * Bluetooth CRC) take one.
 */
function mutations(frames: readonly Frame[]): Frame[] {
  const out: Frame[] = [];
  for (const f of frames) {
    for (let i = 0; i < f.data.length; i++) {
      const head = i < 16;
      if (!head && i % 3 !== 0 && i < f.data.length - 4) continue;
      for (const v of head ? [0x01, 0xff] : [0xff]) {
        if (f.data[i] === v) continue;
        const data = f.data.slice();
        data[i] = v;
        out.push({ ...f, data });
      }
    }
  }
  return out;
}

/** Deterministic bytes for a fixture's profile id. */
const fixedId = Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff);

/** The Edge profile parts the C2 panel may write: an edit of an empty slot and of a used one, in every custom slot. */
export function edgeFixtureParts(): { reportId: number; data: Uint8Array }[] {
  const out: { reportId: number; data: Uint8Array }[] = [];
  const edit: EdgeEdit = { label: "Fixture FPS", sticks: [{ preset: 1, step: 4 }, { preset: 2, step: 10 }], triggers: [{ min: 12, max: 240 }, { min: 0, max: 255 }], buttons: Array.from({ length: 16 }, (_, i) => (i === 14 ? 0x05 : i === 15 ? 0x04 : i)) };
  for (const slot of EDGE_SLOTS.filter((s) => !s.protected)) {
    const empty = [0, 1, 2].map((part) => {
      const b = new Uint8Array(EDGE_PART);
      b[0] = slot.read + part;
      if (part === 0) b[1] = 16;
      return b;
    });
    const first = edgeWriteFrames(parseEdgeProfile(slot, empty), edit, fixedId);
    out.push(...first);
    // The same slot read back and edited again (unknown bytes kept, a new label and curve).
    const read = first.map((f, i) => Uint8Array.from([slot.read + i, ...f.data]));
    out.push(...edgeWriteFrames(parseEdgeProfile(slot, read), { ...edit, label: "Again", sticks: [{ preset: 5, step: 0 }, { preset: 0, step: 0 }] }, fixedId));
  }
  for (const s of [1, 2, 3] as const) out.push(edgeDeleteFrame(s));
  return out;
}

/** Edge feature SETs that must be refused. */
function edgeRefusedSets(): { reportId: number; data: Uint8Array }[] {
  const out: { reportId: number; data: Uint8Array }[] = [];
  const good = edgeFixtureParts();
  // The default profile, under its own write id.
  for (const f of good.slice(0, 3)) out.push({ reportId: 0x63, data: f.data });
  // Deletes of the default and of no slot.
  for (const n of [0, 1, 5, 0xff]) {
    const d = new Uint8Array(EDGE_PART - 1);
    d[0] = n;
    out.push({ reportId: 0x68, data: d });
  }
  // Each field out of range, the CRC fixed up so only the field is wrong.
  const reseal = (reportId: number, data: Uint8Array) => {
    const part = Uint8Array.from([reportId, ...data]);
    new DataView(part.buffer).setUint32(60, edgePartCrc(part), true);
    return { reportId, data: part.slice(1) };
  };
  const bad = (i: number, at: number, v: number) => {
    const d = good[i].data.slice();
    d[at - 1] = v;
    out.push(reseal(good[i].reportId, d));
  };
  bad(0, 1, 3); // part index 3
  bad(0, 2, 0); // part 1 not marked used
  bad(0, 6, 0x07); // a control character in the name
  bad(0, 7, 0x41); // a high byte in the name
  bad(1, 44, 0x05); // curve modifier
  bad(2, 30, 6); // curve preset
  bad(2, 4, 255); // L2 start at the end
  bad(2, 10, 0x12); // a button that isn't one
  // A part whose CRC is off.
  const d = good[1].data.slice();
  d[62] ^= 1;
  out.push({ reportId: good[1].reportId, data: d });
  // Wrong length.
  out.push({ reportId: 0x60, data: good[0].data.slice(0, 40) });
  return out;
}

// ---- GameSir (wave C2)

const GAMESIR_GUARD: Readonly<Record<GamesirModel, PadGuard>> = { cyclone2: "gamesir-cyclone2", g7pro8k: "gamesir-g7pro8k", tarantula: "gamesir-tarantula" };
const GAMESIR_MODELS = Object.keys(GAMESIR_GUARD) as GamesirModel[];

const be16 = (values: readonly number[]) => values.flatMap((v) => [v >> 8, v & 0xff]);

/** Values a field takes in the fixture: its bounds and a typical setting. */
function fieldValues(model: GamesirModel, f: Field, firstRemap: boolean): number[][] {
  const n = f.len;
  switch (f.kind) {
    case "percent":
      return [Array(n).fill(75), Array(n).fill(0), Array(n).fill(100)];
    case "permille16":
      return [be16([50, 1000, 0, 1000].slice(0, n / 2)), be16(Array(n / 2).fill(0)), be16(Array(n / 2).fill(1000))];
    case "traj":
      return [[1], [0]];
    case "poll":
      return GAMESIR_MAPS[model].pollRates.map((_, code) => [code]);
    case "remap":
      return firstRemap ? [...GAMESIR_TARGETS.map((t) => [1, t.code]), [0, 0]] : [[1, 0x0a], [0, 0]];
    case "curve":
      return GAMESIR_CURVES.map((c) => [...c.block]);
    case "lightSlot":
      return [[0], [1], [2], [3]];
    case "lightMode":
      return G7_8K_LIGHT_MODES.map((l) => [l.code]);
  }
}

/** Every kind of frame the GameSir settings send, per model, and a sample of them whose one-byte changes are checked too. */
export function gamesirFixtureFrames(): { allowed: Frame[]; probe: Frame[] } {
  const allowed: Frame[] = [];
  const probe: Frame[] = [];
  for (const model of GAMESIR_MODELS) {
    const guard = GAMESIR_GUARD[model];
    const m = GAMESIR_MAPS[model];
    const add = (f: { reportId: number; data: Uint8Array }, sample = false) => {
      allowed.push({ guard, ...f });
      if (sample) probe.push({ guard, ...f });
    };
    add(gamesirQuery(CMD.heartbeat), true);
    add(gamesirQuery(CMD.firmware));
    add(gamesirQuery(CMD.active));
    for (const p of [1, 2, 3, 4]) add(gamesirSwitch(p), p === 2);
    if (m.vibration) {
      add(gamesirRumble(100, 100), true);
      add(gamesirRumble(0, 0));
    }
    // Reads: the whole of profile 1 and of the lighting bank, the first packet of the other profiles.
    gamesirReads(1, 0, m.profileSize).forEach((f, i, all) => add(f, i === 0 || i === all.length - 1));
    for (const b of [2, 3, 4]) add(gamesirReads(b, 0, m.profileSize)[0]);
    if (m.lightSize) gamesirReads(LIGHT_BANK, 0, m.lightSize).forEach((f, i, all) => add(f, i === all.length - 1));
    // Writes: every field, at its bounds; the first field of each kind is probed byte by byte.
    const probed = new Set<string>();
    let firstRemap = true;
    for (const f of gamesirFields(model)) {
      const bank = f.bank === "profile" ? 1 + (f.at % 4) : LIGHT_BANK;
      const values = fieldValues(model, f, firstRemap && f.kind === "remap");
      if (f.kind === "remap") firstRemap = false;
      values.forEach((v, i) => gamesirWrites(bank, f.at, v).forEach((w) => add(w, i === 0 && !probed.has(f.kind))));
      probed.add(f.kind);
    }
  }
  return { allowed, probe };
}

/** GameSir frames that must be refused. */
function gamesirRefused(): Frame[] {
  const out: Frame[] = [];
  const raw = (guard: PadGuard, ...bytes: number[]): Frame => {
    const data = new Uint8Array(GAMESIR_LEN);
    data.set(bytes);
    return { guard, reportId: GAMESIR_OUT, data };
  };
  for (const model of GAMESIR_MODELS) {
    const g = GAMESIR_GUARD[model];
    const m = GAMESIR_MAPS[model];
    // The firmware loader (0x17 55 88), macro recording, LED playback, the answers' own codes, unknown commands.
    for (const cmd of [0x17, 0x16, 0x0d, 0x0e, 0x0f, 0x05, 0x06, 0x0a, 0x0c, 0x00, 0x01, 0x02, 0x08, 0x21, 0xf3, 0xff]) out.push(raw(g, cmd, 0x55, 0x88));
    // Queries with arguments, profiles other than 1-4.
    out.push(raw(g, CMD.firmware, 1), raw(g, CMD.heartbeat, 0, 0, 0, 1));
    for (const p of [0, 5, 0x20, 0xff]) out.push(raw(g, CMD.switchProfile, p));
    out.push(raw(g, CMD.switchProfile, 1, 1));
    // Reads: other banks, past the end, sizes 0 and 57, trailing bytes.
    for (const bank of [0, 5, 6, 0x10, 0x21, 0xff]) out.push(raw(g, CMD.read, bank, 0, 0, 8));
    if (!m.lightSize) out.push(raw(g, CMD.read, LIGHT_BANK, 0, 0, 8));
    out.push(raw(g, CMD.read, 1, m.profileSize >> 8, m.profileSize & 0xff, 1), raw(g, CMD.read, 1, 0, 0, 0), raw(g, CMD.read, 1, 0, 0, 57), raw(g, CMD.read, 1, 0, 0, 8, 1));
    // Writes: the Shift layer and other banks, outside every field (incl. 0x3f, the profile -> lighting link), sizes
    // 0 and 49, a page crossing, trailing bytes.
    for (const bank of [0, 5, 0x21, 0xff]) out.push(raw(g, CMD.write, bank, 0x00, 0x20, 1, 50));
    if (!m.lightSize) out.push(raw(g, CMD.write, LIGHT_BANK, 0, 0, 1, 1));
    for (const addr of [0x0000, 0x0001, 0x001f, 0x003f, 0x0040, 0x0100, m.profileSize - 1]) out.push(raw(g, CMD.write, 1, addr >> 8, addr & 0xff, 1, 1));
    out.push(raw(g, CMD.write, 1, 0x00, 0x2e, 0), raw(g, CMD.write, 1, 0x00, 0x2e, 49, 1), raw(g, CMD.write, 1, 0x00, 0x2e, 1, 1, 7));
    // Values out of range in each kind of field.
    const fields = gamesirFields(model);
    const first = (kind: Field["kind"]) => fields.find((f) => f.kind === kind);
    const put = (f: Field | undefined, bytes: number[], at = 0) => f && out.push(raw(g, CMD.write, f.bank === "profile" ? 1 : LIGHT_BANK, (f.at + at) >> 8, (f.at + at) & 0xff, bytes.length, ...bytes));
    put(first("percent"), [101]);
    put(first("percent"), [0xff]);
    put(first("permille16"), [0x03, 0xe9]);
    put(first("permille16"), [0x10], 1);
    put(first("permille16"), [0x00]);
    put(first("traj"), [2]);
    put(first("poll"), [m.pollRates.length]);
    put(first("remap"), [2, 0x04]);
    put(first("remap"), [3, 0x01]);
    put(first("remap"), [1, 0x0d]);
    put(first("remap"), [1, 0x10]);
    put(first("remap"), [1]);
    put(first("remap"), [0x0a], 1);
    put(first("curve"), [...GAMESIR_CURVES[0].block.slice(0, 9), 0x00]);
    put(first("curve"), GAMESIR_CURVES[0].block.slice(0, 5));
    put(first("lightSlot"), [4]);
    put(first("lightMode"), [0x02]);
    // Rumble: other frames, and none at all where the motors aren't mapped.
    out.push(raw(g, CMD.rumble, 0x66, 0x55, 101, 0), raw(g, CMD.rumble, 0x55, 0x66, 10, 10), raw(g, CMD.rumble, 0x66, 0x55, 10, 10, 1));
    if (!m.vibration) out.push(raw(g, CMD.rumble, 0x66, 0x55, 0, 0));
    // Other report ids and lengths.
    for (const id of [0x00, 0x01, 0x02, 0x10, 0x12, 0xa2]) out.push({ ...raw(g, CMD.firmware), reportId: id });
    out.push({ guard: g, reportId: GAMESIR_OUT, data: new Uint8Array(62) }, { guard: g, reportId: GAMESIR_OUT, data: new Uint8Array(64) });
  }
  // A read-only GameSir id (shared or dead channel) gets nothing.
  out.push({ guard: "input", reportId: GAMESIR_OUT, data: gamesirQuery(CMD.firmware).data });
  return out;
}

/** Every probed GameSir frame with one byte of its command, arguments and data changed (and its last byte). */
function gamesirMutations(frames: readonly Frame[]): Frame[] {
  const out: Frame[] = [];
  for (const f of frames) {
    const used = Math.min(f.data.length, (f.data[0] === CMD.write ? 5 + f.data[4] : 5) + 2);
    for (let i = 0; i < used; i++) {
      for (const v of [0x01, 0xff]) {
        if (f.data[i] === v) continue;
        const data = f.data.slice();
        data[i] = v;
        out.push({ ...f, data });
      }
    }
    const data = f.data.slice();
    data[data.length - 1] = 0xff;
    out.push({ ...f, data });
  }
  return out;
}

// ---- SCUF Envision (wave C2: reads only)

/** Every GET the SCUF panel sends (the receiver at 0, its pad at 1; 7 for the top address). */
function scufAllowed(): Frame[] {
  return [0, 1, 7].flatMap((addr) => SCUF_READS.map((prop) => ({ guard: "scuf" as const, ...scufGet(prop, addr) })));
}

function scufRefused(): Frame[] {
  const out: Frame[] = [];
  const raw = (...bytes: number[]): Frame => {
    const data = new Uint8Array(SCUF_LEN);
    data.set(bytes);
    return { guard: "scuf", reportId: 0, data };
  };
  // SET (operating mode bootloader, polling, anything), calibration, files, factory reset, firmware, pairing, sessions.
  for (const cmd of [0x01, 0x03, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x16, 0x1b, 0xff]) out.push(raw(0x08, cmd, 0x13, 0x00));
  out.push(raw(0x08, 0x01, 0x03, 0x00, 0x03), raw(0x09, 0x01, 0x03, 0x00, 0x05), raw(0x08, 0x0a, 0x03), raw(0x08, 0x0f, 0x00));
  // GETs of properties it doesn't read, BRAGI 1.5 frames, trailing bytes, other ids and lengths.
  for (const prop of [0x01, 0x02, 0x03, 0x14, 0x6e, 0x105, 0x0113, 0xffff]) out.push(raw(0x08, 0x02, prop & 0xff, prop >> 8));
  out.push(raw(0x00, 0x01, 0x00, 0x02, 0x13, 0x00), raw(0x01, 0x01, 0x05, 0x1b, 0x01), raw(0x10, 0x02, 0x13, 0x00), raw(0x08, 0x02, 0x13, 0x00, 0x01));
  out.push({ ...raw(0x08, 0x02, 0x13, 0x00), reportId: 0x01 }, { guard: "scuf", reportId: 0, data: new Uint8Array(63) }, { guard: "scuf", reportId: 0, data: new Uint8Array(65) });
  return out;
}

// ---- 8BitDo Ultimate (wave C3)

/** Every frame the 8BitDo settings and tester send: commands, all 37 reads, two whole configs written. */
function ebdAllowed(): { all: Frame[]; probe: Frame[] } {
  const g = "8bitdo" as const;
  const sample = ebdSampleConfig();
  const edited = parseEbdConfig(sample).profiles[2];
  const next = ebdApply(sample, { ...edited, name: "Drift", rumble: [0.25, 0], sticks: [{ start: 30, end: 200 }, { start: 0, end: 255 }], features: 0x1000 | 0x0002, keys: edited.keys.map((k, i) => (i === 0 ? 0x0800 : k)) });
  const commands = [ebdReportState(), ebdSave(), ebdVersion(), ebdVibrate(200, 200, 600), ebdVibrate(0, 0, 1), ebdVibrate(255, 0, 1000)].map((f) => ({ guard: g, ...f }));
  const reads = ebdReads().map((f) => ({ guard: g, reportId: f.reportId, data: f.data }));
  const writes = [...ebdWrites(sample), ...ebdWrites(next)].map((f) => ({ guard: g, reportId: f.reportId, data: f.data }));
  // Probed byte by byte: the commands, the first and last reads, and the chunks holding the header, names, rumble, keys and macros.
  const probe = [...commands.slice(0, 4), reads[0], reads[36], ...[0, 2, 3, 5, 11, 36].map((i) => writes[37 + i])];
  return { all: [...commands, ...reads, ...writes], probe };
}

function ebdRefused(): Frame[] {
  const g = "8bitdo" as const;
  const out: Frame[] = [];
  const raw = (...bytes: number[]): Frame => {
    const data = new Uint8Array(EBD_LEN);
    data.set(bytes);
    return { guard: g, reportId: 0x81, data };
  };
  // Calibration start / save (both variants), every other direct command.
  out.push(raw(0x03, 0x00, 0x36), raw(0x04, 0x00, 0x36, 0x01), raw(0x04, 0x00, 0x38, 0x01), raw(0x05, 0x00, 0x21, 0x02, 0x00), raw(0x05, 0x00, 0x20, 0x01, 0x00), raw(0x02, 0x01, 0x00));
  // Simple commands it never sends (vibration parameters, reset, others) and the known ones with wrong arguments.
  for (const cmd of [0x00, 0x03, 0x04, 0x05, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x10, 0xff]) out.push(raw(0x11, 0x04, cmd, 0x00, 0x00, 0x00));
  out.push(raw(0x11, 0x04, 0x07, 0x00, 0x01, 0x00), raw(0x11, 0x04, 0x06, 0x00, 0x14, 0x00), raw(0x11, 0x04, 0x08, 0x00, 0xe9, 0x03, 0x10, 0x10), raw(0x11, 0x04, 0x08, 0x00, 0x00, 0x00, 0x10, 0x10), raw(0x11, 0x04, 0x07, 0x00, 0x00, 0x00, 0x01));
  // Reads off the grid, past the end, of another size; writes with a bad CRC, a wrong length byte, field values out of range.
  const read = ebdReads()[2];
  for (const [at, v] of [[14, 91], [14, 0x74], [6, 44], [10, 0x75], [8, 1], [0, 0x12]] as const) {
    const d = read.data.slice();
    d[at] = v;
    out.push({ guard: g, reportId: 0x81, data: d });
  }
  const sample = ebdSampleConfig();
  const chunkWith = (mutate: (b: Uint8Array) => void, index: number) => {
    const b = sample.slice();
    mutate(b);
    const f = ebdWrites(b)[index];
    out.push({ guard: g, reportId: 0x81, data: f.data });
  };
  chunkWith((b) => (b[EBD_AT.mode] = 6), 0);
  chunkWith((b) => (b[EBD_AT.slot] = 3), 0);
  chunkWith((b) => (b[EBD_AT.names + 2] = 0x07), 0);
  chunkWith((b) => new DataView(b.buffer).setFloat32(EBD_AT.rumble + 4, 1.5, true), 2);
  chunkWith((b) => new DataView(b.buffer).setFloat32(EBD_AT.rumble + 16, Number.NaN, true), 2);
  chunkWith((b) => b.set([200, 100], EBD_AT.sticks + 4), 3);
  chunkWith((b) => new DataView(b.buffer).setUint32(EBD_AT.special + 4, 0x4000, true), 4);
  chunkWith((b) => new DataView(b.buffer).setUint32(EBD_AT.keys + 8, 0x10000000, true), 5);
  chunkWith((b) => (b[EBD_AT.macros + 4] = 5), 10);
  chunkWith((b) => (b[EBD_AT.macros + 8 + 94] = 19), 12);
  const w = ebdWrites(sample)[5].data.slice();
  w[8] ^= 0xff;
  out.push({ guard: g, reportId: 0x81, data: w });
  const w2 = ebdWrites(sample)[5].data.slice();
  w2[0] += 1;
  out.push({ guard: g, reportId: 0x81, data: w2 });
  // Other report ids and lengths; nothing for the read-only 8BitDo ids.
  for (const id of [0x00, 0x01, 0x02, 0x80, 0x82]) out.push({ ...raw(0x11, 0x04, 0x07, 0x00), reportId: id });
  out.push({ guard: g, reportId: 0x81, data: new Uint8Array(62) }, { guard: g, reportId: 0x81, data: new Uint8Array(64) });
  out.push({ guard: "input", reportId: 0x81, data: ebdReportState().data });
  return out;
}

// ---- Flydigi (wave C3)

function fdAllowed(): { all: Frame[]; probe: Frame[] } {
  const g = "flydigi" as const;
  const sample = flydigiSampleConfig(2);
  const before = parseFlydigiConfig(2, sample);
  const next = flydigiApply(sample, before, { ...before, title: "Drift", keys: before.keys.map((k, i) => (i === 4 ? 5 : i === 5 ? 4 : k)), sticks: [{ curve: 1, deadZone: 40 }, { curve: 2, deadZone: 0 }], vibration: false });
  const commands = [fdDeviceInfo(), ...[0, 1, 2, 3].map(fdReadConfig), ...[0, 3].map(fdReadRandomId), fdSave(0x1235), fdSave(0xffff), fdMotor(200, 200), fdMotor(0, 0)].map((f) => ({ guard: g, ...f }));
  const writes = [...fdWrites(0, flydigiSampleConfig(0)), ...fdWrites(2, next)].map((f) => ({ guard: g, ...f }));
  return { all: [...commands, ...writes], probe: [...commands.slice(0, 2), commands[5], commands[7], commands[9], writes[80], ...[2, 3, 11, 12, 15].map((i) => writes[80 + i])] };
}

function fdRefused(): Frame[] {
  const g = "flydigi" as const;
  const raw = (...bytes: number[]): Frame => {
    const data = new Uint8Array(FD_LEN);
    data.set(bytes);
    return { guard: g, reportId: 0x05, data };
  };
  const out: Frame[] = [];
  // The XInput switch, update mode, LED / screen writes, ForceAdapt, mapping enable, sleep, unknown commands.
  for (const cmd of [0xed, 0x17, 0xe5, 0xe6, 0xe7, 0x33, 0xd0, 0xd1, 0xa0, 0xee, 0xef, 0xf2, 0xf5, 0x10, 0x12, 0x00, 0xff]) out.push(raw(cmd, 0x01, 0x02));
  // Slots past 3, a header for another size, parcels off the end, a bad checksum, other sub-commands, trailing bytes.
  out.push(raw(0xeb, 4), raw(0xea, 79, 0xa0, 4), raw(0xea, 50, 0xa0, 0), raw(0xea, 79, 0xa1, 0), raw(0x22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xa0, 79), raw(0x22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xa1, 3));
  out.push(raw(0x50, 0x02, 1, 0x59), raw(0x50, 0x03, 0x12, 0x35, 0x00), raw(0x50, 0x05, 1), raw(0x50, 0x01), raw(0xec, 1), raw(0x0f, 1, 1, 1));
  // Parcels whose fields are out of range: an unknown key target, a turbo mode, a stick curve, a dead zone, the vibration switch.
  const parcel = (index: number, set: (b: Uint8Array) => void) => {
    const b = flydigiSampleConfig(0);
    set(b);
    out.push({ guard: g, ...fdWrites(0, b)[1 + index] });
  };
  parcel(1, (b) => (b[FD_AT.keys] = 0x50));
  parcel(1, (b) => (b[FD_AT.keys + 1] = 3));
  parcel(10, (b) => (b[FD_AT.sticks] = 4));
  parcel(11, (b) => (b[FD_AT.sticks + 8] = 200));
  parcel(14, (b) => (b[FD_AT.vibration] = 2));
  // Other report ids and lengths; nothing for the 37D7 pads (guard input).
  for (const id of [0x00, 0x03, 0x04, 0x06]) out.push({ ...raw(0xec), reportId: id });
  out.push({ guard: g, reportId: 0x05, data: new Uint8Array(62) }, { guard: g, reportId: 0x05, data: new Uint8Array(64) }, { guard: "input", reportId: 0x05, data: fdDeviceInfo().data });
  return out;
}

export function padFixtureText(): string {
  const lines: string[] = [];
  const allowed = allowedFrames();
  for (const f of [...allowed, ...refusedFrames(), ...mutations(allowed)]) {
    const v = checkPadOutput(f.guard, f.reportId, f.data);
    lines.push(`${f.guard} out:${f.reportId.toString(16).padStart(2, "0")} ${v.ok ? 1 : 0} ${hex(f.data)}`);
  }
  // The Edge's profile writes and deletes: every allowed part, the refusals, and every allowed part with one byte changed
  // (the CRC left as it was, so nearly all of those are refused; the bridge must agree on each).
  const parts = edgeFixtureParts();
  const sets = [...parts, ...edgeRefusedSets(), ...mutations(parts.map((f) => ({ guard: "edge" as const, ...f })))];
  for (const f of sets) lines.push(`edge set:${f.reportId.toString(16).padStart(2, "0")} ${checkPadFeatureSet("edge", f.reportId, f.data).ok ? 1 : 0} ${hex(f.data)}`);
  // GameSir: every kind of frame its settings send, the refusals, and a sample with one byte changed.
  const gs = gamesirFixtureFrames();
  for (const f of [...gs.allowed, ...gamesirRefused(), ...gamesirMutations(gs.probe)]) {
    const v = checkPadOutput(f.guard, f.reportId, f.data);
    lines.push(`${f.guard} out:${f.reportId.toString(16).padStart(2, "0")} ${v.ok ? 1 : 0} ${hex(f.data)}`);
  }
  // SCUF: every GET, the refusals, and the receiver's GETs with one byte changed.
  const scuf = scufAllowed();
  for (const f of [...scuf, ...scufRefused(), ...mutations(scuf.filter((f) => f.data[0] === 0x08))]) {
    const v = checkPadOutput(f.guard, f.reportId, f.data);
    lines.push(`${f.guard} out:${f.reportId.toString(16).padStart(2, "0")} ${v.ok ? 1 : 0} ${hex(f.data)}`);
  }
  // 8BitDo: every frame, the refusals, and a sample with one byte changed.
  const ebd = ebdAllowed();
  for (const f of [...ebd.all, ...ebdRefused(), ...mutations(ebd.probe)]) {
    const v = checkPadOutput(f.guard, f.reportId, f.data);
    lines.push(`${f.guard} out:${f.reportId.toString(16).padStart(2, "0")} ${v.ok ? 1 : 0} ${hex(f.data)}`);
  }
  // Flydigi: every frame, the refusals, and a sample with one byte changed.
  const fd = fdAllowed();
  for (const f of [...fd.all, ...fdRefused(), ...mutations(fd.probe)]) {
    const v = checkPadOutput(f.guard, f.reportId, f.data);
    lines.push(`${f.guard} out:${f.reportId.toString(16).padStart(2, "0")} ${v.ok ? 1 : 0} ${hex(f.data)}`);
  }
  for (const guard of [...Object.values(GAMESIR_GUARD), "scuf" as const, "8bitdo" as const, "flydigi" as const]) {
    for (const id of [0x00, 0x0f, 0x10, 0x12, 0x20, 0xff]) {
      lines.push(`${guard} get:${id.toString(16).padStart(2, "0")} ${checkPadFeatureGet(guard, id).ok ? 1 : 0} -`);
      lines.push(`${guard} set:${id.toString(16).padStart(2, "0")} ${checkPadFeatureSet(guard, id).ok ? 1 : 0} 1:00`);
    }
  }
  // Feature reads and writes: every report id, every guard.
  for (const guard of ["ds5", "edge", "ds4", "switch", "input"] as const) {
    for (let id = 0; id < 256; id++) {
      lines.push(`${guard} get:${id.toString(16).padStart(2, "0")} ${checkPadFeatureGet(guard, id).ok ? 1 : 0} -`);
      if (id % 16 === 0 || [0x05, 0x09, 0x12, 0x20, 0x60, 0x80, 0x81, 0x82, 0x83, 0xa0, 0xa3].includes(id))
        lines.push(`${guard} set:${id.toString(16).padStart(2, "0")} ${checkPadFeatureSet(guard, id).ok ? 1 : 0} 1:00`);
    }
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(PAD_FRAMES, padFixtureText());
  console.log(`wrote ${PAD_FRAMES}`);
}
