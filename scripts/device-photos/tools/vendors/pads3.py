"""Controllers, final pass: the SYNQ controller models still drawn and the popular named pads of the id table
(src/lib/controllers/ids.generated.ts). Sources: Microsoft's store renders (Adobe Dynamic Media, transparent), the
makers' Shopify stores (HORI Europe, HyperX, 8BitDo, Machenike), rog.asus.com galleries, and for discontinued pads the
makers' own pages as the Wayback Machine kept them (xbox.com, razer.com, scufgaming.com, store.google.com). Kind
`gamepad`; USB ids only where the id is the model's alone. Steps: cands2.py pads3, picks/pads3.json, pin_picks.py pads3,
build2.py pads3, assemble2.py."""
from rows import R, make

DM = "https://cdn-dynmedia-1.microsoft.com/is/image/microsoftcorp/{}?wid=1600&hei=1600&fmt=png-alpha"
GAIN = (r"dlcdnwebimgs\.asus\.com/gain/([0-9A-F\-]{36})", "https://dlcdnwebimgs.asus.com/gain/{}/w2000")


def i(vid, *pids):
    return [f"{vid}:{p:04x}" for p in pids]


ROWS = [
    R("microsoft-xbox-adaptive-controller", "microsoft", "Xbox Adaptive Controller", "gamepad",
      [("img", DM.format(f"gldn-Xbox-Z-BuyBoxImage-b0{n}")) for n in range(5)] + [("img", DM.format("Sneak-Peek-Carousel-Xbox-Adaptive-Controller-Top-View"))],
      ids=i("045e", 0x0b0a, 0x0b0c, 0x0b21), names=["xbox adaptive controller", "adaptive controller", "microsoft xbox adaptive controller"],
      page="https://www.microsoft.com/en-us/d/xbox-adaptive-controller/8NSDBHZ1N3D8", note="microsoft.com store (Microsoft's own renders)"),
    R("microsoft-xbox-elite-controller", "microsoft", "Xbox Elite Wireless Controller", "gamepad",
      [("wbgrab", "xbox.com/en-US/xbox-one/accessories/controllers/elite-wireless-controller", r"(?i)elite")],
      ids=i("045e", 0x02e3), names=["xbox elite controller", "xbox elite wireless controller", "elite controller"],
      note="xbox.com product page as the Wayback Machine kept it"),
    R("microsoft-xbox-360-controller", "microsoft", "Xbox 360 Controller", "gamepad",
      [("wbgrab", "xbox.com/en-US/xbox-360/accessories/controllers/wireless-controller", r"(?i)controller"),
       ("wbgrab", "xbox.com/en-US/xbox-360/accessories/controllers/WirelessController", r"(?i)controller")],
      names=["xbox 360 controller", "xbox 360 wireless controller", "microsoft xbox 360 controller", "xbox 360 controller for windows"],
      note="xbox.com product page as the Wayback Machine kept it"),
    R("hori-wireless-horipad-for-steam", "hori", "HORI Wireless HORIPAD for Steam", "gamepad",
      [("shop", "horieurope.com", "wireless-horipad-for-steam"), ("shop", "horieurope.com", "hpc-055")],
      ids=i("0f0d", 0x0196, 0x01ab), names=["wireless horipad for steam", "horipad for steam"], note="horieurope.com (HORI's own store)"),
    R("machenike-g5-pro", "machenike", "Machenike G5 Pro", "gamepad", [("shop", "global.machenike.com", "g5pro")],
      names=["machenike g5 pro", "g5 pro"], note="global.machenike.com (Machenike's own store)"),
    R("hyperx-clutch", "hyperx", "HyperX Clutch", "gamepad", [("wbgrab", "hyperx.com/products/hyperx-clutch-wireless-gaming-controller", r"cdn\.shopify\.com/s/files/.*(?i:clutch)")],
      ids=i("03f0", 0x038d, 0x048d), names=["hyperx clutch", "clutch wireless gaming controller"], note="hyperx.com product page as the Wayback Machine kept it"),
    R("asus-rog-raikiri-ii", "asus", "ASUS ROG Raikiri II", "gamepad",
      [("ids", "https://rog.asus.com/us/controllers/rog-raikiri-ii/", GAIN), ("ids", "https://rog.asus.com/us/controllers/rog-raikiri-ii/gallery/", GAIN)],
      ids=i("0b05", 0x1c91, 0x1c92, 0x1c96, 0x1d04), names=["rog raikiri ii", "asus rog raikiri ii", "raikiri ii"], note="rog.asus.com model page"),
    R("razer-raiju", "razer", "Razer Raiju", "gamepad", [("wbgrab", "razer.com/gaming-controllers/razer-raiju", r"(?i)raiju")],
      ids=i("1532", 0x1000), names=["razer raiju"], note="razer.com product page as the Wayback Machine kept it"),
    R("razer-raiju-tournament-edition", "razer", "Razer Raiju Tournament Edition", "gamepad",
      [("wbgrab", "razer.com/gaming-controllers/razer-raiju-tournament-edition", r"(?i)raiju")],
      ids=i("1532", 0x1007, 0x100a), names=["razer raiju tournament edition", "raiju tournament edition"], note="razer.com product page as the Wayback Machine kept it"),
    R("razer-raiju-ultimate", "razer", "Razer Raiju Ultimate", "gamepad", [("wbgrab", "razer.com/gaming-controllers/razer-raiju-ultimate", r"(?i)raiju")],
      ids=i("1532", 0x1004, 0x1009), names=["razer raiju ultimate", "raiju ultimate"], note="razer.com product page as the Wayback Machine kept it"),
    R("razer-wolverine-tournament-edition", "razer", "Razer Wolverine Tournament Edition", "gamepad",
      [("wbgrab", "razer.com/gaming-controllers/razer-wolverine-tournament-edition", r"(?i)wolverine")],
      ids=i("1532", 0x0a15), names=["razer wolverine tournament edition", "wolverine tournament edition"], note="razer.com product page as the Wayback Machine kept it"),
    R("scuf-instinct", "scuf", "SCUF Instinct", "gamepad", [("wbgrab", "scufgaming.com/instinct-pro-custom-controller", r"(?i)instinct"),
                                                         ("wbgrab", "scufgaming.com/scuf-instinct-pro-steel-gray", r"(?i)instinct")],
      names=["scuf instinct", "scuf instinct pro", "instinct pro"], note="scufgaming.com product page as the Wayback Machine kept it"),
    R("google-stadia-controller", "google", "Google Stadia Controller", "gamepad", [("wbgrab", "store.google.com/us/product/stadia_controller", r"googleusercontent|gstatic")],
      names=["stadia controller", "google stadia controller"], note="store.google.com product page as the Wayback Machine kept it"),
    R("8bitdo-sn30-pro", "8bitdo", "8BitDo SN30 Pro", "gamepad", [("retail", r"^8bitdo sn30 pro(?! ?\+)(?!.*(edition|limited))", ("shop.8bitdo.com",))],
      names=["8bitdo sn30 pro", "sn30 pro"], note="shop.8bitdo.com (8BitDo's own store)"),
]

candidates, jobs = make("pads3", ROWS)
