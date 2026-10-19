"""Monitors and webcams, final pass: more of the popular models, the same makers' sources as displays.py (rog.asus.com and
asus.com galleries, lg.com, BenQ's image server, AOC's Sanity CDN, logitech.com, obsbot.com, avermedia.com, creative.com)
and msi.com as the Wayback Machine kept it (msi.com answers 403 to the pipeline). Monitors are found by the model in
their EDID name and the maker; webcams by the name the camera reports. Steps: cands2.py displays3, picks/displays3.json,
pin_picks.py displays3, build2.py displays3, assemble2.py."""
from rows import R, make
from vendors.displays import GAIN, LGT, SANITY, benq

ROG = "https://rog.asus.com/us/monitors/"
TUF = "https://www.asus.com/displays-desktops/monitors/tuf-gaming/"
LG = "https://www.lg.com/us/monitors/"
AOC = "https://us.aoc.com/en-US/gaming/products/monitors/"
LOGI = "https://www.logitech.com/en-us/products/webcams/"
MSI_PIC = r"asset\.msi\.com/resize/image/global/product/product_[0-9a-f]+\.png[0-9a-f]+/\d+\.png"
OBSBOT_PIC = r"resource-media\.obsbothk\.com/image/default/"


def mon(key, vendor, name, names, sources, **opts):
    return R(key, vendor, name, "monitor", sources, names=names, **opts)


def cam(key, vendor, name, names, sources, **opts):
    return R(key, vendor, name, "webcam", sources, names=names, **opts)


ROWS = [
    # ASUS ROG Swift / Strix and TUF Gaming
    mon("asus-pg259qn", "asus", "ASUS ROG Swift 360Hz PG259QN", ["pg259qn"], [("ids", ROG + "23-to-24-5-inches/rog-swift-360hz-pg259qn-model/gallery/", GAIN)]),
    mon("asus-xg27acs", "asus", "ASUS ROG Strix XG27ACS", ["xg27acs"], [("ids", ROG + "27-to-31-5-inches/rog-strix-xg27acs/gallery/", GAIN)]),
    mon("asus-pg34wcdm", "asus", "ASUS ROG Swift OLED PG34WCDM", ["pg34wcdm"], [("ids", ROG + "32-to-34-inches/rog-swift-oled-pg34wcdm/gallery/", GAIN)]),
    mon("asus-xg27ucs", "asus", "ASUS ROG Strix XG27UCS", ["xg27ucs"], [("ids", ROG + "27-to-31-5-inches/rog-strix-xg27ucs/gallery/", GAIN)]),
    mon("asus-pg27ucdm", "asus", "ASUS ROG Swift OLED PG27UCDM", ["pg27ucdm"], [("ids", ROG + "27-to-31-5-inches/rog-swift-oled-pg27ucdm/gallery/", GAIN)]),
    mon("asus-vg27aq1a", "asus", "ASUS TUF Gaming VG27AQ1A", ["vg27aq1a"], [("ids", TUF + "tuf-gaming-vg27aq1a/", GAIN)]),
    mon("asus-vg249q1a", "asus", "ASUS TUF Gaming VG249Q1A", ["vg249q1a"], [("ids", TUF + "tuf-gaming-vg249q1a/", GAIN)]),
    # LG UltraGear
    # Flat white ground: the flood fill keeps the white logo on the screen, which the matting model reads as ground.
    *[mon(f"lg-{m}", "lg", f"LG UltraGear {m.upper()}", [m], [("ids", LG + f"lg-{m}-b-gaming-monitor", LGT)], flood=True)
      for m in ("27gl850", "27gn800", "27gp950", "34gp83a", "24gn600", "27gn950", "45gr95qe", "27gr75q")],
    # BenQ ZOWIE and MOBIUZ
    mon("benq-xl2411k", "benq", "ZOWIE XL2411K", ["xl2411k", "zowie xl2411k"], [("ids", "https://zowie.benq.com/en-us/monitor/xl2411k.html", benq("xl2411k"))]),
    mon("benq-xl2546x", "benq", "ZOWIE XL2546X", ["xl2546x", "zowie xl2546x", "xl2546x plus"], [("ids", "https://zowie.benq.com/en-us/monitor/xl2546x.html", benq("xl2546x"))]),
    mon("benq-ex2710q", "benq", "BenQ MOBIUZ EX2710Q", ["ex2710q", "mobiuz ex2710q"], [("ids", "https://www.benq.com/en-us/monitor/gaming/ex2710q.html", benq("ex2710q"))]),
    mon("benq-ex270qm", "benq", "BenQ MOBIUZ EX270QM", ["ex270qm", "mobiuz ex270qm"], [("ids", "https://www.benq.com/en-us/monitor/gaming/ex270qm.html", benq("ex270qm"))]),
    # AOC
    *[mon(f"aoc-{m}", "aoc", f"AOC {m.upper()}", [m], [("ids", AOC + m, SANITY)]) for m in ("q27g2s", "c24g1", "24g2sp", "q27g3xmn", "cu34g2x")],
    # MSI (msi.com as the Wayback Machine kept it)
    mon("msi-mpg-271qrx", "msi", "MSI MPG 271QRX QD-OLED", ["271qrx", "mpg271qrx"], [("wbgrab", "msi.com/Monitor/MPG-271QRX-QD-OLED", MSI_PIC)],
        note="msi.com product page as the Wayback Machine kept it"),
    mon("msi-g274qpf", "msi", "MSI G274QPF", ["g274qpf", "g274qpf qd", "g274qpf e2"], [("wbgrab", "msi.com/Monitor/G274QPF-QD", MSI_PIC), ("wbgrab", "msi.com/Monitor/G274QPF", MSI_PIC)],
        note="msi.com product page as the Wayback Machine kept it"),
    mon("msi-mag-274upf", "msi", "MSI MAG 274UPF", ["274upf", "mag274upf"], [("wbgrab", "msi.com/Monitor/MAG-274UPF", MSI_PIC)], note="msi.com product page as the Wayback Machine kept it"),
    # Webcams
    cam("logitech-c920e", "logitech", "Logitech C920e", ["c920e", "logitech c920e", "webcam c920e"], [("grab", LOGI + "c920e-business-webcam.960-001360.html", r"/gallery/")]),
    cam("logitech-c930e", "logitech", "Logitech C930e", ["c930e", "logitech c930e", "webcam c930e"], [("grab", LOGI + "c930e-business-webcam.960-000971.html", r"/gallery/")]),
    cam("logitech-c505", "logitech", "Logitech C505", ["c505", "logitech c505", "webcam c505", "c505e"], [("grab", LOGI + "c505-hd-webcam.960-001363.html", r"/gallery/")]),
    cam("logitech-brio-300", "logitech", "Logitech Brio 300", ["brio 300", "logitech brio 300", "brio 301", "brio 305"], [("grab", LOGI + "brio-300-webcam.960-001413.html", r"/gallery/")]),
    cam("logitech-brio-100", "logitech", "Logitech Brio 100", ["brio 100", "logitech brio 100", "brio 101", "brio 105"], [("grab", LOGI + "brio-100-webcam.960-001616.html", r"/gallery/")]),
    cam("obsbot-tiny-2-lite", "obsbot", "OBSBOT Tiny 2 Lite", ["obsbot tiny 2 lite", "tiny 2 lite"], [("grab", "https://www.obsbot.com/obsbot-tiny-2-lite-4k-webcam", OBSBOT_PIC)]),
    cam("obsbot-tiny-4k", "obsbot", "OBSBOT Tiny 4K", ["obsbot tiny 4k", "tiny 4k"], [("grab", "https://www.obsbot.com/obsbot-tiny-4k-webcam", OBSBOT_PIC)]),
    cam("avermedia-pw313", "avermedia", "AVerMedia Live Streamer CAM 313", ["live streamer cam 313", "pw313", "avermedia pw313"],
        [("og", "https://www.avermedia.com/us/product-detail/PW313"), ("grab", "https://www.avermedia.com/us/product-detail/PW313", r"avermedia\.com/.*(PW313|pw313)")]),
    cam("creative-live-cam-sync-1080p", "creative", "Creative Live! Cam Sync 1080p", ["live cam sync 1080p", "creative live cam sync 1080p"],
        [("og", "https://us.creative.com/p/web-cameras/creative-live-cam-sync-1080p"), ("grab", "https://us.creative.com/p/web-cameras/creative-live-cam-sync-1080p", r"img\.creative\.com/images/products/")]),
]

candidates, jobs = make("displays3", ROWS)
