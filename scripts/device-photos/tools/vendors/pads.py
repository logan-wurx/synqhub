"""Game controllers: official product pictures from the makers' own sites and stores, matched to the controller ids in
docs/devices/CONTROLLERS.md. Every source is the maker's: playstation.com (Sony's Scene7 server, transparent `$facebook$`
renders), xbox.com, the Shopify stores of 8BitDo, Flydigi and Turtle Beach (Turtle Beach also sells PDP / Victrix), the
GameSir, SCUF, Razer and Thrustmaster product pages. Candidates are reviewed by eye (cands2.py pads), cut with proc2 (rembg
when a picture is not transparent), picks in picks/pads.json.

Each row: (key, vendor folder, display name, USB ids, extra names, sources). A source is one of
  ("shop", domain, handle)      every picture of a Shopify product (/products/<handle>.js)
  ("grab", page, regex)         every picture address on the page that matches the regex (URL-decoded first)
  ("ps", scene7 name)           one playstation.com render, transparent
  ("psgrab", page, regex)       every playstation.com render named on the page that matches the regex
  ("img", url)                  one picture
USB ids are left off where a pad shares them with another model or is UNVERIFIED in CONTROLLERS.md (a shared id would put
the wrong picture on a device); those rows are found by name only."""
import json, re, sys, urllib.parse
from common import ROOT, fetch, job

PS = "https://gmedia.playstation.com/is/image/SIEPDC/{}?$facebook$"
# Microsoft's own image server (Adobe Dynamic Media behind microsoft.com/store): a transparent PNG at any size.
DM = "https://cdn-dynmedia-1.microsoft.com/is/image/microsoftcorp/{}?wid=1600&hei=1600&fmt=png-alpha"


def i(vid, *pids):
    return [f"{vid}:{p:04x}" for p in pids]


def html(url):
    try:
        return fetch(url, text=True).replace("\\u002F", "/").replace("\\/", "/").replace("&amp;", "&")
    except Exception as e:
        print("  page failed:", url[:90], str(e)[:60], file=sys.stderr)
        return ""


def grab(url, pattern):
    """Picture addresses on the page matching the pattern, in page order, without duplicates (query dropped, except where
    the query is the picture's own name, as on xbox.com)."""
    t = urllib.parse.unquote(html(url))
    out, names = [], set()
    # Commas stay in (Logitech's and Nintendo's image servers put their sizing in the path); trailing punctuation goes.
    for m in re.findall(r"https?://[^\"'\s<>)\\]+", t):
        m = "https://" + re.split(r"https?://", m.rstrip(",;}"))[-1]     # Razer and others wrap the real address in a resizing proxy
        if not re.search(pattern, m, re.I):
            continue
        if not re.search(r"\.(png|jpe?g|webp)(\?|$)", m, re.I) and not re.search(r"assets\.nintendo\.com/image/upload/", m):
            continue
        base = m if "xboxservices.com" in m else m.split("?")[0]
        if "cdn.shopify.com" in base:
            base += "?width=1600"
        name = base.split("?")[0].rstrip("/").rsplit("/", 1)[-1]      # one entry per picture, whatever size the page asked for
        if name in names:
            continue
        names.add(name)
        out.append(base)
    return out


_LISTINGS = {}


def listing(domain):
    """Every product of a Shopify store from its public /products.json (read once per store and run)."""
    if domain not in _LISTINGS:
        out = {}
        for page in range(1, 9):
            try:
                ps = json.loads(fetch(f"https://{domain}/products.json?limit=250&page={page}", text=True)).get("products", [])
            except Exception as e:
                print("  listing failed:", domain, str(e)[:60], file=sys.stderr)
                break
            if not ps:
                break
            out.update({p["handle"]: [im["src"] for im in p.get("images", [])] for p in ps})
        _LISTINGS[domain] = out
    return _LISTINGS[domain]


def shop(domain, handle):
    try:
        ims = json.loads(fetch(f"https://{domain}/products/{handle}.js", text=True)).get("images", [])
    except Exception as e:
        # Some stores answer 429 to /products/<handle>.js after a few requests but still serve the listing.
        ims = listing(domain).get(handle, [])
        if not ims:
            print("  shop failed:", domain, handle, str(e)[:60], file=sys.stderr)
            return []
    return [("https:" + s if s.startswith("//") else s).split("?")[0] + "?width=1600" for s in ims]


def psgrab(url, pattern):
    names = []
    for n in re.findall(r"gmedia\.playstation\.com/is/image/SIEPDC/([A-Za-z0-9_\-]+)", html(url)):
        if re.search(pattern, n, re.I) and n not in names:
            names.append(n)
    return [PS.format(n) for n in names]


def urls_of(sources):
    out = []
    for s in sources:
        kind = s[0]
        got = (shop(s[1], s[2]) if kind == "shop" else grab(s[1], s[2]) if kind == "grab" else [PS.format(s[1])] if kind == "ps"
               else psgrab(s[1], s[2]) if kind == "psgrab" else [s[1]])
        out += [u for u in got if u not in out]
    return out


def page_of(sources):
    for s in sources:
        if s[0] in ("grab", "psgrab"):
            return s[1]
        if s[0] == "shop":
            return f"https://{s[1]}/products/{s[2]}"
    return ""


XB = "https://www.xbox.com/en-US/accessories/controllers/"
PSA = "https://www.playstation.com/en-us/accessories/"
GS = "https://gamesir.com/products/{}/buy"
SCUF = "https://www.scufgaming.com/us/en/p/"
SCUF_PICS = r"res\.cloudinary\.com/scuf-pwa/.*(gallery|hero|pdp)"
RZ = "https://www.razer.com/console-controllers/"
TM = "https://www.thrustmaster.com/en-us/products/"
SCUF_C = "https://www.scufgaming.com/us/en/c/"
B8 = "shop.8bitdo.com"
FD = "shops.flydigi.com"
TBP = "https://www.turtlebeach.com/products/"
TB_FILES = r"cdn\.shopify\.com/s/files/1/0556/5795/5430/files/"
NIN = "https://www.nintendo.com/us/store/products/"
JOYCON = r"assets\.nintendo\.com/image/upload/.*joy-con-gray-gray-1200x675"
PWA = "https://www.powera.com/"
ACCO = r"media\.accobrands\.com/.*\.(png|jpe?g|webp)"
NAC = "https://www.nacongaming.com/en-US/"
LGG = "https://www.logitechg.com/en-us/products/gamepads/"
B8_SITE = "https://www.8bitdo.com/images/2022/"
# The gallery pictures of rog.asus.com (ASUS's image server, 2000 px; the ids are the ones each pad's gallery page lists).
ROG_GAIN = "https://dlcdnwebimgs.asus.com/gain/{}/w2000"
# The My Nintendo Store's image server (Cloudinary): a PNG of the store's own render at any size.
MNS = "https://assets.nintendo.com/image/upload/f_png/q_auto:best/ncom/My%20Nintendo%20Store/EN-US/Nintendo%20Switch%202/"
MNS_PDP = "https://assets.nintendo.com/image/upload/f_png/q_auto:best/ncom/My%20Nintendo%20Store/EN-US/MNS%20HOME/General/NSO%20Controller%20PDPs/"

ROWS = [
    # Sony
    ("sony-dualsense", "sony", "Sony DualSense", i("054c", 0x0ce6), ["dualsense", "dualsense wireless controller", "sony dualsense", "ps5 controller"],
     [("ps", "dualsense-controller-product-thumbnail-01-en-14sep21"), ("ps", "dualsense-white-screenshot-04-en-08dec21"), ("ps", "dualsense-white-screenshot-05-en-08dec21"),
      ("ps", "dualsense-midnight-black-screenshot-01-en-08dec21")]),
    ("sony-dualsense-edge", "sony", "Sony DualSense Edge", i("054c", 0x0df2), ["dualsense edge", "dualsense edge wireless controller", "sony dualsense edge"],
     [("ps", "dualsense-edge-listing-thumb-01-en-23aug22"), ("ps", "DualSense-Edge-image-block-02-en-24aug22"), ("ps", "DualSense-Edge-image-block-01-en-24aug22")]),
    ("sony-dualshock-4", "sony", "Sony DualShock 4", i("054c", 0x05c4, 0x09cc), ["dualshock 4", "dualshock 4 wireless controller", "sony dualshock 4", "ps4 controller"],
     [("psgrab", PSA + "dualshock-4-wireless-controller/", r"dualshock|ds4")]),
    ("sony-access-controller", "sony", "Sony Access controller", [], ["access controller", "playstation access controller", "sony access controller"],
     [("psgrab", PSA + "access-controller/", r"access-controller")]),
    # Microsoft
    ("microsoft-xbox-wireless-controller", "microsoft", "Xbox Wireless Controller", i("045e", 0x0b12, 0x02ea, 0x0b13, 0x02e0, 0x02fd, 0x0b20),
     ["xbox wireless controller", "xbox controller", "xbox one controller", "xbox series x controller", "xbox one s controller"],
     [("grab", XB + "xbox-wireless-controller", r"Xbox-Wireless-Controller_(Gallery-0_246801|Image-Hero)")]),
    ("microsoft-xbox-elite-series-2", "microsoft", "Xbox Elite Wireless Controller Series 2", i("045e", 0x0b00, 0x0b05, 0x0b22),
     ["xbox elite wireless controller series 2", "elite series 2", "xbox elite series 2", "elite wireless controller series 2"],
     [("img", DM.format("gldn-Xbox-3131-D-b00-1")), ("img", DM.format("gldn-Xbox-3131-D-b01-1")), ("grab", XB + "elite-wireless-controller-series-2", r"elite")]),
    # The Core is the same hardware in white with fewer parts in the box: found by name only (its ids are the Elite's).
    ("microsoft-xbox-elite-series-2-core", "microsoft", "Xbox Elite Wireless Controller Series 2 Core", [],
     ["elite series 2 core", "xbox elite series 2 core", "elite wireless controller series 2 core", "xbox elite wireless controller series 2 core"],
     [("img", DM.format("b00-Xbox-Elite-Controller-right-angle-Series-2-White"))]),
    ("microsoft-xbox-adaptive-controller", "microsoft", "Xbox Adaptive Controller", i("045e", 0x0b0a, 0x0b0c, 0x0b21), ["xbox adaptive controller", "adaptive controller"],
     [("img", DM.format("Xbox-Adaptive-Controller")), ("grab", XB + "xbox-adaptive-controller", r"adaptive")]),
    # GameSir
    ("gamesir-g7-se", "gamesir", "GameSir G7 SE", i("3537", 0x1010), ["g7 se", "gamesir g7 se", "g7 se wired controller for xbox"],
     [("grab", GS.format("gamesir-g7-se"), r"files/gamesir-g7-se-wired-controller")]),
    ("gamesir-g7-pro", "gamesir", "GameSir G7 Pro", i("3537", 0x109b, 0x109c, 0x100a, 0x1003, 0x10ba, 0x10bb, 0x10a7, 0x1022), ["g7 pro", "gamesir g7 pro"],
     [("grab", GS.format("gamesir-g7-pro"), r"files/gamesir-g7-pro")]),
    ("gamesir-g7-pro-8k-pc", "gamesir", "GameSir G7 Pro 8K PC", i("3537", 0x10c7, 0x10c8, 0x10b8), ["g7 pro 8k", "g7 pro 8k pc", "gamesir g7 pro 8k"],
     [("grab", GS.format("gamesir-g7-pro-8k-pc"), r"files/gamesir-g7-pro-8k")]),
    ("gamesir-tarantula-pro-8k", "gamesir", "GameSir Tarantula Pro 8K", i("3537", 0x103d, 0x103c), ["tarantula pro", "tarantula 8k", "tarantula pro 8k", "gamesir tarantula"],
     [("grab", GS.format("gamesir-tarantula-8k-pc"), r"files/gamesir-tarantula")]),
    ("gamesir-cyclone-2", "gamesir", "GameSir Cyclone 2", i("3537", 0x1053, 0x101d, 0x102a, 0x100b), ["cyclone 2", "gamesir cyclone 2"],
     [("grab", GS.format("gamesir-cyclone2"), r"files/gamesir-cyclone-2")]),
    ("gamesir-kaleid", "gamesir", "GameSir Kaleid", i("3537", 0x1082, 0x1086, 0x1012), ["kaleid", "t4 kaleid", "gamesir kaleid", "gamesir t4 kaleid"],
     [("grab", GS.format("gamesir-kaleid-xbox-controller"), r"files/gamesir-kaleid")]),
    ("gamesir-nova-lite", "gamesir", "GameSir Nova Lite", i("3537", 0x100f, 0x1098), ["nova lite", "nova 2 lite", "gamesir nova", "gamesir nova lite"],
     [("grab", GS.format("gamesir-nova-lite"), r"files/gamesir-nova")]),
    ("gamesir-super-nova", "gamesir", "GameSir Super Nova", i("3537", 0x103e), ["super nova", "gamesir super nova"],
     [("grab", GS.format("gamesir-super-nova"), r"files/gamesir-super-nova")]),
    # 8BitDo
    ("8bitdo-ultimate-2c", "8bitdo", "8BitDo Ultimate 2C", i("2dc8", 0x310a, 0x301a, 0x301c, 0x301b), ["ultimate 2c", "8bitdo ultimate 2c", "ultimate 2c wireless controller"],
     [("shop", B8, "8bitdo-ultimate-2c-wireless-controller")]),
    ("8bitdo-ultimate-2", "8bitdo", "8BitDo Ultimate 2 Wireless", i("2dc8", 0x310b, 0x6012, 0x6013), ["ultimate 2 wireless", "8bitdo ultimate 2", "ultimate 2 wireless controller"],
     [("shop", B8, "8bitdo-ultimate-2")]),
    ("8bitdo-ultimate-2-bluetooth", "8bitdo", "8BitDo Ultimate 2 Bluetooth", i("2dc8", 0x600f), ["ultimate 2 bluetooth", "8bitdo ultimate 2 bluetooth"],
     [("shop", B8, "8bitdo-ultimate-2-bluetooth-controller")]),
    ("8bitdo-ultimate-3-mode", "8bitdo", "8BitDo Ultimate 3-mode for Xbox", i("2dc8", 0x200f), ["ultimate 3 mode", "8bitdo ultimate 3 mode", "ultimate 3 mode controller for xbox"],
     [("shop", B8, "ultimate-3-mode-controller-for-xbox")]),
    ("8bitdo-pro-2", "8bitdo", "8BitDo Pro 2", i("2dc8", 0x6003, 0x6006, 0x3010), ["pro 2", "8bitdo pro 2", "pro 2 wired controller"],
     [("shop", B8, "8bitdo-pro-2-bluetooth-controller")]),
    ("8bitdo-pro-3", "8bitdo", "8BitDo Pro 3", i("2dc8", 0x6009, 0x600a), ["pro 3", "8bitdo pro 3"],
     [("shop", B8, "8bitdo-pro-3")]),
    # Flydigi
    ("flydigi-vader-5-pro", "flydigi", "Flydigi Vader 5 Pro", i("37d7", 0x2401), ["vader 5 pro", "flydigi vader 5 pro"], [("shop", FD, "vader5pro")]),
    ("flydigi-apex-5", "flydigi", "Flydigi Apex 5", i("37d7", 0x2501), ["apex 5", "flydigi apex 5"], [("shop", FD, "apex5")]),
    # SCUF
    # The Envision Pro V2 keeps the Envision Pro's shell: a family photo (its ids are the V2's own).
    ("scuf-envision-pro", "scuf", "SCUF Envision Pro", i("2e95", 0x434c, 0x434d, 0x434e, 0x5046) + i("1b1c", 0x3a05, 0x3a06, 0x3a08, 0x3a09),
     ["envision pro", "scuf envision pro", "envision pro v2", "scuf envision pro v2"],
     [("grab", SCUF + "scuf-envision-pro-black-he", SCUF_PICS), ("grab", SCUF_C + "pcc/envision", r"envision_pro_black_front")]),
    ("scuf-envision", "scuf", "SCUF Envision", [], ["scuf envision", "envision wired"], [("grab", SCUF + "scuf-envision-black-he", SCUF_PICS)]),
    ("scuf-valor-pro-wireless", "scuf", "SCUF Valor Pro Wireless", [], ["valor pro wireless", "scuf valor pro wireless"],
     [("grab", SCUF_C + "xbox/valor-pro", r"valor-wireless-black-front")]),
    ("scuf-valor-pro", "scuf", "SCUF Valor Pro", [], ["valor pro", "scuf valor pro", "valor pro wired"], [("grab", SCUF_C + "xbox/valor-pro", r"valor-wired-light-gray-front|valor_pro_(red|blue)_front")]),
    # Turtle Beach, PDP / Victrix (turtlebeach.com: a Shopify storefront that doesn't answer /products/<handle>.js, so read from the page)
    ("turtle-beach-stealth-ultra", "turtle-beach", "Turtle Beach Stealth Ultra", i("10f5", 0x7073), ["stealth ultra", "turtle beach stealth ultra", "stealth ultra controller"],
     [("grab", TBP + "stealth-ultra-controller", TB_FILES + r"(stealth-ultra-controller|\d+-StealthUltra)")]),
    ("turtle-beach-stealth-pivot", "turtle-beach", "Turtle Beach Stealth Pivot", [], ["stealth pivot", "turtle beach stealth pivot"],
     [("grab", TBP + "stealth-pivot-controller", TB_FILES + r"[^/]*(stealth-?pivot|StealthPivot)")]),
    ("victrix-pro-bfg", "victrix", "Victrix Pro BFG", [], ["victrix pro bfg", "pro bfg", "pro bfg wireless controller"],
     [("grab", TBP + "victrix-pro-bfg-wireless-controller", TB_FILES + r"[^/]*(bfg|BFG)")]),
    ("victrix-pro-bfg-reloaded", "victrix", "Victrix Pro BFG Reloaded (Xbox)", i("0e6f", 0x024c), ["victrix pro bfg reloaded", "pro bfg reloaded", "victrix pro bfg for xbox"],
     [("grab", TBP + "victrix-pro-bfg-reloaded-wireless-controller", TB_FILES + r"[^/]*(bfg|BFG|reloaded|Reloaded)")]),
    ("victrix-gambit", "victrix", "Victrix Gambit", i("0e6f", 0x02d6), ["victrix gambit", "gambit", "gambit prime"],
     [("grab", TBP + "victrix-gambit-prime-wired-controller", TB_FILES + r"[^/]*(gambit|Gambit)")]),
    # Nintendo
    ("nintendo-switch-pro-controller", "nintendo", "Nintendo Switch Pro Controller", i("057e", 0x2009), ["pro controller", "switch pro controller", "nintendo switch pro controller"],
     [("grab", NIN + "pro-controller/", r"assets\.nintendo\.com/image/upload/.*/nintendo-switch-pro-controller/")]),
    # Windows sees each Joy-Con on its own (L 2006, R 2007) and the pair in the charging grip (200E): one official pair shot,
    # cut into its halves for the single ones (CROP below).
    ("nintendo-joy-con-l", "nintendo", "Nintendo Joy-Con (L)", i("057e", 0x2006), ["joy con l", "joy con (l)", "nintendo switch joy con l"], [("grab", NIN + "joy-con-set-l-r-gray/", JOYCON)]),
    ("nintendo-joy-con-r", "nintendo", "Nintendo Joy-Con (R)", i("057e", 0x2007), ["joy con r", "joy con (r)", "nintendo switch joy con r"], [("grab", NIN + "joy-con-set-l-r-gray/", JOYCON)]),
    ("nintendo-joy-con", "nintendo", "Nintendo Joy-Con (L)/(R)", i("057e", 0x200e), ["joy con", "joy con l r", "joy con charging grip", "nintendo switch joy con"],
     [("grab", NIN + "joy-con-set-l-r-gray/", JOYCON)]),
    # Valve
    ("valve-steam-controller", "valve", "Steam Controller", i("28de", 0x1102, 0x1142, 0x1105, 0x1106), ["steam controller", "valve steam controller"],
     [("grab", "https://store.steampowered.com/app/353370/Steam_Controller/", r"apps/353370/ss_[0-9a-f]+\.1920x1080")]),
    ("valve-steam-deck", "valve", "Steam Deck", i("28de", 0x1205), ["steam deck", "steam deck controller", "valve steam deck"],
     [("grab", "https://www.steamdeck.com/en/", r"steamdeck/images/(?!favicon|apple|social).*\.(png|jpe?g|webp)")]),
    # PowerA (ACCO Brands' media server)
    ("powera-fusion-pro-4", "powera", "PowerA Fusion Pro 4", i("20d6", 0x400b), ["fusion pro 4", "powera fusion pro 4", "fusion pro 4 wired controller"],
     [("grab", PWA + "ja-jp/p/xbox/xbox-series-xs/xbox-シリーズ-x-またはシリーズ-s-コントローラ/xbox-シリーズ-x-またはシリーズ-s-の有線コントローラー/fusion-pro-4-wired-controller-for-xbox-xbgp0325-01jp/", ACCO)]),
    ("powera-fusion-pro-3", "powera", "PowerA Fusion Pro 3", [], ["fusion pro 3", "powera fusion pro 3", "fusion pro 3 wired controller"],
     [("grab", PWA + "p/fusion/controllers/wired/fusion-pro-3-wired-controller-for-xbox-black-xbgp0062-01/", ACCO)]),
    ("powera-ops-v3-pro", "powera", "PowerA OPS v3 Pro", [], ["ops v3 pro", "powera ops v3 pro", "ops v3 pro wireless controller"],
     [("grab", PWA + "p/pc/controllers/wireless/ops-v3-pro-wireless-controller-for-pc-and-cloud-gaming-with-lumectra-pcgp0382-01/", ACCO)]),
    # Nacon
    ("nacon-revolution-5-pro", "nacon", "Nacon Revolution 5 Pro", i("3285", 0x0d16, 0x0d17, 0x0d18, 0x0d19, 0x0662), ["revolution 5 pro", "nacon revolution 5 pro"],
     [("grab", NAC + "revolution-5-pro", r"media/catalog/product")]),
    ("nacon-revolution-x-pro", "nacon", "Nacon Revolution X Pro", [], ["revolution x pro", "nacon revolution x pro"], [("grab", NAC + "revolution-x-pro-controller", r"media/catalog/product")]),
    # Logitech (the F510 is the F310's shell with rumble: a family photo)
    ("logitech-f310", "logitech", "Logitech Gamepad F310", i("046d", 0xc21d, 0xc216, 0xc21e), ["f310", "gamepad f310", "logitech gamepad f310", "logitech f310", "f510", "logitech f510", "rumble gamepad f510"],
     [("grab", LGG + "f310-gamepad.940-000110.html", r"resource\.logitechg?\.com/.*f310")]),
    ("logitech-f710", "logitech", "Logitech Wireless Gamepad F710", i("046d", 0xc21f), ["f710", "wireless gamepad f710", "logitech f710", "logitech wireless gamepad f710"],
     [("grab", LGG + "f710-wireless-gamepad.940-000117.html", r"resource\.logitechg?\.com/.*f710")]),
    # Corsair
    ("corsair-novablade-pro", "corsair", "Corsair NOVABLADE PRO", i("1b1c", 0x2b1f, 0x2b2b), ["novablade pro", "corsair novablade pro", "novablade pro wireless"],
     [("grab", "https://www.corsair.com/us/en/p/leverless-controllers/ch-963b01g-ww/novablade-pro-wireless-hall-effect-leverless-fighting-game-controller-ch-963b01g-ww",
       r"assets\.corsair\.com/image/upload/.*products/novablade/(CORSAIR_NOVABLADE|01_Novablade_hero)")]),
    # Razer
    ("razer-wolverine-v3-pro", "razer", "Razer Wolverine V3 Pro", i("1532", 0x0a3f), ["wolverine v3 pro", "razer wolverine v3 pro"],
     [("grab", RZ + "razer-wolverine-v3-pro/RZ06-05200100-R3U1", r"medias-p1\.phoenix\.razer\.com/.*wolverine[^/]*v3[^/]*pro[^/]*500x500")]),
    ("razer-wolverine-v3-pro-8k", "razer", "Razer Wolverine V3 Pro 8K PC", i("1532", 0x0a57, 0x0a59), ["wolverine v3 pro 8k", "wolverine v3 pro 8k pc", "razer wolverine v3 pro 8k pc"],
     [("grab", RZ + "razer-wolverine-v3-pro-8k-pc/RZ06-05540100-R3U1", r"medias-p1\.phoenix\.razer\.com/.*wolverine[^/]*500x500")]),
    ("razer-wolverine-v3-tournament-edition", "razer", "Razer Wolverine V3 Tournament Edition", [], ["wolverine v3 tournament edition", "wolverine v3 te", "razer wolverine v3 tournament edition"],
     [("grab", RZ + "razer-wolverine-v3-tournament-edition/RZ06-05210100-R3U1", r"medias-p1\.phoenix\.razer\.com/.*wolverine[^/]*500x500")]),
    ("razer-raiju-v3-pro", "razer", "Razer Raiju V3 Pro", i("1532", 0x1024, 0x1026), ["raiju v3 pro", "razer raiju v3 pro"],
     [("grab", RZ + "razer-raiju-v3-pro-for-ps5/RZ06-05580100-R3UA", r"medias-p1\.phoenix\.razer\.com/.*raiju[^/]*500x500")]),
    # Thrustmaster
    ("thrustmaster-eswap-x-pro", "thrustmaster", "Thrustmaster eSwap X Pro", i("044f", 0xd012), ["eswap x pro", "eswap x pro controller", "thrustmaster eswap x pro"],
     [("grab", TM + "eswap-x-pro-controller/", r"eswap")]),
    ("thrustmaster-eswap-x-2", "thrustmaster", "Thrustmaster eSwap X 2", i("044f", 0xd01e), ["eswap x 2", "eswap x2", "thrustmaster eswap x 2"], [("grab", TM + "eswap-x-2/", r"eswap")]),
    ("thrustmaster-eswap-pro", "thrustmaster", "Thrustmaster eSwap Pro", i("044f", 0xd00e), ["eswap pro", "eswap pro controller", "thrustmaster eswap pro"],
     [("grab", TM + "eswap-pro-controller/", r"eswap")]),

    # Second wave: the named pads that still fell back to a drawing (seventh pass in ../README.md).
    # The first 8BitDo Ultimate (2022): the Bluetooth and 2.4G models share the shell and the dock, so one family picture for
    # every id SDL gives it (its own and its X-input modes).
    ("8bitdo-ultimate", "8bitdo", "8BitDo Ultimate", i("2dc8", 0x3011, 0x3012, 0x3100, 0x3105, 0x3106, 0x3109, 0x6007),
     ["8bitdo ultimate", "ultimate bluetooth controller", "ultimate 2 4g wireless controller", "8bitdo ultimate bluetooth", "8bitdo ultimate 2 4g"],
     [("img", B8_SITE + "ultimate-bluetooth-controller/ultimate-bluetooth-black.png"), ("img", B8_SITE + "ultimate-2.4g-wireless-controller/2.4g-black.png"),
      ("img", B8_SITE + "ultimate-bluetooth-controller/ultimate-bluetooth-white.png")]),
    ("8bitdo-ultimate-wired-xbox", "8bitdo", "8BitDo Ultimate Wired Controller for Xbox", i("2dc8", 0x2002),
     ["ultimate wired controller for xbox", "8bitdo ultimate wired controller for xbox", "8bitdo ultimate wired"],
     [("shop", B8, "8bitdo-ultimate-wired-controller-for-xbox-and-windows")]),
    # HyperX (HP's vendor id; hyperx.com is a Shopify store)
    ("hyperx-clutch-gladiate", "hyperx", "HyperX Clutch Gladiate", i("03f0", 0x0495, 0x08b6), ["clutch gladiate", "hyperx clutch gladiate", "hp hyperx clutch gladiate"],
     [("shop", "hyperx.com", "hyperx-clutch-gladiate-wired-xbox-gaming-controller")]),
    ("hyperx-clutch-gladiate-rgb", "hyperx", "HyperX Clutch Gladiate RGB", i("03f0", 0x07a0), ["clutch gladiate rgb", "hyperx clutch gladiate rgb"],
     [("shop", "hyperx.com", "hyperx-clutch-gladiate-rgb-gaming-controller")]),
    ("hyperx-clutch-tanto", "hyperx", "HyperX Clutch Tanto", i("03f0", 0x09b4), ["clutch tanto", "hyperx clutch tanto", "clutch tanto mini"],
     [("shop", "hyperx.com", "hyperx-clutch-tanto-mini-wired-gaming-controller")]),
    # SteelSeries
    ("steelseries-stratus-duo", "steelseries", "SteelSeries Stratus Duo", i("1038", 0x1430, 0x1431), ["stratus duo", "steelseries stratus duo"],
     [("grab", "https://steelseries.com/gaming-controllers/stratus-duo", r"images\.ctfassets\.net/.*buyrender_stratusduo_00\d\.png")]),
    # Razer (older pads keep their product page; the Kitsune is an all-button pad)
    ("razer-wolverine-ultimate", "razer", "Razer Wolverine Ultimate", i("1532", 0x0a14), ["wolverine ultimate", "razer wolverine ultimate"],
     [("grab", RZ + "razer-wolverine-ultimate", r"razerzone\.com/images/.*wolverine-ult")]),
    ("razer-kitsune", "razer", "Razer Kitsune", i("1532", 0x1012), ["kitsune", "razer kitsune"],
     [("grab", RZ + "razer-kitsune", r"medias-p1\.phoenix\.razer\.com/sys-master-phoenix-images-container/(?!.*(pay|logo|icon))")]),
    # ASUS ROG
    ("asus-rog-raikiri-pro", "asus", "ASUS ROG Raikiri Pro", i("0b05", 0x1abb), ["raikiri pro", "rog raikiri pro", "asus rog raikiri pro"],
     [("img", ROG_GAIN.format(g)) for g in ("15A78C5B-4553-4ACA-BB68-D7CF73E3F36C", "F5E3C845-396B-41B3-B549-7B8C5FCA0802", "565A62BC-E6DB-4410-8C8A-A16495120D29",
                                           "646910C1-9A86-4BF1-B374-6B632063B6FD", "98C5B4E4-9BA0-49CB-94FB-E1259DC8AB0E", "886D98C5-E181-441F-A7B2-417A4C19B946")]),
    ("asus-rog-raikiri", "asus", "ASUS ROG Raikiri", i("0b05", 0x1a38), ["raikiri", "rog raikiri", "asus rog raikiri"],
     [("img", ROG_GAIN.format(g)) for g in ("0F34A77C-0F26-4E0A-9B67-6143E5ADA4BB", "8D155689-ADAA-497C-B83A-4606A857AE29", "B5D1C85C-1C72-4849-96FE-F7B6C686073D",
                                           "15232D97-EB98-4016-8ECD-4C8C9D4C5984", "3D713EF8-B5F3-4C80-A475-27FBF8189C23", "E317ACF2-F8B2-4C59-898E-F76DB68ABB60")]),
    # Nacon
    ("nacon-pro-compact", "nacon", "Nacon Pro Compact", i("3285", 0x0614, 0x0646, 0x0603), ["pro compact", "nacon pro compact", "pro compact controller for xbox"],
     [("img", "https://media.nacongaming.com/media/catalog/product/x/b/xbxprocompactblack_main.webp"),
      ("img", "https://media.nacongaming.com/media/catalog/product/x/b/xbxprocompactblack_lfs01.webp")]),
    # Nintendo Switch 2 (the My Nintendo Store's own renders)
    ("nintendo-switch-2-pro-controller", "nintendo", "Nintendo Switch 2 Pro Controller", i("057e", 0x2069),
     ["switch 2 pro controller", "nintendo switch 2 pro controller"],
     [("img", MNS + "Controllers/Pro%20Controllers/123674-nintendo-switch-2-pro-controller-front-angle-2000x2000"),
      ("img", MNS + "Controllers/Pro%20Controllers/123674-nintendo-switch-2-pro-controller-front-2000x2000"),
      ("img", MNS + "Controllers/Pro%20Controllers/123674-nintendo-switch-2-pro-controller-top-angle-2000x2000")]),
    ("nintendo-joy-con-2", "nintendo", "Nintendo Joy-Con 2", i("057e", 0x2066, 0x2067, 0x2068), ["joy con 2", "nintendo joy con 2", "switch 2 joy con"],
     [("img", MNS + "Controllers/Joy-Con%202/123677-nintendo-switch-2-joy-con-2-set-light-blue-light-red-front-1200x675")]),
    ("nintendo-switch-2-gamecube-controller", "nintendo", "Nintendo GameCube Controller (Switch 2)", i("057e", 0x2073),
     ["nintendo switch online gamecube controller", "gamecube controller for switch 2", "switch 2 gamecube controller"],
     [("img", MNS_PDP + "2880x1565_GameCube_Controller_Parallax"), ("img", MNS_PDP + "1920x1080_GameCube_Controller_16_9_Image.jpg")]),
    # Turtle Beach / PDP for Switch 2 (the Rematch and Afterglow wireless pads share 0E6F:0193: by name only)
    ("turtle-beach-rematch-wired-switch-2", "turtle-beach", "Turtle Beach Rematch Wired (Switch 2)", i("0e6f", 0x0196),
     ["rematch wired controller for nintendo switch 2", "rematch wired controller", "turtle beach rematch wired"],
     [("grab", TBP + "rematch-wired-controller-nintendo-switch-2", TB_FILES + r"\d_TB-Rematch-Wired-GID-NSW2[^/]*2400x1350")]),
    ("turtle-beach-afterglow-wave-wired-switch-2", "turtle-beach", "Turtle Beach Afterglow Wave Wired (Switch 2)", i("0e6f", 0x0197),
     ["afterglow wave wired controller for nintendo switch 2", "afterglow wave wired controller", "turtle beach afterglow wave wired"],
     [("grab", TBP + "afterglow-wave-wired-controller-nintendo-switch-2", TB_FILES + r"\d_TB-Afterglow-Wave-Wired-NSW-2[^/]*2400x1350")]),
    ("turtle-beach-afterglow-wired-switch-2", "turtle-beach", "Turtle Beach Afterglow Wired (Switch 2)", i("0e6f", 0x0198),
     ["afterglow wired controller for switch 2", "afterglow wired controller for nintendo switch 2", "turtle beach afterglow wired"],
     [("grab", TBP + "afterglow-wired-controller-nintendo-switch-2", TB_FILES + r"\d_TB-AFTERGLOW_WIRED_NSW2[^/]*2400x1350")]),
    ("turtle-beach-rematch-wireless-switch-2", "turtle-beach", "Turtle Beach Rematch Wireless (Switch 2)", [],
     ["rematch wireless rgb gaming controller for nintendo switch 2", "rematch wireless controller for nintendo switch 2", "turtle beach rematch wireless"],
     [("grab", TBP + "rematch-wireless-controller-nintendo-switch-2", TB_FILES + r"\d_REMATCH_WIRELESS_LED_NSW2[^/]*2400x1350_[0-9a-f]")]),
    ("turtle-beach-afterglow-wireless-switch-2", "turtle-beach", "Turtle Beach Afterglow Wireless (Switch 2)", [],
     ["afterglow wireless rgb gaming controller for nintendo switch 2", "afterglow wireless controller for nintendo switch 2", "turtle beach afterglow wireless"],
     [("grab", TBP + "afterglow-wireless-controller-nintendo-switch-2", TB_FILES + r"\d_TB-AFTERGLOW-NSW-2-WIRELESS[^/]*2400x1350")]),
]


def candidates(only=None):
    out = []
    for key, vendor, name, ids, names, sources in ROWS:
        urls = urls_of(sources) if not only or key in only else []
        if not urls and (not only or key in only):
            print("  no pictures:", key, file=sys.stderr)
        out.append(dict(key=key, vendor=vendor, name=name, kind="gamepad", ids=ids, page=page_of(sources), names=[name] + names,
                        note="maker's own site", urls=urls[:10]))
    return out


def jobs():
    picks_f = ROOT / "picks" / "pads.json"
    picks = json.load(open(picks_f)) if picks_f.exists() else {}
    out = []
    for c in candidates():
        sel = picks.get(c["key"])
        if sel is None or sel >= len(c["urls"]):
            continue
        j = job(c["key"], c["vendor"], c["name"], c["kind"], c["ids"], url=c["urls"][sel], page=c["page"], names=c["names"], note=c["note"] + f" (image {sel + 1})")
        if c["key"] in BRIDGE:
            j["bridge"] = BRIDGE[c["key"]]
        if c["key"] in CROP:
            j["crop"] = CROP[c["key"]]
        out.append(j)
    return out


# Products photographed in two pieces: bridge the gap between them so the cut keeps both (build2.py; an odd filter size on the
# third-size mask, so 71 closes a gap of about 200 px in a 1200 px picture).
BRIDGE = {"nintendo-joy-con": 71}
# One product out of a picture of several (fractions x0, y0, x1, y1 of the maker's picture; build2.py).
CROP = {"nintendo-joy-con-l": (0.0, 0.0, 0.5, 1.0), "nintendo-joy-con-r": (0.5, 0.0, 1.0, 1.0)}
