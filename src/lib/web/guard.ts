// The website's last line of defence. On the desktop every report to a device passes the Rust bridge
// (src-tauri/src/hid.rs `send_report`, `send_report_to`, `send_feature_report`, `receive_feature_report`
// and brands.rs `check_with`) after the TypeScript guard in the driver. A browser has no bridge, so
// this is the same second check, written in TypeScript and put in front of the real WebHID device
// (src/lib/web/proxy.ts) before anything is sent: the brand / QMK (VIA, Vial) / X68 HE / ATK X1 /
// OpenMouse guards, plus the firmware-update (bootloader) refusal.
//
// It reuses the drivers' own TypeScript guards (the first line of defence on the desktop), chosen the
// way the Rust bridge chooses its guard: by USB id and collection (src/lib/web/policy.ts). The Advanced
// section is desktop-only for now, so no scope is ever granted here: everything that needs an Advanced
// token (pairing, button / key / macro writes, switch calibration, resets) is refused. Firmware,
// bootloader and DFU commands have no scope on any platform.
//
// Pure TypeScript: no DOM, no React, no device access. scripts/web-guard.test.ts runs the existing
// frame fixtures (the ones the Rust tests use) through it and expects the Rust verdicts.
import {
  RAZER,
  X68_CONFIG_COLLECTION,
  X68_FRAME_LEN,
  X68_REPORT_ID,
  atkDevice,
  brandDevice,
  keychronHe,
  channelNameOk,
  collectionAccess,
  inBootloader,
  razerFeatureOnly,
  viaGuarded,
  type Access,
  type Channel,
} from "./policy.ts";
import { isIllumipcId } from "../illumipc/ids.ts";
import { padGuardOf } from "../controllers/pads.ts";
import { checkPadFeatureGet, checkPadFeatureSet, checkPadOutput } from "../controllers/guard.ts";
import type { PadGuard } from "../controllers/types.ts";
import type { OutgoingReport } from "../brands/types.ts";

/** Why a report was not sent. The text is meant for the person, so it says what and why. */
export class GuardRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardRefusal";
  }
}

const refuse = (message: string): never => {
  throw new GuardRefusal(message);
};

const hex = (b: ArrayLike<number>, n = 8) => Array.from({ length: Math.min(b.length, n) }, (_, i) => b[i].toString(16).padStart(2, "0")).join(" ");
const h4 = (n: number) => n.toString(16).padStart(4, "0");

/** The parts of a WebHID collection the guard reads. */
export interface CollectionShape {
  usagePage: number;
  usage: number;
  outputReports?: readonly { reportId?: number; items?: readonly { reportSize?: number; reportCount?: number }[] }[];
}

/** What the guard needs to know about one device. */
export interface GuardTarget {
  vendorId: number;
  productId: number;
  productName?: string | null;
  collections: readonly CollectionShape[];
}

// ---------------------------------------------------------------------------------------------
// Per-brand checks (brands.rs `check_with`, one entry per `Guard`)
// ---------------------------------------------------------------------------------------------

type Transport = "output" | "feature";

/** Both verdict shapes the drivers' guards return (`what` or `name`). */
interface AnyVerdict {
  verdict: "read" | "write" | "blocked";
  what?: string;
  name?: string;
  reason?: string;
}

/** The brand's guard, loaded for one device: throws GuardRefusal, or returns what the frame is. */
interface BrandCheck {
  check(transport: Transport, reportId: number, data: Uint8Array): string;
  /** An input report from the device (Logitech learns feature indexes from IRoot replies). */
  observe?(reportId: number, data: Uint8Array): void;
}

const fromVerdict = (v: AnyVerdict): string => {
  const what = v.what ?? v.name ?? "frame";
  if (v.verdict === "blocked") return refuse(`Blocked: ${what}${v.reason ? ` (${v.reason})` : ""}.`);
  return what;
};

const fromCommandGuard = (guard: { classify(r: OutgoingReport): AnyVerdict }): BrandCheck => ({
  check: (transport, reportId, data) => fromVerdict(guard.classify({ type: transport, reportId, data })),
});

/** Output length of the channel's report from its descriptor; 64 when unknown (brands.rs `out_len`). */
function outputLength(target: GuardTarget, channel: Channel): number {
  for (const c of target.collections) {
    if (!channel.collections.some(([page, usage]) => page === c.usagePage && (usage === null || usage === c.usage))) continue;
    for (const r of c.outputReports ?? []) {
      if (!channel.reportIds.includes(r.reportId ?? 0)) continue;
      const bits = (r.items ?? []).reduce((n, i) => n + (i.reportSize ?? 0) * (i.reportCount ?? 0), 0);
      if (bits >= 8) return Math.floor(bits / 8);
    }
  }
  return 64;
}

async function loadBrandCheck(channel: Channel, target: GuardTarget): Promise<BrandCheck> {
  const pid = target.productId;
  switch (channel.guard) {
    case "sonix": {
      const { checkFrame } = await import("../kb/fcc/sonix-protocol.ts");
      return {
        check(_t, _r, data) {
          const v = checkFrame(data);
          return v.ok ? v.name : refuse(`Blocked: ${v.reason ?? v.name}`);
        },
      };
    }
    case "monsgeek":
      return fromCommandGuard((await import("../brands/monsgeek/guard.ts")).MONSGEEK_GUARD);
    case "rk-beiying":
      return fromCommandGuard((await import("../brands/rk-beiying/guard.ts")).RK_BEIYING_GUARD);
    case "sparklink":
      return fromCommandGuard((await import("../brands/sparklink/guard.ts")).SPARKLINK_GUARD);
    case "fw19f5-mchose":
    case "fw19f5-drunkdeer":
    case "fw19f5-readonly": {
      const { FW_GUARDS } = await import("../brands/fw19f5/guard.ts");
      return fromCommandGuard(FW_GUARDS[channel.guard.slice("fw19f5-".length) as keyof typeof FW_GUARDS]);
    }
    case "drunkdeer":
      return fromCommandGuard((await import("../brands/drunkdeer/guard.ts")).DRUNKDEER_GUARD);
    case "bytech": {
      const { checkAnalogFrame } = await import("../kb/analogsense/protocol.ts");
      return {
        check(transport, reportId, data) {
          const v = checkAnalogFrame("bytech", reportId, data, transport);
          return v.ok ? v.name : refuse(`Blocked: ${v.reason}`);
        },
      };
    }
    case "razer":
      return fromCommandGuard((await import("../brands/razer/guard.ts")).razerGuard);
    case "asus": {
      const { asusGuard } = await import("../brands/asus/guard.ts");
      return fromCommandGuard(asusGuard(pid));
    }
    case "bragi": {
      const [{ BragiGuardState, classifyBragiFrame }, { CORSAIR_MODELS }] = await Promise.all([import("../brands/corsair/guard.ts"), import("../brands/corsair/devices.ts")]);
      const model = CORSAIR_MODELS.get(pid);
      if (!model?.framing) return { check: () => refuse("Refused: not a Corsair Bragi device in SYNQ's table.") };
      const framing = model.framing;
      const length = outputLength(target, channel);
      const state = new BragiGuardState(framing, model.family, length);
      return {
        check(_t, _r, data) {
          // Like the bridge (brands.rs `bragi`): the open file is remembered here, a session isn't tracked.
          const what = fromVerdict(classifyBragiFrame({ framing, family: model.family, openFile: state.openFile, length }, data));
          state.observe(data); // only an allowed frame gets here
          return what;
        },
      };
    }
    case "sabre": {
      const { classifySabreFrame } = await import("../brands/corsair/sabre.ts");
      return { check: (_t, _r, data) => fromVerdict(classifySabreFrame(data)) };
    }
    case "icue":
      return fromCommandGuard(new (await import("../brands/corsair-icue/guard.ts")).CorsairIcueGuard());
    case "logitech-kb": {
      const { LogitechKbGuard } = await import("../brands/logitech-kb/guard.ts");
      const map = new Map<number, number>();
      /** (device index, software id) -> the feature id an IRoot.getFeature asked for. */
      const pending = new Map<string, number>();
      return {
        check(transport, reportId, data) {
          const what = fromVerdict(new LogitechKbGuard(map).classify({ type: transport, reportId, data }));
          if (data[1] === 0x00 && data[2] >> 4 === 0) pending.set(`${data[0]}:${data[2] & 0x0f}`, (data[3] << 8) | data[4]);
          return what;
        },
        observe(reportId, data) {
          if (reportId < 0x10 || reportId > 0x12 || data.length < 4 || data[1] !== 0x00 || data[2] >> 4 !== 0) return;
          const k = `${data[0]}:${data[2] & 0x0f}`;
          const feature = pending.get(k);
          if (feature === undefined) return;
          pending.delete(k);
          if (data[3] !== 0) map.set(data[3], feature);
        },
      };
    }
    case "steelseries": {
      const [{ guardFor, STEELSERIES_GUARD }, { MODELS }] = await Promise.all([import("../brands/steelseries/guard.ts"), import("../brands/steelseries/devices.ts")]);
      const model = MODELS.find((m) => m.productId === pid);
      if (!model) return { check: () => refuse("Refused: not a SteelSeries keyboard in SYNQ's table.") };
      // The Rust bridge narrows to the model's family (`steelseries(Some(family), ...)`); so does this.
      return fromCommandGuard(model.family === "other" ? STEELSERIES_GUARD : guardFor(model));
    }
    case "headset": {
      const [{ checkHeadsetFrame }, { findHeadset }] = await Promise.all([import("../headsets/guard.ts"), import("../headsets/protocol.ts")]);
      const model = findHeadset(target.vendorId, pid);
      if (!model) return { check: () => refuse("Refused: not a headset in SYNQ's table.") };
      return {
        check: (_t, reportId, data) => {
          const v = checkHeadsetFrame(model, { reportId, data });
          return v.ok && v.what ? v.what : refuse("Refused: not a headset frame SYNQ builds.");
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The hand-built devices' frame checks (hid.rs)
// ---------------------------------------------------------------------------------------------

/** The Razer rule for OpenMouse's Razer mice (hid.rs `razer_frame_allowed`). */
export function razerFrameAllowed(reportId: number, data: Uint8Array, strictShape: boolean): void {
  if (strictShape && (reportId !== 0 || data.length !== 90)) refuse(`A Razer mouse only takes report 0 with 90 bytes here (got report ${reportId}, ${data.length} bytes).`);
  if (reportId === 0 && data.length > 7 && data[6] === 0x00 && (data[7] === 0x04 || data[7] === 0x84)) refuse("Blocked: Razer's device-mode command (it can switch the mouse into its bootloader or test mode).");
}

/** Keychron / Lemokey and Madlions boards whose key depth AnalogSense reads over the raw-HID channel (hid.rs). */
const KEYCHRON_ANALOG: readonly (readonly [number, number])[] = [
  [0x3434, 0x0b10], [0x3434, 0x0b11], [0x3434, 0x0b12], [0x3434, 0x0b30], [0x3434, 0x0b50],
  [0x3434, 0x0e20], [0x3434, 0x0e21], [0x3434, 0x0e22], [0x362d, 0x0610], [0x362d, 0x0611],
];
const MADLIONS_ANALOG: readonly (readonly [number, number])[] = [
  [0x373b, 0x1053], [0x373b, 0x1054], [0x373b, 0x1055], [0x373b, 0x1056], [0x373b, 0x105d],
  [0x373b, 0x1058], [0x373b, 0x1059], [0x373b, 0x105a], [0x373b, 0x105c], [0x373b, 0x10a7],
];
const inList = (list: readonly (readonly [number, number])[], v: number, p: number) => list.some(([lv, lp]) => lv === v && lp === p);

/** hid.rs `analog_raw_read_allowed`: the only non-VIA frames a QMK raw-HID collection takes (never a write, never calibration). */
export function analogRawReadAllowed(v: number, p: number, d: Uint8Array): boolean {
  if (d.length !== 32) return false;
  const zero = (from: number) => d.subarray(from).every((b) => b === 0);
  if (inList(KEYCHRON_ANALOG, v, p) && d[0] === 0xa9) return ((d[1] === 0x01 || d[1] === 0x31) && zero(2)) || (d[1] === 0x30 && d[2] < 6 && d[3] < 19 && zero(4));
  if (inList(MADLIONS_ANALOG, v, p)) return d[0] === 0x02 && d[1] === 0x96 && d[2] === 0x1c && d[3] === 0 && d[4] === 0 && d[5] === 0 && d[6] % 4 === 0 && d[6] < 75 && d[7] === 4 && zero(8);
  return false;
}

// ---------------------------------------------------------------------------------------------
// The guard for one device
// ---------------------------------------------------------------------------------------------

/** One collection the guard lets a driver use, with how. */
interface OpenCollection {
  usagePage: number;
  usage: number;
  access: Access;
  /** A QMK raw-HID collection: only checked VIA / Vial frames, only through `outputTo`. */
  via: boolean;
}

export class DeviceGuard {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly channel: Channel | null;
  /** The collections of this device a driver may use (everything else stays closed). */
  readonly open: readonly OpenCollection[];
  readonly #brand: BrandCheck | null;
  #atk: ((f: Uint8Array) => string | null) | null = null;
  #x68: ((f: Uint8Array) => string | null) | null = null;
  #via: ((f: Uint8Array) => string | null) | null = null;
  /** Keychron's Hall-effect tier for the ids policy.ts names (hid.rs `keychron_he_frame_allowed`). */
  #keychron: ((f: Uint8Array) => boolean) | null = null;
  /** A game controller: what may be sent to it (src/lib/controllers/guard.ts; the bridge: pads.rs). */
  readonly #pad: PadGuard | null;

  private constructor(target: GuardTarget, brand: BrandCheck | null, channel: Channel | null) {
    this.vendorId = target.vendorId;
    this.productId = target.productId;
    this.productName = target.productName ?? "";
    this.channel = channel;
    this.#brand = brand;
    this.#pad = padGuardOf(target.vendorId, target.productId);
    this.open = target.collections.flatMap((c) => {
      const access = collectionAccess(target.vendorId, target.productId, c.usagePage, c.usage);
      return access ? [{ usagePage: c.usagePage, usage: c.usage, access, via: viaGuarded(target.vendorId, target.productId, c.usagePage, c.usage) }] : [];
    });
  }

  /**
   * Builds the guard and loads every TypeScript guard the device needs first (the brand's, the QMK one,
   * the X1's, the X68 HE's), so each check afterwards is synchronous.
   */
  static async create(target: GuardTarget): Promise<DeviceGuard> {
    const channel = brandDevice(target.vendorId, target.productId);
    const brand = channel && channelNameOk(channel, target.productName) ? await loadBrandCheck(channel, target) : null;
    const guard = new DeviceGuard(target, brand, channel);
    await guard.#load();
    return guard;
  }

  /** Loads the hand-built devices' frame checks this device needs (the ATK X1, the X68 HE, QMK raw HID). */
  async #load(): Promise<void> {
    if (atkDevice(this.vendorId, this.productId)) {
      const { checkFrame } = await import("../atk-protocol.ts");
      this.#atk = (f) => checkFrame(f);
    }
    if (isIllumipcId(this.vendorId, this.productId)) {
      const { checkFrame } = await import("../x68he-protocol.ts");
      this.#x68 = (f) => {
        const v = checkFrame(f);
        return v.ok ? null : (v.reason ?? "not on SYNQ's list");
      };
    }
    if (this.open.some((c) => c.via)) {
      const { checkViaFrame } = await import("../kb/via/guard.ts");
      this.#via = (f) => {
        const v = checkViaFrame(f);
        return v.ok ? null : v.why;
      };
      if (keychronHe(this.vendorId, this.productId)) {
        const { checkKeychronFrame } = await import("../kb/via/keychron/guard.ts");
        this.#keychron = (f) => checkKeychronFrame(f).ok;
      }
    }
  }

  /** Whether any collection of this device may be used at all. */
  get usable(): boolean {
    return !this.bootloader && this.open.length > 0 && (!this.channel || this.#brand !== null);
  }

  /** In firmware-update mode, by id or by what it calls itself: nothing is ever sent. */
  get bootloader(): boolean {
    return inBootloader(this.vendorId, this.productId, this.productName);
  }

  #notBootloader(): void {
    if (this.bootloader) refuse("This device is in firmware-update mode; SYNQ never sends it anything. Finish or cancel the update in the maker's tool.");
  }

  /** pads.rs `check_output`: a controller takes only the exact frames of its guard. */
  #padOutput(reportId: number, data: Uint8Array): void {
    if (!this.#pad) return;
    const v = checkPadOutput(this.#pad, reportId, data);
    if (!v.ok) refuse(v.why);
  }

  /** hid.rs `refuse_x68`. */
  #refuseX68(what: string): void {
    if (isIllumipcId(this.vendorId, this.productId)) refuse(`${what} isn't used for the X68 HE; SYNQ only sends it checked output reports on FF1B:0091.`);
  }

  /** hid.rs `atk_guard`: every report to the X1 passes the ATK frame check, with no Advanced scope. */
  #atkOk(reportId: number, data: Uint8Array): void {
    if (!atkDevice(this.vendorId, this.productId)) return;
    if (reportId !== 0x08 || data.length !== 16) refuse(`ATK frames are report 8, 16 bytes (got report ${reportId}, ${data.length} bytes).`);
    const why = this.#atk!(data);
    if (why !== null) refuse(`Blocked: ${why}.`);
  }

  /** brands.rs `check_with`: transport, report id, then the brand's guard. */
  #brandCheck(transport: Transport, reportId: number, data: Uint8Array): void {
    const c = this.channel;
    if (!c) return;
    if (!this.#brand) refuse(`Refused: ${c.brand} doesn't match this device (${this.productName || "unnamed"}).`);
    const ok = c.takes === "both" || (c.takes === "output" && transport === "output") || (c.takes === "feature" && transport === "feature");
    if (!ok) refuse(`${c.brand} takes ${c.takes === "feature" ? "feature reports" : "output reports"} only.`);
    if (!c.reportIds.includes(reportId)) refuse(`${c.brand} uses report [${c.reportIds.join(", ")}] (got ${reportId}).`);
    this.#brand!.check(transport, reportId, data);
  }

  /** A writer is a collection a plain output report may go to: full access, and not a QMK raw-HID collection. */
  get #writers(): readonly OpenCollection[] {
    return this.open.filter((c) => c.access === "full" && !c.via);
  }

  /**
   * An output report with no named collection (WebHID's `sendReport`). hid.rs `send_report`: never the
   * X68 HE (it has its own checked path), the X1 and brand frames are checked, and a QMK raw-HID
   * collection is never reached this way.
   */
  output(reportId: number, data: Uint8Array): void {
    this.#notBootloader();
    this.#padOutput(reportId, data);
    this.#refuseX68("An unrouted output report");
    this.#atkOk(reportId, data);
    this.#brandCheck("output", reportId, data);
    if (this.#writers.length === 0) refuse(`No collection of this device takes output reports (report 0x${reportId.toString(16).padStart(2, "0")}).`);
  }

  /** An output report to one named collection (the bridge's `send_report_to`, which VIA / Vial and the X68 HE use). */
  outputTo(usagePage: number, usage: number, reportId: number, data: Uint8Array): void {
    this.#notBootloader();
    this.#padOutput(reportId, data);
    if (isIllumipcId(this.vendorId, this.productId)) {
      if (usagePage !== X68_CONFIG_COLLECTION[0] || usage !== X68_CONFIG_COLLECTION[1] || reportId !== X68_REPORT_ID) refuse(`The X68 HE only takes report ${X68_REPORT_ID} on FF1B:0091.`);
      if (data.length !== X68_FRAME_LEN) refuse(`X68 frames are ${X68_FRAME_LEN} bytes (got ${data.length}).`);
      const why = this.#x68!(data);
      if (why !== null) refuse(`Blocked X68 frame ${hex(data)}: ${why}`);
    }
    this.#atkOk(reportId, data);
    this.#brandCheck("output", reportId, data);
    const name = `${h4(usagePage)}:${h4(usage)}`;
    const w = this.open.find((c) => c.usagePage === usagePage && c.usage === usage);
    if (!w) return refuse(`Collection ${name} isn't open.`);
    if (w.access === "input") refuse(`Collection ${name} is read-only: nothing is ever sent to it.`);
    if (w.access === "feature") refuse(`Collection ${name} takes feature reports only.`);
    if (w.via) {
      if (reportId !== 0) refuse("QMK raw HID has no report ids; SYNQ only sends it report 0.");
      const why = this.#via!(data);
      if (why !== null && !analogRawReadAllowed(this.vendorId, this.productId, data) && !this.#keychron?.(data)) refuse(`Blocked: ${why}`);
    }
  }

  /** A feature report (WebHID's `sendFeatureReport`). hid.rs `send_feature_report`. */
  feature(reportId: number, data: Uint8Array): void {
    this.#notBootloader();
    if (this.#pad) {
      const v = checkPadFeatureSet(this.#pad, reportId, data);
      if (!v.ok) refuse(v.why);
    }
    this.#refuseX68("A feature report");
    if (atkDevice(this.vendorId, this.productId)) refuse("The ATK X1 takes output reports on its config channel only; no feature report is ever sent.");
    if (this.channel) this.#brandCheck("feature", reportId, data);
    else if (this.vendorId === RAZER) razerFrameAllowed(reportId, data, this.open.some((c) => c.access === "feature"));
    if (!this.open.some((c) => c.access === "feature") && this.#writers.length === 0) refuse(`No collection of this device takes feature reports (report 0x${reportId.toString(16).padStart(2, "0")}).`);
  }

  /** Reading a feature report (`receiveFeatureReport`). hid.rs `receive_feature_report`. */
  receiveFeature(reportId: number): void {
    this.#notBootloader();
    if (this.#pad) {
      const v = checkPadFeatureGet(this.#pad, reportId);
      if (!v.ok) refuse(v.why);
    }
    this.#refuseX68("A feature report");
    const c = this.channel;
    if (c && (c.takes === "output" || !c.reportIds.includes(reportId))) refuse(`${c.brand} is only read with feature report [${c.reportIds.join(", ")}].`);
    if (!this.open.some((x) => x.access === "feature") && this.#writers.length === 0) refuse(`No collection of this device has feature report 0x${reportId.toString(16).padStart(2, "0")}.`);
  }

  /** An input report that arrived (Logitech's guard learns feature indexes from the device's own IRoot replies). */
  observeInput(reportId: number, data: Uint8Array): void {
    this.#brand?.observe?.(reportId, data);
  }

  /** Whether a feature-only Razer collection is open (the strict 90-byte shape applies). */
  get razerFeatureOnly(): boolean {
    return this.open.some((c) => c.access === "feature" && razerFeatureOnly(this.vendorId, this.productId, c.usagePage, c.usage));
  }
}
