// A SparkLink-family session over a GuardedChannel (src/lib/brands/local-kb.ts).
//
// connect = check the USB id and the 0xFFA0:0x0001 collection (never a board whose sync reply says it is in its
// bootloader) -> board info, protocol version, name, travel range, Windows / Mac mode, report rate, configuration ->
// the default key table -> global travel and every key's mode, actuation, rapid trigger and dead zones. A board that
// doesn't answer is kept as "listed, didn't answer": nothing else is read or sent.
//
// Writes are plans: send() then readBack(), so src/lib/kb's KbSession can wrap them 1:1. A write needs the
// "Allow changes" switch (allowWrites), a travel range the board reported, values in range, and a key the board's own
// table names. send() re-reads what it patches first, so only the fields the change names are written; a key in an
// advanced mode (dynamic keystroke and the like) is left alone. Whether the board stores a change across a power cycle
// is not documented by the SDK: every plan says "not verified".
//
// Pacing: one request in flight, the next goes out when its reply is in; a missing reply is retried (3 tries, 20 ms
// apart, 1 s per try for the first reads, shorter for optional ones).

import { GuardedChannel, sleep, type FrameLog, type HidLike, type SupportTier } from "../local-kb.ts";
import { SPARKLINK_CHANNEL, isKochi, sparklinkModel, type SparkLinkModel } from "./devices.ts";
import { guardFor, type GuardContext } from "./guard.ts";
import * as P from "./protocol.ts";

export const TIMING = { replyTimeoutMs: 1000, optionalTimeoutMs: 450, tries: 3, retryGapMs: 20 } as const;

export interface SparkLinkSessionOptions {
  /** Asked before every write. Default: never. */
  allowWrites?: () => boolean | Promise<boolean>;
  log?: FrameLog;
  /** Per-try timeout (default 1000 ms). */
  timeoutMs?: number;
}

/** Why a session could not read the keyboard. */
export class NoAnswerError extends Error {
  constructor(what: string, ms: number) {
    super(`No answer from the keyboard within ${ms} ms (${what}).`);
    this.name = "NoAnswerError";
  }
}

/** The board answered with its "refused" reply (command class 0xFF). */
export class RefusedError extends Error {
  constructor(what: string) {
    super(`The keyboard refused that (${what}).`);
    this.name = "RefusedError";
  }
}

export interface SparkKey {
  /** The key's default key value (a HID usage; 1 = Fn): how the board addresses it. */
  key: number;
  row: number;
  col: number;
  /** row * 21 + col: the panel's key index. */
  index: number;
}

/** One key's settings as the board holds them. Distances in mm; null when the board didn't answer that layout. */
export interface KeyRead {
  touch: P.Touch;
  /** Advanced-key mode (dynamic keystroke and the like), 0 for none. */
  adv: number;
  travelMm: number | null;
  rtPressMm: number | null;
  rtReleaseMm: number | null;
  deadTopMm: number | null;
  deadBottomMm: number | null;
}

export interface GlobalRead {
  /** The travel the keys in global mode actuate at. */
  travelMm: number;
  /** The dead zones the global message reports; AureTrix notes they are not reliable, so the panel reads the keys' own (globalDead). */
  dbDeadTopMm: number;
  dbDeadBottomMm: number;
}

export interface SparkLinkState {
  answered: boolean;
  sync: P.SyncInfo | null;
  protocol: string | null;
  name: string | null;
  precision: P.Precision | null;
  keys: SparkKey[];
  /** Key values two physical keys share: such keys can't be addressed one at a time. */
  ambiguous: number[];
  global: GlobalRead | null;
  perKey: Map<number, KeyRead>;
  /** The board answered the travel reads in range: the analog section is shown. */
  analog: boolean;
  unitsOk: boolean;
  unitsWhy: string;
  /** true Windows mode, false Mac mode, null when the board has no such switch. */
  winMode: boolean | null;
  rateHz: number | null;
  configId: number | null;
  notes: string[];
}

export interface SparkLinkPlan<T> {
  label: string;
  expected: T;
  persistence: "saved" | "volatile" | "unknown";
  send(): Promise<void>;
  readBack(): Promise<T>;
}

/** The fields of an analog change; distances in mm. */
export interface AnalogPatch {
  actuationMm?: number;
  rapidTrigger?: boolean;
  rtPressMm?: number;
  rtReleaseMm?: number;
  deadTopMm?: number;
  deadBottomMm?: number;
}

/** What a model's tier lets SYNQ do. */
export function tierAllowsWrites(tier: SupportTier): boolean {
  return tier === "experimental" || tier === "community" || tier === "verified";
}

const id4 = (vid: number, pid: number) => `${vid.toString(16).padStart(4, "0")}:${pid.toString(16).padStart(4, "0")}`;
const KEY_ORDER = ["touch", "travelMm", "rtPressMm", "rtReleaseMm", "deadTopMm", "deadBottomMm"] as const;
type KeyField = (typeof KEY_ORDER)[number];

export class SparkLinkSession {
  readonly hid: HidLike;
  readonly model: SparkLinkModel;
  readonly channel: GuardedChannel;
  state: SparkLinkState;
  private readonly opts: SparkLinkSessionOptions;
  private ctx: GuardContext = { keys: null, writes: false };
  private chain: Promise<unknown> = Promise.resolve();
  private waiter: { request: Uint8Array; resolve: (d: Uint8Array) => void } | null = null;
  private readonly unsubscribe: () => void;

  private constructor(hid: HidLike, model: SparkLinkModel, opts: SparkLinkSessionOptions) {
    this.hid = hid;
    this.model = model;
    this.opts = opts;
    this.channel = new GuardedChannel(hid, guardFor(() => this.ctx), SPARKLINK_CHANNEL, opts.log);
    this.unsubscribe = this.channel.onInput((d) => this.onInput(d));
    this.state = this.blank();
  }

  private blank(): SparkLinkState {
    return {
      answered: false,
      sync: null,
      protocol: null,
      name: null,
      precision: null,
      keys: [],
      ambiguous: [],
      global: null,
      perKey: new Map(),
      analog: false,
      unitsOk: false,
      unitsWhy: "Not read yet.",
      winMode: null,
      rateHz: null,
      configId: null,
      notes: [],
    };
  }

  /** Checks the USB id and collection, then reads. Throws without sending anything for ids SYNQ doesn't open. */
  static async connect(hid: HidLike, opts: SparkLinkSessionOptions = {}): Promise<SparkLinkSession> {
    const id = id4(hid.vendorId, hid.productId);
    const model = sparklinkModel(hid.vendorId, hid.productId);
    if (!model) throw new Error(`${id} is not a SparkLink keyboard id that SYNQ knows.`);
    const c = SPARKLINK_CHANNEL;
    if (hid.collections && hid.collections.length > 0 && !hid.collections.some((x) => x.usagePage === c.usagePage && (x.usage ?? 0) === c.usage))
      throw new Error(`${id}: this handle isn't the vendor collection 0xFFA0:0x0001 these keyboards are configured on.`);
    const s = new SparkLinkSession(hid, model, opts);
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
    if (!tierAllowsWrites(this.model.tier)) return { ok: false, why: "This keyboard is read-only in SYNQ." };
    if (!this.state.answered) return { ok: false, why: "The keyboard didn't answer, so nothing can be changed." };
    return { ok: true, why: "" };
  }

  /** Writes to key settings need the travel range as well. */
  get canWriteKeys(): { ok: boolean; why: string } {
    const w = this.canWrite;
    if (!w.ok) return w;
    if (!this.state.analog) return { ok: false, why: "This keyboard didn't report key travel settings." };
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
  private request(frame: Uint8Array, label: string, o: { timeoutMs?: number; tries?: number } = {}): Promise<P.Message> {
    return this.exclusive(async () => {
      const ms = o.timeoutMs ?? this.opts.timeoutMs ?? TIMING.replyTimeoutMs;
      const tries = o.tries ?? TIMING.tries;
      let last: unknown;
      for (let attempt = 0; attempt < tries; attempt++) {
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
          const raw = await answer;
          const r = P.parseReply(raw);
          if (!r) throw new Error("The keyboard sent a reply this protocol doesn't know.");
          if (r.failed) throw new RefusedError(label);
          return r;
        } catch (e) {
          if (!(e instanceof NoAnswerError)) throw e;
          last = e;
          await sleep(TIMING.retryGapMs);
        } finally {
          clearTimeout(timer);
        }
      }
      throw last instanceof Error ? last : new NoAnswerError(label, ms);
    });
  }

  /** An optional read: null when the board doesn't answer or refuses it. */
  private async tryOrder(type: number, label: string): Promise<Uint8Array | null> {
    try {
      return (await this.request(P.orderFrame(type), label, { timeoutMs: TIMING.optionalTimeoutMs, tries: 2 })).data;
    } catch (e) {
      if (e instanceof NoAnswerError || e instanceof RefusedError) return null;
      throw e;
    }
  }

  private async write(frame: Uint8Array, label: string): Promise<P.Message> {
    if (!(await this.opts.allowWrites?.())) throw new Error("Writes are switched off for this keyboard.");
    // The guard lets a write through only while this is on; it goes off again whatever happens.
    this.ctx = { keys: this.ctx.keys, writes: true };
    try {
      return await this.request(frame, label, { tries: 2 });
    } finally {
      this.ctx = { keys: this.ctx.keys, writes: false };
    }
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  /** Board info, orders, the key table, then (when the board reports a travel range) global travel and every key. */
  async readAll(): Promise<SparkLinkState> {
    const st = this.blank();
    this.state = st;
    this.ctx = { keys: null, writes: false };
    try {
      st.sync = P.decodeSync((await this.request(P.syncFrame(), "board info")).data);
      st.answered = true;
    } catch (e) {
      if (!(e instanceof NoAnswerError)) throw e;
      st.notes.push("This keyboard didn't answer, so it is only listed.");
      return st;
    }
    if (st.sync.bootloader) {
      st.answered = false;
      throw new Error("This keyboard is in its update (boot) mode. SYNQ never opens a keyboard in that mode.");
    }
    const get = async (type: number, label: string) => this.tryOrder(type, label);
    const ver = await get(P.ORDER.protocolVersion, "protocol version");
    st.protocol = ver ? P.decodeProtocolVersion(ver) : null;
    const nm = await get(P.ORDER.keyboardName, "keyboard name");
    st.name = nm ? P.decodeName(nm) || null : null;
    const pr = await get(P.ORDER.precisionStroke, "travel range");
    st.precision = pr ? P.decodePrecision(pr) : null;
    const win = await get(P.ORDER.queryWin, "Windows mode");
    const mac = await get(P.ORDER.queryMac, "Mac mode");
    const w = win ? P.decodeModeQuery(win) : null;
    const m = mac ? P.decodeModeQuery(mac) : null;
    st.winMode = w !== null && m !== null && w !== m ? w : null;
    const rate = await get(P.ORDER.rateOfReturn, "report rate");
    st.rateHz = rate ? P.decodeRate(rate) : null;
    const cfg = await get(P.ORDER.config, "configuration");
    st.configId = cfg ? P.decodeConfig(cfg) : null;

    await this.readKeyTable();
    if (st.keys.length && st.precision) await this.readSettings();
    else if (!st.precision) st.unitsWhy = "This keyboard didn't report a travel range.";
    else st.unitsWhy = "This keyboard didn't report its keys.";
    return st;
  }

  private async readKeyTable(): Promise<void> {
    const st = this.state;
    const seen = new Map<number, SparkKey>();
    const dup = new Set<number>();
    for (const [a, b] of [
      [0, 1],
      [2, 3],
      [4, 5],
    ] as const) {
      let reply: P.Message;
      try {
        reply = await this.request(P.defKeyFrame(a, b), `key table rows ${a},${b}`);
      } catch (e) {
        if (e instanceof NoAnswerError || e instanceof RefusedError) {
          st.notes.push("The keyboard's key table couldn't be read in full.");
          continue;
        }
        throw e;
      }
      for (const d of P.decodeDefKeys(reply.data)) {
        if (seen.has(d.value)) dup.add(d.value);
        else seen.set(d.value, { key: d.value, row: d.row, col: d.col, index: d.row * P.MATRIX_COLS + d.col });
      }
    }
    st.ambiguous = [...dup].sort((x, y) => x - y);
    st.keys = [...seen.values()].filter((k) => !dup.has(k.key)).sort((x, y) => x.index - y.index);
    this.ctx = { keys: new Set(st.keys.map((k) => k.key)), writes: this.ctx.writes };
  }

  /** Reads one key's layouts. */
  private async readKey(key: number): Promise<KeyRead | null> {
    const r = await this.request(P.keyReadFrame(key, P.READ_LAYOUTS), `key ${key}`);
    const by = new Map(P.decodeKeyEntries(r.data).filter((e) => e.key === key).map((e) => [e.layout, e.value] as const));
    const modeRaw = by.get(P.LAYOUT.mode);
    if (modeRaw === undefined) return null;
    const mode = P.decodeMode(modeRaw);
    const dist = (layout: number) => {
      const v = by.get(layout);
      return v === undefined ? null : P.mm(v);
    };
    return { touch: mode.touch, adv: mode.adv, travelMm: dist(P.LAYOUT.db0), rtPressMm: dist(P.LAYOUT.rtp), rtReleaseMm: dist(P.LAYOUT.rtr), deadTopMm: dist(P.LAYOUT.dp), deadBottomMm: dist(P.LAYOUT.dr) };
  }

  private async readSettings(): Promise<void> {
    const st = this.state;
    const prec = st.precision!;
    try {
      const g = P.decodeDb((await this.request(P.dbReadFrame(), "global travel")).data);
      st.global = { travelMm: P.mm(g.travel), dbDeadTopMm: P.mm(g.pressDead), dbDeadBottomMm: P.mm(g.releaseDead) };
    } catch (e) {
      if (!(e instanceof NoAnswerError || e instanceof RefusedError)) throw e;
      st.notes.push("The keyboard's global travel setting couldn't be read.");
    }
    let failed = 0;
    for (const k of st.keys) {
      try {
        const r = await this.readKey(k.key);
        if (r) st.perKey.set(k.key, r);
        else failed++;
      } catch (e) {
        if (!(e instanceof NoAnswerError || e instanceof RefusedError)) throw e;
        failed++;
        if (failed >= 4 && st.perKey.size === 0) break;
      }
    }
    if (failed) st.notes.push(`${failed} of ${st.keys.length} keys didn't report their settings.`);
    // Unit check: the board's own travel range must be sane and every value read must sit inside it.
    const sane = prec.stepMm > 0 && prec.stepMm <= 0.1 && prec.minMm >= 0 && prec.maxMm > prec.minMm && prec.maxMm <= P.MAX_TRAVEL_UM / 1000;
    const values = [...st.perKey.values()].flatMap((r) => [r.travelMm, r.rtPressMm, r.rtReleaseMm, r.deadTopMm, r.deadBottomMm]).filter((v): v is number => v !== null);
    if (st.global) values.push(st.global.travelMm, st.global.dbDeadTopMm, st.global.dbDeadBottomMm);
    const stray = values.filter((v) => v > prec.maxMm + 1e-9).length;
    st.analog = st.perKey.size > 0 && st.perKey.size >= st.keys.length * 0.6;
    st.unitsOk = st.analog && sane && stray === 0;
    st.unitsWhy = !st.analog ? "This keyboard didn't report key travel settings." : !sane ? "The keyboard's travel range looks unusual, so key changes are off." : stray ? `${stray} travel values are beyond the keyboard's own maximum, so key changes are off.` : "";
  }

  // -------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------

  private requireKeyWrites(): void {
    const w = this.canWriteKeys;
    if (!w.ok) throw new Error(w.why);
  }

  /** Rounds a distance to the board's step and checks it against its range. */
  private checkMm(v: number, lo: number, what: string): number {
    const prec = this.state.precision!;
    const step = prec.stepMm > 0 ? prec.stepMm : 0.01;
    const snapped = Math.round(v / step + 1e-9) * step;
    const hi = prec.maxMm;
    if (!Number.isFinite(v) || snapped < lo - 1e-9 || snapped > hi + 1e-9) throw new RangeError(`${what} must be ${lo} to ${hi} mm.`);
    return Math.round(snapped * 1000) / 1000;
  }

  /** The keyboard's range for an actuation, a rapid-trigger distance and a dead zone. */
  ranges(): { actuation: [number, number]; rt: [number, number]; dead: [number, number]; step: number } | null {
    const p = this.state.precision;
    if (!p) return null;
    const step = p.stepMm > 0 ? p.stepMm : 0.01;
    return { actuation: [Math.max(p.minMm, step), p.maxMm], rt: [step, p.maxMm], dead: [0, p.maxMm], step };
  }

  /** The dead zones of the keys in global mode: the value most of them hold (the global message's own are not reliable). */
  globalDead(): { top: number | null; bottom: number | null } {
    const keys = [...this.state.perKey.values()].filter((k) => k.touch === "global");
    const common = (f: (k: KeyRead) => number | null, fallback: number | null): number | null => {
      const counts = new Map<number, number>();
      for (const k of keys) {
        const v = f(k);
        if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      let best: number | null = null;
      let n = 0;
      for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
      return best ?? fallback;
    };
    const g = this.state.global;
    return { top: common((k) => k.deadTopMm, g?.dbDeadTopMm ?? null), bottom: common((k) => k.deadBottomMm, g?.dbDeadBottomMm ?? null) };
  }

  /**
   * The default (global-mode) travel and dead zones. The travel goes in the global message; the dead zones go in it too
   * and onto every key still in global mode, which is how AureTrix applies them (a key's dead zones are its own).
   */
  planGlobal(patch: Pick<AnalogPatch, "actuationMm" | "deadTopMm" | "deadBottomMm">): SparkLinkPlan<Partial<Record<"travelMm" | "deadTopMm" | "deadBottomMm", number>>> {
    this.requireKeyWrites();
    const st = this.state;
    if (!st.global) throw new Error("This keyboard's global travel setting couldn't be read.");
    if (patch.actuationMm === undefined && patch.deadTopMm === undefined && patch.deadBottomMm === undefined) throw new Error("Nothing to change.");
    const r = this.ranges()!;
    const want: Partial<Record<"travelMm" | "deadTopMm" | "deadBottomMm", number>> = {};
    if (patch.actuationMm !== undefined) want.travelMm = this.checkMm(patch.actuationMm, r.actuation[0], "Actuation");
    if (patch.deadTopMm !== undefined) want.deadTopMm = this.checkMm(patch.deadTopMm, r.dead[0], "Top dead zone");
    if (patch.deadBottomMm !== undefined) want.deadBottomMm = this.checkMm(patch.deadBottomMm, r.dead[0], "Bottom dead zone");
    const globalKeys = () => st.keys.filter((k) => st.perKey.get(k.key)?.touch === "global" && st.perKey.get(k.key)?.adv === 0).map((k) => k.key);
    const readDb = async () => {
      const g = P.decodeDb((await this.request(P.dbReadFrame(), "global travel")).data);
      st.global = { travelMm: P.mm(g.travel), dbDeadTopMm: P.mm(g.pressDead), dbDeadBottomMm: P.mm(g.releaseDead) };
      return g;
    };
    return {
      label: "Default travel settings",
      expected: want,
      persistence: "unknown",
      send: async () => {
        const db = await readDb();
        const dead = this.globalDead();
        const travel = want.travelMm !== undefined ? P.um(want.travelMm) : db.travel;
        const top = want.deadTopMm !== undefined ? P.um(want.deadTopMm) : P.um(dead.top ?? P.mm(db.pressDead));
        const bottom = want.deadBottomMm !== undefined ? P.um(want.deadBottomMm) : P.um(dead.bottom ?? P.mm(db.releaseDead));
        if (travel !== db.travel || top !== db.pressDead || bottom !== db.releaseDead) await this.write(P.dbWriteFrame({ travel, pressDead: top, releaseDead: bottom }), "global travel");
        if (want.deadTopMm === undefined && want.deadBottomMm === undefined) return;
        for (const k of globalKeys()) {
          const cur = await this.readKey(k);
          if (!cur || cur.touch !== "global" || cur.adv !== 0) continue;
          st.perKey.set(k, cur);
          if (want.deadTopMm !== undefined && cur.deadTopMm !== want.deadTopMm) await this.write(P.keyWriteFrame(k, P.LAYOUT.dp, top), `key ${k} top dead zone`);
          if (want.deadBottomMm !== undefined && cur.deadBottomMm !== want.deadBottomMm) await this.write(P.keyWriteFrame(k, P.LAYOUT.dr, bottom), `key ${k} bottom dead zone`);
        }
      },
      readBack: async () => {
        const got: Partial<Record<"travelMm" | "deadTopMm" | "deadBottomMm", number>> = {};
        if (want.travelMm !== undefined) got.travelMm = P.mm((await readDb()).travel);
        if (want.deadTopMm !== undefined || want.deadBottomMm !== undefined) {
          let top = want.deadTopMm;
          let bottom = want.deadBottomMm;
          for (const k of globalKeys()) {
            const cur = await this.readKey(k);
            if (!cur) continue;
            st.perKey.set(k, cur);
            if (want.deadTopMm !== undefined && cur.deadTopMm !== null && cur.deadTopMm !== want.deadTopMm) top = cur.deadTopMm;
            if (want.deadBottomMm !== undefined && cur.deadBottomMm !== null && cur.deadBottomMm !== want.deadBottomMm) bottom = cur.deadBottomMm;
          }
          if (top !== undefined) got.deadTopMm = top;
          if (bottom !== undefined) got.deadBottomMm = bottom;
        }
        return got;
      },
    };
  }

  /** The settings the keys named should hold after `patch`, or null for a key that is left alone. */
  private nextKey(cur: KeyRead, patch: AnalogPatch, fallbackTravel: number): KeyRead | null {
    if (cur.adv !== 0) return null;
    const r = this.ranges()!;
    let touch = cur.touch;
    if (patch.rapidTrigger === true) touch = "rt";
    else if (patch.rapidTrigger === false && touch === "rt") touch = "single";
    if (patch.actuationMm !== undefined && touch === "global") touch = "single";
    const wantsRt = patch.rtPressMm !== undefined || patch.rtReleaseMm !== undefined;
    if (wantsRt && touch !== "rt") throw new Error("Rapid-trigger distances need rapid trigger turned on for those keys.");
    const own = touch !== "global";
    const next: KeyRead = { ...cur, touch };
    // A key that gets its own mode keeps the travel it effectively had.
    if (own) next.travelMm = patch.actuationMm !== undefined ? this.checkMm(patch.actuationMm, r.actuation[0], "Actuation") : touch !== cur.touch && cur.touch === "global" ? fallbackTravel : cur.travelMm;
    if (touch === "rt") {
      next.rtPressMm = patch.rtPressMm !== undefined ? this.checkMm(patch.rtPressMm, r.rt[0], "Rapid-trigger press distance") : cur.rtPressMm;
      next.rtReleaseMm = patch.rtReleaseMm !== undefined ? this.checkMm(patch.rtReleaseMm, r.rt[0], "Rapid-trigger release distance") : cur.rtReleaseMm;
      if (!next.rtPressMm || !next.rtReleaseMm) throw new Error("Rapid trigger needs a press and a release distance.");
    }
    if (patch.deadTopMm !== undefined) next.deadTopMm = this.checkMm(patch.deadTopMm, r.dead[0], "Top dead zone");
    if (patch.deadBottomMm !== undefined) next.deadBottomMm = this.checkMm(patch.deadBottomMm, r.dead[0], "Bottom dead zone");
    return next;
  }

  /** Which fields of a key a change touches, in KEY_ORDER. */
  private fieldsOf(patch: AnalogPatch, next: KeyRead): KeyField[] {
    const f = new Set<KeyField>(["touch"]);
    if (next.touch !== "global") f.add("travelMm");
    if (next.touch === "rt") {
      f.add("rtPressMm");
      f.add("rtReleaseMm");
    }
    if (patch.deadTopMm !== undefined) f.add("deadTopMm");
    if (patch.deadBottomMm !== undefined) f.add("deadBottomMm");
    return KEY_ORDER.filter((k) => f.has(k));
  }

  private pick(read: KeyRead, fields: readonly KeyField[]): Partial<Record<KeyField, unknown>> {
    const out: Partial<Record<KeyField, unknown>> = {};
    for (const k of fields) out[k] = read[k];
    return out;
  }

  /**
   * Settings on these keys (default key values; all of the board's keys when `keys` is "all"). A key in an advanced
   * mode keeps it: it is skipped, and the plan is refused when that leaves nothing to change.
   */
  planKeys(keys: readonly number[] | "all", patch: AnalogPatch): SparkLinkPlan<Record<number, Partial<Record<KeyField, unknown>>>> {
    this.requireKeyWrites();
    const st = this.state;
    const wanted = (keys === "all" ? st.keys.map((k) => k.key) : [...keys]).filter((k, i, a) => a.indexOf(k) === i);
    if (!wanted.length) throw new Error("No keys to change.");
    for (const k of wanted) if (!st.keys.some((x) => x.key === k)) throw new Error(`Key ${k} isn't a key this keyboard reported.`);
    if (Object.values(patch).every((v) => v === undefined)) throw new Error("Nothing to change.");
    const fallback = st.global?.travelMm ?? 0;
    const plan = new Map<number, { next: KeyRead; fields: KeyField[] }>();
    for (const k of wanted) {
      const cur = st.perKey.get(k);
      if (!cur) continue;
      const next = this.nextKey(cur, patch, fallback);
      if (next) plan.set(k, { next, fields: this.fieldsOf(patch, next) });
    }
    if (!plan.size) throw new Error("Those keys use an advanced mode (dynamic keystroke or similar) that SYNQ leaves alone.");
    const expected: Record<number, Partial<Record<KeyField, unknown>>> = {};
    for (const [k, p] of plan) expected[k] = this.pick(p.next, p.fields);
    const apply = async (k: number, next: KeyRead, cur: KeyRead) => {
      const layouts: [number, number][] = [];
      if (next.touch !== cur.touch) layouts.push([P.LAYOUT.mode, P.modeValue(next.touch)]);
      if (next.touch !== "global" && next.travelMm !== null && next.travelMm !== cur.travelMm) layouts.push([P.LAYOUT.db0, P.um(next.travelMm)]);
      if (next.touch === "rt") {
        if (next.rtPressMm !== null && next.rtPressMm !== cur.rtPressMm) layouts.push([P.LAYOUT.rtp, P.um(next.rtPressMm)]);
        if (next.rtReleaseMm !== null && next.rtReleaseMm !== cur.rtReleaseMm) layouts.push([P.LAYOUT.rtr, P.um(next.rtReleaseMm)]);
      }
      if (next.deadTopMm !== null && next.deadTopMm !== cur.deadTopMm) layouts.push([P.LAYOUT.dp, P.um(next.deadTopMm)]);
      if (next.deadBottomMm !== null && next.deadBottomMm !== cur.deadBottomMm) layouts.push([P.LAYOUT.dr, P.um(next.deadBottomMm)]);
      // A key leaving rapid trigger or global mode is written in the order that never leaves it half-set: travel values first, the mode last when it turns something on.
      const modeFirst = next.touch === "global";
      const ordered = [...layouts].sort((a, b) => (a[0] === P.LAYOUT.mode ? (modeFirst ? -1 : 1) : b[0] === P.LAYOUT.mode ? (modeFirst ? 1 : -1) : 0));
      for (const [layout, value] of ordered) await this.write(P.keyWriteFrame(k, layout, value), `key ${k} layout ${layout}`);
    };
    return {
      label: `Analog settings on ${plan.size === 1 ? "1 key" : `${plan.size} keys`}`,
      expected,
      persistence: "unknown",
      send: async () => {
        for (const [k, p] of plan) {
          // Patch what the board holds now, not what was read at connect.
          const cur = (await this.readKey(k)) ?? st.perKey.get(k)!;
          if (cur.adv !== 0) continue;
          st.perKey.set(k, cur);
          const next = this.nextKey(cur, patch, st.global?.travelMm ?? fallback) ?? p.next;
          expected[k] = this.pick(next, p.fields);
          await apply(k, next, cur);
        }
      },
      readBack: async () => {
        const got: Record<number, Partial<Record<KeyField, unknown>>> = {};
        for (const [k, p] of plan) {
          const r = await this.readKey(k);
          if (!r) continue;
          st.perKey.set(k, r);
          got[k] = this.pick(r, p.fields);
        }
        return got;
      },
    };
  }

  /** Switch Windows / Mac mode (the board must report that it has the switch). */
  planSystemMode(mode: "win" | "mac"): SparkLinkPlan<"win" | "mac"> {
    const w = this.canWrite;
    if (!w.ok) throw new Error(w.why);
    if (this.state.winMode === null) throw new Error("This keyboard has no Windows / Mac switch.");
    return {
      label: `${mode === "win" ? "Windows" : "Mac"} mode`,
      expected: mode,
      persistence: "unknown",
      send: async () => {
        const type = mode === "win" ? P.ORDER.setWin : P.ORDER.setMac;
        const r = await this.write(P.orderFrame(type), "system mode");
        if (!P.decodeModeAck(r.data)) throw new Error("The keyboard did not acknowledge the mode change.");
      },
      readBack: async () => {
        const win = P.decodeModeQuery((await this.request(P.orderFrame(P.ORDER.queryWin), "Windows mode")).data);
        const mac = P.decodeModeQuery((await this.request(P.orderFrame(P.ORDER.queryMac), "Mac mode")).data);
        if (win === null || mac === null || win === mac) throw new Error("The keyboard did not report a consistent Windows / Mac mode.");
        this.state.winMode = win;
        return win ? "win" : "mac";
      },
    };
  }

  /** True for the one board whose mode switch a third party exercised, once its name checks out. */
  get modeSwitchTested(): boolean {
    return isKochi(this.model.vendorId, this.model.productId) && this.state.name === "KOCHI68";
  }
}
