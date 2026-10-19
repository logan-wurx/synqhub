// Leak check for a release build of the app. Read-only: it never runs the exe or the installer.
//
//   node release/tools/leak-scan.mjs --target <CARGO_TARGET_DIR> [--user-terms "YourName,YourHeadphones"]
//
// The personal terms to look for (your name, your devices' names, your email's user part) come from --user-terms,
// else the ONBOARD_LEAK_TERMS variable, else release/tools/leak-terms.local.txt (one per line or comma-separated;
// that file is kept out of git, so nobody's personal terms are published with the tool).
//
// It looks at three things:
//   1. the release exe (strings, UTF-8 and UTF-16),
//   2. the web assets compiled into it (Tauri stores them Brotli-compressed under
//      <target>/release/build/onboard-*/out/tauri-codegen-assets; each blob is also located inside
//      the exe, so what is scanned is what ships),
//   3. the build that produced it (cargo fingerprint: which features were on).
//
// Findings are grouped: dev paths, user-specific terms, secrets (patterns, and the values of this
// shell's own KEY/TOKEN/SECRET variables, which are searched for but never printed), debug ports.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { brotliDecompressSync } from "node:zlib";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const target = opt("target", process.env.CARGO_TARGET_DIR);
if (!target) {
  console.error("Usage: node release/tools/leak-scan.mjs --target <CARGO_TARGET_DIR> [--user-terms a,b,c]");
  process.exit(2);
}
const releaseDir = join(target, "release");
const exePath = opt("exe", join(releaseDir, "synq.exe"));
const localTerms = new URL("./leak-terms.local.txt", import.meta.url);
const userTerms = (opt("user-terms", process.env.ONBOARD_LEAK_TERMS) ?? (existsSync(localTerms) ? readFileSync(localTerms, "utf8") : ""))
  .split(/[,\r\n]/)
  .map((s) => s.trim())
  .filter(Boolean);
if (!userTerms.length) console.log("(no personal terms to look for: see the note at the top of this file)");

const PATTERN_GROUPS = {
  "dev paths": [
    /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>|]{1,40}[\\/]/g,
    /[\\/]\.cargo[\\/]registry/g,
    /[\\/]\.rustup[\\/]/g,
    /onboard-release-target/g,
    /[\\/]jev[\\/]onboard/gi,
    /\bnode_modules[\\/]/g,
    /\.pdb\b/gi,
  ],
  "secrets (patterns)": [
    /TYPESAFE_API_KEY/g,
    /\bsk-[A-Za-z0-9_-]{20,}/g,
    /\bghp_[A-Za-z0-9]{20,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bxox[bpas]-[A-Za-z0-9-]{10,}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g,
    /\b(?:api[_-]?key|secret|passwd|password|auth[_-]?token|access[_-]?token|bearer)\s*[:=]\s*["'`][^"'`\s]{8,}["'`]/gi,
  ],
  "debug ports and dev servers": [
    /--remote-debugging[-a-z]*/g,
    /remote-allow-origins/g,
    /\b9222\b/g,
    /localhost:\d{2,5}/g,
    /127\.0\.0\.1:\d{2,5}/g,
    /\bWEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS\b/g,
  ],
};

const devFiles = new Set();
const found = new Map(); // group -> Map(key -> {count, where:Set, example})
function note(group, key, where, example) {
  if (!found.has(group)) found.set(group, new Map());
  const g = found.get(group);
  const e = g.get(key) ?? { count: 0, where: new Set(), example };
  e.count++;
  e.where.add(where);
  g.set(key, e);
}

const clip = (s, n = 110) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Scans a Buffer as latin1 (UTF-8 text is ASCII-visible there) and as UTF-16LE. */
function scan(buf, where, { binary = false } = {}) {
  const latin = buf.toString("latin1");
  for (const m of latin.matchAll(/[A-Za-z]:[\\/]+Users[\\/]+[\x20-\x7e]{3,220}?\.(?:rs|toml|js|ts|tsx|pdb)\b/g)) devFiles.add(`${where}: ${m[0]}`);
  const wide = binary ? buf.toString("utf16le") : "";
  for (const [group, patterns] of Object.entries(PATTERN_GROUPS)) {
    for (const re of patterns) {
      for (const text of binary ? [latin, wide] : [latin]) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          const at = m.index ?? 0;
          const context = text.slice(Math.max(0, at - 30), at + m[0].length + 40).replace(/[^\x20-\x7e]/g, "·");
          note(group, clip(m[0], 60), where, clip(context));
        }
      }
    }
  }
  for (const term of userTerms) {
    const needles = [Buffer.from(term, "latin1"), Buffer.from(term, "utf16le")];
    for (const [i, n] of needles.entries()) {
      if (i === 0) {
        // Case-sensitive on purpose: the app id "com.logan.onboard" and Logitech's own "LOGAN" product
        // name are not the user's name; "Logan" in a path is.
        for (let at = latin.indexOf(term); at >= 0; at = latin.indexOf(term, at + 1)) {
          const context = latin.slice(Math.max(0, at - 40), at + term.length + 50).replace(/[^\x20-\x7e]/g, "·");
          note("user-specific terms", term, where, clip(context));
        }
      } else if (binary && buf.indexOf(n) >= 0) {
        note("user-specific terms", `${term} (UTF-16)`, where, "(wide string)");
      }
    }
  }
}

/** Values of this shell's secret-looking variables, searched for in every blob. Never printed. */
const secretValues = Object.entries(process.env)
  .filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(k) && v && v.length >= 8 && !/^(true|false|\d+)$/i.test(v) && !/PATH|DIR|HOME|FILE/i.test(k))
  .map(([k, v]) => [k, v]);
// Plus the local secret files in ~/.config/synq (a bot token and the like), searched for the same way, never printed.
const secretDir = join(homedir(), ".config", "synq");
if (existsSync(secretDir))
  for (const f of readdirSync(secretDir)) {
    const v = readFileSync(join(secretDir, f), "utf8").trim();
    if (v.length >= 8) secretValues.push([`~/.config/synq/${f}`, v]);
  }
function scanEnvSecrets(buf, where) {
  const hay = buf.toString("latin1");
  for (const [k, v] of secretValues) if (hay.includes(v)) note("secrets (this shell's own values)", `value of ${k}`, where, "(value not shown)");
}

console.log(`Exe: ${exePath}`);
if (!existsSync(exePath)) {
  console.error("The exe isn't there. Build first.");
  process.exit(2);
}
const exe = readFileSync(exePath);
console.log(`  ${exe.length} bytes, ${secretValues.length} secret-looking values checked for (env vars and ~/.config/synq files: ${secretValues.map(([k]) => k).join(", ") || "none"})`);
scan(exe, "synq.exe", { binary: true });
scanEnvSecrets(exe, "synq.exe");

// ---- embedded web assets
const buildDirs = existsSync(join(releaseDir, "build")) ? readdirSync(join(releaseDir, "build")).filter((d) => d.startsWith("onboard-")) : [];
const assetDirs = buildDirs
  .map((d) => join(releaseDir, "build", d, "out", "tauri-codegen-assets"))
  .filter((d) => existsSync(d));
// Older builds leave their own asset folders behind, so pick the one this exe was actually built from:
// the folder whose compressed files are found inside the exe most often.
const inExe = (dir) => readdirSync(dir).filter((f) => exe.indexOf(readFileSync(join(dir, f))) >= 0).length;
const scored = assetDirs.map((d) => ({ d, n: inExe(d) })).sort((a, b) => b.n - a.n);
assetDirs.length = 0;
for (const s of scored) assetDirs.push(s.d);
let assetCount = 0;
let notInExe = 0;
const names = [];
// Text that has to ship inside the app: Equalizer APO's license and credit (also reachable in the UI).
const REQUIRED_NOTICES = ["GNU GENERAL PUBLIC LICENSE", "Jonas Thedering", "sourceforge.net/projects/equalizerapo"];
const noticesSeen = new Set();
if (assetDirs.length) {
  const dir = assetDirs[0];
  console.log(`Embedded web assets: ${dir}`);
  for (const f of readdirSync(dir)) {
    const blob = readFileSync(join(dir, f));
    let plain;
    try {
      plain = brotliDecompressSync(blob);
    } catch {
      plain = blob;
    }
    assetCount++;
    if (exe.indexOf(blob) < 0) notInExe++;
    names.push(f);
    for (const n of REQUIRED_NOTICES) if (plain.includes(n)) noticesSeen.add(n);
    scan(plain, `asset ${f.slice(0, 10)}…${f.slice(f.lastIndexOf("."))}`);
    scanEnvSecrets(plain, `asset ${f.slice(0, 10)}`);
  }
  console.log(`  ${assetCount} assets decompressed and scanned; ${assetCount - notInExe} of them found byte-for-byte inside the exe${notInExe ? ` (${notInExe} NOT found: the exe is not from this asset set)` : ""}`);
  for (const n of REQUIRED_NOTICES) console.log(`  required notice "${n}": ${noticesSeen.has(n) ? "present" : "MISSING"}`);
} else {
  console.log("Embedded web assets: not found under build/onboard-*/out (nothing scanned there).");
}

// ---- features of the build
console.log("Build features (cargo fingerprint of the newest onboard bin):");
const fpRoot = join(releaseDir, ".fingerprint");
let newest = null;
if (existsSync(fpRoot)) {
  for (const d of readdirSync(fpRoot).filter((d) => d.startsWith("onboard-"))) {
    const json = join(fpRoot, d, "bin-onboard.json");
    if (existsSync(json)) {
      const t = statSync(json).mtimeMs;
      if (!newest || t > newest.t) newest = { t, json };
    }
  }
}
let perfTest = "unknown";
if (newest) {
  const fp = JSON.parse(readFileSync(newest.json, "utf8"));
  console.log(`  ${newest.json}: features ${fp.features} (written ${new Date(newest.t).toISOString()})`);
  perfTest = /perf-test/.test(fp.features) ? "ON" : "off";
}
const hookMsg = exe.indexOf("This build has no test hooks.") >= 0;
console.log(`  perf-test feature: ${perfTest}; the "no test hooks" refusal string is ${hookMsg ? "present" : "ABSENT"} in the exe (present = hooks compiled out)`);

// ---- report
console.log("\n=== Findings ===");
let total = 0;
for (const group of [...Object.keys(PATTERN_GROUPS), "user-specific terms", "secrets (this shell's own values)"]) {
  const g = found.get(group);
  console.log(`\n[${group}] ${g ? g.size + " distinct" : "none"}`);
  if (!g) continue;
  for (const [key, e] of [...g.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 25)) {
    total += e.count;
    console.log(`  ${String(e.count).padStart(4)}x ${key}   in: ${[...e.where].slice(0, 3).join(", ")}${e.where.size > 3 ? ` +${e.where.size - 3}` : ""}`);
    console.log(`        e.g. ${e.example}`);
  }
}
console.log(`\nDistinct source files named by a user-profile path: ${devFiles.size}`);
const byRoot = new Map();
for (const f of devFiles) {
  const path = f.slice(f.indexOf(": ") + 2);
  const root = path
    .replace(/(registry[\\/]src[\\/][^\\/]+[\\/]).*/, "$1…")
    .replace(/(onboard[\\/]src-tauri[\\/]).*/, "$1…");
  byRoot.set(root, (byRoot.get(root) ?? 0) + 1);
}
for (const [root, n] of [...byRoot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(n).padStart(4)}x ${root}`);
console.log(`\nTotal hits: ${total}`);
