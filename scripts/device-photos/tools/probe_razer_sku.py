"""probe_razer_sku.py url...: live razer.com product pages -> og:title and the store thumbnail from the JSON-LD."""
import re, sys, urllib.parse
sys.path.insert(0, ".")
from common import fetch

for u in sys.argv[1:]:
    try:
        t = fetch(u, text=True).replace("\\u002F", "/")
    except Exception as e:
        print(u, "ERR", str(e)[:70])
        continue
    title = re.search(r'<meta property="og:title" content="([^"]+)"', t)
    imgs = re.findall(r'"image": ?"([^"]+)"', t)
    med = []
    for i in imgs:
        real = urllib.parse.unquote(i)
        m = re.search(r"(https://medias-p1\.phoenix\.razer\.com/[^\s\"]+\.(?:png|jpg|webp))", real)
        med.append(m.group(1) if m else real[:100])
    print(u.split("razer.com")[-1], "|", title.group(1) if title else None)
    for m in med[:3]:
        print("     ", m)
