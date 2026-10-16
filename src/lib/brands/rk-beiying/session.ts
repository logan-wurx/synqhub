// A Royal Kludge BeiYing session over a GuardedChannel (src/lib/brands/local-kb.ts).
//
// These boards never answer: there is nothing to read, so connecting sends nothing. SYNQ keeps what it last sent
// (the "shadow": lighting, and the key-map overrides on top of the board's default map) in a small store on this PC,
// shows that, and says so. Every change sends feature reports through the guard (guard.ts) and can only ever be
// "unconfirmed". A key change rewrites the whole base-layer map from the shadow (the firmware can't take one key);
// a lighting change is one report.
//
// Writes need: the board's tier (always "Allow changes"), allowWrites() saying yes, a known mode number, and for the
// key map a board whose every default code is known (`board.keymap`). Pacing: reports go out one after another,
// as Rangoli and KludgeKnight send them.

import { GuardedChannel, sleep, type FrameLog, type HidLike } from "../local-kb.ts";
import { RK_CHANNEL, defaultCodes, offeredModes, rkModel, type RkMode, type RkModel } from "./devices.ts";
import { guardFor, type GuardContext } from "./guard.ts";
import * as P from "./protocol.ts";

export interface RkShadow {
  lighting: P.Lighting;
  /** slot -> code, only where it differs from the board's default. */
  overrides: Record<number, number>;
  /** Whether this PC has ever sent that group to this board; before that the shadow is just the defaults. */
  sent: { lighting: boolean; keymap: boolean };
}

/** Where the shadow is kept between runs. Failures are never fatal: the shadow then lasts for the session. */
export interface ShadowStore {
  load(id: string): RkShadow | null;
  save(id: string, shadow: RkShadow): void;
}

export const memoryShadowStore = (): ShadowStore & { data: Map<string, RkShadow> } => {
  const data = new Map<string, RkShadow>();
  return {
    data,
    load: (id) => (data.has(id) ? structuredClone(data.get(id)!) : null),
    save: (id, s) => void data.set(id, structuredClone(s)),
  };
};

/** localStorage, always inside try/catch (private windows and blocked storage throw); memory when it isn't there. */
export function browserShadowStore(prefix = "onboard.rk-beiying."): ShadowStore {
  const fallback = memoryShadowStore();
  return {
    load(id) {
      try {
        const raw = globalThis.localStorage?.getItem(prefix + id);
        if (raw) {
          const v = JSON.parse(raw) as RkShadow;
          if (v && typeof v === "object" && v.lighting && v.overrides) return v;
        }
      } catch {
        /* storage blocked: use the session's copy */
      }
      return fallback.load(id);
    },
    save(id, s) {
      fallback.save(id, s);
      try {
        globalThis.localStorage?.setItem(prefix + id, JSON.stringify(s));
      } catch {
        /* storage blocked: the session's copy is all there is */
      }
    },
  };
}

export interface RkSessionOptions {
  /** Asked before every report. Default: never. */
  allowWrites?: () => boolean | Promise<boolean>;
  log?: FrameLog;
  store?: ShadowStore;
  /** Pause between the reports of one transfer, ms (default 0: back to back, as the other tools send them). */
  gapMs?: number;
}

export interface RkPlan {
  label: string;
  expected: unknown;
  persistence: "saved" | "volatile" | "unknown";
  caution?: string;
  send(): Promise<void>;
}

export const SWAP_RED_GREEN = "swap-red-green";
const id4 = (vid: number, pid: number) => `${vid.toString(16).padStart(4, "0")}:${pid.toString(16).padStart(4, "0")}`;

export class RkSession {
  readonly hid: HidLike;
  readonly model: RkModel;
  readonly channel: GuardedChannel;
  readonly modes: readonly RkMode[];
  shadow: RkShadow;
  private readonly opts: RkSessionOptions;
  private readonly store: ShadowStore;
  private readonly defaults: Map<number, number>;
  private ctx: GuardContext;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(hid: HidLike, model: RkModel, opts: RkSessionOptions) {
    this.hid = hid;
    this.model = model;
    this.opts = opts;
    this.store = opts.store ?? browserShadowStore();
    this.modes = offeredModes(model.board);
    this.defaults = defaultCodes(model.board);
    this.ctx = { modes: this.modes.map((m) => m.n), writes: false, keymap: model.board.keymap };
    this.channel = new GuardedChannel(hid, guardFor(() => this.ctx), RK_CHANNEL, opts.log);
    this.shadow = this.store.load(id4(hid.vendorId, hid.productId)) ?? this.freshShadow();
  }

  /** Checks the USB id and collection. Sends nothing: these boards can't be read. */
  static connect(hid: HidLike, opts: RkSessionOptions = {}): RkSession {
    const id = id4(hid.vendorId, hid.productId);
    const model = rkModel(hid.vendorId, hid.productId);
    if (!model) throw new Error(`${id} is not a Royal Kludge BeiYing keyboard SYNQ knows.`);
    if (hid.collections && hid.collections.length > 0 && !hid.collections.some((c) => c.usagePage === RK_CHANNEL.usagePage && (c.usage ?? 0) === RK_CHANNEL.usage))
      throw new Error(`${id}: this handle isn't the System Control collection 0001:0080 these keyboards are configured through.`);
    if (!model.board.modes.length) throw new Error(`${id}: the table has no lighting modes for this keyboard.`);
    return new RkSession(hid, model, opts);
  }

  private freshShadow(): RkShadow {
    const b = this.model.board;
    const first = this.modes[0]?.n ?? 1;
    const def = b.defMode && this.modes.some((m) => m.n === b.defMode) ? b.defMode : first;
    return {
      lighting: { mode: def, speed: 3, brightness: Math.min(P.BRIGHTNESS.max, Math.max(1, b.defBri ?? 5)), rgb: [255, 255, 255], random: false, sleep: 5 },
      overrides: {},
      sent: { lighting: false, keymap: false },
    };
  }

  get id(): string {
    return id4(this.hid.vendorId, this.hid.productId);
  }

  /** The code in a slot: the override, else the board's default, else nothing. */
  codeOf(slot: number): number {
    return this.shadow.overrides[slot] ?? this.defaults.get(slot) ?? 0;
  }

  modeOf(n: number): RkMode | undefined {
    return this.modes.find((m) => m.n === n);
  }

  /** Whether the session may send the key map of this board. */
  get canRemap(): boolean {
    return this.model.board.keymap;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async sendAll(frames: readonly Uint8Array[]): Promise<void> {
    if (!(await this.opts.allowWrites?.())) throw new Error("Writes are switched off for this keyboard.");
    await this.exclusive(async () => {
      this.ctx = { ...this.ctx, writes: true };
      try {
        for (let i = 0; i < frames.length; i++) {
          if (i > 0 && this.opts.gapMs) await sleep(this.opts.gapMs);
          await this.channel.feature(frames[i]);
        }
      } finally {
        this.ctx = { ...this.ctx, writes: false };
      }
    });
  }

  private persist(): void {
    this.store.save(this.id, this.shadow);
  }

  // -------------------------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------------------------

  /** Lighting: changes the named fields of the last-sent lighting and sends the one report. */
  planLighting(patch: Partial<P.Lighting>, label: string): RkPlan {
    const next: P.Lighting = { ...this.shadow.lighting, ...patch };
    const mode = this.modeOf(next.mode);
    if (!mode) throw new Error(`Mode ${next.mode} isn't one of this keyboard's lighting modes.`);
    const frame = P.encodeLighting(next, this.model.board.quirks.includes(SWAP_RED_GREEN));
    return {
      label,
      expected: next,
      persistence: "unknown",
      send: async () => {
        await this.sendAll([frame]);
        this.shadow = { ...this.shadow, lighting: next, sent: { ...this.shadow.sent, lighting: true } };
        this.persist();
      },
    };
  }

  /** The key map after a change: `code` null puts the board's default back. */
  private mapWith(slot: number, code: number | null): { map: Map<number, number>; overrides: Record<number, number> } {
    if (!this.canRemap) throw new Error("This keyboard's key map isn't offered: not every key's default is known.");
    if (!this.defaults.has(slot)) throw new Error(`Slot ${slot} isn't a key on this keyboard.`);
    const overrides = { ...this.shadow.overrides };
    if (code === null || code === this.defaults.get(slot)) delete overrides[slot];
    else {
      if (P.classifyCode(code).kind === "unknown" || code === 0) throw new Error(`0x${code.toString(16)} isn't a key code this keyboard takes.`);
      overrides[slot] = code;
    }
    const map = new Map<number, number>(this.defaults);
    for (const [s, c] of Object.entries(overrides)) map.set(Number(s), c);
    return { map, overrides };
  }

  /** One key: sets its function (or puts the default back) and sends the whole base-layer map. */
  planKey(slot: number, code: number | null, label: string): RkPlan {
    const { map, overrides } = this.mapWith(slot, code);
    const frames = P.encodeKeymap(map);
    return {
      label,
      expected: { slot, code: code ?? this.defaults.get(slot) },
      persistence: "saved",
      caution: "This keyboard can't report its key map, so SYNQ sends the whole base layer: its own copy of the default map with the changes made from this PC. Remaps made with other tools are replaced.",
      send: async () => {
        await this.sendAll(frames);
        this.shadow = { ...this.shadow, overrides, sent: { ...this.shadow.sent, keymap: true } };
        this.persist();
      },
    };
  }

  /** Every key back to the board's default map. */
  planResetKeys(): RkPlan {
    if (!this.canRemap) throw new Error("This keyboard's key map isn't offered: not every key's default is known.");
    const frames = P.encodeKeymap(this.defaults);
    return {
      label: "All keys back to the default map",
      expected: { reset: true },
      persistence: "saved",
      caution: "Sends the board's default base-layer map: every remap, including ones made with other tools, is replaced.",
      send: async () => {
        await this.sendAll(frames);
        this.shadow = { ...this.shadow, overrides: {}, sent: { ...this.shadow.sent, keymap: true } };
        this.persist();
      },
    };
  }
}
