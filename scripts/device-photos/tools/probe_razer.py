import sys, re, json
sys.path.insert(0, ".")
from common import ROOT, wb_fetch

IMG = re.compile(r"https?:[^\"'\s)\\]*\.(?:png|jpg|webp)")
cdx = json.load(open(ROOT / "raw" / "razer-cdx.json"))
for slug in sys.argv[1:]:
    cands = sorted(cdx[slug], key=lambda x: x[1])
    o, ts = cands[-1]
    u = f"https://web.archive.org/web/{ts}id_/{o}"
    try:
        t = wb_fetch(u, gap=2).replace("\\u002F", "/")
    except Exception as e:
        print(slug, "ERR", str(e)[:80])
        continue
    print(slug, ts, len(t))
    im = [i for i in dict.fromkeys(IMG.findall(t)) if "razer" in i and "award" not in i and "icon" not in i]
    print(len(im))
    print("\n".join(i[:150] for i in im[:8]))
    print(re.findall(r'"image": ?"([^"]+)"', t)[:1], re.findall(r'og:image" content="([^"]+)', t)[:1])
