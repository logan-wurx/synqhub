"""Models whose own product page is gone from the maker's / retailer's live site: the page as the Wayback Machine kept it -> the product pictures it linked.
A picture is taken from the live CDN when it still answers (same URL, still hosted), else from the archived copy ('wb:<timestamp>:<url>').
Rows: ../tools/wayback3-rows.json  [brand, key, display name, kind, ids or OpenMouse regex, extra names, [page url, ...], [image url regex or '']]."""
import json, re, sys, urllib.parse
import requests
from common import ROOT, job, slug, fetch, wb_fetch
from vendors.stores2 import omids

ROWS_FILE = ROOT / "tools" / "wayback3-rows.json"
IMG = re.compile(r"(?:https?:)?//[^\"'\s<>)\\]+?\.(?:png|jpg|jpeg|webp)(?:\?[^\"'\s<>)\\]*)?", re.I)


def snapshots(url, n=4):
    q = f"http://web.archive.org/cdx/search/cdx?url={urllib.parse.quote(url, safe=':/')}&output=txt&fl=timestamp,original&filter=statuscode:200&collapse=digest&limit=40"
    try:
        t = wb_fetch(q, gap=3)
    except Exception as e:
        print("  cdx failed:", url[:60], str(e)[:40], file=sys.stderr)
        return []
    rows = [l.split(" ", 1) for l in t.strip().splitlines() if " " in l and not l.startswith("<")]
    # spread over the available history: newest, oldest, and the middle
    if len(rows) > n:
        idx = sorted({0, len(rows) - 1, len(rows) // 2, len(rows) // 4})
        rows = [rows[i] for i in idx][:n]
    return rows


def live_ok(u):
    try:
        r = requests.get(u, headers={"User-Agent": "Mozilla/5.0"}, timeout=30, stream=True)
        ok = r.status_code == 200 and "image" in r.headers.get("content-type", "") and int(r.headers.get("content-length", "99999")) > 6000
        r.close()
        return ok
    except Exception:
        return False


def wb_ok(ts, u):
    """The archived copy of a picture answers (a polite HEAD, one every 1.5 s)."""
    import time
    time.sleep(1.5)
    try:
        r = requests.head(f"https://web.archive.org/web/{ts}im_/{u}", headers={"User-Agent": "Mozilla/5.0"}, timeout=40, allow_redirects=True)
        return r.status_code == 200 and "image" in r.headers.get("content-type", "")
    except Exception:
        return False


def page_pictures(url, pat):
    out = []
    for ts, orig in snapshots(url):
        try:
            t = wb_fetch(f"https://web.archive.org/web/{ts}id_/{orig}", gap=3).replace("\\u002F", "/").replace("&amp;", "&")
        except Exception as e:
            print("  snapshot failed:", ts, orig[:50], str(e)[:30], file=sys.stderr)
            continue
        for u in IMG.findall(t):
            if re.search(r"logo|favicon|sprite|icon|badge|banner|swatch|flag", u, re.I):
                continue
            if pat and not re.search(pat, u, re.I):
                continue
            if "resource.logitech.com" in u:
                m = re.search(r"/content/dam/(.+)$", u)
                if m:
                    u = "https://resource.logitech.com/w_1100,c_limit,f_png/d_transparent.gif/content/dam/" + m.group(1)
            if u.startswith("//"):
                u = "https:" + u
            u = u.split("&amp;")[0]
            if u not in [x[0] for x in out]:
                out.append((u, ts))
    return out


def candidates():
    out = []
    rows = json.load(open(ROWS_FILE, encoding="utf8")) if ROWS_FILE.exists() else []
    for brand, key, name, kind, ids, names, pages, pat in rows:
        pics = []
        for p in pages:
            pics += [x for x in page_pictures(p, pat) if x[0] not in [y[0] for y in pics]]
        urls = []
        for u, ts in pics:
            if len(urls) >= 6:
                break
            if live_ok(u):
                urls.append(u)
            elif wb_ok(ts, u):
                urls.append(f"wb:{ts}:{u}")
        if not urls:
            print("  no pictures:", key, file=sys.stderr)
            continue
        idl = ids if isinstance(ids, list) else omids(brand, ids)
        out.append(dict(key=key, vendor=slug(brand), name=name, kind=kind, ids=idl, page=pages[0], names=[name] + list(names), note="web.archive.org snapshot of " + pages[0].split("//")[-1][:60], urls=urls))
    return out


def jobs():
    picks_f = ROOT / "picks" / "wayback3.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
