// A KbDriver + KbBackend (src/lib/kb/types.ts) for Logitech G keyboards over HID++ 2.0. Read-only tier:
// SYNQ shows what the keyboard reports and only writes a handful of reversible settings once the
// person turns on "Allow changes" in the generic panel. Every outgoing report is classified by
// LogitechKbGuard first; a blocked frame throws and never reaches sendReport.
//
// This never resurrects any firmware/DFU/reset/pairing/host-switch/profile-memory path: those feature
// ids are in BLOCKED_FEATURES and their indices are never put in the guard's map.

import type {
  BlockedCommand,
  HidLike,
  InfoState,
  KbBackend,
  KbChange,
  KbContext,
  KbDriver,
  KbPlan,
  KbState,
  KbSupport,
} from "../../kb/types.ts";
import { LOGITECH_ANALOG_KEYBOARDS, logitechKeyboard } from "./devices.ts";
import { LogitechKbGuard, BLOCKED_FEATURES } from "./guard.ts";
import * as P from "./protocol.ts";

const DRIVER = "logitech-kb";

/** Map the guard's BlockReason to the kb panel's narrower BlockedCommand.why. */
const KB_WHY: Readonly<Record<string, BlockedCommand["why"]>> = {
  firmware: "firmware",
  bootloader: "bootloader",
  "factory-reset": "factory-reset",
  calibration: "calibration",
  pairing: "pairing",
  identity: "identity",
  "device-mode": "unverified",
  "profile-wipe": "macro",
  shape: "unverified",
  unknown: "unverified",
};

export const LOGITECH_KB_BLOCKED: readonly BlockedCommand[] = [...BLOCKED_FEATURES.values()].map((b) => ({ what: b.what, why: KB_WHY[b.why] ?? "unverified" }));

// ---------------------------------------------------------------------------------------------
// Minimal HID++ request/answer over a HidLike
// ---------------------------------------------------------------------------------------------

class Hidpp {
  readonly #dev: HidLike;
  readonly #guard: LogitechKbGuard;
  #waiter: { frame: P.HidppFrame; resolve: (r: Uint8Array) => void; reject: (e: Error) => void } | null = null;
  readonly #onInput = (e: HIDInputReportEvent) => this.#input(e);
  #attached = false;
  constructor(dev: HidLike, guard: LogitechKbGuard) {
    this.#dev = dev;
    this.#guard = guard;
  }
  get device(): HidLike {
    return this.#dev;
  }
  async open(): Promise<void> {
    await this.#dev.open();
    if (!this.#attached) {
      this.#dev.addEventListener("inputreport", this.#onInput);
      this.#attached = true;
    }
  }
  async close(): Promise<void> {
    if (this.#attached) {
      this.#dev.removeEventListener("inputreport", this.#onInput);
      this.#attached = false;
    }
    this.#waiter?.reject(new Error("closed"));
    this.#waiter = null;
    await this.#dev.close();
  }
  #input(e: HIDInputReportEvent): void {
    const w = this.#waiter;
    if (!w) return;
    const r = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    if (e.reportId !== w.frame.reportId) return;
    const err = P.parseError(r);
    if (err && err.featureIndex === w.frame.data[1]) {
      this.#waiter = null;
      w.reject(new Error(`device refused feature 0x${err.featureIndex.toString(16)} fn 0x${err.fn.toString(16)} (code ${err.code})`));
      return;
    }
    if (P.isAnswer(w.frame, r)) {
      this.#waiter = null;
      w.resolve(r.slice());
    }
  }
  /** Classify, send, await the answer. A blocked frame throws before any report is sent. */
  request(frame: P.HidppFrame, timeoutMs = 600): Promise<Uint8Array> {
    const v = this.#guard.classify({ type: "output", reportId: frame.reportId, data: frame.data });
    if (v.verdict === "blocked") return Promise.reject(new Error(`SYNQ refused ${v.name}: ${v.reason}`));
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#waiter?.frame === frame) this.#waiter = null;
        reject(new Error(`no answer to ${v.name} in ${timeoutMs} ms`));
      }, timeoutMs);
      this.#waiter = { frame, resolve: (r) => (clearTimeout(timer), resolve(r)), reject: (e) => (clearTimeout(timer), reject(e)) };
      this.#dev.sendReport(frame.reportId, new Uint8Array(frame.data)).catch((e: unknown) => {
        this.#waiter = null;
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }
  /** The guard verdict for a frame without sending it (used by plans / tests). */
  check(frame: P.HidppFrame) {
    return this.#guard.classify({ type: "output", reportId: frame.reportId, data: frame.data });
  }
}

// ---------------------------------------------------------------------------------------------
// Feature resolution
// ---------------------------------------------------------------------------------------------

/** Resolve the safe + analog feature ids this keyboard has into an index map, via IRoot.GetFeature. */
async function resolveFeatures(dev: HidLike, deviceIndex: number): Promise<Map<number, number>> {
  const ids = [P.FEATURE.featureSet, P.FEATURE.firmwareInfo, P.FEATURE.deviceName, P.FEATURE.reportRate, P.FEATURE.reportRateExt, P.FEATURE.brightness, P.FEATURE.rgbEffects, P.FEATURE.perKeyLightingV2, P.FEATURE.perKeyLighting, P.FEATURE.onboardProfiles, P.FEATURE.analogKeys];
  // The guard needs a map before we can send even GetFeature-targeted frames, but GetFeature goes to
  // IRoot (index 0) which is always allowed, so a temporary empty-map session is enough to resolve.
  const probe = new Hidpp(dev, new LogitechKbGuard(new Map()));
  await probe.open();
  const map = new Map<number, number>();
  try {
    for (const id of ids) {
      try {
        const reply = await probe.request(P.getFeature(deviceIndex, id));
        const { index } = P.parseGetFeature(reply);
        if (index !== 0) map.set(index, id);
      } catch {
        /* feature absent on this keyboard */
      }
    }
  } finally {
    // keep the device open; the backend reuses it
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

class LogitechKbBackend implements KbBackend {
  readonly driver = DRIVER;
  readonly support: KbSupport = { tier: "read-only", why: "Learned from G HUB depots + Solaar, never tested on hardware by SYNQ." };
  readonly blocked = LOGITECH_KB_BLOCKED;
  #state: KbState;
  readonly #hidpp: Hidpp;
  readonly #deviceIndex: number;
  readonly #map: ReadonlyMap<number, number>;
  readonly #model: string;
  readonly #connection: string;
  #brightnessMax = 0xffff;

  constructor(hidpp: Hidpp, map: ReadonlyMap<number, number>, deviceIndex: number, model: string, connection: string) {
    this.#hidpp = hidpp;
    this.#map = map;
    this.#deviceIndex = deviceIndex;
    this.#model = model;
    this.#connection = connection;
    this.#state = { info: this.#info([]), notes: [] };
  }
  get state(): KbState {
    return this.#state;
  }
  #idx(featureId: number): number | undefined {
    for (const [index, id] of this.#map) if (id === featureId) return index;
    return undefined;
  }
  #info(firmware: string[], serial?: string | null): InfoState {
    return { brand: "Logitech G", model: this.#model, driver: DRIVER, protocol: "HID++ 2.0", firmware, serial: serial ?? null, connection: this.#connection };
  }

  async load(): Promise<KbState> {
    const notes: string[] = [];
    const firmware: string[] = [];
    const d = this.#deviceIndex;

    const fwIdx = this.#idx(P.FEATURE.firmwareInfo);
    if (fwIdx !== undefined) {
      try {
        const info = await this.#hidpp.request(P.fwGetInfo(d, fwIdx));
        const count = info[3] ?? 0;
        for (let e = 0; e < Math.min(count, 8); e++) {
          const r = await this.#hidpp.request(P.fwGetEntry(d, fwIdx, e));
          const type = r[3] & 0x0f;
          if (type === 0 || type === 1) firmware.push(`${String.fromCharCode(r[4], r[5], r[6])}${r[7].toString(16)} v${r[8]}.${r[9]}.${P.u16be(r, 10)}`);
        }
      } catch {
        notes.push("Firmware version could not be read.");
      }
    }

    const state: KbState = { info: this.#info(firmware), notes };

    // Polling (report rate)
    const rateExt = this.#idx(P.FEATURE.reportRateExt);
    const rate = this.#idx(P.FEATURE.reportRate);
    if (rateExt !== undefined) {
      try {
        const list = await this.#hidpp.request(P.rateExtGetList(d, rateExt));
        const flags = P.u16be(list, 3);
        const labelHz = [125, 250, 500, 1000, 2000, 4000, 8000];
        const options = labelHz.filter((_, i) => flags & (1 << i));
        const cur = await this.#hidpp.request(P.rateExtGet(d, rateExt));
        // current rate code read; state.polling.hz holds the human value
        state.polling = { hz: labelHz[cur[3]] ?? null, options, writable: options.length > 0, note: "Extended report rate (0x8061)." };
      } catch {
        /* ignore */
      }
    } else if (rate !== undefined) {
      try {
        const list = await this.#hidpp.request(P.rateGetList(d, rate));
        const flags = list[3];
        const options = [1, 2, 3, 4, 5, 6, 7, 8].filter((i) => flags & (1 << (i - 1))).map((ms) => Math.round(1000 / ms));
        const cur = await this.#hidpp.request(P.rateGet(d, rate));
        // current rate code read; state.polling.hz holds the human value
        state.polling = { hz: cur[3] ? Math.round(1000 / cur[3]) : null, options, writable: options.length > 0, note: "Report rate (0x8060), in ms internally." };
      } catch {
        /* ignore */
      }
    }

    // Brightness, exposed as a 0..100% option
    const brIdx = this.#idx(P.FEATURE.brightness);
    if (brIdx !== undefined) {
      try {
        const info = await this.#hidpp.request(P.brightnessGetInfo(d, brIdx));
        const max = P.u16be(info, 3) || 100;
        this.#brightnessMax = max;
        const cur = await this.#hidpp.request(P.brightnessGet(d, brIdx));
        const pct = Math.round((P.u16be(cur, 3) / max) * 100);
        state.options = [{ id: "brightness", label: "Brightness", kind: "range", spec: { min: 0, max: 100, step: 1, unit: "%" }, value: pct, writable: true }];
      } catch {
        /* ignore */
      }
    }

    // Lighting presence
    if (this.#idx(P.FEATURE.rgbEffects) !== undefined || this.#idx(P.FEATURE.perKeyLightingV2) !== undefined) {
      state.lighting = { groups: [], source: "device", note: "RGB lighting is present (0x8071 / 0x8081). SYNQ reads it but does not yet build effect frames." };
    }

    // Analog keys (RAPID boards)
    const anIdx = this.#idx(P.FEATURE.analogKeys);
    if (anIdx !== undefined) {
      let rapid: boolean | null = null;
      try {
        const r = await this.#hidpp.request(P.analogGetRapidTrigger(d, anIdx));
        rapid = (r[3] & 0x01) === 0x01;
      } catch {
        notes.push("Rapid trigger state could not be read.");
      }
      const analogModel = LOGITECH_ANALOG_KEYBOARDS.find((m) => this.#model.toUpperCase().includes(m.model.toUpperCase().split(" ")[0]));
      const maxMm = analogModel && analogModel.model.includes("G515") ? 2.5 : 4.0;
      state.analog = {
        scope: "both",
        travelMm: maxMm,
        fields: {
          actuationMm: { min: 0.1, max: maxMm, step: 0.1, unit: "mm", decimals: 1 },
          rapidTrigger: "toggle",
          rtPressMm: { min: 0.1, max: 2.0, step: 0.1, unit: "mm", decimals: 1 },
          rtReleaseMm: { min: 0.1, max: 2.0, step: 0.1, unit: "mm", decimals: 1 },
        },
        writable: ["rapidTrigger"],
        global: { rapidTrigger: rapid, actuationMm: null, rtPressMm: null, rtReleaseMm: null },
        perKey: {},
        source: rapid === null ? "unknown" : "device",
        note: "Actuation and per-key rapid-trigger depths need a real device to read back (feature 0x1B08 reply layout is unconfirmed).",
      };
      notes.push("Analog actuation ranges are from the G HUB UI; exact per-key read-back needs a device.");
    }

    this.#state = state;
    return state;
  }

  plan(change: KbChange): KbPlan {
    const d = this.#deviceIndex;
    if (change.kind === "polling") {
      const rateExt = this.#idx(P.FEATURE.reportRateExt);
      const rate = this.#idx(P.FEATURE.reportRate);
      if (rateExt !== undefined) {
        const code = [125, 250, 500, 1000, 2000, 4000, 8000].indexOf(change.hz);
        if (code < 0) throw new Error(`${change.hz} Hz is not an option for this keyboard.`);
        const frame = P.rateExtSet(d, rateExt, code);
        return this.#writePlan(`Report rate ${change.hz} Hz`, change.hz, frame, async () => {
          const cur = await this.#hidpp.request(P.rateExtGet(d, rateExt));
          return [125, 250, 500, 1000, 2000, 4000, 8000][cur[3]] ?? null;
        }, "saved");
      }
      if (rate !== undefined) {
        const ms = Math.round(1000 / change.hz);
        const frame = P.rateSet(d, rate, ms);
        return this.#writePlan(`Report rate ${change.hz} Hz`, change.hz, frame, async () => {
          const cur = await this.#hidpp.request(P.rateGet(d, rate));
          return cur[3] ? Math.round(1000 / cur[3]) : null;
        }, "saved");
      }
      throw new Error("This keyboard has no adjustable report rate.");
    }
    if (change.kind === "option" && change.id === "brightness") {
      const brIdx = this.#idx(P.FEATURE.brightness);
      if (brIdx === undefined) throw new Error("This keyboard has no brightness control.");
      const value = Math.max(0, Math.min(100, change.value));
      const frame = P.brightnessSet(d, brIdx, Math.round((value / 100) * this.#brightnessMax));
      return this.#writePlan(`Brightness ${value}%`, value, frame, async () => {
        const info = await this.#hidpp.request(P.brightnessGetInfo(d, brIdx));
        const max = P.u16be(info, 3) || 100;
        const cur = await this.#hidpp.request(P.brightnessGet(d, brIdx));
        return Math.round((P.u16be(cur, 3) / max) * 100);
      }, "saved");
    }
    if (change.kind === "analog" && change.target === "global" && typeof change.values.rapidTrigger === "boolean") {
      const anIdx = this.#idx(P.FEATURE.analogKeys);
      if (anIdx === undefined) throw new Error("This keyboard has no analog keys.");
      const on = change.values.rapidTrigger;
      const frame = P.analogSetRapidTrigger(d, anIdx, on);
      return this.#writePlan(`Rapid trigger ${on ? "on" : "off"}`, { rapidTrigger: on }, frame, async () => {
        const r = await this.#hidpp.request(P.analogGetRapidTrigger(d, anIdx));
        return { rapidTrigger: (r[3] & 0x01) === 0x01 };
      }, "saved");
    }
    throw new Error("SYNQ can't change that on this Logitech keyboard yet.");
  }

  #writePlan(label: string, expected: unknown, frame: P.HidppFrame, readBack: () => Promise<unknown>, persistence: KbPlan["persistence"]): KbPlan {
    const v = this.#hidpp.check(frame);
    if (v.verdict === "blocked") throw new Error(`SYNQ refuses to send ${label}: ${v.reason}`);
    return {
      label,
      expected,
      persistence,
      send: async () => {
        await this.#hidpp.request(frame);
      },
      readBack,
    };
  }

  snapshot(): unknown {
    return { device: this.#model, connection: this.#connection, featureMap: [...this.#map.entries()].map(([i, id]) => [i, `0x${id.toString(16)}`]), state: this.#state };
  }
  async close(): Promise<void> {
    await this.#hidpp.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

const hasHidpp = (device: HidLike): boolean => (device.collections ?? []).some((c) => c.usagePage === P.HIDPP.usagePage);
/** Cabled keyboards answer as device 0xFF; a wireless board through its receiver answers on slot 1. */
const defaultIndex = (connection: string): number => (connection === "receiver" ? 0x01 : 0xff);

export const logitechKbDriver: KbDriver = {
  id: DRIVER,
  name: "Logitech G keyboard (HID++)",
  priority: 40,
  vids: [P.HIDPP.vendorId],
  claims(device: HidLike): boolean {
    return !!logitechKeyboard(device.vendorId, device.productId) && hasHidpp(device);
  },
  async open(device: HidLike, _ctx: KbContext): Promise<KbBackend> {
    const entry = logitechKeyboard(device.vendorId, device.productId);
    if (!entry) throw new Error("Not a known Logitech keyboard.");
    const index = defaultIndex(entry.connection);
    const map = await resolveFeatures(device, index);
    const guard = new LogitechKbGuard(map);
    const hidpp = new Hidpp(device, guard);
    await hidpp.open();
    const backend = new LogitechKbBackend(hidpp, map, index, entry.model, entry.connection);
    await backend.load();
    return backend;
  },
  async ping(device: HidLike): Promise<boolean> {
    const entry = logitechKeyboard(device.vendorId, device.productId);
    if (!entry) return false;
    const probe = new Hidpp(device, new LogitechKbGuard(new Map()));
    try {
      await probe.open();
      await probe.request(P.ping(defaultIndex(entry.connection)), 400);
      return true;
    } catch {
      return false;
    } finally {
      await probe.close().catch(() => undefined);
    }
  },
};
