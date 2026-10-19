"""Headphones and IEMs for the Sound page (kind `headphones`): the person names the headphones on an output ("Zero:2") or
picks an AutoEq model ("7Hz Salnotes Zero 2"), and src/lib/device-images.ts `headphonePhotoKeyFor` finds the picture by
that name. About 190 of the most popular IEMs, earbuds and headphones (audiophile, studio, consumer and gaming), the 7Hz
Salnotes Zero:2 first.

Sources, in the order the review sheets show them: the maker's own store or product page where one answers (`maker`),
then reputable audio retailers' Shopify stores (`RETAIL`: the authorised dealers headphones.com, Linsoul, Apos Audio,
HiFiGo, Headphone Zone, Audio46, Bloom Audio, Moon Audio, Audio Advice, Hifi Headphones), matched by product title.
Steps: cands2.py phones, picks/phones.json, build2.py phones, assemble2.py."""
from common import norm_name, slug
from rows import R, make

RETAIL = ["headphones.com", "linsoul.com", "apos.audio", "hifigo.com", "www.headphonezone.in", "audio46.com", "bloomaudio.com",
          "www.moon-audio.com", "www.audioadvice.com", "www.hifiheadphones.co.uk"]
BEYER = (r"api\.beyerdynamic\.de/media/catalog/product/([a-z0-9/_\-]+?(?:perspective|front|side)[a-z0-9_\-]*\.png)", "https://api.beyerdynamic.de/media/catalog/product/{}")
AT = "https://www.audio-technica.com/en-us/"
APPLE = "https://as-images.apple.com/is/{}?wid=1200&hei=1200&fmt=png-alpha"   # Apple's own product renders, transparent
SS = "https://steelseries.com/gaming-headsets/"
LGG = "https://www.logitechg.com/en-us/shop/p/"
RZ = "https://www.razer.com/gaming-headsets/"
LGDAM = "https://resource.logitechg.com/w_1600,c_limit,f_png/d_transparent.gif/content/dam/gaming/en/products/"
PNX = "https://assets2.razerzone.com/images/pnx.assets/16eac26cd230ce343f56af70ec49626a/"


def at_pics(model):
    return (r"media/catalog/product/cache/[0-9a-f]+/a/t/(" + model + r"_[0-9a-z]+\.(?:png|jpg))", "https://www.audio-technica.com/media/catalog/product/a/t/{}")


def T(vendor, name, rx, names=(), maker=(), stores=RETAIL, **opts):
    """One model. `name` starts with the maker's name; the picture is found by it, by the model alone (when two words or more)
    and by `names`."""
    words = norm_name(name).split()
    vwords = vendor.split("-")
    model = " ".join(w for i, w in enumerate(words) if not (i < len(vwords) and w == vwords[i]))
    key = f"{vendor}-{slug(model)}"
    allnames = [norm_name(name), model, *[norm_name(n) for n in names]]
    return R(key, vendor, name, "headphones", [*maker, ("retail", rx, tuple(stores))], names=list(dict.fromkeys(allnames)), **opts)


TARGETS = [
    # 7Hz (the user's own Zero:2 first; sold by Linsoul, 7Hz's own distributor)
    T("7hz", "7Hz Salnotes Zero:2", r"^7hz.*zero:? ?2\b", names=["7hz salnotes zero 2", "salnotes zero 2", "7hz x crinacle zero 2", "crinacle zero 2", "zero 2"]),
    T("7hz", "7Hz Salnotes Zero", r"^7hz salnotes zero$", names=["salnotes zero"]),
    T("7hz", "7Hz Timeless", r"^7hz timeless$"),
    T("7hz", "7Hz Timeless II", r"^7hz timeless (ii|2)\b"),
    T("7hz", "7Hz Sonus", r"^7hz sonus$"),
    # Truthear
    T("truthear", "Truthear Hexa", r"^truthear hexa\b"),
    T("truthear", "Truthear x Crinacle Zero", r"^truthear (x crinacle )?zero(?!.*(red|blue ?2|2))", names=["truthear zero", "truthear zero blue"]),
    T("truthear", "Truthear x Crinacle Zero RED", r"^truthear (x crinacle )?zero:? ?red\b", names=["truthear zero red"]),
    T("truthear", "Truthear Gate", r"^truthear gate\b"),
    T("truthear", "Truthear Nova", r"^truthear nova\b"),
    T("truthear", "Truthear Hola", r"^truthear hola\b"),
    # Moondrop
    T("moondrop", "Moondrop Aria", r"^moondrop aria(?! ?(2|ii|snow|se))\b"),
    T("moondrop", "Moondrop Aria 2", r"^moondrop aria ?(2|ii)\b"),
    T("moondrop", "Moondrop Chu", r"^moondrop chu(?! ?(2|ii|3|iii))\b"),
    T("moondrop", "Moondrop Chu 2", r"^moondrop chu ?(2|ii)\b(?!.*dsp)"),
    T("moondrop", "Moondrop Kato", r"^moondrop kato\b"),
    T("moondrop", "Moondrop Blessing 2", r"^moondrop blessing ?(2|ii)\b(?!.*dusk)"),
    T("moondrop", "Moondrop Blessing 3", r"^moondrop blessing ?(3|iii)\b"),
    T("moondrop", "Moondrop Starfield", r"^moondrop starfield(?! ?(2|ii|3|iii))\b"),
    T("moondrop", "Moondrop Starfield 2", r"^moondrop starfield ?(2|ii)\b"),
    T("moondrop", "Moondrop Variations", r"^moondrop variations\b"),
    T("moondrop", "Moondrop May", r"^moondrop may\b"),
    T("moondrop", "Moondrop LAN", r"^moondrop lan(?! ?(2|ii))\b"),
    T("moondrop", "Moondrop Para", r"^moondrop para(?! ?(2|ii))\b"),
    # Kiwi Ears (its own store first)
    T("kiwi-ears", "Kiwi Ears Cadenza", r"^kiwi ears cadenza$", stores=["kiwiears.com", *RETAIL]),
    T("kiwi-ears", "Kiwi Ears Quintet", r"^kiwi ears quintet\b", stores=["kiwiears.com", *RETAIL]),
    T("kiwi-ears", "Kiwi Ears Orchestra Lite", r"^kiwi ears orchestra lite\b", stores=["kiwiears.com", *RETAIL]),
    T("kiwi-ears", "Kiwi Ears Melody", r"^kiwi ears melody\b", stores=["kiwiears.com", *RETAIL]),
    # TANGZU (its own store first)
    T("tangzu", "TANGZU Wan'er S.G", r"wan.?er s\.?g(?! ?(2|ii))\b", names=["tangzu waner sg", "tangzu wan er sg", "wan er s g"], stores=["tangzu.net", *RETAIL]),
    T("tangzu", "TANGZU Zetian Wu", r"(zetian wu|wu zetian)", names=["tangzu wu zetian"], stores=["tangzu.net", *RETAIL]),
    # Simgot
    T("simgot", "Simgot EW200", r"^simgot ew200\b", names=["simgot audio ew200"]),
    T("simgot", "Simgot EA500", r"^simgot ea500(?! ?(lm|dsp))\b", names=["simgot audio ea500"]),
    T("simgot", "Simgot EA500LM", r"^simgot ea500 ?lm\b", names=["simgot audio ea500lm", "simgot ea500 lm"]),
    T("simgot", "Simgot EA1000", r"^simgot ea1000\b", names=["simgot audio ea1000", "simgot ea1000 fermat"]),
    T("simgot", "Simgot EW100", r"^simgot ew100(?!p)\b", names=["simgot audio ew100"]),
    # KZ, CCA, Tin HiFi (KZ's own store first)
    T("kz", "KZ ZSN Pro X", r"^(kz )?zsn pro x\b", stores=["kztws.com", *RETAIL]),
    T("kz", "KZ ZS10 Pro", r"^(kz )?zs10 pro$", stores=["kztws.com", *RETAIL]),
    T("kz", "KZ ZEX Pro", r"^(kz )?zex pro\b", stores=["kztws.com", *RETAIL]),
    T("kz", "KZ EDX Pro", r"^(kz )?edx pro$", stores=["kztws.com", *RETAIL]),
    T("cca", "CCA CRA", r"^cca cra$"),
    T("tin-hifi", "Tin HiFi T2", r"^tin ?hifi t2\b(?! ?(plus|pro|evo|dlc|mkii))"),
    T("tin-hifi", "Tin HiFi C3", r"^tin ?hifi c3\b"),
    T("tin-hifi", "Tin HiFi T3 Plus", r"^tin ?hifi t3 plus\b"),
    # ThieAudio (its own store first), FiiO
    T("thieaudio", "ThieAudio Monarch MKII", r"^thieaudio monarch mk ?(ii|2)\b", stores=["thieaudio.com", *RETAIL]),
    T("thieaudio", "ThieAudio Monarch MKIII", r"^thieaudio monarch mk ?(iii|3)\b", stores=["thieaudio.com", *RETAIL]),
    T("thieaudio", "ThieAudio Oracle MKII", r"^thieaudio oracle mk ?(ii|2)\b", stores=["thieaudio.com", *RETAIL]),
    T("thieaudio", "ThieAudio Hype 2", r"^thieaudio hype ?2\b", stores=["thieaudio.com", *RETAIL]),
    T("fiio", "FiiO FH3", r"fiio fh3\b"),
    T("fiio", "FiiO FD5", r"fiio fd5\b"),
    T("fiio", "FiiO JD1", r"fiio jd1\b"),
    # Sennheiser (its own US store first)
    T("sennheiser", "Sennheiser IE 200", r"sennheiser\W+ie ?200\b", stores=["us.sennheiser-hearing.com", *RETAIL]),
    T("sennheiser", "Sennheiser IE 600", r"sennheiser\W+ie ?600\b", stores=["us.sennheiser-hearing.com", *RETAIL]),
    T("sennheiser", "Sennheiser IE 900", r"sennheiser\W+ie ?900\b", stores=["us.sennheiser-hearing.com", *RETAIL]),
    T("sennheiser", "Sennheiser Momentum True Wireless 3", r"momentum true wireless 3\b", stores=["us.sennheiser-hearing.com", *RETAIL]),
    T("sennheiser", "Sennheiser HD 600", r"sennheiser\W+hd ?600\b(?! series)", stores=["us.sennheiser-hearing.com", *RETAIL]),
    T("sennheiser", "Sennheiser HD 650", r"sennheiser\W+hd ?650\b", stores=["us.sennheiser-hearing.com", *RETAIL]),
    T("sennheiser", "Sennheiser HD 660 S", r"sennheiser\W+hd ?660 ?s\b(?! ?2)", stores=["us.sennheiser-hearing.com", *RETAIL]),
    T("sennheiser", "Sennheiser HD 660S2", r"sennheiser\W+hd ?660 ?s ?2\b", stores=["us.sennheiser-hearing.com", *RETAIL]),
    T("sennheiser", "Sennheiser HD 800 S", r"sennheiser\W+hd ?800 ?s\b", stores=["us.sennheiser-hearing.com", *RETAIL]),
    T("sennheiser", "Sennheiser HD 560S", r"sennheiser\W+hd ?560 ?s\b", stores=["us.sennheiser-hearing.com", *RETAIL]),
    T("sennheiser", "Sennheiser HD 58X Jubilee", r"hd ?58x\b", names=["sennheiser hd 58x"], stores=["us.sennheiser-hearing.com", *RETAIL]),
    T("sennheiser", "Sennheiser HD 599", r"sennheiser\W+hd ?599\b(?! ?se)", stores=["us.sennheiser-hearing.com", *RETAIL]),
    T("sennheiser", "Sennheiser Momentum 4 Wireless", r"momentum 4 wireless\b", stores=["us.sennheiser-hearing.com", *RETAIL]),
    # Shure, Etymotic, Final, Campfire, 64 Audio
    T("shure", "Shure SE535", r"shure\W+se535\b"),
    T("shure", "Shure SRH840A", r"shure\W+srh840a?\b"),
    T("shure", "Shure AONIC 50", r"shure\W+aonic 50\b(?! gen)"),
    T("etymotic", "Etymotic ER2XR", r"\ber2xr\b", stores=["etymotic.com", *RETAIL]),
    T("etymotic", "Etymotic ER4XR", r"\ber4xr\b", stores=["etymotic.com", *RETAIL]),
    T("final", "Final Audio E3000", r"final\W+(audio\W+)?e3000\b"),
    T("final", "Final Audio E500", r"final\W+(audio\W+)?e500\b"),
    T("final", "Final Audio A4000", r"final\W+(audio\W+)?a4000\b"),
    T("campfire-audio", "Campfire Audio Andromeda", r"andromeda(?! ?(gold|ss|cs|emerald))\b", stores=["www.campfireaudio.com", *RETAIL]),
    T("64-audio", "64 Audio U12t", r"\bu12t\b", stores=["www.64audio.com", *RETAIL]),
    # Earbuds
    T("samsung", "Samsung Galaxy Buds2 Pro", r"galaxy buds ?2 pro\b"),
    T("samsung", "Samsung Galaxy Buds3 Pro", r"galaxy buds ?3 pro\b"),
    T("samsung", "Samsung Galaxy Buds Live", r"galaxy buds live\b"),
    T("google", "Google Pixel Buds Pro", r"pixel buds pro(?! ?2)\b"),
    T("sony", "Sony WF-1000XM4", r"sony\W+wf-?1000xm4\b"),
    T("sony", "Sony WF-1000XM5", r"sony\W+wf-?1000xm5\b"),
    T("sony", "Sony WH-1000XM3", r"sony\W+wh-?1000xm3\b"),
    T("sony", "Sony WH-1000XM4", r"sony\W+wh-?1000xm4\b"),
    T("sony", "Sony WH-1000XM5", r"sony\W+wh-?1000xm5\b"),
    T("sony", "Sony MDR-7506", r"sony\W+mdr-?7506\b"),
    T("sony", "Sony MDR-V6", r"sony\W+mdr-?v6\b"),
    T("sony", "Sony INZONE H9", r"inzone h9\b"),
    T("sony", "Sony INZONE H7", r"inzone h7\b"),
    T("sony", "Sony INZONE Buds", r"inzone buds\b"),
    T("sony", "Sony IER-Z1R", r"sony\W+ier-?z1r\b"),
    T("bose", "Bose QuietComfort 35 II", r"bose\W+quietcomfort 35 (ii|2)\b"),
    T("bose", "Bose QuietComfort 45", r"bose\W+quietcomfort 45\b"),
    T("bose", "Bose QuietComfort Ultra Headphones", r"bose\W+quietcomfort ultra headphones\b"),
    T("bose", "Bose Noise Cancelling Headphones 700", r"bose\W+(noise cancelling )?headphones 700\b", names=["bose 700"]),
    T("bose", "Bose QuietComfort Earbuds II", r"bose\W+quietcomfort earbuds (ii|2)\b"),
    T("bose", "Bose QuietComfort Ultra Earbuds", r"bose\W+quietcomfort ultra earbuds\b"),
    T("jabra", "Jabra Elite 85t", r"jabra\W+elite 85t\b"),
    T("jabra", "Jabra Elite 75t", r"jabra\W+elite 75t\b"),
    T("beats", "Beats Fit Pro", r"beats\W+fit pro\b"),
    T("beats", "Beats Studio Buds", r"beats\W+studio buds(?! ?\+)\b"),
    T("nothing", "Nothing Ear", r"^nothing ear\b(?! ?\()", names=["nothing ear 1", "nothing ear 2"]),
    # Beyerdynamic (its own pages: transparent product renders)
    T("beyerdynamic", "Beyerdynamic DT 770 Pro", r"beyerdynamic\W+dt ?770 ?pro\b(?! ?x)", maker=[("ids", "https://www.beyerdynamic.com/p/dt-770-pro", BEYER)]),
    T("beyerdynamic", "Beyerdynamic DT 990 Pro", r"beyerdynamic\W+dt ?990 ?pro\b(?! ?x)", maker=[("ids", "https://www.beyerdynamic.com/p/dt-990-pro", BEYER)]),
    T("beyerdynamic", "Beyerdynamic DT 880", r"beyerdynamic\W+dt ?880\b", maker=[("ids", "https://www.beyerdynamic.com/p/dt-880-pro", BEYER)]),
    T("beyerdynamic", "Beyerdynamic DT 1990 Pro MKII", r"beyerdynamic\W+dt ?1990 ?pro", maker=[("ids", "https://www.beyerdynamic.com/p/dt-1990-pro-mkii", BEYER)], names=["beyerdynamic dt 1990 pro"]),
    T("beyerdynamic", "Beyerdynamic DT 900 Pro X", r"beyerdynamic\W+dt ?900 ?pro ?x\b", maker=[("ids", "https://www.beyerdynamic.com/p/dt-900-pro-x", BEYER)]),
    T("beyerdynamic", "Beyerdynamic DT 700 Pro X", r"beyerdynamic\W+dt ?700 ?pro ?x\b", maker=[("ids", "https://www.beyerdynamic.com/p/dt-700-pro-x", BEYER)]),
    T("beyerdynamic", "Beyerdynamic MMX 300", r"beyerdynamic\W+mmx ?300\b", maker=[("ids", "https://www.beyerdynamic.com/p/mmx-300-pro", BEYER)]),
    T("beyerdynamic", "Beyerdynamic T1", r"beyerdynamic\W+t1\b", maker=[("ids", "https://www.beyerdynamic.com/p/t1", BEYER)]),
    # Audio-Technica (its own pages)
    T("audio-technica", "Audio-Technica ATH-M50x", r"ath-?m50x\b(?! ?bt)", maker=[("ids", AT + "ath-m50x", at_pics("ath-m50x"))]),
    T("audio-technica", "Audio-Technica ATH-M40x", r"ath-?m40x\b", maker=[("ids", AT + "ath-m40x", at_pics("ath-m40x"))]),
    T("audio-technica", "Audio-Technica ATH-M20x", r"ath-?m20x\b(?! ?bt)", maker=[("ids", AT + "ath-m20x", at_pics("ath-m20x"))]),
    T("audio-technica", "Audio-Technica ATH-R70x", r"ath-?r70x\b", maker=[("ids", AT + "ath-r70x", at_pics("ath-r70x"))]),
    T("audio-technica", "Audio-Technica ATH-AD700X", r"ath-?ad700x\b", maker=[("ids", AT + "ath-ad700x", at_pics("ath-ad700x"))]),
    T("audio-technica", "Audio-Technica ATH-M50xBT2", r"ath-?m50x ?bt2\b", maker=[("ids", AT + "ath-m50xbt2", at_pics("ath-m50xbt2"))]),
    # AKG, HIFIMAN, Philips, Koss, Grado
    T("akg", "AKG K371", r"akg\W+k ?371\b(?! ?bt)"),
    T("akg", "AKG K702", r"akg\W+k ?702\b"),
    T("akg", "AKG K712 Pro", r"akg\W+k ?712\b"),
    T("akg", "AKG K240 Studio", r"akg\W+k ?240\b"),
    T("akg", "AKG K361", r"akg\W+k ?361\b(?! ?bt)"),
    T("akg", "AKG K612 Pro", r"akg\W+k ?612\b"),
    T("hifiman", "HIFIMAN Sundara", r"hifiman\W+sundara\b(?! ?(closed|silver))"),
    T("hifiman", "HIFIMAN Ananda", r"hifiman\W+ananda\b(?! ?(bt|nano|stealth|unveiled))"),
    T("hifiman", "HIFIMAN Edition XS", r"hifiman\W+edition xs\b"),
    T("hifiman", "HIFIMAN Arya", r"hifiman\W+arya\b(?! ?(organic|unveiled|wifi))"),
    T("hifiman", "HIFIMAN HE400se", r"hifiman\W+he ?400 ?se\b"),
    T("hifiman", "HIFIMAN Deva Pro", r"hifiman\W+deva pro\b"),
    T("hifiman", "HIFIMAN HE1000se", r"hifiman\W+he ?1000 ?se\b"),
    T("grado", "Grado SR80x", r"\bsr ?80x\b", stores=["gradolabs.com", *RETAIL]),
    T("grado", "Grado SR60x", r"\bsr ?60x\b", stores=["gradolabs.com", *RETAIL]),
    T("grado", "Grado SR325x", r"\bsr ?325x\b", stores=["gradolabs.com", *RETAIL]),
    # Audeze, Focal, Meze, Superlux, Samson
    T("audeze", "Audeze LCD-X", r"audeze\W+lcd-?x\b(?!c)(?! ?2021 creator)", stores=["www.audeze.com", *RETAIL]),
    T("audeze", "Audeze LCD-2 Classic", r"audeze\W+lcd-?2 classics?\b", stores=["www.audeze.com", *RETAIL]),
    T("audeze", "Audeze Maxwell", r"audeze\W+maxwell(?! ?2)\b", stores=["www.audeze.com", *RETAIL]),
    T("audeze", "Audeze Penrose", r"audeze\W+penrose\b", stores=["www.audeze.com", *RETAIL]),
    T("focal", "Focal Clear MG", r"focal\W+clear mg\b(?! ?pro)"),
    T("focal", "Focal Utopia", r"focal\W+utopia\b"),
    T("focal", "Focal Bathys", r"focal\W+bathys\b(?! ?mg)"),
    T("focal", "Focal Elex", r"focal\W+elex\b"),
    T("meze", "Meze 99 Classics", r"meze\W+(audio\W+)?99 classics\b(?! ?v2)", stores=["mezeaudio.com", *RETAIL]),
    T("meze", "Meze 109 Pro", r"meze\W+(audio\W+)?109 pro\b(?! primal)", stores=["mezeaudio.com", *RETAIL]),
    T("superlux", "Superlux HD 681", r"superlux\W+hd ?681\b(?! ?(evo|b|f))"),
    T("samson", "Samson SR850", r"samson\W+sr ?850\b"),
    # Gaming headsets people play through (the ones SYNQ drives have their own `headset` pictures)
    T("hyperx", "HyperX Cloud II", r"^hyperx cloud ii\b(?! (wireless|core))", stores=["hyperx.com"]),
    T("hyperx", "HyperX Cloud Alpha", r"^hyperx cloud alpha(?! (wireless|s\b|air|2))", stores=["hyperx.com"]),
    T("hyperx", "HyperX Cloud III", r"^hyperx cloud iii\W+gaming headset$", stores=["hyperx.com"]),
    T("hyperx", "HyperX Cloud Alpha Wireless", r"^hyperx cloud alpha wireless$", stores=["hyperx.com"]),
    T("hyperx", "HyperX Cloud III Wireless", r"^hyperx cloud iii wireless\W+gaming headset$", stores=["hyperx.com"]),
    T("hyperx", "HyperX Cloud Stinger 2", r"^hyperx cloud stinger 2\W+gaming headset$", stores=["hyperx.com"]),
    # Second batch: makers' own image servers and pages where no dealer lists the model.
    T("apple", "Apple AirPods Pro", r"$^", maker=[("img", APPLE.format("MWP22"))], names=["airpods pro 1st generation"]),
    T("apple", "Apple AirPods Pro 2", r"$^", maker=[("img", APPLE.format("MTJV3")), ("img", APPLE.format("MQD83"))], names=["apple airpods pro 2nd generation", "airpods pro2"]),
    T("apple", "Apple AirPods (3rd generation)", r"$^", maker=[("img", APPLE.format("MME73"))], names=["apple airpods 3", "airpods 3rd generation"]),
    T("apple", "Apple AirPods 4", r"$^", maker=[("img", APPLE.format("MXP63"))]),
    T("apple", "Apple AirPods Max", r"$^", maker=[("img", APPLE.format("airpods-max-select-spacegray-202011")), ("img", APPLE.format("airpods-max-select-202409-midnight"))]),
    T("google", "Google Pixel Buds Pro 2", r"$^", maker=[("og", "https://store.google.com/us/product/pixel_buds_pro_2")]),
    T("beats", "Beats Studio Pro", r"$^", maker=[("grab", "https://www.beatsbydre.com/headphones/studio-pro-wireless", r"content/dam/beats/web/product/headphones/studiopro")]),
    T("philips", "Philips Fidelio X2HR", r"$^", maker=[("og", "https://www.philips.co.uk/c-p/X2HR_00/fidelio-headphones")], names=["philips fidelio x2"], force=True),
    T("philips", "Philips SHP9500", r"$^", maker=[("og", "https://www.usa.philips.com/c-p/SHP9500_00/wired-headphones")], force=True),
    T("shure", "Shure SE215", r"$^", maker=[("grab", "https://www.shure.com/en-US/products/earphones/se215", r"shureweb\.eu/shure_product_db/product_main_images")]),
    T("shure", "Shure SE846", r"$^", maker=[("grab", "https://www.shure.com/en-US/products/earphones/se846", r"shureweb\.eu/shure_product_db/product_main_images")]),
    T("koss", "Koss Porta Pro", r"^porta pro®?$", stores=["www.koss.com"], names=["koss portapro"]),
    T("koss", "Koss KSC75", r"^ksc75$", stores=["www.koss.com"]),
    T("sennheiser", "Sennheiser IE 300", r"$^", maker=[("shop", "us.sennheiser-hearing.com", "ie-300")]),
    T("sennheiser", "Sennheiser HD 280 Pro", r"$^", maker=[("shop", "us.sennheiser-hearing.com", "hd-280-pro")]),
    T("sennheiser", "Sennheiser HD 490 Pro", r"$^", maker=[("shop", "us.sennheiser-hearing.com", "hd-490-pro")]),
    T("sennheiser", "Sennheiser HD 25", r"$^", maker=[("shop", "us.sennheiser-hearing.com", "hd-25")]),
    T("steelseries", "SteelSeries Arctis Nova Pro", r"$^", maker=[("grab", SS + "arctis-nova-pro", r"imgbuy_arctis_nova_pro(?!_wireless|_xbox)")]),
    T("steelseries", "SteelSeries Arctis Nova Pro Wireless", r"$^", maker=[("grab", SS + "arctis-nova-pro-wireless", r"imgbuy_arctis_nova_pro_wireless")]),
    T("steelseries", "SteelSeries Arctis Nova 1", r"$^", maker=[("grab", SS + "arctis-nova-1", r"arctis_nova_1.*(img_buy|imgbuy)")]),
    T("logitech", "Logitech G Pro X", r"$^", maker=[("grab", LGG + "pro-x-gaming-headset", r"products/pro-x.*gallery")], names=["logitech g pro x gaming headset", "logitech pro x headset"]),
    T("logitech", "Logitech G435", r"$^", maker=[("grab", LGG + "g435-wireless-gaming-headset", r"g435.*gallery")], names=["logitech g435 lightspeed"]),
    T("razer", "Razer BlackShark V2", r"$^", maker=[("grab", RZ + "razer-blackshark-v2", r"pnx\.assets/[0-9a-f]+/[^/]*blackshark-v2(?!-pro|-x)")]),
    T("razer", "Razer Kraken V3", r"$^", maker=[("grab", RZ + "razer-kraken-v3", r"pnx\.assets/[0-9a-f]+/[^/]*kraken-v3(?!-pro|-x|-hypersense)")]),
    T("razer", "Razer Barracuda X", r"$^", maker=[("grab", RZ + "razer-barracuda-x", r"pnx\.assets/[0-9a-f]+/[^/]*barracuda-x")]),
    T("razer", "Razer Barracuda Pro", r"$^", maker=[("grab", RZ + "razer-barracuda-pro", r"pnx\.assets/[0-9a-f]+/[^/]*barracuda-pro")]),
    # Third batch: Logitech G's gallery renders, Razer's store thumbnails (500 px, transparent).
    T("logitech", "Logitech G PRO X Headset", r"$^", maker=[("img", LGDAM + "pro-x/pro-headset-gallery-1.png"), ("img", LGDAM + "pro-x/pro-headset-gallery-2.png")],
      names=["logitech g pro x", "logitech g pro x gaming headset", "logitech pro x headset", "g pro x gaming headset"]),
    T("logitech", "Logitech G335", r"$^", maker=[("img", LGDAM + f"g335/g335-{c}-gallery-1.png") for c in ("black", "white")]),
    T("logitech", "Logitech G432", r"$^", maker=[("img", LGDAM + "g432/2025/g432-3qtr-front-left-angle-gallery-1.png")], names=["logitech g431", "logitech g432 7 1"]),
    T("astro", "ASTRO A50 X", r"$^", maker=[("img", LGDAM + f"astro-a50-x/product-gallery/astro-a50-x-{c}-gallery-1.png") for c in ("black", "white")],
      names=["astro gaming a50 x", "logitech astro a50 x", "a50 x"]),
    T("razer", "Razer BlackShark V2 Pro (2023)", r"$^", maker=[("img", PNX + "razer-blackshark-v2-pro-black-2023-500x500.webp")],
      names=["razer blackshark v2 pro 2023", "razer blackshark v2 pro"]),
    T("razer", "Razer BlackShark V2 X", r"$^", maker=[("img", PNX + "razer-blackshark-v2-x-black-500x500.webp")]),
    T("razer", "Razer BlackShark V2 HyperSpeed", r"$^", maker=[("img", PNX + "razer-blackshark-v2-hyperspeed-black-500x500.webp")]),
]

candidates, jobs = make("phones", TARGETS, note="maker's own store or an authorised dealer's listing")

