// A DrunkDeer settings session over a GuardedChannel (src/lib/brands/local-kb.ts).
//
// connect = check the USB identity (never opens detect-only ids or 0x19F5:0xAFxx upgraders) -> identity
// read (0xA0) -> model + firmware dialect + features -> read everything the firmware can report.
// Writes are plans: send() then readBack(), so a later src/lib/kb KbBackend can wrap them 1:1. A write
// needs a model with a write tier, a known dialect, and allowWrites() saying yes; the outcome is
// "confirmed" (read back equal), "mismatch" (read back different) or "unconfirmed" (the firmware can't
// report it).
//
// Pacing follows the official app [antler KA/NC]: one frame in flight; the next goes out when the keyboard
// answers; an answer that doesn't come within 2 s (5 watchdog ticks x 400 ms) is a failure. The tracking
// stop on old dialects (B6 03 00) gets no answer: the official app frees the link after 50 ms. Live depth
// is one round per "tracking on"; the app re-arms 20 ms after the round's last chunk.
//
// Sources: see devices.ts / protocol.ts. Coupling rules (LW/RDT force RT on + Turbo off, Turbo excludes
// keystroke tracking) follow svumo/DrunkDeer-Control (MIT) docs/keyboard-protocol.md §5.2, which mirrors
// the official UI.

import { GuardedChannel, sleep, type FrameLog, type HidLike, type KeyboardCaps, type Reading, type SupportTier, type WriteOutcome } from "../local-kb.ts";
import {
  DD_CHANNEL,
  FACTORY_KEYPOINTS,
  MAX_LW_PAIRS,
  MAX_RDT_PAIRS,
  X60_VID,
  capsFor,
  deviceEntry,
  featuresFor,
  isOemUpgrader,
  modelForTypeBytes,
  tierAllowsWrites,
  tierFor,
  type DrunkDeerFeatures,
  type DrunkDeerModel,
} from "./devices.ts";
import { guardFor, type GuardContext } from "./guard.ts";
import * as P from "./protocol.ts";

export const TIMING = { replyTimeoutMs: 2000, noReplyWaitMs: 50, depthRearmMs: 20 } as const;

export interface DrunkDeerSessionOptions {
  /** Asked before every write. Default: never. */
  allowWrites?: () => boolean | Promise<boolean>;
  log?: FrameLog;
  /** Per-answer timeout (default 2000 ms, the official watchdog). */
  timeoutMs?: number;
  now?: () => string;
}

export interface LightingState {
  /** Preset key ("color5"), or null when the code isn't one of this model's presets. */
  mode: string | null;
  code: number;
  speed: number;
  brightness: number;
  /** Colour byte; not reported by the firmware (null when only read). */
  colour: number | null;
}

export interface DrunkDeerState {
  identity: P.IdentityInfo;
  model: DrunkDeerModel | null;
  tier: SupportTier;
  features: DrunkDeerFeatures | null;
  common: Reading<P.CommonSettings>;
  autoMatch: Reading<number>;
  lwReplace: Reading<boolean>;
  lighting: Reading<LightingState>;
  keyPoints: Record<P.KeyField, Reading<number[]>>;
  lwPairs: Reading<P.LwPair[]>;
  rdtPairs: Reading<P.RdtPair[]>;
  profileIndex: Reading<number>;
  profileCount: Reading<number>;
  notes: string[];
}

export interface DrunkDeerPlan<T> {
  label: string;
  expected: T;
  persistence: "saved" | "volatile" | "unknown";
  send(): Promise<void>;
  /** `value` undefined = nothing readable; `unread` = why (part of) the change can't be confirmed. */
  readBack(): Promise<{ value?: T; unread?: string }>;
  equal(a: T, b: T): boolean;
}

export interface KeyPointOptions {
  /** When this firmware can't report per-key values, "factory" fills every other slot with the factory values. */
  baseline?: "factory";
}

const unknown = <T>(): Reading<T> => ({ value: null, source: "unknown" });
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Waiter {
  match: (d: Uint8Array) => boolean;
  resolve: (d: Uint8Array) => void;
}

export class DrunkDeerSession {
  readonly hid: HidLike;
  readonly channel: GuardedChannel;
  state: DrunkDeerState;
  private readonly opts: DrunkDeerSessionOptions;
  private ctx: GuardContext = { features: null, writes: false };
  private chain: Promise<unknown> = Promise.resolve();
  private waiter: Waiter | null = null;
  private depthHandler: ((d: Uint8Array) => void) | null = null;
  private depth: { running: boolean; loop: Promise<void> } | null = null;
  private readonly unsubscribe: () => void;

  private constructor(hid: HidLike, opts: DrunkDeerSessionOptions) {
    this.hid = hid;
    this.opts = opts;
    this.channel = new GuardedChannel(hid, guardFor(() => this.ctx), DD_CHANNEL, opts.log);
    this.unsubscribe = this.channel.onInput((d) => this.onInput(d));
    this.state = DrunkDeerSession.emptyState();
  }

  /** Checks the USB identity, reads the identity, then everything readable. Throws without sending anything for ids SYNQ doesn't open. */
  static async connect(hid: HidLike, opts: DrunkDeerSessionOptions = {}): Promise<DrunkDeerSession> {
    const id = `${hid.vendorId.toString(16).padStart(4, "0")}:${hid.productId.toString(16).padStart(4, "0")}`;
    if (isOemUpgrader(hid.vendorId, hid.productId)) throw new Error(`${id} is a firmware upgrader interface. SYNQ never opens it.`);
    const entry = deviceEntry(hid.vendorId, hid.productId);
    if (!entry) throw new Error(`${id} is not a DrunkDeer id SYNQ knows.`);
    if (entry.tier === "detectOnly") throw new Error(`${entry.model} (${id}) is detected only: ${entry.notes ?? ""}`);
    if (hid.vendorId === X60_VID && !/drunk\s*deer|x60/i.test(hid.productName ?? ""))
      throw new Error(`${id} carries the X60's USB id but its product name ("${hid.productName ?? ""}") isn't DrunkDeer's; nothing sent.`);
    if (hid.collections && hid.collections.length > 0 && !hid.collections.some((c) => c.usagePage === DD_CHANNEL.usagePage && (c.usage ?? 0) === DD_CHANNEL.usage))
      throw new Error(`${id}: this handle isn't the vendor collection 0xFF00/0x00.`);
    const s = new DrunkDeerSession(hid, opts);
    try {
      await s.identify();
      await s.readAll();
    } catch (e) {
      s.unsubscribe();
      throw e;
    }
    return s;
  }

  get model(): DrunkDeerModel | null {
    return this.state.model;
  }
  get features(): DrunkDeerFeatures | null {
    return this.state.features;
  }
  get tier(): SupportTier {
    return this.state.tier;
  }
  get caps(): KeyboardCaps | null {
    const m = this.state.model;
    return m ? capsFor(m, this.state.identity.firmware, this.state.identity.fineStep) : null;
  }
  get depthRunning(): boolean {
    return !!this.depth?.running;
  }

  // -------------------------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------------------------

  private now(): string {
    return this.opts.now ? this.opts.now() : new Date().toISOString();
  }

  private onInput(d: Uint8Array): void {
    this.depthHandler?.(d);
    const w = this.waiter;
    if (w && w.match(d)) {
      this.waiter = null;
      w.resolve(d);
    }
  }

  /** Serialises requests: one frame in flight. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Sends one frame (guard first) and waits for the answer `match` accepts; `match` null = no answer expected. */
  private request(frame: Uint8Array, match: ((d: Uint8Array) => boolean) | null, label: string): Promise<Uint8Array | null> {
    return this.exclusive(async () => {
      if (!match) {
        await this.channel.output(frame);
        await sleep(TIMING.noReplyWaitMs);
        return null;
      }
      const ms = this.opts.timeoutMs ?? TIMING.replyTimeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer = new Promise<Uint8Array>((resolve, reject) => {
        this.waiter = { match, resolve };
        timer = setTimeout(() => {
          this.waiter = null;
          reject(new Error(`No answer from the keyboard within ${ms} ms (${label}).`));
        }, ms);
      });
      answer.catch(() => undefined);
      try {
        await this.channel.output(frame);
      } catch (e) {
        this.waiter = null;
        clearTimeout(timer);
        throw e;
      }
      try {
        return await answer;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  private echoOf(frame: Uint8Array): (d: Uint8Array) => boolean {
    return (d) => d[0] === frame[0] && d[1] === frame[1];
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  private static emptyState(): DrunkDeerState {
    return {
      identity: P.decodeIdentity(P.buildFrame([0xa0, 0x02, 0x00])),
      model: null,
      tier: "readOnly",
      features: null,
      common: unknown(),
      autoMatch: unknown(),
      lwReplace: unknown(),
      lighting: unknown(),
      keyPoints: { actuation: unknown(), downstroke: unknown(), upstroke: unknown() },
      lwPairs: unknown(),
      rdtPairs: unknown(),
      profileIndex: unknown(),
      profileCount: unknown(),
      notes: [],
    };
  }

  /** 0xA0 identity read; on the first call it also resolves model, dialect, tier and features. */
  async identify(): Promise<P.IdentityInfo> {
    const reply = await this.request(P.encodeIdentity(), P.isIdentityReply, "identity");
    const id = P.decodeIdentity(reply as Uint8Array);
    const first = this.state.model === null && this.state.features === null && this.state.common.value === null;
    if (first) this.resolveModel(id);
    else if (id.typeBytes.join() !== this.state.identity.typeBytes.join()) throw new Error("The keyboard reported different type bytes than at connect.");
    this.applyIdentity(id);
    return id;
  }

  private resolveModel(id: P.IdentityInfo): void {
    let model = modelForTypeBytes(...id.typeBytes);
    const notes: string[] = [];
    if (model && (this.hid.vendorId === X60_VID) !== (model.typeCode === 603)) {
      notes.push(`Type bytes ${id.typeBytes.join(",")} (${model.name}) don't belong to USB id ${this.hid.vendorId.toString(16)}:${this.hid.productId.toString(16)}; treated as unknown.`);
      model = null;
    }
    if (!model) notes.push(`Unknown type bytes ${id.typeBytes.join(",")}: read-only, and per-key values are never written (firmware dialect unknown).`);
    const tier = tierFor(model, id.firmware);
    const features = model ? featuresFor(model, id.firmware, id.fineStep) : null;
    if (features?.officialUpdatePrompt) notes.push("The official app asks owners of this firmware to update it (SYNQ never updates firmware).");
    if (model && features && !features.extendedIdentity)
      notes.push("This firmware dialect doesn't report Last-Win / RDT / RT-match / lighting state reliably; those show SYNQ's last write.");
    if (model && features && !features.pulls) notes.push("Per-key actuation / rapid-trigger values can't be read from this firmware.");
    this.state = { ...this.state, model, tier, features, notes };
    this.ctx = { features, presetCodes: features?.lightingPresets.map((p) => p.code) ?? [], writes: tierAllowsWrites(tier) && !!features };
  }

  private applyIdentity(id: P.IdentityInfo): void {
    const at = this.now();
    const f = this.state.features;
    const ext = !!f?.extendedIdentity;
    const prev = this.state;
    const common: P.CommonSettings = {
      turbo: id.turbo,
      rapidTrigger: id.rapidTrigger,
      // Bytes 18/19 are read on every dialect (svumo), but the official app only trusts them on newHighPrec.
      lastWin: ext || prev.common.source !== "cache" ? id.lastWin : (prev.common.value?.lastWin ?? id.lastWin),
      rdt: ext || prev.common.source !== "cache" ? id.rdt : (prev.common.value?.rdt ?? id.rdt),
      rtMatch: ext ? id.rtMatch : (prev.common.value?.rtMatch ?? false),
    };
    const presets = f?.lightingPresets ?? [];
    this.state = {
      ...prev,
      identity: id,
      common: { value: common, source: ext ? "device" : prev.common.source === "cache" ? "cache" : "device", at },
      autoMatch: f?.autoMatch ? { value: id.autoMatch, source: "device", at } : prev.autoMatch,
      lwReplace: f?.lwReplace ? { value: id.lwReplace, source: "device", at } : prev.lwReplace,
      lighting: ext
        ? { value: { mode: presets.find((p) => p.code === id.colour.code)?.key ?? null, code: id.colour.code, speed: id.colour.speed, brightness: id.colour.brightness, colour: prev.lighting.value?.colour ?? null }, source: "device", at }
        : prev.lighting,
      profileIndex: f?.profileIndex ? { value: id.profileIndex, source: "device", at } : prev.profileIndex,
    };
  }

  /** Reads everything this firmware can report (identity is read by identify()). Sends nothing that changes the keyboard. */
  async readAll(): Promise<DrunkDeerState> {
    const f = this.state.features;
    if (f?.pulls) {
      for (const field of P.KEY_FIELDS) await this.pullKeyPoints(field);
      await this.pullLw();
      await this.pullRdt();
    }
    if (f?.profileCount) {
      const r = await this.request(P.encodeProfileCountQuery(), (d) => d[0] === P.CMD.profileCount, "profile count");
      this.state = { ...this.state, profileCount: { value: P.decodeProfileCount(r as Uint8Array), source: "device", at: this.now() } };
    }
    return this.state;
  }

  async refresh(): Promise<DrunkDeerState> {
    await this.identify();
    return this.readAll();
  }

  /** FD 07 x -> 5 replies of 30 values (arrival order, as the official app). */
  async pullKeyPoints(field: P.KeyField): Promise<number[]> {
    const values: number[] = [];
    let n = 0;
    await this.request(P.encodePullKeyPoints(field), (d) => {
      const r = P.decodePullReply(d);
      if (!r || r.field !== field) return false;
      values.push(...r.mm);
      return ++n === 5;
    }, `read ${field}`);
    const mm = values.slice(0, P.SLOTS);
    this.state = { ...this.state, keyPoints: { ...this.state.keyPoints, [field]: { value: mm, source: "device", at: this.now() } } };
    return mm;
  }

  async pullLw(): Promise<P.LwPair[]> {
    const r = await this.request(P.encodePullLw(), (d) => d[0] === P.CMD.pairs && d[1] === P.FC.lwReply, "read Last-Win pairs");
    const pairs = P.decodeLwPull(r as Uint8Array) ?? [];
    this.state = { ...this.state, lwPairs: { value: pairs, source: "device", at: this.now() } };
    return pairs;
  }

  async pullRdt(): Promise<P.RdtPair[]> {
    const r = await this.request(P.encodePullRdt(), (d) => d[0] === P.CMD.pairs && d[1] === P.FC.rdtReply, "read RDT pairs");
    const pairs = P.decodeRdtPull(r as Uint8Array) ?? [];
    this.state = { ...this.state, rdtPairs: { value: pairs, source: "device", at: this.now() } };
    return pairs;
  }

  // -------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------

  private requireWritable(what: string): DrunkDeerFeatures {
    const f = this.state.features;
    if (!f || !this.state.model) throw new Error(`${what}: this keyboard's model / firmware dialect is unknown, so SYNQ doesn't write to it.`);
    if (!tierAllowsWrites(this.state.tier)) throw new Error(`${what}: ${this.state.model.name} is read-only in SYNQ.`);
    return f;
  }

  /** Runs a plan: allowWrites() -> send -> read back -> outcome. Throws when writes are off or the keyboard doesn't answer. */
  async run<T>(plan: DrunkDeerPlan<T>): Promise<WriteOutcome<T>> {
    const allow = this.opts.allowWrites ?? (() => false);
    if (!(await allow())) throw new Error(`Changes are switched off (${plan.label}).`);
    await plan.send();
    const rb = await plan.readBack();
    if (rb.value === undefined) return { status: "unconfirmed", value: plan.expected, why: rb.unread ?? "The keyboard can't report this setting." };
    if (!plan.equal(plan.expected, rb.value)) return { status: "mismatch", wrote: plan.expected, read: rb.value };
    if (rb.unread) return { status: "unconfirmed", value: plan.expected, why: rb.unread };
    return { status: "confirmed", value: plan.expected };
  }

  /**
   * Common switch (0xB5). Coupling as in the official UI: Last-Win or RDT on forces Rapid Trigger on and
   * Turbo off; Turbo stops keystroke tracking. Turbo / RT read back on every dialect; LW / RDT / RT-match
   * only on newHighPrec.
   */
  planCommon(change: Partial<P.CommonSettings>): DrunkDeerPlan<P.CommonSettings> {
    const f = this.requireWritable("Common settings");
    const cur = this.state.common.value;
    if (!cur) throw new Error("Common settings haven't been read yet.");
    const next: P.CommonSettings = { ...cur, ...change };
    if (next.lastWin || next.rdt) {
      if (change.turbo === true) throw new Error("Turbo can't be on together with Last-Win / RDT.");
      if (change.rapidTrigger === false) throw new Error("Last-Win / RDT need Rapid Trigger on.");
      next.turbo = false;
      next.rapidTrigger = true;
    }
    if ((next.lastWin || next.rdt) && !f.rtp) throw new Error(`Last-Win / RDT aren't offered on firmware ${this.state.identity.firmwareText} (official cutoff ${this.state.model?.rtpFrom}).`);
    if (next.rtMatch && !f.autoMatch) throw new Error("RT-match isn't offered on this keyboard's firmware.");
    const ext = f.extendedIdentity;
    const before = cur;
    return {
      label: "Common settings",
      expected: next,
      persistence: "saved",
      send: async () => {
        if (next.turbo && this.depth?.running) await this.stopDepth();
        await this.request(P.encodeCommon(next), (d) => d[0] === P.CMD.common, "common switch");
        if (!ext) this.state = { ...this.state, common: { value: next, source: "cache", at: this.now() } };
      },
      readBack: async () => {
        const id = await this.identify();
        if (ext) return { value: { turbo: id.turbo, rapidTrigger: id.rapidTrigger, lastWin: id.lastWin, rdt: id.rdt, rtMatch: id.rtMatch } };
        const unreadChanged = next.lastWin !== before.lastWin || next.rdt !== before.rdt || next.rtMatch !== before.rtMatch;
        return {
          value: { ...next, turbo: id.turbo, rapidTrigger: id.rapidTrigger },
          unread: unreadChanged ? "Turbo and Rapid Trigger read back; this firmware dialect doesn't report the Last-Win / RDT / RT-match flags." : undefined,
        };
      },
      equal: sameJson,
    };
  }

  async setCommon(change: Partial<P.CommonSettings>): Promise<WriteOutcome<P.CommonSettings>> {
    return this.run(this.planCommon(change));
  }

  /**
   * Per-key actuation / downstroke / upstroke. `values` is either all 126 slots or { slot: mm } changes.
   * The keyboard takes whole batches, so a partial change needs the other slots: read from the keyboard
   * (newHighPrec with read-back), SYNQ's last write, or `baseline: "factory"` when neither exists.
   */
  planKeyPoints(field: P.KeyField, values: readonly number[] | Readonly<Record<number, number>>, opts: KeyPointOptions = {}): DrunkDeerPlan<number[]> {
    const f = this.requireWritable(`Per-key ${field}`);
    const d = f.dialect;
    const range = f.units[field];
    const cur = this.state.keyPoints[field].value;
    let base: number[];
    let changed: number[];
    if (Array.isArray(values)) {
      if (values.length !== P.SLOTS) throw new RangeError(`Give all ${P.SLOTS} slots or a { slot: mm } map.`);
      base = [...values];
      changed = base.map((_, i) => i);
    } else {
      if (cur) base = [...cur];
      else if (opts.baseline === "factory") base = new Array(P.SLOTS).fill(FACTORY_KEYPOINTS[field]);
      else throw new Error(`This keyboard can't report per-key ${field}, and SYNQ hasn't written it yet. Pass baseline "factory" to write the factory value (${FACTORY_KEYPOINTS[field]} mm) to every other key.`);
      changed = [];
      for (const [k, mm] of Object.entries(values as Record<string, number>)) {
        const slot = Number(k);
        if (!Number.isInteger(slot) || slot < 0 || slot >= P.SLOTS) throw new RangeError(`Slot ${k} is not 0..${P.SLOTS - 1}.`);
        base[slot] = mm;
        changed.push(slot);
      }
    }
    for (const slot of changed) {
      const mm = base[slot];
      if (!(mm >= range.min - 1e-9 && mm <= range.max + 1e-9)) throw new RangeError(`${field} must be ${range.min}..${range.max} mm on this keyboard (slot ${slot}: ${mm}).`);
    }
    base = base.map((mm) => P.wireToMm(P.mmToWire(mm, d), d));
    // Official UI rule: a non-zero downstroke never exceeds apPlusDownstrokeMax - actuation (the app lowers
    // it to max(0, cap - AP) when AP rises), so a downstroke of 0 is always allowed.
    const other = field === "actuation" ? "downstroke" : field === "downstroke" ? "actuation" : null;
    if (other) {
      const o = this.state.keyPoints[other].value ?? (opts.baseline === "factory" ? new Array(P.SLOTS).fill(FACTORY_KEYPOINTS[other]) : null);
      if (o)
        for (const slot of changed) {
          const [ap, ds] = field === "actuation" ? [base[slot], o[slot]] : [o[slot], base[slot]];
          if (ds > 0 && ap + ds > f.units.apPlusDownstrokeMax + 1e-9)
            throw new RangeError(`Slot ${slot}: actuation ${ap} + downstroke ${ds} would exceed ${f.units.apPlusDownstrokeMax} mm.`);
        }
    }
    const frames = P.encodeKeyPoints(field, base, d);
    const toWire = (a: readonly number[]) => a.map((mm) => P.mmToWire(mm, d));
    return {
      label: `Per-key ${field} (${changed.length} key${changed.length === 1 ? "" : "s"})`,
      expected: base,
      persistence: "saved",
      send: async () => {
        for (const fr of frames) await this.request(fr, this.echoOf(fr), `${field} batch`);
        this.state = { ...this.state, keyPoints: { ...this.state.keyPoints, [field]: { value: base, source: "cache", at: this.now() } } };
      },
      readBack: async () => (f.pulls ? { value: await this.pullKeyPoints(field) } : { unread: "This firmware has no per-key read command; SYNQ keeps the values it wrote." }),
      equal: (a, b) => sameJson(toWire(a), toWire(b.slice(0, P.SLOTS))),
    };
  }

  async setKeyPoints(field: P.KeyField, values: readonly number[] | Readonly<Record<number, number>>, opts?: KeyPointOptions): Promise<WriteOutcome<number[]>> {
    return this.run(this.planKeyPoints(field, values, opts));
  }

  private requirePairs(kind: "Last-Win" | "RDT"): DrunkDeerFeatures {
    const f = this.requireWritable(`${kind} pairs`);
    if (!f.pairWrites)
      throw new Error(`${kind} pairs on this keyboard are committed through the keymap stream plus 0xAA / 0xA7 / 0xA8, which SYNQ never sends. Only the on/off switch is available.`);
    const c = this.state.common.value;
    if (!c?.rapidTrigger || !(kind === "Last-Win" ? c.lastWin : c.rdt)) throw new Error(`Turn on Rapid Trigger and ${kind} first (the official app only saves pairs then).`);
    return f;
  }

  /** Last-Win pair table (newHighPrec): FC 0A mode, then FC 01. Read back with FC 05 where the firmware has it. */
  planLwPairs(pairs: readonly P.LwPair[]): DrunkDeerPlan<P.LwPair[]> {
    const f = this.requirePairs("Last-Win");
    if (pairs.length > MAX_LW_PAIRS) throw new RangeError(`At most ${MAX_LW_PAIRS} Last-Win pairs.`);
    const c = this.state.common.value as P.CommonSettings;
    const clear = P.encodeClearPairs(P.lwRdtMode(c.lastWin, c.rdt));
    const frame = P.encodeLwPairs(pairs);
    const expected = pairs.map((p) => ({ main: p.main, trigger: p.trigger }));
    return {
      label: `Last-Win pairs (${pairs.length})`,
      expected,
      persistence: "saved",
      send: async () => {
        await this.request(clear, this.echoOf(clear), "clear pair table");
        await this.request(frame, this.echoOf(frame), "Last-Win pairs");
        this.state = { ...this.state, lwPairs: { value: expected, source: "cache", at: this.now() } };
      },
      readBack: async () => (f.pulls ? { value: await this.pullLw() } : { unread: "This firmware can't report its pair table." }),
      equal: sameJson,
    };
  }

  async setLastWinPairs(pairs: readonly P.LwPair[]): Promise<WriteOutcome<P.LwPair[]>> {
    return this.run(this.planLwPairs(pairs));
  }

  /** RDT pair table (newHighPrec): FC 0A mode, then FC 03. */
  planRdtPairs(pairs: readonly P.RdtPair[]): DrunkDeerPlan<P.RdtPair[]> {
    const f = this.requirePairs("RDT");
    if (pairs.length > MAX_RDT_PAIRS) throw new RangeError(`At most ${MAX_RDT_PAIRS} RDT pairs.`);
    const c = this.state.common.value as P.CommonSettings;
    const clear = P.encodeClearPairs(P.lwRdtMode(c.lastWin, c.rdt));
    const frame = P.encodeRdtPairs(pairs);
    const q = (mm: number) => Math.round(mm * 200) / 200;
    const expected = pairs.map((p) => ({ press: p.press, release: p.release, activeMm: q(p.activeMm), resetMm: q(p.resetMm) }));
    return {
      label: `RDT pairs (${pairs.length})`,
      expected,
      persistence: "saved",
      send: async () => {
        await this.request(clear, this.echoOf(clear), "clear pair table");
        await this.request(frame, this.echoOf(frame), "RDT pairs");
        this.state = { ...this.state, rdtPairs: { value: expected, source: "cache", at: this.now() } };
      },
      readBack: async () => (f.pulls ? { value: await this.pullRdt() } : { unread: "This firmware can't report its pair table." }),
      equal: sameJson,
    };
  }

  async setRdtPairs(pairs: readonly P.RdtPair[]): Promise<WriteOutcome<P.RdtPair[]>> {
    return this.run(this.planRdtPairs(pairs));
  }

  /** RT auto-match mode (FD 0C): 0 standard, 1 competitive, 2 hardcore, 255 off. Read back from identity bytes 30/31. */
  planAutoMatch(mode: number): DrunkDeerPlan<number> {
    const f = this.requireWritable("Auto-match");
    if (!f.autoMatch) throw new Error("Auto-match isn't offered on this keyboard's firmware.");
    const frame = P.encodeAutoMatch(mode);
    return {
      label: `Auto-match ${mode}`,
      expected: mode,
      persistence: "saved",
      send: async () => {
        if (this.depth?.running) await this.stopDepth(); // the official app turns tracking off here
        await this.request(frame, this.echoOf(frame), "auto-match");
      },
      readBack: async () => ({ value: (await this.identify()).autoMatch }),
      equal: (a, b) => a === b,
    };
  }

  async setAutoMatch(mode: number): Promise<WriteOutcome<number>> {
    return this.run(this.planAutoMatch(mode));
  }

  /** Last-Win Replace (FC 0B), A75 Ultra / Master firmware >= 73. Read back from identity byte 32. */
  planLwReplace(on: boolean): DrunkDeerPlan<boolean> {
    const f = this.requireWritable("Last-Win Replace");
    if (!f.lwReplace) throw new Error("Last-Win Replace isn't offered on this keyboard's firmware.");
    const frame = P.encodeLwReplace(on);
    return {
      label: `Last-Win Replace ${on ? "on" : "off"}`,
      expected: on,
      persistence: "saved",
      send: async () => void (await this.request(frame, this.echoOf(frame), "Last-Win Replace")),
      readBack: async () => ({ value: (await this.identify()).lwReplace }),
      equal: (a, b) => a === b,
    };
  }

  async setLastWinReplace(on: boolean): Promise<WriteOutcome<boolean>> {
    return this.run(this.planLwReplace(on));
  }

  /**
   * Lighting preset (AE 01). `mode` is a preset key ("color5") or its English name from this model's
   * table. Mode, speed and brightness read back on newHighPrec (identity 22..24); the colour byte is never
   * reported, so it isn't part of the comparison.
   */
  planLighting(l: { mode: string; speed: number; brightness: number; colour: number }): DrunkDeerPlan<LightingState> {
    const f = this.requireWritable("Lighting");
    const preset = f.lightingPresets.find((p) => p.key === l.mode || p.name.toLowerCase() === l.mode.toLowerCase());
    if (!preset) throw new Error(`"${l.mode}" isn't a lighting preset of the ${this.state.model?.name}.`);
    const frame = P.encodeLighting({ code: preset.code, speed: l.speed, brightness: l.brightness, colour: l.colour });
    const expected: LightingState = { mode: preset.key, code: preset.code, speed: l.speed, brightness: l.brightness, colour: l.colour };
    return {
      label: `Lighting ${preset.name}`,
      expected,
      persistence: "saved",
      send: async () => {
        await this.request(frame, this.echoOf(frame), "lighting");
        if (!f.extendedIdentity) this.state = { ...this.state, lighting: { value: expected, source: "cache", at: this.now() } };
      },
      readBack: async () => {
        if (!f.extendedIdentity) return { unread: "This firmware dialect doesn't report its lighting state." };
        const id = await this.identify();
        return { value: { ...expected, mode: f.lightingPresets.find((p) => p.code === id.colour.code)?.key ?? null, code: id.colour.code, speed: id.colour.speed, brightness: id.colour.brightness } };
      },
      equal: (a, b) => a.code === b.code && a.speed === b.speed && a.brightness === b.brightness,
    };
  }

  async setLighting(l: { mode: string; speed: number; brightness: number; colour: number }): Promise<WriteOutcome<LightingState>> {
    return this.run(this.planLighting(l));
  }

  // -------------------------------------------------------------------------------------------
  // Live key depth
  // -------------------------------------------------------------------------------------------

  /**
   * Starts keystroke tracking: one round of chunks per "tracking on" (B6 03 01 / FD 03 01), re-armed 20 ms
   * after each round. `onFrame` gets 126 depths in mm per round. Refused while Turbo is on (official rule).
   */
  startDepth(onFrame: (mm: Float64Array) => void, onError?: (e: unknown) => void): void {
    const f = this.state.features;
    if (!f) throw new Error("Live depth: the keyboard's firmware dialect is unknown.");
    if (this.state.common.value?.turbo) throw new Error("Turbo and keystroke tracking can't run together (official app rule).");
    if (this.depth?.running) return;
    const d = f.dialect;
    const values = new Float64Array(P.SLOTS);
    this.depthHandler = (data) => {
      const c = P.decodeDepth(data, d);
      if (!c) return;
      values.set(c.mm.slice(0, P.SLOTS - c.first), c.first);
      if (c.last) onFrame(values.slice());
    };
    const state = { running: true, loop: Promise.resolve() };
    this.depth = state;
    const on = P.encodeTracking(true, d);
    state.loop = (async () => {
      try {
        while (state.running) {
          await this.request(on, (r) => P.decodeDepth(r, d)?.last === true, "keystroke tracking");
          if (state.running) await sleep(TIMING.depthRearmMs);
        }
      } catch (e) {
        state.running = false;
        onError?.(e);
      }
    })();
  }

  /** Stops the depth loop and sends tracking off (B6 03 00 gets no answer; FD 03 00 is echoed). */
  async stopDepth(): Promise<void> {
    const dep = this.depth;
    if (!dep) return;
    dep.running = false;
    await dep.loop;
    this.depth = null;
    this.depthHandler = null;
    const f = this.state.features;
    if (!f) return;
    const off = P.encodeTracking(false, f.dialect);
    await this.request(off, f.dialect === "newHighPrec" ? this.echoOf(off) : null, "keystroke tracking off");
  }

  async close(): Promise<void> {
    try {
      await this.stopDepth();
    } catch {
      // the device may already be gone
    }
    this.unsubscribe();
  }
}
