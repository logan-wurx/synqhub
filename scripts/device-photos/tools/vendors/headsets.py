"""Gaming headsets: official product pictures from the makers' own sites, matched to the headset ids in
src/lib/headsets/headsets.json (the families SYNQ drives). Sources: steelseries.com product pages (Contentful renders),
logitechg.com product pages (the gallery renders on resource.logitechg.com) and HyperX's own Shopify store. Candidates are
reviewed by eye (cands2.py headsets), cut with proc2 (rembg when a picture is not transparent), picks in picks/headsets.json.

Each row: (key, vendor folder, display name, USB ids, extra names, sources), sources as in pads.py. Special editions of a
model (Diablo IV, WoW) carry their own ids and their own picture; the Nova 7 and 7X variants share their model's."""
import json, sys
from common import ROOT, job
from vendors.pads import page_of, urls_of


def i(vid, *pids):
    return [f"{vid}:{p:04x}" for p in pids]


SS = "https://steelseries.com/gaming-headsets/"
LG = "https://www.logitechg.com/en-us/products/gaming-audio/"

ROWS = [
    ("steelseries-arctis-nova-7", "steelseries", "SteelSeries Arctis Nova 7", i("1038", 0x2202, 0x22A1), ["arctis nova 7", "steelseries arctis nova 7"],
     [("grab", SS + "arctis-nova-7", r"arctis_nova_7_black_pdp_img_buy")]),
    ("steelseries-arctis-nova-7x", "steelseries", "SteelSeries Arctis Nova 7X", i("1038", 0x2206, 0x2258, 0x229E, 0x22AD, 0x22A4, 0x22A5), ["arctis nova 7x", "steelseries arctis nova 7x"],
     [("grab", SS + "arctis-nova-7", r"arctis_nova_7x_black_pdp_img_buy")]),
    ("steelseries-arctis-nova-7-diablo-iv", "steelseries", "SteelSeries Arctis Nova 7 Diablo IV", i("1038", 0x223A, 0x22A9), ["arctis nova 7 diablo iv"],
     [("grab", SS + "arctis-nova-7", r"diablo_4_pdp_img_buy")]),
    ("steelseries-arctis-nova-7-wow", "steelseries", "SteelSeries Arctis Nova 7 WoW Edition", i("1038", 0x227A), ["arctis nova 7 wow edition"],
     [("grab", SS + "arctis-nova-7", r"arctis_nova_7_wow_img_buy")]),
    ("steelseries-arctis-nova-7-gen-2", "steelseries", "SteelSeries Arctis Nova 7 Wireless Gen 2", i("1038", 0x227E), ["arctis nova 7 wireless gen 2", "arctis nova 7 gen 2"],
     [("grab", SS + "arctis-nova-7-gen-2", r"arctis_nova_7_wl_gen_2_(black|white)_pdp_img_buy")]),
    ("logitech-g535", "logitech", "Logitech G535", i("046d", 0x0AC4), ["g535", "logitech g535", "g535 wireless"],
     [("grab", LG + "g535-wireless-headset.981-000971.html", r"g535-wireless-gallery")]),
    ("logitech-pro-x-2", "logitech", "Logitech PRO X 2", i("046d", 0x0AFB, 0x0AFC), ["pro x 2", "logitech pro x 2", "pro x 2 lightspeed"],
     [("grab", LG + "pro-x-2-wireless-headset.981-001262.html", r"gallery-\d-pro-x-2-lightspeed-gaming-headset-black")]),
    ("logitech-g733", "logitech", "Logitech G733", i("046d", 0x0AB5, 0x0AFE, 0x0B1F), ["g733", "logitech g733"],
     [("grab", LG + "g733-rgb-wireless-headset.981-000863.html", r"g733-black-gallery")]),
    ("hyperx-cloud-ii-wireless", "hyperx", "HyperX Cloud II Wireless", i("03f0", 0x0696, 0x018B), ["cloud ii wireless", "hyperx cloud ii wireless"],
     [("shop", "hyperx.com", "hyperx-cloud-ii-wireless")]),
]


def candidates():
    out = []
    for key, vendor, name, ids, names, sources in ROWS:
        urls = urls_of(sources)
        if not urls:
            print("  no pictures:", key, file=sys.stderr)
        out.append(dict(key=key, vendor=vendor, name=name, kind="headset", ids=ids, page=page_of(sources), names=[name] + names,
                        note="maker's own site", urls=urls[:10]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "headsets.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None or sel >= len(c["urls"]):
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
