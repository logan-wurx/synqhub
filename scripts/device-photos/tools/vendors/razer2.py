"""Razer models no longer in the store: razer.com product pages as the Wayback Machine kept them -> the store gallery pictures
(the 500x500 transparent thumbnail where the snapshot has one, else the 1500x1000 gallery shot, cut by rembg). Reviewed by eye."""
import json, re, sys, urllib.parse
from common import ROOT, job, slug, wb_fetch, fetch

CDX = json.load(open(ROOT / "raw" / "razer-cdx.json"))
PRODUCTS = json.load(open(ROOT / "tools" / "razer-products.json"))
IMG = re.compile(r"https?:[^\"'\s)\\]*\.(?:png|jpg|webp)")
# display name -> archived page slug (the product's own page, or its family's where the model never had one)
ROWS = {
    "Viper Ultimate": "razer-viper-ultimate", "Viper 8KHz": "razer-viper-8khz", "Naga V2 Pro": "razer-naga-v2-pro", "Naga Trinity": "razer-naga-trinity", "Naga X": "razer-naga-x",
    "Basilisk Essential": "razer-basilisk-essential", "Basilisk": "razer-basilisk", "Basilisk X HyperSpeed": "razer-basilisk-x-hyperspeed", "Basilisk Ultimate": "razer-basilisk-ultimate",
    "Basilisk V2": "razer-basilisk-v2", "Basilisk V3": "razer-basilisk-v3", "Basilisk V3 Pro": "razer-basilisk-v3-pro", "DeathAdder Elite": "razer-deathadder-elite",
    "Abyssus 1800": "razer-abyssus", "Abyssus 2000": "razer-abyssus", "Abyssus 2014": "razer-abyssus", "Abyssus Elite (D.Va Edition)": "razer-abyssus-essential", "Abyssus Essential": "razer-abyssus-essential",
    "Abyssus V2": "razer-abyssus-v2", "Atheris": "razer-atheris", "DeathAdder 1800": "razer-deathadder-classic", "DeathAdder 2000": "razer-deathadder-classic", "DeathAdder 2013": "razer-deathadder",
    "DeathAdder 3500": "razer-deathadder-black", "DeathAdder Chroma": "razer-deathadder-chroma", "DeathAdder V2 Mini": "razer-deathadder-v2-mini", "DeathAdder V2 Lite": "razer-deathadder-v2-mini",
    "Diamondback Chroma": "razer-diamondback", "Imperator 2012": "razer-imperator", "Lancehead": "razer-lancehead", "Lancehead Tournament Edition": "razer-lancehead-tournament-edition",
    "Lancehead Wireless": "razer-lancehead", "Mamba": "razer-mamba", "Mamba 2012": "razer-mamba", "Mamba Elite": "razer-mamba-elite", "Mamba Tournament Edition": "razer-mamba-tournament-edition",
    "Mamba Wireless": "razer-mamba-wireless", "Naga": "razer-naga", "Naga 2012": "razer-naga", "Naga 2014": "razer-naga-molten", "Naga Chroma": "razer-naga-chroma", "Naga Epic": "razer-naga-epic",
    "Naga Epic Chroma": "razer-naga-epic-chroma", "Naga Hex": "razer-naga-hex", "Naga Hex (Red)": "razer-naga-hex", "Naga Hex V2": "razer-naga-hex-v2", "Naga Pro": "razer-naga-pro",
    "Orochi": "razer-orochi", "Orochi 2013": "razer-orochi", "Ouroboros 2012": "razer-ouroboros", "Pro Click": "razer-pro-click", "Pro Click Mini": "razer-pro-click-mini",
    "Pro Click V2": "razer-pro-click-v2", "Pro Click V2 Vertical Edition": "razer-pro-click-v2-vertical-edition", "Taipan": "razer-taipan",
}


def pids_of(name):
    out = []
    for p in PRODUCTS:
        n = p["name"]
        if isinstance(n, str) and re.sub(r"\s*\((?:Wired|Wireless)\)", "", n).strip() == name:
            out.append(f"1532:{p['pid']:04x}")
    return out


def underlying(u):
    """The picture behind a signed assets3.razerzone.com URL (the store's own medias host)."""
    m = re.search(r"/(?:\d+x\d+)/(https?%3A%2F%2F[^\"'\s]+)", u)
    if not m:
        return u
    real = urllib.parse.unquote(m.group(1))
    return real


def page_images(slug_):
    cands = sorted(CDX[slug_], key=lambda x: x[1])
    o, ts = cands[-1]
    t = wb_fetch(f"https://web.archive.org/web/{ts}id_/{o}", gap=2).replace("\\u002F", "/")
    seen, thumbs, heroes, others = set(), [], [], []
    for u in IMG.findall(t):
        if "razer" not in u or re.search(r"award|icon|logo|badge|swatch|flag|payment", u, re.I):
            continue
        real = underlying(u)
        if real in seen:
            continue
        seen.add(real)
        if re.search(r"500x500|_500|thumb", real, re.I) and real.endswith(".png"):
            thumbs.append(real)
        elif re.search(r"gallery|hero|carousel|og[-_ ]?image|product", real, re.I) and "78x78" not in u:
            heroes.append(real)
        elif "eeimages/products" in real:
            others.append(real)
    return ts, thumbs, heroes, others


def candidates():
    out = []
    for name, sl in ROWS.items():
        if sl not in CDX:
            print("  no archive for", name, sl, file=sys.stderr)
            continue
        try:
            ts, thumbs, heroes, others = page_images(sl)
        except Exception as e:
            print("  ERR", name, str(e)[:70], file=sys.stderr)
            continue
        urls = []
        for u in thumbs[:2] + heroes[:3] + others[:2]:
            urls.append(u)
            urls.append(f"wb:{ts}:{u}")
        # live first, archived copy right after; the review sheet shows both, a pick is the live or the archived one
        key = slug("razer " + name)
        out.append(dict(key=key, vendor="razer", name="Razer " + name, kind="mouse", ids=pids_of(name), page=f"https://web.archive.org/web/{ts}/https://www.razer.com/gaming-mice/{sl}",
                        names=["Razer " + name, name], note=f"razer.com product page '{sl}', archived {ts}", urls=urls[:8]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "razer2.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
