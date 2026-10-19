"""reexport_check.py <reexport log> [--revert]: compare every re-exported picture with the one it replaced (the committed
file, `git show HEAD:<path>`): the outline (alpha above half) of the new picture, scaled to the old size, must match
the old outline (IoU >= 0.96) and its colours must agree inside it. A cut that ate part of a white product, or kept a
floor shadow the first pass had removed, fails, and --revert puts the old picture (and its index.json size) back."""
import io, json, pathlib, re, subprocess, sys
import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
REPO = ROOT.parents[1]
DEST = REPO / "src" / "assets" / "devices"
log, revert = sys.argv[1], "--revert" in sys.argv
keys = re.findall(r"^\s+([a-z0-9-]+): \[\d+, \d+\] -> ", open(log, encoding="utf8").read(), re.M)
index = json.load(open(DEST / "index.json", encoding="utf8"))
models = {m["key"]: m for m in index["models"]}
bad = []
for k in keys:
    m = models[k]
    rel = f"src/assets/devices/{m['vendor']}/{k}.webp"
    old_bytes = subprocess.run(["git", "show", f"HEAD:{rel}"], cwd=REPO, capture_output=True).stdout
    if not old_bytes:
        continue
    old = Image.open(io.BytesIO(old_bytes)).convert("RGBA")
    new = Image.open(DEST / m["vendor"] / f"{k}.webp").convert("RGBA").resize(old.size, Image.LANCZOS)
    a, b = np.asarray(old)[..., 3] > 128, np.asarray(new)[..., 3] > 128
    iou = float((a & b).sum() / max(1, (a | b).sum()))
    both = a & b
    dc = float(np.abs(np.asarray(old)[..., :3][both].astype(int) - np.asarray(new)[..., :3][both].astype(int)).mean()) if both.any() else 99.0
    if iou < 0.96 or dc > 18:
        bad.append((k, round(iou, 3), round(dc, 1)))
        if revert:
            (DEST / m["vendor"] / f"{k}.webp").write_bytes(old_bytes)
            m["size"], m["kb"] = list(old.size), round(len(old_bytes) / 1024, 1)
print(f"{len(keys)} checked, {len(bad)} differ from the old cut{' (reverted)' if revert else ''}:")
for b in bad:
    print("  ", *b)
if revert:
    json.dump(index, open(DEST / "index.json", "w", encoding="utf8"), indent=1, ensure_ascii=False)
