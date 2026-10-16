// Checks src/lib/illumipc (the catalogue of boards the illumipc driver knows by product code, their layouts, the id list) and
// the layout / identity functions in src/lib/x68he-layout.ts. No device, no window.
// Run: node --test scripts/illumipc-catalog.test.ts
//
// Evidence used: illumipc.com's own device.json (the counts the research found: 44 Redragon entries, 30 on 2E3C:C365 and
// 14 on 0416:7372; Epomaker HE60 Lite and HE30; Womier M68HE PRO) and its per-product layout files, whose matrix is the
// 6 x 22 one the X68 HE uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ILLUMIPC_BOARDS, ILLUMIPC_LAYOUTS } from "../src/lib/illumipc/catalog.generated.ts";
import { ILLUMIPC_USB_IDS, idKey, isIllumipcHex, isIllumipcId } from "../src/lib/illumipc/ids.ts";
import { X68_LAYOUTS, boardForProduct, identityFor, layoutForProduct } from "../src/lib/x68he-layout.ts";
import { checkFrame, encodeTriggerWrites } from "../src/lib/x68he-protocol.ts";
import { isBootloader } from "../src/lib/bootloader-ids.ts";

test("the catalogue lists the brands the research named, with the counts illumipc's device.json has", () => {
  const by = (b: string) => ILLUMIPC_BOARDS.filter((x) => x.brand === b);
  assert.equal(ILLUMIPC_BOARDS.length, 50);
  assert.equal(by("Redragon").length, 44);
  assert.equal(by("Epomaker").length, 2);
  assert.equal(by("Womier").length, 1);
  assert.equal(by("MAGIC-REFINER").length, 3);
  const rd = by("Redragon");
  assert.equal(rd.filter((b) => b.ids.some(([v, p]) => v === 0x2e3c && p === 0xc365)).length, 30);
  assert.equal(rd.filter((b) => b.ids.some(([v, p]) => v === 0x0416 && p === 0x7372)).length, 14);
  assert.equal(new Set(ILLUMIPC_BOARDS.map((b) => b.product.toUpperCase())).size, 50, "one row per product code");
  assert.deepEqual(by("Womier").map((b) => [b.product, b.name]), [["KF068USHEARGB", "M68HE PRO"]]);
  assert.deepEqual(by("Epomaker").map((b) => b.name).sort(), ["HE30", "HE60 Lite"]);
});

test("every id a board enumerates as is one the bridge opens, and every opened id has a board", () => {
  const ids = new Set(ILLUMIPC_USB_IDS.map(([v, p]) => idKey(v, p)));
  assert.equal(ids.size, ILLUMIPC_USB_IDS.length);
  const used = new Set<string>();
  for (const b of ILLUMIPC_BOARDS) {
    assert.ok(b.ids.length >= 1);
    for (const [v, p] of b.ids) {
      assert.ok(ids.has(idKey(v, p)), `${b.product} ${idKey(v, p)}`);
      used.add(idKey(v, p));
      assert.equal(isBootloader(v, p, null), false);
    }
  }
  assert.deepEqual([...ids].sort(), [...used].sort());
  assert.ok(isIllumipcId(0x2e3c, 0xc365) && isIllumipcId(0x0416, 0x7372) && !isIllumipcId(0x0416, 0xb23c) && !isIllumipcId(0x2e3c, 0xaf01));
  assert.ok(isIllumipcHex("2e3c", "C365") && isIllumipcHex(0x2e3c, 0xc368) && !isIllumipcHex("2e3c", "af01") && !isIllumipcHex(null, "c365"));
});

test("layouts: one 6 x 22 matrix, every HID in the keyboard page, keys that don't overlap, Fn / knob / G keys locked", () => {
  assert.equal(ILLUMIPC_LAYOUTS.length, 19);
  for (const [n, l] of ILLUMIPC_LAYOUTS.entries()) {
    const idx = l.keys.map((k) => k[0]);
    assert.equal(new Set(idx).size, idx.length, `layout ${n}: one key per matrix slot`);
    for (const [index, hid, x, y, w, h, kind] of l.keys) {
      assert.ok(index >= 0 && index < 132, `layout ${n}: slot ${index}`);
      if (kind === 0) assert.ok(hid >= 0x04 && hid <= 0xe7, `layout ${n}: HID ${hid}`);
      else assert.equal(hid, 0);
      assert.ok(w > 0.5 && w < 8 && h > 0.5 && h < 3 && x >= 0 && y >= 0, `layout ${n}: key ${index} is ${w} x ${h} at ${x},${y}`);
    }
    for (let i = 0; i < l.keys.length; i++)
      for (let j = i + 1; j < l.keys.length; j++) {
        const [, , ax, ay, aw, ah] = l.keys[i];
        const [, , bx, by, bw, bh] = l.keys[j];
        const ox = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
        const oy = Math.min(ay + ah, by + bh) - Math.max(ay, by);
        // An ISO Enter is drawn as its 1.5 x 2 bounding box, which reaches 0.25 into the key beside it.
        assert.ok(!(ox > 0.35 && oy > 0.15), `layout ${n}: keys ${l.keys[i][0]} and ${l.keys[j][0]} overlap`);
      }
  }
  // 104-key full size: the K556 family; Fn is a locked key.
  const k556 = layoutForProduct("7555USHEXYXCPARGB")!;
  assert.equal(k556.layout.keys.filter((k) => !k.locked).length, 103);
  assert.deepEqual(k556.layout.keys.filter((k) => k.locked).map((k) => k.label), ["Fn"]);
  assert.ok(k556.layout.units.w >= 21 && k556.layout.units.w <= 23, String(k556.layout.units.w));
  // The factory entry of an ordinary key is its HID usage; Fn is illumipc's Fn action.
  const esc = k556.layout.keys.find((k) => k.label === "Esc")!;
  assert.deepEqual(esc.factory, [0, 0x29, 0, 0]);
  assert.equal(k556.layout.keys.find((k) => k.index === 22)!.label, "`", "slot 22 is the grave key on this board, not Esc");
});

test("every board gets a layout, an ISO or ANSI type that matches its code, and illumipc's own fallback is said out loud", () => {
  for (const b of ILLUMIPC_BOARDS) {
    const r = layoutForProduct(b.product);
    assert.ok(r, b.product);
    assert.equal(r.known, true);
    assert.equal(boardForProduct(b.product.toLowerCase())?.product, b.product, "case does not matter");
    if (b.brand !== "MAGIC-REFINER") assert.ok(r.layout.id.startsWith("catalog-"), b.product);
  }
  const fb = ILLUMIPC_BOARDS.filter((b) => b.layoutFrom);
  assert.deepEqual(fb.map((b) => [b.product, b.layoutFrom]), [["K1USliteBYHEARGB", "SI2828HEARGB"]]);
  assert.equal(layoutForProduct("7295UKHEXYXK552JCARGB")!.layout.usType, false, "illumipc's 'uk' type");
  assert.equal(layoutForProduct("7272USHEXYXK673JCARGB")!.layout.usType, true);
  assert.equal(layoutForProduct("SOLO30QMHMHEARGB")!.layout.keys.length, 29);
});

test("the X68 HE family behaves as it did: the three known codes, the prefix rule, nothing else", () => {
  assert.equal(layoutForProduct("AK1680UKX68ZAXHEARGB")?.layout.id, "iso-uk");
  assert.equal(layoutForProduct("AK1680BRX68ZAXHEARGB")?.layout.id, "iso-br");
  assert.equal(layoutForProduct("AK1680GUKX68XYXCPHEARGB")?.layout.id, "iso");
  assert.equal(layoutForProduct("AK1680GUSHEARGB")?.layout.id, "ansi");
  assert.equal(layoutForProduct("AK1680GUSHEARGB")?.known, false);
  assert.equal(layoutForProduct("SI2828HEARGB"), null);
  assert.equal(layoutForProduct("ZZ0001"), null);
  assert.equal(layoutForProduct(" ak1680gushearGB ")?.layout.id, "ansi", "case and spaces don't matter");
  assert.equal(X68_LAYOUTS.ansi.keys.length, 68);
});

test("identities: the catalogue names its boards; any X68-looking board is the MAGIC-REFINER X68 HE; the rest are 'HE keyboard (code)'", () => {
  assert.deepEqual(identityFor("7272USHEXYXK673JCARGB", "K673"), { brand: "Redragon", model: "K673WB-RGB-M", name: "Redragon K673WB-RGB-M", x68: false });
  assert.deepEqual(identityFor("KF068USHEARGB", "x"), { brand: "Womier", model: "M68HE PRO", name: "Womier M68HE PRO", x68: false });
  assert.equal(identityFor("7555USHEXYXCPARGB", "").model, "7555USHEXYXCPARGB", "illumipc lists no model name for this one: the code stands in");
  assert.deepEqual(identityFor("AK1680UKX68ZAXHEARGB", "X68HE"), { brand: "MAGIC-REFINER", model: "X68 HE", name: "MAGIC-REFINER X68 HE", x68: true });
  assert.equal(identityFor("AK1680GUSXX68HEARGB", "X68HE").x68, true, "the friend's board, whichever AK168x code it reports");
  assert.equal(identityFor("AK1680GUSHEARGB", "X68 HE").x68, true);
  assert.deepEqual(identityFor("AK1681GUSXQMXTHEARGB", "Some board"), { brand: "", model: "AK1681GUSXQMXTHEARGB", name: "HE keyboard (AK1681GUSXQMXTHEARGB)", x68: false });
});

test("the allowlist is the same one for every board: a trigger write passes, a reset or calibration frame never does", () => {
  const frames = encodeTriggerWrites([{ index: 68, mode: 13, travel: 120, press: 15, release: 20 }]);
  assert.ok(frames.length >= 1);
  for (const f of frames) assert.equal(checkFrame(f).ok, true);
  for (const bytes of [[0x0b], [0x14, 0, 0, 0, 1, 1], [0x21, 0, 0, 0, 24, 6], [0x23, 0, 0, 0, 1], [0x14, 3, 0, 0, 1, 1, 1]]) {
    const g = new Uint8Array(63);
    g.set(bytes);
    assert.equal(checkFrame(g).ok, false, bytes.join(","));
  }
});
