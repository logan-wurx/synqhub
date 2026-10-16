// One look for many lights (wave L5): a colour, a white or a gradient, a brightness and power, sent to every light in a
// group whatever it is. Each light is reached through a `Driver` (src/lib/lighting/look/drivers.ts opens them: a Govee
// lamp's controller, a Wi-Fi light's, a Dynamic Lighting device, a USB hub), and each driver keeps its own pace. The
// page shows the look as it was asked for; the lights' own pages show what each reports. Pure: no device here.
import { kelvinRgb, type Rgb } from "../govee/frames.ts";
import type { LampView } from "../lamp.ts";
import type { SyncEdge } from "../models.ts";

/** How one light takes a look. Only `colour` and `close` are required; the rest fall back to colour. */
export interface Driver {
  key: string;
  colour(rgb: Rgb): void;
  /** Colours spread from the light's first segment (or lamp, or LED) to its last. */
  gradient?(stops: readonly Rgb[]): void;
  white?(kelvin: number): void;
  brightness?(percent: number): void;
  power?(on: boolean): void;
  /** Screen sync: a Govee lamp starts its own; a hub gets ready (its backup kept) for the bridge's; `can` false when
   * it can't follow. A Wi-Fi light needs nothing here (the bridge drives it: look/sync.ts). */
  sync?: { can: boolean; start(edge: SyncEdge, vivid: boolean, monitor: string | null): Promise<void> };
  /** A hub's channels as the bridge drives them in sync: [channel, LED count]. */
  hubChannels?: readonly (readonly [number, number])[];
  close(): Promise<void>;
}

export type Look = { kind: "colour"; rgb: Rgb } | { kind: "white"; kelvin: number } | { kind: "gradient"; stops: readonly Rgb[] };

/** The middle of a gradient, for a light of one colour. */
export const middle = (stops: readonly Rgb[]): Rgb => stops[Math.floor((stops.length - 1) / 2)] ?? [255, 255, 255];

/** A colour at a brightness (for lights with no brightness of their own: Dynamic Lighting, hubs). */
export const dim = (c: Rgb, percent: number): Rgb => {
  const k = Math.max(0, Math.min(100, percent)) / 100;
  return [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];
};

const initial = (): LampView => ({
  power: true,
  brightness: 80,
  mode: "colour",
  segments: [[255, 255, 255]],
  segmentBrightness: [100],
  kelvin: null,
  scene: null,
  firmware: null,
  music: null,
  sync: null,
});

/** Every driver at once, shaped like a lamp's controls so the Light tab and the stage can drive it. */
export class LookControl {
  readonly segments = 1;
  readonly spec = { kelvin: [2700, 6500] as const };
  view: LampView = initial();
  look: Look = { kind: "colour", rgb: [255, 255, 255] };
  #drivers: Driver[] = [];
  #subs = new Set<() => void>();

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

  /** The lights the look goes to now; a light that joins takes the current look at once. */
  setDrivers(next: readonly Driver[]) {
    const known = new Set(this.#drivers.map((d) => d.key));
    this.#drivers = [...next];
    for (const d of next) if (!known.has(d.key)) this.#apply(d);
  }

  get drivers(): readonly Driver[] {
    return this.#drivers;
  }

  #apply(d: Driver) {
    if (this.view.power === false) return d.power ? d.power(false) : d.colour([0, 0, 0]);
    d.power?.(true);
    this.#look(d);
    d.brightness?.(this.view.brightness ?? 100);
  }

  #look(d: Driver) {
    const l = this.look;
    // Lights without a brightness of their own get the colour at the look's brightness.
    const b = d.brightness ? 100 : (this.view.brightness ?? 100);
    if (l.kind === "white") return d.white ? d.white(l.kelvin) : d.colour(dim(kelvinRgb(l.kelvin), b));
    if (l.kind === "gradient") return d.gradient ? d.gradient(b === 100 ? l.stops : l.stops.map((s) => dim(s, b))) : d.colour(dim(middle(l.stops), b));
    d.colour(dim(l.rgb, b));
  }

  setColour(rgb: Rgb) {
    this.look = { kind: "colour", rgb };
    this.#set({ mode: "colour", segments: [rgb], power: true });
    this.#drivers.forEach((d) => this.#look(d));
  }
  setWhite(kelvin: number) {
    this.look = { kind: "white", kelvin };
    this.#set({ mode: "white", kelvin, segments: [kelvinRgb(kelvin)], power: true });
    this.#drivers.forEach((d) => this.#look(d));
  }
  setGradient(stops: readonly Rgb[]) {
    this.look = { kind: "gradient", stops };
    this.#set({ mode: "segments", segments: stops, power: true });
    this.#drivers.forEach((d) => this.#look(d));
  }
  setBrightness(percent: number) {
    this.#set({ brightness: Math.max(1, Math.min(100, Math.round(percent))), power: true });
    for (const d of this.#drivers) {
      if (d.brightness) d.brightness(this.view.brightness ?? 100);
      else this.#look(d);
    }
  }
  setPower(on: boolean) {
    this.#set({ power: on });
    this.#drivers.forEach((d) => this.#apply(d));
  }

  async close() {
    const all = this.#drivers;
    this.#drivers = [];
    await Promise.allSettled(all.map((d) => d.close()));
  }
}
