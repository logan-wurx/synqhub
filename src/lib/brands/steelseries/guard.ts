// SteelSeries Apex outgoing-frame allowlist. Default-deny: only the exact shapes SYNQ's encoders build pass
// (report id 0, 64-byte output or the family's feature length, a known command, values GG itself uses, zero padding).
//
// Two layers:
//   STEELSERIES_GUARD   static superset over every model the table drives. The Rust bridge mirrors this one
//                       (fixture: steelseries-frames.txt, written by scripts/steelseries-allowlist-fixture.ts).
//   guardFor(model)     what a session uses: the same rules narrowed to the model's family, its own GG table, its
//                       analog key list, its LEDs and the capabilities devices.ts grants it.
// BLOCKED rules are checked first and win in both.

import { blockVerdict, okVerdict, type BlockReason, type CommandGuard, type OutgoingReport, type Verdict } from "../local-kb.ts";
import { FEATURE_LENGTH, MODELS, SS_OUTPUT_LENGTH, SS_REPORT_ID, isDriven, type SsModel } from "./devices.ts";
import { ANALOG_COUNT, BRIGHTNESS_MAX, OP, PAIR_ORDER, PROFILE_SLOTS, RELEASE_MODE, SENS_MAX, SENS_MIN, directCapacity, hex, tablePairs, type CommandFamily } from "./protocol.ts";

// ---------------------------------------------------------------------------------------------
// What SYNQ never sends
// ---------------------------------------------------------------------------------------------

export interface BlockedEntry {
  what: string;
  why: BlockReason;
  /** Hex prefix, `..` = any byte. Matched against the data bytes (no report id) of output AND feature reports. */
  bytes: string;
  /** Where the bytes come from (paths relative to wave4-src/steelseries/). */
  source: string;
}

const R = "[rikearon] oss/Rikearon/apex-control/docs/PROTOCOL.md";
const Z = "[zunuza] oss/zunuza/apex-control/docs/PROTOCOL_NOTES.md";
const G = "[opengg] oss/GUHPY/OpenGG/docs/protocol.md";

export const BLOCKED: readonly BlockedEntry[] = [
  { what: "Flash profile erase: 02 01 <fs> (Gen 3 wired), 02 03 <slot> (wireless keyboard over USB), 02 01 <10+slot> (receiver copy)", why: "profile-wipe", bytes: "02", source: `${R} §Onboard profiles 'Erase slot entry'; ${G} 'Profile file reports'` },
  { what: "Flash profile write chunk: 03 01 <fs> <size> <offset> ... (Gen 3 wired / wireless), 03 00 00 <half> 00 02 ... (legacy page data)", why: "profile-wipe", bytes: "03", source: `${R} 'Write chunk'; ${G}; ${Z} 'Burst structure'` },
  { what: "Flash validate / commit a written slot: B1 <slot> (Gen 3 wired)", why: "profile-wipe", bytes: "b1", source: `${R} 'Validate slot'` },
  { what: "Flash validate a written slot: E6 <slot-1> (receiver) / A6 (USB cable)", why: "profile-wipe", bytes: "e6", source: `${G} 'Validate'` },
  { what: "Flash validate a written slot over the USB cable: A6 <slot-1>", why: "profile-wipe", bytes: "a6", source: `${G} 'USB cable commands'` },
  { what: "Keyboard-slot erase / write tunnelled through the receiver: 42 03 <slot>, 43 03 <slot> ...", why: "profile-wipe", bytes: "42", source: `${G} 'Erase keyboard slot'` },
  { what: "Keyboard-slot write tunnelled through the receiver: 43 03 <slot> 00 02 <offset> <512 bytes>", why: "profile-wipe", bytes: "43", source: `${G} 'Write keyboard block'` },
  { what: "Legacy profile write, begin region: 88 00 <slot> <region>", why: "profile-wipe", bytes: "88", source: `${Z} 'Write transaction' step 1` },
  { what: "Legacy profile write, commit a 1 KB page: 05 00 <slot> <region> <page> 00 00 04 00", why: "profile-wipe", bytes: "05", source: `${Z} 'Write transaction' step 2` },
  { what: "Legacy profile write, end region: eb <slot>", why: "profile-wipe", bytes: "eb", source: `${Z} 'Write transaction' step 3` },
  { what: "Region write (writes flash on every call): 75 <region>", why: "identity", bytes: "75", source: `${R} 'Queries & misc'` },
  { what: "Key-binding write 36 <layer> <count> [hid, fn, kc0..kc3] (a blank Fn layer erases the factory shortcuts); on the wireless cable the same opcode is rapid-trigger enable, so it is never sent", why: "profile-wipe", bytes: "36", source: `${R} 'Key bindings'; ${G} 'USB cable commands' (36)` },
  { what: "Fn-bound-key bitmask 3C <32-byte mask>", why: "profile-wipe", bytes: "3c", source: `${R} 'Key bindings'` },
  { what: "Choose the Fn trigger key 35 <hid>", why: "profile-wipe", bytes: "35", source: `${R} 'Key bindings'` },
  { what: "OLED image saved into the flash profile: 38 83 00 <640 bytes> (Gen 3 wired)", why: "profile-wipe", bytes: "38 83", source: `${R} 'OLED' Persist` },
  { what: "Persistent OLED image path: 4C 01 <offset> <length> ... (receiver)", why: "profile-wipe", bytes: "4c", source: `${G} 'Live settings' 4C` },
  { what: "41: lighting clear on the Gen 3 wired TKL, but a 'reset' on the wireless line; ambiguous, never sent", why: "factory-reset", bytes: "41", source: `${R} 'Lighting' Clear; ${G} 'Shared channel' ('41 is a reset')` },
  { what: "Profile volatility switch 34 <0|1> (meaning unclear)", why: "unknown", bytes: "34", source: `${R} 'Queries & misc'` },
  { what: "Legacy 69 (sent around profile switches; meaning unknown)", why: "unknown", bytes: "69", source: `${Z} 'Profile switching'` },
  { what: "Legacy 74 00 01 00 (sent after a profile save; meaning unknown)", why: "unknown", bytes: "74", source: `${Z} 'Write transaction' step 6` },
  { what: "Legacy rapid-tap live switch 1a 00 / 1a 01 (paired with a full profile save)", why: "unknown", bytes: "1a", source: `${Z} 'SOCD'` },
  { what: "Wireless slot activation 53 <slot-1> (receiver) / 13 (cable)", why: "unknown", bytes: "53", source: `${G} 'Activate slot'` },
  { what: "Wireless slot activation over the cable: 13 <slot-1>", why: "unknown", bytes: "13", source: `${G} 'USB cable commands'` },
  { what: "Wireless 'use persistent settings' 68 00 (receiver) / 28 00 (cable)", why: "unknown", bytes: "68", source: `${G} 'Activate slot'` },
  { what: "Wireless 'use persistent settings' over the cable: 28 00", why: "unknown", bytes: "28", source: `${G} 'USB cable commands'` },
];

/** A bytes pattern from BLOCKED as matcher input: null = wildcard. */
export const patternOf = (bytes: string): (number | null)[] => bytes.trim().split(/\s+/).map((t) => (t === ".." ? null : parseInt(t, 16)));

export function matchesPattern(bytes: string, data: Uint8Array): boolean {
  const p = patternOf(bytes);
  if (data.length < p.length) return false;
  return p.every((b, i) => b === null || data[i] === b);
}

// ---------------------------------------------------------------------------------------------
// Scope: what the encoders can produce for a set of models
// ---------------------------------------------------------------------------------------------

type Cap = "firmware" | "brightness" | "profiles" | "release" | "init" | "region" | "status" | "actuation" | "rapidTrigger" | "sensitivity" | "direct";

interface Scope {
  caps: Map<CommandFamily, Set<Cap>>;
  /** "l,h" pairs per family (union of the writable models' GG tables). */
  pairs: Map<CommandFamily, Set<string>>;
  /** Analog key lists per family (each 68 long, ascending). */
  keyLists: Map<CommandFamily, (readonly number[])[]>;
  leds: Map<CommandFamily, Set<number>>;
}

export function scopeFor(models: readonly SsModel[]): Scope {
  const s: Scope = { caps: new Map(), pairs: new Map(), keyLists: new Map(), leds: new Map() };
  const add = (f: CommandFamily, c: Cap) => {
    if (!s.caps.has(f)) s.caps.set(f, new Set());
    s.caps.get(f)!.add(c);
  };
  for (const m of models) {
    if (m.family === "other" || !isDriven(m)) continue;
    const f: CommandFamily = m.family;
    if (m.firmwareQuery) add(f, "firmware");
    if (m.brightness) add(f, "brightness");
    if (m.profiles) add(f, "profiles");
    if (m.regionQuery) add(f, "region");
    if (m.statusQuery) add(f, "status");
    if (m.directLighting) {
      add(f, "direct");
      if (m.directLighting.release) add(f, "release");
      if (m.directLighting.initFirst) add(f, "init");
      if (!s.leds.has(f)) s.leds.set(f, new Set());
      for (const l of m.directLighting.leds) s.leds.get(f)!.add(l);
    }
    const analog: [Cap, unknown][] = [["actuation", m.actuation], ["rapidTrigger", m.rapidTrigger], ["sensitivity", m.sensitivity]];
    for (const [c, v] of analog) if (v) add(f, c);
    if ((m.actuation || m.rapidTrigger || m.sensitivity) && m.analogKeys) {
      const lists = s.keyLists.get(f) ?? [];
      if (!lists.some((l) => l.join() === m.analogKeys!.join())) lists.push(m.analogKeys);
      s.keyLists.set(f, lists);
    }
    if (m.actuation && m.table) {
      if (!s.pairs.has(f)) s.pairs.set(f, new Set());
      for (const p of tablePairs(m.table)) s.pairs.get(f)!.add(`${p.l},${p.h}`);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// The commands SYNQ builds
// ---------------------------------------------------------------------------------------------

interface Spec {
  id: string;
  name: string;
  kind: "read" | "write";
  type: "output" | "feature";
  family: CommandFamily;
  cap: Cap;
  /** Leading bytes that pick the spec. */
  head: readonly number[];
  check(f: Uint8Array, s: Scope): boolean;
}

const zeroFrom = (f: Uint8Array, from: number): boolean => {
  for (let i = from; i < f.length; i++) if (f[i] !== 0) return false;
  return true;
};

/** `[hid, a, b] x 68` from `at`: keys are one of the scope's lists, (l,h) pairs on the scope's tables. */
function triplets(f: Uint8Array, at: number, fam: CommandFamily, s: Scope): boolean {
  const lists = s.keyLists.get(fam) ?? [];
  const pairs = s.pairs.get(fam);
  if (!pairs) return false;
  const list = lists.find((l) => l.every((k, i) => f[at + i * 3] === k));
  if (!list) return false;
  for (let i = 0; i < ANALOG_COUNT; i++) {
    const a = f[at + i * 3 + 1], b = f[at + i * 3 + 2];
    const [l, h] = PAIR_ORDER[fam] === "hl" ? [b, a] : [a, b];
    if (!pairs.has(`${l},${h}`)) return false;
  }
  return zeroFrom(f, at + ANALOG_COUNT * 3);
}

/** `[hid, v] x 68` from `at` with v in `ok`. */
function duples(f: Uint8Array, at: number, fam: CommandFamily, s: Scope, ok: (v: number) => boolean): boolean {
  const lists = s.keyLists.get(fam) ?? [];
  const list = lists.find((l) => l.every((k, i) => f[at + i * 2] === k));
  if (!list) return false;
  for (let i = 0; i < ANALOG_COUNT; i++) if (!ok(f[at + i * 2 + 1])) return false;
  return zeroFrom(f, at + ANALOG_COUNT * 2);
}

/** `<op> <n> [led, R, G, B] x n`, LEDs ascending and in the scope's LED set. */
function direct(f: Uint8Array, fam: CommandFamily, s: Scope): boolean {
  const n = f[1];
  const leds = s.leds.get(fam);
  if (!leds || n < 1 || n > directCapacity(fam)) return false;
  for (let i = 0; i < n; i++) {
    const id = f[2 + i * 4];
    if (!leds.has(id) || (i && id <= f[2 + (i - 1) * 4])) return false;
  }
  return zeroFrom(f, 2 + n * 4);
}

const only = (len: number) => (f: Uint8Array) => zeroFrom(f, len);

const SPECS: readonly Spec[] = [
  // legacy line
  { id: "legacy-firmware", name: "firmware version", kind: "read", type: "output", family: "legacy", cap: "firmware", head: [OP.firmware], check: (f) => f[1] <= 1 && zeroFrom(f, 2) },
  { id: "legacy-brightness-read", name: "read brightness", kind: "read", type: "output", family: "legacy", cap: "brightness", head: [OP.brightnessGet], check: only(1) },
  { id: "legacy-brightness", name: "brightness", kind: "write", type: "output", family: "legacy", cap: "brightness", head: [OP.brightnessSet], check: (f) => f[1] <= BRIGHTNESS_MAX && zeroFrom(f, 2) },
  { id: "legacy-release", name: "lighting back to the keyboard", kind: "write", type: "output", family: "legacy", cap: "release", head: [OP.legacyRelease], check: only(1) },
  { id: "legacy-profile", name: "select profile", kind: "write", type: "output", family: "legacy", cap: "profiles", head: [OP.profile], check: (f) => f[1] >= 1 && f[1] <= PROFILE_SLOTS && zeroFrom(f, 2) },
  { id: "legacy-actuation", name: "actuation", kind: "write", type: "feature", family: "legacy", cap: "actuation", head: [OP.legacyActuation, OP.legacyActuationSub], check: (f, s) => triplets(f, 2, "legacy", s) },
  { id: "legacy-direct", name: "direct colour", kind: "write", type: "feature", family: "legacy", cap: "direct", head: [OP.legacyDirect], check: (f, s) => direct(f, "legacy", s) },
  // single-MCU line
  { id: "single-firmware", name: "firmware version", kind: "read", type: "output", family: "single", cap: "firmware", head: [OP.firmware], check: (f) => f[1] <= 1 && zeroFrom(f, 2) },
  { id: "single-region", name: "read region", kind: "read", type: "output", family: "single", cap: "region", head: [OP.region], check: only(1) },
  { id: "single-layout", name: "read layout", kind: "read", type: "output", family: "single", cap: "region", head: [OP.layout], check: only(1) },
  { id: "single-init", name: "direct-mode init", kind: "write", type: "output", family: "single", cap: "init", head: [OP.singleInit], check: only(1) },
  { id: "single-actuation", name: "actuation", kind: "write", type: "feature", family: "single", cap: "actuation", head: [OP.single, OP.singleThresholds, ANALOG_COUNT, 0x00], check: (f, s) => triplets(f, 4, "single", s) },
  { id: "single-release-mode", name: "rapid trigger", kind: "write", type: "feature", family: "single", cap: "rapidTrigger", head: [OP.single, OP.singleReleaseMode, ANALOG_COUNT], check: (f, s) => duples(f, 3, "single", s, (v) => v === RELEASE_MODE.off || v === RELEASE_MODE.rapidTrigger) },
  { id: "single-sensitivity", name: "rapid-trigger sensitivity", kind: "write", type: "feature", family: "single", cap: "sensitivity", head: [OP.single, OP.singleSensitivity, ANALOG_COUNT], check: (f, s) => duples(f, 3, "single", s, (v) => v >= SENS_MIN && v <= SENS_MAX) },
  { id: "single-direct", name: "direct colour", kind: "write", type: "feature", family: "single", cap: "direct", head: [OP.singleDirect], check: (f, s) => direct(f, "single", s) },
  // wireless line, receiver
  { id: "rx-connection", name: "connection status", kind: "read", type: "output", family: "wireless-rx", cap: "status", head: [OP.rxConnection], check: only(1) },
  { id: "rx-battery", name: "battery status", kind: "read", type: "output", family: "wireless-rx", cap: "status", head: [OP.rxBattery], check: only(1) },
  { id: "rx-release", name: "lighting back to the keyboard", kind: "write", type: "output", family: "wireless-rx", cap: "release", head: [OP.rxRelease], check: only(1) },
  { id: "rx-actuation", name: "actuation", kind: "write", type: "feature", family: "wireless-rx", cap: "actuation", head: [OP.rxActuation, 0x00, ANALOG_COUNT], check: (f, s) => triplets(f, 3, "wireless-rx", s) },
  { id: "rx-rapid-trigger", name: "rapid trigger", kind: "write", type: "feature", family: "wireless-rx", cap: "rapidTrigger", head: [OP.rxRapidTrigger, ANALOG_COUNT], check: (f, s) => duples(f, 2, "wireless-rx", s, (v) => v <= 1) },
  { id: "rx-sensitivity", name: "rapid-trigger sensitivity", kind: "write", type: "feature", family: "wireless-rx", cap: "sensitivity", head: [OP.rxSensitivity, ANALOG_COUNT], check: (f, s) => duples(f, 2, "wireless-rx", s, (v) => v >= SENS_MIN && v <= SENS_MAX) },
  { id: "rx-direct", name: "direct colour", kind: "write", type: "feature", family: "wireless-rx", cap: "direct", head: [OP.rxDirect], check: (f, s) => direct(f, "wireless-rx", s) },
  // wireless line, USB cable
  { id: "usb-battery", name: "battery status", kind: "read", type: "output", family: "wireless-usb", cap: "status", head: [OP.usbBattery], check: only(1) },
  { id: "usb-release", name: "lighting back to the keyboard", kind: "write", type: "output", family: "wireless-usb", cap: "release", head: [OP.usbRelease], check: only(1) },
  { id: "usb-actuation", name: "actuation", kind: "write", type: "feature", family: "wireless-usb", cap: "actuation", head: [OP.usbActuation, 0x00, ANALOG_COUNT], check: (f, s) => triplets(f, 3, "wireless-usb", s) },
  { id: "usb-sensitivity", name: "rapid-trigger sensitivity", kind: "write", type: "feature", family: "wireless-usb", cap: "sensitivity", head: [OP.usbSensitivity, ANALOG_COUNT], check: (f, s) => duples(f, 2, "wireless-usb", s, (v) => v >= SENS_MIN && v <= SENS_MAX) },
  { id: "usb-direct", name: "direct colour", kind: "write", type: "feature", family: "wireless-usb", cap: "direct", head: [OP.usbDirect], check: (f, s) => direct(f, "wireless-usb", s) },
];

export const SPEC_IDS: readonly string[] = SPECS.map((s) => s.id);

const lengthOf = (spec: Spec): number => (spec.type === "output" ? SS_OUTPUT_LENGTH : FEATURE_LENGTH[spec.family]);

const notListed = (r: OutgoingReport): Verdict =>
  blockVerdict("not listed", "unknown", `${r.type} ${hex(r.data.subarray(0, 4))}... is not a command SYNQ builds for this keyboard.`);

/** Classify one report against a scope; `families` limits which families' commands count. */
export function classifyWith(r: OutgoingReport, s: Scope, families?: ReadonlySet<CommandFamily>): Verdict {
  const f = r.data;
  if (r.reportId !== SS_REPORT_ID) return blockVerdict("report id", "shape", `SteelSeries reports use report id 0 (got ${r.reportId}).`);
  const lengths = r.type === "output" ? [SS_OUTPUT_LENGTH] : Object.values(FEATURE_LENGTH);
  if (!lengths.includes(f.length)) return blockVerdict("bad length", "shape", `${r.type} reports are ${lengths.join(" / ")} bytes (got ${f.length}).`);
  for (const b of BLOCKED) if (matchesPattern(b.bytes, f)) return blockVerdict(b.what, b.why, `SYNQ never sends this: ${b.what}.`);
  for (const spec of SPECS) {
    if (families && !families.has(spec.family)) continue;
    if (spec.type !== r.type || lengthOf(spec) !== f.length) continue;
    if (!spec.head.every((b, i) => f[i] === b)) continue;
    if (!s.caps.get(spec.family)?.has(spec.cap)) continue;
    if (spec.check(f, s)) return okVerdict(spec.name, spec.kind);
  }
  return notListed(r);
}

function makeGuard(models: readonly SsModel[], families?: ReadonlySet<CommandFamily>): CommandGuard {
  const scope = scopeFor(models);
  return {
    classify: (r: OutgoingReport) => classifyWith(r, scope, families),
    blocked: BLOCKED.map((b) => ({ what: b.what, why: b.why })),
  };
}

/** Static superset for the bridge: every command any driven model may receive. */
export const STEELSERIES_GUARD: CommandGuard = makeGuard(MODELS);

/** The session guard for one model: its family, its table, its keys, its LEDs, its capabilities. */
export function guardFor(model: SsModel): CommandGuard {
  if (model.family === "other") return { classify: (r) => notListed(r), blocked: STEELSERIES_GUARD.blocked };
  return makeGuard([model], new Set([model.family]));
}
