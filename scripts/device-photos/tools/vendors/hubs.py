"""USB RGB hubs and PC lighting devices (wave L4): official product pictures from the makers' own sites, found by USB id.
The kind is `light` (the lighting group). Sources: corsair.com product galleries. Steps: cands2.py hubs, picks in
picks/hubs.json, build2.py hubs, assemble2.py, then node scripts/gen-device-images.mjs."""
import json, sys
from common import ROOT, job
from vendors.pads import grab

CORSAIR = "https://www.corsair.com/us/en/p/"
BIG = r"c_pad,q_auto,h_1024,w_1024.*"

ROWS = [
    ("corsair-lighting-node-pro", "corsair", "Corsair Lighting Node Pro", ["1b1c:0c0b"], ["lighting node pro", "icue lighting node pro"],
     CORSAIR + "rgb-lighting/cl-9011109-ww/icue-lighting-node-pro-rgb-lighting-controller-cl-9011109-ww", BIG + r"CL-9011109-WW/Gallery"),
    ("corsair-nautilus-lcd-cap", "corsair", "Corsair Nautilus LCD Cap", ["1b1c:0c57"], ["nautilus lcd cap", "nautilus rs lcd screen module"],
     CORSAIR + "cpu-coolers/cw-9061029-ww/nautilus-rs-lcd-screen-module-cw-9061029-ww", BIG + r"CW-9061029-WW_0"),
]


def candidates(only=None):
    out = []
    for key, vendor, name, ids, names, page, pattern in ROWS:
        if only and key not in only:
            continue
        urls = grab(page, pattern)
        if not urls:
            print("  no pictures:", key, file=sys.stderr)
        out.append(dict(key=key, vendor=vendor, name=name, kind="light", ids=ids, page=page, names=[name] + names, note="maker's own site", urls=urls[:10]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "hubs.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates(only={k for k, v in picks.items() if v is not None}):
        sel = picks.get(c["key"])
        if sel is None or sel >= len(c["urls"]):
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
