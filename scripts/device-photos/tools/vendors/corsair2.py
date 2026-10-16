"""Corsair models the store sitemap lacked: product pages found by search -> JSON-LD product images. Reviewed by eye."""
import json, re, sys
from common import ROOT, job, fetch

ROWS = [
    ("corsair-k95-rgb-platinum-xt", "K95 RGB PLATINUM XT", "keyboard", ["1b1c:1b89"], ["k95 rgb platinum xt", "k95 platinum xt", "k95 rgb platinum"],
     "https://www.corsair.com/us/en/p/keyboards/ch-9127414-na/k95-rgb-platinum-xt-mechanical-gaming-keyboard-cherry-mx-speed-na-layout-ch-9127414-na"),
    ("corsair-makr-pro-75", "MAKR PRO 75", "keyboard", ["1b1c:2b1a"], ["makr pro 75", "makr pro 75 hololive momosuzu nene edition", "makr pro 75 hololive"],
     "https://www.corsair.com/uk/en/p/keyboards/ch-91ce21g-uk/makr-pro-75-hall-effect-diy-keyboard-uk-ch-91ce21g-uk"),
    ("corsair-makr-75", "MAKR 75", "keyboard", ["1b1c:2b04"], ["makr 75"], "https://www.corsair.com/ww/en/s/makr75-diy-barebones-keyboard-kit"),
]


def candidates():
    out = []
    for key, name, kind, ids, names, page in ROWS:
        try:
            t = fetch(page, text=True)
        except Exception as e:
            print("  no page", key, str(e)[:60], file=sys.stderr)
            continue
        urls = []
        for s in re.findall(r'<script type="application/ld\+json">(.*?)</script>', t, re.S):
            try:
                j = json.loads(s)
            except Exception:
                continue
            for jj in (j if isinstance(j, list) else [j]):
                if isinstance(jj, dict) and jj.get("@type") == "Product" and jj.get("image"):
                    im = jj["image"]
                    urls += im if isinstance(im, list) else [im]
        og = re.findall(r'og:image" content="([^"]+)', t)
        urls += og
        urls = [u for u in dict.fromkeys(urls)]
        if not urls:
            print("  no images", key, file=sys.stderr)
            continue
        out.append(dict(key=key, vendor="corsair", name="Corsair " + name, kind=kind, ids=ids, page=page, names=["Corsair " + name, name] + names, note="corsair.com product page image", urls=urls[:6]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "corsair2.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
