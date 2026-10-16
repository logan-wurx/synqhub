// Razer sessions over a GuardedChannel: the request/reply loop Synapse Web's rzDevice25 uses, then a
// keyboard session (Huntsman analog / HE) and a mouse session (Viper / DeathAdder V4 HyperSpeed).
// Every frame passes razerGuard before it reaches the HidLike; writes are refused unless the model's
// tier allows them and the caller's allowWrites() says yes; every write is read back.
//
// Request loop [Synapse Web rzDevice25.sendCommand / _getUSBTransferInResult]: SET_FEATURE the 90-byte
// report, wait 5 ms, GET_FEATURE; a reply whose transaction id, class or id differs means "resend";
// status 1 (busy) means "read again" (10 ms apart, up to 10 times); 2 = done; 0 / 3 / 4 = resend;
// 5 = not supported (stop).

import { GuardedChannel, sleep as realSleep, type FrameLog, type HidLike, type WriteOutcome } from "../local-kb.ts";
import { RAZER_ALL_KEYS, RAZER_CONTROL, RAZER_VALID_KEY_IDS, findRazerKeyboard, findRazerMouse, type RazerKeyboardModel, type RazerMouseModel, type TxPolicy } from "./devices.ts";
import { razerGuard } from "./guard.ts";
import * as P from "./protocol.ts";

export class RazerCommandError extends Error {
  readonly status: number;
  constructor(what: string, status: number, detail: string) {
    super(`${what}: ${detail}`);
    this.name = "RazerCommandError";
    this.status = status;
  }
}

export interface RazerLinkOptions {
  log?: FrameLog;
  sleep?: (ms: number) => Promise<void>;
  /** Sends per request before giving up (Synapse resends on a mismatched or failed reply). */
  maxOut?: number;
  /** Reads per send while the device says busy. */
  maxIn?: number;
}

export class RazerLink {
  readonly channel: GuardedChannel;
  private readonly policy: TxPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxOut: number;
  private readonly maxIn: number;
  private tx = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(hid: HidLike, policy: TxPolicy, opts: RazerLinkOptions = {}) {
    this.channel = new GuardedChannel(hid, razerGuard, RAZER_CONTROL, opts.log);
    this.policy = policy;
    this.sleep = opts.sleep ?? realSleep;
    this.maxOut = opts.maxOut ?? 3;
    this.maxIn = opts.maxIn ?? 10;
  }

  /** Synapse's rolling id: 0, 1, ... 30, then 0 again (it resets when the counter reaches 31). */
  nextTx(): number {
    if (this.policy.kind === "fixed") return this.policy.id;
    if (this.tx === this.policy.wrapAt) this.tx = 0;
    return this.tx++;
  }

  /** One request, serialised with every other request on this link (one feature endpoint). */
  request(r: P.Request): Promise<P.Reply> {
    const run = this.queue.then(() => this.exchange(r));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async exchange(r: P.Request): Promise<P.Reply> {
    const cmd = P.CMD[r.cmd];
    let last = "no reply";
    let lastStatus = -1;
    for (let out = 0; out < this.maxOut; out++) {
      const tx = this.nextTx();
      const f = P.frame(r, tx);
      await this.channel.feature(f); // the guard runs here; a blocked frame throws before any I/O
      await this.sleep(5);
      for (let i = 0; i < this.maxIn; i++) {
        if (i > 0) await this.sleep(10);
        const rep = P.parseReply(await this.channel.getFeature());
        lastStatus = rep.status;
        if (rep.tx !== tx || rep.cls !== cmd.cls || rep.id !== cmd.id) {
          last = `reply for ${rep.cls.toString(16)}/${rep.id.toString(16)} tx ${rep.tx}, expected tx ${tx}`;
          break;
        }
        if (rep.status === P.STATUS.busy) {
          last = "busy";
          continue;
        }
        if (rep.status === P.STATUS.ok) return rep;
        if (rep.status === P.STATUS.unsupported) throw new RazerCommandError(cmd.what, rep.status, "not supported by this device");
        last = rep.status === P.STATUS.failed ? "failed" : rep.status === P.STATUS.timeout ? "timeout" : `status ${rep.status}`;
        break;
      }
    }
    throw new RazerCommandError(cmd.what, lastStatus, last);
  }
}

const now = () => new Date().toISOString();

function unconfirmed<T>(value: T, why: string): WriteOutcome<T> {
  return { status: "unconfirmed", value, why };
}

// ===================================================================================================
// Keyboards
// ===================================================================================================

export interface RazerKeyboardState {
  model: RazerKeyboardModel;
  firmware: string | null;
  serial: string | null;
  profileIds: number[];
  activeProfile: number | null;
  /** The onboard profile this session reads and edits (the active one). */
  profile: number;
  /** Analog keys found (fwIDs that answered the actuation read with a non-zero value). */
  keys: number[];
  actuation: Map<number, P.KeyActuation>;
  rapidTrigger: Map<number, P.KeyRapidTrigger>;
  bottomDeadZone: number | null;
  snapTap: P.SnapTapState | null;
  singleSnapTap: P.SingleSnapTapState | null;
  dualPriority: P.DualPriorityState | null;
  pollingHz: number | null;
  brightness: number | null;
  readAt: string | null;
  /** Reads that failed, as sentences. */
  problems: string[];
}

export interface RazerSessionOptions extends RazerLinkOptions {
  /** The person's "Allow changes" switch. Writes are refused while it returns false. */
  allowWrites?: () => boolean;
  /** Keys to probe for analog values (default: every fwID SYNQ knows, minus the numpad on non-full boards). */
  candidateKeys?: readonly number[];
}

const NUMPAD = new Set([90, 91, 92, 93, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108]);

export class RazerKeyboardSession {
  readonly model: RazerKeyboardModel;
  readonly link: RazerLink;
  private readonly allowWrites: () => boolean;
  private readonly candidates: readonly number[];
  state: RazerKeyboardState;

  constructor(hid: HidLike, model: RazerKeyboardModel, opts: RazerSessionOptions = {}) {
    this.model = model;
    this.link = new RazerLink(hid, model.tx, opts);
    this.allowWrites = opts.allowWrites ?? (() => false);
    this.candidates = opts.candidateKeys ?? [...RAZER_VALID_KEY_IDS].filter((k) => model.form === "full" || !NUMPAD.has(k)).sort((a, b) => a - b);
    this.state = {
      model, firmware: null, serial: null, profileIds: [], activeProfile: null, profile: 1, keys: [], actuation: new Map(), rapidTrigger: new Map(),
      bottomDeadZone: null, snapTap: null, singleSnapTap: null, dualPriority: null, pollingHz: null, brightness: null, readAt: null, problems: [],
    };
  }

  static forDevice(hid: HidLike, opts?: RazerSessionOptions): RazerKeyboardSession {
    const m = findRazerKeyboard(hid.productId);
    if (!m) throw new Error(`Razer product ${hid.productId.toString(16)} is not a keyboard SYNQ drives.`);
    return new RazerKeyboardSession(hid, m, opts);
  }

  get writable(): boolean {
    return this.model.tier !== "readOnly" && this.model.tier !== "detectOnly" && this.allowWrites();
  }

  private async read<T>(what: string, r: P.Request, dec: (rep: P.Reply) => T): Promise<T | null> {
    try {
      return dec(await this.link.request(r));
    } catch (e) {
      this.state.problems.push(`${what}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Identification, profiles and every setting of the active profile. Reads only. */
  async connect(): Promise<RazerKeyboardState> {
    this.state.problems = [];
    this.state.firmware = await this.read("firmware", P.encFirmware(), (r) => P.decFirmware(r.data));
    this.state.serial = await this.read("serial", P.encSerial(), (r) => P.decSerial(r.data));
    this.state.profileIds = (await this.read("profile list", P.encProfileList(), (r) => P.decProfileList(r.data))) ?? [];
    this.state.activeProfile = await this.read("active profile", P.encActiveProfileGet(), (r) => P.decActiveProfile(r.data));
    this.state.profile = this.state.activeProfile && this.state.activeProfile <= P.MAX_PROFILE_ID ? this.state.activeProfile : (this.state.profileIds[0] ?? 1);
    return this.readAll();
  }

  async readAll(): Promise<RazerKeyboardState> {
    const p = this.state.profile;
    const f = this.model.features;
    await this.readAnalog(this.candidates);
    this.state.bottomDeadZone = f.bottomDeadZone ? await this.read("bottom dead zone", P.encBottomDeadZoneGet(p), (r) => P.decBottomDeadZone(r.data)) : null;
    this.state.snapTap = f.snapTap ? await this.read("snap tap", P.encSnapTapGet(p), (r) => P.decSnapTap(r.data)) : null;
    this.state.singleSnapTap = f.singleKeySnapTap ? await this.read("single-key snap tap", P.encSingleSnapTapGet(p), (r) => P.decSingleSnapTap(r.data)) : null;
    this.state.dualPriority = f.dualKeypressPriority ? await this.read("dual keypress priority", P.encDualPriorityGet(p), (r) => P.decDualPriority(r.data)) : null;
    this.state.pollingHz = f.highSpeedPolling ? await this.read("polling", P.encPollingGet(p), (r) => P.decPolling(r.data)) : null;
    this.state.brightness = await this.read("brightness", P.encBrightnessGet(p), (r) => P.decBrightness(r.data));
    this.state.readAt = now();
    return this.state;
  }

  /**
   * Actuation and rapid trigger for `keys`, in Synapse's packet sizes. A packet the board refuses is
   * retried key by key, and keys that still fail (or read back 0) are treated as not analog.
   */
  async readAnalog(keys: readonly number[]): Promise<void> {
    const p = this.state.profile;
    const act = new Map<number, P.KeyActuation>();
    for (const chunk of chunks(keys, P.ACTUATION_PER_PACKET)) {
      let got = await this.tryRead(() => P.encActuationGet(p, chunk), P.decActuation);
      if (!got) {
        got = [];
        for (const k of chunk) got.push(...((await this.tryRead(() => P.encActuationGet(p, [k]), P.decActuation)) ?? []));
      }
      for (const e of got) if (chunk.includes(e.keyId) && e.actuationRaw > 0) act.set(e.keyId, e);
    }
    const analogKeys = [...act.keys()].sort((a, b) => a - b);
    const rt = new Map<number, P.KeyRapidTrigger>();
    for (const chunk of chunks(analogKeys, P.RT_PER_PACKET)) {
      const got = await this.tryRead(() => P.encRapidTriggerGet(p, chunk), P.decRapidTrigger);
      for (const e of got ?? []) if (chunk.includes(e.keyId)) rt.set(e.keyId, e);
    }
    for (const [k, v] of act) this.state.actuation.set(k, v);
    for (const [k, v] of rt) this.state.rapidTrigger.set(k, v);
    if (keys === this.candidates) this.state.keys = analogKeys;
    if (keys === this.candidates && analogKeys.length === 0) this.state.problems.push("No key answered the actuation read.");
  }

  private async tryRead<T>(mk: () => P.Request, dec: (r: P.Reply) => T): Promise<T | null> {
    try {
      return dec(await this.link.request(mk()));
    } catch {
      return null;
    }
  }

  private requireWrites(feature: boolean, what: string): void {
    if (!feature) throw new Error(`${this.model.model} has no ${what} setting.`);
    if (this.model.tier === "readOnly" || this.model.tier === "detectOnly") throw new Error(`${this.model.model} is read-only in SYNQ (${this.model.notes ?? "unverified"}).`);
    if (!this.allowWrites()) throw new Error("Changes are off. Turn on \"Allow changes\" first.");
  }

  private targetKeys(target: "all" | readonly number[]): number[] {
    const keys = target === "all" ? this.state.keys : [...target];
    if (keys.length === 0) throw new Error("No analog keys to change (read the keyboard first).");
    for (const k of keys) if (!this.state.keys.includes(k)) throw new Error(`Key ${k} is not an analog key on this board.`);
    return keys;
  }

  /**
   * Actuation point in mm for some keys or all of them; release point = Synapse's rule (0.1 mm above,
   * floor 256 raw) unless given. "all" uses key id 255 in one packet, as Synapse does.
   */
  async setActuation(target: "all" | readonly number[], actuationMm: number, releaseMm?: number): Promise<WriteOutcome<number>> {
    this.requireWrites(true, "actuation");
    const keys = this.targetKeys(target);
    const actRaw = P.mmToRaw(actuationMm);
    if (actRaw < this.model.actuation.minRaw || actRaw > this.model.actuation.maxRaw)
      throw new Error(`Actuation must be ${P.rawToMm(this.model.actuation.minRaw)}..${P.rawToMm(this.model.actuation.maxRaw)} mm on this board.`);
    const relRaw = releaseMm === undefined ? P.releaseFor(actRaw) : Math.max(P.RELEASE_MIN_RAW, P.mmToRaw(releaseMm));
    const p = this.state.profile;
    if (target === "all") await this.link.request(P.encActuationSet(p, [{ keyId: RAZER_ALL_KEYS, actuationRaw: actRaw, releaseRaw: relRaw }], this.model.actuation.maxRaw));
    else for (const c of chunks(keys, P.ACTUATION_PER_PACKET)) await this.link.request(P.encActuationSet(p, c.map((keyId) => ({ keyId, actuationRaw: actRaw, releaseRaw: relRaw })), this.model.actuation.maxRaw));
    await this.readAnalog(keys);
    const off = keys.find((k) => this.state.actuation.get(k)?.actuationRaw !== actRaw);
    if (off !== undefined) return { status: "mismatch", wrote: actuationMm, read: P.rawToMm(this.state.actuation.get(off)?.actuationRaw ?? 0) };
    return { status: "confirmed", value: P.rawToMm(actRaw) };
  }

  async setRapidTrigger(target: "all" | readonly number[], rt: { enabled: boolean; pressMm: number; releaseMm?: number }): Promise<WriteOutcome<boolean>> {
    this.requireWrites(true, "rapid trigger");
    const keys = this.targetKeys(target);
    const pressRaw = P.mmToRaw(rt.pressMm);
    const releaseRaw = P.mmToRaw(rt.releaseMm ?? rt.pressMm);
    const p = this.state.profile;
    if (target === "all") await this.link.request(P.encRapidTriggerSet(p, [{ keyId: RAZER_ALL_KEYS, enabled: rt.enabled, pressRaw, releaseRaw }]));
    else for (const c of chunks(keys, P.RT_PER_PACKET)) await this.link.request(P.encRapidTriggerSet(p, c.map((keyId) => ({ keyId, enabled: rt.enabled, pressRaw, releaseRaw }))));
    await this.readAnalog(keys);
    const off = keys.find((k) => {
      const v = this.state.rapidTrigger.get(k);
      return !v || v.enabled !== rt.enabled || (rt.enabled && (v.pressRaw !== pressRaw || v.releaseRaw !== releaseRaw));
    });
    if (off !== undefined) return { status: "mismatch", wrote: rt.enabled, read: this.state.rapidTrigger.get(off)?.enabled ?? false };
    return { status: "confirmed", value: rt.enabled };
  }

  async setBottomDeadZone(level: "responsive" | "medium" | "stable"): Promise<WriteOutcome<number>> {
    this.requireWrites(this.model.features.bottomDeadZone && this.model.bottomDeadZone !== null, "bottom dead zone");
    const v = this.model.bottomDeadZone![level];
    await this.link.request(P.encBottomDeadZoneSet(this.state.profile, v));
    return this.verify(v, async () => (this.state.bottomDeadZone = await this.read("bottom dead zone", P.encBottomDeadZoneGet(this.state.profile), (r) => P.decBottomDeadZone(r.data))));
  }

  async setSnapTap(s: P.SnapTapState): Promise<WriteOutcome<P.SnapTapState>> {
    this.requireWrites(this.model.features.snapTap, "snap tap");
    for (const pr of s.pairs) this.targetKeys([pr.a, pr.b]);
    await this.link.request(P.encSnapTapSet(this.state.profile, s));
    const back = (this.state.snapTap = await this.read("snap tap", P.encSnapTapGet(this.state.profile), (r) => P.decSnapTap(r.data)));
    if (!back) return unconfirmed(s, "read-back failed");
    return JSON.stringify(back) === JSON.stringify(s) ? { status: "confirmed", value: back } : { status: "mismatch", wrote: s, read: back };
  }

  /** Turns single-key snap tap on/off, keeping the keys the board reported (their key codes aren't documented). */
  async setSingleSnapTapEnabled(enabled: boolean): Promise<WriteOutcome<boolean>> {
    this.requireWrites(this.model.features.singleKeySnapTap, "single-key snap tap");
    const cur = this.state.singleSnapTap;
    if (!cur) throw new Error("Read single-key snap tap first.");
    await this.link.request(P.encSingleSnapTapSet(this.state.profile, { enabled, keys: cur.keys }));
    const back = (this.state.singleSnapTap = await this.read("single-key snap tap", P.encSingleSnapTapGet(this.state.profile), (r) => P.decSingleSnapTap(r.data)));
    if (!back) return unconfirmed(enabled, "read-back failed");
    return back.enabled === enabled ? { status: "confirmed", value: enabled } : { status: "mismatch", wrote: enabled, read: back.enabled };
  }

  async setDualPriority(s: P.DualPriorityState): Promise<WriteOutcome<P.DualPriorityState>> {
    this.requireWrites(this.model.features.dualKeypressPriority, "dual keypress priority");
    if (s.keys.length) this.targetKeys(s.keys);
    await this.link.request(P.encDualPrioritySet(this.state.profile, s));
    const back = (this.state.dualPriority = await this.read("dual keypress priority", P.encDualPriorityGet(this.state.profile), (r) => P.decDualPriority(r.data)));
    if (!back) return unconfirmed(s, "read-back failed");
    return JSON.stringify(back) === JSON.stringify(s) ? { status: "confirmed", value: back } : { status: "mismatch", wrote: s, read: back };
  }

  async setPolling(hz: number): Promise<WriteOutcome<number>> {
    this.requireWrites(this.model.features.highSpeedPolling, "polling");
    if (!this.model.polling.includes(hz)) throw new Error(`${hz} Hz isn't offered on this board.`);
    await this.link.request(P.encPollingSet(this.state.profile, hz));
    return this.verify(hz, async () => (this.state.pollingHz = await this.read("polling", P.encPollingGet(this.state.profile), (r) => P.decPolling(r.data))));
  }

  async setBrightness(percent: number): Promise<WriteOutcome<number>> {
    this.requireWrites(true, "brightness");
    const req = P.encBrightnessSet(this.state.profile, percent);
    await this.link.request(req);
    const expected = P.decBrightness(new Uint8Array([0, 0, req.args[2]]));
    return this.verify(expected, async () => (this.state.brightness = await this.read("brightness", P.encBrightnessGet(this.state.profile), (r) => P.decBrightness(r.data))));
  }

  async setActiveProfile(id: number): Promise<WriteOutcome<number>> {
    this.requireWrites(true, "profile");
    if (this.state.profileIds.length && !this.state.profileIds.includes(id)) throw new Error(`Profile ${id} isn't on the keyboard (${this.state.profileIds.join(", ")}).`);
    await this.link.request(P.encActiveProfileSet(id));
    const out = await this.verify(id, async () => (this.state.activeProfile = await this.read("active profile", P.encActiveProfileGet(), (r) => P.decActiveProfile(r.data))));
    if (out.status === "confirmed") {
      this.state.profile = id;
      this.state.actuation.clear();
      this.state.rapidTrigger.clear();
      await this.readAll();
    }
    return out;
  }

  private async verify<T>(expected: T, readBack: () => Promise<T | null>): Promise<WriteOutcome<T>> {
    const got = await readBack();
    if (got === null) return unconfirmed(expected, "read-back failed");
    return got === expected ? { status: "confirmed", value: got } : { status: "mismatch", wrote: expected, read: got };
  }
}

// ===================================================================================================
// Mice
// ===================================================================================================

export interface RazerMouseState {
  model: RazerMouseModel;
  firmware: string | null;
  profile: number;
  dpi: P.DpiStages | null;
  pollingHz: number | null;
  battery: number | null;
  charging: boolean | null;
  lift: { mode: number; level: number; asymmetric: boolean } | null;
  readAt: string | null;
  problems: string[];
}

export class RazerMouseSession {
  readonly model: RazerMouseModel;
  readonly link: RazerLink;
  private readonly allowWrites: () => boolean;
  state: RazerMouseState;

  constructor(hid: HidLike, model: RazerMouseModel, opts: RazerSessionOptions = {}) {
    this.model = model;
    this.link = new RazerLink(hid, model.tx, opts);
    this.allowWrites = opts.allowWrites ?? (() => false);
    this.state = { model, firmware: null, profile: 1, dpi: null, pollingHz: null, battery: null, charging: null, lift: null, readAt: null, problems: [] };
  }

  static forDevice(hid: HidLike, opts?: RazerSessionOptions): RazerMouseSession {
    const m = findRazerMouse(hid.productId);
    if (!m) throw new Error(`Razer product ${hid.productId.toString(16)} is not a mouse this layer drives.`);
    return new RazerMouseSession(hid, m, opts);
  }

  private async read<T>(what: string, r: P.Request, dec: (rep: P.Reply) => T): Promise<T | null> {
    try {
      return dec(await this.link.request(r));
    } catch (e) {
      this.state.problems.push(`${what}: ${(e as Error).message}`);
      return null;
    }
  }

  async connect(): Promise<RazerMouseState> {
    this.state.problems = [];
    this.state.firmware = await this.read("firmware", P.encFirmware(), (r) => P.decFirmware(r.data));
    const active = await this.read("active profile", P.encActiveProfileGet(), (r) => P.decActiveProfile(r.data));
    this.state.profile = active && active <= P.MAX_PROFILE_ID ? active : 1;
    return this.readAll();
  }

  async readAll(): Promise<RazerMouseState> {
    const p = this.state.profile;
    this.state.dpi = await this.read("DPI stages", P.encDpiStagesGet(p), P.decDpiStages);
    this.state.pollingHz = await this.read("polling", P.encPollingGet(p), (r) => P.decPolling(r.data));
    if (this.model.battery) {
      this.state.battery = await this.read("battery", P.encBattery(), (r) => P.decBattery(r.data));
      this.state.charging = await this.read("charging", P.encCharging(), (r) => P.decCharging(r.data));
    }
    if (this.model.lod) this.state.lift = await this.read("lift-off", P.encLiftGet(), (r) => P.decLift(r.data));
    this.state.readAt = now();
    return this.state;
  }

  private requireWrites(): void {
    if (this.model.tier === "readOnly" || this.model.tier === "detectOnly") throw new Error(`${this.model.model} is read-only in SYNQ.`);
    if (!this.allowWrites()) throw new Error("Changes are off. Turn on \"Allow changes\" first.");
  }

  /**
   * Writes DPI stages (1..5) and the active stage (1-based). Stage ids are kept from the read (Synapse
   * re-sends the ids it read); new stages get the next free id.
   */
  async setDpiStages(stages: readonly { x: number; y?: number }[], active: number): Promise<WriteOutcome<P.DpiStages>> {
    this.requireWrites();
    const cur = this.state.dpi;
    if (!cur) throw new Error("Read the DPI stages first.");
    const { min, max, step } = this.model.dpi;
    for (const s of stages) for (const v of [s.x, s.y ?? s.x]) if (v < min || v > max || (v - min) % step !== 0) throw new Error(`DPI must be ${min}..${max} in steps of ${step}.`);
    let nextId = Math.max(0, ...cur.stages.map((s) => s.id)) + 1;
    const want: P.DpiStages = { active, stages: stages.map((s, i) => ({ id: cur.stages[i]?.id ?? nextId++, x: s.x, y: s.y ?? s.x })) };
    await this.link.request(P.encDpiStagesSet(this.state.profile, want, { min, max }));
    const back = (this.state.dpi = await this.read("DPI stages", P.encDpiStagesGet(this.state.profile), P.decDpiStages));
    if (!back) return unconfirmed(want, "read-back failed");
    return JSON.stringify(back) === JSON.stringify(want) ? { status: "confirmed", value: back } : { status: "mismatch", wrote: want, read: back };
  }

  async setPolling(hz: number): Promise<WriteOutcome<number>> {
    this.requireWrites();
    if (!this.model.polling.includes(hz)) throw new Error(`${hz} Hz isn't offered on this mouse.`);
    await this.link.request(P.encPollingSet(this.state.profile, hz));
    const got = (this.state.pollingHz = await this.read("polling", P.encPollingGet(this.state.profile), (r) => P.decPolling(r.data)));
    if (got === null) return unconfirmed(hz, "read-back failed (the wireless link re-negotiates after a rate change)");
    return got === hz ? { status: "confirmed", value: hz } : { status: "mismatch", wrote: hz, read: got };
  }

  /** Symmetric lift-off level (Synapse "smart tracking" universal cut-off). Turns the proximity sensor on first, as Synapse does. */
  async setLiftLevel(level: number): Promise<WriteOutcome<number>> {
    this.requireWrites();
    if (!this.model.lod || !this.model.lod.levels.includes(level)) throw new Error("That lift-off level isn't offered on this mouse.");
    await this.link.request(P.encProximityOn());
    await this.link.request(P.encLiftSet(level));
    const back = (this.state.lift = await this.read("lift-off", P.encLiftGet(), (r) => P.decLift(r.data)));
    if (!back) return unconfirmed(level, "read-back failed");
    return back.level === level && back.mode === P.LIFT_MODE.universalCutOff ? { status: "confirmed", value: level } : { status: "mismatch", wrote: level, read: back.level };
  }
}

function chunks<T>(a: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}
