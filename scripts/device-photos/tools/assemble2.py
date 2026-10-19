"""assemble2.py: merge the second-pass results (../out/<vendor>/_report.json) into the repo's src/assets/devices WITHOUT removing what is there:
new pictures are copied in, a key that already exists is replaced, aliases.json adds names and USB ids to existing pictures (same-shell models share one picture),
and index.json / SOURCES.json are rewritten."""
import json, pathlib, shutil, sys, collections

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "out"
REPO = HERE.parents[2]          # the checkout this script is in (tools -> device-photos -> scripts -> repo), so a worktree writes to itself
DEST = REPO / "src" / "assets" / "devices"
# Keys never merged. The developer's own devices (Superlight 2, DEX, ZywOo Falchion) used to be left to SYNQ's renders; they now have
# product photos too (vendors/own.py), found by name only, so the renders still win where DeviceArt prefers them.
EXCLUDE: set = set()

index = json.load(open(DEST / "index.json", encoding="utf8"))["models"]
src = json.load(open(DEST / "SOURCES.json", encoding="utf8"))
notice, images = src["notice"], src["images"]
models = {m["key"]: m for m in index}
sources = {s["key"]: s for s in images}
added = replaced = 0
for vdir in sorted(OUT.iterdir()):
    rp = vdir / "_report.json"
    if not rp.exists():
        continue
    for r in json.load(open(rp)):
        if not r.get("ok") or r["key"] in EXCLUDE:
            continue
        key, vendor = r["key"], r["vendor"]
        if key in models:
            old = models[key]
            oldf = DEST / old["vendor"] / f"{key}.webp"
            if oldf.exists() and old["vendor"] != vendor:
                oldf.unlink()
            replaced += 1
        else:
            added += 1
        d = DEST / vendor
        d.mkdir(exist_ok=True)
        shutil.copyfile(vdir / f"{key}.webp", d / f"{key}.webp")
        models[key] = {"key": key, "vendor": vendor, "name": r["name"], "kind": r["kind"], "ids": r["ids"], "names": r["names"], "kb": r["kb"], "size": r["size"]}
        s = r.get("url") or r.get("file") or ""
        if str(s).startswith("wb:"):
            _, ts, orig = s.split(":", 2)
            s = f"https://web.archive.org/web/{ts}im_/{orig}"
        page = r.get("page") or ""
        if page and not page.startswith("http"):
            page = "https://web.archive.org/web/2/https://" + page.rstrip("*")
        sources[key] = {"vendor": vendor, "model": r["name"], "key": key, "ids": r["ids"], "sourceUrl": s if str(s).startswith("http") else None, "pageUrl": page or None, "fetched": r.get("fetched"), "how": r.get("note")}

alias_f = HERE.parent / "aliases.json"
if alias_f.exists():
    for key, a in json.load(open(alias_f)).items():
        if key not in models:
            print("alias for a missing picture:", key)
            continue
        m = models[key]
        m["names"] = sorted(set(m["names"]) | set(a.get("names", [])))
        m["ids"] = sorted(set(m["ids"]) | set(a.get("ids", [])))
        sources[key]["ids"] = m["ids"]
        # Once only: a picture whose source was not re-merged this run already carries the note.
        also = " | also used for: " + ", ".join(a.get("for", [])) if a.get("for") else ""
        if also not in (sources[key].get("how") or ""):
            sources[key]["how"] = (sources[key].get("how") or "") + also

ml = sorted(models.values(), key=lambda m: (m["vendor"], m["key"]))
sl = sorted(sources.values(), key=lambda m: (m["vendor"], m["key"]))
json.dump({"models": ml}, open(DEST / "index.json", "w", encoding="utf8"), indent=1, ensure_ascii=False)
json.dump({"notice": notice, "images": sl}, open(DEST / "SOURCES.json", "w", encoding="utf8"), indent=1, ensure_ascii=False)
total = sum(f.stat().st_size for f in DEST.rglob("*.webp"))
print(f"added {added}, replaced {replaced}; {len(ml)} pictures, {total / 1048576:.2f} MB")
print(collections.Counter(m["vendor"] for m in ml).most_common(40))
