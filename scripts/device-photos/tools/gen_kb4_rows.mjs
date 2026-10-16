// Prints the ROWS of vendors/kb4.py: which pictures the 0x19F5 family (NuPhy, MCHOSE, RK Gcome) and Royal Kludge's BeiYing boards get, with every
// USB id of the models that share a shell. The ids come from the drivers' own tables, so a new model only needs a row here.
//   node scripts/device-photos/tools/gen_kb4_rows.mjs > rows.txt   (then paste into vendors/kb4.py; the mchose-jet75 row is left out: that picture
//   exists and its ids come from aliases.json; the shared id 3837:3033 is on no picture)
import * as C from "../../../src/lib/brands/rk-beiying/catalog.generated.ts";
import * as F from "../../../src/lib/brands/fw19f5/index.ts";
const hex = (v, p) => `${v.toString(16).padStart(4, "0")}:${p.toString(16).padStart(4, "0")}`;
const rows = [];
const add = (brand, store, query, key, name, ids, names) => rows.push([brand, store, query, key, name, [...new Set(ids)].sort(), names]);
const nu = (names) => F.FW_MODELS.filter((m) => m.family === "nuphy" && names.includes(m.name)).map((m) => hex(m.vendorId, m.productId));
const mc = (pred) => F.FW_MODELS.filter((m) => m.family === "mchose" && m.board && pred(m.board)).flatMap((m) => m.board.ids.map(([v, p]) => hex(v, p)));

// ---- NuPhy (pay.nuphy.com, NuPhy's own Shopify store)
const N = "pay.nuphy.com";
add("NuPhy", N, "NuPhy Air75 V3", "nuphy-air75-v3", "NuPhy Air75 V3", nu(["Air75 V3", "Air75 V3 (ISO)", "Air75 V3 (JIS)"]), ["air75 v3", "nuphy air75 v3", "air75 v3 iso", "air75 v3 jis"]);
add("NuPhy", N, "NuPhy Air65 V3", "nuphy-air65-v3", "NuPhy Air65 V3", nu(["Air65 V3", "Air65 V3 (ISO)", "Air65 V3 (JIS)"]), ["air65 v3", "nuphy air65 v3", "air65 v3 iso", "air65 v3 jis"]);
add("NuPhy", N, "NuPhy Air100 V3", "nuphy-air100-v3", "NuPhy Air100 V3", nu(["Air100 V3", "Air100 V3 (ISO)", "Air100 V3 (JIS)"]), ["air100 v3", "nuphy air100 v3", "air100 v3 iso", "air100 v3 jis"]);
add("NuPhy", N, "NuPhy Node75 Low-profile", "nuphy-node75", "NuPhy Node75", nu(["Node75", "Node75 (ISO)", "Node75 (JIS)"]), ["node75", "nuphy node75", "node75 iso", "node75 jis"]);
add("NuPhy", N, "NuPhy Node75 High-profile", "nuphy-node75-high", "NuPhy Node75 High", nu(["Node75 High", "Node75 High (ISO)", "Node75 High (JIS)"]), ["node75 high", "nuphy node75 high", "node75 high iso", "node75 high jis"]);
add("NuPhy", N, "NuPhy Node100 Low-profile", "nuphy-node100", "NuPhy Node100", nu(["Node100", "Node100 (ISO)", "Node100 (JIS)"]), ["node100", "nuphy node100", "node100 iso", "node100 jis"]);
add("NuPhy", N, "NuPhy Node100 High-profile", "nuphy-node100-high", "NuPhy Node100 High", nu(["Node100 High", "Node100 High (ISO)", "Node100 High (JIS)"]), ["node100 high", "nuphy node100 high", "node100 high iso", "node100 high jis"]);
add("NuPhy", N, "NuPhy Kick75", "nuphy-kick75", "NuPhy Kick75", nu(["Kick75", "Kick75 High"]), ["kick75", "nuphy kick75", "kick75 high"]);
add("NuPhy", N, "NuPhy Halo75 V2", "nuphy-halo75-v2", "NuPhy Halo75 V2", nu(["Halo75 V2 (ISO)"]), ["halo75 v2", "nuphy halo75 v2", "halo75 v2 iso"]);
add("NuPhy", N, "NuPhy Halo96 V2", "nuphy-halo96-v2", "NuPhy Halo96 V2", nu(["Halo96 V2 (ISO)"]), ["halo96 v2", "nuphy halo96 v2", "halo96 v2 iso"]);
add("NuPhy", N, "NuPhy Field75 HE V2", "nuphy-field75-he-v2", "NuPhy Field75 HE V2", nu(["Field75 HE V2"]), ["field75 he v2", "nuphy field75 he v2"]);
add("NuPhy", N, "NuPhy Gem80", "nuphy-gem80-he", "NuPhy Gem80 HE", nu(["Gem80 HE"]), ["gem80 he", "nuphy gem80 he", "gem80"]);
add("NuPhy", N, "NuPhy WH80 Gaming", "nuphy-wh80", "NuPhy WH80", nu(["WH80"]), ["wh80", "nuphy wh80"]);
add("NuPhy", N, "NuPhyX BH65", "nuphy-bh65-he", "NuPhy BH65 HE", nu(["BH65 HE"]), ["bh65 he", "nuphy bh65 he", "bh65", "nuphyx bh65"]);

// ---- MCHOSE (mchose.store, MCHOSE's official Shopify store)
const M = "mchose.store";
const byName = (re) => mc((b) => re.test(b.name));
add("MCHOSE", M, "MCHOSE Ace 60 Pro", "mchose-ace60-pro", "MCHOSE Ace 60 Pro", byName(/^Ace 60/), ["ace 60 pro", "mchose ace 60 pro", "ace 60", "mchose ace 60", "ace 60x", "ace 60 pro iso fr", "ace 60 pro nordic"]);
add("MCHOSE", M, "MCHOSE Ace 68", "mchose-ace68", "MCHOSE Ace 68", mc((b) => ["mc-ace68-2114", "mc-ace68pro-2116", "mc-ace68pro-3003", "mc-ace68pro-3024"].includes(b.id)), ["ace 68", "mchose ace 68", "ace 68 v2"]);
add("MCHOSE", M, "MCHOSE Ace 68 Air", "mchose-ace68-air", "MCHOSE Ace 68 Air", mc((b) => /Air/.test(b.name)), ["ace 68 air", "mchose ace 68 air", "ace 68 air 2"]);
add("MCHOSE", M, "MCHOSE Ace 68 GT", "mchose-ace68-gt", "MCHOSE Ace 68 GT", mc((b) => b.id === "mc-ace68pro-3007"), ["ace 68 gt", "mchose ace 68 gt"]);
add("MCHOSE", M, "MCHOSE Ace 68 Turbo", "mchose-ace68-turbo", "MCHOSE Ace 68 Turbo", mc((b) => /Turbo/.test(b.name)), ["ace 68 turbo", "mchose ace 68 turbo", "ace 68 turbo 8k", "ace 68 turbo 16k"]);
add("MCHOSE", M, "MCHOSE Mix 87", "mchose-mix87", "MCHOSE Mix 87", mc((b) => /Mix 87/.test(b.name)), ["mix 87", "mchose mix 87"]);
add("MCHOSE", M, "MCHOSE K99 V3", "mchose-k99-v3", "MCHOSE K99 V3", mc((b) => b.id === "mc-K99-2020").filter((id) => id !== "3837:3033"), ["k99 v3", "mchose k99 v3"]);
add("MCHOSE", M, "MCHOSE Jet 75", "mchose-jet75", "MCHOSE Jet 75", mc((b) => /^Jet 75/.test(b.name)), ["jet 75", "mchose jet 75", "jet75"]);

// ---- Royal Kludge (rkgamingstore.com, RK's own Shopify store)
const R = "rkgamingstore.com";
const rk = (re) => C.RK_BOARDS.filter((b) => re.test(b.name)).map((b) => hex(0x258a, b.pid));
const rkn = (re) => C.RK_BOARDS.filter((b) => re.test(b.name)).map((b) => b.name);
const grp = (key, query, name, re, extra = []) => add("Royal Kludge", R, query, key, name, rk(re), [name, ...extra]);
grp("royal-kludge-rk61", "RK61", "RK61", /^(RK[- ]?61|RK 61|RK858)/i, ["rk61", "rk 61", "rk61 keyboard", "rk-61 keyboard", "rk61rgb"]);
grp("royal-kludge-rk68", "RK68", "RK68", /^(RK[- ]?68|68RGB|RK-G68|G68|RKG68)/i, ["rk68", "rk-68", "rk68plus", "rk68pro", "rkg68", "rk68rgb"]);
grp("royal-kludge-rk71", "RK71", "RK71", /^RK71/i, ["rk71", "rk71rgb"]);
grp("royal-kludge-rk84", "RK84", "RK84", /^RK84/i, ["rk84", "rk84rgb", "rk84 pro"]);
grp("royal-kludge-rk89", "RK89", "RK89", /^RK89/i, ["rk89", "rk89rgb"]);
grp("royal-kludge-rk96", "RK96", "RK96", /^RK96/i, ["rk96", "rk96 rgb"]);
grp("royal-kludge-rk920", "RK920", "RK920", /^RK920/i, ["rk920", "rk920rgb"]);
grp("royal-kludge-sink87g", "Sink87G", "RK Sink87G", /^Sink87G/i, ["sink87g", "rk sink87g"]);
grp("royal-kludge-m75", "M75", "RK M75", /M75/i, ["m75", "rk m75", "rk-m75", "rk-m75rgb", "m75n"]);
grp("royal-kludge-f68", "F68", "RK F68", /F68/i, ["f68", "rk f68", "rk-f68"]);
grp("royal-kludge-l75", "L75", "RK L75", /L75/i, ["l75", "rk l75"]);
grp("royal-kludge-l98", "L98", "RK L98", /L98/i, ["l98", "rk l98"]);
grp("royal-kludge-r65", "R65 Wired", "RK R65", /R65/i, ["r65", "rk-r65", "rk-r65rgb", "r65rgb"]);
grp("royal-kludge-r75", "R75 Wired", "RK R75", /R75/i, ["r75", "rk-r75", "r75rgb"]);
grp("royal-kludge-r87-pro", "R87 PRO TKL Wired", "RK R87 Pro", /R87PRO/i, ["r87 pro", "r87pro", "rk r87 pro"]);
grp("royal-kludge-f99", "F99", "RK F99", /F99/i, ["f99", "rk f99"]);
// RK's "Gcome" firmware boards
add("Royal Kludge", R, "R99", "royal-kludge-r99", "RK R99", F.FW_MODELS.filter((m) => m.family === "rk-gcome" && /^R99/.test(m.name)).map((m) => hex(m.vendorId, m.productId)), ["r99", "rk r99"]);

// Report any id used twice.
const seen = new Map();
for (const r of rows) for (const id of r[5]) { if (seen.has(id)) console.error("DUP", id, seen.get(id), r[3]); seen.set(id, r[3]); }
const py = (v) => JSON.stringify(v);
console.log("ROWS = [");
for (const r of rows) console.log(`    (${py(r[0])}, ${py(r[1])}, ${py(r[2])}, ${py(r[3])}, ${py(r[4])}, ${py(r[5])}, ${py(r[6])}),`);
console.log("]");
console.error(rows.length, "rows,", seen.size, "ids");
