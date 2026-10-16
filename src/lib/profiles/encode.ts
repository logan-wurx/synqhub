// Game profiles, encoded OFFLINE: the settings the Games page edits become the exact reports the device's
// own driver would send, built with that driver's pure frame builders (atk-protocol.ts, x68he-protocol.ts)
// from the device's last-known state (state.ts). Nothing here talks to a device.
//
// For every row a profile changes, `steps` writes the new row and `restore` writes the row as the device
// last had it, so the helper can put the everyday settings back exactly. Every frame is checked by the
// driver's own guard here (the same verdicts as the Rust guards, see the frame fixtures), and the helper
// sends it through the Rust guards again (src-tauri/src/hid.rs), with no Advanced grant. The builders used
// here only make settings writes: no pairing, remap, macro, calibration, reset, firmware or bootloader.
//
// A device whose driver needs a live exchange to change a setting (Logitech's onboard-profile flash
// writes, brand keyboards with session handshakes) has no encoder: "Not supported for game profiles yet".
import * as A from "../atk-protocol.ts";
import * as X from "../x68he-protocol.ts";
import { isIllumipcId } from "../illumipc/ids.ts";

export type Step =
  | { kind: "output"; reportId: number; data: number[] }
  | { kind: "outputTo"; usagePage: number; usage: number; reportId: number; data: number[] }
  | { kind: "feature"; reportId: number; data: number[] };

export const NOT_SUPPORTED = "Not supported for game profiles yet";

export type Family = "atk" | "x68";

/** The ATK X1's EEPROM rows as last read (each the full row, value/check pairs included). */
export interface AtkRows {
  system: number[];
  liftOff: number[];
  function: number[];
  performance: number[];
  stages: number[][];
}

export interface AtkKnown {
  rows: AtkRows;
  pollingOptions: number[];
  debounceOptions: number[];
  dpi: { min: number; max: number; step: number; maxStages: number };
}

export interface X68Known {
  trigger: { unitMm: number; minUnits: number; maxUnits: number; minMm: number; maxMm: number; rtMinMm: number; rtMaxMm: number };
  keys: X.KeyTrigger[];
}

interface KnownBase {
  /** hid.rs device key (what the helper opens). */
  key: string;
  name: string;
  vendorId: number;
  productId: number;
  /** When the panel last read it (seconds since 1970). */
  updated: number;
}
export type KnownDevice = (KnownBase & { family: "atk"; atk: AtkKnown }) | (KnownBase & { family: "x68"; x68: X68Known });

export interface AtkSettings {
  stages: number[];
  activeStage: number;
  pollingHz: number;
  /** Null: leave lift-off alone. */
  liftOffMm: number | null;
  motionSync: boolean;
  angleSnapping: boolean;
  debounceMs: number;
}

export interface X68Settings {
  /** Every key's actuation point. */
  actuationMm: number;
  rapidTrigger: boolean;
  pressMm: number;
  releaseMm: number;
}

export type ProfileSettings = { family: "atk"; atk: AtkSettings } | { family: "x68"; x68: X68Settings };

/** Which offline encoder a device has, if any. */
export function familyOf(vendorId: number, productId: number): Family | null {
  if (vendorId === A.ATK_VENDOR_ID && A.ATK_LINKS[productId]?.verified) return "atk";
  if (isIllumipcId(vendorId, productId)) return "x68";
  return null;
}

// ---- reading the last-known state as settings

export function settingsFrom(k: KnownDevice): ProfileSettings {
  if (k.family === "atk") {
    const r = k.atk.rows;
    const sys = A.decodeSystem(r.system);
    const fn = A.decodeFunction(r.function);
    const lod = A.unpair(r.liftOff[0], r.liftOff[1]);
    return {
      family: "atk",
      atk: {
        stages: r.stages.map((row) => A.unpackPaw3955Stage(row).x),
        activeStage: sys.activeStage,
        pollingHz: sys.pollingHz,
        liftOffMm: lod === null ? null : A.liftOffMm(lod),
        motionSync: fn.motionSync,
        angleSnapping: fn.angleSnapping,
        debounceMs: fn.debounceMs,
      },
    };
  }
  const t = k.x68.trigger;
  // The most common setting across the keys stands for "every key".
  const counts = new Map<string, { k: X.KeyTrigger; n: number }>();
  for (const key of k.x68.keys) {
    const id = `${key.mode}_${key.travel}_${key.press}_${key.release}`;
    const c = counts.get(id) ?? { k: key, n: 0 };
    c.n++;
    counts.set(id, c);
  }
  const top = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.k;
  const mm = (u: number) => Math.round(u * t.unitMm * 1000) / 1000;
  return {
    family: "x68",
    x68: {
      actuationMm: top ? mm(top.travel) : t.minMm,
      rapidTrigger: !!top && top.mode !== X.TRIGGER_MODE.normal,
      pressMm: top && top.press ? mm(top.press) : t.rtMinMm,
      releaseMm: top && top.release ? mm(top.release) : t.rtMinMm,
    },
  };
}

// ---- encoding

export interface Encoded {
  steps: Step[];
  restore: Step[];
}

const same = (a: readonly number[], b: readonly number[] | undefined) => !!b && a.length === b.length && a.every((v, i) => v === b[i]);

function atkStep(address: number, row: readonly number[]): Step {
  const f = A.buildWrite(address, row);
  const problem = A.checkFrame(f);
  if (problem) throw new Error(`The ATK guard refused a profile frame: ${problem}`);
  return { kind: "output", reportId: A.REPORT_ID, data: Array.from(f) };
}

function encodeAtk(k: AtkKnown, s: AtkSettings): Encoded {
  const r = k.rows;
  const { min, max, maxStages } = k.dpi;
  if (!s.stages.length || s.stages.length > maxStages) throw new Error(`Keep 1 to ${maxStages} DPI steps.`);
  for (const d of s.stages) if (!Number.isInteger(d) || d < min || d > max) throw new Error(`DPI must be between ${min} and ${max}.`);
  if (!Number.isInteger(s.activeStage) || s.activeStage < 0 || s.activeStage >= s.stages.length) throw new Error("Pick the DPI step the mouse starts on.");
  const code = A.codeForRate(s.pollingHz);
  if (code === null || !k.pollingOptions.includes(s.pollingHz)) throw new Error(`${s.pollingHz} Hz isn't a polling rate this mouse takes.`);
  if (!k.debounceOptions.includes(s.debounceMs)) throw new Error(`${s.debounceMs} ms isn't a debounce time this mouse takes.`);
  if (s.liftOffMm !== null && !(s.liftOffMm >= A.LIFT_OFF.minMm - 1e-9 && s.liftOffMm <= A.LIFT_OFF.maxMm + 1e-9)) throw new Error(`Lift-off is ${A.LIFT_OFF.minMm} to ${A.LIFT_OFF.maxMm} mm.`);

  // [address, new row, row as last read (null: never read)]
  const rows: [number, number[], number[] | null][] = [];
  s.stages.forEach((dpi, i) => rows.push([A.ADDR.paw3955Dpi + i * A.PAW3955_STAGE_LENGTH, A.packPaw3955Stage(dpi), r.stages[i] ?? null]));
  let sys = A.withPair(r.system, 0, code);
  sys = A.withPair(sys, 2, s.stages.length);
  sys = A.withPair(sys, 4, s.activeStage);
  rows.push([A.ADDR.system, sys, r.system]);
  if (s.liftOffMm !== null) rows.push([A.ADDR.liftOff, A.pair(A.liftOffCode(s.liftOffMm)), r.liftOff]);
  let fn = A.withPair(r.function, A.FN.debounce, s.debounceMs);
  fn = A.withPair(fn, A.FN.motionSync, s.motionSync ? 1 : 0);
  fn = A.withPair(fn, A.FN.angleSnapping, s.angleSnapping ? 1 : 0);
  rows.push([A.ADDR.function, fn, r.function]);

  const steps: Step[] = [];
  const restore: Step[] = [];
  for (const [address, row, old] of rows) {
    if (old && same(row, old)) continue;
    steps.push(atkStep(address, row));
    // A stage row the mouse didn't use before is left as written: the restored step count hides it.
    if (old) restore.push(atkStep(address, old));
  }
  // Put the step count and the active step back last, after the rows they point at.
  restore.sort((a, b) => Number(isSystem(a)) - Number(isSystem(b)));
  return { steps, restore };
}

const isSystem = (s: Step) => s.data[2] === 0 && s.data[3] === 0 && s.data[0] === A.CMD.setEeprom;

function x68Step(f: Uint8Array): Step {
  const c = X.checkFrame(f);
  if (!c.ok || c.access !== "write") throw new Error(`The X68 HE guard refused a profile frame: ${c.reason ?? c.name}`);
  return { kind: "outputTo", usagePage: X.X68.usagePage, usage: X.X68.usage, reportId: X.X68.reportId, data: Array.from(f) };
}

function encodeX68(k: X68Known, s: X68Settings): Encoded {
  const t = k.trigger;
  const units = (mm: number) => Math.round(mm / t.unitMm);
  const travel = units(s.actuationMm);
  if (travel < t.minUnits || travel > t.maxUnits) throw new Error(`Actuation is ${t.minMm} to ${t.maxMm} mm.`);
  const press = units(s.pressMm);
  const release = units(s.releaseMm);
  if (s.rapidTrigger && (press < 1 || release < 1 || press * t.unitMm > t.rtMaxMm + 1e-9 || release * t.unitMm > t.rtMaxMm + 1e-9))
    throw new Error(`Rapid-trigger sensitivity is ${t.rtMinMm} to ${t.rtMaxMm} mm.`);
  if (!k.keys.length) throw new Error("SYNQ hasn't read this keyboard's keys yet.");
  const mode = s.rapidTrigger ? X.TRIGGER_MODE.rapid : X.TRIGGER_MODE.normal;
  const want = k.keys.map((key) => ({ index: key.index, mode, travel, press: s.rapidTrigger ? press : key.press, release: s.rapidTrigger ? release : key.release }));
  const changed = want.filter((w, i) => {
    const o = k.keys[i];
    return o.mode !== w.mode || o.travel !== w.travel || (s.rapidTrigger && (o.press !== w.press || o.release !== w.release));
  });
  const old = k.keys.filter((o) => changed.some((c) => c.index === o.index));
  if (old.some((o) => !X.WRITABLE_TRIGGER_MODES.includes(o.mode))) throw new Error("Some keys use a trigger mode SYNQ can't put back.");
  return { steps: X.encodeTriggerWrites(changed).map(x68Step), restore: X.encodeTriggerWrites(old).map(x68Step) };
}

/** The profile for one device: its reports, and the reports that put it back. Throws on a setting the device can't take. */
export function encode(k: KnownDevice, s: ProfileSettings): Encoded {
  if (k.family === "atk" && s.family === "atk") return encodeAtk(k.atk, s.atk);
  if (k.family === "x68" && s.family === "x68") return encodeX68(k.x68, s.x68);
  throw new Error("Those settings are for another kind of device.");
}
