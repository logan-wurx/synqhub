"""Monitors and webcams: official product pictures from the makers' own sites. Monitors are found by the name their
EDID gives (no USB ids), with the maker the EDID's manufacturer code names; webcams by their USB ids where those are
certain, else by the name the camera reports. Same steps as headsets.py: cands2.py displays, picks in
picks/displays.json, build2.py displays.

Sources: asus.com and rog.asus.com galleries, lg.com, samsung.com, zowie.benq.com, aoc.com, logitech.com and
logitechg.com, razer.com, elgato.com, obsbot.com, insta360.com, anker.com. Several image servers give pictures without
a file extension (ROG's "gain" ids, LG's transform paths, BenQ's and Samsung's Scene7 names, Elgato's Cloudinary
paths), so those rows read the picture ids off the page ("ids" sources) and build the address from them."""
import json, re, sys
from common import ROOT, job
from vendors.pads import grab, html, shop


def i(vid, *pids):
    return [f"{vid}:{p:04x}" for p in pids]


LT = "https://www.logitech.com/en-us/shop/p/"
ROG = "https://rog.asus.com/us/monitors/27-to-31-5-inches/{}/gallery/"
TUF = "https://www.asus.com/displays-desktops/monitors/tuf-gaming/{}/"
LG = "https://www.lg.com/us/monitors/{}"
SAM = "https://www.samsung.com/us/{}"
ZW = "https://zowie.benq.com/en-au/monitor/{}.html"
AOC = "https://us.aoc.com/en-US/gaming/products/monitors/{}"
ELG = "https://www.elgato.com/us/en/p/{}"
RZ = "https://www.razer.com/streaming-cameras/{}"

# Picture ids read off a page, and the address each one is served at.
GAIN = (r"dlcdnwebimgs\.asus\.com/gain/([0-9A-F\-]{36})", "https://dlcdnwebimgs.asus.com/gain/{}/w2000")
LGT = (r"media\.us\.lg\.com/transform/ecomm-PDPGallery-1100x730/([0-9a-f\-]{36}/[^\"'\s?<>]+)", "https://media.us.lg.com/transform/ecomm-PDPGallery-1100x730/{}")
BENQ = "https://image.benq.com/is/image/benqco/{}?fmt=png-alpha&wid=1600"
SANITY = (r"cdn\.sanity\.io/images/hf5b3axp/production/([0-9a-f]{40}-\d+x\d+\.(?:png|jpg|webp))", "https://cdn.sanity.io/images/hf5b3axp/production/{}?w=1600&fit=max")
AOC_SQUARE = (SANITY[0].replace(r"\d+x\d+", "3840x3840"), SANITY[1])
CLOUD = "https://res.cloudinary.com/elgato-pwa/image/upload/q_auto/{}"
PNX = "https://assets2.razerzone.com/images/pnx.assets/{}"


def sam(sku, preset="PD_GALLERY_PNG"):
    """Samsung's gallery pictures; the PNG preset is cut out already, except on a few models where it keeps a white
    ground (those take the JPEG preset and go through rembg like any other photo)."""
    return (r"images\.samsung\.com/is/image/samsung/(p6pim/us/" + sku + r"/gallery/[a-z0-9\-]+)", "https://images.samsung.com/is/image/samsung/{}?$" + preset + "$")


def benq(model):
    return (r"image\.benq\.com/is/image/benqco/([A-Za-z0-9_\-\.]*" + model + r"[A-Za-z0-9_\-\.]*)", BENQ)


def elgato(path):
    return (r"elgato-pwa/image/upload/(?:[^/\"'\s]+/)*?v\d+/(Products/" + path + r"[^\"'\s?)]*\.(?:jpg|png))", CLOUD)


def pnx(word):
    return (r"pnx\.assets/([0-9a-f]{32}/(?:" + word + r")[A-Za-z0-9_\-]*\.(?:webp|jpg|png))", PNX)


# (key, vendor, display name, USB ids, other names, sources). Sources: ("grab", page, pattern), ("ids", page, (regex, address)),
# ("shop", domain, handle).
ROWS = [
    ("asus-vg248qe", "asus", "ASUS VG248", [], ["vg248", "asus vg248", "vg248qe", "asus vg248qe", "tuf gaming vg248qe"],
     [("grab", "https://www.asus.com/displays-desktops/monitors/tuf-gaming/vg248qe/", r"media/global/gallery/")]),
    ("logitech-c920", "logitech", "Logitech C920 HD Pro Webcam", i("046d", 0x082D), ["c920", "c920 hd pro webcam", "logitech c920", "hd pro webcam c920", "c920s"],
     [("grab", LT + "c920s-pro-hd-webcam.960-001257", r"c920s-gallery")]),
    ("logitech-c922", "logitech", "Logitech C922 Pro Stream Webcam", i("046d", 0x085C), ["c922", "c922 pro stream webcam", "logitech c922"],
     [("grab", "https://www.logitechg.com/en-us/products/streaming-gear/c922-pro-stream-webcam.960-001087.html", r"c922-gallery")]),
    ("logitech-brio", "logitech", "Logitech BRIO", i("046d", 0x085E), ["brio", "logitech brio", "brio 4k", "logitech brio 4k"],
     [("grab", LT + "brio-4k-hdr-webcam", r"brio/gallery/brio-gallery")]),
    # Monitor and webcam wave 2. ASUS ROG and TUF: the model is the EDID name ("PG27AQDM", "VG27AQ").
    ("asus-pg27aqdm", "asus", "ASUS ROG Swift OLED PG27AQDM", [], ["pg27aqdm"], [("ids", ROG.format("rog-swift-oled-pg27aqdm"), GAIN)]),
    ("asus-pg32ucdm", "asus", "ASUS ROG Swift OLED PG32UCDM", [], ["pg32ucdm"], [("ids", ROG.format("rog-swift-oled-pg32ucdm"), GAIN)]),
    ("asus-pg27aqn", "asus", "ASUS ROG Swift 360Hz PG27AQN", [], ["pg27aqn"], [("ids", ROG.format("rog-swift-360hz-pg27aqn-model"), GAIN)]),
    ("asus-xg27aqm", "asus", "ASUS ROG Strix XG27AQM", [], ["xg27aqm"], [("ids", ROG.format("rog-strix-xg27aqm-model"), GAIN)]),
    ("asus-vg27aq", "asus", "ASUS TUF Gaming VG27AQ", [], ["vg27aq"], [("grab", TUF.format("tuf-gaming-vg27aq"), r"media/global/gallery/.*_2000")]),
    ("asus-vg259qm", "asus", "ASUS TUF Gaming VG259QM", [], ["vg259qm"], [("grab", TUF.format("tuf-gaming-vg259qm"), r"media/global/gallery/.*_2000")]),
    ("asus-vg279qm", "asus", "ASUS TUF Gaming VG279QM", [], ["vg279qm"], [("grab", TUF.format("tuf-gaming-vg279qm"), r"media/global/gallery/.*_2000")]),
    # LG UltraGear: the EDID carries the model ("27GR95QE"); a monitor whose EDID says only "LG ULTRAGEAR" stays drawn.
    ("lg-27gr95qe", "lg", "LG UltraGear 27GR95QE", [], ["27gr95qe"],
     [("grab", LG.format("lg-27gr95qe-b-gaming-monitor"), r"lg\.com/us/images/monitors/.*/gallery/"), ("ids", LG.format("lg-27gr95qe-b-gaming-monitor"), LGT)]),
    ("lg-27gp850", "lg", "LG UltraGear 27GP850", [], ["27gp850"], [("ids", LG.format("lg-27gp850-b-gaming-monitor"), LGT)]),
    ("lg-32gs95ue", "lg", "LG UltraGear 32GS95UE", [], ["32gs95ue"], [("ids", LG.format("lg-32gs95ue-b-gaming-monitor"), LGT)]),
    ("lg-27gs95qe", "lg", "LG UltraGear 27GS95QE", [], ["27gs95qe"], [("ids", LG.format("lg-27gs95qe-b-gaming-monitor"), LGT)]),
    # Samsung Odyssey: by the model code in the EDID name ("Odyssey G85SD"); one picture per shell, so the code, not "G8".
    ("samsung-odyssey-oled-g9", "samsung", "Samsung Odyssey OLED G9", [], ["odyssey oled g9", "g95sd", "g93sd", "g91sd", "g95sc", "g93sc"],
     [("ids", SAM.format("monitors/gaming/49-inch-odyssey-oled-g9-g95sd-dual-qhd-240hz-03ms-g-sync-sku-ls49dg956snxgo"), sam("ls49dg956snxgo"))]),
    ("samsung-odyssey-oled-g8", "samsung", "Samsung Odyssey OLED G8 (34\")", [], ["g85sd", "g85sb"],
     [("ids", SAM.format("monitors/gaming/34-inch-odyssey-oled-g8-g85sd-ultra-wqhd-175hz-03ms-g-sync-sku-ls34dg856snxza"), sam("ls34dg856snxza"))]),
    ("samsung-odyssey-oled-g8-27", "samsung", "Samsung Odyssey OLED G8 (27\")", [], ["g81sf"],
     [("ids", SAM.format("monitors/gaming/27-inch-odyssey-oled-g8-g81sf-4k-240hz-gaming-monitor-sku-ls27fg810snxza"), sam("ls27fg810snxza"))]),
    ("samsung-odyssey-g9", "samsung", "Samsung Odyssey G9 (G95C)", [], ["g95c"],
     [("ids", SAM.format("monitors/gaming/49-inch-odyssey-g9-dqhd-240hz-1ms-gtg-displayhdr-1000-gaming-monitor-sku-ls49cg954enxza"), sam("ls49cg954enxza", "PD_GALLERY_JPG"))]),
    ("samsung-odyssey-neo-g9-57", "samsung", "Samsung Odyssey Neo G9 (57\")", [], ["g95nc"],
     [("ids", SAM.format("monitors/gaming/57-inch-odyssey-neo-g9-dual-4k-uhd-quantum-mini-led-240hz-1ms-hdr-1000-curved-gaming-monitor-sku-ls57cg952nnxza"), sam("ls57cg952nnxza", "PD_GALLERY_JPG"))]),
    ("samsung-odyssey-neo-g8", "samsung", "Samsung Odyssey Neo G8", [], ["odyssey neo g8", "g85nb"],
     [("ids", SAM.format("computing/monitors/gaming/32-odyssey-neo-g8-4k-uhd-240hz-1ms-curved-gaming-monitor-ls32bg852nnxgo/"), sam("ls32bg852nnxgo"))]),
    ("samsung-odyssey-neo-g7", "samsung", "Samsung Odyssey Neo G7 (32\")", [], ["g75nb"],
     [("ids", SAM.format("computing/monitors/gaming/32-odyssey-neo-g7-4k-uhd-165hz-1ms-curved-gaming-monitor-ls32bg752nnxgo/"), sam("ls32bg752nnxgo"))]),
    ("samsung-odyssey-g7-g70d", "samsung", "Samsung Odyssey G7 (G70D)", [], ["g70d"],
     [("ids", SAM.format("monitors/gaming/27-inch-odyssey-g7-g70d-4k-uhd-ips-144hz-1ms-gtg-smart-gaming-monitor-sku-ls27dg702enxza"), sam("ls27dg702enxza", "PD_GALLERY_JPG"))]),
    # BenQ ZOWIE: the XL2546K and XL2566K share one shell, and most XL EDIDs say only "ZOWIE XL LCD", so that name gets the family picture.
    ("benq-xl2546k", "benq", "ZOWIE XL2546K", [], ["xl2546k", "xl2566k", "zowie xl lcd", "zowie xl2546k", "zowie xl2566k"],
     [("ids", ZW.format("xl2546k"), benq("xl2546k"))]),
    ("benq-xl2540k", "benq", "ZOWIE XL2540K", [], ["xl2540k", "zowie xl2540k"], [("ids", ZW.format("xl2540k"), benq("xl2540k"))]),
    ("benq-xl2586x", "benq", "ZOWIE XL2586X", [], ["xl2586x", "zowie xl2586x"], [("ids", ZW.format("xl2586x"), benq("xl2586x"))]),
    # AOC: EDID names carry the panel suffix ("24G2W1G4"). The US 24G2 page is a listing; the 24G2U (the same shell with a USB hub) has its own.
    ("aoc-24g2", "aoc", "AOC 24G2", [], ["24g2", "24g2u", "24g2w1g4", "24g2u5"], [("ids", "https://eu.aoc.com/en/gaming/products/monitors/24g2u-bk", AOC_SQUARE)]),
    ("aoc-27g2", "aoc", "AOC 27G2", [], ["27g2", "27g2u", "27g2g4", "27g2wg4"], [("ids", AOC.format("27g2"), SANITY)]),
    ("aoc-ag276qzd", "aoc", "AOC AGON PRO AG276QZD", [], ["ag276qzd"], [("ids", "https://www.aoc.com/us/gaming/products/monitors/ag276qzd", SANITY)]),
    # Webcams. Logitech: USB ids from Logitech's own driver lists where certain, names otherwise.
    ("logitech-mx-brio", "logitech", "Logitech MX Brio", [], ["mx brio", "logitech mx brio", "mx brio 705"], [("grab", LT + "mx-brio-4k-webcam", r"mx-brio/.*gallery")]),
    ("logitech-streamcam", "logitech", "Logitech StreamCam", i("046d", 0x0893), ["streamcam", "logitech streamcam"], [("grab", LT + "streamcam", r"streamcam/gallery/")]),
    ("logitech-c270", "logitech", "Logitech C270 HD Webcam", i("046d", 0x0825), ["c270", "c270 hd webcam"], [("grab", LT + "c270-hd-webcam", r"/gallery/")]),
    ("logitech-c310", "logitech", "Logitech C310 HD Webcam", i("046d", 0x081B), ["c310", "c310 hd webcam"], [("grab", LT + "c310-hd-webcam", r"/gallery/")]),
    ("logitech-c615", "logitech", "Logitech C615 HD Webcam", i("046d", 0x082C), ["c615", "c615 hd webcam"], [("grab", LT + "c615-webcam", r"/gallery/")]),
    ("logitech-c925e", "logitech", "Logitech C925e", i("046d", 0x085B), ["c925e", "c925e webcam"], [("grab", LT + "c925e-business-webcam", r"/gallery/")]),
    ("logitech-brio-500", "logitech", "Logitech Brio 500", [], ["brio 500", "brio 501", "brio 505", "logitech brio 500", "logitech brio 505"],
     [("grab", LT + "brio-500-webcam", r"brio-500/gallery/"), ("grab", LT + "brio-505-webcam", r"brio-505/gallery/")]),
    # Razer: the Kiyo X has a store page with its gallery; the others only their product pages' renders.
    ("razer-kiyo", "razer", "Razer Kiyo", i("1532", 0x0E03), ["kiyo", "razer kiyo"], [("ids", RZ.format("razer-kiyo"), pnx("kiyo|img-"))]),
    ("razer-kiyo-pro", "razer", "Razer Kiyo Pro", i("1532", 0x0E05), ["kiyo pro", "razer kiyo pro"], [("ids", RZ.format("razer-kiyo-pro"), pnx("kiyo-pro|img-"))]),
    ("razer-kiyo-x", "razer", "Razer Kiyo X", [], ["kiyo x", "razer kiyo x"], [("grab", RZ.format("razer-kiyo-x/RZ19-04170100-R3U1"), r"medias-p1\.phoenix\.razer\.com/.*kiyo-x")]),
    ("razer-kiyo-pro-ultra", "razer", "Razer Kiyo Pro Ultra", [], ["kiyo pro ultra", "razer kiyo pro ultra"],
     [("ids", RZ.format("razer-kiyo-pro-ultra"), pnx("razer-kiyo-pro-ultra|u1-|u7-|u9-"))]),
    # Elgato
    ("elgato-facecam", "elgato", "Elgato Facecam", [], ["facecam", "elgato facecam"], [("ids", ELG.format("facecam"), elgato("10WAA9901/"))]),
    ("elgato-facecam-mk2", "elgato", "Elgato Facecam MK.2", [], ["facecam mk 2", "facecam mk2", "elgato facecam mk 2", "elgato facecam mk2"], [("ids", ELG.format("facecam-mk2"), elgato("10WAC9901/"))]),
    ("elgato-facecam-pro", "elgato", "Elgato Facecam Pro", [], ["facecam pro", "elgato facecam pro"], [("ids", ELG.format("facecam-pro"), elgato("10WAB9901/"))]),
    ("elgato-facecam-neo", "elgato", "Elgato Facecam Neo", [], ["facecam neo", "elgato facecam neo"], [("ids", ELG.format("facecam-neo"), elgato("10WAE9901/"))]),
    # OBSBOT, Insta360, Anker
    ("obsbot-tiny-2", "obsbot", "OBSBOT Tiny 2", [], ["obsbot tiny 2", "tiny 2"], [("grab", "https://www.obsbot.com/obsbot-tiny-2-4k-webcam", r"resource-media\.obsbothk\.com/image/default/")]),
    ("obsbot-meet-2", "obsbot", "OBSBOT Meet 2", [], ["obsbot meet 2", "meet 2"], [("grab", "https://www.obsbot.com/obsbot-meet-2-4k-webcam", r"resource-media\.obsbothk\.com/image/default/")]),
    ("insta360-link", "insta360", "Insta360 Link", [], ["insta360 link"], [("grab", "https://www.insta360.com/product/insta360-link", r"res\.insta360\.com/static/[0-9a-f]+/link")]),
    ("insta360-link-2", "insta360", "Insta360 Link 2", [], ["insta360 link 2"], [("grab", "https://www.insta360.com/product/insta360-link2", r"insta360\.com/.*(?:KV_@2560|l2s-white|link2\.png)")]),
    ("anker-powerconf-c200", "anker", "Anker PowerConf C200", [], ["powerconf c200", "anker powerconf c200", "ankerwork c200"],
     [("grab", "https://www.anker.com/de/products/a3369", r"cdn\.shopify\.com/s/files/1/1054/")]),
]

MONITORS = {"asus-vg248qe"} | {r[0] for r in ROWS if r[0].split("-")[0] in ("lg", "samsung", "benq", "aoc") or r[0] in
                                ("asus-pg27aqdm", "asus-pg32ucdm", "asus-pg27aqn", "asus-xg27aqm", "asus-vg27aq", "asus-vg259qm", "asus-vg279qm")}


def ids(url, rx, fmt):
    """Picture ids on the page, in page order without duplicates, each turned into the address that serves it."""
    out = []
    for m in re.findall(rx, html(url), re.I):
        u = fmt.format(m)
        if u not in out:
            out.append(u)
    return out


def urls_of(sources):
    out = []
    for s in sources:
        got = grab(s[1], s[2]) if s[0] == "grab" else ids(s[1], *s[2]) if s[0] == "ids" else shop(s[1], s[2]) if s[0] == "shop" else [s[1]]
        out += [u for u in got if u not in out]
    return out


def candidates(only=None):
    out = []
    for key, vendor, name, usb, names, sources in ROWS:
        if only and key not in only:
            continue
        urls = urls_of(sources)
        if not urls:
            print("  no pictures:", key, file=sys.stderr)
        out.append(dict(key=key, vendor=vendor, name=name, kind="monitor" if key in MONITORS else "webcam", ids=usb, page=sources[0][1], names=[name] + names,
                        note="maker's own site", urls=urls[:16]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "displays.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates(only=set(picks)):
        sel = picks.get(c["key"])
        if sel is None or sel >= len(c["urls"]):
            continue
        out.append(job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})"))
    return out
