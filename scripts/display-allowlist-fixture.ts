// Writes src/lib/displays/display-cases.txt: monitor (DDC/CI) and webcam (UVC) writes with the TypeScript guards'
// verdicts. The Rust guards (src-tauri/src/monitors.rs, webcams.rs) must give every line the same verdict;
// scripts/displays.test.ts checks the file still matches the TS guards.
//   vcp <code> <value> <max> <listed values, comma, or -> <confirm 0|1> <verdict 0|1>
//   uvc <id> <min> <max> <step> <canAuto 0|1> <value> <auto 0|1> <verdict 0|1>
//   node scripts/display-allowlist-fixture.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { vcpRefusal, type Caps } from "../src/lib/displays/vcp.ts";
import { UVC, uvcRefusal } from "../src/lib/displays/uvc.ts";

const CAPS: Caps = { model: "Sample", mccs: "2.2", vcp: { "16": [], "18": [], "20": [5, 6, 8, 11], "22": [], "24": [], "26": [], "96": [1, 3, 17], "98": [], "141": [1, 2], "4": [], "214": [1, 4, 5], "223": [] } };

export function caseLines(): string[] {
  const out: string[] = [];
  const codes = [0x02, 0x04, 0x05, 0x06, 0x08, 0x0a, 0x0c, 0x10, 0x12, 0x14, 0x16, 0x18, 0x1a, 0x52, 0x60, 0x62, 0x6c, 0x8d, 0xb0, 0xd6, 0xdf, 0xe0, 0xf0, 0xff];
  for (const code of codes) {
    for (const value of [0, 1, 2, 3, 5, 6, 7, 17, 50, 100, 101, 255]) {
      for (const max of [0, 100]) {
        for (const confirm of [false, true]) {
          for (const caps of [CAPS, { ...CAPS, vcp: { "16": [], "18": [] } }]) {
            const ok = vcpRefusal(code, value, caps, max, confirm) === null;
            const lst = caps.vcp[String(code)];
            out.push(`vcp ${code} ${value} ${max} ${lst === undefined ? "absent" : lst.length ? lst.join(",") : "-"} ${confirm ? 1 : 0} ${ok ? 1 : 0}`);
          }
        }
      }
    }
  }
  const ranges = [
    { min: -11, max: -2, step: 1, canAuto: true },
    { min: 2800, max: 6500, step: 10, canAuto: false },
    { min: 0, max: 255, step: 1, canAuto: false },
    { min: 0, max: 3, step: 1, canAuto: false },
  ];
  for (const id of [...UVC.map((s) => s.id), "gain", "roll", "iris", "hue"]) {
    for (const r of ranges) {
      for (const value of [r.min - 1, r.min, r.min + 1, Math.round((r.min + r.max) / 2), r.max, r.max + 1, 4005]) {
        for (const auto of [false, true]) {
          const ok = uvcRefusal(id, r, value, auto) === null;
          out.push(`uvc ${id} ${r.min} ${r.max} ${r.step} ${r.canAuto ? 1 : 0} ${value} ${auto ? 1 : 0} ${ok ? 1 : 0}`);
        }
      }
    }
  }
  return [...new Set(out)];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const lines = caseLines();
  writeFileSync(new URL("../src/lib/displays/display-cases.txt", import.meta.url), `${lines.join("\n")}\n`);
  console.log(`${lines.length} cases, ${lines.filter((l) => l.endsWith(" 1")).length} allowed`);
}
