import sys, re
sys.path.insert(0, ".")
from common import shopify

# usage: list_titles.py domain regex
d, rx = sys.argv[1], sys.argv[2]
items = shopify(d)
print("==", d, len(items))
print(" | ".join(f"{p['title'][:60]}<{p['handle'][:40]}>" for p in items if re.search(rx, (p["title"] + " " + p["handle"]).lower()) and p["images"])[:3000])
