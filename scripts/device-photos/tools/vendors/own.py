"""The developer's own devices, which earlier passes left to SYNQ's hand-made renders: the PRO X SUPERLIGHT 2 and its DEX
(logitechg.com gallery renders), the ROG Falchion Ace HFX ZywOo Edition (rog.asus.com gallery), the ATK Blazing Sky X1 V2 Air+
(atk.store, ATK's own Shopify store) and the webcam that calls itself "PC-LM1E Camera" (AUKEY's PC-LM1E 1080p webcam, made by
KYE Systems / Genius, hence its 0458 vendor id; aukey.com's archived product page). Found by name only: their USB ids stay
off the pictures (scripts/device-images.test.ts keeps the hand-made renders unshadowed by id). The 7Hz Salnotes Zero:2 is in
phones.py. Steps: cands2.py own, picks/own.json, build2.py own, assemble2.py."""
from rows import R, make

DAM = "https://resource.logitechg.com/w_1600,c_limit,f_png/d_transparent.gif/content/dam/gaming/en/products/"
GAIN = (r"dlcdnwebimgs\.asus\.com/gain/([0-9A-F\-]{36})", "https://dlcdnwebimgs.asus.com/gain/{}/w2000")
SHOP_IMG = r"cdn\.shopify\.com/s/files/"

ROWS = [
    R("logitech-pro-x-superlight-2", "logitech", "PRO X SUPERLIGHT 2", "mouse",
      [("img", DAM + "pro-x-superlight-2/new-gallery-assets-2025/pro-x-superlight-2-mice-top-angle-" + c + "-gallery-1" + s + ".png") for c, s in (("black", ""), ("white", ""), ("pink", "-new"))]
      + [("img", DAM + "pro-x-superlight-2/new-gallery-assets-2025/pro-x-superlight-2-mice-profile-left-angle-black-gallery-4-2-award.png")],
      names=["pro x superlight 2", "g pro x superlight 2", "pro x 2 superlight", "pro x 2", "logitech g pro x superlight 2", "pro x superlight 2 lightspeed"],
      page="https://www.logitechg.com/en-us/shop/p/pro-x2-superlight-wireless-mouse", note="logitechg.com product page, gallery render"),
    R("logitech-pro-x-superlight-2-dex", "logitech", "PRO X SUPERLIGHT 2 DEX", "mouse",
      [("img", DAM + "pro-x-superlight-2-dex/gallery/new-gallery-assets-2025/pro-x-superlight-2-dex-mouse-" + v + ".png")
       for v in ("top-angle-black-gallery-1", "top-angle-white-gallery-1", "top-angle-pink-gallery-1", "3qtr-high-back-angle-black-gallery-3-new", "profile-left-angle-black-gallery-4-2-award")],
      names=["pro x superlight 2 dex", "pro x 2 dex", "superlight 2 dex", "logitech g pro x superlight 2 dex"],
      page="https://www.logitechg.com/en-us/shop/p/pro-x-superlight-2-dex", note="logitechg.com product page, gallery render"),
    R("rog-falchion-ace-hfx-zywoo-edition", "asus", "ROG FALCHION ACE HFX ZYWOO EDITION", "keyboard",
      [("ids", "https://rog.asus.com/us/keyboards/keyboards/aura-rgb/rog-falchion-ace-hfx-zywoo-edition/gallery/", GAIN),
       ("ids", "https://rog.asus.com/us/keyboards/keyboards/aura-rgb/rog-falchion-ace-hfx-zywoo-edition/", GAIN)],
      names=["rog falchion ace hfx zywoo edition", "falchion ace hfx zywoo edition", "falchion ace hfx zywoo"], note="rog.asus.com model page"),
    R("atk-x1-v2-air-plus", "atk", "ATK Blazing Sky X1 V2 Air+", "mouse",
      [("shop", "www.atk.store", "atk-blazing-sky-x1-v2-series-esports-wireless-mouse")],
      names=["x1 v2 air plus", "atk x1 v2 air plus", "blazing sky x1 v2 air plus", "vxe x1 v2 air plus"], note="atk.store (ATK's own store)",
      flood=True),   # a white mouse on white: the matting model takes its body for ground
    R("aukey-pc-lm1e", "aukey", "AUKEY PC-LM1E 1080p Webcam", "webcam",
      # The archived page links pc-lm1e-2 at 1024 px; Shopify still serves the page's pictures at full size (1500 px).
      [("img", f"https://cdn.shopify.com/s/files/1/0118/7659/7856/products/pc-lm1e-{n}.jpg") for n in range(2, 7)]
      + [("wbgrab", "aukey.com/products/1080p-webcam-pc-lm1", r"cdn\.shopify\.com/s/files/.*/products/pc-lm1")],
      page="https://web.archive.org/web/2021/https://www.aukey.com/products/1080p-webcam-pc-lm1",
      ids=["0458:6006"], names=["pc lm1e", "pc lm1e camera", "aukey pc lm1e", "pc lm1", "aukey pc lm1"], note="aukey.com product page as the Wayback Machine kept it"),
]

candidates, jobs = make("own", ROWS)
