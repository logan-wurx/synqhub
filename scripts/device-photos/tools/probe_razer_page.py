"""probe_razer_page.py url: every picture URL on a live razer.com page (og:image, JSON-LD, medias host)."""
import re, sys, urllib.parse
sys.path.insert(0, ".")
from common import fetch

u = sys.argv[1]
t = fetch(u, text=True).replace("\\u002F", "/").replace("&amp;", "&")
print(len(t))
print("og:", re.findall(r'og:image" content="([^"]+)"', t))
print("ld blocks:", len(re.findall(r"application/ld\+json", t)))
seen = []
for m in re.finditer(r"https://medias-p1\.phoenix\.razer\.com/[^\s\"'\\)]+\.(?:png|jpg|webp)", urllib.parse.unquote(t)):
    if m.group(0) not in seen:
        seen.append(m.group(0))
print(len(seen), "medias pictures")
for s in seen[:30]:
    print("  ", s)
i = t.find('"image"')
print(t[i - 100:i + 400] if i >= 0 else "no image key")
