// Outgoing-frame allowlist for Keychron's Hall-effect extension of VIA (0xA0..0xAB beside VIA's own commands). It is a
// second tier on top of the VIA guard (../guard.ts): a frame the VIA guard refuses may still go to a Keychron HE
// keyboard when it is one of these, and only to the ids in catalog.generated.ts. Default-deny: only the exact shapes
// SYNQ's encoders build pass.
//
// What may be sent (the Rust bridge mirrors this, src-tauri/src/hid.rs `keychron_he_frame_allowed`):
//   0xA0 / 0xA1 / 0xA2      protocol version, firmware version, supported features: reads
//   0xA7 0x01               the misc protocol version: a read
//   0xA9 0x01, 0x10         analog protocol version and profile info: reads
//   0xA9 0x12               raw profile bytes: a read (profile, offset, 1..26 bytes)
//   0xA9 0x14               set travel: a mode, actuation and rapid-trigger sensitivities (0.1 mm units, at most 3.9 mm)
//                           for the profile's own configuration or for the keys named by row masks
//   0xA9 0x1F               save a profile to EEPROM
// Never sent: 0xAA (wireless firmware update: it jumps to the bootloader and flashes) and 0xAB (factory and RF test),
// 0xA7 0x11 (factory reset), 0xA9 0x1E (profile reset), 0xA9 0x40 (sensor calibration) and its state reads, the
// advanced-key, SOCD, curve, game-controller and profile-name writes (not offered yet), profile selection, and
// anything not listed above. VIA's own bootloader jump (0x0B) and EEPROM reset (0x0A) stay refused by the VIA guard.
//
// Two layers, as in the other brand guards:
//   checkKeychronFrame(f)        the static verdict. The bridge repeats this one; its fixture is keychron-he-frames.txt.
//   keychronGuardFor(ctx)        what a session uses: the static verdict, then narrowed to the keyboard's active profile
//                                and matrix size, and to reads only when writes aren't allowed.
import type { Verdict } from "../guard.ts";
import { AKM, AMC, FRAME_LEN, KC, MAX_PROFILES, MAX_UNITS, MISC, RAW_CHUNK } from "./protocol.ts";

const block = (why: string): Verdict => ({ ok: false, why: `Blocked: ${why}.` });
const read = (what: string): Verdict => ({ ok: true, what, write: false });
const write = (what: string): Verdict => ({ ok: true, what, write: true });
const notListed = (f: Uint8Array): Verdict => ({ ok: false, why: `Blocked: Keychron command ${Array.from(f.subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join(" ")} isn't on SYNQ's list.` });

const zeroFrom = (f: Uint8Array, from: number): boolean => {
  for (let i = from; i < f.length; i++) if (f[i] !== 0) return false;
  return true;
};

/** The largest raw profile offset a read may name (a profile is a few hundred bytes to ~1.5 KB). */
export const MAX_RAW_OFFSET = 4096;

/** What SYNQ never sends a Keychron HE keyboard, for the panel's "never sends" list (beside VIA's own). */
export const KEYCHRON_BLOCKED: readonly { what: string; why: "firmware" | "factory-reset" | "calibration" | "profile-wipe" | "unverified" }[] = [
  { what: "0xAA: wireless firmware update (it reboots into the bootloader), and 0xAB: factory and RF test", why: "firmware" },
  { what: "0xA7 0x11: factory reset", why: "factory-reset" },
  { what: "0xA9 0x40: sensor calibration, and its state reads", why: "calibration" },
  { what: "0xA9 0x1E: reset a profile to its defaults", why: "profile-wipe" },
  { what: "0xA9 advanced keys (0x15), SOCD (0x16), profile names (0x13), curves and game-controller mode (0x21, 0x23), profile selection (0x11): not offered yet", why: "unverified" },
];

/** Static verdict for one 32-byte frame (no session context). */
export function checkKeychronFrame(f: Uint8Array, ctx?: KeychronContext): Verdict {
  if (f.length !== FRAME_LEN) return { ok: false, why: `Keychron raw-HID frames are ${FRAME_LEN} bytes (got ${f.length}).` };
  const v = classify(f);
  if (!v.ok || !ctx) return v;
  return narrow(f, v, ctx);
}

function classify(f: Uint8Array): Verdict {
  switch (f[0]) {
    case KC.protocolVersion:
      return zeroFrom(f, 1) ? read("keychron protocol version") : notListed(f);
    case KC.firmwareVersion:
      return zeroFrom(f, 1) ? read("keychron firmware version") : notListed(f);
    case KC.supportFeature:
      return zeroFrom(f, 1) ? read("keychron features") : notListed(f);
    case KC.wirelessDfu:
      return block("Keychron's wireless firmware update (0xAA)");
    case KC.factoryTest:
      return block("Keychron's factory and RF test (0xAB)");
    case KC.misc:
      if (f[1] === MISC.factoryReset) return block("Keychron factory reset (0xA7 0x11)");
      return f[1] === MISC.getProtocolVer && zeroFrom(f, 2) ? read("keychron misc version") : notListed(f);
    case KC.analog:
      return classifyAnalog(f);
    default:
      return notListed(f);
  }
}

function classifyAnalog(f: Uint8Array): Verdict {
  switch (f[1]) {
    case AMC.getVersion:
      return zeroFrom(f, 2) ? read("analog version") : notListed(f);
    case AMC.getProfilesInfo:
      return zeroFrom(f, 2) ? read("analog profiles") : notListed(f);
    case AMC.getProfileRaw:
      return f[2] < MAX_PROFILES && f[5] >= 1 && f[5] <= RAW_CHUNK && (f[3] | (f[4] << 8)) + f[5] <= MAX_RAW_OFFSET && zeroFrom(f, 6) ? read("analog profile bytes") : notListed(f);
    case AMC.setTravel: {
      const [profile, mode, act, sens, rls, entire] = [f[2], f[3], f[4], f[5], f[6], f[7]];
      if (profile >= MAX_PROFILES || mode > AKM.rapid || act > MAX_UNITS || sens > MAX_UNITS || rls > MAX_UNITS || entire > 1) return notListed(f);
      if (entire === 1) return mode >= AKM.regular && zeroFrom(f, 8) ? write("analog global travel") : notListed(f);
      return !zeroFrom(f, 8) ? write("analog key travel") : notListed(f);
    }
    case AMC.saveProfile:
      return f[2] < MAX_PROFILES && zeroFrom(f, 3) ? write("analog save profile") : notListed(f);
    case AMC.resetProfile:
      return block("resetting an analog profile (0xA9 0x1E)");
    case AMC.calibrate:
      return block("Keychron sensor calibration (0xA9 0x40)");
    default:
      return notListed(f);
  }
}

// ---------------------------------------------------------------------------------------------
// Session narrowing
// ---------------------------------------------------------------------------------------------

export interface KeychronContext {
  /** The keyboard's active profile, once read; a profile frame names no other. Null: only the version and profile-info reads go out. */
  profile: number | null;
  /** The matrix SYNQ drew from the catalogue: row masks stay inside it. */
  rows: number;
  cols: number;
  /** False for read-only tiers: every "write" verdict is refused. */
  writes: boolean;
}

function narrow(f: Uint8Array, v: Extract<Verdict, { ok: true }>, ctx: KeychronContext): Verdict {
  if (v.write && !ctx.writes) return { ok: false, why: "Blocked: this keyboard is read-only in SYNQ." };
  if (f[0] !== KC.analog) return v;
  if (f[1] === AMC.getVersion || f[1] === AMC.getProfilesInfo) return v;
  if (ctx.profile === null) return { ok: false, why: "Blocked: only the version and profile-info reads go out until the keyboard's active profile is known." };
  if (f[2] !== ctx.profile) return { ok: false, why: "Blocked: that is not the keyboard's active profile; SYNQ only reads and writes the active one." };
  if (f[1] === AMC.setTravel && f[7] === 0) {
    for (let r = 0; r < 8; r++) {
      const mask = f[8 + r * 3] | (f[9 + r * 3] << 8) | (f[10 + r * 3] << 16);
      if (mask === 0) continue;
      if (r >= ctx.rows || mask >>> ctx.cols !== 0) return { ok: false, why: "Blocked: a key outside this keyboard's matrix." };
    }
  }
  return v;
}

/** A session's guard for the extension. `ctx` is read on every call, so the session can fill it in once the profile is known. */
export const keychronGuardFor = (ctx: () => KeychronContext) => (f: Uint8Array): Verdict | null => (f[0] >= 0xa0 && f[0] <= 0xab ? checkKeychronFrame(f, ctx()) : null);
