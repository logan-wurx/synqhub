// What each panel keeps about its device (the view it read), turned into the two things the feature needs:
// what the device can take (a MouseTarget / KeyboardTarget) and what it holds now (which is also what
// "Save as my feel" saves). Reads kept views only; nothing here opens or asks a device anything. The view
// types are imported as types only, so this file pulls no driver into the first-load code.
import type { MouseView } from "../mouse.ts";
import type { AtkView } from "../atk-session.ts";
import type { GenericView } from "../openmouse/safe-mouse.ts";
import type { KbView } from "../kb/types.ts";
import type { KeyboardView } from "../keyboard.ts";
import type { X68View } from "../x68he.ts";
import { mmToUnits, unitsToMm } from "./units.ts";
import type { KeyboardDevice, KeyboardNow, LodLevel, MouseDevice, MouseNow, SocdMode, SocdPairFeel } from "./types.ts";

const NO_TOGGLES = { angleSnapping: false, motionSync: false, ripple: false } as const;

// ---------------------------------------------------------------------------------------------
// Mice
// ---------------------------------------------------------------------------------------------

/** The ATK X1's lift-off scale (src/lib/atk-protocol.ts LIFT_OFF; a test keeps the two equal). */
export const ATK_LIFT_OFF = { min: 0.7, max: 1.7, step: 0.1 } as const;

const hasStages = (n: MouseNow | null): MouseNow | null => (n && n.stages.length ? n : null);

export function logitechMouse(v: MouseView): MouseDevice {
  const caps = v.caps;
  const now: MouseNow = {
    stages: v.stages,
    active: Math.min(v.defaultStage, Math.max(0, v.stages.length - 1)),
    pollingHz: v.pollingHz,
    lod: v.lod ? { kind: "level", level: v.lod } : null,
    debounceMs: null,
    angleSnapping: null,
    motionSync: null,
    ripple: null,
  };
  return {
    target: {
      dpi: { min: caps?.minDpi ?? 100, max: caps?.maxDpi ?? 44000, step: caps?.stepDpi ?? 50 },
      stages: { max: caps?.maxStages ?? 5, fixedCount: null },
      polling: v.pollingOptions.length ? { options: v.pollingOptions } : null,
      lod: v.lods.length ? { kind: "levels", levels: v.lods as LodLevel[] } : null,
      debounce: null,
      toggles: NO_TOGGLES,
    },
    now: hasStages(now),
  };
}

export function atkMouse(v: AtkView): MouseDevice {
  const now: MouseNow = {
    stages: v.stages,
    active: Math.min(v.activeStage, Math.max(0, v.stages.length - 1)),
    pollingHz: v.pollingHz,
    lod: v.liftOffMm === null ? null : { kind: "mm", mm: v.liftOffMm, min: ATK_LIFT_OFF.min, max: ATK_LIFT_OFF.max },
    debounceMs: v.debounceMs,
    angleSnapping: v.angleSnapping,
    motionSync: v.motionSync,
    ripple: v.rippleControl,
  };
  return {
    target: {
      dpi: { min: v.dpiRange.min, max: v.dpiRange.max, step: v.dpiRange.step },
      stages: { max: v.dpiRange.maxStages, fixedCount: null },
      polling: v.pollingOptions.length ? { options: v.pollingOptions } : null,
      lod: { kind: "mm", ...ATK_LIFT_OFF },
      debounce: v.debounceOptions.length ? { options: v.debounceOptions } : null,
      toggles: { angleSnapping: true, motionSync: true, ripple: true },
    },
    now: hasStages(now),
  };
}

export function genericMouse(v: GenericView): MouseDevice {
  const toggle = (name: string): boolean | null => v.toggles.find((t) => t.setting === name)?.value ?? null;
  const can = (name: string): boolean => !!v.toggles.find((t) => t.setting === name)?.canSet;
  const s = v.stages;
  const values = s?.values.length ? s.values : [v.dpi.value];
  const now: MouseNow = {
    stages: values,
    active: s ? Math.min(s.active, Math.max(0, values.length - 1)) : 0,
    pollingHz: v.polling?.hz ?? null,
    lod: v.lod?.value ? { kind: "level", level: v.lod.value as LodLevel } : null,
    debounceMs: v.debounce?.ms ?? null,
    angleSnapping: toggle("angleSnapping"),
    motionSync: toggle("motionSync"),
    ripple: toggle("rippleControl"),
  };
  const grid = s?.canSet ? { min: s.min, max: s.max, step: s.step } : { min: v.dpi.min, max: v.dpi.max, step: v.dpi.step };
  const canDpi = v.dpi.canSet || !!s?.canSet;
  return {
    target: {
      dpi: canDpi ? { ...grid, options: v.dpi.options.length ? v.dpi.options : undefined } : null,
      stages: s?.canSet ? { max: s.maxStages, fixedCount: s.countEditable ? null : s.values.length } : null,
      polling: v.polling?.canSet && v.polling.options.length ? { options: v.polling.options } : null,
      lod: v.lod?.canSet && v.lod.options.length ? { kind: "levels", levels: v.lod.options as LodLevel[] } : null,
      debounce: v.debounce?.canSet && v.debounce.options.length ? { options: v.debounce.options } : null,
      toggles: { angleSnapping: can("angleSnapping"), motionSync: can("motionSync"), ripple: can("rippleControl") },
    },
    now: hasStages(now),
  };
}

/** The mouse device for a family (`logitech`, `atk`, `om:<vid>:<pid>`) and its kept view; null before the panel read it. */
export function describeMouse(family: string, view: unknown): MouseDevice | null {
  if (!view || typeof view !== "object") return null;
  if (family === "logitech") return logitechMouse(view as MouseView);
  if (family === "atk") return atkMouse(view as AtkView);
  if (family.startsWith("om:")) return genericMouse(view as GenericView);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Key names (a SOCD pair is saved by key name, so it can be found on another layout)
// ---------------------------------------------------------------------------------------------

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "1234567890";

/** HID usage -> the name a SOCD pair uses (letters, digits, arrows, Space and the common modifiers). */
export const HID_KEY_NAMES: Readonly<Record<number, string>> = (() => {
  const m: Record<number, string> = {};
  for (let i = 0; i < 26; i++) m[0x04 + i] = LETTERS[i];
  for (let i = 0; i < 10; i++) m[0x1e + i] = DIGITS[i];
  Object.assign(m, { 0x28: "Enter", 0x29: "Esc", 0x2b: "Tab", 0x2c: "Space", 0x39: "Caps", 0x4f: "Right", 0x50: "Left", 0x51: "Down", 0x52: "Up", 0xe0: "Ctrl", 0xe1: "Shift", 0xe2: "Alt" });
  return m;
})();

export const hidUsageOf = (name: string): number | null => {
  const key = Object.entries(HID_KEY_NAMES).find(([, n]) => n.toLowerCase() === name.trim().toLowerCase());
  return key ? Number(key[0]) : null;
};

const ALIASES: Record<string, string> = {
  "←": "Left",
  "→": "Right",
  "↑": "Up",
  "↓": "Down",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  "left arrow": "Left",
  "right arrow": "Right",
  "up arrow": "Up",
  "down arrow": "Down",
  space: "Space",
  spc: "Space",
  "␣": "Space",
  shift: "Shift",
  lshift: "Shift",
  "l shift": "Shift",
  "left shift": "Shift",
  ctrl: "Ctrl",
  lctrl: "Ctrl",
  control: "Ctrl",
  "left ctrl": "Ctrl",
  alt: "Alt",
  lalt: "Alt",
  "left alt": "Alt",
  tab: "Tab",
  caps: "Caps",
  "caps lock": "Caps",
  esc: "Esc",
  escape: "Esc",
  enter: "Enter",
  return: "Enter",
};

/** A keycap legend as a pair name ("a" -> "A", "Left Arrow" -> "Left"); null for a key SOCD pairs don't name. */
export function keyNameOf(label: string | undefined | null): string | null {
  const t = (label ?? "").trim();
  if (!t) return null;
  const alias = ALIASES[t.toLowerCase()];
  if (alias) return alias;
  return t.length === 1 && (LETTERS.includes(t.toUpperCase()) || DIGITS.includes(t)) ? t.toUpperCase() : null;
}

// ---------------------------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------------------------

/** The Falchion's ranges, in 0.1 mm (src/lib/keyboard.ts LIMITS; a test keeps the two equal). */
export const FALCHION_LIMITS = { actuation: { min: 1, max: 40 }, rapidTrigger: { min: 1, max: 20 } } as const;
const FALCHION_UNIT_MM = 0.1;

export function falchionKeyboard(v: KeyboardView): KeyboardDevice {
  const s = v.settings;
  const rt = s.rapidTrigger;
  const mm = (u: number) => unitsToMm(u, FALCHION_UNIT_MM);
  const now: KeyboardNow = {
    actuationMm: mm(s.actuation),
    rapidTrigger: rt.enabled,
    rtPressMm: mm(rt.independent ? rt.press : rt.sensitivity),
    rtReleaseMm: mm(rt.independent ? rt.release : rt.sensitivity),
    socd: null,
  };
  const L = FALCHION_LIMITS;
  return {
    target: {
      actuation: { min: mm(L.actuation.min), max: mm(L.actuation.max), step: FALCHION_UNIT_MM },
      rapidTrigger: true,
      rtSensitivity: { min: mm(L.rapidTrigger.min), max: mm(L.rapidTrigger.max), step: FALCHION_UNIT_MM, independent: true },
      socd: null,
    },
    now,
  };
}

/** The X68 HE's trigger modes (src/lib/x68he-protocol.ts TRIGGER_MODE; a test keeps them equal). */
export const X68_MODE = { normal: 0, rapidLegacy: 1, rapid: 12, rapidSplit: 13 } as const;
export const X68_SOCD_MODES: readonly SocdMode[] = ["last", "priorityA", "priorityB", "neutral"];
/** SOCD slot modes: 0 last input, 1 key 1 wins, 2 key 2 wins, 3 neutral. */
export const X68_SOCD_CODE: Record<SocdMode, number | null> = { last: 0, priorityA: 1, priorityB: 2, neutral: 3, first: null, deeper: null, deeperSingle: null };
const X68_SOCD_FROM_CODE: Record<number, SocdMode> = { 0: "last", 1: "priorityA", 2: "priorityB", 3: "neutral" };
const X68_RT_MODES: readonly number[] = [X68_MODE.rapidLegacy, X68_MODE.rapid, X68_MODE.rapidSplit];
export const X68_MAX_SOCD = 20;

export function mostCommon(values: readonly number[], fallback: number): number {
  const count = new Map<number, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  let best = fallback;
  let n = 0;
  for (const [v, c] of count) if (c > n) [best, n] = [v, c];
  return best;
}

/** The keys of the X68 the actuation and rapid-trigger cards write: not locked, and with a trigger entry. */
export function x68EditableKeys(st: X68View["state"]): number[] {
  return st.layout.keys.filter((k) => !k.locked && st.keys[k.index]).map((k) => k.index);
}

export function x68Socd(st: X68View["state"]): SocdPairFeel[] {
  const out: SocdPairFeel[] = [];
  for (const e of st.socd?.entries ?? []) {
    const a = HID_KEY_NAMES[e.key1];
    const b = HID_KEY_NAMES[e.key2];
    const mode = X68_SOCD_FROM_CODE[e.mode];
    if (a && b && mode) out.push({ a, b, mode });
  }
  return out;
}

export function x68Keyboard(view: X68View): KeyboardDevice {
  const st = view.state;
  const t = st.trigger;
  if (!t) return { target: { actuation: null, rapidTrigger: false, rtSensitivity: null, socd: null }, now: null };
  const unit = t.unitMm;
  const keys = x68EditableKeys(st).map((i) => st.keys[i]);
  const rtKeys = keys.filter((k) => X68_RT_MODES.includes(k.mode));
  const pool = rtKeys.length ? rtKeys : keys;
  const mm = (u: number) => unitsToMm(u, unit);
  const now: KeyboardNow | null = keys.length
    ? {
        actuationMm: mm(mostCommon(keys.map((k) => k.travel), t.minUnits)),
        rapidTrigger: rtKeys.length > 0,
        rtPressMm: mm(mostCommon(pool.map((k) => k.press), mmToUnits(0.5, unit))),
        rtReleaseMm: mm(mostCommon(pool.map((k) => k.release), mmToUnits(0.5, unit))),
        socd: st.socd ? x68Socd(st) : null,
      }
    : null;
  return {
    target: {
      actuation: { min: t.minMm, max: t.maxMm, step: unit },
      rapidTrigger: true,
      rtSensitivity: { min: t.rtMinMm, max: t.rtMaxMm, step: unit, independent: true },
      socd: st.socd && st.keymap ? { modes: X68_SOCD_MODES, maxPairs: X68_MAX_SOCD, keys: Object.values(HID_KEY_NAMES), existing: x68Socd(st) } : null,
    },
    now,
  };
}

/** The generic keyboard's keys by pair name ("A", "Left"...), from its first layer's legends. */
export function genericKeyIndex(v: KbView): Map<string, number> {
  const out = new Map<string, number>();
  const km = v.keymap;
  const layer = km?.codes[0];
  if (!km || !layer) return out;
  for (const k of km.layout.keys) {
    const code = layer[k.index];
    if (code === undefined) continue;
    const name = keyNameOf(km.label?.(code) ?? k.label);
    if (name && !out.has(name)) out.set(name, k.index);
  }
  return out;
}

export function genericKeyboard(v: KbView): KeyboardDevice {
  const a = v.analog;
  const w = new Set<string>(a?.writable ?? []);
  const spec = (field: "actuationMm" | "rtPressMm" | "rtReleaseMm") => {
    const f = a?.fields[field];
    return f && f !== "toggle" && w.has(field) ? { min: f.min, max: f.max, step: f.step } : null;
  };
  const g = a?.global ?? null;
  const per = a ? Object.values(a.perKey) : [];
  const pick = (f: (x: NonNullable<typeof g>) => number | null | undefined): number | null => {
    if (g && f(g) != null) return f(g)!;
    const vals = per.map(f).filter((x): x is number => typeof x === "number");
    return vals.length ? mostCommon(vals, vals[0]) : null;
  };
  const rtOn = g?.rapidTrigger ?? (per.length ? per.some((x) => x.rapidTrigger) : null);
  const index = genericKeyIndex(v);
  const byIndex = new Map([...index].map(([name, i]) => [i, name] as const));
  const socd = v.advanced?.socd;
  const socdOk = !!socd && v.advanced!.writable.includes("socd") && index.size > 0;
  const existing: SocdPairFeel[] = [];
  for (const p of socd?.pairs ?? []) {
    const x = byIndex.get(p.keys[0]);
    const y = byIndex.get(p.keys[1]);
    if (x && y) existing.push({ a: x, b: y, mode: p.mode });
  }
  const press = spec("rtPressMm");
  const release = spec("rtReleaseMm");
  const now: KeyboardNow | null = a
    ? {
        actuationMm: pick((x) => x.actuationMm),
        rapidTrigger: rtOn === null ? null : !!rtOn,
        rtPressMm: pick((x) => x.rtPressMm),
        rtReleaseMm: pick((x) => x.rtReleaseMm),
        socd: socd ? existing : null,
      }
    : null;
  return {
    target: {
      actuation: spec("actuationMm"),
      rapidTrigger: !!a && a.fields.rapidTrigger !== undefined && w.has("rapidTrigger"),
      rtSensitivity: press ? { ...press, independent: !!release } : null,
      socd: socdOk ? { modes: socd!.modes, maxPairs: socd!.maxPairs ?? null, keys: [...index.keys()], existing } : null,
    },
    now,
  };
}

/** The keyboard device for a family (`falchion`, `x68`, `kb:<vid>:<pid>`) and its kept view; null before the panel read it. */
export function describeKeyboard(family: string, view: unknown): KeyboardDevice | null {
  if (!view || typeof view !== "object") return null;
  if (family === "falchion") return (view as KeyboardView).settings ? falchionKeyboard(view as KeyboardView) : null;
  if (family === "x68") return (view as X68View).state ? x68Keyboard(view as X68View) : null;
  if (family.startsWith("kb:")) return genericKeyboard(view as KbView);
  return null;
}
