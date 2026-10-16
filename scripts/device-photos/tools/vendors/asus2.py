"""ASUS models the first pass missed: product pages on asus.com / rog.asus.com found by search -> the page's own product pictures
(og:image 'gain' picture first, then key-visual PNGs). Reviewed by eye."""
import json, re, sys
from common import ROOT, job, fetch

GAIN = re.compile(r"https://dlcdnwebimgs\.asus\.com/gain/[0-9A-Fa-f-]{36}")
KV = re.compile(r"https://dlcdnwebimgs\.asus\.com/files/media/[^\"' )<>]*?/v1/img/kv/[A-Za-z0-9_.-]+\.png")
KVJ = re.compile(r"https://dlcdnimgs\.asus\.com/websites/global/products/[A-Za-z0-9]+/v1/images/(?:kv|static|pd[A-Za-z0-9_]*)\.(?:png|jpg)")


def i(*pids):
    return [f"0b05:{p:04x}" for p in pids]


ROWS = [
    ("rog-azoth", "ROG AZOTH", "keyboard", i(0x1a83, 0x1a85), ["rog azoth", "azoth"], "https://rog.asus.com/us/keyboards/keyboards/aura-rgb/rog-azoth-model/"),
    ("rog-harpe-ace-aim-lab-edition", "ROG HARPE ACE AIM LAB EDITION", "mouse", i(0x1a92, 0x1a94, 0x1845), ["harpe ace aim lab edition", "harpe ace aim lab", "rog harpe ace aim lab edition"], "https://rog.asus.com/us/mice-mouse-pads/mice/ambidextrous/rog-harpe-ace-aim-lab-edition-model/"),
    ("rog-gladius-ii-p502", "ROG GLADIUS II", "mouse", i(0x1845), ["gladius ii", "rog gladius ii", "gladius ii p502", "rog gladius ii p502", "gladius ii core"], "https://rog.asus.com/mice-mouse-pads/mice/ergonomic-right-handed/rog-gladius-ii-model/"),
    ("asus-proart-mouse-md301", "ProArt Mouse MD301", "mouse", [], ["proart mouse md301", "md301", "asus proart mouse md301"], "https://www.asus.com/us/accessories/mice-and-mouse-pads/proart/proart-mouse-md301/"),
    ("asus-proart-keyboard-kd300", "ProArt Keyboard KD300", "keyboard", [], ["proart keyboard kd300", "kd300", "asus proart keyboard kd300"], "https://www.asus.com/accessories/keyboards/proart/proart-keyboard-kd300/"),
    ("asus-tuf-gaming-k4-magnetic", "TUF Gaming K4 Magnetic", "keyboard", [], ["tuf gaming k4 magnetic", "k4 magnetic", "asus tuf gaming k4 magnetic", "tx75 analog gaming keyboard", "tx75 core gaming keyboard", "asus tx75 analog gaming keyboard", "asus tx75 core gaming keyboard", "tx75"], "https://www.asus.com/accessories/keyboards/asus-keyboard/tuf-gaming-k4-magnetic/"),
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
        for og in re.findall(r'og:image" content="([^"]+)', t):
            if "dlcdnwebimgs" in og and "/gain/" in og:
                urls.append(og.rstrip("/") + "/w900")
        for g in GAIN.findall(t):
            u = g + "/w900"
            if u not in urls:
                urls.append(u)
        urls += [u for u in dict.fromkeys(KV.findall(t)) if "bg" not in u and "deco" not in u]
        urls += list(dict.fromkeys(KVJ.findall(t)))
        if not urls:
            print("  no images", key, file=sys.stderr)
            continue
        out.append(dict(key=key, vendor="asus", name=name if name.startswith(("ROG", "ProArt", "TUF")) is False else "ASUS " + name if not name.startswith("ROG") else name, kind=kind, ids=ids, page=page, names=[name] + names,
                        note="asus.com / rog.asus.com product page", urls=urls[:6]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "asus2.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
