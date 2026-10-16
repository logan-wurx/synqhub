// MonsGeek / Akko keyboard session over a GuardedChannel (feature reports on FFFF:0002, report id 0).
//
//   connect   identify (0x8F, 3 tries 500 ms apart as the vendor app does) -> model + command set
//             from the dev id -> unit size (0xE6 feature list, firmware fallback) -> read everything.
//   writes    one setting at a time: refuse unless the model is a writable tier, the board isn't in
//             its bootloader, the command set is gen2 and allowWrites() says yes; travel writes also
//             need the stored actuation values to make sense in the detected unit (FCC's rule). Then
//             send, wait like the vendor app (10 ms before each send / read, 100 ms after a saved
//             write, 300 ms after a per-key commit), read the setting back -> WriteOutcome.
//
// Every frame goes through the guard for the current scope: "identify" until the model is known, then
// "gen2" or "yc500" (reads only). A blocked frame throws BlockedFrameError before the HidLike sees it.
//
// Ported from FCC app/src/hid/ry.ts (GPL-3.0: Link pacing / retries, read order, units check, mode
// switching rules for DKS / mod-tap / toggle / snap tap) with sharkfin (GPL-3.0) for the yc500 reads.
// Timing cross-checked against MonsGeek's web driver (SEND_TIME 10, READ_TIME 10, vendorSleep 100,
// whoAmI 3 x 500 ms; documentation only).

import { GuardedChannel, sleep as realSleep } from "../local-kb.ts";
import type { FrameLog, HidLike, KeyboardCaps, Reading, SupportTier, WriteOutcome } from "../local-kb.ts";
import * as P from "./protocol.ts";
import { createGuard, type GuardScope } from "./guard.ts";
import { L478, LYC, MONSGEEK_CHANNEL, capsFor, keyPositions, modelByDevId, travelLimits, type MonsGeekModel } from "./devices.ts";

export interface Pacing {
  /** Before every SET_FEATURE. [WEB SEND_TIME 10][FCC 10] */
  sendGapMs: number;
  /** Between SET_FEATURE and GET_FEATURE. [WEB READ_TIME 10][FCC 10] */
  readGapMs: number;
  /** After a write the keyboard saves. [WEB vendorSleep 100][FCC 100] */
  afterWriteMs: number;
  /** After the commit frame of a per-key table batch. [FCC 300] */
  afterCommitMs: number;
  /** Between identify attempts. [WEB whoAmI 500] */
  identifyRetryMs: number;
  /** Tries per GET when a stale answer comes back. [FCC 4] */
  retries: number;
}

export const OFFICIAL_PACING: Pacing = { sendGapMs: 10, readGapMs: 10, afterWriteMs: 100, afterCommitMs: 300, identifyRetryMs: 500, retries: 4 };

export interface MonsGeekSessionOptions {
  hid: HidLike;
  /** Asked before every write; nothing is written unless it returns true. */
  allowWrites: () => boolean | Promise<boolean>;
  log?: FrameLog;
  pacing?: Partial<Pacing>;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** A write SYNQ won't send (tier, allowWrites, units, ranges). Nothing reached the keyboard. */
export class WriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteRefusedError";
  }
}

export interface MonsGeekState {
  profile: Reading<number>;
  pollingHz: Reading<number>;
  debounceMs: Reading<number>;
  options: Reading<P.Options>;
  ycOptions: Reading<P.YcOptions>;
  lighting: Reading<P.Lighting>;
  lightingWire: Reading<P.LightingWire>;
  /** Four sub-layers of 512 bytes (4 per position) for the active profile. */
  keymap: Reading<Uint8Array>[];
  /** Raw per-key tables by id (gen2: u16 or u8 x 128; yc500: u8 x 126). */
  tables: Map<number, Reading<Uint16Array | Uint8Array>>;
  /** DKS binding rows (table 10), four arrays. */
  dks: Reading<Uint8Array[]>;
}

export interface KeySettings {
  pos: number;
  kind: P.KindName | "unknown";
  rapidTrigger: boolean;
  actuationMm: number | null;
  releaseMm: number | null;
  rtPressMm: number | null;
  rtReleaseMm: number | null;
  dksPointMm: number | null;
  deadzoneMm: number | null;
  modTapMs: number | null;
  snapPartner: number | null;
  dksRows: number[] | null;
  /** Sub-layer entries 0..3 (null where unread). */
  entries: (P.KeyEntry | null)[];
}

export type KeyModeSpec =
  | { kind: "normal"; key?: P.KeyEntry }
  | { kind: "modTap"; hold: P.KeyEntry; tap: P.KeyEntry; holdMs: number }
  | { kind: "toggle"; key: P.KeyEntry; repeat?: boolean }
  | { kind: "dks"; firstMm: number; keys: readonly [P.KeyEntry, P.KeyEntry, P.KeyEntry, P.KeyEntry]; rows: readonly [P.DksCell[], P.DksCell[], P.DksCell[], P.DksCell[]] };

/** One per-key value. `table` -1 = a keymap entry on `sublayer` (value = the 4 entry bytes). */
export interface TableValue {
  table: number;
  pos: number;
  value: number | readonly number[];
  sublayer?: number;
}

const unknownReading = <T>(): Reading<T> => ({ value: null, source: "unknown" });

export class MonsGeekSession {
  readonly hid: HidLike;
  readonly pacing: Pacing;
  private readonly allowWritesFn: () => boolean | Promise<boolean>;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly log?: FrameLog;
  private queue: Promise<unknown> = Promise.resolve();

  /** The channel every frame goes through (guard scope changes after identification). */
  channel: GuardedChannel;
  scope: GuardScope = "identify";

  identity: P.Identity | null = null;
  model: MonsGeekModel | null = null;
  family: P.Family = "gen2";
  /** Command set chosen without a model record (unknown dev id): reads only, decoded on a best guess. */
  familyGuessed = false;
  tier: SupportTier = "detectOnly";
  tierWhy = "Not connected.";
  rfVersion: number | null = null;
  ycRevision: number | null = null;
  features: P.FeatureList = P.decodeFeatureList(null);
  unitMm = 0.1;
  unitSource: P.UnitSource = "firmware";
  unitsOk = false;
  unitsWhy = "Not read yet.";
  state: MonsGeekState = MonsGeekSession.emptyState();

  constructor(opts: MonsGeekSessionOptions) {
    this.hid = opts.hid;
    this.pacing = { ...OFFICIAL_PACING, ...(opts.pacing ?? {}) };
    this.allowWritesFn = opts.allowWrites;
    this.sleepFn = opts.sleep ?? realSleep;
    this.log = opts.log;
    this.channel = new GuardedChannel(this.hid, createGuard("identify"), MONSGEEK_CHANNEL, this.log);
  }

  static emptyState(): MonsGeekState {
    return {
      profile: unknownReading(),
      pollingHz: unknownReading(),
      debounceMs: unknownReading(),
      options: unknownReading(),
      ycOptions: unknownReading(),
      lighting: unknownReading(),
      lightingWire: unknownReading(),
      keymap: [0, 1, 2, 3].map(() => unknownReading<Uint8Array>()),
      tables: new Map(),
      dks: unknownReading(),
    };
  }

  /** Identify, pick the command set and tier, read the unit size and every setting. */
  static async connect(opts: MonsGeekSessionOptions): Promise<MonsGeekSession> {
    const s = new MonsGeekSession(opts);
    await s.run(() => s.identify());
    if (s.tier !== "detectOnly") await s.readAll();
    return s;
  }

  get light() {
    return this.model?.light ?? (this.family === "yc500" ? LYC : L478);
  }

  /** Polling is offered when the USB id is an 8 kHz one and firmware >= 0x400. [WEB isSupportReportRate] */
  get pollingAllowed(): boolean {
    const v = this.rfVersion ?? this.identity?.firmware ?? 0;
    return !!this.model?.polling8k && this.family === "gen2" && v >= 0x400;
  }

  get caps(): KeyboardCaps {
    return capsFor(this.model, this.unitMm, this.pollingAllowed);
  }

  /** Serialises device exchanges (one at a time, like the vendor app). */
  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private now() {
    return new Date().toISOString();
  }

  private device<T>(value: T): Reading<T> {
    return { value, source: "device", at: this.now() };
  }

  private setScope(scope: GuardScope) {
    this.scope = scope;
    this.channel = new GuardedChannel(this.hid, createGuard(scope), MONSGEEK_CHANNEL, this.log);
  }

  // ---------------------------------------------------------------------------------------------
  // Exchanges
  // ---------------------------------------------------------------------------------------------

  private async send(frame: Uint8Array) {
    await this.sleepFn(this.pacing.sendGapMs);
    await this.channel.feature(frame);
  }

  /** GET with opcode echo; retried when a stale answer comes back. [FCC Link.query] */
  private async query(frame: Uint8Array): Promise<Uint8Array> {
    for (let attempt = 0; attempt < this.pacing.retries; attempt++) {
      await this.send(frame);
      await this.sleepFn(this.pacing.readGapMs);
      const r = await this.channel.getFeature();
      if (r.length === P.FRAME_LEN && r[0] === frame[0]) return r;
    }
    throw new Error(`No answer to 0x${frame[0].toString(16)}.`);
  }

  /** One page of a paged read (no echo: the page is the data). [FCC Link.page] */
  private async page(frame: Uint8Array): Promise<Uint8Array> {
    for (let attempt = 0; attempt < this.pacing.retries; attempt++) {
      await this.send(frame);
      await this.sleepFn(this.pacing.readGapMs);
      const r = await this.channel.getFeature();
      if (r.length === P.FRAME_LEN) return r;
    }
    throw new Error(`Paged read of 0x${frame[0].toString(16)} failed.`);
  }

  private async pages(frames: Uint8Array[]): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    for (const f of frames) out.push(await this.page(f));
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Identify
  // ---------------------------------------------------------------------------------------------

  private async identify() {
    let id: P.Identity | null = null;
    for (let i = 0; i < 3 && !id; i++) {
      if (i) await this.sleepFn(this.pacing.identifyRetryMs);
      try {
        id = P.decodeIdentify(await this.query(P.encodeIdentify()));
      } catch {
        id = null;
      }
    }
    if (!id) {
      this.tier = "detectOnly";
      this.tierWhy = "The keyboard didn't report a model id (0x8F).";
      return;
    }
    this.identity = id;
    if (id.boot) {
      this.tier = "detectOnly";
      this.tierWhy = "The keyboard reports it is in its bootloader. SYNQ sends nothing else; replug it.";
      return;
    }
    const model = modelByDevId(id.devId) ?? null;
    this.model = model;
    if (model) {
      this.family = model.family;
      this.tier = model.tier;
      this.tierWhy = model.tierWhy ?? (model.tier === "experimental" ? "Known model, never tested on hardware by SYNQ: writes need your OK." : "");
    } else {
      // Unknown id: reads only. The command set is a guess from the USB id (YC3121 boards use 4035).
      this.family = this.hid.productId === 0x4035 ? "yc500" : "gen2";
      this.familyGuessed = true;
      this.tier = "readOnly";
      this.tierWhy = `Unknown model id ${id.devId}: read-only. Please send a board report.`;
    }

    if (this.family === "gen2") {
      try {
        this.rfVersion = P.decodeRfVersion(await this.query(P.encodeRfVersion()));
      } catch {
        this.rfVersion = null;
      }
      let features: Uint8Array | null = null;
      try {
        features = await this.query(P.encodeFeatureList());
      } catch {
        features = null; // older firmware: no feature list, fall back to the version
      }
      this.features = P.decodeFeatureList(features);
      const u = P.unitMm(features, id.firmware, this.rfVersion);
      this.unitMm = u.unitMm;
      this.unitSource = u.source;
      this.setScope("gen2");
    } else {
      this.setScope("yc500");
      try {
        this.ycRevision = P.ycDecodeRevision(await this.query(P.ycEncodeRevision()));
      } catch {
        this.ycRevision = null;
      }
      this.unitMm = 0.1;
      this.unitSource = "firmware";
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  /** Reads every setting of the active profile. */
  readAll(): Promise<MonsGeekState> {
    return this.run(async () => {
      if (this.tier === "detectOnly") throw new Error(this.tierWhy);
      this.state = this.family === "gen2" ? await this.readAllGen2() : await this.readAllYc500();
      this.checkUnits();
      return this.state;
    });
  }

  private async readAllGen2(): Promise<MonsGeekState> {
    const st = MonsGeekSession.emptyState();
    const profile = P.decodeProfile(await this.query(P.encodeProfileRead()));
    st.profile = this.device(profile);
    try {
      const hz = P.decodePolling(await this.query(P.encodePollingRead()));
      if (hz !== null) st.pollingHz = this.device(hz);
    } catch {
      /* boards without a report-rate register */
    }
    st.debounceMs = this.device(P.decodeDebounce(await this.query(P.encodeDebounceRead())));
    st.options = this.device(P.decodeOptions(await this.query(P.encodeOptionsRead())));
    const wire = P.decodeLightingWire(await this.query(P.encodeLightingRead()));
    st.lightingWire = this.device(wire);
    st.lighting = { value: P.lightingFromWire(wire, this.light), source: this.model?.light ? "device" : "default", at: this.now() };
    for (const t of [P.TABLE.mode, P.TABLE.actuation, P.TABLE.release, P.TABLE.rtPress, P.TABLE.rtRelease, P.TABLE.dksPoint, P.TABLE.modTap, P.TABLE.deadzone, P.TABLE.snap]) {
      const pages = await this.pages(P.encodeTableReadAll(t));
      st.tables.set(t, this.device(P.U16_TABLES.includes(t) ? P.decodeU16Table(pages) : P.decodeU8Table(pages)));
    }
    st.dks = this.device(P.decodeDksBindings(await this.pages(P.encodeTableReadAll(P.TABLE.dksBindingsGet))));
    if (profile < P.MAX_PROFILES) {
      for (let l = 0; l < P.SUBLAYERS; l++) st.keymap[l] = this.device(P.decodeKeymapPages(await this.pages(P.encodeKeymapReadAll(profile, l))));
    }
    return st;
  }

  private async readAllYc500(): Promise<MonsGeekState> {
    const st = MonsGeekSession.emptyState();
    const profile = P.ycDecodeProfile(await this.query(P.ycEncodeProfileRead()));
    st.profile = this.device(profile);
    st.debounceMs = this.device(P.ycDecodeDebounce(await this.query(P.ycEncodeDebounceRead())));
    st.ycOptions = this.device(P.ycDecodeOptions(await this.query(P.ycEncodeOptionsRead())));
    const wire = P.decodeLightingWire(await this.query(P.encodeLightingRead()));
    st.lightingWire = this.device(wire);
    st.lighting = { value: P.lightingFromWire(wire, this.light), source: "device", at: this.now() };
    if (profile * 4 + 3 <= P.YC_MAX_SLOT) {
      for (let l = 0; l < P.SUBLAYERS; l++) {
        const frames = Array.from({ length: P.KEYMAP_READ_PAGES }, (_, page) => P.ycEncodeKeymapRead(profile, page, l));
        st.keymap[l] = this.device(P.decodeKeymapPages(await this.pages(frames)));
      }
    }
    // Switch columns exist from firmware 2.00; older yc3121 magnetic firmware takes settings but can't report them. [SF]
    if (this.ycRevision !== null && this.ycRevision >= 0x200) {
      for (const t of [P.TABLE.mode, P.TABLE.actuation, P.TABLE.release, P.TABLE.rtPress, P.TABLE.rtRelease, P.TABLE.dksPoint, P.TABLE.modTap, P.TABLE.deadzone, P.TABLE.snap]) {
        const frames = Array.from({ length: P.readPages(t, "yc500") }, (_, page) => P.ycEncodeTableRead(t, page));
        st.tables.set(t, this.device(P.decodeU8Table(await this.pages(frames), P.YC_POSITIONS)));
      }
      const frames = Array.from({ length: 8 }, (_, page) => P.ycEncodeTableRead(P.TABLE.dksBindingsGet, page));
      st.dks = this.device(P.decodeDksBindings(await this.pages(frames), P.YC_POSITIONS));
    }
    return st;
  }

  /** Live travel of every position in mm (table 254), gen2 only. Reads; allowed on read-only boards. */
  readLiveTravel(): Promise<Map<number, number>> {
    return this.run(async () => {
      if (this.family !== "gen2" || this.scope !== "gen2") throw new Error("Live travel is read on RY5088 boards only.");
      const values = P.decodeU16Table(await this.pages(P.encodeTableReadAll(P.TABLE.liveTravel)));
      const out = new Map<number, number>();
      const keys = keyPositions(this.model) ?? Array.from({ length: P.POSITIONS }, (_, p) => p);
      for (const p of keys) out.set(p, P.wireToMm(values[p], this.unitMm));
      return out;
    });
  }

  /** FCC's rule: every key's stored actuation must be > 0 and <= 1.25 x max travel in the detected unit. */
  private checkUnits() {
    if (this.family !== "gen2") {
      this.unitsOk = false;
      this.unitsWhy = "yc500 boards are read-only in SYNQ.";
      return;
    }
    const act = this.state.tables.get(P.TABLE.actuation)?.value;
    if (!act) {
      this.unitsOk = false;
      this.unitsWhy = "Actuation table not read.";
      return;
    }
    const layer0 = this.state.keymap[0].value;
    const keys = keyPositions(this.model) ?? (layer0 ? Array.from({ length: P.POSITIONS }, (_, p) => p).filter((p) => !P.sameEntry(P.entryAt(layer0, p), [0, 0, 0, 0])) : []);
    const maxMm = travelLimits(this.model).max * 1.25;
    const bad = keys.filter((p) => {
      const mm = act[p] * this.unitMm;
      return !(mm > 0 && mm <= maxMm);
    });
    this.unitsOk = keys.length >= 8 && bad.length === 0;
    this.unitsWhy = this.unitsOk
      ? `Stored actuation points fit ${this.unitMm} mm units (${this.unitSource}).`
      : keys.length < 8
        ? "Too few key positions to check the travel units."
        : `Stored actuation of ${bad.length} key(s) (e.g. position ${bad[0]}: ${act[bad[0]]} counts) doesn't fit ${this.unitMm} mm units; travel writes stay off. Please send a board report.`;
  }

  /** One key's settings in mm / ms from the last read. */
  keySettings(pos: number): KeySettings {
    const t = (id: number) => this.state.tables.get(id)?.value ?? null;
    const mode = t(P.TABLE.mode)?.[pos];
    const yc = this.family === "yc500";
    const mm = (id: number) => {
      const v = t(id)?.[pos];
      if (v === undefined) return null;
      return yc ? P.ycColumnMm(id, v) : P.wireToMm(v, this.unitMm);
    };
    const snap = t(P.TABLE.snap)?.[pos];
    const mt = t(P.TABLE.modTap)?.[pos];
    const dks = this.state.dks.value;
    return {
      pos,
      kind: mode === undefined ? "unknown" : P.kindName(mode),
      rapidTrigger: mode !== undefined && P.rtOn(mode),
      actuationMm: mm(P.TABLE.actuation),
      releaseMm: mm(P.TABLE.release),
      rtPressMm: mm(P.TABLE.rtPress),
      rtReleaseMm: mm(P.TABLE.rtRelease),
      dksPointMm: mm(P.TABLE.dksPoint),
      deadzoneMm: mm(P.TABLE.deadzone),
      modTapMs: mt === undefined ? null : mt * 10,
      snapPartner: snap === undefined || snap === P.SNAP_NONE ? null : snap,
      dksRows: dks ? dks.map((row) => row[pos]) : null,
      entries: this.state.keymap.map((l) => (l.value ? P.entryAt(l.value, pos) : null)),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Write gating
  // ---------------------------------------------------------------------------------------------

  /** Whether this board takes writes at all (before asking allowWrites). */
  canWrite(): { ok: boolean; why: string } {
    if (!this.identity) return { ok: false, why: "Not identified." };
    if (this.identity.boot) return { ok: false, why: "Bootloader mode." };
    if (this.tier !== "experimental" && this.tier !== "community" && this.tier !== "verified") return { ok: false, why: this.tierWhy || `Tier ${this.tier}.` };
    if (this.family !== "gen2" || this.scope !== "gen2") return { ok: false, why: "Only RY5088 (gen2) boards take writes." };
    return { ok: true, why: "" };
  }

  private async gate(what: string, opts: { travel?: boolean } = {}) {
    const c = this.canWrite();
    if (!c.ok) throw new WriteRefusedError(`${what}: ${c.why}`);
    if (opts.travel && !this.unitsOk) throw new WriteRefusedError(`${what}: ${this.unitsWhy}`);
    if (!(await this.allowWritesFn())) throw new WriteRefusedError(`${what}: writes are not allowed (allowWrites() said no).`);
  }

  private profileNow(): number {
    const p = this.state.profile.value;
    if (p === null || p >= P.MAX_PROFILES) throw new WriteRefusedError("The active profile wasn't read.");
    return p;
  }

  private checkPositions(positions: readonly number[]) {
    if (!positions.length) throw new WriteRefusedError("No keys given.");
    const keys = keyPositions(this.model);
    for (const p of positions) {
      if (!Number.isInteger(p) || p < 0 || p >= P.POSITIONS) throw new WriteRefusedError(`Position ${p} is out of range.`);
      if (keys && !keys.includes(p)) throw new WriteRefusedError(`Position ${p} has no key on ${this.model?.name}.`);
    }
  }

  private mmToCounts(what: string, mm: number, min: number, max: number): number {
    if (!Number.isFinite(mm) || mm < min - 1e-9 || mm > max + 1e-9) throw new WriteRefusedError(`${what} must be ${min}..${max} mm (got ${mm}).`);
    return P.mmToWire(mm, this.unitMm);
  }

  // ---------------------------------------------------------------------------------------------
  // Simple settings
  // ---------------------------------------------------------------------------------------------

  private async writeAndRead<T>(frame: Uint8Array, readBack: () => Promise<T>, same: (a: T, b: T) => boolean, wrote: T): Promise<WriteOutcome<T>> {
    await this.send(frame);
    await this.sleepFn(this.pacing.afterWriteMs);
    let read: T;
    try {
      read = await readBack();
    } catch (e) {
      return { status: "unconfirmed", value: wrote, why: `Read-back failed: ${(e as Error).message}` };
    }
    return same(read, wrote) ? { status: "confirmed", value: read } : { status: "mismatch", wrote, read };
  }

  setPolling(hz: number): Promise<WriteOutcome<number>> {
    return this.run(async () => {
      await this.gate("Polling rate");
      if (!this.pollingAllowed) throw new WriteRefusedError("Polling rate: the vendor app doesn't offer it on this board / firmware (needs an 8 kHz USB id and firmware >= 0x400).");
      const frame = P.encodePollingWrite(hz);
      const out = await this.writeAndRead(frame, async () => P.decodePolling(await this.query(P.encodePollingRead())) ?? -1, (a, b) => a === b, hz);
      if (out.status !== "unconfirmed") this.state.pollingHz = this.device(out.status === "confirmed" ? out.value : out.read);
      return out;
    });
  }

  /** Switches the active profile, then re-reads everything (keymap and tables are per profile). */
  async setProfile(profile: number): Promise<WriteOutcome<number>> {
    const out = await this.run(async () => {
      await this.gate("Profile");
      const max = Math.min(this.model?.profiles ?? 1, P.MAX_PROFILES);
      if (!Number.isInteger(profile) || profile < 0 || profile >= max) throw new WriteRefusedError(`Profile must be 0..${max - 1}.`);
      return this.writeAndRead(P.encodeProfileWrite(profile), async () => P.decodeProfile(await this.query(P.encodeProfileRead())), (a, b) => a === b, profile);
    });
    await this.readAll();
    return out;
  }

  setDebounce(ms: number): Promise<WriteOutcome<number>> {
    return this.run(async () => {
      await this.gate("Debounce");
      const max = this.model?.debounceMax;
      if (!max) throw new WriteRefusedError("Debounce: the vendor app doesn't offer it on this model.");
      if (!Number.isInteger(ms) || ms < 0 || ms > max) throw new WriteRefusedError(`Debounce must be 0..${max} ms.`);
      const out = await this.writeAndRead(P.encodeDebounceWrite(ms), async () => P.decodeDebounce(await this.query(P.encodeDebounceRead())), (a, b) => a === b, ms);
      if (out.status !== "unconfirmed") this.state.debounceMs = this.device(out.status === "confirmed" ? out.value : out.read);
      return out;
    });
  }

  /** Anti-mistouch, RT stability and WASD swap (read-modify-write; the OS byte is read-only). */
  setOptions(change: Partial<Pick<P.Options, "antiMistouch" | "rtStabilityMs" | "wasdSwap">>): Promise<WriteOutcome<P.Options>> {
    return this.run(async () => {
      await this.gate("Keyboard options");
      const cur = this.state.options.value;
      if (!cur) throw new WriteRefusedError("Keyboard options weren't read.");
      const next: P.Options = { ...cur, ...change };
      let frame: Uint8Array;
      try {
        frame = P.encodeOptionsWrite(next);
      } catch (e) {
        throw new WriteRefusedError((e as Error).message);
      }
      const same = (a: P.Options, b: P.Options) => a.antiMistouch === b.antiMistouch && a.rtStabilityMs === b.rtStabilityMs && a.wasdSwap === b.wasdSwap && a.fnIndex === b.fnIndex;
      const out = await this.writeAndRead(frame, async () => P.decodeOptions(await this.query(P.encodeOptionsRead())), same, next);
      if (out.status !== "unconfirmed") this.state.options = this.device(out.status === "confirmed" ? out.value : out.read);
      return out;
    });
  }

  /** Mode, speed, brightness, variant, colour. Read-modify-write of the current lighting. */
  setLighting(change: Partial<P.Lighting>): Promise<WriteOutcome<P.LightingWire>> {
    return this.run(async () => {
      await this.gate("Lighting");
      if (!this.model?.light) throw new WriteRefusedError("Lighting: this model's lighting constants aren't known.");
      const cur = this.state.lighting.value;
      if (!cur) throw new WriteRefusedError("Lighting wasn't read.");
      if (this.model.lightDisputed && change.colour !== undefined && change.colour !== cur.colour)
        throw new WriteRefusedError(`Lighting: rainbow / single-colour can't be changed on this model yet (${this.model.lightDisputed}).`);
      let colour = change.colour ?? cur.colour;
      if (colour === "preset" || colour === "none") colour = "fixed"; // a preset index reads back; SYNQ writes RGB
      const next: P.Lighting = { ...cur, ...change, colour };
      if (change.mode !== undefined && change.variant === undefined && next.variant >= P.variantsOf(next.mode)) next.variant = 0;
      let wire: P.LightingWire;
      let frame: Uint8Array;
      try {
        wire = P.lightingToWire(next, this.model.light);
        // Disputed nibble: keep whatever colour mode the board has now.
        if (this.model.lightDisputed) wire.option = (wire.option & 0xf0) | ((this.state.lightingWire.value?.option ?? wire.option) & 0x0f);
        frame = P.encodeLightingWrite(wire);
      } catch (e) {
        throw new WriteRefusedError((e as Error).message);
      }
      const same = (a: P.LightingWire, b: P.LightingWire) => a.mode === b.mode && a.speedWire === b.speedWire && a.brightness === b.brightness && a.option === b.option && a.r === b.r && a.g === b.g && a.b === b.b;
      const out = await this.writeAndRead(frame, async () => P.decodeLightingWire(await this.query(P.encodeLightingRead())), same, wire);
      if (out.status !== "unconfirmed") {
        const w = out.status === "confirmed" ? out.value : out.read;
        this.state.lightingWire = this.device(w);
        this.state.lighting = this.device(P.lightingFromWire(w, this.model.light));
      }
      return out;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Keymap
  // ---------------------------------------------------------------------------------------------

  private async readKeymapPage(sublayer: number, page: number) {
    const profile = this.profileNow();
    const r = await this.page(P.encodeKeymapRead(profile, page, sublayer));
    const cur = this.state.keymap[sublayer].value;
    if (cur) cur.set(r, page * P.FRAME_LEN);
    return r;
  }

  private async sendKey(sublayer: number, pos: number, entry: P.KeyEntry) {
    await this.send(P.encodeKeyWrite(this.profileNow(), pos, sublayer, entry));
    await this.sleepFn(this.pacing.afterWriteMs);
  }

  /** One key on one sub-layer (single-key write), read back from its page. */
  remapKey(pos: number, entry: P.KeyEntry, sublayer = 0): Promise<WriteOutcome<P.KeyEntry>> {
    return this.run(async () => {
      await this.gate("Remap");
      this.checkPositions([pos]);
      if (!P.entryOk(entry)) throw new WriteRefusedError(`Key entry [${entry.join(", ")}] isn't one SYNQ writes.`);
      if (sublayer > 0 && this.keySettings(pos).kind === "normal") throw new WriteRefusedError("Sub-layers 1..3 only matter for DKS / mod-tap keys; use setKeyMode.");
      await this.sendKey(sublayer, pos, entry);
      try {
        const r = await this.readKeymapPage(sublayer, pos >> 4);
        const read = P.entryAt(r, pos & 15);
        return P.sameEntry(read, entry) ? { status: "confirmed", value: read } : { status: "mismatch", wrote: entry, read };
      } catch (e) {
        return { status: "unconfirmed", value: entry, why: `Read-back failed: ${(e as Error).message}` };
      }
    });
  }

  /** A whole sub-layer (10 pages, as the vendor app sends it), read back in full. */
  writeSublayer(sublayer: number, table: Uint8Array): Promise<WriteOutcome<Uint8Array>> {
    return this.run(async () => {
      await this.gate("Keymap");
      const profile = this.profileNow();
      let frames: Uint8Array[];
      try {
        frames = P.encodeSublayerWrite(profile, sublayer, table);
      } catch (e) {
        throw new WriteRefusedError((e as Error).message);
      }
      for (const f of frames) await this.send(f);
      await this.sleepFn(this.pacing.afterWriteMs);
      let read: Uint8Array;
      try {
        read = P.decodeKeymapPages(await this.pages(P.encodeKeymapReadAll(profile, sublayer)));
      } catch (e) {
        return { status: "unconfirmed", value: table, why: `Read-back failed: ${(e as Error).message}` };
      }
      this.state.keymap[sublayer] = this.device(read);
      return read.every((b, i) => b === table[i]) ? { status: "confirmed", value: read } : { status: "mismatch", wrote: table, read };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Per-key tables
  // ---------------------------------------------------------------------------------------------

  private tableValue(table: number, pos: number): number | null {
    const v = this.state.tables.get(table)?.value;
    return v ? v[pos] : null;
  }

  /** Sends single-key table writes (commit on the last), waits, reads the touched tables back. */
  private async writeTables(writes: TableValue[]): Promise<WriteOutcome<TableValue[]>> {
    if (!writes.length) return { status: "confirmed", value: [] };
    let frames: Uint8Array[];
    try {
      frames = P.encodeTableBatch(writes);
    } catch (e) {
      throw new WriteRefusedError((e as Error).message);
    }
    for (const f of frames) await this.send(f);
    await this.sleepFn(this.pacing.afterCommitMs);
    const tables = [...new Set(writes.map((w) => (w.table === P.TABLE.dksBindingsSet ? P.TABLE.dksBindingsGet : w.table)))];
    try {
      for (const t of tables) {
        const pages = await this.pages(P.encodeTableReadAll(t));
        if (t === P.TABLE.dksBindingsGet) this.state.dks = this.device(P.decodeDksBindings(pages));
        else this.state.tables.set(t, this.device(P.U16_TABLES.includes(t) ? P.decodeU16Table(pages) : P.decodeU8Table(pages)));
      }
    } catch (e) {
      return { status: "unconfirmed", value: writes, why: `Read-back failed: ${(e as Error).message}` };
    }
    const read: TableValue[] = writes.map((w) =>
      w.table === P.TABLE.dksBindingsSet
        ? { table: w.table, pos: w.pos, value: (this.state.dks.value ?? []).map((row) => row[w.pos]) }
        : { table: w.table, pos: w.pos, value: this.tableValue(w.table, w.pos) ?? -1 },
    );
    const same = (a: TableValue["value"], b: TableValue["value"]) => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b);
    const bad = writes.filter((w, i) => !same(w.value, read[i].value));
    if (!bad.length) return { status: "confirmed", value: read };
    return { status: "mismatch", wrote: bad, read: read.filter((_, i) => !same(writes[i].value, read[i].value)) };
  }

  /** Actuation point of keys (table 0). Release (table 1) is separate, as in the vendor app. */
  setActuation(positions: readonly number[], mm: number): Promise<WriteOutcome<TableValue[]>> {
    return this.run(async () => {
      await this.gate("Actuation", { travel: true });
      this.checkPositions(positions);
      const t = travelLimits(this.model);
      const v = this.mmToCounts("Actuation", mm, t.min, t.max);
      return this.writeTables(positions.map((pos) => ({ table: P.TABLE.actuation, pos, value: v })));
    });
  }

  setRelease(positions: readonly number[], mm: number): Promise<WriteOutcome<TableValue[]>> {
    return this.run(async () => {
      await this.gate("Release point", { travel: true });
      this.checkPositions(positions);
      const t = travelLimits(this.model);
      const v = this.mmToCounts("Release point", mm, t.min, t.max);
      return this.writeTables(positions.map((pos) => ({ table: P.TABLE.release, pos, value: v })));
    });
  }

  /** Bottom dead zone (table 6). */
  setDeadzone(positions: readonly number[], mm: number): Promise<WriteOutcome<TableValue[]>> {
    return this.run(async () => {
      await this.gate("Dead zone", { travel: true });
      this.checkPositions(positions);
      const v = this.mmToCounts("Dead zone", mm, 0, travelLimits(this.model).deadMax);
      return this.writeTables(positions.map((pos) => ({ table: P.TABLE.deadzone, pos, value: v })));
    });
  }

  /** Rapid trigger on/off and its press / release sensitivities (tables 2, 3 and the mode bit). */
  setRapidTrigger(positions: readonly number[], rt: { enabled: boolean; pressMm?: number; releaseMm?: number }): Promise<WriteOutcome<TableValue[]>> {
    return this.run(async () => {
      await this.gate("Rapid trigger", { travel: true });
      this.checkPositions(positions);
      const t = travelLimits(this.model);
      const min = Math.max(t.rtMin, this.unitMm);
      const writes: TableValue[] = [];
      for (const pos of positions) {
        const mode = this.tableValue(P.TABLE.mode, pos);
        if (mode === null) throw new WriteRefusedError("Key modes weren't read.");
        if (rt.enabled) {
          if (rt.pressMm !== undefined) writes.push({ table: P.TABLE.rtPress, pos, value: Math.max(1, this.mmToCounts("RT press", rt.pressMm, min, t.rtMax)) });
          if (rt.releaseMm !== undefined) writes.push({ table: P.TABLE.rtRelease, pos, value: Math.max(1, this.mmToCounts("RT release", rt.releaseMm, min, t.rtMax)) });
        }
        const next = rt.enabled ? mode | P.RT_FLAG : mode & ~P.RT_FLAG;
        if (next !== mode) writes.push({ table: P.TABLE.mode, pos, value: next });
      }
      return this.writeTables(writes);
    });
  }

  /** Snap tap between two keys: both get kind 7 and each other's position (rapid-trigger bit kept). [FCC][WEB] */
  setSnapTap(a: number, b: number): Promise<WriteOutcome<TableValue[]>> {
    return this.run(async () => {
      await this.gate("Snap tap");
      this.checkPositions([a, b]);
      if (a === b) throw new WriteRefusedError("Snap tap needs two different keys.");
      const writes: TableValue[] = [];
      for (const [p, partner] of [
        [a, b],
        [b, a],
      ] as const) {
        const mode = this.tableValue(P.TABLE.mode, p);
        if (mode === null) throw new WriteRefusedError("Key modes weren't read.");
        if (P.kindOf(mode) !== P.KIND.normal && P.kindOf(mode) !== P.KIND.snap) throw new WriteRefusedError(`Position ${p} is a ${P.kindName(mode)} key; set it back to normal first.`);
        writes.push({ table: P.TABLE.mode, pos: p, value: (mode & P.RT_FLAG) | P.KIND.snap });
        writes.push({ table: P.TABLE.snap, pos: p, value: partner });
      }
      return this.writeTables(writes);
    });
  }

  /** Back to a plain key (and its snap partner too, when it had one). */
  clearSnapTap(pos: number): Promise<WriteOutcome<TableValue[]>> {
    return this.setKeyMode(pos, { kind: "normal" });
  }

  /**
   * Changes a key's kind. Mod-tap keeps its hold key on sub-layer 0 and tap key on 1; DKS uses all four
   * sub-layers as its bindings, table 4 as its first point and table 8 for the stage cells; a key that
   * goes back to normal gets [0,0,0,0] on sub-layers 1..3 (and `key` on 0 when given). [FCC writeKeys]
   */
  setKeyMode(pos: number, spec: KeyModeSpec): Promise<WriteOutcome<TableValue[]>> {
    return this.run(async () => {
      await this.gate("Key mode", { travel: spec.kind === "dks" });
      this.checkPositions([pos]);
      const mode = this.tableValue(P.TABLE.mode, pos);
      if (mode === null || this.state.keymap.some((l) => !l.value)) throw new WriteRefusedError("Key modes and sub-layers must be read first.");
      const rt = mode & P.RT_FLAG;
      const curKind = P.kindOf(mode);
      const keys: [number, P.KeyEntry][] = []; // [sub-layer, entry]
      const writes: TableValue[] = [];
      const leaving = curKind === P.KIND.dks || curKind === P.KIND.modTap || curKind === P.KIND.toggleHold || curKind === P.KIND.toggleTap;
      switch (spec.kind) {
        case "normal":
          if (spec.key) keys.push([0, spec.key]);
          if (leaving) for (let l = 1; l < P.SUBLAYERS; l++) keys.push([l, P.ENTRY.none()]);
          writes.push({ table: P.TABLE.mode, pos, value: rt | P.KIND.normal });
          break;
        case "modTap": {
          if (!Number.isFinite(spec.holdMs) || spec.holdMs < 10 || spec.holdMs > 2550) throw new WriteRefusedError("Mod-tap hold time must be 10..2550 ms.");
          keys.push([0, spec.hold], [1, spec.tap]);
          if (curKind === P.KIND.dks) keys.push([2, P.ENTRY.none()], [3, P.ENTRY.none()]);
          writes.push({ table: P.TABLE.modTap, pos, value: Math.min(255, Math.max(1, Math.round(spec.holdMs / 10))) });
          writes.push({ table: P.TABLE.mode, pos, value: rt | P.KIND.modTap });
          break;
        }
        case "toggle":
          keys.push([0, spec.key]);
          if (leaving) for (let l = 1; l < P.SUBLAYERS; l++) keys.push([l, P.ENTRY.none()]);
          writes.push({ table: P.TABLE.mode, pos, value: rt | (spec.repeat ? P.KIND.toggleTap : P.KIND.toggleHold) });
          break;
        case "dks": {
          const t = travelLimits(this.model);
          spec.keys.forEach((k, l) => keys.push([l, k]));
          writes.push({ table: P.TABLE.dksPoint, pos, value: this.mmToCounts("DKS first point", spec.firstMm, t.min, t.max) });
          writes.push({ table: P.TABLE.dksBindingsSet, pos, value: spec.rows.map((r) => P.packDksRow(r)) });
          writes.push({ table: P.TABLE.mode, pos, value: rt | P.KIND.dks });
          break;
        }
      }
      // Leaving snap tap: clear this key's partner link and the partner's.
      if (curKind === P.KIND.snap) {
        const partner = this.tableValue(P.TABLE.snap, pos);
        writes.push({ table: P.TABLE.snap, pos, value: P.SNAP_NONE });
        if (partner !== null && partner < P.POSITIONS && this.tableValue(P.TABLE.snap, partner) === pos) {
          const pm = this.tableValue(P.TABLE.mode, partner) ?? 0;
          writes.push({ table: P.TABLE.snap, pos: partner, value: P.SNAP_NONE });
          writes.push({ table: P.TABLE.mode, pos: partner, value: (pm & P.RT_FLAG) | P.KIND.normal });
        }
      }
      for (const [, e] of keys) if (!P.entryOk(e)) throw new WriteRefusedError(`Key entry [${e.join(", ")}] isn't one SYNQ writes.`);
      // Sub-layer entries first (single-key writes), then the tables with one commit.
      const changedKeys = keys.filter(([l, e]) => !P.sameEntry(P.entryAt(this.state.keymap[l].value!, pos), e));
      for (const [l, e] of changedKeys) await this.sendKey(l, pos, e);
      const tableOut = await this.writeTables(writes);
      // Read back the touched sub-layer pages.
      const keyMismatch: [number, P.KeyEntry, P.KeyEntry][] = [];
      try {
        for (const l of [...new Set(changedKeys.map(([l]) => l))]) {
          const r = await this.readKeymapPage(l, pos >> 4);
          for (const [kl, e] of changedKeys) if (kl === l && !P.sameEntry(P.entryAt(r, pos & 15), e)) keyMismatch.push([l, e, P.entryAt(r, pos & 15)]);
        }
      } catch (e) {
        return { status: "unconfirmed", value: writes, why: `Sub-layer read-back failed: ${(e as Error).message}` };
      }
      if (keyMismatch.length && tableOut.status !== "mismatch") {
        return {
          status: "mismatch",
          wrote: keyMismatch.map(([l, e]) => ({ table: -1, sublayer: l, pos, value: e })),
          read: keyMismatch.map(([l, , r]) => ({ table: -1, sublayer: l, pos, value: r })),
        };
      }
      return tableOut;
    });
  }
}
