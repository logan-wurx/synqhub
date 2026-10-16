import sys, re
sys.path.insert(0, ".")
from common import wb_fetch

IMG = re.compile(r"https?:[^\"'\s)\\]*\.(?:png|jpg|webp)")
for ts, u in (("20200816021445", "https://www.razer.com/gaming-mice"), ("20190227082533", "https://www2.razer.com/ap-en/gaming-mice")):
    try:
        t = wb_fetch(f"https://web.archive.org/web/{ts}id_/{u}", gap=3)
    except Exception as e:
        print(ts, "ERR", e)
        continue
    t = t.replace("\\u002F", "/")
    imgs = sorted(set(IMG.findall(t)))
    print(ts, len(t), len(imgs))
    for i in imgs[:80]:
        print("  ", i[:170])
