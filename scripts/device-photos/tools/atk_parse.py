import re, json, collections
t = open(r"../../atkhub-src/index.js", encoding="utf8").read()
entries = re.findall(r'"\.\./assets/device/([a-z]+)/([^"/]+)/([^"/]+\.(?:webp|png|jpg))":([A-Za-z_$][\w$]*)', t)
wrap = dict(re.findall(r'([A-Za-z_$][\w$]*)=Object\.freeze\(Object\.defineProperty\(\{__proto__:null,default:([A-Za-z_$][\w$]*)\}', t))
urls = dict(re.findall(r'([A-Za-z_$][\w$]*)="(https://bpcdn\.atkgear\.com/hub-v3/production/[^"]+)"', t))
out = []
for kind, model, fn, ident in entries:
    u = urls.get(wrap.get(ident, ""), None)
    out.append({"kind": kind, "model": model, "file": fn, "url": u})
json.dump(out, open("atk-hub-images.json", "w"), indent=1)
c = collections.defaultdict(list)
for o in out: c[(o["kind"], o["model"])].append(o["file"])
print(len(out), sum(1 for o in out if not o["url"]))
for k, v in sorted(c.items()): print(k, v)
