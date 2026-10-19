"""Shared plumbing for the final-pass vendor modules (vendors/own.py, phones.py, pads3.py, lights3.py, displays3.py, kb6.py,
mice3.py): a module lists rows made with R(), and make(<vendor>, ROWS) gives it the candidates() / jobs() pair that cands2.py
and build2.py call. Picks are in picks/<vendor>.json as {key: index} (an index into the row's candidate list) or
{key: "<address>"} (that picture itself, for one found by hand).

A source is one of the pads.py kinds, plus:
  ("shopq", domain, regex)     the pictures of the Shopify products whose title matches the regex (from /products.json)
  ("wbgrab", page, regex)      the pictures the Wayback Machine's copies of a page linked (live address when it still
                               answers, else the archived copy), as wayback3.py does
  ("og", page)                 the page's og:image (a maker's share picture is often its main product shot)
  ("ids", page, (regex, fmt))  picture ids read off the page, each served at fmt.format(id) (as displays.py does)
  ("retail", regex, stores)    the first product per store (in order) whose title matches the regex and is not an open-box,
                               refurbished, bundle or accessory listing: authorised dealers' Shopify stores, the last resort
A picture's own product page is remembered (PAGES), so SOURCES.json names the listing it came from.
Nothing fetched is ever executed; every address is cached under ../cache."""
import json, re, sys
from common import ROOT, job, fetch, norm_name
from vendors.pads import urls_of as pad_urls, page_of as pad_page, html


def R(key, vendor, name, kind, sources, ids=(), names=(), **opts):
    """One model: its picture key, vendor folder, display name, kind, sources, USB ids ("vid:pid"), other names it is
    known by, and processing options (crop, soft, feather, bridge, force, flood: see build2.py / proc2.py)."""
    return dict(key=key, vendor=vendor, name=name, kind=kind, sources=list(sources), ids=list(ids), names=list(names), opts=opts)


_STORES = {}


def store(domain):
    """{handle: (title, [picture addresses])} of a Shopify store, from its public /products.json (read once per run)."""
    if domain not in _STORES:
        out = {}
        for page in range(1, 41):
            try:
                ps = json.loads(fetch(f"https://{domain}/products.json?limit=250&page={page}", text=True)).get("products", [])
            except Exception as e:
                print("  listing failed:", domain, str(e)[:60], file=sys.stderr)
                break
            if not ps:
                break
            out.update({p["handle"]: (p.get("title", ""), [im["src"] for im in p.get("images", [])]) for p in ps})
        _STORES[domain] = out
    return _STORES[domain]


PAGES = {}
# Listings that are not the product alone: open-box and used stock, bundles, accessories "for" another product.
SKIP = re.compile(r"open[- ]?box|b[- ]stock|refurb|renewed|pre-?owned|\bused\b|\bdemo\b|bundle|\+ |replacement|upgrade cable|ear ?pads|ear ?tips|"
                  r"eartips|\bfor (?:the )?(?!pc|gaming|xbox|playstation|ps5|switch|iphone|android|mac)", re.I)


def _shop_pics(domain, handle, ims, n=None):
    out = [("https:" + s if s.startswith("//") else s).split("?")[0] + "?width=1600" for s in ims[:n]]
    for u in out:
        PAGES.setdefault(u, f"https://{domain}/products/{handle}")
    return out


def shopq(domain, pattern):
    out = []
    for handle, (title, ims) in store(domain).items():
        if re.search(pattern, title, re.I) or re.search(pattern, handle.replace("-", " "), re.I):
            out += _shop_pics(domain, handle, ims)
    return out


def retail(pattern, stores, per_store=1, most=24):
    out = []
    for dom in stores:
        hits = 0
        for handle, (title, ims) in store(dom).items():
            if hits >= per_store or not re.search(pattern, title, re.I) or SKIP.search(title):
                continue
            out += _shop_pics(dom, handle, ims, 6)
            hits += 1
        if len(out) >= most:
            break
    return out


def og(page):
    t = html(page)
    m = re.search(r"""<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)""", t) or re.search(r"""<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image""", t)
    if not m:
        return []
    u = m.group(1)
    return ["https:" + u if u.startswith("//") else u]


def wbgrab(page, pattern):
    from vendors.wayback3 import page_pictures, live_ok, wb_ok
    urls = []
    for u, ts in page_pictures(page, pattern):
        if len(urls) >= 8:
            break
        if live_ok(u):
            urls.append(u)
        elif wb_ok(ts, u):
            urls.append(f"wb:{ts}:{u}")
    return urls


def urls_of(sources):
    out = []
    for s in sources:
        kind = s[0]
        if kind == "shopq":
            got = shopq(s[1], s[2])
        elif kind == "retail":
            got = retail(s[1], s[2], *s[3:])
        elif kind == "wbgrab":
            got = wbgrab(s[1], s[2])
        elif kind == "og":
            got = og(s[1])
        elif kind == "ids":
            from vendors.displays import ids
            got = ids(s[1], *s[2])
        else:
            got = pad_urls([s])
        out += [u for u in got if u not in out]
    return out


def page_of(sources):
    for s in sources:
        if s[0] in ("og", "ids"):
            return s[1]
        if s[0] == "wbgrab":
            return "https://web.archive.org/web/2/" + s[1]
        if s[0] == "shopq":
            return f"https://{s[1]}"
    return pad_page([s for s in sources if s[0] != "retail"])


def make(vendor, rows, note="maker's own site", limit=12):
    """(candidates, jobs) for a list of R() rows."""

    def candidates(only=None, look=True):
        """The rows (only those asked for), each with its candidate addresses; look=False skips the search (a pinned pick
        needs none, and an archived page takes long to read again)."""
        out = []
        for r in rows:
            if only and r["key"] not in only:
                continue
            urls = urls_of(r["sources"]) if look else []
            if look and not urls:
                print("  no pictures:", r["key"], file=sys.stderr)
            how = r["opts"].get("note") or note
            names = [r["name"]] + [n for n in r["names"] if norm_name(n) != norm_name(r["name"])]
            out.append(dict(key=r["key"], vendor=r["vendor"], name=r["name"], kind=r["kind"], ids=r["ids"], page=r["opts"].get("page") or page_of(r["sources"]),
                            names=names, note=how, urls=urls[:limit], opts=r["opts"]))
        return out

    def jobs():
        picks_f = ROOT / "picks" / f"{vendor}.json"
        picks = json.load(open(picks_f)) if picks_f.exists() else {}
        # Rows with an index pick need their candidates; a pinned (address) pick only needs the page it came from, which a
        # store listing knows and an archived page does not change.
        searched = {r["key"] for r in rows if isinstance(picks.get(r["key"]), int)
                    or (isinstance(picks.get(r["key"]), str) and any(s[0] in ("retail", "shopq", "shop") for s in r["sources"]))}
        rest = set(picks) - searched
        cands = (candidates(only=searched) if searched else []) + (candidates(only=rest, look=False) if rest else [])
        out = []
        for c in cands:
            sel = picks.get(c["key"])
            if sel is None:
                continue
            if isinstance(sel, str):
                url, which = sel, "picture picked by eye"
            elif sel < len(c["urls"]):
                url, which = c["urls"][sel], f"image {sel + 1}"
            else:
                print("  pick out of range:", c["key"], sel, file=sys.stderr)
                continue
            page = PAGES.get(url) or c["page"]
            j = job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=url, page=page, names=c["names"], note=f"{c['note']} ({which})")
            for k in ("crop", "soft", "feather", "bridge", "force", "flood"):
                if k in c["opts"]:
                    j[k] = c["opts"][k]
            out.append(j)
        return out

    return candidates, jobs
