"""darktiles.py <vendor> [keys] [tile]: the built pictures of ../out/<vendor>/ on dark tiles the way the redesigned Devices home
shows them (one product per tile, about 400 px tall), with the size and weight under each, written to ../qa/dark-<vendor>-N.png.
For the last look before assemble2.py: halos, a cut-off part, a box or a cable stub show up here and not on a white sheet.
`zoom` as the vendor draws one picture at full size on the dark ground: darktiles.py zoom <vendor> <key>."""
import json, pathlib, sys
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
BG, TILE_BG = (12, 12, 14), (28, 28, 32)


def sheet(vendor, keys=None, tile=420, per=12):
    d = ROOT / "out" / vendor
    rep = {r["key"]: r for r in json.load(open(d / "_report.json")) if r.get("ok")}
    ks = [k for k in rep if not keys or k in keys]
    cols = 4
    for s in range(0, len(ks), per):
        chunk = ks[s:s + per]
        rows = (len(chunk) + cols - 1) // cols
        im = Image.new("RGB", (cols * (tile + 12) + 12, rows * (tile + 40) + 12), BG)
        dr = ImageDraw.Draw(im)
        for i, k in enumerate(chunk):
            x, y = 12 + (i % cols) * (tile + 12), 12 + (i // cols) * (tile + 40)
            dr.rounded_rectangle([x, y, x + tile, y + tile], 18, fill=TILE_BG)
            p = Image.open(d / f"{k}.webp").convert("RGBA")
            p.thumbnail((tile - 40, tile - 40), Image.LANCZOS)
            im.paste(p, (x + (tile - p.width) // 2, y + (tile - p.height) // 2), p)
            r = rep[k]
            dr.text((x + 4, y + tile + 4), k[:56], fill=(230, 230, 120))
            dr.text((x + 4, y + tile + 20), f"{r['size'][0]}x{r['size'][1]}  {r['kb']} KB  q{r['q']}  {r.get('how', '')}", fill=(170, 170, 170))
        out = ROOT / "qa" / f"dark-{vendor}-{s // per + 1}.png"
        im.save(out)
        print(out)


def zoom(vendor, key):
    p = Image.open(ROOT / "out" / vendor / f"{key}.webp").convert("RGBA")
    im = Image.new("RGB", (p.width + 40, p.height + 40), TILE_BG)
    im.paste(p, (20, 20), p)
    out = ROOT / "qa" / f"zoom-{key}.png"
    im.save(out)
    print(out, p.size)


if __name__ == "__main__":
    if sys.argv[1] == "zoom":
        zoom(sys.argv[2], sys.argv[3])
    else:
        sheet(sys.argv[1], set(sys.argv[2].split(",")) if len(sys.argv) > 2 and sys.argv[2] else None, int(sys.argv[3]) if len(sys.argv) > 3 else 420)
