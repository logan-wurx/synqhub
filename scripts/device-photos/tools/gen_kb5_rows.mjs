// Writes kb5-rows.json next to this file: which pictures wave B keyboards get (Keychron / Lemokey Hall-effect boards, Redragon boards on the
// illumipc driver, Epomaker, Womier, Royal Kludge's SparkLink C-series), with the names and USB ids each picture answers to.
//   node scripts/device-photos/tools/gen_kb5_rows.mjs
// The ids and names come from the drivers' own tables (src/lib/kb/via/keychron/catalog.generated.ts, src/lib/illumipc/catalog.generated.ts,
// src/lib/brands/sparklink/devices.ts), so a new model only needs a row here. vendors/kb5.py reads the result.
//
// Shared USB ids are on no picture: 2E3C:C365..C368 and 0416:7372 are worn by hundreds of illumipc boards (the product code tells them apart, so
// the panel names the board and the picture is found by name), and a Redragon / Epomaker / Womier picture lists names only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KC_MODELS } from "../../../src/lib/kb/via/keychron/devices.ts";
import { ILLUMIPC_BOARDS } from "../../../src/lib/illumipc/catalog.generated.ts";
import { SPARKLINK_MODELS } from "../../../src/lib/brands/sparklink/devices.ts";

const hex = (v, p) => `${v.toString(16).padStart(4, "0")}:${p.toString(16).padStart(4, "0")}`;
const norm = (s) => s.toLowerCase().replace(/\+/g, " plus ").replace(/&/g, " and ").split(/[^a-z0-9]+/).filter(Boolean).join(" ");
const rows = [];
// [brand, store, query, key, display name, ids, extra names]
const add = (brand, store, query, key, name, ids, names) => rows.push([brand, store, query, key, name, [...new Set(ids)].sort(), [...new Set(names.map(norm))]]);

// ---- Keychron / Lemokey (keychron.com, www.lemokey.com): new models only; q1/q3/q5/k2/p1 exist and get their other ids from aliases.json
const kc = (brand, name) => KC_MODELS.filter((m) => m.brand === brand && m.name === name).map((m) => hex(m.vendorId, m.productId));
for (const n of ["Q0", "Q2", "Q4", "Q6", "Q12", "K4", "K6", "K8", "K10"]) {
  add("Keychron", "keychron.com", `Keychron ${n} HE`, `keychron-${n.toLowerCase()}-he`, `Keychron ${n} HE`, kc("Keychron", `${n} HE`), [`${n} HE`, `Keychron ${n} HE`]);
}
for (const n of ["L1", "P2", "P3"]) {
  add("Lemokey", "www.lemokey.com", `Lemokey ${n} HE`, `lemokey-${n.toLowerCase()}-he`, `Lemokey ${n} HE`, kc("Lemokey", `${n} HE`), [`${n} HE`, `Lemokey ${n} HE`]);
}

// ---- Redragon (redragonshop.com): the catalogue's model names of a family are all answers to one picture. Families with no Hall-effect
// product in the store (K552, K701, K721, M68, M82, RS82) are left to the drawn keyboard.
const RD = [
  ["K617", "FIZZ K617 HE", "redragon-k617-he", "Redragon K617 HE"],
  ["K618", "HORUS K618 HE", "redragon-k618-he", "Redragon K618 HE"],
  ["K580", "VATA K580 HE", "redragon-k580-he", "Redragon K580 HE"],
  ["K556", "DHARMA K556 HE", "redragon-k556-he", "Redragon K556 HE"],
  ["K673", "UCAL K673 HE", "redragon-k673-he", "Redragon K673 HE"],
  ["K707", "STAR BLADE K707 HE", "redragon-k707-he", "Redragon K707 HE"],
  ["K686", "EISA K686 HE", "redragon-k686-he", "Redragon K686 HE"],
  ["M61", "FIDD K683", "redragon-m61", "Redragon M61 (K683)"],
];
for (const [fam, query, key, name] of RD) {
  const names = ILLUMIPC_BOARDS.filter((b) => b.brand === "Redragon" && b.name.toUpperCase().startsWith(fam)).map((b) => b.name);
  if (!names.length) throw new Error(`no catalogue model for ${fam}`);
  const base = fam === "M61" ? ["M61", "Redragon M61", "K683", "Redragon K683"] : [`${fam} HE`, `Redragon ${fam} HE`, fam];
  add("Redragon", "redragonshop.com", query, key, name, [], [...base, ...names, ...names.map((n) => `Redragon ${n}`)]);
}

// ---- Epomaker and Womier: names only (the id is shared)
add("Epomaker", "epomaker.com", "EPOMAKER HE30", "epomaker-he30", "Epomaker HE30", [], ["HE30", "Epomaker HE30"]);
add("Womier", "womierkeyboard.com", "Womier M68HE PRO", "womier-m68he-pro", "Womier M68HE PRO", [], ["M68HE PRO", "Womier M68HE PRO"]);

// ---- Royal Kludge SparkLink C-series (rkgamingstore.com): every id of a model (the DE / FR / ES / JP / V2 variants share a shell)
const sl = (re) => SPARKLINK_MODELS.filter((m) => m.brand === "Royal Kludge" && re.test(m.name)).map((m) => hex(m.vendorId, m.productId));
for (const [n, q] of [["C68", "C68"], ["C84", "C84"], ["C87", "C87"], ["C96", "C96"], ["C98", "C98"]]) {
  add("Royal Kludge", "rkgamingstore.com", q, `royal-kludge-${n.toLowerCase()}`, `RK ${n}`, sl(new RegExp(`^${n}( |$)`)), [`RK ${n}`, n, `Royal Kludge ${n}`]);
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "kb5-rows.json");
fs.writeFileSync(out, JSON.stringify(rows, null, 1) + "\n");
console.log(`${rows.length} rows -> ${out}`);
for (const r of rows) console.log(r[3].padEnd(24), r[5].length, "ids", r[6].length, "names");
