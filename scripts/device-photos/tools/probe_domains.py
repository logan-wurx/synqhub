"""probe_domains.py d1 d2 ...: how many products each Shopify store lists publicly (and caches the catalogs)."""
import sys
sys.path.insert(0, ".")
from common import shopify

for d in sys.argv[1:]:
    try:
        items = shopify(d)
    except Exception as e:
        print(d, "ERR", str(e)[:60])
        continue
    print(d, len(items), flush=True)
