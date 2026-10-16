import re, sys
sys.path.insert(0, ".")
from common import fetch

t = fetch("https://www.logitech.com/sitemap.xml", text=True)
locs = [l.replace("https://www.logitech.com/en-us/shop/p/", "") for l in re.findall(r"<loc>([^<]+)</loc>", t) if "/shop/p/" in l]
print(len(locs))
print(" | ".join(l for l in locs if re.search(r"mx-master|mx-anywhere|mx-vertical|mx-ergo|k845|g713|g715|lift|mx-keys", l)))
u = next((l for l in locs if "mx-master-3s" in l), None)
print(u)
if u:
    h = fetch("https://www.logitech.com/en-us/shop/p/" + u, text=True)
    imgs = sorted(set(re.findall(r"https://resource\.logitech\.com/[^\"' )<>\\]+?\.(?:png|webp|jpg)", h)))
    print(len(imgs))
    for i in imgs[:14]:
        print("  ", i.split("/content/dam/")[-1][:120])
