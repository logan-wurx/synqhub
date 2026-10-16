// Writes src-tauri/src/via-frames.txt: the frontend VIA/Vial guard's verdict (1 allowed, 0 refused)
// on ~1,400 frames (every command byte, every second byte of the commands that look at it, lighting
// value ids and keycode samples). The Rust bridge's `via_frame_allowed` must agree on every one
// (hid.rs test `via_guard_matches_the_frontend`). Run after changing either guard:
//
//   node scripts/via-guard-fixture.ts
//
// Trailing zero bytes are dropped from each line; the test pads frames back to 32 bytes.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkViaFrame } from "../src/lib/kb/via/guard.ts";

export function viaFixtureFrames(): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const frame = (...bytes: number[]) => {
    const f = new Uint8Array(32);
    f.set(bytes);
    frames.push(f);
  };
  for (let c = 0; c < 256; c++) frame(c);
  for (const c of [0x02, 0x07, 0x09, 0xfe]) for (let b = 1; b < 256; b++) frame(c, b);
  for (let ch = 0; ch <= 5; ch++) for (let id = 0; id <= 6; id++) frame(0x07, ch, id, 0x80, 0x40);
  for (const [hi, lo] of [
    [0x00, 0x00],
    [0x00, 0x01],
    [0x00, 0x04],
    [0x00, 0xe7],
    [0x00, 0xff],
    [0x01, 0x00],
    [0x01, 0x04],
    [0x51, 0x00],
    [0x52, 0x21],
    [0x5c, 0x00],
    [0x5c, 0xdf],
    [0x7c, 0x00],
    [0x7c, 0x01],
    [0x7c, 0x03],
    [0x7e, 0x00],
    [0xff, 0xff],
  ])
    frame(0x05, 1, 2, 3, hi, lo);
  return frames;
}

export function viaFixtureText(): string {
  return viaFixtureFrames()
    .map((f) => {
      let end = f.length;
      while (end > 1 && f[end - 1] === 0) end--;
      const hex = Array.from(f.subarray(0, end), (b) => b.toString(16).padStart(2, "0")).join("");
      return `${checkViaFrame(f).ok ? 1 : 0} ${hex}`;
    })
    .join("\n")
    .concat("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/src/via-frames.txt");
  writeFileSync(out, viaFixtureText());
  console.log(`wrote ${out}`);
}
