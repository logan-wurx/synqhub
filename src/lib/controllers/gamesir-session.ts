// GameSir's settings as a session (wave C2): the Cyclone 2, the G7 Pro 8K PC and the Tarantula Pro 8K. The config
// channel takes one command at a time, about 20 ms apart (the pads drop back-to-back commands), and answers on input
// report 0x10. The same safety model as keyboards: `experimental`, writes only while the person's "Allow changes"
// switch is on, a full backup (four profile banks and the lighting bank) before the first change, a read-back after
// every write. Writes only reach the active profile, so a save to another profile switches to it first and back after.
// Every frame passes guard.ts here, and the bridge (pads.rs) or the website's guard checks it again.
import { checkPadOutput } from "./guard.ts";
import {
  CMD,
  GAMESIR_ANSWER,
  GAMESIR_MAPS,
  LIGHT_BANK,
  fieldBytes,
  gamesirAccepts,
  gamesirFields,
  gamesirQuery,
  gamesirReads,
  gamesirSwitch,
  gamesirWrites,
  parseGamesirAnswer,
  type Field,
  type GamesirAnswer,
  type GamesirModel,
} from "./gamesir.ts";
import type { PadGuard } from "./types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

/** Room between two commands (the reference tools: about 20 ms; back-to-back ones are dropped). */
export const GAMESIR_GAP_MS = 20;
/** The pads stream real state, and answer, only while the host sends this query now and then. */
export const GAMESIR_HEARTBEAT_MS = 400;
const ANSWER_MS = 300;
const BUSY_TRIES = 5;

type Frame = { reportId: number; data: Uint8Array };

/** Why a change wasn't made, in words for the page. */
export class GamesirRefused extends Error {}

export const gamesirGuard = (model: GamesirModel): PadGuard => `gamesir-${model}` as PadGuard;

/** One pad's config channel: frames go out one at a time, guard first; answers are matched to what asked for them. */
export class GamesirChannel {
  readonly device: HIDDevice;
  readonly model: GamesirModel;
  readonly guard: PadGuard;
  gapMs: number;
  #queue: Promise<unknown> = Promise.resolve();
  #last = -Infinity;
  readonly #waiters = new Set<(a: GamesirAnswer) => boolean>();
  #listening = false;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  readonly #onInput = (e: Event) => {
    const ev = e as HIDInputReportEvent;
    if (ev.reportId !== GAMESIR_ANSWER) return;
    const a = parseGamesirAnswer(new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength));
    if (!a) return;
    for (const w of [...this.#waiters]) if (w(a)) break;
  };

  constructor(device: HIDDevice, model: GamesirModel, gapMs = GAMESIR_GAP_MS) {
    this.device = device;
    this.model = model;
    this.guard = gamesirGuard(model);
    this.gapMs = gapMs;
  }

  /** Sends one frame when its turn comes; resolves with the answer `expect` accepts (null: none expected, or none came). */
  request(f: Frame, expect: ((a: GamesirAnswer) => boolean) | null, timeoutMs = ANSWER_MS): Promise<GamesirAnswer | null> {
    const run = async (): Promise<GamesirAnswer | null> => {
      const v = checkPadOutput(this.guard, f.reportId, f.data);
      if (!v.ok) throw new GamesirRefused(v.why);
      if (!this.#listening) {
        this.device.addEventListener("inputreport", this.#onInput);
        this.#listening = true;
      }
      // Timers can fire a little early against the real clock (an event loop's cached time): wait until the gap
      // has really passed, since the pads drop a command that follows the last one too closely.
      for (let wait = this.#last + this.gapMs - now(); wait > 0; wait = this.#last + this.gapMs - now()) await sleep(wait);
      let settle: (a: GamesirAnswer | null) => void = () => {};
      const answer = new Promise<GamesirAnswer | null>((r) => (settle = r));
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waiter = (a: GamesirAnswer) => {
        if (!expect?.(a)) return false;
        if (timer) clearTimeout(timer);
        this.#waiters.delete(waiter);
        settle(a);
        return true;
      };
      if (expect) {
        this.#waiters.add(waiter);
        timer = setTimeout(() => {
          this.#waiters.delete(waiter);
          settle(null);
        }, timeoutMs);
      }
      try {
        await this.device.sendReport(f.reportId, f.data as BufferSource);
      } catch (e) {
        if (timer) clearTimeout(timer);
        this.#waiters.delete(waiter);
        throw e;
      } finally {
        this.#last = now();
      }
      return expect ? answer : null;
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    return p;
  }

  /** The keep-alive query, every 0.4 s while a tester or panel is open (nothing changes on the pad). */
  startHeartbeat(): void {
    if (this.#heartbeat) return;
    const beat = () => void this.request(gamesirQuery(CMD.heartbeat), null).catch(() => undefined);
    beat();
    this.#heartbeat = setInterval(beat, GAMESIR_HEARTBEAT_MS);
  }

  stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  close(): void {
    this.stopHeartbeat();
    if (this.#listening) this.device.removeEventListener("inputreport", this.#onInput);
    this.#listening = false;
    channels.delete(this.device);
  }
}

const channels = new WeakMap<HIDDevice, GamesirChannel>();

/** The one channel of an open GameSir pad (the tester's heartbeat and the settings share its queue). */
export function gamesirChannel(device: HIDDevice, model: GamesirModel): GamesirChannel {
  let c = channels.get(device);
  if (!c || c.model !== model) {
    c = new GamesirChannel(device, model);
    channels.set(device, c);
  }
  return c;
}

export interface GamesirBackup {
  kind: "gamesir-settings";
  model: GamesirModel;
  savedAt: string;
  note: string;
  /** Profile banks 1-4 and the lighting bank (where mapped), each as read from address 0, as hex. */
  banks: { bank: number; hex: string }[];
}

export interface GamesirSessionOptions {
  /** The open pad (its vendor collection, page 0xFFF0). */
  device: HIDDevice;
  model: GamesirModel;
  /** Keeps the backup (desktop: a file; website: the browser's storage); returns where it went. */
  save: (prefix: string, json: string) => Promise<string>;
  /** The person's "Allow changes" switch. */
  allowWrites: () => boolean;
  gapMs?: number;
}

/** One field's new bytes. */
export interface GamesirChange {
  field: Field;
  bytes: number[];
}

export interface GamesirWriteResult {
  /** Fields read back as written. */
  verified: string[];
  /** The report rate was changed. */
  rateChanged: boolean;
  /** ...and the pad went away to reconnect at its new rate before it could be read back: check it once it is back. */
  reconnecting: boolean;
}

export class GamesirSession {
  readonly model: GamesirModel;
  readonly channel: GamesirChannel;
  readonly #o: GamesirSessionOptions;
  #backup: { where: string; data: GamesirBackup } | null = null;
  firmware: { controller: string; dongle: string } | null = null;
  /** The pad's active profile (1-4). */
  active = 1;
  /** Bank images as last read: 1-4 and 0x20. */
  readonly images = new Map<number, Uint8Array>();

  constructor(o: GamesirSessionOptions) {
    this.#o = o;
    this.model = o.model;
    this.channel = gamesirChannel(o.device, o.model);
    if (o.gapMs !== undefined) this.channel.gapMs = o.gapMs;
  }

  get backup(): { where: string; data: GamesirBackup } | null {
    return this.#backup;
  }

  get fields(): Field[] {
    return gamesirFields(this.model);
  }

  #banks(): number[] {
    return GAMESIR_MAPS[this.model].lightSize ? [1, 2, 3, 4, LIGHT_BANK] : [1, 2, 3, 4];
  }

  #size(bank: number): number {
    const m = GAMESIR_MAPS[this.model];
    return bank === LIGHT_BANK ? m.lightSize : m.profileSize;
  }

  /** A command that the pad acknowledges, sent again while it says it is busy. */
  async #acked(f: Frame, what: string): Promise<void> {
    for (let i = 0; i < BUSY_TRIES; i++) {
      const a = await this.channel.request(f, (x) => x.cmd === CMD.ack);
      if (a && !a.busy) return;
      await sleep(a?.busy ? 30 : 60);
    }
    throw new GamesirRefused(`The pad didn't take the ${what}.`);
  }

  /** Who the pad is and which profile it is on. Nothing is changed. */
  async hello(): Promise<void> {
    // The tester's keep-alive (already running when the link opened the pad; the channel runs one at most).
    this.channel.startHeartbeat();
    let fw: GamesirAnswer | null = null;
    for (let i = 0; i < 3 && !fw; i++) {
      // A pad that is asleep answers nothing until the host's keep-alive reaches it.
      await this.channel.request(gamesirQuery(CMD.heartbeat), null);
      fw = await this.channel.request(gamesirQuery(CMD.firmware), (a) => a.cmd === CMD.firmwareAck);
    }
    if (!fw?.firmware) throw new GamesirRefused("The pad doesn't answer on its settings channel. Wake it (press a button) and make sure it is in its PC / Xbox mode, then open it again.");
    this.firmware = fw.firmware;
    this.active = await this.#activeProfile();
  }

  async #activeProfile(): Promise<number> {
    const a = await this.channel.request(gamesirQuery(CMD.active), (x) => x.cmd === CMD.activeAck);
    const p = a?.profile ?? 0;
    // The pads answer 0 for their first profile.
    return p >= 1 && p <= 4 ? p : 1;
  }

  /** A whole bank, in packets of at most 56 bytes; every packet must come back. */
  async readBank(bank: number): Promise<Uint8Array> {
    const size = this.#size(bank);
    const image = new Uint8Array(size);
    for (const f of gamesirReads(bank, 0, size)) {
      const addr = (f.data[2] << 8) | f.data[3];
      const len = f.data[4];
      let got: GamesirAnswer | null = null;
      for (let i = 0; i < 3 && !got; i++) got = await this.channel.request(f, (a) => a.cmd === CMD.readAck && a.read?.bank === bank && a.read.addr === addr);
      if (!got?.read || got.read.data.length < len) throw new GamesirRefused(`The pad didn't answer a read of bank ${bank} at 0x${addr.toString(16)}.`);
      image.set(got.read.data.subarray(0, len), addr);
    }
    this.images.set(bank, image);
    return image;
  }

  /** Firmware, the active profile, all four profiles and the lighting bank. Nothing is changed. */
  async read(): Promise<void> {
    await this.hello();
    for (const b of this.#banks()) await this.readBank(b);
  }

  /** A full backup of every bank SYNQ reads, kept once per session before the first change. */
  async #ensureBackup(): Promise<void> {
    if (this.#backup) return;
    const banks: GamesirBackup["banks"] = [];
    for (const b of this.#banks()) banks.push({ bank: b, hex: hex(await this.readBank(b)) });
    const data: GamesirBackup = {
      kind: "gamesir-settings",
      model: this.model,
      savedAt: new Date().toISOString(),
      note: `${GAMESIR_MAPS[this.model].name}: profile banks 1-4 and the lighting bank as read before SYNQ's first change (config channel reads, report 0x0F command 0x04).`,
      banks,
    };
    const where = await this.#o.save(`gamesir-${this.model}`, JSON.stringify(data, null, 1));
    this.#backup = { where, data };
  }

  #mayWrite(): void {
    if (!this.#o.allowWrites()) throw new GamesirRefused("Turn on Allow changes first: GameSir settings are experimental.");
  }

  /** Makes `profile` the active one and waits until the pad says so. */
  async #switchTo(profile: number): Promise<void> {
    await this.#acked(gamesirSwitch(profile), `switch to profile ${profile}`);
    for (let i = 0; i < 8; i++) {
      if ((await this.#activeProfile()) === profile) {
        this.active = profile;
        return;
      }
      await sleep(120);
    }
    throw new GamesirRefused(`The pad didn't switch to profile ${profile}.`);
  }

  async #writeField(bank: number, c: GamesirChange): Promise<void> {
    for (const f of gamesirWrites(bank, c.field.at, c.bytes)) await this.#acked(f, c.field.name);
  }

  async #readBack(bank: number, fields: Field[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    const image = this.images.get(bank) ?? new Uint8Array(this.#size(bank));
    for (const field of fields) {
      for (const f of gamesirReads(bank, field.at, field.len)) {
        const addr = (f.data[2] << 8) | f.data[3];
        const got = await this.channel.request(f, (a) => a.cmd === CMD.readAck && a.read?.bank === bank && a.read.addr === addr);
        if (!got?.read) throw new GamesirRefused(`The pad didn't answer the read-back of ${field.name}.`);
        image.set(got.read.data.subarray(0, f.data[4]), addr);
      }
      out.set(field.name, fieldBytes(image, field));
    }
    this.images.set(bank, image);
    return out;
  }

  /**
   * Writes fields of one profile (1-4) or of the lighting bank (0x20), each read back. A profile that isn't the active
   * one is switched to first and back after. The report rate goes last: some pads reconnect when it changes.
   */
  async write(bank: number, changes: GamesirChange[]): Promise<GamesirWriteResult> {
    this.#mayWrite();
    const light = bank === LIGHT_BANK;
    if (!light && !(bank >= 1 && bank <= 4)) throw new GamesirRefused(`Profile ${bank} isn't one SYNQ writes.`);
    if (light && !GAMESIR_MAPS[this.model].lightSize) throw new GamesirRefused("This pad's lighting isn't mapped.");
    for (const c of changes) {
      if ((c.field.bank === "light") !== light) throw new GamesirRefused(`${c.field.name} isn't in that bank.`);
      if (!gamesirAccepts(this.model, c.field, c.bytes)) throw new GamesirRefused(`${c.field.name}: that value isn't one SYNQ writes.`);
    }
    if (!changes.length) return { verified: [], rateChanged: false, reconnecting: false };
    await this.#ensureBackup();
    const ordered = [...changes.filter((c) => c.field.kind !== "poll"), ...changes.filter((c) => c.field.kind === "poll")];
    const back = this.active;
    const switched = !light && bank !== this.active;
    if (switched) await this.#switchTo(bank);
    const verified: string[] = [];
    let rateChanged = false;
    let reconnecting = false;
    try {
      for (const c of ordered) {
        await this.#writeField(bank, c);
        if (c.field.kind === "poll") rateChanged = true;
        let got: number[];
        try {
          got = (await this.#readBack(bank, [c.field])).get(c.field.name)!;
        } catch (e) {
          // A pad that reconnects at its new report rate can't be read back here: the page says to check it.
          if (c.field.kind !== "poll") throw e;
          reconnecting = true;
          break;
        }
        if (got.some((v, i) => v !== c.bytes[i])) throw new GamesirRefused(`The pad didn't keep ${c.field.name} as written. Your backup: ${this.#backup?.where ?? "not saved"}.`);
        verified.push(c.field.name);
      }
    } finally {
      if (switched && !reconnecting) await this.#switchTo(back).catch(() => undefined);
    }
    return { verified, rateChanged, reconnecting };
  }

  /** Puts back, from a backup, every field SYNQ writes that differs now (fields it can't write stay as they are). */
  async restore(b: GamesirBackup): Promise<{ restored: string[]; kept: string[] }> {
    if (b.kind !== "gamesir-settings" || b.model !== this.model) throw new GamesirRefused(`That isn't a ${GAMESIR_MAPS[this.model].name} backup.`);
    this.#mayWrite();
    await this.#ensureBackup();
    const restored: string[] = [];
    const kept: string[] = [];
    for (const { bank, hex: h } of b.banks) {
      const saved = unhex(h);
      const current = this.images.get(bank) ?? (await this.readBank(bank));
      const changes: GamesirChange[] = [];
      for (const field of this.fields.filter((f) => (f.bank === "light") === (bank === LIGHT_BANK))) {
        const want = fieldBytes(saved, field);
        if (want.length !== field.len || want.every((v, i) => v === current[field.at + i])) continue;
        if (gamesirAccepts(this.model, field, want)) changes.push({ field, bytes: want });
        else kept.push(`${field.name} (profile ${bank})`);
      }
      if (changes.length) {
        const r = await this.write(bank, changes);
        restored.push(...r.verified.map((n) => (bank === LIGHT_BANK ? n : `${n} (profile ${bank})`)));
      }
    }
    return { restored, kept };
  }
}
