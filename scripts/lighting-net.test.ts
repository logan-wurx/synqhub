// The Wi-Fi lights of wave L3 (src/lib/lighting/net): the guard and its fixture (the bridge's guard.rs is held to the
// same file), each brand's messages read back by the simulated lights, pairing, and the controller's pace. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NET_BRANDS, hsv, lifxFrame, rgbOfHsv, type NetDevice } from "../src/lib/lighting/net/brands.ts";
import { checkNet, type Brand, type NetMessage } from "../src/lib/lighting/net/guard.ts";
import { NetLightController, NET_PACE_MS, type Send } from "../src/lib/lighting/net/control.ts";
import { simList, simPair, simSend } from "../src/lib/lighting/net/sim.ts";
import { NET_MESSAGES, netFixtureText } from "./net-fixtures.ts";
import { photoKeyFor } from "../src/lib/device-images.ts";
import { NET_MAKERS, netModel } from "../src/lib/lighting/models.ts";
import { currentScene, listScenes, recallMessage, sceneColours, xyRgb } from "../src/lib/lighting/net/scenes.ts";

const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** The simulated lights as the page lists them (a paired Hue bridge's lights each a device). */
async function devices(): Promise<NetDevice[]> {
  const found = await simList();
  return found.map((f) => ({ brand: f.brand, id: f.id, name: f.name, model: f.model, host: f.host, paired: f.paired, mac: f.mac ?? undefined, sub: f.brand === "hue" ? "1" : undefined }));
}

test("the network fixture is what scripts/net-fixtures.ts writes, and the guard agrees with every line", () => {
  const text = netFixtureText();
  assert.equal(readFileSync(NET_MESSAGES, "utf8").replace(/\r\n/g, "\n"), text, "run node scripts/net-fixtures.ts");
  let allowed = 0;
  for (const line of text.trim().split("\n")) {
    const [brand, ok, ...json] = line.split(" ");
    const raw = JSON.parse(json.join(" "));
    const m: NetMessage = raw.kind === "lifx" ? { kind: "lifx", bytes: Uint8Array.from(raw.bytes) } : raw;
    assert.equal(checkNet(brand as Brand, m).ok, ok === "1", line.slice(0, 120));
    allowed += Number(ok === "1");
  }
  assert.ok(allowed > 50, "the fixture holds every message the page builds");
});

test("the guard refuses what the brief names, for every brand", () => {
  const no = (brand: Brand, m: NetMessage) => assert.equal(checkNet(brand, m).ok, false, `${brand} ${JSON.stringify(m).slice(0, 80)}`);
  no("hue", { kind: "http", method: "PUT", path: "/api/{token}/config", body: { swupdate2: { install: true } } });
  no("hue", { kind: "http", method: "PUT", path: "/api/{token}/lights/1", body: { name: "x" } });
  no("nanoleaf", { kind: "http", method: "PUT", path: "/api/v1/{token}/identify" });
  no("elgato", { kind: "http", method: "PUT", path: "/elgato/accessory-info", body: { displayName: "x" } });
  no("twinkly", { kind: "http", method: "POST", path: "/xled/v1/network/status", body: { mode: 1, station: { ssid: "x" } } });
  no("twinkly", { kind: "http", method: "POST", path: "/xled/v1/fw/0/update" });
  no("wiz", { kind: "json", body: { method: "setWifiConfig", params: { ssid: "x", pass: "y" } } });
  no("wiz", { kind: "json", body: { method: "reset", params: {} } });
  no("yeelight", { kind: "json", body: { id: 1, method: "set_name", params: ["x"] } });
  no("lifx", { kind: "lifx", bytes: lifxFrame("d073d5a1b2c3", 24, Array.from({ length: 32 }, () => 65)) });
  no("lifx", { kind: "lifx", bytes: lifxFrame("d073d5a1b2c3", 38, []) });
  // Another brand's message is refused too.
  no("wiz", NET_BRANDS.yeelight.power({ brand: "yeelight", id: "x", name: "", model: "", host: "", paired: true }, true)[0]);
});

test("colours survive the round trip through hue and saturation", () => {
  for (const c of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 128, 0], [255, 255, 255]] as const) {
    const [h, s] = hsv(c);
    const back = rgbOfHsv(h, s);
    back.forEach((v, i) => assert.ok(Math.abs(v - c[i]) <= 1, `${c} -> ${back}`));
  }
});

test("every brand: power, brightness, colour and white go out through the guard and the light reports them back", async () => {
  const hue = (await simList()).find((f) => f.brand === "hue")!;
  // The simulated bridge lets SYNQ in once its "button" has been pressed (the second ask).
  await assert.rejects(simPair("hue", hue.id));
  await new Promise((r) => setTimeout(r, 1600));
  await simPair("hue", hue.id);
  for (const d of await devices()) {
    const b = NET_BRANDS[d.brand];
    const sent: NetMessage[] = [];
    const send: Send = (brand, id, m) => {
      assert.ok(checkNet(brand, m).ok, `${brand}: the guard takes ${JSON.stringify(m).slice(0, 80)}`);
      sent.push(m);
      return simSend(brand, id, m);
    };
    const c = new NetLightController(d, send);
    await c.refresh();
    assert.equal(c.view.power, true, `${d.brand}: it reports on`);
    c.setBrightness(40);
    await until(() => sent.length > b.query(d).length);
    if (!c.whiteOnly) c.setColour([255, 0, 0]);
    else if (b.kelvin) c.setWhite(5000);
    await new Promise((r) => setTimeout(r, NET_PACE_MS[d.brand] * 3 + 50));
    await c.refresh();
    await until(() => c.view.brightness !== null);
    // Twinkly reports power and brightness only; the rest report what they show.
    assert.ok(Math.abs((c.view.brightness ?? 0) - 40) <= 1, `${d.brand}: brightness ${c.view.brightness}`);
    if (d.brand !== "twinkly") {
      if (c.whiteOnly) assert.equal(c.view.kelvin, 5000, `${d.brand}: white`);
      else assert.deepEqual(c.view.segments[0].map((v) => Math.round(v / 16)), [16, 0, 0], `${d.brand}: red`);
    }
    c.setPower(false);
    await new Promise((r) => setTimeout(r, NET_PACE_MS[d.brand] + 50));
    await c.refresh();
    assert.equal(c.view.power, false, `${d.brand}: off`);
    await c.close();
  }
});

test("a dragged slider sends the latest value at the brand's pace (Yeelight's quota: about one a second)", async () => {
  const d = (await devices()).find((x) => x.brand === "yeelight")!;
  const times: number[] = [];
  const values: number[] = [];
  const c = new NetLightController(d, (brand, id, m) => {
    times.push(Date.now());
    if (m.kind === "json") values.push(Number((m.body as { params: number[] }).params[0]));
    return simSend(brand, id, m);
  });
  for (let v = 10; v <= 90; v += 10) c.setBrightness(v);
  await until(() => times.length >= 1);
  c.setBrightness(95);
  await until(() => values.includes(95), 3000);
  assert.ok(values.length <= 3, `a burst of 10 changes became ${values.length} messages`);
  assert.equal(values[values.length - 1], 95, "the last value wins");
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= NET_PACE_MS.yeelight - 20, "spaced a second apart");
  await c.close();
});

test("a light that needs pairing says so", async () => {
  const nl = { brand: "nanoleaf" as const, id: "nobody", name: "x", model: "x", host: "x", paired: false };
  await assert.rejects(simSend(nl.brand, nl.id, NET_BRANDS.nanoleaf.query(nl)[0]), /hasn't found/);
});

test("a Wi-Fi light is pictured by the model it reports, and drawn when there is no clean picture", () => {
  const pic = (brand: keyof typeof NET_MAKERS, model: string) => photoKeyFor({ kind: "light", name: `${NET_MAKERS[brand]} ${netModel({ brand, model })}`, brand: NET_MAKERS[brand] });
  assert.equal(pic("hue", "Hue color lamp"), "philips-hue-color-a19");
  assert.equal(pic("hue", "Hue gradient lightstrip"), "philips-hue-gradient-lightstrip");
  assert.equal(pic("nanoleaf", "NL42"), "nanoleaf-shapes-hexagons");
  assert.equal(pic("nanoleaf", "NL59"), "nanoleaf-lines");
  assert.equal(pic("elgato", "Elgato Key Light"), "elgato-key-light");
  assert.equal(pic("elgato", "Elgato Light Strip"), "elgato-light-strip");
  assert.equal(pic("elgato", "Elgato Key Light Air"), null, "another model: no picture rather than the wrong one");
  assert.equal(pic("twinkly", "Twinkly"), "twinkly-strings");
  assert.equal(pic("wiz", "WiZ light"), "wiz-color-bulb");
  assert.equal(pic("lifx", "LIFX light"), null, "LIFX has only packaging shots");
  assert.equal(pic("hue", "BSB002"), "philips-hue-bridge", "the bridge itself, on its card and its page");
});

test("scenes a light already has are listed and recalled, never made or changed", async () => {
  const [hueLight, nano] = (await devices()).filter((d) => d.brand === "hue" || d.brand === "nanoleaf").sort((a) => (a.brand === "hue" ? -1 : 1));
  const sent: NetMessage[] = [];
  const send: Send = async (brand, id, m) => {
    assert.ok(checkNet(brand, m).ok, `${brand}: the guard takes ${JSON.stringify(m).slice(0, 80)}`);
    sent.push(m);
    try {
      return await simSend(brand, id, m);
    } catch {
      // The pretend bridge needs pairing first (the second ask lets SYNQ in).
      await simPair(brand, id).catch(() => new Promise((r) => setTimeout(r, 1600)).then(() => simPair(brand, id)));
      return simSend(brand, id, m);
    }
  };
  const hue = await listScenes(hueLight, send);
  assert.deepEqual(hue.map((s) => s.name), ["Read", "Relax", "Tropical twilight"], "the scenes with this light, not the Hue app's own");
  assert.equal(hue.find((s) => s.name === "Relax")?.group, "1", "a group scene is recalled through its group");
  const colours = await sceneColours(hueLight, hue[1], send);
  assert.equal(colours.length, 2);
  assert.ok(colours[0][0] > colours[0][2], "Relax is warm");
  assert.deepEqual(recallMessage(hueLight, hue[1]), { kind: "http", method: "PUT", path: "/api/{token}/groups/1/action", body: { scene: "sc-relax-01" } });
  await send("hue", hueLight.id, recallMessage(hueLight, hue[0]));
  const effects = await listScenes(nano, send);
  assert.deepEqual(effects.map((e) => e.name), ["Northern Lights", "Forest", "Fireplace", "Nemo"]);
  await send("nanoleaf", nano.id, recallMessage(nano, effects[3]));
  assert.equal(await currentScene(nano, send), "Nemo");
  // Every message was a read or a recall.
  assert.ok(sent.every((m) => m.kind === "http" && (m.method === "GET" || /\/action$|\/effects$/.test(m.path))));
  // Hue's xy for a pure-ish red reads red.
  const red = xyRgb([0.675, 0.322]);
  assert.ok(red[0] > 200 && red[1] < 80 && red[2] < 80, `${red}`);
});
