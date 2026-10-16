// Puts the official Equalizer APO 1.4.2 x64 installer next to this script, for bundling into
// SYNQ's installer (tauri.conf.json > bundle.resources). Keeps it only if its size and SHA-256
// match what SourceForge publishes for the release (same values as src-tauri/src/engine/model.rs).
//
//   node src-tauri/eq-engine/fetch.mjs
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = "EqualizerAPO-x64-1.4.2.exe";
const URL = "https://sourceforge.net/projects/equalizerapo/files/1.4.2/EqualizerAPO-x64-1.4.2.exe/download";
const SHA256 = "7403be7427bbe1936a40dded082829b6e217fc4f5990fee5cba501f0ae055afa";
const SIZE = 11_980_366;

const dest = join(dirname(fileURLToPath(import.meta.url)), FILE);
const ok = (buf) => buf.length === SIZE && createHash("sha256").update(buf).digest("hex") === SHA256;

if (existsSync(dest) && ok(readFileSync(dest))) {
  console.log(`${FILE} is already here and checks out.`);
  process.exit(0);
}
console.log(`Downloading ${URL}`);
const res = await fetch(URL, { redirect: "follow", headers: { "User-Agent": "Wget/1.21" } });
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
if (!ok(buf)) throw new Error(`The download (${buf.length} bytes) doesn't match the official file, so it wasn't saved.`);
writeFileSync(dest, buf);
console.log(`Saved ${dest} (SHA-256 ${SHA256}).`);
