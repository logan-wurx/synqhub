// GameSir's HID controllers (wave C2): the Cyclone 2, the G7 Pro 8K PC and the Tarantula Pro 8K. Their settings are
// registers in per-profile banks, read and written over the vendor HID collection (usage page 0xFFF0) with output
// report 0x0F; answers come back as input report 0x10, the live state as 0x12.
//
// Sources (MIT): MiguelSanzBr/gamesir-cyclone2-linux (docs/PROTOCOL.md, from GameSir Connect, checked on a Cyclone 2)
// and broroeror/gamesir-linux-tools ("Deadband": controller_profile.py / vendors/gamesir/config.py, register maps
// verified on each model). Per-PID only: an id the sources don't name as configurable is read only (models.ts).
//
// Safety: SYNQ sends only the commands below, and writes only into the fields of FIELDS (each with its allowed
// values): vibration, report rate, stick and trigger dead zones, stick trajectory, the Cyclone's curve presets, button
// remaps to gamepad buttons, and the lighting effect / mode. Never the firmware loader (0x0F 0x17 55 88: it reboots the
// pad into its JieLi bootloader), never macros, turbo, keyboard or mouse targets, the Shift layer or a raw bank write.
// guard.ts and src-tauri/src/pads.rs check every frame against the same table (generated into controller_ids.rs).
// Pure data and functions: no DOM, no React, no device access.

export type GamesirModel = "cyclone2" | "g7pro8k" | "tarantula";

export const GAMESIR_OUT = 0x0f;
export const GAMESIR_ANSWER = 0x10;
export const GAMESIR_STATE = 0x12;
/** Bytes after the report id. */
export const GAMESIR_LEN = 63;

export const CMD = { write: 0x03, read: 0x04, readAck: 0x05, ack: 0x06, switchProfile: 0x07, firmware: 0x09, firmwareAck: 0x0a, active: 0x0b, activeAck: 0x0c, rumble: 0x20, heartbeat: 0xf2 } as const;
/** Commands that are never sent, by name (the guard refuses every command not in CMD anyway). */
export const GAMESIR_NEVER: Readonly<Record<number, string>> = { 0x17: "firmware loader (reboots into the JieLi bootloader)", 0x16: "macro recording", 0x0d: "LED keyframe playback" };

/** Most data bytes a write carries (Deadband's bare frames: 48), and a read asks for (56). */
export const WRITE_MAX = 48;
export const READ_MAX = 56;
export const LIGHT_BANK = 0x20;

export interface GamesirMap {
  model: GamesirModel;
  name: string;
  /** Bytes of a profile bank SYNQ reads (the known span), and of the lighting bank (0: not mapped). */
  profileSize: number;
  lightSize: number;
  /** Report-rate codes (index = code). */
  pollRates: readonly number[];
  vibration: boolean;
  /** Stick / trigger dead zones: 8-bit percent (Cyclone) or 16-bit big-endian percent x10 (the 8K engine). */
  wideDeadzones: boolean;
  trigger: { dzMin: number; rtOffset: number; curve: number | null };
  stick: { traj: number; dzMin: number; rsOffset: number; curve: number | null };
  remaps: readonly { name: string; at: number }[];
  /** Lighting fields in bank 0x20. */
  light: { kind: "slot"; at: 0 } | { kind: "mode"; mode: 0; brightness: 1 } | null;
}

const STANDARD_REMAPS = [
  ["D-pad up", 0x0042],
  ["D-pad down", 0x0049],
  ["D-pad left", 0x0050],
  ["D-pad right", 0x0057],
  ["LB", 0x005e],
  ["RB", 0x0065],
  ["LS", 0x006c],
  ["RS", 0x0073],
  ["A", 0x007a],
  ["B", 0x0081],
  ["X", 0x0088],
  ["Y", 0x008f],
  ["L4", 0x00b2],
] as const;
const remaps = (extra: readonly (readonly [string, number])[]) => [...STANDARD_REMAPS, ...extra].map(([name, at]) => ({ name, at }));

/** The 8K's register map; the Tarantula's sits 5 x 0xA9 higher after its button blocks. */
const TAR = 5 * 0xa9;

export const GAMESIR_MAPS: Readonly<Record<GamesirModel, GamesirMap>> = {
  cyclone2: {
    model: "cyclone2",
    name: "GameSir Cyclone 2",
    profileSize: 680,
    lightSize: 635,
    pollRates: [250, 500, 1000],
    vibration: true,
    wideDeadzones: false,
    trigger: { dzMin: 0x01f1, rtOffset: 0x1c, curve: 0x01fe },
    stick: { traj: 0x0227, dzMin: 0x0229, rsOffset: 0x20, curve: 0x022e },
    remaps: remaps([
      ["R4", 0x0151],
      ["LT", 0x01f5],
      ["RT", 0x0211],
      ["View", 0x009d],
      ["Menu", 0x00a4],
      ["Capture", 0x00ab],
    ]),
    light: { kind: "slot", at: 0 },
  },
  g7pro8k: {
    model: "g7pro8k",
    name: "GameSir G7 Pro 8K PC",
    profileSize: 0x0430,
    lightSize: 0x00a4,
    pollRates: [250, 500, 1000, 2000, 4000, 8000],
    vibration: true,
    wideDeadzones: true,
    trigger: { dzMin: 0x0357, rtOffset: 0x20, curve: null },
    stick: { traj: 0x0395, dzMin: 0x0397, rsOffset: 0x24, curve: null },
    remaps: remaps([
      ["R4", 0x015b],
      ["L5", 0x0204],
      ["R5", 0x02ad],
    ]),
    light: { kind: "mode", mode: 0, brightness: 1 },
  },
  tarantula: {
    model: "tarantula",
    name: "GameSir Tarantula Pro 8K",
    profileSize: 0x0430 + TAR,
    lightSize: 0,
    pollRates: [250, 500, 1000, 2000, 4000, 8000],
    vibration: false,
    wideDeadzones: true,
    trigger: { dzMin: 0x0357 + TAR, rtOffset: 0x20, curve: null },
    stick: { traj: 0x0395 + TAR, dzMin: 0x0397 + TAR, rsOffset: 0x24, curve: null },
    remaps: remaps([
      ["R4", 0x015b],
      ["C1", 0x0204],
      ["C2", 0x02ad],
      ["C3", 0x0356],
      ["C4", 0x03ff],
      ["T1", 0x04a8],
      ["T2", 0x0551],
      ["T3", 0x05fa],
    ]),
    light: null,
  },
};

/**
 * Configurable ids, per model (the sources' lists; any other GameSir id is read only). Not 0x0575: a wired Cyclone in
 * its extras mode and an idle G7 Pro 8K dongle share it, and the two register maps differ.
 */
export const GAMESIR_IDS: Readonly<Record<GamesirModel, readonly number[]>> = {
  cyclone2: [0x1053, 0x101d, 0x102a, 0x100b],
  g7pro8k: [0x10c7, 0x10c8, 0x10c5, 0x10c6, 0x1032, 0x1033, 0x10b7, 0x10b9],
  tarantula: [0x103d],
};

export const gamesirModelOf = (pid: number): GamesirModel | null => (Object.keys(GAMESIR_IDS) as GamesirModel[]).find((m) => GAMESIR_IDS[m].includes(pid)) ?? null;

/** Remap targets SYNQ offers: gamepad buttons only (no keyboard, mouse, macro or turbo). */
export const GAMESIR_TARGETS: readonly { name: string; code: number }[] = [
  { name: "D-pad up", code: 0x01 },
  { name: "D-pad down", code: 0x02 },
  { name: "D-pad left", code: 0x03 },
  { name: "D-pad right", code: 0x04 },
  { name: "LB", code: 0x05 },
  { name: "RB", code: 0x06 },
  { name: "LS", code: 0x07 },
  { name: "RS", code: 0x08 },
  { name: "A", code: 0x09 },
  { name: "B", code: 0x0a },
  { name: "X", code: 0x0b },
  { name: "Y", code: 0x0c },
  { name: "View", code: 0x0e },
  { name: "Menu", code: 0x0f },
  { name: "LT", code: 0x13 },
  { name: "RT", code: 0x14 },
  { name: "Disabled", code: 0xff },
];

/** The Cyclone's three curve presets (captured blocks, written whole). */
export const GAMESIR_CURVES: readonly { name: string; block: readonly number[] }[] = [
  { name: "Linear", block: [0x00, 0x64, 0x00, 0x00, 0x28, 0x29, 0x80, 0x80, 0xd7, 0xd6] },
  { name: "Concave", block: [0x01, 0x64, 0x00, 0x00, 0x5e, 0x17, 0xb0, 0x4f, 0xe8, 0xa1] },
  { name: "S-Curve", block: [0x02, 0x64, 0x00, 0x00, 0x28, 0x4d, 0x80, 0x80, 0xd7, 0xb3] },
];

/** The 8K's lighting modes (bank 0x20, 0x0000). */
export const G7_8K_LIGHT_MODES: readonly { name: string; code: number }[] = [
  { name: "Rainbow", code: 0x00 },
  { name: "Off", code: 0x01 },
  { name: "Colourful", code: 0x03 },
  { name: "Static", code: 0x04 },
];

// ---- the write allowlist

/** What a field holds: the guard checks every byte a write puts into it. */
export type FieldKind = "percent" | "permille16" | "traj" | "poll" | "remap" | "curve" | "lightSlot" | "lightMode";

export interface Field {
  name: string;
  bank: "profile" | "light";
  at: number;
  len: number;
  kind: FieldKind;
}

/** Every field a model's writes may touch. */
export function gamesirFields(model: GamesirModel): Field[] {
  const m = GAMESIR_MAPS[model];
  const f: Field[] = [];
  const add = (name: string, bank: Field["bank"], at: number, len: number, kind: FieldKind) => f.push({ name, bank, at, len, kind });
  if (m.vibration) add("vibration", "profile", 0x0020, 2, "percent");
  add("report rate", "profile", 0x002e, 1, "poll");
  const dz = m.wideDeadzones ? 8 : 4;
  const dzKind: FieldKind = m.wideDeadzones ? "permille16" : "percent";
  for (const [name, off] of [
    ["LT dead zone", 0],
    ["RT dead zone", m.trigger.rtOffset],
  ] as const)
    add(name, "profile", m.trigger.dzMin + off, dz, dzKind);
  for (const [name, off] of [
    ["left stick", 0],
    ["right stick", m.stick.rsOffset],
  ] as const) {
    add(`${name} trajectory`, "profile", m.stick.traj + off, 1, "traj");
    add(`${name} dead zone`, "profile", m.stick.dzMin + off, dz, dzKind);
    if (m.stick.curve !== null) add(`${name} curve`, "profile", m.stick.curve + off, 10, "curve");
  }
  if (m.trigger.curve !== null) {
    add("LT curve", "profile", m.trigger.curve, 10, "curve");
    add("RT curve", "profile", m.trigger.curve + m.trigger.rtOffset, 10, "curve");
  }
  for (const r of m.remaps) add(`${r.name} remap`, "profile", r.at, 2, "remap");
  if (m.light?.kind === "slot") add("lighting effect", "light", 0, 1, "lightSlot");
  if (m.light?.kind === "mode") {
    add("lighting mode", "light", 0, 1, "lightMode");
    add("lighting brightness", "light", 1, 1, "percent");
  }
  return f;
}

/** Why these bytes may not go into this field (at `offset` inside it), or null. */
export function fieldProblem(model: GamesirModel, field: Field, offset: number, bytes: Uint8Array): string | null {
  const m = GAMESIR_MAPS[model];
  switch (field.kind) {
    case "percent":
      return bytes.every((b) => b <= 100) ? null : `${field.name}: 0 to 100`;
    case "permille16": {
      if ((offset & 1) !== 0 || bytes.length % 2 !== 0) return `${field.name}: whole 16-bit values`;
      for (let i = 0; i < bytes.length; i += 2) if (((bytes[i] << 8) | bytes[i + 1]) > 1000) return `${field.name}: 0 to 1000`;
      return null;
    }
    case "traj":
      return bytes.every((b) => b <= 1) ? null : `${field.name}: circle or raw`;
    case "poll":
      return bytes[0] < m.pollRates.length ? null : `report rate code ${bytes[0]}`;
    case "remap":
      if (offset !== 0 || bytes.length !== 2) return `${field.name}: the whole record`;
      if (bytes[0] === 0 && bytes[1] === 0) return null;
      return bytes[0] === 1 && GAMESIR_TARGETS.some((t) => t.code === bytes[1]) ? null : `${field.name}: a gamepad button`;
    case "curve":
      return offset === 0 && GAMESIR_CURVES.some((c) => c.block.length === bytes.length && c.block.every((v, i) => v === bytes[i])) ? null : `${field.name}: one of the presets, whole`;
    case "lightSlot":
      return bytes[0] <= 3 ? null : "lighting effect 1 to 4";
    case "lightMode":
      return G7_8K_LIGHT_MODES.some((l) => l.code === bytes[0]) ? null : "lighting mode";
  }
}

export type GamesirVerdict = { ok: true; what: string } | { ok: false; why: string };

/** The guard for one output report to a GameSir pad of this model (`data` excludes the report id). */
export function checkGamesirOutput(model: GamesirModel, reportId: number, data: Uint8Array): GamesirVerdict {
  const no = (why: string): GamesirVerdict => ({ ok: false, why: `GameSir: ${why}.` });
  if (reportId !== GAMESIR_OUT) return no(`output report 0x${reportId.toString(16)} isn't the config channel's`);
  if (data.length !== GAMESIR_LEN) return no("config reports are 64 bytes");
  const cmd = data[0];
  const rest = (from: number) => data.subarray(from).every((b) => b === 0);
  const m = GAMESIR_MAPS[model];
  const bankSize = (bank: number) => (bank >= 1 && bank <= 4 ? m.profileSize : bank === LIGHT_BANK ? m.lightSize : 0);
  switch (cmd) {
    case CMD.heartbeat:
    case CMD.firmware:
    case CMD.active:
      return rest(1) ? { ok: true, what: "query" } : no("queries carry no data");
    case CMD.switchProfile:
      return data[1] >= 1 && data[1] <= 4 && rest(2) ? { ok: true, what: `profile ${data[1]}` } : no("profiles 1 to 4");
    case CMD.rumble:
      if (!m.vibration) return no(`${m.name}: no rumble is sent (its motors aren't mapped)`);
      return data[1] === 0x66 && data[2] === 0x55 && data[3] <= 100 && data[4] <= 100 && rest(5) ? { ok: true, what: "rumble test" } : no("the rumble test frame");
    case CMD.read: {
      const [bank, addr, len] = [data[1], (data[2] << 8) | data[3], data[4]];
      if (!bankSize(bank)) return no(`bank 0x${bank.toString(16)} isn't read`);
      if (len < 1 || len > READ_MAX || addr + len > bankSize(bank) || !rest(5)) return no("a read inside the bank, 1 to 56 bytes");
      return { ok: true, what: `read ${bank}:${addr.toString(16)}+${len}` };
    }
    case CMD.write: {
      const [bank, addr, len] = [data[1], (data[2] << 8) | data[3], data[4]];
      if (len < 1 || len > WRITE_MAX || !rest(5 + len)) return no("a write of 1 to 48 bytes");
      if ((addr & 0xff) + len > 0x100) return no("a write crosses a register page");
      const where: Field["bank"] | null = bank >= 1 && bank <= 4 ? "profile" : bank === LIGHT_BANK && m.lightSize ? "light" : null;
      if (!where) return no(`bank 0x${bank.toString(16)} isn't written`);
      const field = gamesirFields(model).find((f) => f.bank === where && addr >= f.at && addr + len <= f.at + f.len);
      if (!field) return no(`0x${addr.toString(16)}+${len} isn't a field SYNQ writes`);
      const why = fieldProblem(model, field, addr - field.at, data.subarray(5, 5 + len));
      return why ? no(why) : { ok: true, what: `write ${field.name}` };
    }
    default:
      return no(`command 0x${cmd.toString(16)}${GAMESIR_NEVER[cmd] ? ` (${GAMESIR_NEVER[cmd]})` : ""} is never sent`);
  }
}

// ---- frames

const frame = (...bytes: number[]) => {
  const d = new Uint8Array(GAMESIR_LEN);
  d.set(bytes);
  return { reportId: GAMESIR_OUT, data: d };
};

export const gamesirQuery = (cmd: typeof CMD.heartbeat | typeof CMD.firmware | typeof CMD.active) => frame(cmd);
export const gamesirSwitch = (profile: number) => frame(CMD.switchProfile, profile);
/** The rumble test (each motor 0 to 100 of the pad's 255: a gentle test), and its stop frame. */
export const gamesirRumble = (left: number, right: number) => frame(CMD.rumble, 0x66, 0x55, Math.min(100, left), Math.min(100, right));
export const GAMESIR_STOP = gamesirRumble(0, 0);

/** Reads of `len` bytes from `addr`, in packets of at most 56. */
export function gamesirReads(bank: number, addr: number, len: number): { reportId: number; data: Uint8Array }[] {
  const out = [];
  for (let a = addr; a < addr + len; a += READ_MAX) {
    const n = Math.min(READ_MAX, addr + len - a);
    out.push(frame(CMD.read, bank, a >> 8, a & 0xff, n));
  }
  return out;
}

/** Writes of `bytes` at `addr`, in packets of at most 48 that never cross a 256-byte page. */
export function gamesirWrites(bank: number, addr: number, bytes: readonly number[]): { reportId: number; data: Uint8Array }[] {
  const out = [];
  let pos = 0;
  while (pos < bytes.length) {
    const a = addr + pos;
    const n = Math.min(WRITE_MAX, 0x100 - (a & 0xff), bytes.length - pos);
    out.push(frame(CMD.write, bank, a >> 8, a & 0xff, n, ...bytes.slice(pos, pos + n)));
    pos += n;
  }
  return out;
}

// ---- answers and the state report

export interface GamesirAnswer {
  cmd: number;
  /** Ack: busy (send again). */
  busy?: boolean;
  read?: { bank: number; addr: number; data: Uint8Array };
  firmware?: { controller: string; dongle: string };
  profile?: number;
}

const version = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).filter((c) => c !== "\0" && c.trim()).join(".");

/** An input report 0x10 (data without the id). */
export function parseGamesirAnswer(data: Uint8Array): GamesirAnswer | null {
  if (data.length < 2) return null;
  const cmd = data[0];
  if (cmd === CMD.ack) return { cmd, busy: data[1] === 1 };
  if (cmd === CMD.readAck && data.length >= 5) return { cmd, read: { bank: data[1], addr: (data[2] << 8) | data[3], data: data.slice(5, 5 + data[4]) } };
  if (cmd === CMD.firmwareAck && data.length >= 16) return { cmd, firmware: { controller: version(data.subarray(3, 8)), dongle: version(data.subarray(11, 16)) } };
  if (cmd === CMD.activeAck) return { cmd, profile: data[1] };
  return { cmd };
}

// ---- settings as the page shows them

/** Whether these are the whole bytes of a value SYNQ may write into this field (the guard's own rule). */
export const gamesirAccepts = (model: GamesirModel, field: Field, bytes: readonly number[]): boolean =>
  bytes.length === field.len && fieldProblem(model, field, 0, Uint8Array.from(bytes)) === null;

/** A field's bytes in a bank image (read from address 0). */
export const fieldBytes = (image: Uint8Array, field: Field): number[] => Array.from(image.subarray(field.at, field.at + field.len));

/** Dead zone blocks: [dead zone, max, anti-dead zone, anti-dead zone max], in percent (the 8K's are tenths of one). */
export function deadzoneValues(field: Field, bytes: readonly number[]): number[] {
  if (field.kind === "permille16") return [0, 2, 4, 6].map((i) => ((bytes[i] << 8) | bytes[i + 1]) / 10);
  return [...bytes];
}
export function deadzoneBytes(field: Field, values: readonly number[]): number[] {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  if (field.kind === "permille16") return values.flatMap((v) => [Math.round(clamp(v) * 10) >> 8, Math.round(clamp(v) * 10) & 0xff]);
  return values.map((v) => Math.round(clamp(v)));
}

/** Which curve preset a curve block is (-1: one drawn in GameSir Connect, kept as it is). */
export const curvePreset = (bytes: readonly number[]): number => GAMESIR_CURVES.findIndex((c) => c.block.length === bytes.length && c.block.every((v, i) => v === bytes[i]));

/** A remap record as a target code (null: not remapped). */
export const remapTarget = (bytes: readonly number[]): number | null => (bytes[0] === 0 && bytes[1] === 0 ? null : bytes[1]);
export const remapBytes = (target: number | null): number[] => (target === null ? [0, 0] : [1, target]);
