"""probe_logi_page.py url [filter]: every resource.logitech.com picture URL on a logitech.com page."""
import re, sys
sys.path.insert(0, ".")
from common import fetch

t = fetch(sys.argv[1], text=True)
flt = sys.argv[2] if len(sys.argv) > 2 else ""
us = sorted(set(re.findall(r"https://resource\.logitech\.com/[^\"'\s<>)\\]+", t)))
print(len(t), len(us))
for u in us:
    if flt in u:
        print(u[:260])
