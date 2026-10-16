// A 0x19F5-family session over a GuardedChannel (src/lib/brands/local-kb.ts).
//
// connect = check the USB id (never an upgrader, never an id the table doesn't name) -> read the info area
// (firmware) -> read the base area (active profile) -> for boards with a known travel unit, the function
// block and the key-trigger table. A board that doesn't answer in the plain 0x55 protocol (NuPhy's newest
// firmware masks its traffic, a DrunkDeer relabel may answer on a collection the OS keeps) is kept as
// "listed, didn't answer": the session stays open with nothing else read.
//
// Writes are plans: send() then readBack(), so src/lib/kb's KbSession can wrap them 1:1. A write needs a
// family that may write (guard.ts), the "Allow changes" switch (allowWrites), a unit check that passed,
// and values in range. send() re-reads the area first and patches only the bytes the change names; only
// the changed 8-byte records (or the 64-byte function block) go out. readBack() reads the area again.
//
// Pacing follows FCC (GPL-3.0-or-later, app/src/hid/mc.ts): one request in flight, the next goes out when
// its reply is in, a missing reply is retried (3 tries, 20 ms apart), 1 s per try.

import { GuardedChannel, sleep, type FrameLog, type HidLike, type SupportTier } from "../local-kb.ts";
import { FW_CHANNEL, fwModel, isFwUpgrader, layoutOf, type FwModel } from "./devices.ts";
import { guardFamilyOf, guardFor, type GuardContext } from "./guard.ts";
import * as P from "./protocol.ts";

export const TIMING = { replyTimeoutMs: 1000, tries: 3, retryGapMs: 20 } as const;

export interface Fw19f5SessionOptions {
  /** Asked before every write. Default: never. */
  allowWrites?: () => boolean | Promise<boolean>;
  log?: FrameLog;
  /** Per-try timeout (default 1000 ms, FCC's). */
  timeoutMs?: number;
}

/** Why a session could not read the keyboard. */
export class NoAnswerError extends Error {
  constructor(what: string, ms: number) {
    super(`No answer from the keyboard within ${ms} ms (${what}).`);
    this.name = "NoAnswerError";
  }
}

export interface Fw19f5State {
  answered: boolean;
  firmware: { raw: number; text: string } | null;
  base: P.BaseInfo | null;
  /** The active profile's 64-byte function block (MCHOSE). */
  func: Uint8Array | null;
  /** The active profile's key-trigger table: 8 bytes per slot. */
  triggers: Uint8Array | null;
  /** Slots whose record reads like a real key. */
  keys: readonly number[];
  /** The travel unit looked right for every key it was applied to. */
  unitsOk: boolean;
  unitsWhy: string;
  notes: string[];
}

export interface Fw19f5Plan<T> {
  label: string;
  expected: T;
  persistence: "saved" | "volatile" | "unknown";
  send(): Promise<void>;
  readBack(): Promise<T>;
}

export interface AnalogRead {
  actuationMm: number;
  rapidTrigger: boolean;
  rtPressMm: number;
  rtReleaseMm: number;
}

/** What a model's tier lets SYNQ do. */
export function tierAllowsWrites(tier: SupportTier): boolean {
  return tier === "experimental" || tier === "community" || tier === "verified";
}

/** The travel units for a model: its catalogue row, else its travel facts; null when neither exists. */
export function unitsOf(model: FwModel): P.TravelUnits | null {
  const b = model.board ?? model.candidates[0] ?? null;
  if (b) return { step: b.step, precision: b.precision, maxTravel: b.maxTravel };
  return model.travel ? { step: model.travel.step, precision: model.travel.precision, maxTravel: model.travel.maxTravel } : null;
}

const id4 = (vid: number, pid: number) => `${vid.toString(16).padStart(4, "0")}:${pid.toString(16).padStart(4, "0")}`;

export class Fw19f5Session {
  readonly hid: HidLike;
  readonly model: FwModel;
  readonly channel: GuardedChannel;
  readonly units: P.TravelUnits | null;
  state: Fw19f5State;
  private readonly opts: Fw19f5SessionOptions;
  private ctx: GuardContext = { profile: null, writes: false };
  private chain: Promise<unknown> = Promise.resolve();
  private waiter: { request: Uint8Array; resolve: (d: Uint8Array) => void } | null = null;
  private readonly unsubscribe: () => void;

  private constructor(hid: HidLike, model: FwModel, opts: Fw19f5SessionOptions) {
    this.hid = hid;
    this.model = model;
    this.opts = opts;
    this.units = unitsOf(model);
    this.channel = new GuardedChannel(hid, guardFor(guardFamilyOf(model.family), () => this.ctx), FW_CHANNEL, opts.log);
    this.unsubscribe = this.channel.onInput((d) => this.onInput(d));
    this.state = { answered: false, firmware: null, base: null, func: null, triggers: null, keys: [], unitsOk: false, unitsWhy: "Not read yet.", notes: [] };
  }

  /** Checks the USB id, then reads. Throws without sending anything for ids SYNQ doesn't open. */
  static async connect(hid: HidLike, opts: Fw19f5SessionOptions = {}): Promise<Fw19f5Session> {
    const id = id4(hid.vendorId, hid.productId);
    if (isFwUpgrader(hid.vendorId, hid.productId)) throw new Error(`${id} is a firmware-update (upgrader) interface. SYNQ never opens it.`);
    const model = fwModel(hid.vendorId, hid.productId);
    if (!model) throw new Error(`${id} is not a keyboard id of the 0x19F5 family that SYNQ knows.`);
    if (hid.collections && hid.collections.length > 0 && !hid.collections.some((c) => c.usagePage === FW_CHANNEL.usagePage && (c.usage ?? 0) === FW_CHANNEL.usage))
      throw new Error(`${id}: this handle isn't the Generic Desktop collection 0001:0000 these keyboards are configured on.`);
    const s = new Fw19f5Session(hid, model, opts);
    try {
      await s.readAll();
    } catch (e) {
      s.unsubscribe();
      throw e;
    }
    return s;
  }

  /** Whether the connected board's tier lets writes through (still needs "Allow changes" at the call site). */
  get canWrite(): { ok: boolean; why: string } {
    if (!tierAllowsWrites(this.model.tier)) return { ok: false, why: this.model.family === "nuphy" || this.model.family === "rk-gcome" ? "SYNQ only reads this keyboard's firmware version." : "This keyboard is read-only in SYNQ." };
    if (!this.state.answered) return { ok: false, why: "The keyboard didn't answer, so nothing can be changed." };
    if (!this.units) return { ok: false, why: "This keyboard's travel unit isn't known." };
    if (!this.state.unitsOk) return { ok: false, why: this.state.unitsWhy };
    return { ok: true, why: "" };
  }

  close(): void {
    this.unsubscribe();
  }

  // -------------------------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------------------------

  private onInput(d: Uint8Array): void {
    const w = this.waiter;
    if (w && P.answers(w.request, d)) {
      this.waiter = null;
      w.resolve(d);
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Sends one frame (guard first) and waits for its reply; retries a missing reply. */
  private request(frame: Uint8Array, label: string): Promise<Uint8Array> {
    return this.exclusive(async () => {
      const ms = this.opts.timeoutMs ?? TIMING.replyTimeoutMs;
      let last: unknown;
      for (let attempt = 0; attempt < TIMING.tries; attempt++) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const answer = new Promise<Uint8Array>((resolve, reject) => {
          this.waiter = { request: frame, resolve };
          timer = setTimeout(() => {
            this.waiter = null;
            reject(new NoAnswerError(label, ms));
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
        } catch (e) {
          last = e;
          await sleep(TIMING.retryGapMs);
        } finally {
          clearTimeout(timer);
        }
      }
      throw last instanceof Error ? last : new NoAnswerError(label, ms);
    });
  }

  /** Reads `size` bytes of an area at `offset`, 56 at a time. */
  private async get(cmd: number, offset: number, size: number): Promise<Uint8Array> {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += P.CHUNK) {
      const n = Math.min(P.CHUNK, size - i);
      const r = P.parseReply(await this.request(P.readFrame(cmd, offset + i, n), `area ${cmd} @ ${offset + i}`));
      if (!r) throw new Error("The keyboard sent a reply this protocol doesn't know.");
      out.set(r.data.subarray(0, n), i);
    }
    return out;
  }

  private async set(cmd: number, offset: number, data: Uint8Array, last: boolean): Promise<void> {
    if (!(await this.opts.allowWrites?.())) throw new Error("Writes are switched off for this keyboard.");
    // The guard lets a write through only while this is on; it goes off again whatever happens.
    this.ctx = { profile: this.ctx.profile, writes: true };
    try {
      const r = P.parseReply(await this.request(P.writeFrame(cmd, offset, data, last), `write area ${cmd} @ ${offset}`));
      if (!r) throw new Error("The keyboard sent a reply this protocol doesn't know.");
    } finally {
      this.ctx = { profile: this.ctx.profile, writes: false };
    }
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  /** Info, base, then (for boards that may be written or shown) the function block and trigger table. */
  async readAll(): Promise<Fw19f5State> {
    const st = this.state;
    st.notes = [];
    try {
      const info = await this.get(P.AREA.info, 0, P.CHUNK);
      st.firmware = P.decodeFirmware(info);
      st.answered = true;
    } catch (e) {
      if (!(e instanceof NoAnswerError)) throw e;
      st.answered = false;
      st.notes.push(
        this.model.family === "nuphy"
          ? "This keyboard didn't answer in the plain 0x55 protocol. NuPhy's newest firmware masks its traffic with a per-session key, and SYNQ has no documentation for that, so it is only listed."
          : this.model.family === "drunkdeer"
            ? "This keyboard didn't answer. DrunkDeer's OEM relabels may answer on a collection Windows doesn't let apps read, so it is only listed."
            : "This keyboard didn't answer in the plain 0x55 protocol, so it is only listed.",
      );
      return st;
    }
    const base = P.decodeBase(await this.get(P.AREA.base, 0, P.CHUNK));
    st.base = base;
    if (!base.valid) st.notes.push("The keyboard's profile information looks unusual, so SYNQ treats profile 1 as the active one.");
    this.ctx = { profile: base.profile, writes: this.ctx.writes };
    const family = guardFamilyOf(this.model.family);
    if (family === "readonly" || !this.units) {
      st.unitsOk = false;
      st.unitsWhy = family === "readonly" ? "SYNQ only reads this keyboard's firmware version." : "This keyboard's travel unit isn't known.";
      return st;
    }
    if (family === "mchose") st.func = await this.get(P.AREA.funcGet, P.funcOffset(base.profile), P.BLOCK.func);
    await this.readTriggers();
    return st;
  }

  /** Re-reads the whole key-trigger table of the active profile and judges the unit. */
  async readTriggers(): Promise<Uint8Array> {
    const st = this.state;
    const units = this.units!;
    const profile = this.ctx.profile ?? 0;
    const n = Math.min(this.model.board?.maxKeyCount ?? this.model.travel?.maxKeyCount ?? P.MAX_KEYS, P.MAX_KEYS);
    const table = await this.get(P.AREA.triggerGet, P.triggerOffset(profile), n * P.TRIGGER_BYTES);
    st.triggers = table;
    const board = this.model.board;
    const layoutKeys = board ? layoutOf(board) : null;
    const layoutSlots = layoutKeys ? layoutKeys.map((k) => k[0]) : null;
    const typedSlots = layoutKeys ? layoutKeys.filter((k) => k[1] !== 0).map((k) => k[0]) : null;
    const live: number[] = [];
    for (let slot = 0; slot < n; slot++) if (P.plausible(P.triggerAt(table, slot, units), units)) live.push(slot);
    st.keys = layoutSlots ? layoutSlots.filter((s) => s < n && live.includes(s)) : live;
    // Unit check (FCC `unitsOk`): every key the layout names must read as a real travel in these units. Without
    // a layout (DrunkDeer gen 2, shared ids), the records that look live must be nearly all plausible.
    if (layoutSlots && typedSlots) {
      const bad = typedSlots.filter((s) => s < n && !live.includes(s));
      st.unitsOk = bad.length === 0 && typedSlots.length > 0;
      st.unitsWhy = st.unitsOk ? "" : `${bad.length} of ${typedSlots.length} keys read as impossible travel at ${units.step} units per mm, so actuation changes are off.`;
    } else {
      const liveRecords = Array.from({ length: n }, (_, s) => P.triggerAt(table, s, units)).filter((t) => t.live);
      st.unitsOk = st.keys.length >= 10 && st.keys.length >= liveRecords.length * 0.9;
      st.unitsWhy = st.unitsOk ? "" : "The key records don't read as travel at the expected unit, so actuation changes are off.";
    }
    return table;
  }

  /** Re-reads the active profile's function block. */
  async readFunc(): Promise<Uint8Array> {
    const block = await this.get(P.AREA.funcGet, P.funcOffset(this.ctx.profile ?? 0), P.BLOCK.func);
    this.state.func = block;
    return block;
  }

  /** The decoded settings of one slot, from the last read. */
  analogOf(slot: number): AnalogRead | null {
    const t = this.state.triggers;
    if (!t || !this.units) return null;
    const x = P.triggerAt(t, slot, this.units);
    return { actuationMm: x.actuationMm, rapidTrigger: x.rapidTrigger, rtPressMm: x.rtPressMm, rtReleaseMm: x.rtReleaseMm };
  }

  // -------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------

  private requireWrites(): void {
    const w = this.canWrite;
    if (!w.ok) throw new Error(w.why);
  }

  /**
   * Actuation / rapid trigger on these slots (all of the board's keys when `slots` is "all"). A key in an
   * advanced mode (dynamic keystroke or similar) keeps it: the rapid-trigger switch skips such keys, and the
   * plan is refused when that leaves nothing to change.
   */
  planAnalog(slots: readonly number[] | "all", patch: P.TriggerPatch): Fw19f5Plan<Record<number, AnalogRead>> {
    this.requireWrites();
    const units = this.units!;
    const keys = (slots === "all" ? this.state.keys : [...slots]).filter((s, i, a) => a.indexOf(s) === i);
    if (!keys.length) throw new Error("No keys to change.");
    for (const s of keys) if (!this.state.keys.includes(s)) throw new Error(`Slot ${s} isn't a key on this keyboard.`);
    if (patch.actuationMm === undefined && patch.rapidTrigger === undefined && patch.rtPressMm === undefined && patch.rtReleaseMm === undefined) throw new Error("Nothing to change.");
    const at = (table: Uint8Array, s: number) => table.subarray(s * P.TRIGGER_BYTES, s * P.TRIGGER_BYTES + P.TRIGGER_BYTES);
    /** What to change on one record: the rapid-trigger switch is dropped for an advanced mode; null when nothing is left. */
    const patchFor = (rec: Uint8Array): P.TriggerPatch | null => {
      const mode = rec[1] & 15;
      if (patch.rapidTrigger === undefined || mode === 0 || mode === 1) return patch;
      const { rapidTrigger: _skipped, ...rest } = patch;
      return Object.keys(rest).length ? rest : null;
    };
    // Validate against the cached table now, so a bad value is refused before anything is sent.
    const table = this.state.triggers!;
    const effective = keys.filter((s) => patchFor(at(table, s)) !== null);
    if (!effective.length) throw new Error("Those keys use an advanced mode (dynamic keystroke or similar) that SYNQ leaves alone.");
    for (const s of effective) P.patchTrigger(at(table, s), patchFor(at(table, s))!, units);
    const expected: Record<number, AnalogRead> = {};
    const read = (t: P.Trigger): AnalogRead => ({ actuationMm: t.actuationMm, rapidTrigger: t.rapidTrigger, rtPressMm: t.rtPressMm, rtReleaseMm: t.rtReleaseMm });
    const profile = this.ctx.profile ?? 0;
    const flagLast = this.model.family === "drunkdeer";
    return {
      label: `Analog settings on ${effective.length === 1 ? "1 key" : `${effective.length} keys`}`,
      get expected() {
        return expected;
      },
      persistence: "saved",
      send: async () => {
        const fresh = await this.readTriggers();
        const next = Uint8Array.from(fresh);
        for (const s of effective) {
          const p = patchFor(at(fresh, s));
          if (p) next.set(P.patchTrigger(at(fresh, s), p, units), s * P.TRIGGER_BYTES);
          // What the board should hold afterwards: the patched record as the board will decode it.
          expected[s] = read(P.triggerAt(next, s, units));
        }
        const runs = P.changedRuns(fresh, next);
        for (let i = 0; i < runs.length; i++) {
          const [from, to] = runs[i];
          await this.set(P.AREA.triggerSet, P.triggerOffset(profile) + from, next.slice(from, to), flagLast && i === runs.length - 1);
        }
      },
      readBack: async () => {
        await this.readTriggers();
        const got: Record<number, AnalogRead> = {};
        for (const s of effective) got[s] = this.analogOf(s)!;
        return got;
      },
    };
  }

  /** A change to the function block (MCHOSE): flags, sleep, lighting. */
  planFunc(patch: P.FuncPatch, label: string): Fw19f5Plan<P.FuncSettings> {
    this.requireWrites();
    if (guardFamilyOf(this.model.family) !== "mchose") throw new Error("Only MCHOSE boards take these changes.");
    if (!this.state.func) throw new Error("The keyboard's settings haven't been read.");
    P.patchFunc(this.state.func, patch);
    const profile = this.ctx.profile ?? 0;
    let expected: P.FuncSettings = P.decodeFunc(P.patchFunc(this.state.func, patch));
    return {
      label,
      get expected() {
        return expected;
      },
      persistence: "saved",
      send: async () => {
        const fresh = await this.readFunc();
        const next = P.patchFunc(fresh, patch);
        expected = P.decodeFunc(next);
        if (next.every((b, i) => b === fresh[i])) return;
        for (const w of P.funcWrites(profile, next)) await this.set(P.AREA.funcSet, w.offset, w.data, false);
      },
      readBack: async () => P.decodeFunc(await this.readFunc()),
    };
  }
}
