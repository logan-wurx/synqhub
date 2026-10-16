// Builds SYNQ Helper for the installer (tauri.conf.json > build.beforeBundleCommand): synq-helper.exe on
// Windows, synq-helper on Linux. The NSIS hook (src-tauri/installer/hooks.nsh) and the Linux bundles
// (tauri.linux.conf.json > bundle.linux.deb/appimage.files) pick the helper up from src-tauri/target/release,
// but a release build may use another target dir (CARGO_TARGET_DIR, as release/tools/build-release.mjs does),
// so the fresh binary is copied there; otherwise the installer could ship a stale helper.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync("cargo build --release --manifest-path src-tauri/Cargo.toml -p synq-helper", { cwd: root, stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);

const defaultDir = join(root, "src-tauri", "target", "release");
const builtDir = process.env.CARGO_TARGET_DIR ? join(resolve(process.env.CARGO_TARGET_DIR), "release") : defaultDir;
const exe = process.platform === "win32" ? "synq-helper.exe" : "synq-helper";
const built = join(builtDir, exe);
if (!existsSync(built)) {
  console.error(`${exe} not found at ${built}`);
  process.exit(1);
}
if (resolve(builtDir) !== resolve(defaultDir)) {
  mkdirSync(defaultDir, { recursive: true });
  copyFileSync(built, join(defaultDir, exe));
  console.log(`copied the fresh helper to ${defaultDir}`);
}
