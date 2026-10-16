"""Corsair: official corsair.com product pages (ww/en sitemap) -> first JSON-LD product image (1024 px transparent WebP)."""
import re, json, requests
from common import ROOT, UA, job, fetch
URLS = [u for u in open(ROOT / "src" / "corsair-products.txt").read().split("\n") if "/ww/en/p/" in u]
def c(*pids): return [f"1b1c:{p:04x}" for p in pids]
ROWS = [
    # key, name, kind, ids, extra names, url regex (first match wins)
    ("corsair-galleon-100-sd", "GALLEON 100 SD", "keyboard", c(0x2b0c), ["galleon 100 sd", "galleon 100"], r"galleon-100-sd-stream-deck-integrated-mechanical-keyboard-ch-912a31i"),
    ("corsair-vanguard-pro-96", "VANGUARD PRO 96", "keyboard", c(0x2b0e), ["vanguard pro 96"], r"vanguard-pro-96-hall-effect-gaming-keyboard-ch-91e911g"),
    ("corsair-vanguard-96", "VANGUARD 96 WIRELESS", "keyboard", c(0x2b0d, 0x2b0f), ["vanguard 96", "vanguard 96 wireless"], r"vanguard-96-wireless-mechanical"),
    ("corsair-vanguard-air-99", "VANGUARD AIR 99 WIRELESS", "keyboard", c(0x2b21), ["vanguard air 99"], r"vanguard-air-99-wireless-optical-mechanical-gaming-keyboard-black"),
    ("corsair-clipper-pro-mini-60", "CLIPPER PRO MINI 60", "keyboard", c(0x2b30, 0x2b31), ["clipper pro mini 60", "vanguard pro 60 wireless"], r"clipper-pro-mini-60-hall-effect-gaming-keyboard-ch-979101j"),
    ("corsair-skiff-100", "SKIFF 100", "keyboard", c(0x2b3d), ["skiff 100"], r"skiff-100-gaming-keyboard-ch-9226h65"),
    ("corsair-skiff-100-plus", "SKIFF 100 PLUS", "keyboard", c(0x2b3e), ["skiff 100 plus"], r"skiff-100-plus-gaming-keyboard"),
    ("corsair-k70-core-rgb", "K70 Core RGB", "keyboard", c(0x1bfd), ["k70 core rgb", "k70 core"], r"k70-core-rgb-mechanical-gaming-keyboard-black"),
    ("corsair-k70-core-tkl", "K70 Core TKL RGB", "keyboard", c(0x2b01), ["k70 core tkl", "k70 core rgb tkl"], r"k70-core-tkl-rgb-mechanical-gaming-keyboard-ch-911911e"),
    ("corsair-k70-pro-tkl", "K70 PRO TKL", "keyboard", [], ["k70 pro tkl", "k70 max"], r"k70-pro-tkl-hall-effect-programmable-keyboard-ch-911911g"),
    ("corsair-k70-rgb-pro", "K70 RGB PRO", "keyboard", c(0x1bc4, 0x1bb3), ["k70 rgb pro"], r"k70-rgb-pro-mechanical-gaming-keyboard-with-pbt-double-shot-pro-keycaps-cherry-mx-red"),
    ("corsair-k100-rgb", "K100 RGB", "keyboard", c(0x1b7c, 0x1bc5, 0x1b7d), ["k100 rgb", "k100 rgb optical", "k100 mx red"], r"k100-rgb-optical-mechanical-gaming-keyboard-corsair-opx-switch-black"),
    ("corsair-k55-rgb-pro", "K55 RGB PRO", "keyboard", c(0x1ba4), ["k55 rgb pro"], r"k55-rgb-pro-gaming-keyboard"),
    ("corsair-k65-plus-wireless", "K65 PLUS WIRELESS", "keyboard", [], ["k65 plus wireless", "k65 plus"], r"k65-plus-wireless-75-percent-rgb-mechanical-gaming-keyboard-ch-91d401l"),
    ("corsair-nightsword-v2", "NIGHTSWORD V2 WIRELESS SD", "mouse", c(0x2b1c), ["nightsword v2", "nightsword v2 wireless sd"], r"nightsword-v2-wireless-stream-deck-gaming-mouse"),
    ("corsair-nightsword-rgb", "NIGHTSWORD RGB", "mouse", c(0x1b5c), ["nightsword rgb", "nightsword"], r"nightsword-rgb-tunable-fps-moba-gaming-mouse"),
    ("corsair-scimitar-elite-wireless-se", "SCIMITAR ELITE WIRELESS SE", "mouse", c(0x2b22), ["scimitar elite wireless se", "scimitar elite wireless"], r"scimitar-elite-wireless-se-mmo-gaming-mouse-white"),
    ("corsair-scimitar-rgb-elite", "SCIMITAR RGB ELITE", "mouse", [], ["scimitar rgb elite", "scimitar elite rgb v2", "scimitar elite rgb"], r"scimitar-rgb-elite-optical-moba-mmo-gaming-mouse"),
    ("corsair-sabre-v2-pro-cf", "SABRE v2 PRO Carbon Fiber", "mouse", c(0x2b25, 0x2b35), ["sabre v2 pro cf", "sabre v2 pro carbon fiber"], r"sabre-v2-pro-carbon-fiber-wireless-gaming-mouse-black"),
    ("corsair-sabre-v2-pro-mg", "SABRE v2 PRO Magnesium Alloy", "mouse", c(0x2b29, 0x2b34), ["sabre v2 pro mg", "sabre v2 pro magnesium"], r"sabre-v2-pro-wireless-magnesium-alloy-gaming-mouse-black"),
    ("corsair-sabre-v2-pro", "SABRE v2 PRO Ultralight", "mouse", c(0x2b28, 0x2b2a), ["sabre v2 pro", "sabre v2 pro ultralight"], r"sabre-v2-pro-ultralight-wireless-gaming-mouse-ch-931g000"),
    ("corsair-harpoon-v2", "HARPOON v2 WIRELESS", "mouse", c(0x2b2e, 0x2b33), ["harpoon v2", "harpoon v2 wireless"], r"harpoon-v2-wireless-gaming-mouse"),
    ("corsair-harpoon-rgb-pro", "HARPOON RGB PRO", "mouse", [], ["harpoon rgb pro", "harpoon rgb"], r"harpoon-rgb-pro-fps-moba-gaming-mouse"),
    ("corsair-katar-pro", "KATAR PRO", "mouse", c(0x1bba), ["katar pro", "katar pro v2", "katar elite"], r"katar-pro-wireless-gaming-mouse"),
    ("corsair-m75", "M75", "mouse", c(0x1bf0), ["m75", "m75 gaming mouse"], r"m75-lightweight-rgb-gaming-mouse-ch-930d010"),
    ("corsair-m75-wireless", "M75 WIRELESS", "mouse", c(0x1bf1), ["m75 wireless"], r"m75-wireless-lightweight-rgb-gaming-mouse-black"),
    ("corsair-m75-air", "M75 AIR WIRELESS", "mouse", [], ["m75 air", "m75 air wireless"], r"corsair-m75-air-wireless-ultra-lightweight-gaming-mouse-black"),
    ("corsair-m65-rgb-ultra", "M65 RGB ULTRA", "mouse", c(0x1b9e), ["m65 rgb ultra", "m65 pro rgb", "m65 rgb elite", "m65 elite"], r"m65-rgb-ultra-tunable-fps-gaming-mouse-ch-9309411"),
    ("corsair-m55", "M55", "mouse", c(0x1b70), ["m55", "m55 rgb pro"], r"m55-lightweight-gaming-mouse-ch-930f000"),
    ("corsair-ironclaw-rgb", "IRONCLAW RGB", "mouse", [], ["ironclaw rgb", "ironclaw"], r"ironclaw-rgb-fps-moba-gaming-mouse"),
    ("corsair-ironclaw-rgb-wireless", "IRONCLAW RGB WIRELESS", "mouse", c(0x1b4c, 0x1b66, 0x1bdc), ["ironclaw rgb wireless", "ironclaw wireless"], r"ironclaw-rgb-wireless-gaming-mouse"),
    ("corsair-darkstar", "DARKSTAR WIRELESS", "mouse", [], ["darkstar"], r"darkstar-wireless-rgb-mmo-gaming-mouse"),
]
def jobs():
    out = []
    for key, name, kind, ids, names, rx in ROWS:
        page = next((u for u in URLS if re.search(rx, u)), None)
        if not page:
            print("no page", key); continue
        try:
            h = fetch(page, text=True)
            img = None
            for s in re.findall(r'<script type="application/ld\+json">(.*?)</script>', h, re.S):
                j = json.loads(s)
                if isinstance(j, dict) and j.get("@type") == "Product" and j.get("image"):
                    img = j["image"][0]; break
            if not img: print("no image", key); continue
            out.append(job(key, "corsair", name, kind, ids, url=img, page=page, names=[name] + names, note="corsair.com product page JSON-LD image"))
        except Exception as e:
            print("ERR", key, str(e)[:100])
    return out
