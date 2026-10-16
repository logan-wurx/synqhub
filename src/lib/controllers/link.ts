// A live connection to one controller for the tester, whichever way SYNQ reaches it:
//
// - `hid`: the pad's gamepad collection through navigator.hid (the desktop bridge's shim, or the website's guarded
//   WebHID). Every report is parsed for the screen and its time kept for the polling figure (the bridge stamps each
//   report when it reads it). Sony and Nintendo pads get their allowlisted reads and the volatile tests (guard.ts).
// - `xinput`: an XInput slot (Windows desktop): the state for the screen, the sampler for the polling figure.
// - `gamepad`: the browser's Gamepad API (any browser, no WebHID, no helper): about 250 Hz at most.
//
// Rules (CONTROLLERS-ROADMAP.md, the brief): everything that changes a pad's report mode (the Sony calibration read on
// Bluetooth, the Switch input mode) happens here, when the person opens the tester, never from the device list; the
// rumble test stops by itself within a second and on close, blur or any error; closing puts the Switch back in the
// mode it was in and gives the USB timeout back; handles are released when the window loses focus (the page does it,
// the bridge backs it up). GameSir's pads (wave C2) are read on their vendor collection: the link sends their
// keep-alive query every 0.4 s while it is open (they stream real state and answer only then) and asks for the
// firmware version; nothing else unless the person clicks the rumble test or saves a setting.
import { DS4, DS5, ds4Output, ds5Output, switchOutput, type Ds5Effect, type Ds5Trigger, type Link, type SwitchCommand } from "./frames.ts";
import { GAMESIR_GUARDS, checkPadOutput } from "./guard.ts";
import { CMD, GAMESIR_MAPS, GAMESIR_STATE, GAMESIR_STOP, gamesirQuery, gamesirRumble, type GamesirModel } from "./gamesir.ts";
import { gamesirChannel, type GamesirChannel } from "./gamesir-session.ts";
import { SCUF_COLLECTION, scufAnswer, scufBattery, scufBatteryStatus, scufFirmware, scufGet, scufPads, scufU32 } from "./scuf.ts";
import { PROP } from "../brands/corsair/bragi.ts";
import { EBD_IN, ebdVibrate } from "./eightbitdo.ts";
import { FD_IN, fdMotor, parseFlydigiAnswer } from "./flydigi.ts";

/** Pads whose input report SYNQ parses into sticks and buttons (others are timed and saved for diagnostics). */
export const PARSED_GUARDS: readonly string[] = ["ds5", "edge", "ds4", "switch", "gamesir-cyclone2", "gamesir-g7pro8k", "gamesir-tarantula"];
import type { PadIdentity } from "./identify.ts";
import {
  ds4Firmware,
  ds5Firmware,
  parseDs4,
  parseDs5,
  parseGamepad,
  parseGamesirState,
  parseSwitch,
  parseXInput,
  redactSwitch,
  switchDeviceInfo,
  switchReply,
  switchSpi,
  switchStickCal,
  type PadState,
  type SwitchContext,
  type XInputReading,
} from "./parse.ts";

export type SourceKind = "hid" | "xinput" | "gamepad";

export interface PadSource {
  kind: SourceKind;
  /** What the polling figure means here (CONTROLLERS.md §6.2). */
  label: string;
  /** "per-report": every report has its own time (exact); "per-change": XInput counts changes; "sampled": the Gamepad API. */
  timestamps: "per-report" | "per-change" | "sampled";
  /** A known ceiling (the Gamepad API is about 250 Hz). */
  maxHz?: number;
}

export interface PadInfo {
  link: Link | "xinput" | "gamepad";
  firmware?: string;
  hardware?: string;
  build?: string;
  deviceType?: string;
  battery?: { percent: number | null; charging: boolean; text?: string };
  /** The pad was switched to its full report for the tester (Bluetooth Sony, the Switch): until it reconnects. */
  reportModeChanged?: boolean;
  /** Calibration was read (Sony feature 0x05 / 0x02, Switch SPI). */
  calibration?: "read" | "not available";
  /** What SYNQ read and sent while opening, for the diagnostics bundle (addresses already removed). */
  reads: { what: string; hex: string }[];
  /** More facts the pad told SYNQ (the SCUF receiver's firmware, which pad is connected), for the overview. */
  facts?: [string, string][];
}

/** A raw report as it arrived (for the polling figure and diagnostics). */
export interface RawReport {
  t: number;
  id: number;
  data: Uint8Array;
}

export interface MeasureResult {
  times: number[];
  states: PadState[];
  /** XInput: how fast it was sampled (a figure near half of this is sample-limited). */
  sampleHz: number | null;
}

/** The volatile tests a pad takes, on the person's click only. */
export interface PadTests {
  kind: "ds5" | "ds4" | "switch" | "gamesir" | "8bitdo" | "flydigi";
  rumble(): Promise<void>;
  lightbar?(r: number, g: number, b: number): Promise<void>;
  playerLeds?(pattern: number): Promise<void>;
  micLed?(mode: 0 | 1 | 2): Promise<void>;
  triggers?(effect: Ds5Trigger): Promise<void>;
  releaseLeds?(): Promise<void>;
  homeLight?(intensity: number): Promise<void>;
}

export interface PadLink {
  readonly identity: PadIdentity;
  readonly source: PadSource;
  /** The open HID device (a HID pad's settings sessions use it: edge-session.ts); null for XInput and the Gamepad API. */
  readonly hid: HIDDevice | null;
  readonly info: PadInfo;
  readonly tests: PadTests | null;
  onState(cb: (s: PadState) => void): () => void;
  onRaw(cb: (r: RawReport) => void): () => void;
  /** Collects report (or change) times for `seconds`. */
  measure(seconds: number): Promise<MeasureResult>;
  close(): Promise<void>;
}

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toBytes = (v: DataView) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();

/** The longest the rumble test runs (the brief: at most 1 s). */
export const RUMBLE_MS = 700;

class Listeners<T> {
  #set = new Set<(v: T) => void>();
  add(cb: (v: T) => void): () => void {
    this.#set.add(cb);
    return () => this.#set.delete(cb);
  }
  emit(v: T): void {
    for (const cb of [...this.#set]) {
      try {
        cb(v);
      } catch (e) {
        console.warn("[onboard pad] listener failed", e);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// HID
// ---------------------------------------------------------------------------------------------

/** The bridge adds when it read the report and which collection it came from (the browser's WebHID has neither). */
type InputEvent = HIDInputReportEvent & { hostTime?: number; usagePage?: number };

/** Which transport a HID pad uses, from the output reports its descriptor declares. */
function linkOf(device: HIDDevice, identity: PadIdentity): Link {
  const outs = device.collections.flatMap((c) => c.outputReports ?? []).map((r) => r.reportId);
  if (identity.guard === "ds5" || identity.guard === "edge") return outs.includes(DS5.BT_OUTPUT) ? "bt" : "usb";
  if (identity.guard === "ds4") return outs.includes(DS4.BT_OUTPUT) ? "bt" : "usb";
  if (identity.guard === "switch") return outs.includes(0x80) ? "usb" : "bt";
  return "usb";
}

class HidLink implements PadLink {
  readonly source: PadSource = { kind: "hid", label: "raw HID reports, each timed as it was read", timestamps: "per-report" };
  readonly info: PadInfo;
  tests: PadTests | null = null;
  readonly #device: HIDDevice;
  readonly #link: Link;
  readonly #states = new Listeners<PadState>();
  readonly #raw = new Listeners<RawReport>();
  readonly #replies = new Listeners<RawReport>();
  /** BRAGI answers (SCUF): input reports the bridge tagged with the BRAGI collection. */
  readonly #bragi = new Listeners<Uint8Array>();
  #switch: SwitchContext = {};
  #packet = 0;
  #initialSimple = false;
  #rumbleTimer: ReturnType<typeof setTimeout> | null = null;
  #rumbling = false;
  /** The person ran one of the light tests: on close the DualSense gets its lights back (the release-LEDs frame). */
  #lightsTested = false;
  /** A GameSir pad's config channel (its keep-alive, firmware query and rumble test go through its queue). */
  #gamesir: GamesirChannel | null = null;
  #closed = false;
  #onInput = (e: Event) => this.#input(e as InputEvent);
  readonly identity: PadIdentity;

  get hid(): HIDDevice {
    return this.#device;
  }

  constructor(identity: PadIdentity, device: HIDDevice) {
    this.identity = identity;
    this.#device = device;
    this.#link = linkOf(device, identity);
    this.info = { link: this.#link, reads: [] };
  }

  #input(e: InputEvent): void {
    const data = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength).slice();
    const t = e.hostTime ?? e.timeStamp ?? performance.now();
    const r: RawReport = { t, id: e.reportId, data: this.identity.guard === "switch" ? redactSwitch(e.reportId, data) : data };
    if (this.identity.guard === "scuf" && e.usagePage === SCUF_COLLECTION[0]) {
      // An answer on the BRAGI channel: not the pad's input.
      this.#bragi.emit(data);
      return;
    }
    // An 8BitDo config answer (its settings page, the vibration test): not the pad's input either.
    if (this.identity.guard === "8bitdo" && e.reportId === EBD_IN && (data[0] === 0x04 || data[0] === 0x22)) return;
    // A Flydigi config answer (on its vendor collection: the bridge tags it; in the browser, by its shape).
    if (this.identity.guard === "flydigi" && (e.usagePage === 0xffa0 || (e.usagePage === undefined && e.reportId === FD_IN && parseFlydigiAnswer(data)))) return;
    this.#raw.emit(r);
    if (this.identity.guard === "switch" && (e.reportId === 0x21 || e.reportId === 0x81)) this.#replies.emit(r);
    const s = this.#parse(e.reportId, data, t);
    if (s) {
      if (s.battery) this.info.battery = s.battery;
      this.#states.emit(s);
    }
  }

  #parse(id: number, data: Uint8Array, t: number): PadState | null {
    switch (this.identity.guard) {
      case "ds5":
      case "edge":
        return parseDs5(id, data, t);
      case "ds4":
        return parseDs4(id, data, t);
      case "switch":
        return parseSwitch(id, data, t, this.#switch);
      case "gamesir-cyclone2":
      case "gamesir-g7pro8k":
      case "gamesir-tarantula":
        return parseGamesirState(id, data, t);
      default:
        // No parser for this pad's layout yet: its reports are timed, and the browser's Gamepad API draws it.
        return null;
    }
  }

  /** Sends one report through the guard first (the bridge and the website check it again). */
  async #send(f: { reportId: number; data: Uint8Array }): Promise<void> {
    const v = checkPadOutput(this.identity.guard, f.reportId, f.data);
    if (!v.ok) throw new Error(v.why);
    await this.#device.sendReport(f.reportId, f.data as BufferSource);
  }

  async #get(reportId: number): Promise<Uint8Array> {
    const v = await this.#device.receiveFeatureReport(reportId);
    const b = toBytes(v);
    this.info.reads.push({ what: `feature 0x${reportId.toString(16)}`, hex: hex(b) });
    return b;
  }

  /** A Switch subcommand (or USB command) and its reply, retried like SDL does. */
  async #switchCmd(cmd: SwitchCommand, wait: boolean): Promise<RawReport | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const f = switchOutput(this.#link, cmd, this.#packet);
      this.#packet = (this.#packet + 1) & 0x0f;
      let off = () => {};
      const reply = wait
        ? new Promise<RawReport | null>((resolve) => {
            const timer = setTimeout(() => resolve(null), 300);
            off = this.#replies.add((r) => {
              const ok = cmd.kind === "usb" ? r.id === 0x81 && r.data[0] === cmd.command : r.id === 0x21 && switchReply(r.data)?.sub === f.data[9];
              if (ok) {
                clearTimeout(timer);
                resolve(r);
              }
            });
          })
        : Promise.resolve(null);
      await this.#send(f);
      const got = await reply;
      off();
      if (!wait || got) return got;
    }
    return null;
  }

  /** Opening the tester: the reads and the report-mode switch the brief allows, nothing else. */
  async open(): Promise<void> {
    if (!this.#device.opened) await this.#device.open();
    this.#device.addEventListener("inputreport", this.#onInput);
    const g = this.identity.guard;
    if (g === "ds5" || g === "edge") {
      const fw = ds5Firmware(await this.#get(DS5.FEATURE_FIRMWARE).catch(() => new Uint8Array()));
      if (fw) Object.assign(this.info, fw);
      // The calibration read: on Bluetooth it also switches the pad to its full report (until it reconnects).
      const cal = await this.#get(DS5.FEATURE_CALIBRATION).catch(() => null);
      this.info.calibration = cal ? "read" : "not available";
      this.info.reportModeChanged = this.#link === "bt" && !!cal;
      this.tests = this.#ds5Tests();
    } else if (g === "ds4") {
      const fw = ds4Firmware(await this.#get(DS4.FEATURE_FIRMWARE).catch(() => new Uint8Array()));
      if (fw) Object.assign(this.info, fw);
      const cal = await this.#get(this.#link === "bt" ? DS4.FEATURE_CALIBRATION_BT : DS4.FEATURE_CALIBRATION_USB).catch(() => null);
      this.info.calibration = cal ? "read" : "not available";
      this.info.reportModeChanged = this.#link === "bt" && !!cal;
      this.tests = this.#ds4Tests();
    } else if (g === "switch") {
      await this.#openSwitch();
      this.tests = this.#switchTests();
    } else if (GAMESIR_GUARDS[g]) {
      await this.#openGamesir(GAMESIR_GUARDS[g]!);
    } else if (g === "scuf") {
      await this.#openScuf().catch(() => undefined);
    } else if (g === "8bitdo") {
      this.tests = this.#ebdTests();
    } else if (g === "flydigi") {
      this.tests = this.#flydigiTests();
    }
  }

  /** The Flydigi motor test: on until the stop frame, which follows within a second (and on close, blur or error). */
  #flydigiTests(): PadTests {
    const stop = async () => {
      if (this.#rumbleTimer) clearTimeout(this.#rumbleTimer);
      this.#rumbleTimer = null;
      this.#rumbling = false;
      await this.#send(fdMotor(0, 0));
    };
    this.#stopRumble = stop;
    return {
      kind: "flydigi",
      rumble: async () => {
        this.#rumbling = true;
        try {
          await this.#send(fdMotor(200, 200));
        } catch (e) {
          await stop().catch(() => undefined);
          throw e;
        }
        this.#stopRumbleLater(stop);
      },
    };
  }

  /** The 8BitDo's vibration test: the pad runs it for 0.6 s and stops by itself; a zero-length one ends it early. */
  #ebdTests(): PadTests {
    const stop = async () => {
      if (this.#rumbleTimer) clearTimeout(this.#rumbleTimer);
      this.#rumbleTimer = null;
      this.#rumbling = false;
      await this.#send(ebdVibrate(0, 0, 1));
    };
    this.#stopRumble = stop;
    return {
      kind: "8bitdo",
      rumble: async () => {
        this.#rumbling = true;
        try {
          await this.#send(ebdVibrate(200, 200, 600));
        } catch (e) {
          await stop().catch(() => undefined);
          throw e;
        }
        this.#stopRumbleLater(stop);
      },
    };
  }

  /**
   * The SCUF Envision's BRAGI reads: the receiver's firmware and connected pad, then the pad's identity, firmware and
   * battery. GETs only. Answers are told apart from the pad's input by the collection the bridge tags them with; the
   * browser can't tell, so there the first unanswered GET ends the reads.
   */
  async #openScuf(): Promise<void> {
    const ask = async (prop: number, addr: number): Promise<Uint8Array | null> => {
      let off = () => {};
      const answer = new Promise<Uint8Array | null>((resolve) => {
        const timer = setTimeout(() => (off(), resolve(null)), 300);
        off = this.#bragi.add((d) => {
          const a = scufAnswer(d);
          if (!a) return;
          clearTimeout(timer);
          off();
          resolve(a.ok ? a.data : null);
        });
      });
      await this.#send(scufGet(prop, addr));
      return answer;
    };
    const facts: [string, string][] = [];
    this.info.facts = facts;
    const fw0 = await ask(PROP.firmware, 0);
    if (!fw0) return;
    const receiver = /dongle|receiver/i.test(this.identity.personality ?? "");
    facts.push([receiver ? "Receiver firmware" : "Firmware (BRAGI)", scufFirmware(fw0)]);
    let addr = 0;
    if (receiver) {
      const bits = await ask(PROP.subdevices, 0);
      const pads = bits ? scufPads(scufU32(bits)) : [];
      if (!pads.length) {
        facts.push(["Pad", "Not connected to the receiver (wake it, or check its switch)"]);
        return;
      }
      addr = pads[0];
      facts.push(["Pad", `Connected (BRAGI address ${addr})`]);
      const fw = await ask(PROP.firmware, addr);
      if (fw) facts.push(["Pad firmware", scufFirmware(fw)]);
    }
    const vid = await ask(PROP.usbVid, addr);
    const pid = await ask(PROP.usbPid, addr);
    if (vid && pid) facts.push([receiver ? "Pad USB id" : "USB id (BRAGI)", `${scufU32(vid).toString(16).padStart(4, "0").toUpperCase()}:${scufU32(pid).toString(16).padStart(4, "0").toUpperCase()}`]);
    const level = await ask(PROP.batteryLevel, addr);
    const status = await ask(PROP.batteryStatus, addr);
    if (level) {
      const s = status ? scufBatteryStatus(status) : undefined;
      this.info.battery = { percent: scufBattery(level), charging: s === "charging", text: `${scufBattery(level)}%${s ? ` · ${s}` : ""}` };
    }
  }

  async #openGamesir(model: GamesirModel): Promise<void> {
    const ch = gamesirChannel(this.#device, model);
    this.#gamesir = ch;
    ch.startHeartbeat();
    const fw = await ch.request(gamesirQuery(CMD.firmware), (a) => a.cmd === CMD.firmwareAck).catch(() => null);
    if (fw?.firmware) {
      this.info.firmware = fw.firmware.dongle ? `${fw.firmware.controller} (receiver ${fw.firmware.dongle})` : fw.firmware.controller;
      this.info.reads.push({ what: "firmware (config command 0x09)", hex: `${fw.firmware.controller} / ${fw.firmware.dongle}` });
    }
    if (!GAMESIR_MAPS[model].vibration) return;
    const stop = async () => {
      if (this.#rumbleTimer) clearTimeout(this.#rumbleTimer);
      this.#rumbleTimer = null;
      this.#rumbling = false;
      await ch.request(GAMESIR_STOP, null);
    };
    this.#stopRumble = stop;
    this.tests = {
      kind: "gamesir",
      rumble: async () => {
        this.#rumbling = true;
        try {
          await ch.request(gamesirRumble(100, 100), null);
        } catch (e) {
          await stop().catch(() => undefined);
          throw e;
        }
        this.#stopRumbleLater(stop);
      },
    };
  }

  async #openSwitch(): Promise<void> {
    // Which report the pad sends before SYNQ asks for anything (0x3F: it's restored on close).
    const seen = new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => (off(), resolve(null)), 250);
      const off = this.#raw.add((r) => {
        if (r.id === 0x30 || r.id === 0x3f) {
          clearTimeout(timer);
          off();
          resolve(r.id);
        }
      });
    });
    if (this.#link === "usb") {
      const status = await this.#switchCmd({ kind: "usb", command: 0x01 }, true);
      if (status) this.info.reads.push({ what: "USB status (address removed)", hex: hex(status.data.subarray(0, 12)) });
      await this.#switchCmd({ kind: "usb", command: 0x02 }, true);
      await this.#switchCmd({ kind: "usb", command: 0x03 }, true);
      await this.#switchCmd({ kind: "usb", command: 0x02 }, true);
      await this.#switchCmd({ kind: "usb", command: 0x04 }, false);
    }
    this.#initialSimple = (await seen) === 0x3f;
    const info = await this.#switchCmd({ kind: "deviceInfo" }, true);
    const di = info && switchReply(info.data);
    const parsed = di && switchDeviceInfo(di.body);
    if (parsed) {
      this.info.firmware = parsed.firmware;
      this.info.deviceType = parsed.type;
    }
    await this.#switchCmd({ kind: "inputMode", mode: 0x30 }, true);
    this.info.reportModeChanged = true;
    await this.#switchCmd({ kind: "imu", on: true }, true);
    // Stick calibration: factory, then the user's own (where the pad has one).
    const factory = await this.#switchCmd({ kind: "spiRead", address: 0x603d, length: 18 }, true);
    const spi = factory && switchReply(factory.data);
    const block = spi && switchSpi(spi.body);
    if (block) {
      this.#switch.cal = switchStickCal(block.bytes);
      this.info.calibration = "read";
      this.info.reads.push({ what: "SPI 0x603d (factory stick calibration)", hex: hex(block.bytes) });
    } else this.info.calibration = "not available";
  }

  #stopRumbleLater(stop: () => Promise<void>): void {
    if (this.#rumbleTimer) clearTimeout(this.#rumbleTimer);
    this.#rumbleTimer = setTimeout(() => void stop().catch(() => undefined), RUMBLE_MS);
  }

  #ds5Tests(): PadTests {
    const send = (e: Ds5Effect) => this.#send(ds5Output(this.#link, e));
    const stop = async () => {
      if (this.#rumbleTimer) clearTimeout(this.#rumbleTimer);
      this.#rumbleTimer = null;
      this.#rumbling = false;
      await send({ kind: "rumble", left: 0, right: 0 });
    };
    this.#stopRumble = stop;
    return {
      kind: "ds5",
      rumble: async () => {
        this.#rumbling = true;
        try {
          await send({ kind: "rumble", left: 200, right: 200 });
        } catch (e) {
          await stop().catch(() => undefined);
          throw e;
        }
        this.#stopRumbleLater(stop);
      },
      lightbar: (r, g, b) => ((this.#lightsTested = true), send({ kind: "lightbar", r, g, b })),
      playerLeds: (pattern) => ((this.#lightsTested = true), send({ kind: "playerLeds", pattern })),
      micLed: (mode) => ((this.#lightsTested = true), send({ kind: "micLed", mode })),
      triggers: (effect) => send({ kind: "triggers", effect }),
      // Only from the "Give the lights back" button, or on close after the person's own light test.
      releaseLeds: async () => {
        await send({ kind: "releaseLeds" });
        this.#lightsTested = false;
      },
    };
  }

  #ds4Tests(): PadTests {
    const stop = async () => {
      if (this.#rumbleTimer) clearTimeout(this.#rumbleTimer);
      this.#rumbleTimer = null;
      this.#rumbling = false;
      await this.#send(ds4Output(this.#link, { kind: "rumble", left: 0, right: 0 }));
    };
    this.#stopRumble = stop;
    return {
      kind: "ds4",
      rumble: async () => {
        this.#rumbling = true;
        try {
          await this.#send(ds4Output(this.#link, { kind: "rumble", left: 200, right: 200 }));
        } catch (e) {
          await stop().catch(() => undefined);
          throw e;
        }
        this.#stopRumbleLater(stop);
      },
      lightbar: (r, g, b) => this.#send(ds4Output(this.#link, { kind: "lightbar", r, g, b })),
    };
  }

  #switchTests(): PadTests {
    let vibration = false;
    const stop = async () => {
      if (this.#rumbleTimer) clearTimeout(this.#rumbleTimer);
      this.#rumbleTimer = null;
      this.#rumbling = false;
      await this.#send(switchOutput(this.#link, { kind: "rumble", pulse: false }, this.#nextPacket()));
    };
    this.#stopRumble = stop;
    return {
      kind: "switch",
      rumble: async () => {
        if (!vibration) {
          await this.#switchCmd({ kind: "vibration", on: true }, true);
          vibration = true;
        }
        this.#rumbling = true;
        try {
          await this.#send(switchOutput(this.#link, { kind: "rumble", pulse: true }, this.#nextPacket()));
        } catch (e) {
          await stop().catch(() => undefined);
          throw e;
        }
        this.#stopRumbleLater(stop);
      },
      playerLeds: async (pattern) => {
        await this.#switchCmd({ kind: "playerLights", pattern }, true);
      },
      homeLight: async (intensity) => {
        await this.#switchCmd({ kind: "homeLight", intensity }, true);
      },
    };
  }

  #nextPacket(): number {
    const p = this.#packet;
    this.#packet = (p + 1) & 0x0f;
    return p;
  }

  #stopRumble: (() => Promise<void>) | null = null;

  onState(cb: (s: PadState) => void): () => void {
    return this.#states.add(cb);
  }
  onRaw(cb: (r: RawReport) => void): () => void {
    return this.#raw.add(cb);
  }

  async measure(seconds: number): Promise<MeasureResult> {
    const times: number[] = [];
    const states: PadState[] = [];
    // A GameSir pad's answers share its collection: only its state reports count.
    const off1 = this.#raw.add((r) => void ((!this.#gamesir || r.id === GAMESIR_STATE) && times.push(r.t)));
    const off2 = this.#states.add((s) => states.push(s));
    await sleep(seconds * 1000);
    off1();
    off2();
    return { times, states, sampleHz: null };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (this.#rumbling || this.#rumbleTimer) await this.#stopRumble?.().catch(() => undefined);
      if (this.#lightsTested && (this.identity.guard === "ds5" || this.identity.guard === "edge")) await this.tests?.releaseLeds?.().catch(() => undefined);
      if (this.identity.guard === "switch") {
        if (this.#initialSimple) await this.#switchCmd({ kind: "inputMode", mode: 0x3f }, false).catch(() => undefined);
        if (this.#link === "usb") await this.#switchCmd({ kind: "usb", command: 0x05 }, false).catch(() => undefined);
      }
    } finally {
      this.#gamesir?.close();
      this.#device.removeEventListener("inputreport", this.#onInput);
      await this.#device.close().catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// XInput (Windows desktop)
// ---------------------------------------------------------------------------------------------

/** How the XInput link reads: the bridge (src-tauri/src/xinput.rs), or the preview's simulated pad. */
export interface XInputBackend {
  read(slot: number): Promise<XInputReading | null>;
  /** Starts a sampling run; batches arrive through `onBatch` until `done`. */
  sample(slot: number, seconds: number, onBatch: (b: { readings: XInputReading[]; sampleHz: number; done: boolean }) => void): Promise<() => void>;
  stop(): Promise<void>;
}

class XInputLink implements PadLink {
  readonly source: PadSource = { kind: "xinput", label: "XInput packet changes (move a stick: XInput only counts changes)", timestamps: "per-change" };
  readonly info: PadInfo;
  readonly tests = null;
  readonly hid = null;
  readonly #states = new Listeners<PadState>();
  readonly #raw = new Listeners<RawReport>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #last = -1;
  #measuring = false;
  readonly identity: PadIdentity;
  private readonly slot: number;
  private readonly backend: XInputBackend;

  constructor(identity: PadIdentity, slot: number, backend: XInputBackend, battery?: [string, number]) {
    this.identity = identity;
    this.slot = slot;
    this.backend = backend;
    this.info = { link: "xinput", reads: [] };
    if (battery) this.info.battery = { percent: battery[0] === "wired" ? null : [0, 33, 66, 100][battery[1]] ?? null, charging: false, text: battery[0] === "wired" ? "Wired" : `${["Empty", "Low", "Medium", "Full"][battery[1]] ?? "?"} (${battery[0]})` };
  }

  async open(): Promise<void> {
    // The screen reads the state at its own pace; the polling figure comes from the sampler.
    this.#timer = setInterval(() => {
      if (this.#measuring) return;
      void this.backend.read(this.slot).then((r) => {
        if (!r || r.n === this.#last) return;
        this.#last = r.n;
        this.#states.emit(parseXInput(r));
      });
    }, 16);
  }

  onState(cb: (s: PadState) => void): () => void {
    return this.#states.add(cb);
  }
  onRaw(cb: (r: RawReport) => void): () => void {
    return this.#raw.add(cb);
  }

  async measure(seconds: number): Promise<MeasureResult> {
    const times: number[] = [];
    const states: PadState[] = [];
    const rates: number[] = [];
    this.#measuring = true;
    try {
      await new Promise<void>((resolve, reject) => {
        let stop = () => {};
        const watchdog = setTimeout(() => resolve(), (seconds + 2) * 1000);
        this.backend
          .sample(this.slot, seconds, (b) => {
            for (const r of b.readings) {
              const s = parseXInput(r);
              times.push(s.t);
              states.push(s);
              this.#states.emit(s);
            }
            if (b.sampleHz) rates.push(b.sampleHz);
            if (b.done) {
              clearTimeout(watchdog);
              stop();
              resolve();
            }
          })
          .then((s) => (stop = s), reject);
      });
    } finally {
      this.#measuring = false;
    }
    rates.sort((a, b) => a - b);
    return { times, states, sampleHz: rates.length ? rates[rates.length >> 1] : null };
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.backend.stop().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// The Gamepad API (any browser)
// ---------------------------------------------------------------------------------------------

class GamepadLink implements PadLink {
  readonly source: PadSource = { kind: "gamepad", label: "the browser's Gamepad API (about 250 Hz at most: for the picture, not the polling rate)", timestamps: "sampled", maxHz: 250 };
  readonly info: PadInfo = { link: "gamepad", reads: [] };
  readonly tests = null;
  readonly hid = null;
  readonly #states = new Listeners<PadState>();
  readonly #raw = new Listeners<RawReport>();
  #frame = 0;
  #last = -1;
  readonly identity: PadIdentity;
  private readonly index: number;

  constructor(identity: PadIdentity, index: number) {
    this.identity = identity;
    this.index = index;
  }

  async open(): Promise<void> {
    const tick = () => {
      const g = navigator.getGamepads?.()[this.index];
      if (g && g.timestamp !== this.#last) {
        this.#last = g.timestamp;
        this.#states.emit(parseGamepad(g));
      }
      this.#frame = requestAnimationFrame(tick);
    };
    this.#frame = requestAnimationFrame(tick);
  }

  onState(cb: (s: PadState) => void): () => void {
    return this.#states.add(cb);
  }
  onRaw(cb: (r: RawReport) => void): () => void {
    return this.#raw.add(cb);
  }

  async measure(seconds: number): Promise<MeasureResult> {
    const times: number[] = [];
    const states: PadState[] = [];
    const off = this.#states.add((s) => {
      times.push(s.t);
      states.push(s);
    });
    await sleep(seconds * 1000);
    off();
    return { times, states, sampleHz: null };
  }

  async close(): Promise<void> {
    cancelAnimationFrame(this.#frame);
  }
}

// ---------------------------------------------------------------------------------------------

export async function openHidLink(identity: PadIdentity, device: HIDDevice): Promise<PadLink> {
  const link = new HidLink(identity, device);
  try {
    await link.open();
  } catch (e) {
    await link.close().catch(() => undefined);
    throw e;
  }
  return link;
}

export async function openXInputLink(identity: PadIdentity, slot: number, backend: XInputBackend, battery?: [string, number]): Promise<PadLink> {
  const link = new XInputLink(identity, slot, backend, battery);
  await link.open();
  return link;
}

export async function openGamepadLink(identity: PadIdentity, index: number): Promise<PadLink> {
  const link = new GamepadLink(identity, index);
  await link.open();
  return link;
}
