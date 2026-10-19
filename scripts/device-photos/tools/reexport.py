"""reexport.py [--dry]: bring the earlier passes' pictures up to the new size (about 900 px on the long side, proc.py), from
the very source each one names in src/assets/devices/SOURCES.json, cut the way it was cut then:
  - a transparent source keeps its own alpha;
  - an opaque source the matting model cut before is found in cache/matte (keyed by the source's bytes) and reused;
  - any other opaque source was cut by the flood fill of the first pass (proc.py), and is again.
A picture is only replaced when the source gives a bigger one (never enlarged). Lights (kept whole, glow feathered, kit
shots cropped) and the Joy-Con crops keep their pictures. index.json gets the new size and weight; SOURCES.json is unchanged
(same source). Run with the matting venv's python."""
import io, json, hashlib, pathlib, sys, time
from PIL import Image
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import ROOT, fetch
import proc, proc2

REPO = ROOT.parents[1]
DEST = REPO / "src" / "assets" / "devices"
# Cut differently than the source alone says: crops of a pair shot, and a white ground behind a stray transparent corner.
SKIP_KEYS = {"nintendo-joy-con", "nintendo-joy-con-l", "nintendo-joy-con-r", "ajazz-ak680-max"}
# Built at the new size already (this pass's vendors, out/<vendor>/_report.json), with their own options.
for rp in (ROOT / "out").glob("*/_report.json"):
    SKIP_KEYS |= {r["key"] for r in json.load(open(rp))}
dry = "--dry" in sys.argv


def source_of(url):
    """The pipeline's address for a SOURCES.json sourceUrl (archived pictures go back through the polite Wayback fetch)."""
    if url.startswith("https://web.archive.org/web/") and "im_/" in url:
        ts, orig = url[len("https://web.archive.org/web/"):].split("im_/", 1)
        return f"wb:{ts}:{orig}"
    return url


def cut(raw):
    """(RGBA picture cut as before, how) or (None, why)."""
    im = proc.load_rgba(io.BytesIO(raw))
    clear, edge = proc.alpha_stats(im)
    if edge >= 0.5 or clear >= 0.002:
        return im, "alpha"
    matte = proc2.CACHE_M / f"{hashlib.sha1(raw).hexdigest()}.png"
    if matte.exists():
        return Image.open(matte).convert("RGBA"), "matte"
    out, info = proc.cut_flat_bg(im)
    return (out, "flood") if out is not None else (None, f"flood: {info}")


def main():
    index = json.load(open(DEST / "index.json", encoding="utf8"))
    sources = {s["key"]: s for s in json.load(open(DEST / "SOURCES.json", encoding="utf8"))["images"]}
    done = kept = failed = 0
    before = after = 0
    for m in index["models"]:
        key = m["key"]
        if m["kind"] == "light" or key in SKIP_KEYS or max(m["size"]) >= proc.LONG - 10:
            continue
        s = sources.get(key, {})
        url = s.get("sourceUrl")
        if not url:
            continue
        src = source_of(url)
        if not src.startswith("wb:") and not (ROOT / "cache" / hashlib.sha1(src.encode()).hexdigest()).exists():
            time.sleep(1.5)   # a live fetch: one every second and a half (archived ones are paced by wb_fetch)
        try:
            raw = fetch(src)
            im, how = cut(raw)
        except Exception as e:
            print(f"  fail {key}: {str(e)[:70]}", flush=True)
            failed += 1
            continue
        if im is None:
            print(f"  keep {key}: {how}", flush=True)
            kept += 1
            continue
        im, _ = proc.keep_largest(im, 5)
        im = proc.trim(im)
        if im is None or max(im.size) <= max(m["size"]) + 40:
            kept += 1
            continue
        data, q, size = proc.encode(im)
        f = DEST / m["vendor"] / f"{key}.webp"
        before += f.stat().st_size
        after += len(data)
        print(f"  {key}: {m['size']} -> {list(size)} ({how}, q{q}, {len(data) // 1024} KB)", flush=True)
        if not dry:
            f.write_bytes(data)
            m["size"], m["kb"] = list(size), round(len(data) / 1024, 1)
        done += 1
    if not dry:
        json.dump(index, open(DEST / "index.json", "w", encoding="utf8"), indent=1, ensure_ascii=False)
    print(f"re-exported {done}, kept {kept}, failed {failed}; {before / 1048576:.1f} MB -> {after / 1048576:.1f} MB")


if __name__ == "__main__":
    main()
