"""probe_razer_pool.py: harvest every store thumbnail (500x500 transparent PNG) that a handful of live razer.com pages link to (their 'related products' carousels)."""
import re, sys, urllib.parse, json
sys.path.insert(0, ".")
from common import fetch

PAGES = [
    "https://www.razer.com/gaming-mice/razer-viper-v4-pro",
    "https://www.razer.com/gaming-mice/razer-deathadder-v4-pro",
    "https://www.razer.com/gaming-mice/razer-basilisk-v4-pro",
    "https://www.razer.com/gaming-mice/razer-naga-v3-pro",
    "https://www.razer.com/gaming-mice/razer-cobra-pro",
    "https://www.razer.com/gaming-mice/razer-deathadder-v3-hyperspeed",
    "https://www.razer.com/gaming-keyboards/razer-huntsman-v3-pro-8khz/RZ03-05740200-R3U1",
    "https://www.razer.com/gaming-keyboards/razer-blackwidow-v4-pro",
    "https://www.razer.com/gaming-keyboards/razer-huntsman-v3-he-magnetic-8khz/RZ03-05930200-R3U1",
    "https://www.razer.com/gaming-mice",
    "https://www.razer.com/gaming-keyboards",
]
pool = {}
for p in PAGES:
    try:
        t = urllib.parse.unquote(fetch(p, text=True).replace("\\u002F", "/").replace("&amp;", "&"))
    except Exception as e:
        print("ERR", p, str(e)[:60])
        continue
    n = 0
    for m in re.finditer(r"https://medias-p1\.phoenix\.razer\.com/[^\s\"'\\)]+?\.(?:png|jpg|webp)", t):
        u = m.group(0)
        name = u.rsplit("/", 1)[1]
        if re.search(r"500x500|_500|thumb", name, re.I) and u not in pool.values():
            pool.setdefault(name, u)
            n += 1
    print(p.split("razer.com")[-1], n)
json.dump(pool, open("../raw/razer-pool.json", "w"), indent=1)
print(len(pool), "thumbnails")
for k in sorted(pool):
    print("  ", k)
