// Sample mice for the browser preview (`npm run dev` without Tauri), so the generic panel can be
// seen and tried: a Razer that OpenMouse marks as tested, and a Pulsar that starts read-only. They
// run through the same SafeMouse wrapper as real mice; nothing here touches hardware.
import type { MouseLighting, MouseStatus } from "@openmouse/protocol/drivers";
import type { GenericHost } from "./host.ts";
import type { DriverMatch } from "./registry.ts";
import { memoryStore } from "./store.ts";

const wait = (ms = 220) => new Promise((r) => setTimeout(r, ms));

const razerLogo: MouseLighting = {
  zone: "Logo",
  modes: ["Off", "Static", "Breathing single", "Spectrum", "Wave"],
  mode: "Static",
  color: "#00ff66",
  color2: null,
  colorModes: ["Static", "Breathing single"],
  dualColorModes: [],
  reactiveModes: [],
  speeds: [],
  speed: null,
  writeOnly: true,
};

function razerStatus(): MouseStatus {
  return {
    brand: "Razer",
    name: "Viper V3 Pro",
    ui: { settingsReady: true, dpiStageEditor: { maxStages: 5, countEditable: true, minDpi: 100, maxDpi: 35000, stepDpi: 50 } },
    batteryPercent: 72,
    batteryState: "Discharging",
    dpi: 1600,
    dpiStages: [400, 800, 1600, 3200],
    activeDpiStage: 2,
    pollingRateHz: 4000,
    supportedPollingRates: [125, 500, 1000, 2000, 4000, 8000],
    activeProfile: 1,
    liftOffDistance: "Low",
    supportedLiftOffDistances: ["Low", "Medium", "High"],
    sleepTimeout: 300,
    connectionType: "Wireless",
    connectionDetail: "HyperPolling dongle",
    deviceMode: "Onboard",
    lighting: razerLogo,
    firmware: ["1.04.00"],
  };
}

function pulsarStatus(): MouseStatus {
  return {
    brand: "Pulsar",
    name: "X2 HE",
    ui: { dpiStageEditor: { maxStages: 6, countEditable: true, minDpi: 50, maxDpi: 26000, stepDpi: 10 } },
    batteryPercent: 46,
    batteryState: "Charging",
    dpi: 800,
    dpiStages: [400, 800, 1600, 3200],
    activeDpiStage: 1,
    pollingRateHz: 1000,
    supportedPollingRates: [125, 250, 500, 1000, 2000, 4000],
    activeProfile: 0,
    liftOffDistance: "Medium",
    supportedLiftOffDistances: ["Low", "Medium", "High"],
    motionSync: true,
    angleSnapping: false,
    rippleControl: false,
    debounceMs: 3,
    sleepTimeout: 6,
    connectionType: "Wireless",
    connectionDetail: "4K dongle",
    deviceMode: "Onboard",
    magneticButtons: {
      buttons: [
        { switchType: "magnetic", triggerPoint: 0.6, rapidTrigger: 0.2, rapidTriggerEnabled: true },
        { switchType: "magnetic", triggerPoint: 0.8, rapidTrigger: 0.3, rapidTriggerEnabled: false },
      ],
      triggerPointRange: { min: 0.1, max: 2 },
      rapidTriggerRange: { min: 0.1, max: 1 },
      rapidTriggerUnit: "level",
      rapidTriggerSwitch: true,
      canChooseSwitchType: false,
      calibration: "calibrated",
      liveDepth: false,
    },
    buttonMappings: { Left: "Left click", Right: "Right click", Middle: "Middle click", Back: "Back", Forward: "Forward", DPI: "DPI cycle" },
    buttonOptions: ["Left click", "Right click", "Middle click", "Back", "Forward", "DPI cycle", "Disabled"],
    firmware: ["Mouse 1.2.6", "Dongle 1.0.9"],
  };
}

/** A budget-mouse style sample: a short fixed list of DPI steps, two polling rates and a lift-off with no middle level. */
function sampleStatus(): MouseStatus {
  return {
    brand: "Redragon",
    name: "Sample Mouse",
    ui: { settingsReady: true, dpiStageEditor: { maxStages: 4, countEditable: false, minDpi: 450, maxDpi: 3500, stepDpi: 450 } },
    batteryPercent: 100,
    batteryState: "Unknown",
    dpi: 900,
    dpiStages: [450, 900, 1800, 3500],
    activeDpiStage: 1,
    pollingRateHz: 1000,
    supportedPollingRates: [500, 1000],
    activeProfile: 0,
    liftOffDistance: "Low",
    supportedLiftOffDistances: ["Low", "High"],
    connectionType: "Wired",
    connectionDetail: "USB cable",
    deviceMode: "Onboard",
    firmware: ["1.0.0"],
  };
}

/** A stand-in driver client: same method names as OpenMouse's, values kept in memory. */
class SampleClient {
  #s: MouseStatus;
  #dpiOptions: number[];
  constructor(s: MouseStatus, dpiOptions: number[]) {
    this.#s = s;
    this.#dpiOptions = dpiOptions;
  }
  async open() {}
  async close() {}
  async readStatus() {
    await wait(160);
    return structuredClone(this.#s);
  }
  getDpiOptions() {
    return this.#dpiOptions;
  }
  getSupportedPollingRates() {
    return this.#s.supportedPollingRates ?? [];
  }
  getSleepOptions() {
    return this.#s.brand === "Pulsar" ? [1, 3, 6, 12, 30, 60, 180] : [60, 120, 300, 600, 900];
  }
  getDebounceOptions() {
    return this.#s.debounceMs === undefined ? [] : [0, 1, 2, 3, 4, 6, 8, 10];
  }
  async setDpi(dpi: number) {
    await wait();
    return (this.#s.dpi = dpi);
  }
  async setDpiStageValue(i: number, dpi: number) {
    await wait(80);
    this.#s.dpiStages![i] = dpi;
    if (i === this.#s.activeDpiStage) this.#s.dpi = dpi;
    return dpi;
  }
  async setDpiStageCount(n: number) {
    const st = this.#s.dpiStages!;
    while (st.length < n) st.push(st[st.length - 1] * 2);
    st.length = n;
    return n;
  }
  async setActiveDpiStage(i: number) {
    this.#s.activeDpiStage = i;
    this.#s.dpi = this.#s.dpiStages![i];
    return i;
  }
  async setPollingRate(hz: number) {
    await wait();
    return (this.#s.pollingRateHz = hz);
  }
  async setLiftOffDistance(v: NonNullable<MouseStatus["liftOffDistance"]>) {
    await wait();
    return (this.#s.liftOffDistance = v);
  }
  async setMotionSync(on: boolean) {
    return (this.#s.motionSync = on);
  }
  async setAngleSnapping(on: boolean) {
    return (this.#s.angleSnapping = on);
  }
  async setRippleControl(on: boolean) {
    return (this.#s.rippleControl = on);
  }
  async setDebounceTime(ms: number) {
    return (this.#s.debounceMs = ms);
  }
  async setSleepTimeout(v: number) {
    return (this.#s.sleepTimeout = v);
  }
  async setLighting(l: MouseLighting) {
    await wait();
    this.#s.lighting = { ...l };
    return l;
  }
  async setButtonMapping(button: string, action: string) {
    await wait(120);
    this.#s.buttonMappings![button] = action;
  }
  async factoryReset() {
    await wait(600);
    const fresh = this.#s.brand === "Pulsar" ? pulsarStatus() : razerStatus();
    this.#s = fresh;
  }
  async calibrateMagneticButtons(onProgress: (p: { left: number; right: number; message: string; step: number; steps: number }) => void, signal?: AbortSignal) {
    for (const [left, right, message] of [[0, 0, "Let go of both buttons."], [40, 0, "Press the left button all the way down."], [100, 30, "Now the right button."], [100, 100, "Almost done…"]] as [number, number, string][]) {
      if (signal?.aborted) throw new Error("Calibration cancelled.");
      onProgress({ left, right, message, step: 1, steps: 6 });
      await wait(900);
    }
  }
  async setMagneticTriggerPoint(b: 0 | 1, p: number) {
    this.#s.magneticButtons!.buttons[b].triggerPoint = p;
    return p;
  }
  async setMagneticRapidTrigger(b: 0 | 1, enabled: boolean, level: number) {
    Object.assign(this.#s.magneticButtons!.buttons[b], { rapidTriggerEnabled: enabled, rapidTrigger: level });
    return { enabled, level };
  }
}

interface Sample {
  device: HIDDevice;
  brand: string;
  cls: string;
  client: SampleClient;
}

const fakeDevice = (vendorId: number, productId: number, productName: string) => ({ vendorId, productId, productName, collections: [], opened: false }) as unknown as HIDDevice;

const steps = (min: number, max: number, step: number) => Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step);

let samples: Sample[] | null = null;
function all(): Sample[] {
  samples ??= [
    { device: fakeDevice(0x1532, 0x00c1, "Razer Viper V3 Pro"), brand: "Razer", cls: "RazerHidClient", client: new SampleClient(razerStatus(), steps(100, 35000, 50)) },
    { device: fakeDevice(0x3710, 0x5406, "Pulsar X2 HE 4K Dongle"), brand: "Pulsar", cls: "PulsarHidClient", client: new SampleClient(pulsarStatus(), steps(50, 26000, 10)) },
    { device: fakeDevice(0x4f42, 0x5642, "SYNQ Sample Mouse"), brand: "Redragon", cls: "RazerHidClient", client: new SampleClient(sampleStatus(), [450, 900, 1800, 3500]) },
  ];
  return samples;
}

export const sampleHost: GenericHost = {
  live: false,
  store: memoryStore(),
  async devices() {
    return all().map((s) => s.device);
  },
  async match(device): Promise<DriverMatch | null> {
    const s = all().find((x) => x.device === device);
    return s ? { brand: s.brand, cls: s.cls, create: () => s.client } : null;
  },
};
