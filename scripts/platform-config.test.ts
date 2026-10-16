// The Tauri config per platform, merged the way Tauri merges tauri.<platform>.conf.json into tauri.conf.json
// (JSON Merge Patch, RFC 7396):
//
//   - Windows keeps exactly what it had: the WebView2 flags, the NSIS installer with its hooks, the bundled EQ
//     engine installer (there is no tauri.windows.conf.json);
//   - Linux gets the same window without the WebView2 flags, a .deb and an AppImage carrying the helper and the
//     udev rule, the .deb's maintainer scripts, and no Equalizer APO;
//   - macOS (switched off in CI) the same window, an app and a dmg, no Equalizer APO;
//   - the end-to-end config only swaps the frontend build for the sample-device one and turns bundling off;
//   - the Linux workflow runs `npm run verify`, runs on pushes to its working branches (linux-port, controllers,
//     lighting) and by hand, and never releases.
//
// Nothing here builds anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const json = (p: string) => JSON.parse(read(p));

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** RFC 7396: objects merge key by key, null deletes, anything else (arrays included) replaces. */
function mergePatch(target: Json, patch: Json): Json {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: { [k: string]: Json } = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k] ?? null, v);
  }
  return out;
}

const base = json("src-tauri/tauri.conf.json");
const WEBVIEW2_FLAGS = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --in-process-gpu --disable-gpu --enable-features=NetworkServiceInProcess2";
const EAPO = "eq-engine/EqualizerAPO-x64-1.4.2.exe";

test("Windows keeps exactly the config it had", () => {
  assert.ok(!existsSync(join(root, "src-tauri/tauri.windows.conf.json")), "no Windows overrides: tauri.conf.json is the Windows config");
  assert.equal(base.app.windows.length, 1);
  assert.equal(base.app.windows[0].additionalBrowserArgs, WEBVIEW2_FLAGS);
  assert.deepEqual(base.bundle.targets, ["nsis"]);
  assert.equal(base.bundle.resources[EAPO], EAPO);
  assert.equal(base.bundle.windows.nsis.installerHooks, "installer/hooks.nsh");
  assert.equal(base.bundle.windows.nsis.installMode, "perMachine");
  assert.equal(base.build.beforeBundleCommand, "npm run build:helper");
});

for (const os of ["linux", "macos"]) {
  test(`${os}: the same window without the WebView2 flags, and no Equalizer APO`, () => {
    const merged = mergePatch(base, json(`src-tauri/tauri.${os}.conf.json`)) as typeof base;
    const { additionalBrowserArgs, ...windowsWindow } = base.app.windows[0];
    assert.equal(additionalBrowserArgs, WEBVIEW2_FLAGS);
    assert.deepEqual(merged.app.windows, [windowsWindow], "only the WebView2 flags differ from the Windows window");
    assert.deepEqual(merged.bundle.resources, {}, "the Equalizer APO installer isn't bundled");
    assert.equal(merged.identifier, base.identifier);
    assert.equal(merged.version, base.version);
  });
}

test("Linux: a .deb and an AppImage with the helper and the udev rule", () => {
  const merged = mergePatch(base, json("src-tauri/tauri.linux.conf.json")) as typeof base;
  assert.deepEqual(merged.bundle.targets, ["deb", "appimage"]);
  const deb = merged.bundle.linux.deb;
  assert.equal(deb.files["/usr/bin/synq-helper"], "target/release/synq-helper");
  assert.equal(deb.files["/usr/lib/udev/rules.d/70-onboard-hub.rules"], "linux/70-onboard-hub.rules");
  assert.ok(deb.depends.includes("libudev1"));
  assert.equal(merged.bundle.linux.appimage.files["/usr/bin/synq-helper"], "target/release/synq-helper");
  for (const script of [deb.postInstallScript, deb.preRemoveScript, deb.postRemoveScript]) {
    assert.ok(existsSync(join(root, "src-tauri", script)), script);
    assert.ok(read(`src-tauri/${script}`).startsWith("#!/bin/sh\n"), `${script}: a POSIX script with LF line ends`);
  }
  assert.match(read(`src-tauri/${deb.postInstallScript}`), /udevadm control --reload-rules && udevadm trigger/);
  assert.ok(existsSync(join(root, "src-tauri/linux/70-onboard-hub.rules")));
  // The helper is built for the bundles on every platform, with that platform's file name.
  assert.match(read("scripts/build-helper.mjs"), /process\.platform === "win32" \? "synq-helper\.exe" : "synq-helper"/);
});

test("the end-to-end config only swaps the frontend build and turns bundling off", () => {
  const e2e = json("src-tauri/tauri.e2e.conf.json");
  assert.deepEqual(Object.keys(e2e).filter((k) => k !== "$schema").sort(), ["build", "bundle"]);
  assert.deepEqual(e2e.build, { beforeBuildCommand: "npm run build:e2e" });
  assert.deepEqual(e2e.bundle, { active: false });
  assert.match(read("vite.config.ts"), /__ONBOARD_E2E__: mode === "e2e" \? "true" : "false"/, "only the e2e mode turns the sample devices on");
});

test("the Linux workflow checks main, the work branches and pull requests, and never releases", () => {
  const wf = read(".github/workflows/linux.yml");
  assert.match(wf, /push:\s+branches: \[main, linux-port, controllers, lighting\]/);
  assert.match(wf, /^ {2}pull_request:$/m);
  assert.match(wf, /workflow_dispatch:/);
  // A push or a pull request runs every stage; only a run by hand can switch stages off.
  assert.doesNotMatch(wf, /github\.event_name == 'push' \|\|/, "a pull request would skip the stages");
  assert.equal((wf.match(/github\.event_name != 'workflow_dispatch' \|\| inputs\.(verify|bundle|e2e)/g) ?? []).length, 3);
  assert.doesNotMatch(wf, /schedule:|action-gh-release|tagName|releaseName|gh release create|^\s+release:/im, "no schedule, no GitHub release");
  assert.match(wf, /run: npm run verify/);
  assert.match(wf, /runs-on: ubuntu-22\.04/);
  assert.match(wf, /--self-test/);
  const desktop = read(".github/workflows/desktop.yml");
  assert.doesNotMatch(desktop, /\n\s+push:/, "Windows and macOS run by hand only");
  assert.match(desktop, /vars\.MACOS_ENABLED == 'true'/);
  assert.doesNotMatch(desktop, /tagName|releaseName|gh release/);
});
