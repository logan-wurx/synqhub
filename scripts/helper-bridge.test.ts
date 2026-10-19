// SYNQ Helper, the website side (src/lib/web/helper.ts) against the helper itself
// (src-tauri/helper/src/bridge.rs) and the shared Rust config (src-tauri/src/helper_cfg.rs, games.rs):
//
//   - the website forwards exactly the commands the helper's bridge answers, and never the browser-only
//     ones (backups, logs, settings copies stay in this browser);
//   - the port and the site origin agree on both sides;
//   - the Games page's program-name rule is the Rust one;
//   - the Rust sources keep their safety rules (127.0.0.1 only, origin + host checks, every device
//     command through hid.rs, no firmware command).
//
// Nothing here opens a socket or talks to a device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HELPER_COMMANDS, HELPER_PORT, HELPER_URL } from "../src/lib/web/helper.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const bridge = read("src-tauri/helper/src/bridge.rs");
const cfg = read("src-tauri/src/helper_cfg.rs");

/** The command names in `Bridge::dispatch`'s match (string arms before `=>`). */
function bridgeCommands(): Set<string> {
  const body = bridge.slice(bridge.indexOf("pub fn dispatch"), bridge.indexOf("pub fn release"));
  const out = new Set<string>();
  for (const m of body.matchAll(/^\s*((?:"[a-z_]+"\s*\|\s*)*"[a-z_]+")\s*=>/gm)) for (const n of m[1].matchAll(/"([a-z_]+)"/g)) out.add(n[1]);
  return out;
}

test("the website forwards exactly what the helper answers", () => {
  const rust = bridgeCommands();
  assert.ok(rust.size > 15, `${rust.size}`);
  assert.deepEqual([...HELPER_COMMANDS].sort(), [...rust].sort());
});

test("browser-only commands never go to the helper", () => {
  for (const cmd of ["mouse_backup_save", "mouse_log", "kb_backup_save", "kb_log", "keyboard_log", "keyboard_state_load", "keyboard_state_save", "kb_definition_load", "kb_definition_save", "feel_load", "feel_save", "page_busy", "memory_trim"]) {
    assert.ok(!HELPER_COMMANDS.has(cmd), cmd);
  }
  // Nor anything that would change the helper itself or forget its sites from a website.
  for (const cmd of ["helper_set", "helper_forget_sites", "game_art_set", "game_art_clear"]) {
    assert.ok(!HELPER_COMMANDS.has(cmd), cmd);
  }
});

test("the Games page and battery alerts reach the helper, which asks before saving profiles", () => {
  for (const cmd of ["games_load", "games_save", "games_detect", "game_art", "helper_held", "device_state_save", "device_states_load", "helper_prefs", "helper_prefs_set", "games_running", "live_held_load", "live_held_save"]) {
    assert.ok(HELPER_COMMANDS.has(cmd), cmd);
  }
  const bridge = read("src-tauri/helper/src/bridge.rs");
  assert.match(bridge, /fn games_save\(&self[\s\S]*?self\.consent\.confirm/, "a site's profile save waits for the person's yes");
  assert.match(bridge, /fn engine\(&self[\s\S]*?self\.consent\.confirm[\s\S]*?run_elevated/, "the EQ engine's setup waits for the person's yes, then Windows' own prompt");
  assert.match(bridge, /"helper_set"/, "the helper's own settings stay the desktop app's (desktop_only test)");
});

test("the website's security policy lets the page reach the helper (and the site is the helper's origin)", () => {
  // public-web/_headers is what the live site sends: a connect-src without the helper's address blocks the bridge
  // in every browser, with nothing but a console error to show for it.
  const csp = read("public-web/_headers").match(/Content-Security-Policy: (.+)/)?.[1] ?? "";
  const connect = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src")) ?? "";
  assert.ok(connect.split(/\s+/).includes(HELPER_URL.replace(/\/$/, "")), `connect-src allows ${HELPER_URL}: ${connect}`);
  const web = read("vite.web.config.ts");
  assert.match(web, /og:image.*\$\{SITE_ORIGIN\}/, "the link preview's picture is on the site's own origin");
});

test("the app's program name is the one the helper and the game rules use", () => {
  // tauri.conf.json's mainBinaryName names the installed app; the helper opens it ("Open SYNQ"), leaves devices alone
  // while it runs, and neither it nor the helper may be taken for a game.
  const name = JSON.parse(read("src-tauri/tauri.conf.json")).mainBinaryName as string;
  assert.ok(name, "mainBinaryName is set");
  const main = read("src-tauri/helper/src/main.rs");
  assert.ok(main.includes(`const APP_EXE: &str = "${name}.exe";`), "helper APP_EXE");
  assert.ok(main.includes(`d.join("${name}")`), "helper opens the Linux app by its name");
  assert.ok(read("src-tauri/src/games.rs").includes(`["${name}.exe", "synq-helper.exe"`), "games.rs NOT_GAMES");
  assert.ok(read("src/lib/helper.ts").includes(`["${name}.exe", "synq-helper.exe"`), "helper.ts not-a-game list");
});

test("port and origin agree on both sides", () => {
  const port = Number(cfg.match(/pub const BRIDGE_PORT: u16 = (\d+);/)?.[1]);
  assert.equal(port, HELPER_PORT);
  assert.equal(HELPER_URL, `ws://127.0.0.1:${port}/`);
  const origin = cfg.match(/pub const SITE_ORIGIN: &str = "([^"]+)";/)?.[1];
  const links = read("src/lib/web/links.ts");
  assert.ok(origin && links.includes(`SITE_ORIGIN = "${origin}"`), "links.ts SITE_ORIGIN matches helper_cfg.rs");
  // Dev origins: the website's dev and preview ports, debug builds only.
  const web = read("vite.web.config.ts");
  for (const p of [web.match(/server: \{ port: (\d+)/)?.[1], web.match(/preview: \{ port: (\d+)/)?.[1]]) {
    assert.ok(p && cfg.includes(`"http://localhost:${p}"`), `dev origin for ${p}`);
  }
  assert.match(bridge, /if cfg!\(debug_assertions\) \{\s*v\.extend\(helper_cfg::DEV_ORIGINS/);
});

test("the bridge's safety rules are in place", () => {
  assert.match(bridge, /TcpListener::bind\(\("127\.0\.0\.1", port\)\)/, "loopback only");
  assert.match(bridge, /!host_ok\(r\.header\("host"\), port\) \|\| !origin_allowed\(r\.header\("origin"\), &allow\)/, "host and origin checked in the handshake");
  assert.match(bridge, /return Err\("Pair with SYNQ Helper first\.".into\(\)\);/, "nothing before pairing");
  // Every device command goes to hid.rs (the guarded bridge), never to hidapi directly.
  assert.doesNotMatch(bridge.slice(0, bridge.indexOf("#[cfg(test)]")), /hidapi::/);
  assert.doesNotMatch(bridge, /"[a-z_]*(firmware|bootloader|dfu)[a-z_]*"\s*=>/i, "no firmware command");
  // Only the hash of a pairing token is kept.
  assert.match(bridge, /token_sha256: sha256_hex\(token\)/);
});

test("program names follow the Rust rule", async () => {
  // src/lib/helper.ts imports the Tauri API; its `cleanExe` is checked against games.rs by source.
  const games = read("src-tauri/src/games.rs");
  const ts = read("src/lib/helper.ts");
  const notGamesRust = games.match(/const NOT_GAMES: \[&str; \d+\] = \[([^\]]+)\]/)?.[1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)).filter((s) => s.endsWith(".exe"));
  const notGamesTs = ts.match(/\[("synq\.exe"[^\]]+)\]\.includes/)?.[1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1));
  assert.deepEqual(notGamesTs, notGamesRust);
  assert.match(games, /MAX_EXE_LEN: usize = 64/);
  assert.match(ts, /e\.length > 64/);
  // The seeded games.
  for (const exe of ["cs2.exe", "valorant-win64-shipping.exe", "r5apex.exe", "fortniteclient-win64-shipping.exe", "overwatch.exe"]) assert.ok(games.includes(`"${exe}"`), exe);
});

test("the helper starts on a fresh Windows: the Visual C++ runtime is linked in, not needed as VCRUNTIME140.dll", () => {
  // It is handed out on its own (the website's "Get SYNQ Helper"); a PC that never installed the runtime can't start
  // an exe that imports it (the Sandbox test caught exactly that). The app gets the same from tauri-build.
  const build = read("src-tauri/helper/build.rs");
  assert.ok(build.includes("/NODEFAULTLIB:{lib}") && build.includes('"vcruntime.lib"'), "the dynamic runtime is left out");
  assert.ok(build.includes('"libvcruntime.lib"') && build.includes('"ucrt.lib"'), "the static runtime is named instead");
});
