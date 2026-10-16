"""SteelSeries models with no picture yet: the product page's buy / pdp pictures (Contentful), opaque ones cut with rembg. Reviewed by eye."""
import json, re, sys
from common import ROOT, job, fetch
from vendors import steelseries as ss

HAVE = {"steelseries-apex-pro-gen-3", "steelseries-apex-pro-tkl-gen-3", "steelseries-apex-pro-tkl-wireless-gen-3", "steelseries-apex-pro-tkl-cyber", "steelseries-apex-pro-tkl-steel", "steelseries-apex-100",
        "steelseries-apex-pro-mini-gen-3", "steelseries-apex-pro-tkl-2023", "steelseries-apex-pro-tkl-wireless-2023", "steelseries-apex-pro"}
# models SYNQ lists that the shared SteelSeries table folds into one entry (same board, another year or cable/receiver id)
EXTRA = [
    ("steelseries-apex-7-2024", "Apex 7 (2024)", "keyboard", ["1038:1652"], ["apex 7 2024"], "gaming-keyboards/apex-7?keyboardSize=fullSize&switchType=red-qx2-mechanical&keyboardLanguage=english&color=black"),
]


def candidates():
    out = []
    for key, name, kind, ids, names, path in list(ss.ROWS) + EXTRA:
        if key in HAVE:
            continue
        try:
            h = fetch(ss.B + path, text=True).replace("&amp;", "&")
        except Exception as e:
            print("  no page", key, str(e)[:60], file=sys.stderr)
            continue
        seen, urls = set(), []
        for u in re.findall(r"https://images\.ctfassets\.net/[A-Za-z0-9/_.-]+\.(?:png|jpg)", h):
            n = u.split("/")[-1]
            if u in seen or not re.search(r"buy|pdp", n, re.I) or re.search(r"swatch|award|badge|card|crosshair|_(us|uk|de|fr|nd|jp|kr|es|it|br|th)\.", n, re.I):
                continue
            seen.add(u)
            urls.append(u + "?w=1100&fm=png")
        if not urls:
            print("  no images", key, file=sys.stderr)
            continue
        out.append(dict(key=key, vendor="steelseries", name="SteelSeries " + name, kind=kind, ids=ids, page=ss.B + path, names=["SteelSeries " + name, name] + names,
                        note="steelseries.com product page picture, cut with rembg", urls=urls[:6]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "steelseries3.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
