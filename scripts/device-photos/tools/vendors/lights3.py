"""Lights, final pass: the Govee models the earlier passes left drawn, found again through us.govee.com's own search (each
model's results name the product page that sells it, new or refurbished, and the gallery pictures named after the SKU);
the Wi-Fi lights' other product lines (Philips Hue on Signify's image server as transparent PNGs, Nanoleaf's and LIFX's own
Shopify stores, Elgato's pages, Yeelight's site); and the USB RGB hubs (NZXT's and Corsair's own product pages as the
Wayback Machine kept them, Corsair's and NZXT's image servers). Kind `light`. Steps: cands2.py lights3, picks/lights3.json,
build2.py lights3, assemble2.py."""
from rows import R, make

GOVEE = "https://us.govee.com/products/"
GF = r"cdn\.shopify\.com/s/files/1/0512/3489/8105/(?:files|products)/"
SIGNIFY = (r"assets\.signify\.com/is/image/Signify/([A-Za-z0-9_\-]+)", "https://www.assets.signify.com/is/image/Signify/{}?wid=1600&hei=1600&fmt=png-alpha")
HUE = "https://www.philips-hue.com/en-us/p/"
ELGATO = "https://www.elgato.com/us/en/p/"
ELGATO_PICS = r"res\.cloudinary\.com/elgato-pwa/image/upload/[^\"' ]*Products/[^\"' ]*\.(?:png|jpe?g|webp)"
CORSAIR_OLD = r"corsair\.com/medias/sys_master/images/"


def elgato_pics(folder):
    """Elgato's Cloudinary product pictures under Products/<folder> (their names have spaces, which the plain grab stops at)."""
    return (r"elgato-pwa/image/upload/(?:[^/\"'<>]+/)*?v\d+/(Products/(?:" + folder + r")[^\"'?<>]*?\.(?:png|jpg))", "https://res.cloudinary.com/elgato-pwa/image/upload/q_auto/{}")


def govee(sku, name, handle, sku_pics=True, also=(), **opts):
    """A Govee light: the product page's gallery (only pictures named after the SKU when the store names them so)."""
    pat = GF + (rf"[^/]*H?{sku[1:]}[^/]*\.(?:png|jpe?g|webp)" if sku_pics else r"[^/]+\.(?:png|jpe?g|webp)")
    return R(f"govee-{sku.lower()}", "govee", f"Govee {name} {sku}", "light", [("grab", GOVEE + handle, pat)],
             names=[f"govee {sku.lower()}", sku.lower(), *[f"govee {a.lower()}" for a in also], *[a.lower() for a in also]],
             note="us.govee.com (Govee's own store)", soft=opts.pop("soft", True), **opts)


def hue(key, name, names, page):
    return R(key, "philips-hue", name, "light", [("ids", HUE + page, SIGNIFY)], names=names, note="philips-hue.com (Signify's image server)")


ROWS = [
    # Govee: bulbs and recessed lights
    govee("H6006", "Smart A19 LED Bulb", "govee-smart-a19-led-light-bulbs", sku_pics=False),
    govee("H6009", "Smart RGBWW Bulb 1200 lm", "refurbished-govee-smart-rgbww-light-bulbs-1200-lumens", sku_pics=False, soft=False),
    # No pick: its only single-bulb shot is an infographic whose glow the cut cannot separate (the packs wear the box sleeve).
    govee("H6010", "BR30 Smart RGBWW Bulb", "govee-rgbww-smart-led-light-bulbs", soft=False),
    # No picks: the recessed lights are only shown with the box or the phone overlapping them (no crop separates them).
    govee("H601A", "6-Inch Smart RGBWW Recessed Light", "govee-smart-rgbww-recessed-lights-4-pack", sku_pics=False),
    govee("H601B", "4-Inch Smart Recessed Light", "govee-4-inch-smart-recessed-lighting", sku_pics=False),
    govee("H6057", "RGBIC Night Light", "refurbished-govee-rgbic-night-light", sku_pics=False, soft=False),
    govee("H605C", "Envisual TV Backlight T2", "govee-envisual-tv-backlight-t2"),
    govee("H6088", "Cube Wall Sconces", "govee-rgbic-cube-wall-sconces", sku_pics=False, soft=False),
    govee("H61E0", "LED Strip Light M1", "refurbished-govee-led-strip-light-m1", sku_pics=False),
    # outdoor: string, ground, pathway, permanent, flood, spot and curtain lights (one picture per light, its other lengths and packs share it)
    govee("H7020", "Outdoor String Lights", "refurbished-govee-rgbic-warm-white-wi-fi-bluetooth-smart-outdoor-string-lights", sku_pics=False, also=("H7021",)),
    govee("H7050", "Outdoor Ground Lights", "govee-rgbic-wi-fi-bluetooth-outdoor-ground-lights-99-99-for-3-items", sku_pics=False, also=("H7051",)),
    govee("H7055", "Outdoor Pathway Lights", "refurnished-govee-outdoor-pathway-lights", sku_pics=False),
    govee("H705A", "Permanent Outdoor Lights", "refurbished-govee-rgbic-led-permanent-outdoor-lights", sku_pics=False, also=("H705B", "H705C")),
    govee("H7060", "RGBICWW Smart Flood Lights", "refurbished-govee-rgbicww-led-smart-flood-lights", sku_pics=False, also=("H7061", "H7062")),
    govee("H7065", "Outdoor Spot Lights", "refurbished-govee-outdoor-spot-lights", sku_pics=False, also=("H7066",)),
    govee("H70B1", "Curtain Lights Pro", "refurbished-govee-curtain-lights-pro", sku_pics=False),
    # Philips Hue: a light behind the bridge reports its product name.
    hue("philips-hue-white-a19", "Philips Hue White A19", ["hue white lamp", "hue white a19"], "hue-white-75w-a19-e26-smart-bulb/046677591205"),
    hue("philips-hue-white-ambiance-a19", "Philips Hue White Ambiance A19", ["hue ambiance lamp", "hue white ambiance a19", "hue white ambiance lamp"], "hue-white-ambiance-a19-e26-smart-bulb-60-w/046677549602"),
    hue("philips-hue-filament-bulb", "Philips Hue White Filament Bulb", ["hue filament bulb", "hue white filament"], "hue-white-filament-st19-edison-e26-smart-bulb/046677571122"),
    hue("philips-hue-color-candle", "Philips Hue White and Color Ambiance Candle", ["hue color candle", "hue white and color ambiance candle"], "hue-white-and-color-ambiance-candle-e12-smart-bulb/046677556969"),
    hue("philips-hue-lightstrip-plus", "Philips Hue Lightstrip Plus", ["hue lightstrip plus", "hue lightstrip"], "hue-white-and-color-ambiance-lightstrip-plus-base-v4-80-inch/046677555313"),
    hue("philips-hue-play", "Philips Hue Play Light Bar", ["hue play", "hue play light bar"], "hue-white-and-color-ambiance-play-light-bar-single-pack/7820130U7"),
    hue("philips-hue-play-gradient-lightstrip", "Philips Hue Play Gradient Lightstrip", ["hue play gradient lightstrip"], "hue-white-and-color-ambiance-play-gradient-lightstrip-65-inch/046677560416"),
    hue("philips-hue-go", "Philips Hue Go", ["hue go", "hue go portable accent light"], "hue-white-and-color-ambiance-go-portable-accent-light/7602031U7"),
    hue("philips-hue-iris", "Philips Hue Iris", ["hue iris"], "hue-white-and-color-ambiance-iris-table-lamp/046677561796"),
    hue("philips-hue-bloom", "Philips Hue Bloom", ["hue bloom"], "hue-white-and-color-ambiance-bloom-table-lamp/046677560188"),
    hue("philips-hue-signe-gradient-floor", "Philips Hue Signe Gradient Floor Lamp", ["hue signe gradient floor", "hue signe gradient", "hue signe"], "hue-white-and-color-ambiance-signe-gradient-floor-lamp/046677803506"),
    # Nanoleaf: discovery reports the model number (NL22 Light Panels, NL29 Canvas, NL47 / NL48 Shapes Triangles / Mini Triangles, NL52 Elements).
    R("nanoleaf-canvas", "nanoleaf", "Nanoleaf Canvas", "light", [("wbgrab", "nanoleaf.me/en-US/products/nanoleaf-canvas/", r"cdn\.shopify\.com|nanoleaf\.me/.*(?:canvas|Canvas)")],
      names=["nanoleaf nl29", "nanoleaf canvas"], note="nanoleaf.me as the Wayback Machine kept it", soft=True),
    R("nanoleaf-light-panels", "nanoleaf", "Nanoleaf Light Panels (Aurora)", "light", [("wbgrab", "nanoleaf.me/en-US/products/nanoleaf-light-panels/", r"cdn\.shopify\.com|nanoleaf\.me/.*(?:light-panels|aurora|Aurora)")],
      names=["nanoleaf nl22", "nanoleaf light panels", "nanoleaf aurora"], note="nanoleaf.me as the Wayback Machine kept it", soft=True),
    R("nanoleaf-shapes-triangles", "nanoleaf", "Nanoleaf Shapes Triangles", "light", [("grab", "https://nanoleaf.me/en-US/products/nanoleaf-shapes/triangles/", r"cdn\.shopify\.com/s/files/.*(?:riangle)")],
      names=["nanoleaf nl47", "nanoleaf shapes triangles", "nanoleaf nl48", "nanoleaf shapes mini triangles"], soft=True),
    R("nanoleaf-elements", "nanoleaf", "Nanoleaf Elements Hexagons", "light", [("shop", "nanoleaf.me", "nanoleaf-elements"), ("shop", "nanoleaf.me", "nanoleaf-elements-starter-kits"),
                                                                             ("shop", "nanoleaf.me", "nanoleaf-elements-expansion-packs")],
      names=["nanoleaf nl52", "nanoleaf elements"], note="nanoleaf.me (Nanoleaf's own store)", soft=True),
    R("nanoleaf-essentials-bulb", "nanoleaf", "Nanoleaf Essentials Bulb", "light", [("wbgrab", "nanoleaf.me/en-US/products/nanoleaf-essentials/bulb/", r"cdn\.shopify\.com")],
      names=["nanoleaf nl45", "nanoleaf essentials bulb", "nanoleaf essentials"], note="nanoleaf.me as the Wayback Machine kept it"),
    R("nanoleaf-essentials-lightstrip", "nanoleaf", "Nanoleaf Essentials Lightstrip", "light", [("wbgrab", "nanoleaf.me/en-US/products/nanoleaf-essentials/lightstrip/", r"cdn\.shopify\.com")],
      names=["nanoleaf nl55", "nanoleaf essentials lightstrip"], note="nanoleaf.me as the Wayback Machine kept it", soft=True),
    # Elgato: the product name from the light itself.
    R("elgato-key-light-air", "elgato", "Elgato Key Light Air", "light", [("ids", ELGATO + "key-light-air", elgato_pics("10LAM9901"))], names=["elgato key light air"]),
    R("elgato-key-light-mini", "elgato", "Elgato Key Light Mini", "light", [("grab", ELGATO + "key-light-mini", ELGATO_PICS)], names=["elgato key light mini"]),
    R("elgato-key-light-neo", "elgato", "Elgato Key Light Neo", "light", [("ids", ELGATO + "key-light-neo", elgato_pics("10LAJ9911|Neo"))], names=["elgato key light neo"]),
    R("elgato-ring-light", "elgato", "Elgato Ring Light", "light", [("grab", ELGATO + "ring-light", ELGATO_PICS)], names=["elgato ring light"]),
    # LIFX: a LIFX light says only its brand ("LIFX light"), so its picture is LIFX's best-known light, the A19 bulb.
    R("lifx-color-a19", "lifx", "LIFX Color A19", "light", [("shop", "www.lifx.com", "lifx-color-a19-smart-light-homekit"), ("shopq", "www.lifx.com", r"^LIFX (Color|SuperColor) A19")],
      names=["lifx light", "lifx color", "lifx a19", "lifx"], note="lifx.com (LIFX's own store)"),
    # Yeelight: the model its discovery answer names ("color", "stripe", "mono", "ceiling", "bslamp", "lamp").
    R("yeelight-color-bulb", "yeelight", "Yeelight Smart LED Bulb (Color)", "light",
      [("wbgrab", "us.yeelight.com/products/yeelight-smart-led-bulb-1s-color", r"cdn\.shopify\.com"), ("wbgrab", "store.yeelight.com/products/yeelight-smart-led-bulb-1s-color", r"cdn\.shopify\.com")],
      names=["yeelight color", "yeelight color1", "yeelight color2", "yeelight color4", "yeelight colorc"], note="Yeelight's own store as the Wayback Machine kept it"),
    R("yeelight-lightstrip", "yeelight", "Yeelight Lightstrip", "light",
      [("wbgrab", "us.yeelight.com/products/yeelight-led-light-strip-1s-6-56ft", r"cdn\.shopify\.com"), ("wbgrab", "store.yeelight.com/products/yeelight-led-light-strip-1s-6-56ft", r"cdn\.shopify\.com")],
      names=["yeelight stripe", "yeelight strip1", "yeelight strip6", "yeelight lightstrip"], note="Yeelight's own store as the Wayback Machine kept it", soft=True),
    # RGB hubs, by USB id
    R("nzxt-rgb-and-fan-controller", "nzxt", "NZXT RGB & Fan Controller", "light",
      [("wbgrab", "nzxt.com/products/rgb-and-fan-controller", r"cdn\.shopify\.com|nzxt\.com/.*\.(?:png|jpe?g|webp)"), ("wbgrab", "www.nzxt.com/products/rgb-fan-controller", r"nzxt")],
      # The boxed 6-channel controller's ids; the 2-channel ones are boards inside NZXT cases, found by the shared name.
      ids=["1e71:2011", "1e71:2019", "1e71:201f", "1e71:2020"], names=["nzxt rgb and fan controller", "rgb and fan controller"],
      note="nzxt.com product page as the Wayback Machine kept it"),
    R("nzxt-hue-2", "nzxt", "NZXT HUE 2", "light", [("wbgrab", "www.nzxt.com/products/hue-2-rgb-lighting-kit", r"nzxt|shopify")],
      ids=["1e71:2001"], names=["nzxt hue 2", "hue 2 rgb lighting kit"], note="nzxt.com product page as the Wayback Machine kept it"),
    R("nzxt-hue-2-ambient", "nzxt", "NZXT HUE 2 Ambient", "light", [("wbgrab", "www.nzxt.com/products/hue-2-ambient-lighting-kit", r"nzxt|shopify"), ("wbgrab", "www.nzxt.com/products/hue-2-ambient-v2", r"nzxt|shopify")],
      ids=["1e71:2002"], names=["nzxt hue 2 ambient", "hue 2 ambient"], note="nzxt.com product page as the Wayback Machine kept it"),
    R("corsair-commander-pro", "corsair", "Corsair Commander Pro", "light",
      [("wbgrab", "corsair.com/us/en/Categories/Products/Accessories-%7C-Parts/iCUE-CONTROLLERS/iCUE-Commander-PRO-Smart-RGB-Lighting-and-Fan-Speed-Controller/p/CL-9011110-WW", CORSAIR_OLD)],
      ids=["1b1c:0c10"], names=["corsair commander pro", "commander pro", "icue commander pro"], note="corsair.com product page as the Wayback Machine kept it"),
    R("corsair-lighting-node-core", "corsair", "Corsair Lighting Node Core", "light",
      [("wbgrab", "corsair.com/us/en/Categories/Products/Accessories-%7C-Parts/iCUE-CONTROLLERS/iCUE-Lighting-Node-CORE-Digital-Fan-RGB-Lighting-Controller/p/CL-8930009", CORSAIR_OLD)],
      ids=["1b1c:0c1a"], names=["corsair lighting node core", "lighting node core", "icue lighting node core"], note="corsair.com product page as the Wayback Machine kept it"),
    R("corsair-lt100", "corsair", "Corsair LT100", "light",
      [("wbgrab", "corsair.com/us/en/Categories/Products/Ambient-Lighting/iCUE-LT100-Smart-Lighting-Towers-Starter-Kit/p/CD-9010002-NA", CORSAIR_OLD)],
      ids=["1b1c:0c23"], names=["corsair lt100", "lt100", "icue lt100"], note="corsair.com product page as the Wayback Machine kept it", soft=True),
]

candidates, jobs = make("lights3", ROWS)
