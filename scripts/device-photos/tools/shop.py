"""Shopify product matching + image choice (shared by the store-based vendor modules)."""
import io, re, sys
import numpy as np
from PIL import Image
from common import fetch, shopify, woo, toks, job
import proc

BAD = set("""skate skates grip tape dongle receiver pad mousepad mouse-pad cable cord bungee case sleeve seal sticker switch switches pack keycap keycaps stand wrist rest
addon add-on gift card sample replacement battery charging dock bundle cover foot feet glass sapphire teflon ptfe lizard skin skins stabilizer lube tool kit hat shirt tee hoodie
bag poster print box superglide glide for pcs set kits compatible membership donation voucher warranty protection plate stick refund reimbursement booster pre-order preorder""".split())

BAD_KB = BAD - {"switch", "switches", "pack", "stand", "wrist", "rest", "kit", "box"}

def catalog(domain, bad=None):
    bad = BAD if bad is None else bad
    out = []
    items = woo(domain[4:]) if domain.startswith("woo:") else shopify(domain)
    for p in items:
        if not p.get("images"): continue
        if set(toks(p["title"])) & bad: continue
        out.append({"title": p["title"], "handle": p["handle"], "toks": toks(p["title"] + " " + p["handle"].replace("-", " ")), "tset": set(toks(p["title"])), "images": p["images"], "type": p.get("product_type", "")})
    return out

NOISE = {"gaming", "mouse", "wireless", "ultralight", "lightweight", "light", "weight", "the", "and", "edition", "gen", "series", "magnesium", "alloy", "carbon", "fiber", "black", "white", "pink", "red", "blue", "green", "purple", "silver", "gray", "grey", "yellow", "orange", "limited", "special", "esports", "e", "sports", "for", "with", "of", "new", "keyboard", "hall", "effect", "mechanical", "8k", "4k", "1k", "hz", "wired", "usb", "rgb", "v1", "type", "c"}
DISC = {"pro", "max", "mini", "plus", "ultra", "lite", "se", "v2", "v3", "v4", "v5", "air", "x", "s", "elite", "hero", "ii", "2", "3", "4", "5", "6", "7", "8", "9", "he", "ace", "core", "medium", "small", "large", "xl", "xs", "m", "l", "r"}

def best(cat, query, brand="", disc=None, noise=None):
    """The product whose title contains all the query's words, no extra variant words, and the fewest other words."""
    bt = set(toks(brand))
    q = [t for t in toks(query) if t not in bt]
    if not q: return None
    cands = []
    for p in cat:
        s = p["tset"]
        if not all(t in s for t in q): continue
        extra = [t for t in p["tset"] if t not in q and t not in (noise if noise is not None else NOISE) and t not in bt]
        if any(t in (disc if disc is not None else DISC) for t in extra): continue
        cands.append((len(extra), len(p["title"]), p))
    if not cands: return None
    cands.sort(key=lambda x: (x[0], x[1]))
    return cands[0][2]

def view_ok(rep, kind):
    """A top-down, undamaged, single-subject picture (the same view as SYNQ's own renders)."""
    m = rep.get("shape")
    if not m or rep.get("otherBlobs", 0) > 0.25: return False
    if m["solidity"] < 0.84: return False
    if kind == "mouse": return 1.25 <= m["aspect"] <= 2.6 and m["sym"] >= 0.72
    return 1.5 <= 1 / m["aspect"] <= 4.5      # keyboards: wide and boxy

def analyze(raw, kind):
    try:
        im = proc.load_rgba(io.BytesIO(raw))
    except Exception:
        return None
    if max(im.size) < 400: return None
    cut, rep = proc.prepare(im)
    if cut is None: return None
    ok = view_ok(rep, kind)
    m = rep["shape"]
    return {"ok": ok, "score": m["sym"] + m["solidity"], "rep": rep}

def pick_image(prod, kind="mouse", max_try=5, width=1100):
    best = None
    for im in prod["images"][:max_try]:
        u = im["src"]
        u2 = u + ("&" if "?" in u else "?") + f"width={width}"
        try:
            raw = fetch(u2)
        except Exception:
            continue
        r = analyze(raw, kind)
        if r and r["ok"] and (best is None or (r["score"] > best[0] and r["score"] >= 1.6) or (best is None)):
            best = (r["score"], u2, r["rep"])
            if r["score"] >= 1.8: break          # the first clean top view wins (later pictures are often the underside)
    return (best[1], "view-checked") if best else (None, None)
