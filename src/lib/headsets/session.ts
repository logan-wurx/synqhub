// One headset, open: its status (battery, charging, chat-mix) read on demand, and its settings changed one at a time.
// Reads are always allowed. A change needs the page's "Allow changes" (every headset here is experimental: built from
// HeadsetControl's open protocol, never tried on hardware by SYNQ), saves SYNQ's copy of the settings as a backup
// before the first one, passes the allowlist (guard.ts), and is read back where the headset can report it (HyperX's
// auto-off). The rest can't be read, so the page shows SYNQ's copy of what it set.
import { checkHeadsetFrame } from "./guard.ts";
import { readReply, settingFrames, settingsOf, statusRequests, type Frame, type Model, type SettingId, type Status } from "./protocol.ts";

/** The part of WebHID's HIDDevice the session uses (the desktop bridge and the simulator have it too). */
export interface HidLike {
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener(type: "inputreport", listener: (e: { reportId: number; data: DataView }) => void): void;
  removeEventListener(type: "inputreport", listener: (e: { reportId: number; data: DataView }) => void): void;
}

export interface HeadsetStore {
  saveBackup(prefix: string, json: string): Promise<string>;
  load(key: string): Promise<Partial<Record<SettingId, number>> | null>;
  save(key: string, values: Partial<Record<SettingId, number>>): Promise<void>;
}

export type Values = Partial<Record<SettingId, number>>;

const REPLY_MS = 700;
const GAP_MS = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A reply belongs to this request: the same command (HID++: the same feature and function, or its error reply). */
function answers(f: Frame, d: Uint8Array): boolean {
  if (f.data[0] === 0xb0) return d[0] === 0xb0;
  if (f.data[0] === 0xff && f.data[1] === 0xbb) return d[0] === 0xff && d[1] === 0xbb && d[2] === f.data[2];
  return d[0] === 0xff && (d[1] === 0xff || (d[1] === f.data[1] && d[2] === f.data[2]));
}

export class HeadsetSession {
  readonly model: Model;
  #dev: HidLike;
  #store: HeadsetStore;
  #allow = false;
  #backup: string | null = null;
  #values: Values = {};
  status: Status = { connected: false, battery: null, charging: null };

  constructor(dev: HidLike, model: Model, store: HeadsetStore) {
    this.#dev = dev;
    this.model = model;
    this.#store = store;
  }

  get key(): string {
    return `${this.model.vid}:${this.model.pid}`;
  }

  /** SYNQ's copy of the settings it set on this headset (most can't be read back). */
  get values(): Values {
    return { ...this.#values };
  }

  get allowChanges(): boolean {
    return this.#allow;
  }

  setAllowChanges(on: boolean): void {
    this.#allow = on;
  }

  get backupPath(): string | null {
    return this.#backup;
  }

  async open(): Promise<void> {
    if (!this.#dev.opened) await this.#dev.open();
    this.#values = (await this.#store.load(this.key).catch(() => null)) ?? {};
  }

  async close(): Promise<void> {
    if (this.#dev.opened) await this.#dev.close();
  }

  async #send(f: Frame): Promise<void> {
    const v = checkHeadsetFrame(this.model, f);
    if (!v.ok) throw new Error("SYNQ's allowlist refused that report; nothing was sent.");
    await this.#dev.sendReport(f.reportId, Uint8Array.from(f.data));
  }

  /** Sends one frame and waits for the reply `accept` takes (or none, for frames without one). */
  async #ask(f: Frame, accept: (reportId: number, d: Uint8Array) => boolean): Promise<Uint8Array | null> {
    let done: (d: Uint8Array | null) => void = () => undefined;
    const reply = new Promise<Uint8Array | null>((r) => (done = r));
    const listener = (e: { reportId: number; data: DataView }) => {
      const d = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      if (accept(e.reportId, d)) done(new Uint8Array(d));
    };
    this.#dev.addEventListener("inputreport", listener);
    const timer = setTimeout(() => done(null), REPLY_MS);
    try {
      await this.#send(f);
      return await reply;
    } finally {
      clearTimeout(timer);
      this.#dev.removeEventListener("inputreport", listener);
    }
  }

  /** Battery, charging and (where the headset has it) chat-mix; read only. */
  async refresh(): Promise<Status> {
    let next: Status = { ...this.status };
    let answered = false;
    for (const f of statusRequests(this.model.family)) {
      const d = await this.#ask(f, (id, data) => id === f.reportId && answers(f, data) && readReply(this.model, id, data, next) !== null);
      if (!d) continue;
      answered = true;
      next = readReply(this.model, f.reportId, d, next) ?? next;
      await sleep(GAP_MS);
    }
    this.status = answered ? next : { connected: false, battery: null, charging: null };
    return this.status;
  }

  /** Changes one setting; throws (sending nothing) when changes aren't allowed or the value isn't one SYNQ offers. */
  async set(id: SettingId, value: number): Promise<{ confirmed: boolean }> {
    if (!this.#allow) throw new Error("Changes are off for this headset until you allow them.");
    const frames = settingFrames(this.model, id, value);
    if (!frames) throw new Error("That value isn't one SYNQ offers for this headset.");
    if (!this.#backup) {
      this.#backup = await this.#store.saveBackup(`headset-${this.model.vid}-${this.model.pid}`, JSON.stringify({ model: this.model, values: this.#values, status: this.status }));
    }
    for (const f of frames) {
      await this.#send(f);
      await sleep(GAP_MS);
    }
    let confirmed = false;
    if (this.model.family === "hyperx-cloud2w" && id === "autoOff") {
      const read = statusRequests(this.model.family)[2];
      const d = await this.#ask(read, (rid, data) => rid === read.reportId && data[2] === 0x07);
      if (d && d[3] !== value) throw new Error(`The headset reads back ${d[3]} min, not ${value}.`);
      confirmed = !!d;
    }
    this.#values = { ...this.#values, [id]: value };
    await this.#store.save(this.key, this.#values).catch(() => undefined);
    return { confirmed };
  }

  /** The settings this headset takes, with SYNQ's copy of each. */
  settings() {
    return settingsOf(this.model.family).map((s) => ({ ...s, value: this.#values[s.id] ?? null }));
  }
}
