import json, pathlib, subprocess, sys
REPO = pathlib.Path(__file__).resolve().parents[3]
D = REPO / "src/assets/devices"
idx = json.load(open(D / "index.json", encoding="utf8"))["models"]
idx.sort(key=lambda m: (m["kind"], m["vendor"], m["key"]))
files = [str(D / m["vendor"] / f"{m['key']}.webp") for m in idx]
per = 70
for n in range(0, len(files), per):
    out = REPO / "release/photo-shots" / f"all-pictures-{n // per + 1}.png"
    subprocess.run([sys.executable, str(pathlib.Path(__file__).parent / "sheet.py"), str(out), "10", "150", "#17151a", *files[n:n + per]], check=True)
