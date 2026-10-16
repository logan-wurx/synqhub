// ASUS Gear Link allowlist: every frame SYNQ sends an ASUS device must match one of these rules,
// for that device's family. Anything else is refused, and the blocked rules below are checked first
// so a dangerous frame is named (firmware, calibration, reset...) instead of just "not listed".
//
// The same table is exported as JSON for the Rust bridge (scripts/brands-allowlist-fixture.ts writes
// src/lib/brands/asus/asus-rules.json and asus-frames.txt; see rules.ts for the 30-line matcher).
// Families: hfx (Falchion Ace HFX / ZywOo, captured), he-v1 (Azoth 96 HE, Falcata, Falchion Ace 75 HE),
// he-v2 (TX75 Analog, TX75 Core, K4 Magnetic), mech (Gear Link mechanical boards: reads only),
// mouse, receiver (reads only). Sources: docs/devices/asus-gearlink.md.
import { evaluate, type FrameRule } from "../rules.ts";
import type { BlockedCommand, CommandGuard, FrameVerdict, OutgoingReport } from "../types.ts";
import { ASUS_CONTROL_REPORT_IDS, ASUS_VID, asusGuardFamily, asusModel, isAsusBootloader } from "./devices.ts";

const ALL = ["*"];
const KB = ["hfx", "he-v1", "he-v2"];
const HE = ["he-v1", "he-v2"];
const KB_ANY = ["hfx", "he-v1", "he-v2", "mech"];
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** Units: 0.01 boards count actuation 1..400 (4.00 mm), the HFX 1..40 (4.0 mm). */
const ACT = { he: { min: 1, max: 400 }, hfx: { min: 1, max: 40 } };
const KEY = { min: 1, max: 0xff };

const blocked = (id: string, what: string, why: FrameRule["why"], bytes: FrameRule["bytes"], extra: Partial<FrameRule> = {}): FrameRule => ({
  id,
  what,
  verdict: "blocked",
  why,
  families: ALL,
  bytes,
  ...extra,
});
const b = (at: number, eq: number) => ({ at, eq });

export const ASUS_RULES: readonly FrameRule[] = [
  // ---- firmware / bootloader (Gear Link ota/main.js DCM) --------------------------------------
  blocked("boot-jump", "jump to bootloader `7B AA 'ASUS' AA`", "bootloader", [b(0, 0x7b), b(1, 0xaa), b(2, 0x41), b(3, 0x53), b(4, 0x55), b(5, 0x53), b(6, 0xaa)]),
  blocked("enter-boot", "ENTER_BOOT `7F 55 AA 55 AA` (TX75 Analog, same collection as settings)", "bootloader", [b(0, 0x7f), b(1, 0x55), b(2, 0xaa), b(3, 0x55), b(4, 0xaa)]),
  blocked("radio-isp", "2.4 GHz radio ISP `43 55 AA 55 AA` (TX75 Analog)", "bootloader", [b(0, 0x43), b(1, 0x55), b(2, 0xaa), b(3, 0x55), b(4, 0xaa)]),
  blocked("fwu-magic", "anything carrying the `ASUSHIDFWU` updater magic", "firmware", [], { contains: ascii("ASUSHIDFWU") }),
  blocked("fwu-init", "updater INIT `10 ...`", "firmware", [b(0, 0x10)]),
  blocked("fwu-leave", "updater LEAVE `11 FF`", "firmware", [b(0, 0x11)]),
  blocked("fwu-erase", "updater ERASE / PROGRAM `1F 01` / `1F 51`", "firmware", [b(0, 0x1f)]),
  blocked("fwu-addr", "updater SET_ADDR `20 ...`", "firmware", [b(0, 0x20)]),
  blocked("fwu-len", "updater SET_LEN `21 ...` (21 00 is also an OLED read SYNQ does not need)", "firmware", [b(0, 0x21)]),
  blocked("fwu-data", "updater SET_DATA `22 ...` (22 01 is also the HFX lever read SYNQ does not need)", "firmware", [b(0, 0x22)]),
  blocked("fwu-boot-ver", "updater get_boot_ver `82`", "firmware", [b(0, 0x82)]),
  blocked("fwu-checksum", "updater CHECKSUM `8E`", "firmware", [b(0, 0x8e)]),
  blocked("fwu-status", "updater status `8F`", "firmware", [b(0, 0x8f)]),
  blocked("ry-boot", "ry5088 bootloader `BA C0` / `BA C2`", "firmware", [b(0, 0xba)]),
  blocked("ry-radio", "TX75 radio ISP `C3` / `44` / `C4`", "firmware", [{ at: 0, in: [0xc3, 0x44, 0xc4] }]),
  blocked("fota-7d", "TX75 Core FOTA `7D xx` (only the 7D 20 reads are harmless; SYNQ sends none)", "firmware", [b(0, 0x7d)]),
  // ---- resets ----------------------------------------------------------------------------------
  blocked("device-reset", "deviceReset / resetDongle `B0 00 'reset'`", "factory-reset", [b(0, 0xb0)]),
  blocked("profile-reset", "reset current / all profiles `50 40`", "profile-wipe", [b(0, 0x50), b(1, 0x40)]),
  blocked("binding-reset", "reset key bindings / lighting `50 60` / `50 61`", "profile-wipe", [b(0, 0x50), { at: 1, in: [0x60, 0x61] }]),
  blocked("gamepad-reset", "gamepad reset all / current `52 02` / `52 03`", "factory-reset", [b(0, 0x52)]),
  blocked("analog-reset", "reset analog trigger `51 52`", "profile-wipe", [b(0, 0x51), b(1, 0x52)]),
  blocked("speedtap-reset", "reset Speed Tap `51 56`", "profile-wipe", [b(0, 0x51), b(1, 0x56)]),
  // ---- calibration -----------------------------------------------------------------------------
  blocked("kb-calibrate", "analog key calibration `80 26`", "calibration", [b(0, 0x80), b(1, 0x26)]),
  blocked("kb-calibration-mode", "calibration mode `80 27` (V2 adds switch type)", "calibration", [b(0, 0x80), b(1, 0x27)]),
  blocked("switch-type", "select key switch type `51 27` (changes the analog curve)", "calibration", [b(0, 0x51), b(1, 0x27)], { families: KB_ANY }),
  blocked("mouse-calibration", "mouse surface / LOD / track-on-glass `51 35` (arg 1 is LOD on some models and manual calibration on others)", "calibration", [b(0, 0x51), b(1, 0x35)], { families: ["mouse"] }),
  // ---- identity, demo, pairing -----------------------------------------------------------------
  blocked("gamepad-mode", "gamepad mode / input mode / response `80 00..02` (changes the USB identity)", "identity", [b(0, 0x80), { at: 1, min: 0, max: 2 }]),
  blocked("kb-demo", "keyboard demo mode `51 42`", "demo", [b(0, 0x51), b(1, 0x42)], { families: KB_ANY }),
  blocked("mouse-demo", "mouse demo mode `51 41`", "demo", [b(0, 0x51), b(1, 0x41)], { families: ["mouse"] }),
  blocked("pairing", "receiver pairing mode / unpair `A2 00` / `A2 01`", "pairing", [b(0, 0xa2)]),
  blocked("sw-mode", "software mode `74 00` (keyboard) / `51 30` (mouse): the device stops using its own settings", "identity", [{ at: 0, in: [0x74] }]),
  blocked("mouse-sw-mode", "mouse software mode `51 30`", "identity", [b(0, 0x51), b(1, 0x30)], { families: ["mouse"] }),

  // ================================ allowed: keyboards =========================================
  // reads
  { id: "kb-info", what: "device info read 12 00/01/03/12/15/16", verdict: "read", families: KB_ANY, bytes: [b(0, 0x12), { at: 1, in: [0x00, 0x01, 0x03, 0x12, 0x15, 0x16] }], zeroFrom: 2 },
  { id: "kb-fwinfo", what: "FW info / serial read 12 14 00..02", verdict: "read", families: KB_ANY, bytes: [b(0, 0x12), b(1, 0x14), { at: 2, max: 2 }], zeroFrom: 3 },
  { id: "kb-state", what: "RT mode / Speed Tap state read 25 00 / 25 01", verdict: "read", families: KB, bytes: [b(0, 0x25), { at: 1, in: [0x00, 0x01] }], zeroFrom: 2 },
  { id: "he-global-reads", what: "global actuation / dead zone / RT reads 25 05, 25 0A, 25 22, 25 A5, 25 AA", verdict: "read", families: HE, bytes: [b(0, 0x25), { at: 1, in: [0x05, 0x0a, 0x22, 0xa5, 0xaa] }], zeroFrom: 2 },
  { id: "he-key-reads-v1", what: "per-key trigger / actuation / RT / dead zone / binding reads 25 02/04/06/09/0D", verdict: "read", families: ["he-v1"], bytes: [b(0, 0x25), { at: 1, in: [0x02, 0x04, 0x06, 0x09, 0x0d] }, b(2, 0), b(3, 0)], u16: [{ at: 4, min: KEY.min, max: 0x9fff }], zeroFrom: 6 },
  { id: "he-key-reads-v2", what: "per-key V2 reads 25 A2/A4/A6/A9", verdict: "read", families: ["he-v2"], bytes: [b(0, 0x25), { at: 1, in: [0xa2, 0xa4, 0xa6, 0xa9] }, b(2, 0), b(3, 0)], u16: [{ at: 4, min: KEY.min, max: 0x9fff }], zeroFrom: 6 },
  { id: "he-speedtap-pairs", what: "Speed Tap pair table read 25 08 00|01", verdict: "read", families: HE, bytes: [b(0, 0x25), b(1, 0x08), { at: 2, max: 1 }, b(3, 0)], zeroFrom: 4 },
  // writes
  { id: "kb-save", what: "save current profile 50 55", verdict: "write", families: KB_ANY, bytes: [b(0, 0x50), b(1, 0x55)], zeroFrom: 2 },
  { id: "kb-profile", what: "select profile 51 00 00 00 <1..6>", verdict: "write", families: KB_ANY, bytes: [b(0, 0x51), b(1, 0x00), b(2, 0), b(3, 0), { at: 4, min: 1, max: 6 }], zeroFrom: 5 },
  { id: "he-actuation", what: "global actuation 51 50 (0.01 mm u16)", verdict: "write", families: HE, bytes: [b(0, 0x51), b(1, 0x50), b(2, 0), b(3, 0)], u16: [{ at: 4, ...ACT.he }], zeroFrom: 6 },
  { id: "hfx-actuation", what: "global actuation 51 50 (0.1 mm u16)", verdict: "write", families: ["hfx"], bytes: [b(0, 0x51), b(1, 0x50), b(2, 0), b(3, 0)], u16: [{ at: 4, ...ACT.hfx }], zeroFrom: 6 },
  { id: "he-key-actuation", what: "per-key actuation 51 4F (0.01 mm)", verdict: "write", families: HE, bytes: [b(0, 0x51), b(1, 0x4f), b(2, 0), b(3, 0)], u16: [{ at: 4, ...KEY }, { at: 6, ...ACT.he }], zeroFrom: 8 },
  { id: "hfx-key-actuation", what: "per-key actuation 51 4F (0.1 mm)", verdict: "write", families: ["hfx"], bytes: [b(0, 0x51), b(1, 0x4f), b(2, 0), b(3, 0)], u16: [{ at: 4, ...KEY }, { at: 6, ...ACT.hfx }], zeroFrom: 8 },
  { id: "he-deadzone", what: "global dead zones 51 58 <bottom> <top> (0.01 mm, <= 1.0 mm)", verdict: "write", families: HE, bytes: [b(0, 0x51), b(1, 0x58), b(2, 0), b(3, 0), { at: 4, max: 100 }, { at: 5, max: 100 }], zeroFrom: 6 },
  { id: "hfx-deadzone", what: "global dead zones 51 58 <bottom> <top> (0.1 mm, <= 1.0 mm)", verdict: "write", families: ["hfx"], bytes: [b(0, 0x51), b(1, 0x58), b(2, 0), b(3, 0), { at: 4, max: 10 }, { at: 5, max: 10 }], zeroFrom: 6 },
  { id: "he-key-deadzone", what: "per-key dead zones 51 59 (0.01 mm)", verdict: "write", families: HE, bytes: [b(0, 0x51), b(1, 0x59), b(2, 0), b(3, 0), { at: 6, max: 100 }, { at: 7, max: 100 }], u16: [{ at: 4, ...KEY }], zeroFrom: 8 },
  { id: "hfx-key-deadzone", what: "per-key dead zones 51 59 (0.1 mm)", verdict: "write", families: ["hfx"], bytes: [b(0, 0x51), b(1, 0x59), b(2, 0), b(3, 0), { at: 6, max: 10 }, { at: 7, max: 10 }], u16: [{ at: 4, ...KEY }], zeroFrom: 8 },
  { id: "he-rt-combined", what: "per-key rapid trigger 51 54 00 (combined, u16 0.01 mm)", verdict: "write", families: HE, bytes: [b(0, 0x51), b(1, 0x54), b(2, 0), b(3, 0), { at: 6, max: 1 }, { at: 7, max: 1 }], u16: [{ at: 4, ...KEY }, { at: 8, min: 1, max: 250 }], zeroFrom: 10 },
  { id: "he-rt-independent", what: "per-key rapid trigger 51 54 01 (press + release, u16 0.01 mm)", verdict: "write", families: HE, bytes: [b(0, 0x51), b(1, 0x54), b(2, 1), b(3, 0), { at: 6, max: 1 }, { at: 7, max: 1 }], u16: [{ at: 4, ...KEY }, { at: 8, min: 1, max: 250 }, { at: 10, min: 1, max: 250 }], zeroFrom: 12 },
  { id: "hfx-rt", what: "per-key rapid trigger 51 54 <0|1|2> (u8 0.1 mm, captured)", verdict: "write", families: ["hfx"], bytes: [b(0, 0x51), b(1, 0x54), { at: 2, max: 2 }, b(3, 0), { at: 6, min: 1, max: 25 }, { at: 7, max: 1 }, { at: 8, max: 1 }], u16: [{ at: 4, ...KEY }], zeroFrom: 9 },
  { id: "he-rt-enable", what: "rapid-trigger mode 51 5C (Azoth 96 HE)", verdict: "write", families: ["he-v1"], bytes: [b(0, 0x51), b(1, 0x5c), b(2, 0), b(3, 0), { at: 4, max: 1 }], zeroFrom: 5 },
  { id: "kb-speedtap", what: "Speed Tap on/off 51 57 00", verdict: "write", families: KB, bytes: [b(0, 0x51), b(1, 0x57), b(2, 0), b(3, 0), { at: 4, max: 1 }], zeroFrom: 5 },
  { id: "kb-speedtap-pair", what: "Speed Tap pair 51 55", verdict: "write", families: KB, bytes: [b(0, 0x51), b(1, 0x55), b(2, 0), b(3, 0), { at: 8, max: 1 }], u16: [{ at: 4, ...KEY }, { at: 6, ...KEY }], zeroFrom: 9 },
  { id: "he-remap", what: "key remap 51 21 <src> <tgt u16> <act u16>", verdict: "write", families: HE, bytes: [b(0, 0x51), b(1, 0x21)], u16: [{ at: 2, ...KEY }, { at: 4, min: 0, max: 0x0fff }, { at: 6, ...ACT.he }], zeroFrom: 8 },
  { id: "he-remap-fn", what: "Fn-layer key remap 51 21 <0x9Fxx> <tgt u16> <act u16>", verdict: "write", families: HE, bytes: [b(0, 0x51), b(1, 0x21)], u16: [{ at: 2, min: 0x9f01, max: 0x9fff }, { at: 4, min: 0, max: 0x0fff }, { at: 6, ...ACT.he }], zeroFrom: 8 },
  { id: "hfx-remap", what: "key remap 51 21 <src> <tgt u16> <act u8> (captured)", verdict: "write", families: ["hfx"], bytes: [b(0, 0x51), b(1, 0x21), { at: 6, ...ACT.hfx }], u16: [{ at: 2, ...KEY }, { at: 4, min: 0, max: 0x0fff }], zeroFrom: 7 },
  { id: "hfx-remap-fn", what: "Fn-layer key remap 51 21 <0x9Fxx> <tgt u16> <act u8>", verdict: "write", families: ["hfx"], bytes: [b(0, 0x51), b(1, 0x21), { at: 6, ...ACT.hfx }], u16: [{ at: 2, min: 0x9f01, max: 0x9fff }, { at: 4, min: 0, max: 0x0fff }], zeroFrom: 7 },
  { id: "kb-polling", what: "polling rate 51 31 00 00 <0..3>", verdict: "write", families: ["hfx", "he-v1", "he-v2"], bytes: [b(0, 0x51), b(1, 0x31), b(2, 0), b(3, 0), { at: 4, max: 3 }], zeroFrom: 5, note: "Azoth 96 HE and Falcata use the 80 2x mode system instead; the backend never sends 51 31 to them." },
  { id: "kb-lighting", what: "lighting effect 51 2C <effect 0..9> <packets left 0..2>", verdict: "write", families: KB, bytes: [b(0, 0x51), b(1, 0x2c), { at: 2, max: 9 }, { at: 3, max: 2 }], zeroFrom: 32 },
  { id: "hfx-analog-lighting", what: "analog lighting toggle 51 2D 00 00 <effect> <0|1> (captured)", verdict: "write", families: ["hfx"], bytes: [b(0, 0x51), b(1, 0x2d), b(2, 0), b(3, 0), { at: 4, max: 9 }, { at: 5, max: 1 }], zeroFrom: 6 },
  { id: "hfx-lever", what: "touch panel function / mode 71 00 / 71 02 (captured Sync)", verdict: "write", families: ["hfx"], bytes: [b(0, 0x71), { at: 1, in: [0x00, 0x02] }, b(2, 0), b(3, 0), { at: 4, max: 4 }, { at: 5, max: 1 }], zeroFrom: 6 },

  // ================================ allowed: mice ==============================================
  { id: "mouse-info", what: "mouse info read 12 00 00/02/0E", verdict: "read", families: ["mouse"], bytes: [b(0, 0x12), b(1, 0x00), { at: 2, in: [0x00, 0x02, 0x0e] }], zeroFrom: 3 },
  { id: "mouse-perf-read", what: "performance read 12 04 00..05", verdict: "read", families: ["mouse"], bytes: [b(0, 0x12), b(1, 0x04), { at: 2, max: 5 }], zeroFrom: 3 },
  { id: "mouse-lod-read", what: "calibration / LOD / glass read 12 06 00..02", verdict: "read", families: ["mouse"], bytes: [b(0, 0x12), b(1, 0x06), { at: 2, max: 2 }], zeroFrom: 3 },
  { id: "mouse-battery-read", what: "battery read 12 07 00", verdict: "read", families: ["mouse"], bytes: [b(0, 0x12), b(1, 0x07), b(2, 0)], zeroFrom: 3 },
  { id: "mouse-dpi", what: "DPI stage 51 31 <0..3> RAW16 [RGB]", verdict: "write", families: ["mouse"], bytes: [b(0, 0x51), b(1, 0x31), { at: 2, max: 3 }, b(3, 0)], u16: [{ at: 4, min: 1, max: 64999 }], zeroFrom: 9 },
  { id: "mouse-dpi-xy", what: "split X/Y DPI 51 31 <12..15> X16 Y16", verdict: "write", families: ["mouse"], bytes: [b(0, 0x51), b(1, 0x31), { at: 2, min: 12, max: 15 }, b(3, 0)], u16: [{ at: 4, min: 1, max: 64999 }, { at: 6, min: 1, max: 64999 }], zeroFrom: 8 },
  { id: "mouse-polling", what: "polling 51 31 04 <0..6>", verdict: "write", families: ["mouse"], bytes: [b(0, 0x51), b(1, 0x31), b(2, 4), b(3, 0), { at: 4, max: 6 }], zeroFrom: 5 },
  { id: "mouse-debounce", what: "button response 51 31 05 <0..7>", verdict: "write", families: ["mouse"], bytes: [b(0, 0x51), b(1, 0x31), b(2, 5), b(3, 0), { at: 4, max: 7 }], zeroFrom: 5 },
  { id: "mouse-toggles", what: "angle snap / motion sync 51 31 06|18 <0|1>", verdict: "write", families: ["mouse"], bytes: [b(0, 0x51), b(1, 0x31), { at: 2, in: [6, 18] }, b(3, 0), { at: 4, max: 1 }], zeroFrom: 5 },
  { id: "mouse-active-stage", what: "active DPI stage 51 31 09 <1..4>", verdict: "write", families: ["mouse"], bytes: [b(0, 0x51), b(1, 0x31), b(2, 9), b(3, 0), { at: 4, min: 1, max: 4 }], zeroFrom: 5 },
  { id: "mouse-profile", what: "select profile 50 02 <0..4>", verdict: "write", families: ["mouse"], bytes: [b(0, 0x50), b(1, 0x02), { at: 2, max: 4 }, b(3, 0)], zeroFrom: 4 },
  { id: "mouse-save", what: "save profile 50 03", verdict: "write", families: ["mouse"], bytes: [b(0, 0x50), b(1, 0x03)], zeroFrom: 2 },

  // ================================ allowed: receivers (reads only) ============================
  { id: "receiver-reads", what: "receiver serial / firmware / paired list A1 00, A1 01, A0 00", verdict: "read", families: ["receiver"], bytes: [{ at: 0, in: [0xa0, 0xa1] }, { at: 1, max: 1 }], zeroFrom: 2 },
];

/** What SYNQ never sends to ASUS gear, for the "never sends" list. */
export const ASUS_BLOCKED: readonly BlockedCommand[] = ASUS_RULES.filter((r) => r.verdict === "blocked").map((r) => ({
  what: r.what,
  why: r.why ?? "unknown",
  bytes: r.contains ? `contains "${String.fromCharCode(...r.contains)}"` : r.bytes.map((x) => (x.eq !== undefined ? x.eq.toString(16).padStart(2, "0") : "..")).join(" "),
  source: "ASUS Gear Link ota/main.js and SDK (docs/devices/asus-gearlink.md)",
}));

/** Verdict for one frame to `productId`, by that device's family. */
export function classifyAsusFrame(productId: number, data: Uint8Array): FrameVerdict & { rule?: string } {
  if (isAsusBootloader(ASUS_VID, productId)) return { verdict: "blocked", what: "bootloader device", why: "bootloader", reason: `0b05:${productId.toString(16)} is a firmware-update identity` };
  const m = asusModel(productId);
  if (!m) return { verdict: "blocked", what: "unknown ASUS device", why: "unknown", reason: "only Gear Link keyboards, mice and receivers in SYNQ's table are driven" };
  if (data.length !== 64 && data.length !== 63) return { verdict: "blocked", what: "bad length", why: "unknown", reason: `ASUS frames are 63/64 bytes (got ${data.length})` };
  return evaluate(ASUS_RULES, asusGuardFamily(m), data);
}

export function asusGuard(productId: number): CommandGuard {
  return {
    classify(report: OutgoingReport): FrameVerdict {
      if (report.type !== "output" || !ASUS_CONTROL_REPORT_IDS.includes(report.reportId))
        return { verdict: "blocked", what: "feature report / unexpected report id", why: "unknown", reason: "ASUS settings travel as output report 0 (USB) or 2 (2.4 GHz dongle) only" };
      return classifyAsusFrame(productId, report.data);
    },
    blocked: ASUS_BLOCKED,
  };
}
