"""Razer: official product pages (www.razer.com, product sitemap) -> JSON-LD store thumbnail (transparent 500px PNG)."""
import re, json, requests, urllib.parse, concurrent.futures as cf
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"}
idx = open("../src/razer-sitemap.xml", encoding="utf8").read()
locs = re.findall(r"<loc>([^<]+)</loc>", idx)
us = [l for l in locs if "/Product-en-US" in l][0]
sm = requests.get(us, headers=UA, timeout=90).text
urls = re.findall(r"<loc>([^<]+)</loc>", sm)
print(len(urls), "product urls")
prods = {}
for u in urls:
    m = re.match(r"https://www\.razer\.com/(?:[a-z]{2}-[a-z]{2}/)?(gaming-mice|gaming-keyboards|keyboards|mice)/([^/]+)/([^/?#]+)", u)
    if m: prods.setdefault((m.group(1), m.group(2)), []).append(u)
print(len(prods), "mouse/keyboard slugs")
def page(item):
    (cat, slug), us_ = item
    for u in [f"https://www.razer.com/{cat}/{slug}"] + us_[:1]:
        try:
            r = requests.get(u, headers=UA, timeout=60)
            if r.status_code != 200: continue
            t = r.text.replace("\u002F", "/")
            m = re.search(r'"image": "([^"]+)"', t)
            if not m: continue
            real = urllib.parse.unquote(m.group(1))
            med = re.search(r"(https://medias-p1\.phoenix\.razer\.com/[^\s\"]+\.(?:png|jpg|webp))", real)
            name = re.search(r'<meta property="og:title" content="([^"]+)"', t)
            return {"cat": cat, "slug": slug, "page": u, "image": med.group(1) if med else None, "signed": m.group(1), "title": name.group(1) if name else None}
        except Exception as e:
            err = str(e)[:100]
    return {"cat": cat, "slug": slug, "error": "no image"}
out = []
with cf.ThreadPoolExecutor(8) as ex:
    for i, r in enumerate(ex.map(page, prods.items())):
        out.append(r)
json.dump(out, open("razer-pages.json", "w"), indent=1)
print(sum(1 for o in out if o.get("image")), "with image of", len(out))
