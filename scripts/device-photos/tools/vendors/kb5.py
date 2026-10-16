"""Keyboards of wave B: Keychron / Lemokey Hall-effect boards, Redragon boards on the illumipc driver, Epomaker HE30, Womier M68HE PRO and Royal Kludge's
SparkLink C-series. Pictures come from the makers' own Shopify stores (keychron.com, www.lemokey.com, redragonshop.com, epomaker.com, womierkeyboard.com,
rkgamingstore.com), product matched by model name; candidates are reviewed by eye (cands.py), cut with the flood fill in proc.py (no matting model).
The rows (names and USB ids each picture answers to) are written by tools/gen_kb5_rows.mjs from the drivers' own tables into kb5-rows.json."""
import json, pathlib, sys
from common import ROOT, job, slug
import shop
from vendors.shopkb import KB_NOISE, KB_DISC

HERE = pathlib.Path(__file__).resolve().parent.parent
# (brand, store, query, key, display name, ids, extra names)
ROWS = json.load(open(HERE / "kb5-rows.json", encoding="utf8"))


def candidates():
    cats = {}
    out = []
    for brand, store, query, key, name, ids, names in ROWS:
        cat = cats.get(store) or cats.setdefault(store, shop.catalog(store, shop.BAD_KB - {"pad"}))   # Keychron's Q0 HE is a number pad
        p = shop.best(cat, query, brand, disc=KB_DISC, noise=KB_NOISE)
        if not p:
            print("  no product:", key, file=sys.stderr)
            continue
        out.append(dict(key=key, vendor=slug(brand), name=name, kind="keyboard", ids=ids, page=f"https://{store}/products/{p['handle']}", names=[name] + names,
                        note=f"{store} product '{p['title']}'",
                        urls=[(im["src"] + ("&width=1100" if "cdn.shopify" in im["src"] else "")) for im in p["images"][:8]]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "kb5.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"], None)
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
