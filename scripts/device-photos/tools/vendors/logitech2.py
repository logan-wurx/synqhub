"""Logitech (MX family) from logitech.com product pages: the gallery PNGs on Logitech's DAM (resource.logitech.com), transparent. Reviewed by eye."""
import json, re, sys
from common import ROOT, job, fetch

BASE = "https://www.logitech.com/en-us/shop/p/"
DAM = re.compile(r"https://resource\.logitech\.com/[^\"' )<>\\]*?/content/dam/(logitech/en/products/[^\"' )<>\\]+?\.png)")


def i(*pids):
    return [f"046d:{p:04x}" for p in pids]


ROWS = [
    ("logitech-mx-vertical", "Logitech MX Vertical", [], ["mx vertical", "logitech mx vertical"], "mx-vertical-ergonomic-mouse"),
    ("logitech-mx-master-4", "Logitech MX Master 4", [], ["mx master 4", "mx master 4s", "logitech mx master 4", "logitech mx master 4s"], "mx-master-4"),
    ("logitech-mx-anywhere-3s", "Logitech MX Anywhere 3S", [], ["mx anywhere 3s", "logitech mx anywhere 3s"], "mx-anywhere-3s"),
    ("logitech-mx-master-3s-gallery", "Logitech MX Master 3S", [], ["mx master 3s"], "mx-master-3s"),
]


def candidates():
    res = []
    for key, name, ids, names, pg in ROWS:
        try:
            t = fetch(BASE + pg, text=True)
        except Exception as e:
            print("  no page:", key, str(e)[:60], file=sys.stderr)
            continue
        paths = []
        for m in DAM.finditer(t):
            p = m.group(1)
            if "gallery" in p and p not in paths:
                paths.append(p)
        if not paths:
            print("  no gallery images:", key, file=sys.stderr)
            continue
        res.append(dict(key=key, vendor="logitech", name=name, kind="mouse", ids=ids, page=BASE + pg, names=[name] + names, note="logitech.com product page, DAM gallery image",
                        urls=["https://resource.logitech.com/w_1100,c_limit,f_png/d_transparent.gif/content/dam/" + p for p in paths[:6]]))
    return res


def jobs():
    picks_f = ROOT / "picks" / "logitech2.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
