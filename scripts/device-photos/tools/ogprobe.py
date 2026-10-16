"""ogprobe.py url...: the pictures retail3 would take from each page (first 4, URLs cut to 110 chars)."""
import sys
sys.path.insert(0, ".")
from vendors.retail3 import page_images

for u in sys.argv[1:]:
    ims = page_images(u)
    print(u[:90], len(ims))
    for i in ims[:4]:
        print("     ", i[:110])
