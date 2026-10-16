import re, sys
sys.path.insert(0, ".")
from common import fetch

for u in sys.argv[1:]:
    try:
        t = fetch(u, text=True)
    except Exception as e:
        print(u, "ERR", str(e)[:80])
        continue
    print(u, len(t))
    imgs = [i for i in dict.fromkeys(re.findall(r"https?://[^\"'\s)<>\\]+?\.(?:png|jpg|jpeg|webp)", t)) if re.search(r"asus", i)]
    print(len(imgs))
    for i in imgs[:25]:
        print("   ", i[:170])
    print("   gain:", list(dict.fromkeys(re.findall(r"https://dlcdnwebimgs\.asus\.com/gain/[0-9A-Fa-f-]{36}", t)))[:6])
    print("   og:", re.findall(r'og:image" content="([^"]+)', t)[:2])
    for m in re.findall(r"(?i)(harpe ii ace mini|gladius iv ace max|demon1)[^<]{0,100}", t)[:5]:
        print("   mention:", m)
