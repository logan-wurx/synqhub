// The 8BitDo Ultimate's three profiles as a session (wave C3): read the 1652-byte config (report state, then 37 chunk
// reads), keep a full backup before the first change, write a whole config built from the pad's own bytes with one
// profile edited (37 chunks, each acknowledged, then save), read it back and compare, put the backup back. The same
// safety model as keyboards: `experimental`, writes only while "Allow changes" is on, and only when the stored CRC
// checks out (the layout is the one SYNQ knows). Every frame passes guard.ts here; the bridge or the website's guard
// checks it again.
import { checkPadOutput } from "./guard.ts";
import {
  EBD_CMD,
  EBD_CONFIG_SIZE,
  EBD_IN,
  checkEbdEdit,
  ebdApply,
  ebdReads,
  ebdReportState,
  ebdSave,
  ebdVersion,
  ebdWrites,
  parseEbdAnswer,
  parseEbdConfig,
  type EbdAnswer,
  type EbdConfig,
  type EbdProfile,
} from "./eightbitdo.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const TRIES = 3;

export class EbdRefused extends Error {}

export interface EbdBackup {
  kind: "8bitdo-ultimate-config";
  savedAt: string;
  note: string;
  /** The 1652-byte config as read, as hex. */
  config: string;
}

export interface EbdSessionOptions {
  device: HIDDevice;
  save: (prefix: string, json: string) => Promise<string>;
  allowWrites: () => boolean;
  /** Room between commands. */
  gapMs?: number;
}

/** The answer to an 8BitDo config command: input report 0x02, or an unnumbered report that starts with 0x02. */
export function ebdAnswerOf(reportId: number, data: Uint8Array): EbdAnswer | null {
  if (reportId === EBD_IN) return parseEbdAnswer(data);
  if (reportId === 0 && data[0] === EBD_IN) return parseEbdAnswer(data.subarray(1));
  return null;
}

export class EbdSession {
  readonly #o: EbdSessionOptions;
  #backup: { where: string; data: EbdBackup } | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #waiters = new Set<(a: EbdAnswer) => boolean>();
  #listening = false;
  readonly #onInput = (e: Event) => {
    const ev = e as HIDInputReportEvent;
    const a = ebdAnswerOf(ev.reportId, new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength));
    if (!a) return;
    for (const w of [...this.#waiters]) if (w(a)) break;
  };
  config: EbdConfig | null = null;
  firmware: string | null = null;

  constructor(o: EbdSessionOptions) {
    this.#o = o;
  }

  get backup(): { where: string; data: EbdBackup } | null {
    return this.#backup;
  }

  /** One frame (guard first) and the answer `expect` accepts, one at a time. */
  #request(f: { reportId: number; data: Uint8Array }, expect: (a: EbdAnswer) => boolean, timeoutMs = 400): Promise<EbdAnswer | null> {
    const run = async () => {
      const v = checkPadOutput("8bitdo", f.reportId, f.data);
      if (!v.ok) throw new EbdRefused(v.why);
      if (!this.#listening) {
        this.#o.device.addEventListener("inputreport", this.#onInput);
        this.#listening = true;
      }
      await sleep(this.#o.gapMs ?? 8);
      let settle: (a: EbdAnswer | null) => void = () => {};
      const answer = new Promise<EbdAnswer | null>((r) => (settle = r));
      const waiter = (a: EbdAnswer) => {
        if (!expect(a)) return false;
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        settle(a);
        return true;
      };
      this.#waiters.add(waiter);
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        settle(null);
      }, timeoutMs);
      try {
        await this.#o.device.sendReport(f.reportId, f.data as BufferSource);
      } catch (e) {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        throw e;
      }
      return answer;
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    return p;
  }

  async #configMode(): Promise<void> {
    for (let i = 0; i < TRIES; i++) if (await this.#request(ebdReportState(), (a) => a.cmd === EBD_CMD.readResponse && a.sub === EBD_CMD.reportState)) return;
    throw new EbdRefused("The pad doesn't answer on its config channel. It must be in its config mode (8BitDo's own app switches it there), then open it again.");
  }

  async #readBytes(): Promise<Uint8Array> {
    await this.#configMode();
    const bytes = new Uint8Array(EBD_CONFIG_SIZE);
    for (const f of ebdReads()) {
      let got: EbdAnswer | null = null;
      for (let i = 0; i < TRIES && !got; i++) got = await this.#request(f, (a) => a.cmd === EBD_CMD.readResponse && a.sub === EBD_CMD.read && a.offset === f.offset);
      const n = Math.min(45, EBD_CONFIG_SIZE - f.offset);
      if (!got?.data || got.data.length < n) throw new EbdRefused(`The pad didn't answer the read at ${f.offset}.`);
      bytes.set(got.data.subarray(0, n), f.offset);
    }
    return bytes;
  }

  /** The firmware version and the whole config. Nothing is changed. */
  async read(): Promise<EbdConfig> {
    const v = await this.#request(ebdVersion(), (a) => a.cmd === 0x22).catch(() => null);
    this.firmware = v?.version ?? null;
    this.config = parseEbdConfig(await this.#readBytes());
    return this.config;
  }

  async #ensureBackup(): Promise<void> {
    if (this.#backup) return;
    const bytes = await this.#readBytes();
    const data: EbdBackup = { kind: "8bitdo-ultimate-config", savedAt: new Date().toISOString(), note: "The 8BitDo Ultimate's whole config (three profiles, 1652 bytes) as read before SYNQ's first change.", config: hex(bytes) };
    const where = await this.#o.save("8bitdo-ultimate", JSON.stringify(data, null, 1));
    this.#backup = { where, data };
  }

  #mayWrite(): void {
    if (!this.#o.allowWrites()) throw new EbdRefused("Turn on Allow changes first: 8BitDo settings are experimental.");
    if (!this.config?.crcOk) throw new EbdRefused("This pad's config doesn't check out the way SYNQ expects (its layout may differ): nothing is written.");
  }

  async #writeAll(bytes: Uint8Array): Promise<void> {
    await this.#configMode();
    for (const f of ebdWrites(bytes)) {
      let ok = false;
      for (let i = 0; i < TRIES && !ok; i++) ok = !!(await this.#request(f, (a) => a.cmd === EBD_CMD.readResponse && a.sub === EBD_CMD.write));
      if (!ok) throw new EbdRefused(`The pad didn't take the chunk at ${f.offset}. Your backup: ${this.#backup?.where ?? "not saved"}.`);
    }
    // The save commits it (the answer, if any, isn't needed).
    await this.#request(ebdSave(), () => true, 600);
  }

  async #verify(want: Uint8Array): Promise<void> {
    const back = await this.#readBytes();
    this.config = parseEbdConfig(back);
    if (back.some((v, i) => v !== want[i])) throw new EbdRefused(`The pad didn't keep the config as written. Your backup: ${this.#backup?.where ?? "not saved"}.`);
  }

  /** Writes one profile (every other byte as the pad has it), then reads the whole config back. */
  async write(profile: EbdProfile): Promise<EbdConfig> {
    this.#mayWrite();
    const why = checkEbdEdit(profile);
    if (why) throw new EbdRefused(why);
    await this.#ensureBackup();
    const current = await this.#readBytes();
    const next = ebdApply(current, profile);
    await this.#writeAll(next);
    await this.#verify(next);
    return this.config!;
  }

  /** Puts the whole config back from a backup, as it was (its own CRC), and reads it back. */
  async restore(b: EbdBackup): Promise<EbdConfig> {
    if (b.kind !== "8bitdo-ultimate-config") throw new EbdRefused("That isn't an 8BitDo Ultimate backup.");
    const bytes = unhex(b.config);
    if (bytes.length !== EBD_CONFIG_SIZE || !parseEbdConfig(bytes).crcOk) throw new EbdRefused("That backup doesn't check out.");
    this.#mayWrite();
    await this.#ensureBackup();
    await this.#writeAll(bytes);
    await this.#verify(bytes);
    return this.config!;
  }

  close(): void {
    if (this.#listening) this.#o.device.removeEventListener("inputreport", this.#onInput);
    this.#listening = false;
  }
}
