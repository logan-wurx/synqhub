// Writes the frame lists the Rust bridge can enforce and test against, next to the brand code:
//   src/lib/brands/asus/asus-rules.json      the ASUS rule table + PID -> family map + bootloader PIDs
//   src/lib/brands/asus/asus-frames.txt      "<1|0> <pid> <hex>"           (verdict of classifyAsusFrame)
//   src/lib/brands/corsair/corsair-allow.json  Bragi allow spec (SET/GET props, files, framing per PID)
//   src/lib/brands/corsair/corsair-frames.txt "<1|0> <pid> <open file|-> <hex>" (classifyBragiFrame /
//                                              classifySabreFrame; column 3 is the file the bridge must
//                                              remember from the last allowed 0D open, cleared by 05)
// Trailing zero bytes are dropped; pad back to the report length (ASUS 64, Bragi 64, Sabre 16).
// Run: node scripts/brands-allowlist-fixture.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASUS_BOOTLOADER_PIDS, ASUS_MODELS, asusGuardFamily, asusKeyboardTraits, asusModel, asusMouseTraits } from "../src/lib/brands/asus/devices.ts";
import { ASUS_RULES, classifyAsusFrame } from "../src/lib/brands/asus/guard.ts";
import * as K from "../src/lib/brands/asus/keyboard-codec.ts";
import * as M from "../src/lib/brands/asus/mouse-codec.ts";
import * as B from "../src/lib/brands/corsair/bragi.ts";
import { CORSAIR_MODELS } from "../src/lib/brands/corsair/devices.ts";
import { GET_ALLOWED, SET_ALLOWED, classifyBragiFrame, fileReadable } from "../src/lib/brands/corsair/guard.ts";
import { classifySabreFrame, pairOf, sabreCommand, sabreDpiRow, sabreRead, sabreWrite, SABRE_ADDR } from "../src/lib/brands/corsair/sabre.ts";
import { hex } from "../src/lib/brands/types.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let seed = 2026;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed >>> 8) % n;
};
const strip = (f: Uint8Array) => {
  let end = f.length;
  while (end > 0 && f[end - 1] === 0) end--;
  return hex(f.subarray(0, end), "");
};
const mutate = (f: Uint8Array, span: number) => {
  const g = new Uint8Array(f);
  for (let k = 0; k < 1 + rnd(3); k++) g[rnd(span)] = rnd(4) ? rnd(256) : 0;
  return g;
};

// ---------------------------------------------------------------------------------------------
// ASUS
// ---------------------------------------------------------------------------------------------
const asusLines: string[] = [];
const asusAdd = (pid: number, f: Uint8Array) => asusLines.push(`${classifyAsusFrame(pid, f).verdict === "blocked" ? 0 : 1} ${pid.toString(16).padStart(4, "0")} ${strip(f)}`);
const kbPids = [0x1c10, 0x1c7d, 0x1d68, 0x1b7e, 0x1d1d, 0x1a83];
const mousePids = [0x1c69, 0x1db0];
const asusValid: [number, Uint8Array][] = [];
const keys = Object.values(K.FW_KEY).filter((k) => k !== K.FW_KEY.FN);
for (const pid of kbPids) {
  const m = asusModel(pid)!;
  if (!m.analog) continue;
  const s: K.KbUnitSpec = { cls: asusKeyboardTraits(m).cls, unitMm: m.analog.unitMm };
  const a = m.analog;
  const mm = (lo: number, hi: number) => Math.round((lo + (rnd(1000) / 1000) * (hi - lo)) / s.unitMm) * s.unitMm;
  for (let n = 0; n < 25; n++) {
    const k = keys[rnd(keys.length)];
    for (const f of [
      K.encodeGlobalActuation(s, mm(a.actuation.min, a.actuation.max)),
      K.encodeKeyActuation(s, k, mm(a.actuation.min, a.actuation.max)),
      K.encodeGlobalDeadZones(s, mm(0, a.deadZone.max), mm(0, a.deadZone.max)),
      K.encodeKeyDeadZones(s, k, mm(0, a.deadZone.max), mm(0, a.deadZone.max)),
      ...K.encodeRapidTriggerKey(s, k, { enabled: !!rnd(2), continuous: !!rnd(2), independent: !!rnd(2), sensitivityMm: mm(a.rapidTrigger.min, a.rapidTrigger.max), pressMm: mm(a.rapidTrigger.min, a.rapidTrigger.max), releaseMm: mm(a.rapidTrigger.min, a.rapidTrigger.max) }),
      K.encodeRemap(s, rnd(2) ? k : K.fnKey(k), keys[rnd(keys.length)], mm(a.actuation.min, a.actuation.max)),
      K.encodeSpeedTapPair(k, keys[rnd(keys.length)], !!rnd(2)),
    ])
      asusValid.push([pid, f]);
  }
  for (const f of [K.encodeSave(), K.encodeReadBasic(), K.encodeReadRtMode(), K.encodeReadSpeedTap(), K.encodeSpeedTapEnable(true), K.encodeRapidTriggerEnable(true), K.encodePollingRate(8000), K.encodeReadPollingIndex(), K.encodeReadSpeedTapPairs(1), ...[1, 2, 3, 4, 5, 6].map(K.encodeSelectProfile)]) asusValid.push([pid, f]);
  for (const g of ["v1", "v2"] as const) for (const f of [K.encodeReadActuation(g, null), K.encodeReadActuation(g, 0x12), K.encodeReadDeadZones(g, 0x12), K.encodeReadRapidTrigger(g, 0x12), K.encodeReadKeyTrigger(g, 0x9f12)]) asusValid.push([pid, f]);
}
for (const pid of mousePids) {
  const t = asusMouseTraits(asusModel(pid)!);
  for (let n = 0; n < 15; n++) asusValid.push([pid, M.encodeDpiStage(t, rnd(4), Math.max(100, Math.floor((100 + rnd(t.maxDpi - 100)) / t.dpiBase) * t.dpiBase))]);
  for (const hz of t.pollingHz) asusValid.push([pid, M.encodePolling(t, hz)]);
  for (const f of [M.encodeAngleSnap(t, true), M.encodeActiveStage(t, 1), M.encodeSelectProfile(2), M.encodeSave(), M.encodeReadInfo(), M.encodeReadPerformance(), M.encodeReadLod(), M.encodeReadBattery()]) asusValid.push([pid, f]);
}
for (const [pid, f] of asusValid) for (const p of [pid, ...kbPids, ...mousePids].slice(0, 3)) asusAdd(p, f);
const asusBlocked = ["7baa41535553aa", "7f55aa55aa000082", "4355aa55aa", "1041535553484944465755", "11ff", "1f01", "1f51", "2000000008", "82", "8e", "8f", "bac0", "c3", "7d2001", "b0000000726573657", "5040000001", "5040", "5060", "5202", "5152010064", "5156", "802600001200", "80270100120001", "8000000001", "a200000001", "a2010000050b", "7400000001", "5142000001", "5141000001", "5135010000", "5127120002", "2201"];
for (const h of asusBlocked) for (const pid of [...kbPids, ...mousePids]) asusAdd(pid, Uint8Array.from({ length: 64 }, (_, i) => (i * 2 < h.length ? parseInt(h.slice(i * 2, i * 2 + 2).padEnd(2, "0"), 16) : 0)));
for (const pid of [...ASUS_BOOTLOADER_PIDS].slice(0, 6)) asusAdd(pid, K.encodeReadBasic());
asusAdd(0x19af, K.encodeReadBasic());
for (let n = 0; n < 3000; n++) {
  const [pid, f] = asusValid[rnd(asusValid.length)];
  asusAdd([pid, ...kbPids, ...mousePids][rnd(9)], n % 3 ? mutate(f, 12) : (() => {
    const g = new Uint8Array(64);
    g[0] = [0x12, 0x25, 0x50, 0x51, 0x71, rnd(256)][rnd(6)];
    g[1] = rnd(256);
    for (let i = 2; i < 2 + rnd(8); i++) g[i] = rnd(16);
    return g;
  })());
}
const families: Record<string, string> = {};
for (const m of ASUS_MODELS.values()) families[m.pid.toString(16).padStart(4, "0")] = asusGuardFamily(m);
fs.writeFileSync(
  path.join(root, "src/lib/brands/asus/asus-rules.json"),
  JSON.stringify({ note: "ASUS Gear Link allowlist. Blocked rules first, then allowed; no match = refused. Frames are output report 0, 64 bytes (63 on some mice). See src/lib/brands/rules.ts for the matcher.", vendorId: "0b05", bootloaderPids: [...ASUS_BOOTLOADER_PIDS].map((p) => p.toString(16).padStart(4, "0")).sort(), familyByPid: families, rules: ASUS_RULES }, null, 1) + "\n",
);
fs.writeFileSync(path.join(root, "src/lib/brands/asus/asus-frames.txt"), asusLines.join("\n") + "\n");

// ---------------------------------------------------------------------------------------------
// CORSAIR
// ---------------------------------------------------------------------------------------------
const cLines: string[] = [];
const cAdd = (pid: number, openFile: number | null, f: Uint8Array) => {
  const m = CORSAIR_MODELS.get(pid)!;
  const v = m.family === "mouse-sabre" ? classifySabreFrame(f) : classifyBragiFrame({ framing: m.framing!, family: m.family, openFile }, f);
  cLines.push(`${v.verdict === "blocked" ? 0 : 1} ${pid.toString(16)} ${openFile ?? "-"} ${strip(f)}`);
};
const bragiPids = [0x2b0e, 0x2b31, 0x2b43, 0x2b2e, 0x2b1b];
for (const pid of bragiPids) {
  const m = CORSAIR_MODELS.get(pid)!;
  const o: B.FrameOpts = { framing: m.framing!, session: 0x5a, addr: m.family === "receiver" ? 1 : 0 };
  const valid: Uint8Array[] = [];
  for (const [prop, rule] of SET_ALLOWED) for (const v of [rule.min, rule.max, rule.max + 1]) valid.push(B.encodeSet(o, prop, v));
  for (const prop of [...GET_ALLOWED, 0x3e, 0x3b, 0x04]) valid.push(B.encodeGet(o, prop));
  for (const v of [3, 4, 5, 6, 7]) valid.push(B.encodeSet(o, B.PROP.operatingMode, v));
  for (const file of [0x0f, 38, 28000, 28399, 30000, 31000, 3, 5, 6, 18, 20, 53, 59, 60, 72, 75]) valid.push(B.encodeOpenFile(o, file));
  valid.push(B.encodePing(o), B.frame(o, 0x12, [1, 0, 0]), B.encodeDescribeBuffer(o), B.encodeReadBuffer(o), B.encodeUnbindBuffer(o));
  for (const cmd of [0x03, 0x0a, 0x0b, 0x0c, 0x0f, 0x10, 0x11, 0x16, 0x20]) valid.push(B.frame(o, cmd, [1, 0]));
  if (m.framing === "v15") valid.push(B.encodeSessionStart([1, 2, 3, 4]), B.encodeSessionStop(0x5a));
  const writes = B.encodeWriteFile(o, Uint8Array.from({ length: 200 }, () => rnd(256)));
  for (const f of valid) cAdd(pid, null, f);
  for (const f of writes) for (const open of [null, 0x6d63, 31000, 3, 0x0f]) cAdd(pid, open, f);
  for (let n = 0; n < 500; n++) cAdd(pid, rnd(4) ? null : [0x6d63, 3][rnd(2)], mutate(valid[rnd(valid.length)], 10));
}
const sabreFrames = [sabreRead(0, 2), sabreRead(0xdb, 3), sabreCommand(0x04), sabreCommand(0x12), sabreCommand(0x09), sabreCommand(0x01), sabreWrite(SABRE_ADDR.polling, pairOf(64)), sabreWrite(SABRE_ADDR.lod, pairOf(3)), sabreWrite(SABRE_ADDR.dpiStage0, sabreDpiRow(1600)), sabreWrite(0xdf, pairOf(1)), sabreWrite(0x60, [1, 2, 3, 4])];
for (const f of sabreFrames) cAdd(0x2b2a, null, f);
for (let n = 0; n < 300; n++) cAdd(0x2b28, null, mutate(sabreFrames[rnd(sabreFrames.length)], 16));
const framingByPid: Record<string, string | null> = {};
for (const m of CORSAIR_MODELS.values()) framingByPid[m.pid.toString(16)] = m.family === "mouse-sabre" ? "sabre-eeprom" : m.framing;
fs.writeFileSync(
  path.join(root, "src/lib/brands/corsair/corsair-allow.json"),
  JSON.stringify(
    {
      note: "CORSAIR allow spec. Bragi: output report 0 on 0xFF42 usage 1 (length from the descriptor, 64). Sabre v2: output report 8, 16 bytes, checksum to 0x55. Anything not listed is refused.",
      vendorId: "1b1c",
      framingByPid,
      familyByPid: Object.fromEntries([...CORSAIR_MODELS.values()].map((m) => [m.pid.toString(16), m.family])),
      bragi: {
        commandsAllowed: { "0x01": "SET (setAllowed only)", "0x02": "GET (getAllowed only)", "0x05": "close buffer 0 (01 00)", "0x06": "write begin (buffer 0, open writable file, total <= 4096)", "0x07": "write continue (same)", "0x08": "read buffer 0", "0x09": "describe buffer 0", "0x0D": "open (buffer 0, readable file)", "0x12": "ping, empty payload only", "0x1B": "session start, or stop of our own session (v1.5)" },
        commandsBlocked: { "0x03": "get multiple", "0x0A": "calibration", "0x0B": "create file", "0x0C": "delete file", "0x0F": "factory reset", "0x10": "apply firmware", "0x11": "pairing", "0x16": "apply firmware extended" },
        setAllowed: Object.fromEntries([...SET_ALLOWED].map(([p, r]) => [`0x${p.toString(16)}`, r])),
        getAllowed: [...GET_ALLOWED].map((p) => `0x${p.toString(16)}`),
        readableFiles: { fixed: [15, 38], hostRange: [B.HOST_FILE_MIN, B.HOST_FILE_MAX], excluded: [...B.IDENTITY_FILES] },
        writableFiles: { hostRange: [B.HOST_FILE_MIN, B.HOST_FILE_MAX], excluded: [...B.IDENTITY_FILES] },
        operatingModeValues: [1, 2],
      },
      sabre: { commandsAllowed: ["0x04 battery", "0x08 EEPROM read (len 1..10, addr <= 0x2FF)", "0x12 / 0x1D versions", "0x07 EEPROM write: 0x00 polling {1,16,32,64}, 0x04 stage, 0x0A LOD {0,3,4}, 0x0C+4i DPI rows, 0xAB / 0xAF / 0xB1 toggles"], blocked: ["0x01", "0x02", "0x09", "writes 0xDB-0xDF", "feature report 6"] },
    },
    null,
    1,
  ) + "\n",
);
fs.writeFileSync(path.join(root, "src/lib/brands/corsair/corsair-frames.txt"), cLines.join("\n") + "\n");
console.log(`asus: ${asusLines.length} frames (${asusLines.filter((l) => l.startsWith("1")).length} allowed); corsair: ${cLines.length} frames (${cLines.filter((l) => l.startsWith("1")).length} allowed); fileReadable(15)=${fileReadable(15)}`);
