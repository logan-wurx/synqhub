"""ASUS ROG: official rog.asus.com model pages -> product pictures (overview banner 'gain' images and key-visual PNGs), reviewed by eye."""
import json, re, sys
from common import ROOT, job, slug, fetch

HITS = json.load(open(ROOT / "tools" / "rog-hits2.json"))
CAT = json.load(open(ROOT / "tools" / "catalog-raw.json"))
GAIN = re.compile(r"https://dlcdnwebimgs\.asus\.com/gain/[0-9A-Fa-f-]{36}")
KV = re.compile(r"https://dlcdnwebimgs\.asus\.com/files/media/[0-9A-Fa-f-]{36}/v1/img/(?:kv|banner|product|overview)[A-Za-z0-9_./-]*\.png")


def candidates():
    pids = {}
    for o in CAT:
        if o["src"] == "asus-gearlink" and o["hidPattern"] != 3 and o["model"] in HITS:
            pids.setdefault(o["model"], set()).add(f"0b05:{o['pid']:04x}")
    res = []
    for name, url in HITS.items():
        try:
            t = fetch(url, text=True)
        except Exception as e:
            print("  no page", name, str(e)[:50], file=sys.stderr)
            continue
        urls = []
        for g in GAIN.findall(t):
            u = g + "/w900"
            if u not in urls:
                urls.append(u)
        for k in KV.findall(t):
            if k not in urls and "bg" not in k:
                urls.append(k)
        kind = "mouse" if "/mice/" in url else "keyboard"
        low = name.lower()
        res.append(dict(key=slug(name), vendor="asus", name=name, kind=kind, ids=sorted(pids.get(name, [])), page=url,
                        names=[name, name.replace("ROG ", ""), name.replace("ROG ", "").replace(" EDITION", "")], note="rog.asus.com model page", urls=urls[:6]))
    return res


def jobs():
    picks_f = ROOT / "picks" / "asus.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
