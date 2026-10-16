"""Models only retailers still sell: explicit product-page URLs (found by search), every picture cut with rembg and reviewed by eye.
Pictures come from the page itself: Shopify's product .js (all images), JSON-LD Product images, og:image / twitter:image.
Row: (brand, key, display name, kind, ids or OpenMouse regex, extra names, [page urls])."""
import json, re, sys, urllib.parse
from common import ROOT, job, slug, fetch
from vendors.stores2 import omids


def i(vid, *pids):
    return [f"{vid}:{p:04x}" for p in pids]


ROWS = [
    # filled by the search pass (see picks/retail3.json for what was chosen)
]
FORCE = {"ajazz-ak680-max"}   # opaque white backgrounds hiding behind a stray transparent corner: matte with rembg anyway
ROWS_FILE = ROOT / "tools" / "retail3-rows.json"


def load_rows():
    rows = list(ROWS)
    if ROWS_FILE.exists():
        rows += [tuple(r) for r in json.load(open(ROWS_FILE, encoding="utf8"))]
    return rows


_cats = {}


def store_page(spec):
    """'store:<domain>:<title regex>' -> (page url, [image urls]) from that Shopify store's catalog."""
    import shop
    _, dom, rx = spec.split(":", 2)
    cat = _cats.get(dom) or _cats.setdefault(dom, shop.catalog(dom, set()))
    p = next((x for x in cat if re.search(rx, x["title"], re.I)), None)
    if not p:
        print("  no product:", spec[:70], file=sys.stderr)
        return None, []
    return f"https://{dom}/products/{p['handle']}", [(i["src"] + ("&" if "?" in i["src"] else "?") + "width=1100") for i in p["images"][:6]]


def page_images(url):
    out = []
    try:
        if "/products/" in url and "shopify" not in url:
            base = url.split("?")[0].rstrip("/")
            try:
                j = json.loads(fetch(base + ".js", text=True))
                for im in j.get("images", []):
                    out.append(("https:" + im if im.startswith("//") else im).split("?")[0])
            except Exception:
                pass
        h = fetch(url, text=True)
    except Exception as e:
        print("  page failed:", url[:70], str(e)[:50], file=sys.stderr)
        return out
    for s_ in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', h, re.S):
        try:
            jj = json.loads(s_)
        except Exception:
            continue
        for j2 in (jj if isinstance(jj, list) else [jj]):
            if isinstance(j2, dict) and j2.get("@graph"):
                for g in j2["@graph"]:
                    if isinstance(g, dict) and g.get("@type") in ("Product", "ProductGroup") and g.get("image"):
                        im = g["image"]
                        out += [x if isinstance(x, str) else x.get("url", "") for x in (im if isinstance(im, list) else [im])]
            if isinstance(j2, dict) and j2.get("@type") in ("Product", "ProductGroup") and j2.get("image"):
                im = j2["image"]
                out += [x if isinstance(x, str) else x.get("url", "") for x in (im if isinstance(im, list) else [im])]
    out += re.findall(r'<meta[^>]+(?:property|name)="(?:og:image|twitter:image)(?::secure_url)?"[^>]+content="([^"]+)"', h)
    out += re.findall(r'<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="(?:og:image|twitter:image)"', h)
    clean = []
    for u in out:
        u = u.replace("&amp;", "&")
        if u.startswith("//"):
            u = "https:" + u
        if not u.startswith("http") or re.search(r"logo|favicon|sprite|banner|badge|icon", u, re.I):
            continue
        if u not in clean:
            clean.append(u)
    return clean


def candidates():
    out = []
    for brand, key, name, kind, ids, names, pages in load_rows():
        urls = []
        pages = list(pages)
        for k, p in enumerate(pages):
            if p.startswith("img:"):
                ims = [p[4:]]
            elif p.startswith("store:"):
                pg, ims = store_page(p)
                if pg:
                    pages[k] = pg
                else:
                    ims = []
            else:
                ims = page_images(p)
            for u in ims:
                if u not in urls:
                    urls.append(u)
        pages = [p for p in pages if not p.startswith(("store:", "img:"))]
        if not pages:
            continue
        if not urls:
            print("  no images:", key, file=sys.stderr)
            continue
        idl = ids if isinstance(ids, list) else omids(brand, ids)
        out.append(dict(key=key, vendor=slug(brand), name=name, kind=kind, ids=idl, page=pages[0], names=[name] + list(names), note=f"retailer listing {urllib.parse.urlparse(pages[0]).netloc}", urls=urls[:6]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "retail3.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        j = job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})")
        if c["key"] in FORCE:
            j["force"] = True
        out.append(j)
    return out
