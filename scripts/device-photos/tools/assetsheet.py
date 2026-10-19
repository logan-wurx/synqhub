"""assetsheet.py <keys file or comma list> [tile] [per]: draw pictures straight from src/assets/devices on dark tiles (like
darktiles.py, for pictures already merged: a re-export, an alias check), to ../qa/assets-N.png."""
import json, pathlib, sys
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEST = ROOT.parents[1] / "src" / "assets" / "devices"
arg = sys.argv[1]
keys = [k.strip() for k in (open(arg).read().split() if pathlib.Path(arg).exists() else arg.split(",")) if k.strip()]
tile = int(sys.argv[2]) if len(sys.argv) > 2 else 260
per = int(sys.argv[3]) if len(sys.argv) > 3 else 30
models = {m["key"]: m for m in json.load(open(DEST / "index.json", encoding="utf8"))["models"]}
cols = 6
for s in range(0, len(keys), per):
    chunk = [k for k in keys[s:s + per] if k in models]
    rows = (len(chunk) + cols - 1) // cols
    im = Image.new("RGB", (cols * (tile + 8) + 8, rows * (tile + 26) + 8), (12, 12, 14))
    d = ImageDraw.Draw(im)
    for i, k in enumerate(chunk):
        m = models[k]
        x, y = 8 + (i % cols) * (tile + 8), 8 + (i // cols) * (tile + 26)
        d.rounded_rectangle([x, y, x + tile, y + tile], 12, fill=(28, 28, 32))
        p = Image.open(DEST / m["vendor"] / f"{k}.webp").convert("RGBA")
        p.thumbnail((tile - 16, tile - 16), Image.LANCZOS)
        im.paste(p, (x + (tile - p.width) // 2, y + (tile - p.height) // 2), p)
        d.text((x + 2, y + tile + 4), f"{k[:34]} {m['size'][0]}x{m['size'][1]}", fill=(220, 220, 120))
    out = ROOT / "qa" / f"assets-{s // per + 1}.png"
    im.save(out)
    print(out)
