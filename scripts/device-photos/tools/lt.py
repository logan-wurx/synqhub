"""lt.py <domain|woo:https://base> [regex]: list a store's product titles (with image counts); regex filters title+handle."""
import sys, re
sys.path.insert(0, ".")
from common import shopify, woo

d = sys.argv[1]
rx = sys.argv[2] if len(sys.argv) > 2 else "."
items = woo(d[4:]) if d.startswith("woo:") else shopify(d)
print("==", d, len(items))
for p in items:
    if p["images"] and re.search(rx, (p["title"] + " " + p["handle"]).lower()):
        print(f"  {p['title'][:70]} <{p['handle'][:48]}> {len(p['images'])}")
