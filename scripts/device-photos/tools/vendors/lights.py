"""Lamps and light strips (docs/devices/LIGHTING.md): official product pictures from the makers' own stores. Same steps as the
controllers (pads.py): candidates reviewed by eye (cands2.py lights), cut with proc2 (rembg when a picture is not transparent),
picks in picks/lights.json, then build2.py lights and assemble2.py. The kind is `light`. Lamps are found by model name (the SKU in
their Bluetooth name, `Govee_H6076_7A21`), never by USB id.

Each row: (key, vendor folder, display name, extra names, sources), sources as in pads.py."""
import json, sys
from common import ROOT, job
from vendors.pads import page_of, urls_of

GOVEE = "https://us.govee.com/products/"
GOVEE_FILES = r"cdn\.shopify\.com/s/files/1/0512/3489/8105/files/"

def govee(sku, name, handle, extra=()):
    """A Govee model sold on us.govee.com: its pictures are named after the SKU's digits."""
    return (f"govee-{sku.lower()}", "govee", f"Govee {name} {sku}", [f"govee {sku.lower()}", sku.lower(), *extra],
            [("grab", GOVEE + handle, GOVEE_FILES + rf"H?{sku[1:]}[^/]*\.(png|jpe?g|webp)")])


ROWS = [
    # The H6076 is sold as the "RGBICW Smart Corner Floor Lamp Basic"; its pictures are named after the SKU.
    ("govee-h6076", "govee", "Govee Floor Lamp H6076", ["govee h6076", "h6076", "govee rgbicw smart corner floor lamp basic"],
     [("grab", GOVEE + "govee-rgbicw-smart-corner-floor-lamp", GOVEE_FILES + r"H?6076[^/]*\.(png|jpe?g|webp)")]),
    # Wave L2: the other models Govee's stores still sell whose pictures are named after the SKU. The rest (and every
    # model no longer sold) come from Govee's own product galleries, today's or archived: vendors/goveewb.py.
    govee("H605C", "Envisual TV Backlight T2", "govee-envisual-tv-backlight-t2"),
    govee("H6088", "Cube Wall Sconces", "govee-rgbic-cube-wall-sconces"),
    govee("H6173", "Outdoor Strip Lights", "govee-wi-fi-rgbic-outdoor-strip-lights"),
    govee("H617F", "RGBIC Basic LED Strip", "govee-rgbic-basic-bluetooth-led-strip-lights-with-smart-control"),
    govee("H61A8", "Outdoor Neon Rope Light", "govee-rgbic-outdoor-neon-rope-light"),
    govee("H61C3", "Neon Rope Lights for Desks", "govee-rgbic-led-neon-rope-lights-for-desks"),
    govee("H61F5", "Strip Light 2 Pro", "govee-strip-light-2-pro"),
]


def candidates():
    out = []
    for key, vendor, name, names, sources in ROWS:
        urls = urls_of(sources)
        if not urls:
            print("  no pictures:", key, file=sys.stderr)
        out.append(dict(key=key, vendor=vendor, name=name, kind="light", ids=[], page=page_of(sources), names=[name] + names,
                        note="maker's own site", urls=urls[:12]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "lights.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None or sel >= len(c["urls"]):
            continue
        j = job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})")
        if c["key"] in CROP:
            j["crop"] = CROP[c["key"]]
        if c["key"] in GLOW:
            j.update(soft=True, feather=GLOW[c["key"]])
        elif c["key"] in SOFT:
            j["soft"] = True
        out.append(j)
    return out


# The lamp out of a picture that also shows its box and the app (fractions x0, y0, x1, y1 of the maker's picture; build2.py),
# centred on the pole so its glow is even on both sides.
CROP = {
    "govee-h6076": (0.137, 0.03, 0.415, 0.95),
    # Govee's box-and-app shots: the lights in front of the box, without the box and the phone.
    "govee-h6173": (0.05, 0.68, 0.98, 0.95),
    "govee-h617f": (0.1, 0.64, 0.92, 0.93),
    "govee-h61a8": (0.18, 0.73, 0.88, 0.97),
    "govee-h61c3": (0.2, 0.72, 0.85, 0.97),
    "govee-h61f5": (0.08, 0.64, 0.95, 0.98),
}
# Pictures whose glow is part of the product shot: the maker's alpha is kept whole and fades out over this fraction of each side.
# A strip or rope cut out of a kit shot fades out the same way where the crop cuts it.
GLOW = {"govee-h6076": 0.22, "govee-h61a8": 0.12, "govee-h61c3": 0.12, "govee-h61f5": 0.1}
# Govee's box-and-app product shots: kept whole on the maker's own transparency (the lights, the box and the phone are
# one picture; a largest-piece cut would keep only the box).
SOFT = {"govee-h605c", "govee-h6088", "govee-h6173", "govee-h617f", "govee-h61a8", "govee-h61c3", "govee-h66a0", "govee-h61f5"}
