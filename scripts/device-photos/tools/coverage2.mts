// Final coverage table: per vendor group, how many distinct models get a vendor photo and how many fall back
// (keyboards: drawn from a layout; mice: silhouette).
import { readFileSync, writeFileSync } from "node:fs";
import { photoKeyFor, normName } from "../../../src/lib/device-images.ts";
// The folder holding the candidate lists (om-supported.json, brand-vids.json, ...), with a trailing slash.
const T = process.argv[2] ?? "";
if (!T) throw new Error("usage: node <script> <folder with the candidate lists>/");
const om = JSON.parse(readFileSync(T + "om-supported.json", "utf8")) as { brand: string; model: string; status: string; pids: number[] }[];
const vids = JSON.parse(readFileSync(T + "brand-vids.json", "utf8")) as Record<string, string[]>;
const cat = JSON.parse(readFileSync(T + "catalog-raw.json", "utf8")) as { vendor: string; model: string; vid: number; pid: number; kind: string; src: string; hidPattern?: number }[];
const razer = JSON.parse(readFileSync(T + "razer-products.json", "utf8")) as { pid: number; name: unknown }[];
const hex = (n: number) => n.toString(16).padStart(4, "0");
type Row = { group: string; kind: "mouse" | "keyboard"; name: string; hit: boolean; ids: string[]; brand: string };
const rows = new Map<string, Row>();
const add = (group: string, kind: "mouse" | "keyboard", name: string, hit: string | null, ids: string[] = [], brand = "") => {
  const k = `${group}|${kind}|${normName(name.replace(/\((?:wired|wireless|ansi|iso|jis|us|uk)[^)]*\)/gi, ""))}`;
  const prev = rows.get(k);
  rows.set(k, { group, kind, name, hit: !!hit || !!prev?.hit, ids: [...new Set([...(prev?.ids ?? []), ...ids])], brand: brand || prev?.brand || "" });
};
const GROUPS: Record<string, string> = { Razer: "Razer", Corsair: "Corsair", SteelSeries: "SteelSeries", Logitech: "Logitech", Asus: "ASUS", ASUS: "ASUS" };
for (const r of om) {
  if (!["supported", "likely", "bridge"].includes(r.status)) continue;
  const v = (vids[r.brand] ?? [])[0]?.slice(2);
  const hit = photoKeyFor({ kind: "mouse", vid: v, pid: r.pids[0] !== undefined ? hex(r.pids[0]) : undefined, name: `${r.brand} ${r.model}`, brand: r.brand }) ?? (r.brand === "Logitech" && /superlight 2|dex/i.test(r.model) ? "handmade" : null);
  const idl = r.pids.flatMap((p) => (vids[r.brand] ?? []).filter((x) => (vids[r.brand] ?? []).length <= 3).map((x) => `${x.slice(2).padStart(4, "0")}:${hex(p)}`));
  add(GROUPS[r.brand] ? `${GROUPS[r.brand]} (mice)` : "Other mice (OpenMouse list)", "mouse", `${r.brand} ${r.model}`, hit, idl, r.brand);
}
for (const p of razer) {
  if (typeof p.name !== "string" || /Dock|Dongle/.test(p.name)) continue;
  add("Razer (mice)", "mouse", `Razer ${p.name}`, photoKeyFor({ kind: "mouse", vid: "1532", pid: hex(p.pid), name: `Razer ${p.name}`, brand: "Razer" }), [`1532:${hex(p.pid)}`], "Razer");
}
for (const c of cat) {
  if (c.src === "asus-gearlink" && c.hidPattern === 3) continue;
  if (c.kind === "receiver" || (/RECEIVER|2\.4 GHz|dongle|Unknown board|unverified|model unknown/i.test(c.model) && c.src !== "monsgeek-model")) continue;
  if (c.src === "monsgeek-dev") continue;
  if (c.src === "asus-gearlink" && !["mouse", "keyboard"].includes(c.kind)) continue;
  const kind = c.kind === "mouse" ? "mouse" : "keyboard";
  const name = `${c.vendor === "Sonix" ? "" : c.vendor + " "}${c.model}`;
  const brand = /wooting/i.test(c.vendor) ? "Wooting" : c.vendor;
  const hit = photoKeyFor({ kind, vid: c.vid ? hex(c.vid) : undefined, pid: c.pid ? hex(c.pid) : undefined, name, brand });
  const g =
    c.src === "asus-gearlink" ? `ASUS (${kind === "mouse" ? "mice" : "keyboards"})`
    : c.src.startsWith("corsair") ? `Corsair (${kind === "mouse" ? "mice" : "keyboards"})`
    : c.src.startsWith("razer") ? `Razer (${kind === "mouse" ? "mice" : "keyboards"})`
    : c.src === "steelseries" ? "SteelSeries (keyboards)"
    : c.src.startsWith("logitech") ? "Logitech G (keyboards)"
    : c.src === "monsgeek-model" ? "MonsGeek / Akko (keyboards)"
    : c.src === "drunkdeer" ? "DrunkDeer (keyboards)"
    : c.src === "sonix" ? "Sonix / FCC boards (keyboards)"
    : /wooting|babao|kochi/i.test(name) ? "Wooting / Wuque / Kochi"
    : "Analog boards (AnalogSense list)";
  add(g, kind, name, hit, c.vid && c.pid ? [`${hex(c.vid)}:${hex(c.pid)}`] : [], c.vendor);
}
const out = new Map<string, { n: number; photo: number }>();
for (const r of rows.values()) {
  const g = out.get(r.group) ?? { n: 0, photo: 0 };
  g.n++;
  if (r.hit) g.photo++;
  out.set(r.group, g);
}
const lines = [...out].sort((a, b) => a[0].localeCompare(b[0]));
let N = 0, P = 0;
for (const [g, v] of lines) { console.log(g.padEnd(36), String(v.photo).padStart(4), "photo /", String(v.n).padStart(4), "models"); N += v.n; P += v.photo; }
console.log("TOTAL", P, "/", N);
writeFileSync(T + "coverage2.json", JSON.stringify(Object.fromEntries(out), null, 1));
writeFileSync(T + "uncovered.json", JSON.stringify([...rows.values()].filter((r) => !r.hit), null, 1));
