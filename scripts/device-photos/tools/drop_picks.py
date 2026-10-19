"""drop_picks.py <vendor> <key>...: take pictures rejected on the dark review sheet back out: the pick, the built file and
its line in ../out/<vendor>/_report.json (so assemble2.py does not merge it)."""
import json, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
vendor, keys = sys.argv[1], set(sys.argv[2:])
picks_f = ROOT / "picks" / f"{vendor}.json"
picks = json.load(open(picks_f, encoding="utf8"))
for k in keys:
    picks.pop(k, None)
    (ROOT / "out" / vendor / f"{k}.webp").unlink(missing_ok=True)
json.dump(picks, open(picks_f, "w", encoding="utf8"), indent=1, ensure_ascii=False)
rep_f = ROOT / "out" / vendor / "_report.json"
if rep_f.exists():
    rep = [r for r in json.load(open(rep_f)) if r["key"] not in keys]
    json.dump(rep, open(rep_f, "w"), indent=1)
print(f"{vendor}: dropped {len(keys)}, {len(picks)} picks left")
