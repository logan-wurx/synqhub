"""Third pass, makers' stores and big retailers: explicit (store, title regex) rows for mice AND keyboards, every picture cut with rembg and reviewed by eye.
Row: (brand, store, title regex, key, display name, kind, ids or OpenMouse model regex, extra names)."""
import json, re, sys
from common import ROOT, job, slug
import shop
from vendors.stores2 import omids

W = "woo:https://www.monsgeek.com"
A = "woo:https://en.akkogear.com"
ROWS = [
    ("Redragon", "redragonshop.com", r"^PREDATOR M612$", "redragon-m612", "Redragon Predator M612", "mouse", r"m612", ["predator m612", "m612", "redragon predator m612", "redragon m612", "m612 rgb", "predator m612 rgb"]),
    ("Redragon", "redragonshop.com", r"^K1NG M724 \(1K", "redragon-m724", "Redragon M724 K1NG", "mouse", r"m724", ["m724 k1ng 1k", "m724 k1ng", "k1ng m724", "m724", "redragon m724 k1ng 1k", "redragon k1ng m724"]),
    ("Glorious", "gloriousgaming.com", r"^Model O3 Wireless", "glorious-model-o3", "Glorious Model O3", "mouse", r"model o3", ["model o3 wireless", "model o3", "glorious model o3 wireless", "glorious model o3", "model o 3", "model o 3 wireless"]),
    ("Attack Shark", "attackshark.com", r"^ATTACK SHARK X1 Tri-mode", "attack-shark-x1-store", "Attack Shark X1", "mouse", r"^x1$", ["x1", "attack shark x1"]),
    ("Epomaker", "epomaker.com", r"^EPOMAKER HE80$", "epomaker-he80", "Epomaker HE80", "keyboard", [], ["he80", "epomaker he80"]),
    ("CIDOO", "cidootech.com", r"^CIDOO C60 HE$", "cidoo-c60-he", "CIDOO C60 HE", "keyboard", [], ["c60", "cidoo c60", "c60 he", "cidoo c60 he"]),
    ("Lamzu", "lamzu.com", r"^LAMZU Jet75", "lamzu-jet75", "LAMZU Jet75", "keyboard", [], ["jet75", "lamzu jet75", "jet 75"]),
    ("Akko", A, r"^5075 V5 TMR$", "akko-5075-v5-he", "Akko 5075 V5 HE", "keyboard", [], ["5075 v5 he", "monsgeek 5075 v5 he", "akko 5075 v5 he", "5075b v2 he", "monsgeek 5075b v2 he", "akko 5075b v2 he"]),
    ("Akko", A, r"^5075S VIA$", "akko-5075s", "Akko 5075S", "keyboard", [], ["5075s he", "5075s", "monsgeek 5075s he", "akko 5075s he"]),
    ("Akko", A, r"^Black on White 5087S QMK", "akko-5087s", "Akko 5087S", "keyboard", [], ["5087s v2 he", "5087s", "monsgeek 5087s v2 he", "akko 5087s v2 he"]),
    ("Akko", A, r"^The Legend of Hei MOD68 HE", "akko-mod68", "Akko MOD68", "keyboard", [], ["mod68", "monsgeek mod68", "akko mod68", "mod68 he"]),
    ("Akko", A, r"^Kuromi 5108 V5$", "akko-5108-v5", "Akko 5108 V5 HE", "keyboard", [], ["5108 v5 he", "monsgeek 5108 v5 he", "akko 5108 v5 he", "5108 v5"]),
    ("Akko", A, r"^Gem 02 Black\s+Silver VIA$", "akko-gem02", "Akko Gem02", "keyboard", [], ["gem02", "gem 02", "monsgeek gem02", "akko gem02"]),
    ("Akko", A, r"^Mineral 01 VIA$", "akko-mineral01", "Akko Mineral01", "keyboard", [], ["mineral01", "mineral 01", "monsgeek mineral01", "akko mineral01"]),
    ("Akko", A, r"^Mineral 02 VIA$", "akko-mineral02", "Akko Mineral02", "keyboard", [], ["mineral02", "mineral 02", "monsgeek mineral02", "akko mineral02"]),
    ("Akko", A, r"^MOD007 HE Year of Dragon", "akko-mod007-v3-he", "Akko MOD007 V3 HE", "keyboard", [], ["mod007s v3 he", "mod007b v3 he", "mod007b he pc", "monsgeek mod007s v3 he", "monsgeek mod007b v3 he", "mod007 v3 he", "monsgeek mod007b he pc", "mod007s v3 he uk", "mod007b v3 he uk"]),
    ("Lamzu", "lamzu.com", r"^LAMZU THORN V2$", "lamzu-thorn-v2", "Lamzu Thorn V2", "mouse", r"thorn", ["thorn v2", "lamzu thorn v2", "thorn", "lamzu thorn", "thorn 4k", "lamzu thorn 4k", "thorn mini", "lamzu thorn mini"]),
    ("Lamzu", "lamzu.com", r"^LAMZU MAYA 4K$", "lamzu-maya", "Lamzu Maya", "mouse", r"^maya$", ["maya", "lamzu maya", "maya 4k", "lamzu maya 4k", "maya champion edition", "lamzu maya champion edition", "maya doodle", "lamzu maya doodle"]),
    ("Lamzu", "lamzu.com", r"^LAMZU PARO$", "lamzu-paro", "Lamzu Paro", "mouse", r"^$", ["paro", "lamzu paro", "paro aurora", "lamzu paro aurora"]),
    ("Lamzu", "lamzu.com", r"^LAMZU Tachi Gaming Mouse", "lamzu-tachi", "Lamzu Tachi", "mouse", r"^$", ["tachi", "lamzu tachi"]),
    ("Lamzu", "lamzu.com", r"^LAMZU ORCUS$", "lamzu-orcus", "Lamzu Orcus", "mouse", r"^$", ["orcus", "lamzu orcus"]),
    ("MonsGeek", W, r"^FUN60 Pro$", "monsgeek-fun60", "MonsGeek FUN60", "keyboard", [], ["fun60", "monsgeek fun60"]),
]


def candidates():
    cats = {}
    out = []
    for brand, store, rx, key, name, kind, ids, names in ROWS:
        cat = cats.get(store) or cats.setdefault(store, shop.catalog(store, set()))
        p = next((x for x in cat if re.search(rx, x["title"], re.I)), None)
        if not p:
            print("  no product:", key, file=sys.stderr)
            continue
        dom = store[4:] if store.startswith("woo:") else "https://" + store
        idl = ids if isinstance(ids, list) else omids(brand, ids)
        out.append(dict(key=key, vendor=slug(brand), name=name, kind=kind, ids=idl, page=f"{dom}/products/{p['handle']}", names=[name] + names,
                        note=f"{store.replace('woo:', '')} product '{p['title']}'",
                        urls=[(i["src"] + (("&" if "?" in i["src"] else "?") + "width=1100" if "cdn.shopify" in i["src"] else "")) for i in p["images"][:6]]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "stores3.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
