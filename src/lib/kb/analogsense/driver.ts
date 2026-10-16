// AnalogSense keyboards in SYNQ's generic Keyboard panel: read-only (plan() always throws), plus
// live key depth through `live()`. The shared contract (src/lib/kb/types.ts) has no live-depth hook
// yet, so the backend adds one: `LiveDepthBackend`. A panel for a board another driver claims (VIA
// for Keychron, OpenMouse for Wooting) can still use liveDepthFor() from live.ts on the depth collection.
//
// From AnalogSense (MIT, Copyright (c) 2024 Calamity, Inc.); see devices.ts for sources.
import type { BlockedCommand, HidLike, KbBackend, KbChange, KbContext, KbDriver, KbPlan, KbState, KbSupport } from "../types.ts";
import { FAMILIES, MODELS, findModel, type AnalogModel } from "./devices.ts";
import { AnalogLive, type LiveOptions } from "./live.ts";
import { fwModel, isFwUpgrader } from "../../brands/fw19f5/devices.ts";
import { keychronModel } from "../via/keychron/devices.ts";

/**
 * Ids a configuring driver owns: AnalogSense leaves them alone, so one driver claims each id. The 0x19F5 family's, and the
 * Keychron / Lemokey Hall-effect boards, which VIA's driver now reads and changes through Keychron's analog commands.
 */
const ownedElsewhere = (d: { vendorId: number; productId: number }): boolean =>
  fwModel(d.vendorId, d.productId) !== null || isFwUpgrader(d.vendorId, d.productId) || keychronModel(d.vendorId, d.productId) !== null;

export const ANALOGSENSE_BLOCKED: readonly BlockedCommand[] = [
  { what: "Every settings write: SYNQ only reads key depth on these boards", why: "unverified" },
  { what: "VIA bootloader jump, EEPROM reset and keymap reset (Keychron, Lemokey, Madlions share VIA's channel)", why: "bootloader" },
  { what: "Keychron 0xA9 commands other than the depth reads (profiles, calibration, save)", why: "calibration" },
  { what: "Razer's analog device mode (Synapse switches it on; SYNQ never does)", why: "identity" },
  { what: "Any command to Wooting, Razer or NuPhy boards: their depth arrives unasked", why: "unverified" },
  { what: "Any DrunkDeer or Redragon command other than the depth request", why: "unverified" },
];

export interface LiveDepthBackend extends KbBackend {
  /** A live depth source; start() it while the live view is visible, stop() when it closes. */
  live(opts?: LiveOptions): AnalogLive;
}

export class AnalogSenseBackend implements LiveDepthBackend {
  readonly driver = "analogsense";
  readonly dev: HidLike;
  readonly model: AnalogModel;
  readonly #views = new Set<AnalogLive>();
  #state: KbState;

  constructor(dev: HidLike, model: AnalogModel) {
    this.dev = dev;
    this.model = model;
    this.#state = this.#build();
  }

  get state(): KbState {
    return this.#state;
  }

  get support(): KbSupport {
    return { tier: "read-only", why: "Live key depth only (AnalogSense). SYNQ never changes this keyboard's settings." };
  }

  get blocked(): readonly BlockedCommand[] {
    return ANALOGSENSE_BLOCKED;
  }

  #build(): KbState {
    const f = FAMILIES[this.model.family];
    return {
      info: {
        brand: this.model.vendorId === 0x362d ? "Lemokey" : f.brand,
        model: this.model.productId === null ? this.dev.productName || this.model.name : this.model.name,
        driver: "analogsense",
        protocol: `AnalogSense live depth (${f.mode === "stream" ? "streamed by the keyboard" : "polled by SYNQ"})`,
        firmware: [],
        connection: "USB",
        extra: [["USB id", `${this.dev.vendorId.toString(16).padStart(4, "0")}:${this.dev.productId.toString(16).padStart(4, "0")}`]],
      },
      notes: [...f.notes, "Settings aren't read or changed here; this keyboard is listed for its live key depth."],
    };
  }

  /** Nothing to read: depth only flows while a live view runs. */
  async load(): Promise<KbState> {
    this.#state = this.#build();
    return this.#state;
  }

  plan(_change: KbChange): KbPlan {
    throw new Error("SYNQ only shows live key depth for this keyboard; it doesn't change its settings.");
  }

  live(opts?: LiveOptions): AnalogLive {
    const v = new AnalogLive(this.dev, this.model, opts);
    this.#views.add(v);
    return v;
  }

  snapshot(): unknown {
    return { driver: "analogsense", family: this.model.family, model: this.model.name };
  }

  async close(): Promise<void> {
    for (const v of this.#views) await v.stop();
    this.#views.clear();
  }
}

export const analogsenseDriver: KbDriver = {
  id: "analogsense",
  name: "AnalogSense (live key depth, read-only)",
  // Below every configuring driver: VIA / OpenMouse keep Keychron and Wooting boards when they claim them.
  priority: 5,
  vids: [...new Set(MODELS.map((m) => m.vendorId))],
  claims: (d) => !ownedElsewhere(d) && findModel(d as unknown as Parameters<typeof findModel>[0]) !== null,
  async open(device: HidLike, _ctx: KbContext): Promise<KbBackend> {
    const model = findModel(device as unknown as Parameters<typeof findModel>[0]);
    if (!model) throw new Error("Not a listed analog keyboard.");
    return new AnalogSenseBackend(device, model);
  },
  /** No I/O: stream keyboards can't be asked anything, and a depth request isn't worth a ping. Listed + present = yes. */
  async ping(device: HidLike): Promise<boolean> {
    return !ownedElsewhere(device) && findModel(device as unknown as Parameters<typeof findModel>[0]) !== null;
  },
};
