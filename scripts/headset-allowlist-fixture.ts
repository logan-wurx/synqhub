// Writes src/lib/headsets/headset-frames.txt: frames with the TypeScript headset guard's verdict, one per line
// ("<1|0> <vid> <pid> <report> <data hex, trailing zeros dropped>"). The Rust guard (src-tauri/src/headsets.rs) must
// give every line the same verdict; scripts/headsets.test.ts checks the file still matches the TS guard.
//   node scripts/headset-allowlist-fixture.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHANNELS, MODELS, type Model } from "../src/lib/headsets/protocol.ts";
import { allowedFrames, checkHeadsetFrame } from "../src/lib/headsets/guard.ts";

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/** One model per family and save behaviour: the guard's rules differ by those only. */
function representatives(): Model[] {
  const seen = new Set<string>();
  return MODELS.filter((m) => {
    const k = `${m.family}:${!!m.saveAfterSidetone}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function fixtureLines(): string[] {
  const out = new Set<string>();
  const add = (m: Model, reportId: number, bytes: readonly number[]) => {
    const len = CHANNELS[m.family].length - 1;
    const data = new Uint8Array(len);
    data.set(bytes.slice(0, len));
    let end = data.length;
    while (end > 0 && data[end - 1] === 0) end--;
    const ok = checkHeadsetFrame(m, { reportId, data }).ok;
    out.add(`${ok ? 1 : 0} ${m.vid} ${m.pid} ${hex2(reportId)} ${Array.from(data.slice(0, end), hex2).join("")}`.trimEnd());
  };
  for (const m of representatives()) {
    const report = CHANNELS[m.family].reports[0];
    for (const key of allowedFrames(m).keys()) {
      const [rid, h] = key.split(":");
      const bytes = (h.match(/../g) ?? []).map((b) => parseInt(b, 16));
      add(m, parseInt(rid, 16), bytes);
      // Every meaningful byte changed, two ways, plus the first zero after them; and the same frame on other report ids.
      let used = bytes.length;
      while (used > 0 && bytes[used - 1] === 0) used--;
      for (let i = 0; i <= Math.min(used, 12); i++) {
        add(m, parseInt(rid, 16), bytes.map((b, j) => (j === i ? (b + 1) & 0xff : b)));
        if (i < used) add(m, parseInt(rid, 16), bytes.map((b, j) => (j === i ? b ^ 0x80 : b)));
      }
      for (const other of [0, 0x06, 0x11, 0x21, 0xff]) if (other !== report) add(m, other, bytes);
    }
    // Every command byte on its own, and with a small value after it.
    for (let c = 0; c < 256; c++) {
      if (m.family.startsWith("logi")) add(m, report, [0xff, c >> 4, c & 0x0f ? c : 0x0d, 0x01]);
      else if (m.family === "hyperx-cloud2w") add(m, report, [0xff, 0xbb, c, 0x05]);
      else add(m, report, [c, 0x01]);
    }
  }
  return [...out].sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const lines = fixtureLines();
  writeFileSync(new URL("../src/lib/headsets/headset-frames.txt", import.meta.url), `${lines.join("\n")}\n`);
  console.log(`${lines.length} frames, ${lines.filter((l) => l.startsWith("1")).length} allowed`);
}
