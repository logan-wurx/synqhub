"""Monitors and webcams whose maker's site refuses the pipeline (dell.com, msi.com, gigabyte.com answer 403) or has dropped the
page (Microsoft's LifeCams): the Wayback Machine's copy of the maker's own page -> the product pictures it linked, taken from the
maker's image server when it still answers (msi.com's and gigabyte.com's do), else from the archived copy ('wb:<timestamp>:<url>').
The same method as wayback3.py and padswb.py, with an address regex per row because these image servers name pictures without a
picture extension (Dell's Scene7 '.psd' names, Gigabyte's '/png/1000' paths). Steps: cands2.py displayswb, picks in
picks/displayswb.json, build2.py displayswb."""
import json, re, sys
from common import ROOT, job, wb_fetch
from vendors.wayback3 import live_ok, snapshots

URL = re.compile(r"""(?:https?:)?//[^"'\s<>)\\]+""")
DELL = "dell.com/en-us/shop/{}*"
DELL_PIC = (r"i\.dell\.com/is/image/DellContent/content/dam/.+?/(?:media-gallery|pdp)/[^/?]+\.psd\?", None)
MSI_PIC = (r"asset\.msi\.com/resize/image/global/product/(product_[0-9a-f]+\.png[0-9a-f]+)/\d+\.png", "https://asset.msi.com/resize/image/global/product/{}/1024.png")
GB_PIC = (r"static\.gigabyte\.com/StaticFile/Image/Global/([0-9a-f]{32}/Product/\d+)/(?:png|webp)/\d+", "https://static.gigabyte.com/StaticFile/Image/Global/{}/png/1000")
# Microsoft's archived pages (2015-2017) redirect to the webcam listing, which shows every LifeCam: each row takes only
# the pictures named for its own model (ic_lcstv2_*: Studio, ic_hd3000*: HD-3000).
MS_PAGES = ["microsoft.com/accessories/en-us/products/webcams/lifecam-studio/q2f-00013", "microsoft.com/accessories/en-us/products/webcams/lifecam-hd-3000/t3h-00011"]


def ms_pic(name):
    return (r"compass\.(?:microsoft|surface)\.com/assets/[^?]+\.(?:jpg|png)\?n=" + name + r"[^\"'&\s]*", None)

# (key, vendor, display name, USB ids, other names, archived page addresses (a trailing * takes every address under it), (regex, address))
ROWS = [
    ("dell-aw2725df", "dell", "Alienware AW2725DF", [], ["aw2725df"], [DELL.format("alienware-27-360hz-qd-oled-gaming-monitor-aw2725df/apd/210-bljd")], DELL_PIC),
    ("dell-aw3423dwf", "dell", "Alienware AW3423DWF", [], ["aw3423dwf"], [DELL.format("alienware-34-curved-qd-oled-gaming-monitor-aw3423dwf/apd/210-bfrp")], DELL_PIC),
    ("dell-aw2523hf", "dell", "Alienware AW2523HF", [], ["aw2523hf"], [DELL.format("alienware-25-gaming-monitor-aw2523hf/apd/210-bfed")], DELL_PIC),
    ("dell-aw2724hf", "dell", "Alienware AW2724HF", [], ["aw2724hf"], [DELL.format("alienware-27-gaming-monitor-aw2724hf/apd/210-bhym")], DELL_PIC),
    ("dell-s2721dgf", "dell", "Dell S2721DGF", [], ["s2721dgf"], [DELL.format("dell-27-gaming-monitor-s2721dgf/apd/210-axeh"), "dell.com/en-us/shop/cty/pdp/spd/dell-s2721dgf-monitor"], DELL_PIC),
    ("dell-g2724d", "dell", "Dell G2724D", [], ["g2724d"], [DELL.format("dell-27-gaming-monitor-g2724d/apd/210-bhxc")], DELL_PIC),
    ("msi-mag-271qpx", "msi", "MSI MAG 271QPX QD-OLED", [], ["271qpx", "mag271qpx"], ["msi.com/Monitor/MAG-271QPX-QD-OLED", "msi.com/Monitor/MAG-271QPX-QD-OLED-E2/Gallery"], MSI_PIC),
    ("msi-mpg-321urx", "msi", "MSI MPG 321URX QD-OLED", [], ["321urx", "mpg321urx"], ["msi.com/Monitor/MPG-321URX-QD-OLED/Gallery", "msi.com/Monitor/MPG-321URX-QD-OLED"], MSI_PIC),
    ("msi-mag-274qrf", "msi", "MSI MAG 274QRF-QD", [], ["274qrf", "mag274qrf"], ["msi.com/Monitor/MAG-274QRF-QD-E2/Gallery"], MSI_PIC),
    ("gigabyte-m27q", "gigabyte", "Gigabyte M27Q", [], ["m27q"], ["gigabyte.com/Monitor/M27Q-rev-10/gallery", "gigabyte.com/Monitor/M27Q"], GB_PIC),
    ("gigabyte-fo27q3", "gigabyte", "Gigabyte AORUS FO27Q3", [], ["fo27q3", "aorus fo27q3"], ["gigabyte.com/Monitor/AORUS-FO27Q3/gallery", "gigabyte.com/Monitor/AORUS-FO27Q3"], GB_PIC),
    ("microsoft-lifecam-studio", "microsoft", "Microsoft LifeCam Studio", ["045e:0772"], ["lifecam studio", "microsoft lifecam studio"],
     MS_PAGES, ms_pic("ic_lcstv2")),
    ("microsoft-lifecam-hd-3000", "microsoft", "Microsoft LifeCam HD-3000", [], ["lifecam hd 3000", "microsoft lifecam hd 3000"],
     MS_PAGES[::-1], ms_pic("ic_hd3000")),
]
WEBCAMS = {"microsoft-lifecam-studio", "microsoft-lifecam-hd-3000"}


def page_pictures(page, rx, fmt):
    """(address, snapshot) for every picture the archived page links, newest snapshot first, one per picture."""
    out, names = [], set()
    for ts, orig in sorted(snapshots(page), reverse=True)[:3]:
        try:
            t = wb_fetch(f"https://web.archive.org/web/{ts}id_/{orig}", gap=3).replace("\\u002F", "/").replace("&amp;", "&")
        except Exception as e:
            print("  snapshot failed:", ts, orig[:60], str(e)[:30], file=sys.stderr)
            continue
        for u in URL.findall(t):
            m = re.search(rx, u, re.I)
            if not m:
                continue
            u = ("https:" + u) if u.startswith("//") else u
            name = m.group(1) if fmt else m.group(0).rsplit("/", 1)[-1]
            if name in names:
                continue
            names.add(name)
            out.append((fmt.format(m.group(1)) if fmt else u, ts))
    return out


# Each model's list is kept once made, so the review sheets, the picks and build2.py always see the same list (the
# archive's snapshots and the makers' servers can change between runs).
URLS_FILE = ROOT / "tools" / "displayswb-urls.json"


def candidates(only=None):
    kept = json.load(open(URLS_FILE)) if URLS_FILE.exists() else {}
    out = []
    for key, vendor, name, usb, names, pages, (rx, fmt) in ROWS:
        if only and key not in only:
            continue
        urls = kept.get(key) or []
        if not urls:
            pics = []
            for p in pages:
                pics += [x for x in page_pictures(p, rx, fmt) if x[0] not in [y[0] for y in pics]]
            # The maker's server when it still answers; else the archive's copy, which the review sheet fetches (a copy
            # the archive never kept shows as a failed tile).
            for u, ts in pics[:12]:
                urls.append(u if live_ok(u) else f"wb:{ts}:{u}")
            if urls:
                kept[key] = urls
                URLS_FILE.parent.mkdir(exist_ok=True)
                json.dump(kept, open(URLS_FILE, "w"), indent=1)
        if not urls:
            print("  no pictures:", key, file=sys.stderr)
        out.append(dict(key=key, vendor=vendor, name=name, kind="webcam" if key in WEBCAMS else "monitor", ids=usb, page="https://www." + pages[0].rstrip("*"),
                        names=[name] + names, note="web.archive.org snapshot of " + pages[0].rstrip("*")[:70], urls=urls))
    return out


def jobs():
    picks_f = ROOT / "picks" / "displayswb.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates(only={k for k, v in picks.items() if v is not None}):
        sel = picks.get(c["key"])
        if sel is None or sel >= len(c["urls"]):
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
