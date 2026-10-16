"""SteelSeries models whose product page leads with an opaque hero: the transparent PNG angles on the same page (reviewed by eye)."""
import io, json, re, sys
import numpy as np
from PIL import Image
from common import ROOT, job, fetch
from vendors import steelseries as ss

DONE = {"steelseries-apex-pro-gen-3", "steelseries-apex-pro-tkl-gen-3", "steelseries-apex-pro-tkl-wireless-gen-3", "steelseries-apex-pro-tkl-cyber", "steelseries-apex-pro-tkl-steel", "steelseries-apex-100"}


def transparent_pngs(path):
    h = fetch(ss.B + path, text=True).replace("&amp;", "&")
    seen, out = set(), []
    for u in re.findall(r"https://images\.ctfassets\.net/[A-Za-z0-9/_.-]+\.png", h):
        n = u.split("/")[-1]
        if u in seen or not re.search(r"buy|pdp", n, re.I) or re.search(r"swatch|award|badge|card|crosshair", n, re.I):
            continue
        seen.add(u)
        try:
            im = Image.open(io.BytesIO(fetch(u + "?w=300&fm=png"))).convert("RGBA")
        except Exception:
            continue
        if (np.asarray(im)[..., 3] < 20).mean() > 0.2:
            out.append(u + "?w=1100&fm=png")
    return out


def candidates():
    res = []
    for key, name, kind, ids, names, path in ss.ROWS:
        if key in DONE:
            continue
        urls = transparent_pngs(path)[:6]
        if not urls:
            continue
        res.append(dict(key=key, vendor="steelseries", name=name, kind=kind, ids=ids, page=ss.B + path, names=[name] + names, note="steelseries.com product page, transparent PNG", urls=urls))
    return res


def jobs():
    picks_f = ROOT / "picks" / "steelseries2.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
