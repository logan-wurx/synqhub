"""Second-pass picture preparation: real alpha is kept, anything opaque is matted with rembg (isnet-general-use), then the same
trim / largest-piece / encode steps as proc.py. Run with the scratch venv's python (rembg + onnxruntime)."""
import io, hashlib, pathlib, sys
import numpy as np
from PIL import Image
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import ROOT
import proc

CACHE_M = ROOT / "cache" / "matte"
CACHE_M.mkdir(parents=True, exist_ok=True)


def matted(raw, force=False):
    """RGBA picture from raw bytes: kept as is when it has real transparency, else matted by rembg. Cached by content."""
    key = hashlib.sha1(raw).hexdigest()
    f = CACHE_M / f"{key}.png"
    if f.exists():
        return Image.open(f).convert("RGBA"), "cached"
    im = proc.load_rgba(io.BytesIO(raw))
    clear, edge = proc.alpha_stats(im)
    if not force and (edge >= 0.5 or clear >= 0.002):
        out, how = im, "alpha"
    else:
        import matte
        out, how = matte.cutout(im), "rembg"
    if how == "rembg":
        out.save(f)
    return out, how


def prepare(raw, bridge=5, force=False, soft=False):
    """(trimmed RGBA, report) or (None, report with why). `soft` keeps the picture's own alpha whole (a lamp's glow): no largest-piece cut."""
    try:
        im, how = matted(raw, force)
    except Exception as e:
        return None, {"ok": False, "why": f"unreadable: {str(e)[:60]}"}
    rep = {"srcSize": list(im.size), "how": how}
    w, h = im.size
    if max(w, h) < 180:
        return None, {**rep, "ok": False, "why": "too small"}
    a = np.asarray(im.getchannel("A"))
    cover = float((a > 128).mean())
    rep["cover"] = round(cover, 3)
    if cover < 0.03 or cover > 0.97:
        return None, {**rep, "ok": False, "why": f"subject coverage {cover:.2f}"}
    if not soft:
        im, other = proc.keep_largest(im, bridge)
        rep["otherBlobs"] = round(other, 3)
    im = proc.trim(im)
    if im is None:
        return None, {**rep, "ok": False, "why": "empty"}
    met = proc.shape_metrics(im)
    if met:
        rep["shape"] = {k: round(v, 3) for k, v in met.items()}
    rep["ok"] = True
    return im, rep


def proc_file(raw, out, bridge=5, force=False, soft=False):
    im, rep = prepare(raw, bridge, force, soft)
    if im is None:
        return rep
    data, q, size = proc.encode(im)
    pathlib.Path(out).write_bytes(data)
    return {**rep, "kb": round(len(data) / 1024, 1), "q": q, "size": list(size)}
