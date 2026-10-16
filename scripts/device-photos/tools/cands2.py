"""cands2.py <vendor> [only,keys] [N]: like cands.py, but every candidate goes through proc2 (rembg for opaque pictures), prepared in parallel.
Draws review sheets ../qa/c2-<vendor>-N.png (index on each thumbnail) and writes ../cand/<vendor>.json. Picks go in ../picks/<vendor>.json
as {key: index | null}."""
import inspect, sys, io, json, importlib, pathlib, concurrent.futures as cf
from PIL import Image, ImageDraw
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import ROOT, fetch

vendor = sys.argv[1]
only = set(sys.argv[2].split(",")) if len(sys.argv) > 2 and sys.argv[2] else None
N = int(sys.argv[3]) if len(sys.argv) > 3 else 6
PER = 8
T = 120
mod = importlib.import_module(f"vendors.{vendor}")


def work(task):
    key, i, url = task
    import proc2
    try:
        raw = fetch(url)
    except Exception as e:
        return key, i, None, {"ok": False, "why": f"fetch: {str(e)[:50]}"}
    im, rep = proc2.prepare(raw)
    if im is None:
        return key, i, None, rep
    t = im.copy()
    t.thumbnail((T - 8, T - 8))
    buf = io.BytesIO()
    t.save(buf, "PNG")
    return key, i, buf.getvalue(), rep


if __name__ == "__main__":
    # A source that can skip the models not asked for does (fewer requests: Shopify stores answer 429 to a burst).
    takes_only = "only" in inspect.signature(mod.candidates).parameters
    cands = [c for c in (mod.candidates(only=only) if takes_only else mod.candidates()) if not only or c["key"] in only]
    tasks = [(c["key"], i, u) for c in cands for i, u in enumerate(c["urls"][:N])]
    print(len(cands), "models,", len(tasks), "pictures", flush=True)
    res = {}
    with cf.ProcessPoolExecutor(max_workers=5) as ex:
        for key, i, png, rep in ex.map(work, tasks, chunksize=1):
            res[(key, i)] = (png, rep)
    picks_f = ROOT / "picks" / f"{vendor}.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    index = {}
    for c in cands:
        index[c["key"]] = {"n": len(c["urls"][:N]), "tiles": [{"i": i, "ok": bool(res.get((c["key"], i), (None, {}))[1].get("ok")), "why": res.get((c["key"], i), (None, {}))[1].get("why")} for i in range(len(c["urls"][:N]))]}
    json.dump(index, open(ROOT / "cand" / f"{vendor}.json", "w"), indent=1)
    LW = 190
    for s in range(0, len(cands), PER):
        chunk = cands[s:s + PER]
        sheet = Image.new("RGB", (LW + N * T, len(chunk) * (T + 4)), (24, 22, 26))
        d = ImageDraw.Draw(sheet)
        for r, c in enumerate(chunk):
            y = r * (T + 4)
            d.text((4, y + 4), c["key"][:34], fill=(255, 255, 0))
            d.text((4, y + 18), c["name"][:34], fill=(200, 200, 200))
            d.text((4, y + 32), f"pick={picks.get(c['key'], '-')}", fill=(120, 255, 120))
            for i in range(len(c["urls"][:N])):
                png, rep = res[(c["key"], i)]
                x = LW + i * T
                if png is None:
                    d.rectangle([x + 2, y + 2, x + T - 2, y + T - 2], outline=(120, 0, 0))
                    d.text((x + 8, y + 8), f"{i} x", fill=(255, 80, 80))
                    continue
                t = Image.open(io.BytesIO(png)).convert("RGBA")
                sheet.paste(t, (x + 4 + (T - 8 - t.width) // 2, y + 4 + (T - 8 - t.height) // 2), t)
                d.rectangle([x + 1, y + 1, x + T - 2, y + T - 2], outline=(0, 160, 0) if rep.get("otherBlobs", 0) < 0.2 else (160, 120, 0))
                d.text((x + 6, y + 6), str(i), fill=(255, 255, 0))
        out = ROOT / "qa" / f"c2-{vendor}-{s // PER + 1}.png"
        sheet.save(out)
        print(out, sheet.size, flush=True)
