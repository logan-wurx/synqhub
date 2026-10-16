// Regenerates src-tauri/linux/70-onboard-hub.rules, the Linux udev rule that gives the signed-in user access to
// the HID devices SYNQ supports, from the bridge's own device tables (src-tauri/src/udev.rs `rules()`: hid.rs,
// brands.rs, brand_ids.rs, openmouse_ids.rs). Run it after any of those tables change; the Rust test
// `udev::tests::the_shipped_rules_match_the_tables` fails until the file matches again.
//
//   node scripts/gen-udev-rules.mjs
//
// It runs that test with ONBOARD_WRITE_UDEV_RULES=1, which writes the file instead of comparing. No device is
// touched and no window opens.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(root, "src-tauri", "Cargo.toml");
const run = (env) =>
  spawnSync("cargo", ["test", "--manifest-path", manifest, "--lib", "udev::tests::the_shipped_rules_match_the_tables", "--", "--exact"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });

let r = run({ ONBOARD_WRITE_UDEV_RULES: "1" });
if (r.status !== 0) process.exit(r.status ?? 1);
r = run({});
if (r.status !== 0) process.exit(r.status ?? 1);
const file = join(root, "src-tauri", "linux", "70-onboard-hub.rules");
const entries = readFileSync(file, "utf8")
  .split("\n")
  .filter((l) => l.includes('TAG+="uaccess"')).length;
console.log(`${file}: ${entries} entries, matches the tables.`);
