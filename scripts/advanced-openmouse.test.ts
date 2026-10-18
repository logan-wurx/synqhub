// The generic (OpenMouse) mouse path's Advanced actions, against a driver stand-in that has every method a
// real driver can have, dangerous ones included, and a log of what ran:
//   node --test scripts/advanced-openmouse.test.ts
//
//  (a) the four Advanced driver methods are refused without the confirmation token, and a token opens only
//      its own scope's method;
//  (b) every other method of every real OpenMouse driver (firmware, un-pair, wipes, USB identity, raw
//      reports, macros, profile rewrites...) stays unreachable with every token held;
//  (c) a backup is saved before the first changing call of every flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SafeMouse } from "../src/lib/openmouse/safe-mouse.ts";
import { ADVANCED_METHODS, NEVER_PATTERNS, isAdvancedAllowed, isAllowed, isBlocked } from "../src/lib/openmouse/policy.ts";
import { isLeftClickLabel, primaryButtonName } from "../src/lib/openmouse/advanced.ts";
import { DRIVER_INDEX } from "../src/lib/openmouse/driver-index.generated.ts";
import { memoryStore } from "../src/lib/openmouse/store.ts";
import { AdvancedGate, type AdvancedScope } from "../src/lib/advanced/core.ts";

const ok = { acknowledged: true };
const RESET = { acknowledged: true, typed: "RESET" };
const SCOPES: AdvancedScope[] = ["pair", "remap", "macros", "calibrate", "reset"];

const DANGEROUS = [
  "enterBootloader", "erase", "pair", "clearPairing", "startR1ReceiverPairing", "unpairOmniDevice", "rebootOmniReceiver", "resetAllOnboardProfiles",
  "initializeBlankOnboardProfiles", "resetButtonMappings", "setUsbSpeed", "writeBlock", "sendCommand", "sendOutput", "sendFeatureReport", "receiveFeatureReport", "request",
  "setOnboardMode", "requestHostSwitch", "uploadMacro", "setFriendlyName", "setGameMode", "clearMacroSlot", "setProfileData", "setButtonsMapping", "setMacros", "setKeys",
  "flashFirmware", "updateFirmware", "dfuEnter", "startDfu", "setLayerOrientation",
];

async function gateWith(...scopes: AdvancedScope[]) {
  const g = new AdvancedGate("t");
  for (const s of scopes) await g.grant(s, RESET);
  return g;
}

// ---------------------------------------------------------------------------------------------
// A driver stand-in
// ---------------------------------------------------------------------------------------------

interface Opts {
  buttons?: boolean;
  magnetic?: boolean;
  reset?: boolean;
  omni?: boolean;
  primary?: "Left" | "Right";
  leftLabel?: string;
  fixed?: string[];
}

function fakeMouse(o: Opts = {}) {
  const calls: string[] = [];
  const s: Record<string, unknown> = {
    brand: "Lamzu",
    name: "Test Mouse",
    ui: { settingsReady: true, dpiStageEditor: { maxStages: 5, countEditable: true, minDpi: 100, maxDpi: 26000, stepDpi: 50 } },
    batteryPercent: 50,
    batteryState: "Discharging",
    dpi: 800,
    dpiStages: [400, 800, 1600],
    activeDpiStage: 1,
    pollingRateHz: 1000,
    supportedPollingRates: [500, 1000, 2000],
    activeProfile: 0,
    liftOffDistance: "Low",
    supportedLiftOffDistances: ["Low", "Medium"],
    motionSync: false,
    debounceMs: 2,
    sleepTimeout: 60,
    deviceMode: "Onboard",
    firmware: ["Mouse 1.2.6", "Dongle 1.0.9"],
  };
  if (o.primary) s.primaryButton = o.primary;
  if (o.buttons !== false) {
    s.buttonMappings = { Left: o.leftLabel ?? "Left click", Right: "Right click", Middle: "Middle click", Back: "Back", Forward: "Forward", DPI: "DPI cycle" };
    s.buttonOptions = ["Left click", "Right click", "Middle click", "Back", "Forward", "DPI cycle", "Disabled"];
    if (o.fixed) s.fixedButtons = o.fixed;
  }
  if (o.magnetic !== false) {
    s.magneticButtons = {
      buttons: [{ switchType: "magnetic", triggerPoint: 1, rapidTrigger: 0.5, rapidTriggerEnabled: false }, { switchType: "magnetic", triggerPoint: 1, rapidTrigger: 0.5, rapidTriggerEnabled: false }],
      triggerPointRange: { min: 0.1, max: 2 },
      rapidTriggerRange: { min: 0.1, max: 1 },
      rapidTriggerUnit: "level",
      rapidTriggerSwitch: true,
      canChooseSwitchType: false,
      calibration: "calibrated",
      liveDepth: false,
    };
  }
  if (o.omni) s.asusOmni = { firmware: "1.0", devices: [{ productId: 0x1a00, kind: "mouse", name: "Old mouse" }] };
  const impl: Record<string, (...a: never[]) => unknown> = {
    open: async () => void calls.push("open"),
    close: async () => void calls.push("close"),
    readStatus: async () => (calls.push("readStatus"), structuredClone(s)),
    getDpiOptions: () => [100, 400, 800, 1600, 26000],
    getSupportedPollingRates: () => [500, 1000, 2000],
    getSleepOptions: () => [30, 60, 120],
    getDebounceOptions: () => [0, 1, 2, 4],
    setDpi: async (v: number) => (calls.push("setDpi"), (s.dpi = v)),
    setDpiStageValue: async (i: number, v: number) => (calls.push("setDpiStageValue"), ((s.dpiStages as number[])[i] = v)),
    setDpiStageCount: async (n: number) => (calls.push("setDpiStageCount"), ((s.dpiStages as number[]).length = n)),
    setActiveDpiStage: async (i: number) => (calls.push("setActiveDpiStage"), (s.activeDpiStage = i)),
    setPollingRate: async (v: number) => (calls.push("setPollingRate"), (s.pollingRateHz = v)),
    setLiftOffDistance: async (v: string) => (calls.push("setLiftOffDistance"), (s.liftOffDistance = v)),
    setMotionSync: async (v: boolean) => (calls.push("setMotionSync"), (s.motionSync = v)),
    setDebounceTime: async (v: number) => (calls.push("setDebounceTime"), (s.debounceMs = v)),
    setSleepTimeout: async (v: number) => (calls.push("setSleepTimeout"), (s.sleepTimeout = v)),
    setMagneticTriggerPoint: async (b: number, p: number) => (calls.push("setMagneticTriggerPoint"), ((s.magneticButtons as { buttons: { triggerPoint: number }[] }).buttons[b].triggerPoint = p)),
    setMagneticRapidTrigger: async (b: number, enabled: boolean, level: number) => {
      calls.push("setMagneticRapidTrigger");
      Object.assign((s.magneticButtons as { buttons: object[] }).buttons[b], { rapidTriggerEnabled: enabled, rapidTrigger: level });
      return { enabled, level };
    },
  };
  if (o.buttons !== false) {
    impl.setButtonMapping = async (button: string, action: string) => {
      calls.push(`ADV:setButtonMapping(${button},${action})`);
      (s.buttonMappings as Record<string, string>)[button] = action;
    };
  }
  if (o.reset !== false) {
    impl.factoryReset = async () => {
      calls.push("ADV:factoryReset");
      s.dpiStages = [800, 1600];
      s.activeDpiStage = 0;
      s.dpi = 800;
      s.pollingRateHz = 1000;
      s.debounceMs = 4;
      s.buttonMappings = { Left: "Left click", Right: "Right click", Middle: "Middle click", Back: "Back", Forward: "Forward", DPI: "DPI cycle" };
    };
  }
  if (o.magnetic !== false) {
    impl.calibrateMagneticButtons = async (onProgress: (p: { left: number; right: number; message: string; step: number; steps: number }) => void, signal?: AbortSignal) => {
      calls.push("ADV:calibrate");
      for (const [left, right] of [[0, 0], [50, 0], [100, 40], [100, 100]]) {
        if (signal?.aborted) throw new Error("Calibration cancelled.");
        onProgress({ left, right, message: `step ${left}/${right}`, step: 1, steps: 6 });
        await new Promise((r) => setTimeout(r, 1));
      }
      (s.magneticButtons as { calibration: string }).calibration = "calibrated";
    };
  }
  if (o.omni) {
    impl.setOmniPairingMode = async (on: boolean) => {
      calls.push(`ADV:setOmniPairingMode(${on})`);
    };
  }
  for (const d of DANGEROUS) impl[d] = () => void calls.push(`DANGER:${d}`);
  const client = new Proxy(impl, { get: (t, k) => Reflect.get(t, k) });
  return { client, calls, status: s };
}

const device = () => ({ vendorId: 0x373e, productId: 0x1234, productName: "Test Mouse" });
const match = (client: unknown, cls = "LamzuHidClient") => ({ brand: "Lamzu", cls, create: () => client });

async function rig(o: Opts = {}) {
  const f = fakeMouse(o);
  const store = memoryStore();
  const events: string[] = [];
  const save = store.saveBackup;
  store.saveBackup = async (p, j) => (events.push(`backup:${p}`), save(p, j));
  // every driver call lands in the same ordered list as the backups
  const wrapped = new Proxy(f.client, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (typeof k === "string" && typeof v === "function" && /^(setButtonMapping|factoryReset|calibrateMagneticButtons|setOmniPairingMode)$/.test(k)) {
        return (...a: unknown[]) => (events.push(`call:${k}`), (v as (...x: unknown[]) => unknown)(...a));
      }
      return v;
    },
  });
  const safe = await SafeMouse.connect(device(), match(wrapped), store, { wait: async () => undefined });
  safe.setAllowChanges(true);
  return { f, safe, store, events };
}

// ---------------------------------------------------------------------------------------------
// (a) and (b): the method policy
// ---------------------------------------------------------------------------------------------

test("(a) the four Advanced methods need their token; each token opens only its own method", async () => {
  const wanted: [string, AdvancedScope][] = [["setOmniPairingMode", "pair"], ["setButtonMapping", "remap"], ["calibrateMagneticButtons", "calibrate"], ["factoryReset", "reset"]];
  for (const [method, scope] of wanted) {
    assert.ok(isBlocked(method), `${method} stays blocked on the default path`);
    assert.ok(!isAllowed(method));
    assert.ok(!isAdvancedAllowed(method, scope), `${method}: no gate`);
    assert.ok(!isAdvancedAllowed(method, scope, await gateWith()), `${method}: empty gate`);
    assert.ok(!isAdvancedAllowed(method, scope, { has: () => true, scheme: undefined }), `${method}: lookalike`);
    assert.ok(isAdvancedAllowed(method, scope, await gateWith(scope)), `${method}: ${scope}`);
    for (const other of SCOPES.filter((x) => x !== scope)) {
      assert.ok(!isAdvancedAllowed(method, scope, await gateWith(other)), `${method} must not open with only ${other}`);
      assert.ok(!isAdvancedAllowed(method, other, await gateWith(scope, other)) || ADVANCED_METHODS[other]?.includes(method), `${method} under the wrong scope ${other}`);
    }
  }
});

test("(b) nothing else is reachable with every token: not the dangerous names, not any method of any real driver", async () => {
  const all = await gateWith(...SCOPES);
  // setOmniPairingMode lives on AsusHidClient, which can't be built around a fake device; it is named here.
  const names = new Set<string>([...DANGEROUS, "setOmniPairingMode", "setButtonMapping", "factoryReset", "calibrateMagneticButtons"]);
  const fakeHid = { vendorId: 0, productId: 0, productName: "", opened: false, collections: [], addEventListener() {}, removeEventListener() {} } as unknown as HIDDevice;
  let classes = 0;
  for (const e of DRIVER_INDEX) {
    const impl = await e.load();
    let client: object | null = null;
    try {
      client = impl.create(fakeHid) as object;
    } catch {
      continue;
    }
    classes++;
    for (let p = Object.getPrototypeOf(client); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const n of Object.getOwnPropertyNames(p)) if (typeof Object.getOwnPropertyDescriptor(p, n)?.value === "function" && n !== "constructor") names.add(n);
  }
  assert.ok(classes > 70);
  const reachable: string[] = [];
  for (const n of names) for (const scope of SCOPES) if (isAdvancedAllowed(n, scope, all)) reachable.push(`${scope}:${n}`);
  assert.deepEqual(reachable.sort(), ["calibrate:calibrateMagneticButtons", "pair:setOmniPairingMode", "remap:setButtonMapping", "reset:factoryReset"]);
  // the real drivers do have the dangerous ones; none is reachable
  for (const n of ["unpairOmniDevice", "rebootOmniReceiver", "resetAllOnboardProfiles", "initializeBlankOnboardProfiles", "setUsbSpeed", "startR1ReceiverPairing"]) {
    assert.ok(names.has(n), `${n} exists on a real driver`);
    for (const scope of SCOPES) assert.ok(!isAdvancedAllowed(n, scope, all), `${scope}:${n}`);
  }
  // firmware-ish names never pass even if someone adds them to a list
  for (const n of ["updateFirmware", "flashFirmware", "enterBootloader", "startDfu", "eraseFlash", "upgrade", "setUsbSpeed", "sendCommand", "unpairOmniDevice", "clearMacroSlot", "resetAllOnboardProfiles"]) {
    assert.ok(NEVER_PATTERNS.some((p) => p.test(n)), n);
  }
  // and the lists themselves contain none of them
  for (const list of Object.values(ADVANCED_METHODS)) for (const n of list ?? []) assert.ok(!NEVER_PATTERNS.some((p) => p.test(n)), n);
});

// ---------------------------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------------------------

test("the card lists what this mouse can do, with sources, and hides the rest with a reason", async () => {
  const { safe } = await rig({ omni: true });
  const f = safe.advanced.features;
  for (const s of ["pair", "remap", "calibrate", "reset"] as const) {
    assert.ok(f[s].available, s);
    assert.match(f[s].source, /OpenMouse/);
  }
  assert.ok(!f.macros.available && f.macros.why);
  assert.ok(safe.advanced.pair && safe.advanced.buttons && safe.advanced.calibrate && safe.advanced.reset);
  assert.equal(safe.advanced.macros, undefined);
  assert.deepEqual(safe.advanced.firmware.versions, [{ part: "Mouse", version: "1.2.6" }, { part: "Dongle", version: "1.0.9" }]);
  assert.equal(safe.advanced.firmware.updater?.url, "https://www.lamzu.net/");
  assert.equal(safe.advanced.firmware.latest, null);

  const bare = await rig({ buttons: false, magnetic: false, reset: false });
  for (const s of ["pair", "remap", "calibrate", "reset"] as const) assert.ok(!bare.safe.advanced.features[s].available && bare.safe.advanced.features[s].why, s);
  assert.equal(bare.safe.advanced.buttons, undefined);
  assert.equal(bare.safe.advanced.calibrate, undefined);
  assert.equal(bare.safe.advanced.reset, undefined);
});

test("button changes are hidden when SYNQ can't tell which button is left click", async () => {
  const odd = await rig({ leftLabel: "Primary" });
  assert.ok(!odd.safe.advanced.features.remap.available);
  assert.match(odd.safe.advanced.features.remap.why ?? "", /left click/);
  const handed = await rig({ primary: "Right" });
  assert.ok(!handed.safe.advanced.features.remap.available, "the right button is the primary one but reads 'Right click': can't be verified");
  assert.deepEqual([isLeftClickLabel("Left click"), isLeftClickLabel("Left Button"), isLeftClickLabel("left"), isLeftClickLabel("Right click"), isLeftClickLabel("Left double")], [true, true, true, false, false]);
  assert.equal(primaryButtonName({ buttonMappings: { Left: "x", Right: "y" } } as never), "Left");
  assert.equal(primaryButtonName({ primaryButton: "Right", buttonMappings: { Left: "x", Right: "y" } } as never), "Right");
});

test("Advanced stays shut while the mouse is read-only", async () => {
  const f = fakeMouse();
  const safe = await SafeMouse.connect({ vendorId: 0x3710, productId: 0x9999, productName: "Unknown" }, match(f.client, "PulsarHidClient"), memoryStore(), { wait: async () => undefined });
  // an untested mouse: settingsReady alone doesn't make it 'verified'; flip it read-only
  (f.status.ui as Record<string, unknown>).settingsReady = false;
  const locked = await SafeMouse.connect({ vendorId: 0x3710, productId: 0x9999, productName: "Unknown" }, match(f.client, "PulsarHidClient"), memoryStore());
  await assert.rejects(locked.advanced.buttons!.begin(ok), /aren't mapped yet|Read-only/);
  await assert.rejects(locked.advanced.reset!.reset(RESET), /aren't mapped|Read-only/);
  assert.ok(!f.calls.some((c) => c.startsWith("ADV:")));
  void safe;
});

test("(a) the panel's actions refuse to start without a confirmation, and call the driver for nothing", async () => {
  const { f, safe } = await rig({ omni: true });
  const a = safe.advanced;
  const ac = new AbortController();
  await assert.rejects(a.buttons!.begin({ acknowledged: false }), /confirmation/);
  await assert.rejects(a.calibrate!.run({ acknowledged: false }, () => {}, ac.signal), /confirmation/);
  await assert.rejects(a.pair!.run({ acknowledged: false }, () => {}, ac.signal), /confirmation/);
  await assert.rejects(a.reset!.reset({ acknowledged: true }), /RESET/);
  await assert.rejects(a.reset!.reset({ acknowledged: true, typed: "reset" }), /RESET/);
  await assert.rejects(a.buttons!.set("Right", "Disabled"), /Start button changes first/);
  assert.ok(!f.calls.some((c) => c.startsWith("ADV:") || c.startsWith("DANGER")), f.calls.join());
  assert.deepEqual(a.gate.live, []);
});

test("(c) buttons: backup first; the left button is locked; fixed buttons are left alone; Undo all", async () => {
  const { f, safe, events } = await rig({ fixed: ["Back"] });
  const b = safe.advanced.buttons!;
  const s = await b.begin(ok);
  assert.ok(events.indexOf("backup:generic-lamzu-test-mouse-buttons") >= 0, events.join());
  assert.ok(!events.includes("call:setButtonMapping"), "nothing changed yet");
  assert.ok(events.indexOf("backup:generic-lamzu-test-mouse-buttons") < events.length);
  assert.match(s.backupPath ?? "", /buttons/);
  assert.deepEqual(s.slots.map((x) => [x.id, x.locked]), [["Left", true], ["Right", false], ["Middle", false], ["Back", true], ["Forward", false], ["DPI", false]]);
  assert.equal(s.slots[0].actionLabel, "Left click");
  assert.deepEqual(safe.advanced.gate.live, ["remap"]);

  let st = await b.set("Middle", "Back");
  assert.equal(st.slots[2].actionLabel, "Back");
  assert.ok(st.slots[2].changed);
  st = await b.set("Right", "Left click"); // another button may also click left
  assert.equal(f.status.buttonMappings && (f.status.buttonMappings as Record<string, string>).Right, "Left click");
  const firstCall = events.indexOf("call:setButtonMapping");
  assert.ok(events.indexOf("backup:generic-lamzu-test-mouse-buttons") < firstCall);

  await assert.rejects(b.set("Left", "Disabled"), /left button always stays left click/);
  await assert.rejects(b.set("Left", "Right click"), /left button always stays left click/);
  await assert.rejects(b.set("Back", "Disabled"), /leaves it alone/);
  await assert.rejects(b.set("Right", "Macro 1"), /doesn't offer that action/);
  await assert.rejects(b.set("Thumb", "Disabled"), /isn't a button/);
  assert.equal((f.status.buttonMappings as Record<string, string>).Left, "Left click");

  st = await b.undoAll();
  assert.deepEqual(f.status.buttonMappings, { Left: "Left click", Right: "Right click", Middle: "Middle click", Back: "Back", Forward: "Forward", DPI: "DPI cycle" });
  assert.ok(st.slots.every((x) => !x.changed));
  await b.end();
  assert.deepEqual(safe.advanced.gate.live, []);
  assert.ok(!f.calls.some((c) => c.startsWith("DANGER")));
});

test("(c) calibration: backup first, progress per button, abort and failure are safe", async () => {
  const { f, safe, events } = await rig();
  const cal = safe.advanced.calibrate!;
  assert.ok(cal.steps.length >= 3 && cal.timeoutSeconds > 0);
  assert.equal(cal.canRestore, false);
  assert.match(cal.restoreNote, /old calibration can't be read back/);
  const seen: string[] = [];
  const done = await cal.run(ok, (p) => seen.push(`${p.phase}:${p.targets.map((t) => t.state[0]).join("")}`), new AbortController().signal);
  assert.equal(done.phase, "done");
  assert.ok(events.indexOf("backup:generic-lamzu-test-mouse-before-calibration") < events.indexOf("call:calibrateMagneticButtons"), events.join());
  assert.ok(seen.includes("pressing:pw"), `a half-pressed left button shows as partial: ${seen.join()}`);
  assert.ok(seen.includes("pressing:dp"));
  assert.deepEqual(safe.advanced.gate.live, []);
  assert.match(done.backupPath ?? "", /before-calibration/);

  // aborted part-way: the driver is told, the token is given back
  const ctl = new AbortController();
  const aborted = await cal.run(ok, (p) => p.targets[0].state === "partial" && ctl.abort(), ctl.signal);
  assert.equal(aborted.phase, "aborted");
  assert.deepEqual(safe.advanced.gate.live, []);

  // the mouse says it failed
  const driver = f.client as unknown as { calibrateMagneticButtons: () => Promise<void> };
  driver.calibrateMagneticButtons = async () => {
    throw new Error("The press was too light. Fully press and release.");
  };
  const failed = await cal.run(ok, () => {}, new AbortController().signal);
  assert.equal(failed.phase, "failed");
  assert.match(failed.message, /too light/);
  assert.deepEqual(safe.advanced.gate.live, []);
});

test("(c) a factory reset: RESET typed, the full backup first, then reset, then 'Restore my settings'", async () => {
  const { f, safe, events, store } = await rig();
  // change a few settings and a button so there is something to restore
  await safe.apply({ kind: "polling", hz: 2000 });
  await safe.apply({ kind: "stages", values: [500, 900, 1800], active: 2 });
  await safe.apply({ kind: "debounce", ms: 1 });
  const b = safe.advanced.buttons!;
  await b.begin(ok);
  await b.set("DPI", "Disabled");
  await b.end();
  const before = JSON.parse(JSON.stringify(f.status));
  events.length = 0;

  const reset = safe.advanced.reset!;
  assert.ok(reset.wipes.length >= 2);
  const { backupPath } = await reset.reset(RESET);
  assert.match(backupPath, /before-reset/);
  assert.ok(events.indexOf("backup:generic-lamzu-test-mouse-before-reset") >= 0 && events.indexOf("backup:generic-lamzu-test-mouse-before-reset") < events.indexOf("call:factoryReset"), events.join());
  const saved = JSON.parse(store.backups.at(-1)!.json);
  assert.equal(saved.status.pollingRateHz, 2000, "the backup holds the settings from before");
  assert.deepEqual(saved.status.dpiStages, [500, 900, 1800]);
  assert.equal(f.status.pollingRateHz, 1000, "the mouse is back to factory");
  assert.ok(reset.canRestore());
  assert.deepEqual(safe.advanced.gate.live, []);

  await assert.rejects(reset.restore({ acknowledged: false }), /confirmation/);
  await reset.restore(ok);
  assert.equal(f.status.pollingRateHz, before.pollingRateHz);
  assert.deepEqual(f.status.dpiStages, before.dpiStages);
  assert.equal(f.status.activeDpiStage, before.activeDpiStage);
  assert.equal(f.status.debounceMs, before.debounceMs);
  assert.deepEqual(f.status.buttonMappings, before.buttonMappings, "the changed button comes back too");
  assert.deepEqual(safe.advanced.gate.live, []);
  assert.ok(!f.calls.some((c) => c.startsWith("DANGER")));
});

test("(c) a reset never runs if its backup couldn't be saved", async () => {
  const { f, safe, store } = await rig();
  store.saveBackup = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(safe.advanced.reset!.reset(RESET), /disk full/);
  assert.ok(!f.calls.includes("ADV:factoryReset"));
  await assert.rejects(safe.advanced.buttons!.begin(ok), /disk full/);
  assert.deepEqual(safe.advanced.gate.live, []);
});

test("pairing through an ASUS Omni receiver: pairing mode on, the new mouse noticed, pairing mode off again", async () => {
  const { f, safe } = await rig({ omni: true });
  let polls = 0;
  const impl = f.client as unknown as { readStatus: () => Promise<unknown> };
  const read = impl.readStatus;
  impl.readStatus = async () => {
    const s = (await read()) as { asusOmni: { devices: { productId: number }[] } };
    if (++polls === 4) s.asusOmni.devices.push({ productId: 0x1b00 });
    return s;
  };
  const seen: string[] = [];
  const r = await safe.advanced.pair!.run(ok, (p) => seen.push(p.phase), new AbortController().signal);
  assert.equal(r.phase, "paired");
  assert.deepEqual(seen.slice(0, 2), ["starting", "waiting"]);
  assert.deepEqual(f.calls.filter((c) => c.includes("setOmniPairingMode")), ["ADV:setOmniPairingMode(true)", "ADV:setOmniPairingMode(false)"]);
  assert.deepEqual(safe.advanced.gate.live, []);
  assert.ok(!f.calls.some((c) => c.startsWith("DANGER")));
});
