"""Trace the SYNQ pack's PNGs (alpha) into SVG paths. Usage: python trace.py <pack_dir> <out_dir>"""
import json
import sys
from pathlib import Path

import numpy as np
import potrace
from PIL import Image

pack, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)


def trace(img: Image.Image, scale: float = 1.0) -> tuple[str, list]:
    """Alpha > 50% becomes ink; returns path data in the image's pixel space (times `scale`) and each curve's bbox."""
    # potracer fills the False pixels, so ink is passed as False.
    a = np.array(img.getchannel("A")) <= 127
    plist = potrace.Bitmap(a).trace(turdsize=8, turnpolicy=potrace.POTRACE_TURNPOLICY_MINORITY, alphamax=1.0, opticurve=True, opttolerance=0.2)
    f = lambda p: f"{p.x * scale:.1f} {p.y * scale:.1f}"
    parts, boxes = [], []
    for curve in plist:
        d = [f"M{f(curve.start_point)}"]
        xs, ys = [curve.start_point.x], [curve.start_point.y]
        for seg in curve.segments:
            if seg.is_corner:
                d.append(f"L{f(seg.c)}L{f(seg.end_point)}")
                pts = [seg.c, seg.end_point]
            else:
                d.append(f"C{f(seg.c1)} {f(seg.c2)} {f(seg.end_point)}")
                pts = [seg.c1, seg.c2, seg.end_point]
            xs += [p.x for p in pts]
            ys += [p.y for p in pts]
        d.append("Z")
        parts.append("".join(d))
        boxes.append([min(xs) * scale, min(ys) * scale, max(xs) * scale, max(ys) * scale])
    return "".join(parts), boxes


def crop(name: str, box=None) -> Image.Image:
    im = Image.open(pack / name).convert("RGBA")
    return im.crop(box or im.getbbox())


report = {}
for key, name, box in [
    ("mark", "synq-icon-white.png", None),
    ("wordmark", "synq-wordmark-white.png", None),
    ("logo", "synq-logo-white.png", None),
]:
    im = crop(name, box)
    d, boxes = trace(im)
    w, h = im.size
    (out / f"{key}.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}"><path fill="currentColor" fill-rule="evenodd" d="{d}"/></svg>\n')
    report[key] = {"size": [w, h], "curves": len(boxes), "boxes": [[round(v) for v in b] for b in boxes]}

# The tagline: the lower band of the tagline lockup, under the logo.
tl = Image.open(pack / "synq-logo-tagline-white.png").convert("RGBA")
bb = tl.getbbox()
band = tl.crop((bb[0], 760, bb[2], bb[3]))
band = band.crop(band.getbbox())
d, boxes = trace(band)
w, h = band.size
(out / "tagline.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}"><path fill="currentColor" fill-rule="evenodd" d="{d}"/></svg>\n')
report["tagline"] = {"size": [w, h], "curves": len(boxes)}
print(json.dumps(report, indent=1)[:3000])
