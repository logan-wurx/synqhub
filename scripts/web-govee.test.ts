// Govee lamps on the website (src/lib/lighting/web), held to the desktop bridge: the ciphers give the answers in
// cipher-vectors.txt and the session says and hears the bytes in session-wire.txt (both written and checked by the
// bridge's own tests in src-tauri/src/lighting/govee), every line of the bridge guard's fixture (frames.txt) gets the
// same verdict through the website's gate, and the whole link runs against a pretend Web Bluetooth lamp that speaks
// each encryption. No Bluetooth, no browser, no real lamp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { a3Frames, frame, powerFrame, queryFrame, xorOf, CMD, FRAME_LEN, UPLOAD, type UploadKind } from "../src/lib/lighting/govee/frames.ts";
import { sceneBlob, scenesFor } from "../src/lib/lighting/govee/scenes.generated.ts";
import { specOf } from "../src/lib/lighting/govee/spec.ts";
import { LampController } from "../src/lib/lighting/lamp.ts";
import { K_COMM, K_DEV, K_HS, aesEcb, deviceKey, gcmOpen, gcmSeal, rc4, safe } from "../src/lib/lighting/web/cipher.ts";
import { GoveeSession, Inbox, type GoveeWire, type Scheme } from "../src/lib/lighting/web/session.ts";
import { GoveeGate, PREFIXES, modelOf, skuOf, type GatePace } from "../src/lib/lighting/web/guard.ts";
import { GattWire, MARKER, NOTIFY, SERVICE, WRITE, type BtDevice, type BtRequest, type WebBluetooth } from "../src/lib/lighting/web/bluetooth.ts";
import { WEB_FORGETS, WEB_NO_SYNC, forgetWebLamps, openWebLamp, pickLamp, webLamps, type WebLampDeps } from "../src/lib/lighting/web/link.ts";
import { GOVEE_FRAMES } from "./govee-fixtures.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
const GOVEE_RS = "src-tauri/src/lighting/govee";
const hex = (b: ArrayLike<number>) => (b.length ? Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("") : "-");
const bytes = (h: string) => (h === "-" ? new Uint8Array(0) : Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)));
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const cat = (...parts: ArrayLike<number>[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(5);
  return cond();
}
/** The padding and nonces session.rs's tests use: 37, 74, 111, … */
function counter(): () => number {
  let n = 0;
  return () => (n = (n + 37) & 0xff);
}
const QUICK: GatePace = { gapMs: 0, uploadGapMs: 0, ackMs: 300 };

test("the ciphers give the bridge's answers, byte for byte (cipher-vectors.txt)", () => {
  const lines = text(`${GOVEE_RS}/cipher-vectors.txt`).split("\n").filter(Boolean);
  const kinds = new Map<string, number>();
  for (const line of lines) {
    const [kind, ...f] = line.split(" ");
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    if (kind === "aes") {
      assert.equal(hex(aesEcb(bytes(f[0]), bytes(f[1]), false)), f[2], line);
      assert.equal(hex(aesEcb(bytes(f[0]), bytes(f[2]), true)), f[1], line);
    } else if (kind === "rc4") assert.equal(hex(rc4(bytes(f[0]), 40)), f[1], line);
    else if (kind === "safe") {
      assert.equal(hex(safe(bytes(f[0]), bytes(f[1]), false)), f[2], line);
      assert.equal(hex(safe(bytes(f[0]), bytes(f[2]), true)), f[1], line);
    } else if (kind === "gcm") {
      const [k, nonce, aad, plain, sealed, tag] = f.map(bytes);
      const out = gcmSeal(k, nonce, aad, plain);
      assert.equal(hex(out.sealed), f[4], line);
      assert.equal(hex(out.tag), f[5], line);
      assert.equal(hex(gcmOpen(k, nonce, aad, sealed, tag) ?? []), f[3], line);
      const bad = tag.slice();
      bad[0] ^= 1;
      assert.equal(gcmOpen(k, nonce, aad, sealed, bad), null, "a wrong tag never opens");
    } else if (kind === "devkey") assert.equal(hex(deviceKey(bytes(f[0]), bytes(f[1]))), f[2], line);
    else assert.fail(`unknown line ${line}`);
  }
  // Every v1 length from 0 to 40 bytes (no block, one, two, every tail), and each other kind.
  assert.deepEqual(Object.fromEntries(kinds), { aes: 8, rc4: 5, safe: 41, gcm: 7, devkey: 4 });
});

test("the keys are the bridge's (cipher.rs)", () => {
  const rs = text(`${GOVEE_RS}/cipher.rs`);
  const key = (name: string) => {
    const m = new RegExp(`pub const ${name}: \\[u8; 16\\] = \\[([^\\]]+)\\]`).exec(rs);
    return m ? Uint8Array.from(m[1].split(",").map((x) => parseInt(x.trim(), 16))) : null;
  };
  assert.match(rs, /pub const K_COMM: \[u8; 16\] = \*b"MakingLifeSmarte";/);
  assert.equal(hex(K_COMM), hex(ascii("MakingLifeSmarte")));
  assert.equal(hex(K_HS), hex(key("K_HS")!));
  assert.equal(hex(K_DEV), hex(key("K_DEV")!));
  // The published vectors cipher.rs checks too: FIPS-197 C.1, RC4 "Key", GCM test case 2.
  assert.equal(hex(aesEcb(bytes("000102030405060708090a0b0c0d0e0f"), bytes("00112233445566778899aabbccddeeff"), false)), "69c4e0d86a7b0430d8cdb78070b4c55a");
  assert.equal(hex(rc4(ascii("Key"), 10)), "eb9f7781b734ca72a719");
  const g = gcmSeal(new Uint8Array(16), new Uint8Array(12), new Uint8Array(0), new Uint8Array(16));
  assert.equal(hex(g.sealed) + hex(g.tag), "0388dace60b6a392f328c2b971b2fe78ab6e47d42cec13bdf53a67b21257bddf");
  // The developer's H6076, 2026-10-15: the captured v1 handshake reply decrypts under K_COMM.
  const reply = safe(K_COMM, bytes("9833f1e38a735dfb5b9e1072c5c6e6d807784011"), true);
  assert.equal(hex(reply.subarray(0, 4)), "e701c2ed");
  assert.equal(xorOf(reply, 19), reply[19]);
});

// The simulated lamp of session.rs's tests, line for line: it speaks plaintext, v1 or v2 as told, answers the
// handshakes, queries and commands like the real one, and records every plaintext frame it accepted.
const SIM_SESSION = ascii("0123456789abcdef");
const SIM_SKU = ascii("H6076");
const SIM_MAC = Uint8Array.from([0x0c, 0x34, 0x46, 0x80, 0x50, 0xd6]);
const DEV_IV = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]);
const ctrBytes = (n: number) => Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const valid = (p: Uint8Array | null): p is Uint8Array => !!p && p.length === FRAME_LEN && xorOf(p, 19) === p[19];

type SimKeys = { kind: "v1"; key: Uint8Array } | { kind: "v2"; key: Uint8Array; hostIv: Uint8Array };

class SimLamp {
  readonly scheme: Scheme;
  readonly accepted: Uint8Array[] = [];
  power = true;
  keys: SimKeys | null = null;
  devCtr = 1;
  /** Where the lamp's notifications go. */
  out: (wire: Uint8Array) => void = () => {};

  constructor(scheme: Scheme) {
    this.scheme = scheme;
  }
  get marker() {
    return this.scheme === "v2" ? 2 : null;
  }
  notify(plain: Uint8Array) {
    const k = this.keys;
    if (!k) return this.out(plain);
    if (k.kind === "v1") return this.out(safe(k.key, plain, false));
    const c = ctrBytes(this.devCtr++);
    const { sealed, tag } = gcmSeal(k.key, cat(DEV_IV, c), c, plain);
    this.out(cat(c, sealed, tag));
  }
  command(p: Uint8Array) {
    this.accepted.push(p);
    if (p[0] === 0xaa && p[1] === 0x01) this.notify(frame([0xaa, 0x01, this.power ? 1 : 0]));
    else if (p[0] === 0xaa && p[1] === 0x06) this.notify(frame([0xaa, 0x06, ...ascii("1.04.05")]));
    else if (p[0] === 0x33 && p[1] === 0x01) {
      this.power = p[2] === 1;
      this.notify(frame([0x33, 0x01, 0x00]));
      this.notify(frame([0xee, 0x30, 0x01, p[2]]));
    } else if (p[0] === 0x33) this.notify(frame([0x33, p[1]]));
  }
  unseal(wire: Uint8Array): Uint8Array | null {
    const k = this.keys;
    let plain: Uint8Array | null = null;
    if (this.scheme === "plain") plain = wire;
    else if (this.scheme === "v1" && k?.kind === "v1") plain = safe(k.key, wire, true);
    else if (this.scheme === "v2" && k?.kind === "v2" && wire.length === 40)
      plain = gcmOpen(k.key, cat(k.hostIv, wire.subarray(0, 4)), wire.subarray(0, 4), wire.subarray(4, 24), wire.subarray(24));
    return valid(plain) ? plain : null;
  }
  handshake(wire: Uint8Array): boolean {
    if (this.scheme === "v1") {
      const p = safe(K_COMM, wire, true);
      if (!(valid(p) && p[0] === 0xe7)) return false;
      let reply: Uint8Array;
      if (p[1] === 0x01) reply = frame([0xe7, 0x01, ...SIM_SESSION]);
      else {
        this.keys = { kind: "v1", key: SIM_SESSION };
        reply = frame([0xe7, 0x02]);
      }
      this.out(safe(K_COMM, reply, false));
      return true;
    }
    if (this.scheme === "v2" && wire.length === 40 && wire[0] === 0xe7 && wire[1] === 0x11) {
      const iv = wire.slice(3, 15);
      const hostIv = gcmOpen(K_HS, iv, wire.subarray(0, 16), wire.subarray(16, 24), wire.subarray(24));
      if (!hostIv) throw new Error("bad handshake");
      const head = cat([0xe7, 0x11, 0x00], iv);
      const { sealed, tag } = gcmSeal(K_HS, iv, head, cat(DEV_IV, SIM_SKU, SIM_MAC));
      this.keys = { kind: "v2", key: deviceKey(SIM_SKU, SIM_MAC), hostIv };
      this.out(cat(head, sealed, tag));
      return true;
    }
    return false;
  }
  write(wire: Uint8Array) {
    if (this.handshake(wire)) return;
    const p = this.unseal(wire);
    if (p) this.command(p);
  }
}

/** The bridge's test link: every value written (`>`) and every notification read (`<`), in order. */
function recorded(lamp: SimLamp, log: string[]): GoveeWire {
  const inbox = new Inbox();
  lamp.out = (w) => inbox.push(w);
  return {
    marker: lamp.marker,
    write: async (b) => {
      log.push(`> ${hex(b)}`);
      lamp.write(b);
    },
    recv: async (ms) => {
      const got = await inbox.recv(ms);
      if (got) log.push(`< ${hex(got)}`);
      return got;
    },
  };
}

test("each scheme's session writes and hears the bridge's bytes (session-wire.txt)", async () => {
  const want = text(`${GOVEE_RS}/session-wire.txt`).split("\n").filter(Boolean);
  const got: string[] = [];
  for (const scheme of ["v1", "v2", "plain"] as const) {
    const log: string[] = [];
    const lamp = new SimLamp(scheme);
    const s = await GoveeSession.start(recorded(lamp, log), null, counter());
    assert.equal(s.scheme, scheme);
    const script: [number[], number][] = [
      [[0x33, 0x01, 0x00], 2],
      [[0xaa, 0x01], 1],
      [[0x33, 0x04, 0x23], 1],
      [[0x33, 0x05, 0x15, 0x01, 0xff, 0x00, 0x2a, 0, 0, 0, 0, 0, 0xff, 0x3f], 1],
      [[0x33, 0x01, 0x01], 2],
    ];
    for (const [b, replies] of script) {
      await s.send(frame(b));
      for (let i = 0; i < replies; i++) assert.ok(await s.recv(200), `${scheme}: a reply to ${hex(b)}`);
    }
    assert.equal(lamp.power, true);
    if (scheme === "v2") assert.equal(s.sku, "H6076");
    got.push(...log.map((l) => `${scheme} ${l}`));
  }
  assert.deepEqual(got, want);
});

test("a cached scheme skips the probe, and a silent v1 lamp fails plainly (session.rs)", async () => {
  const quiet = new SimLamp("plain");
  const s = await GoveeSession.start(recorded(quiet, []), "plain", counter());
  assert.equal(s.scheme, "plain");
  assert.equal(quiet.accepted.length, 0);
  await assert.rejects(GoveeSession.start(recorded(new SimLamp("plain"), []), "v1", counter()), /handshake/);
});

test("every line of the bridge guard's fixture gets the same verdict through the website's gate (frames.txt)", async () => {
  let checked = 0;
  let allowed = 0;
  for (const line of readFileSync(GOVEE_FRAMES, "utf8").split(/\r?\n/).filter(Boolean)) {
    const parts = line.split(" ");
    const spec = specOf(parts[1]);
    assert.ok(spec, `unknown model in ${line}`);
    const written: string[] = [];
    const gate = new GoveeGate(spec, async (f) => void written.push(hex(f)), { gapMs: 0, uploadGapMs: 0, ackMs: 0 });
    let verdict: boolean;
    let ok: boolean;
    if (parts[0] === "frame") {
      verdict = parts[2] === "1";
      ok = await gate.send([bytes(parts[3])]).then(() => true, () => false);
      assert.deepEqual(written, ok ? [parts[3]] : [], line);
    } else {
      const kind = parts[0] as UploadKind;
      const [code, rest] = kind === "scene" ? [Number(parts[2]), parts.slice(3)] : [undefined, parts.slice(2)];
      verdict = rest[0] === "1";
      ok = await gate.upload(kind, bytes(rest[1]), code).then(() => true, () => false);
      // The frames the website writes for an upload are the ones the bridge builds (the fixture lists them).
      assert.deepEqual(written, ok ? rest.slice(2) : [], line);
    }
    assert.equal(ok, verdict, line);
    checked++;
    if (verdict) allowed++;
  }
  assert.ok(checked > 3000 && allowed > 400, `${checked} lines, ${allowed} allowed`);
});

test("the bytes checked are the bytes written, and a batch with one refused frame sends nothing", async () => {
  const written: Uint8Array[] = [];
  const gate = new GoveeGate(specOf("H6076")!, async (f) => void written.push(f), QUICK);
  const f = powerFrame(false);
  const sent = gate.send([f]);
  f[2] = 0x55;
  await sent;
  assert.equal(hex(written[0]), hex(powerFrame(false)));
  await assert.rejects(gate.send([powerFrame(true), frame([0xe7, 0x01])]), /handshake/);
  await assert.rejects(gate.send([frame([0xa3, 0x00, 0x01])]), /multi-packet/);
  assert.equal(written.length, 1);
});

test("the lamps the website opens and their GATT link are the bridge's (ble.rs, mod.rs)", () => {
  const ble = text(`${GOVEE_RS}/ble.rs`);
  const prefixes = /const PREFIXES: \[&str; \d+\] = \[([^\]]+)\];/.exec(ble)![1].split(",").map((s) => s.trim().replace(/"/g, ""));
  assert.deepEqual([...PREFIXES], prefixes);
  const uuid = (name: string) => {
    const h = new RegExp(`const ${name}: GUID = GUID::from_u128\\(0x([0-9a-f_]+)\\);`).exec(ble)![1].replace(/_/g, "");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  assert.deepEqual([SERVICE, WRITE, NOTIFY, MARKER], [uuid("SERVICE"), uuid("WRITE"), uuid("NOTIFY"), uuid("MARKER")]);
  // mod.rs `names_and_ids`.
  assert.equal(skuOf("Govee_H6076_7A21"), "H6076");
  assert.equal(skuOf("ihoment_H6199_ABCD"), "H6199");
  assert.equal(skuOf("Govee"), "");
  assert.ok(modelOf("Govee_H6076_7A21"));
  assert.ok(modelOf("ihoment_H6199_ABCD"));
  assert.equal(modelOf("GVH5075_1A2B"), null, "a thermometer is not a lamp");
  assert.equal(modelOf("Govee_H9999_0000"), null, "a model SYNQ doesn't drive");
  assert.equal(modelOf("Lamp_H6076_7A21"), null, "not a Govee name");
});

// A pretend Web Bluetooth lamp: the GATT service, characteristics and events Chrome gives a page, with the simulated
// lamp above behind them. Its A3 uploads are acknowledged as the real lamp does (a3 <type> 00).
class FakeChar extends EventTarget {
  value: DataView | null = null;
  readonly properties = { writeWithoutResponse: true };
  readonly onWrite: (b: Uint8Array) => void;
  readonly read: Uint8Array | null;
  notifying = false;
  constructor(onWrite: (b: Uint8Array) => void, read: Uint8Array | null = null) {
    super();
    this.onWrite = onWrite;
    this.read = read;
  }
  async readValue() {
    if (!this.read) throw new Error("NotSupportedError");
    return new DataView(this.read.slice().buffer);
  }
  async writeValueWithoutResponse(v: Uint8Array) {
    this.onWrite(v);
  }
  async writeValueWithResponse(v: Uint8Array) {
    this.onWrite(v);
  }
  async startNotifications() {
    this.notifying = true;
    return this;
  }
  async stopNotifications() {
    this.notifying = false;
    return this;
  }
  emit(wire: Uint8Array) {
    if (!this.notifying) return;
    this.value = new DataView(wire.slice().buffer);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

class UploadingLamp extends SimLamp {
  readonly a3: Uint8Array[] = [];
  #type = 0;
  command(p: Uint8Array) {
    if (p[0] !== 0xa3) return super.command(p);
    this.a3.push(p);
    // The first frame names the upload's type (a3 00 01 <count> <type> …); the last one (index FF) is answered.
    if (p[1] === 0x00) this.#type = p[4];
    if (p[1] === 0xff) this.notify(frame([0xa3, this.#type, 0x00]));
  }
}

class FakeDevice extends EventTarget implements BtDevice {
  readonly id: string;
  readonly name: string;
  readonly lamp: UploadingLamp;
  connects = 0;
  connected = false;
  readonly gatt: NonNullable<BtDevice["gatt"]>;
  constructor(id: string, name: string, lamp: UploadingLamp) {
    super();
    this.id = id;
    this.name = name;
    this.lamp = lamp;
    const notify = new FakeChar(() => {});
    const write = new FakeChar((b) => lamp.write(b));
    lamp.out = (w) => notify.emit(w);
    const chars: Record<string, FakeChar> = { [WRITE]: write, [NOTIFY]: notify };
    if (lamp.marker !== null) chars[MARKER] = new FakeChar(() => {}, Uint8Array.from([0x01, lamp.marker]));
    const device = this;
    this.gatt = {
      get connected() {
        return device.connected;
      },
      async connect() {
        device.connects++;
        device.connected = true;
        return {
          async getPrimaryService(uuid: string) {
            if (uuid !== SERVICE) throw new Error("NotFoundError");
            return {
              async getCharacteristic(c: string) {
                if (!chars[c]) throw new Error("NotFoundError");
                return chars[c];
              },
            };
          },
        };
      },
      disconnect() {
        device.connected = false;
      },
    };
  }
  /** The lamp switched off at the wall: the browser drops the connection. */
  drop() {
    this.connected = false;
    this.dispatchEvent(new Event("gattserverdisconnected"));
  }
}

const deps = (): WebLampDeps => ({ connect: (d) => GattWire.connect(d), random: counter(), pace: QUICK });

async function added(scheme: Scheme, id = `dev-${scheme}`, name = "Govee_H6076_7A21") {
  const device = new FakeDevice(id, name, new UploadingLamp(scheme));
  let asked: BtRequest | null = null;
  const bt: WebBluetooth = {
    requestDevice: async (req) => {
      asked = req;
      return device;
    },
  };
  const picked = await pickLamp(bt);
  return { device, picked, asked: asked as BtRequest | null };
}

test("Add a light: the chooser shows Govee names only, and the lamp picked is listed by the browser's id for it", async () => {
  forgetWebLamps();
  const { picked, asked } = await added("v1");
  assert.deepEqual(asked, { filters: PREFIXES.map((namePrefix) => ({ namePrefix })), optionalServices: [SERVICE] });
  assert.equal(picked.status, "added");
  assert.deepEqual(webLamps().map((l) => [l.id, l.name, l.sku, l.weak]), [["dev-v1", "Govee_H6076_7A21", "H6076", false]]);
  // A Govee thermometer or a model SYNQ doesn't drive is said so and never kept.
  for (const name of ["GVH5075_1A2B", "Govee_H9999_0000"]) {
    const other = await added("plain", `dev-${name}`, name);
    assert.deepEqual(other.picked, { status: "unsupported", name });
  }
  assert.equal(webLamps().length, 1);
  const refusing = (name: string, message: string): WebBluetooth => ({ requestDevice: () => Promise.reject(Object.assign(new Error(message), { name })) });
  assert.deepEqual(await pickLamp(refusing("NotFoundError", "User cancelled the requestDevice() chooser.")), { status: "cancelled" });
  const off = await pickLamp(refusing("NotFoundError", "Bluetooth adapter not available."));
  assert.ok(off.status === "blocked" && /Bluetooth is off/.test(off.message));
  assert.equal((await pickLamp(null)).status, "blocked");
  // A fresh tab knows no lamp: one from an earlier visit has to be picked again.
  forgetWebLamps();
  await assert.rejects(openWebLamp(picked.status === "added" ? picked.lamp : webLamps()[0], deps()), (e: Error) => e.message === WEB_FORGETS);
});

for (const scheme of ["v1", "v2", "plain"] as const) {
  test(`a ${scheme} lamp over Web Bluetooth: the lamp page's controller drives it, uploads are acknowledged, refused frames never reach it`, async () => {
    forgetWebLamps();
    const { device, picked } = await added(scheme);
    assert.equal(picked.status, "added");
    if (picked.status !== "added") return;
    const link = await openWebLamp(picked.lamp, deps());
    assert.equal(link.scheme, { v1: "encryption v1", v2: "encryption v2", plain: "plaintext" }[scheme]);
    const lamp = device.lamp;
    const c = new LampController(link, specOf("H6076")!);
    c.setPower(false);
    assert.ok(await until(() => !lamp.power && c.view.power === false), "power off reached the lamp and came back");
    c.refresh();
    assert.ok(await until(() => c.view.firmware === "1.04.05"), "the lamp's version came back through the session");
    // A scene: its catalogue data uploaded in the bridge's A3 frames, acknowledged, then switched on.
    const scene = scenesFor("H6076").find((s) => s.blob)!;
    const blob = sceneBlob(scene)!;
    assert.equal(await link.upload("scene", blob, scene.code), true);
    assert.deepEqual(lamp.a3.map(hex), a3Frames(UPLOAD.scene, blob).map(hex));
    // Refused before the radio: another scene's code for that data, the handshake, the key query, firmware commands.
    const before = lamp.accepted.length;
    await assert.rejects(link.upload("scene", blob, scene.code + 1));
    for (const bad of [frame([0xe7, 0x01]), frame([0xaa, 0xb1]), frame([0x33, 0x0f]), frame([0xee, 0x30]), frame([0xa3, 0x00, 0x01])]) await assert.rejects(link.send([bad]));
    assert.equal(lamp.accepted.length, before);
    assert.equal(lamp.a3.length, a3Frames(UPLOAD.scene, blob).length);
    // Screen sync isn't the website's.
    await assert.rejects(link.startSync("left", true, null), (e: Error) => e.message === WEB_NO_SYNC);
    await assert.rejects(link.stopSync(), (e: Error) => e.message === WEB_NO_SYNC);
    await c.close();
    assert.equal(device.connected, false, "closing the page lets go of the lamp");
  });
}

test("the website never needs the lamp's address: its id is the browser's, and a v2 lamp's key comes from its own reply", async () => {
  forgetWebLamps();
  const { device, picked } = await added("v2", "browser-id-Zm9v");
  if (picked.status !== "added") return assert.fail("not added");
  assert.equal(picked.lamp.id, "browser-id-Zm9v");
  const link = await openWebLamp(picked.lamp, deps());
  await link.send([powerFrame(false)]);
  // The pretend lamp opens the frame only under AES-ECB(SKU ‖ its MAC, K_DEV), the key the session derived from the
  // address the lamp named in its handshake: nothing on the website supplied it.
  assert.ok(await until(() => !device.lamp.power));
  await link.close();
});

test("two pages share one connection; the last to close lets go; a dropped lamp is said so and opens again", async () => {
  forgetWebLamps();
  const { device, picked } = await added("v1");
  if (picked.status !== "added") return assert.fail("not added");
  const a = await openWebLamp(picked.lamp, deps());
  const b = await openWebLamp(picked.lamp, deps());
  assert.equal(device.connects, 1);
  await a.close();
  await b.send([queryFrame(CMD.power)]);
  assert.equal(device.connected, true);
  const lost: string[] = [];
  b.onLost((why) => lost.push(why));
  device.drop();
  assert.deepEqual(lost, ["The lamp went out of reach."]);
  await b.close();
  const again = await openWebLamp(picked.lamp, deps());
  assert.equal(device.connects, 2);
  assert.equal(again.scheme, "encryption v1");
  await again.close();
  assert.equal(device.connected, false);
});

test("an open lamp hears a power query whenever nothing else went out for 5 s (the bridge's keep-alive)", async () => {
  forgetWebLamps();
  const { device, picked } = await added("plain");
  if (picked.status !== "added") return assert.fail("not added");
  const link = await openWebLamp(picked.lamp, deps());
  const from = device.lamp.accepted.length;
  assert.ok(await until(() => device.lamp.accepted.slice(from).some((f) => f[0] === 0xaa && f[1] === 0x01), 7000), "a keep-alive went out");
  await link.close();
});
