// Puts the website (`npm run build:web` -> dist-web) on Cloudflare as the Worker "synqhub" (static files only).
//
//   node release/tools/deploy-web.mjs              build, then upload
//   node release/tools/deploy-web.mjs --no-build   upload what dist-web holds
//
// It uploads from a folder outside the repo (SYNQ_SITE_DIR, default %TEMP%\synq-site) with a config written here:
// run inside the repo, wrangler "sets the project up" by rewriting vite.config.ts and package.json.
// The files of earlier uploads stay in that folder and go up again: a page someone opened before the update keeps
// finding its parts (they are named by their content, so nothing old is ever served for something new). The page
// reloads itself onto the new version if a part is gone anyway (src/main.tsx).
// Needs `npx wrangler login` once on this PC.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(root, "dist-web");
const site = process.env.SYNQ_SITE_DIR ?? join(os.tmpdir(), "synq-site");
const pub = join(site, "public");

function run(cmd, cwd) {
  const r = spawnSync(cmd, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!process.argv.includes("--no-build")) run("npm run build:web", root);
if (!existsSync(join(dist, "index.html"))) {
  console.error(`No website build in ${dist}.`);
  process.exit(1);
}

mkdirSync(join(pub, "assets"), { recursive: true });
// Everything but the content-named parts is replaced; the parts are added to.
for (const name of readdirSync(pub)) if (name !== "assets") rmSync(join(pub, name), { recursive: true, force: true });
cpSync(dist, pub, { recursive: true });

writeFileSync(
  join(site, "wrangler.jsonc"),
  `// Written by release/tools/deploy-web.mjs.
{
  "name": "synqhub",
  "compatibility_date": "2026-10-12",
  // The site's links are #addresses: a path that isn't a file is a plain 404, never the page in its place (which
  // the long cache rule for /assets/* would keep for a year under a script's name).
  "assets": { "directory": "./public", "not_found_handling": "none" }
}
`,
);
run("npx -y wrangler@4 deploy", site);
