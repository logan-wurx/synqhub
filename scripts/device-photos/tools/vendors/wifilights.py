"""The Wi-Fi lights of wave L3 (docs/devices/LIGHTING.md §3b): official product pictures from the makers' own sites, one or
two per brand, for the models people have most. Kind `light`, found by the model a light reports when SYNQ finds it
(Hue's product name, Nanoleaf's model number, Elgato's product name; a WiZ, LIFX or Twinkly light only says its brand,
so its picture is the brand's best-known light). Same steps as lights.py: cands2.py wifilights, picks in
picks/wifilights.json, build2.py wifilights, assemble2.py.

Each row: (key, vendor folder, display name, extra names, sources), sources as in pads.py; ("img", url) for Signify's
renders (Philips Hue, WiZ), asked for as transparent PNGs."""
import json, sys
from common import ROOT, job
from vendors.pads import page_of, urls_of

SIGNIFY = "https://www.assets.signify.com/is/image/Signify/{}?wid=1200&hei=1200&fmt=png-alpha"
ELGATO = "https://www.elgato.com/us/en/p/"
ELGATO_PICS = r"res\.cloudinary\.com/elgato-pwa/image/upload/[^\"' ]*Products/[^\"' ]*(?:above-the-fold|ATF|atf)[^\"' ]*\.(?:png|jpe?g|webp)"
SHOP_PICS = r"cdn\.shopify\.com/s/files/[^\"' ]+\.(?:png|jpe?g|webp)"
TWINKLY = "https://twinkly.com/cdn/shop/files/{}?width=1600"

ROWS = [
    # Philips Hue: a light behind the bridge reports its product name ("Hue color lamp", "Hue gradient lightstrip").
    ("philips-hue-color-a19", "philips-hue", "Philips Hue White and Color Ambiance A19", ["hue color lamp", "hue color a19", "hue white and color ambiance"],
     [("img", SIGNIFY.format("046677590826-929003853701-Hue-WCA-810-A19-E26-1P-NAM-RTP")), ("img", SIGNIFY.format("046677591168-929003853802-Hue-WCA-1100-A19-E26-1P-NAM-RTP"))]),
    ("philips-hue-gradient-lightstrip", "philips-hue", "Philips Hue Gradient Lightstrip", ["hue gradient lightstrip", "hue lightstrip gradient"],
     [("img", SIGNIFY.format("046677570552-929002994902-Hue_WCA-gradient-lightstrip-ambiance-base-NAM-RTP-TRN"))]),
    ("philips-hue-play-gradient-light-tube", "philips-hue", "Philips Hue Play Gradient Light Tube", ["hue play gradient light tube", "hue play gradient tube"],
     [("img", SIGNIFY.format("046677803537-915005988401-Hue_Play-gradient-light-tube-compact-black-NAM-RTP-TRN"))]),
    ("philips-hue-flux-strip", "philips-hue", "Philips Hue Flux Strip Light", ["hue flux strip light", "hue flux"],
     [("img", SIGNIFY.format("046677607753-929004610401-Hue-Flux-strip-light-3m-NAM-RTP"))]),
    # The Hue Bridge itself (it reports its model, BSB002), drawn on its card and its page until paired.
    ("philips-hue-bridge", "philips-hue", "Philips Hue Bridge", ["philips hue bsb002", "hue bridge"],
     [("img", SIGNIFY.format(n)) for n in ("046677458478-929001180603-Carousel-Product", "046677458478-929001180603-Hue-Bridge-v2-NAM-RTP-Award", "046677458478-929001180643-PIM-C1L1")]),
    # Nanoleaf: discovery reports the model number (NL42 Shapes, NL59 Lines).
    ("nanoleaf-shapes-hexagons", "nanoleaf", "Nanoleaf Shapes Hexagons", ["nanoleaf nl42", "nanoleaf shapes"],
     [("grab", "https://nanoleaf.me/en-US/products/nanoleaf-shapes/hexagons/", SHOP_PICS)]),
    ("nanoleaf-lines", "nanoleaf", "Nanoleaf Lines", ["nanoleaf nl59", "nanoleaf lines"],
     [("grab", "https://nanoleaf.me/en-US/products/nanoleaf-lines/", SHOP_PICS)]),
    # Elgato: the product name from the light itself.
    ("elgato-key-light", "elgato", "Elgato Key Light", ["elgato key light"], [("grab", ELGATO + "key-light", ELGATO_PICS)]),
    ("elgato-light-strip", "elgato", "Elgato Light Strip", ["elgato light strip"], [("grab", ELGATO + "light-strip", ELGATO_PICS)]),
    # One picture per brand where the light only says its brand. LIFX has only packaging shots (it stays drawn).
    # Twinkly's store keeps its gallery on its own CDN (twinkly.com/cdn/shop), named per product code.
    ("twinkly-strings", "twinkly", "Twinkly Strings", ["twinkly strings", "twinkly"],
     [("img", TWINKLY.format(n)) for n in ("TWS250STP-GUS_Out-of-the-box.jpg", "strings.jpg", "Strings_Gallery-images_AYR_03.png", "TWS100STP-GUS_Out-of-the-box.jpg")]),
    ("wiz-color-bulb", "wiz", "WiZ Color Bulb", ["wiz light", "wiz color", "wiz"],
     [("img", SIGNIFY.format(f"046677603458-WiZ-Bulb-Color-BR30-WiFi-Ble-PDP-PUP_0{i}")) for i in range(1, 6)] + [("img", SIGNIFY.format("WiFi_BLE_7_2BR30_Color_922_65_6_1PF-SPP"))]),
]


def candidates(only=None):
    out = []
    for key, vendor, name, names, sources in ROWS:
        if only and key not in only:
            continue
        urls = urls_of(sources)
        # Signify's renders: ask for the transparent PNG of any of the page's pictures.
        urls = [u if "assets.signify.com" not in u or "fmt=" in u else u.split("?")[0] + "?wid=1200&hei=1200&fmt=png-alpha" for u in urls]
        if not urls:
            print("  no pictures:", key, file=sys.stderr)
        out.append(dict(key=key, vendor=vendor, name=name, kind="light", ids=[], page=page_of(sources) or "https://www.philips-hue.com/en-us", names=[name] + names,
                        note="maker's own site", urls=urls[:12]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "wifilights.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates(only=set(picks)):
        sel = picks.get(c["key"])
        if sel is None or sel >= len(c["urls"]):
            continue
        j = job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})")
        if c["key"] in SOFT:
            j["soft"] = True
        out.append(j)
    return out


# Lights in more than one piece (a strip's coil and its box, panels): kept whole, not cut to the largest piece.
SOFT = {"philips-hue-gradient-lightstrip", "philips-hue-flux-strip", "nanoleaf-shapes-hexagons", "nanoleaf-lines", "twinkly-strings", "elgato-light-strip"}
