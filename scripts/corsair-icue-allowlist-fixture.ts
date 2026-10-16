// Generates src/lib/brands/corsair-icue/corsair-icue-frames.txt: one line per BRAGI frame,
//   `<1|0> <hex>`  where hex = report-id byte (00) + data bytes, trailing zeros dropped.
// 1 = CorsairIcueGuard lets it through, 0 = refused. The desktop bridge runs the same table.
// Run (no device, no window): node scripts/corsair-icue-allowlist-fixture.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CorsairIcueGuard } from "../src/lib/brands/corsair-icue/guard.ts";
import * as P from "../src/lib/brands/corsair-icue/protocol.ts";

const guard = new CorsairIcueGuard();

const frames: P.BragiFrame[] = [
  // allowed
  P.getFirmware(),
  P.getPid(),
  P.getLayout(),
  P.lightingProbe(P.ADDR.lightCtrl1),
  P.lightingProbe(P.ADDR.lightCtrl2),
  P.getFirmware("wireless"),
  P.setRenderMode(P.MODE.direct),
  P.setRenderMode(P.MODE.hwStatic),
  P.startLightingTx(P.ADDR.lightCtrl1),
  P.startLightingTx(P.ADDR.lightCtrl2),
  P.stopLightingTx(P.ADDR.lightCtrl2),
  P.ledBlockFirst(300, [1, 2, 3, 4, 5]),
  P.ledBlockNext([9, 8, 7]),
];

// blocked: wrong command bytes (firmware/reset/pairing/actuation live here), bad addresses, bad endpoints.
const blocked: P.BragiFrame[] = [];
const mk = (bytes: number[]): P.BragiFrame => {
  const d = new Uint8Array(P.BRAGI.length);
  d.set(bytes.slice(0, P.BRAGI.length));
  return { reportId: P.BRAGI.reportId, data: d };
};
// unknown command bytes 0x03,0x04,0x08..0x0C,0x0E..0x14 with wired id
for (const cmd of [0x00, 0x03, 0x04, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0e, 0x0f, 0x10, 0x14, 0x20, 0xff]) blocked.push(mk([0x08, cmd, 0x11, 0x00]));
// GET on unlisted addresses (e.g. a hardware-profile / actuation property)
for (const addr of [0x00, 0x05, 0x13, 0x30, 0x41 + 1, 0x60, 0x80, 0xa0]) blocked.push(mk([0x08, P.CMD.get, addr]));
// SET on non-render-mode addresses (profile/actuation writes)
for (const addr of [0x00, 0x11, 0x12, 0x22, 0x40, 0x55]) blocked.push(mk([0x08, P.CMD.set, addr, 0x01]));
// START_TX on a non-lighting endpoint (firmware/other) — opt1 != 0 or ctrl not 0x01/0x22
blocked.push(mk([0x08, P.CMD.startTx, 0x01, 0x22]));
blocked.push(mk([0x08, P.CMD.startTx, 0x00, 0x05]));
blocked.push(mk([0x08, P.CMD.startTx, 0x02, 0x01]));
// bad write id
blocked.push(mk([0x07, P.CMD.get, 0x11]));
blocked.push(mk([0x00, P.CMD.get, 0x11]));

for (const f of blocked) frames.push(f);

// deterministic fuzz
let seed = 0x1bc0;
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
for (let k = 0; k < 300; k++) {
  const d = new Uint8Array(P.BRAGI.length);
  for (let j = 0; j < 6; j++) d[j] = rnd(256);
  frames.push({ reportId: P.BRAGI.reportId, data: d });
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
const seen = new Set<string>();
const out = lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));

const dst = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/brands/corsair-icue/corsair-icue-frames.txt");
writeFileSync(dst, out.join("\n") + "\n");
const allowed = out.filter((l) => l.startsWith("1")).length;
console.log(`wrote ${out.length} frames (${allowed} allowed, ${out.length - allowed} blocked) to ${dst}`);
