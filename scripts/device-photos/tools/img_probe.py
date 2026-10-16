"""img_probe.py <url> [regex] [n]: the hosts a page loads from, then every picture-like address on it matching the regex
(URL-decoded first; a resizing proxy's inner address is unwrapped). For finding where a maker keeps its product shots."""
import re, sys, urllib.parse
from common import fetch

url = sys.argv[1]
pat = re.compile(sys.argv[2], re.I) if len(sys.argv) > 2 else None
n = int(sys.argv[3]) if len(sys.argv) > 3 else 25
try:
    t = fetch(url, text=True)
except Exception as e:
    print("ERR", str(e)[:120])
    sys.exit()
t = urllib.parse.unquote(t.replace("\\u002F", "/").replace("\\/", "/").replace("&amp;", "&"))
title = re.findall(r"<title>([^<]{0,100})", t)
print(len(t), title[:1])
hosts = {}
for h in re.findall(r"https?://([a-z0-9.\-]+)/", t):
    hosts[h] = hosts.get(h, 0) + 1
print(" hosts:", ", ".join(f"{h} {c}" for h, c in sorted(hosts.items(), key=lambda x: -x[1])[:10]))
seen = []
for m in re.findall(r"https?://[^\"'\s<>)\\,]+", t):
    m = "https://" + m.rsplit("https://", 1)[-1]
    if pat and not pat.search(m):
        continue
    if not pat and not re.search(r"\.(png|jpe?g|webp)", m, re.I):
        continue
    if m not in seen:
        seen.append(m)
for m in seen[:n]:
    print("  ", m[:180])
print(f" [{len(seen)} matches]")
