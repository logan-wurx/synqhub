// Coverage of everything that is not a mouse or a keyboard (coverage2.mts counts those): how many of the models SYNQ
// lists, or the common ones it can identify, resolve to a product photo through the same resolver the app uses.
//
//   node scripts/device-photos/tools/coverage3.mts [--missing]
//
// Controllers: every named model in src/lib/controllers (PAD_MODELS, and the named rows of PAD_ROWS, by the name and
// brand identify.ts gives them). Headsets: src/lib/headsets/headsets.json. Govee: the lighting catalogue. RGB hubs:
// src/lib/lighting/hidrgb/hubs.json. Webcams, monitors, Wi-Fi lights and headphones have no closed list in the app (any
// UVC camera, any DDC/CI monitor, any light on the network, any of ~6,000 AutoEq headphones), so `targets.json` lists
// the common ones with the name and id the app would see.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { headphonePhotoKeyFor, normName, photoKeyFor, type DeviceImageQuery } from "../../../src/lib/device-images.ts";
import { PAD_BOOT, PAD_ROWS } from "../../../src/lib/controllers/ids.generated.ts";
import { PAD_MODELS } from "../../../src/lib/controllers/models.ts";
import { identifyPad } from "../../../src/lib/controllers/identify.ts";
import { GOVEE_MODELS } from "../../../src/lib/lighting/govee/models.generated.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const json = (p: string) => JSON.parse(readFileSync(join(repo, p), "utf8"));
const missing = process.argv.includes("--missing");
const hex = (n: number) => n.toString(16).padStart(4, "0");

type Row = { label: string; hit: string | null };
const report = (title: string, rows: Row[]) => {
  const by = new Map<string, Row>();
  for (const r of rows) {
    const k = normName(r.label);
    const prev = by.get(k);
    by.set(k, { label: r.label, hit: prev?.hit ?? r.hit });
  }
  const all = [...by.values()];
  const n = all.filter((r) => r.hit).length;
  console.log(title.padEnd(34), String(n).padStart(4), "/", String(all.length).padStart(4));
  if (missing) for (const r of all.filter((r) => !r.hit)) console.log("    -", r.label);
  return [n, all.length];
};

// Controllers: the models SYNQ names, then every other named id, as identify.ts names them.
const GENERIC = /^(game controller|xbox(?: 360)?[- ]compatible controller|playstation \d-style controller|switch pro-compatible controller|switch controller|switch 2 controller|8bitdo controller|gamesir controller|flydigi controller|xbox elite controller|xbox 360 controller|xbox one controller|xbox wireless controller|pro controller|wireless controller|steam deck controls)$/i;
const boot = new Set(PAD_BOOT.map(([v, p]) => `${v}:${p}`));
const pads: Row[] = [];
const modelRows: Row[] = [];
for (const m of PAD_MODELS) {
  const i = m.ids[0];
  const hit = photoKeyFor({ kind: "gamepad", vid: i ? hex(i.vid) : null, pid: i ? hex(i.pid) : null, name: m.name, brand: m.brand });
  modelRows.push({ label: `${m.brand} ${m.name}`, hit });
}
for (const [vid, pid, , transport] of PAD_ROWS) {
  if (boot.has(`${vid}:${pid}`)) continue;
  const id = identifyPad({ vid, pid, product: null, via: transport === "hid" ? "hid" : "xinput" });
  if (!id || GENERIC.test(id.name)) continue;
  const label = new RegExp(`^${id.brand.replace(/[^a-z0-9]/gi, ".")}\\b`, "i").test(id.name) || !id.brand ? id.name : `${id.brand} ${id.name}`;
  pads.push({ label, hit: photoKeyFor({ kind: "gamepad", vid: hex(vid), pid: hex(pid), name: id.name, brand: id.brand }) });
}

// Headsets, as HeadsetPage asks: "<brand> <model>" with the USB id.
const hs = json("src/lib/headsets/headsets.json") as { families: Record<string, { brand: string }>; models: { vid: string; pid: string; family: string; name: string }[] };
const headsets = hs.models.map((m) => {
  const brand = hs.families[m.family].brand;
  return { label: `${brand} ${m.name}`, hit: photoKeyFor({ kind: "headset", name: `${brand} ${m.name}`, brand, vid: m.vid, pid: m.pid }) };
});

// Govee lights, as lightArt asks ("Govee H6076").
const govee = Object.keys(GOVEE_MODELS).map((sku) => ({ label: `Govee ${sku}`, hit: photoKeyFor({ kind: "light", name: `Govee ${sku}`, brand: "Govee" }) }));

// RGB hubs and the Nautilus cap, by USB id and name.
const hubsJ = json("src/lib/lighting/hidrgb/hubs.json") as { models: { vid: string; pid: string; name: string }[]; identifyOnly: { vid: string; pid: string; name: string }[] };
const hubs = [...hubsJ.models, ...hubsJ.identifyOnly].map((m) => ({ label: m.name, hit: photoKeyFor({ kind: "light", vid: m.vid, pid: m.pid, name: m.name, brand: "" }) }));

// The lists without a closed set in the app.
type Target = { label: string; q: DeviceImageQuery };
const targets = JSON.parse(readFileSync(join(here, "targets.json"), "utf8")) as Record<string, Target[]>;
const fromTargets = (k: string) => (targets[k] ?? []).map((t) => ({ label: t.label, hit: k === "headphones" ? headphonePhotoKeyFor(t.q.name ?? "") : photoKeyFor(t.q) }));

console.log("Category".padEnd(34), "photo / models");
const parts = [
  report("Controllers (SYNQ's models)", modelRows),
  report("Controllers (all named ids)", [...modelRows, ...pads]),
  report("Headsets", headsets),
  report("Webcams (common)", fromTargets("webcams")),
  report("Monitors (common)", fromTargets("monitors")),
  report("Govee (catalogue)", govee),
  report("Wi-Fi lights (product lines)", fromTargets("wifilights")),
  report("RGB hubs + Nautilus cap", hubs),
  report("Headphones / IEMs (popular)", fromTargets("headphones")),
];
void parts;
