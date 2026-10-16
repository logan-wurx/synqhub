"""Mice whose makers have no usable store: the authorized retailer mechkeys.com (Shopify), product chosen by title pattern, rembg cut, reviewed by eye."""
import json, re, sys
from common import ROOT, job, slug, fetch
import shop
from vendors.stores2 import omids

STORE = "mechkeys.com"
# (brand, title regex, key, display name, OM model regex for ids, extra names)
ROWS = [
    ("Incott", "handle:incott-g23-v2", "incott-g23-v2", "Incott G23 V2", r"g23 v2", ["g23 v2", "g23v2", "g23 v2 pro", "g23v2 pro", "incott g23 v2", "incott g23v2 pro", "g23 v2 se", "g23", "g23 pro", "incott g23", "incott g23 pro"]),
    ("Incott", r"^Incott GHERO", "incott-ghero", "Incott GHERO", r"ghero", ["ghero", "ghero pro", "incott ghero", "incott ghero pro"]),
    ("Incott", r"^Incott G24", "incott-g24", "Incott G24", r"g24", ["g24", "g24 pro", "incott g24", "incott g24 pro"]),
    ("Incott", r"^Incott 029", "incott-zero-29", "Incott Zero 29", r"zero 29", ["zero 29", "zero 29 pro", "incott zero 29", "incott zero 29 pro", "029", "incott 029"]),
    ("Incott", r"^Incott\s+039", "incott-zero-39", "Incott Zero 39", r"zero 39", ["zero 39", "zero 39 pro", "incott zero 39", "incott zero 39 pro", "039", "incott 039"]),
    ("RAWM", r"^RAWM ER21PRO", "rawm-er21-pro", "RAWM ER21 Pro", r"er21", ["er21 pro", "er21m", "er21", "rawm er21 pro", "rawm er21m"]),
    ("RAWM", r"^RAWM ES21 Series", "rawm-es21", "RAWM ES21", r"es21", ["es21", "es21 pro", "es21m", "rawm es21", "rawm es21 pro", "rawm es21m"]),
    ("RAWM", r"^RAWM SA-MH01PRO", "rawm-mh01-pro", "RAWM MH01 Pro", r"mh01", ["mh01 pro", "mh01", "sa mh01 pro", "rawm mh01 pro", "rawm mh01"]),
    ("Delux", r"^DELUX M800mini", "delux-m800-mini", "Delux M800 Mini", r"m800", ["m800 mini", "m800", "delux m800 mini", "m800mini"]),
    ("Rapoo", r"^Rapoo VT9PRO", "rapoo-vt9-pro", "Rapoo VT9 Pro", r"vt9", ["vt9 pro", "vt9", "rapoo vt9 pro"]),
    ("Attack Shark", r"^ATTACK SHARK X6", "attack-shark-x6", "Attack Shark X6", r"^x6$", ["x6", "attack shark x6"]),
]


def candidates():
    cat = shop.catalog(STORE, set())
    out = []
    for brand, rx, key, name, omrx, names in ROWS:
        if rx.startswith("handle:"):
            try:
                h = fetch(f"https://{STORE}/products/{rx[7:]}", text=True)
            except Exception as e:
                print("  page gone:", key, str(e)[:50], file=sys.stderr)
                continue
            imgs = []
            for s_ in re.findall(r'<script type="application/ld\+json">(.*?)</script>', h, re.S):
                try:
                    jj = json.loads(s_)
                except Exception:
                    continue
                for j2 in (jj if isinstance(jj, list) else [jj]):
                    if isinstance(j2, dict) and j2.get("@type") in ("Product", "ProductGroup") and j2.get("image"):
                        im = j2["image"]
                        imgs += im if isinstance(im, list) else [im]
            imgs += re.findall(r'og:image" content="([^"]+)', h)
            p = {"title": rx[7:], "handle": rx[7:], "images": [{"src": u.split("&width")[0]} for u in dict.fromkeys(imgs)]}
        else:
            p = next((x for x in cat if re.search(rx, x["title"], re.I)), None)
        if not p:
            print("  no product:", key, file=sys.stderr)
            continue
        out.append(dict(key=key, vendor=slug(brand), name=name, kind="mouse", ids=omids(brand, omrx), page=f"https://{STORE}/products/{p['handle']}", names=[name] + names,
                        note=f"authorized retailer {STORE}, product '{p['title']}'", urls=[(i["src"] + ("&" if "?" in i["src"] else "?") + "width=1100") for i in p["images"][:6]]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "retail2.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
