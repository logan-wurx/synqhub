// Stand-ins for the views each panel keeps (src/lib/keep.ts), shaped like the real ones, for the "Keep your
// feel" tests. Only the fields the feature reads are filled.
import type { AtkView } from "../src/lib/atk-session.ts";
import type { GenericView } from "../src/lib/openmouse/safe-mouse.ts";
import type { MouseView } from "../src/lib/mouse.ts";
import type { KbView } from "../src/lib/kb/types.ts";
import type { KeyboardView } from "../src/lib/keyboard.ts";
import type { X68View } from "../src/lib/x68he.ts";

// ---------------------------------------------------------------------------------------------
// Views, as the panels keep them
// ---------------------------------------------------------------------------------------------

export function logitechView(over: Partial<MouseView> = {}): MouseView {
  return {
    name: "PRO X 2 DEX",
    connection: "Wireless",
    connectionDetail: "LIGHTSPEED",
    batteryPercent: 80,
    batteryState: "Discharging",
    firmware: [],
    dpi: 800,
    mode: "Onboard",
    writable: true,
    formatName: null,
    stages: [400, 800, 1600],
    defaultStage: 1,
    lod: "Low",
    lods: ["Low", "Medium", "High"],
    pollingHz: 1000,
    pollingWiredHz: 1000,
    pollingOptions: [125, 250, 500, 1000, 2000, 4000, 8000],
    wirelessMaxHz: 8000,
    wiredMaxHz: 8000,
    caps: { maxStages: 5, minDpi: 100, maxDpi: 44000, stepDpi: 50 },
    ...over,
  } as MouseView;
}

export function atkView(over: Partial<AtkView> = {}): AtkView {
  return {
    name: "X1 V2 Air+",
    connection: "Wireless",
    connectionDetail: "8K receiver",
    batteryPercent: 90,
    charging: false,
    writable: true,
    readOnlyReason: null,
    stages: [400, 800, 1600, 3200],
    activeStage: 2,
    dpi: 1600,
    dpiRange: { min: 100, max: 26000, step: 50, maxStages: 6 },
    pollingHz: 4000,
    pollingOptions: [125, 250, 500, 1000, 2000, 4000, 8000],
    liftOffMm: 0.9,
    angleSnapping: false,
    rippleControl: true,
    motionSync: true,
    debounceMs: 2,
    debounceOptions: [0, 1, 2, 4, 8],
    ...over,
  } as AtkView;
}

export function genericMouseView(over: Partial<GenericView> = {}): GenericView {
  return {
    name: "Viper V3 Pro",
    brand: "Razer",
    writable: true,
    dpi: { value: 1600, options: [], min: 100, max: 35000, step: 50, canSet: true },
    stages: { values: [400, 800, 1600, 3200], active: 2, maxStages: 5, countEditable: true, min: 100, max: 35000, step: 50, canSet: true },
    polling: { hz: 4000, options: [125, 500, 1000, 2000, 4000, 8000], canSet: true, note: null },
    lod: { value: "Low", options: ["Low", "Medium", "High"], canSet: true },
    toggles: [],
    debounce: null,
    ...over,
  } as unknown as GenericView;
}

export function falchionView(over: Partial<KeyboardView["settings"]> = {}): KeyboardView {
  return {
    settings: {
      actuation: 12,
      top: 1,
      bottom: 1,
      keys: {},
      rapidTrigger: { enabled: true, keys: [1, 2], independent: false, continuous: false, sensitivity: 3, press: 3, release: 3, custom: {} },
      ...over,
    },
  } as unknown as KeyboardView;
}

const KEY = (index: number, label: string, locked = false) => ({ index, x: index, y: 0, w: 1, h: 1, label, locked });

export function x68View(over: { keys?: Record<number, unknown>; socd?: unknown; trigger?: unknown } = {}): X68View {
  const trigger = { unitMm: 0.01, minUnits: 10, maxUnits: 400, minMm: 0.1, maxMm: 4, rtMinMm: 0.01, rtMaxMm: 2 };
  const t = (index: number, mode: number, travel: number, press: number, release: number) => ({ index, mode, travel, press, release });
  return {
    state: {
      layout: { keys: [KEY(0, "A"), KEY(1, "D"), KEY(2, "W"), KEY(3, "Esc", true), KEY(4, "S")], name: "ANSI", units: { w: 5, h: 1 } },
      trigger: over.trigger === undefined ? trigger : over.trigger,
      keys: over.keys ?? { 0: t(0, 12, 150, 30, 30), 1: t(1, 12, 150, 30, 30), 2: t(2, 12, 120, 30, 30), 3: t(3, 0, 200, 50, 50), 4: t(4, 12, 150, 30, 30) },
      keymap: { default: [], fn: [] },
      socd: over.socd === undefined ? { on: true, entries: [{ index: 0, mode: 0, key1: 0x04, key2: 0x07, state: 1 }] } : over.socd,
    },
  } as unknown as X68View;
}

export function genericKeyboardView(over: Partial<KbView> = {}): KbView {
  const labels: Record<number, string> = { 4: "A", 7: "D", 26: "W", 22: "S", 80: "←" };
  const spec = { min: 0.1, max: 4, step: 0.1, unit: "mm" };
  return {
    analog: {
      scope: "global",
      fields: { actuationMm: spec, rapidTrigger: "toggle", rtPressMm: { ...spec, max: 2 }, rtReleaseMm: { ...spec, max: 2 } },
      writable: ["actuationMm", "rapidTrigger", "rtPressMm", "rtReleaseMm"],
      global: { actuationMm: 1.5, rapidTrigger: true, rtPressMm: 0.3, rtReleaseMm: 0.4 },
      perKey: {},
      source: "device",
    },
    keymap: {
      layout: { keys: [{ index: 0, label: "A" }, { index: 1, label: "D" }, { index: 2, label: "W" }, { index: 3, label: "S" }, { index: 4, label: "Fn" }, { index: 5 }] },
      codes: [{ 0: 4, 1: 7, 2: 26, 3: 22, 4: 0xffff, 5: 80 }],
      label: (c: number) => labels[c],
    },
    advanced: { socd: { modes: ["last", "neutral", "priorityA"], pairs: [{ keys: [0, 1], mode: "last" }], maxPairs: 4 }, writable: ["socd"] },
    ...over,
  } as unknown as KbView;
}

