// Screenshots SYNQ's pages over CDP without touching the desktop.
// usage: node shoot.mjs <outDir> <step...>   steps: page:<Sound|Mouse|Keyboard>, pick:<button text>, wait:<ms>, shot:<name>
import { writeFileSync } from "node:fs";
const [outDir, ...steps] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9333}/json`)).json();
const page = list.find((p) => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const send = (method, params) => new Promise((r) => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
for (const step of steps) {
  const [kind, ...rest] = step.split(":");
  const arg = rest.join(":");
  if (kind === "page") {
    console.log(step, await evaluate(`(() => { const b = [...document.querySelectorAll("aside button")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(arg)})); b?.click(); return !!b; })()`));
  } else if (kind === "pick") {
    console.log(step, await evaluate(`(() => { const b = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null).find((b) => b.textContent.trim() === ${JSON.stringify(arg)}); b?.click(); return !!b; })()`));
  } else if (kind === "open") {
    console.log(step, await evaluate(`(() => { const b = document.querySelector('button[aria-label="Open ' + ${JSON.stringify(arg)} + '"]'); b?.click(); return !!b; })()`));
  } else if (kind === "tab") {
    console.log(step, await evaluate(`(() => { const b = [...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(arg)})); b?.click(); return !!b; })()`));
  } else if (kind === "size") {
    const [width, height] = arg.split("x").map(Number);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  } else if (kind === "wait") {
    await new Promise((r) => setTimeout(r, Number(arg)));
  } else if (kind === "shot") {
    const res = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${outDir}/${arg}.png`, Buffer.from(res.result.data, "base64"));
    console.log("saved", arg);
  } else if (kind === "text") {
    console.log(await evaluate(`[...document.querySelectorAll("main .overflow-y-auto")].filter((e) => e.offsetParent !== null).map((e) => e.innerText.slice(0, 600)).join("\\n---\\n")`));
  }
}
ws.close();
