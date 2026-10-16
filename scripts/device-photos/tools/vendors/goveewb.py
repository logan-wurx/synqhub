"""Govee lights whose product page on us.govee.com is gone or no longer names the SKU (most of the BLE models SYNQ
drives): the Wayback Machine's copy of Govee's own product page -> the gallery it showed, taken from Shopify's CDN where
the same address still answers (it mostly does), else from the archived copy. The same method as padswb.py; the rows
(tools/goveewb-rows.json) carry each page's snapshot and the gallery addresses read from it, because the archive's
index (CDX) was answering 503 when this pass was made:
[key, display name, extra names, archived page url, snapshot timestamp, [picture url, ...]]. Kind `light`, found by the
SKU in the lamp's Bluetooth name; one picture serves the lengths of one strip (extra names)."""
import json, sys
from common import ROOT, job
from vendors.wayback3 import live_ok, wb_ok

ROWS_FILE = ROOT / "tools" / "goveewb-rows.json"


def candidates(only=None):
    out = []
    for key, name, names, page, ts, pics in json.load(open(ROWS_FILE, encoding="utf8")):
        if only and key not in only:
            continue
        urls = []
        for u in pics:
            if len(urls) >= 10:
                break
            if live_ok(u):
                urls.append(u)
            elif wb_ok(ts, u):
                urls.append(f"wb:{ts}:{u}")
        if not urls:
            print("  no pictures:", key, file=sys.stderr)
            continue
        out.append(dict(key=key, vendor="govee", name=name, kind="light", ids=[], page=page, names=[name] + list(names),
                        note=f"Govee's product page, web.archive.org snapshot {ts}", urls=urls))
    return out


def jobs():
    picks_f = ROOT / "picks" / "goveewb.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates(only=set(picks)):
        sel = picks.get(c["key"])
        if sel is None or sel >= len(c["urls"]):
            continue
        j = job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})")
        # Govee's gallery shots are lit, often with the box or two bars: kept whole (proc2 soft), not cut to the largest piece,
        # except a single lamp whose shot has a stray piece beside it.
        j["soft"] = c["key"] not in SOLID
        if c["key"] in CROP:
            j["crop"] = CROP[c["key"]]
        if c["key"] in GLOW:
            j["feather"] = GLOW[c["key"]]
        out.append(j)
    return out


SOLID = {"govee-h6078"}
# The light alone out of a kit shot (fractions x0, y0, x1, y1 of Govee's picture; build2.py): no box, phone or banner.
CROP = {
    "govee-h1a42": (0.0, 0.64, 1.0, 1.0),
    "govee-h6046": (0.6, 0.1, 0.95, 0.88),
    "govee-h6061": (0.0, 0.1, 0.69, 0.85),
    "govee-h6072": (0.2, 0.0, 0.5, 1.0),
    "govee-h6199": (0.31, 0.74, 0.97, 0.97),
    "govee-h66a0": (0.15, 0.57, 0.9, 0.93),
    "govee-h6079": (0.03, 0.0, 0.5, 1.0),
}
# A lamp shot lit with its glow: the glow fades out over this fraction of each side instead of ending at the crop.
GLOW = {"govee-h6079": 0.22, "govee-h1a42": 0.1}
