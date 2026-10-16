"""Razer models whose own product page no longer exists (or only as a SKU page): the transparent 500x500 store thumbnails that razer.com's pages still link to
(harvested into raw/razer-pool.json by probe_razer_pool.py from the 'related products' carousels)."""
import json
from common import ROOT, job

POOL = json.load(open(ROOT / "raw" / "razer-pool.json"))
P = "https://www.razer.com/gaming-keyboards/razer-huntsman-v3-pro-8khz/RZ03-05740200-R3U1"


def i(*pids):
    return [f"1532:{p:04x}" for p in pids]


# (key, display name, kind, ids, extra names, pool file, page)
ROWS = [
    ("razer-naga-v2-pro", "Razer Naga V2 Pro", "mouse", i(0xa7, 0xa8), ["naga v2 pro", "razer naga v2 pro"], "naga-v2-pro-2-500x500.png", "https://www.razer.com/gaming-mice/razer-naga-v2-pro"),
    ("razer-deathadder-v3-pro", "Razer DeathAdder V3 Pro", "mouse", i(0xb6, 0xb7, 0xc2), ["deathadder v3 pro", "razer deathadder v3 pro"], "dav3pro-hyperpolling-smooth-touch-500x500.png", "https://www.razer.com/gaming-mice/razer-deathadder-v3-pro"),
    ("razer-huntsman-v3-pro-tkl", "Razer Huntsman V3 Pro TKL", "keyboard", i(0x2d0, 0x2a7), ["huntsman v3 pro tkl", "huntsman v3 pro tkl 8khz", "huntsman v3 pro tenkeyless", "razer huntsman v3 pro tkl", "razer huntsman v3 pro tkl 8khz"], "huntsman-v3-pro-tkl-8khz-b-500x500.png", P.replace("RZ03-05740200", "RZ03-05520200")),
    ("razer-huntsman-v3-pro-mini", "Razer Huntsman V3 Pro Mini", "keyboard", i(0x2d1, 0x2b0), ["huntsman v3 pro mini", "huntsman v3 pro mini 8khz", "razer huntsman v3 pro mini", "razer huntsman v3 pro mini 8khz"], "huntsman-v3-pro-mini-8khz-black-500x500.png", P),
    ("razer-huntsman-v3-he-magnetic-tkl-8khz", "Razer Huntsman V3 HE Magnetic TKL 8KHz", "keyboard", i(0x2ea), ["huntsman v3 he magnetic tkl 8khz", "huntsman v3 he magnetic tkl", "razer huntsman v3 he magnetic tkl 8khz"], "huntsman-v3-he-mag-tkl-8k-500x500.png",
     "https://www.razer.com/gaming-keyboards/razer-huntsman-v3-he-magnetic-8khz/RZ03-05920200-R3U1"),
    ("razer-huntsman-v3-he-magnetic-mini-8khz", "Razer Huntsman V3 HE Magnetic Mini 65% 8KHz", "keyboard", i(0x2e4), ["huntsman v3 he magnetic mini 65 8khz", "huntsman v3 he magnetic mini 65", "razer huntsman v3 he magnetic mini 65 8khz"], "huntsman-v3-he-mag-65-8k-500x500.png",
     "https://www.razer.com/gaming-keyboards/razer-huntsman-v3-he-magnetic-8khz/RZ03-05930200-R3U1"),
]


def candidates():
    return [dict(key=k, vendor="razer", name=n, kind=kd, ids=ids, page=pg, names=[n] + names, note="razer.com product thumbnail (store CDN)", urls=[POOL[f]]) for k, n, kd, ids, names, f, pg in ROWS if f in POOL]


def jobs():
    return [job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][0], page=c["page"], names=c["names"], note=c["note"]) for c in candidates()]
