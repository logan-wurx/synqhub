"""Controllers whose own product page is gone (discontinued, or moved by the maker): the Wayback Machine's copy of the maker's
page -> the product pictures it linked, taken from the live CDN when the same address still answers. The same method as
wayback3.py; rows in ../tools/padswb-rows.json  [brand, key, display name, USB ids, extra names, [page url pattern, ...], picture regex]."""
import json, sys
from common import ROOT, job, slug
from vendors.wayback3 import page_pictures, live_ok, wb_ok

ROWS_FILE = ROOT / "tools" / "padswb-rows.json"


def candidates():
    out = []
    for brand, key, name, ids, names, pages, pat in json.load(open(ROWS_FILE, encoding="utf8")):
        pics = []
        for p in pages:
            pics += [x for x in page_pictures(p, pat) if x[0] not in [y[0] for y in pics]]
        urls = []
        for u, ts in pics:
            if len(urls) >= 6:
                break
            if live_ok(u):
                urls.append(u)
            elif wb_ok(ts, u):
                urls.append(f"wb:{ts}:{u}")
        if not urls:
            print("  no pictures:", key, file=sys.stderr)
            continue
        out.append(dict(key=key, vendor=slug(brand), name=name, kind="gamepad", ids=ids, page="https://" + pages[0].rstrip("*"), names=[name] + list(names),
                        note="web.archive.org snapshot of " + pages[0].rstrip("*")[:60], urls=urls))
    return out


def jobs():
    picks_f = ROOT / "picks" / "padswb.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None or sel >= len(c["urls"]):
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
