// Writes src-tauri/src/x68-frames.txt: frames with the frontend allowlist's verdict (checkFrame in
// src/lib/x68he-protocol.ts), so the Rust copy (hid.rs x68_frame_allowed) can be tested against it.
// Run: node scripts/x68he-allowlist-fixture.ts   then   cargo test --lib x68_allowlist
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../src/lib/x68he-protocol.ts";

let seed = 777;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const frames: Uint8Array[] = [];
const add = (f: Uint8Array) => frames.push(f);

// Every encoder, many inputs.
for (const f of [P.encodeStatus(), P.encodeProduct(), P.encodeSerial(), P.encodeFnEditable(), P.encodeLightModes(), P.encodeLightModes(true), P.encodeLightRead(), P.encodeLightRead(true), P.encodeKeymapRead("default"), P.encodeKeymapRead("fn"), P.encodeAdvancedRead(), P.encodeSocdListRead(), P.encodeSocdPowerRead(), P.encodeTriggerConfigRead(), P.encodePollRateRead(), P.encodeProfileQuery(), P.encodeSwitchListRead(), P.encodeKeySwitchRead(), P.encodeDeadbandRead()]) add(f);
for (let i = 0; i < 10; i++) add(P.encodeMacroRead(i));
for (let i = 0; i < 132; i += 7) add(P.encodeKeyTriggerRead(i));
for (const hz of P.POLL_HZ) add(P.encodePollRateWrite(hz));
for (let i = 0; i < 5; i++) add(P.encodeProfileSet(i));
for (let n = 0; n < 60; n++) {
  const mode = P.WRITABLE_TRIGGER_MODES[rnd(3)];
  add(P.encodeTriggerWrite({ mode, travel: 1 + rnd(500), press: rnd(300), release: rnd(300) }, Array.from({ length: 1 + rnd(12) }, () => rnd(132))));
  for (const f of P.encodeKeymapWrite(rnd(2) ? "default" : "fn", new Uint8Array(528).map(() => rnd(256)))) add(f);
  for (const f of P.encodeDeadbandWrite(new Uint8Array(264).map(() => rnd(40)))) add(f);
  for (const f of P.encodeSocdWrite(Array.from({ length: rnd(21) }, (_, i) => ({ index: i, mode: rnd(4), key1: 1 + rnd(200), key2: 1 + rnd(200) })))) add(f);
  add(P.encodeSocdPowerWrite(!!rnd(2)));
  add(P.encodeLightWrite({ mode: rnd(17), brightness: rnd(5), speed: rnd(5), color: { r: rnd(256), g: rnd(256), b: rnd(256) }, background: { r: rnd(256), g: rnd(256), b: rnd(256) }, direction: rnd(6), fullColor: rnd(2), power: rnd(2), timer: rnd(3) }, !!rnd(2)));
  add(P.encodeDeviceSettings({ lockWin: !!rnd(2), lockShiftTab: !!rnd(2), lockAltF4: !!rnd(2), lockAltTab: !!rnd(2), superPerformance: !!rnd(2), sixKey: !!rnd(2) }));
  add(P.encodeAdvancedWrite(rnd(40), rnd(3) ? { slot: 0, type: "MT", actions: [[0, 4 + rnd(50), 0, 0], [0, 0xe0, 0, 0]], duration: 1 + rnd(100) } : null));
}
// Mutations of valid frames and plain random frames, including every first byte.
const valid = frames.length;
for (let n = 0; n < 3000; n++) {
  const base = n % 3 === 0 ? new Uint8Array(63) : new Uint8Array(frames[rnd(valid)]);
  if (n % 3 === 0) base[0] = rnd(64);
  const flips = 1 + rnd(3);
  for (let k = 0; k < flips; k++) base[rnd(n % 2 ? 8 : 63)] = rnd(4) ? rnd(256) : 0;
  add(base);
}
// Trailing zeros are dropped (the Rust test pads back to 63 bytes) to keep the file small.
const lines = frames.map((f) => `${P.checkFrame(f).ok ? 1 : 0} ${P.hex(f).replace(/ /g, "")}`);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src-tauri/src/x68-frames.txt");
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(`${lines.length} frames (${lines.filter((l) => l.startsWith("1")).length} allowed) -> ${out}`);
