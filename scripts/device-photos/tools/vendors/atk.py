"""ATK Hub (hub.atk.gg, the official ATK / VXE configurator): device renders, transparent WebP."""
import json
from common import ROOT, job
RAW = ROOT / "raw" / "atk"
D = {(o["kind"], o["model"], o["file"]): o["url"] for o in json.load(open(ROOT / "tools" / "atk-hub-images.json")) if o["url"]}
def a(*pids): return [f"373b:{p:04x}" for p in pids]
ROWS = [
    # key, name, kind, ids, extra names, hub file
    ("atk-f1-ultimate", "ATK F1 Ultimate", "mouse", [], ["f1 ultimate", "f1 ultimate 2 0", "atk f1 ultimate"], "mouse-f1-black-ultimate.webp"),
    ("atk-f1", "ATK F1", "mouse", [], ["atk f1", "f1"], "mouse-f1-black.webp"),
    ("atk-f1-moba", "ATK F1 MOBA", "mouse", [], ["f1 moba"], "mouse-f1-moba-black.webp"),
    ("atk-f1-pro-max", "ATK F1 Pro Max", "mouse", [], ["f1 pro max", "f1 v2 ultra max", "f1 ultra max"], "mouse-f1-pro-max-black.webp"),
    ("atk-x1-v2", "ATK Blazing Sky X1 V2", "mouse", [], ["x1 v2", "x1 v2 ultimate", "blazing sky x1 v2", "atk x1 v2", "x1 v2 air"], "mouse-x1-sky-x1-v2-black.webp"),
    ("atk-x1", "ATK X1", "mouse", [], ["atk x1", "x1"], "mouse-x1-black.webp"),
    ("atk-z1-v2", "ATK Blazing Sky Z1 V2", "mouse", [], ["z1 v2", "blazing sky z1 v2"], "mouse-z1-sky-z1-v2-black.webp"),
    ("atk-z1", "ATK Z1", "mouse", [], ["z1"], "mouse-z1-black.webp"),
    ("atk-a9", "ATK A9", "mouse", [], ["a9", "a9 air", "a9 plus", "a9 mini", "a9 mini plus", "a9 mini +"], "mouse-a9-black.webp"),
    ("atk-fierce-x", "ATK Fierce X", "mouse", [], ["fierce x"], "mouse-fierce-x-black.webp"),
    ("atk-duckbill", "ATK Duckbill", "mouse", [], ["duckbill", "duck bill"], "mouse-duck-bill-purple.webp"),
    ("atk-u2", "ATK U2", "mouse", [], ["u2"], "mouse-u2-black.webp"),
    ("atk-v1", "ATK V1", "mouse", [], ["atk v1"], "mouse-v1-black.webp"),
    ("vxe-mad-r-major", "VXE MAD R Major", "mouse", [], ["mad r major", "vxe mad r major"], "mouse-mad-r-black-major.webp"),
    ("vxe-mad-r", "VXE MAD R", "mouse", [], ["mad r", "vxe mad r"], "mouse-mad-r-black.webp"),
    ("vxe-r1", "VXE R1", "mouse", [], ["vxe r1", "r1 se", "r1 se plus", "r1 pro", "r1 pro max", "dragonfly r1", "dragonfly r1 pro", "vxe dragonfly r1 pro", "r1"], "mouse-r1-black.webp"),
]
def jobs():
    out = []
    for key, name, kind, ids, names, f in ROWS:
        fp = RAW / f
        if not fp.exists(): print("missing", f); continue
        k = f[len("mouse-"):] if f.startswith("mouse-") else f
        url = next((u for (kd, md, fl), u in D.items() if f"{kd}-{md}-{fl}" == f), None)
        out.append(job(key, "atk", name, kind, ids, file=str(fp), url=url, page="https://hub.atk.gg", names=[name] + names, note="ATK Hub (official configurator) device render"))
    return out
