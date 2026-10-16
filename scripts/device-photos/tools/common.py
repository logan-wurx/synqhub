import re, json, hashlib, pathlib, requests, time
ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "cache"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "Accept": "image/avif,image/webp,image/png,image/*,*/*;q=0.8"}
CACHE.mkdir(parents=True, exist_ok=True)
S = requests.Session()
S.headers.update(UA)

def fetch(url, headers=None, text=False, timeout=60, tries=2):
    """Cached GET. Returns bytes (or str). Raises on HTTP errors. "wb:<timestamp>:<url>" reads that archived picture from web.archive.org."""
    if url.startswith("wb:"):
        _, ts, orig = url.split(":", 2)
        return wb_fetch(f"https://web.archive.org/web/{ts}im_/{orig}", text=text)
    key = hashlib.sha1(url.encode()).hexdigest()
    f = CACHE / key
    if f.exists():
        b = f.read_bytes()
        return b.decode("utf8", "replace") if text else b
    last = None
    for i in range(tries):
        try:
            r = S.get(url, headers=headers or {}, timeout=timeout)
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code} {url}")
            f.write_bytes(r.content)
            return r.text if text else r.content
        except Exception as e:
            last = e
            time.sleep(1)
    raise last

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

def toks(s):
    s = s.lower().replace("+", " plus ").replace("&", " and ")
    return [t for t in re.split(r"[^a-z0-9]+", s) if t]

def norm_name(s):
    """The comparison form of a product name: lower case words joined by single spaces."""
    return " ".join(toks(s))

def job(key, vendor, name, kind, ids=(), url=None, file=None, page=None, note="", names=()):
    return dict(key=key, vendor=vendor, name=name, kind=kind, ids=sorted(set(ids)), url=url, file=file, page=page, note=note, names=list(names))

def shopify(domain, pages=8):
    """All products of a Shopify store ({title, handle, product_type, tags, images:[{src,width,height}]}); [] when the store has no public products.json."""
    out = []
    for p in range(1, pages + 1):
        try:
            t = fetch(f"https://{domain}/products.json?limit=250&page={p}", text=True, timeout=40)
            items = json.loads(t).get("products", [])
        except Exception as e:
            break
        if not items: break
        out += items
        if len(items) < 250: break
    return out

def woo(base, per=100, pages=12):
    """WooCommerce Store API products ({title, handle, images:[{src}]}); same shape as shopify()."""
    out = []
    for p in range(1, pages + 1):
        try:
            t = fetch(f"{base}/wp-json/wc/store/v1/products?per_page={per}&page={p}", text=True, timeout=90)
            items = json.loads(t)
        except Exception:
            break
        if not items: break
        for it in items:
            out.append({"title": re.sub(r"&#?\w+;", " ", it.get("name", "")), "handle": it.get("slug", ""), "product_type": "", "images": [{"src": i["src"], "width": 0, "height": 0} for i in it.get("images", [])]})
        if len(items) < per: break
    return out


_last_wb = [0.0]


def wb_fetch(url, text=True, gap=5.0, tries=6):
    """Polite web.archive.org fetch (cached): one request every `gap` seconds, backing off on 429."""
    key = hashlib.sha1(url.encode()).hexdigest()
    f = CACHE / key
    if f.exists():
        b = f.read_bytes()
        return b.decode("utf8", "replace") if text else b
    wait = 20
    for i in range(tries):
        dt = time.time() - _last_wb[0]
        if dt < gap:
            time.sleep(gap - dt)
        _last_wb[0] = time.time()
        try:
            r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=120)
        except Exception:
            time.sleep(5)
            continue
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(wait)
            wait = min(wait * 2, 120)
            continue
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code} {url}")
        f.write_bytes(r.content)
        return r.text if text else r.content
    raise RuntimeError(f"Wayback gave up: {url}")
