"""build.py <vendor> [...]: run vendors/<vendor>.py -> jobs, fetch + process each to ../out/<vendor>/<key>.webp, write ../out/<vendor>/_report.json
   and a QA contact sheet ../qa/<vendor>-N.png."""
import sys, json, importlib, pathlib, traceback, datetime, subprocess
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import ROOT, fetch
import proc
today = datetime.date.today().isoformat()
BRIDGE = {"rog-azoth-extreme": 3}   # the award badges under the wrist rest are separate pieces
for v in sys.argv[1:]:
    mod = importlib.import_module(f"vendors.{v}")
    jobs = mod.jobs()
    out = ROOT / "out" / v; out.mkdir(parents=True, exist_ok=True)
    rawd = ROOT / "raw" / v; rawd.mkdir(parents=True, exist_ok=True)
    report = []
    for j in jobs:
        rep = {k: j[k] for k in ("key", "vendor", "name", "kind", "ids", "names", "url", "file", "page", "note")}
        try:
            if j.get("file"):
                src = pathlib.Path(j["file"])
            else:
                ext = (j["url"].split("?")[0].rsplit(".", 1)[-1] or "bin")[:4].lower()
                ext = ext if ext in ("png", "webp", "jpg", "jpeg", "gif") else "png"
                src = rawd / f"{j['key']}.{ext}"
                if not src.exists(): src.write_bytes(fetch(j["url"]))
            r = proc.proc(src, out / f"{j['key']}.webp", j.get("bg", "auto"), True, BRIDGE.get(j["key"], 5))
            rep.update(r)
        except Exception as e:
            rep.update(ok=False, why=f"error: {str(e)[:120]}")
        report.append(rep)
    for r in report:
        r["fetched"] = today
    json.dump(report, open(out / "_report.json", "w"), indent=1)
    ok = [r for r in report if r.get("ok")]
    print(f"{v}: {len(ok)}/{len(report)} ok,", f"{sum(r['kb'] for r in ok):.0f} KB")
    for r in report:
        if not r.get("ok"): print("   skip", r["key"], "-", r.get("why"))
