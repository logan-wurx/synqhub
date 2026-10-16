"""assemble.py: merge every ../out/<vendor>/_report.json into the repo: src/assets/devices/<vendor>/<key>.webp,
src/assets/devices/index.json (model table for the index generator) and src/assets/devices/SOURCES.json."""
import json, pathlib, shutil, sys, datetime
HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "out"
REPO = HERE.parents[2]
DEST = REPO / "src" / "assets" / "devices"
EXCLUDE = {"razer-deathadder-v3-pro", "logitech-pro-x-superlight-2", "logitech-pro-x-superlight-2-dex", "rog-falchion-ace-hfx-zywoo-edition"}   # the developer's own renders cover the Superlight 2 / DEX / ZywOo Falchion
models, sources, seen = [], [], {}
if DEST.exists():
    shutil.rmtree(DEST)
DEST.mkdir(parents=True)
total = 0
for vdir in sorted(OUT.iterdir()):
    rp = vdir / "_report.json"
    if not rp.exists():
        continue
    for r in json.load(open(rp)):
        if not r.get("ok") or r["key"] in EXCLUDE:
            continue
        key, vendor = r["key"], r["vendor"]
        if key in seen:
            # a later pass (alphabetically) replaces an earlier one: steelseries2 over steelseries
            models[:] = [m for m in models if m["key"] != key]
            sources[:] = [m for m in sources if m["key"] != key]
        seen[key] = vdir.name
        d = DEST / vendor
        d.mkdir(exist_ok=True)
        shutil.copyfile(vdir / f"{key}.webp", d / f"{key}.webp")
        total += (d / f"{key}.webp").stat().st_size
        models.append({"key": key, "vendor": vendor, "name": r["name"], "kind": r["kind"], "ids": r["ids"], "names": r["names"], "kb": r["kb"], "size": r["size"]})
        src = r.get("url") or r.get("file") or ""
        sources.append({"vendor": vendor, "model": r["name"], "key": key, "ids": r["ids"], "sourceUrl": src if str(src).startswith("http") else None, "pageUrl": r.get("page"), "fetched": r.get("fetched"), "how": r.get("note")})
models.sort(key=lambda m: (m["vendor"], m["key"]))
sources.sort(key=lambda m: (m["vendor"], m["key"]))
json.dump({"models": models}, open(DEST / "index.json", "w"), indent=1, ensure_ascii=False)
json.dump({"notice": "Product images (c) their respective owners; fetched from the makers' own official sites, configurators and apps. Want one removed? Open an issue.", "images": sources}, open(DEST / "SOURCES.json", "w"), indent=1, ensure_ascii=False)
print(len(models), "models", round(total / 1048576, 2), "MB")
from collections import Counter
print(Counter(m["vendor"] for m in models))
