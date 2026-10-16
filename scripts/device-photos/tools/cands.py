"""cands.py <vendor> [rows-per-sheet]: download the first images of every matched product, cut them, and draw review sheets
(../qa/cand-<vendor>-N.png) with an index on every thumbnail. Picks go in ../picks/<vendor>.json as {key: index | null}."""
import sys, io, json, importlib, pathlib
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import ROOT, fetch
import proc, shop
vendor = sys.argv[1]; per = int(sys.argv[2]) if len(sys.argv) > 2 else 8
only = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else None
mod = importlib.import_module(f"vendors.{vendor}")
cands = mod.candidates()
picks_f = ROOT / "picks" / f"{vendor}.json"
picks = json.load(open(picks_f)) if picks_f.exists() else {}
T = 120; N = 6
font = ImageFont.load_default()
rows = []
index = {}
for c in cands:
    if only and c["key"] not in only: continue
    tiles = []
    auto = None
    for i, u in enumerate(c["urls"][:N]):
        try:
            raw = fetch(u)
            im = proc.load_rgba(io.BytesIO(raw))
            cut, rep = proc.prepare(im)
        except Exception as e:
            cut, rep = None, {"why": str(e)[:50]}
        if cut is not None:
            ok = shop.view_ok(rep, c["kind"])
            tiles.append((i, cut, ok, rep))
            if ok and auto is None and rep["shape"]["sym"] + rep["shape"]["solidity"] >= 1.6: auto = i
        else:
            tiles.append((i, None, False, rep))
    index[c["key"]] = {"auto": auto, "n": len(tiles), "tiles": [{"i": t[0], "ok": t[2], "shape": t[3].get("shape"), "why": t[3].get("why")} for t in tiles]}
    rows.append((c, tiles, auto))
json.dump(index, open(ROOT / "cand" / f"{vendor}.json", "w"), indent=1)
LW = 190
for s in range(0, len(rows), per):
    chunk = rows[s:s + per]
    sheet = Image.new("RGB", (LW + N * T, len(chunk) * (T + 4)), (24, 22, 26))
    d = ImageDraw.Draw(sheet)
    for r, (c, tiles, auto) in enumerate(chunk):
        y = r * (T + 4)
        picked = picks.get(c["key"], "auto")
        d.text((4, y + 4), c["key"][:34], fill=(255, 255, 0))
        d.text((4, y + 18), c["name"][:34], fill=(200, 200, 200))
        d.text((4, y + 32), f"auto={auto} pick={picked}", fill=(120, 255, 120))
        for i, cut, ok, rep in tiles:
            x = LW + i * T
            if cut is None:
                d.rectangle([x + 2, y + 2, x + T - 2, y + T - 2], outline=(120, 0, 0)); d.text((x + 8, y + 8), f"{i} x", fill=(255, 80, 80)); continue
            t = cut.copy(); t.thumbnail((T - 8, T - 8))
            sheet.paste(t, (x + 4 + (T - 8 - t.width) // 2, y + 4 + (T - 8 - t.height) // 2), t)
            col = (0, 200, 0) if ok else (90, 90, 90)
            d.rectangle([x + 1, y + 1, x + T - 2, y + T - 2], outline=col)
            d.text((x + 6, y + 6), str(i), fill=(255, 255, 0))
    out = ROOT / "qa" / f"cand-{vendor}-{s // per + 1}.png"
    sheet.save(out); print(out, sheet.size)
