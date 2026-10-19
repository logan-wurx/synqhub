"""Earlier pictures cut badly, cut again from the very source SOURCES.json names (same key, names and ids as index.json):
a white mouse whose shell the flood fill ate (Attack Shark X3: the matting model this time), and LG monitors whose white
on-screen logo the matting model took for background (the flood fill this time), and a picture taken from a thumbnail
whose store serves the same picture full size (HORI's OCTA: BigCommerce's 1280 px rendition). Picks in picks/fixes.json
are all 0.
Steps: build2.py fixes, assemble2.py."""
import json
from common import ROOT
from rows import R, make

DEST = ROOT.parents[1] / "src" / "assets" / "devices"
HOW = {"attack-shark-x3": {"force": True}, "lg-27gr95qe": {"flood": True}, "lg-27gs95qe": {"flood": True},
       "hori-fighting-commander-octa": {"url": "https://cdn11.bigcommerce.com/s-bsuqqx/images/stencil/1280x1280/products/806/2386/AB03-001_product_image_01__84213.1601327718.png"}}

_models = {m["key"]: m for m in json.load(open(DEST / "index.json", encoding="utf8"))["models"]}
_sources = {s["key"]: s for s in json.load(open(DEST / "SOURCES.json", encoding="utf8"))["images"]}

ROWS = []
for key, opts in HOW.items():
    m, s = _models[key], _sources[key]
    note = (s.get("how") or "").split(" | also used for:")[0] + "; cut again"
    opts = dict(opts)
    ROWS.append(R(key, m["vendor"], m["name"], m["kind"], [("img", opts.pop("url", s["sourceUrl"]))], ids=m["ids"], names=m["names"],
                  page=s.get("pageUrl") or "", note=note, **opts))

candidates, jobs = make("fixes", ROWS)
