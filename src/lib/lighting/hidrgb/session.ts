// A USB RGB hub's session: what it says about itself (read freely), and one colour per channel once "Allow changes" is
// on. Every report passes checkHubFrame before it goes; a report the guard refuses is never sent. Before the first
// change it keeps a backup of everything the hub reported; the hubs can't report the effect or colours they show, so
// Put back can only send the colour SYNQ sent before the latest one (the page says exactly that).
import { checkHubFrame } from "./guard.ts";
import { colourFrames, identifyFrames, readReply, type Frame, type HubFacts, type HubModel, type Rgb } from "./protocol.ts";

/** Where the backup goes: the app's data folder on the desktop, memory in the preview and the tests. */
export interface HubStore {
  saveBackup(prefix: string, json: string): Promise<string>;
}

/** How a session reaches a hub: the bridge on the desktop, a simulated hub in the preview and the tests. */
export interface HubTransport {
  write(f: Frame): Promise<void>;
  /** The next input report (its id first), or null when none came in time. */
  read(timeoutMs: number): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export class HubSession {
  facts: HubFacts = { firmware: null, accessories: null };
  #allow = false;
  #backup: string | null = null;
  /** What SYNQ sent each channel, the latest last (the hub can't report it). */
  sent = new Map<number, { rgb: Rgb; leds: number }[]>();

  readonly #t: HubTransport;
  readonly #store: HubStore;
  readonly model: HubModel;

  constructor(t: HubTransport, model: HubModel, store: HubStore) {
    this.#t = t;
    this.#store = store;
    this.model = model;
  }

  /** Where the backup was kept, once the first change was made. */
  get backup(): string | null {
    return this.#backup;
  }

  setAllowChanges(on: boolean) {
    this.#allow = on;
  }

  async #send(f: Frame) {
    const v = checkHubFrame(this.model, f);
    if (!v.ok) throw new Error(`Refused before sending: ${v.why}`);
    await this.#t.write(f);
    // Corsair answers every report; read the answer so the next one isn't taken for it.
    if (this.model.family === "corsair-node") return this.#t.read(50);
    return null;
  }

  /** Reads the hub's firmware (and, on NZXT, what is plugged into each channel). */
  async identify(): Promise<HubFacts> {
    for (const f of identifyFrames(this.model)) {
      const answer = await this.#send(f);
      if (answer) this.facts = readReply(this.model, answer, this.facts);
      // NZXT may send status reports in between: look through a few for the answer.
      for (let i = 0; i < 10 && this.model.family === "nzxt-hue2"; i++) {
        const r = await this.#t.read(100);
        if (!r) break;
        const before = this.facts;
        this.facts = readReply(this.model, r, this.facts);
        if (this.facts !== before) break;
      }
    }
    return this.facts;
  }

  /** One colour on one channel, over `leds` LEDs. */
  async setChannel(channel: number, rgb: Rgb, leds: number): Promise<void> {
    if (!this.#allow) throw new Error("Changes wait until you allow them.");
    const frames = colourFrames(this.model, channel, rgb, leds);
    if (!frames) throw new Error("That channel or LED count isn't one this hub has.");
    // Judge them all first: a refusal halfway would leave the channel half set.
    for (const f of frames) {
      const v = checkHubFrame(this.model, f);
      if (!v.ok) throw new Error(`Refused before sending: ${v.why}`);
    }
    if (!this.#backup) {
      const json = JSON.stringify({ hub: this.model.name, usb: `${this.model.vid}:${this.model.pid}`, reported: this.facts, note: "The hub can't report the effect or colours it showed; this is everything it did report." });
      this.#backup = await this.#store.saveBackup(`rgbhub-${this.model.vid}-${this.model.pid}`, json);
    }
    for (const f of frames) await this.#send(f);
    this.sent.set(channel, [...(this.sent.get(channel) ?? []), { rgb, leds }].slice(-2));
  }

  /** The colour SYNQ sent this channel before the latest one, if it sent two. */
  previous(channel: number): { rgb: Rgb; leds: number } | null {
    const h = this.sent.get(channel) ?? [];
    return h.length > 1 ? h[h.length - 2] : null;
  }

  /** Sends the previous colour again (the hub's own earlier effect can't be read, so it can't be restored). */
  async putBack(channel: number): Promise<boolean> {
    const p = this.previous(channel);
    if (!p) return false;
    await this.setChannel(channel, p.rgb, p.leds);
    return true;
  }

  close() {
    return this.#t.close();
  }
}
