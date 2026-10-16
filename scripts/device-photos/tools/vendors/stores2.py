"""Second-pass store mice: the maker's own Shopify store, product chosen by an explicit title pattern, every picture cut with rembg and reviewed by eye."""
import json, re, sys
from common import ROOT, job, slug
import shop

OM = json.load(open(ROOT / "tools" / "om-supported.json"))
VIDS = json.load(open(ROOT / "tools" / "brand-vids.json"))


def omids(brand, model_rx):
    """USB ids OpenMouse lists for the models of `brand` whose name matches (brands with more than three vendor ids get names only)."""
    vids = VIDS.get(brand) or []
    out = []
    for r in OM:
        if r["brand"] == brand and re.search(model_rx, r["model"], re.I) and r["pids"] and 0 < len(vids) <= 3:
            out += [f"{int(v, 16):04x}:{p:04x}" for v in vids for p in r["pids"]]
    return sorted(set(out))


# (brand, store, title regex, key, display name, OM model regex for ids, extra names)
ROWS = [
    ("GravaStar", "gravastar.com", r"^Mercury M1 Pro", "gravastar-mercury-m1-pro", "GravaStar Mercury M1 Pro", r"m1 pro", ["mercury m1 pro", "gravastar mercury m1 pro"]),
    ("Noir Gear", "noirgear.com", r"^Noir M2-NEX - ", "noir-gear-m2-nex", "Noir Gear M2-NEX", r"m2-nex", ["m2 nex", "noir m2 nex", "noir gear m2 nex"]),
    ("WALLHACK", "wallhack.com", r"^M-001", "wallhack-m-001", "WALLHACK M-001", r"m-001", ["m 001", "wallhack m 001"]),
    ("Dareu", "dareu.com", r"^DAREU A950 Pro Magnesium", "dareu-a950-pro-mg", "Dareu A950 PRO Mg", r"a950", ["a950 pro mg", "a950 pro magnesium", "dareu a950 pro mg"]),
    ("ATK", "atkgear.com", r"Blazing Sky ZERO", "atk-zero", "ATK Blazing Sky ZERO", r"zero", ["atk zero", "zero", "vxe zero", "vxe zero normal", "zero normal", "blazing sky zero"]),
    ("Mchose", "mchose.store", r"A7 V3 Series", "mchose-a7-v3", "MCHOSE A7 V3", r"a7 v3", ["a7 v3", "a7 v3 pro", "a7 v3 pro plus", "a7 v3 ultra", "a7 v3 ultra plus", "mchose a7 v3", "mchose a7 v3 pro", "mchose a7 v3 ultra plus", "mchose a7 v3 pro plus"]),
    ("Mchose", "mchose.store", r"A5 V3", "mchose-a5", "MCHOSE A5 Pro Max", r"a5 pro", ["a5 pro max", "mchose a5 pro max", "a5 pro", "a5"]),
    ("Lamzu", "lamzu.com", r"LAMZU ATLANTIS OG V2 PRO", "lamzu-atlantis", "Lamzu Atlantis", r"atlantis", ["atlantis", "lamzu atlantis", "atlantis og v2", "atlantis mini", "atlantis shared family ids"]),
    ("Keychron", "keychron.com", r"^Keychron M6 Wireless", "keychron-m6", "Keychron M6", r"^m6$", ["m6", "keychron m6"]),
    ("Keychron", "keychron.com", r"^Keychron Nape Pro", "keychron-nape-pro", "Keychron Nape Pro", r"nape", ["nape pro", "keychron nape pro"]),
    ("HyperX", "hyperx.com", r"^HyperX Pulsefire Haste - Wireless", "hyperx-pulsefire-haste", "HyperX Pulsefire Haste", r"pulsefire haste", ["pulsefire haste", "hyperx pulsefire haste", "pulsefire haste wireless"]),
    ("HyperX", "hyperx.com", r"^HyperX Pulsefire Haste 2 S", "hyperx-pulsefire-haste-2", "HyperX Pulsefire Haste 2", r"haste 2", ["pulsefire haste 2", "haste 2", "pulsefire haste 2 wireless", "hyperx pulsefire haste 2"]),
    ("Attack Shark", "attackshark.com", r"^ATTACK SHARK X11 ULTRA", "attack-shark-x11", "Attack Shark X11", r"^x11$", ["x11", "attack shark x11", "x11 ultra", "x11 se", "x11se", "attack shark x11 se"]),
    ("Attack Shark", "attackshark.com", r"X8 Series", "attack-shark-x8", "Attack Shark X8", r"x8", ["x8", "x8 ultra", "x8 se", "x8 plus", "attack shark x8 ultra", "attack shark x8 se", "attack shark x8 plus"]),
    ("Attack Shark", "attackshark.com", r"^ATTACK SHARK G3 ", "attack-shark-g3", "Attack Shark G3", r"^g3$", ["g3", "attack shark g3"]),
    ("Attack Shark", "attackshark.com", r"^ATTACK SHARK V3 ", "attack-shark-v3-pro", "Attack Shark V3 Pro", r"v3 pro", ["v3 pro", "v3", "attack shark v3 pro"]),
    ("Attack Shark", "attackshark.com", r"^ATTACK SHARK R11 ", "attack-shark-r8", "Attack Shark R8", r"^r8$", ["r8", "attack shark r8"]),
    ("Pulsar", "pulsar.gg", r"X2F CrazyLight", "pulsar-x2f", "Pulsar X2F", r"x2f", ["x2f", "pulsar x2f"]),
    ("Glorious", "gloriousgaming.com", r"^Model O Classic Wireless", "glorious-model-o-classic", "Glorious Model O", r"^model o$", ["model o", "glorious model o", "model o wireless", "model o pro", "glorious model o pro"]),
    ("Glorious", "gloriousgaming.com", r"^Model D3 Wireless", "glorious-model-d3", "Glorious Model D", r"model d", ["model d", "glorious model d", "model d wireless", "model d 2", "model d 2 wireless", "model d 2 wired", "glorious model d wireless", "glorious model d 2 wireless", "glorious model d 2 wired"]),
    ("Glorious", "gloriousgaming.com", r"^Model O 2 Mini Wireless", "glorious-model-o-2-mini-wireless", "Glorious Model O 2 Mini Wireless", r"model o 2 mini", ["model o 2 mini wireless"]),
]


def candidates():
    cats = {}
    out = []
    for brand, store, rx, key, name, omrx, names in ROWS:
        cat = cats.get(store) or cats.setdefault(store, shop.catalog(store))
        p = next((x for x in cat if re.search(rx, x["title"], re.I)), None)
        if not p:
            # the catalog filter drops accessories; a few real mice carry words it rejects, so look at the raw catalog once
            p = next((x for x in shop.catalog(store, set()) if re.search(rx, x["title"], re.I)), None)
        if not p:
            print("  no product:", key, file=sys.stderr)
            continue
        out.append(dict(key=key, vendor=slug(brand), name=name, kind="mouse", ids=omids(brand, omrx), page=f"https://{store}/products/{p['handle']}", names=[name] + names,
                        note=f"{store} product '{p['title']}'", urls=[(i["src"] + ("&" if "?" in i["src"] else "?") + "width=1100") for i in p["images"][:6]]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "stores2.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
