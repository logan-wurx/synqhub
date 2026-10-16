"""SteelSeries: official steelseries.com product pages (variant URL from the product sitemap) -> first transparent *_img_buy_01 PNG on the page."""
import re, io, requests
from PIL import Image
import numpy as np
from common import UA, job, fetch
B = "https://steelseries.com/"
def s(*p): return [f"1038:{x:04x}" for x in p]
ROWS = [
    ("steelseries-apex-pro-gen-3", "Apex Pro Gen 3", "keyboard", s(0x1640), ["apex pro gen 3", "apex pro 2024"], "gaming-keyboards/apex-pro-gen-3?keyboardSize=fullSize&connectivityType=wired&keyboardLanguage=english&color=black"),
    ("steelseries-apex-pro-tkl-gen-3", "Apex Pro TKL Gen 3", "keyboard", s(0x1642), ["apex pro tkl gen 3", "apex pro tkl 2024"], "gaming-keyboards/apex-pro-gen-3?keyboardSize=tkl&connectivityType=wired&keyboardLanguage=english&color=black"),
    ("steelseries-apex-pro-tkl-wireless-gen-3", "Apex Pro TKL Wireless Gen 3", "keyboard", s(0x1644, 0x1646), ["apex pro tkl wireless gen 3", "apex pro tkl wireless 2024"], "gaming-keyboards/apex-pro-gen-3?keyboardSize=tkl&connectivityType=wireless&keyboardLanguage=english&color=black"),
    ("steelseries-apex-pro-mini-gen-3", "Apex Pro Mini Gen 3", "keyboard", s(0x1648), ["apex pro mini gen 3", "apex pro mini 2024"], "gaming-keyboards/apex-pro-gen-3?keyboardSize=mini&connectivityType=wired&keyboardLanguage=english&color=black"),
    ("steelseries-apex-pro-tkl-cyber", "Apex Pro TKL Gen 3 Cyber", "keyboard", s(0x1660), ["apex pro tkl cyber"], "gaming-keyboards/apex-pro-gen-3?keyboardSize=tkl&connectivityType=wired&keyboardLanguage=english&color=cyber"),
    ("steelseries-apex-pro-tkl-steel", "Apex Pro TKL Gen 3 Steel", "keyboard", s(0x1662), ["apex pro tkl steel"], "gaming-keyboards/apex-pro-gen-3?keyboardSize=tkl&connectivityType=wired&keyboardLanguage=english&color=steel"),
    ("steelseries-apex-pro-tkl-2023", "Apex Pro TKL (2023)", "keyboard", s(0x1628), ["apex pro tkl 2023", "apex pro tkl"], "gaming-keyboards/apex-pro-2023?keyboardLanguage=english&connectivityType=wired"),
    ("steelseries-apex-pro-tkl-wireless-2023", "Apex Pro TKL Wireless (2023)", "keyboard", s(0x1630, 0x1632), ["apex pro tkl wireless 2023", "apex pro tkl wireless"], "gaming-keyboards/apex-pro-2023?keyboardLanguage=english&connectivityType=wireless"),
    ("steelseries-apex-pro", "Apex Pro", "keyboard", s(0x1610, 0x1614), ["apex pro", "apex pro 2019"], "gaming-keyboards/apex-pro?keyboardSize=fullSize&connectivityType=wired&keyboardLanguage=english"),
    ("steelseries-apex-pro-mini", "Apex Pro Mini", "keyboard", s(0x161e), ["apex pro mini"], "gaming-keyboards/apex-pro?keyboardSize=mini&connectivityType=wired&keyboardLanguage=english"),
    ("steelseries-apex-pro-mini-wireless", "Apex Pro Mini Wireless", "keyboard", s(0x1624, 0x1626), ["apex pro mini wireless"], "gaming-keyboards/apex-pro?keyboardSize=mini&connectivityType=wireless&keyboardLanguage=english"),
    ("steelseries-apex-7", "Apex 7", "keyboard", s(0x1612, 0x1652), ["apex 7"], "gaming-keyboards/apex-7?keyboardSize=fullSize&switchType=red-qx2-mechanical&keyboardLanguage=english&color=black"),
    ("steelseries-apex-7-tkl", "Apex 7 TKL", "keyboard", s(0x1618), ["apex 7 tkl"], "gaming-keyboards/apex-7?keyboardSize=tkl&switchType=red-qx2-mechanical&keyboardLanguage=english&color=black"),
    ("steelseries-apex-5", "Apex 5", "keyboard", s(0x161c, 0x1650), ["apex 5"], "gaming-keyboards/apex-5?keyboardLanguage=english"),
    ("steelseries-apex-9-tkl", "Apex 9 TKL", "keyboard", s(0x1634), ["apex 9 tkl"], "gaming-keyboards/apex-9?keyboardSize=tkl&keyboardLanguage=english&color=black"),
    ("steelseries-apex-9-mini", "Apex 9 Mini", "keyboard", s(0x1620), ["apex 9 mini"], "gaming-keyboards/apex-9?keyboardSize=mini&keyboardLanguage=english&color=black"),
    ("steelseries-apex-3", "Apex 3", "keyboard", s(0x161a), ["apex 3"], "gaming-keyboards/apex-3?keyboardSize=fullSize&keyboardLanguage=english&color=black"),
    ("steelseries-apex-3-tkl", "Apex 3 TKL", "keyboard", s(0x1622), ["apex 3 tkl"], "gaming-keyboards/apex-3?keyboardSize=tkl&keyboardLanguage=english&color=black"),
    ("steelseries-apex-100", "Apex 100", "keyboard", [], ["apex 100", "apex 150"], "gaming-keyboards/apex-100?keyboardLanguage=english"),
    # mice (OpenMouse's SteelSeries driver)
    ("steelseries-aerox-9-wireless", "Aerox 9 Wireless", "mouse", s(0x185a, 0x1876, 0x1858, 0x1874), ["aerox 9", "aerox 9 wireless"], "gaming-mice/aerox-9?color=black"),
    ("steelseries-aerox-5", "Aerox 5", "mouse", s(0x1850, 0x1854, 0x185e, 0x1862, 0x1852, 0x185c, 0x1860), ["aerox 5", "aerox 5 wireless"], "gaming-mice/aerox-5?color=black&connectivityType=wireless"),
    ("steelseries-aerox-3", "Aerox 3", "mouse", s(0x1836), ["aerox 3", "aerox 3 wireless"], "gaming-mice/aerox-3-2022?color=onyx&connectivityType=wireless"),
    ("steelseries-sensei-ten", "Sensei Ten", "mouse", s(0x1832, 0x1834), ["sensei ten"], "gaming-mice/sensei-ten"),
    ("steelseries-rival-3-wireless", "Rival 3 Wireless", "mouse", s(0x1830), ["rival 3 wireless"], "gaming-mice/rival-3?connectivityType=wireless"),
    ("steelseries-rival-3", "Rival 3", "mouse", s(0x1824, 0x184c), ["rival 3"], "gaming-mice/rival-3?connectivityType=wired"),
    ("steelseries-rival-650", "Rival 650 Wireless", "mouse", s(0x172b, 0x1726), ["rival 650", "rival 650 wireless"], "gaming-mice/rival-650"),
    ("steelseries-prime", "Prime", "mouse", s(0x182c), ["prime", "prime plus", "prime+"], "gaming-mice/prime?mouseSize=fullSize&connectivityType=wired&model=Plus"),
    ("steelseries-prime-mini-wireless", "Prime Mini Wireless", "mouse", s(0x184a, 0x1848), ["prime mini wireless", "prime mini"], "gaming-mice/prime?mouseSize=mini&connectivityType=wireless&model=Regular"),
]
def pick(h):
    h = h.replace("&amp;", "&")
    imgs = []
    for u in re.findall(r'https://images\.ctfassets\.net/[A-Za-z0-9/_.-]+\.png', h):
        n = u.split("/")[-1]
        if "img_buy_01" in n and not re.search(r"_(us|uk|de|fr|nd|jp|kr|es|it|br|th)\.png$", n) and u not in imgs:
            imgs.append(u)
    return imgs
def jobs():
    out = []
    for key, name, kind, ids, names, path in ROWS:
        page = B + path
        try:
            h = fetch(page, text=True)
        except Exception as e:
            print("page fail", key, str(e)[:80]); continue
        cands = pick(h)
        best = None
        for u in cands[:6]:
            try:
                b = fetch(u + "?w=1000&fm=png")
                im = Image.open(io.BytesIO(b)).convert("RGBA")
                a = np.asarray(im)[..., 3]
                if (a < 20).mean() > 0.2: best = u + "?w=1000&fm=png"; break
            except Exception: pass
        if not best: print("no transparent buy image", key); continue
        out.append(job(key, "steelseries", name, kind, ids, url=best, page=page, names=[name] + names, note="steelseries.com product page, img_buy_01 (Contentful, transparent PNG)"))
    return out
