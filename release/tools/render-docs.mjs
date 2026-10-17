// Fills the {{placeholders}} in release/templates/*.template.md and writes the results, so the app's
// name, version and the installer's size and hash live in ONE place each:
//
//   name / version / app id : src-tauri/tauri.conf.json  (productName, version, identifier)
//   exe name                : src-tauri/Cargo.toml        ([package] name)
//   equalizer apo file/hash : src-tauri/src/engine/model.rs
//   installer size / hash   : release/<installer>.exe and release/SHA256SUMS.txt (written by build-release.mjs)
//
// To rename the app on paper: change productName in tauri.conf.json (and the window "title" next to
// it), then run   node release/tools/render-docs.mjs   and every guide and test script follows.
//
// Outputs: release/BETA-GUIDE.md, release/RELEASE-NOTES-<version>.md, release/sandbox-test/app.json
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rel = join(root, "release");
const read = (p) => readFileSync(join(root, p), "utf8");

const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargoName = /^\s*name\s*=\s*"([^"]+)"/m.exec(read("src-tauri/Cargo.toml").split("[lib]")[0])?.[1];
const model = read("src-tauri/src/engine/model.rs");
const constant = (name) => new RegExp(`pub const ${name}: [^=]+= *"?([^";]+)"?;`).exec(model)?.[1];
const eapo = {
  version: constant("ENGINE_VERSION"),
  file: constant("INSTALLER_FILE"),
  size: Number(constant("INSTALLER_SIZE").replace(/_/g, "")),
  sha256: constant("INSTALLER_SHA256"),
};
if (!cargoName || !eapo.version || !eapo.file || !eapo.sha256) throw new Error("Couldn't read the exe name or the engine constants.");

const installer = `${conf.productName}_${conf.version}_x64-setup.exe`;
const installerPath = join(rel, installer);
let sha = "(build the installer first)";
let sizeMb = "?";
let sizeBytes = "?";
const sums = join(rel, "SHA256SUMS.txt");
if (existsSync(sums)) {
  const line = readFileSync(sums, "utf8").split(/\r?\n/).find((l) => l.includes(installer));
  if (line) sha = line.split(/\s+/)[0];
}
if (existsSync(installerPath)) {
  sizeBytes = statSync(installerPath).size.toLocaleString("en-US");
  sizeMb = (statSync(installerPath).size / 1024 / 1024).toFixed(1);
}

const values = {
  APP_NAME: conf.productName,
  VERSION: conf.version,
  APP_ID: conf.identifier,
  EXE: `${cargoName}.exe`,
  INSTALLER: installer,
  INSTALLER_MB: sizeMb,
  INSTALLER_BYTES: sizeBytes,
  INSTALLER_SHA256: sha,
  EAPO_VERSION: eapo.version,
  EAPO_FILE: eapo.file,
  DATE: new Date().toISOString().slice(0, 10),
  // This version's "New in" section, from release/notes/new-in-<version>.md (none: nothing).
  NEW_IN: existsSync(join(rel, "notes", `new-in-${conf.version}.md`)) ? readFileSync(join(rel, "notes", `new-in-${conf.version}.md`), "utf8").trimEnd() + "\n\n" : "",
};

function render(text, file) {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`${file}: unknown placeholder {{${key}}}`);
    return values[key];
  });
}

const outputs = [
  ["BETA-GUIDE.template.md", "BETA-GUIDE.md"],
  ["RELEASE-NOTES.template.md", `RELEASE-NOTES-${conf.version}.md`],
];
for (const [src, dest] of outputs) {
  const from = join(rel, "templates", src);
  if (!existsSync(from)) {
    console.log(`(skipped ${src}: not there)`);
    continue;
  }
  writeFileSync(join(rel, dest), render(readFileSync(from, "utf8"), src));
  console.log(`wrote release/${dest}`);
}

// The sandbox test reads its facts from here instead of hard-coding them.
writeFileSync(
  join(rel, "sandbox-test", "app.json"),
  JSON.stringify({ name: conf.productName, identifier: conf.identifier, version: conf.version, exe: values.EXE, installer, eapo }, null, 2) + "\n",
);
console.log("wrote release/sandbox-test/app.json");

// Windows Sandbox wants absolute host folders: fill this checkout's path into the .wsb templates (the results are
// kept out of git).
for (const name of ["onboard-sandbox.wsb", "onboard-sandbox-manual.wsb", "synq-helper-sandbox.wsb"]) {
  const template = join(rel, "sandbox-test", `${name}.template`);
  if (!existsSync(template)) continue;
  writeFileSync(join(rel, "sandbox-test", name), readFileSync(template, "utf8").replaceAll("{{REPO}}", root));
  console.log(`wrote release/sandbox-test/${name}`);
}

// Old per-version notes from earlier betas are left alone; list what is in release/.
console.log("release/ now holds: " + readdirSync(rel).filter((f) => !f.startsWith(".")).join(", "));
