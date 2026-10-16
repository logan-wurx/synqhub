// The USB RGB hub guard's case file: every report SYNQ builds for every hub in hubs.json (allowed), the reports it
// never sends (fans, effects, Corsair's direct mode, LED-count setup, other channels and lengths), and single-byte
// mutations of the allowed ones, each with the TypeScript guard's verdict. The bridge's guard
// (src-tauri/src/lighting/hidrgb.rs) must judge every line the same way.
//   node scripts/hidrgb-fixture.ts   (writes src/lib/lighting/hidrgb/rgb-frames.txt)
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkHubFrame } from "../src/lib/lighting/hidrgb/guard.ts";
import { DATA_LEN, MODELS, colourFrames, identifyFrames, maxLeds, type Frame, type HubModel } from "../src/lib/lighting/hidrgb/protocol.ts";

const hex = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
const COLOURS = [
  [255, 0, 0],
  [12, 200, 77],
] as const;

function ledCounts(m: HubModel): number[] {
  if (m.family === "lianli-sl") return [16, 32, 64];
  if (m.family === "nzxt-hue2") return [1, 20, 21, maxLeds(m)];
  return [1, 96, maxLeds(m)];
}

function raw(m: HubModel, reportId: number, bytes: number[], len = DATA_LEN[m.family]): Frame {
  const data = new Uint8Array(len);
  data.set(bytes.slice(0, len));
  return { reportId, data };
}

/** Reports SYNQ never sends this family. */
function refused(m: HubModel): Frame[] {
  const ch = m.channels;
  if (m.family === "nzxt-hue2")
    return [
      raw(m, 0x62, [0x01, 1, 50]),
      raw(m, 0x28, [0x03, 1, 0x28, 0x07]),
      raw(m, 0x2a, [0x04, 1, 1]),
      raw(m, 0x22, [0x10, 1 << ch, 0, 255]),
      raw(m, 0x22, [0x12, 1, 0, 255]),
      raw(m, 0x22, [0x10, 3, 0, 255]),
      raw(m, 0x22, [0xa0, 1, 0, 0x01, 0, 0, 0x28, 0, 0, 0x80, 0, 0x32, 0, 0, 0x02]),
      raw(m, 0x10, [0x02]),
      raw(m, 0x22, [0x10, 1, 0, 255], 64),
    ];
  if (m.family === "corsair-node")
    return [
      raw(m, 0, [0x38, 0, 0x02]),
      raw(m, 0, [0x32, 0, 0, 10, 0, 255]),
      raw(m, 0, [0x39, 0, 100]),
      raw(m, 0, [0x3a, 0, 96]),
      raw(m, 0, [0x3b, 0, 1]),
      raw(m, 0, [0x36, 0, 0x10, 0x00]),
      raw(m, 0, [0x35, 0, 0, 96, 0x00, 0, 0, 0, 0, 255, 0, 0]),
      raw(m, 0, [0x35, 0, 0, 96, 0x04, 0, 0, 0, 0, 255, 0, 0, 0, 255, 0]),
      raw(m, 0, [0x35, 0, 0, 205, 0x04]),
      raw(m, 0, [0x35, ch, 0, 10, 0x04, 0, 0, 0, 0, 255]),
      raw(m, 0, [0x37, ch]),
      raw(m, 1, [0x02]),
      raw(m, 0, [0x02], 63),
    ];
  return [
    raw(m, 0xe0, [0x10, 0x05, 0x00, 0x00, 0x00]),
    raw(m, 0xe0, [0x10, 0x01, 0x02, 0x00, 0x08]),
    raw(m, 0xe0, [0x10, 0x32, 0x05]),
    raw(m, 0xe0, [0x10, 0x32, 0x10 * ch + 1]),
    raw(m, 0xe0, [0x10 + ch, 0x01, 0x02, 0x00, 0x00]),
    raw(m, 0xe0, [0x30 + ch, 255], 193),
    raw(m, 0xe1, [0x10, 0x32, 0x01]),
    raw(m, 0xe0, [0x30, 255], 192),
  ];
}

export function caseLines(): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (m: HubModel, f: Frame) => {
    const v = checkHubFrame(m, f);
    const line = `${v.ok ? 1 : 0} ${m.vid}:${m.pid} ${f.reportId.toString(16).padStart(2, "0")} ${hex(f.data)} ${v.ok ? v.what : "-"}`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  };
  for (const m of MODELS) {
    const built: Frame[] = [...identifyFrames(m)];
    for (let ch = 0; ch < m.channels; ch++) for (const c of COLOURS) for (const n of ledCounts(m)) built.push(...(colourFrames(m, ch, c, n) ?? []));
    for (const f of built) add(m, f);
    for (const f of refused(m)) add(m, f);
    // Single-byte mutations of the first channel's reports: whatever the guard says, the bridge must say too.
    for (const f of [...identifyFrames(m), ...(colourFrames(m, 0, COLOURS[0], ledCounts(m)[0]) ?? [])])
      for (let i = 0; i < Math.min(6, f.data.length); i++) {
        const data = f.data.slice();
        data[i] = (data[i] + 1) & 0xff;
        add(m, { reportId: f.reportId, data });
      }
  }
  return lines;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = new URL("../src/lib/lighting/hidrgb/rgb-frames.txt", import.meta.url);
  const lines = caseLines();
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`rgb-frames.txt: ${lines.length} lines (${lines.filter((l) => l.startsWith("1")).length} allowed)`);
}
