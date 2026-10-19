// Posts new public work into SYNQ's Discord #dev-log: the banner (banner.html, screenshotted by headless Edge or
// Chrome) as its own message on top, then each change's title, notes and link. It runs on the developer's PC after a
// push to the public repo, so no secret is ever stored on GitHub: the webhook URL is read from
// ~/.config/synq/devlog-webhook.txt and never printed. Nobody is pinged, whatever a commit message says.
//   node scripts/devlog/post.mjs <before> <after>              (run in the public checkout: the commits just pushed)
//   node scripts/devlog/post.mjs <before> <after> --dry-run <out.png>   (renders and prints, posts nothing)
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dry = process.argv.includes("--dry-run");
const hookFile = join(homedir(), ".config", "synq", "devlog-webhook.txt");
const hook = existsSync(hookFile) ? readFileSync(hookFile, "utf8").trim() : "";
if (!hook && !dry) {
  console.log(`No webhook in ${hookFile}: nothing to post.`);
  process.exit(0);
}
const [before = "", after = "HEAD"] = process.argv.slice(2).filter((a) => !a.startsWith("--") && !a.endsWith(".png"));
const repoUrl = "https://github.com/logan-wurx/synqhub";
const range = !before || /^0+$/.test(before) ? ["-1", after] : [`${before}..${after}`];
const raw = execFileSync("git", ["log", "--reverse", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", ...range], { encoding: "utf8" });
const commits = raw
  .split("\x1e")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [sha, subject, body = ""] = s.split("\x1f");
    // Commit bodies are wrapped at about 110 columns; Discord wraps by itself, so a wrapped line joins the one before it.
    const lines = body.split("\n").filter((l) => !/^Co-Authored-By:/i.test(l));
    const joined = lines.reduce((out, line) => {
      const t = line.trim();
      if (!t) out.push("");
      else if (out.length && out.at(-1) !== "" && !/^([-*]|\d+\.)\s/.test(t)) out[out.length - 1] += " " + t;
      else out.push(t);
      return out;
    }, []);
    return { sha, subject, body: joined.join("\n").trim() };
  });
if (!commits.length) {
  console.log("No new commits to post.");
  process.exit(0);
}

// The banner: the newest change's title, how many came in this push, the date.
const last = commits.at(-1);
// The developer's own calendar day (the release notes are dated the same way), not UTC's, which turns over in the evening here.
const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const label = `Dev log · ${commits.length > 1 ? `${commits.length} changes · ` : ""}${date}`;
const seed = parseInt(last.sha.slice(0, 6), 16) % 97;
const png = dry ? resolve(process.argv[process.argv.indexOf("--dry-run") + 1] ?? "devlog.png") : join(mkdtempSync(join(tmpdir(), "devlog-")), "banner.png");
const page = `${pathToFileURL(join(here, "banner.html")).href}?${new URLSearchParams({ title: last.subject, label, seed: String(seed) })}`;
const browser = process.env.CHROME_BIN || (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : "google-chrome");
execFileSync(browser, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
  "--force-device-scale-factor=2", "--window-size=1500,500", "--virtual-time-budget=5000", `--screenshot=${png}`, page,
], { stdio: "ignore" });

// The notes: every change in the push, oldest first, split into messages under Discord's 2,000 characters.
const blocks = commits.map((c) => `**${c.subject}**\n${c.body ? c.body + "\n" : ""}${repoUrl}/commit/${c.sha.slice(0, 7)}`);
const messages = [];
for (const b of blocks) {
  const text = b.length > 1900 ? b.slice(0, 1880) + "…" : b;
  if (messages.length && messages.at(-1).length + text.length + 2 <= 1900) messages[messages.length - 1] += "\n\n" + text;
  else messages.push(text);
}

if (dry) {
  console.log(`banner: ${png}\n${messages.map((m, i) => `--- message ${i + 1} (${m.length} chars)\n${m}`).join("\n")}`);
  process.exit(0);
}
const send = async (init) => {
  const res = await fetch(`${hook}?wait=true`, { method: "POST", ...init });
  if (!res.ok) throw new Error(`Discord answered ${res.status}`); // the URL holds the webhook's token: never print it
};
const form = new FormData();
form.append("payload_json", JSON.stringify({ attachments: [{ id: 0, filename: "synq-devlog.png" }], allowed_mentions: { parse: [] } }));
form.append("files[0]", new Blob([readFileSync(png)], { type: "image/png" }), "synq-devlog.png");
await send({ body: form });
for (const content of messages) {
  await new Promise((r) => setTimeout(r, 800));
  // flags 4: no link previews under the notes; allowed_mentions: no @everyone or role pings from a commit message
  await send({ headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, flags: 4, allowed_mentions: { parse: [] } }) });
}
console.log(`Posted ${commits.length} change(s) to #dev-log.`);
