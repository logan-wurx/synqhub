"""Keyboards of the 0x19F5 firmware family (NuPhy, MCHOSE, Royal Kludge) and Royal Kludge's BeiYing boards: pictures from the makers' own
Shopify stores (pay.nuphy.com, mchose.store, rkgamingstore.com), product matched by model name, candidates reviewed by eye (cands2.py).
A picture lists every USB id of the models that share its shell (ISO / JIS variants, revisions); the resolver matches by id first.
The model lists come from src/lib/brands/fw19f5/devices.ts and src/lib/brands/rk-beiying/catalog.generated.ts (see tools/gen_kb4_rows.mjs)."""
import json, sys
from common import ROOT, job, slug
import shop
from vendors.shopkb import KB_NOISE, KB_DISC

# (brand, store, query, key, display name, ids, extra names)
ROWS = [
    ("NuPhy", "pay.nuphy.com", "NuPhy Air75 V3", "nuphy-air75-v3", "NuPhy Air75 V3", ["19f5:1028","19f5:1029","19f5:102a"], ["air75 v3","nuphy air75 v3","air75 v3 iso","air75 v3 jis"]),
    ("NuPhy", "pay.nuphy.com", "NuPhy Air65 V3", "nuphy-air65-v3", "NuPhy Air65 V3", ["19f5:102b","19f5:1040","19f5:1042"], ["air65 v3","nuphy air65 v3","air65 v3 iso","air65 v3 jis"]),
    ("NuPhy", "pay.nuphy.com", "NuPhy Air100 V3", "nuphy-air100-v3", "NuPhy Air100 V3", ["19f5:102d","19f5:1039","19f5:103f"], ["air100 v3","nuphy air100 v3","air100 v3 iso","air100 v3 jis"]),
    ("NuPhy", "pay.nuphy.com", "NuPhy Node75 Low-profile", "nuphy-node75", "NuPhy Node75", ["19f5:1030","19f5:1032","19f5:1034"], ["node75","nuphy node75","node75 iso","node75 jis"]),
    ("NuPhy", "pay.nuphy.com", "NuPhy Node75 High-profile", "nuphy-node75-high", "NuPhy Node75 High", ["19f5:1031","19f5:1033","19f5:1035"], ["node75 high","nuphy node75 high","node75 high iso","node75 high jis"]),
    ("NuPhy", "pay.nuphy.com", "NuPhy Node100 Low-profile", "nuphy-node100", "NuPhy Node100", ["19f5:1037","19f5:103b","19f5:103c"], ["node100","nuphy node100","node100 iso","node100 jis"]),
    ("NuPhy", "pay.nuphy.com", "NuPhy Node100 High-profile", "nuphy-node100-high", "NuPhy Node100 High", ["19f5:1036","19f5:1038","19f5:103a"], ["node100 high","nuphy node100 high","node100 high iso","node100 high jis"]),
    ("NuPhy", "pay.nuphy.com", "NuPhy Kick75", "nuphy-kick75", "NuPhy Kick75", ["19f5:1026","19f5:1027"], ["kick75","nuphy kick75","kick75 high"]),
    ("NuPhy", "pay.nuphy.com", "NuPhy Halo75 V2", "nuphy-halo75-v2", "NuPhy Halo75 V2", ["19f5:1043"], ["halo75 v2","nuphy halo75 v2","halo75 v2 iso"]),
    ("NuPhy", "pay.nuphy.com", "NuPhy Halo96 V2", "nuphy-halo96-v2", "NuPhy Halo96 V2", ["19f5:1044"], ["halo96 v2","nuphy halo96 v2","halo96 v2 iso"]),
    ("NuPhy", "pay.nuphy.com", "NuPhy Field75 HE V2", "nuphy-field75-he-v2", "NuPhy Field75 HE V2", ["19f5:6132"], ["field75 he v2","nuphy field75 he v2"]),
    ("NuPhy", "pay.nuphy.com", "NuPhy Gem80", "nuphy-gem80-he", "NuPhy Gem80 HE", ["19f5:6100"], ["gem80 he","nuphy gem80 he","gem80"]),
    ("NuPhy", "pay.nuphy.com", "NuPhy WH80 Gaming", "nuphy-wh80", "NuPhy WH80", ["19f5:a011"], ["wh80","nuphy wh80"]),
    ("NuPhy", "pay.nuphy.com", "NuPhyX BH65", "nuphy-bh65-he", "NuPhy BH65 HE", ["19f5:6130"], ["bh65 he","nuphy bh65 he","bh65","nuphyx bh65"]),
    ("MCHOSE", "mchose.store", "MCHOSE Ace 60 Pro", "mchose-ace60-pro", "MCHOSE Ace 60 Pro", ["19f5:fc30","19f5:fc31","3837:3002","3837:3040","41e4:2101","41e4:2103","41e4:2112","41e4:2126"], ["ace 60 pro","mchose ace 60 pro","ace 60","mchose ace 60","ace 60x","ace 60 pro iso fr","ace 60 pro nordic"]),
    ("MCHOSE", "mchose.store", "MCHOSE Ace 68", "mchose-ace68", "MCHOSE Ace 68", ["3837:3003","3837:3024","41e4:2114","41e4:2116"], ["ace 68","mchose ace 68","ace 68 v2"]),
    ("MCHOSE", "mchose.store", "MCHOSE Ace 68 Air", "mchose-ace68-air", "MCHOSE Ace 68 Air", ["3837:300a","41e4:2120","41e4:2132"], ["ace 68 air","mchose ace 68 air","ace 68 air 2"]),
    ("MCHOSE", "mchose.store", "MCHOSE Ace 68 GT", "mchose-ace68-gt", "MCHOSE Ace 68 GT", ["3837:3007"], ["ace 68 gt","mchose ace 68 gt"]),
    ("MCHOSE", "mchose.store", "MCHOSE Ace 68 Turbo", "mchose-ace68-turbo", "MCHOSE Ace 68 Turbo", ["3837:3026","3837:3028"], ["ace 68 turbo","mchose ace 68 turbo","ace 68 turbo 8k","ace 68 turbo 16k"]),
    ("MCHOSE", "mchose.store", "MCHOSE Mix 87", "mchose-mix87", "MCHOSE Mix 87", ["3837:300d","41e4:2122"], ["mix 87","mchose mix 87"]),
    ("MCHOSE", "mchose.store", "MCHOSE K99 V3", "mchose-k99-v3", "MCHOSE K99 V3", ["3837:2020"], ["k99 v3","mchose k99 v3"]),
    ("Royal Kludge", "rkgamingstore.com", "RK61", "royal-kludge-rk61", "RK61", ["258a:004a","258a:0055","258a:0060","258a:0065","258a:0066","258a:007a","258a:008c","258a:00b8","258a:00c6","258a:00c7","258a:00c9","258a:00e1","258a:00ec","258a:00ed","258a:00f8","258a:0183","258a:01ab"], ["RK61","rk61","rk 61","rk61 keyboard","rk-61 keyboard","rk61rgb"]),
    ("Royal Kludge", "rkgamingstore.com", "RK68", "royal-kludge-rk68", "RK68", ["258a:0048","258a:0049","258a:0052","258a:005c","258a:005e","258a:0064","258a:006f","258a:0075","258a:0079","258a:008b","258a:008e","258a:00a2","258a:00da","258a:00e7","258a:00ff","258a:0103","258a:010a","258a:013a"], ["RK68","rk68","rk-68","rk68plus","rk68pro","rkg68","rk68rgb"]),
    ("Royal Kludge", "rkgamingstore.com", "RK71", "royal-kludge-rk71", "RK71", ["258a:004d","258a:004e","258a:005a","258a:0069","258a:006a","258a:00a5","258a:00b5","258a:00ea"], ["RK71","rk71","rk71rgb"]),
    ("Royal Kludge", "rkgamingstore.com", "RK84", "royal-kludge-rk84", "RK84", ["258a:00c8","258a:00f3","258a:00f4","258a:010d"], ["RK84","rk84","rk84rgb","rk84 pro"]),
    ("Royal Kludge", "rkgamingstore.com", "RK89", "royal-kludge-rk89", "RK89", ["258a:007b","258a:009c","258a:00cd"], ["RK89","rk89","rk89rgb"]),
    ("Royal Kludge", "rkgamingstore.com", "RK96", "royal-kludge-rk96", "RK96", ["258a:0053","258a:0089","258a:00a4","258a:01c4"], ["RK96","rk96","rk96 rgb"]),
    ("Royal Kludge", "rkgamingstore.com", "RK920", "royal-kludge-rk920", "RK920", ["258a:008f"], ["RK920","rk920","rk920rgb"]),
    ("Royal Kludge", "rkgamingstore.com", "Sink87G", "royal-kludge-sink87g", "RK Sink87G", ["258a:0176"], ["RK Sink87G","sink87g","rk sink87g"]),
    ("Royal Kludge", "rkgamingstore.com", "M75", "royal-kludge-m75", "RK M75", ["258a:0147","258a:0163","258a:0175","258a:01ac"], ["RK M75","m75","rk m75","rk-m75","rk-m75rgb","m75n"]),
    ("Royal Kludge", "rkgamingstore.com", "F68", "royal-kludge-f68", "RK F68", ["258a:014e"], ["RK F68","f68","rk f68","rk-f68"]),
    ("Royal Kludge", "rkgamingstore.com", "L75", "royal-kludge-l75", "RK L75", ["258a:01e5","258a:0201","258a:0249","258a:024a"], ["RK L75","l75","rk l75"]),
    ("Royal Kludge", "rkgamingstore.com", "L98", "royal-kludge-l98", "RK L98", ["258a:01fb"], ["RK L98","l98","rk l98"]),
    ("Royal Kludge", "rkgamingstore.com", "R65 Wired", "royal-kludge-r65", "RK R65", ["258a:014a","258a:0172","258a:0184","258a:01ad","258a:01f7"], ["RK R65","r65","rk-r65","rk-r65rgb","r65rgb"]),
    ("Royal Kludge", "rkgamingstore.com", "R75 Wired", "royal-kludge-r75", "RK R75", ["258a:0151","258a:015b","258a:015e","258a:017e","258a:017f","258a:01fc"], ["RK R75","r75","rk-r75","r75rgb"]),
    ("Royal Kludge", "rkgamingstore.com", "R87 PRO TKL Wired", "royal-kludge-r87-pro", "RK R87 Pro", ["258a:019f","258a:01be"], ["RK R87 Pro","r87 pro","r87pro","rk r87 pro"]),
    ("Royal Kludge", "rkgamingstore.com", "F99", "royal-kludge-f99", "RK F99", ["258a:0218"], ["RK F99","f99","rk f99"]),
    ("Royal Kludge", "rkgamingstore.com", "R99", "royal-kludge-r99", "RK R99", ["19f5:a02c","19f5:a043","19f5:a045"], ["r99","rk r99"]),
]


def candidates():
    cats = {}
    out = []
    for brand, store, query, key, name, ids, names in ROWS:
        cat = cats.get(store) or cats.setdefault(store, shop.catalog(store, shop.BAD_KB))
        p = shop.best(cat, query, brand, disc=KB_DISC, noise=KB_NOISE)
        if not p:
            print("  no product:", key, file=sys.stderr)
            continue
        out.append(dict(key=key, vendor=slug(brand), name=name, kind="keyboard", ids=ids, page=f"https://{store}/products/{p['handle']}", names=[name] + names,
                        note=f"{store} product '{p['title']}'",
                        urls=[(im["src"] + ("&width=1100" if "cdn.shopify" in im["src"] else "")) for im in p["images"][:8]]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "kb4.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"], None)
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
