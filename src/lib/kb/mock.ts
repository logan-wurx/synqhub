// Sample keyboards for the browser preview (`npm run dev` without Tauri), so the generic Keyboard
// panel can be seen and tried: a Wooting 60HE+ and a Wuque Studio BABAO60 HE through the real
// OpenMouse wrapper (OmkbBackend) with stand-in driver clients, and a VIA board (the simulated QMK
// keyboard in via/sim.ts) through the real VIA driver, with its layout served from memory instead of
// usevia.app. Two more boards run through their real brand drivers over simulated hardware: an MCHOSE Ace 60 Pro
// (the 0x19F5 firmware family, src/lib/brands/fw19f5/sim.ts) and a Royal Kludge RK-M75 (the legacy write-only
// channel, src/lib/brands/rk-beiying/sim.ts, its shadow kept in memory), plus a Royal Kludge M75HE (the SparkLink family,
// src/lib/brands/sparklink/sim.ts) and a Keychron Q1 HE (VIA with Keychron's analog layer, src/lib/kb/via/keychron/sim.ts).
// Nothing here touches hardware or the network.
import type { KeyboardStatus } from "@openmouse/keyboard-protocol/drivers";
import { isBootloader } from "../bootloader-ids.ts";
import type { KbHost } from "./host.ts";
import { OmkbBackend } from "./openmouse/backend.ts";
import type { KbDriverLoader } from "./registry.ts";
import { memoryKbStore } from "./session.ts";
import type { KbAdvancedChange, KbBackend, KbDriver, KbPlan, KbState, KeyIndex, SocdMode } from "./types.ts";
import type { LiveFrame } from "./analogsense/live.ts";
import { memoryDefinitionCache, vendorProductId, viaDefinitions } from "./via/definitions.ts";
import { viaDriver } from "./via/driver.ts";
import { SimViaKeyboard, sampleCompiledDefinition } from "./via/sim.ts";
import { fwModel, layoutOf as fwLayoutOf } from "../brands/fw19f5/devices.ts";
import { fw19f5KbDriver } from "../brands/fw19f5/kb-driver.ts";
import { SimFw19f5Board } from "../brands/fw19f5/sim.ts";
import { createRkKbDriver } from "../brands/rk-beiying/kb-driver.ts";
import { memoryShadowStore } from "../brands/rk-beiying/session.ts";
import { SimRkBoard } from "../brands/rk-beiying/sim.ts";
import { sparklinkKbDriver } from "../brands/sparklink/kb-driver.ts";
import { SimSparkLinkBoard } from "../brands/sparklink/sim.ts";
import { keychronModel } from "./via/keychron/devices.ts";
import { SimKeychronHe } from "./via/keychron/sim.ts";

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

class SampleWooting {
  #active = 1;
  async open() {}
  async close() {}
  async readStatus(): Promise<KeyboardStatus> {
    await wait();
    return {
      brand: "Wooting",
      name: "Wooting 60HE+",
      ui: { family: "wooting", settingsReady: false },
      connectionType: "Wired",
      connectionDetail: "USB",
      firmware: ["Firmware: 2.10.0", "Layout: ANSI"],
      firmwareVersion: "2.10.0",
      layout: "ANSI",
      serial: "A01B2306W031H01234",
      activeProfile: this.#active,
      profileCount: 4,
      profileNames: ["Digital", "Analog 1", "Analog 2", "Analog 3"],
      analogProfile: { actuationRaw: 22528, actuationMm: 1.5, profileFields: [], global: null },
    };
  }
  async switchProfile(slot: number) {
    await wait(200);
    this.#active = slot;
    return slot;
  }
}

/** A BABAO60 HE's 60% matrix: 6 x 21 slots, layer-0 codes are HID usages. */
const WUQUE_ROWS: number[][] = [
  [0x29, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2d, 0x2e, 0x2a],
  [0x2b, 0x14, 0x1a, 0x08, 0x15, 0x17, 0x1c, 0x18, 0x0c, 0x12, 0x13, 0x2f, 0x30, 0x31],
  [0x39, 0x04, 0x16, 0x07, 0x09, 0x0a, 0x0b, 0x0d, 0x0e, 0x0f, 0x33, 0x34, 0x28],
  [0xe1, 0x1d, 0x1b, 0x06, 0x19, 0x05, 0x11, 0x10, 0x36, 0x37, 0x38, 0xe5],
  [0xe0, 0xe3, 0xe2, 0x2c, 0xe6, 0xe7, 0x65, 0xe4],
];

class SampleWuque {
  #perf = new Map<string, Record<string, number>>();
  #rate = "r1khz";
  async open() {}
  async close() {}
  async readStatus(): Promise<KeyboardStatus> {
    await wait();
    return {
      brand: "Wuque Studio",
      name: "BABAO60 HE",
      ui: { family: "wuque", settingsReady: false },
      connectionType: "Wired",
      connectionDetail: "USB",
      firmware: ["Firmware: 1.2.1.0", "App 1.2 · PCB 1.0"],
      firmwareVersion: "1.2.1.0",
      layout: null,
      serial: "WQ60HE0001",
      activeProfile: 0,
      profileCount: 4,
      profileNames: [],
      wuque: { device: { protocol: { mainVersion: 1, subVersion: 2, hardwareVersion: 1, softwareVersion: 0 }, info: null, feature: null }, global: {} } as unknown as KeyboardStatus["wuque"],
    };
  }
  async readKeyLayout(layer: number) {
    const rows = Array.from({ length: 6 }, (_, r) => Array.from({ length: 21 }, (_, c) => (layer === 0 ? (WUQUE_ROWS[r]?.[c] ?? 0) : 0)));
    return { layer, rows };
  }
  async readPerformance(row: number, col: number) {
    await wait(4);
    const p = this.#perf.get(`${row},${col}`) ?? { mode: 0, normalPressMm: 1.2, normalReleaseMm: 1.2, rtFirstTouchMm: 0.3, rtPressMm: 0.15, rtReleaseMm: 0.15, pressDeadStrokeMm: 0.1, releaseDeadStrokeMm: 0.1 };
    return { ...p, axis: 0, calibrate: 0, axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0 };
  }
  async writePerformance(s: Record<string, number>) {
    await wait(6);
    const { row, col, ...rest } = s;
    this.#perf.set(`${row},${col}`, rest);
    return this.readPerformance(row, col);
  }
  async readReportRates() {
    return ["r8khz", "r4khz", "r2khz", "r1khz", "r500hz", "r250hz", "r125hz"];
  }
  async readReportRate() {
    return this.#rate;
  }
  async writeReportRate(rate: string) {
    await wait(150);
    this.#rate = rate;
    return true;
  }
  async readRtPrecision() {
    return { min: 0.01 };
  }
}

const fake = (vendorId: number, productId: number, productName: string, usagePage: number) =>
  ({ vendorId, productId, productName, opened: false, collections: [{ usagePage, usage: 1, type: 1, children: [], inputReports: [], outputReports: [], featureReports: [] }] }) as unknown as HIDDevice;

interface Sample {
  device: HIDDevice;
  cls: string;
  brand: string;
  client: unknown;
}

let samples: Sample[] | null = null;
let via: SimViaKeyboard | null = null;
let mchose: SimFw19f5Board | null = null;
let kludge: SimRkBoard | null = null;
let sparklink: SimSparkLinkBoard | null = null;
let keychron: SimKeychronHe | null = null;

/** A 60% ANSI board's factory keys as SparkLink's default-key table lays them out: [HID value, row, col]. */
function sparklinkKeys() {
  const rows: number[][] = [
    [41, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 45, 46, 42],
    [43, 20, 26, 8, 21, 23, 28, 24, 12, 18, 19, 47, 48, 49],
    [57, 4, 22, 7, 9, 10, 11, 13, 14, 15, 51, 52, 40],
    [225, 29, 27, 6, 25, 5, 17, 16, 54, 55, 56, 229],
    [224, 227, 226, 44, 230, 1, 101, 228],
  ];
  return rows.flatMap((r, row) => r.map((key, col) => ({ key, row: row + 1, col })));
}
/** The preview's brand boards: an MCHOSE Ace 60 Pro and a Royal Kludge RK-M75 over simulated hardware. */
function brandBoards(): HIDDevice[] {
  const board = fwModel(0x41e4, 0x2103)!.board!;
  mchose ??= new SimFw19f5Board({ vendorId: 0x41e4, productId: 0x2103, productName: "MCHOSE Ace 60 Pro", step: board.step, layoutSlots: fwLayoutOf(board).map((k) => k[0]), oddKeys: true, latencyMs: 4 });
  kludge ??= new SimRkBoard(0x0147, "RK-M75");
  sparklink ??= new SimSparkLinkBoard({ vendorId: 0x1ca2, productId: 0x1619, productName: "RK M75HE", name: "RK M75HE", keys: sparklinkKeys(), latencyMs: 3 });
  keychron ??= new SimKeychronHe({ model: keychronModel(0x3434, 0x0b10)!, delayMs: 3 });
  return [mchose, kludge, sparklink, keychron] as unknown as HIDDevice[];
}
function all(): Sample[] {
  samples ??= [
    { device: fake(0x31e3, 0x1322, "Wooting 60HE+", 0xff55), cls: "WootingHidClient", brand: "Wooting", client: new SampleWooting() },
    { device: fake(0x1ca6, 0x1b10, "BABAO60 HE", 0xffb0), cls: "WuqueHidClient", brand: "Wuque Studio", client: new SampleWuque() },
  ];
  via ??= new SimViaKeyboard({ vendorId: 0x4f42, productId: 0x5641, productName: "SYNQ Sample 65", delayMs: 3 });
  return samples;
}


/** Preview only: a stand-in live depth source (three keys held part way), so the Actuation tab's live bars can be seen. */
function sampleLive() {
  return {
    async start(onFrame: (f: LiveFrame) => void) {
      onFrame({ depth: new Map([[0x1a, 0.72], [0x04, 0.33], [0xe1, 0.9]]), mm: null, at: Date.now() });
    },
    async stop() {},
  };
}

/**
 * Preview only: gives one sample keyboard live depth and advanced keys (snap tap, dynamic keystroke, mod-tap)
 * that live in memory, so those parts of the panel can be seen and tried without a real board.
 */
function withPreviewExtras(b: KbBackend): KbBackend {
  const pairs: { keys: readonly [KeyIndex, KeyIndex]; mode: SocdMode }[] = [];
  const dksKeys: KeyIndex[] = [];
  const mtKeys: KeyIndex[] = [];
  const state = (): KbState => ({
    ...b.state,
    analog: b.state.analog ? { ...b.state.analog, liveDepth: { hz: 30 }, travelMm: 4 } : b.state.analog,
    advanced: {
      socd: { modes: ["last", "neutral", "priorityA"], pairs: [...pairs], maxPairs: 8 },
      dks: { slots: 4, keys: [...dksKeys], bindingsPerKey: 2 },
      modTap: { keys: [...mtKeys], holdMs: { min: 10, max: 2000, step: 10, unit: "ms" } },
      writable: ["socd", "dks", "modTap"],
      note: "Sample keyboard: these changes only live in this preview.",
    },
  });
  return {
    get driver() {
      return b.driver;
    },
    get state() {
      return state();
    },
    get support() {
      return b.support;
    },
    get blocked() {
      return b.blocked;
    },
    load: async () => {
      await b.load();
      return state();
    },
    plan: (c) => b.plan(c),
    planAdvanced(c: KbAdvancedChange): KbPlan {
      const label = c.kind === "socd" ? "Snap tap pair" : c.kind === "dks" ? "Dynamic keystroke" : c.kind === "modTap" ? "Mod-tap" : "Advanced keys cleared";
      return {
        label,
        expected: c.kind,
        persistence: "volatile",
        async send() {
          await wait(60);
          if (c.kind === "socd") pairs.push({ keys: c.keys, mode: c.mode });
          else if (c.kind === "dks") dksKeys.push(c.key);
          else if (c.kind === "modTap") mtKeys.push(c.key);
          else {
            for (const k of c.keys) {
              for (let i = pairs.length - 1; i >= 0; i--) if (pairs[i].keys.includes(k)) pairs.splice(i, 1);
              if (dksKeys.includes(k)) dksKeys.splice(dksKeys.indexOf(k), 1);
              if (mtKeys.includes(k)) mtKeys.splice(mtKeys.indexOf(k), 1);
            }
          }
        },
        readBack: async () => c.kind,
      };
    },
    snapshot: () => b.snapshot(),
    advanced: () => b.advanced?.() as never,
    close: () => b.close(),
    live: () => sampleLive(),
  } as KbBackend & { live: () => ReturnType<typeof sampleLive> };
}

/** The stand-in OpenMouse keyboards, as a driver (the VIA board uses the real VIA driver). */
const sampleOmkb: KbDriver = {
  id: "omkb",
  name: "OpenMouse keyboards",
  priority: 20,
  vids: [0x31e3, 0x1ca6],
  claims: (d) => all().some((s) => s.device === d) && !isBootloader(d.vendorId, d.productId, d.productName),
  async open(d) {
    const s = all().find((x) => x.device === d)!;
    const backend = await OmkbBackend.open(d, { brand: s.brand, cls: s.cls, create: () => s.client });
    return s.cls === "WuqueHidClient" ? withPreviewExtras(backend) : backend;
  },
  async ping() {
    return true;
  },
};

const rkPreviewDriver = createRkKbDriver({ store: memoryShadowStore() });
const DRIVERS: KbDriverLoader[] = [
  { id: "fw19f5", vids: [0x41e4], priority: 60, load: async () => fw19f5KbDriver },
  { id: "rk-beiying", vids: [0x258a], priority: 60, load: async () => rkPreviewDriver },
  { id: "sparklink", vids: [0x1ca2], priority: 60, load: async () => sparklinkKbDriver },
  { id: "omkb", vids: [0x31e3, 0x1ca6], priority: 20, load: async () => sampleOmkb },
  { id: "via", vids: null, priority: 10, load: async () => viaDriver },
];

export const sampleKbHost: KbHost = {
  live: false,
  store: memoryKbStore(),
  async devices() {
    all();
    return [...all().map((s) => s.device), via as unknown as HIDDevice, ...brandBoards()];
  },
  drivers: DRIVERS,
  definitions: viaDefinitions(
    memoryDefinitionCache({ [`v3-${vendorProductId(0x4f42, 0x5641)}`]: JSON.stringify(sampleCompiledDefinition(0x4f42, 0x5641)) }),
    () => Promise.reject(new Error("The preview never uses the network.")),
  ),
};

/** The sample keyboards as the device list shows them (src/lib/device-names.ts adds them in the preview). */
export const SAMPLE_KEYBOARDS = [
  { vid: "31e3", pid: "1322", name: "Wooting 60HE+", kb: "omkb" as const },
  { vid: "1ca6", pid: "1b10", name: "BABAO60 HE", kb: "omkb" as const },
  { vid: "4f42", pid: "5641", name: "SYNQ Sample 65", kb: "qmk" as const },
  { vid: "41e4", pid: "2103", name: "MCHOSE Ace 60 Pro", kb: "brand" as const },
  { vid: "258a", pid: "0147", name: "RK-M75", kb: "brand" as const },
  { vid: "1ca2", pid: "1619", name: "RK M75HE", kb: "brand" as const },
  { vid: "3434", pid: "0b10", name: "Keychron Q1 HE", kb: "qmk" as const },
];
