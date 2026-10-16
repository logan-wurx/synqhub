"""find.py "<query words>" ...: every cached retailer catalog is searched for products whose title/handle contain ALL the words of each query."""
import sys, re
sys.path.insert(0, ".")
from common import shopify, woo, toks

STORES = ["mechkeys.com", "kbdfans.com", "epomaker.com", "divinikey.com", "cidootech.com", "ajazzstore.com", "aulagear.com", "lofree.co", "keebmonkey.com", "cannonkeys.com",
          "novelkeys.com", "mmkeyboard.com", "redragonshop.com", "keychron.com", "attackshark.com", "gloriousgaming.com", "endgamegear.com", "wlmouse.com", "ninjutso.com",
          "pulsar.gg", "lamzu.com", "mchose.store", "hyperx.com", "woo:https://www.monsgeek.com", "woo:https://en.akkogear.com", "monsgeek.eu", "akkogear.eu", "pay.nuphy.com", "dangerfield.com.au", "whatgeek.com", "www.vtenh.com"]
JUNK = set("keycaps keycap switch switches cable skates skate grip tape pad mousepad lube sticker stabilizers stabilizer plate dongle case sleeve film wrist rest".split())
CATS = {}


def cat(d):
    if d not in CATS:
        try:
            CATS[d] = woo(d[4:]) if d.startswith("woo:") else shopify(d)
        except Exception:
            CATS[d] = []
    return CATS[d]


for q in sys.argv[1:]:
    qt = toks(q)
    print("##", q)
    n = 0
    for d in STORES:
        for p in cat(d):
            if not p["images"]:
                continue
            tt = set(toks(p["title"] + " " + p["handle"].replace("-", " ")))
            if all(t in tt for t in qt) and not (set(toks(p["title"])) & JUNK):
                print(f"   [{d.replace('woo:https://', '')}] {p['title'][:72]} <{p['handle'][:40]}> {len(p['images'])}")
                n += 1
                if n >= 14:
                    break
        if n >= 14:
            break
