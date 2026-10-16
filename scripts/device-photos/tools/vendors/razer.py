"""Razer: official razer.com product pages -> JSON-LD store thumbnail. Mice from OpenMouse's RAZER_PRODUCTS (pid -> name),
keyboards from SYNQ's RAZER_KEYBOARDS table."""
import json, re
from common import ROOT, job, slug, toks
pages = {o["slug"]: o for o in json.load(open(ROOT / "tools" / "razer-pages.json")) if o.get("image")}
prods = json.load(open(ROOT / "tools" / "razer-products.json"))
cat = json.load(open(ROOT / "tools" / "catalog-raw.json"))
STOP = {"razer", "8khz", "wired", "edition", "magnetic"}
def key_of(name): return tuple(sorted(t for t in toks(name) if t not in STOP))
by_slug = {key_of(s.replace("razer-", "", 1)): s for s in pages}
ALIAS = {"Viper V3 Pro SE": "razer-viper-v3-pro-se", "Basilisk V3 35K": "razer-basilisk-v3-35k", "Basilisk V3 Pro 35K": "razer-basilisk-v3-pro-35k",
         "Cobra": "razer-cobra", "Viper V4 Pro": "razer-viper-v4-pro", "Naga Left-Handed Edition 2020": "razer-naga-left-handed-edition", "Basilisk V4 Pro": "razer-basilisk-v4-pro",
         "Basilisk V4 HyperSpeed": "razer-basilisk-v4-hyperspeed", "Cobra HyperSpeed": "razer-cobra-hyperspeed", "Naga V3 Pro": "razer-naga-v3-pro"}
KB_ALIAS = {"Huntsman V3 Pro 8KHz": "razer-huntsman-v3-pro-8khz", "Huntsman V3 Pro": "razer-huntsman-v3-pro", "Huntsman Signature Edition": "razer-huntsman-signature-edition",
            "Huntsman V3 TKL 8KHz": "razer-huntsman-v3-tenkeyless-8khz", "Huntsman V3 Pro Low-profile TKL 8KHz": "razer-huntsman-v3-pro-low-profile-tenkeyless-8khz",
            "Huntsman V2 Analog": "razer-huntsman-v2-analog"}
def find(name):
    n = re.sub(r"\s*\((?:Wired|Wireless)\)", "", name).strip()
    n = re.sub(r"\s+Signature Edition$", "", n) if "Mini Signature" in n else n
    if n in ALIAS: return ALIAS[n] if ALIAS[n] in pages else None
    return by_slug.get(key_of(n))
def jobs():
    out = {}
    for p in prods:
        name = p["name"]
        if not isinstance(name, str) or name.startswith("{") or "Dock" in name or "Dongle" in name: continue
        base = re.sub(r"\s*\((?:Wired|Wireless)\)", "", name).strip()
        s = find(name)
        if not s: continue
        j = out.setdefault(s, {"names": set(), "ids": set(), "name": base})
        j["ids"].add(f"1532:{p['pid']:04x}"); j["names"].add(base)
    for nm, sl in ALIAS.items():
        if sl in pages and sl not in out: out[sl] = {"names": {nm}, "ids": set(), "name": nm}
    EXTRA_IDS = {"razer-viper-v4-pro": ["1532:00e5", "1532:00e6"], "razer-cobra": ["1532:00a3"]}
    for sl, ids in EXTRA_IDS.items():
        if sl in out: out[sl]["ids"].update(ids)
    for k in cat:
        if k["src"] != "razer-kb": continue
        s = KB_ALIAS.get(k["model"])
        if not s or s not in pages: continue
        j = out.setdefault(s, {"names": set(), "ids": set(), "name": k["model"]})
        j["ids"].add(f"1532:{k['pid']:04x}"); j["names"].add(k["model"])
    for s, nm in (("razer-huntsman-v2-analog", "Huntsman V2 Analog"),):
        if s in pages and s not in out:
            out[s] = {"names": {nm}, "ids": {"1532:0266"}, "name": nm}
    res = []
    for s, j in out.items():
        pg = pages[s]
        kind = "keyboard" if pg["cat"] == "gaming-keyboards" else "mouse"
        res.append(job(s, "razer", j["name"], kind, j["ids"], url=pg["image"], page=pg["page"], names=sorted(j["names"] | {j["name"]} | {"razer " + x for x in j["names"]}), note="razer.com product page JSON-LD thumbnail"))
    return res
