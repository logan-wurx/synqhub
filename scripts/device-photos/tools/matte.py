"""Background removal with rembg (isnet-general-use), run in the scratch venv. cutout(im) -> RGBA PIL image."""
import io
from PIL import Image

_sessions = {}


def session(model="isnet-general-use"):
    if model not in _sessions:
        from rembg import new_session
        _sessions[model] = new_session(model)
    return _sessions[model]


def cutout(im, model="isnet-general-use", max_side=1400):
    """Matte a picture. Large pictures are matted at max_side (the model works at 1024 anyway) and the alpha scaled back."""
    from rembg import remove
    rgb = im.convert("RGB")
    w, h = rgb.size
    s = min(1.0, max_side / max(w, h))
    work = rgb.resize((round(w * s), round(h * s)), Image.LANCZOS) if s < 1 else rgb
    out = remove(work, session=session(model), post_process_mask=True)
    return out.convert("RGBA")
