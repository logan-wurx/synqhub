// End-to-end tests of the real desktop app on Linux, in CI only (.github/workflows/linux.yml): WebdriverIO talks to
// tauri-driver, which starts WebKitWebDriver, which starts the app built with `npm run build:e2e` (the preview's
// sample devices; no hardware, nothing saved anywhere but the runner). Run under Xvfb:
//
//   npx tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json
//   xvfb-run -a npm --prefix e2e test
//
// Never run it on a desktop: it opens the app's window.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// The app's program is `synq` (tauri.conf.json mainBinaryName).
const application = process.env.ONBOARD_E2E_APP ?? path.resolve(here, `../src-tauri/target/debug/synq${process.platform === "win32" ? ".exe" : ""}`);
const driverPath = process.env.TAURI_DRIVER ?? path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver");
mkdirSync(path.join(here, "screenshots"), { recursive: true });

let driver;

export const config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.e2e.mjs"],
  maxInstances: 1,
  capabilities: [{ maxInstances: 1, "tauri:options": { application } }],
  logLevel: "warn",
  bail: 0,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 180_000 },

  onPrepare() {
    if (!existsSync(application)) throw new Error(`The e2e build isn't there: ${application} (npx tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json)`);
    if (!existsSync(driverPath)) throw new Error(`tauri-driver isn't installed: ${driverPath} (cargo install tauri-driver --locked)`);
  },
  beforeSession() {
    driver = spawn(driverPath, [], { stdio: [null, process.stdout, process.stderr] });
  },
  afterTest: async function (test, _context, { passed }) {
    if (!passed) await browser.saveScreenshot(path.join(here, "screenshots", `failed-${test.title.replace(/[^a-z0-9]+/gi, "-")}.png`)).catch(() => undefined);
  },
  afterSession() {
    driver?.kill();
  },
};
