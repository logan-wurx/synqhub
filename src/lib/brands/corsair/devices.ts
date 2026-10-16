// CORSAIR Web Hub devices (the 0x2Bxx generation) and how SYNQ drives each. Pure data.
//
// Identity: VID 0x1B1C + PID, from the Web Hub device table (devices.generated.ts). Families:
//   kb-he        Hall-effect / magnetic boards with per-key actuation files (Vanguard Pro 96 + GUMA,
//                Clipper Pro Mini 60, Vanguard Pro 60 Wireless, MAKR Pro 75 + Nene)
//   kb           other Web Hub keyboards: info, polling, profiles, brightness only
//   mouse-bragi  Bragi mice (Scimitar Elite W SE, Nightsword V2, Harpoon V2 W / v2, Sabre v3 Pro family)
//   mouse-sabre  Sabre v2 Pro family: NOT Bragi; an ATK-style EEPROM protocol on report 8 (sabre.ts)
//   receiver     SLIPSTREAM receivers (Bragi; devices behind them use addresses 1..7)
// Older 0x1Bxx Corsair gear (K70 MAX, iCUE-only) is not in this table and is never touched.
import { WEBHUB_DEVICES, WEBHUB_SNAPSHOT, type WebHubDevice } from "./devices.generated.ts";
import { BRAGI_USAGE_NOTIFY, BRAGI_USAGE_PAGE, BRAGI_USAGE_REQUEST, CORSAIR_UNIT_MM, CORSAIR_VID, type Framing } from "./bragi.ts";
import type { HidChannel, KeyboardFeatures, MouseFeatures, SupportTier } from "../types.ts";

export { CORSAIR_VID };

export type CorsairFamily = "kb-he" | "kb" | "mouse-bragi" | "mouse-sabre" | "receiver";

/**
 * Bragi 1.5 PIDs per the CORSAIR Web FW Updater's hard-coded list (`l_`). Web Hub agrees for every one
 * except 0x2B31 (Clipper Pro Mini 60), which it drives with 1.0 framing; SYNQ follows Web Hub there.
 */
export const FWUPDATER_V15_PIDS: ReadonlySet<number> = new Set([
  0x2b0d, 0x2b0e, 0x2b1b, 0x2b1c, 0x2b0f, 0x2b21, 0x2b31, 0x2b0c, 0x2b3f, 0x2b40, 0x2b41, 0x2b42, 0x2b30, 0x2b43, 0x2b44, 0x2b45, 0x2b33, 0x2b3c, 0x2b54,
]);

/** Sabre v2 Pro mice and their receivers (Web Hub hands them to the Sabre Web Hub). */
export const SABRE_V2_PIDS: ReadonlySet<number> = new Set([0x2b25, 0x2b28, 0x2b29, 0x2b2a, 0x2b34, 0x2b35]);

export interface CorsairModel {
  pid: number;
  name: string;
  family: CorsairFamily;
  /** Bragi header layout; null for the Sabre v2 EEPROM family. */
  framing: Framing | null;
  /** Web Hub wraps file I/O in operating mode 2 for these (mice, receivers). Keyboards' file services wrap too. */
  hostControlForFiles: boolean;
  /** Analog keys: actuation range in mm (table `actuationDistanceRange.supported`), unit 0.1 mm. */
  actuationMm: readonly [number, number] | null;
  tier: SupportTier;
  table: WebHubDevice;
  sources: readonly string[];
}

const HE = new Set([0x2b0e, 0x2b54, 0x2b31, 0x2b30, 0x2b1a, 0x2b5b]);

function familyOf(d: WebHubDevice): CorsairFamily {
  if (SABRE_V2_PIDS.has(d.pid)) return "mouse-sabre";
  if (d.kind === "receiver") return "receiver";
  if (d.kind === "mouse") return "mouse-bragi";
  return HE.has(d.pid) && d.actuationMm ? "kb-he" : "kb";
}

function build(): Map<number, CorsairModel> {
  const out = new Map<number, CorsairModel>();
  for (const d of WEBHUB_DEVICES) {
    const family = familyOf(d);
    const framing: Framing | null = family === "mouse-sabre" ? null : d.multiSession ? "v15" : "v1";
    // A 0 mm minimum in the table means "off"; SYNQ writes at least one unit (0.1 mm).
    const act = d.actuationMm ? ([Math.max(CORSAIR_UNIT_MM, d.actuationMm[0]), d.actuationMm[1]] as const) : null;
    out.set(d.pid, {
      pid: d.pid,
      name: d.name,
      family,
      framing,
      hostControlForFiles: true,
      actuationMm: family === "kb-he" ? act : null,
      tier: family === "kb" || family === "receiver" ? "readOnly" : "experimental",
      table: d,
      sources: [`CORSAIR Web Hub device table (assets/BDiHBs-c.js \`l2e\`, snapshot ${WEBHUB_SNAPSHOT})`, "CORSAIR Web FW Updater v2.0.232 enums (Ct, Ke, Ft, Tt)"],
    });
  }
  return out;
}

export const CORSAIR_MODELS: ReadonlyMap<number, CorsairModel> = build();

export function corsairModel(productId: number): CorsairModel | null {
  return CORSAIR_MODELS.get(productId) ?? null;
}

export const corsairPids = (family: CorsairFamily): number[] => [...CORSAIR_MODELS.values()].filter((m) => m.family === family).map((m) => m.pid);

/** The Bragi request collection (output + input) and the notification collection (input only). */
export const BRAGI_CHANNELS: readonly HidChannel[] = [
  { role: "control", usagePage: BRAGI_USAGE_PAGE, usage: BRAGI_USAGE_REQUEST, reportId: 0, length: 64, direction: "output", note: "Length from the descriptor (64 on every known device)." },
  { role: "notify", usagePage: BRAGI_USAGE_PAGE, usage: BRAGI_USAGE_NOTIFY, reportId: 0, length: 64, direction: "input", note: "Property changes, key presses (KeyPressStateChange), analog key travel. SYNQ does not need it." },
];

/** Sabre v2 Pro channel: collection 0xFF02 usage 2 (receivers) or 0xFF01 usage 0 (wired mice), report 8, 16 bytes. */
export const SABRE_CHANNEL: HidChannel = { role: "control", usagePage: 0xff02, usage: 0x0002, reportId: 8, length: 16, direction: "output", note: "Sabre Web Hub uses the collection with exactly one input report, id 8." };

export function corsairKeyboardFeatures(m: CorsairModel): KeyboardFeatures {
  const a = m.actuationMm;
  const range = a ? { min: a[0], max: a[1], step: CORSAIR_UNIT_MM } : null;
  return {
    unitMm: a ? CORSAIR_UNIT_MM : null,
    actuation: range ? { range, perKey: true, readBack: "device" } : undefined,
    rapidTrigger: range ? { range: { min: 0.1, max: 2.0, step: 0.1 }, perKey: true, separatePressRelease: true, continuous: true, deadzone: range, readBack: "device" } : undefined,
    socd: a ? { name: "FlashTap", maxPairs: 1, modes: ["neutral", "last", "first"], readBack: "device" } : undefined,
    polling: { hz: m.table.pollingWiredHz, readBack: "device", reconnects: false },
    profiles: { count: m.table.profileMax ?? 1, save: "automatic", readBack: "device" },
  };
}

export function corsairMouseFeatures(m: CorsairModel): MouseFeatures {
  const dpi = m.table.dpi;
  return {
    dpi: dpi ? { min: dpi.min, max: dpi.max, step: dpi.step, stages: 5, separateXY: false, readBack: m.table.supportsProfile ? "unconfirmed" : "device" } : undefined,
    polling: { hz: m.table.pollingWiredHz, wirelessHz: m.table.pollingWirelessHz, readBack: "device" },
    liftOff: { values: [1, 2, 3, 4, 5], labels: { 1: "Lowest", 2: "Low", 3: "Medium", 4: "High", 5: "Highest" }, asymmetric: false, readBack: "device" },
    angleSnap: { readBack: "device" },
    motionSync: { readBack: "device" },
    debounceMs: { values: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14], readBack: "device" },
    battery: { readBack: "device" },
    profiles: m.table.supportsProfile ? { count: m.table.profileMax ?? 1, readBack: "device" } : undefined,
  };
}
