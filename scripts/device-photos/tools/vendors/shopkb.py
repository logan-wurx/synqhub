"""Keyboards of the store-based makers (Shopify / WooCommerce): product matched by model name, candidates reviewed by eye (cands.py)."""
import json, sys
from common import ROOT, job, slug
import shop

KB_NOISE = shop.NOISE | {"magnetic", "switch", "switches", "custom", "qmk", "via", "he", "version", "layout", "compact", "tkl", "ansi", "iso", "us", "keyboard", "keyboards", "mechanical", "adjustable",
                         "actuation", "distance", "best", "budget", "gear", "greatest", "weapon", "future", "your", "the", "hot", "swappable", "barebone", "assembled", "fully", "kit", "edition",
                         "collection", "special", "all", "wood", "resin", "concrete", "copper", "tmr", "rt", "rapid", "trigger", "one", "handed"}
KB_DISC = {"pro", "max", "mini", "ultra", "plus", "lite", "v2", "v3", "v4", "v5", "air", "se", "ii", "m", "l", "s", "x", "master", "jp"}


def i(vid, *pids):
    return [f"{vid}:{p:04x}" for p in pids]


W = "woo:https://www.monsgeek.com"
A = "woo:https://en.akkogear.com"
# (brand, store, query, key, display name, ids, extra names)
ROWS = [
    ("DrunkDeer", "drunkdeer.com", "DrunkDeer A75 Pro", "drunkdeer-a75-pro", "DrunkDeer A75 Pro", i("352d", 0x2383), ["a75", "a75 pro", "a75 iso", "a75 ultra", "a75 master", "drunkdeer a75"]),
    ("DrunkDeer", "drunkdeer.com", "DrunkDeer G65", "drunkdeer-g65", "DrunkDeer G65", i("352d", 0x2382, 0x2390, 0x23b4, 0x23b5), ["g65", "g65 lite", "g65 m1", "g65 m2", "g65 m3"]),
    ("DrunkDeer", "drunkdeer.com", "DrunkDeer G60", "drunkdeer-g60", "DrunkDeer G60", i("352d", 0x2384, 0x2394, 0x23b3, 0x23b6), ["g60", "g60 m1", "g60 m2", "g60 m3"]),
    ("DrunkDeer", "drunkdeer.com", "DrunkDeer G75", "drunkdeer-g75", "DrunkDeer G75", i("352d", 0x2386, 0x2391), ["g75", "g75 jp"]),
    ("DrunkDeer", "drunkdeer.com", "X60", "drunkdeer-x60", "DrunkDeer X60", i("1a81", 0x2094), ["x60", "x60he"]),
    ("Keychron", "keychron.com", "Keychron Q1 HE", "keychron-q1-he", "Keychron Q1 HE", i("3434", 0x0b10, 0x0b11, 0x0b12), ["q1 he", "keychron q1 he"]),
    ("Keychron", "keychron.com", "Keychron Q3 HE", "keychron-q3-he", "Keychron Q3 HE", i("3434", 0x0b30), ["q3 he", "keychron q3 he"]),
    ("Keychron", "keychron.com", "Keychron Q5 HE", "keychron-q5-he", "Keychron Q5 HE", i("3434", 0x0b50), ["q5 he", "keychron q5 he"]),
    ("Keychron", "keychron.com", "Keychron K2 HE", "keychron-k2-he", "Keychron K2 HE", i("3434", 0x0e20, 0x0e21, 0x0e22), ["k2 he", "keychron k2 he"]),
    ("Lemokey", "www.lemokey.com", "Lemokey P1 HE", "lemokey-p1-he", "Lemokey P1 HE", i("362d", 0x0610, 0x0611), ["p1 he", "lemokey p1 he"]),
    ("AJAZZ", "www.ajazzstore.com", "AJAZZ AK820 Max", "ajazz-ak820-max", "AJAZZ AK820 MAX", i("0c45", 0x8033, 0x8044, 0x8070, 0x809b, 0x80a0, 0x80a5, 0x80b1), ["ak820 max", "ak820max", "ajazz ak820max"]),
    ("AJAZZ", "www.ajazzstore.com", "AJAZZ AK980", "ajazz-ak980", "AJAZZ AK980", i("0c45", 0x8800), ["ak980", "ak980 max"]),
    ("AULA", "aulagear.com", "AULA F65", "aula-f65", "AULA F65", i("0c45", 0x8032), ["f65", "aula f65"]),
    # MonsGeek / Akko (WooCommerce stores): a model is told apart by name, never by the shared USB id
    ("MonsGeek", W, "MonsGeek FUN60 Pro", "monsgeek-fun60-pro", "MonsGeek FUN60 Pro", [], ["fun60 pro", "monsgeek fun60 pro"]),
    ("MonsGeek", W, "MonsGeek FUN60 Max", "monsgeek-fun60-max", "MonsGeek FUN60 Max", [], ["fun60 max", "monsgeek fun60 max"]),
    ("MonsGeek", W, "MonsGeek FUN60 Ultra", "monsgeek-fun60-ultra", "MonsGeek FUN60 Ultra", [], ["fun60 ultra", "monsgeek fun60 ultra"]),
    ("MonsGeek", W, "MonsGeek FUN68", "monsgeek-fun68", "MonsGeek FUN68", [], ["fun68", "monsgeek fun68"]),
    ("MonsGeek", W, "MonsGeek FUN75", "monsgeek-fun75", "MonsGeek FUN75", [], ["fun75", "monsgeek fun75"]),
    ("MonsGeek", W, "MonsGeek M1 V5", "monsgeek-m1-v5", "MonsGeek M1 V5 HE", [], ["m1 v5 he", "m1 v5 tmr", "m1 v5", "monsgeek m1 v5 he", "monsgeek m1 v5 tmr"]),
    ("MonsGeek", W, "MonsGeek M2 V5", "monsgeek-m2-v5", "MonsGeek M2 V5 HE", [], ["m2 v5 he", "m2 v5", "monsgeek m2 v5 he"]),
    ("MonsGeek", W, "MonsGeek M3 V5", "monsgeek-m3-v5", "MonsGeek M3 V5 HE", [], ["m3 v5 he", "m3 v5", "monsgeek m3 v5 he"]),
    ("MonsGeek", W, "MonsGeek Verve68", "monsgeek-verve68", "MonsGeek Verve68", [], ["verve68", "verve68t", "monsgeek verve68"]),
    ("MonsGeek", W, "MonsGeek Shine68", "monsgeek-shine68", "MonsGeek Shine68", [], ["shine68", "monsgeek shine68"]),
    ("Akko", A, "Akko MOD007 V5 HE", "akko-mod007-v5-he", "Akko MOD007 V5 HE", [], ["mod007 v5 he", "akko mod007 v5 he"]),
    ("Akko", A, "Akko 5075B V2 HE", "akko-5075b-v2-he", "Akko 5075B V2 HE", [], ["5075b v2 he", "akko 5075b v2 he"]),
    ("Akko", A, "Akko 5075S HE", "akko-5075s-he", "Akko 5075S HE", [], ["5075s he", "akko 5075s he"]),
    ("Akko", A, "Akko TAC75 HE", "akko-tac75-he", "Akko TAC75 HE", [], ["tac75 he", "akko tac75 he"]),
    ("Akko", A, "Akko RAY68", "akko-ray68", "Akko RAY68", [], ["ray68", "akko ray68"]),
    ("Akko", A, "Akko 5087S V2 HE", "akko-5087s-v2-he", "Akko 5087S V2 HE", [], ["5087s v2 he", "akko 5087s v2 he"]),
    ("Akko", A, "Akko 5108 V5 HE", "akko-5108-v5-he", "Akko 5108 V5 HE", [], ["5108 v5 he", "akko 5108 v5 he"]),
    ("MonsGeek", W, "MonsGeek MG75S HE", "monsgeek-mg75s-he", "MonsGeek MG75S HE", [], ["mg75s he", "monsgeek mg75s he"]),
    ("MonsGeek", W, "MonsGeek M1W V3 HE", "monsgeek-m1w-he", "MonsGeek M1W HE", [], ["m1w he", "m1w v3 he", "monsgeek m1w he"]),
    ("Akko", A, "Akko 5075 V5 HE", "akko-5075-v5-he", "Akko 5075 V5 HE", [], ["5075 v5 he", "akko 5075 v5 he"]),
    ("Akko", A, "Akko 5087 V3 HE", "akko-5087-v3-he", "Akko 5087 V3 HE", [], ["5087 v3 he", "akko 5087 v3 he"]),
    ("Akko", A, "Akko 5087 V5 HE", "akko-5087-v5-he", "Akko 5087 V5 HE", [], ["5087 v5 he", "akko 5087 v5 he"]),
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
        dom = store[4:] if store.startswith("woo:") else "https://" + store
        out.append(dict(key=key, vendor=slug(brand), name=name, kind="keyboard", ids=ids, page=f"{dom}/products/{p['handle']}", names=[name] + names,
                        note=f"{store.replace('woo:', '')} product '{p['title']}'",
                        urls=[(im["src"] + ("&width=1100" if "cdn.shopify" in im["src"] else "")) for im in p["images"][:6]]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "shopkb.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"], None)
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
