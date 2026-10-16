"""Logitech G (newer models the G HUB depots keep encrypted): official logitechg.com product pages -> gallery PNGs from Logitech's DAM
(resource.logitechg.com), transparent. Candidates are reviewed by eye (cands.py); picks in ../picks/logitechg.json."""
import json, re, sys
from common import ROOT, job, slug, fetch

BASE = "https://www.logitechg.com/en-us/shop/p/"
DAM = re.compile(r"https://resource\.logitechg\.com/[^\"' )<>\\]*?/content/dam/(gaming/[^\"' )<>\\]+?\.png)")


def i(*pids):
    return [f"046d:{p:04x}" for p in pids]


# key, name, kind, ids, extra names, product page slug
ROWS = [
    ("logitech-pro-x-superlight-2", "PRO X SUPERLIGHT 2", "mouse", i(0xc09b), ["pro x superlight 2", "g pro x superlight 2", "pro x 2 superlight"], "pro-x2-superlight-wireless-mouse"),
    ("logitech-pro-x-superlight-2-dex", "PRO X SUPERLIGHT 2 DEX", "mouse", i(0xc0a0), ["pro x superlight 2 dex", "pro x 2 dex"], "pro-x-superlight-2-dex"),
    ("logitech-pro-x-superlight-2c", "PRO X SUPERLIGHT 2c", "mouse", [], ["pro x superlight 2c"], "pro-x-superlight-2c"),
    ("logitech-pro-x2-superstrike", "PRO X2 SUPERSTRIKE", "mouse", i(0xc0a8, 0x40bd), ["pro x2 superstrike", "pro x 2 superstrike"], "pro-x2-superstrike-mouse"),
    ("logitech-pro-x3-superstrike", "PRO X3 SUPERSTRIKE", "mouse", i(0xc54f), ["pro x3 superstrike", "pro x 3 superstrike"], "pro-x3-superstrike-mouse"),
    ("logitech-g502-x-plus", "G502 X PLUS", "mouse", [], ["g502 x plus", "g502 x plus wireless"], "g502-x-plus-wireless-lightforce"),
    ("logitech-g502-x-lightspeed", "G502 X LIGHTSPEED", "mouse", [], ["g502 x lightspeed", "g502 x wireless"], "g502-x-wireless-lightforce"),
    ("logitech-g502-x", "G502 X", "mouse", i(0xc099), ["g502 x", "g502 x wired"], "g502-x-wired-lightforce"),
    ("logitech-g-pro-2-lightspeed", "G PRO 2 LIGHTSPEED", "mouse", [], ["g pro 2", "pro 2 lightspeed", "g pro 2 lightspeed"], "pro-2-lightspeed"),
    ("logitech-g309", "G309 LIGHTSPEED", "mouse", [], ["g309"], "g309-lightspeed-gaming-mouse"),
    ("logitech-g305x", "G305X LIGHTSPEED", "mouse", [], ["g305x"], "g305x-lightspeed-wireless-gaming-mouse"),
    ("logitech-pro-x-60", "PRO X 60", "keyboard", i(0xc351), ["pro x 60", "pro x 60 lightspeed"], "pro-x-60-wireless-keyboard"),
    ("logitech-pro-x-tkl-rapid", "PRO X TKL RAPID", "keyboard", [], ["pro x tkl rapid", "pro x tkl"], "pro-x-tkl-rapid"),
    ("logitech-g515-rapid-tkl", "G515 RAPID TKL", "keyboard", [], ["g515 rapid tkl", "g515 rapid", "g515 tkl", "g515 lightspeed tkl"], "g515-rapid-tkl"),
    ("logitech-g715", "G715", "keyboard", i(0xc347), ["g715", "g715 aurora"], "g715-wireless-gaming-keyboard"),
]


def dam_images(slug_):
    t = fetch(BASE + slug_, text=True)
    out = []
    for m in DAM.finditer(t):
        p = m.group(1)
        if p not in out:
            out.append(p)
    return out


def candidates():
    res = []
    for key, name, kind, ids, names, pg in ROWS:
        try:
            imgs = dam_images(pg)
        except Exception as e:
            print("  no page:", key, str(e)[:60], file=sys.stderr)
            continue
        # transparent gallery shots, top views first
        gal = [p for p in imgs if "gallery" in p]
        top = [p for p in gal if "top" in p]
        rest = [p for p in gal if "top" not in p]
        order = (top + rest)[:6]
        if not order:
            print("  no gallery images:", key, file=sys.stderr)
            continue
        res.append(dict(key=key, vendor="logitech", name=name, kind=kind, ids=ids, page=BASE + pg, names=[name] + names,
                        note=f"logitechg.com product page, DAM gallery image", urls=["https://resource.logitechg.com/w_1100,c_limit,f_png/d_transparent.gif/content/dam/" + p for p in order]))
    return res


def jobs():
    picks_f = ROOT / "picks" / "logitechg.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None:
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
