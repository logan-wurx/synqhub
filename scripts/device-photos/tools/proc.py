"""Normalize one vendor product image into SYNQ's device-picture format.

  load -> (transparent already? keep : cut the flat background with an edge flood fill + soft alpha)
       -> trim to the subject -> fit to ~900 px on the long side (never enlarged) -> WebP (at most 70 KB, most 25-70).

proc(path, out_webp, bg="auto") returns a report dict; report["ok"] False means "skip this image" (with report["why"]).
"""
import io, sys, json
import numpy as np
from PIL import Image, ImageFilter

LONG = 900          # target long side (the large studio tiles show a picture about 400 px tall, 800 on a HiDPI screen)
MAX_KB = 70
MIN_SRC = 220       # smaller than this on the long side is too soft to use

def load_rgba(path):
    im = Image.open(path)
    if im.mode == "P":
        im = im.convert("RGBA")
    elif im.mode in ("LA", "La"):
        im = im.convert("RGBA")
    elif im.mode != "RGBA":
        im = im.convert("RGB").convert("RGBA")
    return im

def alpha_stats(im):
    """(share of fully clear pixels, share of clear pixels on the border frame)."""
    a = np.asarray(im.getchannel("A"))
    fr = np.concatenate([a[:3].ravel(), a[-3:].ravel(), a[:, :3].ravel(), a[:, -3:].ravel()])
    return float((a < 20).mean()), float((fr < 20).mean())

def downscale_for_work(im, cap=900):
    w, h = im.size
    s = cap / max(w, h)
    if s >= 1: return im, 1.0
    return im.resize((round(w * s), round(h * s)), Image.LANCZOS), s

def border_bg(rgb, w=3):
    """Median border colour + how uniform the frame is. rgb: HxWx3 uint8."""
    h, wd, _ = rgb.shape
    fr = np.concatenate([rgb[:w].reshape(-1, 3), rgb[-w:].reshape(-1, 3), rgb[:, :w].reshape(-1, 3), rgb[:, -w:].reshape(-1, 3)])
    med = np.median(fr, axis=0)
    d = np.abs(fr.astype(np.int16) - med.astype(np.int16)).max(axis=1)
    return med, float((d <= 14).mean())

def flood(mask):
    """Connected component of `mask` reachable from the image border (4-neighbour)."""
    h, w = mask.shape
    flat = mask.ravel()
    seen = np.zeros(h * w, dtype=bool)
    stack = []
    for x in range(w):
        for y in (0, h - 1):
            i = y * w + x
            if flat[i] and not seen[i]: seen[i] = True; stack.append(i)
    for y in range(h):
        for x in (0, w - 1):
            i = y * w + x
            if flat[i] and not seen[i]: seen[i] = True; stack.append(i)
    while stack:
        i = stack.pop()
        x = i % w
        for j in ((i - w) if i >= w else -1, (i + w) if i < (h - 1) * w else -1, (i - 1) if x else -1, (i + 1) if x < w - 1 else -1):
            if j >= 0 and flat[j] and not seen[j]:
                seen[j] = True; stack.append(j)
    return seen.reshape(h, w)

def cut_flat_bg(im):
    """Soft-alpha cut of a flat-coloured background. Returns (rgba, report) or (None, why)."""
    work, s = downscale_for_work(im.convert("RGB"))
    rgb = np.asarray(work)
    med, uni = border_bg(rgb)
    if uni < 0.93:
        return None, f"background not flat (frame uniformity {uni:.2f})"
    dist = np.abs(rgb.astype(np.int16) - med.astype(np.int16)).max(axis=2)
    bgmask = flood(dist <= 16)
    # Dark products photographed on white keep a soft grey floor shadow: eat it (light, low-saturation pixels within a few
    # px of the background) when the product's own body is dark, so a white product is never touched.
    lum = rgb.astype(np.float32).mean(axis=2)
    sat = rgb.max(axis=2).astype(np.int16) - rgb.min(axis=2).astype(np.int16)
    near18 = np.asarray(Image.fromarray((bgmask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(37))) > 0
    core = ~near18
    if core.sum() > 400 and float(np.median(lum[core])) < 140 and float(med.mean()) > 200:
        shadowy = (lum > 120) & (sat <= 28) & (dist <= 110)
        m = bgmask.copy()
        for _ in range(16):
            g = m.copy()
            g[1:, :] |= m[:-1, :]; g[:-1, :] |= m[1:, :]; g[:, 1:] |= m[:, :-1]; g[:, :-1] |= m[:, 1:]
            g &= (shadowy | m)
            if (g == m).all(): break
            m = g
        bgmask = m
    frac = float(bgmask.mean())
    if frac < 0.12: return None, f"background removal found only {frac:.0%} background"
    if frac > 0.97: return None, "nothing left after cut"
    # soft edge: pixels within 2 px of the background region get an alpha from their distance to the bg colour
    bgimg = Image.fromarray((bgmask * 255).astype(np.uint8))
    near = np.asarray(bgimg.filter(ImageFilter.MaxFilter(5))) > 0
    alpha = np.where(bgmask, 0.0, 1.0)
    edge = near & ~bgmask
    alpha[edge] = np.clip((dist[edge].astype(np.float32) - 10) / 50.0, 0, 1)
    # un-matte the colour fringe toward the foreground
    a = np.clip(alpha, 1e-3, 1)[..., None]
    fg = (rgb.astype(np.float32) - med.astype(np.float32) * (1 - a)) / a
    fg = np.clip(fg, 0, 255)
    fg = np.where(edge[..., None], fg, rgb.astype(np.float32))
    out = np.dstack([fg.astype(np.uint8), (alpha * 255).astype(np.uint8)])
    # one px of erosion on the alpha hides the last of the halo
    A = Image.fromarray(out[..., 3]).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.6))
    out[..., 3] = np.asarray(A)
    rgba = Image.fromarray(out, "RGBA")
    if s != 1.0:  # keep the work-size result; it is already near the output size
        pass
    return rgba, {"bg": [int(x) for x in med], "bgFrac": round(frac, 3)}


def components(mask):
    """Label 8-connected components of a boolean mask; returns (labels, sizes)."""
    h, w = mask.shape
    lab = np.zeros(mask.shape, dtype=np.int32)
    flat = mask.ravel(); lf = lab.ravel()
    sizes = [0]
    n = 0
    for start in np.flatnonzero(flat):
        if lf[start]: continue
        n += 1
        stack = [start]; lf[start] = n; cnt = 0
        while stack:
            i = stack.pop(); cnt += 1
            y, x = divmod(i, w)
            for dy in (-1, 0, 1):
                yy = y + dy
                if yy < 0 or yy >= h: continue
                for dx in (-1, 0, 1):
                    xx = x + dx
                    if (dy or dx) and 0 <= xx < w:
                        j = yy * w + xx
                        if flat[j] and not lf[j]:
                            lf[j] = n; stack.append(j)
        sizes.append(cnt)
    return lab, sizes

def keep_largest(im, bridge=5):
    """Drop every opaque blob except the biggest (dongles, captions, boxes). Returns (im, other_fraction)."""
    a = np.asarray(im.getchannel("A"))
    small = Image.fromarray(a).resize((max(1, a.shape[1] // 3), max(1, a.shape[0] // 3)), Image.BILINEAR)
    m = np.asarray(small) > 60
    # bridge hairline gaps so one product stays one blob
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(bridge))) > 0
    lab, sizes = components(m)
    if len(sizes) < 2: return im, 0.0
    big = int(np.argmax(sizes[1:])) + 1
    total = sum(sizes[1:])
    other = 1 - sizes[big] / total
    keepm = np.asarray(Image.fromarray(((lab == big) * 255).astype(np.uint8)).resize((a.shape[1], a.shape[0]), Image.NEAREST).filter(ImageFilter.MaxFilter(9))) > 0
    a2 = np.where(keepm, a, 0).astype(np.uint8)
    out = im.copy(); out.putalpha(Image.fromarray(a2))
    return out, float(other)

def hull_area(points):
    pts = sorted(set(points))
    if len(pts) < 3: return 0.0
    def cross(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo = []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    up = []
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    hull = lo[:-1] + up[:-1]
    return abs(sum(hull[i][0] * hull[(i + 1) % len(hull)][1] - hull[(i + 1) % len(hull)][0] * hull[i][1] for i in range(len(hull)))) / 2

def shape_metrics(im):
    """aspect (h/w), mirror symmetry (IoU of mask vs its flip), solidity (area / convex hull) of the subject."""
    a = np.asarray(im.getchannel("A")) > 128
    ys, xs = np.nonzero(a)
    if len(xs) < 50: return None
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    sub = a[y0:y1 + 1, x0:x1 + 1]
    h, w = sub.shape
    flip = sub[:, ::-1]
    iou = float((sub & flip).sum() / max(1, (sub | flip).sum()))
    # solidity on a coarse grid
    step = max(1, max(h, w) // 120)
    g = sub[::step, ::step]
    gy, gx = np.nonzero(g)
    area = g.sum()
    # boundary points only
    edge = g & ~(np.pad(g, 1)[:-2, 1:-1] & np.pad(g, 1)[2:, 1:-1] & np.pad(g, 1)[1:-1, :-2] & np.pad(g, 1)[1:-1, 2:])
    ey, ex = np.nonzero(edge)
    ha = hull_area(list(zip(ex.tolist(), ey.tolist())))
    return {"aspect": h / w, "sym": iou, "solidity": float(area / ha) if ha else 0.0, "w": w, "h": h}

def trim(im, pad_frac=0.02):
    a = im.getchannel("A").point(lambda v: 255 if v > 10 else 0)
    box = a.getbbox()
    if not box: return None
    w, h = im.size
    pad = max(2, int(max(box[2] - box[0], box[3] - box[1]) * pad_frac))
    box = (max(box[0] - pad, 0), max(box[1] - pad, 0), min(box[2] + pad, w), min(box[3] + pad, h))
    return im.crop(box)

def encode(im, kb=MAX_KB):
    """Smallest-loss WebP under the size cap; shrinks the picture only when quality 58 still overshoots."""
    best = None
    for long_side in (LONG, 800, 700):
        w, h = im.size
        s = long_side / max(w, h)
        r = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS) if s < 1.0 or max(w, h) > long_side else im
        for q in (90, 86, 82, 78, 74, 70, 64, 58):
            buf = io.BytesIO()
            r.save(buf, "WEBP", quality=q, alpha_quality=min(q + 8, 100), method=6)
            if buf.tell() <= kb * 1024:
                return buf.getvalue(), q, r.size
            best = (buf.getvalue(), q, r.size)
    return best

def prepare(im, bg="auto", largest=True, bridge=5):
    """RGBA picture -> (cut, trimmed RGBA, report) or (None, None, report-with-why)."""
    rep = {}
    w, h = im.size
    rep["srcSize"] = [w, h]
    if max(w, h) < MIN_SRC: return None, {**rep, "ok": False, "why": f"too small ({w}x{h})"}
    t_clear, t_edge = alpha_stats(im)
    rep["transparent"] = round(t_clear, 3)
    real_alpha = t_edge >= 0.5 or t_clear >= 0.002
    if not real_alpha and bg != "none":
        cut, info = cut_flat_bg(im)
        if cut is None: return None, {**rep, "ok": False, "why": info}
        rep["cut"] = info
        im = cut
    if largest:
        im, other = keep_largest(im, bridge)
        rep["otherBlobs"] = round(other, 3)
    im = trim(im)
    if im is None: return None, {**rep, "ok": False, "why": "empty"}
    met = shape_metrics(im)
    if met: rep["shape"] = {k: round(v, 3) for k, v in met.items()}
    return im, rep

def proc(path, out, bg="auto", largest=True, bridge=5):
    rep = {"src": str(path)}
    try:
        im = load_rgba(path)
    except Exception as e:
        return {**rep, "ok": False, "why": f"unreadable: {e}"}
    im, r = prepare(im, bg, largest, bridge)
    rep.update(r)
    if im is None: return rep
    data, q, size = encode(im)
    open(out, "wb").write(data)
    return {**rep, "ok": True, "kb": round(len(data) / 1024, 1), "q": q, "size": list(size)}

if __name__ == "__main__":
    print(json.dumps(proc(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "auto"), indent=1))
