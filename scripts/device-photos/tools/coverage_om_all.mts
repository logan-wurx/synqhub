// Every OpenMouse mouse (all statuses): which ones resolve to a picture.
import { readFileSync } from "node:fs";
import { photoKeyFor } from "../../../src/lib/device-images.ts";
// The folder holding the candidate lists (om-supported.json, brand-vids.json, ...), with a trailing slash.
const T = process.argv[2] ?? "";
if (!T) throw new Error("usage: node <script> <folder with the candidate lists>/");
const om = JSON.parse(readFileSync(T + "om-supported.json", "utf8")) as { brand: string; model: string; status: string; pids: number[] }[];
const vids = JSON.parse(readFileSync(T + "brand-vids.json", "utf8")) as Record<string, string[]>;
const hex = (n: number) => n.toString(16).padStart(4, "0");
const miss: Record<string, string[]> = {};
let n = 0, hit = 0;
for (const r of om) {
  const v = (vids[r.brand] ?? [])[0]?.slice(2);
  const k = photoKeyFor({ kind: "mouse", vid: v, pid: r.pids[0] !== undefined ? hex(r.pids[0]) : undefined, name: `${r.brand} ${r.model}`, brand: r.brand }) ?? (r.brand === "Logitech" && /superlight 2|dex/i.test(r.model) ? "handmade" : null);
  n++;
  if (k) hit++;
  else (miss[r.brand] ??= []).push(`${r.model} [${r.status}]`);
}
console.log(hit, "/", n);
for (const [b, l] of Object.entries(miss).sort((a, c) => c[1].length - a[1].length)) console.log(b.padEnd(14), l.length, "|", l.join(" | "));
