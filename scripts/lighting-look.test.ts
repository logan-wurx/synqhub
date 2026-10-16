// One look everywhere (wave L5, src/lib/lighting/look): every source in one list with stable keys, the look fanned out
// to each light in the way it takes it, and which lights can't follow the screen. No devices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LookControl, dim, middle, type Driver } from "../src/lib/lighting/look/control.ts";
import { cantSync, lightRefs } from "../src/lib/lighting/look/lights.ts";
import type { NetDevice } from "../src/lib/lighting/net/brands.ts";
import type { HubModel } from "../src/lib/lighting/hidrgb/protocol.ts";

const lamp = { id: "a4c138000001", name: "Govee_H6076_0001", sku: "H6076", rssi: -60, heardMs: 0 };
const wifi = (brand: NetDevice["brand"], extra: Partial<NetDevice> = {}): NetDevice => ({ brand, id: `${brand}-1`, name: brand, model: "x", host: "192.168.1.9", paired: true, ...extra });
const hub: HubModel = { vid: "1e71", pid: "2019", family: "nzxt-hue2", name: "NZXT RGB & Fan Controller", channels: 3 };

test("every source in one list, each with a key that stays the same", () => {
  const refs = lightRefs(
    [lamp],
    [wifi("hue", { sub: "3", name: "Desk lamp" }), wifi("hue", { id: "bridge", paired: false }), wifi("hue", { id: "bridge2", paired: true }), wifi("nanoleaf", { paired: false }), wifi("wiz")],
    [{ id: "dl-1", name: "Keyboard" }],
    [{ family: "1e71:2019", model: hub }],
  );
  assert.deepEqual(
    refs.map((r) => r.key),
    ["govee:a4c138000001", "wifi:net~hue~hue-1~3", "wifi:net~wiz~wiz-1", "dl:dl-1", "hub:1e71:2019"],
    "a Hue bridge (paired or not) and an unpaired light are not lights you can send a look to",
  );
  assert.deepEqual(refs.map((r) => r.source), ["govee", "wifi", "wifi", "lamparray", "hub"]);
  assert.deepEqual(
    refs.map((r) => r.detail),
    ["Govee H6076 · Bluetooth", "Philips Hue · Wi-Fi", "WiZ · Wi-Fi", "Dynamic Lighting", "NZXT · USB"],
    "the maker and how it's reached, each said once",
  );
  const [usb, ble] = lightRefs(
    [],
    [],
    [
      { id: "\\\\?\\HID#VID_1532&PID_0084&MI_03&Col05#8&1a2b3c&0&0004#{4d1e55b2-f16f-11cf-88cb-001111000030}", name: "Razer keyboard" },
      { id: "\\\\?\\HID#{00001812-0000-1000-8000-00805f9b34fb}_Dev_VID&02046d_PID&b023_REV&0007#9&2f&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}", name: "Logitech mouse" },
    ],
    [],
  );
  assert.equal(usb.detail, "Dynamic Lighting · USB");
  assert.equal(ble.detail, "Dynamic Lighting · Bluetooth");
});

test("which lights can follow the screen", () => {
  const [g, w, y, k, ks, dl, h] = lightRefs(
    [lamp],
    [wifi("wiz"), wifi("yeelight"), wifi("elgato", { model: "Elgato Key Light" }), wifi("elgato", { id: "s", model: "Elgato Light Strip" })],
    [{ id: "dl-1", name: "Keyboard" }],
    [{ family: "1e71:2019", model: hub }],
  );
  assert.equal(cantSync(g), null);
  assert.equal(cantSync(w), null);
  assert.match(cantSync(y)!, /one change a second/);
  assert.match(cantSync(k)!, /white only/);
  assert.equal(cantSync(ks), null);
  assert.equal(cantSync(dl), "Dynamic Lighting devices follow the app in front, so they can't follow the screen.");
  assert.equal(cantSync(h), null, "a hub can follow, once its changes are allowed in the view");
});

/** A light that records what it was told. */
function fake(key: string, has: { gradient?: boolean; white?: boolean; brightness?: boolean; power?: boolean }) {
  const log: string[] = [];
  const d: Driver = {
    key,
    colour: (c) => log.push(`colour ${c.join(",")}`),
    gradient: has.gradient ? (s) => log.push(`gradient ${s.length}`) : undefined,
    white: has.white ? (k) => log.push(`white ${k}`) : undefined,
    brightness: has.brightness ? (p) => log.push(`brightness ${p}`) : undefined,
    power: has.power ? (on) => log.push(`power ${on}`) : undefined,
    close: async () => void log.push("close"),
  };
  return { d, log };
}

test("one look reaches every light in the way it takes it", async () => {
  const full = fake("govee", { gradient: true, white: true, brightness: true, power: true });
  const plain = fake("hub", {});
  const look = new LookControl();
  look.setDrivers([full.d, plain.d]);
  // Joining: each light takes the current look at once.
  assert.deepEqual(full.log, ["power true", "colour 255,255,255", "brightness 80"]);
  assert.deepEqual(plain.log, ["colour 204,204,204"], "a light without its own brightness gets the colour dimmed");
  full.log.length = plain.log.length = 0;

  look.setColour([255, 0, 0]);
  look.setWhite(2700);
  look.setGradient([[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
  assert.deepEqual(full.log, ["colour 255,0,0", "white 2700", "gradient 3"]);
  assert.equal(plain.log[0], "colour 204,0,0");
  assert.match(plain.log[1], /^colour /, "white as a colour where the light has no white");
  assert.equal(plain.log[2], `colour ${dim(middle([[255, 0, 0], [0, 255, 0], [0, 0, 255]]), 80).join(",")}`, "a gradient's middle on a light of one colour");
  full.log.length = plain.log.length = 0;

  look.setBrightness(50);
  assert.deepEqual(full.log, ["brightness 50"]);
  assert.equal(plain.log.length, 1, "the plain light gets the look again at the new brightness");
  full.log.length = plain.log.length = 0;

  look.setPower(false);
  assert.deepEqual(full.log, ["power false"]);
  assert.deepEqual(plain.log, ["colour 0,0,0"], "off is black where a light has no power of its own");
  // A light that joins while the look is off stays dark.
  const late = fake("late", { power: true });
  look.setDrivers([full.d, plain.d, late.d]);
  assert.deepEqual(late.log, ["power false"]);

  await look.close();
  assert.ok(full.log.includes("close") && plain.log.includes("close") && late.log.includes("close"));
});
