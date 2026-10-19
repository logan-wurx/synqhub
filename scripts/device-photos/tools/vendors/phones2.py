"""Headphones, second build: rows of phones.py whose dealer listings answered only after phones.py was built (several stores
had answered 429), reviewed on the same kind of sheet. A separate vendor so building them does not search phones.py's 113
listings again. Steps: cands2.py phones2, picks in picks/phones2.json (pinned to addresses), build2.py phones2.
Left out after review: Sony WH-1000XM3 (the only listings were for replacement ear pads; the WH-1000XM4 comes from Sony's
image server instead), INZONE H7 (white ear cups on a white ground: neither the matting model nor the flood fill kept them
whole)."""
from rows import R, make
from vendors.phones import TARGETS

KEYS = {"moondrop-may", "moondrop-lan", "tin-hifi-t2", "thieaudio-hype-2", "sennheiser-hd-660-s", "shure-aonic-50", "etymotic-er2xr",
        "final-audio-e3000", "final-audio-e500", "sony-wf-1000xm4", "sony-mdr-7506", "sony-inzone-h9", "sony-inzone-buds",
        "sony-ier-z1r", "jabra-elite-85t", "jabra-elite-75t", "beyerdynamic-dt-1990-pro-mkii", "google-pixel-buds-pro-2"}

# Makers' own renders found through their archived product pages: the page names the picture, the maker's image server
# serves it (Samsung's still answers, transparent at any width; Sony's only through the Wayback Machine, at the largest
# width the archive kept).
TARGET = {r["key"]: r for r in TARGETS}


def maker(key, url, page, note):
    t = TARGET[key]
    return R(key, t["vendor"], t["name"], "headphones", [("img", url)], names=t["names"], page=page, note=note)


MAKER = [
    maker("sony-wh-1000xm4", "wb:20250210043626:https://www.sony.com/image/5d02da5df552836db894cead8a68f5f3?fmt=png-alpha&wid=660&hei=660",
          "https://electronics.sony.com/audio/headphones/headband/p/wh1000xm4-b",
          "Sony's image server as the Wayback Machine kept it (the picture of electronics.sony.com's product page)"),
    maker("samsung-galaxy-buds3-pro",
          "https://images.samsung.com/is/image/samsung/p6pim/us/sm-r630nzwaxar/gallery/us-galaxy-buds3-pro-r630-sm-r630nzwaxar-549769886?wid=1200&hei=1200&fmt=png-alpha",
          "https://www.samsung.com/us/mobile-audio/galaxy-buds3-pro/buy/",
          "Samsung's image server (the gallery picture samsung.com's archived product page names)"),
]

candidates, jobs = make("phones2", [r for r in TARGETS if r["key"] in KEYS] + MAKER, note="maker's own store or an authorised dealer's listing")
