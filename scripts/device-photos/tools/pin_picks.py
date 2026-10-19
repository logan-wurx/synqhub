"""pin_picks.py <vendor>: replace each index pick in picks/<vendor>.json by the address that index had on the review sheet
(cand/<vendor>.json, written by cands2.py), so build2.py fetches exactly the picture that was looked at even when an
archived page or a store listing lists its pictures in another order the next time. Picks already pinned are kept."""
import json, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
vendor = sys.argv[1]
picks_f = ROOT / "picks" / f"{vendor}.json"
picks = json.load(open(picks_f, encoding="utf8"))
cand = json.load(open(ROOT / "cand" / f"{vendor}.json", encoding="utf8"))
pinned = 0
for key, sel in picks.items():
    if isinstance(sel, int) and key in cand and "urls" in cand[key] and sel < len(cand[key]["urls"]):
        picks[key] = cand[key]["urls"][sel]
        pinned += 1
json.dump(picks, open(picks_f, "w", encoding="utf8"), indent=1, ensure_ascii=False)
print(f"{vendor}: {pinned} picks pinned to their addresses")
