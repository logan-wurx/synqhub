// Runs a plan's steps through a device's own session, one at a time, the same calls its panel makes when a
// person changes the setting by hand. Each session already does what the safety rules ask (the tier and
// "Allow changes", one backup before the first write, a read-back after each change), so this adds no way
// to the device: it only turns the plan's human-unit steps into those calls. It stops at the first one that
// fails or doesn't read back, and says how far it got. The session objects are described by the few methods
// used, so the tests drive them with stand-ins.
import type { MouseView } from "../mouse.ts";
import type { AtkView } from "../atk-session.ts";
import type { Change, GenericView, WriteResult } from "../openmouse/safe-mouse.ts";
import type { KbAnyChange, KbView, KbWriteResult } from "../kb/types.ts";
import type { ProfileSettings } from "../keyboard.ts";
import type { KeyTrigger, SocdEntry } from "../x68he-protocol.ts";
import type { X68View } from "../x68he.ts";
import { FALCHION_LIMITS, X68_MODE, X68_SOCD_CODE, genericKeyIndex, hidUsageOf, x68EditableKeys } from "./devices.ts";
import { clamp, mmToUnits } from "./units.ts";
import type { SocdPairFeel, Step } from "./types.ts";

export interface ApplyOutcome<V> {
  /** Every step was written (and read back where the device can). */
  ok: boolean;
  /** How many steps went through, out of `total`. */
  done: number;
  total: number;
  /** Why it stopped, in a sentence for the person. */
  error: string | null;
  /** The device's view after the last step that went through. */
  view: V | null;
}

const message = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^Error: /, "");

interface One<V> {
  view: V;
  /** The change was sent but the device read back something else. */
  problem?: string;
}

async function sequence<V>(steps: readonly Step[], one: (step: Step) => Promise<One<V>>, onView?: (v: V) => void): Promise<ApplyOutcome<V>> {
  let view: V | null = null;
  let done = 0;
  for (const step of steps) {
    try {
      const r = await one(step);
      view = r.view;
      onView?.(r.view);
      if (r.problem) return { ok: false, done, total: steps.length, error: r.problem, view };
      done++;
    } catch (e) {
      return { ok: false, done, total: steps.length, error: message(e), view };
    }
  }
  return { ok: true, done, total: steps.length, error: null, view };
}

const unsupported = (step: Step): never => {
  throw new Error(`This device can't take a "${step.kind}" change from here.`);
};

// ---------------------------------------------------------------------------------------------
// Mice
// ---------------------------------------------------------------------------------------------

export interface LogitechLike {
  saveStages(stages: number[], defaultStage: number): Promise<MouseView>;
  setActiveDpi(dpi: number): Promise<MouseView>;
  setPolling(hz: number): Promise<MouseView>;
  setLod(lod: "Low" | "Medium" | "High"): Promise<MouseView>;
}

export function driveLogitech(s: LogitechLike, steps: readonly Step[], onView?: (v: MouseView) => void): Promise<ApplyOutcome<MouseView>> {
  return sequence(
    steps,
    async (step) => {
      switch (step.kind) {
        case "stages":
          return { view: await s.saveStages(step.values, step.active) };
        case "dpi":
          return { view: await s.setActiveDpi(step.dpi) };
        case "polling":
          return { view: await s.setPolling(step.hz) };
        case "lod":
          if ("level" in step) return { view: await s.setLod(step.level) };
          return unsupported(step);
        default:
          return unsupported(step);
      }
    },
    onView,
  );
}

export interface AtkLike {
  saveStages(stages: number[], activeStage: number): Promise<AtkView>;
  setActiveDpi(dpi: number): Promise<AtkView>;
  setPolling(hz: number): Promise<AtkView>;
  setLiftOff(mm: number): Promise<AtkView>;
  setAngleSnapping(on: boolean): Promise<AtkView>;
  setRippleControl(on: boolean): Promise<AtkView>;
  setMotionSync(on: boolean): Promise<AtkView>;
  setDebounce(ms: number): Promise<AtkView>;
}

export function driveAtk(s: AtkLike, steps: readonly Step[], onView?: (v: AtkView) => void): Promise<ApplyOutcome<AtkView>> {
  return sequence(
    steps,
    async (step) => {
      switch (step.kind) {
        case "stages":
          return { view: await s.saveStages(step.values, step.active) };
        case "dpi":
          return { view: await s.setActiveDpi(step.dpi) };
        case "polling":
          return { view: await s.setPolling(step.hz) };
        case "lod":
          if ("mm" in step) return { view: await s.setLiftOff(step.mm) };
          return unsupported(step);
        case "debounce":
          return { view: await s.setDebounce(step.ms) };
        case "toggle":
          return { view: await (step.setting === "angleSnapping" ? s.setAngleSnapping(step.on) : step.setting === "motionSync" ? s.setMotionSync(step.on) : s.setRippleControl(step.on)) };
        default:
          return unsupported(step);
      }
    },
    onView,
  );
}

export interface SafeMouseLike {
  apply(change: Change): Promise<WriteResult>;
}

/** A generic (OpenMouse) mouse: SafeMouse.apply, which backs up first and reads every change back. */
export function driveGenericMouse(s: SafeMouseLike, steps: readonly Step[], onView?: (v: GenericView) => void): Promise<ApplyOutcome<GenericView>> {
  const result = (r: WriteResult): One<GenericView> => ({ view: r.view, problem: r.verdict === "mismatch" ? r.detail : undefined });
  return sequence(
    steps,
    async (step) => {
      switch (step.kind) {
        case "stages":
          return result(await s.apply({ kind: "stages", values: step.values, active: step.active }));
        case "dpi":
          return result(await s.apply({ kind: "dpi", dpi: step.dpi }));
        case "polling":
          return result(await s.apply({ kind: "polling", hz: step.hz }));
        case "lod":
          if ("level" in step) return result(await s.apply({ kind: "lod", value: step.level }));
          return unsupported(step);
        case "debounce":
          return result(await s.apply({ kind: "debounce", ms: step.ms }));
        case "toggle":
          return result(await s.apply({ kind: "toggle", setting: step.setting, on: step.on }));
        default:
          return unsupported(step);
      }
    },
    onView,
  );
}

// ---------------------------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------------------------

export interface KbSessionLike {
  apply(change: KbAnyChange): Promise<KbWriteResult>;
}

/** A generic keyboard: KbSession.apply, one change per step, each read back by the session. */
export function driveGenericKeyboard(s: KbSessionLike, view: KbView, steps: readonly Step[], onView?: (v: KbView) => void): Promise<ApplyOutcome<KbView>> {
  const a = view.analog;
  const keys = genericKeyIndex(view);
  const target = (): "global" | number[] => {
    if (!a) throw new Error("This keyboard has no analog settings.");
    if (a.scope !== "per-key") return "global";
    const list = a.keys ?? view.keymap?.layout.keys.map((k) => k.index) ?? [];
    if (!list.length) throw new Error("SYNQ can't tell which keys are analog on this keyboard.");
    return [...list];
  };
  const result = (r: KbWriteResult): One<KbView> => ({ view: r.view, problem: r.verdict === "mismatch" ? r.detail : undefined });
  const independent = !!a?.writable.includes("rtReleaseMm");
  return sequence(
    steps,
    async (step) => {
      switch (step.kind) {
        case "actuation":
          return result(await s.apply({ kind: "analog", target: target(), values: { actuationMm: step.mm } }));
        case "rapidTrigger":
          return result(await s.apply({ kind: "analog", target: target(), values: { rapidTrigger: step.on } }));
        case "rtSensitivity":
          return result(await s.apply({ kind: "analog", target: target(), values: independent ? { rtPressMm: step.pressMm, rtReleaseMm: step.releaseMm } : { rtPressMm: step.pressMm } }));
        case "socd": {
          let last: KbWriteResult | null = null;
          for (const p of step.pairs) {
            const x = keys.get(p.a);
            const y = keys.get(p.b);
            if (x === undefined || y === undefined) throw new Error(`${x === undefined ? p.a : p.b} isn't a key SYNQ can find on this keyboard.`);
            last = await s.apply({ kind: "socd", keys: [x, y], mode: p.mode });
            if (last.verdict === "mismatch") return result(last);
          }
          if (!last) throw new Error("No SOCD pair to set.");
          return result(last);
        }
        default:
          return unsupported(step);
      }
    },
    onView,
  );
}

/** The Falchion's whole feel as one edit of its profile (in 0.1 mm units); the session batches and saves it. */
export function applyToFalchion(s: ProfileSettings, steps: readonly Step[]): void {
  const L = FALCHION_LIMITS;
  for (const step of steps) {
    if (step.kind === "actuation") s.actuation = clamp(mmToUnits(step.mm, 0.1), L.actuation.min, L.actuation.max);
    else if (step.kind === "rapidTrigger") s.rapidTrigger.enabled = step.on;
    else if (step.kind === "rtSensitivity") {
      const press = clamp(mmToUnits(step.pressMm, 0.1), L.rapidTrigger.min, L.rapidTrigger.max);
      const release = clamp(mmToUnits(step.releaseMm, 0.1), L.rapidTrigger.min, L.rapidTrigger.max);
      s.rapidTrigger.sensitivity = press;
      s.rapidTrigger.press = press;
      s.rapidTrigger.release = release;
      s.rapidTrigger.independent = press !== release;
    } else unsupported(step);
  }
}

export interface FalchionLike {
  update(label: string, change: (s: ProfileSettings) => void): Promise<unknown>;
}

const FALCHION_STEPS: readonly Step["kind"][] = ["actuation", "rapidTrigger", "rtSensitivity"];

export async function driveFalchion(s: FalchionLike, steps: readonly Step[]): Promise<ApplyOutcome<null>> {
  try {
    // Checked before anything is queued, so an unsupported step never leaves half an edit behind.
    for (const step of steps) if (!FALCHION_STEPS.includes(step.kind)) unsupported(step);
    await s.update("Keep your feel", (p) => applyToFalchion(p, steps));
    return { ok: true, done: steps.length, total: steps.length, error: null, view: null };
  } catch (e) {
    return { ok: false, done: 0, total: steps.length, error: message(e), view: null };
  }
}

type X68State = X68View["state"];
const isRtMode = (m: number) => m === X68_MODE.rapidLegacy || m === X68_MODE.rapid || m === X68_MODE.rapidSplit;

/** The X68 HE key triggers after the steps: only keys that end up different are returned. */
export function x68Triggers(st: X68State, steps: readonly Step[]): KeyTrigger[] {
  const t = st.trigger;
  if (!t) throw new Error("SYNQ couldn't read this keyboard's trigger table.");
  const unit = t.unitMm;
  const editable = x68EditableKeys(st);
  const next = new Map<number, KeyTrigger>(editable.map((i) => [i, { ...st.keys[i] }]));
  let rt: boolean | null = null;
  for (const step of steps) {
    if (step.kind === "actuation") {
      const travel = clamp(mmToUnits(step.mm, unit), t.minUnits, t.maxUnits);
      for (const k of next.values()) k.travel = travel;
    } else if (step.kind === "rtSensitivity") {
      const lo = Math.max(1, mmToUnits(t.rtMinMm, unit));
      const hi = mmToUnits(t.rtMaxMm, unit);
      const press = clamp(mmToUnits(step.pressMm, unit), lo, hi);
      const release = clamp(mmToUnits(step.releaseMm, unit), lo, hi);
      for (const k of next.values()) {
        k.press = press;
        k.release = release;
      }
    } else if (step.kind === "rapidTrigger") rt = step.on;
    else unsupported(step);
  }
  const out: KeyTrigger[] = [];
  for (const [i, k] of next) {
    const was = isRtMode(st.keys[i].mode);
    const on = rt === null ? was : rt;
    if (!on) {
      if (was) k.mode = X68_MODE.normal;
    } else if (!was || k.press !== st.keys[i].press || k.release !== st.keys[i].release) {
      // Separate distances need the split mode; one distance works in either.
      k.mode = k.press !== k.release ? X68_MODE.rapidSplit : st.keys[i].mode === X68_MODE.rapidSplit ? X68_MODE.rapidSplit : X68_MODE.rapid;
      if (k.mode === X68_MODE.rapid) k.release = k.press;
    }
    const before = st.keys[i];
    if (k.mode !== before.mode || k.travel !== before.travel || k.press !== before.press || k.release !== before.release) out.push(k);
  }
  return out;
}

/** The X68 HE SOCD table with the pairs added after the ones it has (nothing it has is removed). */
export function x68SocdTable(st: X68State, pairs: readonly SocdPairFeel[]): SocdEntry[] {
  const entries = [...(st.socd?.entries ?? [])];
  for (const p of pairs) {
    const key1 = hidUsageOf(p.a);
    const key2 = hidUsageOf(p.b);
    const mode = X68_SOCD_CODE[p.mode];
    if (key1 === null || key2 === null || mode === null) throw new Error(`The X68 HE can't set "${p.a} + ${p.b}" in that mode.`);
    entries.push({ index: entries.length, mode, key1, key2 });
  }
  return entries;
}

export interface X68Like {
  setTriggers(label: string, changes: KeyTrigger[]): Promise<string>;
  setSocd(label: string, entries: SocdEntry[], on: boolean): Promise<string>;
}

export async function driveX68(s: X68Like, state: X68State, steps: readonly Step[]): Promise<ApplyOutcome<null>> {
  const triggers: Step[] = [];
  const pairs: SocdPairFeel[] = [];
  let socdSteps = 0;
  let done = 0;
  try {
    // Everything is worked out before anything is written.
    for (const x of steps) {
      if (x.kind === "actuation" || x.kind === "rtSensitivity" || x.kind === "rapidTrigger") triggers.push(x);
      else if (x.kind === "socd") {
        pairs.push(...x.pairs);
        socdSteps++;
      } else unsupported(x);
    }
    const changes = triggers.length ? x68Triggers(state, triggers) : [];
    const table = socdSteps ? x68SocdTable(state, pairs) : null;
    if (changes.length) await s.setTriggers("Keep your feel", changes);
    done += triggers.length;
    if (table) await s.setSocd("Keep your feel: SOCD pairs", table, true);
    done += socdSteps;
    return { ok: true, done, total: steps.length, error: null, view: null };
  } catch (e) {
    return { ok: false, done, total: steps.length, error: message(e), view: null };
  }
}
