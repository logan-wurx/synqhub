// Gaming headsets (src/lib/headsets): the frames SYNQ builds, the allowlist (and its fixture, which the Rust guard
// in src-tauri/src/headsets.rs is held to), reading replies, and a session against simulated headsets of every family:
// reads always, changes only once allowed, a backup before the first, read back where the headset can say.
//   node --test scripts/headsets.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHANNELS, MODELS, findHeadset, percentFromVoltage, readReply, settingFrames, settingsOf, statusRequests, type Family, type Model } from "../src/lib/headsets/protocol.ts";
import { allowedFrames, checkHeadsetFrame } from "../src/lib/headsets/guard.ts";
import { HeadsetSession, type HeadsetStore } from "../src/lib/headsets/session.ts";
import { simulateHeadset } from "../src/lib/headsets/sim.ts";
import { fixtureLines } from "./headset-allowlist-fixture.ts";

const FAMILIES: Family[] = ["ss-nova7", "logi-g535", "logi-gpro", "logi-g633", "hyperx-cloud2w"];
const first = (f: Family) => MODELS.find((m) => m.family === f)!;

function memory(): HeadsetStore & { backups: string[]; saved: Record<string, unknown> } {
  const backups: string[] = [];
  const saved: Record<string, unknown> = {};
  return {
    backups,
    saved,
    async saveBackup(prefix, json) {
      backups.push(json);
      return `(memory) ${prefix}.json`;
    },
    async load(key) {
      return (saved[key] as Record<string, number>) ?? null;
    },
    async save(key, values) {
      saved[key] = values;
    },
  };
}

test("the table: 27 headsets in 5 families, each family with one vendor collection or a documented one", () => {
  assert.equal(MODELS.length, 27);
  assert.deepEqual([...new Set(MODELS.map((m) => m.family))].sort(), [...FAMILIES].sort());
  assert.equal(findHeadset(0x1038, 0x2202)?.name, "Arctis Nova 7");
  assert.equal(findHeadset("046D", "0AC4")?.family, "logi-g535");
  assert.equal(findHeadset(0x046d, 0xc0a0), null, "the DEX is a mouse");
  for (const f of FAMILIES) for (const [page] of CHANNELS[f].collections) assert.ok(page >= 0xff00 || (f === "logi-g535" && page === 0x000c), f);
});

test("headset-frames.txt is still what the guard says (regenerate with node scripts/headset-allowlist-fixture.ts)", () => {
  const file = readFileSync(new URL("../src/lib/headsets/headset-frames.txt", import.meta.url), "utf8").trim().split(/\r?\n/);
  assert.deepEqual(file, fixtureLines());
  assert.ok(file.filter((l) => l.startsWith("1")).length >= 100);
});

test("every frame SYNQ builds passes; values it doesn't offer build nothing", () => {
  for (const m of MODELS) {
    for (const f of statusRequests(m.family)) assert.equal(checkHeadsetFrame(m, f).what, "read", `${m.pid} read`);
    for (const s of settingsOf(m.family)) {
      for (const v of s.values) for (const f of settingFrames(m, s.id, v)!) assert.equal(checkHeadsetFrame(m, f).what, s.id, `${m.pid} ${s.id} ${v}`);
      assert.equal(settingFrames(m, s.id, 255), null);
    }
  }
  const nova = first("ss-nova7");
  assert.deepEqual(Array.from(settingFrames(nova, "sidetone", 2)![0].data.slice(0, 3)), [0x39, 2, 0]);
  assert.equal(settingFrames(nova, "sidetone", 2)!.length, 1, "no save on the first Nova 7");
  assert.equal(settingFrames(findHeadset(0x1038, 0x227e)!, "sidetone", 2)!.length, 2, "the Gen 2 saves");
  assert.deepEqual(Array.from(settingFrames(nova, "eqPreset", 1)![0].data.slice(0, 12)), [0x33, 23, 25, 24, 21, 18, 18, 19, 19, 19, 19, 0]);
  assert.equal(settingFrames(first("logi-g633"), "lights", 1)!.length, 2, "strips and logo");
  assert.equal(settingsOf("hyperx-cloud2w").length, 1);
});

test("the guard refuses what SYNQ doesn't build: other commands, values, report ids, lengths", () => {
  const nova = first("ss-nova7");
  const pad = (b: number[]) => {
    const d = new Uint8Array(63);
    d.set(b);
    return d;
  };
  assert.equal(checkHeadsetFrame(nova, { reportId: 0, data: pad([0x39, 4]) }).ok, false);
  assert.equal(checkHeadsetFrame(nova, { reportId: 0, data: pad([0xb2, 1]) }).ok, false, "Bluetooth-on-power isn't offered");
  assert.equal(checkHeadsetFrame(nova, { reportId: 6, data: pad([0x09]) }).ok, false);
  assert.equal(checkHeadsetFrame(nova, { reportId: 0, data: new Uint8Array(64) }).ok, false);
  assert.equal(checkHeadsetFrame(nova, { reportId: 0, data: Uint8Array.from([0xb0]) }).ok, true, "short data counts as zero-padded");
  assert.equal(allowedFrames(nova).size, 1 + 4 + 8 + 4 + 4 + 2);
});

test("Logitech batteries are a voltage on the maker's curve", () => {
  assert.equal(percentFromVoltage(4300, "g535"), 100);
  assert.equal(percentFromVoltage(3817, "g535"), 50);
  assert.equal(percentFromVoltage(3000, "g535"), 0);
  assert.equal(percentFromVoltage(3900, "g633"), 70);
});

test("replies read per family", () => {
  const nova = first("ss-nova7");
  const s0 = { connected: false, battery: null, charging: null };
  const r = (bytes: number[]) => Uint8Array.from([...bytes, ...new Array(63 - bytes.length).fill(0)]);
  assert.deepEqual(readReply(nova, 0, r([0xb0, 0, 3, 0x03, 80, 100]), s0), { connected: true, battery: 75, charging: false, chatmix: { game: 80, chat: 100 } });
  assert.equal(readReply(nova, 0, r([0xb0, 0, 3, 0x00]), s0)?.connected, false);
  assert.equal(readReply(findHeadset(0x1038, 0x22a1)!, 0, r([0xb0, 0, 64, 0x01, 0, 0]), s0)?.battery, 64);
  assert.equal(readReply(nova, 0, r([0x39, 1]), s0), null, "not a status reply");
  const g535 = first("logi-g535");
  const logi = readReply(g535, 0x11, Uint8Array.from([0xff, 0x05, 0x0d, 3817 >> 8, 3817 & 0xff, 0x03]), s0)!;
  assert.deepEqual([logi.battery, logi.charging, logi.estimated], [50, true, true]);
  assert.equal(readReply(g535, 0x11, Uint8Array.from([0xff, 0xff, 0x05, 0x0d, 0x05]), s0)?.connected, false);
  const hx = first("hyperx-cloud2w");
  assert.equal(readReply(hx, 6, Uint8Array.from([0xff, 0xbb, 0x02, 0, 0x0f, 0x8c, 88]), s0)?.battery, 88);
  assert.equal(readReply(hx, 6, Uint8Array.from([0xff, 0xbb, 0x07, 30]), s0)?.autoOff, 30);
});

for (const family of FAMILIES) {
  test(`session (${family}): reads, refuses changes until allowed, backs up first, never sends a refused frame`, async () => {
    const model: Model = family === "ss-nova7" ? findHeadset(0x1038, 0x227e)! : first(family);
    const sim = simulateHeadset(model);
    const store = memory();
    const s = new HeadsetSession(sim, model, store);
    await s.open();
    const st = await s.refresh();
    assert.equal(st.connected, true);
    assert.ok(st.battery !== null && st.battery > 50 && st.battery <= 100, `battery ${st.battery}`);
    const setting = settingsOf(family)[0];
    const value = setting.values[1];
    const before = sim.sent.length;
    await assert.rejects(() => s.set(setting.id, value), /until you allow them/);
    assert.equal(sim.sent.length, before, "nothing sent before allowing");
    s.setAllowChanges(true);
    await assert.rejects(() => s.set(setting.id, 77), /isn't one SYNQ offers/);
    const r = await s.set(setting.id, value);
    assert.equal(store.backups.length, 1, "backed up before the first change");
    assert.equal(sim.held[setting.id], value);
    assert.equal(s.values[setting.id], value);
    assert.equal(r.confirmed, family === "hyperx-cloud2w", "only HyperX's auto-off reads back");
    assert.deepEqual(sim.forbidden, []);
    sim.connected = false;
    if (family !== "hyperx-cloud2w") assert.equal((await s.refresh()).connected, false);
    await s.close();
  });
}
