"""Mice of the Shopify-based makers: official stores, product matched by the OpenMouse model name, first usable image."""
import json, sys
from common import ROOT, job, slug, norm_name
import shop
OM = json.load(open(ROOT / "tools" / "om-supported.json"))
VIDS = json.load(open(ROOT / "tools" / "brand-vids.json"))
STORES = {
    "Endgame Gear": "endgamegear.com", "Pulsar": "pulsar.gg", "Lamzu": "lamzu.com", "WLMouse": "www.wlmouse.com", "Attack Shark": "attackshark.com",
    "Glorious": "gloriousgaming.com", "Ninjutso": "ninjutso.com", "G-Wolves": "g-wolves.com", "Finalmouse": "finalmouse.com", "HyperX": "hyperx.com", "Keychron": "keychron.com",
}
CLAIMED = {"supported", "likely", "bridge"}
def ids_for(brand, pids):
    vids = VIDS.get(brand) or []
    if not pids or len(vids) == 0 or len(vids) > 3: return []
    return [f"{int(v,16):04x}:{p:04x}" for v in vids for p in pids]
def candidates(only=None):
    out = []
    for brand, domain in STORES.items():
        if only and brand not in only: continue
        cat = shop.catalog(domain)
        seen = set()
        for r in OM:
            if r["brand"] != brand or r["status"] not in CLAIMED: continue
            model = r["model"]
            q = model.replace("(wired)", "").replace("(Wired)", "").split("(")[0].strip()
            p = shop.best(cat, brand + " " + q if brand.lower() not in q.lower() else q, brand)
            if not p or p["handle"] in seen: continue
            seen.add(p["handle"])
            key = slug(f"{brand} {q}")
            nm = f"{brand} {q}" if brand.lower() not in q.lower() else q
            out.append(dict(key=key, vendor=slug(brand), name=nm, kind="mouse", ids=ids_for(brand, r["pids"]), page=f"https://{domain}/products/{p['handle']}",
                            names=[model, f"{brand} {model}", q, f"{brand} {q}"], note=f"{domain} product '{p['title']}'",
                            urls=[(i["src"] + ("&" if "?" in i["src"] else "?") + "width=1100") for i in p["images"][:6]]))
    return out

def jobs():
    picks_f = ROOT / "picks" / "shopmice.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    idx = json.load(open(ROOT / "cand" / "shopmice.json")) if (ROOT / "cand" / "shopmice.json").exists() else {}
    out = []
    for c in candidates():
        k = c["key"]
        sel = picks.get(k, "auto")
        if sel == "auto": sel = (idx.get(k) or {}).get("auto")
        if sel is None: continue
        if sel is None: continue
        out.append(job(k, c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
