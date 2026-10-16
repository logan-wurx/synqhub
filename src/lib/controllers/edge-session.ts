// The DualSense Edge's profile slots as a session (wave C2): read all four, keep a full backup before the first change,
// write a custom slot, read it back and compare, delete one, put the backup back. The same safety model as keyboards:
// `experimental`, writes only while the person's "Allow changes" switch is on, a backup first, a read-back after every
// write. USB only. Every report passes guard.ts here, and the bridge (pads.rs) or the website's guard checks it again.
import { checkPadFeatureGet, checkPadFeatureSet } from "./guard.ts";
import { EDGE_PART, EDGE_READS, EDGE_SLOTS, edgeDeleteFrame, edgePartCrc, edgeWriteFrames, parseEdgeProfile, type EdgeEdit, type EdgeProfile } from "./edge.ts";

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface EdgeBackup {
  kind: "dualsense-edge-profiles";
  savedAt: string;
  note: string;
  /** The 12 read reports, 0x70..0x7B, each 64 bytes with its id, as hex. */
  reports: string[];
}

export interface EdgeSessionOptions {
  /** The open Edge (its gamepad collection). */
  device: HIDDevice;
  /** "usb" or "bt": profiles are read and written over USB only. */
  link: "usb" | "bt";
  /** Keeps the backup (desktop: a file; website: the browser's storage); returns where it went. */
  save: (prefix: string, json: string) => Promise<string>;
  /** The person's "Allow changes" switch. */
  allowWrites: () => boolean;
  /** Pause between the parts of a write (the reference app sends them back to back; a little room costs nothing). */
  gapMs?: number;
}

/** Why a change wasn't made, in words for the page. */
export class EdgeRefused extends Error {}

export class EdgeSession {
  readonly #o: EdgeSessionOptions;
  #backup: { where: string; data: EdgeBackup } | null = null;
  profiles: EdgeProfile[] = [];

  constructor(o: EdgeSessionOptions) {
    this.#o = o;
  }

  get backup(): { where: string; data: EdgeBackup } | null {
    return this.#backup;
  }

  #usb(): void {
    if (this.#o.link !== "usb") throw new EdgeRefused("Connect the DualSense Edge with a USB cable: its profiles are read and written over USB only.");
  }

  async #get(id: number): Promise<Uint8Array> {
    const v = checkPadFeatureGet("edge", id);
    if (!v.ok) throw new EdgeRefused(v.why);
    const view = await this.#o.device.receiveFeatureReport(id);
    const b = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
    // Some stacks leave the report id out: put it back so every part reads the same way.
    if (b.length === EDGE_PART - 1) return Uint8Array.from([id, ...b]);
    return b;
  }

  async #set(reportId: number, data: Uint8Array): Promise<void> {
    const v = checkPadFeatureSet("edge", reportId, data);
    if (!v.ok) throw new EdgeRefused(v.why);
    await this.#o.device.sendFeatureReport(reportId, data as BufferSource);
  }

  async #readSlot(slot: number): Promise<EdgeProfile> {
    const s = EDGE_SLOTS[slot];
    const parts = [await this.#get(s.read), await this.#get(s.read + 1), await this.#get(s.read + 2)];
    return parseEdgeProfile(s, parts);
  }

  /** Reads all four slots (12 feature reads; nothing is changed). */
  async read(): Promise<EdgeProfile[]> {
    this.#usb();
    const out: EdgeProfile[] = [];
    for (const s of EDGE_SLOTS) out.push(await this.#readSlot(s.slot));
    this.profiles = out;
    return out;
  }

  /** A full backup of the four slots, kept once per session before the first change. */
  async #ensureBackup(): Promise<void> {
    if (this.#backup) return;
    const reports: string[] = [];
    for (const id of EDGE_READS) reports.push(hex(await this.#get(id)));
    const data: EdgeBackup = { kind: "dualsense-edge-profiles", savedAt: new Date().toISOString(), note: "The DualSense Edge's four profile slots as read before SYNQ's first change (feature reports 0x70-0x7B).", reports };
    const where = await this.#o.save("dualsense-edge-profiles", JSON.stringify(data, null, 1));
    this.#backup = { where, data };
  }

  #mayWrite(slot: number): void {
    this.#usb();
    if (!this.#o.allowWrites()) throw new EdgeRefused("Turn on Allow changes first: profile writes are experimental.");
    if (EDGE_SLOTS[slot]?.protected !== false) throw new EdgeRefused("The default profile (Triangle) is never changed.");
  }

  async #sendParts(frames: { reportId: number; data: Uint8Array }[]): Promise<void> {
    for (const f of frames) {
      await this.#set(f.reportId, f.data);
      await sleep(this.#o.gapMs ?? 20);
    }
  }

  /** Writes a custom slot (1-3), then reads it back: what the pad kept must be what was written. */
  async write(slot: 1 | 2 | 3, edit: EdgeEdit): Promise<EdgeProfile> {
    this.#mayWrite(slot);
    await this.#ensureBackup();
    const current = await this.#readSlot(slot);
    await this.#sendParts(edgeWriteFrames(current, edit));
    const back = await this.#readSlot(slot);
    const same =
      !back.empty &&
      back.label === edit.label.trim() &&
      back.sticks.every((s, i) => s.preset === edit.sticks[i].preset && s.step === edit.sticks[i].step) &&
      back.triggers.every((t, i) => t.min === edit.triggers[i].min && t.max === edit.triggers[i].max) &&
      back.buttons.every((b, i) => b === edit.buttons[i]);
    this.profiles[slot] = back;
    if (!same) throw new EdgeRefused(`The pad didn't keep the change as written. Your backup: ${this.#backup?.where ?? "not saved"}.`);
    return back;
  }

  /** Empties a custom slot (1-3), then reads it back. */
  async remove(slot: 1 | 2 | 3): Promise<EdgeProfile> {
    this.#mayWrite(slot);
    await this.#ensureBackup();
    const f = edgeDeleteFrame(slot);
    await this.#set(f.reportId, f.data);
    await sleep(this.#o.gapMs ?? 20);
    const back = await this.#readSlot(slot);
    this.profiles[slot] = back;
    if (!back.empty) throw new EdgeRefused("The pad still holds that profile.");
    return back;
  }

  /**
   * Puts the custom slots back from a backup: each used slot is written again from its own bytes (the default is never
   * written; a slot that was empty is deleted). Read back like any write.
   */
  async restore(b: EdgeBackup): Promise<void> {
    if (b.kind !== "dualsense-edge-profiles" || b.reports.length !== 12) throw new EdgeRefused("That isn't a DualSense Edge profile backup.");
    for (const s of EDGE_SLOTS.filter((x) => !x.protected)) {
      this.#mayWrite(s.slot);
      await this.#ensureBackup();
      const parts = [0, 1, 2].map((i) => unhex(b.reports[s.slot * 3 + i]));
      const saved = parseEdgeProfile(s, parts);
      if (saved.empty) {
        await this.remove(s.slot as 1 | 2 | 3);
        continue;
      }
      // The parts as they were, under the write id, with their own CRC recomputed (the profile CRC is the backup's).
      const frames = parts.map((p) => {
        const part = p.slice(0, EDGE_PART);
        part[0] = s.write;
        new DataView(part.buffer).setUint32(60, edgePartCrc(part), true);
        return { reportId: s.write, data: part.slice(1) };
      });
      await this.#sendParts(frames);
      const back = await this.#readSlot(s.slot);
      this.profiles[s.slot] = back;
      if (back.label !== saved.label) throw new EdgeRefused(`Slot ${s.button} didn't come back as it was in the backup.`);
    }
  }
}
