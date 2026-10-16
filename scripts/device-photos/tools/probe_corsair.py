import re, sys
sys.path.insert(0, ".")
from common import fetch

t = fetch("https://www.corsair.com/ww-sitemap-products-1.xml", text=True)
locs = [l for l in re.findall(r"<loc>([^<]+)</loc>", t) if "/ww/en/p/" in l]
print(len(locs))
for pat in sys.argv[1:]:
    print(pat, [l.split("/p/")[1][:100] for l in locs if re.search(pat, l)][:6])
