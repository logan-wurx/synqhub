p='vendors/retail2.py'
s=open(p,encoding='utf8').read()
old='''            j = json.loads(fetch(f"https://{STORE}/products/{rx[7:]}.json", text=True))["product"]
            p = {"title": j["title"], "handle": j["handle"], "images": j["images"]}'''
new='''            h = fetch(f"https://{STORE}/products/{rx[7:]}", text=True)
            imgs = []
            for s_ in re.findall(r'<script type="application/ld\+json">(.*?)</script>', h, re.S):
                try:
                    jj = json.loads(s_)
                except Exception:
                    continue
                for j2 in (jj if isinstance(jj, list) else [jj]):
                    if isinstance(j2, dict) and j2.get("@type") in ("Product", "ProductGroup") and j2.get("image"):
                        im = j2["image"]
                        imgs += im if isinstance(im, list) else [im]
            imgs += re.findall(r'og:image" content="([^"]+)', h)
            p = {"title": rx[7:], "handle": rx[7:], "images": [{"src": u.split("&width")[0]} for u in dict.fromkeys(imgs)]}'''
assert old in s
s=s.replace(old,new)
open(p,'w',encoding='utf8').write(s)
