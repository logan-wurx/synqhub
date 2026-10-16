"""More store mice, picked by an explicit title pattern (the automatic matcher is too strict for these catalogs)."""
import json, re, sys
from common import ROOT, job, slug
import shop

# (brand, store, title regex, key, display name, ids, extra names)
ROWS = [
    ("HyperX", "hyperx.com", r"^HyperX Pulsefire Haste - Wireless", "hyperx-pulsefire-haste", "HyperX Pulsefire Haste", [], ["pulsefire haste", "hyperx pulsefire haste"]),
    ("HyperX", "hyperx.com", r"^HyperX Pulsefire Haste 2 – Wireless", "hyperx-pulsefire-haste-2-wireless", "HyperX Pulsefire Haste 2 Wireless", [], ["pulsefire haste 2 wireless", "haste 2 wireless"]),
    ("HyperX", "hyperx.com", r"^HyperX Pulsefire Haste 2 – Gaming", "hyperx-pulsefire-haste-2", "HyperX Pulsefire Haste 2", [], ["pulsefire haste 2", "haste 2"]),
    ("HyperX", "hyperx.com", r"^HyperX Pulsefire Fuse", "hyperx-pulsefire-fuse", "HyperX Pulsefire Fuse", [], ["pulsefire fuse"]),
    ("G-Wolves", "g-wolves.com", r"^G-Wolves HTX Mini 8K", "g-wolves-htx-mini-8k", "G-Wolves HTX Mini 8K", [], ["htx mini 8k", "htx mini"]),
    ("Pulsar", "pulsar.gg", r"^X2H v3 Medium", "pulsar-x2h", "Pulsar X2H", [], ["x2h", "pulsar x2h", "x2h v3"]),
    ("Pulsar", "pulsar.gg", r"^TenZ Signature Edition 2\.0", "pulsar-tenz-signature", "Pulsar TenZ Signature", [], ["tenz signature", "pulsar tenz signature"]),
]


def candidates():
    cats = {}
    out = []
    for brand, store, rx, key, name, ids, names in ROWS:
        cat = cats.get(store) or cats.setdefault(store, shop.catalog(store))
        p = next((x for x in cat if re.search(rx, x["title"])), None)
        if not p:
            print("  no product:", key, file=sys.stderr)
            continue
        out.append(dict(key=key, vendor=slug(brand), name=name, kind="mouse", ids=ids, page=f"https://{store}/products/{p['handle']}", names=[name] + names,
                        note=f"{store} product '{p['title']}'", urls=[i["src"] + "&width=1100" if "?" in i["src"] else i["src"] + "?width=1100" for i in p["images"][:6]]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "shopmice2.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
