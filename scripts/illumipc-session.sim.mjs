// Headless end-to-end check of the illumipc driver (src/lib/x68he.ts + src/lib/x68he-layout.ts + the catalogue in
// src/lib/illumipc) against simulated keyboards that are not the X68 HE: a Redragon K673 on 2E3C:C365, a Redragon M82
// on 0416:7372, an Epomaker HE60 Lite that borrows illumipc's fallback layout, a Womier M68HE PRO, an Epomaker HE30 in
// a gamepad-mode id, and a board whose product code nobody listed. The keyboards answer the way illumipc's code expects
// (no hardware, no window, no Tauri). Bundles the session with the project's rolldown, swapping @tauri-apps/api and
// ./backend for in-memory mocks. The X68 HE itself is checked by scripts/x68he-session.sim.mjs.
// Run: node scripts/illumipc-session.sim.mjs
import { rolldown } from "rolldown";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(os.tmpdir(), `illumipc-sim-${process.pid}.mjs`);

const MOCKS = {
  "@tauri-apps/api/core": "export const invoke = (cmd, args) => globalThis.__tauri.invoke(cmd, args);",
  "@tauri-apps/api/event": "export const listen = (ev, cb) => globalThis.__tauri.listen(ev, cb);",
  "./backend": "export const inTauri = true; export const liveHardware = true;",
};
const bundle = await rolldown({
  input: path.join(root, "src/lib/x68he.ts"),
  plugins: [
    {
      name: "mocks",
      resolveId(id) {
        if (id in MOCKS) return `\0mock:${id}`;
        return null;
      },
      load(id) {
        if (id.startsWith("\0mock:")) return MOCKS[id.slice(6)];
        return null;
      },
    },
  ],
});
await bundle.write({ file: out, format: "esm" });

// ---------------------------------------------------------------------------------------------
// Simulated keyboard
// ---------------------------------------------------------------------------------------------
let KEY = "2e3c:c365:1:";
let USB = { vendorId: 0x2e3c, productId: 0xc365, productName: "X68HE" };
let ANSI = [];
const sent = [];
const dev = {
  product: "",
  keymap: { 0x80: new Uint8Array(528), 0x82: new Uint8Array(528) },
  triggers: new Map(),
  deadband: new Uint8Array(264),
  socd: { on: 1, list: [[1, 0, 4, 7]] },
  adv: new Map(),
  light: [2, 3, 2, 255, 0, 0, 0, 0, 0, 1, 1, 0, 0],
  poll: 1,
  answerProfile: false,
};
/** Resets the simulated keyboard to a new model: the matrix indices that answer a per-key read. */
function reset(product, usb, indices) {
  dev.product = product;
  dev.triggers = new Map(indices.map((i) => [i, { mode: 0, travel: 150, press: 50, release: 50 }]));
  dev.keymap = { 0x80: new Uint8Array(528), 0x82: new Uint8Array(528) };
  dev.deadband = new Uint8Array(264);
  dev.adv = new Map();
  USB = usb;
  KEY = `${usb.vendorId.toString(16).padStart(4, "0")}:${usb.productId.toString(16).padStart(4, "0")}:1:`;
  sent.length = 0;
}

const listeners = new Map();
const emit = (data) => {
  const f = new Uint8Array(63);
  f.set(data.slice(0, 63));
  for (const cb of listeners.get("hid-input") ?? []) setTimeout(() => cb({ payload: { key: KEY, reportId: 1, usagePage: 0xff1b, usage: 0x91, data: Array.from(f) } }), 1);
};
const page = (cmd, sub, p, payload) => [cmd, sub, (p >> 8) & 255, p & 255, payload.length, ...payload];

function handle(f) {
  const [c, b1, , b3, b4, b5, b6, b7] = f;
  // The simulated firmware refuses to exist if a blocked command ever arrives.
  if (c === 0x0b || c === 0x23 || (c === 0x14 && (b1 === 2 || b1 === 3 || f[5] !== 0)) || (c === 0x21 && [6, 7, 8, 15, 16].includes(b5)) || (c === 0x25 && b1 === 1))
    throw new Error(`BLOCKED FRAME REACHED THE DEVICE: ${Array.from(f.slice(0, 8))}`);
  switch (c) {
    case 0x01: {
      const s = new Array(18).fill(0);
      s[0] = 1; s[9] = 1; s[12] = 0x18; s[13] = 0x01;
      return emit([1, 0, 0, 0, 0, ...s]);
    }
    case 0x0d: {
      const text = `0,0,0,0,${dev.product},V1_0_7`;
      emit(page(0x0d, 0, 0, Array.from(text, (ch) => ch.charCodeAt(0))));
      return emit(page(0x0d, 0, 1, []));
    }
    case 0x15:
      return emit(page(0x15, 0, 0, Array.from("SN123456", (ch) => ch.charCodeAt(0))));
    case 0x0e:
      return emit(page(0x0e, 0, 0, new Array(22).fill(0x3f)));
    case 0x0a:
      return emit(page(0x0a, 0, 0, [0, 1, 2, 3, 4, 7, 8, 10, 0, 0, 4, 4]));
    case 0x07:
      if (b1 === 1) return emit(page(0x07, 1, 0, dev.light));
      dev.light = Array.from(f.slice(5, 18));
      return;
    case 0x18:
      if (b1 >= 0x80) {
        for (let p = 0; p < 10; p++) {
          const n = Math.min(14, 132 - p * 14);
          emit(page(0x18, b1, p, Array.from(dev.keymap[b1].slice(p * 56, p * 56 + n * 4))));
        }
        return;
      }
      dev.keymap[b1 === 0 ? 0x80 : 0x82].set(f.slice(5, 5 + b4), b3 * 56);
      return emit([0x18, b1]);
    case 0x19:
      return emit(page(0x19, b1, 0, []));
    case 0x22:
      if (b1 === 0x80) {
        for (let s = 0; s < 40; s++) {
          const p = dev.adv.get(s) ?? new Uint8Array([0x22, 0x80, 0, s, 50]);
          const r = new Uint8Array(63);
          r.set(p);
          r[1] = 0x80; r[3] = s;
          emit(Array.from(r));
        }
        return;
      }
      if (f[5]) dev.adv.set(b1, new Uint8Array(f));
      else dev.adv.delete(b1);
      return;
    case 0x24:
      if (b1 === 1) {
        for (let p = 0; p < 2; p++) {
          const body = [];
          for (let i = 0; i < 10; i++) body.push(...(dev.socd.list[p * 10 + i] ?? [7, 255, 255, 255]));
          emit(page(0x24, 1, p, body));
        }
        return;
      }
      if (b1 === 2) return emit(page(0x24, 2, 0, [dev.socd.on, 0, 0, 0, 4, 7]));
      if (b1 === 3) return void (dev.socd.on = f[5]);
      for (let i = 0; i < 10; i++) {
        const e = Array.from(f.slice(5 + i * 4, 9 + i * 4));
        dev.socd.list[b3 * 10 + i] = e[0] ? e : undefined;
      }
      dev.socd.list = dev.socd.list.filter(Boolean);
      return emit([0x24, 0]);
    case 0x26:
      if (b1 === 0) {
        for (let p = 0; p < 5; p++) emit(page(0x26, 0, p, Array.from(dev.deadband.slice(p * 58, Math.min(264, p * 58 + 58)))));
        return;
      }
      dev.deadband.set(f.slice(5, 5 + b4), b3 * 58);
      return emit([0x26, 1]);
    case 0x21: {
      if (b5 === 0x11) return dev.answerProfile ? emit([0x21, 0, 0, 0, 0, 0x11, 0, 1]) : undefined;
      if (b5 === 0x04) return emit([0x21, 0, 0, 0, 24, 4, 0x90, 10, 10, 1, 10]);
      if (b5 === 0x05) {
        const i = b6 * 22 + b7;
        const t = dev.triggers.get(i);
        if (!t) return;
        return emit([0x21, 0, 0, 0, 24, 5, t.mode, t.travel & 255, t.travel & 255, t.press & 255, t.release & 255, t.travel >> 8, t.travel >> 8, t.press >> 8, t.release >> 8, b6, b7]);
      }
      if (b5 === 0x09) {
        if (b4 === 1) return emit([0x21, 0, 0, 0, 1, 9, dev.poll]);
        dev.poll = b7;
        return;
      }
      if (b4 === 24 && [0, 12, 13].includes(b5)) {
        const travel = f[28] | (f[32] << 8), press = f[30] | (f[34] << 8), release = f[31] | (f[35] << 8);
        for (let col = 0; col < 22; col++) for (let row = 0; row < 6; row++) if ((f[6 + col] >> row) & 1) {
          const i = row * 22 + col;
          if (dev.triggers.has(i)) dev.triggers.set(i, { mode: b5, travel, press, release });
        }
      }
      return;
    }
    default:
      return;
  }
}

const files = new Map();
const store = {};
globalThis.window = globalThis;
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = String(v)) };
globalThis.__tauri = {
  async invoke(cmd, args) {
    switch (cmd) {
      case "hid_list":
        return [{ key: KEY, ...USB, collections: [{ usagePage: 0xff1b, usage: 0x91 }] }];
      case "devices_list":
        return [{ kind: "keyboard", name: "HE keyboard", vid: USB.vendorId.toString(16).padStart(4, "0"), pid: USB.productId.toString(16).padStart(4, "0"), collections: [{ usagePage: 1, usage: 6, interface: 0 }, { usagePage: 0xff1b, usage: 0x91, interface: 1 }] }];
      case "hid_open":
      case "hid_close":
        return null;
      case "hid_send_report_to":
        assert.equal(args.usagePage, 0xff1b);
        assert.equal(args.usage, 0x91);
        assert.equal(args.reportId, 1);
        assert.equal(args.data.length, 63);
        sent.push(Uint8Array.from(args.data));
        handle(Uint8Array.from(args.data));
        return null;
      case "keyboard_log":
        files.set(`${args.serial}-hid-log.txt`, [...(files.get(`${args.serial}-hid-log.txt`) ?? []), ...args.lines]);
        return null;
      case "keyboard_state_load":
        return files.get(`${args.serial}.json`) ?? null;
      case "keyboard_state_save":
        files.set(`${args.serial}.json`, args.json);
        return null;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  },
  async listen(ev, cb) {
    const l = listeners.get(ev) ?? [];
    l.push(cb);
    listeners.set(ev, l);
    return () => listeners.set(ev, (listeners.get(ev) ?? []).filter((x) => x !== cb));
  },
};

const { connectX68 } = await import(pathToFileURL(out).href);
const { ILLUMIPC_BOARDS, ILLUMIPC_LAYOUTS } = await import(pathToFileURL(path.join(root, "src/lib/illumipc/catalog.generated.ts")).href);
const { ILLUMIPC_USB_IDS } = await import(pathToFileURL(path.join(root, "src/lib/illumipc/ids.ts")).href);
const board = (code) => ILLUMIPC_BOARDS.find((b) => b.product === code);
const FALLBACK = ILLUMIPC_BOARDS.find((b) => b.layoutFrom);
const layoutOf = (code) => ILLUMIPC_LAYOUTS[board(code).layout];
const normal = (code) => layoutOf(code).keys.filter((k) => k[6] === 0).map((k) => k[0]);
const locked = (code) => layoutOf(code).keys.filter((k) => k[6] !== 0).map((k) => k[0]);
const perKeyReads = () => sent.filter((f) => f[0] === 0x21 && f[5] === 0x05).map((f) => f[6] * 22 + f[7]);
const writeFrames = () =>
  sent.filter(
    (f) =>
      (f[0] === 0x21 && ![0x04, 0x05, 0x11].includes(f[5]) && !(f[5] === 0x09 && f[4] === 1)) || // trigger writes, poll rate, profile switch
      (f[0] === 0x18 && f[1] < 0x80) || // keymap pages
      (f[0] === 0x22 && f[1] < 0x80) || // an advanced-key slot
      (f[0] === 0x26 && f[1] === 1) || // dead zones
      (f[0] === 0x24 && f[1] !== 1 && f[1] !== 2) || // SOCD table / switch
      (f[0] === 0x07 && f[1] !== 1), // lighting
  );

/** The 67 keys of the X68 HE's ANSI matrix that answer a per-key read (every key but Fn). */
const ANSI_IDX = [22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 36, 38, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 58, 60, 66, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 80, 82, 88, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 101, 103, 104, 110, 111, 112, 116, 119, 122, 124, 125, 126];

async function connect(code, usb, expectations, indices) {
  const idx = indices ?? normal(code);
  reset(code, usb, idx);
  const s = await connectX68();
  assert.ok(s, `${code}: a session`);
  const st = s.view.state;
  for (const [k, v] of Object.entries(expectations)) assert.deepEqual(k.split(".").reduce((o, p) => o[p], st), v, `${code}: ${k}`);
  return { s, idx };
}

// ---- A Redragon K673 on 2E3C:C365: named by the catalogue, its own 82-key layout, every key answers
{
  const code = "7272USHEXYXK673JCARGB";
  const { s, idx } = await connect(code, { vendorId: 0x2e3c, productId: 0xc365, productName: "K673" }, {
    "info.brand": "Redragon",
    "info.model": "K673WB-RGB-M",
    "info.name": "Redragon K673WB-RGB-M",
    "info.x68": false,
    "info.usbId": "2e3c:c365",
    "layoutKnown": true,
  });
  const v = s.view;
  assert.ok(v.state.layout.id.startsWith("catalog-"));
  assert.equal(v.state.layout.usType, true);
  assert.equal(v.state.layout.keys.length, layoutOf(code).keys.length);
  assert.equal(Object.keys(v.state.keys).length, idx.length, "every key that isn't locked answered");
  assert.equal(v.readOnlyReason, null);
  assert.equal(v.writable, true);
  assert.equal(v.writesEnabled, false, "changes start switched off");
  // The Fn key (and any knob or G key) is drawn locked and never read.
  assert.ok(v.state.layout.keys.some((k) => k.locked && k.label === "Fn"));
  assert.deepEqual(perKeyReads().filter((i) => locked(code).includes(i)), [], "no read of a locked key");
  assert.equal(writeFrames().length, 0, "no writes while reading");
  // Writes: refused until allowed, then confirmed per key; a locked key can't be remapped.
  await assert.rejects(s.setTriggers("x", [{ index: idx[3], mode: 0, travel: 100, press: 50, release: 50 }]), /switched off/);
  s.setWritesEnabled(true);
  const a = idx[3];
  const b = idx[9];
  const msg = await s.setTriggers("RT", [a, b].map((index) => ({ index, mode: 13, travel: 120, press: 15, release: 20 })));
  assert.match(msg, /Confirmed on 2 keys/);
  assert.deepEqual(dev.triggers.get(a), { mode: 13, travel: 120, press: 15, release: 20 });
  assert.equal(dev.triggers.get(idx[4]).mode, 0, "other keys untouched");
  const lockedIndex = locked(code)[0];
  await assert.rejects(s.setKeymap("fn", "default", [{ index: lockedIndex, action: [0, 4, 0, 0] }]), /can't be changed/);
  assert.deepEqual(perKeyReads().filter((i) => locked(code).includes(i)), [], "...and still never read");
  const keymapWrites = sent.filter((f) => f[0] === 0x18 && f[1] < 0x80);
  assert.equal(keymapWrites.length, 0);
  await s.close();
}

// ---- A Redragon M82 on Winbond's 0416:7372: found, named, written like the rest
{
  const code = "7272USXYXNHJHERGB";
  const { s, idx } = await connect(code, { vendorId: 0x0416, productId: 0x7372, productName: "M82" }, {
    "info.brand": "Redragon",
    "info.model": "M82",
    "info.usbId": "0416:7372",
  });
  assert.equal(s.view.readOnlyReason, null);
  assert.equal(Object.keys(s.view.state.keys).length, idx.length);
  s.setWritesEnabled(true);
  const msg = await s.setTriggers("A", [{ index: idx[5], mode: 0, travel: 90, press: 50, release: 50 }]);
  assert.match(msg, /Confirmed on 1 key/);
  assert.equal(dev.triggers.get(idx[5]).travel, 90);
  await s.close();
}

// ---- Epomaker HE60 Lite: illumipc has no layout file for it and uses SI2828HEARGB's; the catalogue says so
{
  const b = FALLBACK;
  assert.equal(b.product, "K1USliteBYHEARGB");
  assert.equal(b.layoutFrom, "SI2828HEARGB");
  const { s } = await connect(b.product, { vendorId: 0x2e3c, productId: 0xc365, productName: "HE60 Lite" }, { "info.brand": "Epomaker", "info.model": "HE60 Lite", "info.name": "Epomaker HE60 Lite" });
  assert.equal(s.view.readOnlyReason, null);
  await s.close();
}

// ---- Womier M68HE PRO and Epomaker HE30 (a gamepad-mode id)
{
  const w = await connect("KF068USHEARGB", { vendorId: 0x2e3c, productId: 0xc365, productName: "M68HE PRO" }, { "info.brand": "Womier", "info.model": "M68HE PRO" });
  assert.equal(w.s.view.readOnlyReason, null);
  assert.equal(w.s.view.state.layout.keys.filter((k) => !k.locked).length, normal("KF068USHEARGB").length);
  await w.s.close();
  const h = await connect("SOLO30QMHMHEARGB", { vendorId: 0x2e3c, productId: 0xc367, productName: "HE30" }, { "info.brand": "Epomaker", "info.model": "HE30", "info.usbId": "2e3c:c367" });
  assert.equal(h.s.view.readOnlyReason, null);
  await h.s.close();
}

// ---- A product code nobody listed: read, never written
{
  const { s } = await connect("ZZ0001", { vendorId: 0x2e3c, productId: 0xc365, productName: "Some HE board" }, { "info.brand": "", "info.name": "HE keyboard (ZZ0001)", "info.x68": false }, ANSI_IDX);
  const v = s.view;
  assert.equal(v.writable, false);
  assert.match(v.readOnlyReason, /no layout for/);
  s.setWritesEnabled(true);
  const before = sent.length;
  await assert.rejects(s.setTriggers("x", [{ index: 68, mode: 0, travel: 100, press: 50, release: 50 }]));
  assert.equal(writeFrames().length, 0);
  assert.equal(sent.length, before, "nothing went out");
  await s.close();
}

// ---- The X68 family keeps its name whatever AK168x code it reports
{
  const { s } = await connect("AK1680GUSXX68HEARGB", { vendorId: 0x2e3c, productId: 0xc365, productName: "X68HE" }, { "info.brand": "MAGIC-REFINER", "info.model": "X68 HE", "info.x68": true }, ANSI_IDX);
  assert.equal(s.view.state.layout.id, "ansi");
  await s.close();
}

// ---- Every id the catalogue names is one the bridge opens
for (const b of ILLUMIPC_BOARDS) for (const [v, p] of b.ids) assert.ok(ILLUMIPC_USB_IDS.some(([iv, ip]) => iv === v && ip === p), `${b.product} ${v.toString(16)}:${p.toString(16)}`);

fs.unlinkSync(out);
console.log(`illumipc session sim: ok (${ILLUMIPC_BOARDS.length} boards in the catalogue)`);
process.exit(0);
