// One Wi-Fi light as its page drives it: what it shows (at once when the person changes something, then as the light
// answers), and a queue that keeps only the latest power, brightness and colour and sends them at the brand's own pace
// (Yeelight allows about one message a second, Hue about ten). Messages are built when they are sent, from what the
// page shows then, so a light that takes colour and brightness together (LIFX) always gets the latest of both.
import { kelvinRgb, type Rgb } from "../govee/frames.ts";
import type { LampView } from "../lamp.ts";
import { NET_BRANDS, type NetBrand, type NetDevice, type NetState } from "./brands.ts";
import type { Brand, Json, NetMessage } from "./guard.ts";
import type { Reply } from "./link.ts";

/** Room between two messages to one light. */
export const NET_PACE_MS: Readonly<Record<Brand, number>> = { hue: 100, nanoleaf: 100, elgato: 100, twinkly: 150, wiz: 60, yeelight: 1000, lifx: 50 };
/** After the changes stop, the light is asked what it shows (Yeelight later: its quota counts questions too). */
const CONFIRM_MS: Readonly<Record<Brand, number>> = { hue: 900, nanoleaf: 900, elgato: 900, twinkly: 900, wiz: 900, yeelight: 2500, lifx: 900 };

type Change = "power" | "brightness" | "colour";
/** How a message reaches the light: link.ts `netSend` in the app, the simulated lights in tests. */
export type Send = (brand: Brand, id: string, m: NetMessage) => Promise<Reply>;

const initial = (): LampView => ({
  power: null,
  brightness: null,
  mode: null,
  segments: [[255, 255, 255]],
  segmentBrightness: [100],
  kelvin: null,
  scene: null,
  firmware: null,
  music: null,
  sync: null,
});

const answerOf = (r: Reply): Json | Uint8Array | null => (r.kind === "json" ? r.body : r.kind === "bytes" ? Uint8Array.from(r.bytes) : null);

/** Whether an error means the light (or its bridge) wants pairing again. */
export const wantsPairing = (why: string) => /pair/i.test(why);

export class NetLightController {
  readonly device: NetDevice;
  readonly brand: NetBrand;
  readonly segments = 1;
  /** The white range (null: colour only), as a lamp page's Light tab reads it. */
  readonly spec: { kelvin: readonly [number, number] | null };
  /** A light with white only (Elgato's Key Light). */
  readonly whiteOnly: boolean;
  view: LampView = initial();
  onError: (why: string) => void = () => {};
  #send: Send;
  #subs = new Set<() => void>();
  #dirty = new Set<Change>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #confirm: ReturnType<typeof setTimeout> | null = null;
  #busy = false;
  #last = 0;
  #closed = false;

  constructor(device: NetDevice, send: Send) {
    this.device = device;
    this.brand = NET_BRANDS[device.brand];
    this.#send = send;
    this.whiteOnly = !this.brand.colour || this.brand.colourTo(device, [255, 0, 0], this.#now()).length === 0;
    this.spec = { kelvin: this.brand.kelvin };
  }

  subscribe = (cb: () => void) => {
    this.#subs.add(cb);
    return () => {
      this.#subs.delete(cb);
    };
  };
  getView = () => this.view;

  #set(patch: Partial<LampView>) {
    this.view = { ...this.view, ...patch };
    this.#subs.forEach((cb) => cb());
  }

  #now(): NetState {
    const v = this.view;
    return { power: v.power, brightness: v.brightness, colour: v.mode === "white" ? null : (v.segments[0] ?? null), kelvin: v.mode === "white" ? v.kelvin : null };
  }

  /** Asks the light what it shows. */
  async refresh(): Promise<void> {
    const answers: (Json | Uint8Array | null)[] = [];
    for (const m of this.brand.query(this.device)) answers.push(answerOf(await this.#send(this.device.brand, this.device.id, m)));
    if (this.#closed || this.#dirty.size || this.#busy) return;
    const s = this.brand.read(this.device, answers);
    const patch: Partial<LampView> = {};
    if (s.power != null) patch.power = s.power;
    if (s.brightness != null) patch.brightness = s.brightness;
    if (s.kelvin) Object.assign(patch, { mode: "white", kelvin: s.kelvin, segments: [kelvinRgb(s.kelvin)] });
    else if (s.colour) Object.assign(patch, { mode: "colour", segments: [s.colour] });
    else if (this.view.mode === null) patch.mode = this.whiteOnly ? "white" : "colour";
    this.#set(patch);
  }

  setPower(on: boolean) {
    this.#set({ power: on });
    this.#queue("power");
  }
  setBrightness(percent: number) {
    this.#set({ brightness: Math.max(1, Math.min(100, Math.round(percent))), power: true });
    this.#queue("brightness");
  }
  setColour(rgb: Rgb) {
    if (this.whiteOnly) return;
    this.#set({ mode: "colour", segments: [rgb], power: true });
    this.#queue("colour");
  }
  setWhite(kelvin: number) {
    if (!this.brand.kelvin) return;
    this.#set({ mode: "white", kelvin, segments: [kelvinRgb(kelvin)], power: true });
    this.#queue("colour");
  }

  async close() {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#confirm) clearTimeout(this.#confirm);
    this.#subs.clear();
  }

  #build(c: Change): NetMessage[] {
    const d = this.device;
    const now = this.#now();
    if (c === "power") return this.brand.power(d, this.view.power !== false);
    if (c === "brightness") return this.brand.brightness(d, this.view.brightness ?? 100, now);
    return this.view.mode === "white" && this.view.kelvin ? this.brand.white(d, this.view.kelvin, now) : this.brand.colourTo(d, this.view.segments[0], now);
  }

  #queue(c: Change) {
    // The latest of each kind of change, sent in the order they were last made.
    this.#dirty.delete(c);
    this.#dirty.add(c);
    if (this.#confirm) clearTimeout(this.#confirm);
    this.#kick();
  }

  #kick() {
    if (this.#timer || this.#busy || this.#closed || !this.#dirty.size) return;
    const wait = Math.max(0, this.#last + NET_PACE_MS[this.device.brand] - Date.now());
    this.#timer = setTimeout(() => void this.#flush(), wait);
  }

  async #flush() {
    this.#timer = null;
    const c = this.#dirty.values().next().value;
    if (!c || this.#closed) return;
    this.#dirty.delete(c);
    this.#busy = true;
    try {
      for (const [i, m] of this.#build(c).entries()) {
        if (i) await new Promise((r) => setTimeout(r, NET_PACE_MS[this.device.brand]));
        await this.#send(this.device.brand, this.device.id, m);
      }
    } catch (e) {
      this.onError(e instanceof Error ? e.message : String(e));
    } finally {
      this.#busy = false;
      this.#last = Date.now();
    }
    if (this.#dirty.size) return this.#kick();
    this.#confirm = setTimeout(() => void this.refresh().catch(() => {}), CONFIRM_MS[this.device.brand]);
  }
}
