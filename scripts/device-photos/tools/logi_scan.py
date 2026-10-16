"""Scan the Logitech G HUB depots (official updates.ghub.logitechg.com) with HTTP Range reads: for each depot read
the container header, walk the length-prefixed entries, and keep manifest.json + the image entry list. Nothing is
executed; depots are read as data."""
import json, re, struct, sys, concurrent.futures as cf, requests, pathlib
BASE = "https://updates.ghub.logitechg.com"
d = json.load(open(r"../../wave4-src/logitech/pipeline/details.json", encoding="utf8"))
deps = [x for x in d["depots"] if not x["name"].startswith(("core", "driver_", "applet_", "lua_", "release_notes", "audio_prompts", "gl"))]
S = requests.Session()
def rng(url, a, b):
    r = S.get(url, headers={"Range": f"bytes={a}-{b}"}, timeout=40)
    r.raise_for_status()
    return r.content
def scan(dep):
    url = BASE + dep["url"]
    try:
        head = rng(url, 0, 4095)
        hl = struct.unpack("<I", head[4:8])[0]
        hdr = json.loads(head[8:8 + hl])
        pos = 8 + hl
        entries = []
        for f in hdr["files"]:
            ln = struct.unpack("<I", (head[pos:pos + 4] if pos + 4 <= len(head) else rng(url, pos, pos + 3)))[0]
            entries.append({"name": f["name"], "len": ln, "off": pos + 4})
            pos += 4 + ln
        man = None
        for e in entries:
            if e["name"] == "manifest.json":
                man = json.loads(rng(url, e["off"], e["off"] + e["len"] - 1))
        return {"depot": dep["name"], "url": dep["url"], "size": dep["size"], "entries": entries, "manifest": man}
    except Exception as ex:
        return {"depot": dep["name"], "error": str(ex)[:200]}
out = []
with cf.ThreadPoolExecutor(8) as ex:
    for i, r in enumerate(ex.map(scan, deps)):
        out.append(r)
        if i % 50 == 0: print(i, len(deps), flush=True)
json.dump(out, open("logi-scan.json", "w"), indent=1)
print("done", len(out), sum(1 for o in out if "error" in o))
