// Builds the beta installer the same way every time, then checks and files it.
//
//   node release/tools/build-release.mjs            build, copy to release/, hash, leak-scan, render docs
//   node release/tools/build-release.mjs --no-build skip the build (re-run the steps after it)
//
// Same command as always (`npx tauri build --bundles nsis`, separate target dir), plus one thing: it
// tells rustc to rewrite this PC's folders (your profile, the cargo cache) to neutral names, so the
// panic messages inside the exe don't spell out where it was built. Nothing else about the build
// changes, and no source file is touched.
//
// The app's name comes from src-tauri/tauri.conf.json (productName) and nowhere else in here.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const { productName, version } = conf;
const target = process.env.CARGO_TARGET_DIR ?? join(os.tmpdir(), "onboard-release-target");
const installerName = `${productName}_${version}_x64-setup.exe`;
const built = join(target, "release", "bundle", "nsis", installerName);
const outDir = join(root, "release");

function run(cmd, args, env = process.env) {
  // One command string for the shell (npx is npx.cmd on Windows); every argument here is a fixed word or a quoted path.
  const r = spawnSync([cmd, ...args].join(" "), { cwd: root, env, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(" ")} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
}

if (!process.argv.includes("--no-build")) {
  const home = os.homedir();
  const cargoHome = process.env.CARGO_HOME ?? join(home, ".cargo");
  // Later mappings win, so the general one goes first.
  const remap = [`${home}=/home`, `${root}=/onboard`, `${cargoHome}=/cargo`].map((m) => `--remap-path-prefix=${m}`);
  const inherited = (process.env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: target,
    // Unit separator between flags, so a folder name with a space can't split one.
    CARGO_ENCODED_RUSTFLAGS: [...inherited, ...remap].join("\x1f"),
  };
  delete env.RUSTFLAGS;
  console.log(`Building ${productName} ${version} into ${target}\n  path rewrites: ${remap.join("  ")}\n`);
  run("npx", ["tauri", "build", "--bundles", "nsis"], env);
}

if (!existsSync(built)) {
  console.error(`The installer isn't where it should be: ${built}`);
  process.exit(1);
}
const final = join(outDir, installerName);
copyFileSync(built, final);
const sha = createHash("sha256").update(readFileSync(final)).digest("hex");
console.log(`\nInstaller: ${final}\n  ${statSync(final).size} bytes\n  SHA-256 ${sha}\n`);

// SYNQ Helper on its own, for the website's Get SYNQ Helper (src/lib/web/links.ts HELPER_DOWNLOAD_URL): the same file
// the installer carries, which installs itself when run on its own (src-tauri/helper/src/standalone.rs).
const helperName = "synq-helper.exe";
const helperBuilt = join(target, "release", helperName);
if (!existsSync(helperBuilt)) {
  console.error(`SYNQ Helper isn't where it should be: ${helperBuilt}`);
  process.exit(1);
}
const helperFinal = join(outDir, helperName);
copyFileSync(helperBuilt, helperFinal);
const helperSha = createHash("sha256").update(readFileSync(helperFinal)).digest("hex");
console.log(`SYNQ Helper: ${helperFinal}\n  ${statSync(helperFinal).size} bytes\n  SHA-256 ${helperSha}\n`);
writeFileSync(join(outDir, "SHA256SUMS.txt"), `${sha} *${installerName}\n${helperSha} *${helperName}\n`);

console.log("--- leak scan ---");
run("node", [join("release", "tools", "leak-scan.mjs"), "--target", `"${target}"`]);

const render = join(root, "release", "tools", "render-docs.mjs");
if (existsSync(render)) {
  console.log("\n--- docs ---");
  run("node", [join("release", "tools", "render-docs.mjs")]);
}
