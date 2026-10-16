// The scenarios in ../flows.mjs, driven through WebdriverIO against the real app (see ../wdio.conf.mjs).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scenarios } from "../flows.mjs";

const shots = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "screenshots");
const el = (sel) => $(sel);

const box = async (e) => ({ ...(await e.getLocation()), ...(await e.getSize()) });

/** Waits until the element has the same box twice in a row, 100 ms apart: a card or chip still sliding in from a page
 * transition would take the click on whatever has moved under the point WebKit aimed at. */
async function still(e) {
  let a = await box(e);
  for (let i = 0; i < 40; i++) {
    await browser.pause(100);
    const b = await box(e);
    if (["x", "y", "width", "height"].every((k) => Math.abs(a[k] - b[k]) < 0.5)) return;
    a = b;
  }
}

/** Runs `act` on a freshly found element once it is clickable and still, again with a new lookup if the old one went
 * stale or wasn't clickable yet. */
async function fresh(sel, act) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const e = await el(sel);
      await e.waitForClickable({ timeout: 8_000 });
      await still(e);
      return await act(e);
    } catch (err) {
      last = err;
      await browser.pause(250);
    }
  }
  throw last;
}

/** The flows' driver, on WebdriverIO. */
const t = {
  async waitFor(sel, { gone = false, timeout } = {}) {
    await (await el(sel)).waitForDisplayed({ reverse: gone, timeout });
  },
  async click(sel) {
    await fresh(sel, (e) => e.click());
  },
  async type(sel, text) {
    await fresh(sel, (e) => e.setValue(text));
  },
  async rect(sel) {
    const e = await el(sel);
    const [p, s] = await Promise.all([e.getLocation(), e.getSize()]);
    return { x: p.x, y: p.y, w: s.width, h: s.height };
  },
  async count(sel) {
    return (await $$(sel)).length;
  },
  async attr(sel, name) {
    return (await el(sel)).getAttribute(name);
  },
  async shot(name) {
    await browser.saveScreenshot(path.join(shots, `${name}.png`));
  },
  async errors() {
    return browser.execute(() => window.__onboardE2E?.errors ?? ["the e2e build's console recorder isn't there (was it built with npm run build:e2e?)"]);
  },
};

describe("SYNQ on Linux, with sample devices", () => {
  for (const s of scenarios) {
    it(s.name, () => s.run(t, { linux: true }));
  }
});
