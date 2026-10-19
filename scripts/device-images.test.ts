// Device pictures: the generated index is consistent with the files on disk, the resolver finds a picture by USB id
// or by the name a device reports (and does not hand a "Pro" its plain sibling's picture), and the stand-ins for
// devices without one (a keyboard drawn from its form factor, a silhouette class) come out as expected.
// No device I/O, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVICE_IMAGE_BY_ID, DEVICE_IMAGE_MODELS } from "../src/lib/device-images.generated.ts";
import { headphonePhotoKeyFor, normName, photoKeyFor, usbKey } from "../src/lib/device-images.ts";
import { keyboardForm, lampArrayDrawnAs, shapeClass } from "../src/lib/device-shape.ts";
import { formGeometry } from "../src/lib/keyboard-geometry.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "src", "assets", "devices");

test("every listed picture is on disk, once, and the whole set stays small", () => {
  const keys = new Set<string>();
  let bytes = 0;
  for (const [key, vendor] of DEVICE_IMAGE_MODELS) {
    assert.ok(!keys.has(key), `duplicate key ${key}`);
    keys.add(key);
    const f = join(dir, vendor, `${key}.webp`);
    assert.ok(existsSync(f), `${vendor}/${key}.webp is missing`);
    bytes += statSync(f).size;
    assert.ok(statSync(f).size < 120 * 1024, `${key} is ${statSync(f).size} bytes`);
  }
  // About 900 px on the long side for the large Devices tiles, at most 70 KB each (scripts/device-photos/tools/proc.py).
  assert.ok(bytes < 64 * 1024 * 1024, `pictures total ${bytes} bytes`);
});

test("SOURCES.json records every picture", () => {
  const src = JSON.parse(readFileSync(join(dir, "SOURCES.json"), "utf8")) as { images: { key: string; vendor: string; fetched: string; pageUrl?: string | null; sourceUrl?: string | null }[] };
  const have = new Map(src.images.map((i) => [i.key, i]));
  for (const [key, vendor] of DEVICE_IMAGE_MODELS) {
    const s = have.get(key);
    assert.ok(s, `${key} has no SOURCES.json entry`);
    assert.equal(s.vendor, vendor);
    assert.match(s.fetched, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(s.pageUrl || s.sourceUrl, `${key} names no source`);
  }
});

test("the id table points at listed pictures", () => {
  const keys = new Set(DEVICE_IMAGE_MODELS.map((m) => m[0]));
  for (const [id, key] of Object.entries(DEVICE_IMAGE_BY_ID)) {
    assert.match(id, /^[0-9a-f]{4}:[0-9a-f]{4}$/);
    assert.ok(keys.has(key), `${id} -> ${key} is not a listed picture`);
  }
});

test("SYNQ's own renders are never shadowed by a vendor picture's id", () => {
  // DEX / Superlight 2 (046d), the X1 V2 Air+ (373b), the Falchion (0b05:1d1d), the X68 HE (2e3c:c365).
  for (const id of ["046d:c0a0", "046d:c09b", "373b:1278", "0b05:1d1d", "2e3c:c365"]) assert.equal(DEVICE_IMAGE_BY_ID[id], undefined, id);
});

test("a picture's own name finds it again (no name is stolen by another picture)", () => {
  for (const [key, vendor, kind, name] of DEVICE_IMAGE_MODELS) {
    const brand = vendor.replace(/-/g, " ");
    const got = photoKeyFor({ kind, name, brand });
    assert.equal(got, key, `${name} (${vendor}) resolved to ${got}`);
  }
});

test("by USB id, and by name when the id is shared", () => {
  assert.equal(photoKeyFor({ kind: "mouse", vid: "1532", pid: "00C1", name: "whatever" }), "razer-viper-v3-pro");
  assert.equal(photoKeyFor({ kind: "keyboard", vid: "31e3", pid: "1322", name: "Wooting 60HE+" }), "wooting-60he-plus");
  assert.equal(photoKeyFor({ kind: "mouse", vid: "046d", pid: "c539", name: "Logitech G502 HERO Gaming Mouse" }), "logitech-g502-hero");
  // An id picture of the wrong kind is not used.
  assert.equal(photoKeyFor({ kind: "keyboard", vid: "1532", pid: "00c1" }), null);
});

test("a variant the picture lacks does not borrow the plain model's picture", () => {
  assert.equal(photoKeyFor({ kind: "mouse", name: "Razer DeathAdder V3" }), "razer-deathadder-v3");
  assert.equal(photoKeyFor({ kind: "mouse", name: "Razer DeathAdder V3 Max" }), null);
  assert.equal(photoKeyFor({ kind: "mouse", name: "Logitech G502 X PLUS" }), "logitech-g502-x-plus");
  assert.equal(photoKeyFor({ kind: "mouse", name: "Logitech G502 X" }), "logitech-g502-x");
  assert.equal(photoKeyFor({ kind: "mouse", name: "Logitech G502 HERO Gaming Mouse" }), "logitech-g502-hero");
  assert.equal(photoKeyFor({ kind: "mouse", name: "Logitech G502 Max" }), null);
  // The developer's DEX and Superlight 2 have product photos too, found by name only (their ids stay off the pictures).
  assert.equal(photoKeyFor({ kind: "mouse", name: "Logitech PRO X SUPERLIGHT 2" }), "logitech-pro-x-superlight-2");
  assert.equal(photoKeyFor({ kind: "mouse", name: "PRO X 2 DEX", brand: "Logitech", vid: "046d", pid: "c0a0" }), "logitech-pro-x-superlight-2-dex");
  assert.equal(photoKeyFor({ kind: "mouse", name: "Razer Viper V3 Pro SE" }), "razer-viper-v3-pro-se");
});

test("same-shell models share one picture (wired/wireless/dongle ids, small revisions)", () => {
  assert.equal(photoKeyFor({ kind: "mouse", name: "Razer Lancehead Wireless (Wired)" }), "razer-lancehead");
  assert.equal(photoKeyFor({ kind: "mouse", name: "Razer DeathAdder 2000" }), "razer-deathadder-v2");
  assert.equal(photoKeyFor({ kind: "mouse", name: "Razer Viper V4 HyperSpeed" }), "razer-viper-v4-pro");
  assert.equal(photoKeyFor({ kind: "mouse", name: "Endgame Gear OP1 8K" }), "endgame-gear-op1-8k-v2");
  assert.equal(photoKeyFor({ kind: "mouse", name: "ASUS ROG GLADIUS IV ACE MAX" }), "rog-gladius-iv-ace");
  assert.equal(photoKeyFor({ kind: "mouse", name: "VAXEE NP-01S V2 Wireless" }), "vaxee-np-01s-wireless");
  assert.equal(photoKeyFor({ kind: "mouse", name: "Pulsar X2F" }), "pulsar-x2f");
  assert.equal(photoKeyFor({ kind: "mouse", name: "X11", brand: "K-snake" }), "attack-shark-x11");
  assert.equal(photoKeyFor({ kind: "keyboard", name: "Razer Huntsman V3 Pro Mini 8KHz" }), "razer-huntsman-v3-pro-mini");
  assert.equal(photoKeyFor({ kind: "keyboard", name: "Jet75", brand: "Sonix" }), "lamzu-jet75");
  // a model nobody published a picture of stays without one (the panel draws it from its layout)
  assert.equal(photoKeyFor({ kind: "keyboard", name: "MonsGeek FUN75" }), null);
});

test("a short model name only counts for its own maker", () => {
  assert.equal(photoKeyFor({ kind: "mouse", name: "Redragon R1" }), null);
  assert.equal(photoKeyFor({ kind: "mouse", name: "R1", brand: "VXE" }), "vxe-r1");
  assert.equal(photoKeyFor({ kind: "mouse", vid: "3367", pid: "ffff", name: "OP1we" }), "endgame-gear-op1we");
  assert.equal(photoKeyFor({ kind: "mouse", name: "OP1we" }), null);
});

test("the Jev alias audit's wrong pairings stay apart (onboard-jev/review/alias-review.json)", () => {
  // Another shell or layout than the picture shows: drawn instead of borrowing it.
  assert.equal(photoKeyFor({ kind: "mouse", name: "CORSAIR SABRE v3 PRO WIRELESS MG ERGO", brand: "Corsair" }), null);
  assert.equal(photoKeyFor({ kind: "mouse", name: "CORSAIR SABRE v3 PRO WIRELESS MG", brand: "Corsair" }), "corsair-sabre-v2-pro-mg");
  assert.equal(photoKeyFor({ kind: "keyboard", name: "Wooting One", brand: "Wooting" }), null);
  assert.equal(photoKeyFor({ kind: "keyboard", name: "Jeet75", brand: "VTER" }), null);
  assert.equal(photoKeyFor({ kind: "keyboard", name: "MAD60HE", brand: "Madlions" }), null);
  assert.equal(photoKeyFor({ kind: "mouse", name: "Zaunkoenig M2K" }), null);
  // ...and not by USB id either (the ids are the makers' own: Corsair's device table, OpenMouse's list, the Madlions catalogue).
  assert.equal(photoKeyFor({ kind: "mouse", vid: "1b1c", pid: "2b40" }), null, "SABRE v3 PRO WIRELESS MG ERGO");
  assert.equal(photoKeyFor({ kind: "mouse", vid: "1b1c", pid: "2b44" }), "corsair-sabre-v2-pro-mg", "SABRE v3 PRO WIRELESS MG keeps its family photo");
  assert.equal(photoKeyFor({ kind: "mouse", vid: "0483", pid: "a3cf" }), null, "Zaunkoenig M2K");
  assert.equal(photoKeyFor({ kind: "mouse", vid: "0483", pid: "a462" }), "zaunkoenig-m3k");
  assert.equal(photoKeyFor({ kind: "keyboard", vid: "373b", pid: "1053" }), null, "Madlions MAD60HE");
  assert.equal(photoKeyFor({ kind: "keyboard", vid: "373b", pid: "1058" }), "madlions-mad68he");
  // The full-size Huntsman V3 Pro had the Mini's picture (razer.com's own page metadata points at it).
  assert.equal(photoKeyFor({ kind: "keyboard", vid: "1532", pid: "02a6" }), "razer-huntsman-v3-pro");
  assert.equal(photoKeyFor({ kind: "keyboard", name: "Razer Huntsman V3 Pro Mini" }), "razer-huntsman-v3-pro-mini");
});

test("controllers: official pictures by USB id, and by name where the id is shared or unknown", () => {
  const pad = (vid: string, pid: string) => photoKeyFor({ kind: "gamepad", vid, pid });
  assert.equal(pad("054c", "0ce6"), "sony-dualsense");
  assert.equal(pad("054c", "0df2"), "sony-dualsense-edge");
  assert.equal(pad("045e", "0b12"), "microsoft-xbox-wireless-controller");
  assert.equal(pad("045e", "0b00"), "microsoft-xbox-elite-series-2");
  assert.equal(pad("3537", "1010"), "gamesir-g7-se", "the GameSir G7 SE");
  assert.equal(pad("057e", "2006"), "nintendo-joy-con-l");
  assert.equal(pad("057e", "2007"), "nintendo-joy-con-r");
  assert.equal(pad("057e", "200e"), "nintendo-joy-con", "the pair in the charging grip");
  // The Core shares the Elite's ids; by name it gets its own (white) picture, and "Core" keeps it off the plain Elite's.
  assert.equal(photoKeyFor({ kind: "gamepad", name: "Xbox Elite Wireless Controller Series 2 Core" }), "microsoft-xbox-elite-series-2-core");
  assert.equal(photoKeyFor({ kind: "gamepad", name: "Xbox Elite Wireless Controller Series 2" }), "microsoft-xbox-elite-series-2");
  // Second wave: the first 8BitDo Ultimate in every mode (its own ids and the X-input ones), and its broad name never takes
  // a later Ultimate's picture.
  for (const pid of ["3011", "3012", "3100", "3105", "3106", "3109", "6007"]) assert.equal(pad("2dc8", pid), "8bitdo-ultimate", pid);
  const byName = (name: string) => photoKeyFor({ kind: "gamepad", name });
  assert.equal(byName("8BitDo Ultimate 2C Wireless Controller"), "8bitdo-ultimate-2c");
  assert.equal(byName("8BitDo Ultimate 2 Wireless"), "8bitdo-ultimate-2");
  assert.equal(byName("8BitDo Ultimate 3-mode for Xbox"), "8bitdo-ultimate-3-mode");
  // Switch 2 pads by id and by name, and a Switch 2 name never takes the first Switch's pictures (the "2" is a model word).
  assert.equal(pad("057e", "2069"), "nintendo-switch-2-pro-controller");
  assert.equal(pad("057e", "2066"), "nintendo-joy-con-2");
  assert.equal(byName("Nintendo Switch 2 Pro Controller"), "nintendo-switch-2-pro-controller");
  assert.equal(byName("Nintendo Switch Pro Controller"), "nintendo-switch-pro-controller");
  assert.equal(pad("03f0", "0495"), "hyperx-clutch-gladiate");
  assert.equal(pad("03f0", "07a0"), "hyperx-clutch-gladiate-rgb");
  // The Rematch and Afterglow wireless pads for Switch 2 share 0e6f:0193: no picture by that id, each by its own name.
  assert.equal(pad("0e6f", "0193"), null);
  assert.equal(byName("Turtle Beach Rematch Wireless Controller for Nintendo Switch 2"), "turtle-beach-rematch-wireless-switch-2");
  // Xbox 360-class ids (045e:028e) are shared by many clones: never a picture.
  assert.equal(pad("045e", "028e"), null);
  // A platform word in another maker's pad name is not Microsoft's or Sony's pad.
  assert.equal(photoKeyFor({ kind: "gamepad", vid: "20d6", pid: "2001", name: "PowerA Xbox Series X Controller", brand: "PowerA" }), null);
  assert.equal(photoKeyFor({ kind: "gamepad", name: "Xbox 360 Controller", brand: "Mad Catz" }), null);
  assert.equal(photoKeyFor({ kind: "gamepad", name: "Xbox 360 Controller", brand: "Microsoft" }), "microsoft-xbox-360-controller");
  assert.equal(photoKeyFor({ kind: "gamepad", name: "Xbox Wireless Controller" }), "microsoft-xbox-wireless-controller", "no brand: the name alone decides");
  assert.equal(pad("045e", "0b0a"), "microsoft-xbox-adaptive-controller");
  assert.equal(pad("0f0d", "0196"), "hori-wireless-horipad-for-steam");
  // A pad's picture never answers a mouse or keyboard query, and the other way round.
  assert.equal(photoKeyFor({ kind: "mouse", vid: "054c", pid: "0ce6" }), null);
  assert.equal(photoKeyFor({ kind: "gamepad", vid: "1532", pid: "00c1" }), null);
});

test("names and ids are normalised the same way everywhere", () => {
  assert.equal(normName("Wooting 60HE+"), "wooting 60he plus");
  assert.equal(normName("  Model D- 2 (Wired) "), "model d 2 wired");
  assert.equal(usbKey("1532", "00C1"), "1532:00c1");
  assert.equal(usbKey(0x1532, 0xc1), "1532:00c1");
  assert.equal(usbKey("0x046d", "c09b"), "046d:c09b");
  assert.equal(usbKey("", "c09b"), null);
  assert.equal(usbKey("zzzz", "c09b"), null);
});

test("a Dynamic Lighting device is drawn as the kind Windows reports", () => {
  assert.equal(lampArrayDrawnAs(1), "keyboard");
  assert.equal(shapeClass({ kind: "lamparray", lampKind: 2, name: "Keyboard" }), "symmetric", "a mouse");
  assert.equal(shapeClass({ kind: "lamparray", lampKind: 3, name: "x" }), "gamepad");
  assert.equal(shapeClass({ kind: "lamparray", lampKind: 11, name: "x" }), "headset");
  assert.equal(shapeClass({ kind: "lamparray", lampKind: 7, name: "x" }), "hub", "a PC case");
  assert.equal(shapeClass({ kind: "lamparray", lampKind: 4, name: "x" }), "hub", "a peripheral");
  for (const k of [5, 9, 10, 0, -1]) assert.equal(shapeClass({ kind: "lamparray", lampKind: k, name: "x" }), "light", `kind ${k}`);
});

test("silhouette classes from the name", () => {
  assert.equal(shapeClass({ kind: "mouse", name: "Razer Viper Mini" }), "small");
  assert.equal(shapeClass({ kind: "mouse", name: "Razer DeathAdder V3 Pro" }), "ergonomic");
  assert.equal(shapeClass({ kind: "mouse", name: "Logitech G502 HERO" }), "ergonomic");
  assert.equal(shapeClass({ kind: "mouse", name: "Pulsar X2 HE 4K Dongle" }), "receiver");
  assert.equal(shapeClass({ kind: "mouse", name: "Some Superlight Clone" }), "symmetric");
  assert.equal(shapeClass({ kind: "sound", name: "Fifine Zero:2" }), "iem");
  assert.equal(shapeClass({ kind: "sound", name: "Speakers (Realtek)" }), "headset");
  assert.equal(shapeClass({ kind: "audio", name: "Arctis Nova 7" }), "headset");
  assert.equal(shapeClass({ kind: "keyboard", name: "x" }), "generic");
  // From the Jev shape audit (onboard-jev/review/shape-disagreements.json): a charging dock is not a mouse.
  assert.equal(shapeClass({ kind: "mouse", name: "Mchose MagDock (charging base)" }), "receiver");
});

test("keyboard form factors from the name, and the drawings have the right key counts", () => {
  const form = keyboardForm;
  assert.equal(form("MonsGeek FUN60 Pro"), "60");
  assert.equal(form("Wooting 60HE+"), "60");
  assert.equal(form("BABAO60 HE"), "60");
  assert.equal(form("Fighting68"), "65");
  assert.equal(form("Keychron Q1 HE"), "75");
  assert.equal(form("Wooting 80HE"), "tkl");
  assert.equal(form("Apex Pro TKL (2023)"), "tkl");
  assert.equal(form("AJAZZ AK980"), "96");
  assert.equal(form("K100 RGB"), "full");
  assert.equal(form("Some board"), "65");
  // From the Jev shape audit: 84 keys is a 75%, 63 / 64 keys a 60% footprint, "980" a 96%, the Wooting One a TKL.
  assert.equal(form("KT84 RGB"), "75");
  assert.equal(form("Looting63"), "60");
  assert.equal(form("YYX64K"), "60");
  assert.equal(form("red star 980"), "96");
  assert.equal(form("Wooting One"), "tkl");
  assert.equal(form("Sunny80 HE"), "tkl");
  assert.equal(form("Vooting30"), "60");
  assert.equal(formGeometry("60").keys.length, 61);
  assert.equal(formGeometry("65").keys.length, 68);
  assert.equal(formGeometry("tkl").keys.length, 87);
  assert.equal(formGeometry("full").keys.length, 104);
  for (const f of ["60", "65", "75", "tkl", "96", "full"] as const) {
    const g = formGeometry(f);
    for (const k of g.keys) assert.ok(k.x >= 0 && k.y >= 0 && k.x + k.w <= g.width + 1e-6 && k.y + k.h <= g.height + 1e-6, `${f}: a key falls outside the board`);
  }
});

test("the 0x19F5 family and Royal Kludge's BeiYing boards: their pictures resolve by USB id, and the coverage is what the pipeline made", async () => {
  const { FW_MODELS } = await import("../src/lib/brands/fw19f5/devices.ts");
  const { RK_MODELS } = await import("../src/lib/brands/rk-beiying/devices.ts");
  const key = (vid: number, pid: number, name = "") => photoKeyFor({ kind: "keyboard", vid: vid.toString(16), pid: pid.toString(16), name });
  // A few by id: MCHOSE (its three USB vendor ids), NuPhy (ISO / JIS variants share the shell), Royal Kludge (BeiYing and Gcome).
  assert.equal(key(0x41e4, 0x2103), "mchose-ace60-pro");
  assert.equal(key(0x19f5, 0xfc30), "mchose-ace60-pro", "the Ace 60's other USB id");
  assert.equal(key(0x3837, 0x3028), "mchose-ace68-turbo");
  assert.equal(key(0x3837, 0x3008), "mchose-jet75", "Jet 75 got its USB ids through aliases.json");
  assert.equal(key(0x19f5, 0x1028), "nuphy-air75-v3");
  assert.equal(key(0x19f5, 0x1029), "nuphy-air75-v3", "the JIS variant");
  assert.equal(key(0x19f5, 0x6120), "nuphy-air75-he", "the earlier pictures are kept");
  assert.equal(key(0x258a, 0x0147), "royal-kludge-m75");
  assert.equal(key(0x258a, 0x01ac), "royal-kludge-m75", "the M75N ISO shares the shell");
  assert.equal(key(0x258a, 0x005a), "royal-kludge-rk71");
  assert.equal(key(0x19f5, 0xa02c), "royal-kludge-r99");
  // Another maker's id is never handed one of these pictures; the shared MCHOSE id (four models) has none.
  assert.equal(key(0x3837, 0x3033), null);
  assert.equal(key(0x258a, 0x010c), null, "AULA's F75 shares the vendor id with Royal Kludge, not the picture");
  // Coverage: how many of the claimed models have an official picture (the rest are drawn from their layout).
  const fw = FW_MODELS.filter((m) => key(m.vendorId, m.productId) !== null).length;
  const rk = RK_MODELS.filter((m) => key(m.vendorId, m.productId) !== null).length;
  assert.ok(fw >= 55, `${fw} of ${FW_MODELS.length} 0x19F5-family boards have a picture`);
  assert.ok(rk >= 70, `${rk} of ${RK_MODELS.length} Royal Kludge BeiYing boards have a picture`);
});

test("wave B: Keychron / Lemokey HE boards by USB id, SparkLink C-series by id, illumipc boards by the name the panel reads (never by the shared id)", async () => {
  const { KC_MODELS } = await import("../src/lib/kb/via/keychron/devices.ts");
  const { SPARKLINK_MODELS } = await import("../src/lib/brands/sparklink/devices.ts");
  const { ILLUMIPC_BOARDS } = await import("../src/lib/illumipc/catalog.generated.ts");
  const { identityFor } = await import("../src/lib/x68he-layout.ts");
  const h = (n: number) => n.toString(16).padStart(4, "0");
  const id = (vid: number, pid: number, name = "", brand?: string) => photoKeyFor({ kind: "keyboard", vid: h(vid), pid: h(pid), name, brand });
  // Keychron and Lemokey: every one of the 35 firmware variants (ANSI / ISO / JIS) has a picture, by id.
  for (const m of KC_MODELS) assert.ok(id(m.vendorId, m.productId), `${m.brand} ${m.name} ${h(m.productId)}`);
  assert.equal(id(0x3434, 0x0b61), "keychron-q6-he", "the Q6 HE ISO variant");
  assert.equal(id(0x3434, 0x0b31), "keychron-q3-he", "the Q3 HE ISO variant shares the earlier picture (aliases.json)");
  assert.equal(id(0x362d, 0x0620), "lemokey-p2-he");
  // SparkLink: Royal Kludge's C-series by id (every language variant of a shell), AULA and Kochi are drawn (the maker's list has no model names).
  assert.equal(id(0x1ca2, 0x1604), "royal-kludge-c98");
  assert.equal(id(0x1ca2, 0x160e), "royal-kludge-c98", "C98 (DE)");
  assert.equal(id(0x1ca2, 0x1616), "royal-kludge-c68", "C68 (V2) is found by id although a 'V2' name would count as another model");
  assert.equal(id(0x1ca2, 0x1609), null, "C61 has no Hall-effect picture in RK's store");
  assert.equal(id(0x1ca2, 0x0901), null, "Kochi: no store picture");
  assert.equal(id(0x1ca5, 0x0401), null, "AULA HE boards: no model name, no picture");
  assert.equal(SPARKLINK_MODELS.filter((m) => id(m.vendorId, m.productId, `${m.brand} ${m.name}`, m.brand)).length, 15);
  // illumipc: the id is shared by hundreds of boards, so no picture may sit on it; the panel names the board and the name finds the picture.
  for (const [vid, pid] of [[0x2e3c, 0xc365], [0x2e3c, 0xc366], [0x2e3c, 0xc367], [0x2e3c, 0xc368], [0x0416, 0x7372]]) assert.equal(id(vid, pid), null, `${h(vid)}:${h(pid)}`);
  assert.equal(id(0x2e3c, 0xc365, "HE keyboard (2E3C:C365)"), null);
  const found = ILLUMIPC_BOARDS.filter((b) => {
    const who = identityFor(b.product, "");
    return id(b.ids[0][0], b.ids[0][1], who.model, who.brand || undefined) !== null;
  });
  assert.equal(found.length, 19, "Redragon K556 / K580 / K617 / K618 / K673 / K686 / K707 / M61 and Epomaker HE30");
  assert.equal(id(0x2e3c, 0xc365, "K673WB-RGB-M", "Redragon"), "redragon-k673-he");
  assert.equal(id(0x2e3c, 0xc365, "K617RGB-MP (PT)", "Redragon"), "redragon-k617-he");
  assert.equal(id(0x0416, 0x7372, "M61", "Redragon"), "redragon-m61");
  assert.equal(id(0x2e3c, 0xc366, "HE30", "Epomaker"), "epomaker-he30");
  assert.equal(id(0x2e3c, 0xc365, "HE60 Lite", "Epomaker"), null, "no HE60 Lite picture (the HE60's is not this board)");
  assert.equal(id(0x2e3c, 0xc365, "M82", "Redragon"), null, "no Hall-effect product in Redragon's store: drawn from the layout");
});

test("monitors and webcams: monitors by the model in their EDID name (and maker), webcams by USB id or name", () => {
  const mon = (name: string, brand: string) => photoKeyFor({ kind: "monitor", name: `${brand} ${name}`, brand });
  const cam = (name: string, vid?: string, pid?: string) => photoKeyFor({ kind: "webcam", name, vid, pid });
  assert.equal(mon("ROG PG27AQDM", "ASUS"), "asus-pg27aqdm");
  assert.equal(mon("VG27AQ", "ASUS"), "asus-vg27aq");
  assert.equal(mon("VG27AQL1A", "ASUS"), null, "another model: no borrowed picture");
  assert.equal(mon("27GR95QE", "LG"), "lg-27gr95qe");
  assert.equal(mon("LG ULTRAGEAR", "LG"), null, "an EDID that names no model stays drawn");
  assert.equal(mon("Odyssey G85SD", "Samsung"), "samsung-odyssey-oled-g8");
  assert.equal(mon("Odyssey G9", "Samsung"), null, "the G9 name covers several shells");
  assert.equal(mon("ZOWIE XL LCD", "BenQ"), "benq-xl2546k", "the XL family picture");
  assert.equal(mon("24G2W1G4", "AOC"), "aoc-24g2");
  assert.equal(mon("PG27AQDM", "Dell"), null, "a model name only counts for its own maker");
  assert.equal(cam("Logitech Webcam C270", "046d", "0825"), "logitech-c270");
  assert.equal(cam("Logitech MX Brio", "046d", "0944"), "logitech-mx-brio", "not the BRIO's picture");
  assert.equal(cam("Logitech Brio 505", "046d", "0947"), "logitech-brio-500", "the Brio 500 family");
  assert.equal(cam("Razer Kiyo Pro", "1532", "0e05"), "razer-kiyo-pro");
  assert.equal(cam("Razer Kiyo Pro Ultra"), "razer-kiyo-pro-ultra");
  assert.equal(cam("Elgato Facecam MK.2"), "elgato-facecam-mk2");
  assert.equal(cam("OBSBOT Tiny 2 Lite"), "obsbot-tiny-2-lite", "its own picture, not the Tiny 2's");
  assert.equal(cam("OBSBOT Tiny 2"), "obsbot-tiny-2");
  assert.equal(cam("Insta360 Link 2"), "insta360-link-2");
  assert.equal(cam("Insta360 Link 2C"), null, "the 2C has no gimbal: not the Link's picture");
  // From the makers' pages as the Wayback Machine kept them (dell.com, msi.com and gigabyte.com refuse the pipeline; Microsoft dropped its pages).
  assert.equal(cam("Microsoft® LifeCam Studio(TM)", "045e", "0772"), "microsoft-lifecam-studio");
  assert.equal(cam("Microsoft® LifeCam HD-3000"), "microsoft-lifecam-hd-3000");
  assert.equal(mon("AW2725DF", "Dell"), "dell-aw2725df");
  assert.equal(mon("S2721DGF", "Dell"), null, "no archived picture: drawn");
  assert.equal(mon("MAG 271QPX QD-OLED", "MSI"), "msi-mag-271qpx");
  assert.equal(mon("M27Q X", "Gigabyte"), null, "the M27Q X is another model");
  assert.equal(mon("DELL U2723QE", "Dell"), "dell-u2723qe");
  assert.equal(mon("AW3225QF", "Dell"), "dell-aw3225qf");
  assert.equal(mon("AW3423DW", "Dell"), "dell-aw3423dw", "the white G-SYNC model");
  assert.equal(mon("AW3423DWF", "Dell"), "dell-aw3423dwf", "the black FreeSync model has its own picture");
  assert.equal(mon("AW2524HF", "Dell"), null, "the FreeSync AW2524HF is not the AW2524H's picture");
  assert.equal(mon("M32U", "GBT"), "gigabyte-m32u", "Gigabyte's EDID maker code");
  assert.equal(mon("G27QC", "GBT"), null, "the curved G27QC is not the G27Q");
});

test("USB RGB hubs: pictures in the lighting group, by USB id", () => {
  assert.equal(photoKeyFor({ kind: "light", vid: "1b1c", pid: "0c57", name: "CORSAIR Nautilus LCD Cap" }), "corsair-nautilus-lcd-cap");
  assert.equal(photoKeyFor({ kind: "light", vid: "1b1c", pid: "0c0b", name: "" }), "corsair-lighting-node-pro");
  assert.equal(photoKeyFor({ kind: "light", vid: "1e71", pid: "2011", name: "NZXT RGB & Fan Controller" }), "nzxt-rgb-and-fan-controller", "nzxt.com's page as the Wayback Machine kept it");
  assert.equal(photoKeyFor({ kind: "light", vid: "1b1c", pid: "0c10", name: "" }), "corsair-commander-pro");
});

test("the developer's own devices resolve to product photos (by name; their ids never shadow SYNQ's renders)", () => {
  assert.equal(photoKeyFor({ kind: "mouse", vid: "373b", pid: "1278", name: "ATK X1 V2 Air+" }), "atk-x1-v2-air-plus");
  assert.equal(photoKeyFor({ kind: "keyboard", vid: "0b05", pid: "1d1d", name: "ROG FALCHION ACE HFX ZYWOO EDITION" }), "rog-falchion-ace-hfx-zywoo-edition");
  // The name it reports to the app: the edition word decides over the plain Falchion's equally long name.
  assert.equal(photoKeyFor({ kind: "keyboard", name: "ROG Falchion Ace HFX ZywOo", brand: "ASUS ROG" }), "rog-falchion-ace-hfx-zywoo-edition");
  assert.equal(photoKeyFor({ kind: "keyboard", name: "ROG Falchion Ace HFX", brand: "ASUS ROG" }), "rog-falchion-ace-hfx");
  assert.equal(photoKeyFor({ kind: "mouse", name: "PRO X 2 DEX", brand: "Logitech" }), "logitech-pro-x-superlight-2-dex");
  assert.equal(photoKeyFor({ kind: "gamepad", vid: "3537", pid: "1010", name: "Game controller" }), "gamesir-g7-se");
  assert.equal(photoKeyFor({ kind: "webcam", vid: "0458", pid: "6006", name: "PC-LM1E Camera" }), "aukey-pc-lm1e");
  assert.equal(photoKeyFor({ kind: "light", name: "Govee H6076", brand: "Govee" }), "govee-h6076");
});

test("headphones: the name a person gives a sound output, or the AutoEq model they pick", () => {
  assert.equal(headphonePhotoKeyFor("Zero:2"), "7hz-salnotes-zero-2", "the developer's own IEMs, named as on the Sound page");
  assert.equal(headphonePhotoKeyFor("7Hz Salnotes Zero 2"), "7hz-salnotes-zero-2");
  assert.equal(headphonePhotoKeyFor("7Hz x Crinacle Zero 2"), "7hz-salnotes-zero-2");
  assert.equal(photoKeyFor({ kind: "sound", name: "Zero:2" }), "7hz-salnotes-zero-2", "a sound output's picture goes through the same lookup");
  assert.equal(headphonePhotoKeyFor("7Hz Salnotes Zero"), "7hz-salnotes-zero", "not the Zero:2");
  assert.equal(headphonePhotoKeyFor("Sennheiser HD 600"), "sennheiser-hd-600");
  assert.equal(headphonePhotoKeyFor("Sennheiser HD600"), "sennheiser-hd-600", "letters and digits split the same way on both sides");
  assert.equal(headphonePhotoKeyFor("HD 650"), "sennheiser-hd-650", "a two-word model needs no maker");
  assert.equal(headphonePhotoKeyFor("Beyerdynamic DT 770 PRO 80 Ohm"), "beyerdynamic-dt-770-pro", "the impedance is not a model word");
  assert.equal(headphonePhotoKeyFor("Apple AirPods (3rd generation)"), "apple-airpods-3rd-generation");
  assert.equal(headphonePhotoKeyFor("Moondrop Aria 2"), "moondrop-aria-2");
  assert.equal(headphonePhotoKeyFor("Moondrop Aria (2021)"), "moondrop-aria", "a year in brackets never rules a picture out");
  assert.equal(headphonePhotoKeyFor("Aria"), null, "a one-word model needs its maker");
  assert.equal(headphonePhotoKeyFor("Truthear Zero 2"), null, "another maker's Zero is not the 7Hz Zero:2");
  assert.equal(headphonePhotoKeyFor("Logitech G733 LIGHTSPEED"), "logitech-g733", "a gaming headset's picture serves the Sound page too");
  assert.equal(headphonePhotoKeyFor("Speakers (USB DAC)"), null);
  assert.equal(headphonePhotoKeyFor("Headphones (WF-1000XM4)"), "sony-wf-1000xm4", "Windows' name for a Bluetooth output");
  assert.equal(headphonePhotoKeyFor("WF-1000XM5"), "sony-wf-1000xm5", "not the XM4's picture");
  assert.equal(headphonePhotoKeyFor("INZONE H7"), null, "no clean picture: drawn");
  assert.equal(headphonePhotoKeyFor("Sony WH-1000XM4"), "sony-wh-1000xm4", "Sony's own render, not the XM5's");
  // A headphone picture never answers a device query that names no kind (a Dynamic Lighting device).
  assert.equal(photoKeyFor({ name: "Sennheiser HD 600" }), null);
});
