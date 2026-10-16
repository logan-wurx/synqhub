// Runs every headless simulation (scripts/*.sim.mjs): each drives a real driver session against a simulated
// device in memory (no hardware, no window, no Tauri) and exits non-zero when a check or a firmware tripwire
// fails. This exits non-zero when any of them does, with a summary.
//
//   node scripts/run-sims.mjs            all of them, 4 at a time
//   node scripts/run-sims.mjs razer x68  only the ones whose name contains one of the words
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const filter = process.argv.slice(2);
const sims = readdirSync(dir)
  .filter((f) => f.endsWith(".sim.mjs"))
  .filter((f) => filter.length === 0 || filter.some((w) => f.includes(w)))
  .sort();
if (sims.length === 0) {
  console.error("No simulations matched.");
  process.exit(1);
}
const TIMEOUT_MS = 5 * 60_000;
const slots = Math.max(1, Math.min(4, availableParallelism() - 1));

function runOne(file) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(dir, file)], { cwd: join(dir, ".."), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      out += `\n(timed out after ${TIMEOUT_MS / 1000} s)`;
      child.kill();
    }, TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ file, ok: code === 0 && !signal, code: code ?? signal, ms: Date.now() - started, out });
    });
  });
}

const queue = [...sims];
const results = [];
await Promise.all(
  Array.from({ length: slots }, async () => {
    while (queue.length) {
      const file = queue.shift();
      const r = await runOne(file);
      results.push(r);
      console.log(`${r.ok ? "ok  " : "FAIL"} ${file} (${(r.ms / 1000).toFixed(1)} s)`);
      if (!r.ok) console.log(r.out.trim().split("\n").slice(-40).join("\n"));
    }
  }),
);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} simulations passed.`);
process.exit(failed.length ? 1 : 0);
