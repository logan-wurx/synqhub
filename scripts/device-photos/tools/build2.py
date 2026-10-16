"""build2.py <vendor> [...]: run vendors/<vendor>.py jobs() -> fetch, matte (rembg when opaque), trim, encode to ../out/<vendor>/<key>.webp + _report.json."""
import sys, json, importlib, pathlib, datetime
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import ROOT, fetch
import proc2

today = datetime.date.today().isoformat()
BRIDGE = {}
for v in sys.argv[1:]:
    mod = importlib.import_module(f"vendors.{v}")
    jobs = mod.jobs()
    out = ROOT / "out" / v
    out.mkdir(parents=True, exist_ok=True)
    report = []
    for j in jobs:
        rep = {k: j.get(k) for k in ("key", "vendor", "name", "kind", "ids", "names", "url", "file", "page", "note")}
        try:
            raw = pathlib.Path(j["file"]).read_bytes() if j.get("file") else fetch(j["url"])
            if j.get("crop"):
                # Part of the maker's picture (fractions x0, y0, x1, y1): one Joy-Con out of a pair shot.
                import io
                from PIL import Image
                src = Image.open(io.BytesIO(raw))
                w, h = src.size
                x0, y0, x1, y1 = j["crop"]
                buf = io.BytesIO()
                part = src.crop((round(x0 * w), round(y0 * h), round(x1 * w), round(y1 * h)))
                if j.get("feather"):
                    # A soft picture (a lamp's glow) fades out over the outer `feather` of each side instead of ending at the crop.
                    import numpy as np
                    part = part.convert("RGBA")
                    a = np.asarray(part).copy()
                    hh, ww = a.shape[:2]
                    ramp = lambda n: np.clip(np.minimum(np.arange(n), np.arange(n)[::-1]) / (n * j["feather"]), 0, 1)
                    fade = np.outer(ramp(hh), ramp(ww))
                    a[..., 3] = (a[..., 3] * fade * fade * (3 - 2 * fade)).astype(np.uint8)
                    part = Image.fromarray(a)
                part.save(buf, "PNG")
                raw = buf.getvalue()
            # A job may widen the gap bridging (an odd filter size) so a product in two pieces, a Joy-Con pair, stays whole.
            rep.update(proc2.proc_file(raw, out / f"{j['key']}.webp", BRIDGE.get(j["key"], j.get("bridge", 5)), j.get("force", False), j.get("soft", False)))
        except Exception as e:
            rep.update(ok=False, why=f"error: {str(e)[:120]}")
        rep["fetched"] = today
        report.append(rep)
    json.dump(report, open(out / "_report.json", "w"), indent=1)
    ok = [r for r in report if r.get("ok")]
    print(f"{v}: {len(ok)}/{len(report)} ok, {sum(r['kb'] for r in ok):.0f} KB")
    for r in report:
        if not r.get("ok"):
            print("   skip", r["key"], "-", r.get("why"))
