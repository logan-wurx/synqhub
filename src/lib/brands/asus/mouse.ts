// ASUS Gear Link mice: a guarded read / write / read-back session (local BrandMouseSession interface in
// ../types.ts; no shared mouse-driver contract exists outside OpenMouse's).
//
// Each change: one `51 31` (or `50 02`) frame through the ASUS guard, then `50 03` (save) as Gear Link
// does, then the matching read (`12 04 00`, `12 04 04`, `12 00`) and a comparison. Lift-off is read
// (`12 06 01`) but never written: `51 35 01` means LOD on some models and manual sensor calibration on
// others, so the guard blocks every `51 35` for mice.
import { FrameSession } from "../frame-session.ts";
import { emptyMouseSettings, verdictOf, type BrandMouseSession, type HidLike, type MouseChange, type MouseFeatures, type MouseSettings, type MouseWriteResult } from "../types.ts";
import { ASUS_VID, asusControlReportId, asusModel, asusMouseFeatures, asusMouseTraits, type AsusModel, type AsusMouseTraits } from "./devices.ts";
import { ASUS_BLOCKED, classifyAsusFrame } from "./guard.ts";
import * as M from "./mouse-codec.ts";

const LOD_LABEL = ["Low", "Mid", "High"];

export function claimsAsusMouse(vendorId: number, productId: number): AsusModel | null {
  if (vendorId !== ASUS_VID) return null;
  const m = asusModel(productId);
  return m && m.kind === "mouse" ? m : null;
}

export class AsusMouseSession implements BrandMouseSession {
  readonly model: AsusModel;
  readonly traits: AsusMouseTraits;
  readonly features: MouseFeatures;
  readonly blocked = ASUS_BLOCKED;
  readonly link: FrameSession;
  readonly length: number;
  #last: MouseSettings = emptyMouseSettings();

  /**
   * `reportLength`: the 0xFF01 output report length from the descriptor (64 on most, 63 on some).
   * `allowWrites`: the experimental tier's "Allow changes" switch; writes are refused while it is off.
   */
  constructor(device: HidLike, model: AsusModel, opts: { reportLength?: number; allowWrites?: () => boolean; log?: (d: "out" | "in", b: Uint8Array, n?: string) => void } = {}) {
    if (model.kind !== "mouse") throw new Error("not an ASUS mouse");
    this.model = model;
    this.traits = asusMouseTraits(model);
    this.features = asusMouseFeatures(model);
    this.length = opts.reportLength ?? 64;
    this.link = new FrameSession({
      device,
      reportId: (() => {
        const id = asusControlReportId((device.collections ?? []) as Parameters<typeof asusControlReportId>[0], 0xff01);
        if (id < 0) throw new Error("The mouse's control collection uses an unexpected report id; SYNQ won't guess.");
        return id;
      })(),
      length: this.length,
      guard: (f) => classifyAsusFrame(model.pid, f),
      isAnswer: M.isAnswer,
      isRejected: M.isRejected,
      timeoutFor: (f) => (f[0] === 0x50 ? 1500 : 600),
      allowWrites: opts.allowWrites,
      log: opts.log,
    });
  }

  get last(): MouseSettings {
    return this.#last;
  }

  async read(): Promise<MouseSettings> {
    const L = this.length;
    const info = M.decodeInfo(await this.link.request(M.encodeReadInfo(L)));
    const perf = M.decodePerformance(this.traits, await this.link.request(M.encodeReadPerformance(L)));
    const s: MouseSettings = {
      ...emptyMouseSettings(),
      firmware: info.firmware,
      profile: info.profile,
      activeStage: info.activeStage > 0 ? info.activeStage - 1 : null,
      dpi: perf.dpi,
      pollingHz: perf.pollingHz,
      debounceMs: this.traits.debounce ? perf.debounceMs : null,
      angleSnap: this.traits.angleSnap ? perf.angleSnap : null,
    };
    if (this.traits.motionSync) s.motionSync = M.decodeMotionSync(await this.link.request(M.encodeReadMotionSync(L)));
    const lod = M.decodeLod(await this.link.request(M.encodeReadLod(L)));
    s.liftOff = lod.mode === 0 ? lod.level : null;
    s.liftOffLabel = lod.mode === 0 ? (LOD_LABEL[lod.level] ?? null) : lod.mode === 1 ? "Asymmetric" : "Calibrated";
    if (this.model.manifest.flags.hasPowerInfo) s.battery = M.decodeBattery(await this.link.request(M.encodeReadBattery(L)));
    this.#last = s;
    return s;
  }

  /** The frame for a change (validated, guard-checked), without sending it. */
  frameFor(c: MouseChange): Uint8Array {
    const t = this.traits;
    const L = this.length;
    let f: Uint8Array;
    switch (c.kind) {
      case "dpi":
        f = M.encodeDpiStage(t, c.stage, c.dpi, undefined, L);
        break;
      case "activeStage":
        f = M.encodeActiveStage(t, c.stage, L);
        break;
      case "polling":
        f = M.encodePolling(t, c.hz, L);
        break;
      case "debounce":
        f = M.encodeDebounce(t, c.ms, L);
        break;
      case "angleSnap":
        f = M.encodeAngleSnap(t, c.on, L);
        break;
      case "motionSync":
        f = M.encodeMotionSync(t, c.on, L);
        break;
      case "profile":
        f = M.encodeSelectProfile(c.index, 5, L);
        break;
      case "liftOff":
        throw new Error("Lift-off is read-only on ASUS mice in SYNQ: its command doubles as sensor calibration on some models.");
    }
    const v = classifyAsusFrame(this.model.pid, f);
    if (v.verdict === "blocked") throw new Error(`SYNQ won't send that (${v.what}).`);
    return f;
  }

  async apply(c: MouseChange): Promise<MouseWriteResult> {
    const f = this.frameFor(c);
    await this.link.request(f);
    await this.link.request(M.encodeSave(this.length));
    const s = await this.read();
    const pick = (): [unknown, unknown] => {
      switch (c.kind) {
        case "dpi":
          return [c.dpi, s.dpi?.[c.stage]];
        case "activeStage":
          return [c.stage, s.activeStage];
        case "polling":
          return [c.hz, s.pollingHz];
        case "debounce":
          return [c.ms, s.debounceMs];
        case "angleSnap":
          return [c.on, s.angleSnap];
        case "motionSync":
          return [c.on, s.motionSync];
        case "profile":
          return [c.index, s.profile];
        default:
          return [null, undefined];
      }
    };
    const [expected, got] = pick();
    return { verdict: verdictOf(expected, got === null ? undefined : got), expected, got, persistence: "saved" };
  }

  close(): Promise<void> {
    return this.link.close();
  }
}
