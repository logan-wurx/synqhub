// SteelSeries Apex keyboards for SYNQ's generic Keyboard panel (src/lib/kb/types.ts KbDriver / KbBackend).
// Not registered anywhere yet: add `steelseriesKbDriver` to the keyboard driver list once the bridge allows the
// 0xFFC0 collection (devices.ts STEELSERIES_BRIDGE).
//
// Tier: nothing here has run on hardware with SYNQ, so every board is "read-only" until the person allows
// changes (KbSession enforces that, takes the backup and judges the read-back). The byte layouts come from
// community USB captures and tools (see protocol.ts); GG's own encrypted device files were not decrypted.
//
// What the keyboards can't do, and how this backend copes:
//   - No live read-back of actuation, rapid trigger or sensitivity on any line. read-backs resolve undefined
//     ("Unconfirmed") and the panel shows SYNQ's own last write ("cache").
//   - Every analog frame carries all 68 keys. A per-key change therefore needs a known value for every other key:
//     SYNQ only allows per-key changes after it has set that field for all keys in this session.
//   - Live settings live in RAM (Gen 3 wired: [rikearon]) or outside the stored profile (2019: [zunuza]); SYNQ
//     never writes the flash profile (BLOCKED in guard.ts).

import type {
  AnalogField,
  AnalogState,
  AnalogValues,
  BlockedCommand,
  HidLike as KbHidLike,
  KbBackend,
  KbChange,
  KbContext,
  KbDriver,
  KbPlan,
  KbState,
  KbSupport,
  KeyIndex,
  LightingSetting,
  LightingValue,
  NumberSpec,
  ProfilesState,
} from "../../kb/types.ts";
import { GuardedChannel, type BlockReason, type FrameLog, type HidLike, type OutgoingReport } from "../local-kb.ts";
import { STEELSERIES_VID, SS_OUTPUT_LENGTH, SS_USAGE_PAGE, channelFor, findModel, isBootloader, isDriven, type SsCapability, type SsModel } from "./devices.ts";
import { BLOCKED, guardFor } from "./guard.ts";
import * as P from "./protocol.ts";

export const DRIVER_ID = "steelseries";

const FAMILY_LABEL: Readonly<Record<P.CommandFamily, string>> = {
  legacy: "Apex 2019 line (fw 4.x)",
  single: "Apex Gen 3 wired line (fw 1.19 / 1.20)",
  "wireless-rx": "Apex wireless line via receiver (fw 3.24)",
  "wireless-usb": "Apex wireless line over USB (fw 3.24)",
};

const WHY: Readonly<Record<BlockReason, BlockedCommand["why"]>> = {
  firmware: "firmware",
  bootloader: "bootloader",
  "device-mode": "bootloader",
  "factory-reset": "factory-reset",
  calibration: "calibration",
  pairing: "pairing",
  "profile-wipe": "factory-reset",
  identity: "identity",
  shape: "unverified",
  unknown: "unverified",
};

/** What SYNQ never sends to a SteelSeries keyboard, for the panel's "never sends" list. */
export const STEELSERIES_BLOCKED: readonly BlockedCommand[] = [
  {
    what: "Firmware update / bootloader: GG keeps those commands in encrypted device files, SYNQ knows none, refuses every unlisted command and never opens a bootloader id (the keyboard's PID + 1, e.g. 1038:1615)",
    why: "firmware",
  },
  ...BLOCKED.map((b) => ({ what: `${b.what} [${b.bytes}]`, why: ["36", "3c", "35"].includes(b.bytes) ? ("keystrokes" as const) : WHY[b.why] })),
];

/** Writes are planned only for capabilities with hardware evidence on this PID or a same-firmware sibling. */
const canWrite = (c: SsCapability | undefined): boolean => !!c && c.evidence !== "inferred";
/** Lighting is lower stakes (volatile, no flash): OpenRGB-only evidence is enough. */
const canLight = (c: SsCapability | undefined): boolean => !!c;

const MM_SPEC: NumberSpec = { min: 0.1, max: 4.0, step: 0.1, unit: "mm", decimals: 1 };
const r1 = (v: number) => Math.round(v * 10) / 10;
const hex4 = (n: number) => n.toString(16).padStart(4, "0");

/** Is this a SteelSeries keyboard's configuration collection SYNQ drives? No I/O: ids and collections only. */
export function claimsSteelSeries(device: { vendorId: number; productId: number; collections?: readonly { usagePage?: number; usage?: number }[] }): boolean {
  if (device.vendorId !== STEELSERIES_VID || isBootloader(device.vendorId, device.productId)) return false;
  const m = findModel(device.productId);
  if (!m || !isDriven(m)) return false;
  const cols = device.collections ?? [];
  return cols.length === 0 || cols.some((c) => c.usagePage === SS_USAGE_PAGE);
}

const asLocal = (d: KbHidLike): HidLike => d as unknown as HidLike;

async function ensureOpen(d: KbHidLike): Promise<void> {
  if (!d.opened) await d.open();
}

// ---------------------------------------------------------------------------------------------
// Link: one guard, two report shapes, one request at a time
// ---------------------------------------------------------------------------------------------

export class SteelSeriesLink {
  readonly model: SsModel;
  readonly out: GuardedChannel;
  readonly feat: GuardedChannel;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(hid: HidLike, model: SsModel, log?: FrameLog) {
    const guard = guardFor(model);
    this.model = model;
    this.out = new GuardedChannel(hid, guard, { ...channelFor(model.family), length: SS_OUTPUT_LENGTH }, log);
    this.feat = new GuardedChannel(hid, guard, channelFor(model.family), log);
  }

  /** Runs `work` after everything queued before it. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(work, work);
    this.#queue = p.catch(() => undefined);
    return p;
  }

  /** Sends one report through the guard (a blocked report throws BlockedFrameError and never reaches the device). */
  async send(r: OutgoingReport): Promise<void> {
    if (r.type === "output") await this.out.output(r.data);
    else await this.feat.feature(r.data);
  }

  /** Sends `r` and resolves with the first input report `isAnswer` accepts. */
  query(r: OutgoingReport, isAnswer: (reply: Uint8Array) => boolean, timeoutMs = 1000): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        fn();
      };
      const off = this.out.onInput((b) => {
        if (isAnswer(b)) finish(() => resolve(b));
      });
      const timer = setTimeout(() => finish(() => reject(new Error(`No answer to ${P.hex(r.data.subarray(0, 2))} within ${timeoutMs} ms.`))), timeoutMs);
      this.send(r).catch((e) => finish(() => reject(e)));
    });
  }

  /** Wireless line: send and wait for `<op> 00`. [opengg] */
  async sendAcked(r: OutgoingReport, timeoutMs = 1500): Promise<void> {
    const op = r.data[0];
    const reply = await this.query(r, (b) => b[0] === op, timeoutMs);
    const status = P.decodeAck(op, reply);
    if (status !== 0) throw new Error(`The keyboard refused ${P.hex([op])} (status ${status}).`);
  }
}

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

interface Readings {
  firmware: string | null;
  ledFirmware: string | null;
  brightness: number | null;
  region: number | null;
  layout: number | null;
  connected: boolean | null;
  battery: { percent: number; charging: boolean } | null;
  problems: string[];
}

/** SYNQ's own last writes this session (the keyboard can't report these). null = never set for every key. */
interface Cache {
  actuation: Map<number, number> | null;
  rapidTrigger: Map<number, boolean> | null;
  sensitivity: Map<number, number> | null;
  lightingMode: 0 | 1 | null;
  color: readonly [number, number] | null;
  profile: number | null;
}

export class SteelSeriesBackend implements KbBackend {
  readonly driver = DRIVER_ID;
  readonly blocked: readonly BlockedCommand[] = STEELSERIES_BLOCKED;
  readonly model: SsModel;
  readonly family: P.CommandFamily;
  readonly link: SteelSeriesLink;
  readonly #device: KbHidLike;
  #readings: Readings = { firmware: null, ledFirmware: null, brightness: null, region: null, layout: null, connected: null, battery: null, problems: [] };
  #cache: Cache = { actuation: null, rapidTrigger: null, sensitivity: null, lightingMode: null, color: null, profile: null };
  #state: KbState | null = null;

  constructor(device: KbHidLike, log?: FrameLog) {
    const model = findModel(device.productId);
    if (device.vendorId !== STEELSERIES_VID || !model || model.family === "other" || !isDriven(model)) throw new Error("Not a SteelSeries keyboard SYNQ drives.");
    this.#device = device;
    this.model = model;
    this.family = model.family;
    this.link = new SteelSeriesLink(asLocal(device), model, log);
  }

  get state(): KbState {
    if (!this.#state) this.#state = this.#build();
    return this.#state;
  }

  get support(): KbSupport {
    const m = this.model;
    const caps = [m.actuation, m.rapidTrigger, m.sensitivity, m.directLighting].filter((c): c is SsCapability => !!c);
    const best = caps.some((c) => c.evidence === "captured") ? "GG's own USB traffic captured on this model" : caps.some((c) => c.evidence === "source-hw") ? "an open-source tool its author ran on this model" : caps.some((c) => c.evidence === "inferred-strong") ? "captures from a sibling with the same firmware" : "open-source code only";
    return { tier: "read-only", why: `${m.model}: commands from ${best}, values from SteelSeries GG's own tables. Not yet tried with SYNQ on a real keyboard.` };
  }

  // -------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------

  async load(): Promise<KbState> {
    const r: Readings = { ...this.#readings, problems: [] };
    const m = this.model;
    const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await this.link.run(fn);
      } catch (e) {
        r.problems.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    };
    if (m.firmwareQuery) {
      r.firmware = await attempt("firmware", async () => P.decodeFirmware(await this.link.query(P.encodeFirmwareRead(0), P.isFirmwareReply)));
    }
    if (m.brightness) {
      r.brightness = await attempt("brightness", async () => P.decodeBrightness(await this.link.query(P.encodeBrightnessRead(), (b) => b[0] === P.OP.brightnessGet)));
    }
    if (m.regionQuery) {
      r.region = await attempt("region", async () => P.decodeQueryByte(P.OP.region, await this.link.query(P.encodeRegionRead(), (b) => b[0] === P.OP.region)));
      r.layout = await attempt("layout", async () => P.decodeQueryByte(P.OP.layout, await this.link.query(P.encodeLayoutRead(), (b) => b[0] === P.OP.layout)));
    }
    if (m.statusQuery && (this.family === "wireless-rx" || this.family === "wireless-usb")) {
      const fam = this.family;
      if (fam === "wireless-rx") {
        const c = await attempt("connection", async () => P.decodeStatusByte(P.OP.rxConnection, await this.link.query(P.encodeStatusRead(fam, "connection"), (b) => b[0] === P.OP.rxConnection)));
        r.connected = c === null ? null : c === 1;
      }
      const op = fam === "wireless-rx" ? P.OP.rxBattery : P.OP.usbBattery;
      const s = await attempt("battery", async () => P.decodeStatusByte(op, await this.link.query(P.encodeStatusRead(fam, "battery"), (b) => b[0] === op)));
      r.battery = s === null ? null : P.batteryFromState(s);
    }
    this.#readings = r;
    this.#state = this.#build();
    return this.#state;
  }

  snapshot(): unknown {
    const map = (x: Map<number, unknown> | null) => (x ? Object.fromEntries(x) : null);
    return {
      format: "onboard-steelseries",
      version: 1,
      model: this.model.ggName,
      productId: hex4(this.model.productId),
      family: this.family,
      readings: this.#readings,
      onboardWrites: {
        actuation: map(this.#cache.actuation),
        rapidTrigger: map(this.#cache.rapidTrigger),
        sensitivity: map(this.#cache.sensitivity),
        lightingMode: this.#cache.lightingMode,
        color: this.#cache.color,
        profile: this.#cache.profile,
      },
      note: "The keyboard can't report its actuation, rapid trigger, sensitivity or active profile; onboardWrites are SYNQ's own writes this session.",
    };
  }

  async close(): Promise<void> {
    if (this.#device.opened) await this.#device.close().catch(() => undefined);
  }

  // -------------------------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------------------------

  #writableAnalog(): AnalogField[] {
    const m = this.model;
    const out: AnalogField[] = [];
    if (canWrite(m.actuation)) out.push("actuationMm");
    if (canWrite(m.rapidTrigger)) out.push("rapidTrigger");
    if (canWrite(m.sensitivity)) out.push("rtPressMm");
    return out;
  }

  #analog(): AnalogState | undefined {
    const m = this.model;
    if (!m.analogKeys || !m.table) return undefined;
    const fields: Partial<Record<AnalogField, NumberSpec | "toggle">> = { actuationMm: MM_SPEC };
    if (m.rapidTrigger) fields.rapidTrigger = "toggle";
    if (m.sensitivity) fields.rtPressMm = { ...MM_SPEC };
    const c = this.#cache;
    const perKey: Record<KeyIndex, AnalogValues> = {};
    for (const k of m.analogKeys) {
      const v: AnalogValues = {};
      if (c.actuation) v.actuationMm = c.actuation.get(k) ?? null;
      if (c.rapidTrigger) v.rapidTrigger = c.rapidTrigger.get(k) ?? null;
      if (c.sensitivity) v.rtPressMm = c.sensitivity.get(k) ?? null;
      if (Object.keys(v).length) perKey[k] = v;
    }
    const uniform = <T>(x: Map<number, T> | null): T | null => {
      if (!x) return null;
      const vals = [...x.values()];
      return vals.every((v) => v === vals[0]) ? vals[0] : null;
    };
    const any = c.actuation || c.rapidTrigger || c.sensitivity;
    const writable = this.#writableAnalog();
    return {
      scope: "both",
      keys: m.analogKeys,
      travelMm: 4.0,
      fields,
      writable,
      global: any ? { actuationMm: uniform(c.actuation), rapidTrigger: uniform(c.rapidTrigger), rtPressMm: uniform(c.sensitivity) } : null,
      perKey,
      source: any ? "cache" : "unknown",
      note: writable.length
        ? "The keyboard can't report these values: shown is what SYNQ last wrote. Set a value for all keys before changing single keys. One sensitivity covers press and release. Lost when the keyboard is unplugged (GG's Save stores them; SYNQ never writes the stored profile)."
        : "Shown for reference (range from GG's table for this model). SYNQ doesn't write these on this model: no capture confirms its commands.",
    };
  }

  #lighting(): KbState["lighting"] {
    const m = this.model;
    const settings: LightingSetting[] = [];
    if (m.brightness && canLight(m.brightness)) {
      const b = this.#readings.brightness;
      settings.push({ id: "brightness", label: "Brightness", kind: "range", spec: { min: 0, max: P.BRIGHTNESS_MAX, step: 1, unit: "level" }, value: b, writable: b !== null });
    }
    if (m.directLighting && canLight(m.directLighting)) {
      if (m.directLighting.release)
        settings.push({
          id: "mode",
          label: "Lighting",
          kind: "choice",
          choice: { options: [{ value: 0, label: "Keyboard's own (profile)" }, { value: 1, label: "One colour from SYNQ" }] },
          value: this.#cache.lightingMode,
          writable: true,
        });
      settings.push({ id: "color", label: "Colour (all keys)", kind: "color", value: this.#cache.color, writable: true });
    }
    if (!settings.length) return undefined;
    return {
      groups: [{ id: "lighting", label: "Lighting", settings }],
      source: this.#readings.brightness !== null ? "device" : this.#cache.lightingMode !== null ? "cache" : "unknown",
      note: m.directLighting?.release
        ? "A colour from SYNQ is volatile: the keyboard shows it until lighting is handed back or it is unplugged."
        : m.directLighting
          ? "A colour from SYNQ stays until the keyboard is unplugged: this model has no lighting hand-back SYNQ can send safely."
          : undefined,
    };
  }

  #profiles(): ProfilesState | undefined {
    if (!this.model.profiles || !canWrite(this.model.profiles)) return undefined;
    return {
      active: this.#cache.profile,
      count: P.PROFILE_SLOTS,
      names: Array.from({ length: P.PROFILE_SLOTS }, (_, i) => `Config ${i + 1}`),
      writable: true,
      note: "The keyboard can't report which profile is active: the one shown is the last SYNQ selected.",
    };
  }

  #build(): KbState {
    const m = this.model;
    const r = this.#readings;
    const extra: [string, string][] = [
      ["USB id", `${hex4(m.vendorId)}:${hex4(m.productId)}`],
      ["GG name", m.ggName],
      ["Firmware line (GG 121)", m.firmwareLine ?? "unknown"],
    ];
    if (r.region !== null) extra.push(["Region", P.REGION_NAMES[r.region] ?? `id ${r.region}`]);
    if (r.layout !== null) extra.push(["Layout", P.LAYOUT_NAMES[r.layout] ?? `id ${r.layout}`]);
    if (r.connected !== null) extra.push(["Keyboard", r.connected ? "connected to the receiver" : "not connected"]);
    if (r.battery) extra.push(["Battery", `${r.battery.percent}%${r.battery.charging ? " (charging)" : ""} (uncalibrated scale)`]);
    const notes: string[] = [];
    if (m.notes) notes.push(m.notes);
    for (const p of r.problems) notes.push(`Couldn't read ${p}`);
    if (m.connection === "receiver" && m.mainPid) notes.push(`Receiver for 1038:${hex4(m.mainPid)}; settings go through it to the keyboard.`);
    return {
      info: {
        brand: "SteelSeries",
        model: m.model,
        driver: DRIVER_ID,
        protocol: `GG HID 0xFFC0 · ${FAMILY_LABEL[this.family]}`,
        firmware: r.firmware ? [r.firmware] : [],
        serial: null,
        connection: m.connection === "receiver" ? "2.4 GHz receiver" : "USB",
        extra,
      },
      analog: this.#analog(),
      lighting: this.#lighting(),
      profiles: this.#profiles(),
      notes,
    };
  }

  #refresh(): void {
    this.#state = this.#build();
  }

  // -------------------------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------------------------

  plan(change: KbChange): KbPlan {
    switch (change.kind) {
      case "analog":
        return this.#planAnalog(change.target, change.values);
      case "lighting":
        return this.#planLighting(change.id, change.value);
      case "profile":
        return this.#planProfile(change.index);
      case "polling":
        throw new Error("Polling rate isn't something SYNQ can set on SteelSeries keyboards yet.");
      case "keycode":
        throw new Error("Key remapping isn't supported for SteelSeries keyboards: a binding write can erase the Fn layer's built-in shortcuts.");
      case "option":
        throw new Error("This keyboard has no such option in SYNQ.");
    }
  }

  #target(): P.AnalogTarget {
    const m = this.model;
    if (!m.table || !m.analogKeys) throw new Error("This keyboard has no adjustable keys.");
    return { family: this.family, table: m.table, keys: m.analogKeys };
  }

  #planAnalog(target: "global" | readonly KeyIndex[], values: AnalogValues): KbPlan {
    const m = this.model;
    const t = this.#target();
    const writable = this.#writableAnalog();
    const keys = target === "global" ? t.keys : target;
    if (!keys.length) throw new Error("No keys selected.");
    for (const k of keys) if (!t.keys.includes(k)) throw new Error(`Key 0x${k.toString(16)} has no adjustable switch on this keyboard.`);
    const sel = new Set(keys);
    const perKey = target !== "global" && keys.length < t.keys.length;
    const reports: OutgoingReport[] = [];
    const after: (() => void)[] = [];
    const labels: string[] = [];
    const expected: AnalogValues = {};
    const need = (f: AnalogField, what: string) => {
      if (!writable.includes(f)) throw new Error(`SYNQ can't change ${what} on the ${m.model}: no capture confirms the command.`);
    };
    const base = <T>(cache: Map<number, T> | null, what: string): Map<number, T> | null => {
      if (perKey && !cache) throw new Error(`Set ${what} for all keys first: the keyboard can't report its current per-key values, so changing some keys would overwrite the others.`);
      return cache;
    };

    if (values.rtReleaseMm !== undefined && values.rtReleaseMm !== null && values.rtReleaseMm !== values.rtPressMm)
      throw new Error("SteelSeries keyboards use one rapid-trigger sensitivity for press and release.");
    if (values.releaseMm != null || values.deadTopMm != null || values.deadBottomMm != null || (values.rtReleaseMm != null && values.rtPressMm == null))
      throw new Error("Only actuation, rapid trigger and its sensitivity can be set on this keyboard.");

    if (values.actuationMm !== undefined && values.actuationMm !== null) {
      need("actuationMm", "actuation");
      const mm = r1(values.actuationMm);
      P.mmToPair(t.table, mm); // throws with a sentence when the value is off GG's table
      const old = base(this.#cache.actuation, "actuation");
      const next = new Map(t.keys.map((k) => [k, sel.has(k) ? mm : old!.get(k)!] as [number, number]));
      reports.push(P.encodeActuation(t, (k) => next.get(k)!));
      after.push(() => (this.#cache.actuation = next));
      labels.push(`Actuation ${mm} mm`);
      expected.actuationMm = mm;
    }
    if (values.rapidTrigger !== undefined && values.rapidTrigger !== null) {
      need("rapidTrigger", "rapid trigger");
      const on = values.rapidTrigger;
      const old = base(this.#cache.rapidTrigger, "rapid trigger");
      const next = new Map(t.keys.map((k) => [k, sel.has(k) ? on : old!.get(k)!] as [number, boolean]));
      reports.push(P.encodeRapidTrigger(t, (k) => next.get(k)!));
      after.push(() => (this.#cache.rapidTrigger = next));
      labels.push(`Rapid trigger ${on ? "on" : "off"}`);
      expected.rapidTrigger = on;
    }
    if (values.rtPressMm !== undefined && values.rtPressMm !== null) {
      need("rtPressMm", "rapid-trigger sensitivity");
      const mm = r1(values.rtPressMm);
      P.sensitivityToRaw(mm);
      const old = base(this.#cache.sensitivity, "the rapid-trigger sensitivity");
      const next = new Map(t.keys.map((k) => [k, sel.has(k) ? mm : old!.get(k)!] as [number, number]));
      reports.push(P.encodeSensitivity(t, (k) => next.get(k)!));
      after.push(() => (this.#cache.sensitivity = next));
      labels.push(`Sensitivity ${mm} mm`);
      expected.rtPressMm = mm;
    }
    if (!reports.length) throw new Error("Nothing to change.");
    // Every frame is checked now, so the session hears "no" before anything is sent.
    for (const r of reports) if (this.link.out.guard.classify(r).verdict === "blocked") this.#refuse(r);

    const wireless = this.family === "wireless-rx" || this.family === "wireless-usb";
    const releaseFirst = wireless && this.#cache.lightingMode === 1;
    const where = target === "global" || !perKey ? "all keys" : `${keys.length} key${keys.length === 1 ? "" : "s"}`;
    return {
      label: `${labels.join(", ")} on ${where}`,
      expected,
      persistence: "volatile",
      caution: releaseFirst ? "SYNQ hands lighting back to the keyboard first (the receiver ignores settings while it shows SYNQ's colour)." : undefined,
      send: () =>
        this.link.run(async () => {
          if (releaseFirst) {
            await this.link.send(P.encodeLightingRelease(this.family));
            this.#cache.lightingMode = 0;
          }
          for (const r of reports) {
            if (wireless) await this.link.sendAcked(r);
            else await this.link.send(r);
          }
          for (const a of after) a();
          this.#refresh();
        }),
      readBack: async () => undefined,
    };
  }

  #refuse(r: OutgoingReport): never {
    const v = this.link.out.guard.classify(r);
    throw new Error(v.verdict === "blocked" ? `SYNQ refused to build this frame: ${v.reason}` : "refused");
  }

  #planLighting(id: string, value: LightingValue): KbPlan {
    const m = this.model;
    if (id === "brightness") {
      if (!m.brightness || this.#readings.brightness === null) throw new Error("This keyboard didn't report a brightness, so SYNQ won't set one.");
      if (typeof value !== "number") throw new Error("Brightness is a number from 0 to 10.");
      const report = P.encodeBrightness(value);
      return {
        label: `Brightness ${value}`,
        expected: value,
        persistence: "unknown",
        send: () => this.link.run(() => this.link.send(report)),
        readBack: () =>
          this.link.run(async () => {
            const b = P.decodeBrightness(await this.link.query(P.encodeBrightnessRead(), (x) => x[0] === P.OP.brightnessGet));
            this.#readings = { ...this.#readings, brightness: b };
            this.#refresh();
            return b ?? undefined;
          }),
      };
    }
    const dl = m.directLighting;
    if (!dl) throw new Error("SYNQ can't change the lighting on this keyboard.");
    const colorFrames = (hs: readonly [number, number]): OutgoingReport[] => {
      const rgb = P.hsToRgb(hs[0], hs[1]);
      const frames: OutgoingReport[] = [];
      if (dl.initFirst) frames.push(P.encodeDirectInit());
      frames.push(P.encodeDirect(this.family, dl.leds, () => rgb));
      return frames;
    };
    if (id === "mode") {
      if (!dl.release) throw new Error("This keyboard has no lighting hand-back SYNQ can send.");
      if (value !== 0 && value !== 1) throw new Error("Lighting mode is 0 (keyboard) or 1 (SYNQ colour).");
      const frames = value === 0 ? [P.encodeLightingRelease(this.family)] : colorFrames(this.#cache.color ?? [0, 0]);
      return {
        label: value === 0 ? "Lighting back to the keyboard" : "Lighting: one colour from SYNQ",
        expected: value,
        persistence: "volatile",
        send: () =>
          this.link.run(async () => {
            for (const f of frames) await this.link.send(f);
            this.#cache.lightingMode = value;
            if (value === 1 && !this.#cache.color) this.#cache.color = [0, 0];
            this.#refresh();
          }),
        readBack: async () => undefined,
      };
    }
    if (id === "color") {
      if (!Array.isArray(value) || value.length !== 2) throw new Error("A colour is [hue, saturation].");
      const hs: readonly [number, number] = [value[0], value[1]];
      const frames = colorFrames(hs);
      return {
        label: "Colour on all keys",
        expected: hs,
        persistence: "volatile",
        caution: dl.release ? undefined : "This keyboard keeps the colour until it is unplugged.",
        send: () =>
          this.link.run(async () => {
            for (const f of frames) await this.link.send(f);
            this.#cache.color = hs;
            this.#cache.lightingMode = 1;
            this.#refresh();
          }),
        readBack: async () => undefined,
      };
    }
    throw new Error(`Unknown lighting setting "${id}".`);
  }

  #planProfile(index: number): KbPlan {
    const m = this.model;
    if (!m.profiles || !canWrite(m.profiles)) throw new Error("SYNQ can't switch profiles on this keyboard.");
    const report = P.encodeProfileSelect(index + 1);
    return {
      label: `Profile Config ${index + 1}`,
      expected: index,
      persistence: "unknown",
      caution: "Switching profiles also swaps lighting and stored actuation; SYNQ's own live settings are dropped.",
      send: () =>
        this.link.run(async () => {
          await this.link.send(report);
          this.#cache = { ...this.#cache, profile: index, actuation: null, rapidTrigger: null, sensitivity: null, lightingMode: null };
          this.#refresh();
        }),
      readBack: async () => undefined,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

export const steelseriesKbDriver: KbDriver = {
  id: DRIVER_ID,
  name: "SteelSeries Apex (GG protocol)",
  priority: 50,
  vids: [STEELSERIES_VID],
  claims: (device) => claimsSteelSeries(device),
  async open(device: KbHidLike, _ctx: KbContext): Promise<KbBackend> {
    await ensureOpen(device);
    const backend = new SteelSeriesBackend(device);
    await backend.load();
    return backend;
  },
  async ping(device: KbHidLike): Promise<boolean> {
    const m = findModel(device.productId);
    if (!m || !claimsSteelSeries(device)) return false;
    const wasOpen = device.opened;
    try {
      await ensureOpen(device);
      const link = new SteelSeriesLink(asLocal(device), m);
      if (m.firmwareQuery) return P.decodeFirmware(await link.query(P.encodeFirmwareRead(0), P.isFirmwareReply, 600)) !== null;
      if (m.statusQuery && (m.family === "wireless-rx" || m.family === "wireless-usb")) {
        const op = m.family === "wireless-rx" ? P.OP.rxBattery : P.OP.usbBattery;
        await link.query(P.encodeStatusRead(m.family, "battery"), (b) => b[0] === op, 600);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      if (!wasOpen && device.opened) await device.close().catch(() => undefined);
    }
  },
};
