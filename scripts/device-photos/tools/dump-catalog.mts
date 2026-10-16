// Dumps every device model the app has a table for, as {vendor, model, vid, pid, kind, src}.
import { writeFileSync } from "node:fs";
const R = new URL("../../../src/lib/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const out: any[] = [];
const add = (vendor: string, model: string, vid: number, pid: number, kind: string, src: string, extra: any = {}) => out.push({ vendor, model, vid, pid, kind, src, ...extra });
const tryImport = async (p: string) => { try { return await import("file:///" + R + p); } catch (e) { console.error("FAIL", p, String(e).slice(0, 200)); return null; } };

let m: any;
if ((m = await tryImport("brands/razer/devices.ts"))) {
  for (const k of m.RAZER_KEYBOARDS) add("Razer", k.model ?? k.name, 0x1532, k.pid, "keyboard", "razer-kb");
  for (const k of m.RAZER_MICE) add("Razer", k.model ?? k.name, 0x1532, k.pid, "mouse", "razer-mice");
}
if ((m = await tryImport("brands/steelseries/devices.ts"))) for (const k of m.MODELS) add("SteelSeries", k.model, k.vendorId, k.productId, k.kind ?? "keyboard", "steelseries");
if ((m = await tryImport("brands/drunkdeer/devices.ts"))) for (const k of m.DEVICES) add("DrunkDeer", k.model, k.vendorId, k.productId, "keyboard", "drunkdeer");
if ((m = await tryImport("brands/monsgeek/devices.ts"))) { for (const k of m.MONSGEEK_DEVICES) add("MonsGeek", k.model, k.vendorId, k.productId, "keyboard", "monsgeek-dev"); for (const k of m.MONSGEEK_MODELS) add("MonsGeek", k.name ?? k.model ?? JSON.stringify(k).slice(0,60), 0, 0, "keyboard", "monsgeek-model", { raw: k }); }
if ((m = await tryImport("brands/logitech-kb/devices.ts"))) { for (const k of m.LOGITECH_KEYBOARDS) add("Logitech", k.model, k.vendorId, k.productId, "keyboard", "logitech-kb"); for (const k of m.LOGITECH_ANALOG_KEYBOARDS) add("Logitech", k.model ?? k.name, 0x046d, k.productId ?? 0, "keyboard", "logitech-analog", {raw:k}); }
if ((m = await tryImport("brands/corsair-icue/devices.ts"))) for (const k of m.CORSAIR_ICUE_DEVICES) add("Corsair", k.model, k.vendorId, k.productId, k.kind, "corsair-icue");
if ((m = await tryImport("brands/corsair/devices.generated.ts"))) for (const k of m.WEBHUB_DEVICES) add("Corsair", k.name, 0x1b1c, k.pid, k.kind, "corsair-webhub", { desc: k.description });
if ((m = await tryImport("brands/asus/devices.generated.ts"))) for (const k of m.GEARLINK_DEVICES) add("ASUS", k.name, 0x0b05, k.pid, k.kind, "asus-gearlink", { code: k.productNumber, hidPattern: k.hidPattern });
if ((m = await tryImport("kb/fcc/sonix-catalog.generated.ts"))) for (const k of m.SONIX_CATALOG) add("Sonix", k.name, k.vendorId, k.productId, "keyboard", "sonix", { id: k.id, status: k.status, transport: k.transport, layout: k.layout });
if ((m = await tryImport("kb/analogsense/devices.ts"))) for (const k of m.MODELS) add(k.brand ?? k.family, k.name ?? k.model, k.vendorId, k.productId, "keyboard", "analogsense", { raw: k });
writeFileSync("catalog-raw.json", JSON.stringify(out, null, 1));
console.log(out.length);
const c: Record<string, number> = {}; for (const o of out) c[o.src] = (c[o.src] ?? 0) + 1; console.log(c);
