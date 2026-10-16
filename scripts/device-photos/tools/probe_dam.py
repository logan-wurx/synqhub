"""probe_dam.py: HEAD-check guessed Logitech DAM picture paths for the two discontinued MX mice."""
import requests

B = "https://resource.logitech.com/w_600,c_limit,f_png/d_transparent.gif/content/dam/logitech/en/products/mice/"
UA = {"User-Agent": "Mozilla/5.0"}
cands = []
for fam in ("mx-master-2s", "mx-master-2s-wireless-mouse", "mx-master", "mx-anywhere-2", "mx-anywhere-2s", "mx-anywhere-2s-wireless-mouse"):
    for sub in ("gallery", "product-gallery", "product-gallery/graphite", "product-gallery/black"):
        for n in ("%s-gallery-1.png", "%s-gallery-01.png", "%s-gallery-2.png", "%s-gallery-graphite-1.png", "%s-mouse-top-view-graphite.png", "%s-mouse-top-view-black.png", "%s-top-view.png"):
            cands.append(f"{B}{fam}/{sub}/{n % fam}")
hit = 0
for u in cands:
    try:
        r = requests.head(u, headers=UA, timeout=20, allow_redirects=True)
    except Exception as e:
        continue
    if r.status_code == 200 and "image" in r.headers.get("content-type", ""):
        print("HIT", u)
        hit += 1
print(len(cands), "tried,", hit, "hits")
