// Checks the generic (OpenMouse) mouse path without a device or a window:
//   node --test scripts/openmouse-safety.test.ts
//
//  - the safety wrapper can only reach allowlisted driver methods; blocked ones are unreachable;
//  - backups come before the first write, and every write is read back and compared;
//  - read-only / hand-built / not-ready mice refuse writes;
//  - the per-vendor lazy registry picks the same driver as OpenMouse's createSupportedClient.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICE_DRIVERS, SUPPORTED_HID_FILTERS, createSupportedClient } from "@openmouse/protocol/drivers";
import { SafeMouse, type Change } from "../src/lib/openmouse/safe-mouse.ts";
import { READ_METHODS, SETTING_METHODS, isAllowed, isBlocked, persistenceFor, supportTier } from "../src/lib/openmouse/policy.ts";
import { findDriver } from "../src/lib/openmouse/registry.ts";
import { DRIVER_INDEX } from "../src/lib/openmouse/driver-index.generated.ts";
import { memoryStore } from "../src/lib/openmouse/store.ts";
import { claimMice, connectGeneric } from "../src/lib/openmouse/host.ts";

const DANGEROUS = [
  "factoryReset",
  "enterBootloader",
  "erase",
  "pair",
  "clearPairing",
  "startR1ReceiverPairing",
  "unpairOmniDevice",
  "setOmniPairingMode",
  "rebootOmniReceiver",
  "calibrateMagneticButtons",
  "resetAllOnboardProfiles",
  "initializeBlankOnboardProfiles",
  "resetButtonMappings",
  "setUsbSpeed",
  "writeBlock",
  "sendCommand",
  "sendOutput",
  "sendFeatureReport",
  "receiveFeatureReport",
  "request",
  "setOnboardMode",
  "requestHostSwitch",
  "uploadMacro",
  "setButtonMapping",
  "setFriendlyName",
  "setGameMode",
  "clearMacroSlot",
  "setProfileData",
];

// ---------------------------------------------------------------------------------------------
// A driver stand-in: every allowed method plus every dangerous one, with a log of what ran.
// ---------------------------------------------------------------------------------------------

function fakeClient(opts: { ui?: Record<string, unknown>; readBack?: "same" | "wrong" | "none"; writeOnlyLighting?: boolean } = {}) {
  const calls: string[] = [];
  const touched = new Set<string>();
  const s: Record<string, unknown> = {
    brand: "Pulsar",
    name: "Test Mouse",
    ui: opts.ui ?? { settingsReady: true, dpiStageEditor: { maxStages: 5, countEditable: true, minDpi: 100, maxDpi: 26000, stepDpi: 50 } },
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
    angleSnapping: false,
    rippleControl: false,
    debounceMs: 2,
    sleepTimeout: 60,
    deviceMode: "Onboard",
    lighting: { zone: "Logo", modes: ["Off", "Static"], mode: "Static", color: "#112233", color2: null, colorModes: ["Static"], dualColorModes: [], reactiveModes: [], speeds: [], speed: null, writeOnly: opts.writeOnlyLighting ?? false },
    magneticButtons: {
      buttons: [
        { switchType: "magnetic", triggerPoint: 1, rapidTrigger: 0.5, rapidTriggerEnabled: false },
        { switchType: "magnetic", triggerPoint: 1, rapidTrigger: 0.5, rapidTriggerEnabled: false },
      ],
      triggerPointRange: { min: 0.1, max: 2 },
      rapidTriggerRange: { min: 0.1, max: 1 },
      rapidTriggerUnit: "level",
      rapidTriggerSwitch: true,
      canChooseSwitchType: false,
      calibration: "calibrated",
      liveDepth: false,
    },
    firmware: ["1.0"],
  };
  const keep = (field: string) => (v: unknown) => {
    if (opts.readBack === "wrong") s[field] = typeof v === "number" ? v + 1 : typeof v === "boolean" ? !v : "High";
    else if (opts.readBack === "none") s[field] = null;
    else s[field] = v;
    return v;
  };
  const impl: Record<string, (...a: never[]) => unknown> = {
    open: async () => void calls.push("open"),
    close: async () => void calls.push("close"),
    readStatus: async () => (calls.push("readStatus"), structuredClone(s)),
    getDpiOptions: () => [100, 150, 200, 26000],
    getSupportedPollingRates: () => [500, 1000, 2000],
    getSleepOptions: () => [30, 60, 120],
    getDebounceOptions: () => [0, 1, 2, 4],
    setDpi: async (v: number) => (calls.push("setDpi"), keep("dpi")(v)),
    setDpiStageValue: async (i: number, v: number) => {
      calls.push("setDpiStageValue");
      (s.dpiStages as number[])[i] = opts.readBack === "wrong" ? v + 50 : v;
      return v;
    },
    setDpiStageCount: async (n: number) => {
      calls.push("setDpiStageCount");
      (s.dpiStages as number[]).length = n;
      return n;
    },
    setActiveDpiStage: async (i: number) => (calls.push("setActiveDpiStage"), (s.activeDpiStage = i)),
    setPollingRate: async (v: number) => (calls.push("setPollingRate"), keep("pollingRateHz")(v)),
    setLiftOffDistance: async (v: string) => (calls.push("setLiftOffDistance"), keep("liftOffDistance")(v as never)),
    setMotionSync: async (v: boolean) => (calls.push("setMotionSync"), keep("motionSync")(v)),
    setAngleSnapping: async (v: boolean) => (calls.push("setAngleSnapping"), keep("angleSnapping")(v)),
    setRippleControl: async (v: boolean) => (calls.push("setRippleControl"), keep("rippleControl")(v)),
    setDebounceTime: async (v: number) => (calls.push("setDebounceTime"), keep("debounceMs")(v)),
    setSleepTimeout: async (v: number) => (calls.push("setSleepTimeout"), keep("sleepTimeout")(v)),
    setLighting: async (l: never) => {
      calls.push("setLighting");
      // Write-only zones keep reporting the boot effect, as Razer's do.
      if (!opts.writeOnlyLighting) s.lighting = l;
    },
    setMagneticTriggerPoint: async (b: number, p: number) => {
      calls.push("setMagneticTriggerPoint");
      (s.magneticButtons as { buttons: { triggerPoint: number }[] }).buttons[b].triggerPoint = p;
      return p;
    },
    setMagneticRapidTrigger: async (b: number, enabled: boolean, level: number) => {
      calls.push("setMagneticRapidTrigger");
      Object.assign((s.magneticButtons as { buttons: object[] }).buttons[b], { rapidTriggerEnabled: enabled, rapidTrigger: level });
      return { enabled, level };
    },
  };
  for (const d of DANGEROUS) impl[d] = () => void calls.push(`DANGER:${d}`);
  const client = new Proxy(impl, {
    get(t, k) {
      if (typeof k === "string") touched.add(k);
      return Reflect.get(t, k);
    },
  });
  return { client, calls, touched, status: s };
}

const device = (vendorId = 0x3710, productId = 0x1234) => ({ vendorId, productId, productName: "Test Mouse" });
const match = (client: unknown, cls = "PulsarHidClient") => ({ brand: "Pulsar", cls, create: () => client });

const EVERY_CHANGE: Change[] = [
  { kind: "dpi", dpi: 1600 },
  { kind: "stages", values: [400, 900, 1600, 3200], active: 2 },
  { kind: "polling", hz: 2000 },
  { kind: "lod", value: "Medium" },
  { kind: "toggle", setting: "motionSync", on: true },
  { kind: "toggle", setting: "angleSnapping", on: true },
  { kind: "toggle", setting: "rippleControl", on: true },
  { kind: "debounce", ms: 4 },
  { kind: "sleep", value: 120 },
  { kind: "magneticTrigger", button: 0, point: 0.5 },
  { kind: "magneticRapid", button: 1, enabled: true, level: 0.3 },
];

// ---------------------------------------------------------------------------------------------
// Allowlist and blocklist
// ---------------------------------------------------------------------------------------------

test("no allowlisted method is blocked, and every dangerous name is", () => {
  for (const m of [...READ_METHODS, ...SETTING_METHODS]) {
    assert.ok(!isBlocked(m), `${m} is on the allowlist but matches a block pattern`);
    assert.ok(isAllowed(m));
  }
  for (const m of DANGEROUS) {
    assert.ok(isBlocked(m), `${m} must be blocked`);
    assert.ok(!isAllowed(m), `${m} must not be allowed`);
  }
  for (const m of ["setMagneticSwitchTypes", "setButtonsMapping", "setMacros", "setProfile", "readOnboardProfiles", "playHapticEffect"]) {
    assert.ok(!isAllowed(m), `${m} is not on the allowlist`);
  }
});

test("every method of every real OpenMouse driver: dangerous ones are never allowed", async () => {
  const fakeHid = { vendorId: 0, productId: 0, productName: "", opened: false, collections: [], addEventListener() {}, removeEventListener() {} } as unknown as HIDDevice;
  const names = new Set<string>();
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
    for (let p = Object.getPrototypeOf(client); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const n of Object.getOwnPropertyNames(p)) if (typeof Object.getOwnPropertyDescriptor(p, n)?.value === "function" && n !== "constructor") names.add(n);
    }
  }
  assert.ok(classes > 70, `instantiated ${classes} driver classes`);
  const allowed = [...names].filter(isAllowed);
  const blocked = [...names].filter(isBlocked);
  for (const m of allowed) assert.ok(!isBlocked(m));
  // The real drivers do have these; the point is that none is reachable.
  for (const m of ["factoryReset", "calibrateMagneticButtons", "setUsbSpeed", "resetAllOnboardProfiles"]) assert.ok(names.has(m) && isBlocked(m), m);
  console.log(`  ${names.size} distinct driver methods; ${allowed.length} allowed, ${blocked.length} blocked, the rest simply never called`);
  console.log(`  blocked: ${blocked.sort().join(", ")}`);
});

test("the wrapper only ever touches allowlisted methods, through every read and change", async () => {
  const f = fakeClient();
  const store = memoryStore();
  const safe = await SafeMouse.connect(device(), match(f.client), store);
  safe.view;
  await safe.refresh();
  for (const c of EVERY_CHANGE) await safe.apply(c);
  await safe.apply({ kind: "lighting", lighting: { ...(f.status.lighting as never as object), mode: "Off" } as never });
  await safe.close();
  const allowed = new Set<string>([...READ_METHODS, ...SETTING_METHODS]);
  for (const k of f.touched) assert.ok(allowed.has(k), `the wrapper looked up "${k}" on the driver`);
  assert.ok(!f.calls.some((c) => c.startsWith("DANGER")), f.calls.join());
});

test("blocked methods are unreachable from outside the wrapper", async () => {
  const f = fakeClient();
  const safe = await SafeMouse.connect(device(), match(f.client), memoryStore());
  const loose = safe as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(safe), []);
  assert.equal(loose.client, undefined);
  assert.equal(loose["#client"], undefined);
  for (const d of DANGEROUS) {
    assert.equal(loose[d], undefined);
    await assert.rejects(safe.apply({ kind: d } as unknown as Change), /no change called/);
  }
  assert.ok(!f.calls.some((c) => c.startsWith("DANGER")));
});

// ---------------------------------------------------------------------------------------------
// Backup and read-back
// ---------------------------------------------------------------------------------------------

test("a backup of everything read is saved once, before the first write", async () => {
  const f = fakeClient();
  const store = memoryStore();
  const order: string[] = [];
  const save = store.saveBackup;
  store.saveBackup = async (p, j) => {
    order.push(`backup after ${f.calls.filter((c) => c.startsWith("set")).length} writes`);
    return save(p, j);
  };
  const safe = await SafeMouse.connect(device(), match(f.client), store);
  assert.equal(store.backups.length, 0, "reading never saves a backup");
  await safe.apply({ kind: "polling", hz: 2000 });
  await safe.apply({ kind: "dpi", dpi: 1200 });
  assert.deepEqual(order, ["backup after 0 writes"]);
  assert.equal(store.backups.length, 1);
  const b = JSON.parse(store.backups[0].json);
  assert.equal(b.status.pollingRateHz, 1000, "the backup holds the values from before the change");
  assert.equal(b.driver, "PulsarHidClient");
  assert.match(store.backups[0].prefix, /^generic-pulsar-test-mouse$/);
  assert.ok(store.lines.some((l) => /setPollingRate\(2000\)/.test(l)));
});

test("read-back compare: confirmed, mismatch, unconfirmed", async () => {
  {
    const f = fakeClient();
    const safe = await SafeMouse.connect(device(), match(f.client), memoryStore());
    for (const c of EVERY_CHANGE) {
      const r = await safe.apply(c);
      assert.equal(r.verdict, "confirmed", `${c.kind}: ${r.detail}`);
    }
    assert.deepEqual(safe.view.stages!.values, [400, 900, 1600, 3200]);
  }
  {
    const f = fakeClient({ readBack: "wrong" });
    const safe = await SafeMouse.connect(device(), match(f.client), memoryStore());
    for (const c of [{ kind: "polling", hz: 2000 }, { kind: "dpi", dpi: 1600 }, { kind: "toggle", setting: "motionSync", on: true }, { kind: "stages", values: [400, 1000, 1600], active: 1 }] as Change[]) {
      const r = await safe.apply(c);
      assert.equal(r.verdict, "mismatch", `${c.kind}: ${r.detail}`);
      assert.match(r.detail, /reports .* instead of/);
    }
  }
  {
    const f = fakeClient({ readBack: "none" });
    const safe = await SafeMouse.connect(device(), match(f.client), memoryStore());
    const r = await safe.apply({ kind: "debounce", ms: 4 });
    assert.equal(r.verdict, "unconfirmed");
    assert.match(r.detail, /^Unconfirmed/);
  }
  {
    const f = fakeClient({ writeOnlyLighting: true });
    const safe = await SafeMouse.connect(device(), match(f.client), memoryStore());
    const r = await safe.apply({ kind: "lighting", lighting: { ...(f.status.lighting as object), mode: "Off" } as never });
    assert.equal(r.verdict, "unconfirmed", "a write-only zone can't be confirmed");
  }
});

test("persistence labels come with every write", async () => {
  const f = fakeClient();
  const safe = await SafeMouse.connect(device(), match(f.client, "PulsarHidClient"), memoryStore());
  assert.match((await safe.apply({ kind: "polling", hz: 2000 })).detail, /Saved on the mouse$/);
  const g = fakeClient();
  const other = await SafeMouse.connect(device(0x2fe3, 1), match(g.client, "ModdoHidClient"), memoryStore());
  assert.match((await other.apply({ kind: "polling", hz: 2000 })).detail, /Not verified$/);
  assert.equal(persistenceFor("LogitechHidppClient", "setDpi", 0xc0a0), "volatile");
  assert.equal(persistenceFor("CorsairHidClient", "setPollingRate", 1), "volatile");
  assert.equal(persistenceFor("RazerHidClient", "setDpi", 0x00c1), "saved");
  assert.equal(persistenceFor("RazerHidClient", "setDpi", 0x0084), "volatile");
  assert.equal(persistenceFor("PulsarHidClient", "setDpi", 1, "Host"), "volatile");
  assert.equal(persistenceFor("SteelSeriesAerox3WirelessHidClient", "setLighting", 1), "volatile");
});

// ---------------------------------------------------------------------------------------------
// Tiers and locks
// ---------------------------------------------------------------------------------------------

test("tiers", () => {
  assert.equal(supportTier(0x046d, 0xc54d, undefined), "verified");
  assert.equal(supportTier(0x373b, 0x1278, undefined), "verified");
  assert.equal(supportTier(0x1532, 0x00c1, { settingsReady: true }), "driver-tested");
  assert.equal(supportTier(0x1532, 0x00c1, { valuesVerified: true }), "driver-tested");
  assert.equal(supportTier(0x3710, 0x1234, {}), "read-only");
  assert.equal(supportTier(0x3710, 0x1234, undefined), "read-only");
});

test("read-only mice refuse writes until changes are allowed", async () => {
  const f = fakeClient({ ui: { dpiStageEditor: { maxStages: 5, minDpi: 100, maxDpi: 26000, stepDpi: 50 } } });
  const store = memoryStore();
  const safe = await SafeMouse.connect(device(), match(f.client), store);
  assert.equal(safe.view.tier, "read-only");
  assert.equal(safe.view.writable, false);
  assert.equal(safe.view.canAllow, true);
  await assert.rejects(safe.apply({ kind: "polling", hz: 2000 }), /Read-only until you allow changes/);
  assert.equal(store.backups.length, 0);
  assert.ok(!f.calls.some((c) => c.startsWith("set")));
  safe.setAllowChanges(true);
  assert.equal((await safe.apply({ kind: "polling", hz: 2000 })).verdict, "confirmed");
  safe.setAllowChanges(false);
  await assert.rejects(safe.apply({ kind: "dpi", dpi: 1200 }));
});

test("mice with a hand-built panel, non-mice and not-ready drivers are never written", async () => {
  for (const [vid, pid, cls, ui] of [
    [0x046d, 0xc54d, "LogitechHidppClient", { settingsReady: true }],
    [0x373b, 0x1278, "AtkHidClient", { settingsReady: true }],
    [0x31e3, 0x1100, "WootingHidClient", { settingsReady: true }],
    [0x1b1c, 0x1b00, "CorsairBragiHidClient", { settingsReady: false }],
  ] as const) {
    const f = fakeClient({ ui });
    const safe = await SafeMouse.connect(device(vid, pid), match(f.client, cls), memoryStore());
    safe.setAllowChanges(true);
    assert.equal(safe.view.writable, false, cls);
    assert.equal(safe.view.canAllow, false, cls);
    await assert.rejects(safe.apply({ kind: "polling", hz: 2000 }));
    assert.ok(!f.calls.some((c) => c.startsWith("set")), cls);
  }
});

test("values the driver hides stay hidden", async () => {
  const f = fakeClient({ ui: { settingsReady: true, hideProcessingCard: true, hideSleepCard: true, hideLodLow: true, pollingReadOnly: true } });
  const safe = await SafeMouse.connect(device(), match(f.client), memoryStore());
  const v = safe.view;
  assert.deepEqual(v.toggles, []);
  assert.equal(v.sleep, null);
  assert.deepEqual(v.lod?.options, ["Medium"]);
  assert.equal(v.polling?.canSet, false);
  assert.equal(v.stages?.canSet, false, "no dpiStageEditor hint: stages are shown, not edited");
});

// ---------------------------------------------------------------------------------------------
// Lazy registry
// ---------------------------------------------------------------------------------------------

test("the lazy index lists every OpenMouse driver in order", () => {
  assert.equal(DRIVER_INDEX.length, DEVICE_DRIVERS.length);
  DRIVER_INDEX.forEach((e, i) => assert.equal(e.brand, DEVICE_DRIVERS[i].brand));
  for (const e of DRIVER_INDEX) assert.ok(e.vids.length, e.cls);
});

test("the lazy registry picks the same driver as createSupportedClient", async () => {
  const reports = (ids: number[]) => ids.map((reportId) => ({ reportId, items: [{ reportSize: 8, reportCount: 64 }] }));
  const shapes = [
    (p?: number, u?: number) => [{ usagePage: p ?? 0xff00, usage: u ?? 1, type: 1, children: [], inputReports: [], outputReports: [], featureReports: [] }],
    (p?: number, u?: number) => [{ usagePage: p ?? 0xff00, usage: u ?? 1, type: 1, children: [], inputReports: reports([0]), outputReports: reports([0]), featureReports: reports([0]) }],
    (p?: number, u?: number) => [{ usagePage: p ?? 0xff02, usage: u ?? 2, type: 1, children: [], inputReports: reports([8]), outputReports: reports([8]), featureReports: [] }],
    (p?: number, u?: number) => [{ usagePage: p ?? 0xffff, usage: u ?? 1, type: 1, children: [], inputReports: reports([1, 4]), outputReports: reports([1, 4]), featureReports: reports([0, 4, 6, 9]) }],
  ];
  let checked = 0;
  let claimed = 0;
  for (const f of SUPPORTED_HID_FILTERS) {
    for (const shape of shapes) {
      const dev = { vendorId: f.vendorId, productId: f.productId ?? 0x1234, productName: "Mouse", opened: false, collections: shape(f.usagePage, f.usage), addEventListener() {}, removeEventListener() {} } as unknown as HIDDevice;
      let want: string | null = null;
      try {
        const c = createSupportedClient(dev);
        want = c ? (c as object).constructor.name : null;
      } catch {
        continue;
      }
      const got = await findDriver(dev);
      let gotName: string | null = null;
      if (got) gotName = (got.create() as object).constructor.name;
      assert.equal(gotName, want, `${f.vendorId.toString(16)}:${(f.productId ?? 0).toString(16)}`);
      checked++;
      if (want) claimed++;
    }
  }
  console.log(`  ${checked} synthetic devices, ${claimed} claimed, same driver every time`);
  assert.ok(claimed > 200);
});

test("claimMice keeps mice, drops non-mice; connectGeneric opens through the wrapper", async () => {
  const f = fakeClient();
  const devs = [
    { vendorId: 0x3710, productId: 0x0001, productName: "X2 Dongle" },
    { vendorId: 0x31e3, productId: 0x1100, productName: "Wooting 60HE+" },
  ] as unknown as HIDDevice[];
  const host = {
    live: false,
    store: memoryStore(),
    devices: async () => devs,
    match: async (d: HIDDevice) => (d.vendorId === 0x3710 ? match(f.client) : { brand: "Wooting", cls: "WootingHidClient", create: () => ({}) }),
  };
  const claimed = await claimMice(host, ["3710:0001", "31e3:1100"]);
  assert.deepEqual([...claimed.keys()], ["3710:0001"]);
  assert.equal(claimed.get("3710:0001")?.name, "Pulsar X2 Dongle");
  assert.ok(!f.calls.length, "claiming reads nothing from the mouse");
  const safe = await connectGeneric(host, "3710:0001");
  assert.ok(safe);
  assert.equal(await connectGeneric(host, "31e3:1100"), null);
});

// ---------------------------------------------------------------------------------------------
// Razer mice that the bridge reaches on their mouse / consumer collection (feature reports only)
// ---------------------------------------------------------------------------------------------

test("the Razer feature-only ids come from the real drivers and match the Rust table", async () => {
  const { readFileSync } = await import("node:fs");
  const { RAZER_PRODUCTS } = await import("@openmouse/protocol/razer-devices");
  const { razerFeatureOnlyPids, razerListedPids, razerClaims, FEATURE_ONLY_COLLECTIONS, RAZER_VENDOR } = await import("./razer-feature-only.mjs");
  const derived: number[] = razerFeatureOnlyPids();

  // 1. The generated Rust table (src-tauri/src/openmouse_ids.rs) is this exact list.
  const rs = readFileSync(new URL("../src-tauri/src/openmouse_ids.rs", import.meta.url), "utf8");
  const table = rs.match(/RAZER_FEATURE_ONLY_PIDS: \[u16; (\d+)\] = \[([^\]]*)\]/);
  assert.ok(table, "openmouse_ids.rs has RAZER_FEATURE_ONLY_PIDS (run node scripts/gen-openmouse-index.mjs)");
  const inRust = table[2].split(",").map((s) => parseInt(s.trim(), 16));
  assert.equal(Number(table[1]), inRust.length);
  assert.deepEqual(inRust, derived, "the Rust table is stale: run node scripts/gen-openmouse-index.mjs");

  // 2. Every id: a real Razer driver claims a lone mouse or consumer collection for it, it is a product
  // OpenMouse lists, and its entry in OpenMouse's product table names neither a vendor-defined control interface nor native-only.
  const listed = new Set<number>(razerListedPids());
  assert.ok(derived.length > 40 && derived.length < listed.size);
  for (const pid of derived) {
    assert.ok(listed.has(pid), `0x${pid.toString(16)} is in OpenMouse's filters`);
    assert.ok(FEATURE_ONLY_COLLECTIONS.some(([page, usage]: number[]) => razerClaims(pid, page, usage)), `0x${pid.toString(16)} is claimed by a Razer driver`);
    const profile = RAZER_PRODUCTS.get(pid);
    assert.notEqual(profile?.vendorControlInterface, true, `0x${pid.toString(16)} has a vendor control interface`);
    assert.notEqual(profile?.nativeOnly, true);
  }

  // 3. Every other listed Razer id is left alone, and says why: a vendor-defined control interface,
  // or no Razer driver claims it on those collections.
  for (const pid of listed) {
    if (derived.includes(pid)) continue;
    const claimed = FEATURE_ONLY_COLLECTIONS.some(([page, usage]: number[]) => razerClaims(pid, page, usage));
    assert.ok(!claimed || RAZER_PRODUCTS.get(pid)?.vendorControlInterface === true, `0x${pid.toString(16)} should be in the set`);
  }

  // Named ones (the mice the panel is for).
  for (const [pid, name] of [[0x0078, "Viper"], [0x008a, "Viper Mini"], [0x00a3, "Cobra"], [0x00c1, "Viper V3 Pro"], [0x00b7, "DeathAdder V3 Pro"], [0x00c5, "DeathAdder V3 HyperSpeed"], [0x00e5, "Viper V4 Pro"]] as const) {
    assert.ok(derived.includes(pid), name);
  }
  assert.equal(RAZER_VENDOR, 0x1532);
  console.log(`  ${derived.length} of ${listed.size} Razer ids get feature-only access to their mouse / consumer collection`);
});

test("every allowed method of the Razer drivers uses feature reports only, and never the device-mode command", async () => {
  const { razerFeatureOnlyPids } = await import("./razer-feature-only.mjs");
  const { razerChecksum, RAZER_PACKET_LENGTH } = await import("@openmouse/protocol/razer");
  // The drivers wait on window.setTimeout between exchanges; run those at once.
  (globalThis as { window?: unknown }).window = { setTimeout: (f: () => void) => setImmediate(f), clearTimeout: () => {} };

  const feature = [{ reportId: 0, items: [{ reportSize: 8, reportCount: RAZER_PACKET_LENGTH }] }];
  const mouse = { usagePage: 0x01, usage: 0x02, type: 1, children: [], inputReports: [], outputReports: [], featureReports: feature };
  const lighting = (zone: string) => ({ zone, modes: [], mode: "Static", color: "#00ff66", color2: "#ff0066", colorModes: [], dualColorModes: [], reactiveModes: [], speeds: [], speed: 1, writeOnly: true });
  const calls: Record<string, unknown[][]> = {
    setDpi: [[800], [1600, 1200]],
    setDpiStageValue: [[0, 800]],
    setActiveDpiStage: [[1]],
    setDpiStageCount: [[3]],
    setPollingRate: [[125], [1000], [8000]],
    setLiftOffDistance: [["Low"], ["High"]],
    setSleepTimeout: [[60], [900]],
    setLighting: [[lighting("Logo")], [lighting("Mouse")], [lighting("Scroll wheel")]],
  };
  let outputs = 0;
  const pairs = new Set<string>();
  let frames = 0;
  let drivers = 0;
  for (const pid of razerFeatureOnlyPids() as number[]) {
    let last: Uint8Array = new Uint8Array(RAZER_PACKET_LENGTH);
    const dev = {
      vendorId: 0x1532,
      productId: pid,
      productName: "Razer",
      opened: true,
      collections: [mouse],
      async open() {},
      async close() {},
      async sendReport() {
        outputs++;
      },
      async sendFeatureReport(_id: number, data: BufferSource) {
        last = new Uint8Array(data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer.slice((data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteOffset + (data as ArrayBufferView).byteLength));
        assert.equal(last.length, RAZER_PACKET_LENGTH, "Razer reports are 90 bytes");
        frames++;
        const [cls, id] = [last[6], last[7]];
        pairs.add(`${cls.toString(16).padStart(2, "0")}/${id.toString(16).padStart(2, "0")}`);
        assert.ok(!(cls === 0x00 && (id === 0x04 || id === 0x84)), `pid ${pid.toString(16)} sent the device-mode command`);
      },
      async receiveFeatureReport() {
        const reply = new Uint8Array(last);
        reply[0] = 0x02; // ok
        reply[88] = razerChecksum(reply);
        return new DataView(reply.buffer);
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HIDDevice;
    const entry = DEVICE_DRIVERS.find((d) => d.brand === "Razer" && d.supports(dev));
    assert.ok(entry, `a Razer driver claims 0x${pid.toString(16)}`);
    const client = entry.create(dev) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    drivers++;
    for (const method of [...READ_METHODS, ...SETTING_METHODS]) {
      if (!isAllowed(method) || typeof client[method] !== "function") continue;
      for (const args of calls[method] ?? [[]]) {
        try {
          await client[method](...args);
        } catch {
          // Zero-filled replies fail the drivers' own read-back checks; what they sent first is what counts.
        }
      }
    }
  }
  assert.equal(outputs, 0, "no Razer driver writes an output report");
  assert.ok(frames > 200, `${frames} feature reports observed`);
  assert.ok(pairs.has("00/81"), "the firmware read was seen");
  console.log(`  ${drivers} Razer ids, ${frames} feature reports, command class/id pairs seen: ${[...pairs].sort().join(" ")}`);
});

// ---------------------------------------------------------------------------------------------
// Which mouse the Mouse page shows first: the quick read-only check, and the rules around it
// ---------------------------------------------------------------------------------------------

test("answering mice go first, unchecked ones next, silent ones last; the page opens on the one that answers", async () => {
  const { orderFamilies, chooseShown } = await import("../src/lib/mouse-order.ts");
  const answers = (o: Record<string, "answers" | "quiet">) => new Map(Object.entries(o));
  const present = ["logitech", "atk", "om:1532:00c1", "om:3710:5406"];

  // The reported case: the receiver of a switched-off DEX is plugged in, the X1 is on.
  const a1 = answers({ logitech: "quiet", atk: "answers", "om:1532:00c1": "answers", "om:3710:5406": "quiet" });
  const o1 = orderFamilies(present, a1);
  assert.deepEqual(o1, ["atk", "om:1532:00c1", "logitech", "om:3710:5406"]);
  assert.equal(chooseShown(o1, a1, null), "atk");
  // A fresh install with nothing picked and the screen showing the old default (Logitech) still moves off it.
  assert.equal(chooseShown(o1, a1, null, "logitech"), "atk");
  // The last pick by hand is kept only if it answers.
  assert.equal(chooseShown(o1, a1, "om:1532:00c1", "atk"), "om:1532:00c1");
  assert.equal(chooseShown(o1, a1, "logitech", "atk"), "atk");
  assert.equal(chooseShown(o1, a1, "gone", null), "atk");
  // Both answer: the one on screen stays, else the default order (hand-built panels first).
  const a2 = answers({ logitech: "answers", atk: "answers" });
  const o2 = orderFamilies(["logitech", "atk"], a2);
  assert.deepEqual(o2, ["logitech", "atk"]);
  assert.equal(chooseShown(o2, a2, null, "atk"), "atk");
  assert.equal(chooseShown(o2, a2, null, null), "logitech");
  // Not checked yet sorts between answering and silent; nothing answers: pick, then what was on screen, then the first.
  assert.deepEqual(orderFamilies(["a", "b", "c"], answers({ a: "quiet", c: "answers" })), ["c", "b", "a"]);
  const none = answers({ logitech: "quiet", atk: "quiet" });
  assert.equal(chooseShown(["logitech", "atk"], none, "atk", "logitech"), "atk");
  assert.equal(chooseShown(["logitech", "atk"], none, null, "atk"), "atk");
  assert.equal(chooseShown(["logitech", "atk"], none, null, null), "logitech");
});

test("the page decides as soon as the answers so far settle it, never differently from waiting for all of them", async () => {
  const { decideEarly, chooseShown, orderFamilies } = await import("../src/lib/mouse-order.ts");
  type A = "answers" | "quiet";
  const states: (A | undefined)[] = ["answers", "quiet", undefined];
  const names = ["logitech", "atk", "om:1532:00c1", "om:3710:5406"];
  let early = 0;
  let checked = 0;
  for (const n of [1, 2, 3, 4]) {
    const present = names.slice(0, n);
    const picks: (string | null)[] = [null, ...present, "gone"];
    for (let code = 0; code < 3 ** n; code++) {
      const partial = new Map<string, A>();
      const unknown: string[] = [];
      present.forEach((f, i) => {
        const st = states[Math.floor(code / 3 ** i) % 3];
        if (st) partial.set(f, st);
        else unknown.push(f);
      });
      for (const explicit of picks) {
        for (const current of picks) {
          const d = decideEarly(present, partial, explicit, current);
          if (!unknown.length) assert.ok(d, "with every mouse heard from there is always an answer");
          if (!d) continue;
          early++;
          // Whatever the mice not heard from turn out to say, waiting for them would have picked the same one.
          for (let fill = 0; fill < 2 ** unknown.length; fill++) {
            const full = new Map(partial);
            unknown.forEach((f, i) => full.set(f, fill & (1 << i) ? "answers" : "quiet"));
            assert.equal(chooseShown(orderFamilies(present, full), full, explicit, current), d, `${[...partial]} ${explicit} ${current}`);
            checked++;
          }
        }
      }
    }
  }
  assert.ok(early > 500 && checked > 1000);
  // The reported case, from the second visit on: the X1 was on screen, answers at once, the receiver is still silent.
  assert.equal(decideEarly(["logitech", "atk"], new Map([["atk", "answers"]]), null, "atk"), "atk");
  // The very first visit has to wait for the Logitech: it would come first if it answered.
  assert.equal(decideEarly(["logitech", "atk"], new Map([["atk", "answers"]]), null, null), null);
  assert.equal(decideEarly(["logitech", "atk"], new Map([["atk", "answers"], ["logitech", "quiet"]]), null, null), "atk");
  console.log(`  ${early} early decisions, ${checked} completions, none differs from waiting`);
});

test("the checks run at once, each with its own limit, and a failure is just a mouse that did not answer", async () => {
  const { runProbes } = await import("../src/lib/mouse-order.ts");
  const started: Record<string, number> = {};
  const t0 = Date.now();
  const result = await runProbes(
    ["fast", "silent", "boom", "no"],
    async (f) => {
      started[f] = Date.now() - t0;
      if (f === "fast") return new Promise((r) => setTimeout(() => r(true), 20));
      if (f === "silent") return new Promise<boolean>(() => {}); // never answers
      if (f === "boom") throw new Error("the driver blew up");
      return false;
    },
    120,
  );
  const took = Date.now() - t0;
  assert.deepEqual(Object.fromEntries(result), { fast: "answers", silent: "quiet", boom: "quiet", no: "quiet" });
  assert.ok(took >= 110 && took < 400, `one limit for all of them, not one after another (${took} ms)`);
  // Each answer is passed on as it comes in: the quick one does not wait for the silent one's limit.
  const heard: [string, string, number][] = [];
  const t2 = Date.now();
  await runProbes(["quick", "mute"], (f) => (f === "quick" ? Promise.resolve(true) : new Promise<boolean>(() => {})), 100, (f, a) => heard.push([f, a, Date.now() - t2]));
  assert.deepEqual(heard.map(([f, a]) => `${f}:${a}`), ["quick:answers", "mute:quiet"]);
  assert.ok(heard[0][2] < 50 && heard[1][2] >= 90, `quick at ${heard[0][2]} ms, silent at ${heard[1][2]} ms`);
  assert.ok(Object.values(started).every((t) => t < 30), "every check started at once");
});

test("the sidebar names the mouse that answers instead of counting mice", async () => {
  const { mouseHint } = await import("../src/lib/mouse-hint.ts");
  const { mouseFamilies } = await import("../src/lib/mouse-family.ts");
  const devices = [
    { kind: "mouse", name: "Logitech mouse", connection: "LIGHTSPEED receiver", vid: "046d", pid: "c54d", reported: null },
    { kind: "mouse", name: "ATK X1 V2 Air+", connection: "8K receiver", vid: "373b", pid: "1278", reported: null },
    { kind: "keyboard", name: "ROG Falchion Ace HFX ZywOo", connection: "USB", vid: "0b05", pid: "1d1d", reported: null },
  ] as const;
  const d = [...devices] as unknown as Parameters<typeof mouseHint>[0];
  assert.deepEqual(mouseFamilies(d), ["logitech", "atk"]);
  const names = new Map([["logitech", "PRO X 2 DEX"]]);
  const a = (o: Record<string, "answers" | "quiet">) => new Map(Object.entries(o));
  assert.equal(mouseHint(d, names), "2 mice", "nothing checked yet");
  assert.equal(mouseHint(d, names, a({ logitech: "quiet", atk: "answers" })), "X1 V2 Air+");
  assert.equal(mouseHint(d, names, a({ logitech: "answers", atk: "quiet" })), "PRO X 2 DEX");
  assert.equal(mouseHint(d, names, a({ logitech: "answers", atk: "answers" })), "2 mice", "both are on");
  assert.equal(mouseHint(d, names, a({ logitech: "quiet", atk: "quiet" })), "2 mice");
  assert.equal(mouseHint(d, names, a({ atk: "answers" })), "2 mice", "one is not checked yet");
  assert.equal(mouseHint([d[1]], names, a({ atk: "quiet" })), "X1 V2 Air+", "a lone mouse is always named");
});

// A HID device that answers like a receiver or a mouse, and writes down every report sent to it.
function fakeHid(opts: { vendorId: number; productId: number; collections: { usagePage: number; usage: number }[]; opened?: boolean; reply: (reportId: number, data: Uint8Array) => { reportId: number; data: number[] } | null }) {
  const sent: { reportId: number; data: number[] }[] = [];
  const listeners = new Set<(e: HIDInputReportEvent) => void>();
  let opens = 0;
  let closes = 0;
  const dev = {
    vendorId: opts.vendorId,
    productId: opts.productId,
    productName: "fake",
    opened: opts.opened ?? false,
    collections: opts.collections.map((c) => ({ ...c, type: 1, children: [], inputReports: [], outputReports: [], featureReports: [] })),
    async open() {
      opens++;
      dev.opened = true;
    },
    async close() {
      closes++;
      dev.opened = false;
    },
    addEventListener(_t: string, fn: (e: HIDInputReportEvent) => void) {
      listeners.add(fn);
    },
    removeEventListener(_t: string, fn: (e: HIDInputReportEvent) => void) {
      listeners.delete(fn);
    },
    async sendReport(reportId: number, data: BufferSource) {
      const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer.slice((data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteOffset + (data as ArrayBufferView).byteLength));
      sent.push({ reportId, data: Array.from(bytes) });
      const r = opts.reply(reportId, bytes);
      if (r) setTimeout(() => listeners.forEach((l) => l({ reportId: r.reportId, data: new DataView(Uint8Array.from(r.data).buffer) } as unknown as HIDInputReportEvent)), 2);
    },
  };
  return { dev: dev as unknown as HIDDevice, sent, listeners, counts: () => ({ opens, closes }) };
}

test("Logitech: a HID++ ping to the receiver slots tells a mouse that is on from one that is off", async () => {
  const { probeLogitechOn, pingFrame, readReply } = await import("../src/lib/logitech-ping.ts");
  const ping = (data: Uint8Array) => data[1] === 0x00 && data[2] === 0x1b;
  const receiver = (reply: (index: number) => number[] | null) =>
    fakeHid({
      vendorId: 0x046d,
      productId: 0xc54d,
      collections: [{ usagePage: 0xff00, usage: 1 }, { usagePage: 0xff00, usage: 2 }],
      reply: (reportId, data) => {
        assert.equal(reportId, 0x10, "short requests on the short collection");
        assert.ok(ping(data) && data.length === 6, "only the root ping goes out");
        const r = reply(data[0]);
        return r && { reportId: 0x10, data: r };
      },
    });

  // DEX on, slot 1: [index, root, ping | id, protocol 4.2, echo]. The other slots say nobody is there.
  const on = receiver((i) => (i === 1 ? [1, 0x00, 0x1b, 4, 2, 0xa5] : [i, 0x8f, 0x00, 0x1b, 0x09, 0]));
  assert.equal(await probeLogitechOn([on.dev], ["c54d"], 800), true);
  assert.deepEqual(on.sent.map((s) => s.data[0]).sort(), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(on.counts(), { opens: 1, closes: 1 }, "opened for the ping, closed again");
  assert.equal(on.listeners.size, 0, "no listener left behind");

  // A receiver that answers every slot of an absent mouse with its HID++ 1.0 error: a quick no. (The LIGHTSPEED
  // receiver on this PC stays silent instead, which the limit below covers.)
  const t0 = Date.now();
  const off = receiver((i) => [i, 0x8f, 0x00, 0x1b, 0x09, 0]);
  assert.equal(await probeLogitechOn([off.dev], ["c54d"], 800), false);
  assert.ok(Date.now() - t0 < 300, "an error from every slot is a quick no, not a wait");
  assert.deepEqual(off.counts(), { opens: 1, closes: 1 });

  // DEX off and the receiver silent: the limit ends it, and the device is still closed.
  const mute = receiver(() => null);
  const t1 = Date.now();
  assert.equal(await probeLogitechOn([mute.dev], ["c54d"], 150), false);
  assert.ok(Date.now() - t1 < 400);
  assert.deepEqual(mute.counts(), { opens: 1, closes: 1 });
  assert.equal(mute.listeners.size, 0);

  // Already open (a panel's session): left open, and its own listeners are not touched.
  const busy = receiver((i) => (i === 1 ? [1, 0x00, 0x1b, 4, 2, 0xa5] : null));
  busy.dev.open = async () => assert.fail("must not reopen");
  (busy.dev as { opened: boolean }).opened = true;
  assert.equal(await probeLogitechOn([busy.dev], ["c54d"], 400), true);
  assert.equal(busy.counts().closes, 0);

  // A mouse on its cable that only has the long collection gets a long ping.
  const cable = fakeHid({
    vendorId: 0x046d,
    productId: 0xc0a0,
    collections: [{ usagePage: 0xff00, usage: 2 }],
    reply: (reportId, data) => {
      assert.equal(reportId, 0x11);
      assert.equal(data.length, 19);
      return data[0] === 0xff ? { reportId: 0x11, data: [0xff, 0x00, 0x1b, 4, 2, 0xa5] } : null;
    },
  });
  assert.equal(await probeLogitechOn([cable.dev], ["c0a0"], 400), true);
  // Other Logitech devices and other vendors' HID++ look-alikes are never touched.
  const keyboard = fakeHid({ vendorId: 0x046d, productId: 0xc548, collections: [{ usagePage: 0xff00, usage: 1 }], reply: () => assert.fail("not a listed mouse") });
  assert.equal(await probeLogitechOn([keyboard.dev], ["c54d"], 100), false);
  assert.equal(keyboard.sent.length, 0);

  // The reply reader.
  assert.deepEqual(readReply(0x10, [1, 0x00, 0x1b, 4, 2]), { index: 1, reply: "pong" });
  assert.deepEqual(readReply(0x11, [1, 0xff, 0x00, 0x1b, 0x02]), { index: 1, reply: "pong" });
  assert.deepEqual(readReply(0x10, [2, 0x8f, 0x00, 0x1b, 0x09]), { index: 2, reply: "absent" });
  assert.equal(readReply(0x10, [1, 0x00, 0x15, 4, 2]), null, "the HID++ driver's own replies (software id 5) are not ours");
  assert.equal(readReply(0x10, [1, 0x05, 0x1b, 4, 2]), null);
  assert.equal(readReply(0x08, [1, 0x00, 0x1b]), null);
  assert.equal(pingFrame(3).length, 6);
});

test("ATK: GetMouseOnline then CID/MID, both reads, through the checked wire", async () => {
  const { probeAtkOn } = await import("../src/lib/atk-wire.ts");
  const P = await import("../src/lib/atk-protocol.ts");
  const { weReportChecksum } = await import("@openmouse/protocol/endgame-gear-we");
  const frame = (cmd: number, data: number[]) => {
    const f = new Array(16).fill(0);
    f[0] = cmd;
    data.forEach((b, i) => (f[5 + i] = b));
    f[15] = weReportChecksum(0x08, f.slice(0, 15));
    return f;
  };
  const receiver = (mouse: "on" | "asleep" | "off") =>
    fakeHid({
      vendorId: 0x373b,
      productId: 0x1278,
      collections: [{ usagePage: 0xff02, usage: 2 }],
      reply: (reportId, data) => {
        assert.equal(reportId, 0x08);
        assert.equal(P.checkFrame(data), null, "every frame passes the checked wire");
        if (data[0] === P.CMD.getMouseOnline) return { reportId: 0x08, data: frame(P.CMD.getMouseOnline, [mouse === "off" ? 0 : 1, 1, 2, 3]) };
        if (data[0] === P.CMD.getCidMid) return mouse === "on" ? { reportId: 0x08, data: frame(P.CMD.getCidMid, [1, 61, 0]) } : null;
        assert.fail(`unexpected command 0x${data[0].toString(16)}`);
      },
    });

  const on = receiver("on");
  assert.equal(await probeAtkOn([on.dev], 1000), true);
  assert.deepEqual(on.sent.map((s) => s.data[0]), [P.CMD.getMouseOnline, P.CMD.getCidMid], "two reads and nothing else");
  assert.deepEqual(on.counts(), { opens: 1, closes: 1 });
  assert.equal(on.listeners.size, 0);

  // The receiver says the mouse is off: no CID/MID is even asked for.
  const off = receiver("off");
  assert.equal(await probeAtkOn([off.dev], 1000), false);
  assert.deepEqual(off.sent.map((s) => s.data[0]), [P.CMD.getMouseOnline]);
  assert.deepEqual(off.counts(), { opens: 1, closes: 1 });

  // Online but asleep: the mouse never answers the CID/MID read, within the limit.
  const t0 = Date.now();
  const asleep = receiver("asleep");
  assert.equal(await probeAtkOn([asleep.dev], 600), false);
  assert.ok(Date.now() - t0 < 900);
  assert.deepEqual(asleep.counts(), { opens: 1, closes: 1 });
  assert.equal(asleep.listeners.size, 0);

  assert.equal(await probeAtkOn([], 100), false, "no ATK device");
  const other = fakeHid({ vendorId: 0x373b, productId: 0x1270, collections: [{ usagePage: 0xff02, usage: 2 }], reply: () => assert.fail("only the X1 is ever asked") });
  assert.equal(await probeAtkOn([other.dev], 100), false);
});

test("a generic mouse is checked with its driver's cheapest read, which only reads", async () => {
  const { SafeMouse } = await import("../src/lib/openmouse/safe-mouse.ts");
  const { CHEAPEST_READ } = await import("../src/lib/openmouse/policy.ts");
  const { pingGeneric } = await import("../src/lib/openmouse/host.ts");
  const { razerChecksum, RAZER_PACKET_LENGTH } = await import("@openmouse/protocol/razer");
  (globalThis as { window?: unknown }).window = { setTimeout: (f: () => void) => setImmediate(f), clearTimeout: () => {} };

  // Every listed method really exists on its driver class, and is not one of the allowlisted writers.
  for (const [cls, method] of Object.entries(CHEAPEST_READ)) {
    const entry = DRIVER_INDEX.find((e) => e.cls === cls);
    assert.ok(entry, cls);
    const impl = await entry.load();
    const client = impl.create({ vendorId: 0, productId: 0, productName: "", opened: false, collections: [] } as unknown as HIDDevice) as object;
    assert.equal(typeof (client as Record<string, unknown>)[method], "function", `${cls}.${method}`);
    assert.ok(!(SETTING_METHODS as readonly string[]).includes(method));
  }

  // A Razer Viper V3 Pro receiver (0x00c1) through the real RazerHidClient: ping = one firmware read.
  const feature = [{ reportId: 0, items: [{ reportSize: 8, reportCount: RAZER_PACKET_LENGTH }] }];
  const razer = (answer: boolean, opened = false) => {
    const sent: Uint8Array[] = [];
    let last = new Uint8Array(RAZER_PACKET_LENGTH);
    const counts = { opens: 0, closes: 0 };
    const dev = {
      vendorId: 0x1532,
      productId: 0x00c1,
      productName: "Razer Viper V3 Pro",
      opened,
      collections: [{ usagePage: 1, usage: 2, type: 1, children: [], inputReports: [], outputReports: [], featureReports: feature }],
      async open() {
        counts.opens++;
        dev.opened = true;
      },
      async close() {
        counts.closes++;
        dev.opened = false;
      },
      async sendReport() {
        assert.fail("a Razer check never writes an output report");
      },
      async sendFeatureReport(_id: number, data: BufferSource) {
        last = new Uint8Array(data as ArrayBuffer);
        sent.push(last);
      },
      async receiveFeatureReport() {
        const reply = new Uint8Array(last);
        reply[0] = answer ? 0x02 : 0x05; // ok / unsupported (nobody home)
        reply[88] = razerChecksum(reply);
        if (!answer) throw new Error("The mouse stayed busy");
        return new DataView(reply.buffer);
      },
      addEventListener() {},
      removeEventListener() {},
    };
    return { dev: dev as unknown as HIDDevice, sent, counts };
  };
  const entry = DRIVER_INDEX.find((e) => e.cls === "RazerHidClient")!;
  const impl = await entry.load();
  const host = (dev: HIDDevice) => ({ live: false, store: memoryStore(), devices: async () => [dev], match: async () => ({ brand: "Razer", cls: "RazerHidClient", create: () => impl.create(dev) }) });

  const on = razer(true);
  assert.equal(await pingGeneric(host(on.dev), "1532:00c1"), true);
  assert.equal(on.sent.length, 1, "one report");
  assert.deepEqual([on.sent[0][6], on.sent[0][7]], [0x00, 0x81], "the firmware-version read, class 0x00 id 0x81");
  assert.deepEqual(on.counts, { opens: 1, closes: 1 });

  const off = razer(false);
  assert.equal(await pingGeneric(host(off.dev), "1532:00c1"), false);
  assert.deepEqual(off.counts, { opens: 1, closes: 1 });
  assert.ok(off.sent.every((f) => f[6] === 0x00 && f[7] === 0x81), "only ever the firmware read");

  const held = razer(true, true);
  assert.equal(await pingGeneric(host(held.dev), "1532:00c1"), true);
  assert.deepEqual(held.counts, { opens: 0, closes: 0 }, "a device a panel holds open is left open");

  // Any other driver is asked for its status; nothing else on it is called.
  const f = fakeClient();
  const pinged = await SafeMouse.ping({ vendorId: 0x3710, productId: 0x1234, productName: "Test", opened: false }, match(f.client));
  assert.equal(pinged, true);
  assert.ok(f.calls.every((c) => c === "open" || c === "readStatus" || c === "close"), `only open / readStatus / close ran: ${f.calls.join(", ")}`);
  assert.ok(f.calls.includes("readStatus"));
  assert.equal(await pingGeneric(host(on.dev), "9999:0000"), false, "an id nobody lists");
});
