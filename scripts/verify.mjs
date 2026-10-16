// Every check, in one command, the same locally and in CI (.github/workflows/linux.yml runs exactly this):
//
//   1. TypeScript        npx tsc --noEmit
//   2. Node tests        npm test (scripts/*.test.ts)
//   3. Simulations       node scripts/run-sims.mjs (scripts/*.sim.mjs)
//   4. App Rust tests    cargo test --lib (src-tauri)
//   5. Helper Rust tests cargo test -p synq-helper (its unit tests, which include every shared guard's)
//   6. Desktop build     npm run build
//   7. Website build     npm run build:web
//
//   npm run verify                      all of them; every step runs, then a summary (non-zero if any failed)
//   npm run verify -- --fail-fast       stop at the first failure
//   npm run verify -- --only=rust,sims  some steps (ids: tsc, test, sims, rust, helper, build, web)
//
// Nothing here opens a window or talks to a device.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = join(root, "src-tauri", "Cargo.toml");
const args = process.argv.slice(2);
const failFast = args.includes("--fail-fast");
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");

const steps = [
  { id: "tsc", name: "TypeScript (tsc --noEmit)", cmd: "npx", args: ["tsc", "--noEmit"] },
  { id: "test", name: "Node tests (npm test)", cmd: "npm", args: ["test"] },
  { id: "sims", name: "Simulations (scripts/*.sim.mjs)", cmd: process.execPath, args: [join(root, "scripts", "run-sims.mjs")] },
  { id: "rust", name: "App Rust tests (cargo test --lib)", cmd: "cargo", args: ["test", "--manifest-path", manifest, "--lib"] },
  { id: "helper", name: "Helper Rust tests (cargo test -p synq-helper)", cmd: "cargo", args: ["test", "--manifest-path", manifest, "-p", "synq-helper"] },
  { id: "build", name: "Desktop build (npm run build)", cmd: "npm", args: ["run", "build"] },
  { id: "web", name: "Website build (npm run build:web)", cmd: "npm", args: ["run", "build:web"] },
].filter((s) => !only || only.includes(s.id));

const results = [];
for (const s of steps) {
  console.log(`\n=== ${s.name}`);
  const t = Date.now();
  // npm / npx are .cmd files on Windows: run them through the shell there.
  const r = spawnSync(s.cmd, s.args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" && s.cmd !== process.execPath });
  const ok = r.status === 0;
  results.push({ ...s, ok, s: ((Date.now() - t) / 1000).toFixed(1) });
  if (!ok && failFast) break;
}
console.log("\n=== verify");
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name} (${r.s} s)`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} step(s) failed.` : `\nAll ${results.length} steps passed.`);
process.exit(failed ? 1 : 0);
