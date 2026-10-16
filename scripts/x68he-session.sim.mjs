// Headless end-to-end check of src/lib/x68he.ts against a simulated X68 HE that answers the way
// illumipc's code expects (no hardware, no window, no Tauri). Bundles the session with the
// project's rolldown, swapping @tauri-apps/api and ./backend for in-memory mocks.
// Run: node scripts/x68he-session.sim.mjs
import { rolldown } from "rolldown";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(os.tmpdir(), `x68he-sim-${process.pid}.mjs`);

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
const KEY = "2e3c:c365:1:";
const ANSI = [22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 36, 38, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 58, 60, 66, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 80, 82, 88, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 101, 103, 104, 110, 111, 112, 116, 119, 121, 122, 124, 125, 126];
const sent = [];
const dev = {
  product: "AK1680GUSXX68HEARGB",
  keymap: { 0x80: new Uint8Array(528), 0x82: new Uint8Array(528) },
  triggers: new Map(ANSI.map((i) => [i, { mode: 0, travel: 150, press: 50, release: 50 }])),
  deadband: new Uint8Array(264),
  socd: { on: 1, list: [[1, 0, 4, 7]] },
  adv: new Map(),
  light: [2, 3, 2, 255, 0, 0, 0, 0, 0, 1, 1, 0, 0],
  poll: 1,
  answerProfile: false,
};
dev.keymap[0x80].set([0, 0x04, 0, 0], 68 * 4);
dev.keymap[0x80].set([1, 0xfa, 0, 0], 121 * 4);
dev.adv.set(0, new Uint8Array([0x22, 0x80, 0, 0, 50, 2, 0, 0xe0, 0, 0, 0, 0x29, 0, 0, 15]));

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
        return [{ key: KEY, vendorId: 0x2e3c, productId: 0xc365, productName: "X68HE", collections: [{ usagePage: 0xff1b, usage: 0x91 }] }];
      case "devices_list":
        return [{ kind: "keyboard", name: "MAGIC-REFINER X68 HE", vid: "2e3c", pid: "c365", collections: [{ usagePage: 1, usage: 6, interface: 0 }, { usagePage: 0xff1b, usage: 0x91, interface: 1 }] }];
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
const steps = [];
const t0 = Date.now();
const s = await connectX68((step) => steps.push(step));
assert.ok(s, "session");
let v = s.view;
console.log(`read everything in ${Date.now() - t0} ms, ${sent.length} requests, steps: ${[...new Set(steps)].length}`);
assert.equal(v.state.info.product, dev.product);
assert.equal(v.state.info.firmware, "1.0.7");
assert.equal(v.state.layout.id, "ansi");
assert.equal(v.state.trigger.unitMm, 0.01);
assert.equal(Object.keys(v.state.keys).length, 67, "every key but Fn");
assert.deepEqual(v.state.socd.entries, [{ index: 0, state: 1, mode: 0, key1: 4, key2: 7 }]);
assert.equal(v.state.advanced[0].type, "MT");
assert.equal(v.state.profile, null);
assert.equal(v.writable, true, v.readOnlyReason);
assert.equal(v.writesEnabled, false, "changes start switched off");
assert.equal(sent.filter((f) => [0x07, 0x18, 0x22, 0x24, 0x26].includes(f[0]) && f[1] < 0x80 && !(f[0] === 0x07 && f[1] === 1) && !(f[0] === 0x24 && (f[1] === 1 || f[1] === 2)) && !(f[0] === 0x26 && f[1] === 0) && !(f[0] === 0x18 && f[1] >= 0x80)).length, 0, "no writes while reading");
assert.equal(files.size, 1, "only the log so far: no backup before a write");

// Writes refused until allowed.
await assert.rejects(s.setTriggers("x", [{ index: 68, mode: 0, travel: 100, press: 50, release: 50 }]), /switched off/);
s.setWritesEnabled(true);

// Per-key rapid trigger on A and D, then read back.
const before = sent.length;
const msg = await s.setTriggers("RT on A/D", [68, 70].map((index) => ({ index, mode: 13, travel: 120, press: 15, release: 20 })));
console.log("triggers:", msg);
const backups = [...files.keys()].filter((k) => k.includes("backup") || k.includes("original"));
assert.equal(backups.length, 2, "original + session backup saved before the first write");
const firstWrite = sent.slice(before).findIndex((f) => f[0] === 0x21 && f[5] === 13);
assert.ok(firstWrite >= 0);
assert.deepEqual(dev.triggers.get(68), { mode: 13, travel: 120, press: 15, release: 20 });
assert.equal(s.view.state.keys[70].mode, 13);
await assert.rejects(s.setTriggers("bad", [{ index: 68, mode: 0, travel: 9999, press: 0, release: 0 }]), /Actuation must be between/);

// Remap Caps Lock (66) to Esc on the default layer, Fn layer F1 on '1'.
await s.setKeymap("caps", "default", [{ index: 66, action: [0, 0x29, 0, 0] }]);
assert.deepEqual(Array.from(dev.keymap[0x80].slice(66 * 4, 66 * 4 + 4)), [0, 0x29, 0, 0]);
await s.setKeymap("fn1", "fn", [{ index: 23, action: [0, 0x3a, 0, 0] }]);
assert.deepEqual(Array.from(dev.keymap[0x82].slice(23 * 4, 23 * 4 + 4)), [0, 0x3a, 0, 0]);
await assert.rejects(s.setKeymap("fn", "default", [{ index: 121, action: [0, 4, 0, 0] }]), /can't be changed/);

// SOCD: add W/S as neutral, keep A/D.
await s.setSocd("socd", [...s.view.state.socd.entries, { index: 1, mode: 3, key1: 0x1a, key2: 0x16 }], true);
assert.deepEqual(dev.socd.list, [[1, 0, 4, 7], [1, 3, 0x1a, 0x16]]);

// Advanced: add a toggle on G (72), bound on the default layer.
const adv = [...s.view.state.advanced, { slot: 1, type: "TGL", actions: [[0, 0x0a, 0, 0]] }];
await s.setAdvanced("tgl", adv, [{ layer: "default", index: 72, action: [0x17, 1, 1, 0] }]);
assert.equal(dev.adv.get(1)[5], 3);
assert.deepEqual(Array.from(dev.keymap[0x80].slice(72 * 4, 72 * 4 + 4)), [0x17, 1, 1, 0]);

// Lighting, dead zones, polling.
await s.setLighting("light", { ...s.view.state.light.config, mode: 3, brightness: 4 });
assert.equal(dev.light[0], 3);
await s.setDeadbands("dz", [{ index: 68, top: 10, bottom: 5 }]);
assert.deepEqual([dev.deadband[136], dev.deadband[137]], [10, 5]);
await s.setPollRate(8000);
assert.equal(dev.poll, 8);
await assert.rejects(s.setProfile(1), /doesn't keep profiles/);

// Diagnostics: read-only.
const writesBefore = sent.length;
const diag = await s.exportDiagnostics();
assert.equal(sent.length, writesBefore, "diagnostics sends nothing");
const diagFile = [...files.keys()].find((k) => k.includes("diag"));
const parsed = JSON.parse(files.get(diagFile));
assert.ok(parsed.collections.allDetected[0].collections.length === 2 && parsed.raw["keymap default"].length === 10);
console.log("diagnostics:", diag);

// Every frame that left passed the allowlist (the device mock throws otherwise); none were destructive.
const log = files.get(`${s.view.state.info.id}-hid-log.txt`);
assert.ok(log.some((l) => l.includes("write 21 00 00 00 18 0d")), "log has the trigger write");
await s.close();
fs.unlinkSync(out);
// X68_SIM_LOG=<path> keeps the simulated HID log (same format the friend's run will produce).
if (process.env.X68_SIM_LOG) fs.writeFileSync(process.env.X68_SIM_LOG, log.join("\n"));
console.log(`ok: ${sent.length} frames, ${log.length} log lines, files: ${[...files.keys()].join(", ")}`);
process.exit(0);
