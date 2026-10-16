"""mouselog.jp: a Japanese mouse database whose product pages carry one clean product picture each (S3: mouselog-phot). Last-resort source for models the makers no longer show
(VAXEE blocks its own site, XM1r / OP1 are gone from endgamegear.com ...). Product chosen by slug pattern, cut with rembg where needed, reviewed by eye."""
import json, re, sys, urllib.parse
from common import ROOT, job, slug, fetch
from vendors.stores2 import omids

B = "https://mouselog.jp"
# (brand, slug regex, key, display name, OpenMouse model regex for ids, extra names)
ROWS = [
    ("VAXEE", r"^VAXEE-XE-Wireless", "vaxee-xe-wireless", "VAXEE XE Wireless", r"^XE Wireless$", ["xe wireless", "vaxee xe wireless", "xe", "vaxee xe"]),
    ("VAXEE", r"^VAXEE-XEv2", "vaxee-xe-v2-wireless", "VAXEE XE V2 Wireless", r"xe v2", ["xe v2 wireless", "xe v2", "vaxee xe v2 wireless", "vaxee xe v2"]),
    ("VAXEE", r"^VAXEE-XE-S-Wireless", "vaxee-xe-s-wireless", "VAXEE XE-S Wireless", r"^XE-S Wireless$", ["xe s wireless", "xe s", "vaxee xe s wireless", "vaxee xe s"]),
    ("VAXEE", r"^VAXEE-XE-S-L", "vaxee-xe-s-l-wireless", "VAXEE XE-S-L Wireless", r"xe-s-l", ["xe s l wireless", "xe s l", "vaxee xe s l wireless", "vaxee xe s l"]),
    ("VAXEE", r"^VAXEE-ZYGEN-NP-01S$", "vaxee-np-01s-wireless", "VAXEE NP-01S Wireless", r"^NP-01S Wireless$", ["np 01s wireless", "np 01s", "np 01s v2 wireless", "np 01s v2", "vaxee np 01s wireless", "vaxee np 01s v2 wireless", "zygen np 01s"]),
    ("VAXEE", r"^VAXEE-NP-01S-V3", "vaxee-np-01s-v3-wireless", "VAXEE NP-01S V3 Wireless", r"np-01s v3", ["np 01s v3 wireless", "np 01s v3", "vaxee np 01s v3 wireless", "vaxee np 01s v3"]),
    ("VAXEE", r"^VAXEE-ZYGEN-NP-01$", "vaxee-np-01-wireless", "VAXEE NP-01 Wireless", r"^NP-01 Wireless$", ["np 01 wireless", "np 01", "vaxee np 01 wireless", "vaxee np 01", "zygen np 01"]),
    ("VAXEE", r"^VAXEE-NP-01-Ergo", "vaxee-np-01-ergo-wireless", "VAXEE NP-01 Ergo Wireless", r"np-01 ergo", ["np 01 ergo wireless", "np 01 ergo", "np 01s ergo wireless", "np 01s ergo", "vaxee np 01 ergo wireless", "vaxee np 01s ergo wireless"]),
    ("VAXEE", r"^VAXEE-OUTSET-AX", "vaxee-ax-wireless", "VAXEE AX Wireless", r"^AX Wireless$", ["ax wireless", "vaxee ax wireless", "outset ax", "vaxee outset ax", "ax"]),
    ("VAXEE", r"^VAXEE-E1-Wireless", "vaxee-e1-wireless", "VAXEE E1 Wireless", r"^E1 Wireless$", ["e1 wireless", "vaxee e1 wireless", "e1", "vaxee e1"]),
    ("VAXEE", r"^VAXEE-x-NINJUTSO", "vaxee-x-ninjutso-sora", "VAXEE x Ninjutso Sora", r"ninjutso", ["vaxee x ninjutso sora", "vaxee ninjutso sora", "sora 4k", "ninjutso sora 4k"]),
    ("Endgame Gear", r"^Endgame-Gear-XM1r", "endgame-gear-xm1r", "Endgame Gear XM1r", r"xm1r", ["xm1r", "endgame gear xm1r", "xm1 rgb", "xm1", "endgame gear xm1 rgb"]),
    ("Endgame Gear", r"^Endgame-Gear-OP1-RGB", "endgame-gear-op1-rgb", "Endgame Gear OP1 RGB", r"op1 rgb", ["op1 rgb", "endgame gear op1 rgb"]),
    ("Endgame Gear", r"^Endgame-Gear-OP1-Gaming-Mouse$", "endgame-gear-op1", "Endgame Gear OP1", r"^OP1$", ["op1", "endgame gear op1"]),
    ("Glorious", r"^Glorious-Model-O-2-PRO-Series-Wireless-Mouse$", "glorious-model-o-2-pro", "Glorious Model O 2 PRO", r"model o 2 pro", ["model o 2 pro", "glorious model o 2 pro", "model o 2 pro wireless", "model o 2 pro 4k 8k", "model o 2 pro series"]),
    ("Glorious", r"^Glorious-Model-D-2-PRO-Series-Wireless-Mouse$", "glorious-model-d-2-pro", "Glorious Model D 2 PRO", r"model d 2 pro", ["model d 2 pro", "glorious model d 2 pro", "model d 2 pro wireless"]),
    ("Orbital", r"^Orbital-Works-Pathfinder", "orbital-pathfinder", "Orbital Pathfinder", r"pathfinder|ghost", ["orbital ghost pathfinder v2", "ghost pathfinder v2", "orbital ghost", "orbital pathfinder", "pathfinder v2", "pathfinder"]),
    ("RAWM", r"^RAWM-SH01-8K", "rawm-sh01", "RAWM SH01", r"^SH01$", ["sh01", "rawm sh01", "sh01 1k", "sh01 8k"]),
    ("RAWM", r"^RAWM-SH01PRO-8K", "rawm-sh01-pro", "RAWM SH01 Pro", r"sh01 pro", ["sh01 pro", "rawm sh01 pro"]),
    ("WLMouse", r"^WLmouse-BEAST-X-MINI$", "wlmouse-beast-x-mini", "WLMouse Beast X Mini", r"beast mini|beast x mini", ["beast mini", "beast x mini", "wlmouse beast mini", "wlmouse beast x mini"]),
    ("WLMouse", r"^WLmouse-Beast-X-8K-Wireless-Gaming-Mouse-OMRON", "wlmouse-beast-x", "WLMouse Beast X", r"beast x$", ["beast x", "wlmouse beast x", "beast x 8k", "wlmouse beast x 8k"]),
    ("Pulsar", r"^Pulsar-X2F-CrazyLight", "pulsar-x2f", "Pulsar X2F", r"x2f", ["x2f", "pulsar x2f", "x2f crazylight", "pulsar x2f crazylight"]),
    ("Pulsar", r"^Pulsar-X2A-v3-Gaming-Mouse$", "pulsar-x2a-v3", "Pulsar X2A V3", r"x2a", ["x2a v3", "x2a", "pulsar x2a v3", "pulsar x2a"]),
    ("Pulsar", r"^Pulsar-X2-v2-Medium", "pulsar-x2-v2", "Pulsar X2 V2", r"^$", ["x2 v2", "pulsar x2 v2", "x2 v2 medium", "pulsar x2"]),
    ("Pulsar", r"^Pulsar-X2N-CrazyLight-Medium", "pulsar-x2n-crazylight", "Pulsar X2N CrazyLight", r"x2n", ["x2n crazylight", "pulsar x2n crazylight", "x2n", "pulsar x2n"]),
    ("Attack Shark", r"^ATTACK-SHARK-X1$", "attack-shark-x1", "Attack Shark X1", r"^x1$", ["x1", "attack shark x1"]),
]

_cat = []


def catalog():
    if not _cat:
        h = fetch(f"{B}/en/products", text=True)
        _cat.extend(urllib.parse.unquote(l).replace("&#39;", "'") for l in re.findall(r'href="/en/products/([^"]+)"', h))
    return _cat


def candidates():
    out = []
    cat = catalog()
    for brand, rx, key, name, omrx, names in ROWS:
        hits = [s for s in cat if re.search(rx, s, re.I)]
        if not hits:
            print("  no product:", key, file=sys.stderr)
            continue
        urls, pages = [], []
        for s in hits[:2]:
            try:
                h = fetch(f"{B}/en/products/{urllib.parse.quote(s, safe='()[]')}", text=True)
            except Exception as e:
                print("  page failed:", s, str(e)[:50], file=sys.stderr)
                continue
            m = re.search(r'<script type="application/ld\+json">(.*?)</script>', h, re.S)
            if not m:
                continue
            try:
                im = json.loads(m.group(1)).get("image")
            except Exception:
                continue
            if im:
                urls.append(im)
                pages.append(f"{B}/en/products/{s}")
        if not urls:
            print("  no image:", key, file=sys.stderr)
            continue
        out.append(dict(key=key, vendor=slug(brand), name=name, kind="mouse", ids=omids(brand, omrx), page=pages[0], names=[name] + names,
                        note=f"mouselog.jp product database picture ('{hits[0]}')", urls=urls))
    return out


def jobs():
    picks_f = ROOT / "picks" / "mouselog.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
