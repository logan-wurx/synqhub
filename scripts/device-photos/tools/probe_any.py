"""probe_any.py url [regex]: status, size, and every image-like URL on the page (optionally filtered by regex)."""
import re, sys
sys.path.insert(0, ".")
from common import fetch

u = sys.argv[1]
flt = re.compile(sys.argv[2], re.I) if len(sys.argv) > 2 else None
try:
    t = fetch(u, text=True)
except Exception as e:
    print("ERR", str(e)[:100])
    sys.exit()
t = t.replace("\\u002F", "/").replace("&amp;", "&")
print(len(t), re.findall(r"<title>([^<]{0,100})", t)[:1])
us = sorted(set(re.findall(r"https?://[^\"'\s<>)\\]+?\.(?:png|jpg|jpeg|webp)(?:\?[^\"'\s<>)\\]*)?", t)))
print(len(us), "images")
for x in us:
    if not flt or flt.search(x):
        print("  ", x[:200])
