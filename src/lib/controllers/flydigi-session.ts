// A Flydigi Apex 4's four profile slots as a session (wave C3): who the pad is (device info), each slot's 790-byte
// config, a full backup before the first change, a slot written whole from the pad's own bytes with the edits applied,
// saved to flash only by the person's Save, read back and compared (all but the two bytes the save itself rewrites),
// and the backup put back. Reads only for the Apex 4 family (device ids 84, 86, 87, 92, 93, 102-104), writes only
// for device id 84, the one the source verified. Every frame passes guard.ts here; the bridge or the website's guard
// checks it again.
import { checkPadOutput } from "./guard.ts";
import {
  FD_AT,
  FD_CONFIG_SIZE,
  FD_IN,
  FD_PARCELS,
  FD_SLOTS,
  FD_WRITABLE_IDS,
  checkFlydigiEdit,
  fdDeviceInfo,
  fdReadConfig,
  fdReadRandomId,
  fdSave,
  fdWrites,
  flydigiApply,
  parseFlydigiAnswer,
  parseFlydigiConfig,
  type FdAnswer,
  type FdProfile,
} from "./flydigi.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
/** The Apex 4 family (FlydigiKit DeviceCatalog): its configs read the same way. */
export const FD_READABLE_IDS: readonly number[] = [84, 86, 87, 92, 93, 102, 103, 104];
const VENDOR_PAGE = 0xffa0;

export class FdRefused extends Error {}

export interface FdBackup {
  kind: "flydigi-apex4-config";
  deviceId: number;
  savedAt: string;
  note: string;
  /** The four slots' 790-byte configs as read, as hex. */
  slots: string[];
}

export interface FdSessionOptions {
  device: HIDDevice;
  save: (prefix: string, json: string) => Promise<string>;
  allowWrites: () => boolean;
  /** Room between parcels. */
  gapMs?: number;
}

/** Equal but for the data-version bytes a save rewrites. */
const sameConfig = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i] || i === FD_AT.dataVersion || i === FD_AT.dataVersion + 1);

export class FlydigiSession {
  readonly #o: FdSessionOptions;
  #backup: { where: string; data: FdBackup } | null = null;
  readonly #listeners = new Set<(a: FdAnswer) => void>();
  #listening = false;
  readonly #onInput = (e: Event) => {
    const ev = e as HIDInputReportEvent & { usagePage?: number };
    if (ev.reportId !== FD_IN || (ev.usagePage !== undefined && ev.usagePage !== VENDOR_PAGE)) return;
    const a = parseFlydigiAnswer(new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength));
    if (a) for (const l of [...this.#listeners]) l(a);
  };
  info: { deviceId: number; firmware: string; battery: number; wired: boolean } | null = null;
  configs: Uint8Array[] = [];
  profiles: FdProfile[] = [];

  constructor(o: FdSessionOptions) {
    this.#o = o;
  }

  get backup(): { where: string; data: FdBackup } | null {
    return this.#backup;
  }

  /** The pad answered as an Apex 4 SYNQ writes to. */
  get writable(): boolean {
    return !!this.info && FD_WRITABLE_IDS.includes(this.info.deviceId);
  }

  async #send(f: { reportId: number; data: Uint8Array }): Promise<void> {
    const v = checkPadOutput("flydigi", f.reportId, f.data);
    if (!v.ok) throw new FdRefused(v.why);
    if (!this.#listening) {
      this.#o.device.addEventListener("inputreport", this.#onInput);
      this.#listening = true;
    }
    await this.#o.device.sendReport(f.reportId, f.data as BufferSource);
  }

  /** Sends a frame and waits for the first answer `pick` returns a value for. */
  async #ask<T>(f: { reportId: number; data: Uint8Array }, pick: (a: FdAnswer) => T | null, timeoutMs = 500): Promise<T | null> {
    let off = () => {};
    const got = new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => (off(), resolve(null)), timeoutMs);
      const l = (a: FdAnswer) => {
        const v = pick(a);
        if (v === null) return;
        clearTimeout(timer);
        off();
        resolve(v);
      };
      this.#listeners.add(l);
      off = () => this.#listeners.delete(l);
    });
    await this.#send(f);
    return got;
  }

  async #readSlot(slot: number): Promise<Uint8Array> {
    // Let parcels of an earlier read drain first: a late one would land in this slot's blob.
    await sleep(120);
    const parts = new Map<number, Uint8Array>();
    let off = () => {};
    const done = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => (off(), resolve(false)), 3000);
      const l = (a: FdAnswer) => {
        if (a.kind !== "parcel" || a.index >= FD_PARCELS) return;
        parts.set(a.index, a.data);
        if (parts.size === FD_PARCELS) {
          clearTimeout(timer);
          off();
          resolve(true);
        }
      };
      this.#listeners.add(l);
      off = () => this.#listeners.delete(l);
    });
    await this.#send(fdReadConfig(slot));
    if (!(await done)) throw new FdRefused(`The pad sent ${parts.size} of 79 parts of slot ${slot + 1}.`);
    const out = new Uint8Array(FD_CONFIG_SIZE);
    for (const [i, d] of parts) out.set(d.subarray(0, Math.min(10, FD_CONFIG_SIZE - i * 10)), i * 10);
    return out;
  }

  /** Who the pad is, then (for the Apex 4 family) its four slots. Nothing is changed. */
  async read(): Promise<void> {
    this.info = await this.#ask(fdDeviceInfo(), (a) => (a.kind === "info" ? a : null));
    if (!this.info) throw new FdRefused("The pad doesn't answer on its settings channel. Put it in its D-input mode (Space Station's mode switch), then open it again.");
    if (!FD_READABLE_IDS.includes(this.info.deviceId)) throw new FdRefused(`This Flydigi (device id ${this.info.deviceId}) isn't an Apex 4: SYNQ doesn't read its settings. The tester works.`);
    this.configs = [];
    for (let s = 0; s < FD_SLOTS; s++) this.configs.push(await this.#readSlot(s));
    this.profiles = this.configs.map((c, s) => parseFlydigiConfig(s, c));
  }

  async #ensureBackup(): Promise<void> {
    if (this.#backup) return;
    const slots: string[] = [];
    for (let s = 0; s < FD_SLOTS; s++) slots.push(hex(await this.#readSlot(s)));
    const data: FdBackup = { kind: "flydigi-apex4-config", deviceId: this.info!.deviceId, savedAt: new Date().toISOString(), note: "The Flydigi Apex 4's four profile slots (790 bytes each) as read before SYNQ's first change.", slots };
    const where = await this.#o.save("flydigi-apex4", JSON.stringify(data, null, 1));
    this.#backup = { where, data };
  }

  #mayWrite(): void {
    if (!this.#o.allowWrites()) throw new FdRefused("Turn on Allow changes first: Flydigi settings are experimental.");
    if (!this.writable) throw new FdRefused(`SYNQ writes only to the Apex 4 its source was checked on (device id 84); this one is ${this.info?.deviceId ?? "unknown"}.`);
  }

  /** Writes a whole slot, saves it to flash, reads it back. */
  async #writeSlot(slot: number, bytes: Uint8Array): Promise<void> {
    const frames = fdWrites(slot, bytes);
    for (let i = 0; i < frames.length; i++) {
      const want = i === 0 ? 0xff : i;
      let ok = false;
      for (let t = 0; t < 3 && !ok; t++) {
        ok = (await this.#ask(frames[i], (a) => (a.kind === "ack" && a.index === want ? true : null), 400)) === true;
        if (!ok) await sleep(40);
      }
      if (!ok) throw new FdRefused(`The pad didn't take part ${i} of slot ${slot + 1}. Nothing was saved; your backup: ${this.#backup?.where ?? "not saved"}.`);
      await sleep(this.#o.gapMs ?? 4);
    }
    const id = await this.#ask(fdReadRandomId(slot), (a) => (a.kind === "randomId" && a.slot === slot ? a.id : null));
    if (id === null) throw new FdRefused("The pad didn't give the slot's save id: nothing was saved to flash (the change lasts until it powers off).");
    const saved = await this.#ask(fdSave((id + 1) & 0xffff), (a) => (a.kind === "saved" ? a.ok : null), 1500);
    if (saved !== true) throw new FdRefused("The pad didn't confirm the save to flash.");
    const back = await this.#readSlot(slot);
    this.configs[slot] = back;
    this.profiles[slot] = parseFlydigiConfig(slot, back);
    if (!sameConfig(back, bytes)) throw new FdRefused(`The pad didn't keep slot ${slot + 1} as written. Your backup: ${this.#backup?.where ?? "not saved"}.`);
  }

  /** Edits one slot (every other byte as the pad has it), saves it on the pad, reads it back. */
  async write(p: FdProfile): Promise<void> {
    this.#mayWrite();
    const why = checkFlydigiEdit(p);
    if (why) throw new FdRefused(why);
    await this.#ensureBackup();
    const current = await this.#readSlot(p.slot);
    await this.#writeSlot(p.slot, flydigiApply(current, parseFlydigiConfig(p.slot, current), p));
  }

  /** Puts back every slot that differs from the backup (all but the save's own data-version bytes). */
  async restore(b: FdBackup): Promise<number[]> {
    if (b.kind !== "flydigi-apex4-config" || b.slots.length !== FD_SLOTS) throw new FdRefused("That isn't a Flydigi Apex 4 backup.");
    this.#mayWrite();
    if (b.deviceId !== this.info!.deviceId) throw new FdRefused("That backup is from another Flydigi model.");
    await this.#ensureBackup();
    const restored: number[] = [];
    for (let s = 0; s < FD_SLOTS; s++) {
      const want = unhex(b.slots[s]);
      const now = await this.#readSlot(s);
      if (sameConfig(now, want)) continue;
      await this.#writeSlot(s, want);
      restored.push(s);
    }
    return restored;
  }

  close(): void {
    if (this.#listening) this.#o.device.removeEventListener("inputreport", this.#onInput);
    this.#listening = false;
    this.#listeners.clear();
  }
}
