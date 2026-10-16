"""Pull the device_image of each wanted Logitech G HUB depot model (official updates.ghub.logitechg.com) into raw/logitech/."""
import json, re, requests, pathlib
BASE = "https://updates.ghub.logitechg.com"
scan = {o["depot"]: o for o in json.load(open("logi-scan.json")) if "error" not in o and o.get("manifest")}
want_depots = """g203 g102_g203 g213_international_2 g302 g303 g303_wireless g305 g310_international g402 g403 g403_hero g410_international g413_international_2 g502 g502_hero g502_wireless
g512_se_international_2 g513_international_2 g600 g602 g603 g604 g610_international_2 g613_international_2 g703 g703_hero g810_international_2 g815_international_2 g900 g903 g903_hero g910_international_2
g915_international_2 g915_tkl_international_2 mx518 pro_keyboard_international_2 pro_mouse pro_mouse_hero pro_wireless_mouse_depot pro_x_wireless_mouse""".split()
out = pathlib.Path("../raw/logitech"); out.mkdir(parents=True, exist_ok=True)
S = requests.Session()
rows = []
for dn in want_depots:
    o = scan.get(dn)
    if not o:
        print("missing depot", dn); continue
    ents = {e["name"]: e for e in o["entries"]}
    for dv in o["manifest"].get("devices", []):
        res = {r["key"]: r["src"] for r in dv.get("resources", [])}
        src = res.get("device_image")
        if not src or src not in ents: continue
        fn = out / f"{dn}__{dv['modelId']}{pathlib.Path(src).suffix}"
        e = ents[src]
        if not fn.exists():
            r = S.get(BASE + o["url"], headers={"Range": f"bytes={e['off']}-{e['off']+e['len']-1}"}, timeout=120)
            r.raise_for_status()
            fn.write_bytes(r.content)
        rows.append({"depot": dn, "modelId": dv["modelId"], "file": fn.name, "src": src, "url": BASE + o["url"], "bytes": e["len"]})
json.dump(rows, open("../raw/logitech/_index.json", "w"), indent=1)
print(len(rows), "images")
