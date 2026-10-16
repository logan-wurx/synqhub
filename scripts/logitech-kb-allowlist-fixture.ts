// Generates src/lib/brands/logitech-kb/logitech-kb-frames.txt: one line per HID++ frame,
//   `<1|0> <hex>`  where hex = reportId byte + data bytes with trailing zeros dropped,
// 1 = the guard (LogitechKbGuard over EXAMPLE_FEATURE_MAP) lets it through, 0 = refused.
// The desktop bridge, once it builds the same feature map from IRoot, must reproduce these verdicts.
// Run (no device, no window): node scripts/logitech-kb-allowlist-fixture.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EXAMPLE_FEATURE_MAP, LogitechKbGuard } from "../src/lib/brands/logitech-kb/guard.ts";
import * as P from "../src/lib/brands/logitech-kb/protocol.ts";

const guard = new LogitechKbGuard(EXAMPLE_FEATURE_MAP);
const idxOf = (featureId: number): number => {
  for (const [i, id] of EXAMPLE_FEATURE_MAP) if (id === featureId) return i;
  throw new Error(`no index for 0x${featureId.toString(16)}`);
};
const D = 0xff; // cabled device index

const frames: P.HidppFrame[] = [
  // IRoot
  P.ping(D),
  P.getFeature(D, P.FEATURE.analogKeys),
  P.getFeature(D, 0x00d0),
  // reads
  P.fwGetInfo(D, idxOf(P.FEATURE.firmwareInfo)),
  P.fwGetEntry(D, idxOf(P.FEATURE.firmwareInfo), 1),
  P.nameGetCount(D, idxOf(P.FEATURE.deviceName)),
  P.nameGetChunk(D, idxOf(P.FEATURE.deviceName), 0),
  P.rateExtGetList(D, idxOf(P.FEATURE.reportRateExt)),
  P.rateExtGet(D, idxOf(P.FEATURE.reportRateExt)),
  P.rateGetList(D, idxOf(P.FEATURE.reportRate)),
  P.brightnessGetInfo(D, idxOf(P.FEATURE.brightness)),
  P.brightnessGet(D, idxOf(P.FEATURE.brightness)),
  P.onboardGetInfo(D, idxOf(P.FEATURE.onboardProfiles)),
  P.onboardGetMode(D, idxOf(P.FEATURE.onboardProfiles)),
  P.onboardGetProfile(D, idxOf(P.FEATURE.onboardProfiles)),
  P.analogGetRapidTrigger(D, idxOf(P.FEATURE.analogKeys)),
  P.analogGetKeyPriority(D, idxOf(P.FEATURE.analogKeys)),
  // writes (allowed settings)
  P.rateExtSet(D, idxOf(P.FEATURE.reportRateExt), 3),
  P.rateSet(D, idxOf(P.FEATURE.reportRate), 1),
  P.brightnessSet(D, idxOf(P.FEATURE.brightness), 0x8000),
  P.onboardSetMode(D, idxOf(P.FEATURE.onboardProfiles), 2),
  P.analogSetRapidTrigger(D, idxOf(P.FEATURE.analogKeys), true),
  P.analogSetRapidTrigger(D, idxOf(P.FEATURE.analogKeys), false),
  P.analogSetTravelEvents(D, idxOf(P.FEATURE.analogKeys), true),
  P.analogSetKeyPriority(D, idxOf(P.FEATURE.analogKeys), true),
];

// Blocked: every dangerous feature's index addressed with a plausible function index.
const blockedIdx = [0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11];
for (const i of blockedIdx) for (const fn of [0, 1, 3, 15]) frames.push(P.frame("short", D, i, fn, [0xff, 0xff, 0xff]));
// Blocked: unresolved feature index, bad device index, bad root function, unknown function on a safe feature.
frames.push(P.frame("short", D, 0x7e, 0));
frames.push(P.frame("short", 0x00, idxOf(P.FEATURE.reportRate), 1));
frames.push(P.frame("short", 0x07, idxOf(P.FEATURE.reportRate), 1)); // slot 7 -> bad
frames.push(P.frame("short", D, P.IROOT_INDEX, 5));
frames.push(P.frame("short", D, idxOf(P.FEATURE.reportRate), 7));

// Deterministic fuzz
let seed = 0x1b08;
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
for (let k = 0; k < 400; k++) {
  const report = (["short", "long", "veryLong"] as const)[rnd(3)];
  const len = P.REPORT[report].len;
  const data = new Uint8Array(len);
  for (let j = 0; j < len; j++) data[j] = rnd(256);
  frames.push({ report, reportId: P.REPORT[report].id, data });
}

const fixtureLine = (allowed: boolean, reportId: number, data: Uint8Array): string => {
  const all = new Uint8Array(1 + data.length);
  all[0] = reportId;
  all.set(data, 1);
  let end = all.length;
  while (end > 1 && all[end - 1] === 0) end--;
  return `${allowed ? 1 : 0} ${P.hex(all.subarray(0, end), "")}`;
};

const lines = frames.map((f) => {
  const v = guard.classify({ type: "output", reportId: f.reportId, data: f.data });
  return fixtureLine(v.verdict !== "blocked", f.reportId, f.data);
});
// De-dup while keeping order.
const seen = new Set<string>();
const out = lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));

const dst = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/brands/logitech-kb/logitech-kb-frames.txt");
writeFileSync(dst, out.join("\n") + "\n");
const allowed = out.filter((l) => l.startsWith("1")).length;
console.log(`wrote ${out.length} frames (${allowed} allowed, ${out.length - allowed} blocked) to ${dst}`);
