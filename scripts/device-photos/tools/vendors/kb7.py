"""Keyboards and mice, final pass: the Sonix / FCC white-label boards whose maker could be named (EWEADN's own store, live
or as the Wayback Machine kept it, for the Battle68, Smart875, Tank68 and ZAP68; Onikuma's store for the G67; Womier's
store for the M68 HE), and the OpenMouse-list mice whose maker's page could be found (Zaunkoenig's archived store).
The Sonix boards report only their model name over 0C45 (Sonix's vendor id, shared by hundreds of boards), so their
pictures sit in the `sonix` folder and are found by that name. Steps: cands2.py kb7, picks/kb7.json, pin_picks.py kb7,
build2.py kb7, assemble2.py."""
from rows import R, make

EW = "https://eweadn.com/products/"
EW_ARCH = "eweadn.com/products/"
SHOP = r"cdn\.shopify\.com/s/files/"

ROWS = [
    R("sonix-eweadn-battle68", "sonix", "EWEADN Battle68 Pro", "keyboard",
      [("wbgrab", EW_ARCH + "eweadn-battle68-he-magnetic-switch-keyboard", SHOP), ("wbgrab", EW_ARCH + "eweadn-battle68", SHOP)],
      names=["battle68pro", "battle68 pro", "eweadn battle68", "eweadn battle68 pro"], note="eweadn.com (EWEADN's own store) as the Wayback Machine kept it"),
    R("sonix-eweadn-smart875", "sonix", "EWEADN Smart875 HE", "keyboard",
      [("wbgrab", EW_ARCH + "eweadn-smart875-aluminum-mechanical-keyboard", SHOP), ("wbgrab", EW_ARCH + "eweadn-smart875", SHOP)],
      names=["smart875e he", "smart875 he", "eweadn smart875"], note="eweadn.com (EWEADN's own store) as the Wayback Machine kept it"),
    R("sonix-eweadn-tank68", "sonix", "EWEADN Tank68 HE", "keyboard",
      [("wbgrab", EW_ARCH + "eweadn-tank68-aluminum-he-magnetic-switch-keyboard", SHOP), ("wbgrab", EW_ARCH + "eweadn-tank68", SHOP)],
      names=["tank68 he", "eweadn tank68", "eweadn tank68 he"], note="eweadn.com (EWEADN's own store) as the Wayback Machine kept it"),
    R("sonix-eweadn-zap68", "sonix", "EWEADN ZAP68 HE", "keyboard", [("shop", "eweadn.com", "eweadn-zap68-he-magnetic-switch-keyboard")],
      names=["zap68", "eweadn zap68", "zap68 he"], note="eweadn.com (EWEADN's own store)"),
    R("sonix-onikuma-g67", "sonix", "Onikuma G67", "keyboard",
      [("shop", "onikuma.com", "onikuma-g67-rapid-trigger-keyboard-60-percent-hall-effect-topographic-gaming-keyboard-wired-rgb-custom-mechanical-key-board-with-magnetic-switch")],
      names=["onikua keyboard g67", "onikuma keyboard g67", "onikuma g67"], note="onikuma.com (Onikuma's own store)"),
    R("sonix-womier-m68he", "sonix", "Womier M68 HE", "keyboard",
      [("shop", "womierkeyboard.com", "womier-m68-he"), ("wbgrab", "womierkeyboard.com/products/womier-m68-he", SHOP)],
      names=["m68he keyboard", "womier m68 he", "womier m68he"], note="womierkeyboard.com (Womier's own store)"),
    R("zaunkoenig-m2k", "zaunkoenig", "Zaunkoenig M2K", "mouse", [("wbgrab", "zaunkoenig.co/products/m2k", SHOP), ("wbgrab", "zaunkoenig.co/m2k", r"zaunkoenig|shopify")],
      ids=["0483:a3cf"], names=["m2k", "zaunkoenig m2k"], note="zaunkoenig.co (Zaunkoenig's own store) as the Wayback Machine kept it"),
]

candidates, jobs = make("kb7", ROWS)
